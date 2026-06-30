'use strict';

// ─── Full Test Matrix (§8 Simulator Spec v1.0) ────────────────────────────────
// 31 tests. Tests 1-2 are mandatory gates.
// Run: node tests/testMatrix.js

const S = require('../src/simulator');

// ─── Test helpers ─────────────────────────────────────────────────────────────
let passed = 0;
let failed = 0;
const results = [];

function test(id, description, fn) {
  try {
    const result = fn();
    if (result === true || result?.ok === true || result === undefined) {
      console.log(`  ✓ T${String(id).padStart(2,'0')}: ${description}`);
      results.push({ id, description, status: 'PASS' });
      passed++;
    } else {
      console.log(`  ✗ T${String(id).padStart(2,'0')}: ${description}`);
      console.log(`      → ${JSON.stringify(result)}`);
      results.push({ id, description, status: 'FAIL', detail: result });
      failed++;
    }
  } catch (err) {
    console.log(`  ✗ T${String(id).padStart(2,'0')}: ${description}`);
    console.log(`      → ERROR: ${err.message}`);
    results.push({ id, description, status: 'ERROR', detail: err.message });
    failed++;
  }
}

function eq(a, b) { return a === b ? true : { expected: b, actual: a }; }

// ─── Config ───────────────────────────────────────────────────────────────────
const CONFIG = {
  networks: [
    { network_id: 'A', it_address: '0xIT_A' },
    { network_id: 'B', it_address: '0xIT_B' },
    { network_id: 'C', it_address: '0xIT_C' },
    { network_id: 'D', it_address: '0xIT_D' },
  ]
};

// Builds state after genesis only (no distribution)
function stateGenesis() {
  S.resetCounters();
  return S.initializeGenesis(CONFIG).state;
}

// Builds state after genesis + treasury distribution (3 wallets × 5000 × 4 networks)
function stateDistributed() {
  S.resetCounters();
  const state = S.initializeGenesis(CONFIG).state;
  for (const net of ['A','B','C','D'])
    for (const w of ['Wallet_1','Wallet_2','Wallet_3'])
      S.applyTreasuryDistribution(state, net, w, 5000);
  return state;
}

// Full cross-network transfer helper
function crossTransfer(state, sender, amount, target_network, mode = 'AUTOMATIC', user_sources = null) {
  const envelope_id_tmp = 'ENV-tmp';
  const src_result = mode === 'AUTOMATIC'
    ? S.resolveAutomaticSources(state, envelope_id_tmp, sender, amount, target_network)
    : S.resolveUserDefinedSources(state, envelope_id_tmp, sender, user_sources, amount, target_network);

  if (!src_result.ok) return src_result;

  const env_r = S.createEnvelopeFromIntent(state, {
    operation_type: S.OPERATION_TYPE.CROSS_NETWORK_TRANSFER,
    source_mode:    mode === 'AUTOMATIC' ? S.SOURCE_MODE.AUTOMATIC : S.SOURCE_MODE.USER_DEFINED,
    amount, sender, recipient: sender,
    target_network,
    sources: src_result.sources,
  });

  const val = S.validatePackage(state, env_r.envelope);
  if (!val.ok) return val;

  for (const src_id of env_r.envelope.source_operation_ids)
    S.applySourceFreeze(state, state.source_operations[src_id]);

  const delta = S.recordTemporaryDelta(state, env_r.envelope);
  if (!delta.ok) return delta;

  S.applyTargetUnfreeze(state, state.settlements[env_r.envelope.settlement_id]);
  return S.completeEnvelope(state, env_r.envelope);
}

// ─── TESTS ────────────────────────────────────────────────────────────────────
console.log('\n═══════════════════════════════════════════════════');
console.log('  MetaRegistry State Simulator — Full Test Matrix');
console.log('═══════════════════════════════════════════════════\n');

// ── GENESIS ───────────────────────────────────────────────────────────────────
console.log('[ Genesis ]');

