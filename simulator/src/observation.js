'use strict';

// ─── Observation and Reconciliation (§5.10 Simulator Spec v1.0) ───────────────
// mockObservedExternalTransfer()  — simulates host-chain Transfer event
// reconcileObservedTransfer()     — classifies and reconciles observation
// updateTokenStateLocation()      — creates/updates TokenStateLocation

const {
  CONSTANTS,
  NETWORK_IDS,
  EVENT_TYPE,
  SNAPSHOT_PHASE,
  REASON_CODE,
  TOKEN_STATUS,
  EXECUTION_PATH,
  RECONCILIATION_STATUS,
} = require('./constants');

const { generateObservationId, generateEventId, generateLocationId } = require('./idGenerator');
const { createHostNetworkObservation, createEventRecord, createTokenStateLocation } = require('./stateFactory');
const { checkInvariants, checkTraceability, triggerStop, assertActive, computeTotals } = require('./invariants');

// ─── mockObservedExternalTransfer ─────────────────────────────────────────────
// Simulates receiving a Transfer event from a host network.
// Returns { ok, observation }

function mockObservedExternalTransfer(state, {
  network_id,
  tx_hash,
  from_address,
  to_address,
  amount,
  block_number  = null,
  timestamp     = null,
  observed_event_type = 'Transfer',
}) {
  const active_check = assertActive(state);
  if (!active_check.ok) return { ok: false, reason: active_check.reason };

  // Basic validation
  if (!NETWORK_IDS.includes(network_id)) {
    return { ok: false, reason: REASON_CODE.INVALID_SOURCE_NETWORK, network_id };
  }
  if (!Number.isInteger(amount) || amount <= 0) {
    return { ok: false, reason: REASON_CODE.INVALID_AMOUNT, amount };
  }
  if (!from_address || !to_address) {
    return { ok: false, reason: 'MISSING_ADDRESS' };
  }

  const observation = createHostNetworkObservation({
    observation_id:     generateObservationId(),
    network_id,
    token_contract:     state.networks[network_id]?.token_contract || `mock_contract_${network_id}`,
    tx_hash:            tx_hash || `mock_tx_${Date.now()}`,
    block_number,
    timestamp,
    from_address,
    to_address,
    amount,
    observed_event_type,
  });

  state.observations[observation.observation_id] = observation;

  // Record HOST_TRANSFER_OBSERVED event
  const evt = createEventRecord({
    event_id:       generateEventId(),
    event_type:     EVENT_TYPE.HOST_TRANSFER_OBSERVED,
    observation_id: observation.observation_id,
    network_id,
    from_address,
    to_address,
    amount,
    evidence:       tx_hash,
  });
  state.events.push(evt);

  return { ok: true, observation };
}

// ─── reconcileObservedTransfer ────────────────────────────────────────────────
// Lifecycle: CLASSIFY → RECONCILE → RECORD → CHECK
//
// Case 1: to_address is known tester/cold/external wallet
//   → update WalletBalance and TokenStateLocation
//   → reconciliation_status = recorded
//   → EventRecord: EXTERNAL_TRANSFER_RECONCILED
//
// Case 2: to_address is UNKNOWN_REGISTRY_ADDRESS
//   → move amount from wallet_active to UNAVAILABLE
//   → TokenStateLocation status = UNAVAILABLE
//   → EventRecord: OUTSIDE_DAPP_TRANSFER_OBSERVED + UNAVAILABLE_STATE_APPLIED
//
// Returns { ok, classification, event_ids[] }

