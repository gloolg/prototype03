'use strict';

/**
 * stateManager.js — In-memory state + SQLite persistence (Variant A)
 *
 * Responsibilities:
 *   1. Hold the single MasterState instance in RAM
 *   2. After every mutating operation — persist changes to SQLite
 *   3. On startup — restore state from SQLite if data exists
 *
 * All routes interact ONLY through this module.
 * The simulator functions are called here, never directly from routes.
 *
 * Simulator path (relative to backend/src/):
 *   ../../simulator/src/simulator.js
 */

const path = require('path');
const { db, now, runTransaction } = require('./db');

// ─── Load simulator ───────────────────────────────────────────────────────────
// Simulator lives in ../simulator/src/ relative to the repo root.
// backend/ and simulator/ are siblings under metanetwork-eqi/.
const SIMULATOR_PATH  = path.resolve(__dirname, '../../simulator/src/simulator.js');
const IDGEN_PATH      = path.resolve(__dirname, '../../simulator/src/idGenerator.js');
const sim             = require(SIMULATOR_PATH);
const { seedCounters } = require(IDGEN_PATH);

// Single source of truth for network IDs — mirrors simulator/src/constants.js
const NETWORK_IDS = sim.NETWORK_IDS || ['A', 'B', 'C', 'D'];

// Lazy-required to avoid circular deps at module load time (networks.js → no stateManager import)
function _networks() { return require('./executor/networks'); }

// ─── In-memory state singleton ───────────────────────────────────────────────
let _state = null;

// ─── getState ─────────────────────────────────────────────────────────────────
// Returns current in-memory state. Throws if not initialized.
function getState() {
  if (!_state) {
    throw new Error('MetaRegistry not initialized. Call POST /genesis first.');
  }
  return _state;
}

// ─── isInitialized ───────────────────────────────────────────────────────────
function isInitialized() {
  return _state !== null && _state.genesis_complete === true;
}

// ─── persistState ─────────────────────────────────────────────────────────────
// Writes current in-memory state to SQLite.
// Called after every mutating operation.
// Uses a single transaction for atomicity.
function persistState(state) {
  runTransaction(() => {
    _persistNetworks(state);
    _persistTreasuries(state);
    _persistWallets(state);
    _persistNewEvents(state);
    _persistNewSnapshots(state);
  });
}

