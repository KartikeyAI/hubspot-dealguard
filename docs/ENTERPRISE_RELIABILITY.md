# Enterprise reliability and recovery

## Service objectives

Production targets must be configured and measured for API availability, webhook acceptance, scheduled scans, workflow actions and outbound delivery.

## Controls

- Per-portal health
- Synthetic OAuth, API, webhook and delivery checks
- Recoverable processing leases
- Idempotent event handling
- Exponential retries
- Dead letters and administrator replay
- Scan checkpoints and resumability
- Incident records and status history
- Backup and restore runbooks
- Disaster-recovery exercises

## Release evidence

The release record must contain evidence from failure injection, backup restore and disaster-recovery tests. CI alone is not sufficient to declare operational readiness.
