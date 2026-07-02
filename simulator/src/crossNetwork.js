'use strict';

// ─── Cross-Network and Same-Network Operations (§5.6, §5.7, §5.8) ────────────
// createEnvelopeFromIntent()           — builds OperationEnvelope
// validatePackage()                    — pre-apply validation
// applySourceFreeze()                  — per SourceOperation
// recordTemporaryDelta()               — InvariantSnapshot after all freezes
// applyTargetUnfreeze()                — TargetSettlement
// completeEnvelope()                   — final check + COMPLETED
// applySameNetworkThroughMetaRegistry()— simplified path, no freeze/unfreeze

const {
  CONSTANTS,
  OPERATION_TYPE,
  ENVELOPE_STATUS,
  SOURCE_OP_STATUS,
  SETTLEMENT_STATUS,
  EVENT_TYPE,
  SNAPSHOT_PHASE,
  SNAPSHOT_STATUS,
  REASON_CODE,
  TOKEN_STATUS,
  EXECUTION_PATH,
  RECONCILIATION_STATUS,
} = require('./constants');

const { generateEnvelopeId, generateSettlementId, generateEventId } = require('./idGenerator');
const { createOperationEnvelope, createTargetSettlement, createEventRecord } = require('./stateFactory');
const {
  checkInvariants,
  checkTraceability,
  triggerStop,
  assertActive,
  computeTotals,
} = require('./invariants');

// ─── createEnvelopeFromIntent ─────────────────────────────────────────────────
// Builds OperationEnvelope + TargetSettlement from resolved sources and intent.
// Registers SourceOperations in state.source_operations.
// Returns { ok, envelope, settlement }

function createEnvelopeFromIntent(state, {
  operation_type,
  source_mode,
  amount,
  sender,
  recipient,
  target_network,
  dapp_intent_id = null,
  sources,        // SourceOperation[] from resolveAutomaticSources / resolveUserDefinedSources
}) {
  const active_check = assertActive(state);
  if (!active_check.ok) return { ok: false, reason: active_check.reason };

  const envelope_id = generateEnvelopeId();

  const envelope = createOperationEnvelope({
    envelope_id,
    operation_type,
    source_mode,
    amount,
    sender,
    recipient,
    target_network,
    dapp_intent_id,
  });

  // Register source operations in state + link to envelope
  for (const src of sources) {
    src.envelope_id = envelope_id;
    state.source_operations[src.source_op_id] = src;
    envelope.source_operation_ids.push(src.source_op_id);
  }

  // Create TargetSettlement
  const settlement = createTargetSettlement({
    settlement_id:    generateSettlementId(),
    envelope_id,
    target_network,
    recipient_wallet: recipient,
    amount,
  });
  envelope.settlement_id = settlement.settlement_id;
  state.settlements[settlement.settlement_id] = settlement;

  // Register envelope in state
  state.envelopes[envelope_id] = envelope;

  // Append ENVELOPE_CREATED event
  const evt = createEventRecord({
    event_id:   generateEventId(),
    event_type: EVENT_TYPE.ENVELOPE_CREATED,
    envelope_id,
    network_id: target_network,
    amount,
    evidence:   `envelope_created_${envelope_id}`,
  });
  state.events.push(evt);

  return { ok: true, envelope, settlement };
}

// ─── validatePackage ──────────────────────────────────────────────────────────
// Full pre-apply validation. Does NOT mutate balances.
// Sets envelope.status = READY_TO_APPLY or REJECTED.
// Returns { ok, violations[] }

