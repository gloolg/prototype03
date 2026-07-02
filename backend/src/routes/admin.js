'use strict';

const express        = require('express');
const router         = express.Router();
const bcrypt         = require('bcryptjs');
const { randomBytes, randomUUID } = require('crypto');
const sm                        = require('../stateManager');
const { checkOnChainInvariant } = sm;
const { db, now }               = require('../db');
const { executeCommand }        = require('../executor');
const { COMMAND_TYPE }          = require('../executor/commandTypes');

const getValidNetworkIds = () => Object.keys(sm.getState().networks);
const SESSION_TTL   = 8 * 60 * 60; // 8 hours

// ── Auth helpers ─────────────────────────────────────────────────────────────

function requireAdmin(req, res, next) {
  const header = req.headers['authorization'] || '';
  const token  = header.startsWith('Bearer ') ? header.slice(7) : null;
  if (!token) return res.status(401).json({ ok: false, reason: 'Unauthorized' });
  const ts      = Math.floor(Date.now() / 1000);
  const session = db.prepare('SELECT 1 FROM admin_sessions WHERE token=? AND expires_at>?').get(token, ts);
  if (!session) return res.status(401).json({ ok: false, reason: 'Invalid or expired session' });
  next();
}

// ── Public: auth endpoints ────────────────────────────────────────────────────

// POST /admin/auth
router.post('/auth', async (req, res) => {
  const { password } = req.body || {};
  if (!password) return res.status(400).json({ ok: false, reason: 'Missing password' });

  const row = db.prepare('SELECT value FROM admin_config WHERE key=?').get('password_hash');
  if (!row) {
    return res.status(503).json({
      ok:     false,
      reason: 'Admin password not configured.',
      setup:  'Run: node scripts/set-admin-password.js <password>',
    });
  }

  const valid = await bcrypt.compare(password, row.value);
  if (!valid) return res.status(401).json({ ok: false, reason: 'Invalid password' });

  const token = randomBytes(32).toString('hex');
  const ts    = Math.floor(Date.now() / 1000);
  db.prepare('INSERT INTO admin_sessions (token, created_at, expires_at) VALUES (?, ?, ?)').run(token, ts, ts + SESSION_TTL);
  // Clean up expired sessions
  db.prepare('DELETE FROM admin_sessions WHERE expires_at < ?').run(ts);

  return res.json({ ok: true, token, expires_in: SESSION_TTL });
});

// POST /admin/logout
router.post('/logout', (req, res) => {
  const header = req.headers['authorization'] || '';
  const token  = header.startsWith('Bearer ') ? header.slice(7) : null;
  if (token) db.prepare('DELETE FROM admin_sessions WHERE token=?').run(token);
  return res.json({ ok: true });
});

// ── All routes below require admin auth ───────────────────────────────────────

router.use(requireAdmin);

// ── Network management ────────────────────────────────────────────────────────

// POST /admin/network-add
// Adds a new network to the MetaRegistry via structural rebalance.
// Body: { network_id: string, it_address: "0x..." }
router.post('/network-add', (req, res) => {
  if (!sm.isInitialized()) {
    return res.status(400).json({ ok: false, reason: 'MetaRegistry not initialized.' });
  }
  const { network_id, it_address } = req.body || {};
  if (!network_id || typeof network_id !== 'string' || !network_id.trim()) {
    return res.status(400).json({ ok: false, reason: 'Missing "network_id".' });
  }
  if (!it_address || !/^0x[0-9a-fA-F]{40}$/i.test(it_address)) {
    return res.status(400).json({ ok: false, reason: 'Missing or invalid "it_address" (must be 0x EVM address).' });
  }
  const net_id = network_id.trim();
  if (sm.getState().networks[net_id]) {
    return res.status(400).json({ ok: false, reason: `Network "${net_id}" already exists.` });
  }
  const result = sm.applyNetworkAdd(net_id, it_address.trim());
  if (!result.ok) return res.status(400).json(result);
  return res.json({ ok: true, network_id: net_id, allIds: result.allIds, newShares: result.newShares });
});

// ── Wallets ───────────────────────────────────────────────────────────────────

