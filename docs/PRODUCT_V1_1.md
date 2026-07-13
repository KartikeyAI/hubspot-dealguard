# DealGuard v1.1 product definition

## Release objective

v1.1 turns DealGuard from a scan-and-review utility into an operational alerting and automation product. It preserves deterministic scoring and adds three distribution surfaces that improve daily adoption:

1. real-time reassessment when important deal fields change;
2. governed Slack alerts to the channel selected by the customer;
3. a deal-based HubSpot workflow action.

## Customer outcomes

- Sales managers learn when a deal becomes or remains critical without waiting for a scheduled report.
- Delivery teams receive a clear handoff-required or handoff-confirmed signal.
- RevOps administrators can place DealGuard inside their existing HubSpot workflow design.
- Teams avoid alert fatigue through cooldowns and idempotency.

## Entitlements

| Capability | Free | Growth / Beta Growth |
|---|---:|---:|
| Scheduled readiness scan | Daily | Hourly |
| Deal card and manual assessment | Yes | Yes |
| Real-time webhook reassessment | Yes | Yes |
| Slack connection and alerts | No | Yes |
| Custom workflow action | No | Yes |
| Slack repeat-alert cooldown | No | Yes |

## Slack alert rules

- **Critical deal:** sent for critical deals, subject to the configured cooldown and idempotency controls.
- **Handoff required:** sent for closed-won deals whose handoff is not confirmed, subject to cooldown.
- **Handoff confirmed:** sent once after an authorised HubSpot user confirms the handoff.
- **Workflow assessment:** sent only when the workflow administrator explicitly selects the Slack option.
- **Test:** sent only from app settings.

Automatic alerts respect the global Slack toggle and per-event toggles. Workflow-requested notifications can run independently of the automatic-alert toggle but still require Growth entitlement and an active connection.

## Non-goals

- AI-generated scoring or autonomous sales decisions.
- Writing DealGuard scores back to HubSpot properties.
- Slack interactive actions or commands.
- Multiple Slack workspaces/channels per HubSpot portal.
- Generic custom-property webhook subscriptions; scheduled scans still cover custom fields.
