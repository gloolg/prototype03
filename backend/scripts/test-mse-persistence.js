'use strict';

/**
 * test-mse-persistence.js
 *
 * Verifies that MSE (multi-source envelope) state persists correctly through
 * simulated server restarts.
 *
 * Runs 5 scenarios without real RPC calls or MetaMask:
 *   1. COLLECTING with active timer → restore() reschedules timer, status stays COLLECTING
 *   2. COLLECTING with no entries yet → restore() does nothing (no timer to schedule)
 *   3. COLLECTING with expired timeout → restore() marks TIMEOUT immediately
 *   4. DELIVERING on restart → restore() marks FAILED (executor was killed mid-flight)
 *   5. Simulate 2-of-3 confirmed, restart, then confirm 3rd → reaches READY
 *
 * Usage:
 *   cd backend
 *   node scripts/test-mse-persistence.js
 *
 * Uses a separate temp DB to avoid touching the production database.
 */

require('dotenv').config();
const path   = require('path');
const fs     = require('fs');
const assert = require('assert');

// ── Temp DB setup ─────────────────────────────────────────────────────────────
const TMP_DB = path.resolve(__dirname, '../db/test-mse-persistence.sqlite');
process.env.DB_PATH = TMP_DB;

// Clean up any previous test run
if (fs.existsSync(TMP_DB)) fs.unlinkSync(TMP_DB);

// Initialize DB schema (this also creates MSE tables)
require('../src/db');
const { db, now } = require('../src/db');

// ── Helpers ───────────────────────────────────────────────────────────────────
let passed = 0;
let failed = 0;

function test(name, fn) {
  try {
    fn();
    console.log(`  ✅ ${name}`);
    passed++;
  } catch (e) {
    console.log(`  ❌ ${name}`);
    console.log(`     ${e.message}`);
    failed++;
  }
}

