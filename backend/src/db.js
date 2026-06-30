'use strict';

/**
 * db.js — SQLite initialization and schema
 * MetaRegistry MVP Backend
 *
 * Tables:
 *   network_state      — per-network active/frozen totals
 *   treasury_state     — IT treasury active/frozen per network
 *   wallet_balance     — per-wallet balances per network
 *   event_record       — append-only event log (immutable after insert)
 *   invariant_snapshot — point-in-time invariant snapshots
 */

require('dotenv').config();
const Database = require('better-sqlite3');
const path = require('path');
const fs = require('fs');

const DB_PATH = process.env.DB_PATH || './db/metaregistry.sqlite';

// Ensure the directory exists
const dbDir = path.dirname(path.resolve(DB_PATH));
if (!fs.existsSync(dbDir)) {
  fs.mkdirSync(dbDir, { recursive: true });
}

const db = new Database(path.resolve(DB_PATH));

// Enable WAL mode for better concurrent read performance
db.pragma('journal_mode = WAL');
// Enforce foreign keys
db.pragma('foreign_keys = ON');

// ---------------------------------------------------------------------------
// Schema
// ---------------------------------------------------------------------------

db.exec(`

  -- -------------------------------------------------------------------------
  -- network_state
  -- One row per network. Tracks total active and frozen tEQUI on that network.
  -- network_id: 'A' | 'B' | 'C' | 'D'
  -- -------------------------------------------------------------------------
  CREATE TABLE IF NOT EXISTS network_state (
    network_id        TEXT PRIMARY KEY,          -- 'A' | 'B' | 'C' | 'D'
    network_name      TEXT NOT NULL,             -- human-readable label
    total_active      INTEGER NOT NULL DEFAULT 0,
    total_frozen      INTEGER NOT NULL DEFAULT 0,
    total_unavailable INTEGER NOT NULL DEFAULT 0,
    is_initialized    INTEGER NOT NULL DEFAULT 0, -- 0=false, 1=true
    initialized_at    INTEGER,                   -- Unix seconds
    updated_at        INTEGER NOT NULL DEFAULT (unixepoch())
  );

  -- -------------------------------------------------------------------------
  -- treasury_state
  -- IT (Internal Treasury) EOA per network.
  -- One row per network.
  -- -------------------------------------------------------------------------
  CREATE TABLE IF NOT EXISTS treasury_state (
    network_id        TEXT PRIMARY KEY,
    it_address        TEXT NOT NULL,             -- EOA address (GCP KMS)
    active_balance    INTEGER NOT NULL DEFAULT 0,
    frozen_balance    INTEGER NOT NULL DEFAULT 0,
    updated_at        INTEGER NOT NULL DEFAULT (unixepoch()),
    FOREIGN KEY (network_id) REFERENCES network_state(network_id)
  );

  -- -------------------------------------------------------------------------
  -- wallet_balance
  -- Per-wallet, per-network balances.
  -- address + network_id = unique key.
  -- -------------------------------------------------------------------------
  CREATE TABLE IF NOT EXISTS wallet_balance (
    id                INTEGER PRIMARY KEY AUTOINCREMENT,
    address           TEXT NOT NULL,             -- wallet address (checksummed)
    network_id        TEXT NOT NULL,
    active_balance    INTEGER NOT NULL DEFAULT 0,
    frozen_balance    INTEGER NOT NULL DEFAULT 0,
    wallet_type       TEXT NOT NULL DEFAULT 'EXTERNAL', -- 'EXTERNAL' | 'COLD' | 'IT' | 'TESTER'
    updated_at        INTEGER NOT NULL DEFAULT (unixepoch()),
    FOREIGN KEY (network_id) REFERENCES network_state(network_id),
    UNIQUE (address, network_id)
  );

  -- -------------------------------------------------------------------------
  -- event_record
  -- Append-only. Rows are NEVER updated or deleted after insert.
  -- Mirrors EventRecord from simulator.
  -- -------------------------------------------------------------------------
  CREATE TABLE IF NOT EXISTS event_record (
    id                INTEGER PRIMARY KEY AUTOINCREMENT,
    event_id          TEXT NOT NULL UNIQUE,      -- deterministic ID from idGenerator
    event_type        TEXT NOT NULL,             -- e.g. GENESIS, TRANSFER, FREEZE, STOP ...
    network_id        TEXT,                      -- nullable for global events
    from_address      TEXT,
    to_address        TEXT,
    amount            INTEGER,
    source_type       TEXT,                      -- AUTOMATIC | USER_DEFINED | null
    status            TEXT NOT NULL,             -- SUCCESS | REJECTED | PENDING
    rejection_code    TEXT,                      -- null if SUCCESS
    metadata          TEXT,                      -- JSON string for extra fields
    created_at        INTEGER NOT NULL DEFAULT (unixepoch())
  );

  -- Index for fast queries by network and type
  CREATE INDEX IF NOT EXISTS idx_event_network    ON event_record(network_id);
  CREATE INDEX IF NOT EXISTS idx_event_type       ON event_record(event_type);
  CREATE INDEX IF NOT EXISTS idx_event_created_at ON event_record(created_at);

  -- -------------------------------------------------------------------------
  -- invariant_snapshot
  -- Point-in-time snapshot of all 9 invariants.
  -- Taken after every state-changing operation.
  -- -------------------------------------------------------------------------
  CREATE TABLE IF NOT EXISTS invariant_snapshot (
    id                    INTEGER PRIMARY KEY AUTOINCREMENT,
    snapshot_id           TEXT NOT NULL UNIQUE,  -- deterministic ID
    triggered_by_event_id TEXT NOT NULL,         -- which event caused this snapshot
    total_minted          INTEGER NOT NULL,
    a_active              INTEGER NOT NULL,
    total_frozen          INTEGER NOT NULL,
    -- per-network active (stored as JSON for flexibility)
    network_active_json   TEXT NOT NULL,         -- e.g. {"A":25000,"B":25000,...}
    -- per-network frozen
    network_frozen_json   TEXT NOT NULL,
    all_invariants_pass   INTEGER NOT NULL,      -- 0=false, 1=true
    failed_invariants     TEXT,                  -- JSON array of failed invariant names, null if all pass
    created_at            INTEGER NOT NULL DEFAULT (unixepoch())
  );

  -- -------------------------------------------------------------------------
  -- observer_checkpoint
  -- Persists last fully-processed block per network.
  -- Updated AFTER all events for a block range are written to event_record.
  -- On restart: resume from last_block+1 (never skip, never double-process
  -- completed blocks; partial last block is safe via observer_seen_txs).
  -- -------------------------------------------------------------------------
  CREATE TABLE IF NOT EXISTS observer_checkpoint (
    network_id   TEXT PRIMARY KEY,
    last_block   INTEGER NOT NULL DEFAULT 0,
    updated_at   INTEGER NOT NULL DEFAULT (unixepoch())
  );

  -- -------------------------------------------------------------------------
  -- observer_seen_txs
  -- Idempotency table for individual Transfer log entries.
  -- Guards against double-processing the last (incomplete) block on restart.
  -- Primary key: (tx_hash, log_index) — globally unique per on-chain event.
  -- -------------------------------------------------------------------------
  CREATE TABLE IF NOT EXISTS observer_seen_txs (
    tx_hash      TEXT NOT NULL,
    log_index    INTEGER NOT NULL,
    network_id   TEXT NOT NULL,
    processed_at INTEGER NOT NULL DEFAULT (unixepoch()),
    PRIMARY KEY (tx_hash, log_index)
  );

  -- -------------------------------------------------------------------------
  -- pending_entries
  -- Populated by Observer when it detects a wallet→IT-EOA Transfer on-chain.
  -- These transfers are the first step of the /entry flow (peer sends tEQUI
  -- to IT-EOA to initiate a cross-network transfer).
  -- A row is considered "unprocessed" if there is no corresponding row in
  -- observer_seen_txs with log_index=-1 (which /entry inserts on success).
  -- Admin can view unprocessed entries via GET /admin/unprocessed-entries.
  -- -------------------------------------------------------------------------
  CREATE TABLE IF NOT EXISTS pending_entries (
    tx_hash      TEXT NOT NULL,
    log_index    INTEGER NOT NULL,
    network_id   TEXT NOT NULL,
    from_address TEXT NOT NULL,
    amount       INTEGER NOT NULL,
    block_number INTEGER NOT NULL,
    detected_at  INTEGER NOT NULL DEFAULT (unixepoch()),
    PRIMARY KEY (tx_hash, log_index)
  );

  -- -------------------------------------------------------------------------
  -- stuck_entries
  -- On-chain tx arrived at IT-EOA and was verified, but applyTransfer returned
  -- !ok (e.g. SYSTEM_STOP). Tokens are NOT lost — they sit in IT-EOA — but the
  -- MetaRegistry quota was not granted to the sender.
  -- Admin can view via GET /admin/stuck-entries and unlock via DELETE /admin/stuck-entries/:tx_hash,
  -- which removes the observer_seen_txs idempotency row so /entry can be retried.
  -- -------------------------------------------------------------------------
  CREATE TABLE IF NOT EXISTS stuck_entries (
    tx_hash        TEXT PRIMARY KEY,
    source_network TEXT NOT NULL,
    amount         INTEGER NOT NULL,
    from_address   TEXT NOT NULL,
    reason         TEXT NOT NULL,
    created_at     INTEGER NOT NULL DEFAULT (unixepoch())
  );

  -- -------------------------------------------------------------------------
  -- admin_config
  -- Key-value store for admin settings (e.g. hashed password).
  -- -------------------------------------------------------------------------
  CREATE TABLE IF NOT EXISTS admin_config (
    key   TEXT PRIMARY KEY,
    value TEXT NOT NULL
  );

  -- -------------------------------------------------------------------------
  -- admin_sessions
  -- Active admin sessions (token → expiry). Cleaned up on login.
  -- -------------------------------------------------------------------------
  CREATE TABLE IF NOT EXISTS admin_sessions (
    token      TEXT PRIMARY KEY,
    created_at INTEGER NOT NULL DEFAULT (unixepoch()),
    expires_at INTEGER NOT NULL
  );

  -- -------------------------------------------------------------------------
  -- execution_log
  -- Executor idempotency table. One row per command_id.
  -- NEVER updated to COMPLETED unless on-chain tx confirmed.
  -- -------------------------------------------------------------------------
  CREATE TABLE IF NOT EXISTS execution_log (
    command_id    TEXT PRIMARY KEY,
    command_type  TEXT NOT NULL,
    network_id    TEXT NOT NULL,
    to_address    TEXT NOT NULL,
    amount        INTEGER NOT NULL,
    envelope_id   TEXT,
    status        TEXT NOT NULL DEFAULT 'PENDING',  -- PENDING | COMPLETED | FAILED
    tx_hash       TEXT,
    block_number  INTEGER,
    error_reason  TEXT,
    created_at    INTEGER NOT NULL DEFAULT (unixepoch()),
    completed_at  INTEGER
  );

`);

