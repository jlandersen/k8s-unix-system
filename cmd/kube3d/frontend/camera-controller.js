import * as THREE from 'three';
import { state, selection, uiState, problemFilter, updateProblemFilterUI, _lastDepthCamPos } from './state.js';
import {
  canvas, camera, orthoCamera, eagleEye, activeCamera,
  updateOrthoFrustum, renderPass, scene,
} from './scene.js';
import {
  spot, SPOT_NS, SPOT_RES,
  positionSpotlight, startSpotlight, startResourceSpotlight,
  fadeOutSpotlight, showPodLabels,
} from './spotlight.js';
import { hideDetailPanel, showDetailForSelection } from './detail-panel.js';
import { ensureRayTargets, rayPodTargets } from './raycast.js';
import { openSearch, closeSearch } from './search.js';

// ── Movement State ─────────────────────────────────────────────
export const velocity = new THREE.Vector3();
export const euler = new THREE.Euler(0, 0, 0, 'YXZ');
const _camDir = new THREE.Vector3();
const keys = {};

// ── Fly-To Animation ───────────────────────────────────────────
export const flyTo = {
  active: false,
  startPos: new THREE.Vector3(),
  startQuat: new THREE.Quaternion(),
  endPos: new THREE.Vector3(),
  endQuat: new THREE.Quaternion(),
  progress: 0,
  duration: 1.4,
  targetResource: null,
  targetNs: null,
};

export function cancelFlyTo() {
  if (!flyTo.active && !spot.active) return;
  flyTo.active = false;
  euler.setFromQuaternion(camera.quaternion);
  fadeOutSpotlight();
}

export function startFlyTo(nsName) {
  const island = nsName === '__nodes__' ? state.nodeIsland : state.namespaces.get(nsName);
  if (!island) return;

  fadeOutSpotlight();

  const worldPos = new THREE.Vector3();
  island.group.getWorldPosition(worldPos);

  flyTo.startPos.copy(camera.position);
  flyTo.startQuat.copy(camera.quaternion);
  flyTo.endPos.set(worldPos.x, worldPos.y + 10, worldPos.z + 12);

  const lookMat = new THREE.Matrix4();
  lookMat.lookAt(flyTo.endPos, worldPos, new THREE.Vector3(0, 1, 0));
  flyTo.endQuat.setFromRotationMatrix(lookMat);

  flyTo.progress = 0;
  flyTo.duration = 1.4;
  flyTo.active = true;
  flyTo.targetNs = nsName;
  velocity.set(0, 0, 0);
}

function startResourceFlyTo(resourceMesh) {
  const wp = new THREE.Vector3();
  resourceMesh.getWorldPosition(wp);

  flyTo.startPos.copy(camera.position);
  flyTo.startQuat.copy(camera.quaternion);
  flyTo.endPos.set(wp.x, wp.y + 6, wp.z + 7);

  const lookMat = new THREE.Matrix4();
  lookMat.lookAt(flyTo.endPos, wp, new THREE.Vector3(0, 1, 0));
  flyTo.endQuat.setFromRotationMatrix(lookMat);

  flyTo.progress = 0;
  flyTo.duration = 0.8;
  flyTo.active = true;
  flyTo.targetNs = null;
  flyTo.targetResource = null;
  velocity.set(0, 0, 0);
}

function flyBackToNamespace(nsName) {
  const island = nsName === '__nodes__' ? state.nodeIsland : state.namespaces.get(nsName);
  if (!island) return;

  const worldPos = new THREE.Vector3();
  island.group.getWorldPosition(worldPos);

  flyTo.startPos.copy(camera.position);
  flyTo.startQuat.copy(camera.quaternion);
  flyTo.endPos.set(worldPos.x, worldPos.y + 10, worldPos.z + 12);

  const lookMat = new THREE.Matrix4();
  lookMat.lookAt(flyTo.endPos, worldPos, new THREE.Vector3(0, 1, 0));
  flyTo.endQuat.setFromRotationMatrix(lookMat);

  flyTo.progress = 0;
  flyTo.duration = 0.8;
  flyTo.active = true;
  flyTo.targetNs = null;
  flyTo.targetResource = null;
  velocity.set(0, 0, 0);
}

