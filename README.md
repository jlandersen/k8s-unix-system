# 🦖 k8s Unix System

A 3D Kubernetes resource viewer inspired by the FSN (File System Navigator) from Jurassic Park.

> "It's a Unix system! I know this!"

Namespaces are rendered as raised platforms (islands), pods as 3D blocks on each island. Live updates via Kubernetes watch API. Fly through your cluster like it's 1993.

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
| **Hover pod** | Show details tooltip |
| **Esc** | Release cursor |

## Visual Guide

- **Green blocks** — Running pods
- **Yellow blocks** — Pending / Initializing
- **Red blocks** — Error / CrashLoopBackOff
- **Platform color** — Namespace island (pink/magenta)
- **Block height** — Increases with restart count
- Pods gently bob when running; error pods shake

## Flags

| Flag | Default | Description |
|---|---|---|
| `--context` | current | Kubernetes context |
| `--port` | 8080 | HTTP server port |
| `--no-browser` | false | Don't auto-open browser |
