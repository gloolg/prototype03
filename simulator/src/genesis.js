'use strict';

// ─── Genesis (§5.1 Simulator Spec v1.0) ──────────────────────────────────────
// initializeGenesis(config)          — sets up 4-network state, partition 25/75
// validateStartingDistribution(state) — verifies all 9 invariants post-genesis

const {
  CONSTANTS,
  EVENT_TYPE,
  SNAPSHOT_PHASE,
  SNAPSHOT_STATUS,
  SYSTEM_STATUS,
} = require('./constants');

const { generateEventId, generateSnapshotId } = require('./idGenerator');

const {
  createMasterState,
  createNetworkState,
  createTreasuryState,
  createEventRecord,
  createInvariantSnapshot,
} = require('./stateFactory');

const { checkInvariants, checkTraceability, computeTotals } = require('./invariants');
const { calculateActiveShares, calculateFrozenReserve } = require('./networkAllocation');

const {
  MINTED_PER_NETWORK,
  A_ACTIVE_EXPECTED,
} = CONSTANTS;

// ─── initializeGenesis(config) → State ───────────────────────────────────────
// Config shape:
// {
//   networks: [
//     { network_id: 'A', it_address: '0xABC...' },
//     { network_id: 'B', it_address: '0xDEF...' },
//     { network_id: 'C', it_address: '0x123...' },
//     { network_id: 'D', it_address: '0x456...' },
//   ]
// }
// Tester wallets are NOT part of genesis config.
// They are registered and funded via applyTreasuryDistribution().

function initializeGenesis(config) {
  // ── Validate config ────────────────────────────────────────────────────────
  if (!config || !Array.isArray(config.networks)) {
    return { ok: false, reason: 'config.networks must be an array' };
  }
  if (config.networks.length < 1) {
    return { ok: false, reason: 'config.networks must contain at least 1 network' };
  }

  const provided_ids = config.networks.map(n => n.network_id);
  if (new Set(provided_ids).size !== provided_ids.length) {
    return { ok: false, reason: `Duplicate network_ids in config: ${provided_ids.join(',')}` };
  }

  const it_addresses = config.networks.map(n => n.it_address);
  if (new Set(it_addresses).size !== it_addresses.length) {
    return { ok: false, reason: 'IT addresses must be unique across all networks' };
  }

  for (const n of config.networks) {
    if (!n.it_address) {
      return { ok: false, reason: `Missing it_address for network ${n.network_id}` };
    }
  }

  // ── Build master state ─────────────────────────────────────────────────────
  const state = createMasterState();

  // ── Build config lookup ────────────────────────────────────────────────────
  const config_by_id = {};
  for (const n of config.networks) {
    config_by_id[n.network_id] = n;
  }

  // ── Compute per-network active shares dynamically ──────────────────────────
  // For N=4 (A,B,C,D): yields {A:25000,B:25000,C:25000,D:25000} — regression-safe.
  const configNetworkIds = config.networks.map(n => n.network_id);
  const activeShares = calculateActiveShares(configNetworkIds, A_ACTIVE_EXPECTED);

  // ── Initialize each network ────────────────────────────────────────────────
  for (let idx = 0; idx < config.networks.length; idx++) {
    const net_conf = config.networks[idx];
    const net_id   = net_conf.network_id;
    const it_id    = net_conf.it_id || `IT-${net_id}`;

    const itActive = activeShares[net_id];
    const itFrozen = calculateFrozenReserve(net_id, MINTED_PER_NETWORK, itActive);

    // Create NetworkState
    const net = createNetworkState({
      network_id:     net_id,
      network_name:   net_conf.network_name || `Network ${net_id}`,
      priority:       net_conf.priority     || idx + 1,
      token_contract: net_conf.token_contract || `mock_contract_${net_id}`,
      it_address:     net_conf.it_address,
    });

    // Set starting partition via dynamic allocation.
    // wallet_active_total remains 0 — no wallets funded yet.
    net.IT_ACTIVE = itActive;
    net.IT_FROZEN = itFrozen;

    state.networks[net_id] = net;

    // Create TreasuryState (must mirror NetworkState — both set together)
    const treasury = createTreasuryState({
      network_id: net_id,
      it_id,
      it_address: net_conf.it_address,
    });
    treasury.IT_ACTIVE = itActive;
    treasury.IT_FROZEN = itFrozen;
    state.treasuries[net_id] = treasury;

    // Record GENESIS_MINT event
    const evt_mint = createEventRecord({
      event_id:    generateEventId(),
      event_type:  EVENT_TYPE.GENESIS_MINT,
      network_id:  net_id,
      to_address:  net_conf.it_address,
      amount:      MINTED_PER_NETWORK,
      evidence:    `mock_mint_tx_${net_id}`,
      state_after: { IT_ACTIVE: itActive, IT_FROZEN: itFrozen },
    });
    state.events.push(evt_mint);

    // Record GENESIS_TREASURY_CAPTURE event
    const evt_capture = createEventRecord({
      event_id:    generateEventId(),
      event_type:  EVENT_TYPE.GENESIS_TREASURY_CAPTURE,
      network_id:  net_id,
      to_address:  net_conf.it_address,
      amount:      MINTED_PER_NETWORK,
      evidence:    `mock_capture_${net_id}`,
      state_after: { it_id, IT_ACTIVE: itActive, IT_FROZEN: itFrozen },
    });
    state.events.push(evt_capture);
  }

  // ── Mark genesis complete and system ACTIVE ────────────────────────────────
  state.genesis_complete = true;
  state.status = SYSTEM_STATUS.ACTIVE;

  // ── Create initial InvariantSnapshot ──────────────────────────────────────
  const totals = computeTotals(state);
  const snap = createInvariantSnapshot({
    snapshot_id:         generateSnapshotId(),
    phase:               SNAPSHOT_PHASE.POST_COMPLETION,
    active_current:      totals.a_active_current,
    frozen_current:      totals.IT_FROZEN_total,
    minted_current:      totals.total_minted,
    unavailable_total:   totals.UNAVAILABLE_total,
    traceability_status: 'ok',
    status:              SNAPSHOT_STATUS.OK,
  });
  state.snapshots.push(snap);

  return { ok: true, state };
}

