'use strict';

/**
 * routes/state.js
 *
 * GET /state
 *   Returns the full current in-memory state summary.
 *   Includes networks, treasuries, wallets, event count, snapshot count.
 *
 * Response 200:
 * {
 *   "ok": true,
 *   "state": {
 *     "status": "ACTIVE",
 *     "genesis_complete": true,
 *     "networks": { ... },
 *     "treasuries": { ... },
 *     "wallets": { ... },
 *     "event_count": 12,
 *     "snapshot_count": 3
 *   }
 * }
 *
 * Response 400 — not initialized:
 * {
 *   "ok": false,
 *   "reason": "..."
 * }
 */

const express = require('express');
const router  = express.Router();
const sm      = require('../stateManager');

// GET /state
router.get('/', (req, res) => {
  if (!sm.isInitialized()) {
    return res.status(400).json({
      ok:     false,
      reason: 'MetaRegistry not initialized. Call POST /genesis first.',
    });
  }

  const state = sm.getFullState();

  return res.status(200).json({
    ok:    true,
    state,
  });
});

module.exports = router;
