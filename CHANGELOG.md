# Change Log

All notable changes to `k8s-unix-system` are documented in this file.

## Unreleased

- Add details side panel for selected resources (pod, node, workload, service, ingress).
- Fix search selection for ingresses now flies to and spotlights the ingress marker.

## [1.1.0] - 2026-03-14

- Add advanced search filtering with `kind:`, `ns:`, `status:`, `node:`, `-l` label selectors, and `/regex/` support.
- Add fuzzy matching and relevance-ranked search results.
- Add inline autocomplete with ghost text and cycling for all filter types.

## [1.0.0] - 2026-03-14

- Add Ingress resource support with live watch/refresh from the networking.v1 API.
- Visualize Ingress → Service → Workload paths as orthogonal ground-level connectors on namespace platforms.
- Show ingress routing details (host, path, backend) in hover tooltip.
- Add INGRESSES counter to HUD.
- Add Services and Ingresses to the kind setup script for demo coverage.
- Group pods by workload in the 3D namespace layout instead of a flat pod grid.
- Add workload snapshots for Deployments, StatefulSets, DaemonSets, Jobs, and CronJobs.
- Resolve ReplicaSet-owned pods to their Deployment owner for cleaner grouping.
- Show workload ownership in pod tooltip and add workload count to HUD.
