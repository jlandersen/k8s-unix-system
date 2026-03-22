import { state, workloadKey, invalidateProblemCounts } from './state.js';
import { layoutNamespaces, ensureNamespace, addOrUpdatePod, removePod, removeNamespace } from './layout.js';
import { rebuildServiceLines, rebuildIngressLines, rebuildPVCLines } from './connections.js';
import { updateHUD } from './hud.js';
import { refreshMetricsOverlays } from './metrics-overlay.js';
import { invalidateSearchIndex } from './search.js';

const FLUSH_DELAY = 100;

const dirty = {
  layout: false,
  serviceLines: false,
  ingressLines: false,
  pvcLines: false,
  metrics: false,
  hud: false,
};
let flushTimer = 0;

function markDirty(...keys) {
  for (const k of keys) dirty[k] = true;
}

function flush() {
  flushTimer = 0;
  if (dirty.layout)       { dirty.layout = false;       layoutNamespaces(); }
  if (dirty.serviceLines)  { dirty.serviceLines = false;  rebuildServiceLines(); }
  if (dirty.ingressLines)  { dirty.ingressLines = false;  rebuildIngressLines(); }
  if (dirty.pvcLines)      { dirty.pvcLines = false;      rebuildPVCLines(); }
  if (dirty.metrics)       { dirty.metrics = false;       refreshMetricsOverlays(); }
  if (dirty.hud)           { dirty.hud = false;           updateHUD(); }
}

function scheduleFlush() {
  if (!flushTimer) flushTimer = setTimeout(flush, FLUSH_DELAY);
}

function flushNow() {
  if (flushTimer) { clearTimeout(flushTimer); flushTimer = 0; }
  flush();
}

export function connectWS() {
  const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
  const ws = new WebSocket(`${proto}//${location.host}/ws`);

  ws.onopen = () => {
    document.getElementById('loading').style.display = 'none';
  };

  ws.onmessage = (e) => {
    const event = JSON.parse(e.data);
    handleEvent(event);
  };

  ws.onclose = () => {
    document.getElementById('loading').style.display = 'block';
    document.getElementById('loading').textContent = 'RECONNECTING...';
    setTimeout(connectWS, 3000);
  };
}

