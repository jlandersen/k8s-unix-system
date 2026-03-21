import { state, uiState, podWorkload, workloadKey } from './state.js';
import { eagleEye } from './scene.js';
import { startFlyTo, toggleEagleEye, flyTo } from './camera-controller.js';
import { showWorkloadDetail, showServiceDetail, showIngressDetail, showPodDetail, showNodeDetail, showPVCDetail, showPVDetail } from './detail-panel.js';

// ── DOM Elements ───────────────────────────────────────────────
const searchOverlay = document.getElementById('search-overlay');
const searchInput = document.getElementById('search-input');
const searchResultsEl = document.getElementById('search-results');
const searchHintEl = document.getElementById('search-hint');
const searchCompletionsEl = document.getElementById('search-completions');
const searchGhostEl = document.getElementById('search-ghost');

// ── Search State ───────────────────────────────────────────────
let searchSelectedIdx = -1;
let searchItems = [];
let searchLastMatches = [];
let searchIndexDirty = true;

// ── Autocomplete State ─────────────────────────────────────────
let acItems = [];
let acSelectedIdx = -1;
let acActive = false;

// ── Search Index ───────────────────────────────────────────────
function buildSearchIndex() {
  const items = [];

  for (const [nsName, ns] of state.namespaces) {
    items.push({ kind: 'namespace', name: nsName, detail: `${ns.pods.size} pods`, ns: nsName, labels: {}, nodeName: '' });

    for (const [podName, podMesh] of ns.pods) {
      const pod = podMesh.userData.pod;
      const owner = podWorkload(pod);
      items.push({
        kind: 'pod', name: podName, detail: `ns/${nsName} · ${owner.kind}/${owner.name}`,
        status: pod.status, ns: nsName, mesh: podMesh,
        labels: pod.labels || {}, nodeName: pod.nodeName || '',
        searchText: `${podName} ${nsName} ${pod.status} ${pod.nodeName || ''} ${owner.kind}/${owner.name} ${labelStr(pod.labels)}`,
      });
    }
  }

  for (const [key, wl] of state.workloads) {
    items.push({
      kind: 'workload', name: `${wl.kind}/${wl.name}`, detail: `ns/${wl.namespace} · ${wl.readyReplicas}/${wl.desiredReplicas} ready`,
      ns: wl.namespace, workload: wl, labels: {}, nodeName: '',
      searchText: `${wl.name} ${wl.kind} ${wl.namespace}`,
    });
  }

  for (const [nodeName] of state.nodes) {
    const block = state.nodeIsland?.blocks.get(nodeName);
    const node = block?.userData.node;
    items.push({
      kind: 'node', name: nodeName, detail: node ? `${node.status}` : '',
      status: node?.status === 'Ready' ? 'Running' : 'Failed',
      ns: '__nodes__', mesh: block || null, labels: {}, nodeName: nodeName,
      searchText: `${nodeName} node`,
    });
  }

  for (const svc of state.services) {
    items.push({
      kind: 'service', name: svc.name, detail: `ns/${svc.namespace} · ${svc.type}`,
      ns: svc.namespace, labels: {}, nodeName: '',
      searchText: `${svc.name} ${svc.namespace} ${svc.type}`,
    });
  }

  for (const ing of state.ingresses) {
    items.push({
      kind: 'ingress', name: ing.name, detail: `ns/${ing.namespace}`,
      ns: ing.namespace, labels: {}, nodeName: '',
      searchText: `${ing.name} ${ing.namespace}`,
    });
  }

  for (const pvc of state.pvcs) {
    items.push({
      kind: 'pvc', name: pvc.name, detail: `ns/${pvc.namespace} · ${pvc.status}`,
      status: pvc.status === 'Bound' ? 'Running' : pvc.status === 'Pending' ? 'Pending' : 'Failed',
      ns: pvc.namespace, labels: {}, nodeName: '',
      pvc: pvc,
      searchText: `${pvc.name} ${pvc.namespace} ${pvc.storageClassName || ''} ${pvc.volumeName || ''}`,
    });
  }

  for (const pv of state.pvs) {
    items.push({
      kind: 'pv', name: pv.name, detail: `${pv.status} · ${pv.capacity || ''}`,
      status: (pv.status === 'Bound' || pv.status === 'Available') ? 'Running' : 'Failed',
      ns: '', labels: {}, nodeName: '',
      pv: pv,
      searchText: `${pv.name} ${pv.storageClassName || ''} ${pv.claimRef || ''}`,
    });
  }

  for (const evt of state.k8sEvents) {
    items.push({
      kind: 'event', name: evt.reason,
      detail: `${evt.involvedObjectKind}/${evt.involvedObjectName} · ns/${evt.namespace}`,
      status: evt.type === 'Warning' ? 'Failed' : 'Running',
      ns: evt.namespace, labels: {}, nodeName: '',
      k8sEvent: evt,
      searchText: `${evt.reason} ${evt.message} ${evt.involvedObjectName} ${evt.namespace}`,
    });
  }

  for (const item of items) {
    if (!item.searchText) item.searchText = `${item.name} ${item.detail}`;
    item.searchText = item.searchText.toLowerCase();
  }

  return items;
}