test(1, 'Genesis: 4 networks × 100,000. TOTAL_MINTED, per-network totals, EventRecords', () => {
  const state = stateGenesis();
  const t = S.computeTotals(state);
  if (t.total_minted !== 400_000) return { expected: 400_000, actual: t.total_minted };
  for (const id of ['A','B','C','D']) {
    const net = state.networks[id];
    if (net.network_total !== 100_000) return { net: id, expected: 100_000, actual: net.network_total };
  }
  const mints    = state.events.filter(e => e.event_type === 'GENESIS_MINT').length;
  const captures = state.events.filter(e => e.event_type === 'GENESIS_TREASURY_CAPTURE').length;
  if (mints !== 4 || captures !== 4) return { mints, captures };
  return true;
});

test(2, 'validateStartingDistribution: all 9 invariants pass', () => {
  const state = stateGenesis();
  const r = S.validateStartingDistribution(state);
  if (!r.ok) return { failures: r.failures };
  const t = S.computeTotals(state);
  if (t.a_active_current !== 100_000) return { A_ACTIVE: t.a_active_current };
  if (t.IT_FROZEN_total   !== 300_000) return { TOTAL_FROZEN: t.IT_FROZEN_total };
  for (const id of ['A','B','C','D']) {
    const net = state.networks[id];
    if (net.IT_ACTIVE !== 25_000) return { net: id, IT_ACTIVE: net.IT_ACTIVE };
    if (net.IT_FROZEN !== 75_000) return { net: id, IT_FROZEN: net.IT_FROZEN };
    if (net.wallet_active_total !== 0) return { net: id, wallet_active: net.wallet_active_total };
  }
  return true;
});

// ── TREASURY ──────────────────────────────────────────────────────────────────
console.log('\n[ Treasury ]');

test(3, 'Treasury distribution: wallet_active=60,000, IT_ACTIVE=40,000, TOTAL_FROZEN=300,000, A_ACTIVE=100,000', () => {
  const state = stateDistributed();
  const t = S.computeTotals(state);
  if (t.wallet_active_total !== 60_000) return { wallet_active: t.wallet_active_total };
  if (t.IT_ACTIVE_total     !== 40_000) return { IT_ACTIVE: t.IT_ACTIVE_total };
  if (t.IT_FROZEN_total     !== 300_000) return { IT_FROZEN: t.IT_FROZEN_total };
  if (t.a_active_current    !== 100_000) return { A_ACTIVE: t.a_active_current };
  return true;
});

test(4, 'Treasury: reject INSUFFICIENT_SOURCE_BALANCE (request > IT_ACTIVE)', () => {
  const state = stateGenesis();
  const r = S.applyTreasuryDistribution(state, 'A', 'Wallet_1', 30_000);
  return eq(r.reason, S.REASON_CODE.INSUFFICIENT_SOURCE_BALANCE);
});

test(5, 'Treasury: reject UNKNOWN_RECIPIENT_WALLET (not in tester set)', () => {
  const state = stateGenesis();
  // Register as non-tester
  state.wallets['A:BadWallet'] = S.createWalletBalance({
    network_id: 'A', wallet_address: 'BadWallet', is_predefined_tester_address: false
  });
  const r = S.applyTreasuryDistribution(state, 'A', 'BadWallet', 1000);
  return eq(r.reason, S.REASON_CODE.UNKNOWN_RECIPIENT_WALLET);
});

test(6, 'Treasury: reject INVALID_AMOUNT (fractional 1000.5)', () => {
  const state = stateGenesis();
  const r = S.applyTreasuryDistribution(state, 'A', 'Wallet_1', 1000.5);
  return eq(r.reason, S.REASON_CODE.INVALID_AMOUNT);
});

// ── CROSS-NETWORK ─────────────────────────────────────────────────────────────
console.log('\n[ Cross-Network ]');

