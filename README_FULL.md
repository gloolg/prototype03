# MetaNetwork EQI — Technical Reference

> Full technical documentation for the MetaRegistry MVP backend.  
> For architecture overview see [README.md](./README.md).  
> Repository: [github.com/gloolg/prototype03](https://github.com/gloolg/prototype03)

---

## Repository Structure

```
prototype03/
├── README.md                      # Lightpaper — architecture overview
├── README_FULL.md                 # This file — full technical reference
├── contracts/tEQUI.sol            # ERC-20 token contract (deployed on 4 testnets)
├── deployments/deployments.json   # Contract addresses per network
├── docs/
│   ├── handover.md                # Historical MVP handover doc (2026-06-17) — predates dynamic-network + cabinet work, kept for architectural rationale only
│   └── demo-script.md             # Manual E2E curl walkthrough (fixed A/B/C/D examples)
├── simulator/src/                 # In-memory state simulator (stateless functions)
│   ├── simulator.js               # Entry point — assembles all modules
│   ├── constants.js               # Enums, invariant values, static NETWORKS list (A/B/C/D — see "Dynamic Network Support")
│   ├── stateFactory.js            # MasterState constructors
│   ├── genesis.js                 # Genesis initialization logic — N-network-agnostic (N≥1)
│   ├── treasury.js                # IT treasury distribution
│   ├── sourceResolution.js        # AUTOMATIC / USER_DEFINED source selection
│   ├── crossNetwork.js            # Cross-network transfer lifecycle
│   ├── invariants.js              # 9 invariants + traceability check — dynamic N-aware
│   ├── observation.js             # Observer reconciliation
│   ├── dappIntent.js              # DAppIntent create/validate + address-policy pre-check
│   ├── transparency.js            # getTransparencySnapshot / getEventHistory
│   ├── networkAllocation.js       # calculateActiveShares / calculateFrozenReserve (N-way A_ACTIVE split)
│   ├── networkRebalance.js        # rebalanceOnNetworkAdd — structural rebalance when a network joins
│   └── idGenerator.js             # Deterministic ID generation
└── backend/
    ├── src/
    │   ├── server.js              # Express app + startup sequence
    │   ├── db.js                  # SQLite schema (19 tables)
    │   ├── stateManager.js        # In-memory state + SQLite persistence bridge
    │   ├── observer/
    │   │   ├── index.js           # Polling scheduler (15s, staggered) — hardcoded to A/B/C/D, see gap below
    │   │   └── processor.js       # Per-network Transfer log processor
    │   ├── executor/
    │   │   ├── index.js           # On-chain delivery engine
    │   │   ├── networks.js        # RPC providers + IT-EOA signers — hardcoded NETWORK_CONFIG for A/B/C/D
    │   │   └── commandTypes.js    # COMMAND_TYPE enum
    │   ├── mse/manager.js         # Multi-source envelope state machine
    │   ├── cabinet/withdraw.js    # Cabinet withdrawal orchestrator (multi-network deduction)
    │   └── routes/
    │       ├── genesis.js         # POST /genesis
    │       ├── treasury.js        # POST /treasury/distribute
    │       ├── transfer.js        # POST /transfer
    │       ├── entry.js           # POST /entry
    │       ├── multiEntry.js      # POST /entry/multi/* (MSE flow)
    │       ├── registry.js        # GET /registry/* — hardcoded NETWORK_CONFIG for A/B/C/D
    │       ├── state.js           # GET /state
    │       ├── events.js          # GET /events
    │       ├── transparency.js    # GET /transparency
    │       ├── healthGas.js       # GET /health/gas — hardcoded to A/B/C/D
    │       ├── cabinet.js         # /cabinet/* (access_token / Bearer session auth)
    │       ├── admin.js           # /admin/* (auth-protected) — wallets, logs, stuck/refund recovery, network-add, cabinets
    │       ├── adminMse.js        # /admin/multi-envelopes/* (auth-protected)
    │       └── adminNetworks.js   # /admin/networks (auth-protected) — network_config CRUD, NOT yet wired to live state (see gap below)
    └── public/
        ├── index.html             # EQI DApp (served at / and /dapp/)
        ├── admin.html             # Admin panel (canonical: /admin/)
        ├── network.html           # Network config admin UI (canonical: /admin/network/)
        ├── cabinet.html           # Cabinet page (canonical: /cabinet/)
        └── transparency.html      # Public transparency dashboard (canonical: /transparency/)
```

**URL convention:** every page has exactly one canonical URL — the trailing-slash form (`/admin/`, `/admin/network/`, `/cabinet/`, `/transparency/`), matching the original `/dapp/` entry point. Every other spelling (no trailing slash, or the raw `.html` filename — both of which used to work silently and identically, since Express's default non-strict routing treats `/foo` and `/foo/` as the same pattern, and the catch-all static mount serves every file in `public/` at its literal name regardless of the app's routes) now `301`-redirects to the canonical form via `server.js`'s `servePageCanonical()`/`redirectTo()` helpers. The one exception is bare `GET /transparency` for non-browser clients: it stays a direct (unredirected) JSON response, since it's a documented public API contract (`curl $BASE/transparency`, used throughout `demo-script.md`) and curl/fetch don't follow redirects by default — only browser navigation to that bare path gets redirected to `/transparency/`.

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

## Dynamic Network Support (N≥1) — what's wired and what isn't

The system was originally hardcoded to exactly 4 networks (A/B/C/D). A refactor series (commits `02e696c`…`a270529`) made most of the accounting core **N-network-agnostic**, but the migration is **incomplete** — some modules still assume the fixed A/B/C/D set. This is the most important divergence from the original design and from what the file/endpoint names might suggest.

**Fully dynamic (reads `Object.keys(state.networks)` / `state.networks` at runtime):**
- `simulator/genesis.js` — `initializeGenesis()` accepts any `config.networks.length >= 1`, splits `A_ACTIVE` across N via `calculateActiveShares()`.
- `simulator/invariants.js` — `checkInvariants()` computes `TOTAL_MINTED_EXPECTED` / `TOTAL_FROZEN_EXPECTED` as `N × MINTED_PER_NETWORK`, not a fixed 400,000/300,000.
- `simulator/networkRebalance.js` — `rebalanceOnNetworkAdd(state, newNetworkId, A_ACTIVE)` structurally rebalances existing networks' `IT_ACTIVE`→`IT_FROZEN` and initializes the new network's share, keeping `A_ACTIVE` exact.
- `stateManager.js` — `getNetworkIds()`, `applyNetworkAdd()`, `restoreState()`, `canApplyTreasuryDistribution()` all derive the active network set from live state, not a constant.
- Routes `transfer.js`, `treasury.js`, `cabinet.js` — validate `network_id` against `Object.keys(sm.getState().networks)`.
- **`POST /admin/network-add`** (in `admin.js`) — the actual live endpoint that calls `sm.applyNetworkAdd()` and adds a network to the in-memory/SQLite MetaRegistry state via structural rebalance.

**Still hardcoded to A/B/C/D (would need code changes before a 5th network is fully operational):**
- `simulator/constants.js` — `NETWORKS` (the static priority list) is still `[A,B,C,D]`. `simulator/sourceResolution.js` → `resolveAutomaticSources()` iterates this static list, so **AUTOMATIC-mode cross-network transfers will never pull from a 5th network** even after `applyNetworkAdd()` — only `USER_DEFINED` mode (explicit per-network amounts) validates against live `state.networks` and would work.
- `backend/src/executor/networks.js` — `NETWORK_CONFIG`, `IT_ADDRESS` are hardcoded objects keyed `A/B/C/D`, sourced from `.env` (`IT_A_ADDRESS`, `RPC_A`, …). `getProvider()`/`getSigner()` throw `Unknown network_id` for anything else. **No on-chain execution is possible for a network outside this set.**
- `backend/src/routes/registry.js` — `NETWORK_CONFIG` (public config served to the DApp) is a hardcoded A/B/C/D object built from `.env`, not from `network_config` table.
- `backend/src/routes/entry.js`, `routes/multiEntry.js` — `IT_ADDRESSES()` reads `IT_A_ADDRESS`..`IT_D_ADDRESS` env vars directly; on-chain entry-tx verification only recognizes these 4.
- `backend/src/routes/healthGas.js` — gas-threshold monitoring list is hardcoded A/B/C/D.
- `backend/src/observer/index.js`, `observer/processor.js` — polling `NETWORKS = ['A','B','C','D']` and the `IT_ADDRESSES` filter set are hardcoded; a 5th network's on-chain transfers would never be observed.
- `backend/src/cabinet/withdraw.js` — `NETWORK_ORDER` and `RESERVED_COL` are hardcoded to A/B/C/D; the `cabinets` table itself only has `reserved_A..reserved_D` columns (schema change needed for a 5th network).

**`/admin/networks` (`adminNetworks.js` + `network.html`, table `network_config`) is a separate, not-yet-integrated feature.** It lets an admin store RPC URL / chain ID / contract address / IT-EOA address+private key for a *prospective* network (validated, private key never logged or returned by `GET`). But **nothing currently reads from `network_config`** — it is not consumed by `executor/networks.js`, `registry.js`, `observer/`, or `stateManager.applyNetworkAdd()`. Today, adding a network end-to-end requires: (1) hardcoding its RPC/IT-EOA/threshold into `.env` and the modules listed above, then (2) calling `POST /admin/network-add` to rebalance the ledger. `/admin/networks` appears to be staging for a future step that unifies these two paths — treat it as configuration storage only, not an activation switch, until that wiring exists.

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
| GET | `/transparency` | — | Content-negotiated: JSON snapshot (invariants, totals, per-network breakdown) for API clients; browser navigation `301`s to the `/transparency/` dashboard page instead |

### Token Operations

| Method | Path | Auth | Description |
|---|---|---|---|
| POST | `/treasury/distribute` | — | Move tEQUI from `IT_ACTIVE` to tester wallet. Enforces 60/40 corridor. Triggers Executor delivery. Body: `{network_id, wallet_address, amount, command_id?}`. **Unauthenticated** — `command_id` is optional and client-suppliable for idempotency; reusing one with different `network_id`/`wallet_address`/`amount` is rejected (`COMMAND_ID_PARAM_MISMATCH`), not silently applied against the cached tx_hash from the original call (see Executor Idempotency below) |
| POST | `/transfer` | — | **Operator endpoint.** Direct MetaRegistry state update without on-chain verification. Modes: `AUTOMATIC` (priority A→B→C→D) or `USER_DEFINED` (explicit per-network amounts). Not used by DApp. Same-network transfers reject `sender === recipient` (`SELF_TRANSFER_NOT_ALLOWED`) |

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
| POST | `/admin/auth` | Login — returns Bearer token (8h session). Body: `{password}` |
| POST | `/admin/logout` | Invalidate session |
| POST | `/admin/network-add` | Add a network to the live MetaRegistry via structural rebalance (`sm.applyNetworkAdd`). Body: `{network_id, it_address}`. **Only extends ledger accounting — does not add RPC/execution support**, see "Dynamic Network Support" above |
| POST | `/admin/register-wallet` | Add wallet to MetaRegistry. Body: `{address, network_ids: []}` |
| GET | `/admin/wallets` | All registered wallets with MetaRegistry balances (from SQLite cache, not live RPC) |
| GET | `/admin/logs` | `event_record` + `execution_log` — recent events and Executor commands (`?limit=`) |
| GET | `/admin/entry-blocks` | `observer_seen_txs` — processed tx hashes |
| DELETE | `/admin/entry-blocks/:tx_hash` | Remove idempotency row to allow `/entry` replay |
| GET | `/admin/onchain-invariant` | Live `balanceOf` comparison: MetaRegistry vs on-chain per IT-EOA and known wallets |
| GET | `/admin/unprocessed-entries` | Wallet→IT-EOA txs seen by Observer but not matched to `/entry` call |
| POST | `/admin/create-stuck-delivery` | Manually register a delivery obligation as STUCK (recovery tool when `/entry` was lost) |
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
| POST | `/admin/cabinets/create` | Create a cabinet (user-facing balance account), reserving `initial_amount/4` from `IT_ACTIVE` on each of A/B/C/D. Body: `{initial_amount}` (must be divisible by 4) |
| GET | `/admin/cabinets` | List all cabinets + per-network reserved totals |
| GET | `/admin/cabinets/:cabinet_id/token` | Retrieve a cabinet's `access_token` (to hand to the end user) |
| GET | `/admin/networks` | List `network_config` rows (prospective networks) — no private keys returned |
| POST | `/admin/networks` | Store RPC/chain-id/contract/IT-EOA config for a prospective network in `network_config`. **Storage only — see "Dynamic Network Support"** |
| PATCH | `/admin/networks/:id/rpc` | Update `rpc_url` for a stored network config |

### Cabinet (access_token auth)

User-facing balance page — no MetaMask required. Access controlled by a pre-issued `access_token` stored in the `cabinets` DB table.

| Method | Path | Auth | Description |
|---|---|---|---|
| GET | `/cabinet` | — | Serves `cabinet.html` static page |
| POST | `/cabinet/auth` | — | Exchange `access_token` → Bearer session token (8h). Body: `{access_token}` |
| GET | `/cabinet/balance` | Bearer | Cabinet total balance + per-network reserved amounts. Response: `{ok, total_balance, reserved:{A,B,C,D}}` |
| POST | `/cabinet/withdraw` | Bearer | Initiate tEQUI withdrawal to an external address. Body: `{recipient, target_network, amount}`. Response: `{ok, withdraw_id, steps}` |
| GET | `/cabinet/withdraw/:withdraw_id/status` | Bearer | Poll withdrawal status + step log. Response: `{ok, withdrawal, steps}` |

---

## Database Schema (19 tables)

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

### `cabinets`
User-facing balance account, access-controlled by `access_token`. `total_balance` must always equal `reserved_A+reserved_B+reserved_C+reserved_D` (enforced belt-and-suspenders in `cabinet/withdraw.js`). Hardcoded to 4 reserved-network columns — see "Dynamic Network Support".
```
cabinet_id TEXT PK | access_token TEXT UNIQUE | total_balance INT
reserved_A INT | reserved_B INT | reserved_C INT | reserved_D INT | created_at INT
```

### `cabinet_sessions`
Bearer sessions issued by `POST /cabinet/auth` from a valid `access_token`. 8-hour TTL.
```
token TEXT PK | cabinet_id TEXT FK | created_at INT | expires_at INT
```

### `cabinet_withdrawals`
One row per `POST /cabinet/withdraw` call.
```
withdraw_id TEXT PK | cabinet_id TEXT FK | recipient TEXT | target_network TEXT
total_amount INT | status TEXT ('PENDING'|'IN_PROGRESS'|'COMPLETED'|'PARTIAL_FAILED') | created_at INT
```

### `cabinet_withdrawal_steps`
One row per network touched by a withdrawal (target network first, then A→B→C→D minus target, per `NETWORK_ORDER`). `command_id` is the Executor idempotency key.
```
id INT PK | withdraw_id TEXT FK | network_id TEXT | amount INT
command_id TEXT UNIQUE | status TEXT ('PENDING'|'COMPLETED'|'FAILED') | tx_hash TEXT | error TEXT
UNIQUE(withdraw_id, network_id)
```

### `network_config`
Admin-managed storage for prospective (not-yet-live) network configs — RPC URL, chain ID, contract address, IT-EOA address+**private key** (plaintext, see Security Notes). **Not read by any other module yet** — see "Dynamic Network Support". Managed via `/admin/networks`.
```
network_id TEXT PK | network_name TEXT | chain_type TEXT DEFAULT 'EVM' | rpc_url TEXT | chain_id INT
contract_address TEXT | it_eoa_address TEXT | it_eoa_private_key TEXT | symbol TEXT DEFAULT 'tEQUI'
explorer_url TEXT | created_at INT | updated_at INT
```

---

## Observer

**Polling:** Hardcoded to networks A/B/C/D (`observer/index.js` — `NETWORKS = ['A','B','C','D']`), each polled independently every 15s. Stagger offsets: A+0s, B+4s, C+8s, D+12s (avoids simultaneous RPC bursts). A network added via `POST /admin/network-add` is **not** picked up here — see "Dynamic Network Support".

**Per-poll flow:**
1. Read `observer_checkpoint.last_block` for this network
2. Fetch current block from RPC
3. No checkpoint → bootstrap: save current block, return (no historical scan)
4. Fetch `Transfer` logs in chunks (default 10 blocks/chunk, capped at 100 blocks/poll; per-network override via `MAX_GET_LOGS_BLOCK_RANGE_<NET>`)
5. Filter OUT: IT-EOA-initiated transfers (Executor outputs, skipped entirely)
6. Transfers TO an IT-EOA are recorded into `pending_entries` (for the admin `/admin/unprocessed-entries` view) but **not** passed to `applyObservation` — they're the Entry flow's job, not Observer's
7. For each remaining log: check `observer_seen_txs` idempotency → call `applyObservation`; fractional (non-10^18-divisible) amounts are skipped with a warning and still marked seen
8. Update `observer_checkpoint` after each successful chunk

**Idempotency:** `(tx_hash, log_index)` composite key in `observer_seen_txs`. Observer uses real `log_index`. `/entry` uses `log_index = -1` to claim the same tx hash — this prevents Observer from re-processing an Entry tx and decrementing `wallet_active` again. MSE source confirmations (`/entry/multi/:id/submit`) claim the tx with its **real** `log_index` (not -1), since re-using -1 there would let Observer double-process the same log before `tryDeliver` runs.

---

## Executor

**Command types** (`executor/commandTypes.js`):
- `TREASURY_DISTRIBUTION` — IT-EOA → tester wallet
- `CROSS_NETWORK_ENTRY` — IT-EOA → recipient after `/entry`
- `MSE_DELIVERY` — IT-EOA → recipient after all MSE sources confirmed
- `REFUND` — IT-EOA → original sender (stuck delivery or MSE refund)
- `CABINET_WITHDRAW` — IT-EOA → external recipient (Cabinet withdrawal step)
- `CROSS_NETWORK_EXIT` — defined but unused (reserved for a future step)

**Idempotency:** `command_id` is unique per operation (e.g. `entry:<tx_hash>`, `mse:deliver:<envelope_id>`, `mse:refund:<envelope_id>:<network>`, `cabinet:withdraw:<withdraw_id>:<network_id>`). On server restart, all `PENDING` rows in `execution_log` are set to `FAILED` — requires admin review.

A cached `COMPLETED` hit is only returned if the incoming `network_id`/`to_address`/`amount` match the row that was actually executed (address comparison case-insensitive); otherwise `executeCommand` returns `{ok:false, reason:'COMMAND_ID_PARAM_MISMATCH'}`. Every other caller derives `command_id` from server-controlled or on-chain-verified data, so this only matters in practice for `POST /treasury/distribute` — the one endpoint that accepts a client-supplied `command_id` directly, on an unauthenticated route. Without this check, reusing an old `command_id` with a different `network_id`/`wallet_address`/`amount` would return the *original* call's `tx_hash` as "proof" while crediting the *new* request's amount to the *new* recipient — a ledger credit with no matching on-chain transfer.

**Pre-flight:** `canApplyTreasuryDistribution` validates invariants before spending gas on a distribution that would be rejected.

**Signing:** `getSigner()` builds an `ethers.Wallet` from a `.env` private key per network (`executor/networks.js`). GCP KMS migration is a drop-in replacement for this one function; not yet done.

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

## Cabinet (no-MetaMask user balance portal)

A separate accounting layer on top of the MetaRegistry, for end users who hold `access_token` credentials instead of a wallet. Admin-created and admin-funded; the cabinet itself never touches on-chain state until a withdrawal is initiated.

- **Creation** (`POST /admin/cabinets/create`): admin picks `initial_amount` (must be divisible by 4); the amount is reserved in equal quarters (`reserved_A..D`) against **free** `IT_ACTIVE` on each of the network's **hardcoded** `CABINET_NETS = ['A','B','C','D']` (deliberately not the dynamic network list — the `cabinets` table has no columns beyond `reserved_D`, so a 5th live network is simply not considered here rather than silently mis-checked). Free = `IT_ACTIVE − SUM(reserved_X across all cabinets)`. Fails if any of the 4 networks lacks enough free `IT_ACTIVE`; rolls back on a post-create invariant violation.
- **Auth**: `POST /cabinet/auth` exchanges the pre-issued `access_token` for an 8-hour Bearer session token (`cabinet_sessions`), same pattern as admin sessions.
- **Balance**: `GET /cabinet/balance` returns `total_balance` and the per-network `reserved_*` breakdown — this is a ledger entry, not a live on-chain balance (the tokens are still sitting in the IT-EOAs until withdrawn).
- **Withdrawal** (`cabinet/withdraw.js`, `processWithdraw()`): builds a deduction plan — target network first, then A→B→C→D minus target (`NETWORK_ORDER`, hardcoded) — taking from `reserved_*` until `amount` is covered. Persists `cabinet_withdrawals` + one `cabinet_withdrawal_steps` row per network touched, then executes each step **sequentially** via `executeCommand(CABINET_WITHDRAW)`. Stops on first failure (`PARTIAL_FAILED`) — later steps are not attempted, leaving partial delivery + a reduced-but-still-correct reserved balance (already-completed steps decremented `reserved_*`/`total_balance`).
- **Invariant check**: after each successful step, `_checkCabinetInvariant()` verifies `(a)` `total_balance === SUM(reserved_*)` for that cabinet and `(b)` `SUM(reserved_X over all cabinets) <= IT_ACTIVE_X`. A violation only indicates a bug in this module's own bookkeeping (not user-triggerable) and sets `reconciliation_required: true` on the response — it does not roll back the already-completed on-chain transfer.
- **State sync**: on each successful step, `sm.applyCabinetWithdraw()` decrements `IT_ACTIVE` and credits the recipient wallet in-memory/SQLite (marks it `is_cabinet: true` if newly created); `A_ACTIVE` is unchanged (`IT_ACTIVE ↓`, `wallet_active ↑`, net zero).

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

- IT private keys (live A/B/C/D): local `.env` only. Never committed. Production: GCP KMS.
- **IT private keys (prospective networks, `network_config.it_eoa_private_key`): stored in SQLite as plaintext.** Never logged (`adminNetworks.js` explicitly avoids logging `req.body`) and never returned by `GET /admin/networks`, but at-rest encryption is not implemented — anyone with read access to `db/metaregistry.sqlite` can read these keys. Acceptable for local MVP use only; must be addressed (KMS/encryption-at-rest) before this table holds anything that touches real value.
- Admin password: bcrypt hash (via `bcryptjs`, not the native `bcrypt` package) stored in `admin_config`. 8-hour sessions (also used unchanged for Cabinet sessions and the `/admin/networks` panel).
- CORS: open `*` for testnet MVP. Tighten for production.
- No user input reaches `exec` or dynamic SQL — all queries use prepared statements with `?` parameters. `adminNetworks.js` validates `network_id` against `^[A-Za-z0-9-]{1,10}$` before use, and EVM fields (`it_eoa_address`, `it_eoa_private_key`, `contract_address`, `chain_id`) against format-specific regexes/`parseInt`.
- `POST /treasury/distribute` is unauthenticated (see API Reference) and accepts a client-supplied `command_id`; `executeCommand` rejects reuse of a `command_id` with different `network_id`/`to_address`/`amount` rather than applying a mismatched request against the original cached `tx_hash` (see Executor above).
- Same-network self-transfer (`sender === recipient`) is rejected at every layer that can reach it: `/entry`, `/entry/multi/create` (route-level `SELF_TRANSFER_NOT_ALLOWED`), and `simulator/crossNetwork.js`'s `applySameNetworkThroughMetaRegistry` itself (covers `/transfer` and any other caller) — without the latter, `sender`/`recipient` resolve to the same wallet object and the balance change silently cancels out while still logging a full `OPERATION_COMPLETED` event.

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

Adding a 5th network is **not** just an env-var addition today — see "Dynamic Network Support" above for the full list of hardcoded A/B/C/D touchpoints (`executor/networks.js`, `routes/registry.js`, `routes/entry.js`, `routes/multiEntry.js`, `routes/healthGas.js`, `observer/`, `cabinet/withdraw.js`, `simulator/constants.js` NETWORKS list) that must be updated alongside `.env` and `POST /admin/network-add`.

---

*MetaNetwork EQI — Architecture by Andrii · Prototype v0.1.0*
