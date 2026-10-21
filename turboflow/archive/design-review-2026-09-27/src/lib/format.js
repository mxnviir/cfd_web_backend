// Extracted from app.compiled.js, which held every screen in one file.
//
// The bodies are the original generated React.createElement output, unchanged.
// Only the packaging is new: this is a module now, so a page that does not use
// it does not download it.

import React from "react";

const friendlyTxLabel = t => {
  if (t.reason) return t.reason;
  const map = {
    simulation_charge: 'Simulation Charge',
    refund: 'Refund',
    usage: 'Simulation Charge',
    debit: 'Debit',
    credit: 'Credit Added',
    purchase: 'Credit Purchase'
  };
  return map[t.type] || t.type || 'Transaction';
};

export { friendlyTxLabel };
