# DealGuard Manager Decision Queue

The Manager Decision Queue is the portfolio-level prioritisation surface for DealGuard. It ranks current open deals using explainable operational evidence and returns one owned next action per deal.

## Purpose

The queue answers:

1. Which deals need intervention first?
2. Which action is overdue or due soon?
3. Which deals are commercially material within a safely comparable currency cohort?
4. Which deals have a current full Deal Brief and which are still readiness-only?
5. Which deterministic evidence explains the priority?

The queue is not a forecast, win probability, buyer-intent model, or expected-loss estimate.

## Endpoint

```text
GET /api/v1/enterprise/decision-queue
```

The endpoint requires an Enterprise subscription and the existing `analytics.view` permission. Pipeline, team, owner, and region assignment scopes are enforced both for explicit filters and unfiltered results.

Supported query parameters:

```text
limit=1..100
band=act_now|review|monitor
evidenceMode=full_deal_brief|aging_deal_brief|stale_deal_brief|readiness_only
pipelineId=<HubSpot pipeline ID>
teamId=<HubSpot team ID>
ownerId=<HubSpot owner ID>
regionCode=<configured region code>
```

## Current-state semantics

The queue starts from exactly one latest open assessment per deal. Repeated assessments do not create duplicate queue entries or multiply commercial value.

The queue joins:

- the latest assessment-history row;
- the current `deal_assessments` record;
- the latest bounded Deal Brief snapshot, when current;
- open remediation counts and the highest-priority open remediation.

No HubSpot API call is made when the queue is loaded.

## Deal Brief snapshots

Migration `0016_manager_decision_queue.sql` adds `deal_decision_snapshots`.

A snapshot is written only after a deal-record GET or explicit record refresh has produced a full Deal Brief. The snapshot retains a minimal derived summary:

- Deal Brief status, attention score, confidence, coverage, and freshness;
- one next action with owner, due date, rationale, and evidence codes;
- bounded risk codes, labels, dimensions, and severities;
- dimension-level score/status summaries.

It does not retain associated contact details, email metadata, meeting metadata, call metadata, line-item rows, quote rows, proposal content, or communication content.

A snapshot is used as current evidence only when:

- its `assessment_at` matches the latest assessment; and
- it was generated no more than 72 hours ago.

Evidence modes are:

- `full_deal_brief`: current and no more than 24 hours old;
- `aging_deal_brief`: current and 24–72 hours old;
- `stale_deal_brief`: older than 72 hours;
- `readiness_only`: no matching snapshot exists.

Stale or mismatched snapshots do not override current readiness evidence.

## Priority methodology

The deterministic priority score is composed of:

| Component | Weight |
|---|---:|
| Current Deal Brief attention, or readiness fallback | 55% |
| Action/remediation urgency | 20% |
| Commercial importance within a comparable currency cohort | 15% |
| Evidence completeness and freshness review need | 10% |

Priority bands:

- `act_now`: score 75–100;
- `review`: score 50–74;
- `monitor`: score below 50.

Critical readiness, an intervention-required Deal Brief, and overdue action conditions apply transparent minimum priority floors.

## Currency safety

Commercial importance is a percentile, not a cross-currency total.

DealGuard uses:

1. HubSpot company-currency amount when available; otherwise
2. original deal amount within the same known currency only.

INR, USD, EUR, and unknown-currency values are never combined into one total. The response exposes separate amount cohorts and each deal’s cohort percentile.

## Action selection

The queue selects the highest-priority available action from:

1. a current Deal Brief action;
2. an open remediation case;
3. the highest-priority current readiness issue.

Every returned action contains:

- priority;
- responsible role;
- due date where available;
- rationale;
- evidence codes;
- source;
- overdue state.

DealGuard does not automatically edit deal fields, stages, owners, activities, line items, quotes, approvals, or stakeholder relationships.

## Graceful degradation

The queue remains useful before every deal has been enriched:

- current full Deal Brief snapshots are used when available;
- stale snapshots are disclosed and not trusted as current;
- deals without snapshots use deterministic readiness, stage-age, issue, amount-cohort, and remediation evidence;
- missing richer evidence modestly increases review priority but is not treated as proof of loss.

## App Home product surface

`ManagerDecisionQueuePanel.tsx` places the queue directly in the deployed Enterprise App Home after the workspace readiness scorecards.

The panel provides:

- `Act now`, `Review`, `Monitor`, and all-priority filters;
- fresh, aging, stale, readiness-only, and all-evidence filters;
- portfolio scorecards for immediate interventions, review items, overdue actions, and full Deal Brief coverage;
- comparable-currency cohort disclosure without cross-currency aggregation;
- ranked deal cards with priority score, readiness, evidence mode, confidence, coverage, amount context, and priority components;
- one owned action with deadline, overdue state, source, rationale, and evidence provenance;
- up to five explainable priority reasons;
- direct navigation to the corresponding HubSpot deal record.

The visual surface requests at most 25 queue items at a time and delegates priority and evidence filters to the server. It makes no HubSpot CRM API call and does not issue a write request. Lower-tier workspaces see an Enterprise capability description and do not call the queue endpoint.

Queue failure is isolated from the rest of App Home. Existing readiness, analytics, billing, workspace, and plan surfaces remain available when the queue endpoint cannot be loaded.

## Deployment dependency

Production deployment requires:

1. PR #17 and migration `0015_trustworthy_intelligence_currency.sql`;
2. PRs #18–#23 for the stacked Deal Intelligence modules;
3. migration `0016_manager_decision_queue.sql`;
4. the Manager Decision Queue Worker changes;
5. the App Home Manager Decision Queue panel;
6. a full portal scan followed by record-level enrichment of priority deals.
