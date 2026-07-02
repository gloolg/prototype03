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

const path = require('path');

// ---------------------------------------------------------------------------
// Page URL convention: canonical form is always the trailing-slash path
// (matches /dapp/, the original entry point). Express's default (non-strict)
// routing treats '/admin' and '/admin/' as the SAME pattern — registering
// both separately doesn't distinguish them, the second is dead code. So each
// page below is ONE route that branches on the literal req.path: exact
// trailing-slash match serves the file, anything else (no slash, or the raw
// .html filename) 301-redirects to the canonical form. This gives every page
// exactly one URL, instead of 3-4 different strings all quietly working.
function servePageCanonical(canonicalPath, file) {
  const filePath = path.join(__dirname, '../public', file);
  return (req, res) => {
    if (req.path === canonicalPath) return res.sendFile(filePath);
    return res.redirect(301, canonicalPath);
  };
}
function redirectTo(canonicalPath) {
  return (req, res) => res.redirect(301, canonicalPath);
}

app.use('/genesis',              require('./routes/genesis'));
app.use('/treasury',             require('./routes/treasury'));
app.use('/transfer',             require('./routes/transfer'));
app.use('/state',                require('./routes/state'));
app.use('/events',               require('./routes/events'));

// GET /transparency (no trailing slash) stays dual-purpose and UNREDIRECTED:
// it's a documented public JSON API (curl $BASE/transparency, used throughout
// demo-script.md) as well as the dashboard for plain browser navigation
// (Accept: text/html). Redirecting it would break API callers that don't
// follow redirects. /transparency/ below is the dedicated, always-HTML
// canonical dashboard URL matching the site-wide trailing-slash convention.
app.get('/transparency', (req, res, next) => {
  if (req.accepts(['json', 'html']) === 'html') {
    return res.sendFile(path.join(__dirname, '../public/transparency.html'));
  }
  next();
});
app.use('/transparency',         require('./routes/transparency'));
app.get('/transparency/',        servePageCanonical('/transparency/', 'transparency.html'));
app.get('/transparency.html',    redirectTo('/transparency/'));

app.use('/registry',             require('./routes/registry'));
app.use('/entry',                require('./routes/entry'));
app.use('/entry/multi',          require('./routes/multiEntry'));

// Admin pages must be registered BEFORE the /admin API routers below.
// app.use('/admin', adminRouter) applies requireAdmin to every /admin/* path
// that doesn't match one of adminRouter's own routes first (router.use(mw)
// has no path filter — it catches everything that falls through). If these
// page routes were registered after the routers, they'd hit requireAdmin
// and 401 before ever reaching the actual page handler.
app.get('/admin',                servePageCanonical('/admin/', 'admin.html'));
app.get('/admin.html',           redirectTo('/admin/'));
app.get('/admin/network',        servePageCanonical('/admin/network/', 'network.html'));
app.get('/network.html',         redirectTo('/admin/network/'));
app.use('/admin',                require('./routes/admin'));
app.use('/admin',                require('./routes/adminMse'));
app.use('/admin',                require('./routes/adminNetworks'));

// Cabinet — user-facing balance page (no MetaMask, access_token auth)
app.get('/cabinet',              servePageCanonical('/cabinet/', 'cabinet.html'));
app.get('/cabinet.html',         redirectTo('/cabinet/'));
app.use('/cabinet',              require('./routes/cabinet'));

// DApp — deliberately served at both / (short root) and /dapp/ (documented
// dual entry point, README_FULL). Only the incidental raw filenames — never
// a documented entry point, just static-file leakage — get normalized.
app.get('/index.html',           redirectTo('/dapp/'));
app.get('/dapp/index.html',      redirectTo('/dapp/'));
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
