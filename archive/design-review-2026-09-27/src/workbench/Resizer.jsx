// The drag handle between the tree and the viewer. Build spec 5.1.
//
// It writes a CSS custom property rather than React state. Dragging fires
// pointermove sixty times a second, and re-rendering the whole Workbench that
// often to move a divider four pixels would drop frames in the viewer while
// the user is looking straight at it.
//
// The width is remembered per browser. A team that widens the tree to read
// long boundary condition names should not have to do it again tomorrow.
import React, { useCallback, useEffect, useRef } from "react";

export default function Resizer({
  varName = "--wb-tree-w",
  storageKey = "wb.treeWidth",
  min = 220,
  max = 560,
  // Which edge the width is measured from. The navigation panel grows from the
  // left; the results pane in split view grows from the right, so its width is
  // the distance from the window's right edge rather than from its left.
  fromRight = false,
  label = "Resize the navigation panel",
  className = "",
}) {
  const MIN = min;
  const MAX = max;
  const dragging = useRef(false);

  useEffect(() => {
    try {
      const saved = Number(localStorage.getItem(storageKey));
      if (saved >= MIN && saved <= MAX) {
        document.querySelector(".wb")?.style.setProperty(varName, `${saved}px`);
      }
    } catch { /* a browser with site data blocked still gets the default */ }
  }, [varName, storageKey, MIN, MAX]);

  const move = useCallback((e) => {
    if (!dragging.current) return;
    const root = document.querySelector(".wb");
    if (!root) return;
    // 10px is the grid's own left margin, so the handle sits where the pointer
    // is rather than ten pixels off it.
    const raw = fromRight ? window.innerWidth - e.clientX - 10 : e.clientX - 10;
    const w = Math.min(MAX, Math.max(MIN, raw));
    root.style.setProperty(varName, `${w}px`);
  }, [varName, fromRight, MIN, MAX]);

  const end = useCallback(() => {
    if (!dragging.current) return;
    dragging.current = false;
    document.body.classList.remove("wb-dragging");
    const w = document.querySelector(".wb")?.style.getPropertyValue(varName);
    try { if (w) localStorage.setItem(storageKey, parseInt(w, 10)); } catch { /* ignore */ }
  }, [varName, storageKey]);

  useEffect(() => {
    addEventListener("pointermove", move);
    addEventListener("pointerup", end);
    return () => { removeEventListener("pointermove", move); removeEventListener("pointerup", end); };
  }, [move, end]);

  return (
    <div
      className={"wb-resizer" + (className ? " " + className : "")}
      role="separator" aria-orientation="vertical"
      aria-label={label} tabIndex={0}
      onPointerDown={(e) => {
        e.preventDefault();
        dragging.current = true;
        document.body.classList.add("wb-dragging");
      }}
      onKeyDown={(e) => {
        // Keyboard too: a divider that only a mouse can move is a divider
        // some users simply do not have.
        const root = document.querySelector(".wb");
        if (!root) return;
        const now = parseInt(getComputedStyle(root).getPropertyValue(varName), 10) || MIN;
        const step = e.shiftKey ? 40 : 10;
        // Left always makes the pane it controls smaller, whichever edge it
        // grows from, because that is what the arrow means on screen.
        const grow = fromRight ? -1 : 1;
        if (e.key === "ArrowLeft") root.style.setProperty(varName, `${Math.max(MIN, Math.min(MAX, now - step * grow))}px`);
        if (e.key === "ArrowRight") root.style.setProperty(varName, `${Math.max(MIN, Math.min(MAX, now + step * grow))}px`);
      }}
    />
  );
}