function easeInOut(t) {
  return t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2;
}

function updateFlyTo(dt) {
  if (!flyTo.active) return;
  flyTo.progress = Math.min(1, flyTo.progress + dt / flyTo.duration);
  const t = easeInOut(flyTo.progress);
  camera.position.lerpVectors(flyTo.startPos, flyTo.endPos, t);
  camera.quaternion.slerpQuaternions(flyTo.startQuat, flyTo.endQuat, t);
  if (flyTo.progress >= 1) {
    flyTo.active = false;
    euler.setFromQuaternion(camera.quaternion);
    if (flyTo.targetNs) {
      startSpotlight(flyTo.targetNs);
      if (flyTo.targetResource) {
        startResourceSpotlight(flyTo.targetResource);
        showDetailForSelection();
        flyTo.targetResource = null;
      }
    }
  }
}

// ── Keyboard ───────────────────────────────────────────────────
document.addEventListener('keydown', (e) => {
  if ((e.code === 'KeyK' && (e.metaKey || e.ctrlKey)) ||
      ((e.key === '/' || e.key === ':') && !uiState.searchOpen && document.activeElement === document.body)) {
    e.preventDefault();
    for (const k in keys) keys[k] = false;
    const prefix = e.key === ':' ? 'kind:' : e.key === '/' ? '/' : '';
    openSearch(prefix);
    return;
  }
  if (e.code === 'Escape' && uiState.searchOpen) { closeSearch(); return; }

  if (uiState.searchOpen) return;

  if (e.key === '?' && !e.repeat) {
    showControlsHint();
    return;
  }

  keys[e.code] = true;

  if (e.code === 'KeyE' && !e.repeat) {
    toggleEagleEye();
    return;
  }

  if (e.code === 'KeyF' && !e.repeat) {
    const filters = [null, 'unhealthy', 'crashloop', 'unscheduled', 'highusage'];
    const idx = filters.indexOf(problemFilter.active);
    const next = filters[(idx + 1) % filters.length];
    problemFilter.active = next;
    updateProblemFilterUI();
    _lastDepthCamPos.set(Infinity, Infinity, Infinity);
    return;
  }

  const movement = ['KeyW','KeyS','KeyA','KeyD','ArrowUp','ArrowDown','ArrowLeft','ArrowRight','Space','ControlLeft','ControlRight'];
  if (movement.includes(e.code)) {
    if ((e.code === 'KeyW' || e.code === 'KeyS') && spot.active && !flyTo.active) return;
    cancelFlyTo();
  }
});
document.addEventListener('keyup', (e) => { keys[e.code] = false; });

// ── Eagle Eye ──────────────────────────────────────────────────
export function toggleEagleEye() {
  eagleEye.active = !eagleEye.active;

  if (eagleEye.active) {
    if (uiState.pointerLocked) document.exitPointerLock();
    cancelFlyTo();

    eagleEye.panX = camera.position.x;
    eagleEye.panZ = camera.position.z;
    orthoCamera.position.set(eagleEye.panX, 100, eagleEye.panZ);
    orthoCamera.lookAt(eagleEye.panX, 0, eagleEye.panZ);
    updateOrthoFrustum();
    renderPass.camera = orthoCamera;
  } else {
    renderPass.camera = camera;
    euler.setFromQuaternion(camera.quaternion);
  }
  updateControlsHint();
}

canvas.addEventListener('wheel', (e) => {
  if (!eagleEye.active) return;
  e.preventDefault();
  eagleEye.zoom = Math.max(10, Math.min(200, eagleEye.zoom + e.deltaY * 0.05));
  updateOrthoFrustum();
}, { passive: false });

let controlsHintTimer = null;

