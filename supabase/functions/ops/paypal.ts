// PayPal: open an order, capture it, and the webhook that settles a payment
// whose tab was closed. Ported from functions/src/paypal.
//
// The client sends a quantity and nothing else. Price and entitlement are
// derived here and recorded in paypal_orders, which no client can read or
// write; credits are granted by private.apply_purchase, exactly once, by
// whichever of capture and webhook gets there first.
import { sql, OpsError, overRateLimit, clientIp } from "../_shared/core.ts";
import type { Ctx } from "./index.ts";

const env = (name: string): string => {
  const v = (Deno.env.get(name) ?? "").trim();
  return ["", "unset", "UNSET", "REPLACE_ME", "changeme"].includes(v) ? "" : v;
};

/**
 * Only production can reach live PayPal: anywhere else this is sandbox
 * whatever PAYPAL_ENV says, so a test deploy cannot charge a real card even
 * if it is handed live credentials by mistake.
 */
function paypalBase(): string {
  const live = env("TURBOFLOW_ENV") === "production" && env("PAYPAL_ENV").toLowerCase() === "live";
  return live ? "https://api-m.paypal.com" : "https://api-m.sandbox.paypal.com";
}

async function accessToken(): Promise<string> {
  const id = env("PAYPAL_CLIENT_ID");
  const secret = env("PAYPAL_SECRET");
  if (!id || !secret) throw new OpsError("failed-precondition", "PayPal is not configured on this server.");
  const resp = await fetch(`${paypalBase()}/v1/oauth2/token`, {
    method: "POST",
    headers: { Authorization: `Basic ${btoa(`${id}:${secret}`)}`, "Content-Type": "application/x-www-form-urlencoded" },
    body: "grant_type=client_credentials",
  });
  if (!resp.ok) throw new OpsError("internal", `PayPal authentication failed (${resp.status}).`);
  return (await resp.json()).access_token;
}

async function paypalFetch(path: string, init: RequestInit = {}) {
  const resp = await fetch(`${paypalBase()}${path}`, {
    ...init,
    headers: { Authorization: `Bearer ${await accessToken()}`, "Content-Type": "application/json", ...(init.headers ?? {}) },
  });
  const body = await resp.json().catch(() => ({}));
  return { ok: resp.ok, status: resp.status, body: body as Record<string, any> };
}

const DEFAULTS = {
  usdPer100Credits: 5, currency: "USD", minCredits: 100, maxCredits: 20000,
  unlimitedMonthlyUSD: 100, unlimitedDays: 30, maxUnlimitedMonths: 24,
};

/** Prices from config/pricing, so they change without a deploy. */
async function getPricing() {
  const [row] = await sql`select data from public.config where id = 'pricing'`.catch(() => []);
  const d = row?.data ?? {};
  const pos = (v: unknown, f: number) => (Number(v) > 0 ? Number(v) : f);
  return {
    usdPer100Credits: pos(d.usdPer100Credits, DEFAULTS.usdPer100Credits),
    currency: typeof d.currency === "string" && d.currency ? d.currency : DEFAULTS.currency,
    minCredits: Math.floor(pos(d.minCredits, DEFAULTS.minCredits)),
    maxCredits: Math.floor(pos(d.maxCredits, DEFAULTS.maxCredits)),
    unlimitedMonthlyUSD: pos(d.unlimitedMonthlyUSD, DEFAULTS.unlimitedMonthlyUSD),
    unlimitedDays: Math.floor(pos(d.unlimitedDays, DEFAULTS.unlimitedDays)),
    maxUnlimitedMonths: Math.floor(pos(d.maxUnlimitedMonths, DEFAULTS.maxUnlimitedMonths)),
  };
}

export async function createPayPalOrder({ caller, data }: Ctx) {
  const cfg = await getPricing();
  const [buyer] = await sql`select usd_per_credit, unlimited_usd from public.users where id = ${caller.uid}`;
  // A per-account rate overrides the global one.
  const usdPerCredit = Number(buyer?.usd_per_credit) > 0 ? Number(buyer.usd_per_credit) : cfg.usdPer100Credits / 100;
  const usdPerMonth = Number(buyer?.unlimited_usd) > 0 ? Number(buyer.unlimited_usd) : cfg.unlimitedMonthlyUSD;

  let value: string;
  let description: string;
  let intent: { kind: "credits" | "unlimited"; credits?: number; days?: number; months?: number };
  if (data.product === "unlimited") {
    if (data.months > cfg.maxUnlimitedMonths) {
      throw new OpsError("invalid-argument", `At most ${cfg.maxUnlimitedMonths} months at a time.`);
    }
    const days = data.months * cfg.unlimitedDays;
    value = (data.months * usdPerMonth).toFixed(2);
    description = `TurboFlow Unlimited, ${data.months} month(s), ${days} days`;
    intent = { kind: "unlimited", days, months: data.months };
  } else {
    if (data.credits < cfg.minCredits || data.credits > cfg.maxCredits) {
      throw new OpsError("invalid-argument", `Credits must be between ${cfg.minCredits} and ${cfg.maxCredits}.`);
    }
    value = (data.credits * usdPerCredit).toFixed(2);
    description = `${data.credits} TurboFlow credits`;
    intent = { kind: "credits", credits: data.credits };
  }
  if (Number(value) <= 0) throw new OpsError("invalid-argument", "That works out to nothing to pay.");

  const { ok, status, body } = await paypalFetch("/v2/checkout/orders", {
    method: "POST",
    body: JSON.stringify({
      intent: "CAPTURE",
      purchase_units: [{ amount: { currency_code: cfg.currency, value }, custom_id: caller.uid, description }],
    }),
  });
  if (!ok) throw new OpsError("internal", `PayPal would not open the order (${status}).`);
  const orderId = String(body.id);

  await sql`
    insert into public.paypal_orders (id, user_id, kind, credits, days, months, amount_usd, currency, expire_at)
    values (${orderId}, ${caller.uid}, ${intent.kind}, ${intent.credits ?? null}, ${intent.days ?? null},
            ${intent.months ?? null}, ${Number(value)}, ${cfg.currency}, now() + interval '3 hours')`;
  return {
    order_id: orderId, product: data.product, amount: Number(value), currency: cfg.currency,
    credits: intent.credits ?? null, days: intent.days ?? null, months: intent.months ?? null,
  };
}

