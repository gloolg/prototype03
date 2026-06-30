'use strict';

/**
 * observer/processor.js — Single-network Transfer log processor
 *
 * For each poll:
 *   1. Read checkpoint (last fully processed block)
 *   2. Get current block from RPC
 *   3. No checkpoint → bootstrap: save current block, return (don't scan history)
 *   4. Fetch Transfer logs in chunks of MAX_GET_LOGS_BLOCK_RANGE blocks
 *      (configurable per-network via env; default 10 for free-tier RPC compat)
 *   5. Filter out IT-wallet-initiated transfers (handled by Executor)
 *   6. Filter out transfers TO IT wallets (entries — Step 10 DApp scope)
 *   7. For each remaining log: idempotency check via observer_seen_txs, then
 *      call stateManager.applyObservation
 *   8. Update checkpoint after each successful chunk
 *
 * MVP conscious decisions:
 *   - Historical events before first Observer start are not tracked (acceptable for testnet MVP)
 *   - IT→tester outgoing transfers are skipped (already tracked via Executor/MetaRegistry)
 *   - tester→IT incoming transfers are skipped (entry flow — Step 10 DApp scope)
 *   - Fractional amounts (on-chain value not divisible by 10^18) are skipped with WARNING log
 *   - Chunk size configurable: MAX_GET_LOGS_BLOCK_RANGE_<NET> > MAX_GET_LOGS_BLOCK_RANGE > 10
 */

const { ethers } = require('ethers');
const { db, now } = require('../db');
const sm          = require('../stateManager');
const { getProvider, CONTRACT_ADDRESS } = require('../executor/networks');
const TRANSFER_TOPIC   = ethers.id('Transfer(address,address,uint256)');
const DECIMALS         = 18n;
const MAX_BLOCKS_PER_POLL = 100;

// IT wallet addresses — loaded once at module init (lowercased for comparison)
const IT_ADDRESSES = new Set([
  process.env.IT_A_ADDRESS,
  process.env.IT_B_ADDRESS,
  process.env.IT_C_ADDRESS,
  process.env.IT_D_ADDRESS,
].filter(Boolean).map(a => a.toLowerCase()));

