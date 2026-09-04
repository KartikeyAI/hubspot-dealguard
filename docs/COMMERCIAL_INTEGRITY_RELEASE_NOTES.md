# Commercial Integrity slice release notes

This stacked Deal Intelligence V2 slice adds optional quote and line-item intelligence without expanding DealGuard's required installation grant.

## Added

- Progressive optional authorization for `crm.objects.line_items.read` and `crm.objects.quotes.read`.
- Bounded, date-versioned line-item and quote association reads.
- Deterministic line-item completeness, amount-alignment, quote-state, expiration, currency, and discount-review signals.
- Owned, due-dated commercial actions.
- Commercial evidence as a sixth Deal Brief dimension.
- Dedicated **DealGuard — Commercial Integrity** HubSpot card.
- Focused behavior, data-boundary, route-isolation, and source-contract tests.

## Not added

- No database migration.
- No quote, line-item, proposal, or contract persistence.
- No proposal-document or terms-content processing.
- No payment, signature, contract, or attachment analysis.
- No autonomous commercial-field mutation.
- No win probability, forecast classification, or expected-loss estimate.

## Deployment order

This slice remains dependent on PRs #17 through #21 and the deferred `0015_trustworthy_intelligence_currency.sql` migration.
