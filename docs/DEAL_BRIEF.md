# DealGuard Deal Brief

The Deal Brief is the primary deal-record decision surface for DealGuard. It synthesises the deterministic evidence already produced by readiness, CRM process momentum, close-date credibility, and buyer-committee coverage into one concise management view.

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
- `risks`: ranked negative evidence across readiness, momentum, close date, and relationships;
- `positiveSignals`: ranked supporting evidence;
- `changes`: material CRM or readiness movement;
- `nextAction`: one prioritized action with owner, due date, rationale, and evidence codes;
- `coverage`: available and missing evidence dimensions;
- `freshness`: age and status of the current assessment;
- `limitations`: explicit interpretation boundaries.

## Status semantics

### `intervention_required`

Used when current evidence includes a critical readiness state, stalled process momentum, weak close-date credibility, or a sufficiently material high-priority intervention.

### `watch`

Used when the deal is at risk, process momentum is weakening, close-date evidence requires review, relationship coverage is not strong, or deterministic attention exceeds the review threshold.

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
- assessment status;
- evidence freshness.

It is a prioritisation mechanism only. It is not:

- buyer intent;
- a forecast category;
- a win probability;
- expected financial loss;
- an AI or machine-learning prediction.

## Evidence coverage

Readiness contributes the stable baseline. Momentum, close-date, and relationship evidence increase coverage only when those optional enrichments are available. Bounded or truncated relationship reads lower confidence.

The brief remains available in readiness-only mode when optional HubSpot enrichment fails, and explicitly reports the unavailable dimensions.

## Data and runtime boundary

This slice:

- adds no OAuth scope;
- adds no database migration;
- requests no additional HubSpot object or activity data;
- stores no new customer-contact dataset;
- reuses the existing on-demand record-enrichment cache;
- does not run optional enrichment during full scans, webhooks, scheduled scans, or workflow actions;
- does not autonomously edit deal fields or relationships.

## HubSpot surface

The existing primary card UID remains stable, but its customer-facing name changes from **DealGuard — Readiness** to **DealGuard — Deal Brief**. Specialized cards remain available for deeper readiness, change, action, and relationship evidence.

## Deployment dependency

This is a stacked slice. Production deployment still requires, in order:

1. PR #17 and migration `0015_trustworthy_intelligence_currency.sql`;
2. PR #18 for momentum and close-date credibility;
3. PR #19 for buyer-committee coverage;
4. this Deal Brief slice.
