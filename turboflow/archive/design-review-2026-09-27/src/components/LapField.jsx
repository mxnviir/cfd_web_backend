// Extracted from app.compiled.js, which held every screen in one file.
//
// The bodies are the original generated React.createElement output, unchanged.
// Only the packaging is new: this is a module now, so a page that does not use
// it does not download it.

import React from "react";

const LapField = ({
  label,
  refInput,
  placeholder,
  unit
}) => /*#__PURE__*/React.createElement("div", {
  style: {
    display: 'flex',
    flexDirection: 'column'
  }
}, /*#__PURE__*/React.createElement("label", {
  style: {
    display: 'block',
    fontSize: 13,
    fontWeight: 700,
    color: 'var(--ink-3)',
    marginBottom: 6
  }
}, label), /*#__PURE__*/React.createElement("div", {
  style: {
    display: 'flex',
    alignItems: 'center'
  }
}, /*#__PURE__*/React.createElement("input", {
  ref: refInput,
  type: "text",
  inputMode: "decimal",
  placeholder: placeholder,
  className: "input-field",
  style: {
    flex: 1,
    minWidth: 0,
    padding: '10px 12px',
    borderRadius: unit ? '4px 0 0 4px' : '4px',
    fontSize: 15
  }
}), unit && /*#__PURE__*/React.createElement("span", {
  style: {
    padding: '10px 12px',
    background: 'var(--panel-2)',
    border: '1px solid var(--rule-strong)',
    borderLeft: 'none',
    borderRadius: '0 4px 4px 0',
    fontSize: 14,
    color: 'var(--ink-4)',
    fontWeight: 600,
    whiteSpace: 'nowrap'
  }
}, unit)));

export { LapField };
