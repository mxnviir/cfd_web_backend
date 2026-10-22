import React from "react";
import { LegalPage } from "../components/LegalPage";

// Where the refund line falls, by status. This is the rule refundJob enforces
// (functions/src/jobs/refundJob.ts): everything up to and including meshing
// is refunded in full, and once the solver has started the compute is spent.
// Change one and the other has to change with it.
const REFUNDS = [
  ['Pending', 'All credits back', true],
  ['Uploading geometry or meshing', 'All credits back', true],
  ['Running or complete', 'No refund', false],
];

const CLAUSES = [{
  t: 'How to get a simulation refund',
  b: 'Cancel the run on the Simulations page before the solver starts. The credits go back to your account straight away, and there is no need to contact us.'
}, {
  t: 'Credit purchase refunds',
  b: 'Credit purchases made via PayPal are refundable. If your credits were not delivered after a successful payment, contact us with your PayPal receipt and we will resolve it manually. You can get a refund of unused credits within 7 Days of purchase. Moreover, you can also dispute charges through PayPal.'
}, {
  t: 'Exceptional circumstances',
  b: 'If a simulation fails due to a technical error on our end (not caused by your file), we will refund the full credits at our discretion. Contact us with your job ID and a description of the issue. We review all such requests within 48 hours.'
}, {
  t: 'Sponsored and discounted accounts',
  b: 'Refund terms for sponsored accounts are the same as standard accounts. The refund amount is calculated based on the credits charged, not the monetary equivalent.'
}];

const RefundPolicyView = () => (
  <LegalPage title="Refund policy" updated="February 2026" clauses={CLAUSES}>
    <h2 className="t-h3 clause-lead">Cancelling a simulation</h2>
    <dl className="facts">
      {REFUNDS.map(([status, refund, ok]) => (
        <React.Fragment key={status}>
          <dt>{status}</dt>
          <dd className={ok ? 'is-ok' : 'is-bad'}>{refund}</dd>
        </React.Fragment>
      ))}
    </dl>
  </LegalPage>
);

export { RefundPolicyView };
