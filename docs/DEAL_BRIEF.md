# DealGuard Deal Brief

The Deal Brief is the primary deal-record decision surface for DealGuard. It synthesises deterministic readiness, CRM process momentum, close-date credibility, buyer-committee coverage, and metadata-only engagement evidence into one concise management view.

## Purpose

The brief should answer six questions without requiring a seller or manager to interpret several independent cards:

1. What is the current operational state of the deal?
2. What requires attention first?
3. What changed since the prior evidence point?
4. What positive evidence is present?
5. What should happen next, who owns it, and when is it due?
6. How complete and fresh is the evidence behind the conclusion?

## Output contract

`intelligence.dealBrief` contains:

- `status`: `on_track`, `watch`, `intervention_required`, or `insufficient_evidence`;
- `attentionScore`: a deterministic review-priority score from 0 to 100;
- `confidence`: `high`, `medium`, or `low`;
- `summary`: a concise evidence-backed decision statement;
- `risks`: ranked negative evidence across readiness, momentum, close date, relationships, and engagement metadata;
- `positiveSignals`: ranked supporting evidence;
- `changes`: material CRM or readiness movement;
- `nextAction`: one prioritized action with owner, due date, rationale, and evidence codes;
- `coverage`: available and missing evidence dimensions;
- `freshness`: age and status of the current assessment;
- `limitations`: explicit interpretation boundaries.

## Status semantics

### `intervention_required`

Used when current evidence includes a critical readiness state, stalled process momentum, weak close-date credibility, materially disengaged activity metadata, or a sufficiently material high-priority intervention.

### `watch`

Used when the deal is at risk, process momentum is weakening, close-date evidence requires review, relationship coverage is not strong, engagement metadata is mixed or unavailable, or deterministic attention exceeds the review threshold.

### `insufficient_evidence`

Used when the brief has less than 60% of its evidence model and no stronger critical condition is present. Missing evidence is not treated as proof that a deal will be lost.

### `on_track`

Used when the available deterministic evidence does not indicate a material intervention or review condition.

## Attention priority

Attention priority combines:

- readiness score;
- CRM process momentum;
- close-date credibility;
- relationship coverage;
- metadata-only engagement evidence;
- assessment status;
- evidence freshness.

It is a prioritisation mechanism only. It is not:

- buyer intent;
- a forecast category;
- a win probability;
- expected financial loss;
- sentiment analysis;
- an AI or machine-learning prediction.

## Evidence coverage

The expanded evidence model uses these maximum contributions:

| Dimension | Maximum contribution |
|---|---:|
| Readiness | 32% |
| CRM process momentum | 20% |
| Close-date credibility | 12% |
| Relationship coverage | 16% |
| Engagement metadata | 20% |

The first four values preserve the relative weighting of the pre-engagement Deal Brief while reserving 20% for activity metadata. Within each optional dimension, incomplete source coverage reduces the contribution. Bounded or truncated relationship or engagement reads lower confidence.

The brief remains available when optional HubSpot enrichment fails and explicitly reports unavailable dimensions. No activity evidence is interpreted as a logging/evidence gap rather than proof of disengagement.

## Engagement evidence boundary

The engagement dimension uses associated email, call, and meeting metadata only:

- timestamps;
- direction;
- status or outcome;
- call duration;
- HubSpot owner ID;
- deal association.

It excludes email subjects, bodies, HTML, headers and addresses; meeting titles, descriptions and internal notes; call bodies, phone numbers, transcriptions and recordings; and all sentiment or communication-content analysis.

## Data and runtime boundary

This slice:

- adds no OAuth scope;
- adds no database migration;
- stores no new customer-contact or activity dataset;
- reuses the existing on-demand record-enrichment cache;
- does not run optional enrichment during full scans, webhooks, scheduled scans, or workflow actions;
- does not autonomously edit deal fields, activities, or relationships.

## HubSpot surface

The existing primary card UID remains stable, while its customer-facing role is **DealGuard — Deal Brief**. Specialized cards remain available for deeper readiness, change, action, relationship, and engagement evidence.

## Deployment dependency

This is a stacked slice. Production deployment still requires, in order:

1. PR #17 and migration `0015_trustworthy_intelligence_currency.sql`;
2. PR #18 for momentum and close-date credibility;
3. PR #19 for buyer-committee coverage;
4. PR #20 for the unified Deal Brief;
5. the metadata-only engagement-intelligence slice.
