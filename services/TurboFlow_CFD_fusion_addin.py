"""
TurboFlow CFD — Fusion 360 Script
Prepares wind-tunnel geometry and uploads a CFD job to TurboFlow on "Run & Upload".
"""
import adsk.core, adsk.fusion, adsk.cam, traceback

# ─── TurboFlow connection ─────────────────────────────────────────────────────
# Paste a connection token below, or into the dialog's "Account" section for a
# one-off. Create one on the Simulations page of turboflow.cloud.
#
# This used to hold a Firebase refresh token copied from the website. That was
# the credential for the whole account: it granted everything the account could
# do, never expired, and could not be revoked — and it lived here in plain text
# inside a file people share with their team. A connection token can be revoked
# from the website, and the session it produces may submit jobs and nothing else.
FIREBASE_PROJECT = "turboflow-7b3ca"
STORAGE_BUCKET   = "turboflow-7b3ca.firebasestorage.app"
FIREBASE_API_KEY = "AIzaSyC9YRhpugT6eIG0PY7O8EaPcB8re7SCoFA"
FUNCTIONS_BASE   = "https://us-central1-turboflow-7b3ca.cloudfunctions.net"
CONNECTION_TOKEN = ""

_app      = None
_ui       = None
_handlers = []
_result_msg = [None]   # completion dialog text — shown in the destroy handler

CMD_ID   = "turboflowCFDPrep"
CMD_NAME = "TurboFlow CFD"


# ─── Small UI helpers ─────────────────────────────────────────────────────────

def _group(inputs, id_, title):
    """Titled, expanded-by-default group box. Returns its child input collection."""
    g = inputs.addGroupCommandInput(id_, title)
    g.isExpanded = True
    return g.children

def _hint(inputs, id_, text):
    """Single-line grey hint beneath a field."""
    html = "<span style='font-size:10px;color:#888888'>" + text + "</span>"
    inputs.addTextBoxCommandInput(id_, "", html, 1, True)


# ─── Cost card HTML (Fusion-safe inline styles only) ─────────────────────────

def _refine_to_fineness(level):
    """Level 1-5 → SimScale fineness 9.0-10.0"""
    return 9.0 + (max(1, min(5, level)) - 1) * 0.25

def _estimate_cost(level, iters, debug=False):
    """Local UX estimate only — real cost calculated and enforced in Cloud Function.
    level 1 = 100cr/1000iter, level 5 = 200cr/1000iter, linear."""
    if debug:
        return 1  # debug is near-free
    cr_per_1000 = 100 + (max(1, min(5, level)) - 1) * 25
    return max(1, round(cr_per_1000 * max(1, min(3000, iters)) / 1000))

def _cost_html(level, iters, debug=False):
    cost = _estimate_cost(level, iters, debug)
    fineness = 1.0 if debug else _refine_to_fineness(level)
    if cost < 100:
        tier_text = "Low"
    elif cost < 175:
        tier_text = "Medium"
    else:
        tier_text = "High"
    return (
        "~" + str(cost) + " credits (estimate)  |  " + tier_text
        + "\nFineness " + str(fineness) + "  x  " + str(iters) + " iterations"
        + "\nFinal cost charged by server"
    )


# ─── Entry / exit ─────────────────────────────────────────────────────────────

def run(context):
    global _app, _ui, _handlers
    try:
        _app = adsk.core.Application.get()
        _ui  = _app.userInterface

        old = _ui.commandDefinitions.itemById(CMD_ID)
        if old:
            old.deleteMe()

        cmdDef = _ui.commandDefinitions.addButtonDefinition(
            CMD_ID, CMD_NAME,
            "Prepare geometry and upload CFD job to TurboFlow.")

        on_created = _CreatedHandler()
        cmdDef.commandCreated.add(on_created)
        _handlers.append(on_created)

        adsk.autoTerminate(False)
        cmdDef.execute()

    except:
        if _ui:
            _ui.messageBox("Startup error:\n" + traceback.format_exc())


def stop(context):
    global _handlers
    try:
        if _ui:
            old = _ui.commandDefinitions.itemById(CMD_ID)
            if old:
                old.deleteMe()
    except:
        pass
    _handlers.clear()


# ─── CommandCreated — builds the panel ────────────────────────────────────────

