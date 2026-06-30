'use strict';

// ─── Fixed constants (§1 Simulator Spec v1.0) ────────────────────────────────
// These values are immutable. Never override in runtime code.

const CONSTANTS = {
  TOKEN:                        'tEQUI',
  DECIMALS:                     18,
  MIN_UNIT:                     1,

  NETWORK_COUNT:                4,
  MINTED_PER_NETWORK:           100_000,
  TOTAL_MINTED_EXPECTED:        400_000,
  A_ACTIVE_EXPECTED:            100_000,
  TOTAL_FROZEN_EXPECTED:        300_000,

  // Starting partition per network (logical, set at genesis by MetaRegistry)
  STARTING_IT_ACTIVE_PER_NETWORK:  25_000,
  STARTING_IT_FROZEN_PER_NETWORK:  75_000,

  // 60/40 rule — enforced at applyTreasuryDistribution(), not at genesis
  MAX_WALLET_ACTIVE_STARTING:   60_000,
  MIN_IT_ACTIVE_STARTING:       40_000,

  UNAVAILABLE_STARTING:         0,
};

// ─── Network registry (§1.1) ──────────────────────────────────────────────────
// Priority order = AUTOMATIC source resolution order
const NETWORKS = [
  { network_id: 'A', network_name: 'Ethereum Sepolia',       priority: 1, it_id: 'IT-A' },
  { network_id: 'B', network_name: 'BNB Smart Chain Testnet', priority: 2, it_id: 'IT-B' },
  { network_id: 'C', network_name: 'Polygon PoS Amoy',       priority: 3, it_id: 'IT-C' },
  { network_id: 'D', network_name: 'Arbitrum Sepolia',       priority: 4, it_id: 'IT-D' },
];

const NETWORK_IDS = NETWORKS.map(n => n.network_id); // ['A','B','C','D']

// ─── Operation types ──────────────────────────────────────────────────────────
const OPERATION_TYPE = {
  GENESIS_INITIALIZATION:             'GENESIS_INITIALIZATION',
  TREASURY_DISTRIBUTION:              'TREASURY_DISTRIBUTION',
  CROSS_NETWORK_TRANSFER:             'CROSS_NETWORK_TRANSFER',
  SAME_NETWORK_THROUGH_METAREGISTRY:  'SAME_NETWORK_THROUGH_METAREGISTRY',
};

// ─── Envelope statuses (§4) ───────────────────────────────────────────────────
const ENVELOPE_STATUS = {
  CREATED:                    'CREATED',
  VALIDATING:                 'VALIDATING',
  READY_TO_APPLY:             'READY_TO_APPLY',
  SOURCE_FREEZE_APPLIED:      'SOURCE_FREEZE_APPLIED',
  TEMP_ACTIVE_DELTA_RECORDED: 'TEMP_ACTIVE_DELTA_RECORDED',
  TARGET_UNFREEZE_APPLIED:    'TARGET_UNFREEZE_APPLIED',
  INVARIANT_CHECKING:         'INVARIANT_CHECKING',
  COMPLETED:                  'COMPLETED',
  REJECTED:                   'REJECTED',
  INVALIDATED:                'INVALIDATED',
  STOP:                       'STOP',
};

// ─── Source operation statuses ────────────────────────────────────────────────
const SOURCE_OP_STATUS = {
  PENDING:        'PENDING',
  FREEZE_APPLIED: 'FREEZE_APPLIED',
  COMPLETED:      'COMPLETED',
  FAILED:         'FAILED',
};

// ─── Settlement statuses ──────────────────────────────────────────────────────
const SETTLEMENT_STATUS = {
  PENDING:          'PENDING',
  UNFREEZE_APPLIED: 'UNFREEZE_APPLIED',
  COMPLETED:        'COMPLETED',
  FAILED:           'FAILED',
};

// ─── Source modes ─────────────────────────────────────────────────────────────
const SOURCE_MODE = {
  AUTOMATIC:    'AUTOMATIC',
  USER_DEFINED: 'USER_DEFINED',
};

// ─── Operation modes (DAppIntent) ────────────────────────────────────────────
const OPERATION_MODE = {
  THROUGH_METAREGISTRY:         'THROUGH_METAREGISTRY',
  DIRECT_HOST_NETWORK_VIA_DAPP: 'DIRECT_HOST_NETWORK_VIA_DAPP',
};

// ─── Address policy statuses ──────────────────────────────────────────────────
const ADDRESS_POLICY = {
  TESTER_WALLET:           'tester_wallet',
  COLD_WALLET:             'cold_wallet',
  EXTERNAL_REGISTERED:     'external_registered',
  UNKNOWN_TARGET_ADDRESS:  'unknown_target_address',
};

// ─── Signature statuses ───────────────────────────────────────────────────────
const SIGNATURE_STATUS = {
  UNSIGNED:  'unsigned',
  SIGNED:    'signed',
  SUBMITTED: 'submitted',
  OBSERVED:  'observed',
};

// ─── Token state location statuses ───────────────────────────────────────────
const TOKEN_STATUS = {
  ACTIVE:      'active',
  FROZEN:      'frozen',
  UNAVAILABLE: 'UNAVAILABLE',
};

// ─── Execution paths ──────────────────────────────────────────────────────────
const EXECUTION_PATH = {
  THROUGH_METAREGISTRY:               'through_metaregistry',
  OUTSIDE_EXECUTION_PATH_BUT_OBSERVED: 'outside_execution_path_but_observed',
};

