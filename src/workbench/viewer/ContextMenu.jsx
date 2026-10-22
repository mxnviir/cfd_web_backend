// The viewer's right-click menu. Build spec 6.3.
//
// Two of these items are the reason the menu exists at all. "Select other"
// lists what is behind the cursor, which is the only way to reach the inside
// of a duct without hiding everything in front of it. "Expand selection"
// turns one click into the whole tyre, because a tyre in a STEP file is
// usually eleven faces and nobody wants to click eleven times.
import React, { useEffect, useRef, useState } from "react";
import { Icon } from "../icons";

function Item({ label, onClick, disabled, submenu, onHoverItem }) {
  const [open, setOpen] = useState(false);
  if (!submenu) {
    return (
      <button type="button" role="menuitem" className="wb-menu-item"
        disabled={disabled} onClick={onClick}>
        {label}
      </button>
    );
  }
  return (
    <span className="wb-ctx-sub" onMouseEnter={() => setOpen(true)}
      onMouseLeave={() => { setOpen(false); onHoverItem?.(null); }}>
      <button type="button" role="menuitem" className="wb-menu-item wb-ctx-parent"
        aria-haspopup="menu" aria-expanded={open} disabled={disabled}>
        {label} <Icon name="chevronRight" size={12} />
      </button>
      {open ? (
        <span className="wb-menu wb-ctx-flyout" role="menu">
          {submenu.map((s) => (
            <button key={s.label} type="button" role="menuitem" className="wb-menu-item"
              onMouseEnter={() => onHoverItem?.(s)}
              onClick={s.onClick}>
              {s.label}
            </button>
          ))}
        </span>
      ) : null}
    </span>
  );
}

export default function ContextMenu({ at, items, onClose, onHoverItem }) {
  const box = useRef(null);
  const [pos, setPos] = useState(at);

  useEffect(() => {
    const away = () => onClose();
    const esc = (e) => { if (e.key === "Escape") onClose(); };
    addEventListener("pointerdown", away);
    addEventListener("keydown", esc);
    return () => { removeEventListener("pointerdown", away); removeEventListener("keydown", esc); };
  }, [onClose]);

  // Keep it on screen. A menu opened near the bottom right of the viewport
  // otherwise runs off the edge and its last three items are unreachable.
  useEffect(() => {
    const el = box.current;
    if (!el) return;
    const r = el.getBoundingClientRect();
    setPos({
      x: Math.min(at.x, innerWidth - r.width - 8),
      y: Math.min(at.y, innerHeight - r.height - 8),
    });
  }, [at.x, at.y]);

  return (
    <div
      ref={box} role="menu" aria-label="Viewer actions"
      className="wb-menu wb-ctx"
      style={{ left: pos.x, top: pos.y }}
      onPointerDown={(e) => e.stopPropagation()}
      onClick={(e) => { if (e.target.tagName === "BUTTON" && !e.target.getAttribute("aria-haspopup")) onClose(); }}
    >
      {items.map((it, i) => (
        it.separator
          ? <span key={`sep${i}`} className="wb-ctx-rule" />
          : <Item key={it.label} {...it} onHoverItem={onHoverItem} />
      ))}
    </div>
  );
}
