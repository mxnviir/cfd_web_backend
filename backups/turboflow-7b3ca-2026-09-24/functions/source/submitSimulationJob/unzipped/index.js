const { onCall, HttpsError } = require("firebase-functions/v2/https");
const { onDocumentCreated } = require("firebase-functions/v2/firestore");
const { initializeApp } = require("firebase-admin/app");
const { getFirestore, FieldValue, Timestamp } = require("firebase-admin/firestore");
const { GoogleAuth } = require("google-auth-library");
const { getAuth } = require("firebase-admin/auth");

initializeApp();
const db = getFirestore();

const PROJECT  = "turboflow-7b3ca";
const REGION   = "us-central1";
const JOB_NAME = "simscale-job";
const DEFAULT_SIMULATION_COST = 100;
const SIMULATION_PRICING = Object.freeze({
  High_Res_Sim: DEFAULT_SIMULATION_COST,
  default: DEFAULT_SIMULATION_COST,
});

function normalizePartType(partType) {
  return typeof partType === "string" ? partType.trim() : "";
}

/**
 * "sponsored" only grants free use of the Race Time Calculator (handled
 * client-side there) - it does NOT make CFD simulations free. Sponsored
 * teams still pay for simulations, at a per-team discounted rate.
 *
 * Set per team by editing that team's user document directly in Firestore
 * (Firebase Console > Firestore Database > users > <uid>), no code needed:
 *   sponsored:   true
 *   sponsorRate: 0.4   // multiplier on normal cost, e.g. 0.4 = 60% off
 * Firestore rules block clients from writing these fields themselves.
 * Defaults to full price (1) when sponsorRate is unset.
 */
function sponsorRateFor(userData = {}) {
  if (userData.sponsored !== true) return 1;
  const r = Number(userData.sponsorRate);
  return (r > 0 && r <= 1) ? r : 1;
}

/**
 * True while the user holds an active "unlimited for 1 month" pass.
 * unlimitedUntil is a Firestore Timestamp set by capturePayPalOrder.
 * This is the only thing that makes simulations fully free.
 */
function hasActiveUnlimited(userData = {}) {
  const until = userData.unlimitedUntil;
  if (!until) return false;
  const ms = typeof until.toMillis === "function"
    ? until.toMillis()
    : (until._seconds ? until._seconds * 1000 : Number(until));
  return Number.isFinite(ms) && ms > Date.now();
}

function resolveSimulationCost(partType, userData = {}) {
  if (hasActiveUnlimited(userData)) {
    return 0;
  }

  const normalizedPartType = normalizePartType(partType);
  const base = SIMULATION_PRICING[normalizedPartType] ?? SIMULATION_PRICING.default;
  return Math.max(1, Math.round(base * sponsorRateFor(userData)));
}

/**
 * submitSimulationJob
 * Deducts credits and creates a job atomically server-side.
 * Cost is always derived from server-side pricing and user entitlements.
 */
exports.submitSimulationJob = onCall(async (request) => {
  if (!request.auth) {
    throw new HttpsError("unauthenticated", "You must be signed in to run simulations.");
  }

  const uid = request.auth.uid;
  const { partType, fileName, teamName, chordLength } = request.data;

  if (!partType || typeof partType !== "string") {
    throw new HttpsError("invalid-argument", "partType is required.");
  }

  const userRef = db.collection("users").doc(uid);
  const jobsRef = db.collection("jobs");
  const txnRef  = userRef.collection("transactions");

  const jobId = await db.runTransaction(async (txn) => {
    const userSnap = await txn.get(userRef);
    if (!userSnap.exists) throw new HttpsError("not-found", "User account not found.");

    const userData = userSnap.data() || {};
    const cost = resolveSimulationCost(partType, userData);
    const currentCredits = userSnap.data().credits ?? 0;
    if (currentCredits < cost) {
      throw new HttpsError("resource-exhausted", `Insufficient credits. You have ${currentCredits} but need ${cost}.`);
    }

    const newJobRef = jobsRef.doc();
    if (cost > 0) {
      txn.update(userRef, { credits: FieldValue.increment(-cost) });
    }
    txn.set(newJobRef, {
      userId:      uid,
      part:        partType,
      fileName:    fileName    ?? null,
      teamName:    teamName    ?? null,
      chordLength: chordLength ?? null,
      cost:        cost,
      status:      "queued",
      createdAt:   FieldValue.serverTimestamp(),
    });
    if (cost > 0) {
      txn.set(txnRef.doc(), {
        type:      "simulation_charge",
        amount:    -cost,
        reason:    "Simulation: " + partType,
        jobId:     newJobRef.id,
        timestamp: FieldValue.serverTimestamp(),
      });
    }
    return newJobRef.id;
  });

  return { jobId };
});

