// Grant what a completed payment bought, exactly once.
//
// Shared by the capture callable and the webhook so both routes cannot grant
// twice for the same order, and so a buyer who closes the tab after approving
// still gets what they paid for.
//
// Idempotency is the order document: it is deleted as part of the same
// transaction that grants. If it is already gone, someone got there first and
// this call grants nothing.
import { db } from "../lib/admin";
import { COL } from "../lib/config";
import { writeGrant, extendUnlimited } from "../lib/ledger";
import type { UserDoc } from "../lib/types";

export interface PurchaseResult {
  applied: boolean;
  product: "credits" | "unlimited";
  credits: number | null;
  unlimited_until: number | null;
}

export async function applyPurchase(orderId: string, captureId: string | null): Promise<PurchaseResult> {
  const orderRef = db.collection(COL.paypalOrders).doc(orderId);

  return await db.runTransaction(async (txn) => {
    const orderSnap = await txn.get(orderRef);
    if (!orderSnap.exists) {
      // Already applied by the other route, or by a retry of this one.
      return { applied: false, product: "credits", credits: null, unlimited_until: null };
    }
    const intent = orderSnap.data() as {
      uid: string; kind: "credits" | "unlimited";
      credits?: number; days?: number; amount_usd?: number;
    };

    const userRef = db.collection(COL.users).doc(intent.uid);
    const userSnap = await txn.get(userRef);
    if (!userSnap.exists) throw new Error("The buyer's account no longer exists.");
    const user = userSnap.data() as UserDoc;

    const paid = `$${Number(intent.amount_usd ?? 0).toFixed(2)}`;

    if (intent.kind === "unlimited") {
      const days = Number(intent.days) > 0 ? Number(intent.days) : 30;
      const untilMs = extendUnlimited(db, txn, intent.uid, user, days);
      writeGrant(db, txn, intent.uid, {
        type: "unlimited_pass",
        amount: 0,
        reason: `PayPal ${paid}, unlimited for ${days} days`,
        rowKey: `order_${orderId}`,
        order_id: orderId,
        ...(captureId ? { capture_id: captureId } : {}),
      });
      txn.delete(orderRef);
      return { applied: true, product: "unlimited", credits: null, unlimited_until: untilMs };
    }

    const credits = Number(intent.credits) || 0;
    writeGrant(db, txn, intent.uid, {
      type: "purchase",
      amount: credits,
      reason: `PayPal ${paid}, ${credits} credits`,
      rowKey: `order_${orderId}`,
      order_id: orderId,
      ...(captureId ? { capture_id: captureId } : {}),
    });
    txn.delete(orderRef);
    return { applied: true, product: "credits", credits, unlimited_until: null };
  });
}