function labelStr(labels) {
  if (!labels) return '';
  return Object.entries(labels).map(([k, v]) => `${k}=${v}`).join(' ');
}

function statusColorCSS(status) {
  if (!status) return '';
  if (status === 'Running' || status === 'Ready') return '#00ff88';
  if (['Pending', 'ContainerCreating', 'PodInitializing'].includes(status)) return '#ffcc00';
  return '#ff4444';
}

export function invalidateSearchIndex() {
  searchIndexDirty = true;
}

// ── Open / Close ───────────────────────────────────────────────
export function openSearch(prefix = '') {
  if (uiState.searchOpen) return;
  uiState.searchOpen = true;
  searchOverlay.classList.add('active');
  searchInput.value = prefix;
  searchResultsEl.innerHTML = '';
  searchSelectedIdx = -1;
  searchLastMatches = [];
  if (searchIndexDirty) {
    searchItems = buildSearchIndex();
    searchIndexDirty = false;
  }
  searchInput.focus();
  if (uiState.pointerLocked) document.exitPointerLock();
  renderCompletions();
  renderSearchResults(prefix);
}

export function closeSearch() {
  if (!uiState.searchOpen) return;
  uiState.searchOpen = false;
  searchOverlay.classList.remove('active');
  searchHintEl.classList.remove('active');
  hideCompletions();
  searchInput.blur();
}

// ── Query Parsing ──────────────────────────────────────────────
const KIND_ALIASES = {
  po: 'pod', pods: 'pod', pod: 'pod',
  deploy: 'workload', deployment: 'workload', deployments: 'workload',
  ds: 'workload', daemonset: 'workload', daemonsets: 'workload',
  sts: 'workload', statefulset: 'workload', statefulsets: 'workload',
  rs: 'workload', replicaset: 'workload', replicasets: 'workload',
  workload: 'workload', workloads: 'workload',
  svc: 'service', service: 'service', services: 'service',
  ing: 'ingress', ingress: 'ingress', ingresses: 'ingress',
  no: 'node', node: 'node', nodes: 'node',
  ns: 'namespace', namespace: 'namespace', namespaces: 'namespace',
  ev: 'event', event: 'event', events: 'event',
  pvc: 'pvc', pvcs: 'pvc', persistentvolumeclaim: 'pvc', persistentvolumeclaims: 'pvc',
  pv: 'pv', pvs: 'pv', persistentvolume: 'pv', persistentvolumes: 'pv',
};

function parseSearchQuery(raw) {
  const filters = { kind: null, ns: null, status: null, node: null, labels: [], regex: null, freeTokens: [] };
  const tokens = raw.trim().split(/\s+/).filter(Boolean);
  let expectLabel = false;

  for (const tok of tokens) {
    const lower = tok.toLowerCase();

    if (expectLabel) {
      filters.labels.push(tok);
      expectLabel = false;
      continue;
    }

    const regexMatch = tok.match(/^\/(.+)\/([gimsuy]*)$/);
    if (regexMatch) {
      try { filters.regex = new RegExp(regexMatch[1], regexMatch[2] || 'i'); } catch {}
      continue;
    }

    if (lower.startsWith('kind:') || lower.startsWith('type:')) {
      const val = lower.split(':')[1];
      if (val && KIND_ALIASES[val]) filters.kind = KIND_ALIASES[val];
      else if (val) filters.kind = val;
      continue;
    }
    if (lower.startsWith('ns:') || lower.startsWith('namespace:')) {
      filters.ns = lower.split(':').slice(1).join(':');
      continue;
    }
    if (lower.startsWith('status:')) {
      filters.status = lower.split(':')[1];
      continue;
    }
    if (lower.startsWith('node:')) {
      filters.node = lower.split(':')[1];
      continue;
    }
    if (lower === '-l') {
      expectLabel = true;
      continue;
    }
    if (lower.startsWith('-l') && lower.length > 2) {
      filters.labels.push(tok.slice(2));
      continue;
    }

    filters.freeTokens.push(lower);
  }

  return filters;
}

