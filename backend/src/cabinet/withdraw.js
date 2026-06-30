'use strict';

/**
 * cabinet/withdraw.js — Orchestrator for cabinet withdrawal
 *
 * Flow:
 *   1. Build deduction list: target network first, then [A,B,C,D] minus target (Variant 1)
 *   2. Calculate how much to take from each reserved_* bucket
 *   3. Persist cabinet_withdrawals + cabinet_withdrawal_steps records
 *   4. For each step with amount > 0: executeCommand → applyCabinetWithdraw → update DB
 *   5. Stop on first executor failure (PARTIAL_FAILED) — later steps are not attempted
 *
 * Idempotency: each step has a stable command_id = 'cabinet:withdraw:{withdraw_id}:{network_id}'
 * On crash-and-restart the execution_log shows which steps completed.
 */

const { randomUUID } = require('crypto');
const { db, now }    = require('../db');
const sm             = require('../stateManager');
const { executeCommand } = require('../executor');
const { COMMAND_TYPE }   = require('../executor/commandTypes');

const NETWORK_ORDER = ['A', 'B', 'C', 'D'];

// Column names for reserved_* — explicit map avoids template literals in SQL
const RESERVED_COL = { A: 'reserved_A', B: 'reserved_B', C: 'reserved_C', D: 'reserved_D' };

// ─── Cabinet invariant check (belt-and-suspenders) ────────────────────────────
// Called after each successful withdraw step.
// Returns true if violation detected (caller adds reconciliation_required flag).
// Can only fail due to a bug in our own accounting code, not user input.
function _checkCabinetInvariant(cabinet_id, network_id) {
  let violated = false;

  // (а) Cabinet balance invariant: total_balance === SUM(reserved_*)
  const cab = db.prepare(
    'SELECT total_balance, reserved_A, reserved_B, reserved_C, reserved_D FROM cabinets WHERE cabinet_id=?'
  ).get(cabinet_id);
  if (cab) {
    const sumRes = cab.reserved_A + cab.reserved_B + cab.reserved_C + cab.reserved_D;
    if (cab.total_balance !== sumRes) {
      console.error(
        `[CABINET INVARIANT VIOLATION] ${cabinet_id}: total_balance(${cab.total_balance}) ≠ SUM(reserved)=${sumRes} after step ${network_id}`
      );
      violated = true;
    }
  }

  // (б) Per-network invariant: SUM(reserved_X over all cabinets) <= IT_ACTIVE_X
  const col        = RESERVED_COL[network_id];
  const reservedX  = db.prepare(`SELECT COALESCE(SUM(${col}), 0) AS r FROM cabinets`).get().r;
  const netIT      = (sm.getState().networks[network_id] || {}).IT_ACTIVE || 0;
  if (reservedX > netIT) {
    console.error(
      `[CABINET INVARIANT VIOLATION] net ${network_id}: SUM(reserved_${network_id})=${reservedX} > IT_ACTIVE=${netIT} after withdraw step`
    );
    violated = true;
  }

  return violated;
}

/**
 * processWithdraw({ cabinet, recipient, target_network, amount })
 *
 * cabinet      — full row from cabinets table
 * recipient    — lowercase 0x address
 * target_network — 'A'|'B'|'C'|'D' (validated by caller)
 * amount       — positive integer tEQUI (validated by caller, <= total_balance)
 *
 * Returns:
 *   { ok: true,  withdraw_id, steps: [{ network_id, amount, tx_hash }] }
 *   { ok: false, reason, withdraw_id?, steps? }
 */
