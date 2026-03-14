# Change Log

All notable changes to `k8s-unix-system` are documented in this file.

## Unreleased

- Add Ingress resource support with live watch/refresh from the networking.v1 API.
- Visualize Ingress → Service → Workload paths as orthogonal ground-level connectors on namespace platforms.
- Show ingress routing details (host, path, backend) in hover tooltip.
- Add INGRESSES counter to HUD.
- Add Services and Ingresses to the kind setup script for demo coverage.
- Group pods by workload in the 3D namespace layout instead of a flat pod grid.
- Add workload snapshots for Deployments, StatefulSets, DaemonSets, Jobs, and CronJobs.
- Resolve ReplicaSet-owned pods to their Deployment owner for cleaner grouping.
- Show workload ownership in pod tooltip and add workload count to HUD.
