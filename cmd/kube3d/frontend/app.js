import * as THREE from 'three';
import { camera, orthoCamera, composer, renderer, pointLight } from './scene.js';
import { updateOrthoFrustum } from './scene.js';
import { updateMouseLook, updateCamera } from './camera-controller.js';
import { updateRaycast, updateDepthTransparency, animatePods } from './raycast.js';
import { updateSpotlight } from './spotlight.js';
import { updateHUD, updateDebugOverlay } from './hud.js';
import { connectWS } from './websocket.js';

import { updatePodMetricsLabelVisibility } from './metrics-overlay.js';

// Side-effect imports (register event listeners / init UI)
import './search.js';

// ── Resize ─────────────────────────────────────────────────────
window.addEventListener('resize', () => {
  camera.aspect = window.innerWidth / window.innerHeight;
  camera.updateProjectionMatrix();
  updateOrthoFrustum();
  renderer.setSize(window.innerWidth, window.innerHeight);
  composer.setSize(window.innerWidth, window.innerHeight);
});

// ── Animation Loop ─────────────────────────────────────────────
const clock = new THREE.Clock();
let frameCount = 0;

function animate() {
  requestAnimationFrame(animate);
  const dt = clock.getDelta();
  const time = clock.getElapsedTime();
  frameCount++;

  updateMouseLook();
  updateCamera(dt);
  updateRaycast();
  updateSpotlight(dt);
  updateDepthTransparency();
  updatePodMetricsLabelVisibility(camera);

  if (frameCount & 1) {
    animatePods(time);
  }

  pointLight.position.x = Math.sin(time * 0.3) * 20;
  pointLight.position.z = Math.cos(time * 0.3) * 20;

  const renderStart = performance.now();
  composer.render();
  updateDebugOverlay(dt, performance.now() - renderStart);
}

// ── Boot ───────────────────────────────────────────────────────
animate();
connectWS();