// ─── restoreState ─────────────────────────────────────────────────────────────
// On server startup: check if SQLite has data.
// If yes — rebuild in-memory state from DB.
// If no — return false (genesis required).
function restoreState() {
  const networks = db.prepare('SELECT * FROM network_state').all();
  if (networks.length === 0) {
    console.log('[stateManager] No persisted state found. Genesis required.');
    return false;
  }

  console.log('[stateManager] Restoring state from SQLite...');

  // Rebuild MasterState skeleton
  const state = sim.createMasterState();

  // Restore networks
  for (const row of networks) {
    state.networks[row.network_id] = {
      network_id:          row.network_id,
      network_name:        row.network_name,
      priority:            _networkPriority(row.network_id),
      token_contract:      `mock_contract_${row.network_id}`,
      it_address:          _itAddressFromTreasury(row.network_id),
      status:              'ACTIVE',
      wallet_active_total: row.total_active - _itActiveFromTreasury(row.network_id),
      IT_ACTIVE:           0, // will be filled from treasury_state below
      IT_FROZEN:           0,
      UNAVAILABLE:         row.total_unavailable || 0,
      get network_total() {
        return this.wallet_active_total + this.IT_ACTIVE + this.IT_FROZEN + this.UNAVAILABLE;
      },
    };
  }

  // Restore treasuries
  const treasuries = db.prepare('SELECT * FROM treasury_state').all();
  for (const row of treasuries) {
    const net = state.networks[row.network_id];
    if (net) {
      net.IT_ACTIVE = row.active_balance;
      net.IT_FROZEN = row.frozen_balance;
      // Recalculate wallet_active_total correctly
      net.wallet_active_total = _walletActiveTotalFromDB(row.network_id);
    }
    state.treasuries[row.network_id] = {
      network_id: row.network_id,
      it_id:      `IT-${row.network_id}`,
      it_address: row.it_address,
      IT_ACTIVE:  row.active_balance,
      IT_FROZEN:  row.frozen_balance,
      latest_state_hash: `restored_${row.network_id}`,
    };
  }

  // Restore wallets — normalize all keys/addresses to lowercase.
  // Genesis may store mixed-case addresses; entry/observer use lowercase.
  // On duplicate lowercase key, keep the entry with the higher balance.
  const wallets = db.prepare('SELECT * FROM wallet_balance').all();
  for (const row of wallets) {
    const addr = row.address.toLowerCase();
    const key  = `${row.network_id}:${addr}`;
    const existing = state.wallets[key];
    if (existing && existing.wallet_active >= row.active_balance) continue;
    state.wallets[key] = {
      network_id:                   row.network_id,
      wallet_address:               addr,
      wallet_active:                row.active_balance,
      is_predefined_tester_address: row.wallet_type === 'EXTERNAL' || row.wallet_type === 'TESTER' || row.wallet_type === 'IT',
      is_cold_wallet:               row.wallet_type === 'COLD',
      is_external_registered:       row.wallet_type === 'EXTERNAL',
      is_cabinet:                   row.wallet_type === 'CABINET',
      last_seen_at:                 row.updated_at * 1000,
    };
  }

  // Restore events (append-only, order by id)
  const events = db.prepare('SELECT * FROM event_record ORDER BY id ASC').all();
  for (const row of events) {
    state.events.push(Object.freeze({
      event_id:    row.event_id,
      event_type:  row.event_type,
      envelope_id: null,
      network_id:  row.network_id,
      from_address: row.from_address,
      to_address:   row.to_address,
      amount:       row.amount,
      state_before: null,
      state_after:  null,
      evidence:     row.metadata,
      created_at:   row.created_at * 1000,
    }));
  }

  // Restore snapshots
  const snapshots = db.prepare('SELECT * FROM invariant_snapshot ORDER BY id ASC').all();
  for (const row of snapshots) {
    state.snapshots.push(Object.freeze({
      snapshot_id:         row.snapshot_id,
      phase:               'post_completion',
      active_current:      row.a_active,
      frozen_current:      row.total_frozen,
      minted_current:      row.total_minted,
      unavailable_total:   0,
      traceability_status: row.all_invariants_pass ? 'ok' : 'violation',
      active_delta:        row.a_active - 100000,
      status:              row.all_invariants_pass ? 'ok' : 'stop',
      created_at:          row.created_at * 1000,
    }));
  }

  state.genesis_complete   = true;
  state.status             = sim.SYSTEM_STATUS.ACTIVE;
  state.observations       = {};
  state.token_locations    = {};
  state.transparency_stale = true;

  // Seed ID counters so post-restore events don't collide with persisted IDs
  seedCounters({ eventCount: state.events.length, snapshotCount: state.snapshots.length });

  _state = state;
  console.log(`[stateManager] State restored. Networks: ${Object.keys(state.networks).join(',')}, Events: ${state.events.length}`);
  return true;
}

// ─── applyGenesis ─────────────────────────────────────────────────────────────
// Calls simulator initializeGenesis, then persists to SQLite.
// config: { networks: [{ network_id, it_address }] }
function applyGenesis(config) {
  if (isInitialized()) {
    return { ok: false, reason: 'Genesis already completed' };
  }

  const result = sim.initializeGenesis(config);
  if (!result.ok) return result;

  _state = result.state;
  persistState(_state);

  console.log('[stateManager] Genesis applied and persisted.');
  return { ok: true };
}

