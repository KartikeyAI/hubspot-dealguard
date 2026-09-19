# Scoped manager and executive workflows

Phase 1 / M1.5 consecutive slice 9; 2026-09-19.

Manager Decision Queue and Executive Revenue View use the same identified-user
collection access check as the analytics endpoints. Record-specific authorization
is not bypassed or weakened. Filters intersect permitted pipeline/owner/team/region
sets. The queue also accepts a stage filter. Unsupported executive stage filters
are rejected rather than silently ignored. Historical executive movement uses
permitted captured dimensions as well as current scoped deal membership.

The queue supports bounded name/ID search, stable ranked pagination and matched
counts. It reads at most 10,001 rows to detect excess capacity and refuses to
publish rankings for a silently truncated cohort above 10,000. Pagination is a
current-state view, not a frozen cursor snapshot; CRM changes between requests can
change membership/ranking. Reload returns to the server's current view.

Duplicate/invalid/overlong controls fail validation. Currency strings must be
complete three-letter codes, not truncated prefixes. Malformed stored JSON shapes
fall back without crashing. App Home exposes search and next/previous navigation,
resets pagination when filters change, and rejects stale/unmounted responses.

Executive access is rechecked before cache lookup; assignment scope is included in
the existing two-minute cache key. HubSpot-side changes may remain cached until
refresh. Impossible calendar dates and duplicate period controls are rejected.
Live-account permissions and rendered UI acceptance remain required. This is not
an assertion of production readiness or a replacement for M1.1 staging gates.
