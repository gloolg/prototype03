'use strict';

/**
 * executor/index.js — Executor / TML Execution Module (Step 8)
 *
 * Responsibilities:
 *   - Accept a validated ExecutionCommand from a route
 *   - Enforce idempotency via execution_log (command_id PRIMARY KEY)
 *   - Sign and broadcast on-chain ERC-20 transfer from IT-EOA
 *   - Wait for 1 confirmation, then record tx_hash + COMPLETED
 *   - On failure: record FAILED, return error — caller keeps MetaRegistry state unchanged
 *
 * MVP conscious decisions (document, not hide):
 *   - Signing: ethers.Wallet from .env private key. KMS-ready: swap getSigner() only.
 *   - Confirmations: 1. Reorg risk accepted for testnet MVP.
 *   - Retry: manual by admin (re-call with same command_id). No auto-retry.
 *   - Gas check: early-exit optimisation only — TX_FAILED also handles out-of-gas mid-flight.
 *   - Race condition: better-sqlite3 is synchronous + Node.js is single-threaded,
 *     so SELECT→INSERT has no interleave window. UNIQUE constraint catch is defense-in-depth.
 */

const { ethers } = require('ethers');
const { db, now } = require('../db');
const { COMMAND_TYPE } = require('./commandTypes');
const { getProvider, getSigner, getContract, getGasThreshold, getMinPriorityFee } = require('./networks');

// Decimals accepted from deployer (18, not 0 — documented deviation in handover §2)
const DECIMALS = 18n;

/**
 * executeCommand(command) → Result
 *
 * command: {
 *   command_id:   string   — idempotency key (UUID, caller-generated)
 *   command_type: COMMAND_TYPE.*
 *   network_id:   'A'|'B'|'C'|'D'
 *   to_address:   string
 *   amount:       number   — integer tEQUI units (Executor converts to wei ×10^18)
 *   envelope_id:  string|null
 * }
 *
 * Result (success):  { ok: true,  command_id, tx_hash, block_number, network_id }
 * Result (failure):  { ok: false, command_id, reason, detail }
 */
