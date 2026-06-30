'use strict';

/**
 * routes/treasury.js
 *
 * POST /treasury/distribute
 *   1. Validate inputs
 *   2. Check MetaRegistry invariants via stateManager (does NOT yet mutate state)
 *   3. Call Executor — real on-chain ERC-20 transfer IT-EOA → tester wallet
 *   4. Only on confirmed tx: apply MetaRegistry state change + record TREASURY_DISTRIBUTION_APPLIED
 *   5. On Executor failure: record EXECUTION_FAILED event, return error — MetaRegistry state unchanged
 *
 * Request body:
 * {
 *   "network_id":     "A",
 *   "wallet_address": "0x...",
 *   "amount":         5000,
 *   "command_id":     "uuid-optional"   ← idempotency key; generated if omitted
 * }
 *
 * Response 200:
 * { "ok": true, "command_id", "tx_hash", "block_number", "event_id", "state_after" }
 *
 * Response 400 — validation / invariant / executor error:
 * { "ok": false, "reason", "command_id"? }
 */

const express  = require('express');
const { randomUUID } = require('crypto');
const router   = express.Router();
const sm       = require('../stateManager');
const { executeCommand } = require('../executor');
const { COMMAND_TYPE }   = require('../executor/commandTypes');
const { db, now }        = require('../db');

const getValidNetworkIds = () => Object.keys(sm.getState().networks);

router.post('/distribute', async (req, res) => {
  // ── Guard: genesis ──────────────────────────────────────────────────────
  if (!sm.isInitialized()) {
    return res.status(400).json({ ok: false, reason: 'MetaRegistry not initialized. Call POST /genesis first.' });
  }

  const { network_id, wallet_address, amount, command_id: client_command_id } = req.body;

  // ── Input validation ────────────────────────────────────────────────────
  const VALID_NETWORK_IDS = getValidNetworkIds();
  if (!network_id || !VALID_NETWORK_IDS.includes(network_id)) {
    return res.status(400).json({ ok: false,
      reason: `"network_id" must be one of: ${VALID_NETWORK_IDS.join(', ')}. Got: ${network_id}` });
  }
  if (!wallet_address || typeof wallet_address !== 'string' || wallet_address.trim() === '') {
    return res.status(400).json({ ok: false, reason: '"wallet_address" must be a non-empty string.' });
  }
  if (!Number.isInteger(amount) || amount <= 0) {
    return res.status(400).json({ ok: false, reason: '"amount" must be a positive integer.' });
  }

  const address    = wallet_address.trim();
  const command_id = client_command_id || randomUUID();

  // ── Pre-flight: validate against MetaRegistry (no state mutation yet) ───
  const preCheck = sm.canApplyTreasuryDistribution(network_id, address, amount);
  if (!preCheck.ok) {
    return res.status(400).json({ ok: false, reason: preCheck.reason, command_id });
  }

  // ── Executor: real on-chain transfer ────────────────────────────────────
  const execResult = await executeCommand({
    command_id,
    command_type: COMMAND_TYPE.TREASURY_DISTRIBUTION,
    network_id,
    to_address:  address,
    amount,
    envelope_id: null,
  });

  if (!execResult.ok) {
    // Record EXECUTION_FAILED event in event_record — MetaRegistry state unchanged
    _recordExecutionFailed({ command_id, network_id, address, amount, reason: execResult.reason });
    return res.status(502).json({
      ok:         false,
      command_id,
      reason:     execResult.reason,
      detail:     execResult.detail,
    });
  }

  // ── On confirmed tx: apply MetaRegistry state change ────────────────────
  const stateResult = sm.applyTreasuryDistribution(network_id, address, amount, execResult.tx_hash);

  if (!stateResult.ok) {
    // On-chain tx succeeded but MetaRegistry update failed — critical, needs reconciliation
    console.error('[CRITICAL] On-chain tx confirmed but MetaRegistry update failed:', {
      tx_hash: execResult.tx_hash, network_id, address, amount, reason: stateResult.reason,
    });
    return res.status(500).json({
      ok:              false,
      command_id,
      reason:          'RECONCILIATION_REQUIRED',
      detail:          stateResult.reason,
      tx_hash:         execResult.tx_hash,
    });
  }

  return res.status(200).json({
    ok:           true,
    command_id,
    tx_hash:      execResult.tx_hash,
    block_number: execResult.block_number,
    event_id:     stateResult.event_id,
    state_after:  stateResult.state_after,
    cached:       execResult.cached || false,
  });
});

function _recordExecutionFailed({ command_id, network_id, address, amount, reason }) {
  try {
    db.prepare(`
      INSERT INTO event_record (event_id, event_type, network_id, to_address, amount, status, metadata, created_at)
      VALUES (?, 'EXECUTION_FAILED', ?, ?, ?, 'FAILED', ?, ?)
    `).run(
      `EVT-FAIL-${command_id}-${now()}`,
      network_id, address, amount,
      JSON.stringify({ command_id, reason }),
      now()
    );
  } catch (e) {
    console.error('[treasury] Failed to record EXECUTION_FAILED event:', e.message);
  }
}

module.exports = router;
