// Extracted from app.compiled.js, which held every screen in one file.
//
// The bodies are the original generated React.createElement output, unchanged.
// Only the packaging is new: this is a module now, so a page that does not use
// it does not download it.

import React, { useEffect, useState } from "react";
import { auth, db } from "../lib/firebase.js";
import { friendlyTxLabel } from "../lib/format.js";

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
    if (t.type === 'refund' || t.amount > 0) return 'var(--ok)';
    return 'var(--bad)';
  };
  const typeBadgeStyle = t => {
    const isCredit = t.amount > 0;
    return {
      display: 'inline-block',
      padding: '1px 7px',
      borderRadius: 4,
      fontSize: 11,
      fontWeight: 700,
      background: 'var(--inset)',
      border: `1px solid ${isCredit ? 'var(--ok)' : 'var(--bad)'}`,
      color: isCredit ? 'var(--ok)' : 'var(--bad)'
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
      background: 'var(--inset)',
      border: '1px solid var(--rule-strong)',
      borderRadius: open ? '4px 4px 0 0' : 4,
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
    "aria-hidden": "true",
    width: "15",
    height: "15",
    viewBox: "0 0 24 24",
    fill: "none",
    stroke: "var(--ink-3)",
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
      color: 'var(--ink)',
      fontWeight: 600,
      fontSize: 14
    }
  }, "Transaction history"), !loadingTx && txs.length > 0 && /*#__PURE__*/React.createElement("span", {
    style: {
      background: 'var(--accent-wash)',
      border: '1px solid var(--accent-wash)',
      color: 'var(--accent-soft)',
      borderRadius: 4,
      padding: '1px 8px',
      fontSize: 11,
      fontWeight: 700
    }
  }, txs.length)), /*#__PURE__*/React.createElement("svg", {
    "aria-hidden": "true",
    width: "14",
    height: "14",
    viewBox: "0 0 24 24",
    fill: "none",
    stroke: "var(--ink-3)",
    strokeWidth: "2.5",
    style: {
      transform: open ? 'rotate(180deg)' : 'none',
      transition: 'transform 0.2s'
    }
  }, /*#__PURE__*/React.createElement("polyline", {
    points: "6 9 12 15 18 9"
  }))), open && /*#__PURE__*/React.createElement("div", {
    style: {
      border: '1px solid var(--rule-strong)',
      borderTop: 'none',
      borderRadius: '0 0 4px 4px',
      overflow: 'hidden'
    }
  }, loadingTx && /*#__PURE__*/React.createElement("div", {
    style: {
      padding: 16,
      color: 'var(--ink-3)',
      fontSize: 13
    }
  }, "Loading..."), !loadingTx && txs.length === 0 && /*#__PURE__*/React.createElement("div", {
    style: {
      padding: 16,
      color: 'var(--ink-3)',
      fontSize: 13
    }
  }, "No transactions yet."), txs.map((t, i) => /*#__PURE__*/React.createElement("div", {
    key: t.id,
    style: {
      display: 'flex',
      alignItems: 'center',
      justifyContent: 'space-between',
      padding: '10px 16px',
      background: i % 2 === 0 ? 'var(--inset)' : 'var(--inset)',
      borderTop: i > 0 ? '1px solid var(--rule)' : 'none'
    }
  }, /*#__PURE__*/React.createElement("div", {
    style: {
      flex: 1,
      minWidth: 0,
      marginRight: 16
    }
  }, /*#__PURE__*/React.createElement("div", {
    style: {
      color: 'var(--ink)',
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
  }, t.amount > 0 ? 'Credit' : 'Debit'), /*#__PURE__*/React.createElement("span", {
    style: {
      color: 'var(--ink-4)',
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

export { TransactionsList };
