'use strict';

/**
 * routes/entry.js
 *
 * POST /entry
 *   Processes a tEQUI entry transaction: verifies it on-chain, then applies
 *   the corresponding MetaRegistry transfer.
 *
 *   Flow:
 *     1. DApp sends on-chain tx: tester → IT-EOA (source network)
 *     2. DApp calls POST /entry with tx_hash + intent metadata
 *     3. Backend fetches tx receipt, verifies Transfer log matches IT-EOA + amount
 *     4. sm.applyTransfer executes cross-network (or same-network) MetaRegistry transfer
 *     5. Executor will subsequently deliver tEQUI on-chain to recipient on target network
 *
 * Request body:
 * {
 *   "tx_hash":           "0x...",
 *   "source_network":    "A",
 *   "target_network":    "B",
 *   "recipient_address": "0x...",
 *   "amount":            1000
 * }
 *
 * Response 200:
 * { "ok": true, "message": "...", "event_id": "EVT-..." }
 *
 * Response 400:
 * { "ok": false, "reason": "..." }
 */

const express          = require('express');
const router           = express.Router();
const { ethers }       = require('ethers');
const { db, now }        = require('../db');
const sm                 = require('../stateManager');
const { getProvider, CONTRACT_ADDRESS } = require('../executor/networks');
const { executeCommand } = require('../executor');
const { COMMAND_TYPE }   = require('../executor/commandTypes');
const TRANSFER_TOPIC   = ethers.id('Transfer(address,address,uint256)');
const VALID_NETS       = ['A', 'B', 'C', 'D'];

const IT_ADDRESSES = () => ({
  A: (process.env.IT_A_ADDRESS || '').toLowerCase(),
  B: (process.env.IT_B_ADDRESS || '').toLowerCase(),
  C: (process.env.IT_C_ADDRESS || '').toLowerCase(),
  D: (process.env.IT_D_ADDRESS || '').toLowerCase(),
});

