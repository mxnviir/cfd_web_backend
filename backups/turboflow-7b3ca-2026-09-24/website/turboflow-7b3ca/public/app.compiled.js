// Destructure from the Global window object instead of "import"
const {
  useState,
  useEffect,
  useRef
} = React;
// Guard globals accessed from optional CDN bundles to avoid ReferenceError when absent
const Recharts = window && window.Recharts ? window.Recharts : {};
const {
  LineChart,
  Line,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  Legend,
  ResponsiveContainer
} = Recharts;
const lucide = window && (window.lucide || window.Lucide) ? window.lucide || window.Lucide : {};
const {
  ArrowRight,
  Wind,
  Zap,
  ShieldCheck,
  Upload,
  CheckCircle,
  ChevronDown,
  ChevronRight,
  Calculator,
  Bot,
  Activity,
  Loader2,
  CheckCircle2,
  FileText,
  Share2,
  Award,
  Download,
  ArrowLeft,
  Home,
  LayoutDashboard,
  User,
  Settings,
  LogOut,
  Server
} = lucide;

// Use the Firebase global variables we defined in Change 2
// No need for 'const auth = getAuth()' anymore

// --- Firestore helpers ---
const recordCreditTransaction = async (userId, amount, reason, type) => {
  if (!userId) throw new Error('Missing userId');
  const userRef = db.collection('users').doc(userId);
  const txRef = userRef.collection('transactions').doc();
  const batch = db.batch();
  batch.update(userRef, {
    credits: firebase.firestore.FieldValue.increment(amount)
  });
  if (amount < 0) {
    batch.update(userRef, {
      totalSpent: firebase.firestore.FieldValue.increment(Math.abs(amount))
    });
  }
  batch.set(txRef, {
    amount,
    reason: reason || '',
    type: type || 'usage',
    timestamp: firebase.firestore.FieldValue.serverTimestamp()
  });
  await batch.commit();
  return true;
};

// submitJobToFirestore calls the Cloud Function so credit deduction
// happens server-side and cannot be blocked by Firestore rules.
const submitJobToFirestore = async ({
  user,
  part,
  fileName,
  cost,
  chordLength
}) => {
  const uid = user && user.uid || auth.currentUser && auth.currentUser.uid;
  if (!uid) throw new Error('Not authenticated');
  const teamName = user && user.teamName || null;
  const submitJobFn = functions.httpsCallable('submitSimulationJob');
  const result = await submitJobFn({
    partType: part,
    fileName: fileName || null,
    teamName,
    cost,
    chordLength: chordLength || null
  });
  const {
    jobId
  } = result.data;
  return {
    id: jobId,
    userId: uid,
    part,
    fileName,
    cost,
    status: 'queued'
  };
};
const cancelAndRefund = async jobId => {
  if (!jobId) throw new Error('Missing jobId');
  const jobRef = db.collection('jobs').doc(jobId);
  const jobSnap = await jobRef.get();
  if (!jobSnap.exists) throw new Error('Job not found');
  const job = jobSnap.data();
  if (!(job.status === 'queued' || job.status === 'pending')) throw new Error('Job not refundable');
  const userRef = db.collection('users').doc(job.userId);
  const txRef = userRef.collection('transactions').doc();
  const batch = db.batch();
  batch.update(userRef, {
    credits: firebase.firestore.FieldValue.increment(job.cost)
  });
  batch.set(txRef, {
    amount: job.cost,
    reason: 'Refund: ' + (job.fileName || job.part),
    type: 'refund',
    timestamp: firebase.firestore.FieldValue.serverTimestamp()
  });
  batch.delete(jobRef);
  await batch.commit();
  return true;
};

/* -- Icons ----------------------------------------------- */
const Ic = {
  Dashboard: (s = 18) => /*#__PURE__*/React.createElement("svg", {
    width: s,
    height: s,
    viewBox: "0 0 24 24",
    fill: "none",
    stroke: "currentColor",
    strokeWidth: "1.5",
    strokeLinecap: "round",
    strokeLinejoin: "round"
  }, /*#__PURE__*/React.createElement("rect", {
    width: "7",
    height: "9",
    x: "3",
    y: "3",
    rx: "1"
  }), /*#__PURE__*/React.createElement("rect", {
    width: "7",
    height: "5",
    x: "14",
    y: "3",
    rx: "1"
  }), /*#__PURE__*/React.createElement("rect", {
    width: "7",
    height: "9",
    x: "14",
    y: "12",
    rx: "1"
  }), /*#__PURE__*/React.createElement("rect", {
    width: "7",
    height: "5",
    x: "3",
    y: "16",
    rx: "1"
  })),
  Solve: (s = 18) => /*#__PURE__*/React.createElement("svg", {
    width: s,
    height: s,
    viewBox: "0 0 24 24",
    fill: "none",
    stroke: "currentColor",
    strokeWidth: "1.5"
  }, /*#__PURE__*/React.createElement("path", {
    d: "m12 14 4-4 4 4-4 4-4-4Z"
  }), /*#__PURE__*/React.createElement("path", {
    d: "M16 10V2"
  }), /*#__PURE__*/React.createElement("path", {
    d: "M7 21v-4"
  }), /*#__PURE__*/React.createElement("path", {
    d: "M7 13V3"
  }), /*#__PURE__*/React.createElement("path", {
    d: "M3 17h4"
  })),
  Docs: (s = 18) => /*#__PURE__*/React.createElement("svg", {
    width: s,
    height: s,
    viewBox: "0 0 24 24",
    fill: "none",
    stroke: "currentColor",
    strokeWidth: "1.5"
  }, /*#__PURE__*/React.createElement("path", {
    d: "M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"
  }), /*#__PURE__*/React.createElement("polyline", {
    points: "14 2 14 8 20 8"
  }), /*#__PURE__*/React.createElement("line", {
    x1: "16",
    y1: "13",
    x2: "8",
    y2: "13"
  }), /*#__PURE__*/React.createElement("line", {
    x1: "16",
    y1: "17",
    x2: "8",
    y2: "17"
  })),
  Billing: (s = 18) => /*#__PURE__*/React.createElement("svg", {
    width: s,
    height: s,
    viewBox: "0 0 24 24",
    fill: "none",
    stroke: "currentColor",
    strokeWidth: "1.5"
  }, /*#__PURE__*/React.createElement("rect", {
    width: "20",
    height: "14",
    x: "2",
    y: "5",
    rx: "2"
  }), /*#__PURE__*/React.createElement("line", {
    x1: "2",
    x2: "22",
    y1: "10",
    y2: "10"
  })),
  Trophy: (s = 18) => /*#__PURE__*/React.createElement("svg", {
    width: s,
    height: s,
    viewBox: "0 0 24 24",
    fill: "none",
    stroke: "currentColor",
    strokeWidth: "1.5"
  }, /*#__PURE__*/React.createElement("path", {
    d: "M6 9H4.5a2.5 2.5 0 0 1 0-5H6"
  }), /*#__PURE__*/React.createElement("path", {
    d: "M18 9h1.5a2.5 2.5 0 0 0 0-5H18"
  }), /*#__PURE__*/React.createElement("path", {
    d: "M4 22h16"
  }), /*#__PURE__*/React.createElement("path", {
    d: "M10 14.66V17c0 .55-.47.98-.97 1.21C7.85 18.75 7 20.24 7 22"
  }), /*#__PURE__*/React.createElement("path", {
    d: "M14 14.66V17c0 .55.47.98.97 1.21C16.15 18.75 17 20.24 17 22"
  }), /*#__PURE__*/React.createElement("path", {
    d: "M18 2H6v7a6 6 0 0 0 12 0V2Z"
  })),
  Tag: (s = 18) => /*#__PURE__*/React.createElement("svg", {
    width: s,
    height: s,
    viewBox: "0 0 24 24",
    fill: "none",
    stroke: "currentColor",
    strokeWidth: "1.5"
  }, /*#__PURE__*/React.createElement("path", {
    d: "M20.59 13.41l-7.17 7.17a2 2 0 0 1-2.83 0L2 12V2h10l8.59 8.59a2 2 0 0 1 0 2.82z"
  }), /*#__PURE__*/React.createElement("line", {
    x1: "7",
    y1: "7",
    x2: "7.01",
    y2: "7"
  })),
  Wrench: (s = 18) => /*#__PURE__*/React.createElement("svg", {
    width: s,
    height: s,
    viewBox: "0 0 24 24",
    fill: "none",
    stroke: "currentColor",
    strokeWidth: "1.5"
  }, /*#__PURE__*/React.createElement("path", {
    d: "M14.7 6.3a1 1 0 0 0 0 1.4l1.6 1.6a1 1 0 0 0 1.4 0l3.77-3.77a6 6 0 0 1-7.94 7.94l-6.91 6.91a2.12 2.12 0 0 1-3-3l6.91-6.91a6 6 0 0 1 7.94-7.94l-3.76 3.76z"
  })),
  Lock: (s = 14) => /*#__PURE__*/React.createElement("svg", {
    width: s,
    height: s,
    viewBox: "0 0 24 24",
    fill: "none",
    stroke: "currentColor",
    strokeWidth: "2"
  }, /*#__PURE__*/React.createElement("rect", {
    x: "3",
    y: "11",
    width: "18",
    height: "11",
    rx: "2",
    ry: "2"
  }), /*#__PURE__*/React.createElement("path", {
    d: "M7 11V7a5 5 0 0 1 10 0v4"
  })),
  Upload: (s = 20) => /*#__PURE__*/React.createElement("svg", {
    width: s,
    height: s,
    viewBox: "0 0 24 24",
    fill: "none",
    stroke: "currentColor",
    strokeWidth: "1.5"
  }, /*#__PURE__*/React.createElement("polyline", {
    points: "16 16 12 12 8 16"
  }), /*#__PURE__*/React.createElement("line", {
    x1: "12",
    y1: "12",
    x2: "12",
    y2: "21"
  }), /*#__PURE__*/React.createElement("path", {
    d: "M20.39 18.39A5 5 0 0 0 18 9h-1.26A8 8 0 1 0 3 16.3"
  })),
  X: (s = 15) => /*#__PURE__*/React.createElement("svg", {
    width: s,
    height: s,
    viewBox: "0 0 24 24",
    fill: "none",
    stroke: "currentColor",
    strokeWidth: "2"
  }, /*#__PURE__*/React.createElement("line", {
    x1: "18",
    y1: "6",
    x2: "6",
    y2: "18"
  }), /*#__PURE__*/React.createElement("line", {
    x1: "6",
    y1: "6",
    x2: "18",
    y2: "18"
  })),
  Check: (s = 14) => /*#__PURE__*/React.createElement("svg", {
    width: s,
    height: s,
    viewBox: "0 0 24 24",
    fill: "none",
    stroke: "currentColor",
    strokeWidth: "2.5"
  }, /*#__PURE__*/React.createElement("polyline", {
    points: "20 6 9 17 4 12"
  })),
  SignOut: (s = 14) => /*#__PURE__*/React.createElement("svg", {
    width: s,
    height: s,
    viewBox: "0 0 24 24",
    fill: "none",
    stroke: "currentColor",
    strokeWidth: "2"
  }, /*#__PURE__*/React.createElement("path", {
    d: "M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4"
  }), /*#__PURE__*/React.createElement("polyline", {
    points: "16 17 21 12 16 7"
  }), /*#__PURE__*/React.createElement("line", {
    x1: "21",
    y1: "12",
    x2: "9",
    y2: "12"
  })),
  User: (s = 18) => /*#__PURE__*/React.createElement("svg", {
    width: s,
    height: s,
    viewBox: "0 0 24 24",
    fill: "none",
    stroke: "currentColor",
    strokeWidth: "1.5",
    strokeLinecap: "round",
    strokeLinejoin: "round"
  }, /*#__PURE__*/React.createElement("path", {
    d: "M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2"
  }), /*#__PURE__*/React.createElement("circle", {
    cx: "12",
    cy: "7",
    r: "4"
  })),
  Google: () => /*#__PURE__*/React.createElement("svg", {
    width: "17",
    height: "17",
    viewBox: "0 0 48 48"
  }, /*#__PURE__*/React.createElement("path", {
    fill: "#EA4335",
    d: "M24 9.5c3.54 0 6.71 1.22 9.21 3.6l6.85-6.85C35.9 2.38 30.47 0 24 0 14.62 0 6.51 5.38 2.56 13.22l7.98 6.19C12.43 13.72 17.74 9.5 24 9.5z"
  }), /*#__PURE__*/React.createElement("path", {
    fill: "#4285F4",
    d: "M46.98 24.55c0-1.57-.15-3.09-.38-4.55H24v9.02h12.94c-.58 2.96-2.26 5.48-4.78 7.18l7.73 6c4.51-4.18 7.09-10.36 7.09-17.65z"
  }), /*#__PURE__*/React.createElement("path", {
    fill: "#FBBC05",
    d: "M10.53 28.59c-.48-1.45-.76-2.99-.76-4.59s.27-3.14.76-4.59l-7.98-6.19C.92 16.46 0 20.12 0 24c0 3.88.92 7.54 2.56 10.78l7.97-6.19z"
  }), /*#__PURE__*/React.createElement("path", {
    fill: "#34A853",
    d: "M24 48c6.48 0 11.93-2.13 15.89-5.81l-7.73-6c-2.15 1.45-4.92 2.3-8.16 2.3-6.26 0-11.57-4.22-13.47-9.91l-7.98 6.19C6.51 42.62 14.62 48 24 48z"
  }), /*#__PURE__*/React.createElement("path", {
    fill: "none",
    d: "M0 0h48v48H0z"
  }))
};

/* -- Transactions List ------------------------------------- */
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
const TransactionsList = ({
  user
}) => {
  const [txs, setTxs] = useState([]);
  const [loadingTx, setLoadingTx] = useState(true);
  const [open, setOpen] = useState(false);
  useEffect(() => {
    const currentUid = user && user.uid || auth && auth.currentUser && auth.currentUser.uid || null;
    if (!currentUid) {
      setLoadingTx(false);
      return;
    }
    const q = db.collection('users').doc(currentUid).collection('transactions').limit(50);
    const unsub = q.onSnapshot(snap => {
      const docs = snap.docs.map(d => ({
        id: d.id,
        ...d.data()
      }));
      docs.sort((a, b) => {
        const ta = a.timestamp && a.timestamp.toMillis ? a.timestamp.toMillis() : 0;
        const tb = b.timestamp && b.timestamp.toMillis ? b.timestamp.toMillis() : 0;
        return tb - ta;
      });
      setTxs(docs);
      setLoadingTx(false);
    }, err => {
      console.error('Tx listen failed', err);
      setLoadingTx(false);
    });
    return () => unsub();
  }, [user && user.uid]);
  const typeColor = t => {
    if (t.type === 'refund' || t.amount > 0) return '#5de88a';
    return '#ff8585';
  };
  const typeBadgeStyle = t => {
    const isCredit = t.amount > 0;
    return {
      display: 'inline-block',
      padding: '1px 7px',
      borderRadius: 20,
      fontSize: 11,
      fontWeight: 700,
      letterSpacing: '0.05em',
      textTransform: 'uppercase',
      background: 'rgba(0,0,0,0.2)',
      border: `1px solid ${isCredit ? 'rgba(93,232,138,0.5)' : 'rgba(255,133,133,0.5)'}`,
      color: isCredit ? '#5de88a' : '#ff8585'
    };
  };
  return /*#__PURE__*/React.createElement("div", {
    style: {
      marginTop: 24
    }
  }, /*#__PURE__*/React.createElement("button", {
    onClick: () => setOpen(o => !o),
    style: {
      width: '100%',
      display: 'flex',
      alignItems: 'center',
      justifyContent: 'space-between',
      padding: '12px 16px',
      background: 'rgba(30,30,30,0.85)',
      border: '1px solid rgba(90,90,90,0.35)',
      borderRadius: open ? '8px 8px 0 0' : 8,
      cursor: 'pointer',
      transition: 'all 0.2s'
    }
  }, /*#__PURE__*/React.createElement("div", {
    style: {
      display: 'flex',
      alignItems: 'center',
      gap: 10
    }
  }, /*#__PURE__*/React.createElement("svg", {
    width: "15",
    height: "15",
    viewBox: "0 0 24 24",
    fill: "none",
    stroke: "#888888",
    strokeWidth: "2"
  }, /*#__PURE__*/React.createElement("rect", {
    x: "3",
    y: "11",
    width: "18",
    height: "11",
    rx: "2"
  }), /*#__PURE__*/React.createElement("line", {
    x1: "2",
    x2: "22",
    y1: "10",
    y2: "10"
  })), /*#__PURE__*/React.createElement("span", {
    style: {
      color: '#eeeeee',
      fontWeight: 600,
      fontSize: 14
    }
  }, "Transaction History"), !loadingTx && txs.length > 0 && /*#__PURE__*/React.createElement("span", {
    style: {
      background: 'rgba(74,144,217,0.10)',
      border: '1px solid rgba(74,144,217,0.16)',
      color: '#9ec8e8',
      borderRadius: 20,
      padding: '1px 8px',
      fontSize: 11,
      fontWeight: 700
    }
  }, txs.length)), /*#__PURE__*/React.createElement("svg", {
    width: "14",
    height: "14",
    viewBox: "0 0 24 24",
    fill: "none",
    stroke: "#888888",
    strokeWidth: "2.5",
    style: {
      transform: open ? 'rotate(180deg)' : 'none',
      transition: 'transform 0.2s'
    }
  }, /*#__PURE__*/React.createElement("polyline", {
    points: "6 9 12 15 18 9"
  }))), open && /*#__PURE__*/React.createElement("div", {
    style: {
      border: '1px solid rgba(90,90,90,0.35)',
      borderTop: 'none',
      borderRadius: '0 0 8px 8px',
      overflow: 'hidden'
    }
  }, loadingTx && /*#__PURE__*/React.createElement("div", {
    style: {
      padding: 16,
      color: '#888888',
      fontSize: 13
    }
  }, "Loading..."), !loadingTx && txs.length === 0 && /*#__PURE__*/React.createElement("div", {
    style: {
      padding: 16,
      color: '#888888',
      fontSize: 13
    }
  }, "No transactions yet."), txs.map((t, i) => /*#__PURE__*/React.createElement("div", {
    key: t.id,
    style: {
      display: 'flex',
      alignItems: 'center',
      justifyContent: 'space-between',
      padding: '10px 16px',
      background: i % 2 === 0 ? 'rgba(30,30,30,0.75)' : 'rgba(30,30,30,0.50)',
      borderTop: i > 0 ? '1px solid rgba(90,90,90,0.20)' : 'none'
    }
  }, /*#__PURE__*/React.createElement("div", {
    style: {
      flex: 1,
      minWidth: 0,
      marginRight: 16
    }
  }, /*#__PURE__*/React.createElement("div", {
    style: {
      color: '#eeeeee',
      fontSize: 13,
      fontWeight: 600,
      marginBottom: 3,
      whiteSpace: 'nowrap',
      overflow: 'hidden',
      textOverflow: 'ellipsis'
    }
  }, friendlyTxLabel(t)), /*#__PURE__*/React.createElement("div", {
    style: {
      display: 'flex',
      alignItems: 'center',
      gap: 8
    }
  }, /*#__PURE__*/React.createElement("span", {
    style: typeBadgeStyle(t)
  }, t.amount > 0 ? 'credit' : 'debit'), /*#__PURE__*/React.createElement("span", {
    style: {
      color: '#666666',
      fontSize: 12
    }
  }, t.timestamp && t.timestamp.toDate ? t.timestamp.toDate().toLocaleString() : '-'))), /*#__PURE__*/React.createElement("div", {
    style: {
      color: typeColor(t),
      fontFamily: 'monospace',
      fontWeight: 700,
      fontSize: 14,
      whiteSpace: 'nowrap'
    }
  }, t.amount > 0 ? '+' : '', t.amount)))));
};

/* -- Auth Modal ------------------------------------------- */
const AuthModal = ({
  reason,
  onClose,
  onSignIn
}) => /*#__PURE__*/React.createElement("div", {
  className: "modal-overlay",
  onClick: onClose
}, /*#__PURE__*/React.createElement("div", {
  className: "modal-card",
  onClick: e => e.stopPropagation()
}, /*#__PURE__*/React.createElement("div", {
  className: "flex items-start justify-between mb-6"
}, /*#__PURE__*/React.createElement("div", null, /*#__PURE__*/React.createElement("div", {
  className: "flex items-center gap-2 mb-1"
}, /*#__PURE__*/React.createElement("img", {
  src: "logo.png",
  alt: "TurboFlow",
  style: {
    width: 20,
    height: 20,
    objectFit: 'cover',
    borderRadius: 6
  },
  onError: e => {
    e.target.style.display = 'none';
  }
}), /*#__PURE__*/React.createElement("span", {
  className: "text-white font-bold text-lg"
}, "Sign in to TurboFlow")), /*#__PURE__*/React.createElement("p", {
  className: "text-slate-400 text-sm mt-1 leading-relaxed"
}, reason || 'Create a free account to access simulations and purchase credits.')), /*#__PURE__*/React.createElement("button", {
  onClick: onClose,
  className: "text-slate-500 hover:text-slate-300 transition-colors ml-4 flex-shrink-0"
}, Ic.X())), /*#__PURE__*/React.createElement("div", {
  className: "border-t border-slate-800 pt-6 space-y-4"
}, /*#__PURE__*/React.createElement("button", {
  onClick: () => {
    onSignIn();
    onClose();
  },
  className: "btn-google w-full py-3 px-4 text-base font-semibold rounded-lg"
}, Ic.Google(), " Continue with Google"), /*#__PURE__*/React.createElement("p", {
  className: "text-center text-[15px] text-slate-500 leading-relaxed"
}, "By signing in you agree to our Terms of Service and Privacy Policy."))));