function validatePackage(state, envelope) {
  const violations = [];
  envelope.status = ENVELOPE_STATUS.VALIDATING;

  const { amount, sender, recipient, target_network, source_operation_ids, settlement_id } = envelope;

  // 1. Amount integrity
  if (!Number.isInteger(amount) || amount <= 0) {
    violations.push({ code: REASON_CODE.INVALID_AMOUNT, amount });
  }

  // 2. Target network must exist
  const target_net = state.networks[target_network];
  if (!target_net) {
    violations.push({ code: REASON_CODE.INVALID_TARGET_NETWORK, target_network });
  }

  // 3. Validate each SourceOperation
  let source_total = 0;
  for (const src_id of source_operation_ids) {
    const src = state.source_operations[src_id];
    if (!src) {
      violations.push({ code: REASON_CODE.INVALID_SOURCE_NETWORK, src_id, note: 'SourceOperation not found' });
      continue;
    }

    // Source network must exist
    const src_net = state.networks[src.source_network];
    if (!src_net) {
      violations.push({ code: REASON_CODE.INVALID_SOURCE_NETWORK, network_id: src.source_network });
      continue;
    }

    // Sender wallet must exist and be tester
    const wallet_key = `${src.source_network}:${src.source_wallet}`;
    const wallet = state.wallets[wallet_key];
    if (!wallet || !wallet.is_predefined_tester_address) {
      violations.push({ code: REASON_CODE.UNKNOWN_SENDER_WALLET, wallet_key });
      continue;
    }

    // Sender balance must cover this source amount
    if (wallet.wallet_active < src.amount) {
      violations.push({
        code:      REASON_CODE.INSUFFICIENT_SOURCE_BALANCE,
        network_id: src.source_network,
        available:  wallet.wallet_active,
        requested:  src.amount,
      });
    }

    // No negative balance after freeze
    if (wallet.wallet_active - src.amount < 0) {
      violations.push({ code: REASON_CODE.NEGATIVE_BALANCE_RISK, wallet_key, amount: src.amount });
    }

    source_total += src.amount;
  }

  // 4. Source amounts must sum to envelope amount
  if (source_total !== amount) {
    violations.push({
      code:         REASON_CODE.SOURCE_SUM_MISMATCH,
      source_total,
      expected:     amount,
    });
  }

  // 5. Target IT_FROZEN must cover settlement
  const settlement = state.settlements[settlement_id];
  if (target_net && settlement) {
    if (target_net.IT_FROZEN < amount) {
      violations.push({
        code:                REASON_CODE.INSUFFICIENT_TARGET_FROZEN,
        target_network,
        IT_FROZEN_available: target_net.IT_FROZEN,
        requested:           amount,
      });
    }
    // No negative IT_FROZEN after unfreeze
    if (target_net && target_net.IT_FROZEN - amount < 0) {
      violations.push({ code: REASON_CODE.NEGATIVE_BALANCE_RISK, note: 'target IT_FROZEN would go negative' });
    }
  }

  // 6. Recipient must be known wallet
  const recipient_key = `${target_network}:${recipient}`;
  const recipient_wallet = state.wallets[recipient_key];
  if (!recipient_wallet || !recipient_wallet.is_predefined_tester_address) {
    violations.push({ code: REASON_CODE.UNKNOWN_RECIPIENT_WALLET, recipient_key });
  }

  // ── Set envelope status ────────────────────────────────────────────────────
  if (violations.length > 0) {
    envelope.status = ENVELOPE_STATUS.REJECTED;
    const evt = createEventRecord({
      event_id:   generateEventId(),
      event_type: EVENT_TYPE.PRE_VALIDATION_REJECTED,
      envelope_id: envelope.envelope_id,
      amount,
      evidence:   violations.map(v => v.code).join(','),
    });
    state.events.push(evt);
    return { ok: false, violations };
  }

  envelope.status = ENVELOPE_STATUS.READY_TO_APPLY;
  const evt = createEventRecord({
    event_id:   generateEventId(),
    event_type: EVENT_TYPE.PRE_VALIDATION_OK,
    envelope_id: envelope.envelope_id,
    amount,
  });
  state.events.push(evt);
  return { ok: true, violations: [] };
}

// ─── applySourceFreeze ────────────────────────────────────────────────────────
// Applies ONE SourceOperation freeze.
// wallet_active -amount; IT_FROZEN +amount.
// Returns { ok, event_id }

