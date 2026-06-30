'use strict';

/**
 * routes/transfer.js
 *
 * POST /transfer
 *   Executes a tEQUI transfer through MetaRegistry.
 *   Supports cross-network and same-network transfers.
 *   Source mode: AUTOMATIC (priority A→B→C→D) or USER_DEFINED (explicit per-network amounts).
 *
 * Request body — AUTOMATIC:
 * {
 *   "source_mode":    "AUTOMATIC",
 *   "amount":         5000,
 *   "sender":         "0x...",
 *   "recipient":      "0x...",
 *   "target_network": "B"
 * }
 *
 * Request body — USER_DEFINED:
 * {
 *   "source_mode":    "USER_DEFINED",
 *   "amount":         5000,
 *   "sender":         "0x...",
 *   "recipient":      "0x...",
 *   "target_network": "B",
 *   "sources": [
 *     { "source_network": "A", "amount": 3000 },
 *     { "source_network": "C", "amount": 2000 }
 *   ]
 * }
 *
 * Response 200:
 * {
 *   "ok": true,
 *   "event_id": "EVT-...",
 *   "state_after": { ... }
 * }
 *
 * Response 400:
 * {
 *   "ok": false,
 *   "reason": "...",
 *   "detail": { ... }
 * }
 */

const express = require('express');
const router  = express.Router();
const sm      = require('../stateManager');

const getValidNetworkIds = () => Object.keys(sm.getState().networks);
const VALID_SOURCE_MODES = ['AUTOMATIC', 'USER_DEFINED'];

// POST /transfer
router.post('/', (req, res) => {
  // Guard: genesis must be complete
  if (!sm.isInitialized()) {
    return res.status(400).json({
      ok:     false,
      reason: 'MetaRegistry not initialized. Call POST /genesis first.',
    });
  }

  const { source_mode, amount, sender, recipient, target_network, sources } = req.body;

  // ── Input validation ──────────────────────────────────────────────────────

  if (!source_mode || !VALID_SOURCE_MODES.includes(source_mode)) {
    return res.status(400).json({
      ok:     false,
      reason: `"source_mode" must be one of: ${VALID_SOURCE_MODES.join(', ')}. Got: ${source_mode}`,
    });
  }

  if (!Number.isInteger(amount) || amount <= 0) {
    return res.status(400).json({
      ok:     false,
      reason: '"amount" must be a positive integer.',
    });
  }

  if (!sender || typeof sender !== 'string' || sender.trim() === '') {
    return res.status(400).json({
      ok:     false,
      reason: '"sender" must be a non-empty string.',
    });
  }

  if (!recipient || typeof recipient !== 'string' || recipient.trim() === '') {
    return res.status(400).json({
      ok:     false,
      reason: '"recipient" must be a non-empty string.',
    });
  }

  const VALID_NETWORK_IDS = getValidNetworkIds();
  if (!target_network || !VALID_NETWORK_IDS.includes(target_network)) {
    return res.status(400).json({
      ok:     false,
      reason: `"target_network" must be one of: ${VALID_NETWORK_IDS.join(', ')}. Got: ${target_network}`,
    });
  }

  // USER_DEFINED: sources array required and must be valid
  if (source_mode === 'USER_DEFINED') {
    if (!sources || !Array.isArray(sources) || sources.length === 0) {
      return res.status(400).json({
        ok:     false,
        reason: 'USER_DEFINED source_mode requires a non-empty "sources" array.',
      });
    }

    let sources_total = 0;
    for (const s of sources) {
      if (!s.source_network || !VALID_NETWORK_IDS.includes(s.source_network)) {
        return res.status(400).json({
          ok:     false,
          reason: `Each source must have a valid "source_network". Got: ${JSON.stringify(s)}`,
        });
      }
      if (!Number.isInteger(s.amount) || s.amount <= 0) {
        return res.status(400).json({
          ok:     false,
          reason: `Each source must have a positive integer "amount". Got: ${JSON.stringify(s)}`,
        });
      }
      sources_total += s.amount;
    }

    if (sources_total !== amount) {
      return res.status(400).json({
        ok:     false,
        reason: `Sum of sources amounts (${sources_total}) must equal "amount" (${amount}).`,
      });
    }
  }

  // ── Call stateManager ────────────────────────────────────────────────────

  const result = sm.applyTransfer({
    source_mode,
    amount,
    sender:         sender.trim(),
    recipient:      recipient.trim(),
    target_network,
    sources:        sources || null,
  });

  if (!result.ok) {
    return res.status(400).json({
      ok:     false,
      reason: result.reason || 'Transfer rejected.',
      detail: result,
    });
  }

  return res.status(200).json({
    ok:          true,
    event_id:    result.event_id || null,
    state_after: result.state_after || null,
  });
});

module.exports = router;
