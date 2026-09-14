# Scoped analytics and saved-view isolation

Phase 1 / M1.2 implementation slice; 2026-09-14.
This is repository implementation, not a deployment or completed milestone.

## Customer behavior

Enterprise analytics and CSV export now support identified users assigned to
one or multiple pipelines, owners, teams and regions. A collection permission
check returns the user's scope for database enforcement. Existing record-level
`requireEnterprisePermission` checks are unchanged.

Scope uses AND across dimensions and IN within each dimension. Omitting a filter
means all assigned values, not the entire portal. Explicit filters can narrow
scope but cannot widen it; an out-of-scope value returns 403 before analytics
queries execute. Duplicate URL filters, identifiers longer than 128 characters,
and whitespace-altered identifiers return 400 rather than being truncated.

The existing Enterprise entitlement gate in the route remains in place. Viewing
and exporting retain their separate `analytics.view` and `analytics.export`
permissions. No new HubSpot OAuth scope or HubSpot read is introduced.

## Current-state and historical semantics

Current counts, amounts, currency coverage, breakdowns, benchmarks, attention
rows, failure patterns and heatmaps filter only AFTER selecting the latest
recorded assessment per deal. Older in-scope observations cannot resurrect a
closed or reassigned deal in the current portfolio.

Daily trends, outcome evidence and policy comparisons require both:

1. the deal's latest recorded dimensions are within the caller's current scope;
2. the reported historical observation is within that scope and selected filters.

Therefore a deal transferred out of an assigned owner/team/pipeline/region is
also removed from that user's historical view after its new assessment arrives.
Historical policy-period timestamps use the same boundary; hidden observations
cannot determine the visible first/last assessment times. Policy names join on
both portal and policy ID.

Handoff metrics join each handoff to its latest recorded deal dimensions and
apply the same effective filters. Closed deals are included because handoffs
commonly follow closure. Handoffs without assessment evidence are excluded;
missing scope evidence is not treated as permission.

Authorization uses DealGuard's latest RECORDED state, not a fresh HubSpot check.
Changes made in HubSpot take effect here when recorded by DealGuard. This slice
does not add archive/deletion ingestion, snapshot carry-forward, real-time scope
revocation, or background enrichment. These remain separate milestone work.
Historical observations are not causal evidence or calibrated forecasts.

## Saved-view ownership

Shared view definitions are readable inside the portal, but sharing does not
permit other users to edit or delete the creator's view. Saved filters are
preferences, never authorization; execution always applies current scope.

Creation generates a new ID. Updating uses a tenant- AND creator-bound UPDATE
with RETURNING, not a global-ID upsert. A missing, foreign or non-owned ID returns
404 and never creates or overwrites a view. Deletion uses the same ownership rule.

A nonempty stored creator user ID is authoritative. Case-insensitive email
fallback is permitted only for legacy views without a creator user ID. Empty or
missing emails never establish ownership. Ownerless historical definitions can
remain readable when shared but are not claimable through this API; any recovery
requires a separate reviewed administration process.

## Export safety

CSV export goes through the same scoped analytics service and export permission.
String cells beginning with a spreadsheet formula marker or control-line prefix
are neutralized, quotes are escaped, and absent values remain empty cells rather
than fabricated zeros or serialized quote pairs. Numeric values retain their
numeric representation; existing currency-suppression semantics are unchanged.

## Validation

- `test/analytics-scope.test.mjs`: scope intersections, permissions, identity,
  input bounds, parameterized SQL, ownership conditions and CSV escaping.
- `test/analytics-scope-postgres.test.mjs`: actual exported services execute
  their SQL against temporary tables with column types copied from the migrated
  PostgreSQL schema. Fixtures cover multi/single scope, reassignment, ties,
  cross-tenant IDs, closed-deal handoffs, pre-close evidence, exports, and saved
  view create/update/delete ownership.
- Canonical CI supplies `DEALGUARD_ANALYTICS_TEST_DATABASE_URL` for its disposable
  PostgreSQL service. The suite fails rather than skips if that fixture is absent
  in canonical CI. Other/local workflows without PostgreSQL explicitly skip the
  database test; unit checks are not described as database acceptance.

No customer database, notification route, subscription or installation is used
by these fixtures. No migration is added. Rollback is an application rollback;
no schema reversal is required. M1.1 live gates and the remaining M1.2 lifecycle,
history, freshness and real-account acceptance work remain open.
