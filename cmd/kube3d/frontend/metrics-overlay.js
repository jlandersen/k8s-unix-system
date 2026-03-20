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
  }
}

function updatePodOverlay(mesh, pod, metrics) {
  const cpuRatio = metrics && pod.cpuRequest > 0 ? metrics.cpuUsage / pod.cpuRequest : 0;
  const memRatio = metrics && pod.memoryRequest > 0 ? Math.min(metrics.memoryUsage / pod.memoryRequest, 1) : 0;

  if (metrics && (pod.cpuRequest > 0 || pod.memoryRequest > 0)) {
    const cpuPct = Math.round(cpuRatio * 100);
    const memPct = Math.round(memRatio * 100);
    removePodLabel(mesh);
    const label = makePodMetricsLabel(cpuPct, memPct);
    const podHeight = mesh.geometry.parameters?.height || 0.7;
    label.position.y = podHeight / 2 + 0.6;
    label.visible = false;
    mesh.userData.metricsLabel = label;
    mesh.add(label);
  } else {
    removePodLabel(mesh);
  }
}

function updateNodeOverlay(blockMesh, node, metrics) {
  if (!node || !metrics) {
    removeNodeRing(blockMesh);
    return;
  }

  const cpuRatio = node.cpuCapacity > 0 ? Math.min(metrics.cpuUsage / node.cpuCapacity, 1) : 0;
  const memRatio = node.memoryCapacity > 0 ? Math.min(metrics.memoryUsage / node.memoryCapacity, 1) : 0;

  if (blockMesh.userData.metricsRing) {
    const rings = blockMesh.userData.metricsRing;
    _updateArcRing(rings.cpu, cpuRatio, new THREE.Color(0x00ccff));
    _updateArcRing(rings.mem, memRatio, new THREE.Color(0xaa44ff));
  } else {
    const cpuRing = _makeArcRing(0.75, 0.93, cpuRatio, new THREE.Color(0x00ccff));
    const memRing = _makeArcRing(0.97, 1.15, memRatio, new THREE.Color(0xaa44ff));

    cpuRing.rotation.x = -Math.PI / 2;
    cpuRing.position.y = -0.45;
    memRing.rotation.x = -Math.PI / 2;
    memRing.position.y = -0.45;

    blockMesh.userData.metricsRing = { cpu: cpuRing, mem: memRing };
    blockMesh.add(cpuRing);
    blockMesh.add(memRing);
  }
}

function _makeArcRing(innerR, outerR, ratio, color) {
  const thetaLength = Math.max(0.01, ratio * Math.PI * 2);
  const geo = new THREE.RingGeometry(innerR, outerR, 48, 1, -Math.PI / 2, thetaLength);
  const mat = new THREE.MeshBasicMaterial({
    color,
    side: THREE.DoubleSide,
    transparent: true,
    opacity: 0.7,
    depthTest: false,
  });
  const mesh = new THREE.Mesh(geo, mat);
  mesh.renderOrder = 1;
  mesh.userData.innerR = innerR;
  mesh.userData.outerR = outerR;
  return mesh;
}

function _updateArcRing(mesh, ratio, color) {
  mesh.geometry.dispose();
  const thetaLength = Math.max(0.01, ratio * Math.PI * 2);
  mesh.geometry = new THREE.RingGeometry(mesh.userData.innerR, mesh.userData.outerR, 48, 1, -Math.PI / 2, thetaLength);
  mesh.material.color.copy(color);
}

function removeNodeRing(blockMesh) {
  if (blockMesh.userData.metricsRing) {
    const rings = blockMesh.userData.metricsRing;
    blockMesh.remove(rings.cpu);
    blockMesh.remove(rings.mem);
    rings.cpu.geometry.dispose();
    rings.cpu.material.dispose();
    rings.mem.geometry.dispose();
    rings.mem.material.dispose();
    blockMesh.userData.metricsRing = null;
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
      removeNodeRing(blockMesh);
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
      removeNodeRing(blockMesh);
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
    const legend = document.getElementById('metrics-legend');
    if (legend) legend.style.display = uiState.metricsVisible && state.metricsAvailable ? 'block' : 'none';
  }
});
