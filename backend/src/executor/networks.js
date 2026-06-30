'use strict';

const { ethers } = require('ethers');

// Minimal ERC-20 ABI
const ERC20_ABI = [
  'function transfer(address to, uint256 amount) returns (bool)',
  'function decimals() view returns (uint8)',
  'function balanceOf(address account) view returns (uint256)',
];

// IT-EOA addresses per network (used by getITBalance)
const IT_ADDRESS = {
  A: (process.env.IT_A_ADDRESS || '').toLowerCase(),
  B: (process.env.IT_B_ADDRESS || '').toLowerCase(),
  C: (process.env.IT_C_ADDRESS || '').toLowerCase(),
  D: (process.env.IT_D_ADDRESS || '').toLowerCase(),
};

const CONTRACT_ADDRESS = '0x494bfC3aB5fAe4066dc1F3D42F6e5b6938b70438';

const NETWORK_CONFIG = {
  A: { rpcEnv: 'RPC_A', keyEnv: 'IT_A_PRIVATE_KEY', symbol: 'ETH', gasThreshold: parseFloat(process.env.GAS_THRESHOLD_A || '0.005'), minPriorityFee: 0n },
  B: { rpcEnv: 'RPC_B', keyEnv: 'IT_B_PRIVATE_KEY', symbol: 'BNB', gasThreshold: parseFloat(process.env.GAS_THRESHOLD_B || '0.005'), minPriorityFee: 25_000_000_000n },
  // Polygon Amoy enforces minimum tip of 25 gwei at the RPC level
  C: { rpcEnv: 'RPC_C', keyEnv: 'IT_C_PRIVATE_KEY', symbol: 'POL', gasThreshold: parseFloat(process.env.GAS_THRESHOLD_C || '0.005'), minPriorityFee: 25_000_000_000n },
  D: { rpcEnv: 'RPC_D', keyEnv: 'IT_D_PRIVATE_KEY', symbol: 'ETH', gasThreshold: parseFloat(process.env.GAS_THRESHOLD_D || '0.005'), minPriorityFee: 0n },
};

const _providers = {};

function getProvider(network_id) {
  if (_providers[network_id]) return _providers[network_id];
  const cfg = NETWORK_CONFIG[network_id];
  if (!cfg) throw new Error(`Unknown network_id: ${network_id}`);
  const rpc = process.env[cfg.rpcEnv];
  if (!rpc) throw new Error(`Missing env var ${cfg.rpcEnv}`);
  // batchMaxCount:1 disables request batching — drpc.org free tier rejects batches >3
  _providers[network_id] = new ethers.JsonRpcProvider(rpc, undefined, { batchMaxCount: 1 });
  return _providers[network_id];
}

// MVP: signing via .env private key.
// To switch to GCP KMS: replace ethers.Wallet with GcpKmsSigner — same interface.
function getSigner(network_id, provider) {
  const cfg = NETWORK_CONFIG[network_id];
  if (!cfg) throw new Error(`Unknown network_id: ${network_id}`);
  const key = process.env[cfg.keyEnv];
  if (!key) throw new Error(`Missing env var ${cfg.keyEnv}`);
  return new ethers.Wallet(key, provider);
}

function getContract(network_id, signer) {
  return new ethers.Contract(CONTRACT_ADDRESS, ERC20_ABI, signer);
}

function getGasThreshold(network_id) {
  return NETWORK_CONFIG[network_id]?.gasThreshold ?? 0.005;
}

function getMinPriorityFee(network_id) {
  return NETWORK_CONFIG[network_id]?.minPriorityFee ?? 0n;
}

// Returns integer tEQUI units (on-chain wei / 10^18) for any address on the given network.
// Uses a read-only contract instance (no signer needed).
// Calls are sequential — drpc.org free tier blocks JSON-RPC batches of >3.
async function getTokenBalance(network_id, address) {
  const provider = getProvider(network_id);
  const contract = new ethers.Contract(CONTRACT_ADDRESS, ERC20_ABI, provider);
  const raw = await contract.balanceOf(address);
  return Number(raw / (10n ** 18n));
}

// Convenience wrapper: balanceOf(IT-EOA) for the given network.
async function getITBalance(network_id) {
  const addr = IT_ADDRESS[network_id];
  if (!addr) throw new Error(`IT_${network_id}_ADDRESS not configured`);
  return getTokenBalance(network_id, addr);
}

module.exports = {
  getProvider, getSigner, getContract, getGasThreshold, getMinPriorityFee,
  getTokenBalance, getITBalance,
  NETWORK_CONFIG, CONTRACT_ADDRESS, IT_ADDRESS,
};
