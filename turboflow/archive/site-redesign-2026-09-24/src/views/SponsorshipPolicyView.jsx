import React from "react";
import { LegalPage } from "../components/LegalPage";

const CLAUSES = [{
  t: '1. Eligibility',
  b: 'Sponsorship is open to active student racing and STEM competition teams registered for an upcoming competitive event. At least one team member must hold a valid university or school email address. Applications are reviewed on a case-by-case basis and acceptance is at TurboFlow sole discretion.'
}, {
  t: '2. Discount structure',
  b: 'Accepted teams are granted a discounted simulation rate. The discount tier (up to 60%, 70%, or 80% off standard credit costs) is determined at the time of acceptance based on team size, competition level, marketing, and usage estimate. The discount rate is locked for the duration of the agreed sponsorship period and applied automatically to every simulation you run.'
}, {
  t: '3. Sponsored store access',
  b: 'Discounted store links are provided directly to the team contact on acceptance. These links must not be shared publicly or with individuals outside the team. TurboFlow reserves the right to revoke store access if links are found to be shared outside the approved team.'
}, {
  t: '4. Obligations',
  b: 'Sponsored teams are not required to display TurboFlow branding on cars or pit displays unless separately mentioned in the google forms link or through any medium of communication. Sponsored teams MUST put the turboflow logo on their official team uniform and any other merchandise. The team shall give TurboFlow the right to use their team name and logo(s) for promotional material. Teams may optionally share anonymised simulation results for our case study library: this is never mandatory. We may ask for a short testimonial or project update at the end of your competition season.'
}, {
  t: '5. Duration and renewal',
  b: 'Sponsorship is granted for one competition season by default. Renewal is not automatic. Teams wishing to continue must reapply before their discount expires.'
}, {
  t: '6. Termination',
  b: 'TurboFlow may revoke sponsorship status and discount access if: store links are shared externally, the team is found to be inactive or no longer competing, or the team is found to have provided false information in their application. No credit refunds are issued upon revocation.'
}, {
  t: '7. No exclusivity',
  b: 'TurboFlow sponsorship programme does not grant any exclusivity. We sponsor multiple teams across the same competition series and do not restrict teams from using other simulation providers.'
}, {
  t: '8. Amendments',
  b: 'TurboFlow reserves the right to amend the sponsorship terms at any time. Teams will be notified of material changes via the contact email provided in their application. Continued use of discounted access after notification constitutes acceptance of updated terms.'
}];

const SponsorshipPolicyView = () => (
  <LegalPage title="Sponsorship policy" updated="February 2026" clauses={CLAUSES} />
);

export { SponsorshipPolicyView };
