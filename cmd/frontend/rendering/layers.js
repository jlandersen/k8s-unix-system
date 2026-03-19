import { state, layers } from '../core/state.js';

// ── Layer Visibility ────────────────────────────────────────────
function applyLayerVisibility() {
  if (state.serviceLines) state.serviceLines.visible = layers.services;
  if (state.ingressGroup) state.ingressGroup.visible = layers.ingresses;
  if (state.pvcGroup) state.pvcGroup.visible = layers.pvcs;
  if (state.workloadGroup) state.workloadGroup.visible = layers.workloads;
  if (state.nodeIsland) state.nodeIsland.group.visible = layers.nodes;

  for (const [, ns] of state.namespaces) {
    if (ns.forbidden) {
      ns.group.visible = layers.forbidden;
    }
  }

  // Resource sub-groups visibility
  if (state.resourceGroup) {
    for (const child of state.resourceGroup.children) {
      if (child.userData && child.userData.layerKey) {
        child.visible = !!layers[child.userData.layerKey];
      }
    }
  }
}

// Wire up layer toggle checkboxes
document.querySelectorAll('#layer-panel input[data-layer]').forEach((cb) => {
  cb.addEventListener('change', () => {
    layers[cb.dataset.layer] = cb.checked;
    applyLayerVisibility();
  });
});

export { applyLayerVisibility };
