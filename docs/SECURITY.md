# Security model

- HubSpot OAuth tokens are encrypted using AES-256-GCM with a 96-bit random IV per value.
- The 256-bit encryption key is provided only through the Worker secret manager.
- Required OAuth scopes are read-only and limited to deals, contacts, companies, and deal schema metadata.
- HubSpot UI-extension requests are authenticated using `X-HubSpot-Signature-v3`, timestamp freshness, URI canonicalisation, HMAC-SHA256, Base64 encoding, and constant-time comparison.
- OAuth state is random, stored only as SHA-256, single-use, and expires after ten minutes.
- User-controlled JSON bodies are size-limited and normalised before persistence.
- Plan limits and custom-rule limits are enforced on the backend.
- Public responses use restrictive content, framing, permissions, referrer, and MIME security headers.
- No sensitive token or CRM payload is written to application logs.
- Data deletion removes derived customer records and destroys the credential ciphertext and IVs.

## Required production controls

- Configure Cloudflare Access or an equivalent control for any future operator dashboard.
- Rotate `ADMIN_API_KEY` and `TOKEN_ENCRYPTION_KEY` under a documented procedure.
- Enable D1 backups and Worker observability.
- Add dependency and secret scanning in the GitHub organisation.
- Complete a third-party security review before Marketplace certification.
