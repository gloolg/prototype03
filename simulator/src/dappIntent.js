'use strict';

// ─── DAppIntent (§5.4 Simulator Spec v1.0) ────────────────────────────────────
// createDAppIntent()                         — creates intent record
// validateDAppIntent()                       — validates before envelope creation
// classifyTargetAddress()                    — returns address policy status
// rejectUnknownRegistryAddressBeforeSignature() — rejects before signature

const {
  CONSTANTS,
  NETWORK_IDS,
  OPERATION_MODE,
  SOURCE_MODE,
  ADDRESS_POLICY,
  SIGNATURE_STATUS,
  EVENT_TYPE,
  REASON_CODE,
} = require('./constants');

const { generateIntentId, generateEventId } = require('./idGenerator');
const { createDAppIntent: _createDAppIntentRecord, createEventRecord } = require('./stateFactory');
const { assertActive } = require('./invariants');

const INTENT_EXPIRY_MS = 300_000; // 5 minutes

// ─── classifyTargetAddress ────────────────────────────────────────────────────
// Returns address policy classification for a given address on a given network.
function classifyTargetAddress(state, network_id, address) {
  const key    = `${network_id}:${address}`;
  const wallet = state.wallets[key];

  if (!wallet) return ADDRESS_POLICY.UNKNOWN_TARGET_ADDRESS;
  if (wallet.is_predefined_tester_address) return ADDRESS_POLICY.TESTER_WALLET;
  if (wallet.is_cold_wallet)               return ADDRESS_POLICY.COLD_WALLET;
  if (wallet.is_external_registered)       return ADDRESS_POLICY.EXTERNAL_REGISTERED;

  return ADDRESS_POLICY.UNKNOWN_TARGET_ADDRESS;
}

// ─── createDAppIntent ─────────────────────────────────────────────────────────
// Creates a DAppIntent record. Does NOT validate yet.
// Returns { ok, intent }
function createDAppIntent(state, input) {
  const active_check = assertActive(state);
  if (!active_check.ok) return { ok: false, reason: active_check.reason };

  const {
    connected_wallet_address,
    selected_network,
    operation_mode,
    source_mode            = null,
    user_defined_sources   = [],
    amount,
    target_network         = null,
    target_address,
  } = input;

  // Compute per-wallet nonce: count existing intents for this wallet
  const nonce = Object.values(state.dapp_intents)
    .filter(i => i.connected_wallet_address === connected_wallet_address)
    .length + 1;

  const intent = _createDAppIntentRecord({
    intent_id:               generateIntentId(),
    connected_wallet_address,
    selected_network,
    operation_mode,
    source_mode,
    user_defined_sources,
    amount,
    target_network,
    target_address,
    nonce,
    expires_at: Date.now() + INTENT_EXPIRY_MS,
  });

  // Classify target address immediately
  if (target_address && target_network) {
    intent.address_policy_status = classifyTargetAddress(state, target_network, target_address);
  }

  state.dapp_intents[intent.intent_id] = intent;

  // Record DAPP_INTENT_CREATED
  const evt = createEventRecord({
    event_id:   generateEventId(),
    event_type: EVENT_TYPE.DAPP_INTENT_CREATED,
    network_id: selected_network,
    amount,
    evidence:   `intent_${intent.intent_id}_mode=${operation_mode}`,
  });
  state.events.push(evt);

  return { ok: true, intent };
}

// ─── validateDAppIntent ───────────────────────────────────────────────────────
// Full validation before creating OperationEnvelope.
// Returns { ok, reason?, intent }
function validateDAppIntent(state, intent) {
  // 1. Intent must not be expired
  if (Date.now() > intent.expires_at) {
    return { ok: false, reason: REASON_CODE.INTENT_EXPIRED, intent };
  }

  // 2. Wallet must be known in selected_network
  const wallet_key = `${intent.selected_network}:${intent.connected_wallet_address}`;
  const wallet     = state.wallets[wallet_key];
  if (!wallet || !wallet.is_predefined_tester_address) {
    return { ok: false, reason: REASON_CODE.UNKNOWN_SENDER_WALLET, wallet_key };
  }

  // 3. selected_network must exist
  if (!NETWORK_IDS.includes(intent.selected_network)) {
    return { ok: false, reason: REASON_CODE.INVALID_SOURCE_NETWORK, network_id: intent.selected_network };
  }

  // 4. Amount must be positive integer
  if (!Number.isInteger(intent.amount) || intent.amount <= 0) {
    return { ok: false, reason: REASON_CODE.INVALID_AMOUNT, amount: intent.amount };
  }

  // 5. operation_mode must be valid
  if (!Object.values(OPERATION_MODE).includes(intent.operation_mode)) {
    return { ok: false, reason: 'INVALID_OPERATION_MODE', operation_mode: intent.operation_mode };
  }

  // 6. Target address policy check
  const policy = classifyTargetAddress(state, intent.target_network || intent.selected_network, intent.target_address);
  intent.address_policy_status = policy;

  // For DIRECT_HOST_NETWORK_VIA_DAPP: unknown address = reject before signature
  if (
    intent.operation_mode === OPERATION_MODE.DIRECT_HOST_NETWORK_VIA_DAPP &&
    policy === ADDRESS_POLICY.UNKNOWN_TARGET_ADDRESS
  ) {
    return rejectUnknownRegistryAddressBeforeSignature(state, intent);
  }

  // For THROUGH_METAREGISTRY: also reject unknown recipient
  if (
    intent.operation_mode === OPERATION_MODE.THROUGH_METAREGISTRY &&
    policy === ADDRESS_POLICY.UNKNOWN_TARGET_ADDRESS
  ) {
    return rejectUnknownRegistryAddressBeforeSignature(state, intent);
  }

  // 7. source_mode validation for USER_DEFINED
  if (
    intent.operation_mode === OPERATION_MODE.THROUGH_METAREGISTRY &&
    intent.source_mode === SOURCE_MODE.USER_DEFINED
  ) {
    if (!Array.isArray(intent.user_defined_sources) || intent.user_defined_sources.length === 0) {
      return { ok: false, reason: REASON_CODE.SOURCE_SUM_MISMATCH, note: 'USER_DEFINED requires user_defined_sources' };
    }
    const sum = intent.user_defined_sources.reduce((acc, s) => acc + (s.amount || 0), 0);
    if (sum !== intent.amount) {
      return { ok: false, reason: REASON_CODE.SOURCE_SUM_MISMATCH, declared_sum: sum, expected: intent.amount };
    }
  }

  return { ok: true, intent };
}

// ─── rejectUnknownRegistryAddressBeforeSignature ──────────────────────────────
// Called when DApp detects unknown target address before signature.
// No state mutation. Records DAPP_PRE_VALIDATION_REJECTED event.
// Returns { ok: false, reason, intent }
function rejectUnknownRegistryAddressBeforeSignature(state, intent) {
  const evt = createEventRecord({
    event_id:   generateEventId(),
    event_type: EVENT_TYPE.DAPP_PRE_VALIDATION_REJECTED,
    network_id: intent.selected_network,
    to_address: intent.target_address,
    amount:     intent.amount,
    evidence:   `rejected_unknown_address_${intent.target_address}_intent=${intent.intent_id}`,
  });
  state.events.push(evt);

  return {
    ok:           false,
    reason:       REASON_CODE.UNKNOWN_REGISTRY_ADDRESS,
    target_address: intent.target_address,
    event_id:     evt.event_id,
    intent,
  };
}

module.exports = {
  createDAppIntent,
  validateDAppIntent,
  classifyTargetAddress,
  rejectUnknownRegistryAddressBeforeSignature,
};
