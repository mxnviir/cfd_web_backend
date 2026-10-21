"""The Workbench's path through SimScale. Build spec 14.7.

The older path in simscale_job.py builds a SimScale model from four columns
on the job and an entity_labels.csv the Fusion add-in wrote. This one sends
the setup the user actually built, unchanged, and its whole job is to make
that setup speak SimScale's language.

The translation is the part worth understanding. A face has three names:

  in the browser   its position in faces.json
  in the STEP      an entity number, "#4711"
  in SimScale      a name it invents at import, "B1_TE12"

Only the STEP entity number is common to all three, which is why the
geometry service records it per face and why this module refuses to run
without it. Guessing the mapping from face order would produce a run that
finishes and puts the inlet on the underside of the car.

Everything else here is stage reporting. A CFD run is twenty minutes of
nothing visible, and "Meshing 43%" is the difference between a team waiting
and a team refreshing the page wondering if it broke.
"""
import io
import json
import logging
import os
import time
import zipfile

from firebase_admin import firestore

import requests

log = logging.getLogger("turboflow")

POLL_INTERVAL = int(os.environ.get("POLL_INTERVAL", "15"))


class SpecError(Exception):
    """Something about the user's setup that the user can fix."""


# ── run document ─────────────────────────────────────────────────────────────
def make_stage_writer(db, job_id, run_id):
    """One function that writes the stage to both documents.

    Both, because they are read by different things: the job drives billing
    and the old dashboard, the run drives the Workbench. Letting them drift
    is how a run shows "finished" in one place and "meshing" in another.
    """
    started = {"done": False}

    def set_stage(status, text, progress=None, extra=None):
        run_patch = {"status": status, "stage_text": text}
        # Stamp the moment the worker actually picked the job up, once.
        # Without it the run panel and the job dock both showed "not started"
        # for the entire run, including while it was meshing, because nothing
        # ever wrote started_at.
        if not started["done"]:
            run_patch["started_at"] = firestore.SERVER_TIMESTAMP
            started["done"] = True
        if progress is not None:
            run_patch["progress"] = max(0.0, min(1.0, float(progress)))
        if status in ("finished", "failed", "cancelled"):
            run_patch["finished_at"] = firestore.SERVER_TIMESTAMP
        if extra:
            run_patch.update(extra)
        if run_id:
            try:
                db.collection("runs").document(run_id).update(run_patch)
            except Exception as e:
                log.warning("could not write the run stage: %s", e)
        try:
            db.collection("jobs").document(job_id).update({"status": status})
        except Exception as e:
            log.warning("could not write the job status: %s", e)
        log.info("  [stage] %s  %s", status, text)
    return set_stage


# ── the face map ─────────────────────────────────────────────────────────────
def fetch_step_id_to_names(api, project_id, geometry_id):
    """{STEP entity number: [SimScale face names]} for an imported geometry.

    One STEP face can become several SimScale faces, which is why the value
    is a list. A tyre split into eleven patches by the CAD package arrives as
    eleven names under one entity number, and assigning "the tyre" has to
    assign all eleven or the wall condition covers a tenth of the wheel.
    """
    out = {}
    page = 1
    while True:
        res = api["geometry"].get_geometry_mappings(
            project_id, geometry_id, _class="face", limit=100, page=page)
        batch = res.embedded or []
        for entry in batch:
            d = entry.to_dict()
            origins = d.get("originate_from") or []
            if not origins:
                continue
            try:
                step_id = int(origins[0].get("entity") or 0)
            except (TypeError, ValueError):
                continue
            out.setdefault(step_id, []).append(d["name"])
        if len(batch) < 100:
            break
        page += 1
    log.info("  mapped %d STEP entities to SimScale faces", len(out))
    return out


def region_names(api, project_id, geometry_id):
    res = api["geometry"].get_geometry_mappings(
        project_id, geometry_id, _class="region", limit=100, page=1)
    return [e.to_dict().get("name", "") for e in (res.embedded or [])]


