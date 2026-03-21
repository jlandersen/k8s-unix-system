import * as THREE from 'three';

// ── Global State ───────────────────────────────────────────────
export const state = {
  namespaces: new Map(),
  nodes: new Map(),
  nodeIsland: null,
  workloads: new Map(),
  services: [],
  serviceLines: null,
  ingresses: [],
  ingressLines: null,
  k8sEvents: [],
  pvcs: [],
  pvs: [],
  pvcLines: null,
  podMetrics: new Map(),    // key: "namespace/podName" -> { cpuUsage, memoryUsage }
  nodeMetrics: new Map(),   // key: nodeName -> { cpuUsage, memoryUsage }
  metricsAvailable: false,
  nodeMetricsAvailable: false,
};

export const selection = {
  phase: 'none',       // 'none' | 'namespace' | 'resource'
  nsName: null,
  resourceMesh: null,
};

export const uiState = {
  searchOpen: false,
  pointerLocked: false,
  integerMouseDetected: false,
  metricsVisible: true,
};

// ── Problem Filters ────────────────────────────────────────────
export const problemFilter = { active: null };

export const HEALTHY_STATUSES = new Set(['Running', 'Succeeded']);
export const CRASHLOOP_STATUSES = new Set(['CrashLoopBackOff', 'ImagePullBackOff']);

const FILTER_LABELS = {
  unhealthy: 'UNHEALTHY',
  crashloop: 'CRASHLOOP',
  unscheduled: 'PENDING',
  warnings: 'WARNINGS',
  highusage: 'HIGH USAGE',
};

export function metricsForPod(pod) {
  return state.podMetrics.get(`${pod.namespace}/${pod.name}`);
}

export function metricsForNode(nodeName) {
  return state.nodeMetrics.get(nodeName);
}

export function podMatchesFilter(pod, filter) {
  switch (filter) {
    case 'unhealthy':
      return !HEALTHY_STATUSES.has(pod.status);
    case 'crashloop':
      return CRASHLOOP_STATUSES.has(pod.status) || pod.restarts > 0;
    case 'unscheduled':
      return pod.status === 'Pending' || !pod.ready;
    case 'warnings':
      return state.k8sEvents.some(e =>
        e.type === 'Warning' && e.involvedObjectName === pod.name && e.namespace === pod.namespace
      );
    case 'highusage': {
      const m = metricsForPod(pod);
      if (!m) return false;
      if (pod.cpuRequest > 0 && m.cpuUsage / pod.cpuRequest > 0.8) return true;
      if (pod.memoryRequest > 0 && m.memoryUsage / pod.memoryRequest > 0.8) return true;
      return false;
    }
    default:
      return true;
  }
}

export function nodeMatchesFilter(node, filter) {
  if (filter === 'unhealthy') return node.status !== 'Ready';
  return false;
}

let _problemCounts = { unhealthy: 0, crashloop: 0, unscheduled: 0, warnings: 0, highusage: 0 };
let _problemCountsDirty = true;

export function invalidateProblemCounts() {
  _problemCountsDirty = true;
}

export function countProblems() {
  if (!_problemCountsDirty) return _problemCounts;
  const counts = { unhealthy: 0, crashloop: 0, unscheduled: 0, warnings: 0, highusage: 0 };
  for (const [, ns] of state.namespaces) {
    for (const [, mesh] of ns.pods) {
      const pod = mesh.userData.pod;
      if (!pod) continue;
      if (!HEALTHY_STATUSES.has(pod.status)) counts.unhealthy++;
      if (CRASHLOOP_STATUSES.has(pod.status) || pod.restarts > 0) counts.crashloop++;
      if (pod.status === 'Pending' || !pod.ready) counts.unscheduled++;
      const m = metricsForPod(pod);
      if (m) {
        if (pod.cpuRequest > 0 && m.cpuUsage / pod.cpuRequest > 0.8) { counts.highusage++; continue; }
        if (pod.memoryRequest > 0 && m.memoryUsage / pod.memoryRequest > 0.8) counts.highusage++;
      }
    }
  }
  for (const [, node] of state.nodes) {
    if (node.status !== 'Ready') counts.unhealthy++;
  }
  counts.warnings = state.k8sEvents.filter(e => e.type === 'Warning').length;
  _problemCounts = counts;
  _problemCountsDirty = false;
  return counts;
}

