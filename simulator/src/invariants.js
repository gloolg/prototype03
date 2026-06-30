'use strict';

// ─── Invariants (§3, §5.9 Simulator Spec v1.0) ───────────────────────────────
// checkInvariants()   — verifies all 9 invariants
// checkTraceability() — verifies every tEQUI has a known location
// triggerStop()       — halts the simulator on critical failure

const { CONSTANTS, NETWORK_IDS, REASON_CODE, SNAPSHOT_PHASE, SNAPSHOT_STATUS, SYSTEM_STATUS, EVENT_TYPE } = require('./constants');
const { generateSnapshotId, generateEventId } = require('./idGenerator');
const { createInvariantSnapshot, createEventRecord } = require('./stateFactory');

const {
  TOTAL_MINTED_EXPECTED,
  A_ACTIVE_EXPECTED,
  TOTAL_FROZEN_EXPECTED,
  MINTED_PER_NETWORK,
} = CONSTANTS;

// ─── Helper: compute global totals from state ─────────────────────────────────
function computeTotals(state) {
  let wallet_active_total = 0;
  let IT_ACTIVE_total     = 0;
  let IT_FROZEN_total     = 0;
  let UNAVAILABLE_total   = 0;

  for (const net_id of NETWORK_IDS) {
    const net = state.networks[net_id];
    if (!net) continue;
    wallet_active_total += net.wallet_active_total;
    IT_ACTIVE_total     += net.IT_ACTIVE;
    IT_FROZEN_total     += net.IT_FROZEN;
    UNAVAILABLE_total   += net.UNAVAILABLE;
  }

  const a_active_current = wallet_active_total + IT_ACTIVE_total + UNAVAILABLE_total;
  const total_minted     = wallet_active_total + IT_ACTIVE_total + IT_FROZEN_total + UNAVAILABLE_total;

  return {
    wallet_active_total,
    IT_ACTIVE_total,
    IT_FROZEN_total,
    UNAVAILABLE_total,
    a_active_current,
    total_minted,
  };
}

