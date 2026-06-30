'use strict';

// ─── networkAllocation + networkRebalance test suite ─────────────────────────
// Run: node simulator/tests/networkAllocationTest.js

const { calculateActiveShares, calculateFrozenReserve } = require('../src/networkAllocation');
const { rebalanceOnNetworkAdd } = require('../src/networkRebalance');
const S = require('../src/simulator');

let passed = 0;
let failed = 0;

function test(id, description, fn) {
  try {
    const result = fn();
    if (result === true || result === undefined) {
      console.log(`  ✓ ${id}: ${description}`);
      passed++;
    } else {
      console.log(`  ✗ ${id}: ${description}`);
      console.log(`      → ${JSON.stringify(result)}`);
      failed++;
    }
  } catch (err) {
    console.log(`  ✗ ${id}: ${description}`);
    console.log(`      → ERROR: ${err.message}`);
    failed++;
  }
}

function eq(a, b, label) {
  if (a === b) return true;
  return { label: label || '', expected: b, actual: a };
}

// ─── Genesis config for tests ─────────────────────────────────────────────────
const CONFIG = {
  networks: [
    { network_id: 'A', it_address: '0xIT_A' },
    { network_id: 'B', it_address: '0xIT_B' },
    { network_id: 'C', it_address: '0xIT_C' },
    { network_id: 'D', it_address: '0xIT_D' },
  ]
};

// ─────────────────────────────────────────────────────────────────────────────
console.log('\n=== GROUP 1: calculateActiveShares — N=4, A_ACTIVE=100,000 (regression) ===\n');
// ─────────────────────────────────────────────────────────────────────────────

test('R01', 'shares sum exactly = 100,000', () => {
  const shares = calculateActiveShares(['A','B','C','D'], 100_000);
  const sum = Object.values(shares).reduce((s, v) => s + v, 0);
  return eq(sum, 100_000, 'sum');
});

test('R02', 'A gets exactly 25,000', () => {
  const shares = calculateActiveShares(['A','B','C','D'], 100_000);
  return eq(shares['A'], 25_000, 'A');
});

test('R03', 'B gets exactly 25,000', () => {
  const shares = calculateActiveShares(['A','B','C','D'], 100_000);
  return eq(shares['B'], 25_000, 'B');
});

test('R04', 'C gets exactly 25,000', () => {
  const shares = calculateActiveShares(['A','B','C','D'], 100_000);
  return eq(shares['C'], 25_000, 'C');
});

test('R05', 'D gets exactly 25,000', () => {
  const shares = calculateActiveShares(['A','B','C','D'], 100_000);
  return eq(shares['D'], 25_000, 'D');
});

test('R06', 'result matches STARTING_IT_ACTIVE_PER_NETWORK constant exactly', () => {
  const shares = calculateActiveShares(['A','B','C','D'], 100_000);
  const STARTING = S.CONSTANTS.STARTING_IT_ACTIVE_PER_NETWORK;
  for (const id of ['A','B','C','D']) {
    if (shares[id] !== STARTING) return { id, expected: STARTING, actual: shares[id] };
  }
  return true;
});

// ─────────────────────────────────────────────────────────────────────────────
console.log('\n=== GROUP 2: calculateActiveShares — N=6, A_ACTIVE=1,000,000,000 (rounding) ===\n');
// ─────────────────────────────────────────────────────────────────────────────

const nets6 = ['A','B','C','D','E','F'];
const BILLION = 1_000_000_000;

test('R07', 'shares sum exactly = 1,000,000,000', () => {
  const shares = calculateActiveShares(nets6, BILLION);
  const sum = Object.values(shares).reduce((s, v) => s + v, 0);
  return eq(sum, BILLION, 'sum');
});

test('R08', 'first 5 networks each get 166,666,667', () => {
  const shares = calculateActiveShares(nets6, BILLION);
  for (const id of ['A','B','C','D','E']) {
    if (shares[id] !== 166_666_667) return { id, expected: 166_666_667, actual: shares[id] };
  }
  return true;
});

test('R09', 'last network (F) gets 166,666,665 (absorbs rounding remainder)', () => {
  const shares = calculateActiveShares(nets6, BILLION);
  return eq(shares['F'], 166_666_665, 'F');
});