router.post('/register-wallet', (req, res) => {
  if (!sm.isInitialized()) {
    return res.status(400).json({ ok: false, reason: 'MetaRegistry not initialized.' });
  }
  const { address, network_ids } = req.body;
  if (!address || typeof address !== 'string') {
    return res.status(400).json({ ok: false, reason: 'Missing or invalid "address".' });
  }
  if (!Array.isArray(network_ids) || network_ids.length === 0) {
    return res.status(400).json({ ok: false, reason: '"network_ids" must be a non-empty array.' });
  }
  const addr = address.trim().toLowerCase();
  if (!/^0x[0-9a-f]{40}$/.test(addr)) {
    return res.status(400).json({ ok: false, reason: 'Invalid Ethereum address format.' });
  }
  const VALID_NETS = getValidNetworkIds();
  const nets = network_ids.filter(n => VALID_NETS.includes(n));
  if (nets.length === 0) {
    return res.status(400).json({ ok: false, reason: 'No valid network_ids.' });
  }
  const results = sm.registerWallet(addr, nets);
  return res.json({ ok: true, address: addr, results });
});

// GET /admin/wallets — all registered wallets with balances
router.get('/wallets', (req, res) => {
  const rows = db.prepare(
    'SELECT address, network_id, active_balance, frozen_balance, wallet_type, updated_at FROM wallet_balance ORDER BY address, network_id'
  ).all();
  return res.json({ ok: true, count: rows.length, wallets: rows });
});

// ── Logs ──────────────────────────────────────────────────────────────────────

// GET /admin/logs?limit=50
router.get('/logs', (req, res) => {
  const limit = Math.min(parseInt(req.query.limit, 10) || 50, 200);
  const events     = db.prepare('SELECT * FROM event_record ORDER BY created_at DESC LIMIT ?').all(limit);
  const executions = db.prepare('SELECT * FROM execution_log ORDER BY created_at DESC LIMIT ?').all(limit);
  return res.json({ ok: true, events, executions });
});

// ── Entry blocks ──────────────────────────────────────────────────────────────

router.get('/entry-blocks', (req, res) => {
  const rows = db.prepare(
    'SELECT tx_hash, network_id, processed_at FROM observer_seen_txs WHERE log_index = -1 ORDER BY processed_at DESC'
  ).all();
  return res.json({ ok: true, count: rows.length, blocked: rows });
});

router.delete('/entry-blocks/:tx_hash', (req, res) => {
  const { tx_hash } = req.params;
  const info = db.prepare('DELETE FROM observer_seen_txs WHERE tx_hash = ? AND log_index = -1').run(tx_hash);
  if (info.changes === 0) {
    return res.status(404).json({ ok: false, reason: 'tx_hash not found in entry blocks.' });
  }
  console.log(`[admin] entry-block cleared: ${tx_hash}`);
  return res.json({ ok: true, tx_hash, message: 'Unblocked. You can now retry POST /entry.' });
});

// ── On-chain invariant ────────────────────────────────────────────────────────

router.get('/onchain-invariant', async (req, res) => {
  try {
    const report = await checkOnChainInvariant();
    return res.json(report);
  } catch (e) {
    return res.status(502).json({ ok: false, reason: 'RPC error', detail: e.message });
  }
});

// ── Unprocessed entries ───────────────────────────────────────────────────────

// GET /admin/unprocessed-entries
// Returns wallet→IT-EOA on-chain transfers detected by Observer that have no
// corresponding /entry record in observer_seen_txs (log_index=-1).
// These are either: (a) /entry not yet called, (b) /entry call was lost.
router.get('/unprocessed-entries', (req, res) => {
  const rows = db.prepare(`
    SELECT pe.tx_hash, pe.log_index, pe.network_id, pe.from_address,
           pe.amount, pe.block_number, pe.detected_at
    FROM pending_entries pe
    WHERE NOT EXISTS (
      SELECT 1 FROM observer_seen_txs os
      WHERE os.tx_hash = pe.tx_hash AND os.log_index = -1
    )
    ORDER BY pe.detected_at DESC
  `).all();
  return res.json({ ok: true, count: rows.length, unprocessed: rows });
});

