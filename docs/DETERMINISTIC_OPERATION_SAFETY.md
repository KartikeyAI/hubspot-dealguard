# Recorded reads, operational authorization and durable remediation

## Record cards and explicit refresh

`GET /api/v1/deals/:id/assessment` reads the current recorded assessment and, when
its source receipts still match, the stored Deal Brief summary. It never contacts
HubSpot, refreshes evidence, writes a decision snapshot, creates recommendations,
creates remediation tasks, sends messages, writes CRM properties, or reports usage.
The observation time is preserved and the response includes fresh/aging/stale/
unavailable evidence status. A missing assessment returns `assessment_unavailable`
with `details.canRefresh`; opening a card does not create one.

An identified user with the record-scoped `deal.review` permission may explicitly
refresh through POST. The fresh HubSpot record is checked against the current
assignment before persistence, and access and assessment identity are checked
again before the response and snapshot persistence. Interactive refresh computes
evidence and records usage. Configured workflow and webhook automation retain
their notification, CRM write-back and automatic remediation responsibilities.

Stored brief reads expose the bounded summary persisted by the prior refresh.
Detailed enrichment panels need an explicit refresh. Missing, invalid, stale or
mismatched optional-source receipts withhold the combined brief rather than
changing its observation time. A stored summary containing commercial evidence
also requires the complete current optional commercial grant; otherwise the
combined summary is withheld and core readiness remains available. The grant is
checked again before a combined summary is returned. Combined risk observations
use the oldest usable source-receipt clock, preserving the age of older history
or engagement evidence. All of this still relies on recorded DealGuard scope;
it is not a live query of every HubSpot user's CRM permissions.

## Enterprise assignment precedence

An explicitly assigned enterprise role controls operational and legacy governance
permission and scope.
The legacy governance role or installer identity cannot restore privileges that
the enterprise assignment lacks. Unassigned users retain the supported legacy
governance path, with an identified actor and active installation required.
Installer bootstrap ends when a usable portal-wide enterprise administrator is
present. A stable user ID bound to another user's email prevents fallback through
that email. The access response identifies stable enterprise assignments separately
from email-only assignments, legacy governance roles and installer bootstrap.

Portal-wide settings, metadata, integration configuration, delivery diagnostics
and overview reads require their corresponding permission and unrestricted
resource scope. Record-level remediation creation checks `remediation.manage`
against the recorded deal's assignment, rather than against the case assignee.

Migration `0041_atomic_enterprise_roles.sql` serializes role changes using the
tenant row. It rechecks the active installation, current portal-wide actor
authority and initial-setup eligibility before mutating a role. The role and its
audit event commit together. Concurrent removals or demotions cannot eliminate
the final usable portal-wide administrator, and narrowing that administrator's
scope requires another usable administrator to remain. A failed audit insert
rolls back the role change.

New or updated assignments require a bounded numeric HubSpot user ID. An existing
email-only assignment can be bound to its stable ID in place, preserving its
identity and creation time. Conflicting IDs, duplicate case-insensitive emails,
and ambiguous identity merges are rejected. All four scope arrays are validated
without truncation or coercion to an empty scope. Newly entered extra grants are
limited to `forecast.approve`, `ai.use` and `breeze.use`; earlier unsupported extras
remain visible for deliberate removal. Canonical role changes also require the
independent approval flow; these transaction checks do not confer approval.

## Remediation transaction boundaries

Migration `0037_atomic_remediation_delivery.sql` adds invoker-rights functions.
Creation locks the current available assessment where one is required and commits
the case, creation event, audit event and notification intent together. Concurrent
duplicate requests reuse the existing open case. Automatic assessment cases also
require the current, open, sufficiently fresh critical issue; caller-supplied stale
issue data cannot create work. An authenticated workflow may explicitly create a
case before its first assessment.

Overdue transitions compare the work revision under the same record/case lock
order. A stale scanner cannot publish an overdue event after another actor has
resolved or changed the case. A transaction failure rolls back the transition,
event, audit and outbox intent together.

HubSpot task delivery has a separate durable state on the case:

| State | Meaning |
| --- | --- |
| `not_requested` | The creation request did not request a task. Repeating creation cannot change this. |
| `pending` | A committed task intent has not been claimed. The remediation maintenance job can resume it. |
| `sending` | One sender has claimed the intent. Another worker cannot send it. |
| `created` | The exact sender recorded a valid HubSpot task identifier. |
| `held` | Delivery or authorization requires reconciliation. No automatic resend occurs. |

A queued automatic task is checked against current issue evidence before claim.
Manual tasks recheck the initiating user's current record permission. Uncertain
HTTP results and abandoned sends are held because a task might already exist in
HubSpot. An exact late success receipt can settle its claim; a late failure cannot
overwrite a recorded success. Operator reconciliation must inspect the case and
HubSpot before deciding any further action. There is no public resend operation.
An already dispatched external request cannot be recalled by a later role change,
record transition or uninstall.

## OAuth lifecycle

Credential refresh compares the exact active encrypted grant it started with.
Delayed refresh success cannot reactivate an inactive/deleted installation or
overwrite a replacement grant. Delayed terminal failure cannot disconnect a
newer grant. Rate limits, server failures and malformed responses leave the
installation and optional consent intact. Confirmed terminal rejection changes
status, revokes optional consent through existing triggers and records the audit
in one transaction. OAuth requests reject redirects, use deadlines and bound
response reads.

