'use strict';

// ─── Source Resolution (§5.5 Simulator Spec v1.0) ─────────────────────────────
// resolveAutomaticSources()    — priority A→B→C→D, one sender wallet
// resolveUserDefinedSources()  — explicit per-network amounts, same sender wallet

const {
  CONSTANTS,
  NETWORKS,
  SOURCE_OP_STATUS,
  REASON_CODE,
} = require('./constants');

const { generateSourceOpId } = require('./idGenerator');
const { createSourceOperation } = require('./stateFactory');

// ─── resolveAutomaticSources ──────────────────────────────────────────────────
// Resolves source networks for a cross-network transfer automatically.
// Takes from sender_address wallet in each network by priority A→B→C→D.
// Networks where sender has wallet_active = 0 are silently skipped.
// Returns { ok, sources: SourceOperation[], reason? }

function resolveAutomaticSources(state, envelope_id, sender_address, amount, target_network) {
  if (!Number.isInteger(amount) || amount <= 0) {
    return { ok: false, reason: REASON_CODE.INVALID_AMOUNT, amount };
  }

  // Sort networks by priority (ascending)
  const ordered = [...NETWORKS].sort((a, b) => a.priority - b.priority);

  let remaining = amount;
  const sources = [];

  for (const net_def of ordered) {
    if (remaining <= 0) break;

    const net_id     = net_def.network_id;
    const wallet_key = `${net_id}:${sender_address}`;
    const wallet     = state.wallets[wallet_key];

    // Skip if wallet does not exist or has zero balance (silent skip per spec)
    if (!wallet || wallet.wallet_active <= 0) continue;

    // Also verify: target_network IT_FROZEN must be able to cover (checked globally below)
    const take = Math.min(wallet.wallet_active, remaining);

    const src_op = createSourceOperation({
      source_op_id:  generateSourceOpId(),
      envelope_id,
      source_network: net_id,
      source_wallet:  sender_address,
      amount:         take,
    });

    sources.push(src_op);
    remaining -= take;
  }

  if (remaining > 0) {
    return {
      ok:     false,
      reason: REASON_CODE.INSUFFICIENT_SOURCE_BALANCE,
      requested:  amount,
      available:  amount - remaining,
      shortfall:  remaining,
    };
  }

  // Verify target IT_FROZEN can cover the full amount
  const target_net = state.networks[target_network];
  if (!target_net) {
    return { ok: false, reason: REASON_CODE.INVALID_TARGET_NETWORK, target_network };
  }
  if (target_net.IT_FROZEN < amount) {
    return {
      ok:                 false,
      reason:             REASON_CODE.INSUFFICIENT_TARGET_FROZEN,
      target_network,
      IT_FROZEN_available: target_net.IT_FROZEN,
      requested:          amount,
    };
  }

  return { ok: true, sources };
}

// ─── resolveUserDefinedSources ────────────────────────────────────────────────
// Validates and builds SourceOperations from explicit user input.
// user_defined_sources: [{ network_id, amount }, ...]
// All amounts must use the same sender_address wallet.
// Returns { ok, sources: SourceOperation[], reason? }

function resolveUserDefinedSources(state, envelope_id, sender_address, user_defined_sources, total_amount, target_network) {
  if (!Array.isArray(user_defined_sources) || user_defined_sources.length === 0) {
    return { ok: false, reason: REASON_CODE.SOURCE_SUM_MISMATCH, note: 'No sources provided' };
  }

  if (!Number.isInteger(total_amount) || total_amount <= 0) {
    return { ok: false, reason: REASON_CODE.INVALID_AMOUNT, amount: total_amount };
  }

  // Check sum equals total_amount exactly
  const declared_sum = user_defined_sources.reduce((acc, s) => acc + (s.amount || 0), 0);
  if (declared_sum !== total_amount) {
    return {
      ok:            false,
      reason:        REASON_CODE.SOURCE_SUM_MISMATCH,
      declared_sum,
      expected_sum:  total_amount,
    };
  }

  const sources = [];

  for (const src of user_defined_sources) {
    const { network_id, amount } = src;

    // Each amount must be a positive integer
    if (!Number.isInteger(amount) || amount <= 0) {
      return { ok: false, reason: REASON_CODE.INVALID_AMOUNT, network_id, amount };
    }

    // Network must exist
    if (!state.networks[network_id]) {
      return { ok: false, reason: REASON_CODE.INVALID_SOURCE_NETWORK, network_id };
    }

    // Sender wallet must exist and have sufficient balance in this network
    const wallet_key = `${network_id}:${sender_address}`;
    const wallet     = state.wallets[wallet_key];

    if (!wallet || !wallet.is_predefined_tester_address) {
      return {
        ok:     false,
        reason: REASON_CODE.UNKNOWN_SENDER_WALLET,
        network_id,
        sender_address,
      };
    }

    if (wallet.wallet_active < amount) {
      return {
        ok:              false,
        reason:          REASON_CODE.INSUFFICIENT_SOURCE_BALANCE,
        network_id,
        sender_address,
        available:       wallet.wallet_active,
        requested:       amount,
      };
    }

    const src_op = createSourceOperation({
      source_op_id:   generateSourceOpId(),
      envelope_id,
      source_network: network_id,
      source_wallet:  sender_address,
      amount,
    });

    sources.push(src_op);
  }

  // Verify target IT_FROZEN can cover the full amount
  const target_net = state.networks[target_network];
  if (!target_net) {
    return { ok: false, reason: REASON_CODE.INVALID_TARGET_NETWORK, target_network };
  }
  if (target_net.IT_FROZEN < total_amount) {
    return {
      ok:                  false,
      reason:              REASON_CODE.INSUFFICIENT_TARGET_FROZEN,
      target_network,
      IT_FROZEN_available: target_net.IT_FROZEN,
      requested:           total_amount,
    };
  }

  return { ok: true, sources };
}

module.exports = {
  resolveAutomaticSources,
  resolveUserDefinedSources,
};
