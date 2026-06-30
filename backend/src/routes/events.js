'use strict';

/**
 * routes/events.js
 *
 * GET /events
 *   Returns append-only event history.
 *   Optional query params:
 *     ?envelope_id=ENV-001   — filter by envelope
 *     ?limit=50              — max records (default 50, max 500)
 *
 * Response 200:
 * {
 *   "ok": true,
 *   "count": 12,
 *   "events": [ { event_id, event_type, network_id, ... }, ... ]
 * }
 */

const express = require('express');
const router  = express.Router();
const sm      = require('../stateManager');

const DEFAULT_LIMIT = 50;
const MAX_LIMIT     = 500;

// GET /events
router.get('/', (req, res) => {
  if (!sm.isInitialized()) {
    return res.status(400).json({
      ok:     false,
      reason: 'MetaRegistry not initialized. Call POST /genesis first.',
    });
  }

  const { envelope_id, tx_hash } = req.query;
  let limit = parseInt(req.query.limit, 10);

  if (isNaN(limit) || limit <= 0) limit = DEFAULT_LIMIT;
  if (limit > MAX_LIMIT) limit = MAX_LIMIT;

  let events = sm.getEventHistory(envelope_id || null, limit);

  // Optional: filter by tx_hash presence in metadata (for DApp polling after entry tx)
  if (tx_hash) {
    events = events.filter(e =>
      e.evidence === tx_hash ||
      (typeof e.evidence === 'string' && e.evidence.includes(tx_hash))
    );
  }

  return res.status(200).json({
    ok:     true,
    count:  events.length,
    events,
  });
});

module.exports = router;
