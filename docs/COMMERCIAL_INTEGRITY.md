# DealGuard Commercial Integrity

Commercial Integrity is an optional DealGuard intelligence module for structured HubSpot quote and line-item metadata. It helps sellers and managers verify that the CRM's commercial package is complete, internally consistent, current, and operationally usable before relying on a close plan.

## Customer questions

The module answers:

1. Are products or services represented by associated line items?
2. Are line-item names, quantities, and prices complete?
3. Does the line-item subtotal align with the recorded deal amount?
4. Is a current quote associated with the deal?
5. Is the current quote draft, pending, issued, accepted, expired, or rejected?
6. Does the current quote amount and currency align with the deal?
7. Is a quote approaching expiration?
8. Is discount metadata material enough to require review?
9. What should happen next, who owns the action, and when is it due?

## Progressive authorization

Commercial Integrity uses optional OAuth scopes:

- `crm.objects.line_items.read`
- `crm.objects.quotes.read`

They are declared in the HubSpot project as optional scopes. Existing installations retain readiness, momentum, relationship, engagement, governance, remediation, and reporting functionality without them.

An administrator can prepare reauthorization through:

```text
POST /api/v1/integrations/hubspot/commercial-access
```

The response contains a HubSpot authorization URL whose `optional_scope` parameter includes only the missing commercial scopes. The endpoint requires the existing `integration.manage` operational permission.

When neither optional scope is granted, DealGuard performs no quote or line-item API call and returns `authorization_required`. Partial authorization evaluates only the source that is available.

## Data accessed

### Deal context

- `amount`
- `amount_in_home_currency`
- `deal_currency_code`
- `closedate`
- `dealstage`

### Line-item metadata

- `name`
- `hs_sku`
- `quantity`
- `price`
- `amount`
- `discount`
- `hs_discount_percentage`
- `recurringbillingfrequency`
- `hs_lastmodifieddate`

### Quote metadata

- `hs_title`
- `hs_quote_number`
- `hs_status`
- `hs_expiration_date`
- `hs_quote_amount`
- `hs_currency`
- `hs_createdate`
- `hs_lastmodifieddate`

The module does not request or inspect proposal documents, quote body content, terms text, attachments, payment details, contract text, signatures, or approval content.

## Runtime boundary

Commercial enrichment runs only for:

- an opened deal record; or
- an explicit deal-record refresh.

It does not run during:

- full portal scans;
- scheduled scans;
- HubSpot webhooks;
- workflow actions; or
- queue processing.

The module uses its own 60-second bounded cache and per-deal in-flight request deduplication. It wraps the existing assessment response rather than modifying the core assessment service.

## On-demand bounds

- line items: 200 per deal;
- quotes: 50 per deal.

Pagination overflow, repeated cursors, no-progress pages, or unreadable associated records mark the source as truncated. Truncation reduces confidence and is disclosed in the response and UI.

## Output contract

`intelligence.commercialIntegrity` contains:

- authorization state;
- `ready`, `watch`, `weak`, `insufficient_data`, `authorization_required`, or `unavailable` status;
- deterministic score and confidence;
- line-item completeness and amount coverage;
- line-item subtotal and deal-amount difference;
- discount and recurring-item counts;
- quote-state counts;
- current quote amount, currency, and deal-amount difference;
- nearest quote expiration;
- close-date proximity;
- explainable signals;
- data-source coverage and truncation;
- interpretation limitations.

`intelligence.commercialActions` contains owned, due-dated actions. Commercial actions are also merged into `intelligence.decisionActions` and can become the Deal Brief's recommended next action.

## Deterministic review semantics

The evaluator checks:

- missing line items near close;
- incomplete quantity or pricing metadata;
- deal/line-item amount divergence;
- missing quote evidence near close;
- quotes remaining draft or pending near close;
- expired or rejected quote-only states;
- approaching quote expiration;
- deal/quote amount divergence;
- deal/quote currency mismatch;
- material recorded discounts.

A recorded discount of 20% or more generates a review signal; 35% or more raises the severity. These are fixed review thresholds only. They do not prove that a discount is unauthorized or commercially inappropriate.

Quote and deal amounts are compared only when both have usable amounts and the same explicit currency. Cross-currency totals are never compared directly.

## Deal Brief integration

Commercial Integrity contributes up to 20% of the expanded Deal Brief evidence model. The previous readiness, momentum, close-date, relationship, and engagement model is proportionally scaled across the remaining 80%.

Commercial evidence can:

- add ranked risk and positive evidence;
- increase deterministic attention priority;
- move the Deal Brief to `watch` or `intervention_required` when supported;
- reduce confidence when authorization is partial or evidence is bounded;
- supply the highest-priority owned next action.

Missing optional authorization lowers evidence coverage but does not create a commercial-risk signal or change the core deterministic readiness result.

## Interpretation boundary

Commercial Integrity is not:

- a forecast category;
- a win probability;
- expected financial loss;
- proof of discount authorization;
- contract analysis;
- proposal-content analysis;
- payment or collections intelligence;
- an AI-generated commercial opinion.

## Deployment dependency

This is a stacked Deal Intelligence V2 slice. Production deployment still requires, in order:

1. PR #17 and migration `0015_trustworthy_intelligence_currency.sql`;
2. PR #18 for momentum and close-date credibility;
3. PR #19 for buyer-committee coverage;
4. PR #20 for the unified Deal Brief;
5. PR #21 for metadata-only engagement intelligence;
6. this optional commercial-integrity slice.