def add_missing_discriminators(node):
    """Put back the type tags SimScale needs and the Workbench used to omit.

    SimScale's JSON is a discriminated union all the way down: a vector of
    three functions is only recognised as one because it carries
    type: "COMPONENT". The Workbench wrote the three components and no tag, and
    every velocity inlet was refused with "Missing 'type' property for object
    'value'" before the mesh was built. Found on 11 Sep 2026 on the first run
    that got far enough to be refused.

    Fixed at the source in boundary.jsx, and here as well, because setups saved
    before that fix are still in the database and would otherwise fail forever
    with an error that names a JSON path no user has ever seen.
    """
    if isinstance(node, dict):
        keys = set(node)
        if {"x", "y", "z"} <= keys and "type" not in keys:
            # Only when the components are themselves functions. A plain
            # vector of numbers (a moving wall's velocity) has no tag and must
            # not be given one.
            if all(isinstance(node.get(k), dict) and "type" in node[k] for k in "xyz"):
                node["type"] = "COMPONENT"
        for value in node.values():
            add_missing_discriminators(value)
    elif isinstance(node, list):
        for item in node:
            add_missing_discriminators(item)
    return node


def readable_api_error(text, fallback="The solver refused the request."):
    """Turn SimScale's error JSON into a sentence a person can act on.

    Their errors are a nested structure with a machine `code`, a `message`, and
    sometimes a `details` object listing every value the field could have taken.
    Passed through whole, it reaches the run panel as three hundred characters
    of JSON with a list of schema version numbers in it, which tells a school
    team nothing except that something broke. The full text still goes to the
    log; this is what goes on screen.
    """
    try:
        data = json.loads(text)
    except Exception:
        return (text or fallback).strip()[:300]

    def first_message(node):
        if isinstance(node, dict):
            for key in ("message", "cause", "detail"):
                v = node.get(key)
                if isinstance(v, str) and v.strip():
                    return v.strip()
            for v in node.values():
                found = first_message(v)
                if found:
                    return found
        elif isinstance(node, list):
            for v in node:
                found = first_message(v)
                if found:
                    return found
        return None

    message = first_message(data)
    code = data.get("code") if isinstance(data, dict) else None
    if message and code:
        return f"{message} ({code})"[:300]
    if message:
        return message[:300]
    if code:
        # No message at all, so name the code plainly rather than dumping the
        # object it came in.
        return f"The solver refused the request: {code}."
    return fallback


def resolve_spec(spec, faces_json, step_id_to_names, regions):
    """Rewrite every face reference in the spec into SimScale face names.

    The spec stores browser face indices, because that is what the user
    clicked and it is stable across a re-upload of the same car. This turns
    each into its STEP entity number using faces.json, and then into the
    names SimScale gave it.

    An index with no STEP id is an error: that means faces.json and the spec
    disagree, and nothing downstream can be trusted.

    A STEP id SimScale did not report is different, and used to be fatal. It
    is not a corruption: SimScale's importer deletes degenerate faces, and a
    real car has them. The first end-to-end run on 11 Sep 2026 died on exactly
    this, five zero-area slivers out of 131 faces that the tessellator listed
    and the importer dropped. Refusing the run told the user to "re-upload the
    geometry", which would have produced the same five slivers and the same
    refusal, forever.

    So a dropped face is now skipped with a warning, and only a boundary
    condition left with *no* faces at all is fatal. That keeps the guarantee
    that matters, which is that no surface silently loses its physics, without
    failing a run over geometry the solver was right to discard.
    """
    faces = faces_json.get("faces") or []
    missing_ids = []
    dropped = []
    emptied = []

    def names_for(index):
        if not (0 <= index < len(faces)):
            missing_ids.append(index)
            return []
        step_id = faces[index].get("step_id")
        if step_id is None:
            missing_ids.append(index)
            return []
        found = step_id_to_names.get(int(step_id))
        if not found:
            area = faces[index].get("area_m2")
            dropped.append((index, step_id, area))
            return []
        return found

    def walk(node):
        if isinstance(node, dict):
            ref = node.get("topologicalReference")
            if isinstance(ref, dict) and isinstance(ref.get("faces"), list):
                names = []
                for index in ref["faces"]:
                    names.extend(names_for(int(index)))
                if ref["faces"] and not names:
                    emptied.append(str(node.get("name") or node.get("type") or "a boundary condition"))
                # Exactly the two keys SimScale's TopologicalReference has,
                # and nothing else.
                #
                # The browser's face indices used to be kept here too, on the
                # reasoning that a later CAD edit needs them to remap. They do
                # need to survive, but not in this copy: this dict is posted to
                # SimScale, whose parser rejects properties it does not know,
                # and the run would die on an unknown "faces" key with a
                # message about JSON. The indices are already safe in
                # runs.spec_snapshot, which is the copy a remap should read.
                node["topologicalReference"] = {
                    "entities": sorted(set(names)),
                    "sets": ref.get("sets") or [],
                }
            for value in node.values():
                walk(value)
        elif isinstance(node, list):
            for item in node:
                walk(item)

    walk(spec)
    add_missing_discriminators(spec)

    # A material with nothing assigned means the whole flow region, which is
    # what a single-region car always is and what the panel does not ask for.
    for fluid in (spec.get("materials") or {}).get("fluids") or []:
        ref = fluid.setdefault("topologicalReference", {})
        if not ref.get("entities"):
            ref["entities"] = list(regions)

    if missing_ids:
        raise SpecError(
            "These faces have no STEP entity id, so they cannot be sent to the "
            "solver: " + ", ".join(str(i) for i in sorted(set(missing_ids))[:10])
            + ". Re-upload the geometry.")
    if emptied:
        raise SpecError(
            "Nothing is left assigned to " + ", ".join(sorted(set(emptied))[:3])
            + ": every face it used was removed by the solver's geometry import. "
            "Open that panel and assign the faces again.")
    if dropped:
        shown = ", ".join(f"{i} (STEP {sid}, {a:.2e} m2)" if isinstance(a, (int, float))
                          else f"{i} (STEP {sid})" for i, sid, a in dropped[:5])
        log.warning(
            "  %d face(s) were dropped by SimScale's import and are not in the "
            "run: %s%s", len(dropped), shown,
            ", ..." if len(dropped) > 5 else "")
    return spec


