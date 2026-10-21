// Extracted from app.compiled.js, which held every screen in one file.
//
// The bodies are the original generated React.createElement output, unchanged.
// Only the packaging is new: this is a module now, so a page that does not use
// it does not download it.

import React, { useRef, useState } from "react";
import { firebase } from "../lib/firebase.js";

const InlineRaceCalc = ({
  isSignedIn,
  onRequireAuth
}) => {
  const [result, setResult] = useState(null);
  const [error, setError] = useState('');
  const [running, setRunning] = useState(false);
  const refCW = React.useRef(null);
  const refDF = React.useRef(null);
  const refMu = React.useRef(null);
  const refMOI = React.useRef(null);
  const run = async () => {
    setError('');
    setResult(null);
    if (!isSignedIn) {
      onRequireAuth('Sign in to use the Race Time Calculator.');
      return;
    }
    const carW = parseFloat(refCW.current.value);
    const fDrag = parseFloat(refDF.current.value);
    const mu = parseFloat(refMu.current.value);
    const iMOI = parseFloat(refMOI.current.value);
    if ([carW, fDrag, mu, iMOI].some(isNaN)) {
      setError('Please fill in all fields.');
      return;
    }
    if (carW <= 0) {
      setError('Car weight must be > 0.');
      return;
    }
    setRunning(true);
    try {
      const idToken = await firebase.auth().currentUser.getIdToken();
      // The project this build is configured for, never one named in the
      // source. Hardcoded to production, this sent a test-project ID token and
      // the user's car data to the production function on every calculation.
      // No fallback: a build with no config should fail here rather than
      // quietly reach across to production.
      const project = window.FIREBASE_CONFIG?.projectId;
      if (!project) throw new Error('This build has no Firebase project configured.');
      const resp = await fetch(`https://us-central1-${project}.cloudfunctions.net/run_lap_calc`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${idToken}`
        },
        body: JSON.stringify({
          carWeightG: carW,
          dragForceN: fDrag,
          muRoll: mu,
          wheelMoiGMm2: iMOI
        })
      });
      const data = await resp.json();
      if (!resp.ok) setError(data.error || 'Simulation failed.');else setResult(data.finishTime);
    } catch (e) {
      setError(e.message || 'Failed to reach server.');
    } finally {
      setRunning(false);
    }
  };
  const Field = ({
    label,
    r,
    placeholder,
    unit
  }) => /*#__PURE__*/React.createElement("div", {
    style: {
      marginBottom: 12
    }
  }, /*#__PURE__*/React.createElement("label", {
    className: "t-label",
    style: { display: 'block', marginBottom: 5 }
  }, label), /*#__PURE__*/React.createElement("div", {
    style: {
      display: 'flex'
    }
  }, /*#__PURE__*/React.createElement("input", {
    ref: r,
    type: "text",
    inputMode: "decimal",
    placeholder: placeholder,
    className: "input-field",
    style: {
      flex: 1,
      // An input will not shrink past its default intrinsic width - about
      // twenty characters - unless it is told it may, and on a phone that is
      // wider than the card it sits in: the row wanted 252 px of a 215 px box
      // and the unit label hung off the edge.
      minWidth: 0,
      padding: '9px 12px',
      borderRadius: unit ? '4px 0 0 4px' : '4px',
      fontSize: 14
    }
  }), unit && /*#__PURE__*/React.createElement("span", {
    style: {
      padding: '9px 12px',
      background: 'var(--panel-2)',
      border: '1px solid var(--rule-strong)',
      borderLeft: 'none',
      borderRadius: '0 4px 4px 0',
      fontSize: 12,
      color: 'var(--ink-4)',
      fontWeight: 600,
      whiteSpace: 'nowrap'
    }
  }, unit)));
  return /*#__PURE__*/React.createElement("div", {
    style: {
      background: 'var(--inset)',
      border: '1px solid var(--panel-2)',
      borderRadius: 4,
      padding: '28px 28px 24px'
    }
  }, /*#__PURE__*/React.createElement("p", {
    style: {
      fontSize: 12,
      fontWeight: 700,
      color: 'var(--ink-4)',
      marginBottom: 20
    }
  }, "STEM Racing car, 20 metre run"), /*#__PURE__*/React.createElement(Field, {
    label: "Weight of car",
    r: refCW,
    placeholder: "e.g. 48",
    unit: "g"
  }), /*#__PURE__*/React.createElement(Field, {
    label: "Drag force at 20 m/s",
    r: refDF,
    placeholder: "e.g. 0.16",
    unit: "N"
  }), /*#__PURE__*/React.createElement(Field, {
    label: "Rolling friction coefficient",
    r: refMu,
    placeholder: "e.g. 0",
    unit: ""
  }), /*#__PURE__*/React.createElement(Field, {
    label: "Wheel MOI",
    r: refMOI,
    placeholder: "e.g. 100",
    unit: "g*mm^2"
  }), error && /*#__PURE__*/React.createElement("p", {
    style: {
      fontSize: 13,
      color: 'var(--bad)',
      margin: '8px 0',
      padding: '8px 12px',
      background: 'var(--inset)',
      borderRadius: 4,
      border: '1px solid var(--bad)'
    }
  }, error), /*#__PURE__*/React.createElement("button", {
    onClick: run,
    disabled: running,
    className: "btn-primary btn-block",
    style: {
      marginTop: 8
    }
  }, running ? 'Running...' : 'Work out race time (10 credits)'), result !== null && /*#__PURE__*/React.createElement("div", {
    style: {
      marginTop: 16,
      padding: '20px',
      borderRadius: 4,
      textAlign: 'center',
      background: 'var(--panel)',
      border: '1px solid var(--ok)'
    }
  }, /*#__PURE__*/React.createElement("p", {
    className: "t-label",
    style: { color: 'var(--ok)', marginBottom: 6 }
  }, "Predicted finish time"), /*#__PURE__*/React.createElement("p", {
    className: "t-data-lg",
    style: { margin: 0 }
  }, result.toFixed(4), /*#__PURE__*/React.createElement("span", {
    className: "t-unit"
  }, "s"))));
};

/* -- Home View -------------------------------------------- */

export { InlineRaceCalc };
