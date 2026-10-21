// Extracted from app.compiled.js, which held every screen in one file.
//
// The bodies are the original generated React.createElement output, unchanged.
// Only the packaging is new: this is a module now, so a page that does not use
// it does not download it.

import React, { useEffect, useRef, useState } from "react";
import { db, firebase } from "../lib/firebase.js";
import { LapField } from "../components/LapField.jsx";

const LapCalcView = ({
  user,
  isSignedIn,
  credits,
  setCredits,
  onRequireAuth
}) => {
  const [result, setResult] = useState(null);
  const [error, setError] = useState('');
  const [running, setRunning] = useState(false);
  const [defaults, setDefaults] = useState(null);
  const [saving, setSaving] = useState(false);
  const [saveMsg, setSaveMsg] = useState('');
  const refCarWeight = React.useRef(null);
  const refDragForce = React.useRef(null);
  const refMuRoll = React.useRef(null);
  const refWheelMOI = React.useRef(null);
  const LAP_CALC_COST = 10;
  const minSponsorshipForFree = 50; // USD
  const isSponsoredFree = user && user.sponsored && user.sponsorshipAmount >= minSponsorshipForFree;

  // Load saved defaults when user signs in
  useEffect(() => {
    if (!isSignedIn || !user) {
      setDefaults(null);
      return;
    }
    const ref = db.collection('users').doc(user.uid);
    const unsub = ref.onSnapshot(snap => {
      if (snap.exists) {
        const d = snap.data() || {};
        setDefaults(d.lapCalcDefaults || {});
      } else {
        setDefaults({});
      }
    });
    return () => unsub();
  }, [isSignedIn, user && user.uid]);

  // Populate inputs once defaults load
  useEffect(() => {
    if (!defaults) return;
    if (refCarWeight.current && defaults.carWeightG != null) refCarWeight.current.value = defaults.carWeightG;
    if (refDragForce.current && defaults.dragForceN != null) refDragForce.current.value = defaults.dragForceN;
    if (refMuRoll.current && defaults.muRoll != null) refMuRoll.current.value = defaults.muRoll;
    if (refWheelMOI.current && defaults.wheelMoiGMm2 != null) refWheelMOI.current.value = defaults.wheelMoiGMm2;
  }, [defaults]);
  const handleSaveDefaults = async () => {
    if (!isSignedIn) {
      onRequireAuth('Sign in to save defaults.');
      return;
    }
    setSaving(true);
    setSaveMsg('');
    try {
      await db.collection('users').doc(user.uid).set({
        lapCalcDefaults: {
          carWeightG: refCarWeight.current.value.trim(),
          dragForceN: refDragForce.current.value.trim(),
          muRoll: refMuRoll.current.value.trim(),
          wheelMoiGMm2: refWheelMOI.current.value.trim(),
          savedAt: firebase.firestore.FieldValue.serverTimestamp()
        }
      }, {
        merge: true
      });
      setSaveMsg('saved');
      setTimeout(() => setSaveMsg(''), 3000);
    } catch (e) {
      setSaveMsg('error');
    } finally {
      setSaving(false);
    }
  };
  const handleRun = async () => {
    setError('');
    setResult(null);
    if (!isSignedIn) {
      onRequireAuth('Sign in to use the Race Time Calculator.');
      return;
    }

    // Read from DOM refs - no controlled state, no jumping
    const carW = parseFloat(refCarWeight.current.value);
    const fDrag = parseFloat(refDragForce.current.value);
    const mu = parseFloat(refMuRoll.current.value);
    const iMOI = parseFloat(refWheelMOI.current.value);
    if (isNaN(carW) || isNaN(fDrag) || isNaN(mu) || isNaN(iMOI)) {
      setError('Please fill in all fields with valid numbers.');
      return;
    }
    if (carW <= 0) {
      setError('Car weight must be greater than 0.');
      return;
    }
    if (fDrag < 0 || mu < 0 || iMOI < 0) {
      setError('Values cannot be negative.');
      return;
    }
    if (!isSponsoredFree && credits < LAP_CALC_COST) {
      setError(`You need ${LAP_CALC_COST} credits to run this. You have ${credits}.`);
      return;
    }
    setRunning(true);
    try {
      // Get Firebase ID token to authenticate with Python Cloud Function
      const idToken = await firebase.auth().currentUser.getIdToken();
      // The project this build is configured for, not a project named in the
      // source. This URL was hardcoded to production, so the test site sent
      // every race-time calculation to production's function: test users spent
      // production compute, and locking production down would have broken a
      // page on the test site with no obvious cause.
      // No `|| 'turboflow-7b3ca'` fallback: a build that cannot say which
      // project it is should stop, not reach for production.
      const project = typeof window !== 'undefined' && window.FIREBASE_CONFIG?.projectId;
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
      if (!resp.ok) {
        setError(data.error || 'Simulation failed.');
      } else {
        setResult(data.finishTime);
      }
    } catch (e) {
      setError(e.message || 'Failed to reach simulation server.');
    } finally {
      setRunning(false);
    }
  };
  return /*#__PURE__*/React.createElement("div", {
    className: "lapcalc"
  }, /*#__PURE__*/React.createElement("div", {
    className: "lapcalc-form"
  }, /*#__PURE__*/React.createElement("div", {
    style: {
      marginBottom: 16,
      flexShrink: 0
    }
  }, /*#__PURE__*/React.createElement("h1", {
    className: "t-h1",
    style: { marginBottom: 4 }
  }, "Race time calculator"), /*#__PURE__*/React.createElement("p", {
    className: "t-small",
    style: { marginBottom: 8 }
  }, "A STEM Racing car over the 20 metre track."), /*#__PURE__*/React.createElement("div", {
    style: {
      display: 'inline-flex',
      alignItems: 'center',
      padding: '4px 10px',
      borderRadius: 4,
      background: isSponsoredFree ? 'var(--ok)' : 'var(--accent-wash)',
      border: isSponsoredFree ? '1px solid var(--ok)' : '1px solid var(--accent-wash)'
    }
  }, /*#__PURE__*/React.createElement("span", {
    style: {
      fontSize: 11,
      fontWeight: 600,
      color: isSponsoredFree ? 'var(--ok)' : 'var(--ink-3)',
    }
  }, isSponsoredFree ? 'Free for sponsored teams' : `${LAP_CALC_COST} credits per run`))), /*#__PURE__*/React.createElement("div", {
    style: {
      flex: 1,
      background: 'var(--inset)',
      border: '1px solid var(--rule)',
      borderRadius: 4,
      padding: '20px 20px 16px',
      display: 'flex',
      flexDirection: 'column',
      gap: 0,
      minHeight: 0
    }
  }, /*#__PURE__*/React.createElement("div", {
    style: {
      flex: 1,
      display: 'flex',
      flexDirection: 'column',
      gap: 10,
      minHeight: 0
    }
  }, /*#__PURE__*/React.createElement(LapField, {
    label: "Weight of car",
    refInput: refCarWeight,
    placeholder: "e.g. 48",
    unit: "g"
  }), /*#__PURE__*/React.createElement(LapField, {
    label: "Drag force at 20 m/s",
    refInput: refDragForce,
    placeholder: "e.g. 0.16",
    unit: "N"
  }), /*#__PURE__*/React.createElement(LapField, {
    label: "Rolling friction coefficient",
    refInput: refMuRoll,
    placeholder: "e.g. 0",
    unit: ""
  }), /*#__PURE__*/React.createElement(LapField, {
    label: "Wheel MOI",
    refInput: refWheelMOI,
    placeholder: "e.g. 100",
    unit: "g*mm^2"
  })), error && /*#__PURE__*/React.createElement("div", {
    style: {
      marginTop: 10,
      padding: '8px 12px',
      borderRadius: 4,
      background: 'var(--inset)',
      border: '1px solid var(--bad)',
      color: 'var(--bad)',
      fontSize: 13
    }
  }, error), /*#__PURE__*/React.createElement("button", {
    onClick: handleRun,
    disabled: running,
    className: "btn-primary btn-block",
    style: {
      marginTop: 14,
      padding: '14px',
      fontSize: 15,
      flexShrink: 0
    }
  }, running ? 'Running...' : isSponsoredFree ? 'Run Simulation (Free)' : `Run (${LAP_CALC_COST} credits)`)), /*#__PURE__*/React.createElement("div", {
    style: {
      marginTop: 12,
      flexShrink: 0,
      background: 'var(--inset)',
      border: '1px solid var(--rule)',
      borderRadius: 4,
      padding: '12px 14px'
    }
  }, /*#__PURE__*/React.createElement("div", {
    style: {
      display: 'flex',
      alignItems: 'center',
      justifyContent: 'space-between',
      marginBottom: 8
    }
  }, /*#__PURE__*/React.createElement("p", {
    style: {
      margin: 0,
      fontSize: 13,
      fontWeight: 700,
      color: 'var(--ink-2)'
    }
  }, "Saved defaults"), /*#__PURE__*/React.createElement("div", {
    style: {
      display: 'flex',
      alignItems: 'center',
      gap: 6
    }
  }, saveMsg === 'saved' && /*#__PURE__*/React.createElement("span", {
    style: {
      fontSize: 12,
      color: 'var(--ok)',
      fontWeight: 600
    }
  }, "Saved"), saveMsg === 'error' && /*#__PURE__*/React.createElement("span", {
    style: {
      fontSize: 12,
      color: 'var(--bad)',
      fontWeight: 600
    }
  }, "Failed"), /*#__PURE__*/React.createElement("button", {
    onClick: handleSaveDefaults,
    disabled: saving,
    style: {
      padding: '4px 12px',
      borderRadius: 4,
      fontSize: 12,
      fontWeight: 700,
      background: 'var(--accent-wash)',
      border: '1px solid var(--accent-wash)',
      color: 'var(--accent-soft)',
      cursor: 'pointer',
      whiteSpace: 'nowrap'
    }
  }, saving ? 'Saving...' : 'Save'))), defaults && Object.keys(defaults).filter(k => k !== 'savedAt').length > 0 ? /*#__PURE__*/React.createElement("table", {
    style: {
      width: '100%',
      borderCollapse: 'collapse',
      fontSize: 12
    }
  }, /*#__PURE__*/React.createElement("thead", null, /*#__PURE__*/React.createElement("tr", null, ['Parameter', 'Value'].map(h => /*#__PURE__*/React.createElement("th", {
    key: h,
    style: {
      textAlign: 'left',
      padding: '4px 6px',
      fontSize: 11,
      fontWeight: 700,
      color: 'var(--ink-4)',
      borderBottom: '1px solid var(--rule)'
    }
  }, h)))), /*#__PURE__*/React.createElement("tbody", null, [{
    key: 'carWeightG',
    label: 'Weight',
    unit: 'g'
  }, {
    key: 'dragForceN',
    label: 'Drag',
    unit: 'N'
  }, {
    key: 'muRoll',
    label: 'Mu roll',
    unit: ''
  }, {
    key: 'wheelMoiGMm2',
    label: 'Wheel MOI',
    unit: 'g*mm^2'
  }].map(({
    key,
    label,
    unit
  }, idx) => /*#__PURE__*/React.createElement("tr", {
    key: key,
    style: {
      background: idx % 2 === 0 ? 'transparent' : 'var(--panel-2)'
    }
  }, /*#__PURE__*/React.createElement("td", {
    style: {
      padding: '6px 6px',
      color: 'var(--ink-2)'
    }
  }, label), /*#__PURE__*/React.createElement("td", {
    style: {
      padding: '6px 6px',
      color: 'var(--ink)',
      fontWeight: 600,
      fontFamily: 'IBM Plex Mono,monospace'
    }
  }, defaults[key] != null && defaults[key] !== '' ? `${defaults[key]}${unit ? ' ' + unit : ''}` : /*#__PURE__*/React.createElement("span", {
    style: {
      color: 'var(--rule-strong)'
    }
  }, "-")))))) : /*#__PURE__*/React.createElement("p", {
    style: {
      margin: 0,
      fontSize: 12,
      color: 'var(--rule-strong)',
      fontStyle: 'italic'
    }
  }, "No defaults saved yet."), defaults && defaults.savedAt && /*#__PURE__*/React.createElement("p", {
    style: {
      margin: '6px 0 0',
      fontSize: 11,
      color: 'var(--ink-3)'
    }
  }, "Last saved: ", defaults.savedAt.toDate ? defaults.savedAt.toDate().toLocaleString() : 'Not available'))), /*#__PURE__*/React.createElement("div", {
    className: "lapcalc-result"
  }, /*#__PURE__*/React.createElement("div", {
    style: {
      position: 'absolute',
      inset: 0,
      background: 'none',
      transition: 'background 0.4s',
      pointerEvents: 'none'
    }
  }), result !== null ? /*#__PURE__*/React.createElement("div", {
    style: {
      textAlign: 'center',
      position: 'relative',
      zIndex: 1
    }
  }, /*#__PURE__*/React.createElement("p", {
    style: {
      fontSize: 11,
      fontWeight: 700,
      color: 'var(--ok)',
      marginBottom: 16
    }
  }, "Predicted finish time"), /*#__PURE__*/React.createElement("p", {
    style: {
      fontSize: 'clamp(48px,8vw,96px)',
      fontWeight: 700,
      color: 'var(--ink-hi)',
      margin: 0,
      letterSpacing: '-0.03em',
      lineHeight: 1,
      fontFamily: 'IBM Plex Mono,monospace'
    }
  }, result.toFixed(4), /*#__PURE__*/React.createElement("span", {
    style: {
      fontSize: 16,
      fontWeight: 400,
      color: 'var(--ink-4)',
      marginLeft: 8
    }
  }, "s")), /*#__PURE__*/React.createElement("p", {
    style: {
      fontSize: 11,
      color: 'var(--rule-strong)',
      marginTop: 14,
      letterSpacing: '0.06em'
    }
  }, "20 m - CO2 canister - k-omega SST scaled")) : /*#__PURE__*/React.createElement("div", {
    style: {
      textAlign: 'center',
      position: 'relative',
      zIndex: 1
    }
  }, /*#__PURE__*/React.createElement("p", {
    style: {
      fontSize: 11,
      fontWeight: 700,
      color: 'var(--ink-4)',
      marginBottom: 16
    }
  }, "Predicted finish time"), /*#__PURE__*/React.createElement("p", {
    style: {
      fontSize: 'clamp(48px,8vw,96px)',
      fontWeight: 700,
      color: 'var(--ink-hi)',
      margin: '0 0 10px',
      letterSpacing: '-0.03em',
      lineHeight: 1,
      fontFamily: 'IBM Plex Mono,monospace',
      userSelect: 'none'
    }
  }, "0.0000", /*#__PURE__*/React.createElement("span", {
    style: {
      fontSize: 16,
      fontWeight: 400,
      color: 'var(--ink-4)',
      marginLeft: 8
    }
  }, "s")), /*#__PURE__*/React.createElement("p", {
    style: {
      fontSize: 13,
      color: 'var(--ink-4)',
      margin: 0
    }
  }, running ? 'Running...' : 'Your result will appear here'))));
};
// The old file's bootstrap line lived here, mounting the single App into
// #root. Each page has its own entry now, so it does not belong in a view.

export { LapCalcView };