function insertEnvelope(overrides = {}) {
  const defaults = {
    envelope_id:      'MSE-TEST-' + Math.random().toString(36).slice(2, 8),
    target_network:   'D',
    recipient:        '0xrecipient0000000000000000000000000000000',
    total_amount:     500,
    source_count:     3,
    confirmed_count:  0,
    status:           'COLLECTING',
    transfer_applied: 0,
    first_entry_at:   null,
    timeout_at:       null,
    created_at:       now(),
    completed_at:     null,
    error_reason:     null,
  };
  const row = { ...defaults, ...overrides };
  db.prepare(`
    INSERT INTO mse_envelope
      (envelope_id, target_network, recipient, total_amount, source_count,
       confirmed_count, status, transfer_applied, first_entry_at, timeout_at,
       created_at, completed_at, error_reason)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    row.envelope_id, row.target_network, row.recipient, row.total_amount, row.source_count,
    row.confirmed_count, row.status, row.transfer_applied, row.first_entry_at, row.timeout_at,
    row.created_at, row.completed_at, row.error_reason
  );
  return row.envelope_id;
}

function insertSource(envelope_id, source_network, status = 'PENDING', actual_amount = null) {
  db.prepare(`
    INSERT INTO mse_source (envelope_id, source_network, from_address, expected_amount, actual_amount, status)
    VALUES (?, ?, '0xsender00000000000000000000000000000000000', 200, ?, ?)
  `).run(envelope_id, source_network, actual_amount, status);
}

function getEnvelopeStatus(envelope_id) {
  return db.prepare('SELECT status FROM mse_envelope WHERE envelope_id=?').get(envelope_id)?.status;
}

// ── Import manager (after DB is initialized) ──────────────────────────────────
// We need to re-require manager fresh each time to test restore() in isolation.
// Clear the module cache between tests to reset in-memory _timers.
function freshManager() {
  delete require.cache[require.resolve('../src/mse/manager')];
  return require('../src/mse/manager');
}

// ── Tests ─────────────────────────────────────────────────────────────────────
console.log('\nMSE Persistence Test\n');

// ────────────────────────────────────────────────────────────────────────
// Scenario 1: COLLECTING with active timer → reschedule, status unchanged
// ────────────────────────────────────────────────────────────────────────
console.log('Scenario 1: COLLECTING + active timer → reschedule');
{
  const ts      = now();
  const env_id  = insertEnvelope({
    status:           'COLLECTING',
    confirmed_count:  2,
    source_count:     3,
    first_entry_at:   ts - 60,   // timer started 60s ago
    timeout_at:       ts + 240,  // 240s remaining
  });
  ['A', 'B'].forEach(n => insertSource(env_id, n, 'CONFIRMED', 200));
  insertSource(env_id, 'C', 'PENDING');

  const mgr = freshManager();
  mgr.restore();

  test('status remains COLLECTING', () => assert.equal(getEnvelopeStatus(env_id), 'COLLECTING'));
  test('confirmed_count preserved', () => {
    const row = db.prepare('SELECT confirmed_count FROM mse_envelope WHERE envelope_id=?').get(env_id);
    assert.equal(row.confirmed_count, 2);
  });
}

// ────────────────────────────────────────────────────────────────────────
// Scenario 2: COLLECTING, no entries yet (timer not started)
// ────────────────────────────────────────────────────────────────────────
console.log('\nScenario 2: COLLECTING + no entries (timer not started) → no-op');
{
  const env_id = insertEnvelope({ status: 'COLLECTING', confirmed_count: 0, first_entry_at: null, timeout_at: null });
  ['A', 'B', 'C'].forEach(n => insertSource(env_id, n, 'PENDING'));

  const mgr = freshManager();
  mgr.restore();

  test('status remains COLLECTING (timer untouched)', () => assert.equal(getEnvelopeStatus(env_id), 'COLLECTING'));
}

// ────────────────────────────────────────────────────────────────────────
// Scenario 3: COLLECTING with EXPIRED timeout → mark TIMEOUT immediately
// ────────────────────────────────────────────────────────────────────────
console.log('\nScenario 3: COLLECTING + expired timeout → TIMEOUT');
{
  const ts     = now();
  const env_id = insertEnvelope({
    status:          'COLLECTING',
    confirmed_count: 1,
    source_count:    3,
    first_entry_at:  ts - 400,  // started 400s ago
    timeout_at:      ts - 100,  // expired 100s ago
  });
  insertSource(env_id, 'A', 'CONFIRMED', 200);
  ['B', 'C'].forEach(n => insertSource(env_id, n, 'PENDING'));

  const mgr = freshManager();
  mgr.restore();

  test('status changed to TIMEOUT', () => assert.equal(getEnvelopeStatus(env_id), 'TIMEOUT'));
}

// ────────────────────────────────────────────────────────────────────────
// Scenario 4: DELIVERING on restart → mark FAILED
// ────────────────────────────────────────────────────────────────────────
console.log('\nScenario 4: DELIVERING on restart → FAILED');
{
  const env_id = insertEnvelope({ status: 'DELIVERING', transfer_applied: 1 });
  ['A', 'B', 'C'].forEach(n => insertSource(env_id, n, 'CONFIRMED', 200));

  const mgr = freshManager();
  mgr.restore();

  test('status changed to FAILED', () => assert.equal(getEnvelopeStatus(env_id), 'FAILED'));
  test('error_reason set', () => {
    const row = db.prepare('SELECT error_reason FROM mse_envelope WHERE envelope_id=?').get(env_id);
    assert.ok(row.error_reason && row.error_reason.includes('SERVER_RESTART'));
  });
}

// ────────────────────────────────────────────────────────────────────────
// Scenario 5: 2-of-3 confirmed → restart → confirm 3rd → READY
// ────────────────────────────────────────────────────────────────────────
console.log('\nScenario 5: 2-of-3 confirmed → restart → confirm 3rd → READY');
{
  const ts     = now();
  const env_id = insertEnvelope({
    status:          'COLLECTING',
    confirmed_count: 2,
    source_count:    3,
    first_entry_at:  ts - 60,
    timeout_at:      ts + 240,
  });
  ['A', 'B'].forEach(n => insertSource(env_id, n, 'CONFIRMED', 200));
  insertSource(env_id, 'C', 'PENDING');

  // Simulate restart
  const mgr = freshManager();
  mgr.restore();

  test('after restart: still COLLECTING', () => assert.equal(getEnvelopeStatus(env_id), 'COLLECTING'));

  // Confirm 3rd source (direct DB call to manager.confirmSource)
  const confirmResult = mgr.confirmSource(env_id, 'C', {
    actual_amount: 200,
    tx_hash:       '0xfake000000000000000000000000000000000000000000000000000000000001',
    log_index:     0,
  });

  test('confirmSource returns ok', () => assert.ok(confirmResult.ok, JSON.stringify(confirmResult)));
  test('all_confirmed is true', () => assert.ok(confirmResult.all_confirmed));
  test('confirmed_count is 3', () => assert.equal(confirmResult.confirmed_count, 3));

  // At this point, tryDeliver would normally be called by the route.
  // We don't call it here because it needs live RPC. Just verify the state.
  // Status is still COLLECTING (tryDeliver would change it to DELIVERING/COMPLETED).
  test('envelope still COLLECTING before tryDeliver', () => assert.equal(getEnvelopeStatus(env_id), 'COLLECTING'));
}

// ── Summary ───────────────────────────────────────────────────────────────────
console.log(`\n${'─'.repeat(40)}`);
console.log(`Results: ${passed} passed, ${failed} failed`);

// Close DB and clean up temp file
db.close();
try { fs.unlinkSync(TMP_DB); } catch (_) { /* Windows may keep file locked briefly */ }
try { fs.unlinkSync(TMP_DB + '-wal'); } catch (_) {}
try { fs.unlinkSync(TMP_DB + '-shm'); } catch (_) {}

if (failed > 0) process.exit(1);
console.log('All MSE persistence tests passed.\n');
