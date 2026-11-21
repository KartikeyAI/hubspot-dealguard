# Initial enterprise administrator setup

The first enterprise roles use a dedicated **two-person approval**. One signed
HubSpot user proposes a fixed pair of portal-wide administrators. The other
signed user reviews the exact pair and accepts it. No enterprise role is created
by the proposal alone, and a nominee cannot start setup or approve themselves as
the requester.

This resolves the first-installation problem without exempting ordinary role
changes from independent approval. Once a usable enterprise administrator exists,
this setup route closes and the normal role approval process applies.

## Who can start

The setup requester must have a signed, stable HubSpot user ID and email, an
active installation, and Enterprise access. There must be no usable portal-wide
enterprise administrator. The requester must also be either:

- The current installer, with no explicit enterprise or legacy role assignment
  overriding that initial authority and no existing legacy administrator; or
- The sole legacy governance administrator, identified by an exact stable user
  ID, matching email when recorded, and no recorded legacy scope restriction.

The second case supports an upgrade from an installation where enabling governance
already created a sole legacy administrator. Two or more existing legacy
administrators can use the normal independent approval path. This dedicated setup
does not repair arbitrary existing or ambiguous enterprise role assignments.

The nominee must have a different signed user ID and email. Neither person may
have a conflicting enterprise assignment or email binding. An exact stable-ID
non-administrator legacy binding for the nominee is permitted, so a legacy
administrator and legacy viewer can migrate together without inventing a third
person. Email-only, ambiguous, and conflicting bindings fail closed.

## The two-person flow

1. The eligible requester opens initial administrator setup and enters the other
   person's HubSpot user ID and email. They explicitly confirm
   `PROPOSE_INITIAL_ADMINISTRATORS`.
2. The server records a proposal for exactly those two people as portal-wide
   administrators, with empty extra permission and scope arrays. It returns the
   proposal ID, SHA-256 fingerprint and server-generated one-hour expiry. It
   creates no role assignment.
3. The addressed nominee opens the app using their own signed HubSpot identity,
   loads the proposal, and reviews both identities, the administrator role, its
   portal-wide scope, fingerprint and expiry.
4. The nominee sends `ACCEPT_INITIAL_ADMINISTRATORS` with the exact proposal ID
   and fingerprint. One database transaction creates both assignments, records
   the approval and completed execution, and writes the audit event.

There is no automatic email, Slack message or invitation delivery. The setup
requester and nominee coordinate separately. A nominee can reject the proposal;
the requester can also withdraw it. Both use the explicit
`REJECT_INITIAL_ADMINISTRATORS` confirmation. Rejection creates no roles. After a
proposal expires or is rejected, the requester may submit a new proposal for a
fresh review.

## Authorization and lifecycle binding

The proposal fingerprint covers the exact requester and nominee user IDs and
emails, portal, installation authorization epoch, current installer metadata,
fixed administrator grant, empty permission and scope arrays, request time and
expiry. The accept request cannot add people, change a role, add permissions or
change scope.

The database transaction locks the tenant and rechecks the current installation,
requester authority, nominee identity, role bindings, existing administrators,
expiry, and full stored payload. Disconnect/reinstall, installer metadata changes,
conflicting assignments, altered payloads and stale fingerprints invalidate the
proposal. Two concurrent proposals leave only one pending request; two concurrent
acceptances cannot create duplicate or partial pairs. An audit or settlement
failure rolls the entire acceptance back.

The status endpoint reveals a pending proposal only to its exact signed requester
or addressed nominee. Other signed users receive no proposal ID, identity details,
fingerprint or timing. A hidden or expired proposal never becomes approval evidence.
The generic approval endpoints do not provide the dedicated setup action.

## API contract

The endpoint is `/api/v1/enterprise/roles/bootstrap`. Every supported request uses
the normal HubSpot URL/body signature validation and an identified user.

`GET` returns:

```json
{
  "initialized": false,
  "viewer": "requester",
  "canPropose": true,
  "proposal": null
}
```

`viewer` is `requester`, `nominee` or `unavailable`. An authorized pending proposal
contains `id`, `payloadHash`, `status`, `expiresAt`, `requester`, `nominee`, `role`,
`permissions`, `scope`, `canAccept` and `canReject`. Each person is represented by
`userId` and `userEmail`.

`POST` proposal:

```json
{
  "action": "propose",
  "nomineeUserId": "123456",
  "nomineeEmail": "colleague@example.test",
  "confirmation": "PROPOSE_INITIAL_ADMINISTRATORS"
}
```

The requester identity comes from the signed request, never from these input
fields. The response is `{ "outcome": "proposed", "proposal": ... }` with HTTP 201.

`POST` acceptance or rejection:

```json
{
  "action": "accept",
  "proposalId": "the-loaded-proposal-id",
  "payloadHash": "the-exact-loaded-sha256-fingerprint",
  "confirmation": "ACCEPT_INITIAL_ADMINISTRATORS"
}
```

For rejection, use `action: "reject"` and
`confirmation: "REJECT_INITIAL_ADMINISTRATORS"`. A successful decision returns
`outcome: "applied"` or `"rejected"` and `approvalId`. Extra grant fields and
unsupported confirmations are rejected. Reload current role/access information
after a successful application.

## Release verification

`test/enterprise-role-bootstrap-postgres.test.mjs` exercises this flow through
the actual v17 router with signed URL/body requests and disposable PostgreSQL.
It covers the initial and legacy-upgrade paths, disclosure boundaries, identity
binding, rejection of extra grant fields, stale installation/payload/expiry rejection,
concurrent nomination and acceptance, and audit-failure rollback. These synthetic
tests do not establish or approve actual customer administrator identities.
