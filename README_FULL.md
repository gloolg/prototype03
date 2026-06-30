# MetaNetwork EQI — Technical Reference

> Full technical documentation for the MetaRegistry MVP backend.  
> For architecture overview see [README.md](./README.md).

---

## Repository Structure

```
metanetwork-latest/
├── README.md                      # Lightpaper — architecture overview
├── README_FULL.md                 # This file — full technical reference
├── contracts/tEQUI.sol            # ERC-20 token contract (deployed on 4 testnets)
├── deployments/deployments.json   # Contract addresses per network
├── simulator/src/                 # In-memory state simulator (stateless functions)
│   ├── simulator.js               # Entry point — assembles all modules
│   ├── constants.js               # Enums, network defs, invariant values
│   ├── stateFactory.js            # MasterState constructors
│   ├── genesis.js                 # Genesis initialization logic
│   ├── treasury.js                # IT treasury distribution
│   ├── sourceResolution.js        # AUTOMATIC / USER_DEFINED source selection
│   ├── crossNetwork.js            # Cross-network transfer lifecycle
│   ├── invariants.js              # 9 invariants + traceability check
│   ├── observation.js             # Observer reconciliation
│   └── idGenerator.js             # Deterministic ID generation
└── backend/
    ├── src/
    │   ├── server.js              # Express app + startup sequence
    │   ├── db.js                  # SQLite schema (14 tables)
    │   ├── stateManager.js        # In-memory state + SQLite persistence bridge
    │   ├── observer/
    │   │   ├── index.js           # 4-network polling scheduler (15s, staggered)
    │   │   └── processor.js       # Per-network Transfer log processor
    │   ├── executor/
    │   │   ├── index.js           # On-chain delivery engine
    │   │   ├── networks.js        # RPC providers + IT-EOA signers
    │   │   └── commandTypes.js    # COMMAND_TYPE enum
    │   ├── mse/manager.js         # Multi-source envelope state machine
    │   └── routes/
    │       ├── genesis.js         # POST /genesis
    │       ├── treasury.js        # POST /treasury/distribute
    │       ├── transfer.js        # POST /transfer
    │       ├── entry.js           # POST /entry
    │       ├── multiEntry.js      # POST /entry/multi/* (MSE flow)
    │       ├── registry.js        # GET /registry/*
    │       ├── state.js           # GET /state
    │       ├── events.js          # GET /events
    │       ├── transparency.js    # GET /transparency
    │       ├── healthGas.js       # GET /health/gas
    │       ├── admin.js           # /admin/* (auth-protected)
    │       └── adminMse.js        # /admin/multi-envelopes/* (auth-protected)
    └── public/
        ├── index.html             # EQI DApp (served at / and /dapp)
        ├── admin.html             # Admin panel (served at /admin)
        └── transparency.html      # Public transparency dashboard
```

---

## Networks & Genesis Constants

| ID | Network | Chain ID | Priority |
|---|---|---|---|
| A | Ethereum Sepolia | 11155111 | 1 |
| B | BNB Smart Chain Testnet | 97 | 2 |
| C | Polygon PoS Amoy | 80002 | 3 |
| D | Arbitrum Sepolia | 421614 | 4 |

**Token:** `tEQUI` · `0x494bfC3aB5fAe4066dc1F3D42F6e5b6938b70438` (all 4 networks) · 18 decimals

**Genesis partition per network:**

| Bucket | Amount |
|---|---|
| `IT_ACTIVE` (distributable to testers) | 25,000 tEQUI |
| `IT_FROZEN` (cross-network reserve) | 75,000 tEQUI |
| `wallet_active_total` | 0 (populated via `/treasury/distribute`) |
| **Total per network** | **100,000 tEQUI** |

**Global invariants (enforced after every operation):**

| Invariant | Value |
|---|---|
| `TOTAL_MINTED` | 400,000 tEQUI |
| `A_ACTIVE` (wallet + IT_ACTIVE + UNAVAILABLE across all nets) | 100,000 tEQUI |
| `TOTAL_FROZEN` at genesis | 300,000 tEQUI |
| `MAX_WALLET_ACTIVE` (60/40 corridor cap) | 60,000 tEQUI |
| `MIN_IT_ACTIVE` (40/60 corridor floor) | 40,000 tEQUI |

---

## API Reference

### System

| Method | Path | Auth | Description |
|---|---|---|---|
| GET | `/health` | — | `{status:"ok", ts:unix}` |
| GET | `/health/gas` | — | IT-EOA gas balance vs thresholds per network |
| GET | `/observer/status` | — | Last processed block + poll ts per network |

### MetaRegistry Lifecycle

