'use strict';

/**
 * routes/adminMse.js — Admin endpoints for multi-source envelope management
 *
 * GET  /admin/multi-envelopes           — all non-COMPLETED envelopes + sources
 * GET  /admin/multi-envelopes/:id       — single envelope
 * POST /admin/multi-envelopes/:id/deliver      — retry delivery (FAILED/TIMEOUT)
 * POST /admin/multi-envelopes/:id/refund/:net  — refund one CONFIRMED source
 * POST /admin/multi-envelopes/:id/refund-all   — refund all CONFIRMED sources
 */

const express    = require('express');
const router     = express.Router();
const { db }     = require('../db');
const mseManager = require('../mse/manager');

function requireAdmin(req, res, next) {
  const header = req.headers['authorization'] || '';
  const token  = header.startsWith('Bearer ') ? header.slice(7) : null;
  if (!token) return res.status(401).json({ ok: false, reason: 'Unauthorized' });
  const ts      = Math.floor(Date.now() / 1000);
  const session = db.prepare('SELECT 1 FROM admin_sessions WHERE token=? AND expires_at>?').get(token, ts);
  if (!session) return res.status(401).json({ ok: false, reason: 'Invalid or expired session' });
  next();
}

router.use(requireAdmin);

// GET /admin/multi-envelopes
router.get('/multi-envelopes', (req, res) => {
  const envelopes = db.prepare(
    "SELECT * FROM mse_envelope WHERE status NOT IN ('COMPLETED') ORDER BY created_at DESC"
  ).all();

  const result = envelopes.map(env => {
    const sources = db.prepare('SELECT * FROM mse_source WHERE envelope_id=? ORDER BY id').all(env.envelope_id);
    return { ...env, sources };
  });

  return res.json({ ok: true, count: result.length, envelopes: result });
});

// GET /admin/multi-envelopes/:id
router.get('/multi-envelopes/:id', (req, res) => {
  const envelope = mseManager.getEnvelope(req.params.id);
  if (!envelope) return res.status(404).json({ ok: false, reason: 'Envelope not found.' });
  return res.json({ ok: true, envelope });
});

// POST /admin/multi-envelopes/:id/deliver
router.post('/multi-envelopes/:id/deliver', async (req, res) => {
  const result = await mseManager.retryDeliver(req.params.id);
  if (!result.ok) {
    return res.status(400).json({ ok: false, reason: result.reason });
  }
  console.log(`[admin/mse] deliver OK: ${req.params.id} tx=${result.tx_hash}`);
  return res.json({ ok: true, message: 'Delivery dispatched.', tx_hash: result.tx_hash });
});

// POST /admin/multi-envelopes/:id/refund/:net
router.post('/multi-envelopes/:id/refund/:net', async (req, res) => {
  const { id, net } = req.params;
  const result = await mseManager.refundSource(id, net);
  if (!result.ok) {
    return res.status(400).json({ ok: false, reason: result.reason });
  }
  console.log(`[admin/mse] refund OK: ${id} net=${net} tx=${result.tx_hash}`);
  return res.json({
    ok:          true,
    message:     'Refund delivered on-chain.',
    tx_hash:     result.tx_hash,
    refunded_to: result.refunded_to,
    amount:      result.amount,
  });
});

// POST /admin/multi-envelopes/:id/refund-all
router.post('/multi-envelopes/:id/refund-all', async (req, res) => {
  const envelope = mseManager.getEnvelope(req.params.id);
  if (!envelope) return res.status(404).json({ ok: false, reason: 'Envelope not found.' });

  const confirmed = envelope.sources.filter(s => s.status === 'CONFIRMED');
  if (confirmed.length === 0) {
    return res.status(400).json({ ok: false, reason: 'No CONFIRMED sources to refund.' });
  }

  const results = [];
  for (const src of confirmed) {
    const r = await mseManager.refundSource(envelope.envelope_id, src.source_network);
    results.push({ source_network: src.source_network, ...r });
    if (r.ok) {
      console.log(`[admin/mse] refund-all: ${envelope.envelope_id} net=${src.source_network} OK tx=${r.tx_hash}`);
    } else {
      console.error(`[admin/mse] refund-all: ${envelope.envelope_id} net=${src.source_network} FAILED: ${r.reason}`);
    }
  }

  const failed = results.filter(r => !r.ok);
  return res.json({
    ok:      failed.length === 0,
    total:   confirmed.length,
    success: results.filter(r => r.ok).length,
    failed:  failed.length,
    results,
  });
});

module.exports = router;
