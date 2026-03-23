import * as THREE from 'three';
import {
  state, uiState, POD_BASE_SIZE, podWorkload, formatBytes,
  problemFilter, podMatchesFilter, nodeMatchesFilter, _lastDepthCamPos,
} from './state.js';
import { canvas, activeCamera, eagleEye } from './scene.js';

// ── Raycaster ──────────────────────────────────────────────────
const raycaster = new THREE.Raycaster();
const mouse = new THREE.Vector2();
let hoveredMesh = null;
let mouseDirty = false;
const tooltip = document.getElementById('tooltip');

// Incremental raycast target registry
const rayNsSet = new Set();
const rayPodSet = new Set();
const rayNsTargets = [];
export const rayPodTargets = [];
let rayNsStale = false;
let rayPodStale = false;

export function registerRayTarget(obj) {
  const t = obj.userData?.type;
  if (t === 'namespace' || t === 'label') {
    rayNsSet.add(obj);
    rayNsStale = true;
  }
  if (obj.isMesh && (t === 'pod' || t === 'nodeBlock' || t === 'ingress' || t === 'pvc')) {
    rayPodSet.add(obj);
    rayPodStale = true;
  }
}

export function unregisterRayTarget(obj) {
  if (rayNsSet.delete(obj)) rayNsStale = true;
  if (rayPodSet.delete(obj)) rayPodStale = true;
}

export function ensureRayTargets() {
  if (rayNsStale) {
    rayNsTargets.length = 0;
    for (const obj of rayNsSet) rayNsTargets.push(obj);
    rayNsStale = false;
  }
  if (rayPodStale) {
    rayPodTargets.length = 0;
    for (const obj of rayPodSet) rayPodTargets.push(obj);
    rayPodStale = false;
  }
}

document.addEventListener('mousemove', (e) => {
  if (uiState.pointerLocked) return;
  mouse.x = (e.clientX / window.innerWidth) * 2 - 1;
  mouse.y = -(e.clientY / window.innerHeight) * 2 + 1;
  mouseDirty = true;

  tooltip.style.left = (e.clientX + 16) + 'px';
  tooltip.style.top = (e.clientY + 16) + 'px';
});

export function updateRaycast() {
  if (!mouseDirty) return;
  mouseDirty = false;

  ensureRayTargets();
  raycaster.setFromCamera(mouse, activeCamera());

  if (!uiState.pointerLocked) {
    const nsHits = raycaster.intersectObjects(rayNsTargets);
    let showPointer = nsHits.length > 0;
    if (!showPointer) {
      const resHits = raycaster.intersectObjects(rayPodTargets);
      showPointer = resHits.length > 0;
    }
    canvas.style.cursor = showPointer ? 'pointer' : 'default';
  }

  const intersects = raycaster.intersectObjects(rayPodTargets);

  if (hoveredMesh) {
    hoveredMesh.material.emissiveIntensity = 1;
    hoveredMesh = null;
  }

  if (intersects.length > 0) {
    hoveredMesh = intersects[0].object;
    hoveredMesh.material.emissiveIntensity = 3;

    if (hoveredMesh.userData.type === 'nodeBlock') {
      const node = hoveredMesh.userData.node;
      const statusClass = node.status === 'Ready' ? 'status-running' : 'status-error';
      tooltip.innerHTML = `
        <div class="pod-name">${node.name}</div>
        <div class="pod-ns">node</div>
        <div class="pod-status ${statusClass}">● ${node.status}</div>
        ${node.cpuCapacity ? `<div>CPU: ${node.cpuCapacity}m &middot; Mem: ${formatBytes(node.memoryCapacity)}</div>` : ''}
      `;
      tooltip.style.display = 'block';
    } else if (hoveredMesh.userData.type === 'ingress' || hoveredMesh.userData.type === 'pvc') {
      tooltip.innerHTML = hoveredMesh.userData.tooltipHTML;
      tooltip.style.display = 'block';
    } else {
      const pod = hoveredMesh.userData.pod;
      const owner = podWorkload(pod);
      const statusClass = pod.status === 'Running' ? 'status-running'
        : ['Pending', 'ContainerCreating', 'PodInitializing'].includes(pod.status) ? 'status-pending'
        : 'status-error';
      tooltip.innerHTML = `
        <div class="pod-name">${pod.name}</div>
        <div class="pod-ns">ns/${pod.namespace}${pod.nodeName ? ' · node/' + pod.nodeName : ''}</div>
        <div>${owner.kind}/${owner.name}</div>
        <div class="pod-status ${statusClass}">● ${pod.status}</div>
        <div>Ready: ${pod.ready ? 'YES' : 'NO'} &middot; Restarts: ${pod.restarts}</div>
        ${pod.cpuRequest || pod.memoryRequest ? `<div>CPU: ${pod.cpuRequest ? pod.cpuRequest + 'm' : '—'} &middot; Mem: ${pod.memoryRequest ? formatBytes(pod.memoryRequest) : '—'}</div>` : ''}
        <div>Age: ${pod.age}</div>
      `;
      tooltip.style.display = 'block';
    }
  } else {
    tooltip.style.display = 'none';
  }
}

