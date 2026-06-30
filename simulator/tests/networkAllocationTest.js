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

// ─────────────────────────────────────────────────────────────────────────────
console.log('\n=== GROUP 5: validateStartingDistribution regression (dynamic check for N=4) ===\n');
// ─────────────────────────────────────────────────────────────────────────────

test('G09', 'validateStartingDistribution passes on valid genesis (dynamic check)', () => {
  S.resetCounters();
  const state = S.initializeGenesis(CONFIG).state;
  const result = S.validateStartingDistribution(state);
  if (!result.ok) return { failures: result.failures };
  return true;
});

test('G10', 'validateStartingDistribution catches wrong IT_ACTIVE (dynamic expected)', () => {
  S.resetCounters();
  const state = S.initializeGenesis(CONFIG).state;
  state.networks['A'].IT_ACTIVE = 99_999;          // one off
  state.treasuries['A'].IT_ACTIVE = 99_999;
  const result = S.validateStartingDistribution(state);
  if (result.ok) return { error: 'Should have failed but passed' };
  const hit = result.failures.some(f => f.check === 'STARTING_IT_ACTIVE' && f.network_id === 'A' && f.expected === 25_000);
  return hit ? true : { error: 'Expected STARTING_IT_ACTIVE failure for A with expected=25000', failures: result.failures };
});

test('G11', 'validateStartingDistribution: for N=4 expected values = 25000/75000 (static=dynamic)', () => {
  const { calculateActiveShares: cas, calculateFrozenReserve: cfr } = require('../src/networkAllocation');
  const CONSTS = S.CONSTANTS;
  const shares = cas(['A','B','C','D'], CONSTS.A_ACTIVE_EXPECTED);
  for (const id of ['A','B','C','D']) {
    if (shares[id] !== CONSTS.STARTING_IT_ACTIVE_PER_NETWORK)
      return { id, dynamic: shares[id], static: CONSTS.STARTING_IT_ACTIVE_PER_NETWORK };
    const frozen = cfr(id, CONSTS.MINTED_PER_NETWORK, shares[id]);
    if (frozen !== CONSTS.STARTING_IT_FROZEN_PER_NETWORK)
      return { id, dynamic_frozen: frozen, static: CONSTS.STARTING_IT_FROZEN_PER_NETWORK };
  }
  return true;
});

// ─────────────────────────────────────────────────────────────────────────────
console.log('\n=== GROUP 6: calculateActiveShares — edge cases (N=1, N=2, N=3) ===\n');
// ─────────────────────────────────────────────────────────────────────────────

test('E01', 'N=1: single network receives full A_ACTIVE (100,000)', () => {
  const shares = calculateActiveShares(['A'], 100_000);
  return eq(shares['A'], 100_000, 'A');
});

test('E02', 'N=1: sum = 100,000', () => {
  const shares = calculateActiveShares(['A'], 100_000);
  const sum = Object.values(shares).reduce((s, v) => s + v, 0);
  return eq(sum, 100_000, 'sum');
});

test('E03', 'N=2: A = 50,000', () => {
  const shares = calculateActiveShares(['A','B'], 100_000);
  return eq(shares['A'], 50_000, 'A');
});

test('E04', 'N=2: B = 50,000', () => {
  const shares = calculateActiveShares(['A','B'], 100_000);
  return eq(shares['B'], 50_000, 'B');
});

test('E05', 'N=2: sum = 100,000', () => {
  const shares = calculateActiveShares(['A','B'], 100_000);
  const sum = Object.values(shares).reduce((s, v) => s + v, 0);
  return eq(sum, 100_000, 'sum');
});

test('E06', 'N=3: A = 33,334 (ceil(100000/3))', () => {
  const shares = calculateActiveShares(['A','B','C'], 100_000);
  return eq(shares['A'], 33_334, 'A');
});

test('E07', 'N=3: B = 33,334', () => {
  const shares = calculateActiveShares(['A','B','C'], 100_000);
  return eq(shares['B'], 33_334, 'B');
});

test('E08', 'N=3: C = 33,332 (absorbs rounding remainder)', () => {
  const shares = calculateActiveShares(['A','B','C'], 100_000);
  return eq(shares['C'], 33_332, 'C');
});

test('E09', 'N=3: sum = 100,000 exactly', () => {
  const shares = calculateActiveShares(['A','B','C'], 100_000);
  const sum = Object.values(shares).reduce((s, v) => s + v, 0);
  return eq(sum, 100_000, 'sum');
});

