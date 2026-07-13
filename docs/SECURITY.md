# Security model

- HubSpot OAuth tokens are encrypted using AES-256-GCM with a 96-bit random IV per value.
- The 256-bit encryption key is provided only through the Worker secret manager.
- Deal, contact, company, and deal-schema read scopes support assessment and configuration metadata.
- Deal and deal-schema write scopes are used only to provision and update the fixed DealGuard-owned `dealguard_*` property allowlist.
- The HubSpot CRM adapter rejects deal-property write payloads containing any non-DealGuard property.
- `crm.objects.tasks.write` is used only to create remediation tasks explicitly requested by an administrator, workflow, or enabled Enterprise remediation automation.
- Task-to-deal association metadata is discovered from HubSpot rather than relying on an undocumented hard-coded association ID.
- DealGuard does not automatically change deal stage, owner, amount, close date, or forecast category.
- HubSpot UI-extension requests are authenticated using `X-HubSpot-Signature-v3`, timestamp freshness, URI canonicalisation, HMAC-SHA256, Base64 encoding, and constant-time comparison.
- OAuth state is random, stored only as SHA-256, single-use, and expires after ten minutes.
- User-controlled JSON bodies are size-limited and normalised before persistence.
- Plan limits, destination limits, custom-rule limits, policy lifecycle, simulation limits, and commercial entitlements are enforced on the backend.
- Governance roles independently authorize settings, integration, scan, native-sync, policy, remediation, delivery, billing, audit, replay, role, and deletion actions.
- Full tenant-data deletion is restricted to a DealGuard administrator and requires an exact confirmation phrase.
- Policy creators cannot approve their own policy when self-approval prevention is enabled.
- Once governance is enabled, live scoring rules cannot be changed through general settings; only an approved policy publication can change them.
- Teams Workflow URLs, generic webhook endpoints, generic webhook signing secrets, HubSpot tokens, and Slack credentials are encrypted using AES-256-GCM.
- Generic outbound webhooks use HMAC-SHA256 signatures and unique delivery IDs.
- Outbound delivery uses compare-and-set leases, retry history, bounded exponential backoff, dead-letter state, and administrator-controlled replay.
- Stripe webhook requests require a valid HMAC-SHA256 signature, fresh timestamp, and idempotent provider event ID.
- Stripe-hosted Checkout and Customer Portal handle payment details. DealGuard stores customer/subscription identifiers and entitlement state, not card data.
- Public responses use restrictive content, framing, permissions, referrer, and MIME security headers.
- No sensitive token, endpoint credential, payment credential, or raw CRM payload is written to application logs.
- Data deletion removes Rokad-hosted derived records, remediation cases, destinations, subscriptions, delivery history, settings, audit history, integration credentials, and credential ciphertext. DealGuard-owned properties, values, and tasks already stored in HubSpot remain customer-controlled CRM data.

## Required production controls

- Configure Cloudflare Access or an equivalent control for any Rokad operator dashboard.
- Rotate `ADMIN_API_KEY`, `TOKEN_ENCRYPTION_KEY`, Stripe secrets, and integration credentials under documented procedures.
- Enable D1 backups, tested restoration, Worker observability, synthetic monitoring, and incident alerting.
- Add dependency, secret, infrastructure, and container scanning in the GitHub organisation.
- Test outbox recovery, dead-letter replay, Stripe webhook replay protection, and billing downgrade behavior.
- Maintain a vulnerability-disclosure process, incident-response procedure, subprocessor list, data-processing agreement, backup policy, and disaster-recovery runbook.
- Complete a third-party security review before Marketplace certification.
