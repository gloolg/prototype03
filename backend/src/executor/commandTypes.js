'use strict';

const COMMAND_TYPE = {
  TREASURY_DISTRIBUTION: 'TREASURY_DISTRIBUTION',
  CROSS_NETWORK_EXIT:    'CROSS_NETWORK_EXIT',    // future: Step 9+
  CROSS_NETWORK_ENTRY:   'CROSS_NETWORK_ENTRY',   // entry delivery: tester-initiated cross-network
  REFUND:                'REFUND',                // return funds to original sender after stuck delivery
  MSE_DELIVERY:          'MSE_DELIVERY',          // final delivery for multi-source envelope
  CABINET_WITHDRAW:      'CABINET_WITHDRAW',      // cabinet withdrawal: IT-EOA → external recipient
};

module.exports = { COMMAND_TYPE };
