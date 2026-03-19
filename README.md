# 🦖 k8s Unix System

A 3D Kubernetes resource viewer inspired by the FSN (File System Navigator) from Jurassic Park. Fly through your cluster like it's 1993.

> "It's a Unix system! I know this!"

## Demo

Current demo video:

https://github.com/user-attachments/assets/6817074a-63dc-4ffc-b991-aa2436c1c5b1

If you cannot view the video, here are a couple of screenshots:

<p align="center">
  <img src="assets/screen1.png" alt="Screenshot 1" width="49%" />
  <img src="assets/screen2.png" alt="Screenshot 2" width="49%" />
</p>

Namespaces are rendered as raised platforms (islands), pods as 3D blocks on each island. Live updates via Kubernetes watch API.

**See [FEATURES.md](FEATURES.md) for the full feature list.**

## Highlights

- **Live 3D cluster view** — Namespaces as islands, pods as colored blocks, nodes on a dedicated island
- **Rich resource visualization** — Services (arcs), Ingresses (golden arcs), PVCs (disks), Workload groups (outlines)
- **Interactive pod actions** — Double-click to describe, stream logs, or kill pods
- **Workload management** — Scale, edit resources, restart deployments, manage CronJobs
- **Layer toggles** — Show/hide each resource type (services, ingresses, PVCs, workloads, RBAC, secrets...)
- **Context switcher** — Switch Kubernetes contexts on the fly from the HUD
- **Eagle eye view** — Orthographic top-down overview of the entire cluster
- **Fly-to navigation** — Click a namespace to zoom in and inspect individual pods

## Quick Start (Docker)

```bash
docker run --rm -it \
  -v ~/.kube/config:/root/.kube/config:ro \
  -p 8080:8080 \
  ghcr.io/jlandersen/k8s-unix-system:main

# Use a specific kubeconfig context
docker run --rm -it \
  -v ~/.kube/config:/root/.kube/config:ro \
  -p 8080:8080 \
  ghcr.io/jlandersen/k8s-unix-system:main --context my-cluster
```

Then open http://localhost:8080.

## Install

```bash
go install github.com/jeppe/k8s-unix-system/cmd@latest
```

Or build from source:

```bash
go build -o k8s-unix-system ./cmd/
```

## Usage

```bash
# Use current kubeconfig context
./k8s-unix-system

# Specify a context
./k8s-unix-system --context my-cluster

# Custom port, don't open browser
./k8s-unix-system --port 9090 --no-browser
```

Opens a browser with the 3D view. All data streams live from your cluster.

## Controls

| Key | Action |
|---|---|
| **Click** | Lock cursor for look-around |
| **WASD / Arrows** | Move |
| **Mouse** | Look around |
| **Space** | Fly up |
| **Ctrl** | Fly down |
| **Shift** | Move faster |
| **E** | Toggle eagle eye (top-down) view |
| **L** | Toggle layer panel |
| **Double-click pod** | Open action menu (describe, logs, kill) |
| **Double-click service** | Open action menu (describe, endpoints, port-forward) |
| **Double-click workload** | Open edit panel (scale, resources, restart) |
| **Click ingress arc** | Show route details |
| **Hover any resource** | Show details tooltip |
| **Esc** | Release cursor / close panel |

## Visual Guide

### Pods
- **Green blocks** — Running pods
- **Yellow blocks** — Pending / Initializing
- **Red blocks** — Error / CrashLoopBackOff
- **Orange blocks** — ImagePullBackOff / Terminating
- **Block height** — Increases with restart count
- **Block shape** — Varies by owner kind (Deployment, StatefulSet, etc.)
- Running pods gently bob; error pods shake aggressively

### Nodes
Nodes are rendered on a separate dark-blue island labeled **NODES**. Each node is a cube colored by status:
- **Cyan blocks** — Ready
- **Red blocks** — NotReady

### Services
Glowing cyan tubes connecting a service hub to matched pods. Double-click for describe, endpoints, or port-forward.

### Ingresses
Golden arcs above namespace islands connecting to backend service pods. Click to see routing rules.

### PVCs
Flat cylinder disks on the workload layer. Green = Bound, Yellow = Pending, Red = Lost.

### Workload Groups
Translucent outline boxes grouping pods by their owning Deployment, StatefulSet, DaemonSet, Job, or CronJob. Label shows replica count.

### Namespaces
- **Pink/magenta platforms** — Accessible namespaces
- **Dark/dimmed platforms** — Forbidden namespaces (RBAC denied)

## Flags

| Flag | Default | Description |
|---|---|---|
| `--context` | current | Kubernetes context |
| `--namespace` | all | Restrict to a specific namespace |
| `--kubeconfig` | default | Path to kubeconfig file |
| `--port` | 8080 | HTTP server port |
| `--no-browser` | false | Don't auto-open browser |
