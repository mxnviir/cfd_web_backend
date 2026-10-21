// The group list: toolbar, cards, and the row menu.
// Build spec 4.4.
import React, { useEffect, useRef, useState } from "react";
import { Icon } from "../workbench/icons";

const MODIFIED = (p) => {
  const v = p.updatedAt || p.createdAt;
  const ms = v?.toMillis ? v.toMillis() : (typeof v === "number" ? v : 0);
  return ms;
};

export const SORTS = [
  ["modified", "Last modified"], ["name", "Name"], ["created", "Created"],
];

export function sortGroups(rows, by, ascending) {
  const key = {
    modified: MODIFIED,
    created: (p) => (p.createdAt?.toMillis ? p.createdAt.toMillis() : 0),
    name: (p) => (p.name || "").toLowerCase(),
  }[by] || MODIFIED;
  const out = [...rows].sort((a, b) => {
    const x = key(a);
    const y = key(b);
    return x < y ? -1 : x > y ? 1 : 0;
  });
  return ascending ? out : out.reverse();
}

function when(ms) {
  if (!ms) return "not yet";
  return new Date(ms).toLocaleDateString(undefined, {
    month: "short", day: "numeric", year: "numeric",
  });
}

function CardMenu({ onPick }) {
  const [open, setOpen] = useState(false);
  const box = useRef(null);
  useEffect(() => {
    if (!open) return;
    const away = (e) => { if (!box.current?.contains(e.target)) setOpen(false); };
    addEventListener("pointerdown", away);
    return () => removeEventListener("pointerdown", away);
  }, [open]);
  const items = [
    ["open", "Open"], ["copy", "Copy"], ["rename", "Rename"],
    ["share", "Share..."], ["delete", "Delete"],
  ];
  return (
    <span ref={box} className="wb-row-menu">
      <button type="button" className="wb-icon-btn db-card-dots" aria-label="More actions"
        aria-expanded={open}
        onClick={(e) => { e.stopPropagation(); setOpen((v) => !v); }}>
        <Icon name="dots" size={16} />
      </button>
      {open ? (
        <span className="wb-menu wb-menu-right" role="menu">
          {items.map(([id, label]) => (
            <button key={id} type="button" role="menuitem"
              className={"wb-menu-item" + (id === "delete" ? " wb-menu-item-bad" : "")}
              onClick={(e) => { e.stopPropagation(); setOpen(false); onPick(id); }}>
              {label}
            </button>
          ))}
        </span>
      ) : null}
    </span>
  );
}

function Stat({ icon, n, label }) {
  // "1 geometries" to a screen reader and in the tooltip.
  if (n === 1) label = label.replace(/ies$/, "y").replace(/s$/, "");
  return (
    <span className="db-stat" title={`${n} ${label}`}>
      <Icon name={icon} size={13} /> {n}
      <span className="wb-sr">{label}</span>
    </span>
  );
}

function Card({ group, counts, thumb, ownerName, selected, onSelect, onOpen, onMenu }) {
  return (
    <div
      className={"db-card" + (selected ? " db-card-on" : "")}
      role="button" tabIndex={0} aria-pressed={selected}
      onClick={onSelect}
      onDoubleClick={onOpen}
      onContextMenu={(e) => { e.preventDefault(); onSelect(); }}
      onKeyDown={(e) => {
        if (e.key === "Enter") onOpen();
        if (e.key === " ") { e.preventDefault(); onSelect(); }
      }}
    >
      <CardMenu onPick={onMenu} />
      <div className="db-thumb">
        {thumb ? <img src={thumb} alt="" /> : "No preview available"}
      </div>
      <div className="db-card-body">
        <span className="db-card-name">{group.name}</span>
        <div className="db-card-by">by {ownerName}</div>
        <div className="db-card-mod">Last modified: {when(MODIFIED(group))}</div>
      </div>
      <div className="db-card-foot">
        <span className="db-stat"><Icon name="grid" size={13} /> Statistics</span>
        <Stat icon="cube" n={counts.geometries} label="geometries" />
        {/* No "meshes" count. SimScale meshes as a separate job and counts
            them; TurboFlow meshes inside the run, nothing ever writes a mesh
            record, and the figure read 0 next to 15 runs - which invites the
            question "why has my mesh not been made?" */}
        <Stat icon="layers" n={counts.simulations} label="simulations" />
        <Stat icon="play" n={counts.runs} label="runs" />
      </div>
    </div>
  );
}

export default function GroupGrid({
  groups, counts, thumbs, ownerNames, loading, view, onView, filter,
  sort, onSort, ascending, onAscending, showInfo, onShowInfo,
  selected, onSelect, onOpen, onMenu,
}) {
  return (
    <>
      <div className="db-toolbar">
        <div className="db-crumb">
          {/* Nothing to crumb to any more: groups are a flat list, so this is
              a heading rather than a trail. */}
          <span>{filter === "recent" ? "Recent" : filter === "shared" ? "Shared with me" : "My groups"}</span>
        </div>
        <button type="button" className="wb-icon-btn wb-tip"
          data-tip={ascending ? "Ascending" : "Descending"}
          aria-label={ascending ? "Sort ascending" : "Sort descending"}
          onClick={() => onAscending(!ascending)}>
          <Icon name={ascending ? "chevronUp" : "chevronDown"} size={15} />
        </button>
        <select className="wb-field wb-select" style={{ width: 150 }} value={sort}
          aria-label="Sort by" onChange={(e) => onSort(e.target.value)}>
          {SORTS.map(([id, label]) => <option key={id} value={id}>{label}</option>)}
        </select>
        <span className="db-seg">
          <button type="button" aria-label="Grid view" aria-pressed={view === "grid"}
            onClick={() => onView("grid")}><Icon name="grid" size={14} /></button>
          <button type="button" aria-label="List view" aria-pressed={view === "list"}
            onClick={() => onView("list")}><Icon name="layers" size={14} /></button>
        </span>
        <button type="button" className="wb-icon-btn wb-tip" data-tip="Details panel"
          aria-label="Show or hide the details panel" aria-pressed={showInfo}
          onClick={() => onShowInfo(!showInfo)}>
          <Icon name="info" size={15} />
        </button>
      </div>

      <div className="db-list-card">
        <div className={view === "grid" ? "db-grid" : "db-rows"}>

          {loading ? [0, 1, 2, 3, 4, 5].map((i) => (
            // Six card outlines, the shape of the content. Build spec 4.4.
            <div key={i} className="db-card" aria-hidden="true">
              <div className="wb-skel" style={{ height: 220 }} />
              <div className="db-card-body">
                <div className="wb-skel" style={{ height: 14, width: "60%", marginBottom: 6 }} />
                <div className="wb-skel" style={{ height: 12, width: "35%" }} />
              </div>
            </div>
          )) : null}

          {!loading ? groups.map((p) => (
            <Card
              key={p.id} group={p}
              counts={counts[p.id] || { geometries: 0, simulations: 0, runs: 0 }}
              thumb={thumbs[p.id]} ownerName={ownerNames[p.userId] || "you"}
              selected={selected === p.id}
              onSelect={() => onSelect(p.id)}
              onOpen={() => onOpen(p)}
              onMenu={(what) => onMenu(what, p)}
            />
          )) : null}
        </div>

        {!loading && !groups.length ? (
          <p className="db-hint" style={{ marginTop: 16 }}>
            {filter === "shared"
              ? "Nobody has shared a group with you. When someone does, it appears here."
              : "No groups yet. Create one and upload a CAD model to start."}
          </p>
        ) : null}
      </div>
    </>
  );
}
