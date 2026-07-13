# Enterprise alerting and escalation

## Destinations

- Multiple Slack channels
- Microsoft Teams Workflows
- Email groups
- HMAC-signed HTTPS webhooks
- SIEM endpoints for audit and security events

## Routing

Routes can filter by event type, severity, pipeline, team, owner and region. Routes may define quiet hours, business calendars, cooldowns, suppression windows and escalation chains.

## Lifecycle

- Pending
- Delivered
- Acknowledged
- Escalated
- Failed
- Dead letter
- Replayed

Acknowledgement, escalation and replay are permission checked and audited.

## Reliability

Outbox processing uses idempotent event IDs, recoverable leases, bounded exponential retry and dead-letter state. Destination credentials remain encrypted.
