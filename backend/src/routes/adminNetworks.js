'use strict';

/**
 * routes/adminNetworks.js — Admin: network configuration management
 *
 * GET   /admin/networks           — list configured networks (no private keys)
 * POST  /admin/networks           — add new network
 * PATCH /admin/networks/:id/rpc   — update rpc_url only
 *
 * All routes require admin Bearer auth.
 * req.body is NEVER logged — contains it_eoa_private_key.
 */

const express     = require('express');
const router      = express.Router();
const { db, now } = require('../db');

// ── Auth ──────────────────────────────────────────────────────────────────────

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

// ── Validation ────────────────────────────────────────────────────────────────

const RPC_RE      = /^(https?|wss?):\/\/.+/i;
const EVM_ADDR_RE = /^0x[0-9a-fA-F]{40}$/;
const EVM_KEY_RE  = /^(0x)?[0-9a-fA-F]{64}$/;
const NET_ID_RE   = /^[A-Za-z0-9-]{1,10}$/;

function validatePayload(body, isEvm) {
  const errors = [];
  const { network_id, network_name, chain_type, rpc_url, chain_id,
          contract_address, it_eoa_address, it_eoa_private_key } = body;

  if (!network_id || !NET_ID_RE.test(network_id))
    errors.push('network_id: 1–10 chars, only letters/digits/hyphens');
  if (!network_name || !network_name.trim())
    errors.push('network_name required');
  if (!chain_type || !chain_type.trim())
    errors.push('chain_type required');
  if (!rpc_url || !RPC_RE.test(rpc_url))
    errors.push('rpc_url: must be http/https/ws/wss URL');
  if (!it_eoa_address || !it_eoa_address.trim())
    errors.push('it_eoa_address required');
  if (!it_eoa_private_key || !it_eoa_private_key.trim())
    errors.push('it_eoa_private_key required');

  if (isEvm) {
    if (it_eoa_address && !EVM_ADDR_RE.test(it_eoa_address.trim()))
      errors.push('it_eoa_address: must be 0x + 40 hex chars (EVM)');
    if (it_eoa_private_key && !EVM_KEY_RE.test(it_eoa_private_key.trim()))
      errors.push('it_eoa_private_key: must be 64 hex chars with or without 0x prefix (EVM)');
    if (contract_address && contract_address.trim() && !EVM_ADDR_RE.test(contract_address.trim()))
      errors.push('contract_address: must be 0x + 40 hex chars (EVM)');
    const cid = parseInt(chain_id, 10);
    if (!Number.isInteger(cid) || cid <= 0)
      errors.push('chain_id: must be a positive integer (EVM)');
  }

  return errors;
}

// ── GET /admin/networks ───────────────────────────────────────────────────────

router.get('/networks', (req, res) => {
  const rows = db.prepare(`
    SELECT network_id, network_name, chain_type, rpc_url, chain_id,
           contract_address, it_eoa_address, symbol, explorer_url,
           created_at, updated_at
    FROM network_config ORDER BY created_at ASC
  `).all();
  return res.json({ ok: true, networks: rows });
});

// ── POST /admin/networks ──────────────────────────────────────────────────────

router.post('/networks', (req, res) => {
  // Do NOT log req.body — contains it_eoa_private_key
  const body = req.body || {};
  const {
    network_id, network_name, chain_type = 'EVM', rpc_url, chain_id,
    contract_address, it_eoa_address, it_eoa_private_key,
    symbol = 'tEQUI', explorer_url,
  } = body;

  const isEvm = (chain_type || '').toUpperCase() === 'EVM';
  const errors = validatePayload(body, isEvm);
  if (errors.length) {
    return res.status(400).json({ ok: false, reason: 'Validation failed', errors });
  }

  const idTrimmed = network_id.trim();

  const existingCfg  = db.prepare('SELECT 1 FROM network_config WHERE network_id=?').get(idTrimmed);
  if (existingCfg) {
    return res.status(409).json({ ok: false, reason: `network_id '${idTrimmed}' already exists in config` });
  }
  const existingLive = db.prepare('SELECT 1 FROM network_state WHERE network_id=?').get(idTrimmed);
  if (existingLive) {
    return res.status(409).json({ ok: false, reason: `network_id '${idTrimmed}' is already an active live network` });
  }

  const cid = (isEvm && chain_id !== undefined && chain_id !== null && chain_id !== '')
    ? parseInt(chain_id, 10)
    : null;

  db.prepare(`
    INSERT INTO network_config
      (network_id, network_name, chain_type, rpc_url, chain_id,
       contract_address, it_eoa_address, it_eoa_private_key,
       symbol, explorer_url, created_at, updated_at)
    VALUES
      (@network_id, @network_name, @chain_type, @rpc_url, @chain_id,
       @contract_address, @it_eoa_address, @it_eoa_private_key,
       @symbol, @explorer_url, @created_at, @updated_at)
  `).run({
    network_id:         idTrimmed,
    network_name:       network_name.trim(),
    chain_type:         (chain_type || 'EVM').trim().toUpperCase(),
    rpc_url:            rpc_url.trim(),
    chain_id:           cid,
    contract_address:   contract_address ? contract_address.trim() : null,
    it_eoa_address:     it_eoa_address.trim(),
    it_eoa_private_key: it_eoa_private_key.trim(),
    symbol:             symbol ? symbol.trim() : 'tEQUI',
    explorer_url:       explorer_url ? explorer_url.trim() : null,
    created_at:         now(),
    updated_at:         now(),
  });

  console.log(`[networks] added network_id=${idTrimmed} chain_type=${(chain_type||'').toUpperCase()}`);
  return res.status(201).json({ ok: true, network_id: idTrimmed });
});

// ── PATCH /admin/networks/:id/rpc ─────────────────────────────────────────────

router.patch('/networks/:id/rpc', (req, res) => {
  const { id }      = req.params;
  const { rpc_url } = req.body || {};

  if (!rpc_url || !RPC_RE.test(rpc_url.trim())) {
    return res.status(400).json({ ok: false, reason: 'rpc_url: must be http/https/ws/wss URL' });
  }

  const row = db.prepare('SELECT 1 FROM network_config WHERE network_id=?').get(id);
  if (!row) {
    return res.status(404).json({ ok: false, reason: `network_id '${id}' not found` });
  }

  const trimmed = rpc_url.trim();
  db.prepare('UPDATE network_config SET rpc_url=?, updated_at=? WHERE network_id=?')
    .run(trimmed, now(), id);

  console.log(`[networks] rpc_url updated network_id=${id}`);
  return res.json({ ok: true, network_id: id, rpc_url: trimmed });
});

module.exports = router;