function fuzzyMatch(text, pattern) {
  let ti = 0, pi = 0, score = 0, consecutive = 0;
  while (ti < text.length && pi < pattern.length) {
    if (text[ti] === pattern[pi]) {
      score += 1 + consecutive;
      consecutive++;
      pi++;
    } else {
      consecutive = 0;
    }
    ti++;
  }
  return pi === pattern.length ? score : 0;
}

function matchesLabel(itemLabels, selector) {
  const parts = selector.split(',');
  return parts.every(part => {
    const [k, v] = part.split('=');
    if (!k) return true;
    if (v === undefined) return k in itemLabels;
    return itemLabels[k] === v;
  });
}

function filterAndScore(items, filters) {
  const results = [];

  for (const item of items) {
    if (filters.kind && item.kind !== filters.kind) continue;
    if (filters.ns && item.ns.toLowerCase() !== filters.ns) continue;
    if (filters.status && !(item.status || '').toLowerCase().includes(filters.status)) continue;
    if (filters.node && !(item.nodeName || '').toLowerCase().includes(filters.node)) continue;
    if (filters.labels.length > 0 && !filters.labels.every(sel => matchesLabel(item.labels || {}, sel))) continue;
    if (filters.regex && !filters.regex.test(item.name) && !filters.regex.test(item.searchText)) continue;

    let score = 0;
    let matched = true;
    for (const tok of filters.freeTokens) {
      if (item.searchText.includes(tok)) {
        score += 10 + (item.name.toLowerCase().includes(tok) ? 5 : 0);
      } else {
        const fs = fuzzyMatch(item.searchText, tok);
        if (fs > 0) {
          score += fs;
        } else {
          matched = false;
          break;
        }
      }
    }
    if (!matched) continue;

    if (item.name.toLowerCase().startsWith(filters.freeTokens[0] || '')) score += 20;

    results.push({ item, score });
  }

  results.sort((a, b) => b.score - a.score);
  return results;
}

// ── Results Rendering ──────────────────────────────────────────
function renderSearchResults(query) {
  searchResultsEl.innerHTML = '';
  searchSelectedIdx = -1;
  searchLastMatches = [];

  const raw = query.trim();
  if (!raw) {
    searchHintEl.classList.add('active');
    searchHintEl.innerHTML = [
      '<kbd>kind:pod</kbd> <kbd>ns:default</kbd> <kbd>status:running</kbd> <kbd>node:worker-1</kbd>',
      '<kbd>-l app=nginx</kbd> <kbd>/regex/</kbd> &middot; Fuzzy matching enabled',
    ].join('<br>');
    return;
  }
  searchHintEl.classList.remove('active');

  const filters = parseSearchQuery(raw);
  const scored = filterAndScore(searchItems, filters);
  searchLastMatches = scored.map(s => s.item);

  const limited = scored.slice(0, 50);
  for (let i = 0; i < limited.length; i++) {
    const item = limited[i].item;
    const div = document.createElement('div');
    div.className = 'search-result';
    div.dataset.index = i;

    let statusHtml = '';
    if (item.status) {
      const c = statusColorCSS(item.status);
      statusHtml = `<span class="sr-status" style="color:${c}">● ${item.status}</span>`;
    }

    div.innerHTML = `<span class="sr-kind">${item.kind}</span><span class="sr-name">${escapeHtml(item.name)}</span>${statusHtml}<span class="sr-detail">${escapeHtml(item.detail)}</span>`;
    div.addEventListener('click', () => selectSearchResult(item));
    searchResultsEl.appendChild(div);
  }

  if (limited.length > 0) {
    searchSelectedIdx = 0;
    searchResultsEl.children[0].classList.add('selected');
  }
}