// POST /admin/create-stuck-delivery
// Manual recovery tool: registers a delivery obligation as STUCK in execution_log
// so it appears in "Застряглі доставки" and can be resolved via retry/refund.
// Use when /entry was lost and you know the delivery details.
router.post('/create-stuck-delivery', (req, res) => {
  const { tx_hash, source_network, target_network, from_address, to_address, amount } = req.body || {};
  const VALID = getValidNetworkIds();

  if (!tx_hash || !source_network || !target_network || !from_address || !to_address || !amount) {
    return res.status(400).json({ ok: false, reason: 'Missing required fields: tx_hash, source_network, target_network, from_address, to_address, amount.' });
  }
  if (!VALID.includes(source_network) || !VALID.includes(target_network)) {
    return res.status(400).json({ ok: false, reason: 'Invalid network_id.' });
  }
  const amt = parseInt(amount, 10);
  if (!Number.isInteger(amt) || amt <= 0) {
    return res.status(400).json({ ok: false, reason: 'amount must be a positive integer.' });
  }

  const command_id = `entry:${tx_hash.trim().toLowerCase()}`;
  const existing = db.prepare('SELECT status FROM execution_log WHERE command_id = ?').get(command_id);
  if (existing) {
    return res.status(400).json({ ok: false, reason: `Already exists in execution_log with status=${existing.status}.`, command_id });
  }

  db.prepare(`
    INSERT INTO execution_log
      (command_id, command_type, network_id, to_address, amount,
       source_network, from_address, status, error_reason, created_at)
    VALUES (?, 'CROSS_NETWORK_ENTRY', ?, ?, ?, ?, ?, 'STUCK',
      'MANUAL_RECOVERY: registered by admin', strftime('%s','now'))
  `).run(command_id, target_network, to_address.trim().toLowerCase(), amt,
         source_network, from_address.trim().toLowerCase());

  console.log(`[admin] create-stuck-delivery: ${command_id} ${source_network}→${target_network} ${amt} tEQUI`);
  return res.json({ ok: true, command_id, message: 'STUCK entry created. Visible in "Застряглі доставки".' });
});

// ── Stuck entries ─────────────────────────────────────────────────────────────

router.get('/stuck-entries', (req, res) => {
  const rows = db.prepare('SELECT * FROM stuck_entries ORDER BY created_at DESC').all();
  return res.json({ ok: true, count: rows.length, stuck_entries: rows });
});

router.delete('/stuck-entries/:tx_hash', (req, res) => {
  const { tx_hash } = req.params;
  const stuckInfo = db.prepare('DELETE FROM stuck_entries WHERE tx_hash = ?').run(tx_hash);
  if (stuckInfo.changes === 0) {
    return res.status(404).json({ ok: false, reason: 'tx_hash not found in stuck_entries.' });
  }
  db.prepare('DELETE FROM observer_seen_txs WHERE tx_hash = ? AND log_index = -1').run(tx_hash);
  console.log(`[admin] stuck-entry unlocked: ${tx_hash}`);
  return res.json({ ok: true, tx_hash, message: 'Stuck entry removed and idempotency lock cleared. Retry POST /entry.' });
});

// ── Stuck deliveries ──────────────────────────────────────────────────────────

// GET /admin/stuck-deliveries — list all STUCK execution_log rows
router.get('/stuck-deliveries', (req, res) => {
  const rows = db.prepare(
    `SELECT command_id, command_type, network_id, to_address, amount,
            source_network, from_address, error_reason, created_at
     FROM execution_log
     WHERE status = 'STUCK'
     ORDER BY created_at DESC`
  ).all();
  return res.json({ ok: true, count: rows.length, stuck_deliveries: rows });
});

