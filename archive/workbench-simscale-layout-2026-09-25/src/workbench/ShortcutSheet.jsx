// Help > Keyboard shortcuts. Build spec 6.7.
//
// The same table as 6.4, in two columns. It is written out here rather than
// generated from the handlers because a list that drifts from the keys is
// worse than no list, and this is the one place a reader can check what the
// viewer actually does.
import React from "react";
import { Modal } from "../dashboard/dialogs";

const GROUPS = [
  ["Camera", [
    ["Rotate", "Left-drag"],
    ["Rotate about one axis", "Hold X, Y or Z while dragging"],
    ["Pan", "Middle-drag"],
    ["Zoom", "Scroll wheel, towards the pointer"],
    ["Set rotation centre", "Double-click the model"],
    ["Fit to view", "A"],
    ["Views", "1 front, 2 back, 3 left, 4 right, 5 top, 6 bottom"],
    ["Isometric", "0"],
  ]],
  ["Selection", [
    ["Select", "Click"],
    ["Toggle one", "Ctrl-click, or Cmd-click on a Mac"],
    ["Add to the selection", "Shift-click"],
    ["Clear", "Click the background"],
    ["Box select", "B, then drag"],
    ["Take only what is fully inside", "Drag left to right"],
    ["Take anything the box touches", "Drag right to left"],
    ["What is behind this", "Right-click, Select other"],
    ["Grow across smooth joins", "Right-click, Expand selection"],
    ["Hide the selection", "H"],
  ]],
  ["Panels", [
    ["Measure", "M"],
    ["Save the open panel", "Enter"],
    ["Discard the open panel", "Esc"],
  ]],
];

export default function ShortcutSheet({ onClose }) {
  return (
    <Modal title="Keyboard shortcuts" onClose={onClose} width={720}
      footer={<button type="button" className="wb-btn" onClick={onClose}>Close</button>}>
      <div className="wb-keys">
        {GROUPS.map(([name, rows]) => (
          <section key={name}>
            <h3>{name}</h3>
            <dl>
              {rows.map(([what, how]) => (
                <React.Fragment key={what}>
                  <dt>{what}</dt>
                  <dd>{how}</dd>
                </React.Fragment>
              ))}
            </dl>
          </section>
        ))}
      </div>
    </Modal>
  );
}
