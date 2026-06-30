'use strict';

const { CONSTANTS } = require('./constants');

// ─── State Factory (§2 Simulator Spec v1.0) ───────────────────────────────────
// Creates properly shaped state entity objects.
// No logic here — only structure. Validation happens in dedicated modules.

const {
  SYSTEM_STATUS,
  TOKEN_STATUS,
  EXECUTION_PATH,
  RECONCILIATION_STATUS,
  SOURCE_OP_STATUS,
  SETTLEMENT_STATUS,
  SIGNATURE_STATUS,
  ENVELOPE_STATUS,
  ADDRESS_POLICY,
} = require('./constants');

// ─── Master State ─────────────────────────────────────────────────────────────
function createMasterState() {
  return {
    status:           SYSTEM_STATUS.UNINITIALIZED, // UNINITIALIZED | ACTIVE | STOP
    genesis_complete: false,

    // Core registries (keyed by ID for O(1) lookup)
    networks:          {},  // network_id → NetworkState
    treasuries:        {},  // network_id → TreasuryState
    wallets:           {},  // `${network_id}:${wallet_address}` → WalletBalance
    token_locations:   {},  // location_id → TokenStateLocation

    // Operation records
    envelopes:         {},  // envelope_id → OperationEnvelope
    source_operations: {},  // source_op_id → SourceOperation
    settlements:       {},  // settlement_id → TargetSettlement
    dapp_intents:      {},  // intent_id → DAppIntent
    observations:      {},  // observation_id → HostNetworkObservation

    // Append-only logs
    events:    [],   // EventRecord[] — append-only, never splice/delete
    snapshots: [],   // InvariantSnapshot[] — append-only, never splice/delete

    // Counters for traceability
    stop_reason: null,  // set when status = STOP
  };
}

// ─── NetworkState (§2.1) ──────────────────────────────────────────────────────
function createNetworkState({
  network_id,
  network_name,
  priority,
  token_contract,
  it_address,
}) {
  return {
    network_id,
    network_name,
    priority,
    token_contract:     token_contract || `mock_contract_${network_id}`,
    it_address,
    status:             'ACTIVE',
    wallet_active_total: 0,
    IT_ACTIVE:          0,
    IT_FROZEN:          0,
    UNAVAILABLE:        0,
    // Computed: wallet_active_total + IT_ACTIVE + IT_FROZEN + UNAVAILABLE
    // Must equal MINTED_PER_NETWORK (100,000) after genesis
    get network_total() {
      return this.wallet_active_total + this.IT_ACTIVE + this.IT_FROZEN + this.UNAVAILABLE;
    },
  };
}

// ─── TreasuryState (§2.3) ─────────────────────────────────────────────────────
// NetworkState is the source of truth for IT_ACTIVE and IT_FROZEN.
// TreasuryState must always be updated in the same operation as NetworkState.
function createTreasuryState({
  network_id,
  it_id,
  it_address,
}) {
  return {
    network_id,
    it_id,
    it_address,
    IT_ACTIVE:          0,
    IT_FROZEN:          0,
    latest_state_hash:  `mock_hash_${it_id}_init`,
  };
}

// ─── WalletBalance (§2.2) ─────────────────────────────────────────────────────
function createWalletBalance({
  network_id,
  wallet_address,
  is_predefined_tester_address = false,
  is_cold_wallet               = false,
  is_external_registered       = false,
}) {
  return {
    network_id,
    wallet_address,
    wallet_active:                0,
    is_predefined_tester_address,
    is_cold_wallet,
    is_external_registered,
    last_seen_at:                 Date.now(),
  };
}

// ─── TokenStateLocation (§2.4) ───────────────────────────────────────────────
function createTokenStateLocation({
  location_id,
  network_id,
  current_address      = null,
  last_known_address   = null,
  amount,
  status               = TOKEN_STATUS.ACTIVE,
  execution_path       = EXECUTION_PATH.THROUGH_METAREGISTRY,
  reconciliation_status = RECONCILIATION_STATUS.RECORDED,
  reason_code          = null,
}) {
  return {
    location_id,
    network_id,
    current_address,
    last_known_address,
    amount,
    status,
    execution_path,
    reconciliation_status,
    reason_code,
  };
}

