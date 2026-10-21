// The page side: pick a car, hand it to the worker, show progress, offer the
// results. Nothing here touches geometry, so nothing here can freeze.

// Where each stage sits on the bar, and how many seconds it usually takes.
// The bar eases toward the end of the current stage and only jumps to the
// next one when the worker says so, so it never claims more than has happened.
const STAGES = {
  engine: [0, 8, 3], read: [8, 22, 2], measure: [22, 30, 3],
  cut: [30, 92, 15], check: [92, 95, 1], export: [95, 98, 1], label: [98, 100, 0.5],
};
const MAX_BYTES = 50 * 2 ** 20;           // what the free storage plan takes per file
const TIME_LIMIT_MS = 10 * 60 * 1000;     // the server's worst car took over nine minutes

const $ = (id) => document.getElementById(id);
const secs = (s) => s.toFixed(s < 1 ? 2 : 1);
let worker = null;
let job = null;
let links = [];

function freshWorker() {
  const w = new Worker(new URL("./cut.worker.js", import.meta.url), { type: "module" });
  w.onmessage = ({ data }) => job?.message(data);
  w.onerror = (e) => {
    e.preventDefault();
    job?.stop(`The geometry engine could not run: ${e.message || "unknown error"}.`, "error");
  };
  w.onmessageerror = () => job?.stop("The geometry engine sent back something unreadable.", "error");
  return w;
}

function setBusy(busy) {
  $("go").disabled = busy;
  $("file").disabled = busy;
  $("cancel").hidden = !busy;
  $("progress-box").hidden = false;
}

function say(text, kind = "") {
  $("status").textContent = text;
  $("status").dataset.kind = kind;
}

function start() {
  const file = $("file").files[0];
  if (!file) return say("Choose a STEP file first.", "error");
  if (!/\.(step|stp)$/i.test(file.name)) return say("That is not a .step or .stp file.", "error");
  if (file.size > MAX_BYTES) {
    return say(`That file is ${(file.size / 2 ** 20).toFixed(1)} MB. The limit is 50 MB.`, "error");
  }
  const options = {
    symmetry: $("half").checked,
    up: +$("up").value, down: +$("down").value, side: +$("side").value, top: +$("top").value,
  };
  links.forEach(URL.revokeObjectURL);
  links = [];
  $("result").hidden = true;
  setBusy(true);

  worker ??= freshWorker();
  const t0 = performance.now();
  let stage = "read";
  let stageAt = t0;
  let text = "Reading the STEP file";
  const bar = $("bar");
  bar.value = 0;
  const cutTau = 5 + 20 * (file.size / 2 ** 20);

  const tick = setInterval(() => {
    const now = performance.now();
    const [a, b, tau] = STAGES[stage];
    const t = (now - stageAt) / 1000;
    const eased = a + (b - a) * 0.95 * (1 - Math.exp(-t / (stage === "cut" ? cutTau : tau)));
    bar.value = Math.max(bar.value, eased);
    say(`${text} · ${Math.round((now - t0) / 1000)} s`);
  }, 100);
  const watchdog = setTimeout(() => job?.stop(
    "This car took longer than ten minutes, so it was stopped. The file is probably " +
    "too complex or has faces the engine cannot resolve.", "error"), TIME_LIMIT_MS);

  job = {
    message(data) {
      if (data.type === "stage") {
        if (data.stage !== stage) {
          stage = data.stage;
          stageAt = performance.now();
          bar.value = Math.max(bar.value, STAGES[stage][0]);
        }
        text = data.text;
      } else if (data.type === "done") {
        bar.value = 100;
        this.stop(`Done in ${secs(data.stats.seconds)} s.`, "ok");
        show(data, file.name);
      } else if (data.type === "error") {
        // A fault in the car leaves the engine healthy; anything else might not.
        this.stop(data.message, "error", !data.carFault);
      }
    },
    stop(message, kind, killWorker = true) {
      clearInterval(tick);
      clearTimeout(watchdog);
      if (killWorker && kind !== "ok") {
        worker?.terminate();
        worker = null;
      }
      job = null;
      setBusy(false);
      say(message, kind);
    },
  };

  const mine = job;
  file.arrayBuffer().then((buf) => {
    if (job === mine) worker.postMessage({ step: buf, options }, [buf]);
  });
}

function show({ step, labels, stats }, name) {
  const base = name.replace(/\.(step|stp)$/i, "");
  const link = (id, body, type, filename) => {
    const url = URL.createObjectURL(new Blob([body], { type }));
    links.push(url);
    Object.assign($(id), { href: url, download: filename });
  };
  link("dl-step", step, "model/step", `${base}-tunnel.step`);
  link("dl-labels", labels, "text/csv", `${base}-entity_labels.csv`);

  const mm3 = (v) => `${Math.round(v).toLocaleString()} mm³`;
  const walls = ["inlet", "outlet", "ground", "top", "side", "symmetry"]
    .filter((w) => stats.labels[w]).map((w) => `${w} ${stats.labels[w]}`).join(", ");
  const rows = [
    ["Car", `${stats.car === "half" ? "half model" : "whole car"}, ${stats.bodies} bod${stats.bodies === 1 ? "y" : "ies"}, drawn in ${stats.unit}`],
    ["Car volume", mm3(stats.carVolumeMm3)],
    ["Removed from the tunnel", `${mm3(stats.removedMm3)} (${stats.removedPct.toFixed(1)}% of the ${mm3(stats.expectedMm3)} expected)`],
    ["How", `${stats.how}${stats.attempts > 1 ? `, symmetry wall position ${stats.attempts}` : ""}`],
    ["Tunnel faces", `${stats.faces}: ${walls}, car ${stats.labels.car_no_slip || 0}`],
    ["Solid is valid", stats.valid ? "yes" : "no (OCC does not certify it)"],
    ["Sealed voids", String(stats.voids)],
    ["Time", `${secs(stats.seconds)} s`],
    ["Engine memory", `${stats.memoryMB} MB`],
  ];
  if (stats.note) rows.push(["Note", stats.note]);
  $("facts").replaceChildren(...rows.map(([k, v]) => {
    const row = document.createElement("div");
    row.innerHTML = "<dt></dt><dd></dd>";
    row.firstChild.textContent = k;
    row.lastChild.textContent = v;
    return row;
  }));
  $("result").hidden = false;
}

$("go").addEventListener("click", start);
$("cancel").addEventListener("click", () => job?.stop("Stopped. Nothing was kept.", ""));
