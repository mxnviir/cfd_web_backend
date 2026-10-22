// Talking to PayPal, and the prices we charge.
//
// Credentials come from Secret Manager rather than a .env file sitting in the
// source tree next to the code that reads it.
import { HttpsError } from "firebase-functions/v2/https";
import { db } from "../lib/admin";
import { COL, PAYPAL_CLIENT_ID, PAYPAL_SECRET, paypalBase, secretValue } from "../lib/config";

export interface PricingConfig {
  usdPer100Credits: number;
  currency: string;
  minCredits: number;
  maxCredits: number;
  unlimitedMonthlyUSD: number;
  unlimitedDays: number;
  maxUnlimitedMonths: number;
}

const DEFAULTS: PricingConfig = Object.freeze({
  usdPer100Credits: 5,
  currency: "USD",
  minCredits: 100,
  maxCredits: 20000,
  unlimitedMonthlyUSD: 100,
  unlimitedDays: 30,
  maxUnlimitedMonths: 24,
});

const positive = (v: unknown, fallback: number): number => {
  const n = Number(v);
  return n > 0 ? n : fallback;
};

/** Prices live in Firestore so they can change without a redeploy. */
export async function getPricing(): Promise<PricingConfig> {
  try {
    const snap = await db.collection(COL.config).doc("pricing").get();
    const d = (snap.exists ? snap.data() : {}) ?? {};
    return {
      usdPer100Credits: positive(d.usdPer100Credits, DEFAULTS.usdPer100Credits),
      currency: typeof d.currency === "string" && d.currency ? d.currency : DEFAULTS.currency,
      minCredits: Math.floor(positive(d.minCredits, DEFAULTS.minCredits)),
      maxCredits: Math.floor(positive(d.maxCredits, DEFAULTS.maxCredits)),
      unlimitedMonthlyUSD: positive(d.unlimitedMonthlyUSD, DEFAULTS.unlimitedMonthlyUSD),
      unlimitedDays: Math.floor(positive(d.unlimitedDays, DEFAULTS.unlimitedDays)),
      maxUnlimitedMonths: Math.floor(positive(d.maxUnlimitedMonths, DEFAULTS.maxUnlimitedMonths)),
    };
  } catch {
    return { ...DEFAULTS };
  }
}

export async function accessToken(): Promise<string> {
  const id = secretValue(PAYPAL_CLIENT_ID);
  const secret = secretValue(PAYPAL_SECRET);
  if (!id || !secret) {
    throw new HttpsError("failed-precondition", "PayPal is not configured on this server.");
  }
  const basic = Buffer.from(`${id}:${secret}`).toString("base64");
  const resp = await fetch(`${paypalBase()}/v1/oauth2/token`, {
    method: "POST",
    headers: {
      Authorization: `Basic ${basic}`,
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: "grant_type=client_credentials",
  });
  if (!resp.ok) {
    throw new HttpsError("internal", `PayPal authentication failed (${resp.status}).`);
  }
  return ((await resp.json()) as { access_token: string }).access_token;
}

export async function paypalFetch(
  path: string, init: RequestInit = {},
): Promise<{ ok: boolean; status: number; body: Record<string, unknown> }> {
  const token = await accessToken();
  const resp = await fetch(`${paypalBase()}${path}`, {
    ...init,
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
      ...(init.headers ?? {}),
    },
  });
  const body = (await resp.json().catch(() => ({}))) as Record<string, unknown>;
  return { ok: resp.ok, status: resp.status, body };
}