// ─── processNetwork ───────────────────────────────────────────────────────────
async function processNetwork(network_id) {
  if (!sm.isInitialized()) return; // skip until genesis done

  let provider;
  try {
    provider = getProvider(network_id);
  } catch (e) {
    console.error(`[observer:${network_id}] Cannot create provider: ${e.message}`);
    return;
  }

  // ── 1. Read checkpoint ──────────────────────────────────────────────────
  const checkpoint = db.prepare(
    'SELECT last_block FROM observer_checkpoint WHERE network_id = ?'
  ).get(network_id);

  // ── 2. Get current block ────────────────────────────────────────────────
  let currentBlock;
  try {
    currentBlock = await provider.getBlockNumber();
  } catch (e) {
    console.error(`[observer:${network_id}] getBlockNumber failed: ${e.message}`);
    return;
  }

  // ── 3. Bootstrap: no checkpoint → save current block, return ───────────
  if (!checkpoint) {
    db.prepare(
      'INSERT INTO observer_checkpoint (network_id, last_block, updated_at) VALUES (?, ?, ?)'
    ).run(network_id, currentBlock, now());
    console.log(`[observer:${network_id}] Bootstrap: starting from block ${currentBlock}`);
    return;
  }

  const fromBlock = checkpoint.last_block + 1;
  const toBlock   = Math.min(currentBlock - 1, fromBlock + MAX_BLOCKS_PER_POLL - 1);

  if (fromBlock > toBlock) return; // nothing new

  // ── 4. Fetch Transfer logs in chunks ────────────────────────────────────
  // Chunk size: per-network env > global env > default 10
  // Alchemy free tier allows max 10 blocks per getLogs call.
  const chunkSize = parseInt(
    process.env[`MAX_GET_LOGS_BLOCK_RANGE_${network_id}`] ||
    process.env.MAX_GET_LOGS_BLOCK_RANGE ||
    '10', 10
  );

  for (let chunkFrom = fromBlock; chunkFrom <= toBlock; chunkFrom += chunkSize) {
    const chunkTo = Math.min(chunkFrom + chunkSize - 1, toBlock);

    let logs;
    try {
      logs = await provider.getLogs({
        address:   CONTRACT_ADDRESS,
        topics:    [TRANSFER_TOPIC],
        fromBlock: chunkFrom,
        toBlock:   chunkTo,
      });
    } catch (e) {
      console.error(
        `[observer:${network_id}] getLogs chunk(${chunkFrom}..${chunkTo}) ` +
        `of (${fromBlock}..${toBlock}) failed: ${e.message}`
      );
      return; // checkpoint stays at last successfully committed chunk
    }

    if (logs.length > 0) {
      console.log(
        `[observer:${network_id}] chunk(${chunkFrom}..${chunkTo}): ${logs.length} Transfer log(s)`
      );
    }

    // ── 5-7. Process each log in this chunk ────────────────────────────────
    for (const log of logs) {
      const tx_hash   = log.transactionHash;
      const log_index = log.index ?? log.logIndex ?? 0;

      // Parse addresses from indexed topics
      const from_address = ('0x' + log.topics[1].slice(26)).toLowerCase();
      const to_address   = ('0x' + log.topics[2].slice(26)).toLowerCase();

      // ── Filter: skip IT-originated (Executor-managed) transfers
      if (IT_ADDRESSES.has(from_address)) continue;

      // ── Wallet→IT transfer: record as pending entry for /entry tracking
      // Do NOT pass to applyObservation — this transfer is handled by /entry.
      // Recording here allows admin to detect cases where /entry was never called.
      if (IT_ADDRESSES.has(to_address)) {
        const rawValue = BigInt(log.data);
        if (rawValue % (10n ** DECIMALS) === 0n) {
          const entryAmount = Number(rawValue / (10n ** DECIMALS));
          if (entryAmount > 0) {
            try {
              db.prepare(
                `INSERT OR IGNORE INTO pending_entries
                   (tx_hash, log_index, network_id, from_address, amount, block_number)
                 VALUES (?, ?, ?, ?, ?, ?)`
              ).run(tx_hash, log_index, network_id, from_address, entryAmount, log.blockNumber);
            } catch (_) {}
          }
        }
        continue;
      }

      // ── Idempotency: skip already-processed logs
      const seen = db.prepare(
        'SELECT 1 FROM observer_seen_txs WHERE tx_hash = ? AND log_index = ?'
      ).get(tx_hash, log_index);
      if (seen) continue;

      // ── Parse amount (wei → integer tEQUI units)
      const rawValue = BigInt(log.data);
      if (rawValue % (10n ** DECIMALS) !== 0n) {
        console.warn(
          `[observer:${network_id}] Fractional transfer skipped: ` +
          `${tx_hash} logIdx=${log_index} value=${rawValue}`
        );
        _markSeen(tx_hash, log_index, network_id);
        continue;
      }
      const amount = Number(rawValue / (10n ** DECIMALS));
      if (amount <= 0) continue;

      // ── Apply observation via stateManager
      const result = sm.applyObservation({
        network_id,
        tx_hash,
        log_index,
        from_address,
        to_address,
        amount,
        block_number: log.blockNumber,
      });

      if (!result.ok) {
        console.error(`[observer:${network_id}] reconcile failed tx=${tx_hash}: ${result.reason}`);
      } else {
        console.log(
          `[observer:${network_id}] ${result.classification} ` +
          `tx=${tx_hash} ${from_address}→${to_address} ${amount} tEQUI`
        );
      }

      // Mark seen regardless of reconcile outcome (don't retry failed observations)
      _markSeen(tx_hash, log_index, network_id);
    }

    // ── 8. Advance checkpoint after each successful chunk ──────────────────
    db.prepare(
      'UPDATE observer_checkpoint SET last_block = ?, updated_at = ? WHERE network_id = ?'
    ).run(chunkTo, now(), network_id);
  }
}

function _markSeen(tx_hash, log_index, network_id) {
  try {
    db.prepare(
      'INSERT OR IGNORE INTO observer_seen_txs (tx_hash, log_index, network_id, processed_at) VALUES (?, ?, ?, ?)'
    ).run(tx_hash, log_index, network_id, now());
  } catch (_) { /* ignore */ }
}

module.exports = { processNetwork };
