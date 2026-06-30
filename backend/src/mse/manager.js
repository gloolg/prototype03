'use strict';

const { randomUUID } = require('crypto');
const { db, now }    = require('../db');
const sm             = require('../stateManager');
const { executeCommand } = require('../executor');
const { COMMAND_TYPE }   = require('../executor/commandTypes');

const TIMEOUT_SEC = 300;

// In-memory timeout handles — rebuilt by restore() on every startup
const _timers = {};

// ── create ────────────────────────────────────────────────────────────────────
function create({ target_network, recipient, sources }) {
  const envelope_id  = 'MSE-' + randomUUID();
  const total_amount = sources.reduce((s, x) => s + x.expected_amount, 0);

  db.transaction(() => {
    db.prepare(`
      INSERT INTO mse_envelope
        (envelope_id, target_network, recipient, total_amount, source_count, created_at)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(envelope_id, target_network, recipient.toLowerCase(), total_amount, sources.length, now());

    const ins = db.prepare(
      'INSERT INTO mse_source (envelope_id, source_network, from_address, expected_amount) VALUES (?, ?, ?, ?)'
    );
    for (const s of sources) {
      ins.run(envelope_id, s.source_network, s.from_address.toLowerCase(), s.expected_amount);
    }
  })();

  return { envelope_id, total_amount, source_count: sources.length };
}

// ── confirmSource ─────────────────────────────────────────────────────────────
// Called after on-chain verification succeeds for one source tx.
// Returns { ok, confirmed_count, source_count, all_confirmed }
function confirmSource(envelope_id, source_network, { actual_amount, tx_hash, log_index }) {
  const envelope = db.prepare('SELECT * FROM mse_envelope WHERE envelope_id=?').get(envelope_id);
  if (!envelope) return { ok: false, reason: 'ENVELOPE_NOT_FOUND' };
  if (envelope.status !== 'COLLECTING') return { ok: false, reason: `NOT_COLLECTING (status=${envelope.status})` };

  const source = db.prepare(
    'SELECT * FROM mse_source WHERE envelope_id=? AND source_network=?'
  ).get(envelope_id, source_network);
  if (!source) return { ok: false, reason: 'SOURCE_NOT_FOUND' };

  if (source.status === 'CONFIRMED') {
    // Idempotent re-submit
    const env = db.prepare('SELECT confirmed_count, source_count FROM mse_envelope WHERE envelope_id=?').get(envelope_id);
    return { ok: true, confirmed_count: env.confirmed_count, source_count: env.source_count, all_confirmed: env.confirmed_count >= env.source_count, already: true };
  }

  const ts       = now();
  const is_first = !envelope.first_entry_at;

  db.transaction(() => {
    db.prepare(
      'UPDATE mse_source SET status=\'CONFIRMED\', actual_amount=?, tx_hash=?, log_index=?, confirmed_at=? WHERE envelope_id=? AND source_network=?'
    ).run(actual_amount, tx_hash, log_index, ts, envelope_id, source_network);

    const new_count = envelope.confirmed_count + 1;
    if (is_first) {
      db.prepare(
        'UPDATE mse_envelope SET confirmed_count=?, first_entry_at=?, timeout_at=? WHERE envelope_id=?'
      ).run(new_count, ts, ts + TIMEOUT_SEC, envelope_id);
    } else {
      db.prepare('UPDATE mse_envelope SET confirmed_count=? WHERE envelope_id=?').run(new_count, envelope_id);
    }
  })();

  if (is_first) {
    _scheduleTimeout(envelope_id, TIMEOUT_SEC * 1000);
  }

  const updated      = db.prepare('SELECT confirmed_count, source_count FROM mse_envelope WHERE envelope_id=?').get(envelope_id);
  const all_confirmed = updated.confirmed_count >= updated.source_count;

  return { ok: true, confirmed_count: updated.confirmed_count, source_count: updated.source_count, all_confirmed };
}

// ── tryDeliver ────────────────────────────────────────────────────────────────
// Called automatically when all sources confirmed. Also callable by admin retry.
async function tryDeliver(envelope_id) {
  const envelope = db.prepare('SELECT * FROM mse_envelope WHERE envelope_id=?').get(envelope_id);
  if (!envelope) return { ok: false, reason: 'ENVELOPE_NOT_FOUND' };

  if (_timers[envelope_id]) {
    clearTimeout(_timers[envelope_id]);
    delete _timers[envelope_id];
  }

  db.prepare('UPDATE mse_envelope SET status=\'DELIVERING\' WHERE envelope_id=?').run(envelope_id);

  // applyTransfer only once — transfer_applied guards crash-between-apply-and-execute edge case
  if (!envelope.transfer_applied) {
    const sources = db.prepare('SELECT * FROM mse_source WHERE envelope_id=? AND status=\'CONFIRMED\'').all(envelope_id);
    const sender  = sources[0].from_address;

    const transferResult = sm.applyTransfer({
      source_mode:    'USER_DEFINED',
      amount:         envelope.total_amount,
      sender,
      recipient:      envelope.recipient,
      target_network: envelope.target_network,
      sources:        sources.map(s => ({ network_id: s.source_network, amount: s.actual_amount })),
    });

    if (!transferResult.ok) {
      db.prepare('UPDATE mse_envelope SET status=\'FAILED\', error_reason=? WHERE envelope_id=?')
        .run('METAREGISTRY_REJECTED: ' + transferResult.reason, envelope_id);
      return { ok: false, reason: transferResult.reason };
    }

    db.prepare('UPDATE mse_envelope SET transfer_applied=1 WHERE envelope_id=?').run(envelope_id);
  }

  const command_id = `mse:deliver:${envelope_id}`;
  const execResult = await executeCommand({
    command_id,
    command_type: COMMAND_TYPE.MSE_DELIVERY,
    network_id:   envelope.target_network,
    to_address:   envelope.recipient,
    amount:       envelope.total_amount,
    envelope_id,
  });

  if (!execResult.ok) {
    db.prepare('UPDATE mse_envelope SET status=\'FAILED\', error_reason=? WHERE envelope_id=?')
      .run('DELIVERY_FAILED: ' + execResult.reason, envelope_id);
    return { ok: false, reason: execResult.reason, command_id };
  }

  db.prepare('UPDATE mse_envelope SET status=\'COMPLETED\', completed_at=? WHERE envelope_id=?')
    .run(now(), envelope_id);

  return { ok: true, tx_hash: execResult.tx_hash, command_id };
}

// ── retryDeliver (admin action) ───────────────────────────────────────────────
async function retryDeliver(envelope_id) {
  const envelope = db.prepare('SELECT * FROM mse_envelope WHERE envelope_id=?').get(envelope_id);
  if (!envelope) return { ok: false, reason: 'ENVELOPE_NOT_FOUND' };
  if (!['FAILED', 'TIMEOUT'].includes(envelope.status)) {
    return { ok: false, reason: `Cannot deliver in status=${envelope.status}` };
  }

  const sources      = db.prepare('SELECT * FROM mse_source WHERE envelope_id=?').all(envelope_id);
  const allConfirmed = sources.every(s => s.status === 'CONFIRMED');
  if (!allConfirmed) {
    return { ok: false, reason: 'Some sources are not CONFIRMED (may be REFUNDED). Cannot deliver partial amount.' };
  }

  // applyTransfer only if not yet applied (same guard as tryDeliver)
  if (!envelope.transfer_applied) {
    const sender = sources[0].from_address;
    const transferResult = sm.applyTransfer({
      source_mode:    'USER_DEFINED',
      amount:         envelope.total_amount,
      sender,
      recipient:      envelope.recipient,
      target_network: envelope.target_network,
      sources:        sources.map(s => ({ network_id: s.source_network, amount: s.actual_amount })),
    });
    if (!transferResult.ok) {
      db.prepare('UPDATE mse_envelope SET status=\'FAILED\', error_reason=? WHERE envelope_id=?')
        .run('METAREGISTRY_REJECTED: ' + transferResult.reason, envelope_id);
      return { ok: false, reason: transferResult.reason };
    }
    db.prepare('UPDATE mse_envelope SET transfer_applied=1 WHERE envelope_id=?').run(envelope_id);
  }

  db.prepare('UPDATE mse_envelope SET status=\'DELIVERING\', error_reason=NULL WHERE envelope_id=?').run(envelope_id);

  const command_id = `mse:deliver:${envelope_id}`;
  const execResult = await executeCommand({
    command_id,
    command_type: COMMAND_TYPE.MSE_DELIVERY,
    network_id:   envelope.target_network,
    to_address:   envelope.recipient,
    amount:       envelope.total_amount,
    envelope_id,
  });

  if (!execResult.ok) {
    db.prepare('UPDATE mse_envelope SET status=\'FAILED\', error_reason=? WHERE envelope_id=?')
      .run('DELIVERY_FAILED: ' + execResult.reason, envelope_id);
    return { ok: false, reason: execResult.reason };
  }

  db.prepare('UPDATE mse_envelope SET status=\'COMPLETED\', completed_at=? WHERE envelope_id=?')
    .run(now(), envelope_id);

  return { ok: true, tx_hash: execResult.tx_hash };
}

// ── refundSource (admin action) ───────────────────────────────────────────────
async function refundSource(envelope_id, source_network) {
  const source = db.prepare(
    'SELECT * FROM mse_source WHERE envelope_id=? AND source_network=?'
  ).get(envelope_id, source_network);
  if (!source) return { ok: false, reason: 'SOURCE_NOT_FOUND' };
  if (source.status !== 'CONFIRMED') return { ok: false, reason: `Source is ${source.status}, not CONFIRMED` };

  const command_id = `mse:refund:${envelope_id}:${source_network}`;
  const execResult = await executeCommand({
    command_id,
    command_type: COMMAND_TYPE.REFUND,
    network_id:   source_network,
    to_address:   source.from_address,
    amount:       source.actual_amount,
    envelope_id,
  });

  if (!execResult.ok) {
    return { ok: false, reason: execResult.reason };
  }

  db.prepare('UPDATE mse_source SET status=\'REFUNDED\' WHERE envelope_id=? AND source_network=?')
    .run(envelope_id, source_network);

  return { ok: true, tx_hash: execResult.tx_hash, refunded_to: source.from_address, amount: source.actual_amount };
}

// ── getEnvelope ───────────────────────────────────────────────────────────────
function getEnvelope(envelope_id) {
  const envelope = db.prepare('SELECT * FROM mse_envelope WHERE envelope_id=?').get(envelope_id);
  if (!envelope) return null;
  const sources = db.prepare('SELECT * FROM mse_source WHERE envelope_id=? ORDER BY id').all(envelope_id);
  return { ...envelope, sources };
}

// ── restore ───────────────────────────────────────────────────────────────────
// Called once at server startup. Rebuilds timers from DB; handles missed timeouts.
function restore() {
  const ts = now();

  // DELIVERING → FAILED: executor was in-flight, server restarted.
  // execution_log PENDING rows were already set to FAILED by server.js startup.
  const delivering = db.prepare('SELECT envelope_id FROM mse_envelope WHERE status=\'DELIVERING\'').all();
  for (const { envelope_id } of delivering) {
    db.prepare('UPDATE mse_envelope SET status=\'FAILED\', error_reason=\'DELIVERY_FAILED: SERVER_RESTART\' WHERE envelope_id=?')
      .run(envelope_id);
    console.log(`[mse] restore: ${envelope_id} DELIVERING → FAILED (server restart)`);
  }

  // COLLECTING: reschedule timers or mark TIMEOUT if already expired
  const collecting = db.prepare('SELECT * FROM mse_envelope WHERE status=\'COLLECTING\'').all();
  for (const env of collecting) {
    if (!env.first_entry_at) continue; // no entries yet — timer not started, nothing to do

    if (ts >= env.timeout_at) {
      db.prepare('UPDATE mse_envelope SET status=\'TIMEOUT\' WHERE envelope_id=?').run(env.envelope_id);
      console.log(`[mse] restore: ${env.envelope_id} → TIMEOUT (expired during downtime)`);
    } else {
      const remaining_ms = (env.timeout_at - ts) * 1000;
      _scheduleTimeout(env.envelope_id, remaining_ms);
      console.log(`[mse] restore: ${env.envelope_id} COLLECTING — ${Math.round(remaining_ms / 1000)}s remaining`);
    }
  }
}

// ── Private ───────────────────────────────────────────────────────────────────
function _scheduleTimeout(envelope_id, delay_ms) {
  if (_timers[envelope_id]) clearTimeout(_timers[envelope_id]);
  _timers[envelope_id] = setTimeout(() => {
    delete _timers[envelope_id];
    const env = db.prepare('SELECT status FROM mse_envelope WHERE envelope_id=?').get(envelope_id);
    if (env && env.status === 'COLLECTING') {
      db.prepare('UPDATE mse_envelope SET status=\'TIMEOUT\' WHERE envelope_id=?').run(envelope_id);
      console.log(`[mse] TIMEOUT: ${envelope_id}`);
    }
  }, delay_ms);
}

module.exports = { create, confirmSource, tryDeliver, retryDeliver, refundSource, getEnvelope, restore };
