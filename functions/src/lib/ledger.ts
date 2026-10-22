// The only place in this backend that changes a credit balance.
//
// This exists because of the vulnerability it replaces. The old refundJob read
// the amount to hand back straight off the job document:
//
//     const amount = job.cost ?? 100;
//
// and the Firestore rules let any signed-in user create a job with any cost they
// liked. Create jobs/x with {userId: self, status: 'pending', cost: 1e9}, call
// refundJob, take a billion credits — and the old code then deleted the job,
// destroying the evidence.
//
// The fix is that a refund is not derived from anything the client wrote. It is
// derived from the ledger: the sum of the charge rows this backend itself
// recorded for that job, minus anything already refunded. A forged job has no
// charge row, so it refunds exactly zero.
//
// Ledger rows live at users/{uid}/transactions and are blocked to all client
// writes by firestore.rules. Row ids are deterministic where a repeat must not
// double-count, so replaying an operation is a no-op rather than a second
// payout.
import { FieldValue, Timestamp } from "firebase-admin/firestore";
import type { Firestore, Transaction, DocumentReference } from "firebase-admin/firestore";
import { COL } from "./config";
import type { TransactionType } from "./types";

export interface LedgerRow {
  type: TransactionType;
  /** Negative for money leaving the account, positive for money arriving. */
  amount: number;
  reason: string;
  job_id?: string;
  order_id?: string;
  capture_id?: string;
  timestamp: FirebaseFirestore.FieldValue;
}

const userRef = (db: Firestore, uid: string): DocumentReference =>
  db.collection(COL.users).doc(uid);

const txnCol = (db: Firestore, uid: string) =>
  userRef(db, uid).collection(COL.transactions);

/** Deterministic ids. Same operation on the same job always lands on the same row. */
export const rowId = {
  charge: (jobId: string) => `charge_${jobId}`,
  reversal: (jobId: string) => `reversal_${jobId}`,
  refund: (jobId: string) => `refund_${jobId}`,
};

export interface JobLedger {
  /** Credits actually taken for this job (a positive number). */
  charged: number;
  /** Credits already given back for this job (a positive number). */
  refunded: number;
  /** What is still owed to the user if the job is cancelled now. Never negative. */
  outstanding: number;
}

/**
 * Read what this backend has recorded against one job.
 *
 * Must be called before any write in the same transaction — Firestore requires
 * all reads to precede all writes, and getting that wrong fails the whole
 * transaction at commit rather than at the call.
 */
export async function readJobLedger(
  db: Firestore, txn: Transaction, uid: string, jobId: string,
): Promise<JobLedger> {
  const snap = await txn.get(txnCol(db, uid).where("job_id", "==", jobId));

  let charged = 0;
  let refunded = 0;
  for (const doc of snap.docs) {
    const d = doc.data() as LedgerRow;
    const amount = Number(d.amount);
    if (!Number.isFinite(amount)) continue;
    if (d.type === "simulation_charge") charged += Math.abs(amount);
    else if (d.type === "refund" || d.type === "simulation_charge_reversal") refunded += Math.abs(amount);
  }
  return { charged, refunded, outstanding: Math.max(0, charged - refunded) };
}

/** Take credits for a job. Idempotent: a second call for the same job writes nothing. */
export function writeCharge(
  db: Firestore, txn: Transaction, uid: string, jobId: string, amount: number, reason: string,
): void {
  if (amount <= 0) return;
  txn.update(userRef(db, uid), { credits: FieldValue.increment(-amount) });
  txn.create(txnCol(db, uid).doc(rowId.charge(jobId)), {
    type: "simulation_charge",
    amount: -amount,
    reason,
    job_id: jobId,
    timestamp: FieldValue.serverTimestamp(),
  });
}

/** Give credits back because the user cancelled before the work was done. */
export function writeRefund(
  db: Firestore, txn: Transaction, uid: string, jobId: string, amount: number, reason: string,
): void {
  if (amount <= 0) return;
  txn.update(userRef(db, uid), { credits: FieldValue.increment(amount) });
  txn.create(txnCol(db, uid).doc(rowId.refund(jobId)), {
    type: "refund",
    amount,
    reason,
    job_id: jobId,
    timestamp: FieldValue.serverTimestamp(),
  });
}

/**
 * Give credits back because we charged and then could not start the work.
 *
 * Kept distinct from a refund so the two are tellable apart in an audit: a
 * refund is the user changing their mind, a reversal is this service failing.
 */
export function writeReversal(
  db: Firestore, txn: Transaction, uid: string, jobId: string, amount: number, reason: string,
): void {
  if (amount <= 0) return;
  txn.update(userRef(db, uid), { credits: FieldValue.increment(amount) });
  txn.create(txnCol(db, uid).doc(rowId.reversal(jobId)), {
    type: "simulation_charge_reversal",
    amount,
    reason,
    job_id: jobId,
    timestamp: FieldValue.serverTimestamp(),
  });
}

/** Add credits from a paid purchase or a signup bonus. */
export function writeGrant(
  db: Firestore, txn: Transaction, uid: string,
  opts: { type: TransactionType; amount: number; reason: string; rowKey?: string; order_id?: string; capture_id?: string },
): void {
  if (opts.amount > 0) {
    txn.update(userRef(db, uid), { credits: FieldValue.increment(opts.amount) });
  }
  const ref = opts.rowKey ? txnCol(db, uid).doc(opts.rowKey) : txnCol(db, uid).doc();
  txn.set(ref, {
    type: opts.type,
    amount: opts.amount,
    reason: opts.reason,
    ...(opts.order_id ? { order_id: opts.order_id } : {}),
    ...(opts.capture_id ? { capture_id: opts.capture_id } : {}),
    timestamp: FieldValue.serverTimestamp(),
  });
}

/** Extend an unlimited pass, stacking on whatever time is left. */
export function extendUnlimited(
  db: Firestore, txn: Transaction, uid: string,
  current: { unlimited_until?: Timestamp | null; unlimited_started_at?: Timestamp | null },
  days: number,
  now = Date.now(),
): number {
  const curMs = current.unlimited_until?.toMillis?.() ?? 0;
  const active = curMs > now;
  const untilMs = (active ? curMs : now) + days * 24 * 60 * 60 * 1000;
  // Keep the original start date while a pass is still running, so the UI can
  // show "12 of 30 days left" rather than restarting the clock on every top-up.
  const startMs = active ? (current.unlimited_started_at?.toMillis?.() ?? now) : now;

  txn.update(userRef(db, uid), {
    unlimited_until: Timestamp.fromMillis(untilMs),
    unlimited_started_at: Timestamp.fromMillis(startMs),
  });
  return untilMs;
}
