# Change Log

All notable changes to `k8s-unix-system` are documented in this file.

## Unreleased

## [1.3.0] - 2026-03-16

- Add `--namespace` / `-n` flag to scope all watches to a single namespace, enabling use with restricted RBAC permissions.
- Add `--kubeconfig` flag to specify a custom kubeconfig file path (also respects `KUBECONFIG` env var).
- Auto-detect namespace from kubeconfig context when namespace listing is forbidden.
- Gracefully skip cluster-scoped resources (nodes) when RBAC doesn't permit access.

## [1.2.0] - 2026-03-15

- Rename binary to `kube3d` and publish to Homebrew (`brew install jlandersen/tap/kube3d`).
- Add cross-platform release builds via GoReleaser (linux, macOS, Windows).
- Add `--version` flag.
- Add details side panel for selected resources (pod, node, workload, service, ingress).
- Fix search selection for ingresses now flies to and spotlights the ingress marker.
- Simplify ingress connector lines with a trunk-and-branch layout instead of individual lines per pod.

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