// ─────────────────────────────────────────────────────────────────────────────
console.log('\n=== GROUP 3: genesis.js refactor — dynamic calc gives same result for N=4 ===\n');
// ─────────────────────────────────────────────────────────────────────────────

test('G01', 'initializeGenesis succeeds', () => {
  S.resetCounters();
  const result = S.initializeGenesis(CONFIG);
  return eq(result.ok, true, 'ok');
});

test('G02', 'each network IT_ACTIVE = 25,000 (dynamic = hardcoded for N=4)', () => {
  S.resetCounters();
  const state = S.initializeGenesis(CONFIG).state;
  for (const id of ['A','B','C','D']) {
    if (state.networks[id].IT_ACTIVE !== 25_000)
      return { id, expected: 25_000, actual: state.networks[id].IT_ACTIVE };
  }
  return true;
});

test('G03', 'each network IT_FROZEN = 75,000', () => {
  S.resetCounters();
  const state = S.initializeGenesis(CONFIG).state;
  for (const id of ['A','B','C','D']) {
    if (state.networks[id].IT_FROZEN !== 75_000)
      return { id, expected: 75_000, actual: state.networks[id].IT_FROZEN };
  }
  return true;
});

test('G04', 'treasury mirrors network for IT_ACTIVE', () => {
  S.resetCounters();
  const state = S.initializeGenesis(CONFIG).state;
  for (const id of ['A','B','C','D']) {
    if (state.treasuries[id].IT_ACTIVE !== state.networks[id].IT_ACTIVE)
      return { id, treasury: state.treasuries[id].IT_ACTIVE, network: state.networks[id].IT_ACTIVE };
  }
  return true;
});

test('G05', 'treasury mirrors network for IT_FROZEN', () => {
  S.resetCounters();
  const state = S.initializeGenesis(CONFIG).state;
  for (const id of ['A','B','C','D']) {
    if (state.treasuries[id].IT_FROZEN !== state.networks[id].IT_FROZEN)
      return { id, treasury: state.treasuries[id].IT_FROZEN, network: state.networks[id].IT_FROZEN };
  }
  return true;
});

test('G06', 'A_ACTIVE invariant holds post-genesis', () => {
  S.resetCounters();
  const state = S.initializeGenesis(CONFIG).state;
  const totals = S.computeTotals(state);
  return eq(totals.a_active_current, 100_000, 'A_ACTIVE');
});

test('G07', 'validateStartingDistribution passes', () => {
  S.resetCounters();
  const state = S.initializeGenesis(CONFIG).state;
  const result = S.validateStartingDistribution(state);
  return eq(result.ok, true, 'ok');
});

test('G08', 'calculateFrozenReserve(N=4): 100,000 - 25,000 = 75,000', () => {
  const { calculateFrozenReserve: cfr } = require('../src/networkAllocation');
  return eq(cfr('A', 100_000, 25_000), 75_000, 'frozen');
});

// ─────────────────────────────────────────────────────────────────────────────
console.log('\n=== GROUP 4: rebalanceOnNetworkAdd — add 5th network E (A_ACTIVE=100,000) ===\n');
// ─────────────────────────────────────────────────────────────────────────────

function genesisState() {
  S.resetCounters();
  return S.initializeGenesis(CONFIG).state;
}

test('B01', 'rebalanceOnNetworkAdd returns ok=true', () => {
  const state = genesisState();
  const result = rebalanceOnNetworkAdd(state, 'E', 100_000);
  return eq(result.ok, true, 'ok');
});

test('B02', 'invariant_ok: Σ A_ACTIVE components = 100,000 across 5 networks', () => {
  const state = genesisState();
  const result = rebalanceOnNetworkAdd(state, 'E', 100_000);
  return eq(result.activeSum, 100_000, 'activeSum');
});

test('B03', 'existing network A: IT_ACTIVE reduced to 20,000', () => {
  const state = genesisState();
  rebalanceOnNetworkAdd(state, 'E', 100_000);
  return eq(state.networks['A'].IT_ACTIVE, 20_000, 'A.IT_ACTIVE');
});

test('B04', 'existing network B: IT_ACTIVE reduced to 20,000', () => {
  const state = genesisState();
  rebalanceOnNetworkAdd(state, 'E', 100_000);
  return eq(state.networks['B'].IT_ACTIVE, 20_000, 'B.IT_ACTIVE');
});