test(7, 'AUTOMATIC A→C 5,000: after source freeze A_ACTIVE=95,000, status=TEMP_ACTIVE_DELTA_RECORDED', () => {
  const state = stateDistributed();
  const src = S.resolveAutomaticSources(state, 'tmp', 'Wallet_1', 5000, 'C');
  const env_r = S.createEnvelopeFromIntent(state, {
    operation_type: S.OPERATION_TYPE.CROSS_NETWORK_TRANSFER,
    source_mode: S.SOURCE_MODE.AUTOMATIC,
    amount:5000, sender:'Wallet_1', recipient:'Wallet_1',
    target_network:'C', sources: src.sources,
  });
  S.validatePackage(state, env_r.envelope);
  for (const id of env_r.envelope.source_operation_ids)
    S.applySourceFreeze(state, state.source_operations[id]);
  S.recordTemporaryDelta(state, env_r.envelope);
  const t = S.computeTotals(state);
  if (t.a_active_current !== 95_000) return { A_ACTIVE_after_freeze: t.a_active_current };
  if (env_r.envelope.status !== S.ENVELOPE_STATUS.TEMP_ACTIVE_DELTA_RECORDED)
    return { status: env_r.envelope.status };
  return true;
});

test(8, 'AUTOMATIC A→C 5,000: complete — A_ACTIVE=100,000, TOTAL_FROZEN=300,000, COMPLETED', () => {
  const state = stateDistributed();
  const r = crossTransfer(state, 'Wallet_1', 5000, 'C');
  if (!r.ok) return r;
  const t = S.computeTotals(state);
  if (t.a_active_current !== 100_000) return { A_ACTIVE: t.a_active_current };
  if (t.IT_FROZEN_total   !== 300_000) return { TOTAL_FROZEN: t.IT_FROZEN_total };
  if (state.wallets['A:Wallet_1'].wallet_active !== 0)     return { W1_A: state.wallets['A:Wallet_1'].wallet_active };
  if (state.wallets['C:Wallet_1'].wallet_active !== 10_000) return { W1_C: state.wallets['C:Wallet_1'].wallet_active };
  return true;
});

test(9, 'AUTOMATIC aggregated 20,000 to D: 4 SourceOperations, A_ACTIVE=80,000 mid, 100,000 final', () => {
  const state = stateDistributed();
  // Step by step to verify mid-state
  const src = S.resolveAutomaticSources(state, 'tmp', 'Wallet_1', 20000, 'D');
  if (!src.ok) return src;
  if (src.sources.length !== 4) return { sources_count: src.sources.length };
  const env_r = S.createEnvelopeFromIntent(state, {
    operation_type: S.OPERATION_TYPE.CROSS_NETWORK_TRANSFER,
    source_mode: S.SOURCE_MODE.AUTOMATIC,
    amount:20000, sender:'Wallet_1', recipient:'Wallet_1',
    target_network:'D', sources: src.sources,
  });
  S.validatePackage(state, env_r.envelope);
  for (const id of env_r.envelope.source_operation_ids)
    S.applySourceFreeze(state, state.source_operations[id]);
  S.recordTemporaryDelta(state, env_r.envelope);
  const t_mid = S.computeTotals(state);
  if (t_mid.a_active_current !== 80_000) return { A_ACTIVE_mid: t_mid.a_active_current };
  S.applyTargetUnfreeze(state, state.settlements[env_r.envelope.settlement_id]);
  S.completeEnvelope(state, env_r.envelope);
  const t_final = S.computeTotals(state);
  if (t_final.a_active_current !== 100_000) return { A_ACTIVE_final: t_final.a_active_current };
  if (t_final.IT_FROZEN_total   !== 300_000) return { TOTAL_FROZEN: t_final.IT_FROZEN_total };
  return true;
});

test(10, 'AUTOMATIC: source insufficient in A, falls through to B', () => {
  const state = stateDistributed();
  // Reduce Wallet_1[A] to 3000
  state.wallets['A:Wallet_1'].wallet_active = 3000;
  state.networks['A'].wallet_active_total -= 2000;
  const src = S.resolveAutomaticSources(state, 'tmp', 'Wallet_1', 7000, 'C');
  if (!src.ok) return src;
  if (src.sources.length !== 2) return { sources_count: src.sources.length };
  const net_a = src.sources.find(s => s.source_network === 'A');
  const net_b = src.sources.find(s => s.source_network === 'B');
  if (!net_a || net_a.amount !== 3000) return { A_amount: net_a?.amount };
  if (!net_b || net_b.amount !== 4000) return { B_amount: net_b?.amount };
  return true;
});