async function processWithdraw({ cabinet, recipient, target_network, amount }) {
  let reconciliation_required = false;
  // ── 1. Build deduction list ───────────────────────────────────────────────
  // Target first, then remaining networks in fixed A→B→C→D order, skipping target.
  const others = NETWORK_ORDER.filter(n => n !== target_network);
  const priority = [target_network, ...others];

  // ── 2. Calculate per-network amounts ─────────────────────────────────────
  const steps = [];
  let remaining = amount;

  for (const net of priority) {
    if (remaining === 0) break;
    const available = cabinet[RESERVED_COL[net]] || 0;
    const take      = Math.min(remaining, available);
    if (take > 0) {
      steps.push({ network_id: net, amount: take });
      remaining -= take;
    }
  }

  // Sanity check — should not happen if total_balance check in route is correct
  if (remaining > 0) {
    return { ok: false, reason: 'INSUFFICIENT_RESERVED_BALANCE', shortfall: remaining };
  }

  // ── 3. Persist withdrawal record ──────────────────────────────────────────
  const withdraw_id = 'WD-' + randomUUID();

  db.transaction(() => {
    db.prepare(`
      INSERT INTO cabinet_withdrawals
        (withdraw_id, cabinet_id, recipient, target_network, total_amount, status, created_at)
      VALUES (?, ?, ?, ?, ?, 'PENDING', ?)
    `).run(withdraw_id, cabinet.cabinet_id, recipient, target_network, amount, now());

    const insStep = db.prepare(`
      INSERT INTO cabinet_withdrawal_steps
        (withdraw_id, network_id, amount, command_id, status, created_at)
      VALUES (?, ?, ?, ?, 'PENDING', ?)
    `);
    for (const step of steps) {
      insStep.run(
        withdraw_id,
        step.network_id,
        step.amount,
        `cabinet:withdraw:${withdraw_id}:${step.network_id}`,
        now()
      );
    }
  })();

  db.prepare("UPDATE cabinet_withdrawals SET status='IN_PROGRESS' WHERE withdraw_id=?")
    .run(withdraw_id);

  // ── 4. Execute steps sequentially ─────────────────────────────────────────
  const results = [];

  for (const step of steps) {
    const command_id = `cabinet:withdraw:${withdraw_id}:${step.network_id}`;

    const execResult = await executeCommand({
      command_id,
      command_type: COMMAND_TYPE.CABINET_WITHDRAW,
      network_id:   step.network_id,
      to_address:   recipient,
      amount:       step.amount,
      envelope_id:  null,
    });

    if (!execResult.ok) {
      // Mark this step and the whole withdrawal as failed; do not attempt further steps.
      db.transaction(() => {
        db.prepare(
          "UPDATE cabinet_withdrawal_steps SET status='FAILED', error=? WHERE withdraw_id=? AND network_id=?"
        ).run(execResult.reason, withdraw_id, step.network_id);
        db.prepare(
          "UPDATE cabinet_withdrawals SET status='PARTIAL_FAILED' WHERE withdraw_id=?"
        ).run(withdraw_id);
      })();

      console.error(
        `[cabinet/withdraw] FAILED step ${step.network_id} for ${withdraw_id}: ${execResult.reason}`
      );
      results.push({ network_id: step.network_id, amount: step.amount, ok: false, reason: execResult.reason });
      return { ok: false, reason: execResult.reason, withdraw_id, steps: results };
    }

    // On-chain confirmed — update MetaRegistry state and cabinet balances atomically.
    sm.applyCabinetWithdraw(step.network_id, recipient, step.amount);

    db.transaction(() => {
      db.prepare(
        "UPDATE cabinet_withdrawal_steps SET status='COMPLETED', tx_hash=? WHERE withdraw_id=? AND network_id=?"
      ).run(execResult.tx_hash, withdraw_id, step.network_id);

      // Decrement reserved_* and total_balance by the exact amount delivered on this network.
      // Using explicit column map (RESERVED_COL) — network_id is one of A/B/C/D, validated by caller.
      db.prepare(`
        UPDATE cabinets
        SET ${RESERVED_COL[step.network_id]} = ${RESERVED_COL[step.network_id]} - ?,
            total_balance = total_balance - ?
        WHERE cabinet_id = ?
      `).run(step.amount, step.amount, cabinet.cabinet_id);
    })();

    // Invariant check (belt-and-suspenders): violations can only indicate a bug
    if (_checkCabinetInvariant(cabinet.cabinet_id, step.network_id)) {
      reconciliation_required = true;
    }

    console.log(
      `[cabinet/withdraw] step ${step.network_id} COMPLETED: ` +
      `${step.amount} tEQUI → ${recipient} tx=${execResult.tx_hash}`
    );
    results.push({ network_id: step.network_id, amount: step.amount, ok: true, tx_hash: execResult.tx_hash });
  }

  db.prepare("UPDATE cabinet_withdrawals SET status='COMPLETED' WHERE withdraw_id=?")
    .run(withdraw_id);

  return { ok: true, withdraw_id, steps: results, reconciliation_required };
}

module.exports = { processWithdraw };