function escapeHtml(str) {
  return str.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function moveSearchSelection(dir) {
  const items = searchResultsEl.children;
  if (items.length === 0) return;

  if (searchSelectedIdx >= 0 && searchSelectedIdx < items.length) {
    items[searchSelectedIdx].classList.remove('selected');
  }

  searchSelectedIdx = Math.max(0, Math.min(items.length - 1, searchSelectedIdx + dir));
  items[searchSelectedIdx].classList.add('selected');
  items[searchSelectedIdx].scrollIntoView({ block: 'nearest' });
}

function confirmSearchSelection() {
  const items = searchResultsEl.children;
  if (searchSelectedIdx < 0 || searchSelectedIdx >= items.length) return;
  const item = searchLastMatches[searchSelectedIdx];
  if (item) selectSearchResult(item);
}

function selectSearchResult(item) {
  closeSearch();

  if (eagleEye.active) toggleEagleEye();

  if (item.mesh) {
    const resNs = item.ns;
    flyTo.targetResource = item.mesh;
    startFlyTo(resNs);
  } else if (item.kind === 'workload') {
    const ns = state.namespaces.get(item.ns);
    if (ns) {
      let firstPod = null;
      for (const [, podMesh] of ns.pods) {
        const pod = podMesh.userData.pod;
        const owner = podWorkload(pod);
        if (owner.name === item.workload.name && owner.kind === item.workload.kind) {
          firstPod = podMesh;
          break;
        }
      }
      if (firstPod) {
        flyTo.targetResource = firstPod;
        startFlyTo(item.ns);
      } else {
        startFlyTo(item.ns);
      }
      showWorkloadDetail(item.workload);
    }
  } else if (item.kind === 'service') {
    startFlyTo(item.ns);
    flyTo.targetNs = null;
    const svc = state.services.find(s => s.name === item.name && s.namespace === item.ns);
    if (svc) showServiceDetail(svc);
  } else if (item.kind === 'event' && item.k8sEvent) {
    const evt = item.k8sEvent;
    if (evt.involvedObjectKind === 'Pod') {
      const ns = state.namespaces.get(evt.namespace);
      if (ns) {
        const podMesh = ns.pods.get(evt.involvedObjectName);
        if (podMesh) {
          flyTo.targetResource = podMesh;
          startFlyTo(evt.namespace);
          showPodDetail(podMesh.userData.pod);
          return;
        }
      }
    } else if (evt.involvedObjectKind === 'Node') {
      const nodeBlock = state.nodeIsland?.blocks.get(evt.involvedObjectName);
      if (nodeBlock) {
        flyTo.targetResource = nodeBlock;
        startFlyTo('__nodes__');
        showNodeDetail(nodeBlock.userData.node);
        return;
      }
    }
    startFlyTo(evt.namespace || '__nodes__');
  } else if (item.kind === 'ingress') {
    const ing = state.ingresses.find(i => i.name === item.name && i.namespace === item.ns);
    if (ing) {
      let marker = null;
      if (state.ingressLines) {
        state.ingressLines.traverse(child => {
          if (child.userData.type === 'ingress' && child.userData.ingress === ing) marker = child;
        });
      }
      if (marker) flyTo.targetResource = marker;
      startFlyTo(item.ns);
      showIngressDetail(ing);
    } else {
      startFlyTo(item.ns);
    }
  } else if (item.kind === 'pvc' && item.pvc) {
    const pvc = item.pvc;
    let marker = null;
    if (state.pvcLines) {
      state.pvcLines.traverse(child => {
        if (child.userData.type === 'pvc' && child.userData.pvc === pvc) marker = child;
      });
    }
    if (marker) flyTo.targetResource = marker;
    startFlyTo(item.ns);
    showPVCDetail(pvc);
  } else if (item.kind === 'pv' && item.pv) {
    showPVDetail(item.pv);
  } else {
    startFlyTo(item.ns);
  }
}

// ── Autocomplete ───────────────────────────────────────────────
const FILTER_PREFIXES = ['kind:', 'ns:', 'status:', 'node:', '-l', 'type:', 'namespace:'];
const KIND_COMPLETIONS = [
  { value: 'pod', label: 'Pods' },
  { value: 'deploy', label: 'Deployments' },
  { value: 'daemonset', label: 'DaemonSets' },
  { value: 'statefulset', label: 'StatefulSets' },
  { value: 'replicaset', label: 'ReplicaSets' },
  { value: 'service', label: 'Services' },
  { value: 'ingress', label: 'Ingresses' },
  { value: 'node', label: 'Nodes' },
  { value: 'namespace', label: 'Namespaces' },
  { value: 'event', label: 'Events' },
  { value: 'pvc', label: 'PersistentVolumeClaims' },
  { value: 'pv', label: 'PersistentVolumes' },
];

function getCompletionContext(text, cursorPos) {
  const before = text.slice(0, cursorPos);
  const lastSpace = before.lastIndexOf(' ');
  const currentToken = before.slice(lastSpace + 1);

  if (!currentToken) return null;

  const lower = currentToken.toLowerCase();

  for (const fp of FILTER_PREFIXES) {
    if (fp.startsWith(lower) && lower !== fp && lower.length >= 2) {
      return { type: 'prefix', partial: lower, prefix: before.slice(0, lastSpace + 1) };
    }
  }

  if (lower.startsWith('kind:') || lower.startsWith('type:')) {
    const val = lower.split(':')[1];
    return { type: 'kind', partial: val, prefix: before.slice(0, lastSpace + 1), tokenPrefix: currentToken.split(':')[0] + ':' };
  }
  if (lower.startsWith('ns:') || lower.startsWith('namespace:')) {
    const val = lower.split(':').slice(1).join(':');
    return { type: 'ns', partial: val, prefix: before.slice(0, lastSpace + 1), tokenPrefix: currentToken.split(':')[0] + ':' };
  }
  if (lower.startsWith('status:')) {
    const val = lower.split(':')[1];
    return { type: 'status', partial: val, prefix: before.slice(0, lastSpace + 1), tokenPrefix: 'status:' };
  }
  if (lower.startsWith('node:')) {
    const val = lower.split(':')[1];
    return { type: 'node', partial: val, prefix: before.slice(0, lastSpace + 1), tokenPrefix: 'node:' };
  }
  if (lower === '-l' || (lower.startsWith('-l') && lower.length >= 2)) {
    const val = lower.length > 2 ? currentToken.slice(2) : '';
    return { type: 'label', partial: val, prefix: before.slice(0, lastSpace + 1), tokenPrefix: '-l' };
  }

  return null;
}

function buildCompletions(ctx) {
  if (!ctx) return [];

  if (ctx.type === 'prefix') {
    const candidates = FILTER_PREFIXES.filter(fp => fp !== 'type:' && fp !== 'namespace:');
    if (!ctx.partial) return candidates.map(fp => ({ value: fp, label: '', insertText: fp }));
    return candidates
      .filter(fp => fp.startsWith(ctx.partial))
      .map(fp => ({ value: fp, label: '', insertText: fp }));
  }

  if (ctx.type === 'kind') {
    return KIND_COMPLETIONS
      .filter(k => !ctx.partial || k.value.startsWith(ctx.partial))
      .map(k => ({ value: k.value, label: k.label, insertText: ctx.tokenPrefix + k.value }));
  }

  if (ctx.type === 'ns') {
    const namespaces = [...state.namespaces.keys()].sort();
    return namespaces
      .filter(ns => !ctx.partial || ns.toLowerCase().startsWith(ctx.partial))
      .map(ns => ({ value: ns, label: '', insertText: ctx.tokenPrefix + ns }));
  }

  if (ctx.type === 'status') {
    const statuses = ['Running', 'Pending', 'Failed', 'ContainerCreating', 'CrashLoopBackOff', 'Ready'];
    return statuses
      .filter(s => !ctx.partial || s.toLowerCase().startsWith(ctx.partial))
      .map(s => ({ value: s, label: '', insertText: ctx.tokenPrefix + s.toLowerCase() }));
  }

  if (ctx.type === 'node') {
    const nodes = [...state.nodes.keys()].sort();
    return nodes
      .filter(n => !ctx.partial || n.toLowerCase().startsWith(ctx.partial))
      .map(n => ({ value: n, label: '', insertText: ctx.tokenPrefix + n }));
  }

  if (ctx.type === 'label') {
    const labelKeys = new Set();
    for (const item of searchItems) {
      if (item.labels) {
        for (const k of Object.keys(item.labels)) {
          labelKeys.add(k);
        }
      }
    }
    const keys = [...labelKeys].sort();
    if (!ctx.partial) {
      return keys.map(k => ({ value: k + '=', label: '', insertText: ctx.tokenPrefix + k + '=' }));
    }
    if (ctx.partial.includes('=')) {
      const [lk, lv] = ctx.partial.split('=');
      const vals = new Set();
      for (const item of searchItems) {
        if (item.labels && item.labels[lk]) vals.add(item.labels[lk]);
      }
      return [...vals].sort()
        .filter(v => !lv || v.toLowerCase().startsWith(lv.toLowerCase()))
        .map(v => ({ value: lk + '=' + v, label: '', insertText: ctx.tokenPrefix + lk + '=' + v }));
    }
    return keys
      .filter(k => k.toLowerCase().startsWith(ctx.partial.toLowerCase()))
      .map(k => ({ value: k + '=', label: '', insertText: ctx.tokenPrefix + k + '=' }));
  }

  return [];
}

function renderCompletions() {
  const text = searchInput.value;
  const cursor = searchInput.selectionStart;
  const ctx = getCompletionContext(text, cursor);
  const completions = buildCompletions(ctx);

  acItems = completions;
  acSelectedIdx = completions.length > 0 ? 0 : -1;

  const currentToken = text.slice(text.lastIndexOf(' ') + 1);
  const exactMatch = completions.length === 1 && completions[0].insertText === currentToken;
  if (completions.length === 0 || exactMatch) {
    hideCompletions();
    return;
  }

  acActive = true;
  searchCompletionsEl.innerHTML = '';
  searchCompletionsEl.classList.add('active');

  for (let i = 0; i < completions.length; i++) {
    const c = completions[i];
    const div = document.createElement('div');
    div.className = 'sc-item' + (i === 0 ? ' selected' : '');
    div.innerHTML = `<span class="sc-value">${escapeHtml(c.value)}</span>${c.label ? `<span class="sc-label">${escapeHtml(c.label)}</span>` : ''}`;
    div.addEventListener('click', () => acceptCompletion(i));
    searchCompletionsEl.appendChild(div);
  }

  updateGhostText();
}

function hideCompletions() {
  acActive = false;
  acItems = [];
  acSelectedIdx = -1;
  searchCompletionsEl.classList.remove('active');
  searchCompletionsEl.innerHTML = '';
  searchGhostEl.textContent = '';
}

function updateGhostText() {
  if (acSelectedIdx < 0 || acSelectedIdx >= acItems.length) {
    searchGhostEl.textContent = '';
    return;
  }
  const c = acItems[acSelectedIdx];
  const text = searchInput.value;
  const lastSpace = text.lastIndexOf(' ');
  const prefix = text.slice(0, lastSpace + 1);
  const full = prefix + c.insertText;
  if (full.toLowerCase().startsWith(text.toLowerCase()) && full.length > text.length) {
    searchGhostEl.textContent = text + full.slice(text.length);
  } else {
    searchGhostEl.textContent = '';
  }
}

function moveCompletionSelection(dir) {
  if (acItems.length === 0) return;
  const items = searchCompletionsEl.children;
  if (acSelectedIdx >= 0 && acSelectedIdx < items.length) {
    items[acSelectedIdx].classList.remove('selected');
  }
  acSelectedIdx = ((acSelectedIdx + dir) % acItems.length + acItems.length) % acItems.length;
  items[acSelectedIdx].classList.add('selected');
  items[acSelectedIdx].scrollIntoView({ block: 'nearest' });
  updateGhostText();
}

function acceptCompletion(idx) {
  if (idx === undefined) idx = acSelectedIdx;
  if (idx < 0 || idx >= acItems.length) return;
  const c = acItems[idx];
  const text = searchInput.value;
  const lastSpace = text.lastIndexOf(' ');
  const prefix = text.slice(0, lastSpace + 1);
  const needsSpace = !c.insertText.endsWith(':') && !c.insertText.endsWith('=');
  searchInput.value = prefix + c.insertText + (needsSpace ? ' ' : '');
  hideCompletions();
  renderSearchResults(searchInput.value);
  searchInput.focus();
}

// ── Event Listeners ────────────────────────────────────────────
searchInput.addEventListener('input', () => {
  renderCompletions();
  renderSearchResults(searchInput.value);
});

searchInput.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') {
    if (acActive) { hideCompletions(); e.preventDefault(); return; }
    closeSearch(); e.preventDefault(); return;
  }

  if (acActive) {
    if (e.key === 'Tab') {
      acceptCompletion();
      e.preventDefault();
      return;
    }
    if (e.key === 'ArrowRight' && searchInput.selectionStart === searchInput.value.length) {
      acceptCompletion();
      e.preventDefault();
      return;
    }
    if (e.key === 'ArrowDown') { moveCompletionSelection(1); e.preventDefault(); return; }
    if (e.key === 'ArrowUp') { moveCompletionSelection(-1); e.preventDefault(); return; }
    if (e.key === 'Enter') {
      acceptCompletion();
      e.preventDefault();
      return;
    }
  }

  if (e.key === 'ArrowDown') { moveSearchSelection(1); e.preventDefault(); return; }
  if (e.key === 'ArrowUp') { moveSearchSelection(-1); e.preventDefault(); return; }
  if (e.key === 'Enter') { confirmSearchSelection(); e.preventDefault(); return; }
});

searchOverlay.addEventListener('click', (e) => {
  if (e.target === searchOverlay) closeSearch();
});
