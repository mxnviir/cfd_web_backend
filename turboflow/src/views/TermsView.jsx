import React from "react";
import { LegalPage } from "../components/LegalPage";

const CLAUSES = [{
  t: '1. Acceptance of terms',
  b: 'By accessing or using TurboFlow ("the Service"), you agree to be bound by these Terms of Service. If you do not agree to these terms, do not use the Service. We reserve the right to update these terms at any time. Continued use of the Service after changes constitutes acceptance.'
}, {
  t: '2. Description of the service',
  b: 'TurboFlow provides cloud-based CFD (Computational Fluid Dynamics) simulation services. Users upload geometry files which are processed by our pipeline. Results are returned digitally. We do not guarantee any specific aerodynamic outcome or performance improvement from simulations.'
}, {
  t: '3. Account responsibilities',
  b: 'You are responsible for maintaining the security of your account credentials. You must provide accurate information when registering. Accounts may not be shared between individuals. You are responsible for all activity that occurs under your account.'
}, {
  t: '4. Credits and payment',
  b: 'Credits are purchased via PayPal and are non-transferable between accounts. Credits have no cash value and cannot be redeemed for money. Unused credits do not expire. Credits are added automatically to the signed-in account once the payment is captured. See our Refund Policy for simulation refund terms.'
}, {
  t: '5. Acceptable use',
  b: 'You may not use the Service to process files you do not own or have rights to. You may not attempt to reverse-engineer, abuse, or overload our simulation infrastructure. Automated or bulk submission without prior approval is prohibited. We reserve the right to suspend accounts that violate these terms without notice. Sharing your account with any other teams is prohibited and will result in the termination of your account.'
}, {
  t: '6. Intellectual property',
  b: 'You retain ownership of all geometry files you upload. TurboFlow retains ownership of its simulation pipeline, software, and infrastructure. Anonymised aggregate results may be used by TurboFlow for research and case study purposes unless you opt out in writing.'
}, {
  t: '7. Limitation of liability',
  b: 'TurboFlow is provided on an "as is" basis. We make no warranties about simulation accuracy, uptime, or fitness for any particular purpose. To the maximum extent permitted by law, TurboFlow is not liable for any indirect, incidental, or consequential damages arising from use of the Service.'
}, {
  t: '8. Termination',
  b: 'We may suspend or terminate your account at our discretion for violation of these terms. You may delete your account at any time. Upon termination, unused credits are forfeited.'
}, {
  t: '9. Use of other services',
  b: 'Modelling services, Race Time calculator use and other mentorship services are only provided to customers who have spent more than $50 (or the equivalent in local currency) on TurboFlow credits.'
}, {
  t: '10. Governing law',
  b: 'These terms are governed by and construed in accordance with the laws of the United Arab Emirates.'
}, {
  t: '11. Contact',
  b: 'For questions about these terms, contact us via our Instagram page or through the contact form linked in the Sponsorship section.'
}];

const TermsView = () => (
  <LegalPage title="Terms of service" updated="February 2026" clauses={CLAUSES} />
);

export { TermsView };
