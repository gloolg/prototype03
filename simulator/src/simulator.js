'use strict';

// ─── MetaRegistry State Simulator (v1.0) ─────────────────────────────────────
// Single entry point. Assembles all modules.

const constants     = require('./constants');
const idGenerator   = require('./idGenerator');
const stateFactory  = require('./stateFactory');
const invariants    = require('./invariants');
const genesis       = require('./genesis');
const treasury      = require('./treasury');
const sourceRes     = require('./sourceResolution');
const crossNetwork  = require('./crossNetwork');
const observation   = require('./observation');
const dappIntent    = require('./dappIntent');
const transparency  = require('./transparency');

module.exports = {
  // Constants
  ...constants,

  // ID generators
  ...idGenerator,

  // State factory
  ...stateFactory,

  // Invariants
  checkInvariants:    invariants.checkInvariants,
  checkTraceability:  invariants.checkTraceability,
  triggerStop:        invariants.triggerStop,
  assertActive:       invariants.assertActive,
  computeTotals:      invariants.computeTotals,

  // Genesis
  initializeGenesis:              genesis.initializeGenesis,
  validateStartingDistribution:   genesis.validateStartingDistribution,

  // Treasury
  applyTreasuryDistribution:      treasury.applyTreasuryDistribution,

  // Source resolution
  resolveAutomaticSources:        sourceRes.resolveAutomaticSources,
  resolveUserDefinedSources:      sourceRes.resolveUserDefinedSources,

  // Cross-network
  createEnvelopeFromIntent:                   crossNetwork.createEnvelopeFromIntent,
  validatePackage:                            crossNetwork.validatePackage,
  applySourceFreeze:                          crossNetwork.applySourceFreeze,
  recordTemporaryDelta:                       crossNetwork.recordTemporaryDelta,
  applyTargetUnfreeze:                        crossNetwork.applyTargetUnfreeze,
  completeEnvelope:                           crossNetwork.completeEnvelope,
  applySameNetworkThroughMetaRegistry:        crossNetwork.applySameNetworkThroughMetaRegistry,

  // Observation
  mockObservedExternalTransfer:   observation.mockObservedExternalTransfer,
  reconcileObservedTransfer:      observation.reconcileObservedTransfer,
  updateTokenStateLocation:       observation.updateTokenStateLocation,

  // DAppIntent
  createDAppIntent:                               dappIntent.createDAppIntent,
  validateDAppIntent:                             dappIntent.validateDAppIntent,
  classifyTargetAddress:                          dappIntent.classifyTargetAddress,
  rejectUnknownRegistryAddressBeforeSignature:    dappIntent.rejectUnknownRegistryAddressBeforeSignature,

  // Transparency
  getTransparencySnapshot:        transparency.getTransparencySnapshot,
  getEventHistory:                transparency.getEventHistory,
};
