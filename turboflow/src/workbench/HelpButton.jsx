// The round "?" above the orientation cube. Build spec 5.8.
//
// SimScale opens a support chat here. TurboFlow has no support staff sitting
// in a chat window, and a chat nobody answers is worse than no chat, so this
// is a popover with the three things that actually help: the docs, the setup
// video, and an email with the group id already in it.
//
// There was a fourth, "Share this group with support". Nothing handled the
// switch and nothing in the backend gives support access to a group, so it
// flipped and did nothing. It comes back when that access exists.
import React, { useEffect, useRef, useState } from "react";
import { Icon } from "./icons";

export default function HelpButton({ groupId }) {
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

  // The group id in the subject line. Without it the first reply to every
  // support mail is "which group?", which costs a day each way.
  const mailto = `mailto:support@turboflow.cloud?subject=${
    encodeURIComponent(`TurboFlow help with group ${groupId || ""}`)}`;

  return (
    <div className="wb-help" ref={box}>
      {open ? (
        <div className="wb-card wb-help-pop" role="dialog" aria-label="Help and support">
          <a className="wb-help-item" href="/#docs">
            <Icon name="file" size={15} /> Read the docs
          </a>
          {/* /docs has no #setup anchor, so this opened the same page as the
              link above. The setup guide is the video. */}
          <a className="wb-help-item" href="https://youtu.be/hKHx4sC5Mw4" target="_blank" rel="noopener">
            <Icon name="play" size={15} /> Watch the Fusion 360 set-up video
          </a>
          <a className="wb-help-item" href={mailto}>
            <Icon name="chat" size={15} /> Email support
          </a>
        </div>
      ) : null}
      <button
        type="button" className="wb-help-btn" aria-label="Help and support"
        aria-expanded={open} onClick={() => setOpen((v) => !v)}
      >
        <Icon name="help" size={18} />
      </button>
    </div>
  );
}