/* -- Root ------------------------------------------------- */
const App = () => {
  const [view, setView] = useState('home');
  const [credits, setCredits] = useState(50);
  const [passUntil, setPassUntil] = useState(0);
  const [passStartedAt, setPassStartedAt] = useState(0);
  const [job, setJob] = useState(null);
  const [isSignedIn, setIsSignedIn] = useState(false);
  const [user, setUser] = useState(null);
  const [showAuth, setShowAuth] = useState(false);
  const [authReason, setAuthReason] = useState('');
  const openAuth = reason => {
    setAuthReason(reason || '');
    setShowAuth(true);
  };
  const requireAuth = (reason, cb) => {
    if (isSignedIn) {
      cb && cb();
      return true;
    }
    openAuth(reason);
    return false;
  };

  // Firebase Auth integration: listen for auth state changes
  useEffect(() => {
    let unsubUserDoc = null;
    const unsubscribe = auth.onAuthStateChanged(async u => {
      // clean up previous user doc listener on auth change
      if (unsubUserDoc) {
        unsubUserDoc();
        unsubUserDoc = null;
      }
      if (u) {
        const initials = (u.displayName || '').split(' ').map(n => n[0]).slice(0, 2).join('').toUpperCase() || (u.email ? u.email[0].toUpperCase() : 'U');
        setIsSignedIn(true);
        try {
          const userRef = db.collection('users').doc(u.uid);
          const doc = await userRef.get();
          let teamName = null;
          if (!doc.exists) {
            await userRef.set({
              name: u.displayName || null,
              email: u.email || null,
              teamName: null,
              credits: 50,
              sponsored: false,
              usdPerCredit: 0.05,
              unlimitedUsd: 100,
              createdAt: firebase.firestore.FieldValue.serverTimestamp(),
              lastSeen: firebase.firestore.FieldValue.serverTimestamp()
            });
            teamName = null;
            setCredits(50);
          } else {
            const data = doc.data() || {};
            teamName = data.teamName || null;
            if (data.credits !== undefined) setCredits(data.credits);
            userRef.set({
              lastSeen: firebase.firestore.FieldValue.serverTimestamp()
            }, {
              merge: true
            }).catch(() => {});
          }
          setUser({
            name: u.displayName || u.email,
            email: u.email,
            initials,
            photoURL: u.photoURL,
            uid: u.uid,
            teamName,
            sponsored: !!(doc.exists && (doc.data() || {}).sponsored)
          });

          // Live listener: credits update instantly when Cloud Function deducts them
          unsubUserDoc = userRef.onSnapshot(snap => {
            if (snap.exists) {
              const d = snap.data() || {};
              if (d.credits !== undefined) setCredits(d.credits);
              var _toMs = function (t) { return t && typeof t.toMillis === 'function' ? t.toMillis() : (t && t.seconds ? t.seconds * 1000 : 0); };
              setPassUntil(_toMs(d.unlimitedUntil));
              setPassStartedAt(_toMs(d.unlimitedStartedAt));
              if (d.teamName !== undefined) setUser(prev => prev ? {
                ...prev,
                teamName: d.teamName
              } : prev);
              if (d.sponsored !== undefined) setUser(prev => prev ? {
                ...prev,
                sponsored: !!d.sponsored
              } : prev);
            }
          });
        } catch (e) {
          console.warn('Failed to read/persist user profile:', e);
          setUser({
            name: u.displayName || u.email,
            email: u.email,
            initials,
            photoURL: u.photoURL,
            uid: u.uid
          });
        }
      } else {
        setIsSignedIn(false);
        setUser(null);
        setCredits(0);
        setPassUntil(0);
        setPassStartedAt(0);
      }
    });
    return () => {
      unsubscribe();
      if (unsubUserDoc) unsubUserDoc();
    };
  }, []);
  const signIn = async () => {
    const provider = new firebase.auth.GoogleAuthProvider();
    try {
      await auth.signInWithPopup(provider);
    } catch (err) {
      console.error('Sign-in error', err);
      alert('Sign-in failed: ' + (err && err.message ? err.message : err));
    }
  };
  const signOut = async () => {
    try {
      await auth.signOut();
    } catch (err) {
      console.warn('Sign-out failed', err);
    }
  };
  const handleSaveTeamName = async name => {
    if (!user || !user.uid) {
      alert('Not signed in');
      return;
    }
    try {
      const userRef = db.collection('users').doc(user.uid);
      await userRef.update({
        teamName: name
      });
      setUser(prev => ({
        ...prev,
        teamName: name
      }));
    } catch (err) {
      console.error('Error saving team name:', err);
      alert('Could not save team name. Please try again.');
    }
  };
  const handleSaveProfile = async profile => {
    if (!user || !user.uid) {
      return {
        ok: false,
        message: 'Not signed in'
      };
    }
    try {
      const userRef = db.collection('users').doc(user.uid);
      await userRef.update({
        teamName: profile.teamName || null,
        region: profile.region || null,
        contactEmail: profile.contactEmail || user && user.email || null
      });
      setUser(prev => ({
        ...prev,
        teamName: profile.teamName || prev.teamName,
        region: profile.region || prev.region,
        contactEmail: profile.contactEmail || prev.contactEmail
      }));
      return {
        ok: true,
        message: 'Profile saved'
      };
    } catch (err) {
      console.error('Error saving profile:', err);
      return {
        ok: false,
        message: 'Could not save profile. Please try again.'
      };
    }
  };
  const [sidebarOpen, setSidebarOpen] = useState(true);
  const passActive = passUntil > Date.now();
  const passDaysLeft = passActive ? Math.ceil((passUntil - Date.now()) / 86400000) : 0;
  const passTotalDays = passActive ? Math.max(passDaysLeft, passStartedAt > 0 ? Math.round((passUntil - passStartedAt) / 86400000) : passDaysLeft) : 0;
  const passPct = (passActive && passTotalDays > 0) ? Math.max(0, Math.min(100, Math.round(passDaysLeft / passTotalDays * 100))) : 0;
  return /*#__PURE__*/React.createElement("div", {
    style: {
      display: 'flex',
      height: '100vh',
      overflow: 'hidden'
    },
    className: "main-grid"
  }, showAuth && /*#__PURE__*/React.createElement(AuthModal, {
    reason: authReason,
    onClose: () => setShowAuth(false),
    onSignIn: signIn
  }), user && !user.teamName && /*#__PURE__*/React.createElement("div", {
    className: "fixed inset-0 z-[100] flex items-center justify-center bg-slate-950/80 backdrop-blur-md"
  }, /*#__PURE__*/React.createElement("div", {
    className: "card-elegant p-8 w-full max-w-md border border-slate-800 shadow-2xl"
  }, /*#__PURE__*/React.createElement("div", {
    className: "flex items-center gap-3 mb-6"
  }, /*#__PURE__*/React.createElement("img", {
    src: "logo.png",
    alt: "TurboFlow",
    style: {
      width: 40,
      height: 40,
      objectFit: 'cover',
      borderRadius: 8
    },
    onError: e => {
      e.target.style.display = 'none';
    }
  }), /*#__PURE__*/React.createElement("h2", {
    className: "text-2xl font-bold text-white"
  }, "Setup Your Team")), /*#__PURE__*/React.createElement("p", {
    className: "text-base text-slate-400 mb-6"
  }, "Welcome to TurboFlow! Please enter your official team name to start managing simulations."), /*#__PURE__*/React.createElement("div", {
    className: "space-y-4"
  }, /*#__PURE__*/React.createElement("div", null, /*#__PURE__*/React.createElement("label", {
    className: "text-[14px] font-bold text-slate-500 uppercase tracking-widest block mb-2"
  }, "Team Name"), /*#__PURE__*/React.createElement("input", {
    id: "teamNameInput",
    type: "text",
    placeholder: "e.g. Red Rocket Racing",
    className: "input-field w-full px-4 py-3 rounded-lg text-white focus:outline-none"
  })), /*#__PURE__*/React.createElement("button", {
    onClick: () => {
      const val = document.getElementById('teamNameInput').value;
      if (val) handleSaveTeamName(val);
    },
    className: "btn-primary w-full py-3 font-bold"
  }, "Complete Setup")))), /*#__PURE__*/React.createElement("aside", {
    style: {
      width: sidebarOpen ? 256 : 56,
      flexShrink: 0,
      display: 'flex',
      flexDirection: 'column',
      zIndex: 50,
      transition: 'width 0.25s cubic-bezier(0.4,0,0.2,1)',
      overflow: 'hidden'
    },
    className: "bg-slate-950 border-r border-slate-850"
  }, /*#__PURE__*/React.createElement("div", {
    style: {
      padding: sidebarOpen ? '16px 16px 16px' : '16px 0',
      display: 'flex',
      flexDirection: 'column',
      alignItems: sidebarOpen ? 'flex-start' : 'center'
    }
  }, /*#__PURE__*/React.createElement("div", {
    style: {
      display: 'flex',
      alignItems: 'center',
      gap: 10,
      width: '100%',
      marginBottom: 16
    }
  }, /*#__PURE__*/React.createElement("button", {
    onClick: () => setSidebarOpen(o => !o),
    title: sidebarOpen ? 'Collapse sidebar' : 'Expand sidebar',
    style: {
      background: 'rgba(74,144,217,0.06)',
      border: '1px solid rgba(74,144,217,0.12)',
      cursor: 'pointer',
      padding: '8px',
      flexShrink: 0,
      color: '#aaaaaa',
      display: 'flex',
      flexDirection: 'column',
      gap: 5,
      alignItems: 'center',
      justifyContent: 'center',
      borderRadius: 8,
      transition: 'all 0.2s',
      width: 36,
      height: 36
    },
    onMouseEnter: e => {
      e.currentTarget.style.background = 'rgba(74,144,226,0.18)';
      e.currentTarget.style.color = '#eeeeee';
      e.currentTarget.style.borderColor = 'rgba(74,144,226,0.5)';
    },
    onMouseLeave: e => {
      e.currentTarget.style.background = 'rgba(74,144,217,0.06)';
      e.currentTarget.style.color = '#aaaaaa';
      e.currentTarget.style.borderColor = 'rgba(74,144,217,0.12)';
    }
  }, /*#__PURE__*/React.createElement("span", {
    style: {
      display: 'block',
      width: 16,
      height: 2,
      background: 'currentColor',
      borderRadius: 2
    }
  }), /*#__PURE__*/React.createElement("span", {
    style: {
      display: 'block',
      width: 16,
      height: 2,
      background: 'currentColor',
      borderRadius: 2
    }
  }), /*#__PURE__*/React.createElement("span", {
    style: {
      display: 'block',
      width: 16,
      height: 2,
      background: 'currentColor',
      borderRadius: 2
    }
  })), sidebarOpen && (!isSignedIn ? /*#__PURE__*/React.createElement("button", {
    onClick: () => openAuth('Sign in to manage simulations, track credits, and purchase plans.'),
    className: "btn-google flex-1 px-3 text-sm rounded-lg",
    style: {
      minWidth: 0,
      height: 36,
      whiteSpace: 'nowrap'
    }
  }, Ic.Google(), " Sign in with Google") : /*#__PURE__*/React.createElement("div", {
    className: "flex items-center gap-2",
    style: {
      flex: 1,
      minWidth: 0
    }
  }, user && user.photoURL ? /*#__PURE__*/React.createElement("img", {
    src: user.photoURL,
    referrerPolicy: "no-referrer",
    style: {
      width: 32,
      height: 32,
      borderRadius: '50%',
      flexShrink: 0,
      objectFit: 'cover',
      border: '1px solid rgba(74,144,226,0.4)'
    },
    onError: e => {
      e.target.style.display = 'none';
      e.target.nextSibling.style.display = 'flex';
    }
  }) : null, /*#__PURE__*/React.createElement("div", {
    style: {
      width: 32,
      height: 32,
      borderRadius: '50%',
      background: '#4a90d9',
      display: user && user.photoURL ? 'none' : 'flex',
      alignItems: 'center',
      justifyContent: 'center',
      color: '#fff',
      fontSize: 14,
      fontWeight: 700,
      flexShrink: 0
    }
  }, user && user.initials || 'U'), /*#__PURE__*/React.createElement("div", {
    style: {
      flex: 1,
      minWidth: 0
    }
  }, /*#__PURE__*/React.createElement("div", {
    className: "text-sm font-semibold text-slate-200",
    style: {
      whiteSpace: 'nowrap',
      overflow: 'hidden',
      textOverflow: 'ellipsis'
    }
  }, user && (user.teamName || user.name) || ''), /*#__PURE__*/React.createElement("div", {
    className: "text-[13px] text-slate-500",
    style: {
      whiteSpace: 'nowrap',
      overflow: 'hidden',
      textOverflow: 'ellipsis'
    }
  }, user && user.email || '')), /*#__PURE__*/React.createElement("button", {
    onClick: signOut,
    className: "text-slate-500 hover:text-slate-300 transition-colors",
    title: "Sign out"
  }, Ic.SignOut()))), !sidebarOpen && isSignedIn && /*#__PURE__*/React.createElement("div", {
    style: {
      width: 32,
      height: 32,
      borderRadius: '50%',
      background: '#4a90d9',
      display: 'flex',
      alignItems: 'center',
      justifyContent: 'center',
      color: '#fff',
      fontSize: 13,
      fontWeight: 700
    }
  }, user && user.initials || 'U'))), /*#__PURE__*/React.createElement("nav", {
    style: {
      flex: 1,
      overflowY: 'auto'
    },
    className: "space-y-px pb-2"
  }, [{
    id: 'home',
    label: 'Dashboard',
    icon: Ic.Dashboard
  }, {
    id: 'simulations',
    label: 'My Simulations',
    icon: () => /*#__PURE__*/React.createElement("svg", {
      width: "18",
      height: "18",
      viewBox: "0 0 24 24",
      fill: "none",
      stroke: "currentColor",
      strokeWidth: "1.5"
    }, /*#__PURE__*/React.createElement("polyline", {
      points: "22 12 18 12 15 21 9 3 6 12 2 12"
    }))
  }, {
    id: 'lapcalc',
    label: 'Race Time Calculator',
    icon: () => /*#__PURE__*/React.createElement("svg", {
      width: "18",
      height: "18",
      viewBox: "0 0 24 24",
      fill: "none",
      stroke: "currentColor",
      strokeWidth: "1.5"
    }, /*#__PURE__*/React.createElement("circle", {
      cx: "12",
      cy: "12",
      r: "10"
    }), /*#__PURE__*/React.createElement("polyline", {
      points: "12 6 12 12 16 14"
    }))
  }, {
    id: 'billing',
    label: 'Billing',
    icon: Ic.Billing
  }, {
    id: 'docs',
    label: 'Setup Guide',
    icon: Ic.Docs
  }].map(({
    id,
    label,
    icon
  }) => /*#__PURE__*/React.createElement("button", {
    key: id,
    onClick: () => setView(id),
    title: !sidebarOpen ? label : '',
    className: `sidebar-link w-full flex items-center gap-3 py-3 text-base transition-all ${view === id ? 'sidebar-link-active' : 'text-slate-400 hover:text-slate-200'}`,
    style: {
      padding: sidebarOpen ? '12px 24px' : '12px 0',
      justifyContent: sidebarOpen ? 'flex-start' : 'center'
    }
  }, icon(), " ", sidebarOpen && label)), sidebarOpen && /*#__PURE__*/React.createElement(React.Fragment, null, /*#__PURE__*/React.createElement("div", {
    style: {
      margin: '10px 20px 0',
      borderTop: '1px solid #2e2e2e'
    }
  }), /*#__PURE__*/React.createElement("div", {
    style: {
      padding: '8px 24px 2px',
      fontSize: 12,
      fontWeight: 700,
      letterSpacing: '0.1em',
      textTransform: 'uppercase',
      color: '#666666'
    }
  }, "Programs")), !sidebarOpen && /*#__PURE__*/React.createElement("div", {
    style: {
      margin: '10px 8px',
      borderTop: '1px solid #2e2e2e'
    }
  }), [{
    id: 'sponsorship',
    label: 'Sponsorship',
    icon: Ic.Trophy
  }, {
    id: 'mentorship',
    label: 'Mentorship',
    icon: Ic.Trophy
  }, {
    id: 'modelling',
    label: 'Modelling Services',
    icon: Ic.Wrench
  }].map(({
    id,
    label,
    icon
  }) => /*#__PURE__*/React.createElement("button", {
    key: id,
    onClick: () => setView(id),
    title: !sidebarOpen ? label : '',
    className: `sidebar-link w-full flex items-center gap-3 py-3 text-base transition-all ${view === id ? 'sidebar-link-active' : 'text-slate-400 hover:text-slate-200'}`,
    style: {
      padding: sidebarOpen ? '12px 24px' : '12px 0',
      justifyContent: sidebarOpen ? 'flex-start' : 'center'
    }
  }, icon(), " ", sidebarOpen && label)), sidebarOpen && /*#__PURE__*/React.createElement(React.Fragment, null, /*#__PURE__*/React.createElement("div", {
    style: {
      margin: '10px 20px 0',
      borderTop: '1px solid #2e2e2e'
    }
  }), /*#__PURE__*/React.createElement("div", {
    style: {
      padding: '8px 24px 2px',
      fontSize: 12,
      fontWeight: 700,
      letterSpacing: '0.1em',
      textTransform: 'uppercase',
      color: '#666666'
    }
  }, "Legal")), !sidebarOpen && /*#__PURE__*/React.createElement("div", {
    style: {
      margin: '10px 8px',
      borderTop: '1px solid #2e2e2e'
    }
  }), [{
    id: 'terms',
    label: 'Terms of Service',
    icon: Ic.Docs
  }, {
    id: 'refund',
    label: 'Refund Policy',
    icon: Ic.Billing
  }, {
    id: 'spolicy',
    label: 'Sponsorship Policy',
    icon: Ic.Trophy
  }].map(({
    id,
    label,
    icon
  }) => /*#__PURE__*/React.createElement("button", {
    key: id,
    onClick: () => setView(id),
    title: !sidebarOpen ? label : '',
    className: `sidebar-link w-full flex items-center gap-3 py-3 text-base transition-all ${view === id ? 'sidebar-link-active' : 'text-slate-400 hover:text-slate-200'}`,
    style: {
      padding: sidebarOpen ? '12px 24px' : '12px 0',
      justifyContent: sidebarOpen ? 'flex-start' : 'center'
    }
  }, icon(), " ", sidebarOpen && label))), sidebarOpen && /*#__PURE__*/React.createElement("div", {
    className: "p-5 border-t border-slate-850"
  }, /*#__PURE__*/React.createElement("div", {
    style: {
      padding: 16
    }
  }, /*#__PURE__*/React.createElement("div", {
    className: "text-[13px] font-bold text-slate-500 uppercase tracking-widest mb-4"
  }, "Credit Balance"), isSignedIn ? /*#__PURE__*/React.createElement(React.Fragment, null, /*#__PURE__*/React.createElement("div", {
    className: "flex items-baseline gap-1.5 mb-3"
  }, /*#__PURE__*/React.createElement("span", {
    className: "text-4xl font-mono font-bold text-white"
  }, credits.toLocaleString()), /*#__PURE__*/React.createElement("span", {
    className: "text-sm text-slate-400"
  }, "Credits")), /*#__PURE__*/React.createElement("div", {
    className: "w-full bg-slate-800 rounded-full overflow-hidden mb-4",
    style: {
      height: 5
    }
  }, /*#__PURE__*/React.createElement("div", {
    className: "h-full bg-gradient-to-r from-blue-500 to-cyan-400 transition-all",
    style: {
      width: `${Math.min(credits / 2000 * 100, 100)}%`
    }
  })), passActive && /*#__PURE__*/React.createElement("div", {
    style: { marginBottom: 14 }
  }, /*#__PURE__*/React.createElement("div", {
    className: "flex items-center justify-between mb-1.5"
  }, /*#__PURE__*/React.createElement("span", {
    className: "text-[13px] font-bold",
    style: { color: '#ffc830' }
  }, "Unlimited pass"), /*#__PURE__*/React.createElement("span", {
    className: "text-[13px] font-mono font-bold",
    style: { color: '#ffc830' }
  }, passDaysLeft + (passDaysLeft === 1 ? ' day left' : ' days left'))), /*#__PURE__*/React.createElement("div", {
    className: "w-full rounded-full overflow-hidden",
    style: { height: 5, background: 'rgba(255,255,255,0.08)' }
  }, /*#__PURE__*/React.createElement("div", {
    style: { height: '100%', width: passPct + '%', background: 'linear-gradient(90deg,#ffc830,#4a90d9)', transition: 'width 0.4s ease' }
  })), /*#__PURE__*/React.createElement("div", {
    className: "text-[11px] text-slate-500 font-mono mt-1"
  }, passDaysLeft + " of " + passTotalDays + " days")), /*#__PURE__*/React.createElement("button", {
    onClick: () => setView('billing'),
    className: "text-[14px] text-blue-400 hover:text-cyan-400 transition-colors font-semibold"
  }, "+ Add Credits")) : /*#__PURE__*/React.createElement("div", {
    className: "text-sm text-slate-500 flex items-center gap-1.5"
  }, Ic.Lock(), " Sign in to view balance")))), /*#__PURE__*/React.createElement("main", {
    style: {
      flex: 1,
      overflowY: view === 'lapcalc' ? 'hidden' : 'auto',
      position: 'relative',
      display: 'flex',
      flexDirection: 'column',
      scrollSnapType: 'y mandatory',
      scrollBehavior: 'smooth'
    }
  }, view === 'home' && /*#__PURE__*/React.createElement(HomeView, {
    setView: setView,
    isSignedIn: isSignedIn,
    onRequireAuth: requireAuth
  }), view === 'dash' && /*#__PURE__*/React.createElement(ActiveJobView, {
    setView: setView,
    setJob: setJob
  }), view === 'docs' && /*#__PURE__*/React.createElement(DocsView, null), view === 'billing' && /*#__PURE__*/React.createElement(BillingView, {
    user: user,
    credits: credits,
    isSignedIn: isSignedIn,
    onRequireAuth: requireAuth
  }), view === 'sponsorship' && /*#__PURE__*/React.createElement(SponsorshipView, null), view === 'terms' && /*#__PURE__*/React.createElement(TermsView, null), view === 'refund' && /*#__PURE__*/React.createElement(RefundPolicyView, null), view === 'spolicy' && /*#__PURE__*/React.createElement(SponsorshipPolicyView, null), view === 'mentorship' && /*#__PURE__*/React.createElement(MentorshipView, {
    isSignedIn: isSignedIn,
    onRequireAuth: requireAuth
  }), view === 'modelling' && /*#__PURE__*/React.createElement(ModellingView, null), view === 'simulations' && /*#__PURE__*/React.createElement(SimulationsView, {
    user: user,
    isSignedIn: isSignedIn,
    credits: credits,
    setCredits: setCredits
  }), view === 'lapcalc' && /*#__PURE__*/React.createElement("div", {
    style: {
      flex: 1,
      display: 'flex',
      minHeight: 0,
      height: '100%'
    }
  }, /*#__PURE__*/React.createElement(LapCalcView, {
    user: user,
    isSignedIn: isSignedIn,
    credits: credits,
    setCredits: setCredits,
    onRequireAuth: requireAuth
  }))));
};
6;

