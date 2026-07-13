# DealGuard 2.0 Enterprise release candidate

## Summary

DealGuard 2.0 replaces the Stripe-bound commercial layer with Dodo Payments and completes the enterprise control plane across policy, analytics, access control, remediation, alerting, compliance, reliability and commercial operations.

## Billing

- Dodo Payments hosted checkout
- Customer Portal sessions
- Standard Webhooks verification
- Subscription lifecycle and grace handling
- Monthly and annual products
- Manual Enterprise contracts
- Included allowances, hard caps and optional overage
- Idempotent Dodo usage-event reporting and retry
- Provider-neutral internal entitlements

## Enterprise capabilities

See `ENTERPRISE_COMPLETE_ACCEPTANCE.md` and `POINT_2_A_TO_H_TRACEABILITY.md` for the authoritative release matrix.

## Migration

Apply migrations through:

```text
0008_secure_exports_and_audit_promotion.sql
```

The migration preserves legacy subscription records for audit while the runtime reads and writes `subscriptions_v2`.

## Security

- HMAC verification for Dodo and customer webhooks
- Encrypted integration endpoints and secrets
- Scoped permissions for all mutating operations
- Hash-chained audit records
- Secure time-limited exports
- Legal holds and retention controls
- Dead-letter and replay authorization

## Release gate

This is an RC until CI and all live acceptance checks pass.
