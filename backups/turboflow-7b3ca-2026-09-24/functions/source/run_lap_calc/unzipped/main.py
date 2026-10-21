import json
import os
import numpy as np
import firebase_admin
from firebase_admin import credentials, firestore
from firebase_functions import https_fn
from firebase_functions.https_fn import Request, Response
from google.cloud.firestore_v1 import SERVER_TIMESTAMP, Increment

# ── Firebase init ──────────────────────────────────────────────────────────────
if not firebase_admin._apps:
    firebase_admin.initialize_app()
db = firestore.client()

LAP_COST = 10

# ── Load full CSV at cold start ────────────────────────────────────────────────
_CSV_PATH = os.path.join(os.path.dirname(__file__), "co2_thrust_data.csv")

def _load_csv():
    t_list, F_list, m_list = [], [], []
    with open(_CSV_PATH) as f:
        header = True
        for line in f:
            if header:
                header = False
                continue
            parts = line.strip().split(",")
            if len(parts) < 7:
                continue
            try:
                t_list.append(float(parts[1]))   # time (s)
                F_list.append(float(parts[5]))   # force (N)
                m_list.append(float(parts[6]))   # mass (kg)
            except (ValueError, IndexError):
                continue
    return np.array(t_list), np.array(F_list), np.array(m_list)

t, F_thrust, m_sheet = _load_csv()


def run_simulation(car_weight_g, drag_force_n, mu_roll, wheel_moi_g_mm2):
    m_car = 0.021 + m_sheet - 0.048 + (car_weight_g / 1000.0)
    N          = len(t)
    I_wheel    = wheel_moi_g_mm2 / 1_000_000_000.0
    r_wheel    = 0.014125
    N_wheels   = 4
    i_max      = N - 1
    dt_default = float(np.mean(np.diff(t)))
    max_steps  = N * 10 + 5000
    v    = np.zeros(max_steps)
    x    = np.zeros(max_steps)
    time = np.zeros(max_steps)
    v[0] = 0.0; x[0] = 0.0; time[0] = t[0]
    i = 1
    while i < max_steps:
        if i <= i_max:
            dt = t[i] - t[i-1]; Fth = F_thrust[i-1]; mass_car = m_car[i-1]
        else:
            dt = dt_default; Fth = 0.0; mass_car = m_car[-1]
        F_fric     = mu_roll * mass_car * 9.81
        F_drag     = drag_force_n * (v[i-1] / 20.0) ** 2
        omega_prev = v[i-2] / r_wheel if i > 1 else v[i-1] / r_wheel
        omega_now  = v[i-1] / r_wheel
        alpha      = (omega_now - omega_prev) / dt
        tau        = I_wheel * alpha
        F_wheel    = (tau / r_wheel) * N_wheels
        F_net      = Fth - F_drag - F_fric - F_wheel
        a          = F_net / mass_car
        v[i]       = max(0.0, v[i-1] + a * dt)
        x[i]       = x[i-1] + v[i-1]*dt + 0.5*a*dt*dt
        time[i]    = time[i-1] + dt
        if x[i] >= 20.0:
            finish_time = time[i-1] + (20.0 - x[i-1]) * (time[i]-time[i-1]) / (x[i]-x[i-1])
            return round(float(finish_time * 0.76), 6)
        if v[i] <= 0.0 and i > i_max:
            raise ValueError("Car stopped before reaching 20 m.")
        i += 1
    raise ValueError("Simulation exceeded maximum steps.")


def _cors(response):
    response.headers["Access-Control-Allow-Origin"]  = "*"
    response.headers["Access-Control-Allow-Methods"] = "POST, OPTIONS"
    response.headers["Access-Control-Allow-Headers"] = "Content-Type, Authorization"
    return response


@https_fn.on_request(region="us-central1")
def run_lap_calc(req: Request) -> Response:
    if req.method == "OPTIONS":
        return _cors(Response("", 204))

    auth_header = req.headers.get("Authorization", "")
    if not auth_header.startswith("Bearer "):
        return _cors(Response(json.dumps({"error": "Unauthenticated"}), 401, mimetype="application/json"))
    try:
        from firebase_admin import auth as fb_auth
        decoded = fb_auth.verify_id_token(auth_header.split("Bearer ")[1])
        uid = decoded["uid"]
    except Exception as e:
        return _cors(Response(json.dumps({"error": f"Invalid token: {e}"}), 401, mimetype="application/json"))

    try:
        body            = req.get_json(force=True)
        car_weight_g    = float(body["carWeightG"])
        drag_force_n    = float(body["dragForceN"])
        mu_roll         = float(body["muRoll"])
        wheel_moi_g_mm2 = float(body["wheelMoiGMm2"])
        preview         = bool(body.get("preview", False))
    except (TypeError, KeyError, ValueError) as e:
        return _cors(Response(json.dumps({"error": f"Invalid input: {e}"}), 400, mimetype="application/json"))

    if car_weight_g <= 0:
        return _cors(Response(json.dumps({"error": "Car weight must be > 0"}), 400, mimetype="application/json"))
    if drag_force_n < 0 or mu_roll < 0 or wheel_moi_g_mm2 < 0:
        return _cors(Response(json.dumps({"error": "Values cannot be negative"}), 400, mimetype="application/json"))

    charged = False
    if not preview:
        user_ref = db.collection("users").document(uid)

        @firestore.transactional
        def deduct_credits(transaction):
            snap = user_ref.get(transaction=transaction)
            if not snap.exists:
                raise Exception("User not found")
            data = snap.to_dict()
            if data.get("sponsored") is True:
                return False
            credits = data.get("credits", 0)
            if credits < LAP_COST:
                raise Exception(f"Insufficient credits. You have {credits} but need {LAP_COST}.")
            transaction.update(user_ref, {"credits": Increment(-LAP_COST)})
            txn_ref = user_ref.collection("transactions").document()
            transaction.set(txn_ref, {"type": "lap_calc_charge", "amount": -LAP_COST,
                                       "reason": "Lap Time Calculator run", "timestamp": SERVER_TIMESTAMP})
            return True

        try:
            charged = deduct_credits(db.transaction())
        except Exception as e:
            return _cors(Response(json.dumps({"error": str(e)}), 402, mimetype="application/json"))

    try:
        finish_time = run_simulation(car_weight_g, drag_force_n, mu_roll, wheel_moi_g_mm2)
    except ValueError as e:
        if charged:
            try: user_ref.update({"credits": Increment(LAP_COST)})
            except Exception: pass
        return _cors(Response(json.dumps({"error": str(e)}), 422, mimetype="application/json"))

    return _cors(Response(
        json.dumps({"finishTime": finish_time, "charged": charged, "cost": LAP_COST if charged else 0}),
        200, mimetype="application/json"
    ))