| Method | Path | Auth | Description |
|---|---|---|---|
| POST | `/genesis` | — | Initialize MetaRegistry (one-time). Body: `{networks:[{network_id,it_address}×4]}` |
| GET | `/state` | — | Full in-memory state: networks, treasuries, wallets, event/snapshot counts |
| GET | `/events` | — | Append-only event log. Params: `?limit=N&envelope_id=ENV-...` |
| GET | `/transparency` | — | Public canonical snapshot: invariants, totals, per-network breakdown |

### Token Operations

| Method | Path | Auth | Description |
|---|---|---|---|
| POST | `/treasury/distribute` | — | Move tEQUI from `IT_ACTIVE` to tester wallet. Enforces 60/40 corridor. Triggers Executor delivery. Body: `{network_id, wallet_address, amount}` |
| POST | `/transfer` | — | **Operator endpoint.** Direct MetaRegistry state update without on-chain verification. Modes: `AUTOMATIC` (priority A→B→C→D) or `USER_DEFINED` (explicit per-network amounts). Not used by DApp. |

### DApp Entry Flow (peer-initiated, on-chain verified)

| Method | Path | Auth | Description |
|---|---|---|---|
| POST | `/entry` | — | Single-source: verify on-chain receipt → MetaRegistry transfer → Executor delivery. Body: `{tx_hash, source_network, target_network, recipient_address, amount}` |
| POST | `/entry/multi/create` | — | Create MSE envelope. Body: `{target_network, recipient, sources:[{source_network, from_address, expected_amount}]}` |
| POST | `/entry/multi/:id/submit` | — | Submit one confirmed source tx to envelope. Body: `{tx_hash, source_network}` |
| GET | `/entry/multi/:id/status` | — | Envelope status + confirmed count |

### Registry (DApp read endpoints)

| Method | Path | Auth | Description |
|---|---|---|---|
| GET | `/registry/config` | — | Public network config: IT-EOA addresses, contract address, chain IDs, network names |
| GET | `/registry/balances?address=0x...` | — | Live `balanceOf()` via RPC for given address on all 4 networks |
| GET | `/registry/check-address?network_id=A&address=0x...` | — | Is address a registered MetaRegistry wallet? UX hint only. |

### Admin Panel (Bearer token required)

| Method | Path | Description |
|---|---|---|
| POST | `/admin/auth` | Login — returns Bearer token (8h session) |
| POST | `/admin/logout` | Invalidate session |
| POST | `/admin/register-wallet` | Add wallet to MetaRegistry |
| GET | `/admin/wallets` | All registered wallets with MetaRegistry balances (from SQLite cache, not live RPC) |
| GET | `/admin/logs` | `execution_log` — all Executor commands with status |
| GET | `/admin/entry-blocks` | `observer_seen_txs` — processed tx hashes |
| DELETE | `/admin/entry-blocks/:tx_hash` | Remove idempotency row to allow `/entry` replay |
| GET | `/admin/onchain-invariant` | Live `balanceOf` comparison: MetaRegistry vs on-chain per IT-EOA |
| GET | `/admin/unprocessed-entries` | Wallet→IT-EOA txs seen by Observer but not matched to `/entry` call |
| POST | `/admin/create-stuck-delivery` | Manually create stuck delivery record |
| GET | `/admin/stuck-entries` | `/entry` calls where `applyTransfer` failed (tokens at IT-EOA, registry not updated) |
| DELETE | `/admin/stuck-entries/:tx_hash` | Remove stuck entry to allow `/entry` retry |
| GET | `/admin/stuck-deliveries` | Executor deliveries that failed after MetaRegistry was updated |
| POST | `/admin/refund-delivery/:tx_hash` | Refund a stuck delivery back to original sender |
| POST | `/admin/retry-delivery/:tx_hash` | Retry a stuck Executor delivery |
| GET | `/admin/multi-envelopes` | All non-COMPLETED MSE envelopes + sources |
| GET | `/admin/multi-envelopes/:id` | Single envelope detail |
| POST | `/admin/multi-envelopes/:id/deliver` | Retry delivery (FAILED or TIMEOUT envelopes with all sources CONFIRMED) |
| POST | `/admin/multi-envelopes/:id/refund/:net` | Refund one CONFIRMED source back on-chain |
| POST | `/admin/multi-envelopes/:id/refund-all` | Refund all CONFIRMED sources |

---

## Database Schema (14 tables)

### `network_state`
Per-network active/frozen totals.
```
network_id TEXT PK | network_name TEXT | total_active INT | total_frozen INT
total_unavailable INT | is_initialized INT | initialized_at INT | updated_at INT
```

### `treasury_state`
IT-EOA balance per network.
```
network_id TEXT PK | it_address TEXT | active_balance INT | frozen_balance INT | updated_at INT
```