// ─────────────────────────────────────────────────────────────────────────────
console.log('\n=== GROUP 7: rebalance rounding — 5→6 networks, A_ACTIVE=1,000,000,000 ===\n');
// ─────────────────────────────────────────────────────────────────────────────

// Build a mock state with N networks, IT_ACTIVE = calculateActiveShares result, IT_FROZEN = 0.
// Used for parametric / large-A_ACTIVE tests where the real genesis config doesn't apply.
function buildMockState(networkIds, A_ACTIVE) {
  const shares = calculateActiveShares(networkIds, A_ACTIVE);
  const state  = S.createMasterState();
  state.status          = 'ACTIVE';
  state.genesis_complete = true;
  for (const id of networkIds) {
    const net = S.createNetworkState({
      network_id:   id,
      network_name: `Network ${id}`,
      priority:     networkIds.indexOf(id) + 1,
      it_address:   `0xIT_${id}`,
    });
    net.IT_ACTIVE = shares[id];
    state.networks[id] = net;
    const treasury = S.createTreasuryState({
      network_id: id,
      it_id:      `IT-${id}`,
      it_address: `0xIT_${id}`,
    });
    treasury.IT_ACTIVE = shares[id];
    state.treasuries[id] = treasury;
  }
  return state;
}

// State: 5 networks (A-E), each IT_ACTIVE = 200,000,000 (exact split of 1B)
// Adding 6th network F → first rounding step in 1B scenario.
const state5to6 = buildMockState(['A','B','C','D','E'], BILLION);
const result5to6 = rebalanceOnNetworkAdd(state5to6, 'F', BILLION, 0);

test('P01', '5→6: rebalanceOnNetworkAdd returns ok=true', () => {
  return eq(result5to6.ok, true, 'ok');
});

test('P02', '5→6: activeSum = 1,000,000,000 exactly', () => {
  return eq(result5to6.activeSum, BILLION, 'activeSum');
});

test('P03', '5→6: existing network A = 166,666,667', () => {
  return eq(state5to6.networks['A'].IT_ACTIVE, 166_666_667, 'A');
});

test('P04', '5→6: existing network B = 166,666,667', () => {
  return eq(state5to6.networks['B'].IT_ACTIVE, 166_666_667, 'B');
});

test('P05', '5→6: existing network C = 166,666,667', () => {
  return eq(state5to6.networks['C'].IT_ACTIVE, 166_666_667, 'C');
});

test('P06', '5→6: existing network D = 166,666,667', () => {
  return eq(state5to6.networks['D'].IT_ACTIVE, 166_666_667, 'D');
});

test('P07', '5→6: existing network E = 166,666,667', () => {
  return eq(state5to6.networks['E'].IT_ACTIVE, 166_666_667, 'E');
});

test('P08', '5→6: new network F = 166,666,665 (rounding remainder)', () => {
  return eq(state5to6.networks['F'].IT_ACTIVE, 166_666_665, 'F');
});

test('P09', '5→6: rebalance_ops = 5 ops, delta = 33,333,333 each (200M - 166,666,667)', () => {
  if (result5to6.rebalance_ops.length !== 5)
    return { expected: 5, actual: result5to6.rebalance_ops.length };
  for (const op of result5to6.rebalance_ops) {
    if (op.delta !== 33_333_333)
      return { network_id: op.network_id, expected_delta: 33_333_333, actual: op.delta };
  }
  return true;
});

// ─────────────────────────────────────────────────────────────────────────────
console.log('\n=== GROUP 8: chain rebalance N=4→12, A_ACTIVE=1,000,000,000 ===\n');
// ─────────────────────────────────────────────────────────────────────────────

// Shared mutable state: each rebalanceOnNetworkAdd call mutates it in place,
// simulating sequential network additions over time.
const chainState = buildMockState(['A','B','C','D'], BILLION);

test('C01', 'Chain baseline N=4: Σ IT_ACTIVE = 1,000,000,000 (all=250,000,000)', () => {
  let sum = 0;
  for (const id of Object.keys(chainState.networks)) sum += chainState.networks[id].IT_ACTIVE;
  if (sum !== BILLION) return { expected: BILLION, actual: sum };
  // All should be 250M (exact equal split)
  for (const id of ['A','B','C','D']) {
    if (chainState.networks[id].IT_ACTIVE !== 250_000_000)
      return { id, expected: 250_000_000, actual: chainState.networks[id].IT_ACTIVE };
  }
  return true;
});