async function executeCommand(command) {
  const { command_id, command_type, network_id, to_address, amount, envelope_id = null } = command;

  // ── Validate command_type ─────────────────────────────────────────────────
  if (!Object.values(COMMAND_TYPE).includes(command_type)) {
    return { ok: false, command_id, reason: 'UNKNOWN_COMMAND_TYPE', detail: command_type };
  }

  // ── Step 0: Idempotency check ─────────────────────────────────────────────
  const existing = db.prepare('SELECT * FROM execution_log WHERE command_id = ?').get(command_id);

  if (existing) {
    if (existing.status === 'COMPLETED') {
      // Defense-in-depth: a cached hit MUST match the current request's
      // params. Without this check, a command_id reused for a logically
      // different operation (different network/recipient/amount) would
      // return the ORIGINAL tx_hash as "proof", and the caller (e.g.
      // routes/treasury.js) would then credit its ledger using the NEW
      // request's amount/recipient — crediting balance with zero matching
      // on-chain movement. This is only reachable via a client-supplied
      // command_id (currently just POST /treasury/distribute); every other
      // caller derives command_id from server-controlled/on-chain-verified
      // data, but the guard applies uniformly since it's cheap and correct
      // for all of them.
      const addrMatches = (existing.to_address || '').toLowerCase() === (to_address || '').toLowerCase();
      if (existing.network_id !== network_id || !addrMatches || existing.amount !== amount) {
        return {
          ok:     false,
          command_id,
          reason: 'COMMAND_ID_PARAM_MISMATCH',
          detail: `command_id was already used for a different operation ` +
            `(network=${existing.network_id}, to=${existing.to_address}, amount=${existing.amount})`,
        };
      }
      // Already executed — return cached result, no new tx
      return {
        ok:           true,
        command_id,
        tx_hash:      existing.tx_hash,
        block_number: existing.block_number,
        network_id:   existing.network_id,
        cached:       true,
      };
    }
    if (existing.status === 'PENDING') {
      // Previous attempt in-flight or crashed mid-way — admin must investigate
      return { ok: false, command_id, reason: 'ALREADY_IN_FLIGHT', detail: 'Previous attempt is PENDING. Check execution_log.' };
    }
    // FAILED or STUCK → allow retry (row will be reset to PENDING below)
  }

  // ── Insert PENDING row (or it's a FAILED retry) ───────────────────────────
  try {
    if (existing) {
      // FAILED or STUCK retry: reset to PENDING
      db.prepare(`
        UPDATE execution_log SET status='PENDING', tx_hash=NULL, block_number=NULL,
          error_reason=NULL, completed_at=NULL WHERE command_id=?
      `).run(command_id);
    } else {
      db.prepare(`
        INSERT INTO execution_log
          (command_id, command_type, network_id, to_address, amount, envelope_id, status, created_at)
        VALUES (?, ?, ?, ?, ?, ?, 'PENDING', ?)
      `).run(command_id, command_type, network_id, to_address, amount, envelope_id, now());
    }
  } catch (err) {
    // UNIQUE constraint violation — race condition defense-in-depth
    if (err.message?.includes('UNIQUE constraint failed')) {
      return { ok: false, command_id, reason: 'ALREADY_IN_FLIGHT', detail: 'Concurrent insert detected.' };
    }
    throw err;
  }

  // ── Execute on-chain ──────────────────────────────────────────────────────
  try {
    const provider = getProvider(network_id);
    const signer   = getSigner(network_id, provider);
    const contract = getContract(network_id, signer);

    // Step 3: Gas balance early-exit (optimisation — not a guarantee)
    const gasBalance = await provider.getBalance(await signer.getAddress());
    const gasBalanceEth = parseFloat(ethers.formatEther(gasBalance));
    const threshold = getGasThreshold(network_id);
    if (gasBalanceEth < threshold) {
      return _fail(command_id, 'INSUFFICIENT_GAS',
        `IT-${network_id} gas balance ${gasBalanceEth} < threshold ${threshold}`);
    }

    // Step 4: Dynamic gas price (getFeeData — no hardcoded gas price per §7.1)
    const feeData = await provider.getFeeData();

    // Step 5: Build and send ERC-20 transfer
    // amount is integer tEQUI units; on-chain amount = amount × 10^18 (decimals=18 deviation §2)
    const onChainAmount = BigInt(amount) * (10n ** DECIMALS);

    const txOptions = {};
    if (feeData.maxFeePerGas) {
      const minTip = getMinPriorityFee(network_id);
      const tip = feeData.maxPriorityFeePerGas ?? 0n;
      const clampedTip = tip < minTip ? minTip : tip;
      txOptions.maxPriorityFeePerGas = clampedTip;
      // maxFeePerGas must be >= tip
      const fee = feeData.maxFeePerGas ?? 0n;
      txOptions.maxFeePerGas = fee < clampedTip ? clampedTip : fee;
    } else if (feeData.gasPrice) {
      txOptions.gasPrice = feeData.gasPrice;
    }

    const tx = await contract.transfer(to_address, onChainAmount, txOptions);

    // Step 6: Wait for 1 confirmation
    // MVP conscious decision: 1 confirmation accepted for testnet. Reorg risk acknowledged.
    const receipt = await tx.wait(1);

    if (!receipt || receipt.status === 0) {
      return _fail(command_id, 'TX_FAILED', `tx_hash: ${tx.hash}, status: ${receipt?.status}`);
    }

    // Step 7: Mark COMPLETED
    db.prepare(`
      UPDATE execution_log
        SET status='COMPLETED', tx_hash=?, block_number=?, completed_at=?
      WHERE command_id=?
    `).run(tx.hash, receipt.blockNumber, now(), command_id);

    return {
      ok:           true,
      command_id,
      tx_hash:      tx.hash,
      block_number: receipt.blockNumber,
      network_id,
    };

  } catch (err) {
    // In ethers v6, tx.wait() throws on revert (does not return { status: 0 }).
    // Distinguish on-chain revert from RPC/network failure for correct diagnostics.
    if (err.receipt?.status === 0) {
      return _fail(command_id, 'TX_FAILED', `tx reverted on-chain: ${err.receipt.hash}`);
    }
    return _fail(command_id, 'RPC_ERROR', err.message);
  }
}

// ── Private helper ────────────────────────────────────────────────────────────
function _fail(command_id, reason, detail) {
  db.prepare(`
    UPDATE execution_log SET status='FAILED', error_reason=?, completed_at=? WHERE command_id=?
  `).run(`${reason}: ${detail}`, now(), command_id);
  return { ok: false, command_id, reason, detail };
}

module.exports = { executeCommand };