// ─── validateStartingDistribution(state) → InvariantReport ───────────────────
// Verifies post-genesis state before any treasury distribution.
// Expected: IT_ACTIVE = 25,000 / IT_FROZEN = 75,000 / wallet_active = 0 per network.
// The 60/40 rule is NOT checked here — it belongs to applyTreasuryDistribution().

function validateStartingDistribution(state) {
  const failures = [];

  // Run full invariant check
  const inv_report = checkInvariants(state, SNAPSHOT_PHASE.POST_COMPLETION);
  if (!inv_report.ok) {
    failures.push(...inv_report.violations.map(v => ({ check: v.invariant, ...v })));
  }

  // Run traceability check
  const trace_report = checkTraceability(state);
  if (!trace_report.ok) {
    failures.push(...trace_report.untracked.map(u => ({ check: 'TRACEABILITY', ...u })));
  }

  // Compute expected shares using the same algorithm as initializeGenesis.
  const stateNetworkIds = Object.keys(state.networks);
  const expectedShares  = calculateActiveShares(stateNetworkIds, A_ACTIVE_EXPECTED);

  // Verify exact starting values per network
  for (const net_id of stateNetworkIds) {
    const net = state.networks[net_id];
    const treasury = state.treasuries[net_id];

    if (!net) {
      failures.push({ check: 'NETWORK_EXISTS', network_id: net_id, issue: 'NetworkState missing' });
      continue;
    }
    if (!treasury) {
      failures.push({ check: 'TREASURY_EXISTS', network_id: net_id, issue: 'TreasuryState missing' });
      continue;
    }

    const expectedItActive = expectedShares[net_id];
    const expectedItFrozen = calculateFrozenReserve(net_id, MINTED_PER_NETWORK, expectedItActive);

    // IT_ACTIVE must match dynamic allocation spec
    if (net.IT_ACTIVE !== expectedItActive) {
      failures.push({
        check:      'STARTING_IT_ACTIVE',
        network_id: net_id,
        expected:   expectedItActive,
        actual:     net.IT_ACTIVE,
      });
    }

    // IT_FROZEN must match structural reserve spec
    if (net.IT_FROZEN !== expectedItFrozen) {
      failures.push({
        check:      'STARTING_IT_FROZEN',
        network_id: net_id,
        expected:   expectedItFrozen,
        actual:     net.IT_FROZEN,
      });
    }

    // wallet_active_total must be 0 (no distribution yet)
    if (net.wallet_active_total !== 0) {
      failures.push({
        check:      'WALLET_ACTIVE_ZERO_AT_GENESIS',
        network_id: net_id,
        expected:   0,
        actual:     net.wallet_active_total,
      });
    }

    // UNAVAILABLE must be 0
    if (net.UNAVAILABLE !== 0) {
      failures.push({
        check:      'UNAVAILABLE_ZERO_AT_GENESIS',
        network_id: net_id,
        expected:   0,
        actual:     net.UNAVAILABLE,
      });
    }

    // TreasuryState must mirror NetworkState
    if (treasury.IT_ACTIVE !== net.IT_ACTIVE) {
      failures.push({
        check:      'TREASURY_MIRROR_IT_ACTIVE',
        network_id: net_id,
        treasury:   treasury.IT_ACTIVE,
        network:    net.IT_ACTIVE,
      });
    }
    if (treasury.IT_FROZEN !== net.IT_FROZEN) {
      failures.push({
        check:      'TREASURY_MIRROR_IT_FROZEN',
        network_id: net_id,
        treasury:   treasury.IT_FROZEN,
        network:    net.IT_FROZEN,
      });
    }
  }

  // Verify genesis events were created: 4× GENESIS_MINT + 4× GENESIS_TREASURY_CAPTURE
  const genesis_mints    = state.events.filter(e => e.event_type === EVENT_TYPE.GENESIS_MINT);
  const genesis_captures = state.events.filter(e => e.event_type === EVENT_TYPE.GENESIS_TREASURY_CAPTURE);

  const N = stateNetworkIds.length;
  if (genesis_mints.length !== N) {
    failures.push({ check: 'GENESIS_MINT_EVENTS',    expected: N, actual: genesis_mints.length });
  }
  if (genesis_captures.length !== N) {
    failures.push({ check: 'GENESIS_CAPTURE_EVENTS', expected: N, actual: genesis_captures.length });
  }

  const ok = failures.length === 0;
  return {
    ok,
    failures,
    summary: ok
      ? `Genesis valid. N=${N}, A_ACTIVE=${A_ACTIVE_EXPECTED}, TOTAL_MINTED=${N * MINTED_PER_NETWORK}, TOTAL_FROZEN=${N * MINTED_PER_NETWORK - A_ACTIVE_EXPECTED}. Per-network IT_ACTIVE allocations match calculateActiveShares spec.`
      : `Genesis validation failed: ${failures.length} issue(s).`,
  };
}

module.exports = {
  initializeGenesis,
  validateStartingDistribution,
};
