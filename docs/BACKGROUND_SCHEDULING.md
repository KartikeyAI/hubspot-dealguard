# Background portal scheduling and evidence coverage

Phase 1 / M1.4, slice 14. Apply additive migration 0029 before runtime rollout.

The 15-minute maintenance tick now reserves up to 100 due enabled portals and
publishes separately addressed queue messages. A five-minute dispatch reservation
is distinct from the five-minute execution lease: an unsent or lost message can
be recovered without giving two workers permission to spend one portal's budget.
Publication failure releases only the matching reservation. Actual execution still
rechecks active installation, enabled/versioned configuration and entitlement.

Each execution registers at most 100 missing jobs and handles at most three deals.
One selection slot is retained for the oldest eligible waiting job. Remaining
slots prioritize overdue remediation, a recorded close plan within seven days of
now, critical readiness, then never-completed/older work. Planning dates come only
from observed CRM properties; invalid dates are unavailable and source-aligned
context cannot be overwritten by an older observation.

When eligible work remains, one delayed continuation is published after releasing
the owned execution lease. Otherwise the next poll is bounded to 15 minutes.
Exhausted daily budgets wait for the next UTC day; authorization/entitlement errors
and provider throttling use explicit holds. A paused or superseded worker cannot
rewrite new settings. Continuations do not increase the established daily budget,
per-deal request cap, HTTP deadlines or read-only admission policy.

All three maintenance consumers use a maximum batch size of two. Existing queue
concurrency remains unchanged. This bounds combined execution within a batch; it
is not a production latency or 10,000-deal freshness certification. Provider limits,
queue delays, database contention and actual enrichment request counts still need
representative load testing.

Status distinguishes fresh, aging, stale and unavailable brief coverage using the
assessment observation clock plus matching snapshot, never only generation time.
The API withholds full coverage counts above its 10,000-observation bound. The
compatibility `recent_briefs` field now means source-fresh briefs. App Home shows
the last bounded run error, without raw provider responses or credentials.

Tests: background-scheduler.test.mjs and background-scheduler-postgres.test.mjs.
They exercise production selection/dispatch/continuation SQL, competing sessions,
queue failure, source clocks, budget resets and pauses. Actual customer-provider
and queue throughput acceptance remain open. Background intelligence remains off
by default; no subscription, provider grant or live configuration is changed.
