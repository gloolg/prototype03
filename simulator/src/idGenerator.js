'use strict';

// ─── ID Generators (§5.2) ─────────────────────────────────────────────────────
// All IDs are append-only and never reused.
// Counters are module-level singletons — reset only via resetCounters() in tests.

let _envelopeCounter  = 0;
let _eventCounter     = 0;
let _snapshotCounter  = 0;
let _intentCounter    = 0;
let _sourceOpCounter  = 0;
let _settlementCounter = 0;
let _locationCounter  = 0;
let _observationCounter = 0;

function _ts() {
  return Date.now();
}

function generateEnvelopeId() {
  _envelopeCounter++;
  return `ENV-${_ts()}-${String(_envelopeCounter).padStart(4, '0')}`;
}

function generateEventId() {
  _eventCounter++;
  return `EVT-${String(_eventCounter).padStart(6, '0')}`;
}

function generateSnapshotId() {
  _snapshotCounter++;
  return `SNAP-${String(_snapshotCounter).padStart(5, '0')}`;
}

function generateIntentId() {
  _intentCounter++;
  return `INT-${_ts()}-${String(_intentCounter).padStart(4, '0')}`;
}

function generateSourceOpId() {
  _sourceOpCounter++;
  return `SRC-${_ts()}-${String(_sourceOpCounter).padStart(4, '0')}`;
}

function generateSettlementId() {
  _settlementCounter++;
  return `SET-${_ts()}-${String(_settlementCounter).padStart(4, '0')}`;
}

function generateLocationId() {
  _locationCounter++;
  return `LOC-${String(_locationCounter).padStart(5, '0')}`;
}

function generateObservationId() {
  _observationCounter++;
  return `OBS-${_ts()}-${String(_observationCounter).padStart(4, '0')}`;
}

// Seed counters from persisted state on restore to avoid ID collisions across restarts
function seedCounters({ eventCount = 0, snapshotCount = 0 } = {}) {
  if (eventCount > _eventCounter)    _eventCounter    = eventCount;
  if (snapshotCount > _snapshotCounter) _snapshotCounter = snapshotCount;
}

// Reset all counters — for use in tests only
function resetCounters() {
  _envelopeCounter   = 0;
  _eventCounter      = 0;
  _snapshotCounter   = 0;
  _intentCounter     = 0;
  _sourceOpCounter   = 0;
  _settlementCounter = 0;
  _locationCounter   = 0;
  _observationCounter = 0;
}

module.exports = {
  generateEnvelopeId,
  generateEventId,
  generateSnapshotId,
  generateIntentId,
  generateSourceOpId,
  generateSettlementId,
  generateLocationId,
  generateObservationId,
  seedCounters,
  resetCounters,
};