function showControlsHint() {
  const hint = document.getElementById('controls-hint');
  const shortcut = document.getElementById('controls-shortcut');
  hint.classList.remove('faded');
  shortcut.classList.remove('visible');
  clearTimeout(controlsHintTimer);
  controlsHintTimer = setTimeout(() => {
    hint.classList.add('faded');
    shortcut.classList.add('visible');
  }, 4000);
}

controlsHintTimer = setTimeout(() => {
  document.getElementById('controls-hint').classList.add('faded');
  document.getElementById('controls-shortcut').classList.add('visible');
}, 5000);

function updateControlsHint() {
  const hint = document.getElementById('controls-hint');
  if (eagleEye.active) {
    hint.textContent = 'EAGLE EYE \u2022 WASD/Arrows: Pan \u2022 Scroll: Zoom \u2022 E: Exit';
  } else {
    hint.textContent = 'WASD/Arrows: Move \u00b7 Mouse: Look \u00b7 Shift: Fast \u00b7 Space/Ctrl: Up/Down \u00b7 Click: Lock cursor \u00b7 Esc: Unlock \u00b7 E: Eagle Eye \u00b7 /: Search';
  }
  showControlsHint();
}

// ── Click Handler ──────────────────────────────────────────────
canvas.addEventListener('click', (e) => {
  if (uiState.pointerLocked || uiState.searchOpen) return;
  const clickMouse = new THREE.Vector2(
    (e.clientX / window.innerWidth) * 2 - 1,
    -(e.clientY / window.innerHeight) * 2 + 1,
  );
  const clickRay = new THREE.Raycaster();
  clickRay.setFromCamera(clickMouse, activeCamera());

  ensureRayTargets();
  const resHits = clickRay.intersectObjects(rayPodTargets);
  if (resHits.length > 0) {
    const resMesh = resHits[0].object;
    const resNs = resMesh.userData.type === 'pod'
      ? resMesh.userData.pod?.namespace
      : resMesh.userData.type === 'nodeBlock' ? '__nodes__'
      : resMesh.userData.type === 'ingress' ? resMesh.userData.ingress?.namespace
      : resMesh.userData.type === 'pvc' ? resMesh.userData.pvc?.namespace
      : null;
    if (resNs) {
      if (selection.nsName === resNs) {
        startResourceSpotlight(resMesh);
        startResourceFlyTo(resMesh);
        showDetailForSelection();
      } else {
        if (eagleEye.active) toggleEagleEye();
        flyTo.targetResource = resMesh;
        startFlyTo(resNs);
      }
      return;
    }
  }

  const targets = [];
  scene.traverse((obj) => {
    if (obj.userData.type === 'namespace') targets.push(obj);
    if (obj.userData.type === 'label') targets.push(obj);
  });
  const hits = clickRay.intersectObjects(targets);
  if (hits.length > 0) {
    const hit = hits[0].object;
    const nsName = hit.userData.name ?? hit.parent?.userData?.name;
    if (nsName) {
      if (selection.phase !== 'none' && selection.nsName === nsName && !eagleEye.active) {
        if (selection.phase === 'resource') {
          selection.phase = 'namespace';
          selection.resourceMesh = null;
          positionSpotlight(nsName);
          spot.targetIntensity = SPOT_NS.intensity;
          spot.targetBeamOpacity = SPOT_NS.beamOpacity;
          spot.targetGlowOpacity = SPOT_NS.glowOpacity;
          spot.fadingIn = true;
          spot.fadingOut = false;
          flyBackToNamespace(nsName);
          hideDetailPanel();
        }
        return;
      }
      if (eagleEye.active) toggleEagleEye();
      flyTo.targetResource = null;
      startFlyTo(nsName);
      return;
    }
  }

  if (selection.phase !== 'none') {
    fadeOutSpotlight();
    return;
  }

  if (!eagleEye.active) canvas.requestPointerLock();
});

document.addEventListener('pointerlockchange', () => {
  uiState.pointerLocked = document.pointerLockElement === canvas;
});