function applySourceFreeze(state, source_op) {
  const active_check = assertActive(state);
  if (!active_check.ok) return { ok: false, reason: active_check.reason };

  const { source_network, source_wallet, amount, source_op_id } = source_op;
  const net      = state.networks[source_network];
  const treasury = state.treasuries[source_network];
  const wallet   = state.wallets[`${source_network}:${source_wallet}`];

  if (!net || !treasury || !wallet) {
    return { ok: false, reason: REASON_CODE.INVALID_SOURCE_NETWORK, source_network };
  }

  // Safety check
  if (wallet.wallet_active < amount) {
    return { ok: false, reason: REASON_CODE.INSUFFICIENT_SOURCE_BALANCE, available: wallet.wallet_active, requested: amount };
  }

  const state_before = {
    source_network,
    wallet_active: wallet.wallet_active,
    IT_FROZEN:     net.IT_FROZEN,
    A_ACTIVE:      computeTotals(state).a_active_current,
  };

  // Apply: wallet_active -amount, IT_FROZEN +amount
  // NetworkState and TreasuryState must be updated together
  wallet.wallet_active         -= amount;
  net.wallet_active_total      -= amount;
  net.IT_FROZEN                += amount;
  treasury.IT_FROZEN           += amount;
  wallet.last_seen_at           = Date.now();

  const state_after = {
    source_network,
    wallet_active: wallet.wallet_active,
    IT_FROZEN:     net.IT_FROZEN,
    A_ACTIVE:      computeTotals(state).a_active_current,
  };

  source_op.status      = SOURCE_OP_STATUS.FREEZE_APPLIED;
  source_op.state_before = state_before;
  source_op.state_after  = state_after;

  const evt = createEventRecord({
    event_id:     generateEventId(),
    event_type:   EVENT_TYPE.SOURCE_FREEZE_APPLIED,
    envelope_id:  source_op.envelope_id,
    network_id:   source_network,
    from_address: source_wallet,
    amount,
    state_before,
    state_after,
    evidence:     `freeze_${source_op_id}`,
  });
  state.events.push(evt);

  return { ok: true, event_id: evt.event_id, state_after };
}

// ─── recordTemporaryDelta ─────────────────────────────────────────────────────
// Records InvariantSnapshot after all source freezes.
// active_delta must be negative (or zero for same-amount operations).
// Triggers STOP if positive delta detected.
// Returns { ok, snapshot }

function recordTemporaryDelta(state, envelope) {
  const inv = checkInvariants(state, SNAPSHOT_PHASE.POST_SOURCE_FREEZE);
  envelope.status = ENVELOPE_STATUS.TEMP_ACTIVE_DELTA_RECORDED;

  // Check for forbidden positive delta
  const positive_violation = inv.violations.find(v => v.code === REASON_CODE.POSITIVE_ACTIVE_DELTA);
  if (positive_violation) {
    triggerStop(state, REASON_CODE.POSITIVE_ACTIVE_DELTA);
    return { ok: false, reason: REASON_CODE.POSITIVE_ACTIVE_DELTA, snapshot: inv.snapshot };
  }

  const evt = createEventRecord({
    event_id:    generateEventId(),
    event_type:  EVENT_TYPE.TEMP_ACTIVE_DELTA_RECORDED,
    envelope_id: envelope.envelope_id,
    amount:      envelope.amount,
    evidence:    `delta=${inv.snapshot.active_delta}`,
  });
  state.events.push(evt);

  return { ok: true, snapshot: inv.snapshot };
}

// ─── applyTargetUnfreeze ──────────────────────────────────────────────────────
// Applies TargetSettlement: IT_FROZEN -amount, recipient wallet_active +amount.
// Returns { ok, event_id }