### `wallet_balance`
Per-wallet, per-network MetaRegistry balances. Values = `wallet_active` from in-memory state, persisted after every operation. **Not live on-chain balances** — use `/registry/balances` for live RPC data.
```
id INT PK | address TEXT | network_id TEXT | active_balance INT | frozen_balance INT
wallet_type TEXT ('EXTERNAL'|'COLD'|'IT'|'TESTER') | updated_at INT
UNIQUE(address, network_id)
```

### `event_record`
Append-only. Never modified after insert.
```
id INT PK | event_id TEXT UNIQUE | event_type TEXT | network_id TEXT
from_address TEXT | to_address TEXT | amount INT | source_type TEXT
status TEXT ('SUCCESS'|'REJECTED'|'PENDING') | rejection_code TEXT
metadata TEXT (JSON) | created_at INT
```

### `invariant_snapshot`
Point-in-time invariant check after every mutating operation.
```
id INT PK | snapshot_id TEXT UNIQUE | triggered_by_event_id TEXT
total_minted INT | a_active INT | total_frozen INT
network_active_json TEXT | network_frozen_json TEXT
all_invariants_pass INT | failed_invariants TEXT (JSON) | created_at INT
```

### `observer_checkpoint`
Last fully-processed block per network. Updated after each successful chunk.
```
network_id TEXT PK | last_block INT | updated_at INT
```

### `observer_seen_txs`
Idempotency table. `(tx_hash, log_index)` is the unique key.  
`log_index = -1` means the tx was claimed by `/entry` (not Observer).
```
tx_hash TEXT | log_index INT | network_id TEXT | processed_at INT
PRIMARY KEY (tx_hash, log_index)
```

### `pending_entries`
Wallet→IT-EOA transfers detected by Observer, not yet matched to `/entry`.
```
tx_hash TEXT | log_index INT | network_id TEXT | from_address TEXT
amount INT | block_number INT | detected_at INT | PRIMARY KEY (tx_hash, log_index)
```

### `stuck_entries`
`/entry` calls where on-chain tx arrived at IT-EOA and was verified, but `applyTransfer` returned `!ok`. Tokens are safe in IT-EOA; MetaRegistry quota was not granted.
```
tx_hash TEXT PK | source_network TEXT | amount INT | from_address TEXT | reason TEXT | created_at INT
```

### `execution_log`
Executor idempotency. One row per `command_id`. Never set to COMPLETED unless on-chain tx confirmed.
```
command_id TEXT PK | command_type TEXT | network_id TEXT | to_address TEXT | amount INT
envelope_id TEXT | status TEXT ('PENDING'|'COMPLETED'|'FAILED'|'STUCK')
tx_hash TEXT | block_number INT | error_reason TEXT
source_network TEXT | from_address TEXT | created_at INT | completed_at INT
```

### `admin_config`
Key-value store. Contains bcrypt-hashed admin password (`admin_password_hash`).

### `admin_sessions`
Active sessions. Cleaned on next login.
```
token TEXT PK | created_at INT | expires_at INT
```

### `mse_envelope`
One row per multi-source operation.
```
envelope_id TEXT PK | target_network TEXT | recipient TEXT | total_amount INT
source_count INT | confirmed_count INT | status TEXT | transfer_applied INT
first_entry_at INT | timeout_at INT | created_at INT | completed_at INT | error_reason TEXT
```
Status values: `COLLECTING → DELIVERING → COMPLETED` or `TIMEOUT` or `FAILED`

### `mse_source`
One row per declared source within an envelope.
```
id INT PK | envelope_id TEXT FK | source_network TEXT | from_address TEXT
expected_amount INT | actual_amount INT | tx_hash TEXT | log_index INT
status TEXT ('PENDING'|'CONFIRMED'|'REFUNDED') | confirmed_at INT
UNIQUE(envelope_id, source_network)
```

---

## Observer

**Polling:** Each of 4 networks polled independently every 15s. Stagger offsets: A+0s, B+4s, C+8s, D+12s (avoids simultaneous RPC bursts).

**Per-poll flow:**
1. Read `observer_checkpoint.last_block` for this network
2. Fetch current block from RPC
3. No checkpoint → bootstrap: save current block, return (no historical scan)
4. Fetch `Transfer` logs in chunks (default 10 blocks/chunk, capped at 100 blocks/poll)
5. Filter OUT: IT-EOA-initiated transfers (Executor outputs); transfers TO IT-EOA (Entry flow)
6. For each remaining log: check `observer_seen_txs` idempotency → call `applyObservation`
7. Update `observer_checkpoint` after each successful chunk

**Idempotency:** `(tx_hash, log_index)` composite key in `observer_seen_txs`. Observer uses real `log_index`. `/entry` uses `log_index = -1` to claim the same tx hash — this prevents Observer from re-processing an Entry tx and decrementing `wallet_active` again.

---

## Executor