// Migration: add total_unavailable column for existing DBs (C3 fix)
try {
  db.exec('ALTER TABLE network_state ADD COLUMN total_unavailable INTEGER NOT NULL DEFAULT 0');
} catch (_) {}

// Migration: add priority column for dynamic N support
try {
  db.exec('ALTER TABLE network_state ADD COLUMN priority INTEGER NOT NULL DEFAULT 0');
} catch (_) {}

// Migration: add source_network + from_address to execution_log for STUCK/refund support
try {
  db.exec('ALTER TABLE execution_log ADD COLUMN source_network TEXT');
} catch (_) {}
try {
  db.exec('ALTER TABLE execution_log ADD COLUMN from_address TEXT');
} catch (_) {}

// MSE: multi-source envelope tables
db.exec(`
  CREATE TABLE IF NOT EXISTS mse_envelope (
    envelope_id      TEXT PRIMARY KEY,
    target_network   TEXT NOT NULL,
    recipient        TEXT NOT NULL,
    total_amount     INTEGER NOT NULL,
    source_count     INTEGER NOT NULL,
    confirmed_count  INTEGER NOT NULL DEFAULT 0,
    status           TEXT NOT NULL DEFAULT 'COLLECTING',
    transfer_applied INTEGER NOT NULL DEFAULT 0,
    first_entry_at   INTEGER,
    timeout_at       INTEGER,
    created_at       INTEGER NOT NULL DEFAULT (unixepoch()),
    completed_at     INTEGER,
    error_reason     TEXT
  );

  CREATE TABLE IF NOT EXISTS mse_source (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    envelope_id     TEXT NOT NULL REFERENCES mse_envelope(envelope_id),
    source_network  TEXT NOT NULL,
    from_address    TEXT NOT NULL,
    expected_amount INTEGER NOT NULL,
    actual_amount   INTEGER,
    tx_hash         TEXT,
    log_index       INTEGER,
    status          TEXT NOT NULL DEFAULT 'PENDING',
    confirmed_at    INTEGER,
    UNIQUE (envelope_id, source_network)
  );
`);