/**
 * refundJob
 * Refunds credits for a queued (100%) or processing (50%) job.
 */
exports.refundJob = onCall(async (request) => {
  if (!request.auth) {
    throw new HttpsError("unauthenticated", "You must be signed in to request a refund.");
  }

  const uid       = request.auth.uid;
  const { jobId } = request.data;

  if (!jobId || typeof jobId !== "string") {
    throw new HttpsError("invalid-argument", "jobId is required.");
  }

  const jobRef  = db.collection("jobs").doc(jobId);
  const userRef = db.collection("users").doc(uid);
  const txnRef  = userRef.collection("transactions");

  const refundAmount = await db.runTransaction(async (txn) => {
    const jobSnap = await txn.get(jobRef);
    if (!jobSnap.exists) throw new HttpsError("not-found", "Job not found.");

    const job = jobSnap.data();

    if (job.userId !== uid) {
      throw new HttpsError("permission-denied", "You do not own this job.");
    }

    const status = job.status;
    if (status === "complete" || status === "done") {
      throw new HttpsError("failed-precondition", "Completed jobs cannot be refunded.");
    }

    // Full refund: everything except running/complete/done
    const fullRefundStatuses = [
      "queued", "pending", "downloading", "uploading_geometry",
      "processing", "creating_simulation", "meshing",
    ];
    const noRefundStatuses = ["running", "complete", "done"];

    if (noRefundStatuses.includes(status)) {
      throw new HttpsError("failed-precondition", `Job status '${status}' is not refundable.`);
    }
    if (!fullRefundStatuses.includes(status)) {
      throw new HttpsError("failed-precondition", `Job status '${status}' is not refundable.`);
    }

    const amount = job.cost ?? 100;
    const label  = "100%";

    txn.update(userRef, { credits: FieldValue.increment(amount) });
    // Mark as cancelling so Cloud Run can detect it and stop SimScale cleanly.
    // For pre-pipeline jobs (no simulationId yet) just delete immediately.
    if (job.simulationId) {
      txn.update(jobRef, { status: "cancelling" });
    } else {
      txn.delete(jobRef);
    }
    txn.set(txnRef.doc(), {
      type:      "refund",
      amount:    amount,
      reason:    `Refund (${label}): ${job.part || job.fileName || "Simulation"}`,
      jobId:     jobId,
      timestamp: FieldValue.serverTimestamp(),
    });

    return amount;
  });

  return { refundAmount };
});