/* -- Predicted Race Time (inline sim for job cards) ------ */
const CO2_DATA = (() => {
  const rows = [[0.0, 0.21940338514177476, 0.056], [0.001, 0.22552445320818681, 0.05571784323637084], [0.002, 0.23181390578593614, 0.055463198619515285], [0.003, 0.23827623918999208, 0.055235585090335944], [0.004, 0.24491606204529304, 0.05502920920089539], [0.005, 0.25173809764321414, 0.0548398445119925], [0.006, 0.25874718632033583, 0.05466429693004972], [0.007, 0.26594828785782415, 0.05450008968991573], [0.008, 0.2733464838995745, 0.054345275528366745], [0.009, 0.2809469803870961, 0.05419829196694335], [0.01, 0.2887551100089336, 0.05405787154933513], [0.011, 0.29677633466223097, 0.0539229809671647], [0.012, 0.305016247923839, 0.05379276705295849], [0.013, 0.3134805775281531, 0.05366652276378268], [0.014, 0.3221751878486415, 0.05354366118259521], [0.015, 0.33110608237978784, 0.05342368852286462], [0.016, 0.3402794062159124, 0.053306198038856285], [0.017, 0.3497014485230843, 0.05319084900483847], [0.018, 0.3593786450000445, 0.0530773603977038], [0.019, 0.3693175803237736, 0.05296550128349948], [0.02, 0.3795249905750289, 0.052855082902646545], [0.025, 0.434835826538815, 0.052320362155600354], [0.03, 0.49796009945678044, 0.051809931238731004], [0.04, 0.6518628472580031, 0.05086978133355427], [0.05, 0.8507832226983159, 0.05007308417851674], [0.06, 1.1060801477107696, 0.049451332760446616], [0.07, 1.4307089350730928, 0.049012014252874256], [0.08, 1.6233866818699893, 0.04883953403175927], [0.09, 1.8339898437174985, 0.04869334982069128], [0.1, 2.061087252695714, 0.04856268310131226], [0.12, 2.5634947419684217, 0.04833536716127018], [0.14, 3.1263231249283903, 0.04814436265621578], [0.16, 3.7511954234213523, 0.04798053294024742], [0.18, 4.438732620984867, 0.04783551926613225], [0.2, 5.188275481023265, 0.04770163573218649], [0.3, 9.72427413688266, 0.04717534024483567], [0.4, 15.095063671753664, 0.04681990014289985], [0.5, 21.310624459226927, 0.04656725413447889], [0.6, 28.342834337426264, 0.046389629990073456], [0.7, 36.159355133427204, 0.04626518017684636], [0.8, 44.72761651267434, 0.04617817011671015], [0.9, 54.01485933437567, 0.046121199753803954], [1.0, 63.98820958833695, 0.046089820817527816], [1.1, 74.63397059655354, 0.046073406640434895], [1.2, 85.79671174597088, 0.04607127975440474], [1.3, 97.44064498053646, 0.04607936734847028], [1.43, 113.21836038452783, 0.04802096]];
  return {
    t: rows.map(r => r[0]),
    F: rows.map(r => r[1]),
    m: rows.map(r => r[2])
  };
})();
const runLapSim = (carW, dragN, mu, iMOI) => {
  const {
    t,
    F,
    m
  } = CO2_DATA;
  const N = t.length,
    r_w = 0.014125,
    N_w = 4;
  const I = iMOI / 1e9;
  const mc = m.map(ms => 0.021 + ms - 0.048 + carW / 1000);
  const max = N * 10 + 5000;
  const v = new Float64Array(max),
    x = new Float64Array(max),
    tm = new Float64Array(max);
  const dt0 = (t[N - 1] - t[0]) / (N - 1);
  tm[0] = t[0];
  for (let i = 1; i < max; i++) {
    const dt = i <= N - 1 ? t[i] - t[i - 1] : dt0;
    const Ft = i <= N - 1 ? F[i - 1] : 0,
      mc_ = i <= N - 1 ? mc[i - 1] : mc[N - 1];
    const op = i > 1 ? v[i - 2] / r_w : v[i - 1] / r_w,
      on = v[i - 1] / r_w;
    const Fw = I * (on - op) / dt / r_w * N_w;
    const a = (Ft - dragN * (v[i - 1] / 20) ** 2 - mu * mc_ * 9.81 - Fw) / mc_;
    v[i] = Math.max(0, v[i - 1] + a * dt);
    x[i] = x[i - 1] + v[i - 1] * dt + 0.5 * a * dt * dt;
    tm[i] = tm[i - 1] + dt;
    if (x[i] >= 20) {
      return (tm[i - 1] + (20 - x[i - 1]) * (tm[i] - tm[i - 1]) / (x[i] - x[i - 1])) * 0.76;
    }
    if (v[i] <= 0 && i > N - 1) return null;
  }
  return null;
};

/* -- Simulations View ------------------------------------- */
const STATUS_META = {
  pending: {
    label: 'Pending',
    color: '#aaaaaa',
    bg: 'rgba(160,160,160,0.10)',
    dot: '#aaaaaa'
  },
  downloading: {
    label: 'Downloading Files',
    color: '#7ab3e0',
    bg: 'rgba(96,165,250,0.1)',
    dot: '#7ab3e0'
  },
  uploading_geometry: {
    label: 'Uploading Geometry',
    color: '#7ab3e0',
    bg: 'rgba(96,165,250,0.1)',
    dot: '#7ab3e0'
  },
  processing: {
    label: 'Processing',
    color: '#7ab3e0',
    bg: 'rgba(74,144,217,0.08)',
    dot: '#7ab3e0'
  },
  creating_simulation: {
    label: 'Creating Simulation',
    color: '#7ab3e0',
    bg: 'rgba(74,144,217,0.08)',
    dot: '#7ab3e0'
  },
  meshing: {
    label: 'Meshing',
    color: '#ff9e50',
    bg: 'rgba(255,158,80,0.12)',
    dot: '#ff9e50'
  },
  running: {
    label: 'Running',
    color: '#3dd490',
    bg: 'rgba(160,160,160,0.10)',
    dot: '#3dd490'
  },
  complete: {
    label: 'Complete',
    color: '#5de88a',
    bg: 'rgba(160,160,160,0.10)',
    dot: '#5de88a'
  },
  failed: {
    label: 'Failed',
    color: '#ff8585',
    bg: 'rgba(255,133,133,0.12)',
    dot: '#ff8585'
  },
  cancelled: {
    label: 'Cancelled',
    color: '#ff8585',
    bg: 'rgba(255,133,133,08)',
    dot: '#ff8585'
  },
  queued: {
    label: 'Queued',
    color: '#aaaaaa',
    bg: 'rgba(160,160,160,0.10)',
    dot: '#aaaaaa'
  },
  cancelling: {
    label: 'Cancelling...',
    color: '#ff9e50',
    bg: 'rgba(255,158,80,0.12)',
    dot: '#ff9e50'
  },
  cancelled: {
    label: 'Cancelled',
    color: '#888888',
    bg: 'rgba(100,116,139,0.1)',
    dot: '#888888'
  }
};
const StatusBadge = ({
  status
}) => {
  const m = STATUS_META[status] || STATUS_META.pending;
  const spinning = ['downloading', 'uploading_geometry', 'processing', 'creating_simulation', 'meshing', 'running'].includes(status);
  return /*#__PURE__*/React.createElement("span", {
    style: {
      display: 'inline-flex',
      alignItems: 'center',
      gap: 6,
      padding: '3px 10px',
      borderRadius: 20,
      background: m.bg,
      border: '1px solid ' + m.color,
      color: m.color,
      fontSize: 12,
      fontWeight: 700,
      letterSpacing: '0.04em'
    }
  }, spinning ? /*#__PURE__*/React.createElement("span", {
    style: {
      width: 7,
      height: 7,
      borderRadius: '50%',
      border: `2px solid ${m.dot}`,
      borderTopColor: 'transparent',
      display: 'inline-block',
      animation: 'spin 0.8s linear infinite'
    }
  }) : /*#__PURE__*/React.createElement("span", {
    style: {
      width: 7,
      height: 7,
      borderRadius: '50%',
      background: m.dot,
      display: 'inline-block'
    }
  }), m.label);
};

// Module-level cache ? survives navigation, only cleared on full page reload
const _raceTimeCache = {};
const SimulationsView = ({
  user,
  isSignedIn,
  credits,
  setCredits
}) => {
  const [jobs, setJobs] = useState([]);
  const [loading, setLoading] = useState(true);
  const [copied, setCopied] = useState(false);
  const [vizJobId, setVizJobId] = useState(null);
  const [token, setToken] = useState(null);
  const [refunding, setRefunding] = useState({});
  const [lapDefaults, setLapDefaults] = useState(null);
  // Stores fetched race times keyed by jobId ? persists across Firestore re-renders
  const [, forceUpdate] = React.useReducer(x => x + 1, 0);

  // Always read refresh token from the currently signed-in user
  useEffect(() => {
    const u = auth.currentUser;
    if (u) setToken(u.refreshToken || null);
    const unsub = auth.onAuthStateChanged(u => {
      setToken(u ? u.refreshToken || null : null);
    });
    return () => unsub();
  }, []);

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
    if (!window.confirm('Cancel this simulation and refund 100 credits?')) return;
    setRefunding(r => ({
      ...r,
      [job.id]: true
    }));
    try {
      const refundFn = firebase.functions().httpsCallable('refundJob');
      await refundFn({
        jobId: job.id
      });
      // credits will update via the live user doc listener in App
    } catch (e) {
      alert('Refund failed: ' + (e.message || e));
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
    className: "text-slate-400 text-base"
  }, "Sign in to view your simulations."));
  return /*#__PURE__*/React.createElement("div", {
    style: {
      padding: '48px 32px'
    }
  }, vizJobId && /*#__PURE__*/React.createElement("div", { style: { position: 'fixed', inset: 0, zIndex: 200, display: 'flex', alignItems: 'center', justifyContent: 'center', background: 'rgba(2,6,23,0.8)', backdropFilter: 'blur(6px)', padding: 16 }, onClick: () => setVizJobId(null) }, /*#__PURE__*/React.createElement("div", { onClick: e => e.stopPropagation(), style: { background: '#1e1e1e', border: '1px solid rgba(160,160,160,0.16)', borderRadius: 16, padding: 28, width: 420, maxWidth: '90vw', boxShadow: '0 30px 70px rgba(0,0,0,0.6)', textAlign: 'center' } }, /*#__PURE__*/React.createElement("h3", { className: "text-xl font-bold text-white", style: { marginBottom: 8 } }, "Request Visualisation Files"), /*#__PURE__*/React.createElement("p", { className: "text-sm text-slate-400", style: { marginBottom: 16 } }, "Copied your Job ID to the clipboard. Send it to us on Instagram and we'll send your visualisation files back."), /*#__PURE__*/React.createElement("div", { style: { display: 'flex', alignItems: 'center', gap: 8, background: 'rgba(0,0,0,0.3)', border: '1px solid rgba(90,90,90,0.3)', borderRadius: 8, padding: '10px 12px', marginBottom: 16 } }, /*#__PURE__*/React.createElement("code", { style: { flex: 1, fontSize: 12, color: '#7acfdd', wordBreak: 'break-all', textAlign: 'left' } }, vizJobId), /*#__PURE__*/React.createElement("button", { onClick: () => { try { navigator.clipboard.writeText(vizJobId); } catch (e) {} }, style: { padding: '6px 12px', fontSize: 12, fontWeight: 700, whiteSpace: 'nowrap', background: '#4a90d9', color: '#fff', border: 'none', borderRadius: 6, cursor: 'pointer' } }, "Copy")), /*#__PURE__*/React.createElement("a", { href: "https://www.instagram.com/turboflow.cfd", target: "_blank", rel: "noopener noreferrer", style: { display: 'block', background: 'linear-gradient(135deg, #833ab4, #fd1d1d, #fcb045)', color: '#fff', fontWeight: 700, fontSize: 14, padding: '12px', borderRadius: 10, textDecoration: 'none', marginBottom: 10 } }, "Open Instagram \u2014 @turboflow.cfd"), /*#__PURE__*/React.createElement("button", { onClick: () => setVizJobId(null), style: { background: 'none', border: 'none', color: '#94a3b8', fontSize: 13, cursor: 'pointer' } }, "Close"))), /*#__PURE__*/React.createElement("div", {
    style: {
      marginBottom: 40
    }
  }, /*#__PURE__*/React.createElement("h2", {
    className: "text-4xl font-bold text-white mb-2"
  }, "My Simulations"), /*#__PURE__*/React.createElement("p", {
    className: "text-slate-400 text-base"
  }, "Live status of every CFD job submitted from Fusion 360.")), /*#__PURE__*/React.createElement("div", {
    style: {
      background: 'linear-gradient(135deg,rgba(74,144,217,0.06),rgba(34,211,238,0.05))',
      border: '1px solid rgba(74,144,217,0.12)',
      borderRadius: 12,
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
      color: '#eeeeee',
      marginBottom: 6,
      fontSize: 15
    }
  }, " Fusion 360 Connection Token"), /*#__PURE__*/React.createElement("p", {
    className: "text-sm text-slate-400 leading-relaxed"
  }, "Copy this token and paste it into your Fusion 360 script as", " ", /*#__PURE__*/React.createElement("code", {
    style: {
      background: 'rgba(255,255,255,0.07)',
      padding: '1px 6px',
      borderRadius: 4,
      fontFamily: 'monospace',
      color: '#7acfdd'
    }
  }, "REFRESH_TOKEN"), ". It never expires, so you only need to do this once.")), /*#__PURE__*/React.createElement("button", {
    onClick: copyToken,
    style: {
      padding: '10px 20px',
      borderRadius: 8,
      fontWeight: 700,
      fontSize: 13,
      cursor: 'pointer',
      background: copied ? 'rgba(93,232,138,15)' : 'rgba(74,144,217,0.12)',
      color: copied ? '#5de88a' : '#7ab3e0',
      border: copied ? '1px solid rgba(93,232,138,3)' : '1px solid rgba(74,144,217,0.16)',
      transition: 'all 0.2s',
      whiteSpace: 'nowrap'
    }
  }, copied ? ' Copied!' : ' Copy Token')), token && /*#__PURE__*/React.createElement("div", {
    style: {
      marginTop: 14,
      background: 'rgba(0,0,0,0.3)',
      borderRadius: 8,
      padding: '10px 14px',
      fontFamily: 'monospace',
      fontSize: 11,
      color: '#666666',
      wordBreak: 'break-all',
      border: '1px solid rgba(90,90,90,0.28)',
      maxHeight: 52,
      overflow: 'hidden',
      WebkitMaskImage: 'linear-gradient(to right, black 55%, transparent 100%)'
    }
  }, token), !token && /*#__PURE__*/React.createElement("div", {
    style: {
      marginTop: 12,
      fontSize: 12,
      color: '#666666'
    }
  }, "Sign in to see your token.")), loading ? /*#__PURE__*/React.createElement("div", {
    style: {
      display: 'flex',
      alignItems: 'center',
      gap: 12,
      color: '#666666',
      padding: '40px 0'
    }
  }, /*#__PURE__*/React.createElement("span", {
    style: {
      width: 18,
      height: 18,
      borderRadius: '50%',
      border: '2px solid #4a90d9',
      borderTopColor: 'transparent',
      display: 'inline-block',
      animation: 'spin 0.8s linear infinite'
    }
  }), "Loading your jobs...") : jobs.length === 0 ? /*#__PURE__*/React.createElement("div", {
    style: {
      textAlign: 'center',
      padding: '60px 0',
      color: '#666666'
    }
  }, /*#__PURE__*/React.createElement("div", {
    style: {
      fontSize: 40,
      marginBottom: 12,
      opacity: 0.4
    }
  }), /*#__PURE__*/React.createElement("p", {
    className: "text-base text-slate-500"
  }, "No simulations yet."), /*#__PURE__*/React.createElement("p", {
    className: "text-sm text-slate-600 mt-1"
  }, "Run the Fusion 360 script to submit your first job.")) : /*#__PURE__*/React.createElement("div", {
    style: {
      display: 'flex',
      flexDirection: 'column',
      gap: 12
    }
  }, jobs.map(job => /*#__PURE__*/React.createElement("div", {
    key: job.id,
    style: {
      background: 'linear-gradient(135deg,rgba(30,30,30,0.92),rgba(46,46,46,0.5))',
      border: '1px solid rgba(160,160,160,0.10)',
      borderRadius: 12,
      padding: 20,
      transition: 'border-color 0.2s'
    },
    onMouseOver: e => e.currentTarget.style.borderColor = 'rgba(160,160,160,0.18)',
    onMouseOut: e => e.currentTarget.style.borderColor = 'rgba(160,160,160,0.10)'
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
      color: '#484848',
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
      color: '#666666',
      whiteSpace: 'nowrap'
    }
  }, formatDate(job.createdAt)), canRefund(job.status) && /*#__PURE__*/React.createElement("button", {
    onClick: () => handleRefund(job),
    disabled: !!refunding[job.id],
    style: {
      padding: '5px 12px',
      borderRadius: 6,
      fontSize: 12,
      fontWeight: 700,
      cursor: 'pointer',
      background: 'rgba(0,0,0,0.2)',
      color: '#ff8585',
      border: '1px solid rgba(255,133,133,0.3)',
      opacity: refunding[job.id] ? 0.5 : 1
    }
  }, refunding[job.id] ? 'Cancelling...' : 'Cancel & Refund'))), /*#__PURE__*/React.createElement("div", {
    style: {
      display: 'grid',
      gridTemplateColumns: 'repeat(auto-fill,minmax(130px,1fr))',
      gap: 8,
      marginBottom: 12
    }
  }, job.faceCount != null && /*#__PURE__*/React.createElement("div", {
    style: {
      background: 'rgba(74,144,217,0.12)',
      borderRadius: 6,
      padding: '8px 12px',
      border: '1px solid rgba(74,144,217,0.20)'
    }
  }, /*#__PURE__*/React.createElement("p", {
    style: {
      fontSize: 10,
      color: '#7ab3e0',
      fontWeight: 700,
      textTransform: 'uppercase',
      letterSpacing: '0.08em',
      marginBottom: 3
    }
  }, "Faces"), /*#__PURE__*/React.createElement("p", {
    style: {
      fontSize: 14,
      color: '#fff',
      fontWeight: 700
    }
  }, job.faceCount)), /*#__PURE__*/React.createElement("div", {
    style: {
      background: 'rgba(74,144,217,0.12)',
      borderRadius: 6,
      padding: '8px 12px',
      border: '1px solid rgba(74,144,217,0.20)'
    }
  }, /*#__PURE__*/React.createElement("p", {
    style: {
      fontSize: 10,
      color: '#7ab3e0',
      fontWeight: 700,
      textTransform: 'uppercase',
      letterSpacing: '0.08em',
      marginBottom: 3
    }
  }, "Drag"), /*#__PURE__*/React.createElement("p", {
    style: {
      fontSize: 14,
      color: '#fff',
      fontWeight: 700
    }
  }, job.status === 'complete' && job.drag_N != null ? fmt(Math.abs(job.drag_N)) + ' N' : 'Pending')), /*#__PURE__*/React.createElement("div", {
    style: {
      background: 'rgba(74,144,217,0.12)',
      borderRadius: 6,
      padding: '8px 12px',
      border: '1px solid rgba(74,144,217,0.20)'
    }
  }, /*#__PURE__*/React.createElement("p", {
    style: {
      fontSize: 10,
      color: '#7ab3e0',
      fontWeight: 700,
      textTransform: 'uppercase',
      letterSpacing: '0.08em',
      marginBottom: 3
    }
  }, "Lift"), /*#__PURE__*/React.createElement("p", {
    style: {
      fontSize: 14,
      color: '#fff',
      fontWeight: 700
    }
  }, job.status === 'complete' && job.lift_N != null ? fmt(Math.abs(job.lift_N)) + ' N' : 'Pending')), (() => {
    if (job.status !== 'complete' || job.drag_N == null || !lapDefaults) return /*#__PURE__*/React.createElement("div", {
      style: {
        background: 'rgba(0,0,0,0.2)',
        borderRadius: 6,
        padding: '6px 10px',
        border: '1px solid rgba(255,200,48,0.8)'
      }
    }, /*#__PURE__*/React.createElement("p", {
      style: {
        fontSize: 10,
        color: '#ffc830',
        fontWeight: 700,
        textTransform: 'uppercase',
        letterSpacing: '0.08em',
        marginBottom: 2
      }
    }, "Race Time"), job.status !== 'complete' || job.drag_N == null ? /*#__PURE__*/React.createElement("p", {
      style: {
        fontSize: 13,
        color: '#666666',
        fontWeight: 600
      }
    }, "Pending") : /*#__PURE__*/React.createElement("p", {
      style: {
        fontSize: 10,
        color: '#888888',
        fontWeight: 500,
        margin: 0
      }
    }, "Set defaults in", /*#__PURE__*/React.createElement("br", null), "Race Time Calculator"));
    const drag = Math.abs(job.drag_N);
    const carW = parseFloat(lapDefaults.carWeightG);
    const mu = parseFloat(lapDefaults.muRoll);
    const iMOI = parseFloat(lapDefaults.wheelMoiGMm2);
    if (isNaN(carW) || carW <= 0 || isNaN(mu) || isNaN(iMOI)) return /*#__PURE__*/React.createElement("div", {
      style: {
        background: 'rgba(0,0,0,0.2)',
        borderRadius: 6,
        padding: '6px 10px',
        border: '1px solid rgba(255,200,48,0.8)'
      }
    }, /*#__PURE__*/React.createElement("p", {
      style: {
        fontSize: 10,
        color: '#ffc830',
        fontWeight: 700,
        textTransform: 'uppercase',
        letterSpacing: '0.08em',
        marginBottom: 2
      }
    }, "Race Time"), /*#__PURE__*/React.createElement("p", {
      style: {
        fontSize: 11,
        color: '#666666',
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
          const resp = await fetch('https://us-central1-turboflow-7b3ca.cloudfunctions.net/run_lap_calc', {
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
        background: 'rgba(0,0,0,0.2)',
        borderRadius: 6,
        padding: '6px 10px',
        border: '1px solid rgba(255,200,48,0.3)',
        gridColumn: 'span 2'
      }
    }, /*#__PURE__*/React.createElement("p", {
      style: {
        fontSize: 10,
        color: '#ffc830',
        fontWeight: 700,
        textTransform: 'uppercase',
        letterSpacing: '0.08em',
        marginBottom: 2
      }
    }, "Predicted Race Time"), raceTime != null ? /*#__PURE__*/React.createElement("p", {
      style: {
        fontSize: 15,
        color: '#ffc830',
        fontWeight: 700,
        fontFamily: 'JetBrains Mono,monospace',
        margin: 0
      }
    }, Number(raceTime).toFixed(4), " s") : /*#__PURE__*/React.createElement("p", {
      style: {
        fontSize: 12,
        color: '#666666',
        margin: 0
      }
    }, "Calculating..."));
  })()), job.status === 'complete' && /*#__PURE__*/React.createElement("div", {
    style: {
      marginTop: 4
    }
  }, /*#__PURE__*/React.createElement("button", {
    onClick: () => { try { navigator.clipboard.writeText(job.id); } catch (e) {} setVizJobId(job.id); },
    style: {
      display: 'inline-flex',
      alignItems: 'center',
      gap: 8,
      padding: '8px 12px',
      borderRadius: 6,
      background: 'linear-gradient(135deg, #4488cc 0%, #3377bb 100%)',
      color: '#fff',
      border: '1px solid rgba(74,144,217,0.16)',
      fontSize: 11,
      fontWeight: 700,
      textDecoration: 'none',
      cursor: 'pointer',
      transition: 'all 0.3s'
    }
  }, "Request Visualisation Files")), job.status === 'failed' && job.error && /*#__PURE__*/React.createElement("div", {
    style: {
      marginTop: 12,
      background: 'rgba(0,0,0,0.2)',
      border: '1px solid rgba(255,133,133,0.3)',
      borderRadius: 8,
      padding: '10px 14px',
      fontSize: 12,
      color: '#ff8585',
      fontFamily: 'monospace'
    }
  }, job.error)))));
};

