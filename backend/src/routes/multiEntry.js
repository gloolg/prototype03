'use strict';

/**
 * routes/multiEntry.js — Multi-source envelope (MSE) DApp-facing endpoints
 *
 * POST /entry/multi/create           — create envelope, declare N sources
 * POST /entry/multi/:id/submit       — submit + verify one source tx on-chain
 * GET  /entry/multi/:id/status       — poll envelope state (for DApp)
 */

const express        = require('express');
const router         = express.Router();
const { ethers }     = require('ethers');
const { db, now }    = require('../db');
const sm             = require('../stateManager');
const { getProvider, CONTRACT_ADDRESS } = require('../executor/networks');
const mseManager     = require('../mse/manager');

const TRANSFER_TOPIC = ethers.id('Transfer(address,address,uint256)');
const getValidNetworkIds = () => Object.keys(sm.getState().networks);

const IT_ADDRESSES = () => ({
  A: (process.env.IT_A_ADDRESS || '').toLowerCase(),
  B: (process.env.IT_B_ADDRESS || '').toLowerCase(),
  C: (process.env.IT_C_ADDRESS || '').toLowerCase(),
  D: (process.env.IT_D_ADDRESS || '').toLowerCase(),
});

// POST /entry/multi/create
router.post('/create', (req, res) => {
  if (!sm.isInitialized()) {
    return res.status(400).json({ ok: false, reason: 'MetaRegistry not initialized.' });
  }

  const { target_network, recipient, sources } = req.body || {};

  const VALID_NETS = getValidNetworkIds();

  if (!target_network || !recipient || !Array.isArray(sources) || sources.length < 2) {
    return res.status(400).json({
      ok:     false,
      reason: 'Required: target_network, recipient, sources (array with at least 2 items).',
    });
  }
  if (!VALID_NETS.includes(target_network)) {
    return res.status(400).json({ ok: false, reason: 'Invalid target_network.' });
  }
  if (!/^0x[0-9a-fA-F]{40}$/.test(recipient)) {
    return res.status(400).json({ ok: false, reason: 'Invalid recipient address.' });
  }

  for (const s of sources) {
    if (!VALID_NETS.includes(s.source_network)) {
      return res.status(400).json({ ok: false, reason: `Invalid source_network: ${s.source_network}` });
    }
    if (!/^0x[0-9a-fA-F]{40}$/.test(s.from_address)) {
      return res.status(400).json({ ok: false, reason: `Invalid from_address in source ${s.source_network}` });
    }
    const amt = parseInt(s.expected_amount, 10);
    if (!Number.isInteger(amt) || amt <= 0) {
      return res.status(400).json({ ok: false, reason: `Invalid expected_amount in source ${s.source_network}` });
    }
    s.expected_amount = amt; // normalize to integer
  }

  // All from_address must be the same — same MetaMask wallet on all EVM networks
  const uniqueAddrs = new Set(sources.map(s => s.from_address.toLowerCase()));
  if (uniqueAddrs.size > 1) {
    return res.status(400).json({
      ok:     false,
      reason: 'All sources must share the same from_address (same wallet on all source networks).',
    });
  }

  // No duplicate source networks
  const uniqueNets = new Set(sources.map(s => s.source_network));
  if (uniqueNets.size < sources.length) {
    return res.status(400).json({ ok: false, reason: 'Duplicate source_network in sources.' });
  }

  // Block true self-loop: source_network == target_network AND sender == recipient
  // (delivering to yourself on the same network through the registry is a no-op).
  // Delivering to a DIFFERENT wallet on the same network as a source is valid.
  const senderAddr = sources[0].from_address.toLowerCase();
  if (uniqueNets.has(target_network) && senderAddr === recipient.toLowerCase()) {
    return res.status(400).json({
      ok:     false,
      reason: 'SELF_TRANSFER_NOT_ALLOWED: source_network equals target_network with the same sender and recipient address.',
    });
  }

  const result = mseManager.create({ target_network, recipient, sources });

  console.log(
    `[mse] create: ${result.envelope_id} ` +
    `${sources.map(s => `${s.source_network}(${s.expected_amount})`).join('+')} → ${target_network} ` +
    `total=${result.total_amount} tEQUI`
  );

  return res.json({
    ok:           true,
    envelope_id:  result.envelope_id,
    total_amount: result.total_amount,
    source_count: result.source_count,
    timeout_sec:  300,
    message:      `MSE created. Submit each source tx via POST /entry/multi/${result.envelope_id}/submit`,
  });
});