//  New Job: Discord ping + Cloud Run trigger 
exports.onNewJob = onDocumentCreated("jobs/{jobId}", async (event) => {
  const job   = event.data.data();
  const jobId = event.params.jobId;

  //  Discord ping 
  const DISCORD_WEBHOOK_URL = process.env.DISCORD_WEBHOOK_URL;
  if (DISCORD_WEBHOOK_URL) {
    try {
      await fetch(DISCORD_WEBHOOK_URL, {
        method:  "POST",
        headers: { "Content-Type": "application/json" },
        body:    JSON.stringify({
          content: "@everyone New simulation job incoming!",
          embeds: [{
            title: " New Simulation Job",
            color: 0x3b82f6,
            fields: [
              { name: "Job ID",  value: jobId,                      inline: true },
              { name: "Team",    value: job.teamName || "Unknown",   inline: true },
              { name: "File",    value: job.fileName || "N/A",       inline: true },
              { name: "Credits", value: String(job.cost || 100),     inline: true },
              { name: "Status",  value: job.status   || "queued",    inline: true },
              { name: "User ID", value: job.userId   || "N/A",       inline: true },
            ],
            timestamp: new Date().toISOString(),
          }],
        }),
      });
    } catch (err) {
      console.error("Discord ping failed:", err.message);
    }
  }

  //  Only trigger Cloud Run for Fusion-uploaded jobs (status = "pending") 
  if (job.status !== "pending") {
    console.log(`Skipping Cloud Run for job ${jobId}  status is '${job.status}', not 'pending'`);
    return;
  }

  //  Server-side security validation 
  // We verify the userId in the job doc matches a real Firebase user by decoding
  // the fact that only a valid authenticated user could have written this doc
  // (enforced by Firestore rules). We also re-clamp all numeric inputs so no
  // tampered values from the Fusion script can affect billing or backend behaviour.
  const uid = job.userId;
  if (!uid || typeof uid !== "string" || uid.length < 10) {
    console.error("Job has invalid userId:", uid);
    await db.collection("jobs").doc(jobId).update({ status: "failed", error: "Invalid userId" });
    return;
  }

  // Verify the user actually exists in Firebase Auth
  try {
    await getAuth().getUser(uid);
  } catch (authErr) {
    console.error(`userId ${uid} not found in Firebase Auth:`, authErr.message);
    await db.collection("jobs").doc(jobId).update({ status: "failed", error: "User not found" });
    return;
  }

  // Clamp all job parameters server-side  Fusion script values are untrusted
  const iterCount     = Math.max(1,    Math.min(3000, Math.round(job.iterationCount || 1000)));
  const refineLevel   = Math.max(1,    Math.min(5,    Math.round(job.refineLevel    || 3)));
  const debugMesh     = job.debugMesh === true;
  const inletVelocity = Math.max(1,    Math.min(100,  parseFloat(job.inletVelocity) || 20));

  // Cost formula: level 1 = 100cr/1000iter, level 5 = 200cr/1000iter, linear
  // Debug mode is near-free (1 credit minimum)
  const crPer1000 = debugMesh ? 1 : (100 + (refineLevel - 1) * 25);
  const cost      = Math.max(1, Math.round(crPer1000 * iterCount / 1000));

  // Derive meshCellsM from refineLevel for Cloud Run (inverse of fineness formula)
  // fineness = 9 + (level-1)*0.25  cells = (fineness-7)*15/3+5
  const meshCellsM = debugMesh ? 0.1 : ((9.0 + (refineLevel-1)*0.25 - 7.0) * 15.0 / 3.0 + 5.0);

  //  Deduct credits atomically before triggering 
  try {
    const userRef = db.collection("users").doc(uid);
    const effectiveCost = await db.runTransaction(async (txn) => {
      const userSnap = await txn.get(userRef);
      if (!userSnap.exists) throw new Error("User document not found");
      const userData = userSnap.data() || {};
      // Active unlimited-pass holders run for free; sponsored teams still pay,
      // just at their backend-configured discounted rate (default: full price).
      const chargeable = hasActiveUnlimited(userData)
        ? 0
        : Math.max(1, Math.round(cost * sponsorRateFor(userData)));
      const currentCredits = userData.credits ?? 0;
      if (currentCredits < chargeable) {
        throw new Error(`Insufficient credits: have ${currentCredits}, need ${chargeable}`);
      }
      if (chargeable > 0) {
        txn.update(userRef, { credits: FieldValue.increment(-chargeable) });
        txn.set(userRef.collection("transactions").doc(), {
          type:      "simulation_charge",
          amount:    -chargeable,
          reason:    `Simulation (level ${refineLevel}, ${iterCount} iter${debugMesh ? ", debug" : ""}): ${jobId.slice(0, 8)}`,
          jobId:     jobId,
          timestamp: FieldValue.serverTimestamp(),
        });
      }
      // Stamp authoritative sanitised values back onto the job doc.
      // This overwrites anything the Fusion script may have tampered with.
      txn.update(db.collection("jobs").doc(jobId), {
        cost:           chargeable,
        iterationCount: iterCount,
        refineLevel:    refineLevel,
        meshCellsM:     meshCellsM,
        inletVelocity:  inletVelocity,
        userId:         uid,   // re-affirm correct uid
      });
      return chargeable;
    });
    console.log(` ${effectiveCost} credits deducted from ${uid} (level ${refineLevel}, ${iterCount} iter, ${meshCellsM.toFixed(1)}M cells)`);
  } catch (creditErr) {
    console.error(` Credit deduction failed: ${creditErr.message}`);
    await db.collection("jobs").doc(jobId).update({
      status: "failed",
      error:  "Credit check failed: " + creditErr.message,
    });
    return;
  }

  //  Trigger the Cloud Run job 
  console.log(`Triggering Cloud Run job for jobId: ${jobId}`);
  try {
    const auth   = new GoogleAuth({ scopes: ["https://www.googleapis.com/auth/cloud-platform"] });
    const client = await auth.getClient();
    const token  = await client.getAccessToken();

    const url = `https://${REGION}-run.googleapis.com/apis/run.googleapis.com/v1`
              + `/namespaces/${PROJECT}/jobs/${JOB_NAME}:run`;

    const resp = await fetch(url, {
      method:  "POST",
      headers: {
        "Authorization": `Bearer ${token.token}`,
        "Content-Type":  "application/json",
      },
      body: JSON.stringify({
        overrides: {
          containerOverrides: [{ env: [{ name: "JOB_ID", value: jobId }] }],
        },
      }),
    });

    if (!resp.ok) {
      const text = await resp.text();
      throw new Error(`Cloud Run trigger failed: ${resp.status} ${text}`);
    }

    console.log(` Cloud Run job triggered for ${jobId}`);

  } catch (err) {
    console.error(` Failed to trigger Cloud Run job: ${err.message}`);
    await db.collection("jobs").doc(jobId).update({
      status: "failed",
      error:  err.message,
    });
  }
});