class _CreatedHandler(adsk.core.CommandCreatedEventHandler):
    def notify(self, args):
        try:
            cmd    = args.command
            inputs = cmd.commandInputs

            cmd.okButtonText     = "Run & Upload"
            cmd.cancelButtonText = "Cancel"

            # Open wide and tall enough that every group shows expanded, no scroll
            try:
                cmd.setDialogMinimumSize(460, 560)
                cmd.setDialogInitialSize(460, 760)
            except Exception:
                pass

            # ── Flow Conditions ────────────────────────────────────────────
            flow = _group(inputs, "grp_flow", "Flow Conditions")
            flow.addValueInput(
                "inlet_velocity", "Wind speed", "m/s",
                adsk.core.ValueInput.createByReal(2000.0))   # 20 m/s
            flow.addValueInput(
                "wheel_radius", "Wheel radius", "mm",
                adsk.core.ValueInput.createByReal(1.4125))   # 14.125 mm
            flow.addBoolValueInput(
                "surface_refine", "Surface refinement", True, "", True)
            _hint(flow, "hint_refine", "Adds boundary-layer cells for accurate drag")

            # ── Mesh & Solver ──────────────────────────────────────────────
            mesh = _group(inputs, "grp_mesh", "Mesh & Solver")
            mesh.addValueInput(
                "iter_count", "Iterations", "",
                adsk.core.ValueInput.createByReal(1000.0))
            _hint(mesh, "hint_iter", "500 quick  /  1000 standard  /  3000 fine")
            debug_dd = mesh.addDropDownCommandInput(
                "debug_mesh", "Debug mode",
                adsk.core.DropDownStyles.TextListDropDownStyle)
            debug_dd.listItems.add("Off", True, "")
            debug_dd.listItems.add("On  (overrides refinement — 0.1M cells, fineness 1)", False, "")
            _hint(mesh, "hint_debug", "Fast test only — ignores refinement level below")
            refine_dd = mesh.addDropDownCommandInput(
                "refine_level", "Refinement level",
                adsk.core.DropDownStyles.TextListDropDownStyle)
            refine_dd.listItems.add("1 - Standard (Recommended)", True, "")
            refine_dd.listItems.add("2 - High", False, "")
            refine_dd.listItems.add("3 - Very High", False, "")
            refine_dd.listItems.add("4 - Extreme", False, "")
            refine_dd.listItems.add("5 - Maximum (Not recommended)", False, "")
            _hint(mesh, "hint_refine_lvl", "Level 1 suits standard CFD. Higher levels increase cost significantly.")

            # ── Cost Estimate ──────────────────────────────────────────────
            cost = _group(inputs, "grp_cost", "Cost Estimate")
            cost.addTextBoxCommandInput("cost_preview", "", _cost_html(1, 1000), 3, True)
            _hint(cost, "hint_cost", "Deducted on successful upload")

            # ── Wind-Tunnel Domain ─────────────────────────────────────────
            dom = _group(inputs, "grp_domain", "Wind-Tunnel Domain")
            _hint(dom, "hint_domain_sub", "Offsets from the car bounding box")
            dom.addValueInput(
                "off_upstream", "Upstream", "m",
                adsk.core.ValueInput.createByReal(150.0))    # 1.5 m
            dom.addValueInput(
                "off_downstream", "Downstream", "m",
                adsk.core.ValueInput.createByReal(50.0))     # 0.5 m
            dom.addValueInput(
                "off_side", "Side", "m",
                adsk.core.ValueInput.createByReal(30.0))     # 0.3 m
            dom.addValueInput(
                "off_top", "Top", "m",
                adsk.core.ValueInput.createByReal(30.0))     # 0.3 m

            # ── Output ─────────────────────────────────────────────────────
            out = _group(inputs, "grp_output", "Output")
            out.addStringValueInput("export_dir", "Export folder", "~/Desktop")
            out.addBoolValueInput(
                "keep_local", "Keep local files after upload", True, "", True)

            # ── Account ────────────────────────────────────────────────────
            acct = _group(inputs, "grp_account", "Account")
            _hint(acct, "hint_token",
                  "Paste a connection token to upload as a different account. "
                  "Leave blank to use the saved default. Create one on the "
                  "Simulations page at turboflow.cloud.")
            acct.addStringValueInput("refresh_token", "Connection token", "")

            # ── Register remaining handlers ────────────────────────────────
            on_change  = _InputChangedHandler()
            on_exec    = _ExecuteHandler()
            on_destroy = _DestroyHandler()

            cmd.inputChanged.add(on_change)
            cmd.execute.add(on_exec)
            cmd.destroy.add(on_destroy)

            _handlers.extend([on_change, on_exec, on_destroy])

        except:
            if _ui:
                _ui.messageBox("Panel build error:\n" + traceback.format_exc())