// ─── canApplyTreasuryDistribution ────────────────────────────────────────────
// Pre-flight validation — reads state but does NOT mutate it.
// Called before Executor sends on-chain tx, so we fail fast on MetaRegistry
// violations before spending gas.
function canApplyTreasuryDistribution(network_id, wallet_address, amount) {
  const state = getState();
  const MAX_WALLET_ACTIVE = sim.CONSTANTS?.MAX_WALLET_ACTIVE_STARTING ?? 60000;
  const MIN_IT_ACTIVE     = sim.CONSTANTS?.MIN_IT_ACTIVE_STARTING     ?? 40000;

  if (!state.genesis_complete) return { ok: false, reason: 'GENESIS_NOT_COMPLETED' };

  const net = state.networks[network_id];
  if (!net) return { ok: false, reason: 'INVALID_SOURCE_NETWORK', network_id };

  if (net.IT_ACTIVE < amount) {
    return { ok: false, reason: 'INSUFFICIENT_SOURCE_BALANCE',
      IT_ACTIVE_available: net.IT_ACTIVE, requested: amount };
  }

  // 60/40 rule: total wallet_active across all networks must not exceed MAX
  let total_wallet_after = 0;
  for (const nid of NETWORK_IDS) {
    const n = state.networks[nid];
    if (n) total_wallet_after += n.wallet_active_total;
  }
  total_wallet_after += amount;
  if (total_wallet_after > MAX_WALLET_ACTIVE) {
    return { ok: false, reason: 'WALLET_ACTIVE_CAP_EXCEEDED',
      total_wallet_after, cap: MAX_WALLET_ACTIVE };
  }

  // IT_ACTIVE minimum check
  let total_it_after = 0;
  for (const nid of NETWORK_IDS) {
    const n = state.networks[nid];
    if (n) total_it_after += (nid === network_id ? n.IT_ACTIVE - amount : n.IT_ACTIVE);
  }
  if (total_it_after < MIN_IT_ACTIVE) {
    return { ok: false, reason: 'IT_ACTIVE_BELOW_MINIMUM',
      total_IT_ACTIVE_after: total_it_after, min_required: MIN_IT_ACTIVE };
  }

  return { ok: true };
}

// ─── applyTreasuryDistribution ────────────────────────────────────────────────
function applyTreasuryDistribution(network_id, wallet_address, amount, tx_hash = null) {
  const state = getState();
  const result = sim.applyTreasuryDistribution(state, network_id, wallet_address, amount);
  if (result.ok) {
    // Attach tx_hash as evidence to the last event (the TREASURY_DISTRIBUTION_APPLIED event)
    if (tx_hash && result.event_id) {
      _storeTxHash(result.event_id, tx_hash);
    }
    persistState(state);
  }
  return result;
}

// ─── applyObservation ────────────────────────────────────────────────────────
// Called by Observer for each on-chain Transfer log that passes filters.
// Calls simulator: mockObservedExternalTransfer → reconcileObservedTransfer.
// Persists state if reconciliation succeeds.
function applyObservation({ network_id, tx_hash, log_index, from_address, to_address, amount, block_number }) {
  const state = getState();

  // Ensure observations and token_locations maps exist (not restored from DB)
  if (!state.observations)    state.observations    = {};
  if (!state.token_locations) state.token_locations = {};

  const obsResult = sim.mockObservedExternalTransfer(state, {
    network_id,
    tx_hash,
    from_address,
    to_address,
    amount,
    block_number,
  });

  if (!obsResult.ok) {
    return { ok: false, reason: obsResult.reason };
  }

  const recResult = sim.reconcileObservedTransfer(state, obsResult.observation);

  if (!recResult.ok) {
    persistState(state); // persist STOP event if triggered
    return { ok: false, reason: recResult.reason, event_ids: recResult.event_ids };
  }

  persistState(state);
  return { ok: true, classification: recResult.classification, event_ids: recResult.event_ids };
}

