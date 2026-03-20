import * as THREE from 'three';

// ── Core ────────────────────────────────────────────────────────
import {
  renderer,
  camera,
  composer,
  updateOrthoFrustum,
  pointLight,
} from './core/scene.js';

// ── Rendering ───────────────────────────────────────────────────
import { updateBillboards } from './rendering/labels.js';
import { setLayoutDeps } from './rendering/namespaces.js';
import './rendering/layers.js'; // side-effect: wires up layer checkboxes
import { updateDepthTransparency } from './rendering/depth.js';
import { selectorMatchesLabels } from './rendering/services.js';
import { podURLs } from './rendering/ingresses.js';
import { RESOURCE_COLORS } from './rendering/resources.js';
import { animatePods } from './rendering/pods.js';

// ── Interaction ─────────────────────────────────────────────────
import {
  euler,
  spot,
  showPodLabels,
  updateCamera,
  updateSpotlight,
} from './interaction/camera.js';
import { setRaycastDeps, updateRaycast } from './interaction/raycast.js';
import {
  podMenu,
  outputPanel,
  killConfirm,
  selectedPod,
  closePodMenu,
  closeOutputPanel,
  closeKillConfirm,
  doPodDescribe,
  doPodLogs,
  showKillConfirm,
  doKillPod,
  setActiveMenuItem,
  repositionPodMenu,
  setSvcMenuDeps,
} from './interaction/pod-menu.js';
import {
  svcMenu,
  svcMenuTitle,
  selectedServiceRef,
  closeSvcMenu,
  doServiceDescribe,
  doServiceEndpoints,
  doServicePortForward,
} from './interaction/svc-menu.js';
import { wlEditPanel, closeWorkloadEdit } from './interaction/workload-edit.js';
import { closeResourceMenu, closeResourceEdit, doResourceDescribe, openResourceEdit } from './interaction/resource-menu.js';
import { ingressPanel, closeIngressPanel } from './interaction/ingress-panel.js';

// ── Network ─────────────────────────────────────────────────────
import { connectWS } from './net/websocket.js';
import { loadContexts } from './net/context.js';

// ── Wire up late-bound dependencies ─────────────────────────────
// layoutNamespaces needs euler, spot, showPodLabels from camera.js
setLayoutDeps({ euler, spot, showPodLabels });

// raycast tooltip needs selectorMatchesLabels, podURLs, RESOURCE_COLORS
setRaycastDeps({ selectorMatchesLabels, podURLs, RESOURCE_COLORS });

// pod-menu dblclick handler needs svc-menu refs
setSvcMenuDeps({
  closeSvcMenu,
  svcMenu,
  svcMenuTitle,
  doServicePortForward,
  selectedServiceRef,
});

// ── Click-outside handlers ──────────────────────────────────────
document.addEventListener('click', (e) => {
  if (podMenu.style.display === 'block' && !podMenu.contains(e.target) && !outputPanel.contains(e.target)) {
    closePodMenu();
    closeOutputPanel();
  }
  if (svcMenu.style.display === 'block' && !svcMenu.contains(e.target) && !outputPanel.contains(e.target)) {
    closeSvcMenu();
    closeOutputPanel();
  }
  if (wlEditPanel.style.display === 'block' && !wlEditPanel.contains(e.target)) {
    closeWorkloadEdit();
  }
  const resourceMenu = document.getElementById('resource-menu');
  if (resourceMenu && resourceMenu.style.display === 'block' && !resourceMenu.contains(e.target) && !outputPanel.contains(e.target)) {
    closeResourceMenu();
  }
  const resourceEditPanel = document.getElementById('resource-edit-panel');
  if (resourceEditPanel && resourceEditPanel.style.display === 'block' && !resourceEditPanel.contains(e.target)) {
    closeResourceEdit();
  }
});

// ── Keyboard shortcuts when menus are open ──────────────────────
document.addEventListener('keydown', (e) => {
  // Kill confirm dialog
  if (killConfirm.style.display === 'block') {
    if (e.key === 'y' || e.key === 'Y') { doKillPod(); return; }
    if (e.key === 'n' || e.key === 'N' || e.key === 'Escape') { closeKillConfirm(); return; }
    return;
  }

  // Ingress panel
  if (ingressPanel.style.display === 'block') {
    if (e.key === 'Escape') { closeIngressPanel(); return; }
  }

  // Workload edit panel
  if (wlEditPanel.style.display === 'block') {
    if (e.key === 'Escape') { closeWorkloadEdit(); return; }
  }

  // Output panel
  if (outputPanel.style.display === 'flex') {
    if (e.key === 'Escape') { closeOutputPanel(); return; }
  }

  // Resource menu shortcuts
  const resourceMenu = document.getElementById('resource-menu');
  const resourceEditPanel = document.getElementById('resource-edit-panel');
  if (resourceMenu && resourceMenu.style.display === 'block') {
    if (e.key === 'v' || e.key === 'V') { doResourceDescribe(); return; }
    if (e.key === 'e' || e.key === 'E') { openResourceEdit(); return; }
    if (e.key === 'Escape') { closeResourceMenu(); return; }
  }
  if (resourceEditPanel && resourceEditPanel.style.display === 'block') {
    if (e.key === 'Escape') { closeResourceEdit(); return; }
  }

  // Service menu shortcuts -- D/E keep menu open, Escape closes it
  if (svcMenu.style.display === 'block' && selectedServiceRef.value) {
    if (e.key === 'd' || e.key === 'D') { doServiceDescribe(selectedServiceRef.value); return; }
    if (e.key === 'e' || e.key === 'E') { doServiceEndpoints(selectedServiceRef.value); return; }
    if (e.key === 'Escape') { closeSvcMenu(); closeOutputPanel(); return; }
  }

  // Pod menu shortcuts -- D/L keep menu open, K/Escape close it
  if (podMenu.style.display === 'block' && selectedPod) {
    if (e.key === 'd' || e.key === 'D') { doPodDescribe(selectedPod); setActiveMenuItem('pod-menu-describe'); repositionPodMenu(); return; }
    if (e.key === 'l' || e.key === 'L') { doPodLogs(selectedPod); setActiveMenuItem('pod-menu-logs'); repositionPodMenu(); return; }
    if (e.key === 'k' || e.key === 'K') { showKillConfirm(selectedPod); closePodMenu(); return; }
    if (e.key === 'o' || e.key === 'O') {
      const openUrlItem = document.getElementById('pod-menu-open-url');
      if (openUrlItem.style.display !== 'none') {
        const urls = JSON.parse(openUrlItem.dataset.urls || '[]');
        for (const url of urls) window.open(url, '_blank');
      }
      return;
    }
    if (e.key === 'Escape') { closePodMenu(); closeOutputPanel(); return; }
  }
});

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

function animate() {
  requestAnimationFrame(animate);
  const dt = clock.getDelta();
  const time = clock.getElapsedTime();

  updateCamera(dt);
  updateRaycast();
  updateSpotlight(dt);
  animatePods(time);
  updateDepthTransparency();
  updateBillboards();

  // Slowly rotate point light
  pointLight.position.x = Math.sin(time * 0.3) * 20;
  pointLight.position.z = Math.cos(time * 0.3) * 20;

  composer.render();
}

// ── Boot ───────────────────────────────────────────────────────
loadContexts();
animate();
connectWS();