// POST /entry/multi/:envelope_id/submit
router.post('/:envelope_id/submit', async (req, res) => {
  if (!sm.isInitialized()) {
    return res.status(400).json({ ok: false, reason: 'MetaRegistry not initialized.' });
  }

  const { envelope_id } = req.params;
  const { tx_hash, source_network } = req.body || {};

  const VALID_NETS = getValidNetworkIds();

  if (!tx_hash || !source_network) {
    return res.status(400).json({ ok: false, reason: 'Required: tx_hash, source_network.' });
  }
  if (!VALID_NETS.includes(source_network)) {
    return res.status(400).json({ ok: false, reason: 'Invalid source_network.' });
  }

  const envelope = mseManager.getEnvelope(envelope_id);
  if (!envelope) {
    return res.status(404).json({ ok: false, reason: 'Envelope not found.' });
  }
  if (envelope.status !== 'COLLECTING') {
    return res.status(400).json({ ok: false, reason: `Envelope is ${envelope.status}, not COLLECTING.` });
  }

  const source = envelope.sources.find(s => s.source_network === source_network);
  if (!source) {
    return res.status(400).json({ ok: false, reason: `source_network=${source_network} not declared in this envelope.` });
  }
  if (source.status === 'CONFIRMED') {
    return res.status(400).json({ ok: false, reason: 'Source already confirmed.', tx_hash: source.tx_hash });
  }

  // Idempotency: reject if tx already claimed by /entry or another MSE submit
  const seenEntry = db.prepare('SELECT 1 FROM observer_seen_txs WHERE tx_hash=? AND log_index=-1').get(tx_hash);
  if (seenEntry) {
    return res.status(400).json({ ok: false, reason: 'Transaction already processed as an entry.' });
  }

  // Fetch on-chain receipt
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
    return res.status(502).json({ ok: false, reason: `RPC error fetching receipt: ${e.message}` });
  }

  if (!receipt) {
    return res.status(400).json({ ok: false, reason: 'Transaction not found on-chain (may still be pending).' });
  }
  if (receipt.status !== 1) {
    return res.status(400).json({ ok: false, reason: 'Transaction failed on-chain (status=0).' });
  }

  // Find Transfer log directed to IT-EOA on source_network
  const it         = IT_ADDRESSES();
  const expectedIt = it[source_network];
  if (!expectedIt) {
    return res.status(500).json({ ok: false, reason: `IT_${source_network}_ADDRESS not configured on server.` });
  }

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

  if (rawAmount % (10n ** 18n) !== 0n) {
    return res.status(400).json({ ok: false, reason: `Fractional tEQUI amount not accepted (raw=${rawAmount}).` });
  }

  const onChainAmount = Number(rawAmount / (10n ** 18n));

  // Verify sender matches declared from_address
  if (from_address !== source.from_address) {
    return res.status(400).json({
      ok:     false,
      reason: `Sender mismatch: on-chain ${from_address}, declared ${source.from_address}.`,
    });
  }

  // Verify amount matches declared expected_amount
  if (onChainAmount !== source.expected_amount) {
    return res.status(400).json({
      ok:     false,
      reason: `Amount mismatch: declared ${source.expected_amount}, on-chain ${onChainAmount}.`,
    });
  }

  // Mark tx log as claimed with its REAL log_index so the Observer's idempotency
  // check (WHERE tx_hash=? AND log_index=?) finds it and skips applyObservation.
  // Using -1 here would let the Observer re-process the same log, decrementing
  // wallet_active before tryDeliver runs → INSUFFICIENT_SOURCE_BALANCE.
  const log_index = transferLog.index ?? transferLog.logIndex ?? 0;
  db.prepare(
    'INSERT OR IGNORE INTO observer_seen_txs (tx_hash, log_index, network_id, processed_at) VALUES (?, ?, ?, ?)'
  ).run(tx_hash, log_index, source_network, now());

  // Confirm source in MSE state machine
  const confirmResult = mseManager.confirmSource(envelope_id, source_network, {
    actual_amount: onChainAmount,
    tx_hash,
    log_index,
  });

  if (!confirmResult.ok) {
    return res.status(400).json({ ok: false, reason: confirmResult.reason });
  }

  console.log(
    `[mse] source confirmed: ${envelope_id} net=${source_network} ` +
    `${confirmResult.confirmed_count}/${confirmResult.source_count} tx=${tx_hash}`
  );

  if (confirmResult.all_confirmed) {
    // All N sources in — trigger delivery async (DApp gets immediate response)
    console.log(`[mse] all sources confirmed: ${envelope_id} — dispatching delivery`);
    mseManager.tryDeliver(envelope_id).catch(err => {
      console.error(`[mse] tryDeliver error for ${envelope_id}: ${err.message}`);
    });

    return res.json({
      ok:              true,
      all_confirmed:   true,
      confirmed_count: confirmResult.confirmed_count,
      source_count:    confirmResult.source_count,
      message:         'All sources confirmed. Delivery dispatched on-chain.',
    });
  }

  const remaining = confirmResult.source_count - confirmResult.confirmed_count;
  return res.json({
    ok:              true,
    all_confirmed:   false,
    confirmed_count: confirmResult.confirmed_count,
    source_count:    confirmResult.source_count,
    message:         `Source ${source_network} confirmed. Waiting for ${remaining} more source(s).`,
  });
});

// GET /entry/multi/:envelope_id/status
router.get('/:envelope_id/status', (req, res) => {
  const envelope = mseManager.getEnvelope(req.params.envelope_id);
  if (!envelope) {
    return res.status(404).json({ ok: false, reason: 'Envelope not found.' });
  }
  return res.json({ ok: true, envelope });
});

module.exports = router;
