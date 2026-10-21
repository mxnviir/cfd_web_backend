"""The Fusion add-in's own upload code, run against a deployed project without Fusion.

It checks everything after the geometry is exported: the connection token
exchange, the credit read, the two uploads under jobs/<id>/, and the job
document that starts a run. It runs the add-in's source, not a copy of it: the
block from "# ── Firebase upload" to the handler's final except is cut out of
the file and executed with the values Fusion would have worked out.

What it cannot check is the part that needs Fusion: exporting the flow region
and labelling its faces. Feed it a flow region and labels file the geometry
service built (a Workbench tunnel's v2/geometry.step and entity_labels.csv are
the same format), so the job it queues is one the worker can run.

Usage:
  FUSION_TOKEN=<connection token> python tests/replay_fusion_addin.py \\
      <stamped add-in .py> <flow.step> <entity_labels.csv> --domain=<json> \\
      [--iterations=100] [--level=1] [--debug-mesh] [--speed=20]

--domain is the tunnel's six planes in metres, as the geometry document stores
them: {"inlet_x":..,"outlet_x":..,"ground_z":..,"top_z":..,"side_y":..,"symmetry_y":..}
Prints the add-in's own result message, which carries the job id.
"""
import csv
import json
import os
import re
import sys
import textwrap
import types


class _Any:
    """Stands in for every Fusion class and value the module touches."""
    def __init__(self, *a, **k):
        pass

    def __getattr__(self, name):
        return _Any()

    def __call__(self, *a, **k):
        return _Any()


def _stub_fusion():
    adsk = types.ModuleType("adsk")
    for sub in ("core", "fusion", "cam"):
        m = types.ModuleType("adsk." + sub)
        m.__getattr__ = lambda name: _Any   # PEP 562: any attribute is the stub class
        setattr(adsk, sub, m)
        sys.modules["adsk." + sub] = m
    adsk.doEvents = lambda: None
    adsk.autoTerminate = lambda *_: None
    sys.modules["adsk"] = adsk


def main(argv):
    pos = [a for a in argv if not a.startswith("--")]
    opts = dict(a[2:].split("=", 1) if "=" in a else (a[2:], "1") for a in argv if a.startswith("--"))
    if len(pos) != 3 or "domain" not in opts or not os.environ.get("FUSION_TOKEN"):
        print(__doc__)
        return 2
    addin, step_path, label_path = pos
    domain = json.loads(opts["domain"])

    _stub_fusion()
    src = open(addin, encoding="utf-8").read()
    start = src.index("            # ── Firebase upload")
    end = src.index('\n        except:\n            if _ui:\n                _result_msg[0] = ("Execution error')
    body = textwrap.indent(textwrap.dedent(src[start:end]), "    ")

    # No __file__: the block saves a pasted token back into its own file, and
    # this must not write a token into anything.
    ns = {"__name__": "turboflow_addin_replay"}
    exec(compile(src, addin, "exec"), ns)

    with open(label_path, newline="", encoding="utf-8") as fh:
        rows = list(csv.DictReader(fh))
    counts = {}
    for r in rows:
        counts[r["label"]] = counts.get(r["label"], 0) + 1
    ns.update({
        "os": os, "csv": csv, "re": re,
        "token_override": os.environ["FUSION_TOKEN"],
        "refine_level": int(opts.get("level", 1)),
        "iter_count": max(1, min(3000, int(opts.get("iterations", 100)))),
        "debug_mesh": "debug-mesh" in opts,
        "stepPath": step_path, "labelPath": label_path,
        "face_ids": [r["step_entity_id"] for r in rows],
        "wheel_data": {i: r for i, r in enumerate(rows) if r["label"] == "rotating_wall"},
        "inlet_velocity": float(opts.get("speed", 20.0)),
        "off_upstream": 1.5, "off_downstream": 0.5, "off_side": 0.3, "off_top": 0.3,
        "domain_m": domain,
        "keep_local": True,
        "label_counts": counts,
        "label_summary": "\n".join(f"  {k}: {v}" for k, v in sorted(counts.items())),
    })
    exec(compile("def _upload():\n" + body + "\n", addin, "exec"), ns)
    ns["_upload"]()
    msg = ns["_result_msg"][0] or "(the add-in set no result message)"
    print(msg)
    return 0 if msg.startswith("Job queued successfully") else 1


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
