/** Demo personas (static demo only; kept free of heavy imports so the production bundle stays small). */
/** Public sandbox password for the seeded demo accounts (the data is synthetic and lives only in the browser tab). */
export const DEMO_PASSWORD = 'OrvmsDemo-2026';

export interface Persona {
  username: string;
  label: string;
  who: string;
  blurb: string;
  /** concrete things to try, shown at the end of the guided tour */
  tryThis: string[];
}

export const PERSONAS: Persona[] = [
  {
    username: 'analyst', label: 'Coast Guard analyst', who: 'Maritime security', blurb: 'Live picture, graded alerts, geofences, case desk.',
    tryThis: ['Open Live map, click a vessel with a red ring, read its alerts.', 'Press "Report boat" and click the sea: a case is created and routed to the nearest desk.', 'Watch the alert queue: zone entries, AIS gaps and spoofing arrive on their own.'],
  },
  {
    username: 'cg.kochi', label: 'CG controller, Kochi', who: 'Regional desk', blurb: 'Works the cases routed to the Kochi desk.',
    tryThis: ['Open Case desk: cases carry priority P1-P4 and an SLA timer.', 'Acknowledge or assign a case; speed the clock to 16x and watch an unattended case escalate.', 'Open Service levels to see response times by desk.'],
  },
  {
    username: 'operator', label: 'Fleet operator', who: 'Shipping company', blurb: 'Voyages, supply-chain control tower, fleet.',
    tryThis: ['Open Supply chain: delivery risk is computed from the vessel position against the committed date.', 'Open Voyages and plan one: the route is risk-assessed automatically.', 'A high-risk voyage cannot start until it is approved: switch to the Risk officer to approve it.'],
  },
  {
    username: 'riskofficer', label: 'Risk officer', who: 'Shipping company', blurb: 'Approves voyages (four-eyes).',
    tryThis: ['Open Voyages: approve the one that is awaiting approval.', 'Critical voyages need two approvers, and the preparer can never approve their own.', 'Open Compliance reports to see the audit trail.'],
  },
  {
    username: 'orgadmin', label: 'Organisation admin', who: 'Shipping company', blurb: 'Registry, API keys, webhooks, billing.',
    tryThis: ['Open Fleet registry and try the CSV import.', 'Open Organisation: create an API key (shown once, stored as a hash) and a signed webhook.', 'Open Billing & contract: plan, usage against quota, GST invoices.'],
  },
  {
    username: 'admin', label: 'Platform admin', who: 'ORVMS operations', blurb: 'Customers, revenue, health, audit.',
    tryThis: ['Open Customers: tenants, plans and onboarding.', 'Open Operations: background-job health, structured logs, environment.', 'Open Revenue: receivables and plan mix across tenants.'],
  },
];