/* ============================================================
 *  PayPal self-serve credit purchases
 *  ----------------------------------------------------------
 *  Pricing is read from Firestore config/pricing so it can be
 *  changed live from the backend (Console or CLI) with no
 *  redeploy. "usdPer100Credits" defaults to 5 ($0.05/credit).
 *  The server is authoritative for the amount charged and the
 *  credits granted  the client only proposes a credit count.
 * ============================================================ */

const PAYPAL_DEFAULTS = Object.freeze({
  usdPer100Credits: 5,
  currency: "USD",
  minCredits: 100,
  maxCredits: 20000,
  unlimitedMonthlyUSD: 100,  // default price PER MONTH of the unlimited pass
  unlimitedDays: 30,         // days granted per month purchased
  maxUnlimitedMonths: 24,    // upper bound on months per purchase
});

async function getPricingConfig() {
  try {
    const snap = await db.collection("config").doc("pricing").get();
    const d = (snap.exists && snap.data()) || {};
    const usdPer100 = Number(d.usdPer100Credits);
    const minC = Number(d.minCredits);
    const maxC = Number(d.maxCredits);
    const unlimUSD = Number(d.unlimitedMonthlyUSD);
    const unlimDays = Number(d.unlimitedDays);
    const maxMonths = Number(d.maxUnlimitedMonths);
    return {
      usdPer100Credits: usdPer100 > 0 ? usdPer100 : PAYPAL_DEFAULTS.usdPer100Credits,
      currency: (typeof d.currency === "string" && d.currency) ? d.currency : PAYPAL_DEFAULTS.currency,
      minCredits: minC > 0 ? Math.floor(minC) : PAYPAL_DEFAULTS.minCredits,
      maxCredits: maxC > 0 ? Math.floor(maxC) : PAYPAL_DEFAULTS.maxCredits,
      unlimitedMonthlyUSD: unlimUSD > 0 ? unlimUSD : PAYPAL_DEFAULTS.unlimitedMonthlyUSD,
      unlimitedDays: unlimDays > 0 ? Math.floor(unlimDays) : PAYPAL_DEFAULTS.unlimitedDays,
      maxUnlimitedMonths: maxMonths > 0 ? Math.floor(maxMonths) : PAYPAL_DEFAULTS.maxUnlimitedMonths,
    };
  } catch (err) {
    console.error("getPricingConfig failed:", err.message);
    return { ...PAYPAL_DEFAULTS };
  }
}

