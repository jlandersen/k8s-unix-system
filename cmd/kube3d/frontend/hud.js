import { state, uiState, updateProblemFilterUI, formatBytes } from './state.js';
import { renderer, camera, orthoCamera, eagleEye } from './scene.js';

// ── HUD Update ─────────────────────────────────────────────────
export function updateHUD() {
  let pods = 0;
  for (const [, ns] of state.namespaces) pods += ns.pods.size;
  document.getElementById('ns-count').textContent = state.namespaces.size;
  document.getElementById('workload-count').textContent = state.workloads.size;
  document.getElementById('pod-count').textContent = pods;
  document.getElementById('node-count').textContent = state.nodes.size;
  document.getElementById('svc-count').textContent = state.services.length;
  document.getElementById('ingress-count').textContent = state.ingresses.length;
  document.getElementById('pvc-count').textContent = state.pvcs.length;
  document.getElementById('warning-count').textContent = state.k8sEvents.filter(e => e.type === 'Warning').length;

  const metricsSummary = document.getElementById('metrics-summary');
  if (metricsSummary) {
    if (state.metricsAvailable && state.podMetrics.size > 0) {
      let totalCPU = 0, totalMem = 0;
      let totalCPUCap = 0, totalMemCap = 0;
      for (const [, m] of state.podMetrics) { totalCPU += m.cpuUsage; totalMem += m.memoryUsage; }
      for (const [, n] of state.nodes) { totalCPUCap += n.cpuCapacity; totalMemCap += n.memoryCapacity; }
      const cpuPct = totalCPUCap > 0 ? ` (${(totalCPU / totalCPUCap * 100).toFixed(0)}%)` : '';
      const memPct = totalMemCap > 0 ? ` (${(totalMem / totalMemCap * 100).toFixed(0)}%)` : '';
      metricsSummary.textContent = `CPU: ${totalCPU}m${cpuPct} · MEM: ${formatBytes(totalMem)}${memPct}`;
      metricsSummary.style.display = 'block';
    } else {
      metricsSummary.style.display = 'none';
    }
  }

  const legend = document.getElementById('metrics-legend');
  if (legend) {
    legend.style.display = uiState.metricsVisible && state.metricsAvailable ? 'block' : 'none';
  }

  updateProblemFilterUI();
}

// ── Debug Overlay (F9) ─────────────────────────────────────────
const dbg = {
  enabled: false,
  el: null,
  frameTimes: [],
  maxSamples: 120,
};

function initDebugOverlay() {
  const el = document.createElement('div');
  el.style.cssText = 'position:fixed;bottom:12px;right:12px;z-index:100;font:11px/1.5 monospace;color:#0f8;background:rgba(0,0,0,0.8);padding:8px 12px;border:1px solid #0f4;border-radius:4px;pointer-events:none;white-space:pre;';
  el.textContent = 'F9 — debug overlay';
  el.style.opacity = '0.5';
  document.body.appendChild(el);
  dbg.el = el;
}
initDebugOverlay();

document.addEventListener('keydown', (e) => {
  if (e.code === 'F9' && !e.repeat) {
    dbg.enabled = !dbg.enabled;
    if (!dbg.enabled) {
      dbg.frameTimes.length = 0;
      dbg.el.textContent = 'F9 — debug overlay';
      dbg.el.style.opacity = '0.5';
    } else {
      dbg.el.style.opacity = '1';
    }
  }
});

export function updateDebugOverlay(dt, renderMs) {
  if (!dbg.enabled) return;

  dbg.frameTimes.push(dt);
  if (dbg.frameTimes.length > dbg.maxSamples) dbg.frameTimes.shift();

  const avg = dbg.frameTimes.reduce((a, b) => a + b, 0) / dbg.frameTimes.length;
  const fps = avg > 0 ? (1 / avg) : 0;
  const ftMs = avg * 1000;

  const info = renderer.info;
  const cam = eagleEye.active ? orthoCamera : camera;
  const pos = cam.position;

  let podCount = 0;
  for (const [, ns] of state.namespaces) podCount += ns.pods.size;
  const nodeCount = state.nodeIsland ? state.nodeIsland.blocks.size : 0;

  dbg.el.textContent =
    `FPS  ${fps.toFixed(0)}  (${ftMs.toFixed(1)}ms)\n` +
    `Draw ${info.render.calls}  Tris ${(info.render.triangles / 1000).toFixed(1)}k\n` +
    `Pods ${podCount}  Nodes ${nodeCount}  NS ${state.namespaces.size}\n` +
    `Cam  ${pos.x.toFixed(1)} ${pos.y.toFixed(1)} ${pos.z.toFixed(1)}\n` +
    `Render ${renderMs.toFixed(1)}ms` +
    (uiState.integerMouseDetected ? '  [int-mouse]' : '');
}