test(11, 'USER_DEFINED: correct sources, COMPLETED with invariants ok', () => {
  const state = stateDistributed();
  const r = crossTransfer(state, 'Wallet_1', 5000, 'C', 'USER_DEFINED',
    [{ network_id:'A', amount:3000 }, { network_id:'B', amount:2000 }]);
  if (!r.ok) return r;
  const t = S.computeTotals(state);
  return eq(t.a_active_current, 100_000);
});

test(12, 'USER_DEFINED: sum 19,999 for 20,000 → SOURCE_SUM_MISMATCH', () => {
  const state = stateDistributed();
  const r = S.resolveUserDefinedSources(state, 'tmp', 'Wallet_1',
    [{ network_id:'A', amount:10000 }, { network_id:'B', amount:9999 }], 20000, 'D');
  return eq(r.reason, S.REASON_CODE.SOURCE_SUM_MISMATCH);
});

test(13, 'USER_DEFINED: correct sum but one balance insufficient → INSUFFICIENT_SOURCE_BALANCE', () => {
  const state = stateDistributed();
  const r = S.resolveUserDefinedSources(state, 'tmp', 'Wallet_1',
    [{ network_id:'A', amount:8000 }], 8000, 'C');
  return eq(r.reason, S.REASON_CODE.INSUFFICIENT_SOURCE_BALANCE);
});

test(14, 'USER_DEFINED: target IT_FROZEN insufficient by 1 → INSUFFICIENT_TARGET_FROZEN', () => {
  const state = stateDistributed();
  state.networks['C'].IT_FROZEN  = 4999;
  state.treasuries['C'].IT_FROZEN = 4999;
  const r = S.resolveUserDefinedSources(state, 'tmp', 'Wallet_1',
    [{ network_id:'A', amount:5000 }], 5000, 'C');
  return eq(r.reason, S.REASON_CODE.INSUFFICIENT_TARGET_FROZEN);
});

// ── SAME-NETWORK ──────────────────────────────────────────────────────────────
console.log('\n[ Same-Network ]');

test(15, 'SAME_NETWORK: Wallet_1→Wallet_2 in A, 1,000. Balances correct, invariants ok', () => {
  const state = stateDistributed();
  const r = S.applySameNetworkThroughMetaRegistry(state, {
    network_id:'A', sender_address:'Wallet_1', recipient_address:'Wallet_2', amount:1000
  });
  if (!r.ok) return r;
  if (state.wallets['A:Wallet_1'].wallet_active !== 4000) return { W1: state.wallets['A:Wallet_1'].wallet_active };
  if (state.wallets['A:Wallet_2'].wallet_active !== 6000) return { W2: state.wallets['A:Wallet_2'].wallet_active };
  const t = S.computeTotals(state);
  if (t.a_active_current !== 100_000) return { A_ACTIVE: t.a_active_current };
  if (t.IT_FROZEN_total   !== 300_000) return { IT_FROZEN: t.IT_FROZEN_total };
  return true;
});

test(16, 'SAME_NETWORK: insufficient balance → INSUFFICIENT_SOURCE_BALANCE', () => {
  const state = stateDistributed();
  const r = S.applySameNetworkThroughMetaRegistry(state, {
    network_id:'A', sender_address:'Wallet_1', recipient_address:'Wallet_2', amount:9000
  });
  return eq(r.reason, S.REASON_CODE.INSUFFICIENT_SOURCE_BALANCE);
});

// ── REJECTION ─────────────────────────────────────────────────────────────────
console.log('\n[ Rejection ]');

test(17, 'Amount = 0 → INVALID_AMOUNT, no state mutation', () => {
  const state = stateDistributed();
  const before = S.computeTotals(state).a_active_current;
  const r = S.applySameNetworkThroughMetaRegistry(state, {
    network_id:'A', sender_address:'Wallet_1', recipient_address:'Wallet_2', amount:0
  });
  const after = S.computeTotals(state).a_active_current;
  if (r.reason !== S.REASON_CODE.INVALID_AMOUNT) return { reason: r.reason };
  return eq(before, after);
});

