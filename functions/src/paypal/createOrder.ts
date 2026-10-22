// Open a PayPal order for credits or an unlimited pass.
//
// The client sends a quantity and nothing else. The server derives both the
// price and the entitlement from that quantity and records them in a document
// the client cannot touch, so a request can never pay a little and be granted a
// lot. That part of the old code was already right and is kept.
import { onCall, HttpsError } from "firebase-functions/v2/https";
import { Timestamp, FieldValue } from "firebase-admin/firestore";
import { db } from "../lib/admin";
import { COL, PAYPAL_CLIENT_ID, PAYPAL_SECRET } from "../lib/config";
import { guard } from "../lib/guard";
import { createPayPalOrderSchema } from "../lib/schema";
import { getPricing, paypalFetch } from "./client";
import type { UserDoc } from "../lib/types";

export const createPayPalOrder = onCall(
  { secrets: [PAYPAL_CLIENT_ID, PAYPAL_SECRET] },
  async (request) => {
    const { uid, data } = await guard(request, "createPayPalOrder", createPayPalOrderSchema, { humanOnly: true });
    const cfg = await getPricing();

    const buyerSnap = await db.collection(COL.users).doc(uid).get();
    const buyer = (buyerSnap.exists ? buyerSnap.data() : {}) as UserDoc;

    // A per-account rate overrides the global one, so an individual team can be
    // priced without changing anyone else's price.
    const usdPerCredit = Number(buyer.usd_per_credit) > 0
      ? Number(buyer.usd_per_credit)
      : cfg.usdPer100Credits / 100;
    const usdPerMonth = Number(buyer.unlimited_usd) > 0
      ? Number(buyer.unlimited_usd)
      : cfg.unlimitedMonthlyUSD;

    let value: string;
    let description: string;
    let intent: Record<string, unknown>;

    if (data.product === "unlimited") {
      if (data.months > cfg.maxUnlimitedMonths) {
        throw new HttpsError("invalid-argument", `At most ${cfg.maxUnlimitedMonths} months at a time.`);
      }
      const days = data.months * cfg.unlimitedDays;
      value = (data.months * usdPerMonth).toFixed(2);
      description = `TurboFlow Unlimited, ${data.months} month(s), ${days} days`;
      intent = { uid, kind: "unlimited", days, months: data.months };
    } else {
      if (data.credits < cfg.minCredits || data.credits > cfg.maxCredits) {
        throw new HttpsError(
          "invalid-argument",
          `Credits must be between ${cfg.minCredits} and ${cfg.maxCredits}.`,
        );
      }
      value = (data.credits * usdPerCredit).toFixed(2);
      description = `${data.credits} TurboFlow credits`;
      intent = { uid, kind: "credits", credits: data.credits };
    }

    if (Number(value) <= 0) {
      throw new HttpsError("invalid-argument", "That works out to nothing to pay.");
    }

    const { ok, status, body } = await paypalFetch("/v2/checkout/orders", {
      method: "POST",
      body: JSON.stringify({
        intent: "CAPTURE",
        purchase_units: [{
          amount: { currency_code: cfg.currency, value },
          custom_id: uid,
          description,
        }],
      }),
    });
    if (!ok) throw new HttpsError("internal", `PayPal would not open the order (${status}).`);

    const orderId = String(body.id);

    // The tamper-proof record of what was agreed. Deleted on capture; a TTL
    // policy on expire_at clears abandoned checkouts, which otherwise pile up.
    await db.collection(COL.paypalOrders).doc(orderId).set({
      ...intent,
      amount_usd: Number(value),
      currency: cfg.currency,
      status: "created",
      created_at: FieldValue.serverTimestamp(),
      expire_at: Timestamp.fromMillis(Date.now() + 3 * 60 * 60 * 1000),
    });

    return {
      order_id: orderId,
      product: data.product,
      amount: Number(value),
      currency: cfg.currency,
      credits: (intent.credits as number | undefined) ?? null,
      days: (intent.days as number | undefined) ?? null,
      months: (intent.months as number | undefined) ?? null,
    };
  },
);