// POST /admin/refund-delivery/:tx_hash
// Sends tEQUI from source IT-EOA back to original sender.
// On success: marks original entry execution_log row as REFUNDED.
// On failure: refund's own execution_log row = FAILED (retryable); original stays STUCK.
router.post('/refund-delivery/:tx_hash', async (req, res) => {
  const { tx_hash } = req.params;
  const entry_command_id  = `entry:${tx_hash}`;
  const refund_command_id = `refund:${tx_hash}`;

  const row = db.prepare('SELECT * FROM execution_log WHERE command_id = ?').get(entry_command_id);
  if (!row) {
    return res.status(404).json({ ok: false, reason: `No execution_log entry for command_id=${entry_command_id}` });
  }
  if (row.status !== 'STUCK') {
    return res.status(400).json({ ok: false, reason: `Entry is not STUCK (status=${row.status}). Only STUCK entries can be refunded.` });
  }
  if (!row.source_network || !row.from_address) {
    return res.status(400).json({ ok: false, reason: 'Missing source_network or from_address on STUCK entry. Cannot refund.' });
  }

  console.log(
    `[admin] refund-delivery: ${entry_command_id} ` +
    `source=${row.source_network} to=${row.from_address} amount=${row.amount}`
  );

  const execResult = await executeCommand({
    command_id:   refund_command_id,
    command_type: COMMAND_TYPE.REFUND,
    network_id:   row.source_network,
    to_address:   row.from_address,
    amount:       row.amount,
    envelope_id:  null,
  });

  if (!execResult.ok) {
    return res.status(502).json({
      ok:     false,
      reason: `Refund failed: ${execResult.reason}. Entry remains STUCK. Retry after fixing the root cause.`,
      detail: execResult,
    });
  }

  // Refund delivered — mark original entry as REFUNDED
  db.prepare(
    `UPDATE execution_log SET status='REFUNDED', completed_at=? WHERE command_id=?`
  ).run(Math.floor(Date.now() / 1000), entry_command_id);

  console.log(`[admin] refund-delivery SUCCESS: refund_tx=${execResult.tx_hash} entry=${entry_command_id} → REFUNDED`);

  return res.json({
    ok:             true,
    message:        'Refund delivered on-chain. Entry marked as REFUNDED.',
    refund_tx_hash: execResult.tx_hash,
    block_number:   execResult.block_number,
    source_network: row.source_network,
    refunded_to:    row.from_address,
    amount:         row.amount,
  });
});

// ── Retry delivery ────────────────────────────────────────────────────────────

router.post('/retry-delivery/:tx_hash', async (req, res) => {
  const { tx_hash } = req.params;
  const command_id  = `entry:${tx_hash}`;

  const row = db.prepare('SELECT * FROM execution_log WHERE command_id = ?').get(command_id);
  if (!row) {
    return res.status(404).json({ ok: false, reason: `No execution_log entry for command_id=${command_id}` });
  }
  if (row.status === 'COMPLETED') {
    return res.status(400).json({ ok: false, reason: 'Delivery already completed.', tx_hash: row.tx_hash });
  }
  if (row.status === 'REFUNDED') {
    return res.status(400).json({ ok: false, reason: 'Entry was refunded. Cannot retry delivery.' });
  }
  if (row.status === 'PENDING') {
    return res.status(400).json({ ok: false, reason: 'Delivery already in-flight (PENDING). Check execution_log.' });
  }
  // FAILED or STUCK → allow retry

  console.log(`[admin] retry-delivery: ${command_id} network=${row.network_id} to=${row.to_address} amount=${row.amount}`);

  const execResult = await executeCommand({
    command_id,
    command_type: row.command_type || COMMAND_TYPE.CROSS_NETWORK_ENTRY,
    network_id:   row.network_id,
    to_address:   row.to_address,
    amount:       row.amount,
    envelope_id:  row.envelope_id || null,
  });

  if (!execResult.ok) {
    return res.status(502).json({ ok: false, reason: execResult.reason, detail: execResult });
  }

  return res.json({
    ok:           true,
    message:      'On-chain delivery retried successfully.',
    tx_hash:      execResult.tx_hash,
    block_number: execResult.block_number,
    network_id:   execResult.network_id,
  });
});

// ── Cabinets ──────────────────────────────────────────────────────────────────