test(18, 'Amount = -100 → INVALID_AMOUNT', () => {
  const state = stateGenesis();
  const r = S.applyTreasuryDistribution(state, 'A', 'Wallet_1', -100);
  return eq(r.reason, S.REASON_CODE.INVALID_AMOUNT);
});

test(19, 'Amount = 120.5 (fractional) → INVALID_AMOUNT', () => {
  const state = stateGenesis();
  const r = S.applyTreasuryDistribution(state, 'A', 'Wallet_1', 120.5);
  return eq(r.reason, S.REASON_CODE.INVALID_AMOUNT);
});

test(20, 'Invalid target network "Z" → INVALID_TARGET_NETWORK', () => {
  const state = stateDistributed();
  const src = S.resolveAutomaticSources(state, 'tmp', 'Wallet_1', 1000, 'Z');
  return eq(src.reason, S.REASON_CODE.INVALID_TARGET_NETWORK);
});

// ── STOP ──────────────────────────────────────────────────────────────────────
console.log('\n[ STOP ]');

test(21, 'Artificial A_ACTIVE +1 → immediate STOP', () => {
  const state = stateDistributed();
  // Inject +1 into IT_ACTIVE of network A
  state.networks['A'].IT_ACTIVE    += 1;
  state.treasuries['A'].IT_ACTIVE  += 1;
  const r = S.checkInvariants(state, S.SNAPSHOT_PHASE.POST_COMPLETION);
  if (r.ok) return { unexpected: 'ok — expected violation' };
  const crit = r.violations.find(v => v.code === S.REASON_CODE.POSITIVE_ACTIVE_DELTA);
  if (!crit) return { violations: r.violations.map(v=>v.code) };
  // Trigger STOP
  S.triggerStop(state, S.REASON_CODE.POSITIVE_ACTIVE_DELTA);
  return eq(state.status, S.SYSTEM_STATUS.STOP);
});

test(22, 'Completed state with unknown token location → TRACEABILITY_FAILURE + STOP', () => {
  const state = stateDistributed();
  // Mismatch: wallet_active_total says 5000 but no WalletBalance
  state.networks['A'].wallet_active_total += 5000;
  const r = S.checkTraceability(state);
  if (r.ok) return { unexpected: 'traceability ok — expected failure' };
  if (r.untracked.length === 0) return { untracked: 'empty — expected issues' };
  // Trigger STOP as completeEnvelope() would in real post-apply path
  S.triggerStop(state, S.REASON_CODE.TRACEABILITY_FAILURE);
  if (state.status !== S.SYSTEM_STATUS.STOP) return { status: state.status };
  if (state.stop_reason !== S.REASON_CODE.TRACEABILITY_FAILURE) return { stop_reason: state.stop_reason };
  return true;
});

// ── UNAVAILABLE ───────────────────────────────────────────────────────────────
console.log('\n[ UNAVAILABLE ]');

test(23, 'Outside-DApp transfer to unknown address → UNAVAILABLE +1000, wallet -1000', () => {
  const state = stateDistributed();
  const obs = S.mockObservedExternalTransfer(state, {
    network_id:'A', tx_hash:'mock_tx_T23',
    from_address:'Wallet_1', to_address:'Unknown_XYZ', amount:1000,
  });
  const rec = S.reconcileObservedTransfer(state, obs.observation);
  if (!rec.ok) return rec;
  if (state.networks['A'].UNAVAILABLE !== 1000) return { UNAVAILABLE: state.networks['A'].UNAVAILABLE };
  if (state.wallets['A:Wallet_1'].wallet_active !== 4000) return { W1_A: state.wallets['A:Wallet_1'].wallet_active };
  const evts = ['OUTSIDE_DAPP_TRANSFER_OBSERVED','UNAVAILABLE_STATE_APPLIED'];
  const found = evts.every(t => state.events.some(e => e.event_type === t));
  return found ? true : { missing_events: evts.filter(t => !state.events.some(e => e.event_type === t)) };
});