// ─── applyTransfer ────────────────────────────────────────────────────────────
// Orchestrates full cross-network transfer lifecycle:
// resolve sources → createEnvelope → validate → freeze → delta → unfreeze → complete
// params: { source_mode, amount, sender, recipient, target_network, sources? }
function applyTransfer(params) {
  const state = getState();

  const {
    source_mode,
    amount,
    sender,
    recipient,
    target_network,
    sources: user_sources = null,
  } = params;

  // 1. Source resolution
  // Note: resolveAutomaticSources and resolveUserDefinedSources take positional args,
  // not an object. envelope_id is not yet assigned at this stage — pass null.
  let resolved;
  if (source_mode === sim.SOURCE_MODE.AUTOMATIC) {
    resolved = sim.resolveAutomaticSources(state, null, sender, amount, target_network);
  } else if (source_mode === sim.SOURCE_MODE.USER_DEFINED) {
    if (!user_sources || !Array.isArray(user_sources)) {
      return { ok: false, reason: 'USER_DEFINED requires sources array' };
    }
    resolved = sim.resolveUserDefinedSources(state, null, sender, user_sources, amount, target_network);
  } else {
    return { ok: false, reason: 'Invalid source_mode. Use AUTOMATIC or USER_DEFINED.' };
  }

  if (!resolved.ok) return resolved;

  // 2. Determine operation type
  const is_same_network = resolved.sources.every(s => s.source_network === target_network);

  // Same-network shortcut
  if (is_same_network) {
    const result = sim.applySameNetworkThroughMetaRegistry(state, {
      network_id:        target_network,
      sender_address:    sender,
      recipient_address: recipient,
      amount,
    });
    if (result.ok) persistState(state);
    return result;
  }

  // 3. Cross-network: full lifecycle
  const env_result = sim.createEnvelopeFromIntent(state, {
    operation_type: sim.OPERATION_TYPE.CROSS_NETWORK_TRANSFER,
    source_mode,
    amount,
    sender,
    recipient,
    target_network,
    sources: resolved.sources,
  });
  if (!env_result.ok) return env_result;

  const { envelope, settlement } = env_result;

  // 4. Validate package
  const val_result = sim.validatePackage(state, envelope);
  if (!val_result.ok) {
    persistState(state); // persist rejected event
    return val_result;
  }

  // 5. Apply source freezes
  for (const src_id of envelope.source_operation_ids) {
    const src = state.source_operations[src_id];
    const freeze_result = sim.applySourceFreeze(state, src);
    if (!freeze_result.ok) {
      persistState(state);
      return freeze_result;
    }
  }

  // 6. Record temporary delta
  const delta_result = sim.recordTemporaryDelta(state, envelope);
  if (!delta_result.ok) {
    persistState(state);
    return delta_result;
  }

  // 7. Apply target unfreeze — captures event_id and state_after for response
  const unfreeze_result = sim.applyTargetUnfreeze(state, settlement);
  if (!unfreeze_result.ok) {
    persistState(state);
    return unfreeze_result;
  }

  // 8. Complete envelope — final invariant check
  const complete_result = sim.completeEnvelope(state, envelope);
  persistState(state);

  if (!complete_result.ok) return complete_result;

  // Return event_id and state_after from unfreeze step (meaningful state change)
  return {
    ok:          true,
    event_id:    unfreeze_result.event_id,
    state_after: unfreeze_result.state_after,
  };
}

// ─── getTransparency ──────────────────────────────────────────────────────────
function getTransparency(limit) {
  const state = getState();
  const result = sim.getTransparencySnapshot(state, limit);
  if (state.transparency_stale) {
    return { ...result, transparency_stale: true,
      note: 'Observation data lost on cold start; reconciliation counts may be inaccurate' };
  }
  return result;
}

// ─── getEventHistory ──────────────────────────────────────────────────────────
function getEventHistory(envelope_id, limit) {
  const state = getState();
  return sim.getEventHistory(state, envelope_id || null, limit || null);
}

// ─── getFullState ─────────────────────────────────────────────────────────────
// Returns safe serializable view of current state (no circular refs).
function getFullState() {
  const state = getState();
  return {
    status:          state.status,
    genesis_complete: state.genesis_complete,
    stop_reason:     state.stop_reason,
    networks:        state.networks,
    treasuries:      state.treasuries,
    wallets:         state.wallets,
    event_count:     state.events.length,
    snapshot_count:  state.snapshots.length,
  };
}