test('C02', 'Chain N=5 (add E): sum = 1,000,000,000, all=200,000,000 (exact split)', () => {
  const r = rebalanceOnNetworkAdd(chainState, 'E', BILLION, 0);
  if (!r.ok || r.activeSum !== BILLION) return { FAILED_AT_N: 5, ok: r.ok, activeSum: r.activeSum };
  for (const id of ['A','B','C','D','E']) {
    if (chainState.networks[id].IT_ACTIVE !== 200_000_000)
      return { id, expected: 200_000_000, actual: chainState.networks[id].IT_ACTIVE };
  }
  return true;
});

test('C03', 'Chain N=6 (add F): sum = 1,000,000,000 (first rounding step)', () => {
  const r = rebalanceOnNetworkAdd(chainState, 'F', BILLION, 0);
  if (!r.ok || r.activeSum !== BILLION) return { FAILED_AT_N: 6, ok: r.ok, activeSum: r.activeSum };
  return true;
});

test('C04', 'Chain N=7 (add G): sum = 1,000,000,000', () => {
  const r = rebalanceOnNetworkAdd(chainState, 'G', BILLION, 0);
  if (!r.ok || r.activeSum !== BILLION) return { FAILED_AT_N: 7, ok: r.ok, activeSum: r.activeSum };
  return true;
});

test('C05', 'Chain N=8 (add H): sum = 1,000,000,000, all=125,000,000 (exact split)', () => {
  const r = rebalanceOnNetworkAdd(chainState, 'H', BILLION, 0);
  if (!r.ok || r.activeSum !== BILLION) return { FAILED_AT_N: 8, ok: r.ok, activeSum: r.activeSum };
  for (const id of Object.keys(chainState.networks)) {
    if (chainState.networks[id].IT_ACTIVE !== 125_000_000)
      return { id, expected: 125_000_000, actual: chainState.networks[id].IT_ACTIVE };
  }
  return true;
});

test('C06', 'Chain N=9 (add I): sum = 1,000,000,000', () => {
  const r = rebalanceOnNetworkAdd(chainState, 'I', BILLION, 0);
  if (!r.ok || r.activeSum !== BILLION) return { FAILED_AT_N: 9, ok: r.ok, activeSum: r.activeSum };
  return true;
});

test('C07', 'Chain N=10 (add J): sum = 1,000,000,000, all=100,000,000 (exact split)', () => {
  const r = rebalanceOnNetworkAdd(chainState, 'J', BILLION, 0);
  if (!r.ok || r.activeSum !== BILLION) return { FAILED_AT_N: 10, ok: r.ok, activeSum: r.activeSum };
  for (const id of Object.keys(chainState.networks)) {
    if (chainState.networks[id].IT_ACTIVE !== 100_000_000)
      return { id, expected: 100_000_000, actual: chainState.networks[id].IT_ACTIVE };
  }
  return true;
});

test('C08', 'Chain N=11 (add K): sum = 1,000,000,000', () => {
  const r = rebalanceOnNetworkAdd(chainState, 'K', BILLION, 0);
  if (!r.ok || r.activeSum !== BILLION) return { FAILED_AT_N: 11, ok: r.ok, activeSum: r.activeSum };
  return true;
});

test('C09', 'Chain N=12 (add L): sum = 1,000,000,000, first 11=83,333,334, L=83,333,326', () => {
  const r = rebalanceOnNetworkAdd(chainState, 'L', BILLION, 0);
  if (!r.ok || r.activeSum !== BILLION) return { FAILED_AT_N: 12, ok: r.ok, activeSum: r.activeSum };
  const all = Object.keys(chainState.networks);            // A..K then L
  for (const id of all.slice(0, -1)) {
    if (chainState.networks[id].IT_ACTIVE !== 83_333_334)
      return { id, expected: 83_333_334, actual: chainState.networks[id].IT_ACTIVE };
  }
  const lastId = all[all.length - 1];                     // L
  if (chainState.networks[lastId].IT_ACTIVE !== 83_333_326)
    return { lastId, expected: 83_333_326, actual: chainState.networks[lastId].IT_ACTIVE };
  return true;
});

// ─── Summary ──────────────────────────────────────────────────────────────────

console.log(`\n${'─'.repeat(55)}`);
console.log(`  Total: ${passed + failed}  Passed: ${passed}  Failed: ${failed}`);
console.log(`${'─'.repeat(55)}\n`);

if (failed > 0) process.exit(1);
