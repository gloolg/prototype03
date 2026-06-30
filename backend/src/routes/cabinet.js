'use strict';

/**
 * routes/cabinet.js — Cabinet endpoints
 *
 * POST /cabinet/auth                        — verify access_token → session token
 * GET  /cabinet/balance                     — total_balance for current cabinet
 * POST /cabinet/withdraw                    — initiate withdrawal to external address
 * GET  /cabinet/withdraw/:withdraw_id/status — poll withdrawal status
 */

const express    = require('express');
const router     = express.Router();
const { randomBytes } = require('crypto');
const { db, now }    = require('../db');
const sm             = require('../stateManager');
const { processWithdraw } = require('../cabinet/withdraw');

const SESSION_TTL = 8 * 60 * 60; // 8 hours
const VALID_NETS  = ['A', 'B', 'C', 'D'];

// ── Auth middleware ───────────────────────────────────────────────────────────

function requireCabinet(req, res, next) {
  const header = req.headers['authorization'] || '';
  const token  = header.startsWith('Bearer ') ? header.slice(7) : null;
  if (!token) return res.status(401).json({ ok: false, reason: 'Unauthorized' });
  const ts      = Math.floor(Date.now() / 1000);
  const session = db.prepare(
    'SELECT cabinet_id FROM cabinet_sessions WHERE token=? AND expires_at>?'
  ).get(token, ts);
  if (!session) return res.status(401).json({ ok: false, reason: 'Invalid or expired session' });
  req.cabinet_id = session.cabinet_id;
  next();
}

// ── POST /cabinet/auth ────────────────────────────────────────────────────────

router.post('/auth', (req, res) => {
  const { access_token } = req.body || {};
  if (!access_token || typeof access_token !== 'string') {
    return res.status(400).json({ ok: false, reason: 'Missing access_token' });
  }

  const cabinet = db.prepare('SELECT * FROM cabinets WHERE access_token=?').get(access_token.trim());
  if (!cabinet) return res.status(401).json({ ok: false, reason: 'Invalid access token' });

  const token = randomBytes(32).toString('hex');
  const ts    = Math.floor(Date.now() / 1000);
  db.prepare(
    'INSERT INTO cabinet_sessions (token, cabinet_id, created_at, expires_at) VALUES (?, ?, ?, ?)'
  ).run(token, cabinet.cabinet_id, ts, ts + SESSION_TTL);
  // Clean up expired sessions
  db.prepare('DELETE FROM cabinet_sessions WHERE expires_at < ?').run(ts);

  return res.json({ ok: true, token, expires_in: SESSION_TTL });
});

// ── GET /cabinet/balance ──────────────────────────────────────────────────────

router.get('/balance', requireCabinet, (req, res) => {
  const cabinet = db.prepare('SELECT * FROM cabinets WHERE cabinet_id=?').get(req.cabinet_id);
  if (!cabinet) return res.status(404).json({ ok: false, reason: 'Cabinet not found' });
  return res.json({
    ok:            true,
    total_balance: cabinet.total_balance,
    reserved:      { A: cabinet.reserved_A, B: cabinet.reserved_B, C: cabinet.reserved_C, D: cabinet.reserved_D },
  });
});

// ── POST /cabinet/withdraw ────────────────────────────────────────────────────

router.post('/withdraw', requireCabinet, async (req, res) => {
  if (!sm.isInitialized()) {
    return res.status(400).json({ ok: false, reason: 'MetaRegistry not initialized' });
  }

  const { recipient, target_network, amount } = req.body || {};

  if (!recipient || typeof recipient !== 'string') {
    return res.status(400).json({ ok: false, reason: 'Missing or invalid recipient' });
  }
  if (!/^0x[0-9a-fA-F]{40}$/.test(recipient)) {
    return res.status(400).json({ ok: false, reason: 'Invalid Ethereum address format' });
  }
  if (!target_network || !VALID_NETS.includes(target_network)) {
    return res.status(400).json({ ok: false, reason: 'target_network must be A, B, C, or D' });
  }
  const amt = parseInt(amount, 10);
  if (!Number.isInteger(amt) || amt <= 0) {
    return res.status(400).json({ ok: false, reason: 'amount must be a positive integer' });
  }

  const cabinet = db.prepare('SELECT * FROM cabinets WHERE cabinet_id=?').get(req.cabinet_id);
  if (!cabinet) return res.status(404).json({ ok: false, reason: 'Cabinet not found' });

  if (cabinet.total_balance < amt) {
    return res.status(400).json({
      ok:        false,
      reason:    'INSUFFICIENT_BALANCE',
      available: cabinet.total_balance,
      requested: amt,
    });
  }

  try {
    const result = await processWithdraw({
      cabinet,
      recipient:      recipient.toLowerCase(),
      target_network,
      amount:         amt,
    });

    if (!result.ok) {
      return res.status(400).json({ ok: false, reason: result.reason, withdraw_id: result.withdraw_id, steps: result.steps });
    }

    return res.json({
      ok:          true,
      withdraw_id: result.withdraw_id,
      steps:       result.steps,
      message:     'Withdrawal completed.',
    });
  } catch (err) {
    console.error('[cabinet] withdraw unhandled error:', err.message);
    return res.status(500).json({ ok: false, reason: 'INTERNAL_ERROR', detail: err.message });
  }
});

// ── GET /cabinet/withdraw/:withdraw_id/status ─────────────────────────────────

router.get('/withdraw/:withdraw_id/status', requireCabinet, (req, res) => {
  const withdrawal = db.prepare(
    'SELECT * FROM cabinet_withdrawals WHERE withdraw_id=? AND cabinet_id=?'
  ).get(req.params.withdraw_id, req.cabinet_id);
  if (!withdrawal) return res.status(404).json({ ok: false, reason: 'Withdrawal not found' });

  const steps = db.prepare(
    'SELECT * FROM cabinet_withdrawal_steps WHERE withdraw_id=? ORDER BY id'
  ).all(req.params.withdraw_id);

  return res.json({ ok: true, withdrawal, steps });
});

module.exports = router;
