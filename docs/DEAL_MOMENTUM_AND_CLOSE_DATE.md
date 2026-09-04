# Deal momentum and close-date credibility

DealGuard derives deterministic deal-process intelligence from HubSpot CRM property history. This capability does not inspect email or meeting content, infer buyer intent, or produce a machine-learning win probability.

## Evidence collected

Using the existing `crm.objects.deals.read` permission, DealGuard requests history for:

- `dealstage`
- `closedate`
- `amount`
- `hubspot_owner_id`
- `hs_next_step`

The current stage-entry timestamp and last recorded sales-activity timestamp remain part of the evidence set.

## CRM process momentum

The momentum signal uses a rolling 90-day evidence window. It considers:

- forward and backward stage movement;
- pipeline movement;
- close-date pushes and pull-ins;
- ownership churn;
- amount changes;
- next-step changes;
- time since the last tracked material change;
- current stage age against policy;
- recorded sales-activity freshness.

The result is one of:

- `strong`
- `watch`
- `stalled`
- `insufficient_data`

A numerical score is omitted when fewer than 40% of tracked history fields have usable evidence.

## Close-date credibility

Close-date credibility starts from the current HubSpot close date and applies explainable deductions for:

- an overdue date;
- repeated later date changes;
- stage regression;
- stage age above policy;
- no next step near close;
- stale recorded activity near close.

The result is `credible`, `watch`, `weak`, or `unavailable`. It is a deterministic CRM-evidence assessment, not a predicted probability of winning or closing.

## Recommended actions

Decision actions include an explicit owner, priority, due date, rationale, and supporting evidence codes. Typical actions include:

- reconfirming a repeatedly pushed close date;
- reviewing a stage regression with the sales manager;
- recording a buyer-committed next step;
- requalifying a stalled opportunity;
- stabilizing deal ownership;
- resolving a stage-age exception.

DealGuard does not autonomously change stage, amount, owner, close date, forecast category, or next step.

## API versioning

The dedicated property-history and pipeline-metadata reads use HubSpot's date-versioned `2026-03` CRM APIs. Property history is requested only when a deal record is opened or explicitly refreshed. Webhook, workflow, and full-portal scan paths remain current-state assessments in this slice, avoiding history API cost where the result is not immediately customer-visible. If HubSpot history is temporarily unavailable, DealGuard returns the deterministic readiness assessment without momentum enrichment rather than failing the core deal card.

## Privacy boundary

Only structured CRM property values and timestamps are processed in this slice. Message bodies, call recordings, and meeting content are outside scope.