# ── SimScale REST, for the parts the SDK does not cover ──────────────────────
def api_post(base, project_id, key, path, body, timeout=60, params=None):
    """POST to the project API.

    `params` is the query string, and it matters: several SimScale endpoints
    take their arguments there rather than in the body. Starting a mesh
    operation is one, and sending its simulationId as JSON instead left the
    operation sitting in READY forever while the worker polled it and reported
    "Meshing 0%" until the run timed out. Found on 11 Sep 2026.
    """
    resp = requests.post(
        f"{base}/projects/{project_id}/{path}",
        headers={"X-API-KEY": key, "Content-Type": "application/json"},
        params=params, json=body, timeout=timeout)
    return resp


def api_put(base, project_id, key, path, body, timeout=60, params=None):
    resp = requests.put(
        f"{base}/projects/{project_id}/{path}",
        headers={"X-API-KEY": key, "Content-Type": "application/json"},
        params=params, json=body, timeout=timeout)
    return resp


def attach_mesh(base, project_id, key, simulation_id, mesh_id):
    """Put the finished mesh on the simulation.

    A mesh that exists and a simulation that knows about it are two different
    things. SimScale keeps `meshId` on the simulation, and nothing sets it when
    the mesh operation finishes: the operation and the simulation only ever met
    through the `simulationId` passed to start, which tells the mesher what to
    mesh and does not tell the simulation what it was meshed with.

    Without this the setup check answers "meshId is mandatory for
    INCOMPRESSIBLE analysis type" even though the mesh finished a second
    earlier, and the solver would refuse to start for the same reason. Run 9 on
    11 Sep 2026 meshed to 95%, finished, and died here.
    """
    got = api_get(base, project_id, key, f"simulations/{simulation_id}")
    if got.status_code >= 400:
        raise SpecError("Could not read the simulation back to attach the mesh. "
                        + readable_api_error(got.text))
    spec = got.json()
    spec["meshId"] = mesh_id
    put = api_put(base, project_id, key, f"simulations/{simulation_id}", spec)
    if put.status_code >= 400:
        log.error("  attach refused, raw body: %s", put.text[:1000])
        raise SpecError("Could not attach the mesh to the simulation. "
                        + readable_api_error(put.text))
    return spec


def api_get(base, project_id, key, path, timeout=60):
    return requests.get(
        f"{base}/projects/{project_id}/{path}",
        headers={"X-API-KEY": key}, timeout=timeout)


