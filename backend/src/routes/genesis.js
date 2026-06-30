'use strict';

/**
 * routes/genesis.js
 *
 * POST /genesis
 *   Initializes MetaRegistry with 4 networks and IT treasury addresses.
 *   Can only be called once. Returns error if already initialized.
 *
 * Request body:
 * {
 *   "networks": [
 *     { "network_id": "A", "it_address": "0x..." },
 *     { "network_id": "B", "it_address": "0x..." },
 *     { "network_id": "C", "it_address": "0x..." },
 *     { "network_id": "D", "it_address": "0x..." }
 *   ]
 * }
 *
 * Response 200:
 * {
 *   "ok": true,
 *   "message": "Genesis completed successfully."
 * }
 *
 * Response 400 — already initialized or invalid input:
 * {
 *   "ok": false,
 *   "reason": "..."
 * }
 */

const express = require('express');
const router = express.Router();
const sm = require('../stateManager');

// POST /genesis
router.post('/', (req, res) => {
  // Guard: already initialized
  if (sm.isInitialized()) {
    return res.status(400).json({
      ok:     false,
      reason: 'Genesis already completed. MetaRegistry is active.',
    });
  }

  const { networks } = req.body;

  // Basic input validation before passing to simulator
  if (!networks || !Array.isArray(networks)) {
    return res.status(400).json({
      ok:     false,
      reason: 'Request body must contain "networks" array.',
    });
  }

  if (networks.length !== 4) {
    return res.status(400).json({
      ok:     false,
      reason: `"networks" must contain exactly 4 entries. Got ${networks.length}.`,
    });
  }

  for (const n of networks) {
    if (!n.network_id || !n.it_address) {
      return res.status(400).json({
        ok:     false,
        reason: `Each network entry must have "network_id" and "it_address". Invalid entry: ${JSON.stringify(n)}`,
      });
    }
  }

  // Call stateManager — runs simulator + persists to SQLite
  const result = sm.applyGenesis({ networks });

  if (!result.ok) {
    return res.status(400).json({ ok: false, reason: result.reason });
  }

  // Return success with full state summary
  const state = sm.getFullState();

  return res.status(200).json({
    ok:      true,
    message: 'Genesis completed successfully.',
    summary: {
      status:        state.status,
      networks:      Object.keys(state.networks),
      event_count:   state.event_count,
    },
  });
});

module.exports = router;