// ─── registerWallet ───────────────────────────────────────────────────────────
// Adds a wallet address to MetaRegistry on specified networks with 0 balance.
// Does NOT affect A_ACTIVE or any treasury invariant.
function registerWallet(address, network_ids) {
  const state = getState();
  const addr  = address.toLowerCase();
  const results = {};

  for (const network_id of network_ids) {
    if (!state.networks[network_id]) {
      results[network_id] = { ok: false, reason: 'INVALID_NETWORK' };
      continue;
    }
    const key = `${network_id}:${addr}`;
    if (state.wallets[key]) {
      results[network_id] = { ok: false, reason: 'ALREADY_REGISTERED', balance: state.wallets[key].wallet_active };
      continue;
    }
    state.wallets[key] = {
      network_id,
      wallet_address:               addr,
      wallet_active:                0,
      is_predefined_tester_address: true,
      is_cold_wallet:               false,
      is_external_registered:       false,
      last_seen_at:                 now() * 1000,
    };
    results[network_id] = { ok: true };
  }

  persistState(state);
  console.log(`[stateManager] registerWallet ${addr} on [${network_ids.join(',')}]:`, results);
  return results;
}

// ─── Private helpers ──────────────────────────────────────────────────────────

const NETWORK_PRIORITIES = { A: 1, B: 2, C: 3, D: 4 };
function _networkPriority(network_id) {
  return NETWORK_PRIORITIES[network_id] || 99;
}

function _itAddressFromTreasury(network_id) {
  const row = db.prepare('SELECT it_address FROM treasury_state WHERE network_id = ?').get(network_id);
  return row ? row.it_address : null;
}

function _itActiveFromTreasury(network_id) {
  const row = db.prepare('SELECT active_balance FROM treasury_state WHERE network_id = ?').get(network_id);
  return row ? row.active_balance : 0;
}

function _walletActiveTotalFromDB(network_id) {
  const row = db.prepare(
    'SELECT COALESCE(SUM(active_balance), 0) as total FROM wallet_balance WHERE network_id = ?'
  ).get(network_id);
  return row ? row.total : 0;
}

// Track which event_ids are already persisted to avoid duplicates
const _persistedEventIds = new Set();
const _persistedSnapshotIds = new Set();

// Seed persisted sets from DB on first call
function _initPersistedSets() {
  if (_persistedEventIds.size === 0) {
    const rows = db.prepare('SELECT event_id FROM event_record').all();
    for (const r of rows) _persistedEventIds.add(r.event_id);
  }
  if (_persistedSnapshotIds.size === 0) {
    const rows = db.prepare('SELECT snapshot_id FROM invariant_snapshot').all();
    for (const r of rows) _persistedSnapshotIds.add(r.snapshot_id);
  }
}

function _persistNetworks(state) {
  const upsert = db.prepare(`
    INSERT INTO network_state (network_id, network_name, total_active, total_frozen, total_unavailable, is_initialized, initialized_at, updated_at)
    VALUES (@network_id, @network_name, @total_active, @total_frozen, @total_unavailable, 1, @initialized_at, @updated_at)
    ON CONFLICT(network_id) DO UPDATE SET
      total_active      = excluded.total_active,
      total_frozen      = excluded.total_frozen,
      total_unavailable = excluded.total_unavailable,
      updated_at        = excluded.updated_at
  `);
  for (const [net_id, net] of Object.entries(state.networks)) {
    upsert.run({
      network_id:       net_id,
      network_name:     net.network_name,
      total_active:     net.IT_ACTIVE + net.wallet_active_total,
      total_frozen:     net.IT_FROZEN, // reporting only; restore uses treasury_state.frozen_balance
      total_unavailable: net.UNAVAILABLE || 0,
      initialized_at:   now(),
      updated_at:       now(),
    });
  }
}

function _persistTreasuries(state) {
  const upsert = db.prepare(`
    INSERT INTO treasury_state (network_id, it_address, active_balance, frozen_balance, updated_at)
    VALUES (@network_id, @it_address, @active_balance, @frozen_balance, @updated_at)
    ON CONFLICT(network_id) DO UPDATE SET
      active_balance = excluded.active_balance,
      frozen_balance = excluded.frozen_balance,
      updated_at     = excluded.updated_at
  `);
  for (const [net_id, tr] of Object.entries(state.treasuries)) {
    upsert.run({
      network_id:     net_id,
      it_address:     tr.it_address,
      active_balance: tr.IT_ACTIVE,
      frozen_balance: tr.IT_FROZEN,
      updated_at:     now(),
    });
  }
}