// ─── Reconciliation statuses ──────────────────────────────────────────────────
const RECONCILIATION_STATUS = {
  RECORDED:               'recorded',
  RECONCILIATION_REQUIRED: 'reconciliation_required',
  STOP:                   'stop',
};

// ─── Rejection / STOP reason codes (§6) ──────────────────────────────────────
const REASON_CODE = {
  INVALID_AMOUNT:               'INVALID_AMOUNT',
  UNKNOWN_SENDER_WALLET:        'UNKNOWN_SENDER_WALLET',
  UNKNOWN_RECIPIENT_WALLET:     'UNKNOWN_RECIPIENT_WALLET',
  INVALID_SOURCE_NETWORK:       'INVALID_SOURCE_NETWORK',
  INVALID_TARGET_NETWORK:       'INVALID_TARGET_NETWORK',
  INSUFFICIENT_SOURCE_BALANCE:  'INSUFFICIENT_SOURCE_BALANCE',
  INSUFFICIENT_TARGET_FROZEN:   'INSUFFICIENT_TARGET_FROZEN',
  SOURCE_SUM_MISMATCH:          'SOURCE_SUM_MISMATCH',
  NEGATIVE_BALANCE_RISK:        'NEGATIVE_BALANCE_RISK',
  INTENT_EXPIRED:               'INTENT_EXPIRED',
  UNKNOWN_REGISTRY_ADDRESS:     'UNKNOWN_REGISTRY_ADDRESS',
  POSITIVE_ACTIVE_DELTA:        'POSITIVE_ACTIVE_DELTA',
  TRACEABILITY_FAILURE:         'TRACEABILITY_FAILURE',
  INVARIANT_FAILURE:            'INVARIANT_FAILURE',
  GENESIS_NOT_COMPLETED:        'GENESIS_NOT_COMPLETED',
  SYSTEM_STOP:                  'SYSTEM_STOP',
  WALLET_ACTIVE_CAP_EXCEEDED:   'WALLET_ACTIVE_CAP_EXCEEDED',
  IT_ACTIVE_BELOW_MINIMUM:      'IT_ACTIVE_BELOW_MINIMUM',
};

// ─── Event types (§7) ─────────────────────────────────────────────────────────
const EVENT_TYPE = {
  GENESIS_MINT:                     'GENESIS_MINT',
  GENESIS_TREASURY_CAPTURE:         'GENESIS_TREASURY_CAPTURE',
  TREASURY_DISTRIBUTION_APPLIED:    'TREASURY_DISTRIBUTION_APPLIED',
  ENVELOPE_CREATED:                 'ENVELOPE_CREATED',
  PRE_VALIDATION_OK:                'PRE_VALIDATION_OK',
  PRE_VALIDATION_REJECTED:          'PRE_VALIDATION_REJECTED',
  SOURCE_FREEZE_APPLIED:            'SOURCE_FREEZE_APPLIED',
  TEMP_ACTIVE_DELTA_RECORDED:       'TEMP_ACTIVE_DELTA_RECORDED',
  TARGET_UNFREEZE_APPLIED:          'TARGET_UNFREEZE_APPLIED',
  INVARIANT_SNAPSHOT:               'INVARIANT_SNAPSHOT',
  OPERATION_COMPLETED:              'OPERATION_COMPLETED',
  HOST_TRANSFER_OBSERVED:           'HOST_TRANSFER_OBSERVED',
  EXTERNAL_TRANSFER_RECONCILED:     'EXTERNAL_TRANSFER_RECONCILED',
  OUTSIDE_DAPP_TRANSFER_OBSERVED:   'OUTSIDE_DAPP_TRANSFER_OBSERVED',
  UNAVAILABLE_STATE_APPLIED:        'UNAVAILABLE_STATE_APPLIED',
  DAPP_INTENT_CREATED:              'DAPP_INTENT_CREATED',
  DAPP_PRE_VALIDATION_REJECTED:     'DAPP_PRE_VALIDATION_REJECTED',
  DAPP_DIRECT_HOST_TX_SUBMITTED:    'DAPP_DIRECT_HOST_TX_SUBMITTED',
  STOP_TRIGGERED:                   'STOP_TRIGGERED',
};

// ─── InvariantSnapshot phases (§2.10) ────────────────────────────────────────
const SNAPSHOT_PHASE = {
  PRE_OPERATION:         'pre_operation',
  POST_SOURCE_FREEZE:    'post_source_freeze',
  POST_TARGET_UNFREEZE:  'post_target_unfreeze',
  POST_COMPLETION:       'post_completion',
  POST_OBSERVATION:      'post_observation',
};

// ─── Global system status ─────────────────────────────────────────────────────
const SYSTEM_STATUS = {
  UNINITIALIZED: 'UNINITIALIZED',
  ACTIVE:        'ACTIVE',
  STOP:          'STOP',
};

// ─── InvariantSnapshot statuses ──────────────────────────────────────────────
const SNAPSHOT_STATUS = {
  OK:           'ok',
  TRANSITIONAL: 'transitional',
  STOP:         'stop',
};

module.exports = {
  CONSTANTS,
  NETWORKS,
  NETWORK_IDS,
  OPERATION_TYPE,
  ENVELOPE_STATUS,
  SOURCE_OP_STATUS,
  SETTLEMENT_STATUS,
  SOURCE_MODE,
  OPERATION_MODE,
  ADDRESS_POLICY,
  SIGNATURE_STATUS,
  TOKEN_STATUS,
  EXECUTION_PATH,
  RECONCILIATION_STATUS,
  REASON_CODE,
  EVENT_TYPE,
  SNAPSHOT_PHASE,
  SYSTEM_STATUS,
  SNAPSHOT_STATUS,
};