const PAYPAL_ENV  = (process.env.PAYPAL_ENV || "sandbox").toLowerCase();
const PAYPAL_BASE = PAYPAL_ENV === "live"
  ? "https://api-m.paypal.com"
  : "https://api-m.sandbox.paypal.com";

async function paypalAccessToken() {
  const id     = process.env.PAYPAL_CLIENT_ID;
  const secret = process.env.PAYPAL_SECRET;
  if (!id || !secret) {
    throw new HttpsError("failed-precondition", "PayPal is not configured on the server.");
  }
  const basic = Buffer.from(`${id}:${secret}`).toString("base64");
  const resp = await fetch(`${PAYPAL_BASE}/v1/oauth2/token`, {
    method:  "POST",
    headers: {
      "Authorization": `Basic ${basic}`,
      "Content-Type":  "application/x-www-form-urlencoded",
    },
    body: "grant_type=client_credentials",
  });
  if (!resp.ok) {
    const text = await resp.text();
    throw new HttpsError("internal", `PayPal auth failed: ${resp.status} ${text}`);
  }
  const json = await resp.json();
  return json.access_token;
}

/**
 * createPayPalOrder
 * Validates the requested credit count against server-side config,
 * computes the USD amount, and opens a PayPal order. The intent is
 * recorded in Firestore so the amount/credits cannot be tampered
 * with before capture.
 */
