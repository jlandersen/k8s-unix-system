import { state, workloadKey } from './state.js';
import { layoutNamespaces, ensureNamespace, addOrUpdatePod, removePod, removeNamespace } from './layout.js';
import { rebuildServiceLines, rebuildIngressLines, rebuildPVCLines } from './connections.js';
import { updateHUD } from './hud.js';

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
      layoutNamespaces();
      rebuildServiceLines();
      rebuildIngressLines();
      rebuildPVCLines();
      updateHUD();
      break;

    case 'pod_added':
    case 'pod_modified':
      addOrUpdatePod(event.namespace, event.pod);
      layoutNamespaces();
      rebuildServiceLines();
      rebuildIngressLines();
      rebuildPVCLines();
      updateHUD();
      break;

    case 'pod_deleted':
      removePod(event.namespace, event.pod.name);
      layoutNamespaces();
      rebuildServiceLines();
      rebuildIngressLines();
      rebuildPVCLines();
      updateHUD();
      break;

    case 'ns_added':
      ensureNamespace(event.namespace);
      layoutNamespaces();
      updateHUD();
      break;

    case 'ns_deleted':
      removeNamespace(event.namespace);
      layoutNamespaces();
      rebuildServiceLines();
      rebuildIngressLines();
      rebuildPVCLines();
      updateHUD();
      break;

    case 'node_updated':
      state.nodes.set(event.node.name, event.node);
      layoutNamespaces();
      updateHUD();
      break;

    case 'node_deleted':
      state.nodes.delete(event.node.name);
      layoutNamespaces();
      updateHUD();
      break;

    case 'svc_updated':
      if (event.service) {
        const idx = state.services.findIndex(s => s.name === event.service.name && s.namespace === event.service.namespace);
        if (idx >= 0) state.services[idx] = event.service;
        else state.services.push(event.service);
      }
      rebuildServiceLines();
      rebuildIngressLines();
      updateHUD();
      break;

    case 'svc_deleted':
      if (event.service) {
        state.services = state.services.filter(s => !(s.name === event.service.name && s.namespace === event.service.namespace));
      }
      rebuildServiceLines();
      rebuildIngressLines();
      updateHUD();
      break;

    case 'ingress_updated':
      if (event.ingress) {
        const idx = state.ingresses.findIndex(i => i.name === event.ingress.name && i.namespace === event.ingress.namespace);
        if (idx >= 0) state.ingresses[idx] = event.ingress;
        else state.ingresses.push(event.ingress);
      }
      rebuildIngressLines();
      updateHUD();
      break;

    case 'ingress_deleted':
      if (event.ingress) {
        state.ingresses = state.ingresses.filter(i => !(i.name === event.ingress.name && i.namespace === event.ingress.namespace));
      }
      rebuildIngressLines();
      updateHUD();
      break;

    case 'k8s_event_added':
      if (event.k8sEvent) {
        const idx = state.k8sEvents.findIndex(e => e.name === event.k8sEvent.name && e.namespace === event.k8sEvent.namespace);
        if (idx >= 0) state.k8sEvents[idx] = event.k8sEvent;
        else state.k8sEvents.push(event.k8sEvent);
      }
      updateHUD();
      break;

    case 'k8s_event_deleted':
      if (event.k8sEvent) {
        state.k8sEvents = state.k8sEvents.filter(e => !(e.name === event.k8sEvent.name && e.namespace === event.k8sEvent.namespace));
      }
      updateHUD();
      break;

    case 'pvc_updated':
      if (event.pvc) {
        const idx = state.pvcs.findIndex(p => p.name === event.pvc.name && p.namespace === event.pvc.namespace);
        if (idx >= 0) state.pvcs[idx] = event.pvc;
        else state.pvcs.push(event.pvc);
      }
      rebuildPVCLines();
      updateHUD();
      break;

    case 'pvc_deleted':
      if (event.pvc) {
        state.pvcs = state.pvcs.filter(p => !(p.name === event.pvc.name && p.namespace === event.pvc.namespace));
      }
      rebuildPVCLines();
      updateHUD();
      break;

    case 'pv_updated':
      if (event.pv) {
        const idx = state.pvs.findIndex(p => p.name === event.pv.name);
        if (idx >= 0) state.pvs[idx] = event.pv;
        else state.pvs.push(event.pv);
      }
      break;

    case 'pv_deleted':
      if (event.pv) {
        state.pvs = state.pvs.filter(p => p.name !== event.pv.name);
      }
      break;

    case 'workloads_snapshot':
      state.workloads.clear();
      for (const workload of event.workloads ?? []) {
        state.workloads.set(workloadKey(workload.namespace, workload.kind, workload.name), workload);
      }
      layoutNamespaces();
      rebuildServiceLines();
      rebuildIngressLines();
      rebuildPVCLines();
      updateHUD();
      break;
  }
}
