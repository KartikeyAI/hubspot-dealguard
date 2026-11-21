# Self-service setup evidence and scoped Home reporting

## Home reporting

The signed UI endpoint `GET /api/v1/dashboard` now derives its collection from the
requester's recorded role and assigned pipeline, owner, team and region scope.
Values within one scope dimension use membership; multiple dimensions must all
match. Explicit filters can narrow access, never enlarge it. Current-assignment
evidence must match the current assessment; an older assignment cannot admit a
record that moved outside the scope. Archived records are excluded.

This UI collection uses one current assessment per deal, not every historical
assessment or only the records touched by the newest scan. A later scan therefore
does not erase previously recorded open opportunities. Empty/incomplete scores
remain unavailable, while measured zero remains zero. Top issue counts deduplicate
each issue code within a deal; invalid issue JSON withholds the ranking rather
than implying complete coverage. A result beyond the bounded 10,000-deal capacity
is unavailable instead of a silent partial total.

Scoped users do not receive portal-wide scan details or timestamps. Permission
and scope are checked again after the read. Home displays unavailable operational
health instead of assuming an absent health response means healthy. This is
**recorded DealGuard authorization and evidence**, not a fresh query of HubSpot's
native record ACL on each request. Internal digest/service paths remain separate
from this user-facing collection.

## Setup checklist

`GET /api/v1/onboarding` is a read-only, portal-wide administrator report. The
native `OnboardingChecklistPanel` loads it explicitly. It uses real stored
installation grants, parseable configuration, scan status, recorded open-deal
availability/freshness, billing status/limits and optional consent states. Missing
or unverified evidence remains explicit. Zero deals is a valid scan result, not
proof of pipeline health.

The checklist recommends the next existing setup/review step; it does not start
scans, fabricate CRM sample data, edit settings, subscribe, invoke AI or deliver
messages. The existing product settings, scan and billing workflows retain their
separate permissions and action controls. In particular, this checklist is not a
replacement for end-to-end checkout, renewal, plan-change, cancellation, HubSpot
edition or OAuth acceptance.

## Consent after expiry

Intelligence administration has a separate UI availability condition from paid
manager functionality. An active, authorized administrator can inspect and revoke
AI/outcome/Breeze consent even after the subscription has expired. Generation,
evaluation and enabling paid capabilities remain entitlement guarded. The
commercial-access fallback uses the current administrator role/scope identity,
not an unrelated legacy role assumption.

Database tests exercise owner/pipeline/team/region access, stale assignment,
archive and closure handling, cross-tenant denial, missing scores, duplicate issue
counts, read-only setup and expired-administrator consent controls. Native SDK
compilation is not live rendered UI acceptance. Current publication and release
limits are in `DEALGUARD_3_CURRENT.md`.

## v3 UI and billing recovery behavior

Home first verifies billing and the current access identity. Optional dashboard,
overview and analytics requests are isolated: a billing-only administrator does
not request a denied analytics collection, and a temporary analytics failure does
not hide billing recovery. Portal-wide summaries are not requested for scoped
users. Privileged panels use their actual permissions; optional AI administration
is distinct from `ai.use`, and forecast reviewers must have an explicitly assigned
eligible role. Request generations discard responses after an identity or record
change. Empty readiness and absent operational data remain unavailable.

The setup checklist remains read-only. A separate authorized **Run pipeline
assessment** action on Home queues the existing scan workflow. Billing retains
monthly/annual checkout and read-only delivery diagnostics. Neither merely opening
Home nor the checklist authorizes a new purchase or optional intelligence request.

Paid access is evaluated against recorded subscription dates on each request,
including repository plan selection and allowance views; it does not wait for a
scheduler or webhook to relabel the provider record. Invalid explicit boundaries,
expired trials/grace/contracts and cancellation without a valid end fail closed.
An intentionally open-ended manual contract is supported. An authoritative active
recurring record without an optional end and without cancellation is also retained
for compatibility, so provider lifecycle reconciliation remains operational work.

Deal cards use recorded GET responses and require an explicit authorized POST to
refresh. Missing evidence shows an available refresh only when the server returns
that capability. Moving to another deal immediately clears old evidence, and late
responses/actions cannot update the new record's card.