**Command types** (`executor/commandTypes.js`):
- `TREASURY_DISTRIBUTION` — IT-EOA → tester wallet
- `CROSS_NETWORK_ENTRY` — IT-EOA → recipient after `/entry`
- `MSE_DELIVERY` — IT-EOA → recipient after all MSE sources confirmed
- `REFUND` — IT-EOA → original sender (stuck delivery or MSE refund)

**Idempotency:** `command_id` is unique per operation (e.g. `entry:<tx_hash>`, `mse:deliver:<envelope_id>`, `mse:refund:<envelope_id>:<network>`). On server restart, all `PENDING` rows in `execution_log` are set to `FAILED` — requires admin review.

**Pre-flight:** `canApplyTreasuryDistribution` validates invariants before spending gas on a distribution that would be rejected.

---

## MSE State Machine

```
create()
  └─ COLLECTING
       │
       ├─ confirmSource() for each source (on-chain verified)
       │   first confirmation → first_entry_at = now(), timeout_at = now() + 300s
       │
       ├─ all confirmed → tryDeliver()
       │   └─ DELIVERING
       │       ├─ applyTransfer (MetaRegistry state update, guarded by transfer_applied flag)
       │       ├─ executeCommand(MSE_DELIVERY)
       │       │   ├─ COMPLETED  ✓
       │       │   └─ FAILED     (retry or refund via admin)
       │       └─ SERVER RESTART while DELIVERING → FAILED (safe: execution_log catches duplicate)
       │
       └─ timeout_at reached without all confirmed → TIMEOUT
            └─ Admin: refund-all (REFUND per source) or retry deliver if sources complete
```

**`transfer_applied` flag:** Guards the edge case where `applyTransfer` succeeds but server crashes before `executeCommand`. On retry (`retryDeliver`), the flag prevents double-application of the MetaRegistry state change.

**Timer:** Starts from first `confirmSource()` (first on-chain confirmed source), not from `create()`. Failed MetaMask signatures before any on-chain confirmation do not consume the 300s window.

---

## DApp Features

- **Wallet:** EIP-1193 (MetaMask, TrustWallet, any compatible). Account selection on every connect.
- **Balance table:** Live `balanceOf()` via backend RPC — Total + per-network. Auto-refresh.
- **Transfer form:**
  - TYPE A (cross-network): `/entry` flow — peer → IT-EOA → MetaRegistry → Executor delivery
  - TYPE B (same-network): Direct on-chain (1 gas) or Via MetaNetwork (2 gas, full registry tracking)
- **Multi-Operations toggle:** Off by default. One-time enable modal per wallet address (localStorage key `mse_ack_enable_<lowercase_address>`). Disable modal shown every time (no localStorage persistence).
- **MSE flow:** Allocation panel → step-by-step signing per source network → delivery polling
- **Self-loop guard:** Blocks `source_network == target_network AND sender == recipient` at both UI and backend (`/entry`, `/entry/multi/:id/submit`)
- **Sign error modal:** On any wallet tx failure — shows raw wallet error message (`err.reason || err.message`), mandatory acknowledgment checkbox, Retry / Cancel. Separate overlay (`#modal-overlay-sign`, z-index 300), no backdrop-click close. Retry re-issues the exact same `sendTransaction` call with no modifications.
- **MSE cancel:** If cancelled after confirmed sources exist — tokens held in IT-EOA, refundable via admin `refund-all`.

---

## Security Notes

- IT private keys: local `.env` only. Never committed. Production: GCP KMS.
- Admin password: bcrypt `$2b$12$` hash stored in `admin_config`. 8-hour sessions.
- CORS: open `*` for testnet MVP. Tighten for production.
- No user input reaches `exec` or dynamic SQL — all queries use prepared statements with `?` parameters.

---

## Environment Variables

```env
IT_A_ADDRESS=0x...        IT_A_PRIVATE_KEY=0x...
IT_B_ADDRESS=0x...        IT_B_PRIVATE_KEY=0x...
IT_C_ADDRESS=0x...        IT_C_PRIVATE_KEY=0x...
IT_D_ADDRESS=0x...        IT_D_PRIVATE_KEY=0x...

RPC_A=https://...         # Ethereum Sepolia
RPC_B=https://...         # BNB Testnet
RPC_C=https://...         # Polygon Amoy
RPC_D=https://...         # Arbitrum Sepolia

CONTRACT_ADDRESS=0x494bfC3aB5fAe4066dc1F3D42F6e5b6938b70438
DB_PATH=./db/metaregistry.sqlite
PORT=3000

GAS_THRESHOLD_A=0.005     # ETH
GAS_THRESHOLD_B=0.005     # BNB
GAS_THRESHOLD_C=0.01      # MATIC
GAS_THRESHOLD_D=0.005     # ETH (Arbitrum)

ADMIN_PASSWORD=...        # plaintext on first boot; bcrypt hash stored in DB after
```

---

*MetaNetwork EQI — Architecture by Andrii · Prototype v0.1.0*