// ─── OperationEnvelope (§2.5) ─────────────────────────────────────────────────
function createOperationEnvelope({
  envelope_id,
  operation_type,
  source_mode        = null,
  amount,
  sender             = null,
  recipient          = null,
  target_network     = null,
  dapp_intent_id     = null,
}) {
  return {
    envelope_id,
    operation_type,
    source_mode,
    amount,
    sender,
    recipient,
    target_network,
    status:               ENVELOPE_STATUS.CREATED,
    source_operation_ids: [],
    settlement_id:        null,
    dapp_intent_id,
    created_at:           Date.now(),
    completed_at:         null,
  };
}

// ─── SourceOperation (§2.6) ───────────────────────────────────────────────────
function createSourceOperation({
  source_op_id,
  envelope_id,
  source_network,
  source_wallet,
  amount,
}) {
  return {
    source_op_id,
    envelope_id,
    source_network,
    source_wallet,
    amount,
    status:       SOURCE_OP_STATUS.PENDING,
    state_before: null,  // set at applySourceFreeze()
    state_after:  null,  // set at applySourceFreeze()
  };
}

// ─── TargetSettlement (§2.7) ──────────────────────────────────────────────────
function createTargetSettlement({
  settlement_id,
  envelope_id,
  target_network,
  recipient_wallet,
  amount,
}) {
  return {
    settlement_id,
    envelope_id,
    target_network,
    recipient_wallet,
    amount,
    status:       SETTLEMENT_STATUS.PENDING,
    state_before: null,  // set at applyTargetUnfreeze()
    state_after:  null,  // set at applyTargetUnfreeze()
  };
}

// ─── DAppIntent (§2.8) ────────────────────────────────────────────────────────
function createDAppIntent({
  intent_id,
  connected_wallet_address,
  selected_network,
  operation_mode,
  source_mode            = null,
  user_defined_sources   = [],
  amount,
  target_network         = null,
  target_address,
  nonce,
  expires_at,            // caller sets this: Date.now() + 300_000
}) {
  return {
    intent_id,
    connected_wallet_address,
    selected_network,
    operation_mode,
    source_mode,
    user_defined_sources,
    amount,
    target_network,
    target_address,
    address_policy_status: ADDRESS_POLICY.UNKNOWN_TARGET_ADDRESS, // set by classifyTargetAddress()
    signature_status:      SIGNATURE_STATUS.UNSIGNED,
    nonce,
    expires_at,
    created_at:            Date.now(),
  };
}

// ─── EventRecord (§2.9) ───────────────────────────────────────────────────────
function createEventRecord({
  event_id,
  event_type,
  envelope_id      = null,
  observation_id   = null,
  network_id       = null,
  from_address     = null,
  to_address       = null,
  amount           = null,
  state_before     = null,
  state_after      = null,
  evidence         = null,
}) {
  return Object.freeze({  // EventRecords are immutable after creation
    event_id,
    event_type,
    envelope_id,
    observation_id,
    network_id,
    from_address,
    to_address,
    amount,
    state_before,
    state_after,
    evidence,
    created_at: Date.now(),
  });
}

// ─── InvariantSnapshot (§2.10) ───────────────────────────────────────────────
function createInvariantSnapshot({
  snapshot_id,
  phase,
  envelope_id        = null,
  active_current,
  frozen_current,
  minted_current,
  unavailable_total,
  traceability_status,
  status,
}) {
  const active_delta = active_current - CONSTANTS.A_ACTIVE_EXPECTED;
  return Object.freeze({   // InvariantSnapshots are immutable after creation
    snapshot_id,
    phase,
    envelope_id,
    active_current,
    frozen_current,
    minted_current,
    unavailable_total,
    traceability_status,
    active_delta,
    status,
    created_at: Date.now(),
  });
}

// ─── HostNetworkObservation (§3 entities) ────────────────────────────────────
function createHostNetworkObservation({
  observation_id,
  network_id,
  token_contract    = null,
  tx_hash,
  block_number      = null,
  timestamp         = null,
  from_address,
  to_address,
  amount,
  observed_event_type = 'Transfer',
}) {
  return {
    observation_id,
    network_id,
    token_contract,
    tx_hash,
    block_number,
    timestamp:    timestamp || Date.now(),
    from_address,
    to_address,
    amount,
    observed_event_type,
    classified:   false,
    reconciled:   false,
  };
}

module.exports = {
  createMasterState,
  createNetworkState,
  createTreasuryState,
  createWalletBalance,
  createTokenStateLocation,
  createOperationEnvelope,
  createSourceOperation,
  createTargetSettlement,
  createDAppIntent,
  createEventRecord,
  createInvariantSnapshot,
  createHostNetworkObservation,
};
