'use strict';

/**
 * server.js — MetaRegistry MVP Backend
 * Entry point. Initializes DB, registers routes, starts HTTP server.
 */

require('dotenv').config();
const express = require('express');

// Initialize DB first — creates tables if they don't exist
const { db, now } = require('./db');

// Restore in-memory state from SQLite if previous session exists
const { restoreState, loadOnChainBalances } = require('./stateManager');
restoreState();

// Clean up stale PENDING execution_log rows from before server restart.
// If executor crashed mid-flight, those commands are unresolvable without admin review.
db.prepare(
  "UPDATE execution_log SET status='FAILED', error_reason='PENDING: SERVER_RESTART', completed_at=? WHERE status='PENDING'"
).run(now());

// Restore MSE (multi-source envelope) timer state from DB.
// Must run after the PENDING cleanup above so DELIVERING envelopes see the cleaned log.
const mseManager = require('./mse/manager');
mseManager.restore();

const observer = require('./observer');

const app = express();

// ---------------------------------------------------------------------------
// Middleware
// ---------------------------------------------------------------------------

// CORS — allow all origins (testnet MVP; tighten for production)
app.use((req, res, next) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  if (req.method === 'OPTIONS') return res.sendStatus(204);
  next();
});

// Parse JSON request bodies
app.use(express.json());

// Simple request logger for development
app.use((req, res, next) => {
  const ts = new Date().toISOString();
  console.log(`[${ts}] ${req.method} ${req.path}`);
  next();
});

// ---------------------------------------------------------------------------
// Routes
// ---------------------------------------------------------------------------

app.use('/genesis',              require('./routes/genesis'));
app.use('/treasury',             require('./routes/treasury'));
app.use('/transfer',             require('./routes/transfer'));
app.use('/state',                require('./routes/state'));
app.use('/events',               require('./routes/events'));
// GET /transparency is dual-purpose: plain browser navigation (Accept: text/html)
// gets the public dashboard page; API clients (curl, fetch — default Accept: */*,
// which ties in favor of the first-listed type below) get the JSON snapshot from
// routes/transparency.js, unchanged. This keeps the documented public API contract
// at GET /transparency working while making the dashboard reachable at the same
// URL a person would actually type, instead of only at /transparency.html.
app.get('/transparency', (req, res, next) => {
  if (req.accepts(['json', 'html']) === 'html') {
    return res.sendFile(path.join(__dirname, '../public/transparency.html'));
  }
  next();
});
app.use('/transparency',         require('./routes/transparency'));
app.use('/registry',             require('./routes/registry'));
app.use('/entry',                require('./routes/entry'));
app.use('/entry/multi',          require('./routes/multiEntry'));
// Serve admin panel HTML pages BEFORE the /admin API routers below.
// Express tries middleware/routes in registration order: app.use('/admin', adminRouter)
// applies requireAdmin to every /admin/* sub-path that doesn't match one of its own
// routes first (router.use(requireAdmin) has no path filter, so it catches everything
// that falls through). If these two page routes were registered AFTER the routers,
// GET /admin/network would hit admin.js's requireAdmin and 401 before ever reaching
// this handler — the page would never be served at all. Keep both page routes here.
app.get('/admin', (req, res) => {
  res.sendFile(path.join(__dirname, '../public/admin.html'));
});
app.get('/admin/network', (req, res) => {
  res.sendFile(path.join(__dirname, '../public/network.html'));
});
app.use('/admin',                require('./routes/admin'));
app.use('/admin',                require('./routes/adminMse'));
app.use('/admin',                require('./routes/adminNetworks'));

// Cabinet — user-facing balance page (no MetaMask, access_token auth)
app.get('/cabinet', (req, res) => {
  res.sendFile(path.join(__dirname, '../public/cabinet.html'));
});
app.use('/cabinet',              require('./routes/cabinet'));

// Serve DApp static files — accessible at both / and /dapp/
const path = require('path');
app.use(express.static(path.join(__dirname, '../public')));
app.use('/dapp', express.static(path.join(__dirname, '../public')));

// ---------------------------------------------------------------------------
// Health checks
// ---------------------------------------------------------------------------

app.get('/health', (req, res) => {
  res.json({ status: 'ok', ts: Math.floor(Date.now() / 1000) });
});

app.use('/health/gas', require('./routes/healthGas'));

app.get('/observer/status', (req, res) => res.json(observer.getStatus()));

// ---------------------------------------------------------------------------
// 404 handler
// ---------------------------------------------------------------------------

app.use((req, res) => {
  res.status(404).json({ error: 'NOT_FOUND', path: req.path });
});

// ---------------------------------------------------------------------------
// Global error handler
// ---------------------------------------------------------------------------

app.use((err, req, res, next) => { // eslint-disable-line no-unused-vars
  console.error('[ERROR]', err);
  res.status(500).json({
    error: 'INTERNAL_ERROR',
    message: err.message || 'Unexpected error'
  });
});

// ---------------------------------------------------------------------------
// Start
// ---------------------------------------------------------------------------

const PORT = parseInt(process.env.PORT, 10) || 3000;

// Async startup: load on-chain balances before accepting requests.
// If RPC is unavailable, server starts in degraded mode (arithmetic balances from SQLite).
(async () => {
  try {
    await loadOnChainBalances();
    console.log('[server] On-chain balance sync complete.');
  } catch (e) {
    console.warn('[server] On-chain balance sync failed — running with arithmetic state:', e.message);
  }

  const server = app.listen(PORT, () => {
    console.log(`MetaRegistry backend running on port ${PORT}`);
    console.log(`DB: ${process.env.DB_PATH || './db/metaregistry.sqlite'}`);
    observer.start();
  });

  process.on('SIGTERM', () => { observer.stop(); server.close(); });
  process.on('SIGINT',  () => { observer.stop(); server.close(); });
})();

module.exports = app;