def check_setup(base, project_id, key, simulation_id):
    """SimScale's own validation, before any meshing.

    This runs before a single core-hour is spent, which is exactly why the
    refund rule draws its line here: a setup SimScale refuses has cost
    nothing, so the whole charge goes back.
    """
    resp = api_post(base, project_id, key, f"simulations/{simulation_id}/check", {})
    if resp.status_code >= 400:
        raise SpecError(f"The solver could not check this setup: {resp.text[:300]}")
    body = resp.json() if resp.content else {}
    errors = []
    for entry in body.get("entries", []) or []:
        if str(entry.get("severity", "")).upper() in ("ERROR", "CRITICAL"):
            errors.append(entry.get("message") or str(entry))
    if errors:
        raise SpecError("; ".join(errors[:6]))
    return body


def first_error_in_event_log(base, project_id, key, path):
    """The first ERROR SimScale logged, as a sentence.

    A failed mesh reports "FAILED" and nothing else on the operation itself;
    the reason is in the event log, and it is usually excellent. For the car in
    the first end-to-end runs it read: "The mesh could not be generated on the
    following entities B1_TE495 ... increase the mesh fineness in problematic
    areas". Showing "Meshing failed." instead of that is throwing away the only
    part of the failure a user could act on.
    """
    try:
        resp = api_get(base, project_id, key, path)
        if resp.status_code >= 400:
            return None
        data = resp.json()
        entries = data.get("entries") or data.get("events") or []
        for e in entries:
            if str(e.get("severity", "")).upper() in ("ERROR", "CRITICAL"):
                message = str(e.get("message") or "").strip()
                if message:
                    return message
        for e in entries:
            message = str(e.get("message") or "").strip()
            if message:
                return message
    except Exception as err:
        log.warning("could not read the event log at %s: %s", path, err)
    return None


def save_event_log(base, project_id, key, path, dest_prefix, name, upload):
    """Keep SimScale's own log beside the result.

    When a mesh fails, its reason is in this log and nowhere else. Fetching
    it at the moment of failure is the difference between a support message
    saying "meshing failed" and one saying which face is self-intersecting.
    """
    try:
        resp = api_get(base, project_id, key, path)
        if resp.status_code < 400:
            local = f"/tmp/{name}"
            with open(local, "w", encoding="utf-8") as fh:
                fh.write(resp.text)
            upload(local, f"{dest_prefix}/logs/{name}", "application/json")
            return f"{dest_prefix}/logs/{name}"
    except Exception as e:
        log.warning("could not save %s: %s", name, e)
    return None


# ── results ──────────────────────────────────────────────────────────────────
def latest_timestep(pvd_text):
    """The last written timestep in a ParaView collection file.

    By its timestep attribute, never by file size. The old exporter picked
    the largest file in the archive, and since every write of a converged
    solution is nearly the same size it landed on whichever the zip happened
    to order first, which is usually an early iteration. A team then read a
    drag number from a solution that had not converged and had no way to tell.
    """
    import re
    best = None
    for match in re.finditer(
            r'<DataSet\b[^>]*timestep="([-\d.eE+]+)"[^>]*file="([^"]+)"', pvd_text):
        try:
            t = float(match.group(1))
        except ValueError:
            continue
        if best is None or t > best[0]:
            best = (t, match.group(2))
    if best is None:
        # Some writers put file before timestep. One more pass the other way
        # round before giving up.
        for match in re.finditer(
                r'<DataSet\b[^>]*file="([^"]+)"[^>]*timestep="([-\d.eE+]+)"', pvd_text):
            try:
                t = float(match.group(2))
            except ValueError:
                continue
            if best is None or t > best[0]:
                best = (t, match.group(1))
    return best


def downsample(rows, limit=2000):
    """At most `limit` points, keeping the first and the last.

    A 3000 iteration run writes 3000 residual points per variable and a
    browser chart cannot show more than a couple of thousand pixels wide.
    The last point matters most, so it is kept explicitly rather than left to
    the stride.
    """
    if len(rows) <= limit:
        return rows
    step = len(rows) / float(limit - 1)
    picked = [rows[int(i * step)] for i in range(limit - 1)]
    picked.append(rows[-1])
    return picked