function handleEvent(event) {
  if (event.type !== 'metrics_update') invalidateSearchIndex();
  switch (event.type) {
    case 'snapshot':
      for (const [name] of state.namespaces) removeNamespace(name);
      for (const ns of event.snapshot) {
        ensureNamespace(ns.name);
        for (const pod of ns.pods ?? []) {
          addOrUpdatePod(ns.name, pod);
        }
      }
      state.nodes.clear();
      for (const node of event.nodes ?? []) {
        state.nodes.set(node.name, node);
      }
      state.workloads.clear();
      for (const workload of event.workloads ?? []) {
        state.workloads.set(workloadKey(workload.namespace, workload.kind, workload.name), workload);
      }
      state.services = event.services ?? [];
      state.ingresses = event.ingresses ?? [];
      state.k8sEvents = event.k8sEvents ?? [];
      state.pvcs = event.pvcs ?? [];
      state.pvs = event.pvs ?? [];
      if (event.metricsAvailable) {
        state.metricsAvailable = true;
        state.nodeMetricsAvailable = event.nodeMetricsAvailable ?? false;
        state.podMetrics.clear();
        for (const m of event.podMetrics ?? [])
          state.podMetrics.set(`${m.namespace}/${m.name}`, m);
        state.nodeMetrics.clear();
        for (const m of event.nodeMetrics ?? [])
          state.nodeMetrics.set(m.name, m);
      }
      invalidateProblemCounts();
      markDirty('layout', 'serviceLines', 'ingressLines', 'pvcLines', 'metrics', 'hud');
      flushNow();
      break;

    case 'pod_added':
    case 'pod_modified':
      addOrUpdatePod(event.namespace, event.pod);
      invalidateProblemCounts();
      markDirty('layout', 'serviceLines', 'ingressLines', 'pvcLines', 'metrics', 'hud');
      scheduleFlush();
      break;

    case 'pod_deleted':
      removePod(event.namespace, event.pod.name);
      invalidateProblemCounts();
      markDirty('layout', 'serviceLines', 'ingressLines', 'pvcLines', 'metrics', 'hud');
      scheduleFlush();
      break;

    case 'ns_added':
      ensureNamespace(event.namespace);
      markDirty('layout', 'hud');
      scheduleFlush();
      break;

    case 'ns_deleted':
      removeNamespace(event.namespace);
      invalidateProblemCounts();
      markDirty('layout', 'serviceLines', 'ingressLines', 'pvcLines', 'hud');
      scheduleFlush();
      break;

    case 'node_updated':
      state.nodes.set(event.node.name, event.node);
      invalidateProblemCounts();
      markDirty('layout', 'metrics', 'hud');
      scheduleFlush();
      break;

    case 'node_deleted':
      state.nodes.delete(event.node.name);
      invalidateProblemCounts();
      markDirty('layout', 'metrics', 'hud');
      scheduleFlush();
      break;

    case 'svc_updated':
      if (event.service) {
        const idx = state.services.findIndex(s => s.name === event.service.name && s.namespace === event.service.namespace);
        if (idx >= 0) state.services[idx] = event.service;
        else state.services.push(event.service);
      }
      markDirty('serviceLines', 'ingressLines', 'hud');
      scheduleFlush();
      break;

    case 'svc_deleted':
      if (event.service) {
        state.services = state.services.filter(s => !(s.name === event.service.name && s.namespace === event.service.namespace));
      }
      markDirty('serviceLines', 'ingressLines', 'hud');
      scheduleFlush();
      break;

    case 'ingress_updated':
      if (event.ingress) {
        const idx = state.ingresses.findIndex(i => i.name === event.ingress.name && i.namespace === event.ingress.namespace);
        if (idx >= 0) state.ingresses[idx] = event.ingress;
        else state.ingresses.push(event.ingress);
      }
      markDirty('ingressLines', 'hud');
      scheduleFlush();
      break;

    case 'ingress_deleted':
      if (event.ingress) {
        state.ingresses = state.ingresses.filter(i => !(i.name === event.ingress.name && i.namespace === event.ingress.namespace));
      }
      markDirty('ingressLines', 'hud');
      scheduleFlush();
      break;

    case 'k8s_event_added':
      if (event.k8sEvent) {
        const idx = state.k8sEvents.findIndex(e => e.name === event.k8sEvent.name && e.namespace === event.k8sEvent.namespace);
        if (idx >= 0) state.k8sEvents[idx] = event.k8sEvent;
        else state.k8sEvents.push(event.k8sEvent);
      }
      invalidateProblemCounts();
      markDirty('hud');
      scheduleFlush();
      break;

    case 'k8s_event_deleted':
      if (event.k8sEvent) {
        state.k8sEvents = state.k8sEvents.filter(e => !(e.name === event.k8sEvent.name && e.namespace === event.k8sEvent.namespace));
      }
      invalidateProblemCounts();
      markDirty('hud');
      scheduleFlush();
      break;

    case 'pvc_updated':
      if (event.pvc) {
        const idx = state.pvcs.findIndex(p => p.name === event.pvc.name && p.namespace === event.pvc.namespace);
        if (idx >= 0) state.pvcs[idx] = event.pvc;
        else state.pvcs.push(event.pvc);
      }
      markDirty('pvcLines', 'hud');
      scheduleFlush();
      break;

    case 'pvc_deleted':
      if (event.pvc) {
        state.pvcs = state.pvcs.filter(p => !(p.name === event.pvc.name && p.namespace === event.pvc.namespace));
      }
      markDirty('pvcLines', 'hud');
      scheduleFlush();
      break;

    case 'pv_updated':
      if (event.pv) {
        const idx = state.pvs.findIndex(p => p.name === event.pv.name);
        if (idx >= 0) state.pvs[idx] = event.pv;
        else state.pvs.push(event.pv);
      }
      markDirty('pvcLines', 'hud');
      scheduleFlush();
      break;

    case 'pv_deleted':
      if (event.pv) {
        state.pvs = state.pvs.filter(p => p.name !== event.pv.name);
      }
      markDirty('pvcLines', 'hud');
      scheduleFlush();
      break;

    case 'workloads_snapshot':
      state.workloads.clear();
      for (const workload of event.workloads ?? []) {
        state.workloads.set(workloadKey(workload.namespace, workload.kind, workload.name), workload);
      }
      markDirty('layout', 'serviceLines', 'ingressLines', 'pvcLines', 'metrics', 'hud');
      scheduleFlush();
      break;

    case 'metrics_update':
      if (event.metricsAvailable) {
        state.metricsAvailable = true;
        state.nodeMetricsAvailable = event.nodeMetricsAvailable ?? false;
        state.podMetrics.clear();
        for (const m of event.podMetrics ?? [])
          state.podMetrics.set(`${m.namespace}/${m.name}`, m);
        state.nodeMetrics.clear();
        for (const m of event.nodeMetrics ?? [])
          state.nodeMetrics.set(m.name, m);
      } else {
        state.metricsAvailable = false;
        state.nodeMetricsAvailable = false;
        state.podMetrics.clear();
        state.nodeMetrics.clear();
      }
      invalidateProblemCounts();
      markDirty('metrics', 'hud');
      scheduleFlush();
      break;
  }
}