// POST /admin/cabinets/create
router.post('/cabinets/create', (req, res) => {
  if (!sm.isInitialized()) {
    return res.status(400).json({ ok: false, reason: 'MetaRegistry not initialized.' });
  }

  const amt = parseInt((req.body || {}).initial_amount, 10);
  if (!Number.isInteger(amt) || amt <= 0) {
    return res.status(400).json({ ok: false, reason: 'initial_amount must be a positive integer.' });
  }
  if (amt % 4 !== 0) {
    return res.status(400).json({
      ok:     false,
      reason: 'initial_amount має ділитися на 4 без залишку для рівного 25%/25%/25%/25% розподілу.',
    });
  }

  const quota = amt / 4;
  const state = sm.getState();
  // Deliberately hardcoded, NOT getValidNetworkIds(): the cabinets table only
  // has reserved_A..reserved_D columns (schema-level 4-network limit, see
  // README_FULL "Dynamic Network Support"). Using the dynamic network list
  // here would silently miscompute for a 5th network — afterRow[`t${n}`]
  // would be undefined for anything beyond D, and `undefined > itActive` is
  // always false in JS, so the invariant check below would never catch a
  // real violation on that network instead of correctly refusing to support it.
  const CABINET_NETS = ['A', 'B', 'C', 'D'];

  const totRow = db.prepare(`
    SELECT COALESCE(SUM(reserved_A),0) AS tA,
           COALESCE(SUM(reserved_B),0) AS tB,
           COALESCE(SUM(reserved_C),0) AS tC,
           COALESCE(SUM(reserved_D),0) AS tD
    FROM cabinets
  `).get();

  const reservedNow = { A: totRow.tA, B: totRow.tB, C: totRow.tC, D: totRow.tD };

  const insufficient = [];
  for (const n of CABINET_NETS) {
    const itActive = (state.networks[n] || {}).IT_ACTIVE || 0;
    const free = itActive - reservedNow[n];
    if (free < quota) insufficient.push({ network: n, free, required: quota });
  }
  if (insufficient.length > 0) {
    return res.status(400).json({
      ok: false,
      reason: 'Insufficient free IT_ACTIVE on some networks.',
      insufficient,
    });
  }

  const cabinet_id   = 'CAB-' + randomUUID();
  const access_token = randomBytes(32).toString('hex');

  db.prepare(`
    INSERT INTO cabinets
      (cabinet_id, access_token, total_balance, reserved_A, reserved_B, reserved_C, reserved_D, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `).run(cabinet_id, access_token, amt, quota, quota, quota, quota, now());

  // Post-create invariant — belt and suspenders
  const afterRow = db.prepare(`
    SELECT COALESCE(SUM(reserved_A),0) AS tA,
           COALESCE(SUM(reserved_B),0) AS tB,
           COALESCE(SUM(reserved_C),0) AS tC,
           COALESCE(SUM(reserved_D),0) AS tD
    FROM cabinets
  `).get();
  for (const n of CABINET_NETS) {
    const itActive = (state.networks[n] || {}).IT_ACTIVE || 0;
    const newReserved = afterRow[`t${n}`];
    if (newReserved > itActive) {
      db.prepare('DELETE FROM cabinets WHERE cabinet_id = ?').run(cabinet_id);
      console.error(`[admin] cabinets/create INVARIANT VIOLATION on ${n}: reserved=${newReserved} > IT_ACTIVE=${itActive} — rolled back`);
      return res.status(500).json({
        ok:     false,
        reason: `INVARIANT_VIOLATION: reserved_${n}(${newReserved}) > IT_ACTIVE_${n}(${itActive}). Creation rolled back.`,
      });
    }
  }

  console.log(`[admin] cabinets/create: ${cabinet_id} total=${amt} quota_per_net=${quota}`);
  return res.json({
    ok:            true,
    cabinet_id,
    access_token,
    total_balance: amt,
    reserved:      { A: quota, B: quota, C: quota, D: quota },
  });
});

// GET /admin/cabinets
router.get('/cabinets', (req, res) => {
  const cabinets = db.prepare('SELECT * FROM cabinets ORDER BY created_at DESC').all();
  const totRow   = db.prepare(`
    SELECT COALESCE(SUM(reserved_A),0) AS tA,
           COALESCE(SUM(reserved_B),0) AS tB,
           COALESCE(SUM(reserved_C),0) AS tC,
           COALESCE(SUM(reserved_D),0) AS tD
    FROM cabinets
  `).get();
  return res.json({
    ok:              true,
    count:           cabinets.length,
    cabinets,
    reserved_totals: { A: totRow.tA, B: totRow.tB, C: totRow.tC, D: totRow.tD },
  });
});

// GET /admin/cabinets/:cabinet_id/token
router.get('/cabinets/:cabinet_id/token', (req, res) => {
  const row = db.prepare('SELECT access_token FROM cabinets WHERE cabinet_id = ?').get(req.params.cabinet_id);
  if (!row) return res.status(404).json({ ok: false, reason: 'Cabinet not found.' });
  return res.json({ ok: true, cabinet_id: req.params.cabinet_id, access_token: row.access_token });
});

module.exports = router;
