# Security model

- HubSpot OAuth tokens are encrypted using AES-256-GCM with a 96-bit random IV per value.
- The 256-bit encryption key is provided only through the Worker secret manager.
- Deal, contact, company, and deal-schema read scopes support assessment and configuration metadata.
- Deal and deal-schema write scopes are used only to provision and update the fixed DealGuard-owned `dealguard_*` property allowlist.
- The HubSpot CRM adapter rejects write payloads containing any non-DealGuard property.
- HubSpot UI-extension requests are authenticated using `X-HubSpot-Signature-v3`, timestamp freshness, URI canonicalisation, HMAC-SHA256, Base64 encoding, and constant-time comparison.
- OAuth state is random, stored only as SHA-256, single-use, and expires after ten minutes.
- User-controlled JSON bodies are size-limited and normalised before persistence.
- Plan limits, custom-rule limits, policy lifecycle, and simulation limits are enforced on the backend.
- Governance roles independently authorize settings, integration, scan, native-sync, policy, audit, role, and deletion actions.
- Full tenant-data deletion is restricted to a DealGuard administrator and requires an exact confirmation phrase.
- Policy creators cannot approve their own policy when self-approval prevention is enabled.
- Once governance is enabled, live scoring rules cannot be changed through general settings; only an approved policy publication can change them.
- Public responses use restrictive content, framing, permissions, referrer, and MIME security headers.
- No sensitive token or raw CRM payload is written to application logs.
- Data deletion removes Rokad-hosted derived records, settings, audit history, integration credentials, and credential ciphertext. DealGuard-owned properties and values already stored in HubSpot remain customer-controlled CRM data.

## Required production controls

- Configure Cloudflare Access or an equivalent control for any operator dashboard.
- Rotate `ADMIN_API_KEY` and `TOKEN_ENCRYPTION_KEY` under a documented procedure.
- Enable D1 backups, tested restoration, Worker observability, and incident alerting.
- Add dependency, secret, and infrastructure scanning in the GitHub organisation.
- Maintain a vulnerability-disclosure process, incident-response procedure, subprocessor list, and data-processing agreement.
- Complete a third-party security review before Marketplace certification.
