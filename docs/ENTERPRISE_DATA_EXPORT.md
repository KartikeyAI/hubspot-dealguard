# Enterprise data export

DealGuard provides administrator-controlled exports for customer portability, audit review and compliance response.

## Export classes

- Audit history
- Policy versions, approvals, simulations and exceptions
- Assessments and derived context
- Remediation cases, comments, evidence metadata and events
- Notification destinations and delivery history without decrypted credentials
- Service-health, incident and synthetic-check history
- Subscription, allowance and usage history
- Tenant configuration and role assignments

## Formats

- CSV for tabular audit and operational review
- JSON for complete structured customer export

## Delivery

Exports are generated server-side and delivered through a time-limited, single-use download token. Export tokens are stored as hashes, expire automatically and are removed by scheduled maintenance.

## Security

- Enterprise subscription required
- Explicit export permission required
- Export creation and consumption are audited
- Encrypted secrets and OAuth tokens are never included
- Legal holds apply to source records, not to extending the download token lifetime