function reconcileObservedTransfer(state, observation) {
  const active_check = assertActive(state);
  if (!active_check.ok) return { ok: false, reason: active_check.reason };

  const { observation_id, network_id, from_address, to_address, amount } = observation;
  const event_ids = [];

  // ── CLASSIFY ──────────────────────────────────────────────────────────────
  const to_key  = `${network_id}:${to_address}`;
  const to_wallet = state.wallets[to_key];

  const is_known_tester   = to_wallet?.is_predefined_tester_address === true;
  const is_cold_wallet    = to_wallet?.is_cold_wallet === true;
  const is_external_reg   = to_wallet?.is_external_registered === true;
  const is_known          = is_known_tester || is_cold_wallet || is_external_reg;

  observation.classified = true;

  // ── RECONCILE ─────────────────────────────────────────────────────────────
  // Update sender balance
  const from_key    = `${network_id}:${from_address}`;
  const from_wallet = state.wallets[from_key];

  if (from_wallet && from_wallet.wallet_active >= amount) {
    from_wallet.wallet_active    -= amount;
    state.networks[network_id].wallet_active_total -= amount;
    from_wallet.last_seen_at      = Date.now();
  }
  // If sender is not in wallets (e.g. IT address) — skip wallet deduction,
  // the balance change will be reflected in TokenStateLocation only.

  if (is_known) {
    // ── Case 1: Known address ──────────────────────────────────────────────

    // Update recipient wallet
    if (to_wallet) {
      to_wallet.wallet_active  += amount;
      state.networks[network_id].wallet_active_total += amount;
      to_wallet.last_seen_at    = Date.now();
    }

    // Update or create TokenStateLocation
    updateTokenStateLocation(state, {
      network_id,
      current_address:       to_address,
      last_known_address:    to_address,
      amount,
      status:                TOKEN_STATUS.ACTIVE,
      execution_path:        EXECUTION_PATH.OUTSIDE_EXECUTION_PATH_BUT_OBSERVED,
      reconciliation_status: RECONCILIATION_STATUS.RECORDED,
      reason_code:           is_cold_wallet ? 'cold_wallet' : null,
    });

    // Record EXTERNAL_TRANSFER_RECONCILED
    const evt = createEventRecord({
      event_id:       generateEventId(),
      event_type:     EVENT_TYPE.EXTERNAL_TRANSFER_RECONCILED,
      observation_id,
      network_id,
      from_address,
      to_address,
      amount,
      state_after: {
        to_wallet_active: to_wallet?.wallet_active,
        address_type:     is_cold_wallet ? 'cold_wallet' : is_external_reg ? 'external_registered' : 'tester_wallet',
      },
      evidence: observation.tx_hash,
    });
    state.events.push(evt);
    event_ids.push(evt.event_id);

    observation.reconciled = true;

    // Run invariant + traceability check
    const inv   = checkInvariants(state, SNAPSHOT_PHASE.POST_OBSERVATION);
    const trace = checkTraceability(state);

    if (!inv.ok || !trace.ok) {
      triggerStop(state, REASON_CODE.INVARIANT_FAILURE);
      return { ok: false, reason: REASON_CODE.INVARIANT_FAILURE, event_ids };
    }

    return { ok: true, classification: 'known_address', event_ids };

  } else {
    // ── Case 2: UNKNOWN_REGISTRY_ADDRESS ──────────────────────────────────

    // Move amount to UNAVAILABLE in NetworkState
    // from_wallet balance already reduced above
    state.networks[network_id].UNAVAILABLE += amount;

    // Update TokenStateLocation with UNAVAILABLE status
    updateTokenStateLocation(state, {
      network_id,
      current_address:       null,
      last_known_address:    to_address,   // we know the address, just not registered
      amount,
      status:                TOKEN_STATUS.UNAVAILABLE,
      execution_path:        EXECUTION_PATH.OUTSIDE_EXECUTION_PATH_BUT_OBSERVED,
      reconciliation_status: RECONCILIATION_STATUS.RECORDED,
      reason_code:           REASON_CODE.UNKNOWN_REGISTRY_ADDRESS,
    });

    // Record OUTSIDE_DAPP_TRANSFER_OBSERVED
    const evt1 = createEventRecord({
      event_id:       generateEventId(),
      event_type:     EVENT_TYPE.OUTSIDE_DAPP_TRANSFER_OBSERVED,
      observation_id,
      network_id,
      from_address,
      to_address,
      amount,
      evidence:       observation.tx_hash,
      state_after: {
        reason_code:  REASON_CODE.UNKNOWN_REGISTRY_ADDRESS,
        UNAVAILABLE:  state.networks[network_id].UNAVAILABLE,
      },
    });
    state.events.push(evt1);
    event_ids.push(evt1.event_id);

    // Record UNAVAILABLE_STATE_APPLIED
    const evt2 = createEventRecord({
      event_id:       generateEventId(),
      event_type:     EVENT_TYPE.UNAVAILABLE_STATE_APPLIED,
      observation_id,
      network_id,
      from_address,
      to_address,
      amount,
      evidence:       `unavailable_${amount}_${network_id}`,
      state_after: {
        UNAVAILABLE_total: state.networks[network_id].UNAVAILABLE,
        A_ACTIVE:          computeTotals(state).a_active_current,
      },
    });
    state.events.push(evt2);
    event_ids.push(evt2.event_id);

    observation.reconciled = true;

    // Run invariant check — A_ACTIVE must still be 100,000
    // (UNAVAILABLE is included in A_ACTIVE formula)
    const inv   = checkInvariants(state, SNAPSHOT_PHASE.POST_OBSERVATION);
    const trace = checkTraceability(state);

    if (!inv.ok || !trace.ok) {
      triggerStop(state, REASON_CODE.INVARIANT_FAILURE);
      return { ok: false, reason: REASON_CODE.INVARIANT_FAILURE, event_ids };
    }

    return {
      ok:             true,
      classification: 'UNKNOWN_REGISTRY_ADDRESS',
      UNAVAILABLE:    state.networks[network_id].UNAVAILABLE,
      event_ids,
    };
  }
}

// ─── updateTokenStateLocation ────────────────────────────────────────────────
// Creates or updates a TokenStateLocation record.
// Returns the location record.

function updateTokenStateLocation(state, {
  network_id,
  current_address      = null,
  last_known_address   = null,
  amount,
  status               = TOKEN_STATUS.ACTIVE,
  execution_path       = EXECUTION_PATH.OUTSIDE_EXECUTION_PATH_BUT_OBSERVED,
  reconciliation_status = RECONCILIATION_STATUS.RECORDED,
  reason_code          = null,
}) {
  const location = createTokenStateLocation({
    location_id:           generateLocationId(),
    network_id,
    current_address,
    last_known_address,
    amount,
    status,
    execution_path,
    reconciliation_status,
    reason_code,
  });

  state.token_locations[location.location_id] = location;
  return location;
}

module.exports = {
  mockObservedExternalTransfer,
  reconcileObservedTransfer,
  updateTokenStateLocation,
};
