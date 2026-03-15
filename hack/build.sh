#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
OUT="${ROOT}/kube3d"

cd "$ROOT"
echo "Building kube3d..."
go build -o "$OUT" ./cmd/kube3d
echo "Built: $OUT"
