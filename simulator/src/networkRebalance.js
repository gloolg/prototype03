'use strict';

// ─── Network Rebalance (parametric extension) ─────────────────────────────────
// rebalanceOnNetworkAdd(currentState, newNetworkId, A_ACTIVE)
//   Simulates the structural rebalance when a new network joins:
//   - Computes new IT_ACTIVE shares for (existingNetworks + newNetwork)
//   - Reduces IT_ACTIVE on each existing network where share shrinks,
//     moving the delta into IT_FROZEN (structural reserve increase)
//   - Initialises the new network with its full share as IT_ACTIVE
//   - Verifies the post-rebalance invariant: Σ A_ACTIVE components = A_ACTIVE
//
// NOTE on applySourceFreeze: applySourceFreeze() from crossNetwork.js operates
// on wallet_active → IT_FROZEN (user wallet freeze for cross-network transfer).
// A structural rebalance moves IT_ACTIVE → IT_FROZEN — a different source field.
// Calling applySourceFreeze here would require a fake wallet entry and would
// corrupt wallet_active_total. The mutation below follows the same accounting
// pattern (state_before / state_after, both net and treasury updated together)
// without re-using the wrong primitive.

const { CONSTANTS } = require('./constants');
const { calculateActiveShares, calculateFrozenReserve } = require('./networkAllocation');
const { createNetworkState, createTreasuryState } = require('./stateFactory');

// ─── rebalanceOnNetworkAdd ────────────────────────────────────────────────────
function rebalanceOnNetworkAdd(currentState, newNetworkId, A_ACTIVE) {
  const existingIds = Object.keys(currentState.networks);
  const allIds      = [...existingIds, newNetworkId];
  const newShares   = calculateActiveShares(allIds, A_ACTIVE);
  const rebalance_ops = [];

  // ── Adjust existing networks ───────────────────────────────────────────────
  for (const netId of existingIds) {
    const net      = currentState.networks[netId];
    const treasury = currentState.treasuries[netId];
    if (!net || !treasury) continue;

    const newShare = newShares[netId];
    const delta    = net.IT_ACTIVE - newShare;

    if (delta > 0) {
      const before = { IT_ACTIVE: net.IT_ACTIVE, IT_FROZEN: net.IT_FROZEN };

      // IT_ACTIVE → IT_FROZEN: structural reserve absorbs what active pool releases
      net.IT_ACTIVE      -= delta;
      treasury.IT_ACTIVE -= delta;
      net.IT_FROZEN      += delta;
      treasury.IT_FROZEN += delta;

      const after = { IT_ACTIVE: net.IT_ACTIVE, IT_FROZEN: net.IT_FROZEN };
      rebalance_ops.push({ network_id: netId, delta, before, after });
    }
  }

  // ── Initialise new network ─────────────────────────────────────────────────
  const newItActive = newShares[newNetworkId];
  const newItFrozen = calculateFrozenReserve(
    newNetworkId,
    CONSTANTS.MINTED_PER_NETWORK,
    newItActive
  );

  const newNet = createNetworkState({
    network_id:   newNetworkId,
    network_name: `Network ${newNetworkId}`,
    priority:     allIds.length,
    it_address:   `0xIT_${newNetworkId}_placeholder`,
  });
  newNet.IT_ACTIVE = newItActive;
  newNet.IT_FROZEN = newItFrozen;
  currentState.networks[newNetworkId] = newNet;

  const newTreasury = createTreasuryState({
    network_id: newNetworkId,
    it_id:      `IT-${newNetworkId}`,
    it_address: `0xIT_${newNetworkId}_placeholder`,
  });
  newTreasury.IT_ACTIVE = newItActive;
  newTreasury.IT_FROZEN = newItFrozen;
  currentState.treasuries[newNetworkId] = newTreasury;

  // ── Invariant check: Σ(wallet_active_total + IT_ACTIVE + UNAVAILABLE) = A_ACTIVE
  let activeSum = 0;
  for (const netId of allIds) {
    const net = currentState.networks[netId];
    if (net) activeSum += (net.wallet_active_total + net.IT_ACTIVE + net.UNAVAILABLE);
  }
  const invariant_ok = (activeSum === A_ACTIVE);

  return {
    ok:             invariant_ok,
    invariant_ok,
    activeSum,
    A_ACTIVE,
    newShares,
    allIds,
    rebalance_ops,
  };
}

module.exports = { rebalanceOnNetworkAdd };