function applyTargetUnfreeze(state, settlement) {
  const active_check = assertActive(state);
  if (!active_check.ok) return { ok: false, reason: active_check.reason };

  const { target_network, recipient_wallet, amount, settlement_id } = settlement;
  const net         = state.networks[target_network];
  const treasury    = state.treasuries[target_network];
  const wallet_key  = `${target_network}:${recipient_wallet}`;
  const wallet      = state.wallets[wallet_key];

  if (!net || !treasury) {
    return { ok: false, reason: REASON_CODE.INVALID_TARGET_NETWORK, target_network };
  }
  if (!wallet) {
    return { ok: false, reason: REASON_CODE.UNKNOWN_RECIPIENT_WALLET, wallet_key };
  }
  if (net.IT_FROZEN < amount) {
    return { ok: false, reason: REASON_CODE.INSUFFICIENT_TARGET_FROZEN, available: net.IT_FROZEN, requested: amount };
  }

  const state_before = {
    target_network,
    IT_FROZEN:     net.IT_FROZEN,
    wallet_active: wallet.wallet_active,
    A_ACTIVE:      computeTotals(state).a_active_current,
  };

  // Apply: IT_FROZEN -amount, wallet_active +amount
  net.IT_FROZEN                -= amount;
  treasury.IT_FROZEN           -= amount;
  wallet.wallet_active         += amount;
  net.wallet_active_total      += amount;
  wallet.last_seen_at           = Date.now();

  const state_after = {
    target_network,
    IT_FROZEN:     net.IT_FROZEN,
    wallet_active: wallet.wallet_active,
    A_ACTIVE:      computeTotals(state).a_active_current,
  };

  settlement.status      = SETTLEMENT_STATUS.UNFREEZE_APPLIED;
  settlement.state_before = state_before;
  settlement.state_after  = state_after;

  const evt = createEventRecord({
    event_id:    generateEventId(),
    event_type:  EVENT_TYPE.TARGET_UNFREEZE_APPLIED,
    envelope_id: settlement.envelope_id,
    network_id:  target_network,
    to_address:  recipient_wallet,
    amount,
    state_before,
    state_after,
    evidence:    `unfreeze_${settlement_id}`,
  });
  state.events.push(evt);

  return { ok: true, event_id: evt.event_id, state_after };
}

// ─── completeEnvelope ─────────────────────────────────────────────────────────
// Final invariant + traceability check. Sets envelope to COMPLETED or INVALIDATED.
// Returns { ok, snapshot }

function completeEnvelope(state, envelope) {
  envelope.status = ENVELOPE_STATUS.INVARIANT_CHECKING;

  const inv = checkInvariants(state, SNAPSHOT_PHASE.POST_COMPLETION);
  const trace = checkTraceability(state);

  if (!inv.ok || !trace.ok) {
    envelope.status = ENVELOPE_STATUS.INVALIDATED;
    const reason = !inv.ok ? REASON_CODE.INVARIANT_FAILURE : REASON_CODE.TRACEABILITY_FAILURE;
    triggerStop(state, reason);
    return { ok: false, reason, snapshot: inv.snapshot };
  }

  envelope.status       = ENVELOPE_STATUS.COMPLETED;
  envelope.completed_at = Date.now();

  // Mark settlement completed
  const settlement = state.settlements[envelope.settlement_id];
  if (settlement) settlement.status = SETTLEMENT_STATUS.COMPLETED;

  // Mark source operations completed
  for (const src_id of envelope.source_operation_ids) {
    const src = state.source_operations[src_id];
    if (src) src.status = SOURCE_OP_STATUS.COMPLETED;
  }

  const evt = createEventRecord({
    event_id:    generateEventId(),
    event_type:  EVENT_TYPE.OPERATION_COMPLETED,
    envelope_id: envelope.envelope_id,
    amount:      envelope.amount,
    evidence:    `completed_${envelope.envelope_id}`,
  });
  state.events.push(evt);

  return { ok: true, snapshot: inv.snapshot };
}

// ─── applySameNetworkThroughMetaRegistry ──────────────────────────────────────
// Simplified lifecycle: no freeze/unfreeze.
// sender wallet_active -amount, recipient wallet_active +amount, same network.
// Returns { ok, event_id }

