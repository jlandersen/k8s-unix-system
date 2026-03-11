#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
OUT="${ROOT}/k8s-unix-system"

cd "$ROOT"
echo "Building k8s-unix-system..."
go build -o "$OUT" ./cmd
echo "Built: $OUT"
