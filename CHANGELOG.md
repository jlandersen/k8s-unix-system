# Change Log

All notable changes to `k8s-unix-system` are documented in this file.

## Unreleased

- Group pods by workload in the 3D namespace layout instead of a flat pod grid.
- Add workload snapshots for Deployments, StatefulSets, DaemonSets, Jobs, and CronJobs.
- Resolve ReplicaSet-owned pods to their Deployment owner for cleaner grouping.
- Show workload ownership in pod tooltip and add workload count to HUD.
