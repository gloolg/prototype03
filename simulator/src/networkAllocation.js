'use strict';

// ─── Dynamic Network Allocation (§genesis parametric extension) ───────────────
// calculateActiveShares(networkIds, A_ACTIVE)
//   Distributes A_ACTIVE across N networks: first N-1 get ceil(A_ACTIVE/N),
//   last network gets the remainder so the sum is exactly A_ACTIVE.
//
// calculateFrozenReserve(networkId, mintedPerNetwork, activeShare)
//   Structural frozen reserve = all minted minus the active share.
//   This is the IT_FROZEN starting value for a network at genesis.
//   Distinct from the short-term IT_FROZEN changes in crossNetwork.js (freeze/unfreeze).

// ─── calculateActiveShares ────────────────────────────────────────────────────
// Returns { [network_id]: activeShare } with sum === A_ACTIVE exactly.
function calculateActiveShares(networkIds, A_ACTIVE) {
  const N = networkIds.length;
  const base = Math.ceil(A_ACTIVE / N);
  const shares = {};
  let allocated = 0;
  for (let i = 0; i < N - 1; i++) {
    shares[networkIds[i]] = base;
    allocated += base;
  }
  shares[networkIds[N - 1]] = A_ACTIVE - allocated;
  return shares;
}

// ─── calculateFrozenReserve ───────────────────────────────────────────────────
// networkId is accepted for future per-network overrides; unused for now.
function calculateFrozenReserve(networkId, mintedPerNetwork, activeShare) { // eslint-disable-line no-unused-vars
  return mintedPerNetwork - activeShare;
}

module.exports = { calculateActiveShares, calculateFrozenReserve };