function _persistWallets(state) {
  const upsert = db.prepare(`
    INSERT INTO wallet_balance (address, network_id, active_balance, frozen_balance, wallet_type, updated_at)
    VALUES (@address, @network_id, @active_balance, @frozen_balance, @wallet_type, @updated_at)
    ON CONFLICT(address, network_id) DO UPDATE SET
      active_balance = excluded.active_balance,
      frozen_balance = excluded.frozen_balance,
      updated_at     = excluded.updated_at
  `);
  for (const [key, wallet] of Object.entries(state.wallets)) {
    const wallet_type = wallet.is_cold_wallet ? 'COLD'
                      : wallet.is_cabinet ? 'CABINET'
                      : wallet.is_external_registered ? 'EXTERNAL' : 'TESTER';
    upsert.run({
      address:        wallet.wallet_address.toLowerCase(),
      network_id:     wallet.network_id,
      active_balance: wallet.wallet_active,
      frozen_balance: 0, // wallets don't hold frozen in simulator
      wallet_type,
      updated_at:     now(),
    });
  }
}

const _REJECTED_EVT_TYPES = new Set(['PRE_VALIDATION_REJECTED', 'DAPP_PRE_VALIDATION_REJECTED']);
const _FAILED_EVT_TYPES   = new Set(['STOP_TRIGGERED']);

function _persistNewEvents(state) {
  _initPersistedSets();
  const insert = db.prepare(`
    INSERT OR IGNORE INTO event_record
      (event_id, event_type, network_id, from_address, to_address, amount, status, rejection_code, metadata, created_at)
    VALUES
      (@event_id, @event_type, @network_id, @from_address, @to_address, @amount, @status, @rejection_code, @metadata, @created_at)
  `);
  for (const evt of state.events) {
    if (_persistedEventIds.has(evt.event_id)) continue;
    const is_rejected = _REJECTED_EVT_TYPES.has(evt.event_type);
    const is_failed   = _FAILED_EVT_TYPES.has(evt.event_type);
    insert.run({
      event_id:       evt.event_id,
      event_type:     evt.event_type,
      network_id:     evt.network_id || null,
      from_address:   evt.from_address || null,
      to_address:     evt.to_address || null,
      amount:         evt.amount != null ? evt.amount : null,
      status:         is_rejected ? 'REJECTED' : is_failed ? 'FAILED' : 'SUCCESS',
      rejection_code: is_rejected ? (evt.evidence || null) : null,
      metadata:       evt.evidence ? JSON.stringify({ evidence: evt.evidence }) : null,
      created_at:     Math.floor((evt.created_at || Date.now()) / 1000),
    });
    _persistedEventIds.add(evt.event_id);
  }
}

function _persistNewSnapshots(state) {
  _initPersistedSets();
  const insert = db.prepare(`
    INSERT OR IGNORE INTO invariant_snapshot
      (snapshot_id, triggered_by_event_id, total_minted, a_active, total_frozen,
       network_active_json, network_frozen_json, all_invariants_pass, created_at)
    VALUES
      (@snapshot_id, @triggered_by_event_id, @total_minted, @a_active, @total_frozen,
       @network_active_json, @network_frozen_json, @all_invariants_pass, @created_at)
  `);

  for (const snap of state.snapshots) {
    if (_persistedSnapshotIds.has(snap.snapshot_id)) continue;

    // Build per-network JSON from current state at snapshot time
    // (we use current state as approximation — exact per-snapshot is not stored in simulator)
    const net_active = {};
    const net_frozen = {};
    for (const [nid, net] of Object.entries(state.networks)) {
      net_active[nid] = net.IT_ACTIVE + net.wallet_active_total;
      net_frozen[nid] = net.IT_FROZEN;
    }

    // Find last event_id as trigger reference
    const last_event = state.events.length > 0
      ? state.events[state.events.length - 1].event_id
      : 'genesis';

    insert.run({
      snapshot_id:          snap.snapshot_id,
      triggered_by_event_id: last_event,
      total_minted:         snap.minted_current,
      a_active:             snap.active_current,
      total_frozen:         snap.frozen_current,
      network_active_json:  JSON.stringify(net_active),
      network_frozen_json:  JSON.stringify(net_frozen),
      all_invariants_pass:  snap.status === 'ok' ? 1 : 0,
      created_at:           Math.floor((snap.created_at || Date.now()) / 1000),
    });
    _persistedSnapshotIds.add(snap.snapshot_id);
  }
}