function applySameNetworkThroughMetaRegistry(state, {
  network_id,
  sender_address,
  recipient_address,
  amount,
  dapp_intent_id = null,
}) {
  const active_check = assertActive(state);
  if (!active_check.ok) return { ok: false, reason: active_check.reason };

  // Validate amount
  if (!Number.isInteger(amount) || amount <= 0) {
    return { ok: false, reason: REASON_CODE.INVALID_AMOUNT, amount };
  }

  // Network must exist
  const net = state.networks[network_id];
  if (!net) return { ok: false, reason: REASON_CODE.INVALID_SOURCE_NETWORK, network_id };

  // Block same-network self-transfer. Without this guard, sender and recipient
  // resolve to the SAME wallet object below (identical network_id:address key),
  // so `wallet_active -= amount` followed by `wallet_active += amount` cancels
  // out silently — the function would return ok:true and log a full
  // OPERATION_COMPLETED event for an operation that moved zero balance.
  // /entry and /entry/multi/create already guard this at the route layer;
  // this mirrors that guard here so the simulator function is safe on its
  // own for any caller (e.g. POST /transfer, which has no such check).
  if (sender_address.toLowerCase() === recipient_address.toLowerCase()) {
    return { ok: false, reason: REASON_CODE.SELF_TRANSFER_NOT_ALLOWED, network_id, address: sender_address };
  }

  // Sender wallet
  const sender_key = `${network_id}:${sender_address}`;
  const sender = state.wallets[sender_key];
  if (!sender || !sender.is_predefined_tester_address) {
    return { ok: false, reason: REASON_CODE.UNKNOWN_SENDER_WALLET, sender_key };
  }
  if (sender.wallet_active < amount) {
    return { ok: false, reason: REASON_CODE.INSUFFICIENT_SOURCE_BALANCE, available: sender.wallet_active, requested: amount };
  }

  // Recipient wallet
  const recipient_key = `${network_id}:${recipient_address}`;
  const recipient = state.wallets[recipient_key];
  if (!recipient || !recipient.is_predefined_tester_address) {
    return { ok: false, reason: REASON_CODE.UNKNOWN_RECIPIENT_WALLET, recipient_key };
  }

  // Build envelope (simplified — no sources/settlement)
  const envelope_id = generateEnvelopeId();
  const envelope = createOperationEnvelope({
    envelope_id,
    operation_type: OPERATION_TYPE.SAME_NETWORK_THROUGH_METAREGISTRY,
    source_mode:    null,
    amount,
    sender:         sender_address,
    recipient:      recipient_address,
    target_network: network_id,
    dapp_intent_id,
  });
  state.envelopes[envelope_id] = envelope;

  // PRE_VALIDATION_OK
  envelope.status = ENVELOPE_STATUS.READY_TO_APPLY;
  state.events.push(createEventRecord({
    event_id:    generateEventId(),
    event_type:  EVENT_TYPE.PRE_VALIDATION_OK,
    envelope_id,
    amount,
  }));

  // Apply: sender -amount, recipient +amount, same network totals unchanged
  const state_before = {
    sender_active:    sender.wallet_active,
    recipient_active: recipient.wallet_active,
    A_ACTIVE:         computeTotals(state).a_active_current,
  };

  sender.wallet_active    -= amount;
  recipient.wallet_active += amount;
  sender.last_seen_at      = Date.now();
  recipient.last_seen_at   = Date.now();
  // wallet_active_total unchanged (same network, -X +X = 0)

  const state_after = {
    sender_active:    sender.wallet_active,
    recipient_active: recipient.wallet_active,
    A_ACTIVE:         computeTotals(state).a_active_current,
  };

  // INVARIANT_CHECKING
  envelope.status = ENVELOPE_STATUS.INVARIANT_CHECKING;
  const inv = checkInvariants(state, SNAPSHOT_PHASE.POST_COMPLETION);
  const trace = checkTraceability(state);

  if (!inv.ok || !trace.ok) {
    envelope.status = ENVELOPE_STATUS.INVALIDATED;
    triggerStop(state, REASON_CODE.INVARIANT_FAILURE);
    return { ok: false, reason: REASON_CODE.INVARIANT_FAILURE };
  }

  envelope.status       = ENVELOPE_STATUS.COMPLETED;
  envelope.completed_at = Date.now();

  const evt = createEventRecord({
    event_id:     generateEventId(),
    event_type:   EVENT_TYPE.OPERATION_COMPLETED,
    envelope_id,
    network_id,
    from_address: sender_address,
    to_address:   recipient_address,
    amount,
    state_before,
    state_after,
    evidence:     `same_network_${envelope_id}`,
  });
  state.events.push(evt);

  return { ok: true, event_id: evt.event_id, state_after };
}

module.exports = {
  createEnvelopeFromIntent,
  validatePackage,
  applySourceFreeze,
  recordTemporaryDelta,
  applyTargetUnfreeze,
  completeEnvelope,
  applySameNetworkThroughMetaRegistry,
};
