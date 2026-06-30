'use strict';

/**
 * routes/registry.js
 *
 * GET /registry/check-address?network_id=A&address=0x...
 *   Returns whether the address is a known tester wallet in MetaRegistry.
 *   UX pre-check only — NOT a security boundary.
 *
 * GET /registry/config
 *   Returns public network config: IT-EOA addresses (public), contract address, chain IDs.
 *   Used by DApp to know where to send entry transactions.
 *   Does NOT expose private keys.
 *
 * GET /registry/balances?address=0x...
 *   Returns tEQUI balanceOf for the given address on all 4 networks.
 *   Reads via backend RPC providers (not MetaMask). Null on RPC error.
 */

const express        = require('express');
const router         = express.Router();
const { ethers }     = require('ethers');
const sm             = require('../stateManager');
const { getProvider, CONTRACT_ADDRESS } = require('../executor/networks');

const ERC20_ABI = ['function balanceOf(address) view returns (uint256)'];

const NETWORK_CONFIG = {
  A: { network_id: 'A', name: 'Ethereum Sepolia',        chainId: 11155111, it_address: process.env.IT_A_ADDRESS, symbol: 'ETH', explorer_url: 'https://sepolia.etherscan.io' },
  B: { network_id: 'B', name: 'BNB Smart Chain Testnet', chainId: 97,       it_address: process.env.IT_B_ADDRESS, symbol: 'BNB', explorer_url: 'https://testnet.bscscan.com' },
  C: { network_id: 'C', name: 'Polygon PoS Amoy',        chainId: 80002,    it_address: process.env.IT_C_ADDRESS, symbol: 'POL', explorer_url: 'https://amoy.polygonscan.com' },
  D: { network_id: 'D', name: 'Arbitrum Sepolia',        chainId: 421614,   it_address: process.env.IT_D_ADDRESS, symbol: 'ETH', explorer_url: 'https://sepolia.arbiscan.io' },
};

// GET /registry/check-address
router.get('/check-address', (req, res) => {
  if (!sm.isInitialized()) {
    return res.status(400).json({ ok: false, reason: 'MetaRegistry not initialized.' });
  }

  const { network_id, address } = req.query;
  if (!network_id || !NETWORK_CONFIG[network_id]) {
    return res.status(400).json({ ok: false, reason: 'Invalid network_id.' });
  }
  if (!address || typeof address !== 'string') {
    return res.status(400).json({ ok: false, reason: 'Missing address.' });
  }

  const state    = sm.getState();
  const key      = `${network_id}:${address.toLowerCase()}`;
  const wallet   = state.wallets[key];
  const is_known = !!wallet;

  // UX pre-check only — NOT a security boundary.
  // Real enforcement: Observer → reconcileObservedTransfer → UNAVAILABLE for unknown addresses.
  return res.json({
    ok:          true,
    address,
    network_id,
    is_known,
    wallet_type: wallet ? (wallet.is_cold_wallet ? 'COLD' : 'TESTER') : null,
  });
});

// GET /registry/config
router.get('/config', (req, res) => {
  return res.json({
    ok:               true,
    contract_address: CONTRACT_ADDRESS,
    networks:         Object.values(NETWORK_CONFIG),
  });
});

// GET /registry/balances?address=0x...
router.get('/balances', async (req, res) => {
  const { address } = req.query;
  if (!address || !/^0x[0-9a-fA-F]{40}$/i.test(address)) {
    return res.status(400).json({ ok: false, reason: 'Invalid or missing address.' });
  }

  const balances = {};
  await Promise.all(Object.keys(NETWORK_CONFIG).map(async net_id => {
    try {
      const provider = getProvider(net_id);
      const contract = new ethers.Contract(CONTRACT_ADDRESS, ERC20_ABI, provider);
      const raw      = await contract.balanceOf(address);
      balances[net_id] = Number(ethers.formatUnits(raw, 18));
    } catch (_) {
      balances[net_id] = null;
    }
  }));

  return res.json({ ok: true, address, balances });
});

module.exports = router;