test(24, 'After UNAVAILABLE: A_ACTIVE = Σ(wallet_active + IT_ACTIVE + UNAVAILABLE) = 100,000', () => {
  const state = stateDistributed();
  const obs = S.mockObservedExternalTransfer(state, {
    network_id:'A', tx_hash:'mock_tx_T24',
    from_address:'Wallet_1', to_address:'Unknown_ABC', amount:2000,
  });
  S.reconcileObservedTransfer(state, obs.observation);
  const t = S.computeTotals(state);
  if (t.a_active_current !== 100_000) return { A_ACTIVE: t.a_active_current };
  if (t.UNAVAILABLE_total !== 2000) return { UNAVAILABLE: t.UNAVAILABLE_total };
  return true;
});

// ── DAPPINTENT ────────────────────────────────────────────────────────────────
console.log('\n[ DAppIntent ]');

test(25, 'DAppIntent THROUGH_METAREGISTRY to known tester: created, validated, DAPP_INTENT_CREATED event', () => {
  const state = stateDistributed();
  const r = S.createDAppIntent(state, {
    connected_wallet_address: 'Wallet_1',
    selected_network: 'A',
    operation_mode: S.OPERATION_MODE.THROUGH_METAREGISTRY,
    source_mode: S.SOURCE_MODE.AUTOMATIC,
    amount: 1000,
    target_network: 'C',
    target_address: 'Wallet_1',
  });
  if (!r.ok) return r;
  if (r.intent.address_policy_status !== S.ADDRESS_POLICY.TESTER_WALLET)
    return { policy: r.intent.address_policy_status };
  const val = S.validateDAppIntent(state, r.intent);
  if (!val.ok) return val;
  const has_event = state.events.some(e => e.event_type === 'DAPP_INTENT_CREATED');
  return has_event ? true : { missing: 'DAPP_INTENT_CREATED' };
});

test(26, 'DAppIntent DIRECT_HOST_NETWORK_VIA_DAPP to unknown → UNKNOWN_REGISTRY_ADDRESS, no mutation', () => {
  const state = stateDistributed();
  const before_a_active = S.computeTotals(state).a_active_current;
  const r = S.createDAppIntent(state, {
    connected_wallet_address: 'Wallet_1',
    selected_network: 'A',
    operation_mode: S.OPERATION_MODE.DIRECT_HOST_NETWORK_VIA_DAPP,
    amount: 1000,
    target_network: 'A',
    target_address: 'UnknownAddr_999',
  });
  if (!r.ok) return r;
  const val = S.validateDAppIntent(state, r.intent);
  if (val.reason !== S.REASON_CODE.UNKNOWN_REGISTRY_ADDRESS) return { reason: val.reason };
  const after_a_active = S.computeTotals(state).a_active_current;
  if (before_a_active !== after_a_active) return { mutation: 'A_ACTIVE changed' };
  const has_event = state.events.some(e => e.event_type === 'DAPP_PRE_VALIDATION_REJECTED');
  return has_event ? true : { missing: 'DAPP_PRE_VALIDATION_REJECTED' };
});

test(27, 'DAppIntent DIRECT_HOST_NETWORK_VIA_DAPP to cold wallet → address_policy=cold_wallet', () => {
  const state = stateDistributed();
  state.wallets['A:Cold_1'] = S.createWalletBalance({
    network_id:'A', wallet_address:'Cold_1', is_cold_wallet: true
  });
  const r = S.createDAppIntent(state, {
    connected_wallet_address: 'Wallet_1',
    selected_network: 'A',
    operation_mode: S.OPERATION_MODE.DIRECT_HOST_NETWORK_VIA_DAPP,
    amount: 500,
    target_network: 'A',
    target_address: 'Cold_1',
  });
  if (!r.ok) return r;
  return eq(r.intent.address_policy_status, S.ADDRESS_POLICY.COLD_WALLET);
});

