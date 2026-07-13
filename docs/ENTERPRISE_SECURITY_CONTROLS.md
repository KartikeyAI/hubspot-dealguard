# Enterprise security controls

## Identity and authorization

- All HubSpot application requests require HubSpot signature validation.
- Application roles are independent of HubSpot CRM permissions and are evaluated on every mutating operation.
- Sensitive actions use explicit permissions and, where configured, two-person approval.
- Role scopes can restrict access to pipelines, teams and business regions.

## Secrets and credentials

- HubSpot OAuth credentials are AES-256-GCM encrypted.
- Slack, Teams, customer-webhook and SIEM endpoints and signing secrets are encrypted.
- Dodo Payments, Resend and encryption keys remain deployment secrets.
- Key rotation is an operational procedure; encrypted records carry enough metadata for controlled re-encryption.

## Auditability

- Consequential actions are written to the audit stream.
- Enterprise audit records use a hash chain to make deletion or mutation detectable.
- Exports can be created as time-limited, single-use secure downloads.
- Legal holds prevent governed records from being removed by normal retention jobs.

## Delivery security

- Dodo webhooks use Standard Webhooks HMAC-SHA256 verification and timestamp freshness checks.
- HubSpot webhooks use HubSpot signature verification and idempotent event processing.
- Customer webhooks are HMAC signed.
- Outbound deliveries use leases, retry, dead-letter and administrator-authorized replay.

## Data minimization

- DealGuard stores derived deal-readiness and operational context.
- Contact and company records are not copied into the DealGuard database.
- Evidence attachments and exports follow customer-configured retention and legal-hold controls.

## Authority boundary

DealGuard does not autonomously modify deal owner, stage, amount, close date or forecast category. CRM writes are limited to DealGuard-owned properties and explicitly requested tasks.
