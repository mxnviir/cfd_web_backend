/**
 * The credit path, against the live database.
 *
 * Everything here runs through the real RPCs the edge functions call, on a
 * throwaway user that is deleted afterwards. Credits are the one thing in this
 * app that is effectively money, so the cases below are the ones where being
 * subtly wrong costs a team a run: partial deduction on a failed submit, a
 * refund that can be claimed twice, a sponsored rate applied to the wrong side.
 *
 * Run: node tests/test_billing.js        (needs .env.deploy, hits the network)
 */
const fs = require("fs");
const path = require("path");
const { createClient } = require(
  path.join(__dirname, "..", "supabase", "_migrate", "node_modules", "@supabase", "supabase-js"));

const env = {};
for (const line of fs.readFileSync(path.join(__dirname, "..", ".env.deploy"), "utf8").split(/\r?\n/)) {
  const m = line.match(/^\s*([A-Z0-9_]+)=(.*)$/);
  if (m) env[m[1]] = m[2];
}

const admin = createClient(env.SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY,
  { auth: { persistSession: false } });

let passed = 0;
const ok = (cond, msg) => {
  if (!cond) throw new Error("FAILED: " + msg);
  passed++;
  console.log("  ok  " + msg);
};
const credits = async (id) =>
  (await admin.from("users").select("credits").eq("id", id).single()).data.credits;

