# Enterprise roles and scoped authority

## Roles

- **Administrator:** tenant, billing, integrations, retention, legal holds, exports and role administration.
- **Policy administrator:** policy authoring, templates, import/export and simulations.
- **Approver:** policy and exception decisions; cannot approve own submissions when self-approval prevention is enabled.
- **RevOps manager:** analytics, scans, remediation management and operational exports.
- **Sales manager:** pipeline-scoped analytics, remediation and escalation management.
- **Reviewer:** review, comment, evidence and recommendation actions without global configuration authority.
- **Viewer:** read-only access within assigned scope.

## Scopes

Role assignments may restrict access by:

- Pipeline
- Team
- Owner
- Region
- Business unit

The backend—not the UI—enforces scope restrictions.

## Sensitive actions

Sensitive actions may require two-person approval:

- Policy publication
- Global retention reduction
- Legal-hold release
- Bulk data deletion
- Billing allowance changes
- SIEM destination changes
- Encryption-key rotation completion

## Bootstrap

The installer may bootstrap as administrator only until explicit role assignments are established. Every bootstrap-derived action remains auditable.
