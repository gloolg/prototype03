'use strict';

/**
 * routes/transparency.js
 *
 * GET /transparency
 *   Returns canonical transparency snapshot for the public eqi.network page.
 *   Mirrors getTransparencySnapshot() from simulator.
 *   Optional query param:
 *     ?limit=50   — max latest_operations to include (default 50)
 *
 * Response 200:
 * {
 *   "ok": true,
 *   "snapshot": {
 *     "global_state": { TOTAL_MINTED, A_ACTIVE, TOTAL_FROZEN, invariant_status, system_status },
 *     "per_network":  { A: { ... }, B: { ... }, C: { ... }, D: { ... } },
 *     "treasury_state": { "IT-A": { it_address, IT_ACTIVE, IT_FROZEN }, ... },
 *     "token_state_summary": { active, frozen, UNAVAILABLE, reconciliation_required },
 *     "latest_operations": [ ... ],
 *     "reconciliation_queue": [ ... ],
 *     "snapshot_at": 1234567890
 *   }
 * }
 */

const express = require('express');
const router  = express.Router();
const sm      = require('../stateManager');

const DEFAULT_LIMIT = 50;
const MAX_LIMIT     = 200;

// GET /transparency
router.get('/', (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET');

  if (!sm.isInitialized()) {
    return res.status(400).json({
      ok:     false,
      reason: 'MetaRegistry not initialized. Call POST /genesis first.',
    });
  }

  let limit = parseInt(req.query.limit, 10);
  if (isNaN(limit) || limit <= 0) limit = DEFAULT_LIMIT;
  if (limit > MAX_LIMIT) limit = MAX_LIMIT;

  const snapshot = sm.getTransparency(limit);

  return res.status(200).json({
    ok:       true,
    snapshot,
  });
});

module.exports = router;