/* -- Inline Race Calc (used on homepage page 5) ---------- */
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
      const resp = await fetch('https://us-central1-turboflow-7b3ca.cloudfunctions.net/run_lap_calc', {
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
    style: {
      display: 'block',
      fontSize: 11,
      fontWeight: 700,
      color: '#666666',
      textTransform: 'uppercase',
      letterSpacing: '0.08em',
      marginBottom: 5
    }
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
      padding: '9px 12px',
      borderRadius: unit ? '7px 0 0 7px' : '7px',
      fontSize: 14
    }
  }), unit && /*#__PURE__*/React.createElement("span", {
    style: {
      padding: '9px 12px',
      background: 'rgba(46,46,46,0.5)',
      border: '1px solid rgba(90,90,90,0.35)',
      borderLeft: 'none',
      borderRadius: '0 7px 7px 0',
      fontSize: 12,
      color: '#666666',
      fontWeight: 600,
      whiteSpace: 'nowrap'
    }
  }, unit)));
  return /*#__PURE__*/React.createElement("div", {
    style: {
      background: 'rgba(30,30,30,0.88)',
      border: '1px solid rgba(46,46,46,0.5)',
      borderRadius: 16,
      padding: '28px 28px 24px'
    }
  }, /*#__PURE__*/React.createElement("p", {
    style: {
      fontSize: 12,
      fontWeight: 700,
      color: '#666666',
      textTransform: 'uppercase',
      letterSpacing: '0.1em',
      marginBottom: 20
    }
  }, "STEM Racing Car - 20 meters Run"), /*#__PURE__*/React.createElement(Field, {
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
      color: '#ff8585',
      margin: '8px 0',
      padding: '8px 12px',
      background: 'rgba(0,0,0,0.2)',
      borderRadius: 7,
      border: '1px solid rgba(255,133,133,0.3)'
    }
  }, error), /*#__PURE__*/React.createElement("button", {
    onClick: run,
    disabled: running,
    className: "btn-primary w-full py-2.5 text-sm font-semibold",
    style: {
      marginTop: 8
    }
  }, running ? 'Running...' : 'Run Simulation (10 credits)'), result !== null && /*#__PURE__*/React.createElement("div", {
    style: {
      marginTop: 16,
      padding: '20px',
      borderRadius: 10,
      textAlign: 'center',
      background: 'linear-gradient(135deg,rgba(93,232,138,07),rgba(30,30,30,0.92))',
      border: '1px solid rgba(93,232,138,18)'
    }
  }, /*#__PURE__*/React.createElement("p", {
    style: {
      fontSize: 11,
      fontWeight: 700,
      color: '#5de88a',
      textTransform: 'uppercase',
      letterSpacing: '0.12em',
      marginBottom: 6
    }
  }, "Predicted Finish Time"), /*#__PURE__*/React.createElement("p", {
    style: {
      fontSize: 44,
      fontWeight: 800,
      color: '#f0f0f0',
      margin: 0,
      fontFamily: 'JetBrains Mono, monospace',
      letterSpacing: '-0.02em'
    }
  }, result.toFixed(4), /*#__PURE__*/React.createElement("span", {
    style: {
      fontSize: 18,
      color: '#888888',
      marginLeft: 4
    }
  }, "s"))));
};

/* -- Home View -------------------------------------------- */
const HomeView = ({
  setView,
  isSignedIn,
  onRequireAuth
}) => {
  const pages = [{
    id: 'racetime',
    title: 'Race Time Calculator',
    subtitle: 'Predict your track time from your car data.',
    borderColor: 'border-green-400',
    accentColor: '#5de88a',
    badge: 'Live Now',
    badgeColor: 'rgba(93,232,138,08)',
    badgeTextColor: '#5de88a',
    badgeBorder: 'rgba(93,232,138,2)',
    description: 'Feed in your CFD results and car data, and our scripts calculate predicted track time from aero changes. Understand exactly how much a 0.01 N drag reduction is worth on the track before you commit to a design direction.',
    cta: 'Check Time',
    ctaView: 'lapcalc',
    ctaNote: 'Free for sponsored teams. It costs 10 credits per run for other users.'
  }, {
    id: 'cfd',
    title: 'Iterative CFD',
    subtitle: 'Upload your geometry. We handle the rest.',
    borderColor: 'border-blue-500',
    accentColor: '#4a90d9',
    badge: 'Core Service',
    badgeColor: 'rgba(74,144,217,0.10)',
    badgeTextColor: '#7ab3e0',
    badgeBorder: 'rgba(74,144,217,0.16)',
    description: 'Drop in your CAD file and our pipeline automatically explores the design space: finding optimal curves, surface features, and aerodynamic configurations across dozens of variants. No manual setup. No CFD expertise required.',
    sections: [{
      e: '',
      t: 'Upload Once',
      b: 'Supports F3D, STEP. Our pipeline preprocesses your geometry automatically: cleaning surfaces, generating meshes, and configuring boundary conditions without any manual input.'
    }, {
      e: '',
      t: 'We Iterate',
      b: 'Our solver runs parametric sweeps across your geometry, varying curvature, camber, chord, and surface features to find configurations you would not have thought to try.'
    }, {
      e: '',
      t: 'Best Results Surfaced',
      b: 'Every run is ranked by aerodynamic performance. Drag coefficient, lift coefficient, pressure distribution, residuals and visualization: we surface the winners and show you why they perform better.'
    }],
    cta: 'Submit a Simulation',
    ctaView: 'simulations'
  }, {
    id: 'mentorship',
    title: 'Mentorship Program',
    subtitle: 'Expert guidance at every stage of your campaign.',
    borderColor: 'border-violet-400',
    accentColor: '#7ab3e0',
    badge: 'Programs',
    badgeColor: 'rgba(167,139,250,0.12)',
    badgeTextColor: '#7ab3e0',
    badgeBorder: 'rgba(167,139,250,0.3)',
    layoutType: 'steps',
    description: 'Work directly with engineers who understand STEM racing. From interpreting your first CFD run to building a full aerodynamic development strategy for your car, we are with you throughout your campaign.',
    steps: [{
      num: '01',
      label: 'Submit your results',
      detail: 'Share your drag, lift, and iteration history. We review everything before our first session so no time is wasted.'
    }, {
      num: '02',
      label: 'Strategy session',
      detail: 'We map your development priorities: which parameters to target, what trade-offs to accept, and how to pace your simulation budget across the season.'
    }, {
      num: '03',
      label: 'Ongoing support',
      detail: 'We stay with you throughout the campaign: reviewing new runs, adjusting the plan, and helping you defend your design at scrutineering.'
    }],
    audience: ['F1 in Schools', 'STEM Racing'],
    cta: 'Get in Touch',
    ctaView: 'mentorship',
    ctaNote: 'For F1 in Schools and STEM Racing teams only'
  }, {
    id: 'modelling',
    title: 'Modelling Services',
    subtitle: 'Need help with your geometry? We have got you.',
    borderColor: 'border-cyan-400',
    accentColor: '#5bc4d8',
    badge: 'Free for CFD Users',
    badgeColor: 'rgba(74,144,217,0.08)',
    badgeTextColor: '#5bc4d8',
    badgeBorder: 'rgba(34,211,238,0.25)',
    layoutType: 'checklist',
    description: 'Paying CFD users get modelling support at no extra cost. We help you build, clean, and prepare geometry that is actually simulation-ready.',
    included: ['Spline & curve editing in Fusion 360', 'Open shell and non-manifold edge repair', 'CAD prep and mesh-readiness checks', 'Symmetry planes and domain sizing', 'Parametric model setup for fast iteration', 'F3D export setup for optimal spline fitting', 'Async support via email or Instagram'],
    notIncluded: ['Full builds from scratch (quoted separately)', 'Physical testing or wind tunnel work'],
    cta: 'Contact Us',
    ctaView: 'modelling',
    ctaNote: 'Free for paying CFD users. Contact us for standalone modelling work.'
  }];
  return /*#__PURE__*/React.createElement("div", {
    style: {
      display: 'flex',
      flexDirection: 'column',
      width: '100%',
      flex: 1,
      scrollBehavior: 'smooth'
    }
  }, /*#__PURE__*/React.createElement("div", {
    style: {
      position: 'relative',
      width: '100%',
      flex: '0 0 100vh',
      display: 'flex',
      flexDirection: 'column',
      justifyContent: 'center',
      overflow: 'hidden',
      borderBottom: '1px solid rgba(46,46,46,0.5)',
      scrollSnapAlign: 'start'
    }
  }, /*#__PURE__*/React.createElement("video", {
    autoPlay: true,
    muted: true,
    loop: true,
    playsInline: true,
    style: {
      position: 'absolute',
      inset: 0,
      width: '100%',
      height: '100%',
      objectFit: 'cover',
      zIndex: 0,
      opacity: 1
    },
    src: "hero-background.mp4"
  }), /*#__PURE__*/React.createElement("div", {
    style: {
      position: 'absolute',
      inset: 0,
      zIndex: 1,
      background: 'linear-gradient(135deg,rgba(20,20,20,0.82) 0%,rgba(30,30,30,0.70) 50%,rgba(20,20,20,0.90) 100%)'
    }
  }), /*#__PURE__*/React.createElement("div", {
    style: {
      position: 'relative',
      zIndex: 2,
      padding: '0 56px',
      width: '100%'
    }
  }, /*#__PURE__*/React.createElement("h1", {
    style: {
      fontSize: 'clamp(44px,6vw,72px)',
      fontWeight: 900,
      color: '#f0f0f0',
      lineHeight: 1.08,
      margin: '0 0 10px',
      letterSpacing: '-0.03em'
    }
  }, "1-Click CFD."), /*#__PURE__*/React.createElement("h2", {
    style: {
      fontSize: 'clamp(28px,4vw,46px)',
      fontWeight: 700,
      color: '#eeeeee',
      lineHeight: 1.15,
      margin: '0 0 28px',
      letterSpacing: '-0.02em'
    }
  }, "Upload your simulations to the cloud in 15 seconds."), /*#__PURE__*/React.createElement("p", {
    style: {
      fontSize: 20,
      color: '#aaaaaa',
      fontWeight: 400,
      maxWidth: 620,
      lineHeight: 1.65,
      margin: '0 0 48px'
    }
  }, "Built for F1 in Schools and STEM Racing teams. Upload your design from Fusion 360 and get drag, lift, and predicted race time, and it's done entirely in the cloud."), /*#__PURE__*/React.createElement("div", {
    style: {
      display: 'flex',
      gap: 16,
      alignItems: 'center',
      flexWrap: 'wrap'
    }
  }, /*#__PURE__*/React.createElement("button", {
    onClick: () => {
      if (!isSignedIn) {
        onRequireAuth('Sign in to start a simulation.');
        return;
      }
      setView('simulations');
    },
    className: "btn-primary",
    style: {
      padding: '14px 36px',
      fontSize: 16,
      fontWeight: 700,
      borderRadius: 8,
      display: 'flex',
      alignItems: 'center',
      gap: 8
    }
  }, !isSignedIn && Ic.Lock(13), "Run a Simulation", /*#__PURE__*/React.createElement("svg", {
    width: "16",
    height: "16",
    viewBox: "0 0 24 24",
    fill: "none",
    stroke: "currentColor",
    strokeWidth: "2.5"
  }, /*#__PURE__*/React.createElement("path", {
    d: "M5 12h14M12 5l7 7-7 7"
  }))), /*#__PURE__*/React.createElement("button", {
    onClick: () => setView('docs'),
    style: {
      padding: '14px 28px',
      fontSize: 15,
      fontWeight: 600,
      borderRadius: 8,
      background: 'rgba(255,255,255,0.04)',
      border: '1px solid rgba(160,160,160,0.18)',
      color: '#aaaaaa',
      cursor: 'pointer',
      transition: 'all 0.2s'
    }
  }, "How It Works")), !isSignedIn && /*#__PURE__*/React.createElement("p", {
    style: {
      marginTop: 14,
      fontSize: 13,
      color: '#666666',
      display: 'flex',
      alignItems: 'center',
      gap: 6
    }
  }, Ic.Lock(11), " Free account required to run simulations.")), /*#__PURE__*/React.createElement("div", {
    style: {
      position: 'absolute',
      bottom: 0,
      left: 0,
      right: 0,
      height: 120,
      zIndex: 4,
      background: 'linear-gradient(to top,rgba(20,20,20,1) 0%,transparent 100%)'
    }
  }), /*#__PURE__*/React.createElement("div", {
    style: {
      position: 'absolute',
      bottom: 32,
      right: 48,
      zIndex: 5,
      fontSize: 96,
      fontWeight: 900,
      color: 'rgba(74,144,217,0.06)',
      fontFamily: 'monospace',
      lineHeight: 1,
      userSelect: 'none'
    }
  }, "01")), pages.map((page, idx) => /*#__PURE__*/React.createElement("div", {
    key: idx,
    style: {
      width: '100%',
      height: '100vh',
      flexShrink: 0,
      display: 'flex',
      alignItems: 'stretch',
      borderBottom: idx < pages.length - 1 ? '1px solid rgba(46,46,46,0.5)' : 'none',
      scrollSnapAlign: 'start',
      boxSizing: 'border-box',
      padding: '0 64px',
      gap: 64
    }
  }, /*#__PURE__*/React.createElement("div", {
    style: {
      flex: '0 0 480px',
      display: 'flex',
      flexDirection: 'column',
      justifyContent: 'center',
      paddingTop: 24,
      paddingBottom: 24
    }
  }, /*#__PURE__*/React.createElement("div", {
    style: {
      fontSize: 13,
      fontWeight: 700,
      letterSpacing: '0.14em',
      textTransform: 'uppercase',
      color: page.accentColor,
      marginBottom: 20
    }
  }, String(idx + 2).padStart(2, '0')), /*#__PURE__*/React.createElement("h2", {
    style: {
      fontSize: 'clamp(40px,4.5vw,68px)',
      fontWeight: 900,
      color: '#f0f0f0',
      lineHeight: 1.05,
      margin: '0 0 18px',
      letterSpacing: '-0.03em'
    }
  }, page.title), /*#__PURE__*/React.createElement("p", {
    style: {
      fontSize: 22,
      color: '#888888',
      fontWeight: 500,
      marginBottom: 22,
      lineHeight: 1.45
    }
  }, page.subtitle), /*#__PURE__*/React.createElement("div", {
    style: {
      width: 48,
      height: 4,
      background: page.accentColor,
      borderRadius: 2,
      marginBottom: 26,
      opacity: 0.7
    }
  }), /*#__PURE__*/React.createElement("p", {
    style: {
      fontSize: 18,
      color: '#aaaaaa',
      lineHeight: 1.8,
      marginBottom: 36
    }
  }, page.description), /*#__PURE__*/React.createElement("div", {
    style: {
      display: 'flex',
      gap: 14,
      alignItems: 'center',
      flexWrap: 'wrap'
    }
  }, page.comingSoon ? /*#__PURE__*/React.createElement("button", {
    disabled: true,
    className: "btn-primary opacity-50 cursor-not-allowed",
    style: {
      padding: '14px 28px',
      fontSize: 16,
      fontWeight: 700,
      borderRadius: 8
    }
  }, "Coming Soon") : /*#__PURE__*/React.createElement("button", {
    onClick: () => {
      if (page.ctaView === 'simulations') {
        if (!isSignedIn) {
          onRequireAuth('Sign in to start a simulation.');
          return;
        }
        setView('simulations');
      } else {
        setView(page.ctaView);
      }
    },
    className: "btn-primary flex items-center gap-2",
    style: {
      padding: '14px 28px',
      fontSize: 16,
      fontWeight: 700,
      borderRadius: 8
    }
  }, page.ctaView === 'simulations' && !isSignedIn && Ic.Lock(13), page.cta, /*#__PURE__*/React.createElement("svg", {
    width: "16",
    height: "16",
    viewBox: "0 0 24 24",
    fill: "none",
    stroke: "currentColor",
    strokeWidth: "2.5"
  }, /*#__PURE__*/React.createElement("path", {
    d: "M5 12h14M12 5l7 7-7 7"
  }))), page.ctaNote && /*#__PURE__*/React.createElement("p", {
    style: {
      fontSize: 14,
      color: '#666666'
    }
  }, page.ctaNote))), /*#__PURE__*/React.createElement("div", {
    style: {
      flex: 1,
      display: 'flex',
      flexDirection: 'column',
      gap: 16,
      justifyContent: 'center',
      paddingTop: 24,
      paddingBottom: 24
    }
  }, page.id === 'racetime' ?
  /*#__PURE__*/
  /* -- Inline Race Time Calculator -- */
  React.createElement(InlineRaceCalc, {
    isSignedIn: isSignedIn,
    onRequireAuth: onRequireAuth
  }) : page.layoutType === 'steps' ?
  /*#__PURE__*/
  /* -- Mentorship: numbered process steps -- */
  React.createElement("div", {
    style: {
      display: 'flex',
      flexDirection: 'column',
      gap: 0
    }
  }, page.steps.map(({
    num,
    label,
    detail
  }, i) => /*#__PURE__*/React.createElement("div", {
    key: num,
    style: {
      display: 'flex',
      gap: 20,
      paddingBottom: i < page.steps.length - 1 ? 28 : 0,
      position: 'relative'
    }
  }, i < page.steps.length - 1 && /*#__PURE__*/React.createElement("div", {
    style: {
      position: 'absolute',
      left: 20,
      top: 44,
      width: 2,
      bottom: 0,
      background: `linear-gradient(to bottom,${page.accentColor}55,transparent)`,
      borderRadius: 2
    }
  }), /*#__PURE__*/React.createElement("div", {
    style: {
      flexShrink: 0,
      width: 40,
      height: 40,
      borderRadius: 10,
      background: `rgba(74,144,217,0.08)`,
      border: `1px solid ${page.accentColor}55`,
      display: 'flex',
      alignItems: 'center',
      justifyContent: 'center',
      fontFamily: 'JetBrains Mono,monospace',
      fontWeight: 700,
      fontSize: 13,
      color: page.accentColor
    }
  }, num), /*#__PURE__*/React.createElement("div", {
    style: {
      paddingTop: 6
    }
  }, /*#__PURE__*/React.createElement("p", {
    style: {
      fontSize: 17,
      fontWeight: 700,
      color: '#eeeeee',
      margin: '0 0 6px'
    }
  }, label), /*#__PURE__*/React.createElement("p", {
    style: {
      fontSize: 14,
      color: '#888888',
      lineHeight: 1.65,
      margin: 0
    }
  }, detail)))), /*#__PURE__*/React.createElement("div", {
    style: {
      marginTop: 28,
      borderTop: '1px solid rgba(46,46,46,0.5)',
      paddingTop: 20
    }
  }, /*#__PURE__*/React.createElement("p", {
    style: {
      fontSize: 11,
      fontWeight: 700,
      textTransform: 'uppercase',
      letterSpacing: '0.1em',
      color: '#666666',
      marginBottom: 12
    }
  }, "Available for"), /*#__PURE__*/React.createElement("div", {
    style: {
      display: 'flex',
      gap: 8,
      flexWrap: 'wrap'
    }
  }, page.audience.map(a => /*#__PURE__*/React.createElement("span", {
    key: a,
    style: {
      fontSize: 13,
      fontWeight: 600,
      padding: '5px 12px',
      borderRadius: 20,
      background: 'rgba(167,139,250,0.08)',
      border: '1px solid rgba(74,144,217,0.12)',
      color: '#9ec8e8'
    }
  }, a))))) : page.layoutType === 'checklist' ?
  /*#__PURE__*/
  /* -- Modelling: included / not included checklist -- */
  React.createElement("div", {
    style: {
      background: 'rgba(30,30,30,0.88)',
      border: '1px solid rgba(46,46,46,0.5)',
      borderRadius: 16,
      padding: '28px 32px'
    }
  }, /*#__PURE__*/React.createElement("p", {
    style: {
      fontSize: 12,
      fontWeight: 700,
      textTransform: 'uppercase',
      letterSpacing: '0.1em',
      color: '#5bc4d8',
      marginBottom: 18
    }
  }, "What's included - free for CFD users"), /*#__PURE__*/React.createElement("div", {
    style: {
      display: 'flex',
      flexDirection: 'column',
      gap: 10,
      marginBottom: 24
    }
  }, page.included.map(item => /*#__PURE__*/React.createElement("div", {
    key: item,
    style: {
      display: 'flex',
      alignItems: 'flex-start',
      gap: 10
    }
  }, /*#__PURE__*/React.createElement("svg", {
    style: {
      flexShrink: 0,
      marginTop: 2
    },
    width: "13",
    height: "13",
    viewBox: "0 0 24 24",
    fill: "none",
    stroke: "#5bc4d8",
    strokeWidth: "2.5"
  }, /*#__PURE__*/React.createElement("polyline", {
    points: "20 6 9 17 4 12"
  })), /*#__PURE__*/React.createElement("span", {
    style: {
      fontSize: 14,
      color: '#cccccc',
      lineHeight: 1.5
    }
  }, item)))), /*#__PURE__*/React.createElement("div", {
    style: {
      borderTop: '1px solid rgba(46,46,46,0.5)',
      paddingTop: 16
    }
  }, /*#__PURE__*/React.createElement("p", {
    style: {
      fontSize: 11,
      fontWeight: 700,
      textTransform: 'uppercase',
      letterSpacing: '0.1em',
      color: '#484848',
      marginBottom: 10
    }
  }, "Not included"), /*#__PURE__*/React.createElement("div", {
    style: {
      display: 'flex',
      flexDirection: 'column',
      gap: 8
    }
  }, page.notIncluded.map(item => /*#__PURE__*/React.createElement("div", {
    key: item,
    style: {
      display: 'flex',
      alignItems: 'flex-start',
      gap: 10
    }
  }, /*#__PURE__*/React.createElement("svg", {
    style: {
      flexShrink: 0,
      marginTop: 2
    },
    width: "13",
    height: "13",
    viewBox: "0 0 24 24",
    fill: "none",
    stroke: "#666666",
    strokeWidth: "2"
  }, /*#__PURE__*/React.createElement("line", {
    x1: "18",
    y1: "6",
    x2: "6",
    y2: "18"
  }), /*#__PURE__*/React.createElement("line", {
    x1: "6",
    y1: "6",
    x2: "18",
    y2: "18"
  })), /*#__PURE__*/React.createElement("span", {
    style: {
      fontSize: 13,
      color: '#666666',
      lineHeight: 1.5
    }
  }, item)))))) :
  /*#__PURE__*/
  /* -- Feature cards (CFD page) -- */
  React.createElement(React.Fragment, null, page.sections.map(({
    t,
    b
  }) => /*#__PURE__*/React.createElement("div", {
    key: t,
    style: {
      background: 'rgba(30,30,30,0.85)',
      border: '1px solid rgba(46,46,46,0.5)',
      borderLeft: `4px solid ${page.accentColor}`,
      borderRadius: 12,
      padding: '24px 28px',
      transition: 'border-color 0.2s'
    }
  }, /*#__PURE__*/React.createElement("h3", {
    style: {
      fontSize: 18,
      fontWeight: 700,
      color: '#eeeeee',
      marginBottom: 10
    }
  }, t), /*#__PURE__*/React.createElement("p", {
    style: {
      fontSize: 15,
      color: '#888888',
      lineHeight: 1.7,
      margin: 0
    }
  }, b))))))));
};