function _storeTxHash(event_id, tx_hash) {
  try {
    db.prepare(`UPDATE event_record SET metadata = json_set(COALESCE(metadata,'{}'), '$.tx_hash', ?) WHERE event_id = ?`)
      .run(tx_hash, event_id);
  } catch (e) {
    console.error('[stateManager] Failed to store tx_hash on event:', e.message);
  }
}

// ─── loadOnChainBalances ──────────────────────────────────────────────────────
// Async. Replaces in-memory wallet.wallet_active and net.IT_ACTIVE with real
// on-chain balanceOf() values. Called once at startup after restoreState().
// Degrades gracefully: if an RPC call fails, the existing arithmetic value is kept.
// Also cleans up stale checksummed wallet_balance rows from DB.
async function loadOnChainBalances() {
  if (!_state) return;
  const { getTokenBalance, getITBalance, IT_ADDRESS } = _networks();
  const EXPECTED = 100_000;

  for (const net_id of NETWORK_IDS) {
    const net = _state.networks[net_id];
    if (!net) continue;

    let wallet_active_total = 0;

    // Load each wallet's real balance sequentially (avoids drpc.org batch limit)
    for (const wallet of Object.values(_state.wallets)) {
      if (wallet.network_id !== net_id) continue;
      try {
        const bal = await getTokenBalance(net_id, wallet.wallet_address);
        wallet.wallet_active = bal;
        wallet_active_total += bal;
        db.prepare(
          'UPDATE wallet_balance SET active_balance=?, updated_at=? WHERE LOWER(address)=? AND network_id=?'
        ).run(bal, now(), wallet.wallet_address, net_id);
      } catch (e) {
        console.warn(`[stateManager] balanceOf ${wallet.wallet_address} on ${net_id}: ${e.message}`);
        wallet_active_total += wallet.wallet_active;
      }
    }
    net.wallet_active_total = wallet_active_total;

    // Load IT-EOA real balance
    try {
      const itOnChain = await getITBalance(net_id);
      const it_frozen  = net.IT_FROZEN;
      const it_active  = Math.max(0, itOnChain - it_frozen);
      net.IT_ACTIVE = it_active;
      if (_state.treasuries[net_id]) _state.treasuries[net_id].IT_ACTIVE = it_active;
      // Persist back so restoreState on next startup sees the fresh value
      db.prepare('UPDATE treasury_state SET active_balance=?, updated_at=? WHERE network_id=?')
        .run(it_active, now(), net_id);

      const inv_sum = itOnChain + wallet_active_total;
      const diff    = inv_sum - EXPECTED;
      const sign    = diff >= 0 ? '+' : '';
      console.log(
        `[stateManager] Network ${net_id}: IT=${itOnChain} + wallets=${wallet_active_total}` +
        ` = ${inv_sum} (diff ${sign}${diff})`
      );
      if (diff !== 0) {
        console.warn(`[stateManager] ⚠ Network ${net_id}: on-chain invariant VIOLATED by ${sign}${diff} tEQUI`);
      }
    } catch (e) {
      console.warn(`[stateManager] getITBalance ${net_id}: ${e.message}`);
    }
  }

  // Remove stale checksummed duplicate rows (address != LOWER(address))
  const cleaned = db.prepare("DELETE FROM wallet_balance WHERE address != LOWER(address)").run();
  if (cleaned.changes > 0) {
    console.log(`[stateManager] Cleaned ${cleaned.changes} stale checksummed wallet_balance row(s)`);
  }
}

