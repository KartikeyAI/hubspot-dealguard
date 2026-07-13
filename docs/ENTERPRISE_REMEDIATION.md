# Enterprise remediation operations

Remediation cases are durable governance records, not transient alerts.

## Capabilities

- Automatic and manual case creation
- Assignment and reassignment
- Severity, priority and due dates
- SLA escalation
- HubSpot task creation
- Comments
- Evidence metadata and secure attachments
- Acknowledge, start, resolve, waive, close and reopen
- Bulk assignment and task creation
- Reopening when an assessment issue returns
- Manager queues and MTTR reporting

## Evidence

Evidence records include filename, media type, size, checksum, uploader and retention state. Binary storage must use the configured object-storage integration; metadata remains in D1. Evidence access is permission checked and audited.

## Authority

Remediation actions never change core HubSpot commercial fields automatically. Associated HubSpot tasks are created only through explicit customer configuration or workflow action.
