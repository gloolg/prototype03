'use strict';

/**
 * observer/index.js — Observer / Watcher polling loop (Step 9)
 *
 * Polls each network independently every POLL_INTERVAL_MS.
 * Networks are staggered by STAGGER_MS to avoid simultaneous RPC bursts.
 *
 * Stagger offsets (STAGGER_MS = 4000):
 *   A: +0ms   B: +4000ms   C: +8000ms   D: +12000ms
 *
 * Use start() on server boot, stop() on graceful shutdown.
 */

const { processNetwork } = require('./processor');
const { db } = require('../db');

const POLL_INTERVAL_MS = 15_000;
const STAGGER_MS       = 4_000;
const NETWORKS         = ['A', 'B', 'C', 'D'];

const _timers = {};
const _busy   = {};
let   _running = false;

function start() {
  if (_running) return;
  _running = true;

  // Warn if any IT address is missing — observer filter will be incomplete
  ['A', 'B', 'C', 'D'].forEach(net => {
    if (!process.env[`IT_${net}_ADDRESS`]) {
      console.error(`[observer] CRITICAL: IT_${net}_ADDRESS not set — tester→IT transfers on Network ${net} will not be filtered`);
    }
  });

  NETWORKS.forEach((network_id, i) => {
    const delay = i * STAGGER_MS;

    // First poll after stagger delay, then repeat every POLL_INTERVAL_MS
    const initial = setTimeout(() => {
      _poll(network_id);
      _timers[network_id] = setInterval(() => _poll(network_id), POLL_INTERVAL_MS);
    }, delay);

    // Store initial timer so stop() can cancel it too
    _timers[`${network_id}_init`] = initial;
  });

  console.log('[observer] Started. Poll interval: 15s, stagger: 4s per network.');
}

function stop() {
  if (!_running) return;
  _running = false;
  for (const t of Object.values(_timers)) {
    clearTimeout(t);
    clearInterval(t);
  }
  Object.keys(_timers).forEach(k => delete _timers[k]);
  console.log('[observer] Stopped.');
}

async function _poll(network_id) {
  if (_busy[network_id]) {
    console.warn(`[observer:${network_id}] Previous poll still running — skipping tick`);
    return;
  }
  _busy[network_id] = true;
  try {
    await processNetwork(network_id);
  } catch (err) {
    // Never let an unhandled error crash the polling loop
    console.error(`[observer:${network_id}] Unhandled error in poll:`, err.message);
  } finally {
    _busy[network_id] = false;
  }
}

// GET /observer/status — returns checkpoint state for all networks
function getStatus() {
  const checkpoints = db.prepare('SELECT * FROM observer_checkpoint ORDER BY network_id').all();
  return {
    running:     _running,
    poll_interval_ms: POLL_INTERVAL_MS,
    checkpoints,
  };
}

module.exports = { start, stop, getStatus };