// ─── applyCabinetWithdraw ─────────────────────────────────────────────────────
// Called immediately after a successful executeCommand(CABINET_WITHDRAW).
// Decrements IT_ACTIVE and credits the recipient wallet in-memory + SQLite.
// A_ACTIVE is unchanged: IT_ACTIVE ↓ amount, wallet_active ↑ amount, net = 0.
function applyCabinetWithdraw(network_id, to_address, amount) {
  const state = getState();
  const net   = state.networks[network_id];
  if (!net) throw new Error(`applyCabinetWithdraw: unknown network ${network_id}`);
  if (net.IT_ACTIVE < amount) {
    throw new Error(
      `applyCabinetWithdraw: IT_ACTIVE(${net.IT_ACTIVE}) < amount(${amount}) on ${network_id}`
    );
  }

  // Normalise address — same pattern as registerWallet / restoreState
  const addr = to_address.toLowerCase();
  const key  = `${network_id}:${addr}`;

  // Decrement IT_ACTIVE in both network and treasury views
  net.IT_ACTIVE -= amount;
  if (state.treasuries[network_id]) {
    state.treasuries[network_id].IT_ACTIVE -= amount;
  }

  // Credit recipient wallet
  if (state.wallets[key]) {
    state.wallets[key].wallet_active += amount;
    state.wallets[key].last_seen_at   = now() * 1000;
  } else {
    state.wallets[key] = {
      network_id,
      wallet_address:               addr,
      wallet_active:                amount,
      is_predefined_tester_address: false,
      is_cold_wallet:               false,
      is_external_registered:       false,
      is_cabinet:                   true,
      last_seen_at:                 now() * 1000,
    };
  }
  net.wallet_active_total += amount;

  persistState(state);
  console.log(`[stateManager] applyCabinetWithdraw: IT-${network_id} -${amount} → ${addr} +${amount}`);
}

// ─── checkOnChainInvariant ────────────────────────────────────────────────────
// Async. Queries balanceOf() for IT-EOA and all known wallets on each network.
// Returns per-network diff from expected 100,000.
async function checkOnChainInvariant() {
  const { getTokenBalance, getITBalance } = _networks();
  const EXPECTED = 100_000;
  const results  = [];

  for (const net_id of NETWORK_IDS) {
    const walletRows = db.prepare(
      'SELECT DISTINCT LOWER(address) as addr FROM wallet_balance WHERE network_id = ?'
    ).all(net_id);

    const wallets = [];
    for (const row of walletRows) {
      try {
        const balance = await getTokenBalance(net_id, row.addr);
        wallets.push({ address: row.addr, balance });
      } catch (e) {
        wallets.push({ address: row.addr, balance: null, error: e.message });
      }
    }

    let it_balance = null;
    try {
      it_balance = await getITBalance(net_id);
    } catch (e) {
      results.push({ network_id: net_id, ok: false, error: e.message });
      continue;
    }

    const wallet_sum   = wallets.reduce((s, w) => s + (w.balance ?? 0), 0);
    const on_chain_sum = it_balance + wallet_sum;
    const diff         = on_chain_sum - EXPECTED;

    results.push({
      network_id: net_id,
      it_balance,
      wallet_sum,
      on_chain_sum,
      expected: EXPECTED,
      diff,
      ok: diff === 0,
      wallets,
    });
  }

  return {
    ok:       results.every(r => r.ok === true),
    networks: results,
    ts:       Math.floor(Date.now() / 1000),
  };
}

module.exports = {
  isInitialized,
  getState,
  restoreState,
  loadOnChainBalances,
  checkOnChainInvariant,
  applyGenesis,
  canApplyTreasuryDistribution,
  applyTreasuryDistribution,
  applyObservation,
  applyTransfer,
  applyCabinetWithdraw,
  getTransparency,
  getEventHistory,
  getFullState,
  registerWallet,
};
