// Capture an approved PayPal order and grant what it bought.
//
// The old capturePayPalOrder was the one piece of the money path that was
// already sound: server-side capture, the captured amount and currency
// reconciled against a server-written intent, granting idempotent inside a
// transaction. That logic is kept as it was.
//
// One check is added, from the Supabase port: the *capture* must be COMPLETED,
// not just the order. An eCheck or a fraud hold reads order-COMPLETED while the
// capture is still PENDING, and granting there hands over credits before the
// money has settled.
import { onCall, HttpsError } from "firebase-functions/v2/https";
import { db } from "../lib/admin";
import { COL, PAYPAL_CLIENT_ID, PAYPAL_SECRET } from "../lib/config";
import { guard } from "../lib/guard";
import { capturePayPalOrderSchema } from "../lib/schema";
import { paypalFetch } from "./client";
import { applyPurchase } from "./applyPurchase";

interface Capture {
  status?: string;
  amount?: { value?: string; currency_code?: string };
  id?: string;
}

export const capturePayPalOrder = onCall(
  { secrets: [PAYPAL_CLIENT_ID, PAYPAL_SECRET] },
  async (request) => {
    const { uid, data } = await guard(request, "capturePayPalOrder", capturePayPalOrderSchema, { humanOnly: true });
    const orderId = data.order_id;

    const orderSnap = await db.collection(COL.paypalOrders).doc(orderId).get();
    if (!orderSnap.exists) throw new HttpsError("not-found", "That order was not found.");
    const intent = orderSnap.data() as { uid: string; amount_usd: number; currency: string };

    if (intent.uid !== uid) {
      throw new HttpsError("permission-denied", "That order is not yours.");
    }

    let res = await paypalFetch(`/v2/checkout/orders/${orderId}/capture`, { method: "POST" });

    // If a previous attempt captured at PayPal but crashed before granting,
    // PayPal answers 422 ORDER_ALREADY_CAPTURED. Re-read the order so the buyer
    // still gets what they paid for; applyPurchase stays idempotent.
    const details = res.body.details as { issue?: string }[] | undefined;
    if (!res.ok && Array.isArray(details) && details.some((d) => d.issue === "ORDER_ALREADY_CAPTURED")) {
      res = await paypalFetch(`/v2/checkout/orders/${orderId}`, { method: "GET" });
    }
    if (!res.ok) {
      throw new HttpsError("internal", `PayPal capture failed (${res.status}).`);
    }
    if (res.body.status !== "COMPLETED") {
      throw new HttpsError("failed-precondition", `Payment is not complete (${String(res.body.status)}).`);
    }

    // Reconcile what PayPal actually took against what was agreed.
    let capture: Capture;
    try {
      const units = res.body.purchase_units as { payments?: { captures?: Capture[] } }[];
      const first = units?.[0]?.payments?.captures?.[0];
      if (!first) throw new Error("no capture");
      capture = first;
    } catch {
      throw new HttpsError("internal", "Could not read the payment details from PayPal.");
    }

    // The added check. Order COMPLETED with capture PENDING means the money has
    // not settled yet.
    if (capture.status !== "COMPLETED") {
      throw new HttpsError(
        "failed-precondition",
        `The payment has not settled yet (${String(capture.status)}). Credits are granted once it does.`,
      );
    }

    const paidValue = Number(capture.amount?.value);
    const paidCurrency = capture.amount?.currency_code;
    if (paidCurrency !== intent.currency || Math.abs(paidValue - Number(intent.amount_usd)) > 0.01) {
      throw new HttpsError("failed-precondition", "The amount paid does not match the order.");
    }

    const result = await applyPurchase(orderId, capture.id ?? null);
    return {
      credited: result.applied,
      product: result.product,
      credits: result.credits,
      unlimited_until: result.unlimited_until,
    };
  },
);