/* -- Profile View ----------------------------------------- */
const ProfileView = ({
  user,
  isSignedIn,
  onRequireAuth,
  onSaveProfile
}) => {
  const [teamName, setTeamName] = useState(user && user.teamName || '');
  const [region, setRegion] = useState(user && user.region || '');
  const [contactEmail, setContactEmail] = useState(user && user.email || '');
  useEffect(() => {
    setTeamName(user && user.teamName || '');
    setRegion(user && user.region || '');
    setContactEmail(user && (user.contactEmail || user.email) || '');
  }, [user]);
  const [toast, setToast] = useState(null);
  const save = async () => {
    if (!isSignedIn) {
      onRequireAuth('Sign in to edit your profile.');
      return;
    }
    const res = await onSaveProfile({
      teamName: teamName || null,
      region: region || null,
      contactEmail: contactEmail || null
    });
    if (res && res.ok) {
      setToast({
        type: 'success',
        text: res.message || 'Saved'
      });
      setTimeout(() => setToast(null), 3000);
    } else {
      setToast({
        type: 'error',
        text: res && res.message || 'Save failed'
      });
      setTimeout(() => setToast(null), 4000);
    }
  };
  return /*#__PURE__*/React.createElement("div", {
    style: {
      padding: '64px 32px'
    }
  }, /*#__PURE__*/React.createElement("h2", {
    className: "text-4xl font-bold text-white mb-4"
  }, "Team Profile"), /*#__PURE__*/React.createElement("div", {
    className: "card-elegant border border-slate-800 rounded-lg p-6"
  }, /*#__PURE__*/React.createElement("div", {
    className: "grid grid-cols-2 gap-6"
  }, /*#__PURE__*/React.createElement("div", null, /*#__PURE__*/React.createElement("label", {
    className: "text-sm font-semibold text-slate-300 block mb-2"
  }, "Team Name"), /*#__PURE__*/React.createElement("input", {
    value: teamName,
    onChange: e => setTeamName(e.target.value),
    className: "input-field w-full px-4 py-3 rounded-lg text-white",
    placeholder: "Team Name"
  })), /*#__PURE__*/React.createElement("div", null, /*#__PURE__*/React.createElement("label", {
    className: "text-sm font-semibold text-slate-300 block mb-2"
  }, "Region"), /*#__PURE__*/React.createElement("select", {
    value: region,
    onChange: e => setRegion(e.target.value),
    className: "input-field fancy-select w-full px-4 py-3 rounded-lg text-white"
  }, /*#__PURE__*/React.createElement("option", {
    value: ""
  }, "Select region"), /*#__PURE__*/React.createElement("option", null, "North America"), /*#__PURE__*/React.createElement("option", null, "Europe"), /*#__PURE__*/React.createElement("option", null, "Asia"), /*#__PURE__*/React.createElement("option", null, "Oceania"), /*#__PURE__*/React.createElement("option", null, "South America"), /*#__PURE__*/React.createElement("option", null, "Africa")))), /*#__PURE__*/React.createElement("div", {
    className: "flex items-center justify-end mt-6 gap-3"
  }, /*#__PURE__*/React.createElement("div", {
    style: {
      position: 'relative'
    }
  }, /*#__PURE__*/React.createElement("button", {
    onClick: save,
    className: "btn-primary py-2.5 px-4 text-base font-semibold"
  }, "Save Profile"), toast && /*#__PURE__*/React.createElement("div", {
    style: {
      position: 'absolute',
      right: 0,
      top: '-44px',
      transform: 'translateY(-4px)'
    }
  }, /*#__PURE__*/React.createElement("div", {
    style: {
      background: toast.type === 'success' ? 'rgba(40,212,102,12)' : 'rgba(0,0,0,0.2)',
      border: `1px solid ${toast.type === 'success' ? 'rgba(40,212,102,25)' : 'rgba(255,133,133,0.3)'}`,
      color: toast.type === 'success' ? '#5de88a' : '#ff8585',
      padding: '8px 12px',
      borderRadius: 10,
      fontSize: 13
    }
  }, toast.text))))));
};

/* -- Order Tracker --------------------------------------- */
const OrderTracker = ({
  user
}) => {
  const [orders, setOrders] = useState([]);
  const [refunding, setRefunding] = useState({});
  useEffect(() => {
    if (!user || !user.uid) {
      setOrders([]);
      return;
    }
    const uid = user.uid;
    const q = db.collection('jobs').where('userId', '==', uid).limit(10);
    const unsub = q.onSnapshot(snap => {
      const docs = snap.docs.map(d => ({
        id: d.id,
        ...d.data()
      }));
      docs.sort((a, b) => {
        const ta = a.createdAt && a.createdAt.toMillis ? a.createdAt.toMillis() : 0;
        const tb = b.createdAt && b.createdAt.toMillis ? b.createdAt.toMillis() : 0;
        return tb - ta;
      });
      setOrders(docs.slice(0, 5));
    }, err => {
      console.error('Order listen failed', err);
      setOrders([]);
    });
    return () => unsub();
  }, [user && user.uid]);
  const handleRefund = async order => {
    if (refunding[order.id]) return;
    const isRefundable = ['queued', 'pending', 'downloading', 'uploading_geometry', 'processing', 'creating_simulation', 'meshing'].includes(order.status);
    const refundAmt = isRefundable ? order.cost : 0;
    const pct = isRefundable ? '100%' : '0%';
    if (!window.confirm(`Refund this job for ${refundAmt} credits (${pct} of ${order.cost})? This cannot be undone.`)) return;
    setRefunding(r => ({
      ...r,
      [order.id]: true
    }));
    try {
      const refundJobFn = functions.httpsCallable('refundJob');
      await refundJobFn({
        jobId: order.id
      });
    } catch (e) {
      console.error('Refund failed', e);
      alert('Refund failed: ' + (e && e.message));
      setRefunding(r => ({
        ...r,
        [order.id]: false
      }));
    }
  };
  const steps = [{
    key: 'queued',
    label: 'Queued'
  }, {
    key: 'processing',
    label: 'Processing'
  }, {
    key: 'done',
    label: 'Done'
  }];
  return /*#__PURE__*/React.createElement("div", {
    style: {
      marginTop: 18
    },
    className: "card-elegant border border-slate-800 rounded-lg p-6"
  }, /*#__PURE__*/React.createElement("h4", {
    className: "text-base font-semibold text-white mb-3"
  }, "Order Tracker"), orders.length === 0 && /*#__PURE__*/React.createElement("div", {
    className: "text-sm text-slate-400"
  }, "No recent orders. Simulation submissions will appear here."), orders.map(order => {
    const statusIndex = steps.findIndex(s => s.key === order.status);
    const canRefund = order.status === 'queued' || order.status === 'processing';
    const refundLabel = order.status === 'queued' ? '100% Refund' : order.status === 'processing' ? '50% Refund' : null;
    const refundColor = order.status === 'queued' ? '#5de88a' : '#ffc830';
    return /*#__PURE__*/React.createElement("div", {
      key: order.id,
      className: "mb-5 last:mb-0"
    }, /*#__PURE__*/React.createElement("div", {
      className: "flex items-center justify-between mb-1"
    }, /*#__PURE__*/React.createElement("div", {
      className: "text-sm text-slate-300 font-semibold"
    }, order.part || 'Simulation'), /*#__PURE__*/React.createElement("div", {
      className: "flex items-center gap-3"
    }, /*#__PURE__*/React.createElement("div", {
      className: "text-[13px] text-slate-500 font-mono"
    }, order.cost ? `${order.cost} credits` : ''), canRefund && /*#__PURE__*/React.createElement("button", {
      onClick: () => handleRefund(order),
      disabled: refunding[order.id],
      style: {
        padding: '3px 10px',
        borderRadius: 6,
        fontSize: 12,
        fontWeight: 700,
        border: `1px solid ${refundColor}40`,
        background: `${refundColor}12`,
        color: refundColor,
        cursor: refunding[order.id] ? 'not-allowed' : 'pointer',
        opacity: refunding[order.id] ? 0.5 : 1,
        transition: 'all 0.2s'
      }
    }, refunding[order.id] ? 'Processing...' : refundLabel))), /*#__PURE__*/React.createElement("div", {
      className: "text-[13px] text-slate-500 mb-3 truncate"
    }, order.fileName || ''), /*#__PURE__*/React.createElement("div", {
      className: "flex items-center gap-2"
    }, steps.map((s, i) => /*#__PURE__*/React.createElement("div", {
      key: s.key,
      style: {
        flex: 1,
        textAlign: 'center'
      }
    }, /*#__PURE__*/React.createElement("div", {
      style: {
        width: 28,
        height: 28,
        margin: '0 auto',
        borderRadius: 999,
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        background: i <= statusIndex ? 'linear-gradient(180deg,#4a90d9,#3aabca)' : '#1e1e1e',
        border: i <= statusIndex ? '1px solid rgba(74,144,217,0.16)' : '1px solid rgba(160,160,160,0.06)'
      }
    }, i <= statusIndex ? /*#__PURE__*/React.createElement("svg", {
      width: "13",
      height: "13",
      viewBox: "0 0 24 24",
      fill: "none",
      stroke: "#fff",
      strokeWidth: "2.5"
    }, /*#__PURE__*/React.createElement("polyline", {
      points: "20 6 9 17 4 12"
    })) : /*#__PURE__*/React.createElement("span", {
      className: "text-sm text-slate-500"
    }, i + 1)), /*#__PURE__*/React.createElement("div", {
      className: "text-[13px] mt-1.5",
      style: {
        color: i <= statusIndex ? '#9ec8e8' : '#666666'
      }
    }, s.label)))), orders.indexOf(order) < orders.length - 1 && /*#__PURE__*/React.createElement("div", {
      className: "border-t border-slate-800 mt-4"
    }));
  }));
};

/* -- Solver View ------------------------------------------ */
const SponsorshipView = () => /*#__PURE__*/React.createElement("div", {
  style: {
    padding: '64px 32px'
  }
}, /*#__PURE__*/React.createElement("div", {
  style: {
    marginBottom: 48
  }
}, /*#__PURE__*/React.createElement("div", {
  className: "flex items-center gap-3 mb-3 flex-wrap"
}, Ic.Trophy(24), /*#__PURE__*/React.createElement("h2", {
  className: "text-4xl font-bold text-white"
}, "Sponsorship Program"), /*#__PURE__*/React.createElement("span", {
  style: {
    fontSize: 13,
    fontWeight: 700,
    letterSpacing: '0.08em',
    textTransform: 'uppercase',
    background: 'rgba(74,144,217,0.12)',
    color: '#5bc4d8',
    border: '1px solid rgba(74,144,217,0.3)',
    padding: '4px 12px',
    borderRadius: 20
  }
}, "STEM Racing")), /*#__PURE__*/React.createElement("p", {
  className: "text-slate-300 text-lg max-w-2xl leading-relaxed"
}, "F1 in Schools and STEM Racing teams get heavily discounted credits, priority support, and hands-on engineering help: permanently.")), /*#__PURE__*/React.createElement("div", {
  className: "grid grid-cols-2 gap-5 mb-10"
}, [{
  title: 'Discounted Credits',
  desc: 'Sponsored teams pay as little as $0.01 per credit: up to 80% off standard rates. The discount is permanent and locked in for the duration of your programme.'
}, {
  title: 'Priority Support',
  desc: 'Direct access to our team for help with submissions, result interpretation, and troubleshooting. We are here throughout your entire campaign, not just when things go wrong.'
}, {
  title: 'Modelling Help',
  desc: 'Struggling with your CAD geometry or not sure how to prepare your files? We will help you build, clean, and get your models simulation-ready: included at no extra cost.'
}, {
  title: 'Engineering Mentorship',
  desc: 'Get guidance from engineers on aerodynamic strategy, design iteration, and how to read and act on your CFD results effectively throughout the season.'
}].map(({
  title,
  desc
}) => /*#__PURE__*/React.createElement("div", {
  key: title,
  style: {
    borderRadius: 12,
    padding: 24
  }
}, /*#__PURE__*/React.createElement("h3", {
  className: "text-base font-bold text-white mb-2"
}, title), /*#__PURE__*/React.createElement("p", {
  className: "text-sm text-slate-400 leading-relaxed"
}, desc)))), /*#__PURE__*/React.createElement("div", {
  className: "grid grid-cols-4 gap-4 mb-10"
}, [{
  n: '80%',
  l: 'Max discount'
}, {
  n: 'Free',
  l: 'Modelling support'
}, {
  n: '48hr',
  l: 'Application review'
}, {
  n: '8',
  l: 'Team members'
}].map(({
  n,
  l
}) => /*#__PURE__*/React.createElement("div", {
  key: l,
  className: "card-elegant border border-slate-800 rounded-xl p-5 text-center"
}, /*#__PURE__*/React.createElement("div", {
  className: "text-4xl font-mono font-bold text-purple-400 mb-1"
}, n), /*#__PURE__*/React.createElement("div", {
  className: "text-[15px] text-slate-400"
}, l)))), /*#__PURE__*/React.createElement("div", {
  style: {
    background: 'rgba(74,144,217,0.06)',
    border: '1px solid rgba(74,144,217,0.12)',
    borderRadius: 12,
    padding: 28,
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'space-between',
    flexWrap: 'wrap',
    gap: 16
  }
}, /*#__PURE__*/React.createElement("div", null, /*#__PURE__*/React.createElement("p", {
  className: "text-base font-semibold text-white mb-1"
}, "F1 in Schools or STEM Racing team?"), /*#__PURE__*/React.createElement("p", {
  className: "text-sm text-slate-400"
}, "Message us on Instagram and we will get back to you within 48 hours with a custom sponsorship package.")), /*#__PURE__*/React.createElement("a", {
  href: "https://www.instagram.com/turboflow.cfd",
  target: "_blank",
  rel: "noopener noreferrer",
  style: {
    textDecoration: 'none'
  },
  className: "btn-primary px-6 py-3 text-sm font-semibold flex items-center gap-2 whitespace-nowrap"
}, Ic.Trophy(14), " Apply for Sponsorship")));

/* -- Mentorship Program View ----------------------------- */
const MentorshipView = () => /*#__PURE__*/React.createElement("div", {
  style: {
    padding: '64px 32px'
  }
}, /*#__PURE__*/React.createElement("div", {
  style: {
    marginBottom: 48
  }
}, /*#__PURE__*/React.createElement("div", {
  className: "flex items-center gap-3 mb-3 flex-wrap"
}, /*#__PURE__*/React.createElement("span", {
  style: {
    fontSize: 13,
    fontWeight: 700,
    letterSpacing: '0.08em',
    textTransform: 'uppercase',
    background: 'rgba(74,144,217,0.12)',
    color: '#5bc4d8',
    border: '1px solid rgba(74,144,217,0.3)',
    padding: '4px 12px',
    borderRadius: 20
  }
}, "Programs")), /*#__PURE__*/React.createElement("h2", {
  className: "text-4xl font-bold text-white mb-4"
}, "Mentorship Program"), /*#__PURE__*/React.createElement("p", {
  className: "text-slate-300 text-lg max-w-2xl leading-relaxed"
}, "Direct access to engineers who understand STEM racing. From interpreting your first CFD run to building a full aerodynamic development strategy, we are with you throughout your campaign.")), /*#__PURE__*/React.createElement("div", {
  className: "grid grid-cols-2 gap-5 mb-10"
}, [{
  title: 'Engineering Guidance',
  desc: 'Work with engineers who can help you interpret CFD results, understand performance trade-offs, and make confident design decisions at every stage of your season.'
}, {
  title: 'Aero Development Strategy',
  desc: 'Learn how to prioritise your simulation budget, which parameters to target first, and how to build a structured iteration plan that actually improves your car.'
}, {
  title: 'Competition Preparation',
  desc: 'Tailored support for F1 in Schools and STEM Racing events. We help you present your aero work clearly and defend your design decisions under scrutiny.'
}, {
  title: 'Results Interpretation',
  desc: 'Not sure what your drag and lift numbers mean in practice? We translate simulation output into actionable design feedback you can act on immediately.'
}].map(({
  title,
  desc
}) => /*#__PURE__*/React.createElement("div", {
  key: title,
  style: {
    borderRadius: 12,
    padding: 24
  }
}, /*#__PURE__*/React.createElement("h3", {
  className: "text-base font-bold text-white mb-2"
}, title), /*#__PURE__*/React.createElement("p", {
  className: "text-sm text-slate-400 leading-relaxed"
}, desc)))), /*#__PURE__*/React.createElement("div", {
  style: {
    background: 'rgba(74,144,217,0.06)',
    border: '1px solid rgba(74,144,217,0.12)',
    borderRadius: 12,
    padding: 28,
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'space-between',
    flexWrap: 'wrap',
    gap: 16
  }
}, /*#__PURE__*/React.createElement("div", null, /*#__PURE__*/React.createElement("p", {
  className: "text-base font-semibold text-white mb-1"
}, "F1 in Schools or STEM Racing team?"), /*#__PURE__*/React.createElement("p", {
  className: "text-sm text-slate-400"
}, "Reach out via Instagram and we will get back to you to discuss how we can support your team.")), /*#__PURE__*/React.createElement("a", {
  href: "https://www.instagram.com/turboflow.cfd",
  target: "_blank",
  rel: "noopener noreferrer",
  style: {
    textDecoration: 'none'
  },
  className: "btn-primary px-6 py-3 text-sm font-semibold flex items-center gap-2 whitespace-nowrap"
}, "Get in Touch")));

