// PayPal calls this when a payment settles.
//
// Neither the Firebase nor the Supabase backend had a webhook, and the old app
// carried a hand-written apology for the consequence: if the buyer approves the
// payment and then closes the tab before capturePayPalOrder runs, the money is
// taken and no credits are granted. PayPal still tells us — we were just not
// listening.
//
// This endpoint is public, so the event is verified with PayPal's own
// verify-webhook-signature call before anything is granted. An unverified body
// is ignored; without that check anyone could post a fake payment here.
import { onRequest } from "firebase-functions/v2/https";
import { logger } from "firebase-functions";
import { db } from "../lib/admin";
import { COL, PAYPAL_CLIENT_ID, PAYPAL_SECRET, PAYPAL_WEBHOOK_ID, secretValue } from "../lib/config";
import { paypalFetch } from "./client";
import { applyPurchase } from "./applyPurchase";
import { overRateLimit, clientIp } from "../lib/ratelimit";

/** Events that mean money has actually settled. */
const SETTLED = new Set(["PAYMENT.CAPTURE.COMPLETED"]);

export const paypalWebhook = onRequest(
  { secrets: [PAYPAL_CLIENT_ID, PAYPAL_SECRET, PAYPAL_WEBHOOK_ID] },
  async (req, res) => {
    if (req.method !== "POST") {
      res.status(405).send("Method not allowed");
      return;
    }

    // Free checks first. A real PayPal delivery always carries these headers;
    // anything without them is refused before it costs a Firestore write or an
    // outbound call to PayPal.
    const h = (name: string): string => String(req.get(name) ?? "");
    if (!h("paypal-transmission-id") || !h("paypal-transmission-sig") || !h("paypal-cert-url")) {
      res.status(400).send("Not a PayPal delivery");
      return;
    }
    const ip = clientIp(req);
    if (ip && await overRateLimit(`ip:${ip}`, "paypalWebhook")) {
      res.status(429).send("Too many requests");
      return;
    }

    const webhookId = secretValue(PAYPAL_WEBHOOK_ID);
    if (!webhookId) {
      logger.error("PAYPAL_WEBHOOK_ID is not set — refusing to trust this event.");
      res.status(503).send("Webhook not configured");
      return;
    }

    const verification = await paypalFetch("/v1/notifications/verify-webhook-signature", {
      method: "POST",
      body: JSON.stringify({
        auth_algo: h("paypal-auth-algo"),
        cert_url: h("paypal-cert-url"),
        transmission_id: h("paypal-transmission-id"),
        transmission_sig: h("paypal-transmission-sig"),
        transmission_time: h("paypal-transmission-time"),
        webhook_id: webhookId,
        webhook_event: req.body,
      }),
    });

    if (!verification.ok || verification.body.verification_status !== "SUCCESS") {
      logger.warn("Rejected a PayPal webhook that failed signature verification.");
      // 400, not 200: PayPal should retry a genuine event that we mishandled,
      // and a forged one deserves no acknowledgement either way.
      res.status(400).send("Signature verification failed");
      return;
    }

    const event = req.body as {
      event_type?: string;
      resource?: {
        id?: string;
        status?: string;
        amount?: { value?: string; currency_code?: string };
        supplementary_data?: { related_ids?: { order_id?: string } };
      };
    };

    if (!event.event_type || !SETTLED.has(event.event_type)) {
      // Acknowledged and ignored — PayPal sends many event types and retrying
      // the ones we do not act on would be noise.
      res.status(200).send("ignored");
      return;
    }

    // What PayPal says was actually taken. capturePayPalOrder has always
    // checked this against the intent and this path did not: the grant comes
    // from the server-written intent either way, so nothing could be inflated,
    // but a settled capture for a different amount than was agreed is a thing
    // to stop and look at rather than to grant and move on.
    const paid = Number(event.resource?.amount?.value);
    const paidCurrency = event.resource?.amount?.currency_code;

    const orderId = event.resource?.supplementary_data?.related_ids?.order_id;
    if (!orderId) {
      logger.warn(`PayPal ${event.event_type} carried no order id.`);
      res.status(200).send("no order id");
      return;
    }

    try {
      const order = await db.collection(COL.paypalOrders).doc(orderId).get();
      if (order.exists && Number.isFinite(paid)) {
        const agreed = Number(order.get("amount_usd"));
        const currency = order.get("currency");
        if (paidCurrency !== currency || Math.abs(paid - agreed) > 0.01) {
          logger.error(
            `PayPal ${orderId}: settled ${paid} ${paidCurrency} against an agreed `
            + `${agreed} ${currency}. Not granting.`);
          // 200: the event is genuine and retrying will not change the amount.
          res.status(200).send("amount mismatch");
          return;
        }
      }
      // Idempotent: if capturePayPalOrder already granted, the order document is
      // gone and this grants nothing.
      const result = await applyPurchase(orderId, event.resource?.id ?? null);
      logger.info(`PayPal webhook for order ${orderId}: ${result.applied ? "granted" : "already handled"}`);
      res.status(200).send("ok");
    } catch (err) {
      logger.error(`PayPal webhook for order ${orderId} failed: ${(err as Error).message}`);
      // 500 so PayPal retries — the buyer has paid and is owed the credits.
      res.status(500).send("retry");
    }
  },
);