export function updateProblemFilterUI() {
  const counts = countProblems();
  const total = counts.unhealthy + counts.crashloop + counts.unscheduled + counts.warnings + counts.highusage;
  const container = document.getElementById('problem-filters');
  const toggle = document.getElementById('pf-toggle');
  const toggleLabel = document.getElementById('pf-toggle-label');
  const toggleCount = document.getElementById('pf-toggle-count');

  container.style.display = (total === 0 && !problemFilter.active) ? 'none' : 'flex';

  if (problemFilter.active) {
    toggleLabel.textContent = '\u2715 ' + FILTER_LABELS[problemFilter.active];
    toggleCount.textContent = counts[problemFilter.active] > 0 ? ` (${counts[problemFilter.active]})` : '';
    toggle.classList.add('active');
    container.classList.remove('expanded');
  } else {
    toggleLabel.textContent = 'FILTERS';
    toggleCount.textContent = total > 0 ? ` (${total})` : '';
    toggle.classList.remove('active');
  }

  for (const btn of document.querySelectorAll('#pf-buttons .pf-btn')) {
    const filter = btn.dataset.filter;
    const countEl = btn.querySelector('.pf-count');
    const c = counts[filter] || 0;
    countEl.textContent = c > 0 ? `(${c})` : '';
    btn.classList.toggle('active', problemFilter.active === filter);
  }
}

export function toggleProblemFilter(filter) {
  problemFilter.active = problemFilter.active === filter ? null : filter;
  updateProblemFilterUI();
  _lastDepthCamPos.set(Infinity, Infinity, Infinity);
}

document.getElementById('pf-toggle').addEventListener('click', () => {
  if (problemFilter.active) {
    problemFilter.active = null;
    updateProblemFilterUI();
    _lastDepthCamPos.set(Infinity, Infinity, Infinity);
  } else {
    document.getElementById('problem-filters').classList.toggle('expanded');
  }
});

document.querySelectorAll('#pf-buttons .pf-btn').forEach(btn => {
  btn.addEventListener('click', () => toggleProblemFilter(btn.dataset.filter));
});

// ── Layout Constants ───────────────────────────────────────────
export const PLATFORM_GAP = 12;
export const POD_BASE_SIZE = 0.7;
export const POD_MIN_SIZE = 0.5;
export const POD_MAX_SIZE = 1.8;
export const POD_GAP = 1.5;
export const POD_STRIDE = POD_MAX_SIZE + POD_GAP;
export const WORKLOAD_GAP = 2.2;
export const PLATFORM_Y = 0;
export const PLATFORM_HEIGHT = 0.3;
export const LABEL_Y_OFFSET = 0.5;
export const NODE_BLOCK_SIZE = 1.2;

// ── Status Colors ──────────────────────────────────────────────
export const STATUS_COLORS = {
  Running:            0x00ff88,
  Succeeded:          0x00aaff,
  Pending:            0xffcc00,
  ContainerCreating:  0xffcc00,
  PodInitializing:    0xffcc00,
  Failed:             0xff4444,
  Error:              0xff4444,
  CrashLoopBackOff:   0xff2222,
  ImagePullBackOff:   0xff6600,
  Terminating:        0xff8800,
  Unknown:            0x888888,
};

export function statusColor(status) {
  return STATUS_COLORS[status] ?? 0x00ff88;
}

// ── Utilities ──────────────────────────────────────────────────
export function formatBytes(bytes) {
  if (bytes < 1024) return bytes + 'B';
  if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(0) + 'Ki';
  if (bytes < 1024 * 1024 * 1024) return (bytes / (1024 * 1024)).toFixed(0) + 'Mi';
  return (bytes / (1024 * 1024 * 1024)).toFixed(1) + 'Gi';
}

export function workloadKey(namespace, kind, name) {
  return `${namespace}/${kind}/${name}`;
}

export function podWorkload(pod) {
  if (pod.ownerKind && pod.ownerName) {
    return { kind: pod.ownerKind, name: pod.ownerName };
  }
  return { kind: 'Pod', name: pod.name };
}

export function relativeTime(unixSeconds) {
  if (!unixSeconds) return '';
  const delta = Math.floor(Date.now() / 1000 - unixSeconds);
  if (delta < 0) return 'just now';
  if (delta < 60) return delta + 's ago';
  if (delta < 3600) return Math.floor(delta / 60) + 'm ago';
  if (delta < 86400) return Math.floor(delta / 3600) + 'h ago';
  return Math.floor(delta / 86400) + 'd ago';
}

export function eventsForResource(kind, name, namespace) {
  return state.k8sEvents
    .filter(e => e.involvedObjectKind === kind && e.involvedObjectName === name && e.namespace === namespace)
    .sort((a, b) => b.lastTimestamp - a.lastTimestamp);
}

// Shared depth-transparency cache position (reset by problem filter toggle)
export const _lastDepthCamPos = new THREE.Vector3(Infinity, Infinity, Infinity);