// ── Mouse Look ─────────────────────────────────────────────────
let pendingMouseX = 0;
let pendingMouseY = 0;
let prevRawX = 0;
let prevRawY = 0;

let mouseEventsSampled = 0;
const MOUSE_SAMPLE_COUNT = 20;
const SENSITIVITY_DEFAULT = 0.002;
const SENSITIVITY_INTEGER = 0.0013;
let mouseSensitivity = SENSITIVITY_DEFAULT;

document.addEventListener('mousemove', (e) => {
  if (!uiState.pointerLocked || uiState.searchOpen) return;
  cancelFlyTo();
  pendingMouseX += e.movementX;
  pendingMouseY += e.movementY;

  if (mouseEventsSampled < MOUSE_SAMPLE_COUNT) {
    if (e.movementX % 1 !== 0 || e.movementY % 1 !== 0) {
      uiState.integerMouseDetected = false;
      mouseEventsSampled = MOUSE_SAMPLE_COUNT;
      mouseSensitivity = SENSITIVITY_DEFAULT;
    } else {
      mouseEventsSampled++;
      if (mouseEventsSampled >= MOUSE_SAMPLE_COUNT) {
        uiState.integerMouseDetected = true;
        mouseSensitivity = SENSITIVITY_INTEGER;
      }
    }
  }
});

export function updateMouseLook() {
  const rawX = pendingMouseX;
  const rawY = pendingMouseY;
  pendingMouseX = 0;
  pendingMouseY = 0;

  let dx, dy;
  if (uiState.integerMouseDetected) {
    dx = (rawX !== 0 && prevRawX !== 0) ? (rawX + prevRawX) * 0.5 : rawX;
    dy = (rawY !== 0 && prevRawY !== 0) ? (rawY + prevRawY) * 0.5 : rawY;
  } else {
    dx = rawX;
    dy = rawY;
  }
  prevRawX = rawX;
  prevRawY = rawY;

  if (dx === 0 && dy === 0) return;

  euler.y -= dx * mouseSensitivity;
  euler.x -= dy * mouseSensitivity;
  euler.x = Math.max(-Math.PI / 2, Math.min(Math.PI / 2, euler.x));
  camera.quaternion.setFromEuler(euler);
}

export function updateCamera(dt) {
  if (eagleEye.active) {
    const speed = keys['ShiftLeft'] || keys['ShiftRight'] ? 60 : 25;
    const dx = ((keys['KeyD'] || keys['ArrowRight']) ? 1 : 0) - ((keys['KeyA'] || keys['ArrowLeft']) ? 1 : 0);
    const dz = ((keys['KeyS'] || keys['ArrowDown']) ? 1 : 0) - ((keys['KeyW'] || keys['ArrowUp']) ? 1 : 0);
    eagleEye.panX += dx * speed * dt;
    eagleEye.panZ += dz * speed * dt;
    orthoCamera.position.set(eagleEye.panX, 100, eagleEye.panZ);
    orthoCamera.lookAt(eagleEye.panX, 0, eagleEye.panZ);
    return;
  }

  if (flyTo.active) { updateFlyTo(dt); return; }

  const speed = keys['ShiftLeft'] || keys['ShiftRight'] ? 40 : 15;

  _camDir.set(0, 0, 0);
  if (keys['KeyW'] || keys['ArrowUp']) _camDir.z -= 1;
  if (keys['KeyS'] || keys['ArrowDown']) _camDir.z += 1;
  if (keys['KeyA'] || keys['ArrowLeft']) _camDir.x -= 1;
  if (keys['KeyD'] || keys['ArrowRight']) _camDir.x += 1;
  if (keys['Space']) _camDir.y += 1;
  if (keys['ControlLeft'] || keys['ControlRight']) _camDir.y -= 1;

  _camDir.normalize();
  _camDir.applyQuaternion(camera.quaternion);

  velocity.lerp(_camDir.multiplyScalar(speed), 0.1);
  camera.position.addScaledVector(velocity, dt);
}
