'use strict';

// ─── Transparency (§5.11 Simulator Spec v1.0) ─────────────────────────────────
// getTransparencySnapshot() — canonical state output for public page
// getEventHistory()         — filtered append-only event history

const { CONSTANTS } = require('./constants');
const { computeTotals } = require('./invariants');

const DEFAULT_LIMIT = 50;

// ─── getTransparencySnapshot ──────────────────────────────────────────────────
function getTransparencySnapshot(state, limit = DEFAULT_LIMIT) {
  const totals = computeTotals(state);

  // ── Global state ───────────────────────────────────────────────────────────
  const global_state = {
    TOTAL_MINTED:     totals.total_minted,
    A_ACTIVE:         totals.a_active_current,
    TOTAL_FROZEN:     totals.IT_FROZEN_total,
    UNAVAILABLE_TOTAL: totals.UNAVAILABLE_total,
    invariant_status: (() => {
      const N = Object.keys(state.networks).length;
      const expectedMinted = N * CONSTANTS.MINTED_PER_NETWORK;
      const expectedFrozen = expectedMinted - CONSTANTS.A_ACTIVE_EXPECTED;
      return totals.a_active_current === CONSTANTS.A_ACTIVE_EXPECTED &&
             totals.IT_FROZEN_total   === expectedFrozen &&
             totals.total_minted      === expectedMinted ? 'ok' : 'violation';
    })(),
    system_status:    state.status,
    stop_reason:      state.stop_reason || null,
  };

  // ── Per-network breakdown ──────────────────────────────────────────────────
  const per_network = {};
  for (const net_id of Object.keys(state.networks)) {
    const net = state.networks[net_id];
    if (!net) continue;
    per_network[net_id] = {
      network_name:        net.network_name,
      wallet_active_total: net.wallet_active_total,
      IT_ACTIVE:           net.IT_ACTIVE,
      IT_FROZEN:           net.IT_FROZEN,
      UNAVAILABLE:         net.UNAVAILABLE,
      network_total:       net.network_total,
    };
  }

  // ── Treasury state ─────────────────────────────────────────────────────────
  const treasury_state = {};
  for (const net_id of Object.keys(state.networks)) {
    const tr = state.treasuries[net_id];
    if (!tr) continue;
    treasury_state[tr.it_id] = {
      it_address: tr.it_address,
      IT_ACTIVE:  tr.IT_ACTIVE,
      IT_FROZEN:  tr.IT_FROZEN,
    };
  }

  // ── Token state summary ────────────────────────────────────────────────────
  let total_active_wallets    = 0;
  let total_frozen_treasury   = 0;
  let total_unavailable       = 0;
  let reconciliation_required = 0;

  for (const net_id of Object.keys(state.networks)) {
    const net = state.networks[net_id];
    if (!net) continue;
    total_active_wallets  += net.wallet_active_total + net.IT_ACTIVE;
    total_frozen_treasury += net.IT_FROZEN;
    total_unavailable     += net.UNAVAILABLE;
  }

  for (const loc of Object.values(state.token_locations)) {
    if (loc.reconciliation_status === 'reconciliation_required') reconciliation_required++;
  }

  const token_state_summary = {
    active:                  total_active_wallets,
    frozen:                  total_frozen_treasury,
    UNAVAILABLE:             total_unavailable,
    reconciliation_required,
    observed_external_count: Object.values(state.observations).filter(o => o.classified).length,
  };

  // ── Latest operations ──────────────────────────────────────────────────────
  const latest_operations = state.events
    .slice(-Math.min(limit, state.events.length))
    .map(evt => ({
      event_id:       evt.event_id,
      event_type:     evt.event_type,
      network_id:     evt.network_id,
      from_address:   evt.from_address,
      to_address:     evt.to_address,
      amount:         evt.amount,
      envelope_id:    evt.envelope_id,
      observation_id: evt.observation_id,
      evidence:       evt.evidence,
      created_at:     evt.created_at,
    }));

  // ── Reconciliation queue ───────────────────────────────────────────────────
  const reconciliation_queue = Object.values(state.observations)
    .filter(o => !o.reconciled)
    .map(o => ({
      observation_id: o.observation_id,
      network_id:     o.network_id,
      tx_hash:        o.tx_hash,
      from_address:   o.from_address,
      to_address:     o.to_address,
      amount:         o.amount,
    }));

  return {
    global_state,
    per_network,
    treasury_state,
    token_state_summary,
    latest_operations,
    reconciliation_queue,
    snapshot_at: Date.now(),
  };
}

// ─── getEventHistory ──────────────────────────────────────────────────────────
// Returns EventRecords in append order.
// If envelope_id provided: filter by that envelope.
// limit = max records to return (most recent first if filtered, append order always).
function getEventHistory(state, envelope_id = null, limit = null) {
  let events = state.events;

  if (envelope_id) {
    events = events.filter(e => e.envelope_id === envelope_id);
  }

  if (limit && limit > 0) {
    events = events.slice(-limit);
  }

  // Return copies (records are frozen, but we return array slice)
  return [...events];
}

module.exports = {
  getTransparencySnapshot,
  getEventHistory,
};
