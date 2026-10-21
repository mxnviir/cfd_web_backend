// The dialog that spends credits. Build spec 11.1.
//
// SimScale calls this Start and shows an estimated core-hour range.
// TurboFlow charges credits, so it shows the price and the balance, and the
// Queue button is disabled when the balance will not cover it. A team that
// finds out mid-run that they cannot afford it has already lost the run.
//
// Errors disable Queue; warnings do not. A warning is about judgement and
// the team may be right.
import React, { useState } from "react";
import { Modal } from "../../dashboard/dialogs";
import { Icon } from "../icons";

function Line({ label, value }) {
  return (
    <div className="wb-qrow">
      <span className="wb-plabel">{label}</span>
      <span>{value}</span>
    </div>
  );
}

export default function QueueDialog({
  defaultName, validation, price, credits, meshName, cells, endTime,
  processors, onClose, onQueue,
}) {
  const [name, setName] = useState(defaultName);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);

  const errors = validation?.errors ?? [];
  const warnings = validation?.warnings ?? [];
  const poor = credits != null && price != null && credits < price;
  const blocked = errors.length > 0 || poor;

  const queue = async () => {
    setBusy(true);
    setError(null);
    try {
      await onQueue(name.trim() || defaultName);
    } catch (err) {
      setError(err.message || String(err));
      setBusy(false);
    }
  };

  return (
    <Modal
      title="Queue simulation run" onClose={onClose} width={520}
      footer={
        <>
          <button type="button" className="wb-btn" onClick={onClose}>Cancel</button>
          <button type="button" className="wb-btn wb-btn-primary"
            disabled={blocked || busy} onClick={queue}>
            {busy ? "Queueing…" : "Queue"}
          </button>
        </>
      }
    >
      <div className="db-field">
        <label htmlFor="q-name">Name</label>
        <input id="q-name" className="wb-field" value={name} maxLength={200}
          onChange={(e) => setName(e.target.value)}
          onKeyDown={(e) => { if (e.key === "Enter" && !blocked && !busy) queue(); }} />
      </div>

      <div className="wb-qsummary">
        <Line label="Mesh" value={meshName || "Standard, automatic"} />
        {cells ? <Line label="Cells" value={cells.toLocaleString()} /> : null}
        <Line label="End time" value={`${endTime ?? 1000} iterations`} />
        <Line label="Processors" value={processors === -1 || processors == null
          ? "Automatic" : processors} />
      </div>

      <p className={"wb-qprice" + (poor ? " wb-qprice-short" : "")}>
        This run costs <strong>{price ?? "-"} credits</strong>.
        {" "}You have {credits == null ? "-" : credits.toLocaleString()}.
        {poor ? (
          <>
            {" "}
            <a className="wb-link" href="/#billing">Add credits</a> before queueing.
          </>
        ) : null}
      </p>

      {errors.map((e) => (
        <p key={e} className="wb-qerror">
          <Icon name="warn" size={14} /> {e}
        </p>
      ))}
      {warnings.map((w) => (
        <p key={w} className="wb-qwarn">
          <Icon name="warn" size={14} /> {w}
        </p>
      ))}
      {error ? <p className="wb-qerror">{error}</p> : null}
    </Modal>
  );
}