/* -- Modelling Services View ------------------------------ */
const ModellingView = () => /*#__PURE__*/React.createElement("div", {
  style: {
    padding: '64px 32px'
  }
}, /*#__PURE__*/React.createElement("div", {
  style: {
    marginBottom: 48
  }
}, /*#__PURE__*/React.createElement("div", {
  className: "flex items-center gap-3 mb-3 flex-wrap"
}, /*#__PURE__*/React.createElement("span", {
  className: "text-4xl"
}), /*#__PURE__*/React.createElement("h2", {
  className: "text-4xl font-bold text-white"
}, "Modelling Services"), /*#__PURE__*/React.createElement("span", {
  style: {
    fontSize: 13,
    fontWeight: 700,
    letterSpacing: '0.08em',
    textTransform: 'uppercase',
    background: 'rgba(74,144,217,0.08)',
    color: '#5bc4d8',
    border: '1px solid rgba(74,144,217,0.12)',
    padding: '4px 12px',
    borderRadius: 20
  }
}, "STEM Racing")), /*#__PURE__*/React.createElement("p", {
  className: "text-slate-300 text-lg max-w-2xl leading-relaxed"
}, "Struggling with a component or not sure where to start? ", /*#__PURE__*/React.createElement("strong", null, "Do not worry, we have got you.")), /*#__PURE__*/React.createElement("p", {
  className: "text-slate-400 text-base max-w-2xl leading-relaxed mt-2"
}, "Complimentary modelling support is available to all paying TurboFlow teams: spline edits, CAD prep, curve fitting, and component design help for F1 in Schools and STEM Racing cars.")), /*#__PURE__*/React.createElement("div", {
  className: "grid grid-cols-2 gap-6 mb-10"
}, [{
  t: 'Component Guidance',
  b: 'Not sure how to model your front wing, halo, or diffuser? We walk you through geometry decisions, constraints, and design trade-offs before you even open Fusion 360.'
}, {
  t: 'Spline & Curve Editing',
  b: 'We edit your existing F3D files directly: smoothing splines, refitting transitions between component anchor points, and ensuring curves are solver-ready.'
}, {
  t: 'CAD Prep & Clean-up',
  b: 'STEP files with bad geometry, open shells, or non-manifold edges will cause mesh failures. We prepare and repair your CAD so it imports and meshes correctly.'
}, {
  t: 'Iterative Design Support',
  b: 'Working through multiple design cycles? We can help you set up parametric models in Fusion 360 so changing the angle of attack or chord length takes seconds, not hours.'
}].map(({
  t,
  b
}) => /*#__PURE__*/React.createElement("div", {
  key: t,
  style: {
    borderRadius: 12,
    padding: 24
  }
}, /*#__PURE__*/React.createElement("h3", {
  className: "text-base font-semibold text-white mb-2"
}, t), /*#__PURE__*/React.createElement("p", {
  className: "text-sm text-slate-400 leading-relaxed"
}, b)))), /*#__PURE__*/React.createElement("div", {
  style: {
    borderRadius: 12,
    padding: 24,
    marginBottom: 24
  }
}, /*#__PURE__*/React.createElement("h3", {
  className: "text-base font-semibold text-white mb-5"
}, "What's included: for free"), /*#__PURE__*/React.createElement("div", {
  className: "grid grid-cols-2 gap-3"
}, ['Free for all existing TurboFlow customers', 'Spline & curve editing in Fusion 360', 'Component geometry guidance', 'CAD prep, clean-up & mesh readiness checks', 'F3D export setup for optimal spline fitting', 'Async support via email or Slack'].map(item => /*#__PURE__*/React.createElement("div", {
  key: item,
  className: "flex items-center gap-2.5 text-sm text-slate-300"
}, /*#__PURE__*/React.createElement("svg", {
  width: "12",
  height: "12",
  viewBox: "0 0 24 24",
  fill: "none",
  stroke: "#5de88a",
  strokeWidth: "2.5"
}, /*#__PURE__*/React.createElement("polyline", {
  points: "20 6 9 17 4 12"
})), item)))), /*#__PURE__*/React.createElement("div", {
  className: "flex gap-4"
}, /*#__PURE__*/React.createElement("a", {
  href: "https://www.instagram.com/turboflow.cfd",
  target: "_blank",
  rel: "noopener noreferrer",
  style: {
    textDecoration: 'none'
  },
  className: "btn-primary px-8 py-3 text-base font-semibold flex items-center gap-2"
}, "Request Modelling Help"), /*#__PURE__*/React.createElement("a", {
  href: "https://www.instagram.com/turboflow.cfd",
  target: "_blank",
  rel: "noopener noreferrer",
  style: {
    textDecoration: 'none'
  },
  className: "px-8 py-3 text-base font-semibold border border-slate-700 rounded-lg text-slate-200 hover:bg-slate-900/40 transition-all flex items-center gap-2"
}, "Contact Us")));

/* -- Active Jobs List (Realtime) --------------------------- */
const ActiveJobView = ({
  setView,
  setJob
}) => {
  const [myJobs, setMyJobs] = useState([]);
  const [loading, setLoading] = useState(true);
  const [cancelling, setCancelling] = useState({});
  useEffect(() => {
    const currentUid = auth && auth.currentUser && auth.currentUser.uid || null;
    if (!currentUid) {
      setLoading(false);
      return;
    }
    // No orderBy to avoid needing a composite index: sort client-side
    const q = db.collection('jobs').where('userId', '==', currentUid).limit(20);
    const unsub = q.onSnapshot(snap => {
      const docs = snap.docs.map(d => ({
        id: d.id,
        ...d.data()
      }));
      docs.sort((a, b) => {
        const ta = a.createdAt && a.createdAt.toMillis ? a.createdAt.toMillis() : 0;
        const tb = b.createdAt && b.createdAt.toMillis ? b.createdAt.toMillis() : 0;
        return tb - ta;
      });
      setMyJobs(docs);
      setLoading(false);
    }, err => {
      console.error('Jobs listen failed', err);
      setLoading(false);
    });
    return () => unsub();
  }, []);
  const handleCancel = async job => {
    if (cancelling[job.id]) return;
    const isQueued = ['queued', 'pending', 'downloading', 'uploading_geometry', 'processing', 'creating_simulation', 'meshing'].includes(job.status);
    const pct = isQueued ? '100%' : '0%';
    const refundAmt = isQueued ? job.cost : 0;
    if (!window.confirm(`Cancel this job and refund ${refundAmt} credits (${pct})?`)) return;
    setCancelling(c => ({
      ...c,
      [job.id]: true
    }));
    try {
      const refundJobFn = functions.httpsCallable('refundJob');
      await refundJobFn({
        jobId: job.id
      });
    } catch (e) {
      console.error(e);
      alert('Cancel failed: ' + (e && e.message));
      setCancelling(c => ({
        ...c,
        [job.id]: false
      }));
    }
  };
  const statusColor = s => s === 'queued' ? '#ffc830' : s === 'processing' ? '#7ab3e0' : '#5de88a';
  return /*#__PURE__*/React.createElement("div", {
    style: {
      padding: '64px 32px'
    }
  }, /*#__PURE__*/React.createElement("div", {
    className: "mb-6"
  }, /*#__PURE__*/React.createElement("h2", {
    className: "text-3xl font-bold text-white"
  }, "Active Requests"), /*#__PURE__*/React.createElement("p", {
    className: "text-base text-slate-400"
  }, "Cancel queued or processing jobs to get a full or partial refund.")), loading && /*#__PURE__*/React.createElement("div", {
    className: "text-slate-500"
  }, "Loading..."), /*#__PURE__*/React.createElement("div", {
    className: "space-y-3"
  }, myJobs.map(job => /*#__PURE__*/React.createElement("div", {
    key: job.id,
    className: "bg-slate-900/80 p-4 rounded-lg border border-slate-800 flex justify-between items-center gap-4"
  }, /*#__PURE__*/React.createElement("div", {
    style: {
      flex: 1,
      minWidth: 0
    }
  }, /*#__PURE__*/React.createElement("p", {
    className: "text-base text-white font-semibold truncate"
  }, job.part || job.fileName || 'Simulation'), /*#__PURE__*/React.createElement("p", {
    className: "text-[13px] text-slate-500 truncate"
  }, job.fileName || ''), /*#__PURE__*/React.createElement("div", {
    className: "flex items-center gap-3 mt-1"
  }, /*#__PURE__*/React.createElement("span", {
    style: {
      fontSize: 12,
      fontWeight: 700,
      textTransform: 'uppercase',
      letterSpacing: '0.06em',
      color: statusColor(job.status)
    }
  }, job.status), /*#__PURE__*/React.createElement("span", {
    className: "text-[12px] text-slate-600 font-mono"
  }, job.cost, " credits"))), /*#__PURE__*/React.createElement("div", {
    className: "flex items-center gap-2 flex-shrink-0"
  }, job.status === 'queued' || job.status === 'pending' || job.status === 'processing' ? /*#__PURE__*/React.createElement("button", {
    onClick: () => handleCancel(job),
    disabled: cancelling[job.id],
    className: "text-[13px] bg-red-900/20 text-red-400 border border-red-900/50 px-3 py-1.5 rounded hover:bg-red-900/40",
    style: {
      opacity: cancelling[job.id] ? 0.5 : 1
    }
  }, cancelling[job.id] ? 'Cancelling...' : 'Cancel & Refund') : /*#__PURE__*/React.createElement("span", {
    className: "text-[13px] text-slate-500"
  }, "Completed")))), !loading && myJobs.length === 0 && /*#__PURE__*/React.createElement("p", {
    className: "text-sm text-slate-500 italic"
  }, "No active simulations.")));
};

/* -- Docs View -------------------------------------------- */
/* -- Results View (Mock/demo) ------------------------------ */
const ResultsView = ({
  job,
  setView
}) => {
  const [rows, setRows] = useState([]);
  useEffect(() => {
    if (!job) return setRows([]);
    const vals = [];
    const dataPoints = [0, 2, 4, 6, 8, 10, 12];
    dataPoints.forEach((v, i) => {
      const noise = (Math.sin(v * 1.73) + 1) * 0.006;
      const baseCd = 0.32;
      const cd = +(baseCd + 0.005 * Math.pow(v - 6, 2) / 4 + noise).toFixed(4);
      const cl = +(0.12 + 0.002 * Math.sin(v * 0.9) + noise * 0.5).toFixed(4);
      vals.push({
        variant: i + 1,
        param: v,
        cd,
        cl
      });
    });
    // find best (lowest cd)
    vals.sort((a, b) => a.cd - b.cd);
    const bestCd = vals[0] ? vals[0].cd : null;
    const enhanced = vals.map((r, i) => ({
      ...r,
      improvement: bestCd ? +((bestCd - r.cd) / r.cd * 100).toFixed(2) : 0
    }));
    setRows(enhanced);
  }, [job]);
  const exportCSV = () => {
    if (!rows || rows.length === 0) return alert('No results to export');
    const hdr = ['variant', 'param', 'cd', 'cl', 'pct_improvement'];
    const csv = [hdr.join(',')].concat(rows.map(r => [r.variant, r.param, r.cd, r.cl, r.improvement].join(','))).join('\n');
    const blob = new Blob([csv], {
      type: 'text/csv'
    });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `${job && job.fileName || 'results'}-results.csv`;
    a.click();
    URL.revokeObjectURL(url);
  };
  const renderSparkline = data => {
    if (!data || data.length === 0) return null;
    const w = 220,
      h = 40;
    const max = Math.max(...data.map(d => d.cd));
    const min = Math.min(...data.map(d => d.cd));
    const points = data.map((d, i) => {
      const x = i / (data.length - 1 || 1) * (w - 4) + 2;
      const y = (d.cd - min) / (max - min || 1) * (h - 4);
      return `${x},${h - 2 - y}`;
    }).join(' ');
    return /*#__PURE__*/React.createElement("svg", {
      width: w,
      height: h,
      viewBox: `0 0 ${w} ${h}`
    }, /*#__PURE__*/React.createElement("polyline", {
      fill: "none",
      stroke: "#7ab3e0",
      strokeWidth: "2",
      points: points
    }));
  };
  const best = rows && rows.length ? rows[0] : null;
  return /*#__PURE__*/React.createElement("div", {
    style: {
      padding: '64px 32px'
    }
  }, /*#__PURE__*/React.createElement("div", {
    className: "flex items-center justify-between mb-6"
  }, /*#__PURE__*/React.createElement("div", null, /*#__PURE__*/React.createElement("h2", {
    className: "text-3xl font-bold text-white"
  }, "Parameter Study Results"), /*#__PURE__*/React.createElement("p", {
    className: "text-base text-slate-400"
  }, "Auto-generated parameter sweep analysis for your submission.")), /*#__PURE__*/React.createElement("div", {
    className: "flex items-center gap-3"
  }, /*#__PURE__*/React.createElement("button", {
    onClick: () => setView('dash'),
    className: "px-3 py-2 bg-slate-800 text-slate-200 rounded"
  }, "Back to Jobs"), /*#__PURE__*/React.createElement("button", {
    onClick: exportCSV,
    className: "btn-primary px-3 py-2"
  }, "Export CSV"))), best && /*#__PURE__*/React.createElement("div", {
    className: "card-elegant border border-slate-800 rounded-lg p-5 mb-6 flex items-center justify-between"
  }, /*#__PURE__*/React.createElement("div", null, /*#__PURE__*/React.createElement("div", {
    className: "text-sm text-slate-400"
  }, "Top Configuration"), /*#__PURE__*/React.createElement("div", {
    className: "text-xl font-bold text-white"
  }, "Variant ", best.variant, ": Param: ", best.param), /*#__PURE__*/React.createElement("div", {
    className: "text-base text-slate-400"
  }, "Cd: ", Math.abs(best.cd), " | Cl: ", Math.abs(best.cl), " | Improvement: ", Math.abs(best.improvement), "%")), /*#__PURE__*/React.createElement("div", null, renderSparkline(rows.slice(0, 10)))), /*#__PURE__*/React.createElement("div", {
    className: "card-elegant border border-slate-800 rounded-lg p-4"
  }, /*#__PURE__*/React.createElement("table", {
    style: {
      width: '100%',
      borderCollapse: 'collapse'
    }
  }, /*#__PURE__*/React.createElement("thead", null, /*#__PURE__*/React.createElement("tr", {
    className: "text-sm text-slate-400"
  }, /*#__PURE__*/React.createElement("th", {
    style: {
      textAlign: 'left',
      padding: 10
    }
  }, "Variant"), /*#__PURE__*/React.createElement("th", {
    style: {
      textAlign: 'left',
      padding: 10
    }
  }, "Param"), /*#__PURE__*/React.createElement("th", {
    style: {
      textAlign: 'left',
      padding: 10
    }
  }, "Cd"), /*#__PURE__*/React.createElement("th", {
    style: {
      textAlign: 'left',
      padding: 10
    }
  }, "Cl"), /*#__PURE__*/React.createElement("th", {
    style: {
      textAlign: 'left',
      padding: 10
    }
  }, "Improvement %"))), /*#__PURE__*/React.createElement("tbody", null, rows.map(r => /*#__PURE__*/React.createElement("tr", {
    key: r.variant,
    style: {
      borderTop: '1px solid rgba(160,160,160,0.05)'
    }
  }, /*#__PURE__*/React.createElement("td", {
    style: {
      padding: 10
    },
    className: "text-base text-white"
  }, r.variant), /*#__PURE__*/React.createElement("td", {
    style: {
      padding: 10
    },
    className: "text-base text-slate-300"
  }, r.param), /*#__PURE__*/React.createElement("td", {
    style: {
      padding: 10
    },
    className: "text-base font-mono text-white"
  }, Math.abs(r.cd)), /*#__PURE__*/React.createElement("td", {
    style: {
      padding: 10
    },
    className: "text-base font-mono text-slate-300"
  }, Math.abs(r.cl)), /*#__PURE__*/React.createElement("td", {
    style: {
      padding: 10
    },
    className: `text-base ${r.variant === best.variant ? 'text-green-400' : 'text-slate-400'}`
  }, r.improvement)))))));
};
const DocsView = () => /*#__PURE__*/React.createElement("div", {
  style: {
    padding: '40px 32px 0px 32px'
  }
}, /*#__PURE__*/React.createElement("div", {
  style: {
    marginBottom: 16
  }
}, /*#__PURE__*/React.createElement("h2", {
  className: "text-4xl font-bold text-white mb-3"
}, "Setting Up Your First Simulation"), /*#__PURE__*/React.createElement("p", {
  className: "text-slate-400 max-w-2xl leading-relaxed text-lg"
}, "Get started with TurboFlow in minutes. Download the Fusion 360 script and follow our integration guide.")), /*#__PURE__*/React.createElement("div", {
  style: {
    marginBottom: 24,
    background: 'linear-gradient(135deg, rgba(74,144,217,0.15) 0%, rgba(74,144,217,0.08) 100%)',
    border: '1px solid rgba(74,144,217,0.25)',
    borderRadius: 12,
    padding: '20px 24px'
  }
}, /*#__PURE__*/React.createElement("div", {
  style: {
    marginBottom: 16
  }
}, /*#__PURE__*/React.createElement("div", {
  style: {
    display: 'flex',
    alignItems: 'center',
    gap: 8,
    marginBottom: 10
  }
}, /*#__PURE__*/React.createElement("div", {
  style: {
    width: 28,
    height: 28,
    borderRadius: '50%',
    background: '#4a90d9',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    color: '#fff',
    fontWeight: 800,
    fontSize: 14
  }
}, "1"), /*#__PURE__*/React.createElement("h3", {
  className: "text-lg font-bold text-white"
}, "Download the Script")), /*#__PURE__*/React.createElement("p", {
  className: "text-slate-300 text-sm leading-relaxed"
}, "Get the TurboFlow Fusion 360 add-in. This is your direct connection to running CFD simulations. Once installed, you'll have access to all your simulations right from Fusion 360.")), /*#__PURE__*/React.createElement("a", {
  href: "https://firebasestorage.googleapis.com/v0/b/turboflow-7b3ca.firebasestorage.app/o/TurboFlow_CFD.zip?alt=media&token=d0136f9e-c1f8-40e4-8327-4b700c2e5ce6",
  target: "_blank",
  rel: "noopener noreferrer",
  style: {
    display: 'inline-flex',
    alignItems: 'center',
    gap: 8,
    background: 'linear-gradient(135deg, #4488cc 0%, #3377bb 100%)',
    color: '#fff',
    fontWeight: 700,
    fontSize: 14,
    padding: '12px 24px',
    borderRadius: 10,
    textDecoration: 'none',
    transition: 'all 0.3s',
    border: '1px solid rgba(74,144,217,0.16)',
    cursor: 'pointer',
    boxShadow: '0 4px 12px rgba(74,144,217,0.12)'
  },
  onMouseOver: e => {
    e.currentTarget.style.background = 'linear-gradient(135deg, #3a7bc8 0%, #2d6bb0 100%)';
    e.currentTarget.style.transform = 'translateY(-1px)';
    e.currentTarget.style.boxShadow = '0 6px 16px rgba(74,144,217,0.16)';
  },
  onMouseOut: e => {
    e.currentTarget.style.background = 'linear-gradient(135deg, #4488cc 0%, #3377bb 100%)';
    e.currentTarget.style.transform = 'translateY(0)';
    e.currentTarget.style.boxShadow = '0 4px 12px rgba(74,144,217,0.12)';
  }
}, "Download Script ZIP")), /*#__PURE__*/React.createElement("div", {
  style: {
    marginBottom: 24,
    background: 'linear-gradient(135deg, rgba(74,144,217,0.15) 0%, rgba(74,144,217,0.08) 100%)',
    border: '1px solid rgba(74,144,217,0.25)',
    borderRadius: 12,
    padding: '20px 24px'
  }
}, /*#__PURE__*/React.createElement("div", {
  style: {
    marginBottom: 16
  }
}, /*#__PURE__*/React.createElement("div", {
  style: {
    display: 'flex',
    alignItems: 'center',
    gap: 8,
    marginBottom: 10
  }
}, /*#__PURE__*/React.createElement("div", {
  style: {
    width: 28,
    height: 28,
    borderRadius: '50%',
    background: '#4a90d9',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    color: '#fff',
    fontWeight: 800,
    fontSize: 14
  }
}, "2"), /*#__PURE__*/React.createElement("h3", {
  className: "text-lg font-bold text-white"
}, "Integrate into Fusion 360")), /*#__PURE__*/React.createElement("p", {
  className: "text-slate-300 text-sm leading-relaxed"
}, "Follow our step-by-step tutorial to install the script into Fusion 360 and start running simulations. It takes less than 5 minutes to get set up and ready to go.")), /*#__PURE__*/React.createElement("a", {
  href: "https://youtu.be/hKHx4sC5Mw4",
  target: "_blank",
  rel: "noopener noreferrer",
  style: {
    display: 'inline-flex',
    alignItems: 'center',
    gap: 8,
    background: 'linear-gradient(135deg, #4488cc 0%, #3377bb 100%)',
    color: '#fff',
    fontWeight: 700,
    fontSize: 14,
    padding: '12px 24px',
    borderRadius: 10,
    textDecoration: 'none',
    transition: 'all 0.3s',
    border: '1px solid rgba(74,144,217,0.16)',
    cursor: 'pointer',
    boxShadow: '0 4px 12px rgba(74,144,217,0.12)'
  },
  onMouseOver: e => {
    e.currentTarget.style.background = 'linear-gradient(135deg, #3a7bc8 0%, #2d6bb0 100%)';
    e.currentTarget.style.transform = 'translateY(-1px)';
    e.currentTarget.style.boxShadow = '0 6px 16px rgba(74,144,217,0.16)';
  },
  onMouseOut: e => {
    e.currentTarget.style.background = 'linear-gradient(135deg, #4488cc 0%, #3377bb 100%)';
    e.currentTarget.style.transform = 'translateY(0)';
    e.currentTarget.style.boxShadow = '0 4px 12px rgba(74,144,217,0.12)';
  }
}, "View Integration Guide")), /*#__PURE__*/React.createElement("div", {
  style: {
    marginTop: 16,
    marginBottom: 0
  }
}, /*#__PURE__*/React.createElement("h3", {
  className: "text-2xl font-bold text-white mb-1"
}, "How It Works"), /*#__PURE__*/React.createElement("div", {
  className: "space-y-2"
}, [{
  n: '01',
  c: '#4a90d9',
  t: 'Upload Your Geometry',
  b: 'Submit your CAD file via the Fusion plugin. That is the only thing you need to provide. (Unless you are using iterative designing, in which case you will also need to describe the part that needs to be optimized.)'
}, {
  n: '02',
  c: '#5bc4d8',
  t: 'Automatic Preprocessing',
  b: 'Our pipeline ingests your geometry, repairs surface defects, generates a CFD-ready mesh, and configures boundary conditions: inlet velocity, outlet pressure, wall treatment, symmetry planes and wheel rotation: without any manual input from you.'
}, {
  n: '03',
  c: '#7ab3e0',
  t: 'Parametric Design Sweep',
  b: 'The solver runs your geometry across a defined design space: varying curvature parameters, chord ratios, camber angles, and surface features. Each variant is a separate CFD run. Typical sweeps cover 5-20 configurations.'
}, {
  n: '04',
  c: '#3dd490',
  t: 'CFD Solver Execution',
  b: 'Each configuration runs through our RANS solver (k-omega SST turbulence model) to convergence. We compute drag coefficient, lift coefficient and pressure distribution for every variant.'
}, {
  n: '05',
  c: '#ffc830',
  t: 'Results Ranked & Surfaced',
  b: 'All variants are ranked by aerodynamic efficiency. You get a full results table with Cd, Cl, and ParaView visualization files: plus the best-performing geometry highlighted and ready to download.'
}, {
  n: '06',
  c: '#ff8585',
  t: 'Iterate',
  b: 'Run again with a tighter design space around your best result, or try a completely different direction. Credits are only deducted per run, so iterating is cheap and fast.'
}].map(({
  n,
  c,
  t,
  b
}, i) => /*#__PURE__*/React.createElement("div", {
  key: n,
  style: {
    display: 'flex',
    gap: 12,
    alignItems: 'flex-start',
    padding: '14px 16px',
    background: 'rgba(30,30,30,0.75)',
    border: '1px solid rgba(46,46,46,0.5)',
    borderRadius: 10
  }
}, /*#__PURE__*/React.createElement("div", {
  style: {
    width: 32,
    height: 32,
    borderRadius: '50%',
    background: `${c}18`,
    border: `1.5px solid ${c}40`,
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    flexShrink: 0
  }
}, /*#__PURE__*/React.createElement("span", {
  style: {
    fontFamily: 'monospace',
    fontWeight: 800,
    fontSize: 11,
    color: c
  }
}, n)), /*#__PURE__*/React.createElement("div", {
  style: {
    flex: 1
  }
}, /*#__PURE__*/React.createElement("p", {
  style: {
    fontWeight: 700,
    color: '#f0f0f0',
    marginBottom: 4,
    fontSize: 13
  }
}, t), /*#__PURE__*/React.createElement("p", {
  style: {
    color: '#aaaaaa',
    fontSize: 12,
    lineHeight: 1.6
  }
}, b)))))));

