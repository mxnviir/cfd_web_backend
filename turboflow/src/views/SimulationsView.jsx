// Extracted from app.compiled.js, which held every screen in one file.
//
// The bodies are the original generated React.createElement output, unchanged.
// Only the packaging is new: this is a module now, so a page that does not use
// it does not download it.

import React, { useEffect, useState } from "react";
import { auth, db, firebase, functions, storage } from "../lib/firebase.js";
import { StatusBadge } from "../lib/status.js";

const _raceTimeCache = {};

const SimulationsView = ({
  user,
  isSignedIn,
  credits,
  setCredits
}) => {
  const [jobs, setJobs] = useState([]);
  // Each Workbench run's own results, by the job that ran it. See below.
  const [runSummaries, setRunSummaries] = useState({});
  const [loading, setLoading] = useState(true);
  const [copied, setCopied] = useState(false);
  // A download that failed, by job, so the message sits beside its button.
  const [downloadError, setDownloadError] = useState({});
  const [token, setToken] = useState(null);
  const [refunding, setRefunding] = useState({});
  const [refundError, setRefundError] = useState({});
  const [lapDefaults, setLapDefaults] = useState(null);
  // Stores fetched race times keyed by jobId ? persists across Firestore re-renders
  const [, forceUpdate] = React.useReducer(x => x + 1, 0);

  // This used to show auth.currentUser.refreshToken — the credential Firebase
  // uses to mint sessions for the account. It granted everything the account
  // could do, never expired, could not be revoked, and was printed on screen
  // where a screenshot or a shared screen would carry it away.
  //
  // Now nothing is shown until the user asks for one, and what they get is a
  // random token that can be revoked and that only lets the add-in submit jobs.
  const [minting, setMinting] = useState(false);
  const [tokenError, setTokenError] = useState(null);

  const createToken = async () => {
    setMinting(true);
    setTokenError(null);
    try {
      const res = await functions.httpsCallable('createFusionToken')({ label: 'Fusion 360' });
      setToken(res.data.token);
    } catch (e) {
      setTokenError(e && e.message ? e.message : 'Could not create a token.');
    } finally {
      setMinting(false);
    }
  };

  // Load lap calc defaults + persisted race times from user doc
  useEffect(() => {
    if (!isSignedIn || !user) {
      setLapDefaults(null);
      return;
    }
    const unsub = db.collection('users').doc(user.uid).onSnapshot(snap => {
      if (snap.exists) {
        const d = snap.data() || {};
        setLapDefaults(d.lapCalcDefaults || null);
        // Restore any previously computed race times into the module cache
        const saved = d.jobRaceTimes || {};
        Object.assign(_raceTimeCache, saved);
      } else {
        setLapDefaults(null);
      }
    });
    return () => unsub();
  }, [isSignedIn, user && user.uid]);

  // Live listener for this user's jobs
  useEffect(() => {
    if (!isSignedIn || !user) {
      setLoading(false);
      return;
    }
    const unsub = db.collection('jobs').where('userId', '==', user.uid).limit(20).onSnapshot(snap => {
      const docs = snap.docs.map(d => ({
        id: d.id,
        ...d.data()
      }));
      docs.sort((a, b) => {
        const toMs = ts => {
          if (!ts) return 0;
          if (ts.toMillis) return ts.toMillis();
          if (ts.toDate) return ts.toDate().getTime();
          return new Date(ts).getTime();
        };
        return toMs(b.createdAt) - toMs(a.createdAt);
      });
      setJobs(docs);
      setLoading(false);
    }, err => {
      console.error('[SimulationsView] Listener error:', err.code, err.message);
      setLoading(false);
    });
    return () => unsub();
  }, [isSignedIn, user]);

  // Where a Workbench run keeps its drag and lift.
  //
  // The Fusion add-in's worker writes drag_N and lift_N onto the job, and this
  // page only ever read the job. A run started from the Workbench writes its
  // results to its run document instead, so every one of them sat here as
  // "Complete" with drag, lift and race time "Pending" for ever. Reading the
  // run as well fixes the ones already finished, not just the next one.
  useEffect(() => {
    if (!isSignedIn || !user) return undefined;
    const unsub = db.collection('runs').where('userId', '==', user.uid).limit(50).onSnapshot(snap => {
      const byJob = {};
      snap.docs.forEach(d => {
        const r = d.data();
        if (r.jobId && r.summary) byJob[r.jobId] = r.summary;
      });
      setRunSummaries(byJob);
    }, err => console.error('[SimulationsView] runs listener error:', err.code, err.message));
    return () => unsub();
  }, [isSignedIn, user]);
  const shownJobs = jobs.map(job => {
    const s = runSummaries[job.id];
    if (!s) return job;
    return {
      ...job,
      drag_N: job.drag_N ?? (Number.isFinite(s.drag) ? s.drag : undefined),
      lift_N: job.lift_N ?? (Number.isFinite(s.lift) ? s.lift : undefined),
    };
  });
  const copyToken = () => {
    if (!token) return;
    navigator.clipboard.writeText(token).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 2500);
    });
  };

  // Refundable = meshing hasn't finished yet
  const canRefund = status => ['pending', 'downloading', 'uploading_geometry', 'processing', 'creating_simulation', 'meshing'].includes(status) && status !== 'cancelling';
  const handleRefund = async job => {
    if (!canRefund(job.status)) return;
    // What this job was actually charged, not a number from an older price list.
    const amount = Number.isFinite(Number(job.cost)) ? Number(job.cost) : null;
    if (!window.confirm(amount != null
      ? `Cancel this simulation and refund ${amount} credits?`
      : 'Cancel this simulation and refund what it cost?')) return;
    setRefunding(r => ({
      ...r,
      [job.id]: true
    }));
    setRefundError(e => ({ ...e, [job.id]: null }));
    try {
      const refundFn = firebase.functions().httpsCallable('refundJob');
      await refundFn({
        job_id: job.id
      });
      // credits will update via the live user doc listener in App
    } catch (e) {
      setRefundError(r => ({ ...r, [job.id]: 'The run was not cancelled and nothing was refunded: ' + (e.message || e) }));
    } finally {
      setRefunding(r => ({
        ...r,
        [job.id]: false
      }));
    }
  };
  const formatDate = ts => {
    if (!ts) return 'Not available';
    try {
      const d = ts.toDate ? ts.toDate() : ts.toMillis ? new Date(ts.toMillis()) : new Date(ts);
      if (isNaN(d.getTime())) return 'Not available';
      return d.toLocaleDateString('en-GB', {
        day: 'numeric',
        month: 'short',
        year: 'numeric',
        hour: '2-digit',
        minute: '2-digit'
      });
    } catch {
      return 'Not available';
    }
  };
  const fmt = (n, dec = 3) => n == null ? 'Pending' : Number(n).toFixed(dec);
  if (!isSignedIn) return /*#__PURE__*/React.createElement("div", {
    style: {
      padding: '64px 32px',
      display: 'flex',
      flexDirection: 'column',
      alignItems: 'center',
      justifyContent: 'center',
      gap: 16,
      height: '60vh'
    }
  }, /*#__PURE__*/React.createElement("div", {
    style: {
      fontSize: 40,
      opacity: 0.3
    }
  }), /*#__PURE__*/React.createElement("p", {
    className: "t-body"
  }, "Sign in to view your simulations."));
  return /*#__PURE__*/React.createElement("div", {
    className: "page"
  }, /*#__PURE__*/React.createElement("div", {
    className: "page-head"
  }, /*#__PURE__*/React.createElement("h1", {
    className: "t-h1"
  }, "My simulations"), /*#__PURE__*/React.createElement("p", {
    className: "t-body"
  }, "Live status of every run, from the Workbench or the Fusion 360 add-in.")), /*#__PURE__*/React.createElement("div", {
    style: {
      background: 'var(--accent-wash)',
      border: '1px solid var(--accent-wash)',
      borderRadius: 4,
      padding: 24,
      marginBottom: 40
    }
  }, /*#__PURE__*/React.createElement("div", {
    style: {
      display: 'flex',
      alignItems: 'flex-start',
      justifyContent: 'space-between',
      gap: 16,
      flexWrap: 'wrap'
    }
  }, /*#__PURE__*/React.createElement("div", {
    style: {
      flex: 1,
      minWidth: 200
    }
  }, /*#__PURE__*/React.createElement("p", {
    style: {
      fontWeight: 700,
      color: 'var(--ink)',
      marginBottom: 6,
      fontSize: 15
    }
  }, "Fusion 360 connection token"), /*#__PURE__*/React.createElement("p", {
    className: "t-small"
  }, "Copy this token into the Account box of the TurboFlow add-in, or set it as", " ", /*#__PURE__*/React.createElement("code", {
    style: {
      background: 'var(--panel-2)',
      padding: '1px 6px',
      borderRadius: 4,
      fontFamily: 'monospace',
      color: 'var(--accent-hi)'
    }
  }, "CONNECTION_TOKEN"), " at the top of TurboFlow_CFD.py. It is shown once, so copy it now. If you lose it, "
   + "create another and this one stops working. Revoke it any time and the "
   + "add-in loses access without touching the rest of your account.")), /*#__PURE__*/React.createElement("button", {
    onClick: token ? copyToken : createToken,
    disabled: minting,
    style: {
      padding: '10px 20px',
      borderRadius: 4,
      fontWeight: 700,
      fontSize: 13,
      cursor: 'pointer',
      background: copied ? 'var(--ok)' : 'var(--accent-wash)',
      color: copied ? 'var(--ok)' : 'var(--accent-soft)',
      border: copied ? '1px solid var(--ok)' : '1px solid var(--accent-wash)',
      transition: 'background-color 0.2s, border-color 0.2s, color 0.2s',
      whiteSpace: 'nowrap'
    }
  }, minting ? 'Creating…' : copied ? 'Copied' : token ? 'Copy token' : 'Create token')),
  tokenError && /*#__PURE__*/React.createElement("p", {
    className: "t-small",
    role: "alert",
    style: { color: 'var(--bad)', marginTop: 10 }
  }, tokenError),
  token && /*#__PURE__*/React.createElement("div", {
    style: {
      marginTop: 14,
      background: 'var(--inset)',
      borderRadius: 4,
      padding: '10px 14px',
      fontFamily: 'monospace',
      fontSize: 11,
      color: 'var(--ink-4)',
      wordBreak: 'break-all',
      border: '1px solid var(--rule)',
      maxHeight: 52,
      overflow: 'hidden',
      WebkitMaskImage: 'linear-gradient(to right, black 55%, transparent 100%)' /* design: data, overflow fade */
    }
  }, token), !token && /*#__PURE__*/React.createElement("div", {
    style: {
      marginTop: 12,
      fontSize: 12,
      color: 'var(--ink-3)'
    }
  }, "No token yet. Create one, then paste it into the add-in.")), loading ? /*#__PURE__*/React.createElement("div", {
    className: "skeleton-list",
    role: "status",
    "aria-label": "Loading your runs"
  }, [0, 1, 2].map(i => /*#__PURE__*/React.createElement("div", {
    key: i,
    className: "skeleton-card"
  }, /*#__PURE__*/React.createElement("span", {
    className: "skeleton-line skeleton-line-short"
  }), /*#__PURE__*/React.createElement("span", {
    className: "skeleton-line"
  }), /*#__PURE__*/React.createElement("span", {
    className: "skeleton-block"
  })))) : jobs.length === 0 ? /*#__PURE__*/React.createElement("div", {
    style: {
      padding: '48px 0',
      color: 'var(--ink-4)'
    }
  }, /*#__PURE__*/React.createElement("p", {
    className: "t-body"
  }, "No runs here yet."), /*#__PURE__*/React.createElement("p", {
    className: "t-small"
  }, "Open the Workbench to upload a car and build a wind tunnel around it, or install the Fusion 360 add-in if you would rather set the tunnel up in CAD.")) : /*#__PURE__*/React.createElement("div", {
    style: {
      display: 'flex',
      flexDirection: 'column',
      gap: 12
    }
  }, shownJobs.map(job => /*#__PURE__*/React.createElement("div", {
    key: job.id,
    style: {
      background: 'var(--panel)',
      border: '1px solid var(--rule)',
      borderRadius: 4,
      padding: 20,
      transition: 'border-color 0.2s'
    },
    onMouseOver: e => e.currentTarget.style.borderColor = 'var(--rule)',
    onMouseOut: e => e.currentTarget.style.borderColor = 'var(--rule)'
  }, /*#__PURE__*/React.createElement("div", {
    style: {
      display: 'flex',
      alignItems: 'flex-start',
      justifyContent: 'space-between',
      gap: 12,
      flexWrap: 'wrap',
      marginBottom: 12
    }
  }, /*#__PURE__*/React.createElement("div", null, /*#__PURE__*/React.createElement("div", {
    style: {
      display: 'flex',
      alignItems: 'center',
      gap: 8,
      marginBottom: 4
    }
  }, /*#__PURE__*/React.createElement(StatusBadge, {
    status: job.status
  })), /*#__PURE__*/React.createElement("p", {
    style: {
      fontFamily: 'monospace',
      fontSize: 11,
      color: 'var(--ink-3)',
      marginTop: 2
    }
  }, job.id)), /*#__PURE__*/React.createElement("div", {
    style: {
      display: 'flex',
      alignItems: 'center',
      gap: 10
    }
  }, /*#__PURE__*/React.createElement("p", {
    style: {
      fontSize: 13,
      color: 'var(--ink-3)',
      whiteSpace: 'nowrap'
    }
  }, formatDate(job.createdAt)), canRefund(job.status) && /*#__PURE__*/React.createElement("button", {
    onClick: () => handleRefund(job),
    disabled: !!refunding[job.id],
    style: {
      padding: '5px 12px',
      borderRadius: 4,
      fontSize: 12,
      fontWeight: 700,
      cursor: 'pointer',
      background: 'var(--inset)',
      color: 'var(--bad)',
      border: '1px solid var(--bad)',
      opacity: refunding[job.id] ? 0.5 : 1
    }
  }, refunding[job.id] ? 'Cancelling...' : 'Cancel and refund'))), refundError[job.id] && /*#__PURE__*/React.createElement("p", {
    role: "alert",
    className: "field-error",
    style: { margin: '0 0 12px' }
  }, refundError[job.id]), /*#__PURE__*/React.createElement("div", {
    style: {
      display: 'grid',
      gridTemplateColumns: 'repeat(auto-fill,minmax(130px,1fr))',
      gap: 8,
      marginBottom: 12
    }
  }, job.faceCount != null && /*#__PURE__*/React.createElement("div", {
    style: {
      background: 'var(--inset)',
      borderRadius: 4,
      padding: '8px 12px',
      border: '1px solid var(--rule)'
    }
  }, /*#__PURE__*/React.createElement("p", {
    style: {
      fontSize: 10,
      color: 'var(--ink-3)',
      fontWeight: 600,
      marginBottom: 3
    }
  }, "Faces"), /*#__PURE__*/React.createElement("p", {
    style: {
      fontSize: 14,
      color: 'var(--ink-hi)',
      fontWeight: 700
    }
  }, job.faceCount)), /*#__PURE__*/React.createElement("div", {
    style: {
      background: 'var(--inset)',
      borderRadius: 4,
      padding: '8px 12px',
      border: '1px solid var(--rule)'
    }
  }, /*#__PURE__*/React.createElement("p", {
    style: {
      fontSize: 10,
      color: 'var(--ink-3)',
      fontWeight: 600,
      marginBottom: 3
    }
  }, "Drag"), /*#__PURE__*/React.createElement("p", {
    style: {
      fontSize: 14,
      color: 'var(--ink-hi)',
      fontWeight: 700
    }
  }, job.status === 'complete' && job.drag_N != null ? fmt(Math.abs(job.drag_N)) + ' N' : 'Pending')), /*#__PURE__*/React.createElement("div", {
    style: {
      background: 'var(--inset)',
      borderRadius: 4,
      padding: '8px 12px',
      border: '1px solid var(--rule)'
    }
  }, /*#__PURE__*/React.createElement("p", {
    style: {
      fontSize: 10,
      color: 'var(--ink-3)',
      fontWeight: 600,
      marginBottom: 3
    }
  }, "Lift (negative is downforce)"), /*#__PURE__*/React.createElement("p", {
    style: {
      fontSize: 14,
      color: 'var(--ink-hi)',
      fontWeight: 700
    }
  }, job.status === 'complete' && job.lift_N != null ? fmt(job.lift_N) + ' N' : 'Pending')), (() => {
    if (job.status !== 'complete' || job.drag_N == null || !lapDefaults) return /*#__PURE__*/React.createElement("div", {
      style: {
        background: 'var(--inset)',
        borderRadius: 4,
        padding: '6px 10px',
        border: '1px solid var(--warn)'
      }
    }, /*#__PURE__*/React.createElement("p", {
      style: {
        fontSize: 10,
        color: 'var(--warn)',
        fontWeight: 700,
        marginBottom: 2
      }
    }, "Race time"), job.status !== 'complete' || job.drag_N == null ? /*#__PURE__*/React.createElement("p", {
      style: {
        fontSize: 13,
        color: 'var(--ink-4)',
        fontWeight: 600
      }
    }, "Pending") : /*#__PURE__*/React.createElement("p", {
      style: {
        fontSize: 10,
        color: 'var(--ink-3)',
        fontWeight: 400,
        margin: 0
      }
    }, "Set defaults in", /*#__PURE__*/React.createElement("br", null), "Race time calculator"));
    const drag = Math.abs(job.drag_N);
    const carW = parseFloat(lapDefaults.carWeightG);
    const mu = parseFloat(lapDefaults.muRoll);
    const iMOI = parseFloat(lapDefaults.wheelMoiGMm2);
    if (isNaN(carW) || carW <= 0 || isNaN(mu) || isNaN(iMOI)) return /*#__PURE__*/React.createElement("div", {
      style: {
        background: 'var(--inset)',
        borderRadius: 4,
        padding: '6px 10px',
        border: '1px solid var(--warn)'
      }
    }, /*#__PURE__*/React.createElement("p", {
      style: {
        fontSize: 10,
        color: 'var(--warn)',
        fontWeight: 700,
        marginBottom: 2
      }
    }, "Race time"), /*#__PURE__*/React.createElement("p", {
      style: {
        fontSize: 11,
        color: 'var(--ink-4)',
        fontWeight: 600
      }
    }, "Save defaults"));
    // Use Firestore-cached value if available, else check in-memory ref
    const raceTime = _raceTimeCache[job.id] != null ? _raceTimeCache[job.id] : null;
    if (raceTime == null && !_raceTimeCache['_fetching_' + job.id]) {
      _raceTimeCache['_fetching_' + job.id] = true;
      (async () => {
        try {
          const u = auth.currentUser;
          if (!u) return;
          const idToken = await u.getIdToken();
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
              'Authorization': 'Bearer ' + idToken
            },
            body: JSON.stringify({
              carWeightG: carW,
              dragForceN: drag,
              muRoll: mu,
              wheelMoiGMm2: iMOI,
              preview: true
            })
          });
          const data = await resp.json();
          if (resp.ok && data.finishTime != null) {
            _raceTimeCache[job.id] = data.finishTime;
            try {
              await db.collection('users').doc(user.uid).set({
                jobRaceTimes: {
                  [job.id]: data.finishTime
                }
              }, {
                merge: true
              });
            } catch (e) {
              console.warn('cache write failed', e);
            }
            forceUpdate();
          }
        } catch (e) {
          console.warn('race time fetch failed', e);
        } finally {
          _raceTimeCache['_fetching_' + job.id] = false;
        }
      })();
    }
    return /*#__PURE__*/React.createElement("div", {
      style: {
        background: 'var(--inset)',
        borderRadius: 4,
        padding: '6px 10px',
        border: '1px solid var(--warn)',
        gridColumn: 'span 2'
      }
    }, /*#__PURE__*/React.createElement("p", {
      style: {
        fontSize: 10,
        color: 'var(--warn)',
        fontWeight: 700,
        marginBottom: 2
      }
    }, "Predicted race time"), raceTime != null ? /*#__PURE__*/React.createElement("p", {
      style: {
        fontSize: 15,
        color: 'var(--warn)',
        fontWeight: 700,
        fontFamily: 'IBM Plex Mono,monospace',
        margin: 0
      }
    }, Number(raceTime).toFixed(4), " s") : /*#__PURE__*/React.createElement("p", {
      style: {
        fontSize: 12,
        color: 'var(--ink-4)',
        margin: 0
      }
    }, "Calculating…"));
  })()), job.status === 'complete' && job.casePath && /*#__PURE__*/React.createElement("div", {
    style: {
      marginTop: 4
    }
  }, /*#__PURE__*/React.createElement("button", {
    // The OpenFOAM case the worker keeps for 90 days. This button used to copy
    // the job id and send people to Instagram to ask for files by hand.
    onClick: async () => {
      setDownloadError(e => ({ ...e, [job.id]: null }));
      try { window.open(await storage.url(job.casePath), '_blank', 'noopener'); }
      catch (err) { setDownloadError(e => ({ ...e, [job.id]: err.message || 'That download could not be opened.' })); }
    },
    style: {
      display: 'inline-flex',
      alignItems: 'center',
      gap: 8,
      padding: '8px 12px',
      borderRadius: 4,
      background: 'transparent',
      color: 'var(--ink)',
      border: '1px solid var(--rule)',
      fontSize: 12,
      fontWeight: 600,
      cursor: 'pointer'
    }
  }, "Download results for ParaView"), downloadError[job.id] && /*#__PURE__*/React.createElement("p", {
    role: "alert",
    style: { margin: '6px 0 0', fontSize: 12, color: 'var(--bad)' }
  }, downloadError[job.id])), job.status === 'failed' && job.error && /*#__PURE__*/React.createElement("div", {
    style: {
      marginTop: 12,
      background: 'var(--inset)',
      border: '1px solid var(--bad)',
      borderRadius: 4,
      padding: '10px 14px',
      fontSize: 12,
      color: 'var(--bad)',
      fontFamily: 'monospace'
    }
  }, job.error)))));
};

/* -- Inline Race Calc (used on homepage page 5) ---------- */

export { _raceTimeCache, SimulationsView };
