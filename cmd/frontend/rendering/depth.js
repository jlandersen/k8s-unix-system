import * as THREE from 'three';
import { state } from '../core/state.js';
import { activeCamera, eagleEye } from '../core/scene.js';

// ── Depth transparency ─────────────────────────────────────────
const DEPTH_FADE_START = 60;
const DEPTH_FADE_END = 250;
const DEPTH_MIN_OPACITY = 0.25;

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
const _lastCamPos = new THREE.Vector3();
let _depthDirty = true;

function markDepthDirty() { _depthDirty = true; }

function updateDepthTransparency() {
  const camPos = activeCamera().position;
  // Skip if camera hasn't moved significantly (saves 300+ material updates per frame)
  if (!_depthDirty && _lastCamPos.distanceToSquared(camPos) < 0.01) return;
  _lastCamPos.copy(camPos);
  _depthDirty = false;

  for (const [, ns] of state.namespaces) {
    ns.group.getWorldPosition(_depthTmpVec);
    const dist = eagleEye.active ? 0 : camPos.distanceTo(_depthTmpVec);
    const f = depthOpacityFactor(dist);

    if (ns.platform) ns.platform.material.opacity = BASE_PLATFORM_OPACITY * f;
    if (ns.label) ns.label.material.opacity = BASE_LABEL_OPACITY * f;

    for (const [, mesh] of ns.pods) {
      mesh.material.opacity = BASE_POD_OPACITY * f;
    }
  }

  // Node island
  if (state.nodeIsland) {
    state.nodeIsland.group.getWorldPosition(_depthTmpVec);
    const dist = eagleEye.active ? 0 : camPos.distanceTo(_depthTmpVec);
    const f = depthOpacityFactor(dist);
    if (state.nodeIsland.platform) state.nodeIsland.platform.material.opacity = BASE_PLATFORM_OPACITY * f;
    if (state.nodeIsland.label) state.nodeIsland.label.material.opacity = BASE_LABEL_OPACITY * f;
    for (const [, mesh] of state.nodeIsland.blocks) {
      mesh.material.opacity = BASE_POD_OPACITY * f;
    }
  }
}

export {
  depthOpacityFactor,
  updateDepthTransparency,
};
