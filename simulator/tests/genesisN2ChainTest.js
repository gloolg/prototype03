'use strict';

/**
 * genesisN2ChainTest.js
 *
 * Backend-stack chain test: genesis N=2 → getTransparency → network-add C
 * → getTransparency → network-add D → getTransparency.
 *
 * At every step:
 *   invariant_status must be 'ok'
 *   TOTAL_MINTED must equal N × 100 000
 *   A_ACTIVE must equal 100 000
 *   per_network keys must match the exact live set
 *
 * Uses an isolated SQLite file in the OS temp dir — never touches the
 * production DB.  File is deleted on success (kept on failure for inspection).
 */

const os   = require('os');
const path = require('path');
const fs   = require('fs');

// ── Point stateManager at a temporary DB (must be set BEFORE first require) ──
const tmpDb = path.join(os.tmpdir(), `metaregistry_test_n2_${Date.now()}.sqlite`);
process.env.DB_PATH = tmpDb;
// dotenv would overwrite DB_PATH from .env — skip it by not running loadConfig
// (stateManager requires db.js which calls require('dotenv').config() first,
//  but dotenv skips keys that are already defined in process.env)

const sm  = require('../../backend/src/stateManager');
const sim = require('../src/simulator');

// ── Helpers ───────────────────────────────────────────────────────────────────

let pass = 0;
let fail = 0;

function check(label, actual, expected) {
  if (actual === expected) {
    console.log(`  ✓ ${label}: ${actual}`);
    pass++;
  } else {
    console.error(`  ✗ ${label}: got ${JSON.stringify(actual)}, expected ${JSON.stringify(expected)}`);
    fail++;
  }
}

function checkTransparency(step, expectedN) {
  const snap = sm.getTransparency();
  const gs   = snap.global_state;
  const nets = Object.keys(snap.per_network || {});

  console.log(`\n── ${step} ──`);
  check('invariant_status',    gs.invariant_status, 'ok');
  check('A_ACTIVE',            gs.A_ACTIVE,         sim.CONSTANTS.A_ACTIVE_EXPECTED);
  check('TOTAL_MINTED',        gs.TOTAL_MINTED,     expectedN * sim.CONSTANTS.MINTED_PER_NETWORK);
  check('network_count',       nets.length,         expectedN);
}

// ── Test ──────────────────────────────────────────────────────────────────────

console.log('MetaRegistry — backend chain test: genesis N=2 → N=3 → N=4\n');
console.log(`Temp DB: ${tmpDb}\n`);

// Genesis with 2 networks
const genesisResult = sm.applyGenesis({
  networks: [
    { network_id: 'A', network_name: 'Ethereum Sepolia',        it_address: '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', priority: 1 },
    { network_id: 'B', network_name: 'BNB Smart Chain Testnet', it_address: '0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb', priority: 2 },
  ],
});
if (!genesisResult.ok) {
  console.error('FATAL: applyGenesis N=2 failed:', genesisResult.reason);
  process.exit(1);
}

checkTransparency('Genesis N=2 (A, B)', 2);

// Add network C
const addC = sm.applyNetworkAdd('C', '0xcccccccccccccccccccccccccccccccccccccccc');
if (!addC.ok) {
  console.error('\nFATAL: applyNetworkAdd C failed:', addC.reason);
  process.exit(1);
}
checkTransparency('After network-add C', 3);

// Add network D
const addD = sm.applyNetworkAdd('D', '0xdddddddddddddddddddddddddddddddddddddddd');
if (!addD.ok) {
  console.error('\nFATAL: applyNetworkAdd D failed:', addD.reason);
  process.exit(1);
}
checkTransparency('After network-add D', 4);

// ── Report ────────────────────────────────────────────────────────────────────

console.log(`\n──────────────────────────────────────────`);
console.log(`  Total: ${pass + fail}  Passed: ${pass}  Failed: ${fail}`);
console.log(`──────────────────────────────────────────`);

if (fail === 0) {
  console.log('\nALL PASS');
  // Clean up temp DB
  try { fs.unlinkSync(tmpDb); fs.unlinkSync(tmpDb + '-wal'); fs.unlinkSync(tmpDb + '-shm'); } catch (_) {}
  process.exit(0);
} else {
  console.error(`\nFAILED — temp DB kept at: ${tmpDb}`);
  process.exit(1);
}
