# Change Log

All notable changes to `k8s-unix-system` are documented in this file.

## [Unreleased]

- Improve rendering and streaming performance: scene object retention, layout memoization, draw distance culling, WebSocket compression with backpressure detection, reduced lock contention, and cached overlay labels.
- Add performance metrics to debug overlay (F9): geometry/texture counts, flush and layout timing, WebSocket message rate and throughput.
- Declutter UI: auto-hide controls hint after 5 seconds, press `?` to show again.
- Collapse problem filter buttons behind a single toggle that shows total count and hides when no problems exist.
- Replace node metric rings with text labels consistent with pod metrics.
- Remove metrics legend overlay from bottom-left corner.

## [1.4.0] - 2026-03-20

- Add live pod and node metrics from `metrics-server`, streamed over WebSocket into the frontend.
- Add a metrics overlay with per-node CPU/memory rings, per-pod usage labels, HUD summary, and `M` toggle.
- Show CPU/memory usage in pod, node, and workload detail panels, and add a HIGH USAGE problem filter.
- Install `metrics-server` in the kind setup script, grant pod metrics access to the restricted demo user, and add a CPU-stress sample pod for the overlay.
- Show ConfigMap and Secret references in pod and workload detail panels, collected from volumes, envFrom, and env.valueFrom across all containers.
- Add PVC/PV support: purple cylinder markers on namespace platforms with connector lines to mounting pods, clickable with fly-to and spotlight.
- Show PVC/PV details in the side panel, volumes section in pod detail, `kind:pvc` / `kind:pv` search filters, and PVCS counter in HUD.
- Add Kubernetes Events as first-class diagnostics (Warning events, live watch, 30-min TTL).
- Show events in the detail panel for pods, nodes, and workloads.
- Add WARNINGS problem filter and warning count to HUD.
- Add events to omnisearch (`kind:event`) with navigation to involved resource.
- Add event-generating sample workloads to the kind setup script (bad image, missing configmap, impossible resource requests).

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