/* -- Terms of Service ------------------------------------ */
const TermsView = () => /*#__PURE__*/React.createElement("div", {
  style: {
    padding: '64px 32px'
  }
}, /*#__PURE__*/React.createElement("div", {
  style: {
    marginBottom: 40
  }
}, /*#__PURE__*/React.createElement("h2", {
  className: "text-4xl font-bold text-white mb-2"
}, "Terms of Service"), /*#__PURE__*/React.createElement("p", {
  className: "text-slate-500 text-sm"
}, "Last updated: February 2026")), [{
  t: '1. Acceptance of Terms',
  b: 'By accessing or using TurboFlow ("the Service"), you agree to be bound by these Terms of Service. If you do not agree to these terms, do not use the Service. We reserve the right to update these terms at any time. Continued use of the Service after changes constitutes acceptance.'
}, {
  t: '2. Description of Service',
  b: 'TurboFlow provides cloud-based CFD (Computational Fluid Dynamics) simulation services. Users upload geometry files which are processed by our pipeline. Results are returned digitally. We do not guarantee any specific aerodynamic outcome or performance improvement from simulations.'
}, {
  t: '3. Account Responsibilities',
  b: 'You are responsible for maintaining the security of your account credentials. You must provide accurate information when registering. Accounts may not be shared between individuals. You are responsible for all activity that occurs under your account.'
}, {
  t: '4. Credits and Payment',
  b: 'Credits are purchased via PayPal and are non-transferable between accounts. Credits have no cash value and cannot be redeemed for money. Unused credits do not expire. Credits are added automatically to the signed-in account once the payment is captured. See our Refund Policy for simulation refund terms.'
}, {
  t: '5. Acceptable Use',
  b: 'You may not use the Service to process files you do not own or have rights to. You may not attempt to reverse-engineer, abuse, or overload our simulation infrastructure. Automated or bulk submission without prior approval is prohibited. We reserve the right to suspend accounts that violate these terms without notice. Sharing your account with any other teams is prohibited and will result in the termination of your account.'
}, {
  t: '6. Intellectual Property',
  b: 'You retain ownership of all geometry files you upload. TurboFlow retains ownership of its simulation pipeline, software, and infrastructure. Anonymised aggregate results may be used by TurboFlow for research and case study purposes unless you opt out in writing.'
}, {
  t: '7. Limitation of Liability',
  b: 'TurboFlow is provided on an "as is" basis. We make no warranties about simulation accuracy, uptime, or fitness for any particular purpose. To the maximum extent permitted by law, TurboFlow is not liable for any indirect, incidental, or consequential damages arising from use of the Service.'
}, {
  t: '8. Termination',
  b: 'We may suspend or terminate your account at our discretion for violation of these terms. You may delete your account at any time. Upon termination, unused credits are forfeited.'
}, {
  t: '9. Use of other Services',
  b: 'Modelling services, Race Time calculator use and other mentorship services are only provided to customers who have spent more than 50$ (or equivalent local currency) on TurboFlow credits.'
}, {
  t: '10. Governing Law',
  b: 'These terms are governed by and construed in accordance with the laws of the United Arab Emirates.'
}, {
  t: '11. Contact',
  b: 'For questions about these terms, contact us via our Instagram page or through the contact form linked in the Sponsorship section.'
}].map(({
  t,
  b
}) => /*#__PURE__*/React.createElement("div", {
  key: t,
  style: {
    marginBottom: 28,
    paddingBottom: 28,
    borderBottom: '1px solid rgba(46,46,46,0.5)'
  }
}, /*#__PURE__*/React.createElement("h3", {
  className: "text-base font-semibold text-white mb-2"
}, t), /*#__PURE__*/React.createElement("p", {
  className: "text-sm text-slate-400 leading-relaxed"
}, b))));

/* -- Refund Policy ---------------------------------------- */
const RefundPolicyView = () => /*#__PURE__*/React.createElement("div", {
  style: {
    padding: '64px 32px'
  }
}, /*#__PURE__*/React.createElement("div", {
  style: {
    marginBottom: 40
  }
}, /*#__PURE__*/React.createElement("h2", {
  className: "text-4xl font-bold text-white mb-2"
}, "Refund Policy"), /*#__PURE__*/React.createElement("p", {
  className: "text-slate-500 text-sm"
}, "Last updated: February 2026")), [{
  t: 'Simulation Refunds',
  rows: [{
    s: 'Pending',
    r: '100% of credits refunded',
    c: '#5de88a'
  }, {
    s: 'Uploading Geometry or Meshing',
    r: '100% of credits refunded',
    c: '#5de88a'
  }, {
    s: 'Running or Completed',
    r: 'No refund available',
    c: '#ff8585'
  }]
}].map(({
  t,
  rows
}) => /*#__PURE__*/React.createElement("div", {
  key: t,
  style: {
    marginBottom: 32
  }
}, /*#__PURE__*/React.createElement("h3", {
  className: "text-base font-semibold text-white mb-4"
}, t), /*#__PURE__*/React.createElement("div", {
  style: {
    borderRadius: 10,
    overflow: 'hidden',
    border: '1px solid rgba(46,46,46,0.5)'
  }
}, rows.map(({
  s,
  r,
  c
}, i) => /*#__PURE__*/React.createElement("div", {
  key: s,
  style: {
    display: 'flex',
    justifyContent: 'space-between',
    alignItems: 'center',
    padding: '14px 20px',
    background: i % 2 === 0 ? 'rgba(30,30,30,0.75)' : 'rgba(30,30,30,0.50)',
    borderTop: i > 0 ? '1px solid rgba(46,46,46,0.5)' : 'none'
  }
}, /*#__PURE__*/React.createElement("span", {
  className: "text-sm font-semibold text-white"
}, s), /*#__PURE__*/React.createElement("span", {
  style: {
    fontSize: 13,
    fontWeight: 700,
    color: c
  }
}, r)))))), [{
  t: 'How to Request a Refund',
  b: 'Cancel your job directly from the Active Jobs or Order Tracker section of the dashboard before it completes. Refunds are processed instantly and credits are returned to your account automatically. There is no need to contact us for standard simulation refunds.'
}, {
  t: 'Credit Purchase Refunds',
  b: 'Credit purchases made via PayPal are refundable. If your credits were not delivered after a successful payment, contact us with your PayPal receipt and we will resolve it manually. You can get a refund of unused credits within 7 Days of purchase. Moreover, you can also dispute charges through PayPal.'
}, {
  t: 'Exceptional Circumstances',
  b: 'If a simulation fails due to a technical error on our end (not caused by your file), we will refund the full credits at our discretion. Contact us with your job ID and a description of the issue. We review all such requests within 48 hours.'
}, {
  t: 'Sponsored and Discounted Accounts',
  b: 'Refund terms for sponsored accounts are the same as standard accounts. The refund amount is calculated based on the credits charged, not the monetary equivalent.'
}].map(({
  t,
  b
}) => /*#__PURE__*/React.createElement("div", {
  key: t,
  style: {
    marginBottom: 28,
    paddingBottom: 28,
    borderBottom: '1px solid rgba(46,46,46,0.5)'
  }
}, /*#__PURE__*/React.createElement("h3", {
  className: "text-base font-semibold text-white mb-2"
}, t), /*#__PURE__*/React.createElement("p", {
  className: "text-sm text-slate-400 leading-relaxed"
}, b))));

/* -- Sponsorship Policy ----------------------------------- */
const SponsorshipPolicyView = () => /*#__PURE__*/React.createElement("div", {
  style: {
    padding: '64px 32px'
  }
}, /*#__PURE__*/React.createElement("div", {
  style: {
    marginBottom: 40
  }
}, /*#__PURE__*/React.createElement("h2", {
  className: "text-4xl font-bold text-white mb-2"
}, "Sponsorship Policy"), /*#__PURE__*/React.createElement("p", {
  className: "text-slate-500 text-sm"
}, "Last updated: February 2026")), [{
  t: '1. Eligibility',
  b: 'Sponsorship is open to active student racing and STEM competition teams registered for an upcoming competitive event. At least one team member must hold a valid university or school email address. Applications are reviewed on a case-by-case basis and acceptance is at TurboFlow sole discretion.'
}, {
  t: '2. Discount Structure',
  b: 'Accepted teams are granted a discounted simulation rate. The discount tier (up to 60%, 70%, or 80% off standard credit costs) is determined at the time of acceptance based on team size, competition level, marketing, and usage estimate. The discount rate is locked for the duration of the agreed sponsorship period and applied automatically to every simulation you run.'
}, {
  t: '3. Sponsored Store Access',
  b: 'Discounted store links are provided directly to the team contact on acceptance. These links must not be shared publicly or with individuals outside the team. TurboFlow reserves the right to revoke store access if links are found to be shared outside the approved team.'
}, {
  t: '4. Obligations',
  b: 'Sponsored teams are not required to display TurboFlow branding on cars or pit displays unless separately mentioned in the google forms link or through any medium of communication. Sponsored teams MUST put the turboflow logo on their official team uniform and any other merchandise. The team shall give TurboFlow the right to use their team name and logo(s) for promotional material. Teams may optionally share anonymised simulation results for our case study library: this is never mandatory. We may ask for a short testimonial or project update at the end of your competition season.'
}, {
  t: '5. Duration and Renewal',
  b: 'Sponsorship is granted for one competition season by default. Renewal is not automatic. Teams wishing to continue must reapply before their discount expires.'
}, {
  t: '6. Termination',
  b: 'TurboFlow may revoke sponsorship status and discount access if: store links are shared externally, the team is found to be inactive or no longer competing, or the team is found to have provided false information in their application. No credit refunds are issued upon revocation.'
}, {
  t: '7. No Exclusivity',
  b: 'TurboFlow sponsorship programme does not grant any exclusivity. We sponsor multiple teams across the same competition series and do not restrict teams from using other simulation providers.'
}, {
  t: '8. Amendments',
  b: 'TurboFlow reserves the right to amend the sponsorship terms at any time. Teams will be notified of material changes via the contact email provided in their application. Continued use of discounted access after notification constitutes acceptance of updated terms.'
}].map(({
  t,
  b
}) => /*#__PURE__*/React.createElement("div", {
  key: t,
  style: {
    marginBottom: 28,
    paddingBottom: 28,
    borderBottom: '1px solid rgba(46,46,46,0.5)'
  }
}, /*#__PURE__*/React.createElement("h3", {
  className: "text-base font-semibold text-white mb-2"
}, t), /*#__PURE__*/React.createElement("p", {
  className: "text-sm text-slate-400 leading-relaxed"
}, b))));

/* -- Billing View ----------------------------------------- */
/**
 * BillingView  self-serve credit purchases via PayPal.
 * Pricing (rate, currency, credit bounds, PayPal client id) is read
 * live from Firestore config/pricing so the backend can change it
 * without a redeploy. The USD amount and the credits granted are
 * re-validated server-side in the createPayPalOrder/capturePayPalOrder
 * Cloud Functions  the client only proposes a credit count.
 */
const BILLING_DEFAULTS = {
  usdPer100Credits: 5,       // "$5 per 100 credits" = $0.05 / credit (normal rate)
  currency: 'USD',
  minCredits: 100,
  maxCredits: 10000,
  step: 50,
  unlimitedMonthlyUSD: 100,  // default $/month for the unlimited pass
  unlimitedDays: 30,
  maxUnlimitedMonths: 24,
  paypalClientId: ''
};

