# Enterprise backup and restore

- Take scheduled D1 backups according to the production retention policy.
- Test restore into an isolated environment at least quarterly.
- Verify tenant, subscription, policy, assessment, remediation, audit, outbox and compliance records after restore.
- Reconcile external events received after the restored backup point.
- Never restore secrets from documentation or logs; deployment secrets remain in the secret manager.
- Record restore evidence and recovery time in the release or disaster-recovery record.