# ─── InputChanged — live cost refresh ─────────────────────────────────────────

class _InputChangedHandler(adsk.core.InputChangedEventHandler):
    def notify(self, args):
        try:
            inputs    = args.inputs
            refine_in = inputs.itemById("refine_level")
            debug_in  = inputs.itemById("debug_mesh")
            iters_in  = inputs.itemById("iter_count")
            cost_box  = inputs.itemById("cost_preview")
            if not (refine_in and iters_in and cost_box):
                return
            level = refine_in.selectedItem.index + 1   # 1-5
            debug = (debug_in.selectedItem.index == 1) if debug_in else False
            iters = int(round(iters_in.value))
            cost_box.text = _cost_html(level, iters, debug)
        except:
            pass   # silent — don't interrupt typing


# ─── CommandExecute — full pipeline ───────────────────────────────────────────

class _ExecuteHandler(adsk.core.CommandEventHandler):
    def notify(self, args):
        try:
            import os, csv, re

            app    = adsk.core.Application.get()
            ui     = app.userInterface
            design = adsk.fusion.Design.cast(app.activeProduct)
            root   = design.rootComponent
            inputs = args.command.commandInputs

            # ── Read inputs (Fusion stores lengths in cm, speeds in cm/s) ──
            up_cm        = inputs.itemById("off_upstream").value
            dn_cm        = inputs.itemById("off_downstream").value
            si_cm        = inputs.itemById("off_side").value
            top_cm       = inputs.itemById("off_top").value
            vel_cms      = inputs.itemById("inlet_velocity").value
            wr_cm        = inputs.itemById("wheel_radius").value
            iter_raw     = int(round(inputs.itemById("iter_count").value))
            iter_count   = max(1,   min(3000, iter_raw))
            refine_level = inputs.itemById("refine_level").selectedItem.index + 1  # 1-5
            debug_mesh   = inputs.itemById("debug_mesh").selectedItem.index == 1
            
            # mesh_cells_m calculation removed -- logic now handled via refine_level on backend

            export_dir   = inputs.itemById("export_dir").value.strip() or "~/Desktop"
            keep_local   = inputs.itemById("keep_local").value
            token_override = inputs.itemById("refresh_token").value.strip()

            # ── Convert to metres ───────────────────────────────────────────
            off_upstream   = max(0.5,  min(50.0,  up_cm  / 100.0))
            off_downstream = max(0.5,  min(50.0,  dn_cm  / 100.0))
            off_side       = max(0.1,  min(10.0,  si_cm  / 100.0))
            off_top        = max(0.1,  min(10.0,  top_cm / 100.0))
            inlet_velocity = max(1.0,  min(100.0, vel_cms / 100.0))
            wheel_radius_m = max(0.001,min(1.0,   wr_cm  / 100.0))

            def cm2m(v): return v / 100.0

            # ── Collect VISIBLE, non-tiny bodies from the user's design (READ-ONLY) ──
            allBodies = [b for comp in design.allComponents
                           for b in comp.bRepBodies
                           if b.isVisible and b.volume >= 0.00000001]
            if not allBodies:
                _result_msg[0] = ("No visible bodies (>= ~10 cm3) found in the design.")
                return

            # ── Detect wheels (cylindrical faces, axis ~Y, radius ~ wheel_radius) ──
            wheel_data = {}
            for body in allBodies:
                for face in body.faces:
                    geom = face.geometry
                    if not isinstance(geom, adsk.core.Cylinder):
                        continue
                    r   = geom.radius
                    tol = wr_cm * 0.08
                    if not (wr_cm - tol <= r <= wr_cm + tol):
                        continue
                    ax = geom.axis
                    if abs(abs(ax.y) - 1.0) > 0.05:
                        continue
                    o   = geom.origin
                    key = (round(o.x/100, 3), round(o.y/100, 3), round(o.z/100, 3))
                    if key not in wheel_data:
                        wheel_data[key] = {
                            "cx_m":     round(o.x/100, 6),
                            "cy_m":     round(o.y/100, 6),
                            "cz_m":     round(o.z/100, 6),
                            "radius_m": round(r/100,   6),
                        }

            # ── Compute domain extents (READ-ONLY) ──────────────────────────
            minX = min(b.boundingBox.minPoint.x for b in allBodies)
            maxX = max(b.boundingBox.maxPoint.x for b in allBodies)
            minY = min(b.boundingBox.minPoint.y for b in allBodies)
            minZ = min(b.boundingBox.minPoint.z for b in allBodies)
            maxZ = max(b.boundingBox.maxPoint.z for b in allBodies)

            domMinX = minX - up_cm
            domMaxX = maxX + dn_cm
            domMinY = minY - si_cm
            domMaxY = 0.0
            if wheel_data:
                wb      = min((w["cz_m"]*100) - (w["radius_m"]*100)
                              for w in wheel_data.values())
                domMinZ = wb - 0.03
            else:
                domMinZ = minZ
            domMaxZ = maxZ + top_cm

            domain_m = {
                "inlet_x":    cm2m(domMaxX), "outlet_x":   cm2m(domMinX),
                "ground_z":   cm2m(domMinZ), "top_z":      cm2m(domMaxZ),
                "side_y":     cm2m(domMinY), "symmetry_y": cm2m(domMaxY),
            }

            bW = domMaxX - domMinX
            bD = abs(domMaxY - domMinY)
            bH = domMaxZ - domMinZ

            # ── Copy bodies to document-independent BRep + classify car vs wheel ──
            tempMgr = adsk.fusion.TemporaryBRepManager.get()

            def _body_is_wheel(body):
                for face in body.faces:
                    geom = face.geometry
                    if not isinstance(geom, adsk.core.Cylinder): continue
                    r   = geom.radius
                    tol = wr_cm * 0.08
                    if not (wr_cm - tol <= r <= wr_cm + tol): continue
                    ax = geom.axis
                    if abs(abs(ax.y) - 1.0) > 0.05: continue
                    return True
                return False

            carBReps   = []
            wheelBReps = []
            for b in allBodies:
                try:
                    t = tempMgr.copy(b)
                    if not t: continue
                    if _body_is_wheel(b): wheelBReps.append(t)
                    else:                 carBReps.append(t)
                except: pass

            if not carBReps and not wheelBReps:
                _result_msg[0] = ("Could not copy visible bodies — cannot proceed.")
                return

            flowBRep = tempMgr.createBox(adsk.core.OrientedBoundingBox3D.create(
                adsk.core.Point3D.create(domMinX + bW/2, domMinY + bD/2, domMinZ + bH/2),
                adsk.core.Vector3D.create(1, 0, 0),
                adsk.core.Vector3D.create(0, 1, 0),
                bW, bD, bH))

            raw_name  = (design.rootComponent.name or "design")
            safe_name = re.sub(r"[^\w\-]", "_", raw_name)
            export_dir_exp = "Desktop"
            os.makedirs(export_dir_exp, exist_ok=True)
            stepPath  = os.path.join(export_dir_exp, safe_name + "_CFD.step")
            labelPath = os.path.join(export_dir_exp, safe_name + "_entity_labels.csv")

            # ── Rebuild + boolean-cut + export in a THROWAWAY document ───────
            #    The user's active design is NEVER modified, so Fusion has nothing
            #    to clean up when the script exits. That teardown of a modified
            #    active design is what a recent Fusion update started crashing on.
            work_doc = app.documents.add(adsk.core.DocumentTypes.FusionDesignDocumentType)
            try:
                work_design = adsk.fusion.Design.cast(app.activeProduct)
                work_design.designType = adsk.fusion.DesignTypes.DirectDesignType
                work_root = work_design.rootComponent

                flowBody = work_root.bRepBodies.add(flowBRep)
                flowBody.name = "FlowRegion_CFD_Temp"

                copiedCar = []
                for t in carBReps:
                    try:
                        added = work_root.bRepBodies.add(t)
                        if added: copiedCar.append(added)
                    except: pass
                copiedWheels = []
                for t in wheelBReps:
                    try:
                        added = work_root.bRepBodies.add(t)
                        if added: copiedWheels.append(added)
                    except: pass

                # Join car bodies into one solid (wheels kept separate for labelling)
                if copiedCar:
                    carSolid = copiedCar[0]
                    carSolid.name = "CarSolid_CFD_Temp"
                    for extra in copiedCar[1:]:
                        try:
                            joinTools = adsk.core.ObjectCollection.create()
                            joinTools.add(extra)
                            ci_join = work_root.features.combineFeatures.createInput(carSolid, joinTools)
                            ci_join.operation = adsk.fusion.FeatureOperations.JoinFeatureOperation
                            ci_join.isKeepToolBodies = False
                            work_root.features.combineFeatures.add(ci_join)
                            found = next((b for b in work_root.bRepBodies if b.name == "CarSolid_CFD_Temp"), None)
                            if found: carSolid = found
                        except Exception as e:
                            _result_msg[0] = ("Car join step failed: " + str(e))
                            return

                # Cut the flow box with the car solid + each wheel
                tools = adsk.core.ObjectCollection.create()
                if copiedCar:
                    tools.add(carSolid)
                for wbdy in copiedWheels:
                    tools.add(wbdy)
                ci = work_root.features.combineFeatures.createInput(flowBody, tools)
                ci.operation = adsk.fusion.FeatureOperations.CutFeatureOperation
                work_root.features.combineFeatures.add(ci)

                # Largest remaining body = external flow region
                candidateBodies = [b for b in work_root.bRepBodies if b.isVisible]
                if not candidateBodies:
                    candidateBodies = list(work_root.bRepBodies)
                if candidateBodies:
                    mainFlowBody = max(candidateBodies, key=lambda b: b.volume)
                    mainFlowBody.name = "FlowRegion_CFD"
                    for b in candidateBodies:
                        if b != mainFlowBody:
                            try: b.isVisible = False
                            except: pass

                work_design.exportManager.execute(
                    work_design.exportManager.createSTEPExportOptions(stepPath))
            finally:
                try: work_doc.close(False)
                except: pass

            # ── Parse STEP + classify faces ─────────────────────────────────
            DOMAIN_TOL = 0.05
            MIN_SPAN   = 0.30

            with open(stepPath, "r", encoding="utf-8", errors="ignore") as f:
                step_content = f.read()

            entity_map = {}
            for m in re.finditer(r"#(\d+)\s*=\s*(.+?)(?=\n#|\nENDSEC|$)",
                                  step_content, re.DOTALL):
                entity_map[int(m.group(1))] = m.group(2).strip().rstrip(";")

            step_pts = {}
            for eid, bs in entity_map.items():
                if bs.startswith("CARTESIAN_POINT"):
                    pm = re.search(
                        r"\(\s*'[^']*'\s*,\s*\(\s*([\d\.\+\-Ee]+)\s*,"
                        r"\s*([\d\.\+\-Ee]+)\s*,\s*([\d\.\+\-Ee]+)", bs)
                    if pm:
                        step_pts[eid] = (
                            float(pm.group(1)),
                            float(pm.group(2)),
                            float(pm.group(3)))

            def collect_pts(sid, depth=0, visited=None):
                if visited is None: visited = set()
                if depth > 12 or sid in visited: return []
                visited.add(sid)
                if sid in step_pts: return [step_pts[sid]]
                pts = []
                for ref in re.findall(r"#(\d+)", entity_map.get(sid, "")):
                    pts.extend(collect_pts(int(ref), depth+1, visited))
                return pts

            def match_wheel(cx, cy, cz):
                for w in wheel_data.values():
                    if (abs(cx - w["cx_m"]) < 0.01 and
                        abs(cy - w["cy_m"]) < 0.01 and
                        abs(cz - w["cz_m"]) < 0.01):
                        return w
                return None

            def classify(fid):
                bs  = entity_map.get(fid, "")
                sm  = re.search(
                    r"ADVANCED_FACE\s*\(\s*'[^']*'\s*,\s*\([^)]+\)\s*,\s*#(\d+)", bs)
                if not sm: return ("car_no_slip", "", "", "", "")
                surf = entity_map.get(int(sm.group(1)), "")

                if surf.startswith("CYLINDRICAL_SURFACE"):
                    rm = re.search(
                        r"CYLINDRICAL_SURFACE\s*\(\s*'[^']*'\s*,\s*#(\d+)\s*,"
                        r"\s*[\d\.Ee\+\-]+", surf)
                    if rm:
                        ab  = entity_map.get(int(rm.group(1)), "")
                        apm = re.search(
                            r"AXIS2_PLACEMENT_3D\s*\(\s*'[^']*'\s*,\s*#(\d+)", ab)
                        if apm:
                            pt = step_pts.get(int(apm.group(1)))
                            if pt:
                                w = match_wheel(
                                    pt[0]/1000, pt[1]/1000, pt[2]/1000)
                                if w:
                                    return ("rotating_wall",
                                            w["radius_m"],
                                            w["cx_m"], w["cy_m"], w["cz_m"])

                if surf.startswith("PLANE"):
                    pts = collect_pts(fid)
                    if not pts: return ("car_no_slip", "", "", "", "")
                    sx = (max(p[0] for p in pts) - min(p[0] for p in pts)) / 1000
                    sy = (max(p[1] for p in pts) - min(p[1] for p in pts)) / 1000
                    sz = (max(p[2] for p in pts) - min(p[2] for p in pts)) / 1000
                    if max(sx, sy, sz) < MIN_SPAN:
                        return ("car_no_slip", "", "", "", "")
                    cx = sum(p[0] for p in pts) / len(pts) / 1000
                    cy = sum(p[1] for p in pts) / len(pts) / 1000
                    cz = sum(p[2] for p in pts) / len(pts) / 1000
                    dm = domain_m
                    if abs(cx - dm["inlet_x"])    < DOMAIN_TOL: return ("inlet",    "", "", "", "")
                    if abs(cx - dm["outlet_x"])   < DOMAIN_TOL: return ("outlet",   "", "", "", "")
                    if abs(cz - dm["top_z"])      < DOMAIN_TOL: return ("top",      "", "", "", "")
                    if abs(cy - dm["side_y"])     < DOMAIN_TOL: return ("side",     "", "", "", "")
                    if (abs(cy - dm["symmetry_y"]) < DOMAIN_TOL
                            and sx > MIN_SPAN and sz > MIN_SPAN):
                        return ("symmetry", "", "", "", "")
                    if (abs(cz - dm["ground_z"])  < DOMAIN_TOL
                            and sx > MIN_SPAN and sy > MIN_SPAN):
                        return ("ground",   "", "", "", "")

                return ("car_no_slip", "", "", "", "")

            face_ids = sorted(
                e for e, b in entity_map.items() if b.startswith("ADVANCED_FACE"))

            label_rows   = []
            label_counts = {}
            for fid in face_ids:
                row = classify(fid)
                label_rows.append((fid,) + row)
                label_counts[row[0]] = label_counts.get(row[0], 0) + 1

            with open(labelPath, "w", newline="") as f:
                w = csv.writer(f)
                w.writerow(["step_entity_id", "label",
                            "radius_m", "cx_m", "cy_m", "cz_m"])
                for row in label_rows:
                    w.writerow(row)

            label_summary = "\n".join(
                "  " + k + ": " + str(v)
                for k, v in sorted(label_counts.items()))

            # ── Firebase upload ─────────────────────────────────────────────
            try: adsk.doEvents()   # flush modeling/graphics events before teardown
            except: pass
            import urllib.request, urllib.error, urllib.parse
            import json as _json, uuid, datetime, base64 as _b64

            # The token is defined at the top of this file; the dialog's Account
            # field can override it for a single run.
            active_token = token_override or CONNECTION_TOKEN
            if not active_token:
                _result_msg[0] = (
                    "No connection token.\n\n"
                    "Create one on the Simulations page at turboflow.cloud, then "
                    "paste it into the Account section of this dialog.")
                return

            def _post_json(url, payload, headers=None):
                req = urllib.request.Request(
                    url, data=_json.dumps(payload).encode(), method="POST")
                req.add_header("Content-Type", "application/json")
                for k, v in (headers or {}).items():
                    req.add_header(k, v)
                with urllib.request.urlopen(req) as r:
                    return _json.loads(r.read())

            def get_access_token():
                """Turn the connection token into a short-lived session.

                Two steps: the token is exchanged for a Firebase custom token,
                which is then exchanged for an ID token. The connection token
                itself never becomes a session credential, so revoking it on the
                website takes effect on the next run.
                """
                try:
                    minted = _post_json(
                        FUNCTIONS_BASE + "/exchangeFusionToken", {"token": active_token})
                except urllib.error.HTTPError as e:
                    detail = e.read().decode("utf-8", errors="replace")[:200]
                    raise RuntimeError(
                        "That connection token was not accepted. Create a new one on "
                        "the Simulations page at turboflow.cloud.\n\n" + detail)
                signed = _post_json(
                    "https://identitytoolkit.googleapis.com/v1/accounts:signInWithCustomToken"
                    "?key=" + FIREBASE_API_KEY,
                    {"token": minted["custom_token"], "returnSecureToken": True})
                return signed["idToken"]

            ACCESS_TOKEN = get_access_token()

            def extract_user_id(id_token):
                try:
                    payload_b64  = id_token.split(".")[1]
                    payload_b64 += "=" * (4 - len(payload_b64) % 4)
                    payload      = _json.loads(_b64.urlsafe_b64decode(payload_b64))
                    return payload.get("user_id") or payload.get("sub", "unknown")
                except Exception:
                    return "unknown"

            USER_ID = extract_user_id(ACCESS_TOKEN)

            def fs_get(collection, doc_id):
                url = ("https://firestore.googleapis.com/v1/projects/"
                       + FIREBASE_PROJECT
                       + "/databases/(default)/documents/"
                       + collection + "/" + doc_id)
                req = urllib.request.Request(url, method="GET")
                req.add_header("Authorization", "Bearer " + ACCESS_TOKEN)
                with urllib.request.urlopen(req) as r:
                    return _json.loads(r.read())

            try:
                user_doc = fs_get("users", USER_ID)
                fields   = user_doc.get("fields", {})
                credits  = int(fields.get("credits", {}).get("integerValue", 0))
            except Exception as e:
                _result_msg[0] = ("Could not check credits:\n" + str(e) + "\n\nAborting.")
                return

            # Active unlimited pass → simulations are free, so skip the credit gate.
            has_unlimited = False
            # unlimited_until is the backend's name for it; unlimitedUntil is
            # the old site's, kept so this still reads an account that has not
            # been converted yet.
            uu = (fields.get("unlimited_until", {}).get("timestampValue")
                  or fields.get("unlimitedUntil", {}).get("timestampValue"))
            if uu:
                try:
                    iso = re.sub(r"\.\d+", "", uu).replace("Z", "+00:00")
                    has_unlimited = datetime.datetime.fromisoformat(iso) > datetime.datetime.now(datetime.timezone.utc)
                except Exception:
                    has_unlimited = False

            # Cost is calculated server-side in Cloud Function — not sent from Fusion
            job_cost = _estimate_cost(refine_level, iter_count, debug_mesh)  # local display only

            if not has_unlimited and credits < job_cost:
                _result_msg[0] = (
                    "Insufficient credits\n\n"
                    "Balance:  " + str(credits) + " credit" + ("s" if credits != 1 else "") + "\n"
                    "Job cost: " + str(job_cost) + " credits\n"
                    "          (" + str(iter_count) + " iters  x  "
                    + ("debug 0.1M" if debug_mesh else "level " + str(refine_level)) + ")\n\n"
                    "Top up at:  turboflow-7b3ca.web.app  >  Billing")
                return

            job_id = str(uuid.uuid4())

            def fb_upload(local, remote):
                with open(local, "rb") as fh:
                    data = fh.read()
                url = ("https://firebasestorage.googleapis.com/v0/b/"
                       + STORAGE_BUCKET
                       + "/o?uploadType=media&name="
                       + urllib.parse.quote(remote, safe=""))
                req = urllib.request.Request(url, data=data, method="POST")
                req.add_header("Content-Type",  "application/octet-stream")
                req.add_header("Authorization", "Bearer " + ACCESS_TOKEN)
                with urllib.request.urlopen(req) as r:
                    return _json.loads(r.read())

            def fs_write(collection, doc_id, doc_fields):
                def fv(v):
                    if isinstance(v, str):   return {"stringValue": v}
                    if isinstance(v, bool):  return {"booleanValue": v}
                    if isinstance(v, int):   return {"integerValue": str(v)}
                    if isinstance(v, float): return {"doubleValue": v}
                    return {"stringValue": str(v)}
                body = {"fields": {k: fv(v) for k, v in doc_fields.items()}}
                url  = ("https://firestore.googleapis.com/v1/projects/"
                        + FIREBASE_PROJECT
                        + "/databases/(default)/documents/"
                        + collection + "/" + doc_id)
                req  = urllib.request.Request(
                    url, data=_json.dumps(body).encode(), method="PATCH")
                req.add_header("Content-Type",  "application/json")
                req.add_header("Authorization", "Bearer " + ACCESS_TOKEN)
                with urllib.request.urlopen(req) as r:
                    return _json.loads(r.read())

            step_remote  = "jobs/" + job_id + "/geometry.step"
            label_remote = "jobs/" + job_id + "/entity_labels.csv"

            try:
                fb_upload(stepPath,  step_remote)
                fb_upload(labelPath, label_remote)
                fs_write("jobs", job_id, {
                    "status":            "pending",
                    "jobId":             job_id,
                    "userId":            USER_ID,
                    "stepPath":          step_remote,
                    "labelPath":         label_remote,
                    "bucket":            STORAGE_BUCKET,
                    "createdAt":         datetime.datetime.utcnow().isoformat() + "Z",
                    "faceCount":         len(face_ids),
                    "wheelCount":        len(wheel_data),
                    "inletVelocity":     inlet_velocity,
                    "iterationCount":    iter_count,
                    "refineLevel":       refine_level if not debug_mesh else 0,
                    "debugMesh":         debug_mesh,
                    "surfaceRefinement": True,
                    "bbox_upstream_m":   off_upstream,
                    "bbox_downstream_m": off_downstream,
                    "bbox_side_m":       off_side,
                    "bbox_top_m":        off_top,
                    "domain_inlet_x":    domain_m["inlet_x"],
                    "domain_outlet_x":   domain_m["outlet_x"],
                    "domain_ground_z":   domain_m["ground_z"],
                    "domain_top_z":      domain_m["top_z"],
                    "domain_side_y":     domain_m["side_y"],
                    "domain_symmetry_y": domain_m["symmetry_y"],
                })

                # Persist a pasted token so future runs default to it. Only
                # after a successful upload, and only if one was pasted.
                token_saved = False
                if token_override and token_override != CONNECTION_TOKEN:
                    try:
                        _self = globals().get("__file__")
                        if _self:
                            with open(_self, "r", encoding="utf-8") as fh:
                                _src = fh.read()
                            _new = re.sub(
                                r'CONNECTION_TOKEN = "[^"]*"',
                                lambda m: 'CONNECTION_TOKEN = "' + token_override + '"',
                                _src, count=1)
                            if _new != _src:
                                with open(_self, "w", encoding="utf-8") as fh:
                                    fh.write(_new)
                                globals()["CONNECTION_TOKEN"] = token_override
                                token_saved = True
                    except Exception:
                        pass

                if not keep_local:
                    try: os.remove(stepPath)
                    except: pass
                    try: os.remove(labelPath)
                    except: pass
                    file_note = "Local files removed (keep local = off)"
                else:
                    file_note = "STEP   " + stepPath + "\nLabels " + labelPath

                _result_msg[0] = (
                    "Job queued successfully.\n\n"
                    "Job ID: " + job_id + "\n\n"
                    "--- Domain ---\n"
                    "  Upstream:   " + str(off_upstream)   + " m\n"
                    "  Downstream: " + str(off_downstream) + " m\n"
                    "  Side:       " + str(off_side)       + " m\n"
                    "  Top:        " + str(off_top)        + " m\n\n"
                    "--- Simulation ---\n"
                    "  Wind speed: " + str(inlet_velocity) + " m/s\n"
                    "  Iterations: " + str(iter_count)     + "\n"
                    "  Refinement: " + ("Debug (0.1M)" if debug_mesh else "Level " + str(refine_level) + " (fineness " + str(_refine_to_fineness(refine_level) if not debug_mesh else 1.0) + ")") + "\n"
                    "  Cost:       " + str(job_cost)       + " credits\n\n"
                    "--- Face Labels ---\n"
                    + label_summary + "\n"
                    "  Wheels:      " + str(len(wheel_data)) + "\n"
                    "  Total faces: " + str(len(face_ids))   + "\n\n"
                    + ("Saved token — future runs default to this account.\n\n" if token_saved else "")
                    + "--- Files ---\n"
                    + file_note
                )

            except urllib.error.HTTPError as e:
                _result_msg[0] = (
                    "Upload failed — files saved locally.\n\n"
                    "HTTP " + str(e.code) + ": " + e.reason + "\n"
                    + e.read().decode("utf-8", errors="replace")[:400] + "\n\n"
                    "STEP   " + stepPath + "\n"
                    "Labels " + labelPath)

            except Exception as e:
                _result_msg[0] = (
                    "Upload failed — files saved locally.\n\n"
                    + str(e) + "\n\n"
                    "STEP   " + stepPath + "\n"
                    "Labels " + labelPath)

        except:
            if _ui:
                _result_msg[0] = ("Execution error:\n" + traceback.format_exc())


# ─── CommandDestroy ────────────────────────────────────────────────────────────

class _DestroyHandler(adsk.core.CommandEventHandler):
    def notify(self, args):
        try:
            if _result_msg[0] and _ui:
                _ui.messageBox(_result_msg[0])
        except:
            pass
        _result_msg[0] = None
        # Do NOT call adsk.autoTerminate(True). Recent Fusion builds crash while
        # unloading a script that popped its dialog via cmdDef.execute() — the
        # crash fires in Fusion's own teardown, after this handler returns cleanly.
        # Leaving the script resident (autoTerminate(False), set in run) skips that
        # teardown entirely. run() deletes the stale command def on the next launch,
        # so re-running is safe and nothing meaningful leaks.
        # ponytail: resident script; revisit only if Autodesk fixes the teardown crash.