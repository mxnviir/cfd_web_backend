// Extracted from app.compiled.js, which held every screen in one file.
//
// The bodies are the original generated React.createElement output, unchanged.
// Only the packaging is new: this is a module now, so a page that does not use
// it does not download it.

import React from "react";

// Colours from the site's theme tokens, so each theme gets its own. These were
// dark-theme hex values - #aaaaaa, #7ab3e0, #5de88a - and on the light theme
// they were pale text on a pale page. Four states, one colour each: waiting is
// neutral, working is the accent, finished is ok, failed is bad, and stopping
// is the warning colour because it is waiting on something outside the run.
const NEUTRAL = { color: 'var(--ink-3)', bg: 'var(--inset)', dot: 'var(--ink-3)' };
const WORKING = { color: 'var(--accent)', bg: 'var(--accent-wash)', dot: 'var(--accent)' };
const STATUS_META = {
  pending: { label: 'Pending', ...NEUTRAL },
  downloading: { label: 'Downloading files', ...WORKING },
  uploading_geometry: { label: 'Uploading geometry', ...WORKING },
  processing: { label: 'Processing', ...WORKING },
  creating_simulation: { label: 'Creating the simulation', ...WORKING },
  meshing: { label: 'Meshing', ...WORKING },
  running: { label: 'Running', ...WORKING },
  complete: { label: 'Complete', color: 'var(--ok)', bg: 'var(--ok-wash)', dot: 'var(--ok)' },
  failed: { label: 'Failed', color: 'var(--bad)', bg: 'transparent', dot: 'var(--bad)' },
  draft: { label: 'Draft', ...NEUTRAL },
  // Legacy. Nothing writes 'queued' any more - it was the status that charged
  // the account and then never ran - but old job documents still carry it.
  queued: { label: 'Queued', ...NEUTRAL },
  cancelling: { label: 'Cancelling', color: 'var(--warn)', bg: 'var(--warn-wash)', dot: 'var(--warn)' },
  cancelled: { label: 'Cancelled', ...NEUTRAL },
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
      borderRadius: 4,
      background: m.bg,
      border: '1px solid ' + m.color,
      color: m.color,
      fontSize: 12,
      fontWeight: 600
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

export { STATUS_META, StatusBadge };
