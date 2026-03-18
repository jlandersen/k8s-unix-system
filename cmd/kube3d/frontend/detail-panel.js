import { state, selection, statusColor, formatBytes, workloadKey, podWorkload, eventsForResource, relativeTime } from './state.js';
import { selectorMatchesLabels } from './connections.js';

const detailPanel = document.getElementById('detail-panel');
let detailPanelOpen = false;

function statusClass(status) {
  if (['Running', 'Ready', 'Succeeded'].includes(status)) return 'dp-status-ok';
  if (['Pending', 'ContainerCreating', 'PodInitializing'].includes(status)) return 'dp-status-warn';
  return 'dp-status-error';
}

function dpRow(label, value) {
  return `<div class="dp-row"><span class="dp-label">${label}</span><span class="dp-value">${value}</span></div>`;
}

function dpLabelsHTML(labels) {
  if (!labels || Object.keys(labels).length === 0) return '';
  const tags = Object.entries(labels)
    .map(([k, v]) => `<span class="dp-label-tag">${k}=${v}</span>`)
    .join('');
  return `<div class="dp-section"><div class="dp-section-title">Labels</div><div class="dp-labels-list">${tags}</div></div>`;
}

function eventsHTML(kind, name, namespace) {
  const events = eventsForResource(kind, name, namespace).slice(0, 20);
  if (events.length === 0) return '';
  const items = events.map(e => {
    const cls = e.type === 'Warning' ? 'dp-status-error' : 'dp-status-ok';
    const ago = relativeTime(e.lastTimestamp);
    return `<div class="dp-svc-item"><div class="dp-svc-name"><span class="${cls}">${e.type}</span> ${e.reason}</div><div class="dp-svc-detail">${e.message}${ago ? ` (${ago}` + (e.count > 1 ? `, x${e.count}` : '') + ')' : ''}</div></div>`;
  }).join('');
  return `<div class="dp-section"><div class="dp-section-title">Events</div>${items}</div>`;
}

function servicesForPod(pod) {
  return state.services.filter(svc =>
    svc.namespace === pod.namespace && selectorMatchesLabels(svc.selector, pod.labels)
  );
}

function ingressesForService(svcName, namespace) {
  return state.ingresses.filter(ing => {
    if (ing.namespace !== namespace) return false;
    if (ing.defaultBackend === svcName) return true;
    return ing.rules.some(r => r.paths.some(p => p.serviceName === svcName));
  });
}

export function showPodDetail(pod) {
  const owner = podWorkload(pod);
  const wKey = workloadKey(pod.namespace, owner.kind, owner.name);
  const wl = state.workloads.get(wKey);
  const svcs = servicesForPod(pod);

  let svcHTML = '';
  if (svcs.length > 0) {
    const items = svcs.map(s => {
      const ings = ingressesForService(s.name, s.namespace);
      const ingInfo = ings.length > 0 ? ` · ${ings.map(i => i.name).join(', ')}` : '';
      return `<div class="dp-svc-item"><div class="dp-svc-name">${s.name}</div><div class="dp-svc-detail">${s.type} · ${s.clusterIP || 'None'}${ingInfo}</div></div>`;
    }).join('');
    svcHTML = `<div class="dp-section"><div class="dp-section-title">Services</div>${items}</div>`;
  }

  let workloadHTML = '';
  if (wl) {
    workloadHTML = `<div class="dp-section"><div class="dp-section-title">Workload</div>`
      + dpRow('Kind', wl.kind)
      + dpRow('Name', wl.name)
      + dpRow('Replicas', `${wl.readyReplicas}/${wl.desiredReplicas} ready`)
      + (wl.availableReplicas !== undefined ? dpRow('Available', wl.availableReplicas) : '')
      + `</div>`;
  } else if (owner.kind !== 'Pod') {
    workloadHTML = `<div class="dp-section"><div class="dp-section-title">Owner</div>`
      + dpRow('Kind', owner.kind)
      + dpRow('Name', owner.name)
      + `</div>`;
  }

  detailPanel.innerHTML = `
    <div class="dp-header">
      <div class="dp-header-text">
        <div class="dp-kind">Pod</div>
        <div class="dp-name">${pod.name}</div>
      </div>
      <button class="dp-close" onclick="window._dpClose()">✕</button>
    </div>
    <div class="dp-section">
      <div class="dp-section-title">Status</div>
      ${dpRow('Status', `<span class="dp-status ${statusClass(pod.status)}">${pod.status}</span>`)}
      ${dpRow('Ready', pod.ready ? 'Yes' : 'No')}
      ${dpRow('Restarts', pod.restarts)}
      ${dpRow('Age', pod.age)}
    </div>
    <div class="dp-section">
      <div class="dp-section-title">Placement</div>
      ${dpRow('Namespace', pod.namespace)}
      ${dpRow('Node', pod.nodeName || '—')}
    </div>
    <div class="dp-section">
      <div class="dp-section-title">Resources</div>
      ${dpRow('CPU Request', pod.cpuRequest ? pod.cpuRequest + 'm' : '—')}
      ${dpRow('Memory Request', pod.memoryRequest ? formatBytes(pod.memoryRequest) : '—')}
    </div>
    ${workloadHTML}
    ${svcHTML}
    ${podVolumesHTML(pod)}
    ${podConfigRefsHTML(pod)}
    ${dpLabelsHTML(pod.labels)}
    ${eventsHTML('Pod', pod.name, pod.namespace)}
  `;
  openDetailPanel();
}

function podVolumesHTML(pod) {
  if (!pod.pvcNames || pod.pvcNames.length === 0) return '';
  const items = pod.pvcNames.map(name => {
    const pvc = state.pvcs.find(p => p.name === name && p.namespace === pod.namespace);
    const status = pvc ? pvc.status : 'Unknown';
    const statusCls = status === 'Bound' ? 'dp-status-ok' : status === 'Pending' ? 'dp-status-warn' : 'dp-status-error';
    const detail = pvc ? ` · ${pvc.requestedStorage || pvc.capacity || ''}${pvc.storageClassName ? ' · ' + pvc.storageClassName : ''}` : '';
    return `<div class="dp-svc-item"><div class="dp-svc-name">${name}</div><div class="dp-svc-detail"><span class="${statusCls}">${status}</span>${detail}</div></div>`;
  }).join('');
  return `<div class="dp-section"><div class="dp-section-title">Volumes</div>${items}</div>`;
}

function podConfigRefsHTML(pod) {
  let html = '';
  if (pod.configMapRefs && pod.configMapRefs.length > 0) {
    const items = pod.configMapRefs.map(name =>
      `<div class="dp-svc-item"><div class="dp-svc-name">${name}</div></div>`
    ).join('');
    html += `<div class="dp-section"><div class="dp-section-title">ConfigMaps</div>${items}</div>`;
  }
  if (pod.secretRefs && pod.secretRefs.length > 0) {
    const items = pod.secretRefs.map(name =>
      `<div class="dp-svc-item"><div class="dp-svc-name">${name}</div></div>`
    ).join('');
    html += `<div class="dp-section"><div class="dp-section-title">Secrets</div>${items}</div>`;
  }
  return html;
}

export function showNodeDetail(node) {
  const podsOnNode = [];
  for (const [, ns] of state.namespaces) {
    for (const [, podMesh] of ns.pods) {
      if (podMesh.userData.pod?.nodeName === node.name) {
        podsOnNode.push(podMesh.userData.pod);
      }
    }
  }

  let podsHTML = '';
  if (podsOnNode.length > 0) {
    const items = podsOnNode.slice(0, 30).map(p => {
      return `<div class="dp-svc-item"><div class="dp-svc-name">${p.name}</div><div class="dp-svc-detail">ns/${p.namespace} · <span class="${statusClass(p.status)}">${p.status}</span></div></div>`;
    }).join('');
    const more = podsOnNode.length > 30 ? `<div class="dp-svc-detail" style="padding:4px 0">… and ${podsOnNode.length - 30} more</div>` : '';
    podsHTML = `<div class="dp-section"><div class="dp-section-title">Pods (${podsOnNode.length})</div>${items}${more}</div>`;
  }

  detailPanel.innerHTML = `
    <div class="dp-header">
      <div class="dp-header-text">
        <div class="dp-kind">Node</div>
        <div class="dp-name">${node.name}</div>
      </div>
      <button class="dp-close" onclick="window._dpClose()">✕</button>
    </div>
    <div class="dp-section">
      <div class="dp-section-title">Status</div>
      ${dpRow('Status', `<span class="dp-status ${statusClass(node.status)}">${node.status}</span>`)}
    </div>
    <div class="dp-section">
      <div class="dp-section-title">Capacity</div>
      ${dpRow('CPU', node.cpuCapacity ? node.cpuCapacity + 'm' : '—')}
      ${dpRow('Memory', node.memoryCapacity ? formatBytes(node.memoryCapacity) : '—')}
    </div>
    ${podsHTML}
    ${eventsHTML('Node', node.name, '')}
  `;
  openDetailPanel();
}

export function showWorkloadDetail(wl) {
  const pods = [];
  const ns = state.namespaces.get(wl.namespace);
  if (ns) {
    for (const [, podMesh] of ns.pods) {
      const pod = podMesh.userData.pod;
      const owner = podWorkload(pod);
      if (owner.kind === wl.kind && owner.name === wl.name) {
        pods.push(pod);
      }
    }
  }

  let podsHTML = '';
  if (pods.length > 0) {
    const items = pods.map(p => {
      return `<div class="dp-svc-item"><div class="dp-svc-name">${p.name}</div><div class="dp-svc-detail"><span class="${statusClass(p.status)}">${p.status}</span> · Restarts: ${p.restarts}</div></div>`;
    }).join('');
    podsHTML = `<div class="dp-section"><div class="dp-section-title">Pods (${pods.length})</div>${items}</div>`;
  }

  const allCMs = [...new Set(pods.flatMap(p => p.configMapRefs || []))].sort();
  const allSecrets = [...new Set(pods.flatMap(p => p.secretRefs || []))].sort();
  let cmHTML = '';
  if (allCMs.length > 0) {
    const items = allCMs.map(name => `<div class="dp-svc-item"><div class="dp-svc-name">${name}</div></div>`).join('');
    cmHTML = `<div class="dp-section"><div class="dp-section-title">ConfigMaps</div>${items}</div>`;
  }
  let secretHTML = '';
  if (allSecrets.length > 0) {
    const items = allSecrets.map(name => `<div class="dp-svc-item"><div class="dp-svc-name">${name}</div></div>`).join('');
    secretHTML = `<div class="dp-section"><div class="dp-section-title">Secrets</div>${items}</div>`;
  }

  detailPanel.innerHTML = `
    <div class="dp-header">
      <div class="dp-header-text">
        <div class="dp-kind">${wl.kind}</div>
        <div class="dp-name">${wl.name}</div>
      </div>
      <button class="dp-close" onclick="window._dpClose()">✕</button>
    </div>
    <div class="dp-section">
      <div class="dp-section-title">Status</div>
      ${dpRow('Namespace', wl.namespace)}
      ${dpRow('Desired', wl.desiredReplicas)}
      ${dpRow('Ready', wl.readyReplicas)}
      ${wl.availableReplicas !== undefined ? dpRow('Available', wl.availableReplicas) : ''}
    </div>
    ${podsHTML}
    ${cmHTML}
    ${secretHTML}
    ${eventsHTML(wl.kind, wl.name, wl.namespace)}
  `;
  openDetailPanel();
}

export function showServiceDetail(svc) {
  const matchedPods = [];
  const ns = state.namespaces.get(svc.namespace);
  if (ns && svc.selector) {
    for (const [, podMesh] of ns.pods) {
      const pod = podMesh.userData.pod;
      if (selectorMatchesLabels(svc.selector, pod.labels)) {
        matchedPods.push(pod);
      }
    }
  }

  const ings = ingressesForService(svc.name, svc.namespace);
  let ingHTML = '';
  if (ings.length > 0) {
    const items = ings.map(i => {
      const rules = i.rules.flatMap(r => r.paths.map(p => `${r.host || '*'}${p.path} → ${p.serviceName}:${p.servicePort}`));
      return `<div class="dp-svc-item"><div class="dp-svc-name">${i.name}</div><div class="dp-svc-detail">${rules.join('<br>')}</div></div>`;
    }).join('');
    ingHTML = `<div class="dp-section"><div class="dp-section-title">Ingresses</div>${items}</div>`;
  }

  let podsHTML = '';
  if (matchedPods.length > 0) {
    const items = matchedPods.map(p => {
      return `<div class="dp-svc-item"><div class="dp-svc-name">${p.name}</div><div class="dp-svc-detail"><span class="${statusClass(p.status)}">${p.status}</span> · node/${p.nodeName || '—'}</div></div>`;
    }).join('');
    podsHTML = `<div class="dp-section"><div class="dp-section-title">Matched Pods (${matchedPods.length})</div>${items}</div>`;
  }

  let selectorHTML = '';
  if (svc.selector && Object.keys(svc.selector).length > 0) {
    const tags = Object.entries(svc.selector)
      .map(([k, v]) => `<span class="dp-label-tag">${k}=${v}</span>`)
      .join('');
    selectorHTML = `<div class="dp-section"><div class="dp-section-title">Selector</div><div class="dp-labels-list">${tags}</div></div>`;
  }

  detailPanel.innerHTML = `
    <div class="dp-header">
      <div class="dp-header-text">
        <div class="dp-kind">Service</div>
        <div class="dp-name">${svc.name}</div>
      </div>
      <button class="dp-close" onclick="window._dpClose()">✕</button>
    </div>
    <div class="dp-section">
      <div class="dp-section-title">Info</div>
      ${dpRow('Namespace', svc.namespace)}
      ${dpRow('Type', svc.type)}
      ${dpRow('Cluster IP', svc.clusterIP || 'None')}
    </div>
    ${selectorHTML}
    ${ingHTML}
    ${podsHTML}
  `;
  openDetailPanel();
}

export function showIngressDetail(ing) {
  let rulesHTML = '';
  if (ing.rules && ing.rules.length > 0) {
    const items = ing.rules.map(r => {
      const paths = r.paths.map(p =>
        `<div class="dp-ingress-path">${p.path || '/'} (${p.pathType}) → ${p.serviceName}:${p.servicePort}</div>`
      ).join('');
      return `<div class="dp-ingress-rule"><div class="dp-ingress-host">${r.host || '*'}</div>${paths}</div>`;
    }).join('');
    rulesHTML = `<div class="dp-section"><div class="dp-section-title">Rules</div>${items}</div>`;
  }

  detailPanel.innerHTML = `
    <div class="dp-header">
      <div class="dp-header-text">
        <div class="dp-kind">Ingress</div>
        <div class="dp-name">${ing.name}</div>
      </div>
      <button class="dp-close" onclick="window._dpClose()">✕</button>
    </div>
    <div class="dp-section">
      <div class="dp-section-title">Info</div>
      ${dpRow('Namespace', ing.namespace)}
      ${ing.ingressClassName ? dpRow('Class', ing.ingressClassName) : ''}
      ${ing.defaultBackend ? dpRow('Default Backend', ing.defaultBackend) : ''}
    </div>
    ${rulesHTML}
  `;
  openDetailPanel();
}

export function showPVCDetail(pvc) {
  const mountingPods = [];
  const ns = state.namespaces.get(pvc.namespace);
  if (ns) {
    for (const [, podMesh] of ns.pods) {
      const pod = podMesh.userData.pod;
      if (pod && pod.pvcNames && pod.pvcNames.includes(pvc.name)) {
        mountingPods.push(pod);
      }
    }
  }

  const pv = pvc.volumeName ? state.pvs.find(p => p.name === pvc.volumeName) : null;

  let pvHTML = '';
  if (pvc.volumeName) {
    pvHTML = `<div class="dp-section"><div class="dp-section-title">Bound Volume</div>`
      + dpRow('PV Name', pvc.volumeName)
      + (pv ? dpRow('PV Status', `<span class="dp-status ${statusClass(pv.status === 'Bound' ? 'Running' : 'Failed')}">${pv.status}</span>`) : '')
      + (pv ? dpRow('Reclaim Policy', pv.reclaimPolicy) : '')
      + `</div>`;
  }

  let podsHTML = '';
  if (mountingPods.length > 0) {
    const items = mountingPods.map(p =>
      `<div class="dp-svc-item"><div class="dp-svc-name">${p.name}</div><div class="dp-svc-detail"><span class="${statusClass(p.status)}">${p.status}</span> · Restarts: ${p.restarts}</div></div>`
    ).join('');
    podsHTML = `<div class="dp-section"><div class="dp-section-title">Mounted By (${mountingPods.length})</div>${items}</div>`;
  }

  const statusCls = pvc.status === 'Bound' ? 'dp-status-ok' : pvc.status === 'Pending' ? 'dp-status-warn' : 'dp-status-error';

  detailPanel.innerHTML = `
    <div class="dp-header">
      <div class="dp-header-text">
        <div class="dp-kind">PersistentVolumeClaim</div>
        <div class="dp-name">${pvc.name}</div>
      </div>
      <button class="dp-close" onclick="window._dpClose()">✕</button>
    </div>
    <div class="dp-section">
      <div class="dp-section-title">Status</div>
      ${dpRow('Status', `<span class="dp-status ${statusCls}">${pvc.status}</span>`)}
      ${dpRow('Namespace', pvc.namespace)}
    </div>
    <div class="dp-section">
      <div class="dp-section-title">Storage</div>
      ${pvc.requestedStorage ? dpRow('Requested', pvc.requestedStorage) : ''}
      ${pvc.capacity ? dpRow('Capacity', pvc.capacity) : ''}
      ${pvc.accessModes?.length ? dpRow('Access Modes', pvc.accessModes.join(', ')) : ''}
      ${pvc.storageClassName ? dpRow('Storage Class', pvc.storageClassName) : ''}
    </div>
    ${pvHTML}
    ${podsHTML}
    ${eventsHTML('PersistentVolumeClaim', pvc.name, pvc.namespace)}
  `;
  openDetailPanel();
}

export function showPVDetail(pv) {
  const statusCls = (pv.status === 'Bound' || pv.status === 'Available') ? 'dp-status-ok' : 'dp-status-error';

  let claimHTML = '';
  if (pv.claimRef) {
    claimHTML = `<div class="dp-section"><div class="dp-section-title">Claim</div>`
      + dpRow('Bound To', pv.claimRef)
      + `</div>`;
  }

  detailPanel.innerHTML = `
    <div class="dp-header">
      <div class="dp-header-text">
        <div class="dp-kind">PersistentVolume</div>
        <div class="dp-name">${pv.name}</div>
      </div>
      <button class="dp-close" onclick="window._dpClose()">✕</button>
    </div>
    <div class="dp-section">
      <div class="dp-section-title">Status</div>
      ${dpRow('Status', `<span class="dp-status ${statusCls}">${pv.status}</span>`)}
      ${pv.reclaimPolicy ? dpRow('Reclaim Policy', pv.reclaimPolicy) : ''}
    </div>
    <div class="dp-section">
      <div class="dp-section-title">Storage</div>
      ${pv.capacity ? dpRow('Capacity', pv.capacity) : ''}
      ${pv.accessModes?.length ? dpRow('Access Modes', pv.accessModes.join(', ')) : ''}
      ${pv.storageClassName ? dpRow('Storage Class', pv.storageClassName) : ''}
    </div>
    ${claimHTML}
    ${eventsHTML('PersistentVolume', pv.name, '')}
  `;
  openDetailPanel();
}

export function openDetailPanel() {
  detailPanelOpen = true;
  detailPanel.classList.add('open');
}

export function hideDetailPanel() {
  detailPanelOpen = false;
  detailPanel.classList.remove('open');
}

window._dpClose = function() {
  hideDetailPanel();
};

export function showDetailForSelection() {
  if (selection.phase === 'resource' && selection.resourceMesh) {
    const mesh = selection.resourceMesh;
    if (mesh.userData.type === 'pod') {
      showPodDetail(mesh.userData.pod);
    } else if (mesh.userData.type === 'nodeBlock') {
      showNodeDetail(mesh.userData.node);
    } else if (mesh.userData.type === 'ingress') {
      const ing = mesh.userData.ingress;
      if (ing) showIngressDetail(ing);
    } else if (mesh.userData.type === 'pvc') {
      const pvc = mesh.userData.pvc;
      if (pvc) showPVCDetail(pvc);
    }
  }
}