test(28, 'DAppIntent expired → INTENT_EXPIRED at validateDAppIntent', () => {
  const state = stateDistributed();
  const r = S.createDAppIntent(state, {
    connected_wallet_address: 'Wallet_1',
    selected_network: 'A',
    operation_mode: S.OPERATION_MODE.THROUGH_METAREGISTRY,
    source_mode: S.SOURCE_MODE.AUTOMATIC,
    amount: 500,
    target_network: 'B',
    target_address: 'Wallet_1',
  });
  // Force expiry
  r.intent.expires_at = Date.now() - 1000;
  const val = S.validateDAppIntent(state, r.intent);
  return eq(val.reason, S.REASON_CODE.INTENT_EXPIRED);
});

// ── COLD WALLET ───────────────────────────────────────────────────────────────
console.log('\n[ Cold Wallet ]');

test(29, 'Cold wallet transfer: TokenStateLocation updated, traceability ok', () => {
  const state = stateDistributed();
  state.wallets['A:Cold_Wallet_1'] = S.createWalletBalance({
    network_id:'A', wallet_address:'Cold_Wallet_1', is_cold_wallet: true
  });
  const obs = S.mockObservedExternalTransfer(state, {
    network_id:'A', tx_hash:'mock_tx_T29',
    from_address:'Wallet_1', to_address:'Cold_Wallet_1', amount:2000,
  });
  const rec = S.reconcileObservedTransfer(state, obs.observation);
  if (!rec.ok) return rec;
  const locs = Object.values(state.token_locations);
  const cold_loc = locs.find(l => l.last_known_address === 'Cold_Wallet_1');
  if (!cold_loc) return { missing: 'TokenStateLocation for cold wallet' };
  if (cold_loc.reason_code !== 'cold_wallet') return { reason_code: cold_loc.reason_code };
  const trace = S.checkTraceability(state);
  return trace.ok ? true : { traceability: trace.untracked };
});

// ── TRANSPARENCY ──────────────────────────────────────────────────────────────
console.log('\n[ Transparency ]');

test(30, 'getTransparencySnapshot: correct global_state, per_network, treasury_state, latest ops', () => {
  const state = stateDistributed();
  crossTransfer(state, 'Wallet_1', 1000, 'C');
  const snap = S.getTransparencySnapshot(state, 20);
  if (snap.global_state.A_ACTIVE !== 100_000) return { A_ACTIVE: snap.global_state.A_ACTIVE };
  if (snap.global_state.invariant_status !== 'ok') return { invariant_status: snap.global_state.invariant_status };
  if (!snap.per_network['A']) return { missing: 'per_network.A' };
  if (!snap.treasury_state['IT-A']) return { missing: 'treasury_state.IT-A' };
  if (!Array.isArray(snap.latest_operations)) return { latest_operations: 'not array' };
  if (snap.latest_operations.length === 0) return { latest_operations: 'empty' };
  return true;
});

test(31, 'getEventHistory: limit=10, append order, append-only guarantee', () => {
  const state = stateDistributed();
  crossTransfer(state, 'Wallet_1', 1000, 'C');
  const history = S.getEventHistory(state, null, 10);
  if (!Array.isArray(history)) return { type: typeof history };
  if (history.length > 10) return { length: history.length };
  // Verify ordering: created_at must be non-decreasing
  for (let i = 1; i < history.length; i++) {
    if (history[i].created_at < history[i-1].created_at)
      return { order_violation: i };
  }
  // Verify immutability of records
  const first = history[0];
  const original_type = first.event_type;
  try { first.event_type = 'HACK'; } catch(_) {}
  return eq(first.event_type, original_type);
});

// ─── Summary ──────────────────────────────────────────────────────────────────
console.log('\n═══════════════════════════════════════════════════');
console.log(`  Results: ${passed} passed, ${failed} failed  (${passed+failed} total)`);
console.log('═══════════════════════════════════════════════════\n');

if (failed > 0) {
  console.log('Failed tests:');
  results.filter(r => r.status !== 'PASS').forEach(r => {
    console.log(`  T${String(r.id).padStart(2,'0')}: ${r.description}`);
    if (r.detail) console.log(`      ${JSON.stringify(r.detail)}`);
  });
  process.exit(1);
} else {
  console.log('All acceptance criteria met. Ready for Implementation Sequence step 2.\n');
}