// ── Pod Animation ──────────────────────────────────────────────
export function animatePods(time) {
  for (const [, ns] of state.namespaces) {
    let i = 0;
    for (const [, mesh] of ns.pods) {
      const pod = mesh.userData.pod;
      const h = mesh.geometry.parameters.height || POD_BASE_SIZE;
      if (pod && pod.status === 'Running') {
        mesh.position.y = h / 2 + Math.sin(time * 2 + i * 0.5) * 0.05;
      } else if (pod && (pod.status === 'CrashLoopBackOff' || pod.status === 'Error')) {
        mesh.position.y = h / 2 + Math.sin(time * 8 + i) * 0.15;
      }
      i++;
    }
  }
}

// ── Depth Transparency ─────────────────────────────────────────
const DEPTH_FADE_START = 30;
const DEPTH_FADE_END = 120;
const DEPTH_MIN_OPACITY = 0.1;
const DEPTH_CAM_THRESHOLD_SQ = 0.25;

const BASE_PLATFORM_OPACITY = 0.85;
const BASE_POD_OPACITY = 0.9;
const BASE_LABEL_OPACITY = 0.9;

function depthOpacityFactor(distance) {
  if (distance <= DEPTH_FADE_START) return 1;
  if (distance >= DEPTH_FADE_END) return DEPTH_MIN_OPACITY;
  const t = (distance - DEPTH_FADE_START) / (DEPTH_FADE_END - DEPTH_FADE_START);
  return 1 - t * (1 - DEPTH_MIN_OPACITY);
}

const _depthTmpVec = new THREE.Vector3();
const _nsFactor = new Map();

export function updateDepthTransparency() {
  const camPos = activeCamera().position;

  if (_lastDepthCamPos.distanceToSquared(camPos) < DEPTH_CAM_THRESHOLD_SQ) return;
  _lastDepthCamPos.copy(camPos);

  const pf = problemFilter.active;

  for (const [nsName, ns] of state.namespaces) {
    ns.group.getWorldPosition(_depthTmpVec);
    const dist = eagleEye.active ? 0 : camPos.distanceTo(_depthTmpVec);
    const f = depthOpacityFactor(dist);

    const prevF = _nsFactor.get(nsName);
    if (prevF === f && pf === _nsFactor.get('__pf')) continue;
    _nsFactor.set(nsName, f);

    if (ns.platform) ns.platform.material.opacity = BASE_PLATFORM_OPACITY * f;
    if (ns.label) ns.label.material.opacity = BASE_LABEL_OPACITY * f;

    for (const [, mesh] of ns.pods) {
      const dimmed = pf && !podMatchesFilter(mesh.userData.pod, pf);
      mesh.material.opacity = (dimmed ? 0.06 : BASE_POD_OPACITY) * f;
    }
  }

  if (state.nodeIsland) {
    state.nodeIsland.group.getWorldPosition(_depthTmpVec);
    const dist = eagleEye.active ? 0 : camPos.distanceTo(_depthTmpVec);
    const f = depthOpacityFactor(dist);
    const prevF = _nsFactor.get('__nodes');
    if (prevF !== f || pf !== _nsFactor.get('__pf')) {
      _nsFactor.set('__nodes', f);
      if (state.nodeIsland.platform) state.nodeIsland.platform.material.opacity = BASE_PLATFORM_OPACITY * f;
      if (state.nodeIsland.label) state.nodeIsland.label.material.opacity = BASE_LABEL_OPACITY * f;
      for (const [, mesh] of state.nodeIsland.blocks) {
        const node = mesh.userData.node;
        const dimmed = pf && !nodeMatchesFilter(node, pf);
        mesh.material.opacity = (dimmed ? 0.06 : BASE_POD_OPACITY) * f;
      }
    }
  }

  _nsFactor.set('__pf', pf);
}
