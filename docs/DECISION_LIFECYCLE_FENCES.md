# Assessment, snapshot and recommendation lifecycle fences

Phase 1 / M1.2 and M1.6 consecutive slice 11; migration 0026.

Accepted assessment writes and application snapshot upserts now serialize on the
parent assessment row. The snapshot trigger rejects a missing/closed parent or a
mismatched source version. A newer assessment removes its superseded assembled
brief until fresh enrichment has been captured. Historical portfolio captures
are not modified by this current-state cleanup.

An accepted closure removes the active brief and transitions presented work to
superseded and accepted work to expired, preserving completed evidence. Terminal
recommendation events are inserted in the same transaction as the assessment.
Retries do not duplicate events. A delayed closed payload must still match the
current closed source version; it cannot delete a newly reopened brief.

New active recommendation instances require a matching current open assessment
and assembled snapshot. This prevents delayed post-persistence observation work
from recreating an active recommendation after closure or in a different episode.
The application uses INSERT RETURNING and does not publish a presentation event
when an insert is rejected. Existing active-instance updates remain subject to
an open-parent check; this is not a claim that all recommendation-definition,
remediation, billing or external notification updates are one transaction.

The parent-before-child lock order applies to application upserts. Custom direct
SQL updates must follow the same order; a conflicting manual update can require a
normal deadlock retry. The migration introduces no SECURITY DEFINER privilege and
no rewritten earlier migration. Existing closed legacy rows are reconciled on the
next accepted assessment or exact-version closure reconciliation; the migration
does not invent historical closure events or execute an unbounded data backfill.

Two-session PostgreSQL tests exercise both directions of snapshot/closure races,
rollback atomicity, reopening, late active-insertion rejection and retry-safe
events. Unit tests cover exact-version cleanup. Fixtures are not live-provider,
representative load or production rollout evidence. Apply 0026 before this code.
