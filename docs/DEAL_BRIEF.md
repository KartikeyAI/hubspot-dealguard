# DealGuard Deal Brief

The Deal Brief is the primary deal-record decision surface for DealGuard. It synthesises deterministic readiness, CRM process momentum, close-date credibility, buyer-committee coverage, metadata-only engagement evidence, and optional commercial integrity into one concise management view.

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
- `risks`: ranked negative evidence across readiness, momentum, close date, relationships, engagement metadata, and commercial integrity;
- `positiveSignals`: ranked supporting evidence;
- `changes`: material CRM or readiness movement;
- `nextAction`: one prioritized action with owner, due date, rationale, and evidence codes;
- `coverage`: available and missing evidence dimensions;
- `freshness`: age and status of the current assessment;
- `limitations`: explicit interpretation boundaries.

## Status semantics

### `intervention_required`

Used when current evidence includes a critical readiness state, stalled process momentum, weak close-date credibility, materially disengaged activity metadata, weak commercial integrity with a material intervention, or another sufficiently supported high-priority action.

### `watch`

Used when the deal is at risk, process momentum is weakening, close-date evidence requires review, relationship coverage is not strong, engagement metadata is mixed, commercial evidence needs review, or deterministic attention exceeds the review threshold.

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
- optional quote and line-item integrity;
- assessment status;
- evidence freshness.

It is a prioritisation mechanism only. It is not:

- buyer intent;
- a forecast category;
- a win probability;
- expected financial loss;
- sentiment analysis;
- contract or proposal-content analysis;
- an AI or machine-learning prediction.

## Evidence coverage

The commercial-expanded evidence model uses these maximum contributions:

| Dimension | Maximum contribution |
|---|---:|
| Readiness | 25.6% |
| CRM process momentum | 16% |
| Close-date credibility | 9.6% |
| Relationship coverage | 12.8% |
| Engagement metadata | 16% |
| Commercial integrity | 20% |

The first five values preserve the relative weighting of the pre-commercial Deal Brief while reserving 20% for optional quote and line-item evidence. Within each optional dimension, incomplete source coverage reduces the contribution. Bounded or truncated reads lower confidence.

The brief remains available when optional HubSpot enrichment fails and explicitly reports unavailable dimensions. No activity evidence is interpreted as a logging/evidence gap rather than proof of disengagement. Missing commercial authorization is treated as an optional coverage gap, not as proof of commercial risk.

## Engagement evidence boundary

The engagement dimension uses associated email, call, and meeting metadata only:

- timestamps;
- direction;
- status or outcome;
- call duration;
- HubSpot owner ID;
- deal association.

It excludes email subjects, bodies, HTML, headers and addresses; meeting titles, descriptions and internal notes; call bodies, phone numbers, transcriptions and recordings; and all sentiment or communication-content analysis.

## Commercial evidence boundary

The commercial dimension uses associated quote and line-item metadata only:

- product or service name and SKU;
- quantity, price, amount, discount, and recurring frequency;
- quote status, amount, currency, creation/update time, and expiration;
- deal amount, currency, close date, and stage context.

It excludes proposal documents, quote body content, terms text, attachments, signatures, payment details, approval content, and contract text. Cross-currency amounts are never directly compared.

Commercial access is progressive. `crm.objects.line_items.read` and `crm.objects.quotes.read` are optional scopes. Existing installations retain core DealGuard functionality without them.

## Data and runtime boundary

The intelligence stack:

- adds no customer-contact, activity, quote, or line-item persistence for record enrichment;
- reuses bounded on-demand caches and in-flight request deduplication;
- does not run optional enrichment during full scans, webhooks, scheduled scans, or workflow actions;
- does not autonomously edit deal fields, activities, quotes, line items, or relationships.

## HubSpot surface

The existing primary card UID remains stable, while its customer-facing role is **DealGuard — Deal Brief**. Specialized cards remain available for deeper readiness, change, action, relationship, engagement, and commercial evidence.

## Deployment dependency

This is a stacked slice. Production deployment still requires, in order:

1. PR #17 and migration `0015_trustworthy_intelligence_currency.sql`;
2. PR #18 for momentum and close-date credibility;
3. PR #19 for buyer-committee coverage;
4. PR #20 for the unified Deal Brief;
5. PR #21 for metadata-only engagement intelligence;
6. the optional commercial-integrity slice.
