// The Workbench top bar. Build spec 5.2.
//
// White, 72px, one grey rule at the bottom. An earlier draft of the spec said
// dark navy; the screenshot says white and the screenshot wins.
//
// SimScale's "AI Agent" button is deliberately absent: the spec says leave it
// out, and a button for a thing that does not exist is worse than no button.
import React, { useEffect, useRef, useState } from "react";
import { Icon } from "./icons";
import { auth } from "../lib/firebase";

/**
 * What is and is not stored.
 *
 * `status` is about requests in flight, so on its own it said "All changes
 * saved" while a panel sat there holding edits nobody had committed - which
 * is the one message most likely to stop someone pressing the tick. `dirty`
 * is the open panel's own answer, and it wins.
 */
function SaveState({ status, dirty, onRetry }) {
  if (status === "saving") {
    return <span className="wb-save">Saving...</span>;
  }
  if (status === "error") {
    return (
      <button type="button" className="wb-save wb-save-bad" onClick={onRetry}>
        Could not save. Retry
      </button>
    );
  }
  if (dirty) {
    return <span className="wb-save wb-save-dirty">Unsaved edits in this panel</span>;
  }
  return <span className="wb-save">All changes saved</span>;
}

/**
 * Model / Results / Split.
 *
 * A segmented control rather than tabs, because these are three arrangements
 * of the same thing and none of them is a different place: the car and its
 * runs belong to each other, and split view is the case where you want both at
 * once. 1, 2 and 3 switch without reaching for it.
 */
export function ViewSwitch({ value, onChange }) {
  const items = [["model", "Model"], ["results", "Results"], ["split", "Split"]];
  return (
    <div className="wb-views" role="group" aria-label="View">
      {items.map(([id, label], i) => (
        <button
          key={id} type="button"
          className={"wb-view" + (value === id ? " wb-view-on" : "")}
          aria-pressed={value === id}
          title={`${label}  (${i + 1})`}
          onClick={() => onChange(id)}
        >
          {label}
        </button>
      ))}
    </div>
  );
}

/** A popover that closes on Escape and on a click anywhere else. */
function Menu({ label, children, align = "right", chevron = true }) {
  const [open, setOpen] = useState(false);
  const box = useRef(null);

  useEffect(() => {
    if (!open) return;
    const away = (e) => { if (!box.current?.contains(e.target)) setOpen(false); };
    const esc = (e) => { if (e.key === "Escape") setOpen(false); };
    addEventListener("pointerdown", away);
    addEventListener("keydown", esc);
    return () => { removeEventListener("pointerdown", away); removeEventListener("keydown", esc); };
  }, [open]);

  return (
    <div className="wb-menu-wrap" ref={box}>
      <button
        type="button" className="wb-btn wb-menu-trigger"
        aria-expanded={open} aria-haspopup="menu"
        onClick={() => setOpen((v) => !v)}
      >
        {label}
        {chevron ? <Icon name="chevronDown" size={14} /> : null}
      </button>
      {open ? (
        <div className={`wb-menu wb-menu-${align}`} role="menu"
          onClick={() => setOpen(false)}>
          {children}
        </div>
      ) : null}
    </div>
  );
}

export function MenuItem({ children, onClick, danger }) {
  return (
    <button type="button" role="menuitem"
      className={"wb-menu-item" + (danger ? " wb-menu-item-bad" : "")}
      onClick={onClick}>
      {children}
    </button>
  );
}

// `group`, not `project`. App has passed group={...} since the move to
// groups; this went on destructuring `project`, so the name in the header was
// always undefined and every group in the Workbench was called "Untitled
// project" no matter what it was called on the dashboard.
export default function TopBar({
  group, user, saveStatus, onRetrySave, onRename, onShare, onCopy,
  onSettings, onHelp, panelDirty, view, onView}) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState("");
  const input = useRef(null);

  useEffect(() => { if (editing) input.current?.select(); }, [editing]);

  const start = () => { setDraft(group?.name || ""); setEditing(true); };
  const commit = () => {
    setEditing(false);
    const next = draft.trim();
    if (next && next !== group?.name) onRename(next);
  };

  const initial = (user?.displayName || user?.email || "?").trim()[0].toUpperCase();

  return (
    <header className="wb-topbar">
      <a className="wb-logo" href="/dashboard" aria-label="TurboFlow dashboard">
        <svg width="28" height="28" viewBox="0 0 32 32" aria-hidden="true">
          <circle cx="16" cy="16" r="15" fill="var(--wb-accent)" />
          <path d="M8 20c6 0 6-8 12-8M8 13h5M19 22h5" fill="none" stroke="var(--wb-on-accent)"
            strokeWidth="2.2" strokeLinecap="round" />
        </svg>
      </a>

      {editing ? (
        <input
          ref={input} className="wb-project-name wb-project-input" value={draft}
          aria-label="Group name"
          onChange={(e) => setDraft(e.target.value)}
          onBlur={commit}
          onKeyDown={(e) => {
            if (e.key === "Enter") commit();
            if (e.key === "Escape") setEditing(false);
          }}
        />
      ) : (
        <button type="button" className="wb-project-name" onClick={start}
          title="Click to rename">
          {group?.name || "Untitled group"}
        </button>
      )}

      <button type="button" className="wb-btn" onClick={onShare}>Share</button>
      <button type="button" className="wb-icon-btn wb-tip" data-tip="Copy group"
        aria-label="Copy group" onClick={onCopy}>
        <Icon name="copy" />
      </button>
      <button type="button" className="wb-icon-btn wb-tip" data-tip="Group settings"
        aria-label="Group settings" onClick={onSettings}>
        <Icon name="gear" />
      </button>

      <SaveState status={saveStatus} dirty={panelDirty} onRetry={onRetrySave} />

      {onView ? <ViewSwitch value={view} onChange={onView} /> : null}

      <div className="wb-topbar-right">
        {/* No Support button here. SimScale has one because it opens their live
            chat; ours opened the keyboard shortcut sheet, which is not support
            and is already in the menu below. Help for a person who is stuck is
            the round button at the bottom right of the viewer, where it does
            not compete with the account menu. */}
        <Menu label="Help">
          <MenuItem onClick={() => location.assign("/docs")}>Documentation</MenuItem>
          <MenuItem onClick={onHelp}>Keyboard shortcuts</MenuItem>
          <MenuItem onClick={() => location.assign("mailto:support@turboflow.cloud")}>
            Email support
          </MenuItem>
        </Menu>
        <Menu
          label={
            <>
              <span className="wb-avatar" aria-hidden="true">{initial}</span>
              <span className="wb-user-name">
                {user?.displayName || user?.email || "Account"}
              </span>
            </>
          }
        >
          <MenuItem onClick={() => location.assign("/dashboard")}>Dashboard</MenuItem>
          <MenuItem onClick={() => location.assign("/billing")}>Billing</MenuItem>
          <MenuItem onClick={() => auth.signOut().then(() => location.assign("/"))}>
            Sign out
          </MenuItem>
        </Menu>
      </div>
    </header>
  );
}

export { Menu };
