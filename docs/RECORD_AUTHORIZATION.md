# URL-bound identity and record authorization

Phase 1 / M1.3, M1.5 and M1.6 hardening, slice 15. No OAuth expansion or schema
migration is required by this slice. This is implementation, not a security audit
or live HubSpot acceptance sign-off.

## Request boundary

UI/API identities in URL parameters require a signature that binds the URL and
method. Body-only legacy v1 signatures remain accepted at the body-origin webhook
receipt, but cannot authenticate UI identities or workflow action endpoints.
Documented legacy v2 (method/URL/body) compatibility remains; v3 additionally
requires the signed integer timestamp within the existing five-minute window.
Partial or invalid v3 headers cannot downgrade to a legacy signature. v2 does not
provide v3's timestamp-based replay protection and must not be represented as such.
Duplicate identity parameters, malformed IDs/email, missing configured project ID
and mismatched project IDs are rejected. Workflow and webhook identity extraction
remain separate. Existing project and acceptance tooling must be exercised in a
real developer account before relying on compatibility across HubSpot surfaces.

## Record boundary

Record reads require an identified user, active installation and analytics.view.
The existing DealGuard assignment dimensions all apply: pipeline, owner, team and
region. Current evidence must match the selected assessment before cached data is
exposed; live property dimensions are checked again before assessment persistence
or optional enrichment. Missing dimensions cannot expand an assigned scope.
Scoped users need an observed record/context, normally supplied by installation
or scheduled scans; absence of those observations is not inferred authorization.
This implements DealGuard data scopes, not an assertion that every native HubSpot
user/field permission has been queried or mirrored.

Review and handoff require explicit deal.review and handoff.confirm grants.
Administrators retain wildcard permissions. RevOps managers, sales managers and
reviewers receive both by default; remediation managers receive review only.
A viewer does not silently receive write permissions. Deal card controls use
server-provided capabilities. Existing role configuration should be reviewed when
upgrading; a legacy UI button is not authorization.

Cached enrichments retain the source dimensions and are rechecked for each reader.
Commercial cache keys bind the exact base evidence and granted optional scopes.
A review write locks/matches its assessed source and fails when superseded.
Previously accepted handoff transactions retain their separate exact-source gate.
An email fallback cannot claim a role explicitly bound to a different user ID.
Malformed stored scope arrays fail closed instead of becoming unrestricted scope.

## Retention and validation

Operational receipt cleanup checks both the configured hold flag and active hold
records. Explicit erasure and broader historical retention policies are separate
controls, not newly certified by these changes. The older internal dashboard also
excludes verified archived records.

Focused tests cover real HMAC/hash validation and URL/body tampering, scope and
permission denial, current-context matching, withheld cached reads, ID-bound roles,
and receipt holds. PostgreSQL tests use disposable tenant fixtures and actual
production queries. Review of other service authorization surfaces, native account
permissions, UI behavior and independent penetration testing remains mandatory.

Primary implementation references:
- https://developers.hubspot.com/docs/apps/developer-platform/build-apps/authentication/request-validation
- https://developers.hubspot.com/docs/api-reference/crm-extensions/v3/guide