async function applyPurchase(orderId: string, captureId: string | null) {
  const [row] = await sql`select private.apply_purchase(${orderId}, ${captureId}) as r`;
  return row.r as { applied: boolean; product: string; credits?: number; unlimited_until?: number };
}

export async function capturePayPalOrder({ caller, data }: Ctx) {
  const [order] = await sql`select user_id, amount_usd, currency from public.paypal_orders where id = ${data.order_id}`;
  if (!order) throw new OpsError("not-found", "That order was not found.");
  if (order.user_id !== caller.uid) throw new OpsError("permission-denied", "That order is not yours.");

  let res = await paypalFetch(`/v2/checkout/orders/${data.order_id}/capture`, { method: "POST" });
  // Captured by an earlier attempt that died before granting: read it back.
  if (!res.ok && (res.body.details ?? []).some((d: any) => d.issue === "ORDER_ALREADY_CAPTURED")) {
    res = await paypalFetch(`/v2/checkout/orders/${data.order_id}`, { method: "GET" });
  }
  if (!res.ok) throw new OpsError("internal", `PayPal capture failed (${res.status}).`);
  if (res.body.status !== "COMPLETED") {
    throw new OpsError("failed-precondition", `Payment is not complete (${String(res.body.status)}).`);
  }
  const capture = res.body.purchase_units?.[0]?.payments?.captures?.[0];
  if (!capture) throw new OpsError("internal", "Could not read the payment details from PayPal.");
  // Order COMPLETED with the capture PENDING means the money has not settled.
  if (capture.status !== "COMPLETED") {
    throw new OpsError("failed-precondition",
      `The payment has not settled yet (${String(capture.status)}). Credits are granted once it does.`);
  }
  if (capture.amount?.currency_code !== order.currency
    || Math.abs(Number(capture.amount?.value) - Number(order.amount_usd)) > 0.01) {
    throw new OpsError("failed-precondition", "The amount paid does not match the order.");
  }
  const result = await applyPurchase(data.order_id, capture.id ?? null);
  return {
    credited: result.applied, product: result.product,
    credits: result.credits ?? null, unlimited_until: result.unlimited_until ?? null,
  };
}

/**
 * PayPal's settlement notice. Public, so verified with PayPal's own
 * verify-webhook-signature before anything is granted.
 */
export async function paypalWebhook(req: Request): Promise<Response> {
  const h = (n: string) => req.headers.get(n) ?? "";
  if (!h("paypal-transmission-id") || !h("paypal-transmission-sig") || !h("paypal-cert-url")) {
    return new Response("Not a PayPal delivery", { status: 400 });
  }
  const ip = clientIp(req);
  if (ip && await overRateLimit(`ip:${ip}`, "paypalWebhook")) return new Response("Too many requests", { status: 429 });
  const webhookId = env("PAYPAL_WEBHOOK_ID");
  if (!webhookId) return new Response("Webhook not configured", { status: 503 });

  const event = await req.json().catch(() => null);
  const verification = await paypalFetch("/v1/notifications/verify-webhook-signature", {
    method: "POST",
    body: JSON.stringify({
      auth_algo: h("paypal-auth-algo"), cert_url: h("paypal-cert-url"),
      transmission_id: h("paypal-transmission-id"), transmission_sig: h("paypal-transmission-sig"),
      transmission_time: h("paypal-transmission-time"), webhook_id: webhookId, webhook_event: event,
    }),
  });
  if (!verification.ok || verification.body.verification_status !== "SUCCESS") {
    return new Response("Signature verification failed", { status: 400 });
  }
  if (event?.event_type !== "PAYMENT.CAPTURE.COMPLETED") return new Response("ignored", { status: 200 });

  const orderId = event.resource?.supplementary_data?.related_ids?.order_id;
  if (!orderId) return new Response("no order id", { status: 200 });
  try {
    const [order] = await sql`select amount_usd, currency from public.paypal_orders where id = ${orderId}`;
    const paid = Number(event.resource?.amount?.value);
    if (order && Number.isFinite(paid)
      && (event.resource?.amount?.currency_code !== order.currency || Math.abs(paid - Number(order.amount_usd)) > 0.01)) {
      console.error(`PayPal ${orderId}: settled ${paid} against ${order.amount_usd}. Not granting.`);
      return new Response("amount mismatch", { status: 200 });
    }
    const result = await applyPurchase(orderId, event.resource?.id ?? null);
    console.log(`PayPal webhook for ${orderId}: ${result.applied ? "granted" : "already handled"}`);
    return new Response("ok", { status: 200 });
  } catch (err) {
    console.error(`PayPal webhook for ${orderId} failed`, err);
    // 500 so PayPal retries: the buyer has paid and is owed the credits.
    return new Response("retry", { status: 500 });
  }
}
