# Commercial Integrity acceptance criteria

A release candidate satisfies this slice when:

1. Existing installations without optional scopes retain the complete non-commercial DealGuard experience.
2. Missing commercial authorization triggers no quote or line-item API call.
3. Partial authorization evaluates only the authorized source.
4. Line-item and quote reads remain bounded and disclose truncation.
5. Quote/deal amount comparisons require an explicit matching currency.
6. Discount thresholds are presented as review prompts, not authorization conclusions.
7. Commercial failure cannot break readiness, momentum, relationship, engagement, or the Deal Brief.
8. Commercial enrichment executes only on deal-record assessment GET or POST paths.
9. No quote, line-item, proposal, or contract content is persisted.
10. GitHub CI runs the focused commercial suites and the full repository tests before merge.
