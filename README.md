# MetaNetwork EQI — Lightpaper

**A canonical state layer for cross-network token accounting. Not a bridge.**

Repository: [github.com/gloolg/prototype03](https://github.com/gloolg/prototype03)

---

## The Problem It Solves

Cross-network token transfers today either require a trust-minimized bridge (lock/mint, wrapped assets) or direct exchange infrastructure. MetaNetwork EQI proposes a third model: **a shared registry that changes which wallet has claim to an amount — without moving the underlying asset between chains at all.**

---

## Core Principle

MetaNetwork EQI maintains a **MetaRegistry** — a single authoritative state machine that tracks tEQUI balances across four EVM testnets. When a user "teleports" 500 tEQUI from Network A to Network B, two things happen:

1. The MetaRegistry **subtracts** 500 from the sender's recorded balance on A
2. The MetaRegistry **adds** 500 to the recipient's recorded balance on B, then the Executor **delivers it on-chain**

No wrapped token is minted. No collateral is locked on chain A. The total supply never changes. **The state changes; the asset accounting follows.**

---

## Key Invariant: A_ACTIVE = 100,000

At genesis, 100,000 tEQUI are minted on each of 4 networks — 400,000 total. The MetaRegistry enforces one non-negotiable invariant at all times:

> **A_ACTIVE** (all wallets + all IT-EOAs + unavailable) **= 100,000 tEQUI**

This is checked after every operation. A positive delta is an immediate system stop. It can never go up — the protocol enforces scarcity at the state layer, not at the contract layer.

*"A_ACTIVE" refers to the active (non-frozen) portion across all networks. The remaining 300,000 tEQUI are held frozen in IT-EOA reserves — available only through controlled treasury distributions.*

---

## Two Planes of Freedom

Wallets interact with tEQUI on two levels simultaneously:

**THROUGH_METAREGISTRY** — send to IT-EOA on source network → MetaRegistry records the transfer → Executor delivers on target network. Full cross-network routing. Two gas payments (sender pays entry, MetaNetwork pays exit).

**DIRECT_HOST_NETWORK** — standard ERC-20 transfer to any address on the same network. Observer records it for MetaRegistry visibility, but no routing occurs. One gas payment, instant.

Neither mode creates or destroys tokens. Both are visible to the MetaRegistry.

---

## How Single-Source Teleport Works

Three steps, two actors:

```
Step 1  Peer sends tEQUI → IT-EOA on source network   (peer pays gas)
Step 2  DApp calls /entry → MetaRegistry records the transfer  (0 gas)
Step 3  Executor delivers tEQUI → recipient on target network  (MetaNetwork pays gas)
```

The MetaRegistry validates the on-chain receipt before recording. If delivery fails, the operation is marked STUCK and recoverable via the admin panel without data loss.

---

## How Multi-Source Operation Works

When no single network holds enough balance, the user splits the amount across N source networks:

```
User declares: "Send 1500 tEQUI to Network D — from A(600) + B(400) + C(500)"
↓
For each source: peer signs, tEQUI → IT-EOA on that network
↓
MetaRegistry collects confirmations (5-minute window)
↓
When all N sources confirmed → single delivery to recipient on target network
↓
If window expires or delivery fails → each source individually refundable
```

**All-or-nothing.** Delivery happens only when every declared source is confirmed. The 5-minute timer starts from the first confirmed on-chain source, not from when the user initiates the operation.

---

## What This Is (and Isn't)

|  | MetaNetwork EQI |
|---|---|
| Wrapped tokens | No — same tEQUI contract address across all chains |
| Locked collateral on source | No — tokens remain in IT-EOA and can be delivered to any recipient |
| Trust model | IT-EOA private keys (GCP KMS) — operator-managed in MVP |
| Bridge relayers | No — single backend Executor with idempotent command log |
| State finality | SQLite WAL + mandatory on-chain receipt verification before any state change |

---

## Current MVP

4 EVM testnets: **Ethereum Sepolia (A) · BNB Testnet (B) · Polygon Amoy (C) · Arbitrum Sepolia (D)**

Token: `tEQUI` · 18 decimals · 400,000 total supply · 100,000 per network  
Contract: `0x494bfC3aB5fAe4066dc1F3D42F6e5b6938b70438` (same address on all four networks)  
Stack: Node.js · Express · better-sqlite3 · ethers.js v6 · MetaMask (EIP-1193)

For full technical documentation (API endpoints, DB schema, Observer/Executor internals, MSE state machine): see [README_FULL.md](./README_FULL.md).

---

*MetaNetwork EQI — Architecture by Andrii*
