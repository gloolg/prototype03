'use strict';

// ─── Treasury Distribution (§5.3 Simulator Spec v1.0) ────────────────────────
// applyTreasuryDistribution(state, network_id, wallet_address, amount)
//   Moves amount from IT_ACTIVE to wallet_active within the same network.
//   Does NOT touch IT_FROZEN.
//   Enforces 60/40 rule.

const {
  CONSTANTS,
  NETWORK_IDS,
  EVENT_TYPE,
  SNAPSHOT_PHASE,
  REASON_CODE,
  SYSTEM_STATUS,
} = require('./constants');

const { generateEventId } = require('./idGenerator');
const { createEventRecord, createWalletBalance } = require('./stateFactory');
const { checkInvariants, checkTraceability, triggerStop, assertActive, computeTotals } = require('./invariants');

const {
  MAX_WALLET_ACTIVE_STARTING,
  MIN_IT_ACTIVE_STARTING,
} = CONSTANTS;

// ─── applyTreasuryDistribution ────────────────────────────────────────────────
function applyTreasuryDistribution(state, network_id, wallet_address, amount) {

  // Guard 1: system must be ACTIVE and genesis complete
  const active_check = assertActive(state);
  if (!active_check.ok) {
    return { ok: false, reason: active_check.reason };
  }
  if (!state.genesis_complete) {
    return { ok: false, reason: REASON_CODE.GENESIS_NOT_COMPLETED };
  }

  // Guard 2: genesis must be recorded for this network
  const genesis_capture = state.events.find(
    e => e.event_type === EVENT_TYPE.GENESIS_TREASURY_CAPTURE && e.network_id === network_id
  );
  if (!genesis_capture) {
    return { ok: false, reason: REASON_CODE.GENESIS_NOT_COMPLETED, network_id };
  }

  // Guard 3: amount must be a positive integer
  if (!Number.isInteger(amount) || amount <= 0) {
    return { ok: false, reason: REASON_CODE.INVALID_AMOUNT, amount };
  }

  // Guard 4: network must exist
  const net = state.networks[network_id];
  if (!net) {
    return { ok: false, reason: REASON_CODE.INVALID_SOURCE_NETWORK, network_id };
  }

  // Guard 5: wallet must be in closed tester set
  // (registered before or being registered now as tester)
  const wallet_key = `${network_id}:${wallet_address}`;
  let wallet = state.wallets[wallet_key];

  if (wallet && !wallet.is_predefined_tester_address) {
    return {
      ok:     false,
      reason: REASON_CODE.UNKNOWN_RECIPIENT_WALLET,
      wallet_address,
      note:   'Recipient exists but is not a predefined tester address',
    };
  }

  // If wallet does not exist yet, it will be created as tester wallet
  // (this is the first-time registration flow for tester wallets)
  const is_new_wallet = !wallet;

  // Guard 6: IT_ACTIVE must be sufficient
  const treasury = state.treasuries[network_id];
  if (net.IT_ACTIVE < amount) {
    return {
      ok:     false,
      reason: REASON_CODE.INSUFFICIENT_SOURCE_BALANCE,
      network_id,
      IT_ACTIVE_available: net.IT_ACTIVE,
      requested: amount,
    };
  }

  // Guard 7: 60/40 rule — predict final state
  // total wallet_active after this operation must not exceed MAX_WALLET_ACTIVE_STARTING
  // across ALL networks
  let total_wallet_active_after = 0;
  for (const nid of NETWORK_IDS) {
    const n = state.networks[nid];
    if (!n) continue;
    total_wallet_active_after += n.wallet_active_total;
  }
  // Add the new amount for this network
  total_wallet_active_after += amount;

  if (total_wallet_active_after > MAX_WALLET_ACTIVE_STARTING) {
    return {
      ok:       false,
      reason:   REASON_CODE.WALLET_ACTIVE_CAP_EXCEEDED,
      current_total_wallet_active: total_wallet_active_after - amount,
      requested_addition:          amount,
      cap:                         MAX_WALLET_ACTIVE_STARTING,
    };
  }

  // Also check IT_ACTIVE minimum after operation
  const it_active_after = net.IT_ACTIVE - amount;
  // Note: MIN_IT_ACTIVE_STARTING (40,000) is a global constraint across all networks.
  // We check the global IT_ACTIVE total after this operation.
  let total_IT_ACTIVE_after = 0;
  for (const nid of NETWORK_IDS) {
    const n = state.networks[nid];
    if (!n) continue;
    total_IT_ACTIVE_after += (nid === network_id ? it_active_after : n.IT_ACTIVE);
  }
  if (total_IT_ACTIVE_after < MIN_IT_ACTIVE_STARTING) {
    return {
      ok:     false,
      reason: REASON_CODE.IT_ACTIVE_BELOW_MINIMUM,
      total_IT_ACTIVE_after,
      min_required: MIN_IT_ACTIVE_STARTING,
    };
  }

  // ── All guards passed — apply state mutation ───────────────────────────────
  const state_before = {
    network_id,
    IT_ACTIVE:          net.IT_ACTIVE,
    wallet_active_total: net.wallet_active_total,
    wallet_balance:     wallet ? wallet.wallet_active : 0,
  };

  // Create wallet if new
  if (is_new_wallet) {
    wallet = createWalletBalance({
      network_id,
      wallet_address,
      is_predefined_tester_address: true,
    });
    state.wallets[wallet_key] = wallet;
  }

  // Apply mutation: IT_ACTIVE -amount, wallet_active +amount
  net.IT_ACTIVE                -= amount;
  treasury.IT_ACTIVE           -= amount;    // keep in sync with NetworkState
  wallet.wallet_active         += amount;
  net.wallet_active_total      += amount;
  wallet.last_seen_at           = Date.now();

  const state_after = {
    network_id,
    IT_ACTIVE:          net.IT_ACTIVE,
    wallet_active_total: net.wallet_active_total,
    wallet_balance:     wallet.wallet_active,
  };

  // Append EventRecord
  const evt = createEventRecord({
    event_id:    generateEventId(),
    event_type:  EVENT_TYPE.TREASURY_DISTRIBUTION_APPLIED,
    network_id,
    from_address: net.it_address,
    to_address:   wallet_address,
    amount,
    state_before,
    state_after,
    evidence:    `treasury_dist_${network_id}_${wallet_address}_${amount}`,
  });
  state.events.push(evt);

  // Run invariant + traceability checks
  const inv = checkInvariants(state, SNAPSHOT_PHASE.POST_COMPLETION);
  if (!inv.ok) {
    triggerStop(state, REASON_CODE.INVARIANT_FAILURE);
    return {
      ok:         false,
      reason:     REASON_CODE.INVARIANT_FAILURE,
      violations: inv.violations,
    };
  }

  const trace = checkTraceability(state);
  if (!trace.ok) {
    triggerStop(state, REASON_CODE.TRACEABILITY_FAILURE);
    return {
      ok:        false,
      reason:    REASON_CODE.TRACEABILITY_FAILURE,
      untracked: trace.untracked,
    };
  }

  return { ok: true, event_id: evt.event_id, state_after };
}

module.exports = {
  applyTreasuryDistribution,
};
