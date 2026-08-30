# Buyer-committee and relationship-coverage intelligence

DealGuard evaluates whether an opportunity has enough structured stakeholder evidence to support a sales review. The feature is deterministic and explainable. It does not inspect communication content, infer sentiment, calculate buyer intent, or predict whether a deal will be won.

## Customer questions answered

- Is the opportunity dependent on one customer relationship?
- Are a decision maker, budget holder, and internal champion explicitly identified?
- Which supporting roles are present, such as executive sponsor, technical evaluator, procurement, legal/compliance, end user, influencer, or implementer?
- Is the buying company unambiguous?
- Which role conclusions come from deal-specific labels, contact-level buying-role values, or lower-confidence job-title hints?
- What should the deal owner do next to improve relationship coverage?

## HubSpot data boundary

The feature uses existing OAuth permissions only:

- `crm.objects.deals.read`
- `crm.objects.contacts.read`
- `crm.objects.companies.read`

It adds no OAuth scope and no database migration.

On record-open and explicit record-refresh paths, DealGuard requests:

### Deal associations

- `/crm/associations/2026-03/deals/contacts/batch/read`
- `/crm/associations/2026-03/deals/companies/batch/read`

Association responses provide the associated record IDs and any relationship labels applied to each deal association.

### Contact properties

- `firstname`
- `lastname`
- `jobtitle`
- `hs_buying_role`
- `lastmodifieddate`

### Company properties

- `name`
- `domain`
- `industry`
- `hs_lastmodifieddate`

Email addresses, phone numbers, notes, email bodies, call bodies, meeting content, recordings, and message text are not requested or returned by this feature.

## Evidence hierarchy

Role evidence is classified by source.

1. **Deal association label — confirmed:** deal-specific evidence such as Decision maker or Champion.
2. **HubSpot contact buying role — contextual:** an explicit contact-level value that may apply beyond the current deal.
3. **Job-title hint — inferred:** a lower-confidence hint used only to direct review. It never confirms authority or advocacy.

The UI preserves these distinctions. A job title cannot by itself produce strong relationship coverage.

## Deterministic coverage model

The coverage score is based on:

- decision-maker evidence;
- budget-holder evidence;
- champion evidence;
- executive-sponsor evidence;
- technical-evaluator evidence;
- stakeholder breadth;
- unambiguous company context.

Deal-specific association labels receive full evidence weight, contact-level buying roles receive reduced weight, and job-title hints receive limited weight. A deal can be classified as `strong` only when all three core roles are explicitly identified.

The output includes:

- `strong`, `partial`, or `weak` coverage status;
- evidence confidence;
- single-threading status;
- explicit-role and association-label coverage percentages;
- role-by-role evidence and people;
- primary-company evidence;
- explainable signals;
- recommended actions with owner, priority, due date, rationale, and evidence codes;
- truncation and methodology limitations.

## Runtime controls

- Relationship enrichment runs only for a deal record open or explicit record refresh.
- Full portal scans, scheduled scans, webhooks, and workflow actions remain current-state readiness operations.
- Contact reads are capped at 100 and company reads at 20 per deal.
- Association pagination is followed only up to those limits.
- The existing 60-second record-enrichment cache is shared across DealGuard record cards.
- If relationship APIs fail, DealGuard logs the optional enrichment failure and returns the deterministic readiness result instead of failing the record card.

## Product surfaces

- **Main DealGuard card:** concise relationship score, confidence, core roles, primary company, and key signals.
- **Relationship Coverage card:** full role evidence, associated stakeholders, company context, signals, and evidence limitations.
- **Recommended Actions card:** relationship interventions combined with momentum and close-date actions, then ordered by priority.

## Interpretation boundary

Relationship coverage describes the structure and quality of CRM evidence. It is not:

- buyer intent;
- sentiment;
- engagement quality;
- stakeholder influence measured from communications;
- a win probability;
- a forecast category;
- an expected-loss estimate.

Those capabilities require separate data access, governance, evaluation, and customer consent.
