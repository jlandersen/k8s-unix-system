import * as THREE from 'three';
import { state, uiState } from './state.js';

const METRICS_LABEL_DISTANCE = 12;

function makePodMetricsLabel(cpuPct, memPct) {
  const cvs = document.createElement('canvas');
  const ctx = cvs.getContext('2d');
  const fontSize = 52;
  const fontStr = `400 ${fontSize}px 'Share Tech Mono', monospace`;
  ctx.font = fontStr;
  const line1 = `CPU ${cpuPct}%`;
  const line2 = `MEM ${memPct}%`;
  const w = Math.ceil(Math.max(ctx.measureText(line1).width, ctx.measureText(line2).width)) + 24;
  const lineGap = 10;
  cvs.width = w;
  cvs.height = fontSize * 2 + lineGap + 16;
  ctx.font = fontStr;

  ctx.fillStyle = '#00ccff';
  ctx.shadowColor = '#00ccff';
  ctx.shadowBlur = 8;
  ctx.fillText(line1, 12, fontSize);

  ctx.fillStyle = '#aa44ff';
  ctx.shadowColor = '#aa44ff';
  ctx.shadowBlur = 8;
  ctx.fillText(line2, 12, fontSize * 2 + lineGap);

  const texture = new THREE.CanvasTexture(cvs);
  texture.minFilter = THREE.LinearFilter;
  const aspect = cvs.width / cvs.height;
  const worldH = 1.4;
  const geo = new THREE.PlaneGeometry(aspect * worldH, worldH);
  const mat = new THREE.MeshBasicMaterial({
    map: texture,
    transparent: true,
    opacity: 0.92,
    depthWrite: false,
    depthTest: false,
    side: THREE.DoubleSide,
  });
  const mesh = new THREE.Mesh(geo, mat);
  mesh.renderOrder = 999;
  mesh.rotation.x = -Math.PI / 2;
  mesh.userData = { type: 'metricsLabel' };
  return mesh;
}

function removePodLabel(mesh) {
  if (mesh.userData.metricsLabel) {
    const label = mesh.userData.metricsLabel;
    mesh.remove(label);
    label.geometry.dispose();
    if (label.material.map) label.material.map.dispose();
    label.material.dispose();
    mesh.userData.metricsLabel = null;
    mesh.userData.metricsKey = null;
  }
}

function updatePodOverlay(mesh, pod, metrics) {
  const cpuRatio = metrics && pod.cpuRequest > 0 ? metrics.cpuUsage / pod.cpuRequest : 0;
  const memRatio = metrics && pod.memoryRequest > 0 ? Math.min(metrics.memoryUsage / pod.memoryRequest, 1) : 0;

  if (metrics && (pod.cpuRequest > 0 || pod.memoryRequest > 0)) {
    const cpuPct = Math.round(cpuRatio * 100);
    const memPct = Math.round(memRatio * 100);
    const key = `${cpuPct}:${memPct}`;
    if (mesh.userData.metricsKey === key && mesh.userData.metricsLabel) return;
    removePodLabel(mesh);
    const label = makePodMetricsLabel(cpuPct, memPct);
    const podHeight = mesh.geometry.parameters?.height || 0.7;
    label.position.y = podHeight / 2 + 0.6;
    label.visible = false;
    mesh.userData.metricsLabel = label;
    mesh.userData.metricsKey = key;
    mesh.add(label);
  } else {
    removePodLabel(mesh);
  }
}

function updateNodeOverlay(blockMesh, node, metrics) {
  if (!node || !metrics) {
    removeNodeLabel(blockMesh);
    return;
  }

  const cpuRatio = node.cpuCapacity > 0 ? Math.min(metrics.cpuUsage / node.cpuCapacity, 1) : 0;
  const memRatio = node.memoryCapacity > 0 ? Math.min(metrics.memoryUsage / node.memoryCapacity, 1) : 0;
  const cpuPct = Math.round(cpuRatio * 100);
  const memPct = Math.round(memRatio * 100);
  const key = `${cpuPct}:${memPct}`;
  if (blockMesh.userData.metricsKey === key && blockMesh.userData.metricsLabel) return;

  removeNodeLabel(blockMesh);
  const label = makePodMetricsLabel(cpuPct, memPct);
  label.position.y = 0.6 + 0.6;
  label.visible = false;
  blockMesh.userData.metricsLabel = label;
  blockMesh.userData.metricsKey = key;
  blockMesh.add(label);
}

function removeNodeLabel(blockMesh) {
  if (blockMesh.userData.metricsLabel) {
    const label = blockMesh.userData.metricsLabel;
    blockMesh.remove(label);
    label.geometry.dispose();
    if (label.material.map) label.material.map.dispose();
    label.material.dispose();
    blockMesh.userData.metricsLabel = null;
    blockMesh.userData.metricsKey = null;
  }
}

export function refreshMetricsOverlays() {
  if (!uiState.metricsVisible || !state.metricsAvailable) {
    clearMetricsOverlays();
    return;
  }

  for (const [, ns] of state.namespaces) {
    for (const [, mesh] of ns.pods) {
      const pod = mesh.userData.pod;
      if (!pod) continue;
      const m = state.podMetrics.get(`${pod.namespace}/${pod.name}`);
      updatePodOverlay(mesh, pod, m);
    }
  }

  if (state.nodeIsland && state.nodeMetricsAvailable) {
    for (const [name, blockMesh] of state.nodeIsland.blocks) {
      const node = state.nodes.get(name);
      const m = state.nodeMetrics.get(name);
      updateNodeOverlay(blockMesh, node, m);
    }
  } else if (state.nodeIsland) {
    for (const [, blockMesh] of state.nodeIsland.blocks) {
      removeNodeLabel(blockMesh);
    }
  }
}

export function clearMetricsOverlays() {
  for (const [, ns] of state.namespaces) {
    for (const [, mesh] of ns.pods) {
      removePodLabel(mesh);
    }
  }
  if (state.nodeIsland) {
    for (const [, blockMesh] of state.nodeIsland.blocks) {
      removeNodeLabel(blockMesh);
    }
  }
}

export function updatePodMetricsLabelVisibility(camera) {
  if (!uiState.metricsVisible || !state.metricsAvailable) return;
  const camPos = camera.position;
  const worldPos = new THREE.Vector3();
  for (const [, ns] of state.namespaces) {
    for (const [, mesh] of ns.pods) {
      const label = mesh.userData.metricsLabel;
      if (!label) continue;
      mesh.getWorldPosition(worldPos);
      const visible = camPos.distanceTo(worldPos) < METRICS_LABEL_DISTANCE;
      if (label.visible !== visible) label.visible = visible;
    }
  }
  if (state.nodeIsland) {
    for (const [, blockMesh] of state.nodeIsland.blocks) {
      const label = blockMesh.userData.metricsLabel;
      if (!label) continue;
      blockMesh.getWorldPosition(worldPos);
      const visible = camPos.distanceTo(worldPos) < METRICS_LABEL_DISTANCE;
      if (label.visible !== visible) label.visible = visible;
    }
  }
}

// ── M key toggle ────────────────────────────────────────────────
document.addEventListener('keydown', (e) => {
  if (e.code === 'KeyM' && !e.repeat && !uiState.searchOpen) {
    uiState.metricsVisible = !uiState.metricsVisible;
    if (uiState.metricsVisible) {
      refreshMetricsOverlays();
    } else {
      clearMetricsOverlays();
    }
  }
});