// ─── checkInvariants(state, phase) → InvariantReport ─────────────────────────
// Checks all 9 invariants.
// phase: SNAPSHOT_PHASE value — determines whether transitional deviation is allowed.
// Returns { ok: bool, violations: [], snapshot: InvariantSnapshot }
function checkInvariants(state, phase) {
  const totals = computeTotals(state);
  const violations = [];
  const is_transitional = (phase === SNAPSHOT_PHASE.POST_SOURCE_FREEZE);

  // Invariant 1: TOTAL_MINTED
  if (totals.total_minted !== TOTAL_MINTED_EXPECTED) {
    violations.push({
      invariant: 'TOTAL_MINTED',
      expected:  TOTAL_MINTED_EXPECTED,
      actual:    totals.total_minted,
      code:      REASON_CODE.INVARIANT_FAILURE,
    });
  }

  // Invariant 2: A_ACTIVE
  // Positive delta = STOP (never allowed).
  // Negative delta = allowed only during POST_SOURCE_FREEZE phase.
  const active_delta = totals.a_active_current - A_ACTIVE_EXPECTED;
  if (active_delta > 0) {
    violations.push({
      invariant: 'A_ACTIVE_POSITIVE_DELTA',
      expected:  A_ACTIVE_EXPECTED,
      actual:    totals.a_active_current,
      delta:     active_delta,
      code:      REASON_CODE.POSITIVE_ACTIVE_DELTA,
      critical:  true,   // triggers STOP
    });
  } else if (active_delta < 0 && !is_transitional) {
    violations.push({
      invariant: 'A_ACTIVE_NEGATIVE_OUTSIDE_TRANSITION',
      expected:  A_ACTIVE_EXPECTED,
      actual:    totals.a_active_current,
      delta:     active_delta,
      code:      REASON_CODE.INVARIANT_FAILURE,
    });
  }

  // Invariant 3: TOTAL_FROZEN
  if (totals.IT_FROZEN_total !== TOTAL_FROZEN_EXPECTED) {
    // During POST_SOURCE_FREEZE: IT_FROZEN increases temporarily — allowed
    // (frozen increases when source is frozen, before target is unfrozen)
    if (!is_transitional) {
      violations.push({
        invariant: 'TOTAL_FROZEN',
        expected:  TOTAL_FROZEN_EXPECTED,
        actual:    totals.IT_FROZEN_total,
        code:      REASON_CODE.INVARIANT_FAILURE,
      });
    }
  }

  // Invariant 4: PER_NETWORK_TOTAL
  for (const net_id of NETWORK_IDS) {
    const net = state.networks[net_id];
    if (!net) {
      violations.push({
        invariant: `PER_NETWORK_TOTAL_${net_id}`,
        expected:  MINTED_PER_NETWORK,
        actual:    0,
        code:      REASON_CODE.INVARIANT_FAILURE,
      });
      continue;
    }
    const net_total = net.wallet_active_total + net.IT_ACTIVE + net.IT_FROZEN + net.UNAVAILABLE;
    if (net_total !== MINTED_PER_NETWORK) {
      if (!is_transitional) {
        violations.push({
          invariant: `PER_NETWORK_TOTAL_${net_id}`,
          expected:  MINTED_PER_NETWORK,
          actual:    net_total,
          code:      REASON_CODE.INVARIANT_FAILURE,
        });
      }
    }
  }

  // Invariant 5: INTEGER_ONLY — checked via amounts being integers
  // (enforced at input validation; here we double-check key totals)
  const non_integers = [];
  for (const net_id of NETWORK_IDS) {
    const net = state.networks[net_id];
    if (!net) continue;
    if (!Number.isInteger(net.wallet_active_total)) non_integers.push(`${net_id}.wallet_active_total`);
    if (!Number.isInteger(net.IT_ACTIVE))           non_integers.push(`${net_id}.IT_ACTIVE`);
    if (!Number.isInteger(net.IT_FROZEN))           non_integers.push(`${net_id}.IT_FROZEN`);
    if (!Number.isInteger(net.UNAVAILABLE))         non_integers.push(`${net_id}.UNAVAILABLE`);
  }
  if (non_integers.length > 0) {
    violations.push({
      invariant: 'INTEGER_ONLY',
      fields:    non_integers,
      code:      REASON_CODE.INVALID_AMOUNT,
    });
  }

  // Invariant 6: NO_NEGATIVE_STATE
  const negatives = [];
  for (const net_id of NETWORK_IDS) {
    const net = state.networks[net_id];
    if (!net) continue;
    if (net.wallet_active_total < 0) negatives.push(`${net_id}.wallet_active_total`);
    if (net.IT_ACTIVE < 0)           negatives.push(`${net_id}.IT_ACTIVE`);
    if (net.IT_FROZEN < 0)           negatives.push(`${net_id}.IT_FROZEN`);
    if (net.UNAVAILABLE < 0)         negatives.push(`${net_id}.UNAVAILABLE`);
  }
  // Check individual wallets
  for (const key of Object.keys(state.wallets)) {
    const w = state.wallets[key];
    if (w.wallet_active < 0) negatives.push(`wallet:${key}`);
  }
  if (negatives.length > 0) {
    violations.push({
      invariant: 'NO_NEGATIVE_STATE',
      fields:    negatives,
      code:      REASON_CODE.NEGATIVE_BALANCE_RISK,
      critical:  true,
    });
  }

  // Invariant 7: APPEND_ONLY
  // Cannot be verified at runtime (we rely on module discipline + Object.freeze on records).
  // Checked implicitly by the fact that events/snapshots arrays only grow.

  // Invariant 8: TRACEABILITY — delegated to checkTraceability()
  // Called separately so we get a detailed report.

  // Invariant 9: ACTIVE_LAYER_IMMUTABILITY (already covered by Invariant 2 positive delta check)

  // ─── Determine snapshot status ───────────────────────────────────────────────
  const has_critical = violations.some(v => v.critical);
  const snapshot_status = has_critical
    ? SNAPSHOT_STATUS.STOP
    : is_transitional
      ? SNAPSHOT_STATUS.TRANSITIONAL
      : violations.length > 0
        ? SNAPSHOT_STATUS.STOP
        : SNAPSHOT_STATUS.OK;

  const snapshot = createInvariantSnapshot({
    snapshot_id:         generateSnapshotId(),
    phase,
    active_current:      totals.a_active_current,
    frozen_current:      totals.IT_FROZEN_total,
    minted_current:      totals.total_minted,
    unavailable_total:   totals.UNAVAILABLE_total,
    traceability_status: 'pending', // set after checkTraceability()
    status:              snapshot_status,
  });

  // Append snapshot to state (append-only)
  state.snapshots.push(snapshot);

  // Append INVARIANT_SNAPSHOT event
  const evt = createEventRecord({
    event_id:    generateEventId(),
    event_type:  EVENT_TYPE.INVARIANT_SNAPSHOT,
    evidence:    `phase=${phase} status=${snapshot_status} delta=${active_delta}`,
  });
  state.events.push(evt);

  const ok = violations.length === 0;
  return { ok, violations, snapshot, totals };
}