exports.createPayPalOrder = onCall(async (request) => {
  if (!request.auth) {
    throw new HttpsError("unauthenticated", "You must be signed in to buy credits.");
  }
  const uid = request.auth.uid;
  const cfg = await getPricingConfig();
  const product = (request.data && request.data.product) === "unlimited" ? "unlimited" : "credits";

  // Per-user purchase rate (USD per credit). If the user's doc has a positive
  // `usdPerCredit`, it overrides the global config rate; otherwise we use the
  // global rate (default $0.05/credit). This lets us price any buyer individually.
  const buyerSnap    = await db.collection("users").doc(uid).get();
  const buyer        = buyerSnap.exists ? (buyerSnap.data() || {}) : {};
  const usdPerCredit = Number(buyer.usdPerCredit) > 0
    ? Number(buyer.usdPerCredit)
    : cfg.usdPer100Credits / 100;
  const unlimitedUsdPerMonth = Number(buyer.unlimitedUsd) > 0
    ? Number(buyer.unlimitedUsd)
    : cfg.unlimitedMonthlyUSD;

  // Build the order (amount + intent doc) per product type. The client only ever
  // supplies a QUANTITY (credits or months); the server derives BOTH the price and
  // the entitlement from it, so a request cannot pay little yet grant a lot.
  let value, description, intentDoc;
  if (product === "unlimited") {
    const months = Math.floor(Number(request.data && request.data.months));
    if (!Number.isFinite(months) || months < 1 || months > cfg.maxUnlimitedMonths) {
      throw new HttpsError(
        "invalid-argument",
        `Months must be a whole number between 1 and ${cfg.maxUnlimitedMonths}.`
      );
    }
    const days  = months * cfg.unlimitedDays;
    value       = (months * unlimitedUsdPerMonth).toFixed(2);
    description = `TurboFlow Unlimited  ${months} month(s) / ${days} days`;
    intentDoc   = { uid, kind: "unlimited", days, months };
  } else {
    const credits = Math.floor(Number(request.data && request.data.credits));
    if (!Number.isFinite(credits) || credits < cfg.minCredits || credits > cfg.maxCredits) {
      throw new HttpsError(
        "invalid-argument",
        `Credits must be a whole number between ${cfg.minCredits} and ${cfg.maxCredits}.`
      );
    }
    value       = (credits * usdPerCredit).toFixed(2);
    description = `${credits} TurboFlow credits`;
    intentDoc   = { uid, kind: "credits", credits };
  }

  if (Number(value) <= 0) {
    throw new HttpsError("invalid-argument", "Computed amount is zero.");
  }

  const token = await paypalAccessToken();
  const resp = await fetch(`${PAYPAL_BASE}/v2/checkout/orders`, {
    method:  "POST",
    headers: { "Authorization": `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      intent: "CAPTURE",
      purchase_units: [{
        amount:      { currency_code: cfg.currency, value },
        custom_id:   uid,
        description,
      }],
    }),
  });
  if (!resp.ok) {
    const text = await resp.text();
    throw new HttpsError("internal", `PayPal order create failed: ${resp.status} ${text}`);
  }
  const order = await resp.json();

  // This doc is a short-lived, tamper-proof record of the intended amount/credits.
  // It is DELETED as soon as the payment is captured (the permanent record then
  // lives in users/{uid}/transactions). If the buyer abandons checkout, the
  // Firestore TTL policy on `expireAt` auto-deletes it so no unpaid "created"
  // orders pile up. PayPal orders themselves expire in ~3h, so 3h matches.
  await db.collection("paypal_orders").doc(order.id).set({
    ...intentDoc,
    amountUSD: Number(value),
    currency:  cfg.currency,
    status:    "created",
    createdAt: FieldValue.serverTimestamp(),
    expireAt:  Timestamp.fromMillis(Date.now() + 3 * 60 * 60 * 1000),
  });

  return {
    orderID:  order.id,
    product,
    amount:   Number(value),
    currency: cfg.currency,
    credits:  intentDoc.credits ?? null,
    days:     intentDoc.days ?? null,
    months:   intentDoc.months ?? null,
  };
});

/**
 * capturePayPalOrder
 * Captures an approved order, verifies the captured amount matches
 * the recorded intent, then grants credits exactly once.
 */
exports.capturePayPalOrder = onCall(async (request) => {
  if (!request.auth) {
    throw new HttpsError("unauthenticated", "You must be signed in to complete a purchase.");
  }
  const uid     = request.auth.uid;
  const orderID = request.data && request.data.orderID;
  if (!orderID || typeof orderID !== "string") {
    throw new HttpsError("invalid-argument", "orderID is required.");
  }

  const orderRef  = db.collection("paypal_orders").doc(orderID);
  const orderSnap = await orderRef.get();
  if (!orderSnap.exists) throw new HttpsError("not-found", "Order not found.");
  const intent = orderSnap.data();

  if (intent.uid !== uid) {
    throw new HttpsError("permission-denied", "This order does not belong to you.");
  }
  const kind = intent.kind === "unlimited" ? "unlimited" : "credits";

  const token = await paypalAccessToken();
  let resp    = await fetch(`${PAYPAL_BASE}/v2/checkout/orders/${orderID}/capture`, {
    method:  "POST",
    headers: { "Authorization": `Bearer ${token}`, "Content-Type": "application/json" },
  });
  let capture = await resp.json().catch(() => ({}));

  // If a previous attempt already captured this order (e.g. it captured at PayPal
  // but crashed before crediting Firestore), PayPal returns 422 ORDER_ALREADY_CAPTURED.
  // Re-fetch the order so we can still grant the credits the buyer paid for. The
  // crediting transaction below stays idempotent, so this cannot double-credit.
  const alreadyCaptured = !resp.ok &&
    Array.isArray(capture && capture.details) &&
    capture.details.some((d) => d.issue === "ORDER_ALREADY_CAPTURED");
  if (alreadyCaptured) {
    resp    = await fetch(`${PAYPAL_BASE}/v2/checkout/orders/${orderID}`, {
      headers: { "Authorization": `Bearer ${token}` },
    });
    capture = await resp.json().catch(() => ({}));
  }

  if (!resp.ok) {
    throw new HttpsError("internal", `PayPal capture failed: ${resp.status} ${JSON.stringify(capture)}`);
  }
  if (capture.status !== "COMPLETED") {
    throw new HttpsError("failed-precondition", `Payment not completed (status: ${capture.status}).`);
  }

  // Verify what PayPal actually captured against the recorded intent.
  let capturedValue, capturedCurrency, captureId = null;
  try {
    const cap        = capture.purchase_units[0].payments.captures[0];
    capturedValue    = Number(cap.amount.value);
    capturedCurrency = cap.amount.currency_code;
    captureId        = cap.id || null;
  } catch (err) {
    throw new HttpsError("internal", "Could not read PayPal capture details.");
  }
  if (capturedCurrency !== intent.currency ||
      Math.abs(capturedValue - Number(intent.amountUSD)) > 0.01) {
    throw new HttpsError("failed-precondition", "Captured amount does not match the order.");
  }

  // Apply the purchase exactly once, then DELETE the order doc so only real
  // payments remain (recorded in users/{uid}/transactions). Idempotency: if the
  // order doc is already gone, it was processed by a prior/concurrent call, so we
  // credit nothing. The capture id is kept on the transaction for audit/refunds.
  const userRef = db.collection("users").doc(uid);
  const result  = await db.runTransaction(async (txn) => {
    const oSnap = await txn.get(orderRef);
    if (!oSnap.exists) return { applied: false };

    const uSnap = await txn.get(userRef);
    if (!uSnap.exists) throw new HttpsError("not-found", "User account not found.");

    if (kind === "unlimited") {
      // Extend the unlimited pass, stacking on any remaining time.
      const ud    = uSnap.data() || {};
      const nowMs = Date.now();
      const curMs = (ud.unlimitedUntil && typeof ud.unlimitedUntil.toMillis === "function")
        ? ud.unlimitedUntil.toMillis() : 0;
      const days  = Number(intent.days) > 0 ? Number(intent.days) : 30;
      const active = curMs > nowMs;
      const newUntilMs = (active ? curMs : nowMs) + days * 24 * 60 * 60 * 1000;
      // Track when the current pass period began so the UI can show days-left vs
      // total. Extending an active pass keeps the original start; a lapsed/first
      // pass starts now. (unlimitedUntil - unlimitedStartedAt) = total days held.
      const startMs = (active && ud.unlimitedStartedAt && typeof ud.unlimitedStartedAt.toMillis === "function")
        ? ud.unlimitedStartedAt.toMillis()
        : nowMs;

      txn.update(userRef, {
        unlimitedUntil:     Timestamp.fromMillis(newUntilMs),
        unlimitedStartedAt: Timestamp.fromMillis(startMs),
      });
      txn.set(userRef.collection("transactions").doc(), {
        type:      "unlimited_pass",
        amount:    0,
        reason:    `PayPal: $${Number(intent.amountUSD).toFixed(2)}  Unlimited ${days} days`,
        orderID,
        captureId,
        timestamp: FieldValue.serverTimestamp(),
      });
      txn.delete(orderRef);
      return { applied: true, unlimitedUntil: newUntilMs };
    }

    // Credit top-up.
    txn.update(userRef, { credits: FieldValue.increment(intent.credits) });
    txn.set(userRef.collection("transactions").doc(), {
      type:      "purchase",
      amount:    intent.credits,
      reason:    `PayPal: $${Number(intent.amountUSD).toFixed(2)}  ${intent.credits} credits`,
      orderID,
      captureId,
      timestamp: FieldValue.serverTimestamp(),
    });
    txn.delete(orderRef);
    return { applied: true, credits: intent.credits };
  });

  return {
    credited:       result.applied,
    product:        kind,
    credits:        kind === "credits" ? (intent.credits ?? null) : null,
    unlimitedUntil: result.unlimitedUntil ?? null,
  };
});
