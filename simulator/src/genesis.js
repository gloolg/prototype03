'use strict';

// ─── Genesis (§5.1 Simulator Spec v1.0) ──────────────────────────────────────
// initializeGenesis(config)          — sets up 4-network state, partition 25/75
// validateStartingDistribution(state) — verifies all 9 invariants post-genesis

const {
  CONSTANTS,
  NETWORKS,
  NETWORK_IDS,
  EVENT_TYPE,
  SNAPSHOT_PHASE,
  SNAPSHOT_STATUS,
  SYSTEM_STATUS,
  REASON_CODE,
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

const {
  MINTED_PER_NETWORK,
  STARTING_IT_ACTIVE_PER_NETWORK,
  STARTING_IT_FROZEN_PER_NETWORK,
  TOTAL_MINTED_EXPECTED,
  A_ACTIVE_EXPECTED,
  TOTAL_FROZEN_EXPECTED,
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
  if (config.networks.length !== CONSTANTS.NETWORK_COUNT) {
    return {
      ok:     false,
      reason: `config.networks must contain exactly ${CONSTANTS.NETWORK_COUNT} networks, got ${config.networks.length}`,
    };
  }

  const provided_ids = config.networks.map(n => n.network_id).sort();
  const expected_ids = [...NETWORK_IDS].sort();
  if (JSON.stringify(provided_ids) !== JSON.stringify(expected_ids)) {
    return {
      ok:     false,
      reason: `config.networks must contain exactly networks ${NETWORK_IDS.join(',')}. Got: ${provided_ids.join(',')}`,
    };
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

  // ── Initialize each network ────────────────────────────────────────────────
  for (const net_def of NETWORKS) {
    const net_id   = net_def.network_id;
    const net_conf = config_by_id[net_id];
    const it_id    = net_def.it_id;

    // Create NetworkState
    const net = createNetworkState({
      network_id:     net_id,
      network_name:   net_def.network_name,
      priority:       net_def.priority,
      token_contract: net_conf.token_contract || `mock_contract_${net_id}`,
      it_address:     net_conf.it_address,
    });

    // Set starting partition: 25,000 active / 75,000 frozen per network
    // This is the canonical logical partition set by MetaRegistry at genesis.
    // wallet_active_total remains 0 — no wallets funded yet.
    net.IT_ACTIVE = STARTING_IT_ACTIVE_PER_NETWORK;
    net.IT_FROZEN = STARTING_IT_FROZEN_PER_NETWORK;

    state.networks[net_id] = net;

    // Create TreasuryState (must mirror NetworkState — both set together)
    const treasury = createTreasuryState({
      network_id: net_id,
      it_id,
      it_address: net_conf.it_address,
    });
    treasury.IT_ACTIVE = STARTING_IT_ACTIVE_PER_NETWORK;
    treasury.IT_FROZEN = STARTING_IT_FROZEN_PER_NETWORK;
    state.treasuries[net_id] = treasury;

    // Record GENESIS_MINT event
    const evt_mint = createEventRecord({
      event_id:    generateEventId(),
      event_type:  EVENT_TYPE.GENESIS_MINT,
      network_id:  net_id,
      to_address:  net_conf.it_address,
      amount:      MINTED_PER_NETWORK,
      evidence:    `mock_mint_tx_${net_id}`,
      state_after: {
        IT_ACTIVE: STARTING_IT_ACTIVE_PER_NETWORK,
        IT_FROZEN: STARTING_IT_FROZEN_PER_NETWORK,
      },
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
      state_after: {
        it_id,
        IT_ACTIVE: STARTING_IT_ACTIVE_PER_NETWORK,
        IT_FROZEN: STARTING_IT_FROZEN_PER_NETWORK,
      },
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

  // Verify exact starting values per network
  for (const net_id of NETWORK_IDS) {
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

    // IT_ACTIVE must be exactly STARTING_IT_ACTIVE_PER_NETWORK
    if (net.IT_ACTIVE !== STARTING_IT_ACTIVE_PER_NETWORK) {
      failures.push({
        check:      'STARTING_IT_ACTIVE',
        network_id: net_id,
        expected:   STARTING_IT_ACTIVE_PER_NETWORK,
        actual:     net.IT_ACTIVE,
      });
    }

    // IT_FROZEN must be exactly STARTING_IT_FROZEN_PER_NETWORK
    if (net.IT_FROZEN !== STARTING_IT_FROZEN_PER_NETWORK) {
      failures.push({
        check:      'STARTING_IT_FROZEN',
        network_id: net_id,
        expected:   STARTING_IT_FROZEN_PER_NETWORK,
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

  if (genesis_mints.length !== CONSTANTS.NETWORK_COUNT) {
    failures.push({
      check:    'GENESIS_MINT_EVENTS',
      expected: CONSTANTS.NETWORK_COUNT,
      actual:   genesis_mints.length,
    });
  }
  if (genesis_captures.length !== CONSTANTS.NETWORK_COUNT) {
    failures.push({
      check:    'GENESIS_CAPTURE_EVENTS',
      expected: CONSTANTS.NETWORK_COUNT,
      actual:   genesis_captures.length,
    });
  }

  const ok = failures.length === 0;
  return {
    ok,
    failures,
    summary: ok
      ? `Genesis valid. A_ACTIVE=${A_ACTIVE_EXPECTED}, TOTAL_FROZEN=${TOTAL_FROZEN_EXPECTED}, TOTAL_MINTED=${TOTAL_MINTED_EXPECTED}. All networks IT_ACTIVE=${STARTING_IT_ACTIVE_PER_NETWORK}/IT_FROZEN=${STARTING_IT_FROZEN_PER_NETWORK}.`
      : `Genesis validation failed: ${failures.length} issue(s).`,
  };
}

module.exports = {
  initializeGenesis,
  validateStartingDistribution,
};