Migration `0040_oauth_authorization_epoch.sql` records an authorization epoch on
the installation and advances it at deactivation. The consumed single-use OAuth
state carries its original issue time into an atomic installation UPSERT. A
callback initiated before deletion/disconnection cannot revive that installation
or overwrite a subsequent reinstall. A newly initiated reconnect is accepted for
a disconnected installation. A tenant marked `deleted` remains unavailable for
OAuth installation while permanent erasure is in progress.
Routine scans, settings edits and token rotation do not invalidate an in-progress
reconnect. Installation and its audit event commit together.

Permanent erasure and installation take the same transaction lock. The callback
then reads the existing hashed `data.deleted` audit receipt after acquiring that
lock. This fresh read prevents a callback that waited for deletion from inserting
a replacement tenant using the earlier authorization state. Finalization requires
the same deleted installation epoch, erases the tenant and dependent records,
and writes its receipt atomically. Its timestamp records completed database
erasure. An authorization flow initiated after that receipt can install again.

The retained receipt has the same fields and retention as before this change:
a SHA-256 reference derived from the portal ID, `data.deleted`, an empty metadata
object, a timestamp and no user identifier or email. It is a pseudonymous audit
reference and is retained indefinitely by the current implementation; there is
no new security table or new business-data retention. Its OAuth anti-replay use
is limited by the ten-minute authorization-state lifetime.

### Automatic erasure recovery

The authorized deletion request records an epoch-bound intent on the tenant and
clears its credentials in one transaction. A configured compliance legal hold or
an active legal-hold record blocks admission before those changes. Existing core
observations remain until finalization. If storage is temporarily unavailable,
the API returns HTTP 202 with a pending deletion status; the original request
continues to authorize completion after the user's session or role changes.

Each maintenance run claims at most one due deletion using a two-minute lease.
A worker processes at most three batches of two hundred objects, with a bounded
overall request deadline. It checks the source epoch, lease and both forms of
legal hold before each storage request and before the final database erasure.
An expired lease can be reclaimed, but its prior sender cannot defer or finalize
the new claim. Transient failures back off from thirty seconds up to one hour.
Remaining objects resume on a later maintenance pass. A legal hold pauses work
until the hold is released through its authorized process. After deletion intent
has deactivated the installation, the ordinary signed approval route cannot
release that hold. Resolution requires a controlled compliance operator action
after separate approval; the retry worker never removes or bypasses a hold.
It resumes only after that resolution. An already-dispatched
external request cannot be recalled by a hold or lifecycle change that happens
after dispatch.

Object deletion is limited to the exact tenant prefix. Responses are bounded and
validated; a successful HTTP status with per-object errors does not count as
completion. Cleanup relists the first page after deletion so it cannot skip keys
by continuing a cursor into a shrinking prefix. A validated empty listing is
required before the tenant is removed. New signed upload links and server-side
object writes are blocked for an inactive tenant. Finalization also waits sixteen
minutes after the intent, allowing previously issued upload links to expire,
then performs the final empty-prefix sweep. Routine transient failures therefore
recover automatically without reopening OAuth or requiring an operator to retry.

`verifiedPortalDeletionReceipt` confirms a valid hashed receipt from the requested
time window and the absence of a current tenant. Canonical HTTP 200 completion
uses this receipt instead of updating approval rows removed by the tenant cascade.
HTTP 202 records the authorized initiation while cleanup continues.

The storage-response checks follow the documented S3 response contracts:
[ListObjectsV2](https://docs.aws.amazon.com/AmazonS3/latest/API/API_ListObjectsV2.html)
and [DeleteObjects](https://docs.aws.amazon.com/AmazonS3/latest/API/API_DeleteObjects.html).

Deploying migration 0040 invalidates authorization flows already outstanding at
that point. Those users must start a new installation flow. This is a deliberate
one-time fence, not an automatic reuse of an earlier authorization.

## Verification and limits

An initial focused validation ran 55 tests with no failures or skips using a
newly created disposable PostgreSQL database. It covered signed viewer GET/POST paths,
scope and enterprise-role precedence, concurrent duplicate creation and task
claims, rollback on an injected outbox failure, stale overdue transitions,
uncertain/late task receipts, token rotation/deletion/reinstall races, bounded
OAuth responses, automatic resolution gates, and request-body bounds.

After the role and permanent-erasure changes, a further 39-test focused run passed
without failures or skips. It exercised sixteen role/governance cases, thirteen
OAuth lifecycle cases and seven recorded-read cases, plus their parent cases.
This included two-connection removal/demotion/bootstrap races, a revocation while
waiting for the role lock, atomic audit rollback, explicit governance precedence,
the real permanent-deletion service with simulated object storage, a callback
waiting for committed erasure, current commercial grants and preserved source
clocks. These totals describe separate overlapping runs, not an aggregate count.

The subsequent deletion-recovery validation passed 32 tests, with no failures or
skips: twelve erasure cases, thirteen OAuth lifecycle cases, five request-body
cases and two parent cases. It covered actual transient failure followed by
automatic retry and completion, upload-expiry sweeps, both legal-hold forms,
holds between storage calls, competing and expired leases, changed epochs,
partial HTTP 200 failures, malformed responses, cross-tenant prefixes, bounded
batch progress and completion receipts that cannot validate a replacement install.

Provider transport in these tests is simulated. This evidence does not establish
live HubSpot installation or refresh behavior, provider task delivery, production
load/recovery targets, independent security approval, or production sign-off.
