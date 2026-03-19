# Features

## Core Visualization

### Namespace Islands
Namespaces are rendered as raised pink/magenta platforms (islands) arranged in a grid layout. Each island displays its namespace name as a glowing label. Forbidden namespaces (RBAC access denied) are shown as darker, dimmed islands.

### Pod Blocks
Pods are rendered as 3D blocks sitting on their namespace island. Pod shape varies by owner kind (Deployment, StatefulSet, DaemonSet, Job, CronJob). Each pod block includes container ring indicators showing the number of containers. Block height increases with restart count.

**Status colors:**
| Status | Color |
|---|---|
| Running | Green |
| Succeeded | Blue |
| Pending / ContainerCreating / PodInitializing | Yellow |
| Failed / Error | Red |
| CrashLoopBackOff | Deep Red |
| ImagePullBackOff | Orange |
| Terminating | Dark Orange |

**Animations:**
- Running pods gently bob up and down
- CrashLoopBackOff / Error pods shake aggressively (high amplitude vibration)

### Node Island
Nodes are displayed on a dedicated dark-blue island labeled **NODES**. Each node is a cube colored by status (cyan = Ready, red = NotReady). Hover to see name, status, CPU and memory capacity.

### Service Connections
Services are visualized as glowing cyan tubes connecting a service hub (small sphere) to each matched pod. The hub floats above the center of the matched pods. Tubes are semi-transparent with emissive glow for depth. Hover a tube or hub to see service details (name, type, ClusterIP, ports, matched pod count). Double-click to open an action menu with Describe, Endpoints, and Port-forward.

### Ingress Visualization
Ingresses are rendered as golden arcs above namespace islands, connecting to their backend service pods. Click an ingress arc to open a route list panel showing hosts, paths, and backend services. Routes are clickable links.

### PVC Disks
PersistentVolumeClaims are shown as flat cylinder disks on the workload layer. Color indicates status (green = Bound, yellow = Pending, red = Lost). Hover to see name, status, and capacity.

### Workload Groups
Deployments, StatefulSets, DaemonSets, Jobs, and CronJobs are rendered as translucent outline boxes grouping their pods. A floating label shows the workload name and replica count (e.g. `my-deploy (3/3)`). Color indicates health (green = all ready, yellow = partially ready, red = no replicas ready).

### Generic Resources
Additional resource types are collected and displayed as small markers:
- ConfigMaps, Secrets, ServiceAccounts
- HPA, NetworkPolicies, PodDisruptionBudgets
- ReplicaSets, RBAC (Roles, ClusterRoles, Bindings)
- Other unclassified resources

## Interactive Features

### Context Switcher
A dropdown in the HUD allows switching between Kubernetes contexts on the fly. The server restarts its watchers against the new context and pushes a fresh snapshot via WebSocket.

### Layer Toggle Panel
A toggleable side panel (`L` key or HUD button) controls visibility of each resource layer:
- Services, Ingresses, PVCs, Workloads, Nodes
- Forbidden namespaces
- ConfigMaps, Secrets, ServiceAccounts, HPA, NetworkPolicies, PDB, ReplicaSets, RBAC, other resources

### Pod Actions (Double-Click Menu)
Double-click a pod to open a radial action menu:
- **Describe** (`D`) — Fetches `kubectl describe` output in a terminal panel
- **Logs** (`L`) — Streams live pod logs in a terminal panel
- **Kill** (`K`) — Deletes the pod (with confirmation dialog)

### Service Actions (Double-Click Menu)
Double-click a service tube or hub to open an action menu:
- **Describe** (`D`) — Fetches service details (type, ClusterIP, ports, selector, labels, events)
- **Endpoints** (`E`) — Shows resolved endpoints with pod names, IPs, nodes, and ready status
- **Port-forward** (`P`) — Starts `kubectl port-forward` to the service on a free local port, with clickable link

### Workload Edit Panel
Double-click a workload group to open an edit panel:
- **Scale** — Adjust replica count for Deployments and StatefulSets
- **Resources** — Edit CPU/memory requests and limits per container
- **Restart** — Trigger a rolling restart
- **CronJob controls** — Edit schedule (with human-readable helper), suspend/resume, trigger manual run

### Ingress Route Panel
Click an ingress arc to view all routing rules: host, path, and backend service. Each route is a clickable link opening the URL.

### Hover Tooltips
Hover any resource to see a detailed tooltip with:
- Pod: name, namespace, status, IP, node, owner, containers, restarts, age, labels, matched services
- Node: name, status, CPU capacity, memory capacity
- Workload: name, kind, replicas, ready count
- PVC: name, namespace, status, capacity

### Billboard Labels
When zoomed into a namespace (spot view), pod and node labels float as billboard sprites that always face the camera, color-coded by status.

## Navigation

### Flight Controls
| Key | Action |
|---|---|
| WASD / Arrows | Move |
| Mouse | Look around |
| Space | Fly up |
| Ctrl | Fly down |
| Shift | Move faster |
| Click | Lock cursor for look-around |
| Esc | Release cursor |

### Eagle Eye View
Press `E` to toggle an orthographic top-down view of the entire cluster. Scroll to zoom, click and drag to pan.

### Fly-to / Spot View
Click a namespace island to fly to it and enter spot view. The camera swoops down to inspect individual pods. Press `Esc` or click outside to return to free-flight.

## Visual Effects

- **Post-processing bloom** — Unreal bloom pass for neon glow
- **CRT scanlines** — Overlay scanline effect for retro feel
- **Horizon gradient sky** — Dark green horizon glow fading to black
- **Fog** — Exponential fog for depth perception
- **Ground grid** — Infinite-feel dark ground plane

## Backend

### Live Streaming
All data streams live from the cluster via Kubernetes watch API over a single WebSocket connection. Pod, Service, and Ingress watchers emit real-time events. A periodic full snapshot ensures consistency.

### Parallel Namespace Listing
Resource listing is parallelized across namespaces (semaphore-controlled) for fast initial load on large clusters.

### API Endpoints
| Endpoint | Method | Description |
|---|---|---|
| `/api/contexts` | GET | List available kubeconfig contexts |
| `/api/context/switch` | POST | Switch active context |
| `/api/pod/describe` | GET | Describe a pod |
| `/api/pod/logs` | GET | Stream pod logs (SSE) |
| `/api/pod/delete` | DELETE | Delete a pod |
| `/api/workload/describe` | GET | Describe a workload |
| `/api/workload/scale` | PATCH | Scale a deployment/statefulset |
| `/api/workload/resources` | PATCH | Update container resources |
| `/api/workload/restart` | POST | Rolling restart |
| `/api/cronjob/schedule` | PATCH | Update cron schedule |
| `/api/cronjob/suspend` | PATCH | Suspend/resume cronjob |
| `/api/cronjob/trigger` | POST | Trigger manual job |
| `/api/service/describe` | GET | Describe a service |
| `/api/service/endpoints` | GET | List service endpoints |
| `/api/service/portforward` | POST | Start port-forward to service |
| `/api/service/portforward` | DELETE | Stop active port-forward |

### Flags
| Flag | Default | Description |
|---|---|---|
| `--context` | current | Kubernetes context |
| `--namespace` | all | Restrict to specific namespace |
| `--kubeconfig` | default | Path to kubeconfig file |
| `--port` | 8080 | HTTP server port |
| `--no-browser` | false | Don't auto-open browser |