// POST /entry
router.post('/', async (req, res) => {
  if (!sm.isInitialized()) {
    return res.status(400).json({ ok: false, reason: 'MetaRegistry not initialized.' });
  }

  const { tx_hash, source_network, target_network, recipient_address, amount } = req.body;

  // ── Input validation ───────────────────────────────────────────────────────
  if (!tx_hash || !source_network || !target_network || !recipient_address || amount === undefined) {
    return res.status(400).json({
      ok:     false,
      reason: 'Missing required fields: tx_hash, source_network, target_network, recipient_address, amount.',
    });
  }
  if (!VALID_NETS.includes(source_network) || !VALID_NETS.includes(target_network)) {
    return res.status(400).json({ ok: false, reason: 'Invalid network_id. Must be A, B, C, or D.' });
  }
  const declaredAmount = parseInt(amount, 10);
  if (!Number.isInteger(declaredAmount) || declaredAmount <= 0) {
    return res.status(400).json({ ok: false, reason: 'amount must be a positive integer.' });
  }

  // ── Idempotency: log_index = -1 marks entry-processed txs ─────────────────
  const seen = db.prepare(
    'SELECT 1 FROM observer_seen_txs WHERE tx_hash = ? AND log_index = -1'
  ).get(tx_hash);
  if (seen) {
    return res.status(400).json({ ok: false, reason: 'Transaction already processed as entry.' });
  }

  // ── Fetch tx receipt from source network ───────────────────────────────────
  let provider;
  try {
    provider = getProvider(source_network);
  } catch (e) {
    return res.status(400).json({ ok: false, reason: `Cannot get provider for Network ${source_network}: ${e.message}` });
  }

  let receipt;
  try {
    receipt = await provider.getTransactionReceipt(tx_hash);
  } catch (e) {
    return res.status(502).json({ ok: false, reason: `RPC error fetching tx receipt: ${e.message}` });
  }

  if (!receipt) {
    return res.status(400).json({ ok: false, reason: 'Transaction not found on-chain (may still be pending).' });
  }
  if (receipt.status !== 1) {
    return res.status(400).json({ ok: false, reason: 'Transaction failed on-chain (status=0).' });
  }

  // ── Resolve IT-EOA first — needed to identify the correct Transfer log ───
  const it = IT_ADDRESSES();
  const expectedIt = it[source_network];
  if (!expectedIt) {
    return res.status(500).json({ ok: false, reason: `IT_${source_network}_ADDRESS not configured on server.` });
  }

  // ── Find the tEQUI Transfer log directed to IT-EOA ────────────────────────
  // Uses expectedIt in find() so multi-transfer txs pick the correct log.
  const transferLog = receipt.logs.find(l =>
    l.address.toLowerCase() === CONTRACT_ADDRESS.toLowerCase() &&
    l.topics[0] === TRANSFER_TOPIC &&
    ('0x' + l.topics[2].slice(26)).toLowerCase() === expectedIt
  );
  if (!transferLog) {
    return res.status(400).json({
      ok:     false,
      reason: `No tEQUI Transfer to IT-EOA for Network ${source_network} found in this transaction.`,
    });
  }

  const from_address = ('0x' + transferLog.topics[1].slice(26)).toLowerCase();
  const rawAmount    = BigInt(transferLog.data);

  // ── Reject fractional amounts (same guard as observer/processor.js) ───────
  if (rawAmount % (10n ** 18n) !== 0n) {
    return res.status(400).json({ ok: false, reason: `Fractional tEQUI amount not accepted (raw=${rawAmount}).` });
  }

  const onChainAmount = Number(rawAmount / (10n ** 18n));

  // ── Verify amount matches declared ────────────────────────────────────────
  if (onChainAmount !== declaredAmount) {
    return res.status(400).json({
      ok:     false,
      reason: `Amount mismatch: declared ${declaredAmount}, on-chain ${onChainAmount}.`,
    });
  }

  // ── Block same-network self-transfer ──────────────────────────────────────
  if (source_network === target_network && from_address === recipient_address.toLowerCase()) {
    return res.status(400).json({
      ok:     false,
      reason: 'SELF_TRANSFER_NOT_ALLOWED: sender and recipient are the same address on the same network.',
    });
  }

  // ── Mark tx as entry-claimed BEFORE applying ─────────────────────────────
  // Fail-safe order: INSERT first prevents double-credit if server crashes
  // after applyTransfer but before the INSERT.
  //
  // If applyTransfer fails after this INSERT, the tx_hash is blocked on retry.
  // Manual recovery (operator): delete the row and retry /entry —
  //   sqlite3 db/metaregistry.sqlite \
  //     "DELETE FROM observer_seen_txs WHERE tx_hash='<tx_hash>' AND log_index=-1;"
  //
  // TBD (future, external testers): POST /admin/entry-seen/:tx_hash force-replay
  // with full audit trail. Not needed for MVP (operator = tester).
  db.prepare(
    'INSERT OR IGNORE INTO observer_seen_txs (tx_hash, log_index, network_id, processed_at) VALUES (?, -1, ?, ?)'
  ).run(tx_hash, source_network, now());

  // ── Apply MetaRegistry transfer ────────────────────────────────────────────
  const result = sm.applyTransfer({
    source_mode:    'AUTOMATIC',
    amount:         onChainAmount,
    sender:         from_address,
    recipient:      recipient_address.toLowerCase(),
    target_network,
  });

  if (!result.ok) {
    // Tokens arrived at IT-EOA on-chain but MetaRegistry rejected the transfer.
    // Record in stuck_entries so admin can audit and unlock via DELETE /admin/stuck-entries/:tx_hash.
    db.prepare(
      'INSERT OR IGNORE INTO stuck_entries (tx_hash, source_network, amount, from_address, reason) VALUES (?, ?, ?, ?, ?)'
    ).run(tx_hash, source_network, onChainAmount, from_address, result.reason || 'UNKNOWN');
    console.error(`[entry] applyTransfer failed — stuck entry recorded. tx=${tx_hash} reason=${result.reason}`);
    return res.status(400).json({
      ok:       false,
      reason:   result.reason,
      detail:   result,
      stuck:    true,
      recovery: 'DELETE /admin/stuck-entries/' + tx_hash + ' then retry POST /entry',
    });
  }

  console.log(
    `[entry] ${from_address} → ${recipient_address} ${onChainAmount} tEQUI ` +
    `Network ${source_network}→${target_network} tx=${tx_hash}`
  );

  // ── Dispatch on-chain delivery to target network ──────────────────────────
  const command_id = `entry:${tx_hash}`;
  const execResult = await executeCommand({
    command_id,
    command_type: COMMAND_TYPE.CROSS_NETWORK_ENTRY,
    network_id:   target_network,
    to_address:   recipient_address.toLowerCase(),
    amount:       onChainAmount,
    envelope_id:  result.event_id || null,
  });

  if (!execResult.ok) {
    // Delivery failed after MetaRegistry was already updated.
    // Mark as STUCK (not FAILED) so admin knows a decision is required:
    // either retry delivery or refund the original sender.
    // Store source_network and from_address for the refund action.
    db.prepare(`
      UPDATE execution_log
        SET status='STUCK', source_network=?, from_address=?
      WHERE command_id=?
    `).run(source_network, from_address, command_id);

    console.error(
      `[entry] CRITICAL: MetaRegistry updated but Executor STUCK for ${tx_hash}. ` +
      `command_id=${command_id} reason=${execResult.reason} detail=${execResult.detail}`
    );
    return res.status(502).json({
      ok:         false,
      reason:     'MetaRegistry updated but on-chain delivery failed. Recorded as STUCK — use admin panel to retry or refund.',
      detail:     execResult,
      event_id:   result.event_id || null,
      command_id,
    });
  }

  console.log(`[entry] Executor delivered: ${execResult.tx_hash} on Network ${target_network}`);

  return res.json({
    ok:           true,
    message:      'Entry processed. MetaRegistry transfer complete. On-chain delivery dispatched.',
    event_id:     result.event_id || null,
    exec_tx_hash: execResult.tx_hash,
    exec_network: target_network,
  });
});

module.exports = router;
