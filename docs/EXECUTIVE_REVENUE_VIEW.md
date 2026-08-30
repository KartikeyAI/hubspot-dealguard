# DealGuard Executive Revenue View

The Executive Revenue View is a deterministic, currency-safe portfolio surface for current open deals. It uses recorded HubSpot deal state, current DealGuard readiness evidence, current bounded Deal Brief snapshots, and daily executive snapshots.

It does not produce a calibrated forecast, buyer-intent score, win probability, expected revenue, or expected loss.

## Endpoint

```text
GET /api/v1/enterprise/executive-revenue
```

The endpoint requires:

- an Enterprise DealGuard entitlement;
- the existing `analytics.view` permission;
- compliance with the caller's assigned pipeline, team, owner, and region scope.

Supported query parameters:

```text
periodStart=YYYY-MM-DD
periodEnd=YYYY-MM-DD
candidateLimit=1..50
refresh=true|false
pipelineId=<HubSpot pipeline ID>
teamId=<HubSpot team ID>
ownerId=<HubSpot owner ID>
regionCode=<configured region code>
```

`periodStart` and `periodEnd` must be supplied together. A custom period can span at most 366 days. Without explicit dates, DealGuard uses the current UTC calendar quarter.

## Evidence sources

The view combines:

1. Current HubSpot deal properties loaded under the existing deal-read permission.
2. Current deterministic DealGuard readiness from `deal_assessments`.
3. Current bounded Deal Brief evidence from `deal_decision_snapshots` when the snapshot matches the latest assessment and is no more than 72 hours old.
4. The latest daily executive snapshot before today for movement comparison.

The HubSpot read requests `hs_forecast_category` as an additional deal property. No additional OAuth scope is required.

## Current-state semantics

Only open deals are included. Each current deal appears once.

The view reports:

- open-deal count;
- deals whose recorded close date is inside the selected period;
- overdue open close dates;
- undated deals;
- recorded Commit and Best case deal counts;
- current Deal Brief intervention count;
- evidence coverage and confidence.

## Recorded forecast categories

Forecast category is treated as customer-supplied CRM evidence. DealGuard normalises common HubSpot values into:

- `commit`;
- `best_case`;
- `pipeline`;
- `not_forecasted`;
- `closed_won`;
- `custom`;
- `unavailable`.

Custom categories remain non-directional unless a future customer-specific ordering is configured. DealGuard does not convert a category into a probability.

## Currency safety

All monetary output is separated into comparable cohorts:

1. HubSpot company currency when `amount_in_home_currency` is available; otherwise
2. one original deal currency identified by `deal_currency_code`.

INR, USD, EUR, and unknown-currency amounts are never summed into one total.

For each safe cohort, the view reports:

- current open amount;
- amount recorded to close inside the selected period;
- overdue amount;
- undated amount;
- recorded forecast-category breakdown;
- period pipeline coverage.

`periodPipelineCoveragePercent` means the share of current open amount whose recorded close date falls inside the selected period. It is not quota coverage and it is not expected revenue.

## Movement

Movement compares current state with the latest stored daily executive snapshot before today.

The view reports:

- recorded close-date pushes and pull-ins;
- close dates added or removed;
- stage changes;
- same-currency amount increases and decreases;
- recorded forecast-category upgrades and downgrades;
- deals entering or leaving the selected period;
- currency-safe movement amounts by cohort.

The first successful run establishes a baseline. Movement is labelled `baseline_only` until an earlier daily snapshot exists.

## Slippage review candidates

Slippage and pull-in outputs are deterministic review prompts, not predictions.

A deal can enter the slippage review queue when deterministic CRM evidence includes one or more of:

- an overdue recorded close date;
- movement out of the selected period;
- a close-date push of at least seven days;
- a recorded forecast-category downgrade.

Readiness and current Deal Brief attention can raise the review priority. The result is a management review prompt, not a prediction that the deal will slip or be lost.

## Pull-in review candidates

A deal can enter the pull-in review queue when:

- its recorded close date falls within 30 days after the selected period;
- deterministic readiness is strong;
- current Deal Brief attention and close-date credibility do not indicate a material intervention condition, when those dimensions are available;
- no overdue high-priority Deal Brief action is present.

A deal without current Deal Brief evidence must meet a higher readiness threshold. The result is a review prompt, not a prediction that the deal will close early.

## Concentration

Within each safe currency cohort, DealGuard calculates concentration by:

- owner;
- pipeline;
- region.

The response includes the largest share and a Herfindahl-Hirschman Index (HHI) for each dimension. Concentration is evaluated only inside one comparable amount cohort.

## Confidence

Confidence is based on coverage of:

- deal amount;
- comparable currency basis;
- close date;
- recorded forecast category;
- owner;
- current readiness assessment;
- current Deal Brief;
- previous executive snapshot.

Confidence can be `high`, `medium`, or `low`. Movement confidence is separately reported as `established`, `directional`, or `baseline_only`.

Missing evidence lowers confidence. It is not interpreted as proof of deal loss.

## Snapshot model

Migration `0017_executive_revenue_view.sql` adds `executive_revenue_snapshots`.

One row is retained per portal, UTC snapshot date, and deal. The snapshot stores only bounded operational state:

- pipeline, stage, owner, team, and region identifiers or labels;
- amount and currency context;
- close date and recorded forecast category;
- readiness score/status;
- bounded Deal Brief status, attention, confidence, and coverage;
- closed/won flags.

It does not store contacts, email metadata, call metadata, meeting metadata, line-item rows, quote rows, proposal content, attachments, or communication content.

Snapshots older than 730 days are removed for the portal during a fresh executive-view capture.

## Runtime boundary

- The view is read-only from the customer's perspective.
- A short-lived two-minute response cache limits repeated HubSpot reads.
- The deal load is bounded by the current plan's maximum deal-scan limit.
- Source truncation is disclosed when the bound is reached.
- Snapshot persistence runs through the request execution context and failure does not invalidate the returned view.
- No webhook, workflow action, scheduled scan, or queue consumer gains a new HubSpot read.
- No CRM field or commercial object is modified.

## Deployment dependency

Production deployment requires, in order:

1. PR #17 and migration `0015_trustworthy_intelligence_currency.sql`;
2. PRs #18–#23 for Deal Intelligence V2;
3. PR #24 and migration `0016_manager_decision_queue.sql`;
4. PR #25 for the Manager Decision Queue App Home surface;
5. migration `0017_executive_revenue_view.sql`;
6. the Executive Revenue View Worker changes;
7. a successful initial executive-view request to establish the daily movement baseline.

The App Home Executive Revenue View panel is deliberately deferred to the next product-surface slice.