test('B05', 'existing network C: IT_ACTIVE reduced to 20,000', () => {
  const state = genesisState();
  rebalanceOnNetworkAdd(state, 'E', 100_000);
  return eq(state.networks['C'].IT_ACTIVE, 20_000, 'C.IT_ACTIVE');
});

test('B06', 'existing network D: IT_ACTIVE reduced to 20,000', () => {
  const state = genesisState();
  rebalanceOnNetworkAdd(state, 'E', 100_000);
  return eq(state.networks['D'].IT_ACTIVE, 20_000, 'D.IT_ACTIVE');
});

test('B07', 'new network E: IT_ACTIVE = 20,000', () => {
  const state = genesisState();
  rebalanceOnNetworkAdd(state, 'E', 100_000);
  return eq(state.networks['E'].IT_ACTIVE, 20_000, 'E.IT_ACTIVE');
});

test('B08', 'existing network A: IT_FROZEN increased to 80,000 (delta=5,000 absorbed)', () => {
  const state = genesisState();
  rebalanceOnNetworkAdd(state, 'E', 100_000);
  return eq(state.networks['A'].IT_FROZEN, 80_000, 'A.IT_FROZEN');
});

test('B09', 'existing network B: IT_FROZEN = 80,000', () => {
  const state = genesisState();
  rebalanceOnNetworkAdd(state, 'E', 100_000);
  return eq(state.networks['B'].IT_FROZEN, 80_000, 'B.IT_FROZEN');
});

test('B10', 'new network E: IT_FROZEN = 80,000 (100,000 - 20,000)', () => {
  const state = genesisState();
  rebalanceOnNetworkAdd(state, 'E', 100_000);
  return eq(state.networks['E'].IT_FROZEN, 80_000, 'E.IT_FROZEN');
});

test('B11', 'existing networks: network_total still = 100,000 each', () => {
  const state = genesisState();
  rebalanceOnNetworkAdd(state, 'E', 100_000);
  for (const id of ['A','B','C','D']) {
    const n = state.networks[id];
    const total = n.wallet_active_total + n.IT_ACTIVE + n.IT_FROZEN + n.UNAVAILABLE;
    if (total !== 100_000) return { id, expected: 100_000, actual: total };
  }
  return true;
});

test('B12', 'new network E: network_total = 100,000', () => {
  const state = genesisState();
  rebalanceOnNetworkAdd(state, 'E', 100_000);
  const e = state.networks['E'];
  const total = e.wallet_active_total + e.IT_ACTIVE + e.IT_FROZEN + e.UNAVAILABLE;
  return eq(total, 100_000, 'E.network_total');
});

test('B13', 'treasury mirrors network IT_ACTIVE for all 5 networks after rebalance', () => {
  const state = genesisState();
  rebalanceOnNetworkAdd(state, 'E', 100_000);
  for (const id of ['A','B','C','D','E']) {
    if (state.treasuries[id].IT_ACTIVE !== state.networks[id].IT_ACTIVE)
      return { id, treasury: state.treasuries[id].IT_ACTIVE, network: state.networks[id].IT_ACTIVE };
  }
  return true;
});

test('B14', 'treasury mirrors network IT_FROZEN for all 5 networks after rebalance', () => {
  const state = genesisState();
  rebalanceOnNetworkAdd(state, 'E', 100_000);
  for (const id of ['A','B','C','D','E']) {
    if (state.treasuries[id].IT_FROZEN !== state.networks[id].IT_FROZEN)
      return { id, treasury: state.treasuries[id].IT_FROZEN, network: state.networks[id].IT_FROZEN };
  }
  return true;
});

test('B15', 'rebalance_ops: exactly 4 existing networks adjusted (delta=5,000 each)', () => {
  const state = genesisState();
  const result = rebalanceOnNetworkAdd(state, 'E', 100_000);
  if (result.rebalance_ops.length !== 4) return { expected: 4, actual: result.rebalance_ops.length };
  for (const op of result.rebalance_ops) {
    if (op.delta !== 5_000) return { network_id: op.network_id, expected_delta: 5_000, actual: op.delta };
  }
  return true;
});

// ─── Summary ──────────────────────────────────────────────────────────────────

console.log(`\n${'─'.repeat(55)}`);
console.log(`  Total: ${passed + failed}  Passed: ${passed}  Failed: ${failed}`);
console.log(`${'─'.repeat(55)}\n`);

if (failed > 0) process.exit(1);
