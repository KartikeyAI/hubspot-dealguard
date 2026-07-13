# Enterprise rollback plan

- Preserve pre-deployment D1 backup.
- Keep the previous Worker deployment available for rollback.
- Treat schema migrations as forward-compatible; do not drop legacy tables during the RC.
- Disable new scheduled processors before rolling back application code when new tables are involved.
- Reconcile Dodo, HubSpot and outbox events received during the rollback window.
- Record the rollback as an incident and audit event.
