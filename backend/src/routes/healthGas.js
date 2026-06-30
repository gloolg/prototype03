'use strict';

const express  = require('express');
const { ethers } = require('ethers');
const router   = express.Router();

const NETWORKS = [
  {
    id:        'A',
    name:      'Ethereum Sepolia',
    rpc:       process.env.RPC_A,
    address:   process.env.IT_A_ADDRESS,
    threshold: parseFloat(process.env.GAS_THRESHOLD_A || '0.005'),
    symbol:    'ETH',
  },
  {
    id:        'B',
    name:      'BNB Smart Chain Testnet',
    rpc:       process.env.RPC_B,
    address:   process.env.IT_B_ADDRESS,
    threshold: parseFloat(process.env.GAS_THRESHOLD_B || '0.005'),
    symbol:    'BNB',
  },
  {
    id:        'C',
    name:      'Polygon PoS Amoy',
    rpc:       process.env.RPC_C,
    address:   process.env.IT_C_ADDRESS,
    threshold: parseFloat(process.env.GAS_THRESHOLD_C || '0.01'),
    symbol:    'POL',
  },
  {
    id:        'D',
    name:      'Arbitrum Sepolia',
    rpc:       process.env.RPC_D,
    address:   process.env.IT_D_ADDRESS,
    threshold: parseFloat(process.env.GAS_THRESHOLD_D || '0.005'),
    symbol:    'ETH',
  },
];

// GET /health/gas
router.get('/', async (req, res) => {
  const results = await Promise.allSettled(
    NETWORKS.map(async (net) => {
      const provider = new ethers.JsonRpcProvider(net.rpc);
      const raw      = await provider.getBalance(net.address);
      const balance  = parseFloat(ethers.formatEther(raw));
      return {
        network_id: net.id,
        network:    net.name,
        address:    net.address,
        balance:    balance,
        symbol:     net.symbol,
        threshold:  net.threshold,
        status:     balance < net.threshold ? 'WARNING' : 'OK',
      };
    })
  );

  const networks = results.map((r, i) => {
    if (r.status === 'fulfilled') return r.value;
    return {
      network_id: NETWORKS[i].id,
      network:    NETWORKS[i].name,
      address:    NETWORKS[i].address,
      balance:    null,
      symbol:     NETWORKS[i].symbol,
      threshold:  NETWORKS[i].threshold,
      status:     'ERROR',
      error:      r.reason?.message || 'RPC error',
    };
  });

  const hasWarning = networks.some(n => n.status === 'WARNING');
  const hasError   = networks.some(n => n.status === 'ERROR');

  return res.json({
    ok:       !hasError,
    summary:  hasWarning ? 'WARNING' : hasError ? 'ERROR' : 'OK',
    networks,
    ts:       Math.floor(Date.now() / 1000),
  });
});

module.exports = router;