async function main() {
  const email = `billing_${Date.now()}@turboflow.test`;
  const password = "Test-Passw0rd!";
  let uid;
  try {
    const { data: created, error } = await admin.auth.admin.createUser({
      email, password, email_confirm: true, user_metadata: { full_name: "Test Racer" },
    });
    if (error) throw error;
    uid = created.user.id;
    await new Promise((r) => setTimeout(r, 800));   // let the signup trigger land

    // ── signup ──
    let prof = (await admin.from("users").select("*").eq("id", uid).single()).data;
    ok(!!prof, "signup creates the profile row");
    ok(prof.credits === 50, "new account starts on 50 credits");
    ok(prof.sponsored === false, "new account is not sponsored");

    // ── a client cannot pay itself ──
    const asUser = createClient(env.SUPABASE_URL, env.SUPABASE_ANON_KEY,
      { auth: { persistSession: false } });
    await asUser.auth.signInWithPassword({ email, password });
    await asUser.from("users").update({ credits: 999999, team_name: "Hackers" }).eq("id", uid);
    prof = (await admin.from("users").select("*").eq("id", uid).single()).data;
    ok(prof.credits === 50, "client cannot raise its own credits");
    ok(prof.team_name === "Hackers", "client can still edit its own team name");

    // ── the RPCs are not reachable with an end-user token ──
    const denied = await asUser.rpc("lap_calc_refund", { p_uid: uid });
    ok(!!denied.error, "signed-in user cannot call lap_calc_refund directly");
    ok(await credits(uid) === 50, "...and no credits were granted by trying");

    // ── submit charges exactly once ──
    await admin.from("users").update({ credits: 200 }).eq("id", uid);
    const { data: jobId, error: subErr } = await admin.rpc("submit_simulation_job", {
      p_uid: uid, p_part: "Front Wing", p_file: "wing.step", p_team: "Test", p_chord: 0.3,
    });
    if (subErr) throw subErr;
    ok(await credits(uid) === 100, "submit deducts 100 credits");
    const job = (await admin.from("jobs").select("*").eq("id", jobId).single()).data;
    ok(job.status === "queued" && job.cost === 100, "job is queued at cost 100");
    const txns = (await admin.from("transactions").select("*").eq("user_id", uid)).data;
    ok(txns.some((t) => t.amount === -100 && t.type === "simulation_charge"),
      "the charge is written to the ledger");

    // ── a submit that cannot be afforded must change nothing ──
    await admin.from("users").update({ credits: 30 }).eq("id", uid);
    const broke = await admin.rpc("submit_simulation_job", {
      p_uid: uid, p_part: "Front Wing", p_file: "x.step", p_team: "T", p_chord: 0.3,
    });
    ok(!!broke.error, "submit fails when the balance is too low");
    ok(/insufficient credits/i.test(broke.error.message), "...with a message a user can read");
    ok(await credits(uid) === 30, "...and deducts nothing (no partial charge)");
    const after = (await admin.from("jobs").select("id").eq("user_id", uid)).data;
    ok(after.length === 1, "...and creates no job row");

    // ── sponsorship discounts the charge ──
    await admin.from("users").update({ credits: 200, sponsored: true, sponsor_rate: 0.5 }).eq("id", uid);
    const spon = await admin.rpc("submit_simulation_job", {
      p_uid: uid, p_part: "Front Wing", p_file: "s.step", p_team: "T", p_chord: 0.3,
    });
    if (spon.error) throw spon.error;
    ok(await credits(uid) === 150, "a 0.5 sponsor rate halves the charge to 50");
    await admin.rpc("refund_job", { p_uid: uid, p_job_id: spon.data });

    // ── an unlimited pass makes runs free ──
    await admin.from("users").update({
      credits: 200, sponsored: false, sponsor_rate: 1,
      unlimited_until: new Date(Date.now() + 864e5).toISOString(),
    }).eq("id", uid);
    const unl = await admin.rpc("submit_simulation_job", {
      p_uid: uid, p_part: "Front Wing", p_file: "u.step", p_team: "T", p_chord: 0.3,
    });
    if (unl.error) throw unl.error;
    ok(await credits(uid) === 200, "an active unlimited pass costs nothing");
    const freeJob = (await admin.from("jobs").select("cost").eq("id", unl.data).single()).data;
    ok(freeJob.cost === 0, "...and the job records a zero cost");
    await admin.from("users").update({ unlimited_until: null }).eq("id", uid);

    // ── refunds are once only ──
    await admin.from("users").update({ credits: 100 }).eq("id", uid);
    const refund = await admin.rpc("refund_job", { p_uid: uid, p_job_id: jobId });
    ok(refund.data === 100, "refund returns the amount charged");
    ok(await credits(uid) === 200, "refund restores the credits");
    const gone = (await admin.from("jobs").select("id").eq("id", jobId).maybeSingle()).data;
    ok(gone === null, "a queued job is removed by the refund");
    const twice = await admin.rpc("refund_job", { p_uid: uid, p_job_id: jobId });
    ok(!!twice.error, "the same job cannot be refunded twice");
    ok(await credits(uid) === 200, "...and the second attempt pays nothing");

    // ── lap calculator ──
    const charged = await admin.rpc("lap_calc_charge", { p_uid: uid });
    ok(charged.data === true, "lap calc charges a normal account");
    ok(await credits(uid) === 190, "...10 credits");
    await admin.rpc("lap_calc_refund", { p_uid: uid });
    ok(await credits(uid) === 200, "a failed lap calc gives the 10 back");
    await admin.from("users").update({ sponsored: true }).eq("id", uid);
    const sponsoredRun = await admin.rpc("lap_calc_charge", { p_uid: uid });
    ok(sponsoredRun.data === false, "sponsored accounts run the lap calc free");
    ok(await credits(uid) === 200, "...and are not charged");
    await admin.from("users").update({ sponsored: false, credits: 5 }).eq("id", uid);
    const poor = await admin.rpc("lap_calc_charge", { p_uid: uid });
    ok(!!poor.error, "lap calc refuses when the balance is short");
    ok(await credits(uid) === 5, "...without taking a partial payment");

    // ── PayPal: money in ──
    // The capture edge function verifies the payment with PayPal and then calls
    // these. Testing them directly is the point: they are what actually mints
    // credits, and a second call on the same order must never mint them twice.
    await admin.from("users").update({ credits: 100 }).eq("id", uid);
    const orderId = `TEST-ORDER-${Date.now()}`;
    await admin.from("paypal_orders").insert({
      id: orderId, uid, kind: "credits", credits: 500,
      amount_usd: 25, currency: "USD", status: "created",
    });
    const granted = await admin.rpc("paypal_apply_credits", { p_uid: uid, p_order_id: orderId });
    ok(granted.data === 500, "capturing an order grants the credits it was for");
    ok(await credits(uid) === 600, "...added to the balance");
    ok((await admin.from("paypal_orders").select("id").eq("id", orderId).maybeSingle()).data === null,
      "...and the order is consumed");
    const replay = await admin.rpc("paypal_apply_credits", { p_uid: uid, p_order_id: orderId });
    ok(replay.data === 0 && !replay.error, "replaying the same order grants nothing");
    ok(await credits(uid) === 600, "...the balance is unchanged");

    // an order belonging to someone else cannot be claimed
    const otherOrder = `TEST-OTHER-${Date.now()}`;
    await admin.from("paypal_orders").insert({
      id: otherOrder, uid: "00000000-0000-4000-8000-000000000000", kind: "credits",
      credits: 9999, amount_usd: 1, currency: "USD", status: "created",
    });
    const stolen = await admin.rpc("paypal_apply_credits", { p_uid: uid, p_order_id: otherOrder });
    ok(!!stolen.error, "an order belonging to another account cannot be claimed");
    ok(await credits(uid) === 600, "...and grants nothing");
    await admin.from("paypal_orders").delete().eq("id", otherOrder);

    // unlimited passes stack onto whatever time is left rather than resetting it
    const passOrder = `TEST-PASS-${Date.now()}`;
    await admin.from("paypal_orders").insert({
      id: passOrder, uid, kind: "unlimited", days: 30,
      amount_usd: 100, currency: "USD", status: "created",
    });
    const until1 = (await admin.rpc("paypal_apply_unlimited", { p_uid: uid, p_order_id: passOrder })).data;
    const days1 = (new Date(until1) - Date.now()) / 864e5;
    ok(days1 > 29 && days1 < 31, "an unlimited pass runs 30 days from now");

    const passOrder2 = `TEST-PASS2-${Date.now()}`;
    await admin.from("paypal_orders").insert({
      id: passOrder2, uid, kind: "unlimited", days: 30,
      amount_usd: 100, currency: "USD", status: "created",
    });
    const until2 = (await admin.rpc("paypal_apply_unlimited", { p_uid: uid, p_order_id: passOrder2 })).data;
    const days2 = (new Date(until2) - Date.now()) / 864e5;
    ok(days2 > 59 && days2 < 61, "buying a second pass extends rather than resets it");

    console.log(`\nok - ${passed} billing assertions hold`);
  } finally {
    if (uid) await admin.auth.admin.deleteUser(uid);
  }
}

main().catch((e) => { console.error("\n" + e.message); process.exit(1); });