// Cabinet: access_token-based user-facing balance accounts
db.exec(`
  CREATE TABLE IF NOT EXISTS cabinets (
    cabinet_id    TEXT PRIMARY KEY,
    access_token  TEXT NOT NULL UNIQUE,
    total_balance INTEGER NOT NULL DEFAULT 0,
    reserved_A    INTEGER NOT NULL DEFAULT 0,
    reserved_B    INTEGER NOT NULL DEFAULT 0,
    reserved_C    INTEGER NOT NULL DEFAULT 0,
    reserved_D    INTEGER NOT NULL DEFAULT 0,
    created_at    INTEGER NOT NULL DEFAULT (unixepoch())
  );

  CREATE TABLE IF NOT EXISTS cabinet_sessions (
    token      TEXT PRIMARY KEY,
    cabinet_id TEXT NOT NULL REFERENCES cabinets(cabinet_id),
    created_at INTEGER NOT NULL DEFAULT (unixepoch()),
    expires_at INTEGER NOT NULL
  );

  CREATE TABLE IF NOT EXISTS cabinet_withdrawals (
    withdraw_id    TEXT PRIMARY KEY,
    cabinet_id     TEXT NOT NULL REFERENCES cabinets(cabinet_id),
    recipient      TEXT NOT NULL,
    target_network TEXT NOT NULL,
    total_amount   INTEGER NOT NULL,
    status         TEXT NOT NULL DEFAULT 'PENDING',
    created_at     INTEGER NOT NULL DEFAULT (unixepoch())
  );

  CREATE TABLE IF NOT EXISTS cabinet_withdrawal_steps (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    withdraw_id TEXT NOT NULL REFERENCES cabinet_withdrawals(withdraw_id),
    network_id  TEXT NOT NULL,
    amount      INTEGER NOT NULL,
    command_id  TEXT NOT NULL UNIQUE,
    status      TEXT NOT NULL DEFAULT 'PENDING',
    tx_hash     TEXT,
    error       TEXT,
    created_at  INTEGER NOT NULL DEFAULT (unixepoch()),
    UNIQUE (withdraw_id, network_id)
  );
`);

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Returns current Unix timestamp in seconds.
 */
function now() {
  return Math.floor(Date.now() / 1000);
}

/**
 * Wraps multiple db operations in a single transaction.
 * Usage: runTransaction(() => { ... })
 */
function runTransaction(fn) {
  return db.transaction(fn)();
}

module.exports = { db, now, runTransaction };
