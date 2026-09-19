# Record archive and restore lifecycle

Development slice 12. Migration 0027 is additive; no earlier migration changes.

Archive is availability, not a closed-lost outcome and not a privacy erasure.
An exact HubSpot record read must positively return an `archived` boolean and the
addressed ID. An active read followed by an archived read on 404 distinguishes
verified archives from unresolvable records. Two 404s, access failures, malformed
responses and provider timeouts remain failed verification, not invented losses.
The verification clock is captured before provider reads. Out-of-order completions
and exact retries cannot overwrite newer record-state evidence.

A verified archive transaction removes the active brief, terminates outstanding
recommendations with events, ends the handoff cycle, and cancels pending background
work. The assessment's original score, observed timestamp, won/lost flags, history,
completed recommendations and prior portfolio captures are preserved. Restoration
permits a new assessment, but does not reopen old completed tasks or recommendations.
Assessment INSERT/ON CONFLICT and archive operations share an advisory lock;
brief/recommendation admission also checks the locked parent and availability.
Direct administrative SQL UPDATEs can conflict with this lock order and must retry
a database-deadlock failure; they are not a supported customer mutation interface.

Current analytics, manager queues, legacy dashboards and native write-back exclude
verified archives. The executive cache includes lifecycle revisions. Reconstructed
history observes the retained archive/restore event timeline at each daily cutoff;
persisted earlier snapshots are not rewritten. The clock is *observed availability*,
not a reconstruction of unobserved CRM activity. Unknown earlier intervals retain
the existing recorded-assessment semantics. CRM reads which positively observe an
active record may recover a missed restore; absence alone cannot do so.

Task, notification and native field-write admissions check availability. Existing
remediation evidence is not automatically waived or deleted. A provider operation
already admitted before an archive can complete; this is not a distributed
transaction with HubSpot or external delivery services.

Lifecycle metadata is tenant-bound and included in account exports; tenant deletion
cascades it. It is retained as current-state/history provenance rather than purged
with ordinary assessment retention. Per-record privacy-erasure operations and
provider-side permanent deletion confirmation remain separate from archive support.

Validation includes actual migrated PostgreSQL archive/restore transactions,
late-work rejection, tenant isolation, handoff preservation, two-session races,
rollback and the real HubSpot client under isolated HTTP fixtures. Live project
upload, restored-record acceptance and representative load tests remain required.

Implementation references: HubSpot project webhook configuration and CRM object
read contracts; PostgreSQL advisory locks and trigger functions. No new OAuth scope.