const BillingView = ({
  user,
  credits,
  isSignedIn,
  onRequireAuth
}) => {
  const h = React.createElement;

  const [cfg, setCfg] = useState(BILLING_DEFAULTS);
  const [amountCredits, setAmountCredits] = useState(500);
  const [status, setStatus] = useState(null); // { type: 'processing'|'success'|'error', msg }
  const [sdkReady, setSdkReady] = useState(false);
  const [unlimitedUntil, setUnlimitedUntil] = useState(0); // ms epoch, 0 = none
  const [unlimitedStartedAt, setUnlimitedStartedAt] = useState(0); // ms epoch when current pass began
  const [userRate, setUserRate] = useState(0); // per-user USD/credit override; 0 = use global
  const [userUnlimitedUsd, setUserUnlimitedUsd] = useState(0); // per-user $/month override; 0 = use global
  const [months, setMonths] = useState(1);
  const [showCreditPay, setShowCreditPay] = useState(false);
  const [showUnlimitedPay, setShowUnlimitedPay] = useState(false);

  const paypalContainerRef = useRef(null);
  const unlimitedContainerRef = useRef(null);
  const buttonsRef = useRef([]);
  const amountRef = useRef(amountCredits);
  amountRef.current = amountCredits;
  const monthsRef = useRef(months);
  monthsRef.current = months;

  // 1. Live pricing config from Firestore (backend-configurable)
  useEffect(() => {
    const ref = db.collection('config').doc('pricing');
    const unsub = ref.onSnapshot(snap => {
      const d = snap.exists && snap.data() || {};
      setCfg({
        usdPer100Credits: Number(d.usdPer100Credits) > 0 ? Number(d.usdPer100Credits) : BILLING_DEFAULTS.usdPer100Credits,
        currency: typeof d.currency === 'string' && d.currency ? d.currency : BILLING_DEFAULTS.currency,
        minCredits: Number(d.minCredits) > 0 ? Math.floor(Number(d.minCredits)) : BILLING_DEFAULTS.minCredits,
        maxCredits: Number(d.maxCredits) > 0 ? Math.floor(Number(d.maxCredits)) : BILLING_DEFAULTS.maxCredits,
        step: Number(d.step) > 0 ? Math.floor(Number(d.step)) : BILLING_DEFAULTS.step,
        unlimitedMonthlyUSD: Number(d.unlimitedMonthlyUSD) > 0 ? Number(d.unlimitedMonthlyUSD) : BILLING_DEFAULTS.unlimitedMonthlyUSD,
        unlimitedDays: Number(d.unlimitedDays) > 0 ? Math.floor(Number(d.unlimitedDays)) : BILLING_DEFAULTS.unlimitedDays,
        maxUnlimitedMonths: Number(d.maxUnlimitedMonths) > 0 ? Math.floor(Number(d.maxUnlimitedMonths)) : BILLING_DEFAULTS.maxUnlimitedMonths,
        paypalClientId: typeof d.paypalClientId === 'string' && d.paypalClientId
          ? d.paypalClientId
          : (window.PAYPAL_CLIENT_ID || '')
      });
    }, err => {
      console.warn('Pricing config load failed, using defaults:', err && err.message);
      setCfg(c => ({ ...c, paypalClientId: c.paypalClientId || window.PAYPAL_CLIENT_ID || '' }));
    });
    return () => unsub();
  }, []);

  // 1b. Live "unlimited pass" status from the user doc.
  useEffect(() => {
    if (!isSignedIn || !user || !user.uid) { setUnlimitedUntil(0); setUnlimitedStartedAt(0); setUserRate(0); setUserUnlimitedUsd(0); return; }
    const unsub = db.collection('users').doc(user.uid).onSnapshot(snap => {
      const u = snap.exists && snap.data() || {};
      const until = u.unlimitedUntil;
      const ms = until && typeof until.toMillis === 'function' ? until.toMillis()
        : (until && until.seconds ? until.seconds * 1000 : 0);
      setUnlimitedUntil(ms || 0);
      var startedRaw = u.unlimitedStartedAt;
      var startedMs = startedRaw && typeof startedRaw.toMillis === 'function' ? startedRaw.toMillis() : (startedRaw && startedRaw.seconds ? startedRaw.seconds * 1000 : 0);
      setUnlimitedStartedAt(startedMs || 0);
      setUserRate(Number(u.usdPerCredit) > 0 ? Number(u.usdPerCredit) : 0);
      setUserUnlimitedUsd(Number(u.unlimitedUsd) > 0 ? Number(u.unlimitedUsd) : 0);
    }, () => {});
    return () => unsub();
  }, [isSignedIn, user && user.uid]);

  // Keep the chosen amount within the configured bounds / step.
  useEffect(() => {
    setAmountCredits(c => clampCredits(c, cfg));
  }, [cfg.minCredits, cfg.maxCredits, cfg.step]);

  function clampCredits(v, c) {
    let n = Math.round((Number(v) || 0) / c.step) * c.step;
    if (!isFinite(n)) n = c.minCredits;
    return Math.min(c.maxCredits, Math.max(c.minCredits, n));
  }

  const rate = userRate > 0 ? userRate : cfg.usdPer100Credits / 100;      // USD per credit (per-user override wins)
  const priceUSD = amountCredits * rate;
  const priceStr = priceUSD.toFixed(2);
  const unlimitedPerMonth = userUnlimitedUsd > 0 ? userUnlimitedUsd : cfg.unlimitedMonthlyUSD;
  const unlimitedMonths = Math.max(1, Number(months) || 1);
  const unlimitedTotalStr = (unlimitedMonths * unlimitedPerMonth).toFixed(2);
  const clientId = cfg.paypalClientId;

  // 2. Load the PayPal SDK once the client id is known.
  useEffect(() => {
    if (!clientId) return;
    if (window.paypal) { setSdkReady(true); return; }
    const existing = document.getElementById('paypal-sdk');
    if (existing) {
      existing.addEventListener('load', () => setSdkReady(true));
      return;
    }
    const s = document.createElement('script');
    s.id = 'paypal-sdk';
    s.src = 'https://www.paypal.com/sdk/js?client-id=' + encodeURIComponent(clientId) +
            '&currency=' + encodeURIComponent(cfg.currency) + '&intent=capture';
    s.onload = () => setSdkReady(true);
    s.onerror = () => setStatus({ type: 'error', msg: 'Could not load PayPal. Check the client ID or your connection.' });
    document.body.appendChild(s);
  }, [clientId, cfg.currency]);

  // 3. Render the PayPal Smart Buttons (once) when ready + signed in.
  //    One set for the credit top-up, one for the unlimited pass.
  useEffect(() => {
    if (!sdkReady || !window.paypal || !isSignedIn) return;

    const createOrderFn = functions.httpsCallable('createPayPalOrder');
    const captureFn = functions.httpsCallable('capturePayPalOrder');

    const makeButtons = (product, container) => {
      if (!container) return null;
      container.innerHTML = '';
      const btns = window.paypal.Buttons({
        style: { layout: 'vertical', color: product === 'unlimited' ? 'gold' : 'blue', shape: 'rect', label: 'paypal' },
        createOrder: async () => {
          setStatus({ type: 'processing', msg: 'Creating your order' });
          const payload = product === 'unlimited' ? { product: 'unlimited', months: monthsRef.current } : { credits: amountRef.current };
          const res = await createOrderFn(payload);
          return res.data.orderID;
        },
        onApprove: async data => {
          setStatus({ type: 'processing', msg: 'Confirming your payment' });
          try {
            const res = await captureFn({ orderID: data.orderID });
            if ((res.data && res.data.product) === 'unlimited') {
              setStatus({ type: 'success', msg: 'Unlimited pass active! All simulations are free while it lasts.' });
            } else {
              const n = res.data && res.data.credits || amountRef.current;
              setStatus({ type: 'success', msg: 'Payment complete! ' + n.toLocaleString() + ' credits added to your account.' });
            }
          } catch (e) {
            setStatus({ type: 'error', msg: 'Payment went through but applying it failed. Contact support with your PayPal receipt. ' + (e && e.message ? e.message : '') });
          }
        },
        onCancel: () => setStatus({ type: 'error', msg: 'Payment cancelled  no charge was made.' }),
        onError: err => {
          console.error('PayPal error', err);
          setStatus({ type: 'error', msg: 'PayPal error: ' + (err && err.message ? err.message : 'unknown') });
        }
      });
      try { btns.render(container); } catch (e) { console.error('Failed to render PayPal buttons', e); }
      return btns;
    };

    buttonsRef.current = [
      makeButtons('credits', paypalContainerRef.current),
      makeButtons('unlimited', unlimitedContainerRef.current)
    ];

    return () => {
      (buttonsRef.current || []).forEach(b => {
        try { if (b && b.close) b.close(); } catch (e) {}
      });
    };
  }, [sdkReady, isSignedIn, showCreditPay, showUnlimitedPay]);

  const setCreditsRaw = v => {
    const n = parseInt((v + '').replace(/[^\d]/g, ''), 10);
    setAmountCredits(isNaN(n) ? '' : n);
  };

  const statusColors = {
    processing: { bg: 'rgba(74,144,217,0.08)', border: 'rgba(74,144,217,0.25)', color: '#7acfdd' },
    success: { bg: 'rgba(40,212,102,0.08)', border: 'rgba(40,212,102,0.3)', color: '#5de88a' },
    error: { bg: 'rgba(220,80,80,0.08)', border: 'rgba(220,80,80,0.3)', color: '#f08a8a' }
  };

  const unlimitedActive = unlimitedUntil > Date.now();
  const unlimitedUntilStr = unlimitedActive
    ? new Date(unlimitedUntil).toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' })
    : '';
  const unlimitedDaysLeft = unlimitedActive ? Math.ceil((unlimitedUntil - Date.now()) / 86400000) : 0;
  const unlimitedTotalDays = unlimitedActive
    ? Math.max(unlimitedDaysLeft, unlimitedStartedAt > 0 ? Math.round((unlimitedUntil - unlimitedStartedAt) / 86400000) : unlimitedDaysLeft)
    : 0;
  const unlimitedPct = (unlimitedActive && unlimitedTotalDays > 0)
    ? Math.max(0, Math.min(100, Math.round(unlimitedDaysLeft / unlimitedTotalDays * 100)))
    : 0;

  return h('div', {
    style: { padding: '32px', display: 'flex', flexDirection: 'column', gap: 16, minHeight: '100%', boxSizing: 'border-box' }
  },
    h('h2', { className: 'text-4xl font-bold text-white' }, 'Purchase Credits'),

    // Current balance + transactions
    isSignedIn && h('div', { className: 'card-elegant border border-slate-800 rounded-lg p-5' },
      h('div', { className: 'flex items-center justify-between flex-wrap gap-4 mb-2' },
        h('div', null,
          h('p', { className: 'text-sm font-semibold text-slate-400 mb-1' }, 'Current Balance'),
          h('div', { className: 'flex items-baseline gap-2 flex-wrap' },
            h('span', { className: 'text-4xl font-mono font-bold text-white' }, credits.toLocaleString()),
            h('span', { className: 'text-base text-slate-400' }, 'Credits'))),
        h('div', { className: 'text-right text-sm text-slate-500' },
          h('p', null, '100 credits = 1 simulation variant'),
          h('p', { className: 'mt-0.5' }, Math.floor(credits / 100), ' variants remaining'))),
      h(TransactionsList, { user: user })),

    // Active unlimited-pass banner with days-left counter + progress bar
    isSignedIn && unlimitedActive && h('div', {
      style: {
        background: 'linear-gradient(135deg, rgba(255,200,48,0.10), rgba(74,144,217,0.08))',
        border: '1px solid rgba(255,200,48,0.35)', borderRadius: 12, padding: '16px 18px',
        display: 'flex', flexDirection: 'column', gap: 12
      }
    },
      h('div', { style: { display: 'flex', alignItems: 'center', justifyContent: 'space-between', flexWrap: 'wrap', gap: 8 } },
        h('div', null,
          h('p', { className: 'text-base font-bold', style: { color: '#ffc830' } }, ' Unlimited pass active'),
          h('p', { className: 'text-sm text-slate-300 mt-0.5' }, 'All simulations run free until ' + unlimitedUntilStr + '.')),
        h('span', { className: 'text-2xl font-mono font-bold', style: { color: '#ffc830' } }, unlimitedDaysLeft + (unlimitedDaysLeft === 1 ? ' day left' : ' days left'))),
      h('div', null,
        h('div', { style: { height: 10, borderRadius: 6, background: 'rgba(255,255,255,0.08)', overflow: 'hidden' } },
          h('div', { style: { height: '100%', width: unlimitedPct + '%', borderRadius: 6, background: 'linear-gradient(90deg, #ffc830, #4a90d9)', transition: 'width 0.4s ease' } })),
        h('div', { className: 'flex justify-between text-xs text-slate-400 font-mono mt-1.5' },
          h('span', null, unlimitedDaysLeft + ' of ' + unlimitedTotalDays + ' days left'),
          h('span', null, unlimitedPct + '%')))),

    // Buy credits card
    h('div', { style: { background: 'rgba(74,144,217,0.06)', border: '1px solid rgba(74,144,217,0.12)', borderRadius: 14, padding: 24 } },
      h('div', { className: 'flex items-center justify-between flex-wrap gap-3 mb-1' },
        h('h3', { className: 'text-base font-bold text-white' }, 'Buy credits with PayPal'),
        h('span', { className: 'text-sm font-mono', style: { color: '#7acfdd' } },
          '$' + (rate * 100).toFixed(2) + ' per 100 credits')),
      h('p', { className: 'text-sm text-slate-400 mb-5' },
        'Choose how many credits you want. Pay securely with PayPal or any card  credits are added to your account automatically once the payment clears.'),

      // Amount selector: number input + slider
      h('div', { style: { display: 'flex', flexDirection: 'column', gap: 14, marginBottom: 18 } },
        h('div', { className: 'flex items-end justify-between flex-wrap gap-4' },
          h('div', { style: { flex: '1 1 200px' } },
            h('label', { className: 'text-sm font-semibold text-slate-400 block mb-1.5' }, 'Number of credits'),
            h('div', { className: 'number-control', style: { maxWidth: 220 } },
              h('input', {
                type: 'number',
                className: 'input-field number-stepper w-full px-4 py-2.5 rounded-lg text-base font-mono',
                min: cfg.minCredits, max: cfg.maxCredits, step: cfg.step,
                value: amountCredits,
                onChange: e => setCreditsRaw(e.target.value),
                onBlur: () => setAmountCredits(c => clampCredits(c, cfg))
              }),
              h('div', { className: 'num-btns' },
                h('button', { type: 'button', onClick: () => setAmountCredits(c => clampCredits((Number(c) || 0) + cfg.step, cfg)) }, '+'),
                h('button', { type: 'button', onClick: () => setAmountCredits(c => clampCredits((Number(c) || 0) - cfg.step, cfg)) }, '')))),
          h('div', { className: 'text-right' },
            h('p', { className: 'text-sm font-semibold text-slate-400 mb-0.5' }, 'You pay'),
            h('p', { className: 'text-4xl font-mono font-bold text-white' }, '$' + priceStr),
            h('p', { className: 'text-xs text-slate-500 mt-0.5' }, (Number(amountCredits) || 0).toLocaleString() + ' credits  ' + cfg.currency))),
        h('input', {
          type: 'range',
          min: cfg.minCredits, max: cfg.maxCredits, step: cfg.step,
          value: clampCredits(amountCredits, cfg),
          onChange: e => setAmountCredits(parseInt(e.target.value, 10)),
          style: { width: '100%', accentColor: '#4a90d9', cursor: 'pointer' }
        }),
        h('div', { className: 'flex justify-between text-xs text-slate-500 font-mono' },
          h('span', null, cfg.minCredits.toLocaleString()),
          h('span', null, cfg.maxCredits.toLocaleString()))),

      // Status message
      status && h('div', {
        style: {
          background: statusColors[status.type].bg,
          border: '1px solid ' + statusColors[status.type].border,
          color: statusColors[status.type].color,
          borderRadius: 8, padding: '10px 14px', marginBottom: 14, fontSize: 14
        }
      }, status.msg),

      // Checkout area
      !isSignedIn
        ? h('button', {
            className: 'btn-primary w-full py-3 text-base font-semibold',
            onClick: () => onRequireAuth && onRequireAuth('Sign in to buy credits.')
          }, 'Sign in to buy credits')
        : !clientId
          ? h('div', {
              style: { background: 'rgba(220,180,60,0.08)', border: '1px solid rgba(220,180,60,0.3)', color: '#e6c05a', borderRadius: 8, padding: '12px 14px', fontSize: 14 }
            }, 'PayPal is not configured yet. Set ', h('code', null, 'config/pricing.paypalClientId'), ' in Firestore (and the PayPal server credentials) to enable checkout.')
          : !showCreditPay
            ? h('button', {
                className: 'btn-primary w-full py-3 text-base font-semibold',
                onClick: () => setShowCreditPay(true)
              }, 'Checkout with PayPal')
            : h('div', null,
                !sdkReady && h('p', { className: 'text-sm text-slate-500 mb-2' }, 'Loading PayPal'),
                h('div', { ref: paypalContainerRef, style: { maxWidth: 400 } })),

      h('p', { className: 'text-xs text-slate-500 mt-3' },
        'Payments are processed by PayPal. Credits are granted server-side after the payment is captured  there is nothing to copy or paste.')),

    // Unlimited pass card
    h('div', { style: { background: 'rgba(255,200,48,0.05)', border: '1px solid rgba(255,200,48,0.18)', borderRadius: 14, padding: 24 } },
      h('div', { className: 'flex items-center justify-between flex-wrap gap-3 mb-1' },
        h('h3', { className: 'text-base font-bold text-white' }, 'Unlimited pass'),
        h('span', { className: 'text-2xl font-mono font-bold text-white' },
          '$' + unlimitedPerMonth.toFixed(2) + ' / month')),
      h('p', { className: 'text-sm text-slate-400 mb-4' },
        'Run as many simulations as you want  every job is free while the pass is active, no credits deducted. Choose how many months below; buying while a pass is active adds to your remaining time.'),

      h('div', { style: { display: 'flex', flexDirection: 'column', gap: 12, marginBottom: 16 } },
        h('div', { className: 'flex items-end justify-between flex-wrap gap-4' },
          h('div', { style: { flex: '1 1 160px' } },
            h('label', { className: 'text-sm font-semibold text-slate-400 block mb-1.5' }, 'Number of months'),
            h('div', { className: 'number-control', style: { maxWidth: 160 } },
              h('input', { type: 'number', className: 'input-field number-stepper w-full px-4 py-2.5 rounded-lg text-base font-mono', min: 1, max: cfg.maxUnlimitedMonths, step: 1, value: months, onChange: e => { var n = parseInt((e.target.value + '').replace(/[^0-9]/g, ''), 10); setMonths(isNaN(n) ? '' : n); }, onBlur: () => setMonths(m => Math.min(cfg.maxUnlimitedMonths, Math.max(1, Number(m) || 1))) }),
              h('div', { className: 'num-btns' },
                h('button', { type: 'button', onClick: () => setMonths(m => Math.min(cfg.maxUnlimitedMonths, (Number(m) || 0) + 1)) }, '+'),
                h('button', { type: 'button', onClick: () => setMonths(m => Math.max(1, (Number(m) || 1) - 1)) }, '-')))),
          h('div', { className: 'text-right' },
            h('p', { className: 'text-sm font-semibold text-slate-400 mb-0.5' }, 'You pay'),
            h('p', { className: 'text-3xl font-mono font-bold text-white' }, '$' + unlimitedTotalStr),
            h('p', { className: 'text-xs text-slate-500 mt-0.5' }, unlimitedMonths + ' month(s) / ' + (unlimitedMonths * cfg.unlimitedDays) + ' days'))),
        h('input', { type: 'range', min: 1, max: cfg.maxUnlimitedMonths, step: 1, value: Math.min(cfg.maxUnlimitedMonths, unlimitedMonths), onChange: e => setMonths(parseInt(e.target.value, 10)), style: { width: '100%', accentColor: '#ffc830', cursor: 'pointer' } }),
        h('div', { className: 'flex justify-between text-xs text-slate-500 font-mono' },
          h('span', null, '1 mo'),
          h('span', null, cfg.maxUnlimitedMonths + ' mo'))),

      !isSignedIn
        ? h('button', {
            className: 'btn-primary w-full py-3 text-base font-semibold',
            onClick: () => onRequireAuth && onRequireAuth('Sign in to buy the unlimited pass.')
          }, 'Sign in to buy the unlimited pass')
        : !clientId
          ? h('div', {
              style: { background: 'rgba(220,180,60,0.08)', border: '1px solid rgba(220,180,60,0.3)', color: '#e6c05a', borderRadius: 8, padding: '12px 14px', fontSize: 14 }
            }, 'PayPal is not configured yet.')
          : !showUnlimitedPay
            ? h('button', {
                className: 'btn-primary w-full py-3 text-base font-semibold',
                onClick: () => setShowUnlimitedPay(true)
              }, 'Get the unlimited pass')
            : h('div', null,
              unlimitedActive && h('p', { className: 'text-sm mb-2', style: { color: '#ffc830' } },
                'You already have an active pass  buying now adds ' + (unlimitedMonths * cfg.unlimitedDays) + ' more days.'),
              !sdkReady && h('p', { className: 'text-sm text-slate-500 mb-2' }, 'Loading PayPal'),
              h('div', { ref: unlimitedContainerRef, style: { maxWidth: 400 } }))),

    // Info cards
    h('div', { className: 'card-elegant border border-slate-800 rounded-lg p-6' },
      h('div', { className: 'grid grid-cols-3 gap-6' },
        [{
          t: 'Same cost for each geometry',
          b: 'Each geometry has the same cost calculation. No hidden fees for any features.'
        }, {
          t: 'PayPal Payments',
          b: 'Buy credits instantly with PayPal or any card. Sponsored racing teams get discounted rates  contact us.'
        }, {
          t: 'Refund Policy',
          b: 'Cancel a pending or meshing job for a full refund. Non-refundable once simulating or completed.'
        }].map(({ t, b }) => h('div', { key: t },
          h('h4', { className: 'text-base font-semibold text-white mb-1.5' }, t),
          h('p', { className: 'text-sm text-slate-400' }, b))))));
};

/* -- Lap Time Calculator View ----------------------------------------- */
// Embedded CSV data from co2_thrust_data.csv
/* Field is defined outside LapCalcView so React never remounts it on re-render */
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
    color: '#888888',
    textTransform: 'uppercase',
    letterSpacing: '0.08em',
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
    padding: '10px 12px',
    borderRadius: unit ? '8px 0 0 8px' : '8px',
    fontSize: 15
  }
}), unit && /*#__PURE__*/React.createElement("span", {
  style: {
    padding: '10px 12px',
    background: 'rgba(46,46,46,0.5)',
    border: '1px solid rgba(90,90,90,0.35)',
    borderLeft: 'none',
    borderRadius: '0 8px 8px 0',
    fontSize: 14,
    color: '#666666',
    fontWeight: 600,
    whiteSpace: 'nowrap'
  }
}, unit)));
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
      const resp = await fetch('https://us-central1-turboflow-7b3ca.cloudfunctions.net/run_lap_calc', {
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
    style: {
      width: '100%',
      height: '100%',
      display: 'flex',
      overflow: 'hidden',
      alignItems: 'stretch'
    }
  }, /*#__PURE__*/React.createElement("div", {
    style: {
      width: '50%',
      flexShrink: 0,
      display: 'flex',
      flexDirection: 'column',
      borderRight: '1px solid rgba(46,46,46,0.5)',
      boxSizing: 'border-box',
      padding: '24px 24px'
    }
  }, /*#__PURE__*/React.createElement("div", {
    style: {
      marginBottom: 16,
      flexShrink: 0
    }
  }, /*#__PURE__*/React.createElement("div", {
    style: {
      fontSize: 11,
      fontWeight: 700,
      letterSpacing: '0.14em',
      textTransform: 'uppercase',
      color: '#5de88a',
      marginBottom: 6
    }
  }, "Race Time Calculator"), /*#__PURE__*/React.createElement("h1", {
    style: {
      fontSize: 26,
      fontWeight: 900,
      color: '#f0f0f0',
      lineHeight: 1.05,
      margin: '0 0 8px',
      letterSpacing: '-0.02em'
    }
  }, "STEM Racing Car - 20 meters"), /*#__PURE__*/React.createElement("div", {
    style: {
      display: 'inline-flex',
      alignItems: 'center',
      padding: '4px 10px',
      borderRadius: 5,
      background: isSponsoredFree ? 'rgba(61,218,144,08)' : 'rgba(74,144,217,0.06)',
      border: isSponsoredFree ? '1px solid rgba(61,218,144,2)' : '1px solid rgba(74,144,217,0.10)'
    }
  }, /*#__PURE__*/React.createElement("span", {
    style: {
      fontSize: 11,
      fontWeight: 600,
      color: isSponsoredFree ? '#3dd490' : '#888888',
      textTransform: 'uppercase',
      letterSpacing: '0.08em'
    }
  }, isSponsoredFree ? 'Sponsored - Free' : `${LAP_CALC_COST} credits per run`))), /*#__PURE__*/React.createElement("div", {
    style: {
      flex: 1,
      background: 'rgba(30,30,30,0.85)',
      border: '1px solid rgba(90,90,90,0.28)',
      borderRadius: 12,
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
      borderRadius: 6,
      background: 'rgba(0,0,0,0.2)',
      border: '1px solid rgba(255,133,133,0.3)',
      color: '#ff8585',
      fontSize: 13
    }
  }, error), /*#__PURE__*/React.createElement("button", {
    onClick: handleRun,
    disabled: running,
    className: "btn-primary w-full py-2 text-sm font-semibold",
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
      background: 'rgba(30,30,30,0.60)',
      border: '1px solid rgba(90,90,90,0.20)',
      borderRadius: 10,
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
      color: '#aaaaaa'
    }
  }, "Saved Defaults"), /*#__PURE__*/React.createElement("div", {
    style: {
      display: 'flex',
      alignItems: 'center',
      gap: 6
    }
  }, saveMsg === 'saved' && /*#__PURE__*/React.createElement("span", {
    style: {
      fontSize: 12,
      color: '#3dd490',
      fontWeight: 600
    }
  }, " Saved"), saveMsg === 'error' && /*#__PURE__*/React.createElement("span", {
    style: {
      fontSize: 12,
      color: '#ff8585',
      fontWeight: 600
    }
  }, "Failed"), /*#__PURE__*/React.createElement("button", {
    onClick: handleSaveDefaults,
    disabled: saving,
    style: {
      padding: '4px 12px',
      borderRadius: 6,
      fontSize: 12,
      fontWeight: 700,
      background: 'rgba(74,144,217,0.09)',
      border: '1px solid rgba(74,144,226,0.25)',
      color: '#7ab3e0',
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
      color: '#666666',
      textTransform: 'uppercase',
      letterSpacing: '0.06em',
      borderBottom: '1px solid rgba(90,90,90,0.28)'
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
      background: idx % 2 === 0 ? 'transparent' : 'rgba(255,255,255,0.02)'
    }
  }, /*#__PURE__*/React.createElement("td", {
    style: {
      padding: '6px 6px',
      color: '#aaaaaa'
    }
  }, label), /*#__PURE__*/React.createElement("td", {
    style: {
      padding: '6px 6px',
      color: '#eeeeee',
      fontWeight: 600,
      fontFamily: 'JetBrains Mono,monospace'
    }
  }, defaults[key] != null && defaults[key] !== '' ? `${defaults[key]}${unit ? ' ' + unit : ''}` : /*#__PURE__*/React.createElement("span", {
    style: {
      color: '#484848'
    }
  }, "-")))))) : /*#__PURE__*/React.createElement("p", {
    style: {
      margin: 0,
      fontSize: 12,
      color: '#484848',
      fontStyle: 'italic'
    }
  }, "No defaults saved yet."), defaults && defaults.savedAt && /*#__PURE__*/React.createElement("p", {
    style: {
      margin: '6px 0 0',
      fontSize: 11,
      color: '#484848'
    }
  }, "Last saved: ", defaults.savedAt.toDate ? defaults.savedAt.toDate().toLocaleString() : 'Not available'))), /*#__PURE__*/React.createElement("div", {
    style: {
      flex: 1,
      display: 'flex',
      alignItems: 'center',
      justifyContent: 'center',
      position: 'relative',
      overflow: 'hidden'
    }
  }, /*#__PURE__*/React.createElement("div", {
    style: {
      position: 'absolute',
      inset: 0,
      background: result !== null ? 'radial-gradient(ellipse at 50% 50%,rgba(61,218,144,06) 0%,transparent 60%)' : 'none',
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
      color: '#3dd490',
      textTransform: 'uppercase',
      letterSpacing: '0.16em',
      marginBottom: 16
    }
  }, "Predicted Finish Time"), /*#__PURE__*/React.createElement("p", {
    style: {
      fontSize: 'clamp(48px,8vw,96px)',
      fontWeight: 900,
      color: '#f0f0f0',
      margin: 0,
      letterSpacing: '-0.03em',
      lineHeight: 1,
      fontFamily: 'JetBrains Mono,monospace'
    }
  }, result.toFixed(4), /*#__PURE__*/React.createElement("span", {
    style: {
      fontSize: 16,
      fontWeight: 400,
      color: '#666666',
      marginLeft: 8
    }
  }, "s")), /*#__PURE__*/React.createElement("p", {
    style: {
      fontSize: 11,
      color: '#484848',
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
      color: '#666666',
      textTransform: 'uppercase',
      letterSpacing: '0.16em',
      marginBottom: 16
    }
  }, "Predicted Finish Time"), /*#__PURE__*/React.createElement("p", {
    style: {
      fontSize: 'clamp(48px,8vw,96px)',
      fontWeight: 900,
      color: '#f0f0f0',
      margin: '0 0 10px',
      letterSpacing: '-0.03em',
      lineHeight: 1,
      fontFamily: 'JetBrains Mono,monospace',
      userSelect: 'none'
    }
  }, "0.0000", /*#__PURE__*/React.createElement("span", {
    style: {
      fontSize: 16,
      fontWeight: 400,
      color: '#666666',
      marginLeft: 8
    }
  }, "s")), /*#__PURE__*/React.createElement("p", {
    style: {
      fontSize: 13,
      color: '#666666',
      margin: 0
    }
  }, running ? 'Running...' : 'Your result will appear here'))));
};
ReactDOM.createRoot(document.getElementById('root')).render(/*#__PURE__*/React.createElement(App, null));