// ─── checkTraceability(state) → TraceabilityReport ───────────────────────────
// Verifies every tEQUI amount has a known location.
// Returns { ok: bool, untracked: [], details: string }
function checkTraceability(state) {
  const untracked = [];

  // For each network: compute expected trackable amount
  // = wallet_active_total + IT_ACTIVE + UNAVAILABLE (IT_FROZEN is in treasury, always tracked)
  for (const net_id of NETWORK_IDS) {
    const net = state.networks[net_id];
    if (!net) continue;

    // Sum all wallet balances for this network
    let wallet_sum = 0;
    for (const key of Object.keys(state.wallets)) {
      const w = state.wallets[key];
      if (w.network_id === net_id) {
        wallet_sum += w.wallet_active;
      }
    }

    // wallet_active_total must equal sum of individual wallet balances
    if (wallet_sum !== net.wallet_active_total) {
      untracked.push({
        network_id: net_id,
        issue:      'wallet_active_total_mismatch',
        expected:   net.wallet_active_total,
        actual:     wallet_sum,
      });
    }

    // Sum TokenStateLocation amounts for this network (active + UNAVAILABLE only)
    let location_sum = 0;
    for (const loc_id of Object.keys(state.token_locations)) {
      const loc = state.token_locations[loc_id];
      if (loc.network_id === net_id && loc.status !== 'frozen') {
        location_sum += loc.amount;
      }
    }

    // IT_ACTIVE and IT_FROZEN are always accounted via TreasuryState
    const treasury = state.treasuries[net_id];
    if (treasury) {
      if (treasury.IT_ACTIVE !== net.IT_ACTIVE) {
        untracked.push({
          network_id: net_id,
          issue:      'treasury_IT_ACTIVE_mismatch',
          treasury:   treasury.IT_ACTIVE,
          network:    net.IT_ACTIVE,
        });
      }
      if (treasury.IT_FROZEN !== net.IT_FROZEN) {
        untracked.push({
          network_id: net_id,
          issue:      'treasury_IT_FROZEN_mismatch',
          treasury:   treasury.IT_FROZEN,
          network:    net.IT_FROZEN,
        });
      }
    }
  }

  // Every active or UNAVAILABLE amount must have a TokenStateLocation
  // with current_address or last_known_address
  for (const loc_id of Object.keys(state.token_locations)) {
    const loc = state.token_locations[loc_id];
    if (loc.amount > 0 && !loc.current_address && !loc.last_known_address) {
      untracked.push({
        location_id: loc_id,
        issue:       'no_known_address',
        amount:      loc.amount,
        network_id:  loc.network_id,
      });
    }
    if (loc.amount < 0) {
      untracked.push({
        location_id: loc_id,
        issue:       'negative_location_amount',
        amount:      loc.amount,
      });
    }
  }

  const ok = untracked.length === 0;
  return {
    ok,
    untracked,
    details: ok
      ? 'All tEQUI amounts have known locations.'
      : `${untracked.length} traceability issue(s) found.`,
  };
}

// ─── triggerStop(state, reasonCode) → StopRecord ─────────────────────────────
// Halts the simulator. No operations allowed after STOP.
function triggerStop(state, reasonCode) {
  // Set global STOP
  state.status      = SYSTEM_STATUS.STOP;
  state.stop_reason = reasonCode;

  // Capture current totals for the stop snapshot
  const totals = computeTotals(state);

  const snapshot = createInvariantSnapshot({
    snapshot_id:         generateSnapshotId(),
    phase:               SNAPSHOT_PHASE.POST_COMPLETION, // best-effort
    active_current:      totals.a_active_current,
    frozen_current:      totals.IT_FROZEN_total,
    minted_current:      totals.total_minted,
    unavailable_total:   totals.UNAVAILABLE_total,
    traceability_status: 'unknown',
    status:              SNAPSHOT_STATUS.STOP,
  });
  state.snapshots.push(snapshot);

  const evt = createEventRecord({
    event_id:   generateEventId(),
    event_type: EVENT_TYPE.STOP_TRIGGERED,
    evidence:   `reason=${reasonCode}`,
  });
  state.events.push(evt);

  return {
    stop_reason:  reasonCode,
    snapshot_id:  snapshot.snapshot_id,
    event_id:     evt.event_id,
    stopped_at:   Date.now(),
  };
}

// ─── Guard: check system is ACTIVE before any operation ──────────────────────
// Returns { ok: true } or { ok: false, reason }
function assertActive(state) {
  if (state.status === SYSTEM_STATUS.STOP) {
    return { ok: false, reason: REASON_CODE.SYSTEM_STOP };
  }
  if (state.status === SYSTEM_STATUS.UNINITIALIZED) {
    return { ok: false, reason: REASON_CODE.GENESIS_NOT_COMPLETED };
  }
  return { ok: true };
}

module.exports = {
  checkInvariants,
  checkTraceability,
  triggerStop,
  assertActive,
  computeTotals,
};