## Workspace role setup in active Home

Initial enterprise setup and normal role changes use different governed paths.
Neither prefilled forms, submitted requests nor normal approval decisions grant a
role on their own. All identities come from signed HubSpot UI requests.

### First enterprise administrators

Open **Initial enterprise administrator setup** and select **Check initial
administrator setup**. The service discloses a pending proposal only to its
eligible setup requester or its exact named nominee. A new installation can use
its unassigned installer; a supported legacy migration can use its sole stable-ID
portal-wide governance administrator when no enterprise administrator exists.
Existing enterprise assignments and conflicting identity bindings are not bypassed.

The requester verifies a different person's numeric HubSpot user ID and email in
HubSpot, enters both, and types `PROPOSE_INITIAL_ADMINISTRATORS`. The resulting
one-hour proposal fixes two portal-wide administrator assignments: the requester
and named nominee. It grants nothing. Ask the nominee to open DealGuard Home and
check initial setup; this flow does not send a message or invitation automatically.

The nominee sees both exact identities, the fixed role and scope, expiry and
payload fingerprint. Only that nominee can type `ACCEPT_INITIAL_ADMINISTRATORS`
and accept. The backend rechecks both identities, installation/lifecycle and the
absence of an existing usable enterprise administrator, then atomically records
both assignments and approval evidence. The requester cannot self-accept. The
nominee can decline, and the requester can withdraw, using
`REJECT_INITIAL_ADMINISTRATORS`. Expired or changed evidence must be proposed again.
Acceptance reloads Home access; the other person should refresh their own Home.

### Subsequent assignment and removal

An entitled, portal-wide role manager can use **Workspace roles and record access**.
Loading the editor checks current access before reading assignments. Select a
verified stable HubSpot user ID, role, optional grants and record scope. Type
`SAVE ROLE` and select **Submit role change**, or request a selected assignment's
removal with `REMOVE ROLE`. The normal signed API creates a pending approval and
returns its identifier; the UI explicitly states that no role change was applied.
Initial installer bootstrap does not expose this ordinary editor.

**Two-person role changes** displays retained requests and their exact proposed
user, role, optional grants and each scope dimension. The separately recorded
previous assignment identifies the exact target of an edit or removal; its
identity, permissions, scope and update time remain visible for review. Changing
that assignment invalidates the reviewed state. A different current
portal-wide authorized administrator reviews a pending request, records a note
and types `APPROVE ROLE CHANGE` or `REJECT ROLE CHANGE`. Self-approval, missing
stable requester identity and expired approval evidence are rejected. Approval is
separate from application. A role manager inspects the approved request and types
`APPLY APPROVED ROLE CHANGE`; the UI sends the exact stored role payload with the
approval ID in the URL. It does not add fields to the signed role payload or guess
a replacement for an unsupported stored request. The service rechecks approval,
current roles, scope and final-administrator protection before committing.

Assign a separate verified stable HubSpot user ID as reviewer or compliance auditor
with the optional `forecast.approve` grant to support independent model review.
Email-only assignments can be bound to a verified stable ID while preserving their
original email. Forecast authorization requires an explicit enterprise assignment;
installer or legacy governance access alone does not satisfy it. The editor also
supports the existing optional `ai.use` and `breeze.use` grants without introducing
arbitrary wildcard permissions.

Editing preserves each pipeline, owner, team and region restriction. Empty scope
dimensions include all records in that dimension; a scoped administrator cannot
use portal-wide role or forecast administration. Unsupported legacy extra grants
are displayed and require explicit acknowledgement before replacement removes
them. Successful application reloads the Home access boundary, so self-demotion
removes privileged panels. Removal remains subject to final-administrator
protection and any remaining legacy/default authorization.

Behavioral tests cover permission and scope denial, exact paired proposals and
nominee acceptance, stable-ID promotion, scope preservation, optional-grant
allowlists, pending versus applied status, independent review, exact approved
replay, and stale identity/access callbacks. PostgreSQL route tests sign actual
HubSpot-style requests through the v17 route chain and verify pending requests,
self-approval denial, independent decision, payload mismatch denial, one audited
application and replay rejection. These are local engineering checks; real
HubSpot accounts, rendered SDK flows and production approvals remain acceptance
work.
