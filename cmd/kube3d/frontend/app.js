import * as THREE from 'three';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/addons/postprocessing/UnrealBloomPass.js';

// ── State ──────────────────────────────────────────────────────
const state = {
  namespaces: new Map(), // name -> { group, platform, pods: Map<name, mesh>, label }
  nodes: new Map(),      // name -> NodeInfo
  nodeIsland: null,      // { group, platform, blocks: Map<name, mesh>, label }
  workloads: new Map(),  // key namespace/kind/name -> WorkloadInfo
  services: [],          // [{name, namespace, type, clusterIP, selector}]
  serviceLines: null,    // THREE.Group holding connection lines
  ingresses: [],         // [{name, namespace, ingressClassName, rules, defaultBackend}]
  ingressLines: null,    // THREE.Group holding ingress->service arcs
};

// ── Problem Filters ────────────────────────────────────────────
const problemFilter = { active: null }; // null or 'unhealthy' | 'crashloop' | 'unscheduled'

const HEALTHY_STATUSES = new Set(['Running', 'Succeeded']);
const CRASHLOOP_STATUSES = new Set(['CrashLoopBackOff', 'ImagePullBackOff']);

function podMatchesFilter(pod, filter) {
  switch (filter) {
    case 'unhealthy':
      return !HEALTHY_STATUSES.has(pod.status);
    case 'crashloop':
      return CRASHLOOP_STATUSES.has(pod.status) || pod.restarts > 0;
    case 'unscheduled':
      return pod.status === 'Pending' || !pod.ready;
    default:
      return true;
  }
}

function nodeMatchesFilter(node, filter) {
  if (filter === 'unhealthy') return node.status !== 'Ready';
  return false;
}

function countProblems() {
  const counts = { unhealthy: 0, crashloop: 0, unscheduled: 0 };
  for (const [, ns] of state.namespaces) {
    for (const [, mesh] of ns.pods) {
      const pod = mesh.userData.pod;
      if (!pod) continue;
      if (!HEALTHY_STATUSES.has(pod.status)) counts.unhealthy++;
      if (CRASHLOOP_STATUSES.has(pod.status) || pod.restarts > 0) counts.crashloop++;
      if (pod.status === 'Pending' || !pod.ready) counts.unscheduled++;
    }
  }
  return counts;
}

function updateProblemFilterUI() {
  const counts = countProblems();
  for (const btn of document.querySelectorAll('.pf-btn')) {
    const filter = btn.dataset.filter;
    const countEl = btn.querySelector('.pf-count');
    const c = counts[filter] || 0;
    countEl.textContent = c > 0 ? `(${c})` : '';
    btn.classList.toggle('active', problemFilter.active === filter);
  }
}

function toggleProblemFilter(filter) {
  problemFilter.active = problemFilter.active === filter ? null : filter;
  updateProblemFilterUI();
  _lastDepthCamPos.set(Infinity, Infinity, Infinity); // force opacity recalc
}

document.querySelectorAll('.pf-btn').forEach(btn => {
  btn.addEventListener('click', () => toggleProblemFilter(btn.dataset.filter));
});

let searchOpen = false;
let searchSelectedIdx = -1;
let searchItems = [];
let searchLastMatches = [];

const PLATFORM_GAP = 12;
const POD_BASE_SIZE = 0.7;
const POD_MIN_SIZE = 0.5;
const POD_MAX_SIZE = 1.8;
const POD_GAP = 1.5;
const POD_STRIDE = POD_MAX_SIZE + POD_GAP;
const WORKLOAD_GAP = 2.2;
const PLATFORM_Y = 0;
const PLATFORM_HEIGHT = 0.3;
const LABEL_Y_OFFSET = 0.5;
const NODE_BLOCK_SIZE = 1.2;

const STATUS_COLORS = {
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

function statusColor(status) {
  return STATUS_COLORS[status] ?? 0x00ff88;
}

function formatBytes(bytes) {
  if (bytes < 1024) return bytes + 'B';
  if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(0) + 'Ki';
  if (bytes < 1024 * 1024 * 1024) return (bytes / (1024 * 1024)).toFixed(0) + 'Mi';
  return (bytes / (1024 * 1024 * 1024)).toFixed(1) + 'Gi';
}

function workloadKey(namespace, kind, name) {
  return `${namespace}/${kind}/${name}`;
}

function podWorkload(pod) {
  if (pod.ownerKind && pod.ownerName) {
    return { kind: pod.ownerKind, name: pod.ownerName };
  }
  return { kind: 'Pod', name: pod.name };
}

// ── Scene Setup ────────────────────────────────────────────────
const canvas = document.getElementById('canvas');
const renderer = new THREE.WebGLRenderer({ canvas, antialias: true });
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 1.5));
renderer.setSize(window.innerWidth, window.innerHeight);
renderer.setClearColor(0x020202);
renderer.localClippingEnabled = true;

const scene = new THREE.Scene();
scene.fog = new THREE.FogExp2(0x020202, 0.012);

const camera = new THREE.PerspectiveCamera(70, window.innerWidth / window.innerHeight, 0.1, 500);
camera.position.set(0, 12, 25);
camera.lookAt(0, 0, 0);

// Eagle Eye: overhead orthographic camera
const ORTHO_DEFAULT_ZOOM = 60;
const orthoCamera = (() => {
  const aspect = window.innerWidth / window.innerHeight;
  const half = ORTHO_DEFAULT_ZOOM / 2;
  return new THREE.OrthographicCamera(
    -half * aspect, half * aspect, half, -half, 0.1, 500,
  );
})();
orthoCamera.position.set(0, 100, 0);
orthoCamera.lookAt(0, 0, 0);

const eagleEye = {
  active: false,
  zoom: ORTHO_DEFAULT_ZOOM,
  panX: 0,
  panZ: 0,
};

function activeCamera() {
  return eagleEye.active ? orthoCamera : camera;
}

function updateOrthoFrustum() {
  const aspect = window.innerWidth / window.innerHeight;
  const half = eagleEye.zoom / 2;
  orthoCamera.left   = -half * aspect;
  orthoCamera.right  =  half * aspect;
  orthoCamera.top    =  half;
  orthoCamera.bottom = -half;
  orthoCamera.updateProjectionMatrix();
}

// Post-processing
const renderPass = new RenderPass(scene, camera);
const composer = new EffectComposer(renderer);
composer.addPass(renderPass);
const bloom = new UnrealBloomPass(
  new THREE.Vector2(window.innerWidth / 2, window.innerHeight / 2),
  0.6, 0.4, 0.85,
);
composer.addPass(bloom);

// Horizon gradient sky (Jurassic Park FSN style)
const skyGeo = new THREE.SphereGeometry(400, 32, 32);
const skyMat = new THREE.ShaderMaterial({
  side: THREE.BackSide,
  depthWrite: false,
  fog: false,
  uniforms: {},
  vertexShader: `
    varying vec3 vWorldPos;
    void main() {
      vec4 wp = modelMatrix * vec4(position, 1.0);
      vWorldPos = wp.xyz;
      gl_Position = projectionMatrix * viewMatrix * wp;
    }
  `,
  fragmentShader: `
    varying vec3 vWorldPos;
    void main() {
      float h = normalize(vWorldPos).y;
      vec3 top    = vec3(0.01, 0.01, 0.01);
      vec3 green  = vec3(0.04, 0.25, 0.10);
      vec3 bottom = vec3(0.01, 0.01, 0.01);

      vec3 col;
      if (h > 0.0) {
        float t = smoothstep(0.0, 0.12, h);
        col = mix(green, top, t);
      } else {
        // Below horizon: all black so nothing bleeds through the grid
        col = bottom;
      }
      gl_FragColor = vec4(col, 1.0);
    }
  `,
});
const sky = new THREE.Mesh(skyGeo, skyMat);
scene.add(sky);

// Lights
const ambient = new THREE.AmbientLight(0x334455, 0.8);
scene.add(ambient);
const dirLight = new THREE.DirectionalLight(0xffffff, 0.6);
dirLight.position.set(10, 20, 10);
scene.add(dirLight);
const pointLight = new THREE.PointLight(0x00ff88, 0.4, 100);
pointLight.position.set(0, 15, 0);
scene.add(pointLight);

// Spotlight (Jurassic Park style – starts hidden)
const spotlight = new THREE.SpotLight(0xffffff, 0, 60, Math.PI / 6, 0.5, 1.2);
spotlight.position.set(0, 30, 0);
spotlight.target.position.set(0, 0, 0);
scene.add(spotlight);
scene.add(spotlight.target);

// FSN-style cone beam (angled, like the Jurassic Park movie)
const BEAM_TOP_RADIUS = 0.1;
const BEAM_BOT_RADIUS = 3.5;
const BEAM_SEGMENTS = 32;
const BEAM_SOURCE_OFFSET = new THREE.Vector3(10, 26, -6);

const beamClipPlane = new THREE.Plane(new THREE.Vector3(0, 1, 0), 0);
const beamMat = new THREE.MeshBasicMaterial({
  color: 0xddeeff,
  transparent: true,
  opacity: 0,
  side: THREE.DoubleSide,
  depthWrite: false,
  blending: THREE.AdditiveBlending,
  clippingPlanes: [beamClipPlane],
});

// Unit-height cone scaled dynamically to match beam length
const beamCone = new THREE.Mesh(
  new THREE.CylinderGeometry(BEAM_TOP_RADIUS, BEAM_BOT_RADIUS, 1, BEAM_SEGMENTS, 1, true),
  beamMat,
);
beamCone.visible = false;
scene.add(beamCone);

// Ground glow disc
const glowGeo = new THREE.CircleGeometry(3.5, 48);
const glowMat = new THREE.MeshBasicMaterial({
  color: 0xffeedd,
  transparent: true,
  opacity: 0,
  depthWrite: false,
  blending: THREE.AdditiveBlending,
});
const glowDisc = new THREE.Mesh(glowGeo, glowMat);
glowDisc.rotation.x = -Math.PI / 2;
glowDisc.visible = false;
scene.add(glowDisc);

// Two-phase selection state
const selection = {
  phase: 'none',       // 'none' | 'namespace' | 'resource'
  nsName: null,
  resourceMesh: null,
};

// Spotlight intensity presets
const SPOT_NS = { intensity: 24, beamOpacity: 0.015, glowOpacity: 0.04, beamWidth: 1.6 };
const SPOT_RES = { intensity: 60, beamOpacity: 0.03, glowOpacity: 0.09, beamWidth: 0.45 };

// Spotlight animation state
const spot = {
  active: false,
  fadingIn: false,
  fadingOut: false,
  intensity: 0,
  beamOpacity: 0,
  glowOpacity: 0,
  targetIntensity: SPOT_NS.intensity,
  targetBeamOpacity: SPOT_NS.beamOpacity,
  targetGlowOpacity: SPOT_NS.glowOpacity,
  fadeSpeed: 2.5,
  nsName: null,
  podLabels: [],
};

const BASE_AMBIENT = 0.8;
const DIM_AMBIENT = 0.25;

function positionSpotlight(nsName) {
  const island = nsName === '__nodes__' ? state.nodeIsland : state.namespaces.get(nsName);
  if (!island) return;
  const wp = new THREE.Vector3();
  island.group.getWorldPosition(wp);

  const w = selection.phase === 'resource' ? SPOT_RES.beamWidth : SPOT_NS.beamWidth;

  const sourcePos = wp.clone().add(BEAM_SOURCE_OFFSET);
  spotlight.position.copy(sourcePos);
  spotlight.target.position.copy(wp);
  spotlight.angle = Math.PI / 6 * w;

  const botR = BEAM_BOT_RADIUS * w;
  const coneEnd = wp.clone();
  const beamDir = new THREE.Vector3().subVectors(coneEnd, sourcePos).normalize();
  const sinTilt = Math.sqrt(beamDir.x * beamDir.x + beamDir.z * beamDir.z);
  const overshoot = (botR * sinTilt / Math.abs(beamDir.y)) * 1.5;
  coneEnd.addScaledVector(beamDir, overshoot);

  beamClipPlane.set(new THREE.Vector3(0, 1, 0), -wp.y);

  const dist = sourcePos.distanceTo(coneEnd);
  beamCone.scale.set(w, dist, w);
  const mid = sourcePos.clone().add(coneEnd).multiplyScalar(0.5);
  beamCone.position.copy(mid);
  const upDir = new THREE.Vector3().subVectors(sourcePos, coneEnd).normalize();
  beamCone.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), upDir);

  const distToGround = sourcePos.distanceTo(wp);
  const tParam = distToGround / dist;
  const rGround = BEAM_TOP_RADIUS + (botR - BEAM_TOP_RADIUS) * tParam;
  const cosTilt = Math.abs(beamDir.y);
  const semiMajor = rGround / cosTilt;
  const semiMinor = rGround;
  const discAngle = Math.atan2(-beamDir.z, beamDir.x);
  glowDisc.rotation.set(-Math.PI / 2, 0, discAngle);
  glowDisc.scale.set(semiMajor / 3.5, semiMinor / 3.5, 1);
  glowDisc.position.set(wp.x, wp.y + 0.05, wp.z);
}

function startSpotlight(nsName) {
  spot.nsName = nsName;
  spot.targetIntensity = SPOT_NS.intensity;
  spot.targetBeamOpacity = SPOT_NS.beamOpacity;
  spot.targetGlowOpacity = SPOT_NS.glowOpacity;
  positionSpotlight(nsName);
  beamCone.visible = true;
  glowDisc.visible = true;
  spot.fadingIn = true;
  spot.fadingOut = false;
  spot.active = true;
  selection.phase = 'namespace';
  selection.nsName = nsName;
  selection.resourceMesh = null;
  showPodLabels(nsName);
}

function startResourceSpotlight(resourceMesh) {
  const wp = new THREE.Vector3();
  resourceMesh.getWorldPosition(wp);

  // Platform surface Y from parent group (resource sits above it at h/2)
  const groundPos = new THREE.Vector3();
  resourceMesh.parent.getWorldPosition(groundPos);
  const surfaceY = groundPos.y;

  const w = SPOT_RES.beamWidth;

  const sourcePos = wp.clone().add(BEAM_SOURCE_OFFSET);
  spotlight.position.copy(sourcePos);
  spotlight.target.position.copy(wp);
  spotlight.angle = Math.PI / 6 * w;

  const botR = BEAM_BOT_RADIUS * w;
  const coneEnd = wp.clone();
  const beamDir = new THREE.Vector3().subVectors(coneEnd, sourcePos).normalize();
  const sinTilt = Math.sqrt(beamDir.x * beamDir.x + beamDir.z * beamDir.z);
  const overshoot = (botR * sinTilt / Math.abs(beamDir.y)) * 1.5;
  coneEnd.addScaledVector(beamDir, overshoot);

  beamClipPlane.set(new THREE.Vector3(0, 1, 0), -surfaceY);

  const dist = sourcePos.distanceTo(coneEnd);
  beamCone.scale.set(w, dist, w);
  const mid = sourcePos.clone().add(coneEnd).multiplyScalar(0.5);
  beamCone.position.copy(mid);
  const upDir = new THREE.Vector3().subVectors(sourcePos, coneEnd).normalize();
  beamCone.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), upDir);

  const groundTarget = new THREE.Vector3(wp.x, surfaceY, wp.z);
  const distToGround = sourcePos.distanceTo(groundTarget);
  const tParam = distToGround / dist;
  const rGround = BEAM_TOP_RADIUS + (botR - BEAM_TOP_RADIUS) * tParam;
  const cosTilt = Math.abs(beamDir.y);
  const semiMajor = rGround / cosTilt;
  const semiMinor = rGround;
  const discAngle = Math.atan2(-beamDir.z, beamDir.x);
  glowDisc.rotation.set(-Math.PI / 2, 0, discAngle);
  glowDisc.scale.set(semiMajor / 3.5, semiMinor / 3.5, 1);
  glowDisc.position.set(wp.x, surfaceY + 0.05, wp.z);

  spot.targetIntensity = SPOT_RES.intensity;
  spot.targetBeamOpacity = SPOT_RES.beamOpacity;
  spot.targetGlowOpacity = SPOT_RES.glowOpacity;
  spot.fadingIn = true;
  spot.fadingOut = false;

  selection.phase = 'resource';
  selection.resourceMesh = resourceMesh;

  startResourceFlyTo(resourceMesh);
  showDetailForSelection();
}

function fadeOutSpotlight() {
  if (!spot.active && !spot.fadingOut) return;
  spot.fadingIn = false;
  spot.fadingOut = true;
  selection.phase = 'none';
  selection.nsName = null;
  selection.resourceMesh = null;
  hideDetailPanel();
}

function lerpTo(current, target, step) {
  if (current < target) return Math.min(current + step * target, target);
  return Math.max(current - step * Math.abs(current), target);
}

function updateSpotlight(dt) {
  if (spot.fadingIn) {
    const step = spot.fadeSpeed * dt;
    spot.intensity = lerpTo(spot.intensity, spot.targetIntensity, step);
    spot.beamOpacity = lerpTo(spot.beamOpacity, spot.targetBeamOpacity, step);
    spot.glowOpacity = lerpTo(spot.glowOpacity, spot.targetGlowOpacity, step);
    ambient.intensity = Math.max(ambient.intensity - spot.fadeSpeed * dt * (BASE_AMBIENT - DIM_AMBIENT), DIM_AMBIENT);
    if (Math.abs(spot.intensity - spot.targetIntensity) < 0.1) spot.fadingIn = false;
  }
  if (spot.fadingOut) {
    spot.intensity = Math.max(spot.intensity - spot.fadeSpeed * dt * spot.targetIntensity, 0);
    spot.beamOpacity = Math.max(spot.beamOpacity - spot.fadeSpeed * dt * spot.targetBeamOpacity, 0);
    spot.glowOpacity = Math.max(spot.glowOpacity - spot.fadeSpeed * dt * spot.targetGlowOpacity, 0);
    ambient.intensity = Math.min(ambient.intensity + spot.fadeSpeed * dt * (BASE_AMBIENT - DIM_AMBIENT), BASE_AMBIENT);
    if (spot.intensity <= 0) {
      spot.fadingOut = false;
      spot.active = false;
      beamCone.visible = false;
      glowDisc.visible = false;
      spot.nsName = null;
      clearPodLabels();
    }
  }
  spotlight.intensity = spot.intensity;
  beamMat.opacity = spot.beamOpacity;
  glowMat.opacity = spot.glowOpacity;

  const podLabelOpacity = spot.intensity / spot.targetIntensity * 0.85;
  for (const { mesh } of spot.podLabels) {
    mesh.material.opacity = podLabelOpacity;
  }
}

function showPodLabels(nsName) {
  clearPodLabels();

  if (nsName === '__nodes__' && state.nodeIsland) {
    const island = state.nodeIsland;
    for (const [nodeName, blockMesh] of island.blocks) {
      const label = makeLabel(nodeName, 28, 1.6, 0.75);
      label.scale.set(0.12, 0.12, 0.12);
      label.position.set(blockMesh.position.x, 0.15, blockMesh.position.z + NODE_BLOCK_SIZE / 2 + 0.6);
      label.material.opacity = 0;
      island.group.add(label);
      spot.podLabels.push({ mesh: label, group: island.group });
    }
    return;
  }

  const ns = state.namespaces.get(nsName);
  if (!ns) return;
  for (const [podName, podMesh] of ns.pods) {
    const label = makeLabel(podName, 28, 1.6, 0.75);
    label.scale.set(0.12, 0.12, 0.12);
    const d = podMesh.geometry.parameters.depth || POD_BASE_SIZE;
    label.position.set(podMesh.position.x, 0.15, podMesh.position.z + d / 2 + 0.6);
    label.material.opacity = 0;
    ns.group.add(label);
    spot.podLabels.push({ mesh: label, group: ns.group });
  }
}

function clearPodLabels() {
  for (const { mesh, group } of spot.podLabels) {
    group.remove(mesh);
    disposeMesh(mesh);
  }
  spot.podLabels = [];
}

// ── Detail Side Panel ──────────────────────────────────────────
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

function showPodDetail(pod) {
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
    ${dpLabelsHTML(pod.labels)}
  `;
  openDetailPanel();
}

function showNodeDetail(node) {
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
  `;
  openDetailPanel();
}

function showWorkloadDetail(wl) {
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
  `;
  openDetailPanel();
}

function showServiceDetail(svc) {
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

function showIngressDetail(ing) {
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

function openDetailPanel() {
  detailPanelOpen = true;
  detailPanel.classList.add('open');
}

function hideDetailPanel() {
  detailPanelOpen = false;
  detailPanel.classList.remove('open');
}

window._dpClose = function() {
  hideDetailPanel();
};

function showDetailForSelection() {
  if (selection.phase === 'resource' && selection.resourceMesh) {
    const mesh = selection.resourceMesh;
    if (mesh.userData.type === 'pod') {
      showPodDetail(mesh.userData.pod);
    } else if (mesh.userData.type === 'nodeBlock') {
      showNodeDetail(mesh.userData.node);
    } else if (mesh.userData.type === 'ingress') {
      const ing = mesh.userData.ingress;
      if (ing) showIngressDetail(ing);
    }
  }
}

// Solid black ground plane
const groundGeo = new THREE.PlaneGeometry(200, 200);
const groundMat = new THREE.MeshBasicMaterial({ color: 0x000000, transparent: true, opacity: 0.4 });
const groundPlane = new THREE.Mesh(groundGeo, groundMat);
groundPlane.rotation.x = -Math.PI / 2;
groundPlane.position.y = -0.5;
scene.add(groundPlane);

// ── Materials ──────────────────────────────────────────────────
const platformMaterial = new THREE.MeshPhongMaterial({
  color: 0x882244,
  emissive: 0x331122,
  shininess: 30,
  transparent: true,
  opacity: 0.85,
});

function podMaterial(status) {
  const color = statusColor(status);
  return new THREE.MeshPhongMaterial({
    color,
    emissive: new THREE.Color(color).multiplyScalar(0.3),
    shininess: 60,
    transparent: true,
    opacity: 0.9,
  });
}

function disposeMaterial(material) {
  if (!material) return;
  if (Array.isArray(material)) {
    for (const mat of material) disposeMaterial(mat);
    return;
  }

  const textures = new Set();
  for (const value of Object.values(material)) {
    if (value && value.isTexture) textures.add(value);
  }
  for (const texture of textures) texture.dispose();
  material.dispose();
}

function disposeMesh(mesh) {
  if (!mesh) return;
  mesh.geometry?.dispose();
  disposeMaterial(mesh.material);
}

// ── Resource Sizing ────────────────────────────────────────────
// CPU: 100m → POD_MIN_SIZE, 2000m+ → POD_MAX_SIZE
// Memory: 64Mi → POD_MIN_SIZE, 2Gi+ → POD_MAX_SIZE
const CPU_MIN = 100;
const CPU_MAX = 2000;
const MEM_MIN = 64 * 1024 * 1024;
const MEM_MAX = 2 * 1024 * 1024 * 1024;

function podWidth(cpuMillis) {
  if (!cpuMillis || cpuMillis <= 0) return POD_BASE_SIZE;
  const t = Math.max(0, Math.min(1, (cpuMillis - CPU_MIN) / (CPU_MAX - CPU_MIN)));
  return POD_MIN_SIZE + t * (POD_MAX_SIZE - POD_MIN_SIZE);
}

function podDepth(memBytes) {
  if (!memBytes || memBytes <= 0) return POD_BASE_SIZE;
  const t = Math.max(0, Math.min(1, (memBytes - MEM_MIN) / (MEM_MAX - MEM_MIN)));
  return POD_MIN_SIZE + t * (POD_MAX_SIZE - POD_MIN_SIZE);
}

// ── Node Island Materials ───────────────────────────────────────
const nodePlatformMaterial = new THREE.MeshPhongMaterial({
  color: 0x224466,
  emissive: 0x112244,
  shininess: 30,
  transparent: true,
  opacity: 0.85,
});

const NODE_BLOCK_COLORS = {
  Ready:    0x00ccff,
  NotReady: 0xff4444,
};

function nodeBlockMaterial(status) {
  const color = NODE_BLOCK_COLORS[status] ?? 0x00ccff;
  return new THREE.MeshPhongMaterial({
    color,
    emissive: new THREE.Color(color).multiplyScalar(0.3),
    shininess: 60,
    transparent: true,
    opacity: 0.9,
  });
}

// ── Text Labels (canvas texture → flat on ground) ─────────────
function makeLabel(text, fontSize = 64, worldHeight = 2.5, opacity = 0.9, fontFamily = "'Share Tech Mono', monospace", fontWeight = '400') {
  const cvs = document.createElement('canvas');
  const ctx = cvs.getContext('2d');
  const fontStr = `${fontWeight} ${fontSize}px ${fontFamily}`;
  ctx.font = fontStr;
  const metrics = ctx.measureText(text);
  cvs.width = Math.ceil(metrics.width) + 20;
  cvs.height = fontSize + 20;
  ctx.font = fontStr;
  ctx.fillStyle = '#00ff88';
  ctx.shadowColor = '#00ff88';
  ctx.shadowBlur = 8;
  ctx.fillText(text, 10, fontSize);
  const texture = new THREE.CanvasTexture(cvs);
  texture.minFilter = THREE.LinearFilter;
  const aspect = cvs.width / cvs.height;
  const planeW = aspect * worldHeight;
  const planeH = worldHeight;
  const geo = new THREE.PlaneGeometry(planeW, planeH);
  const mat = new THREE.MeshBasicMaterial({
    map: texture,
    transparent: true,
    opacity,
    depthWrite: false,
    depthTest: false,
    side: THREE.DoubleSide,
  });
  const mesh = new THREE.Mesh(geo, mat);
  mesh.renderOrder = 999;
  mesh.rotation.x = -Math.PI / 2; // lay flat on ground
  mesh.userData = { type: 'label' };
  return mesh;
}

function makeBeveledPlatformGeo(width, height, depth) {
  const bevel = 0.07;
  const shape = new THREE.Shape();
  shape.moveTo(-width / 2, -depth / 2);
  shape.lineTo( width / 2, -depth / 2);
  shape.lineTo( width / 2,  depth / 2);
  shape.lineTo(-width / 2,  depth / 2);
  shape.closePath();

  const geo = new THREE.ExtrudeGeometry(shape, {
    depth: height,
    bevelEnabled: true,
    bevelThickness: bevel,
    bevelSize: bevel,
    bevelSegments: 1,
  });

  geo.rotateX(-Math.PI / 2);
  geo.translate(0, -height / 2, 0);
  return geo;
}

function buildWorkloadGroups(nsName, ns) {
  const groups = new Map();
  for (const [, podMesh] of ns.pods) {
    const pod = podMesh.userData.pod;
    const owner = podWorkload(pod);
    const key = workloadKey(nsName, owner.kind, owner.name);
    let group = groups.get(key);
    if (!group) {
      group = { key, kind: owner.kind, name: owner.name, pods: [] };
      groups.set(key, group);
    }
    group.pods.push(podMesh);
  }

  const result = [...groups.values()].sort((left, right) => {
    if (left.kind !== right.kind) return left.kind.localeCompare(right.kind);
    return left.name.localeCompare(right.name);
  });

  for (const group of result) {
    group.cols = Math.max(1, Math.ceil(Math.sqrt(group.pods.length)));
    group.rows = Math.max(1, Math.ceil(group.pods.length / group.cols));
    group.width = group.cols * POD_STRIDE + 1;
    group.depth = group.rows * POD_STRIDE + 1;
  }

  return result;
}

// ── Namespace Layout ───────────────────────────────────────────
function layoutNamespaces() {
  // Build the node island first so we can include it in the grid
  if (state.nodes.size > 0) {
    rebuildNodeIsland();
    layoutNodeIsland();
  } else {
    clearNodeIsland();
  }

  // Collect all islands: node island (if any) + namespace groups
  const entries = []; // { group, platWidth, platDepth, nsName?, workloads? }
  if (state.nodeIsland && state.nodeIsland.blocks.size > 0) {
    const blockStride = NODE_BLOCK_SIZE + 1.2;
    const blockCols = Math.max(2, Math.ceil(Math.sqrt(state.nodeIsland.blocks.size)));
    const blockRows = Math.max(1, Math.ceil(state.nodeIsland.blocks.size / blockCols));
    entries.push({
      group: state.nodeIsland.group,
      platWidth: blockCols * blockStride + 2,
      platDepth: blockRows * blockStride + 2,
    });
  }

  const nsList = [...state.namespaces.keys()].sort();
  for (const nsName of nsList) {
    const ns = state.namespaces.get(nsName);
    const workloads = buildWorkloadGroups(nsName, ns);

    const wlCols = Math.max(1, Math.ceil(Math.sqrt(Math.max(workloads.length, 1))));
    const wlRows = Math.max(1, Math.ceil(Math.max(workloads.length, 1) / wlCols));

    const wlColWidths = new Array(wlCols).fill(0);
    const wlRowDepths = new Array(wlRows).fill(0);

    workloads.forEach((workload, index) => {
      const col = index % wlCols;
      const row = Math.floor(index / wlCols);
      wlColWidths[col] = Math.max(wlColWidths[col], workload.width);
      wlRowDepths[row] = Math.max(wlRowDepths[row], workload.depth);
    });

    let wlWidth = 0;
    for (const width of wlColWidths) wlWidth += width;
    if (wlCols > 1) wlWidth += (wlCols - 1) * WORKLOAD_GAP;

    let wlDepth = 0;
    for (const depth of wlRowDepths) wlDepth += depth;
    if (wlRows > 1) wlDepth += (wlRows - 1) * WORKLOAD_GAP;

    const platWidth = Math.max(8, wlWidth + 3);
    const platDepth = Math.max(8, wlDepth + 3);
    entries.push({ group: ns.group, platWidth, platDepth, nsName, workloads });
  }

  const cols = Math.max(1, Math.ceil(Math.sqrt(entries.length)));
  const rows = Math.ceil(entries.length / cols);

  // Compute max width per column and max depth per row to prevent overlaps
  const colWidths = new Array(cols).fill(0);
  const rowDepths = new Array(rows).fill(0);
  entries.forEach((entry, i) => {
    const col = i % cols;
    const row = Math.floor(i / cols);
    colWidths[col] = Math.max(colWidths[col], entry.platWidth);
    rowDepths[row] = Math.max(rowDepths[row], entry.platDepth);
  });

  // Build cumulative offsets (center of each column/row)
  const colX = [];
  let cx = 0;
  for (let c = 0; c < cols; c++) {
    colX.push(cx + colWidths[c] / 2);
    cx += colWidths[c] + PLATFORM_GAP;
  }
  const totalWidth = cx - PLATFORM_GAP;

  const rowZ = [];
  let rz = 0;
  for (let r = 0; r < rows; r++) {
    rowZ.push(rz + rowDepths[r] / 2);
    rz += rowDepths[r] + PLATFORM_GAP;
  }
  const totalDepth = rz - PLATFORM_GAP;

  entries.forEach((entry, i) => {
    const col = i % cols;
    const row = Math.floor(i / cols);
    const x = colX[col] - totalWidth / 2;
    const z = rowZ[row] - totalDepth / 2;
    entry.group.position.set(x, PLATFORM_Y, z);

    // Skip node island — already built by rebuildNodeIsland/layoutNodeIsland
    if (!entry.nsName) return;

    const ns = state.namespaces.get(entry.nsName);
    ns.platWidth = entry.platWidth;
    ns.platDepth = entry.platDepth;

    // Rebuild platform geometry
    if (ns.platform) {
      ns.group.remove(ns.platform);
      disposeMesh(ns.platform);
    }
    const platGeo = makeBeveledPlatformGeo(entry.platWidth, PLATFORM_HEIGHT, entry.platDepth);
    ns.platform = new THREE.Mesh(platGeo, platformMaterial.clone());
    ns.platform.position.y = -PLATFORM_HEIGHT / 2;
    ns.platform.userData = { type: 'namespace', name: entry.nsName };
    ns.group.add(ns.platform);

    // Reposition label
    if (ns.label) {
      ns.group.remove(ns.label);
      disposeMesh(ns.label);
    }
    ns.label = makeLabel(entry.nsName.toUpperCase(), 64, 1.8, 0.82, "'Smooch Sans', sans-serif", '300');
    ns.label.position.set(0, 0.15, entry.platDepth / 2 + 2);
    ns.group.add(ns.label);

    for (const [, label] of ns.workloadLabels) {
      ns.group.remove(label);
      disposeMesh(label);
    }
    ns.workloadLabels.clear();

    const workloads = entry.workloads ?? [];
    const wlCols = Math.max(1, Math.ceil(Math.sqrt(Math.max(workloads.length, 1))));
    const wlRows = Math.max(1, Math.ceil(Math.max(workloads.length, 1) / wlCols));
    const wlColWidths = new Array(wlCols).fill(0);
    const wlRowDepths = new Array(wlRows).fill(0);

    workloads.forEach((workload, index) => {
      const col = index % wlCols;
      const row = Math.floor(index / wlCols);
      wlColWidths[col] = Math.max(wlColWidths[col], workload.width);
      wlRowDepths[row] = Math.max(wlRowDepths[row], workload.depth);
    });

    const wlColCenters = [];
    let wx = 0;
    for (let col = 0; col < wlCols; col++) {
      wlColCenters.push(wx + wlColWidths[col] / 2);
      wx += wlColWidths[col] + WORKLOAD_GAP;
    }
    const wlTotalWidth = wx > 0 ? wx - WORKLOAD_GAP : 0;

    const wlRowCenters = [];
    let wz = 0;
    for (let row = 0; row < wlRows; row++) {
      wlRowCenters.push(wz + wlRowDepths[row] / 2);
      wz += wlRowDepths[row] + WORKLOAD_GAP;
    }
    const wlTotalDepth = wz > 0 ? wz - WORKLOAD_GAP : 0;

    workloads.forEach((workload, index) => {
      const col = index % wlCols;
      const row = Math.floor(index / wlCols);
      const workloadX = wlColCenters[col] - wlTotalWidth / 2;
      const workloadZ = wlRowCenters[row] - wlTotalDepth / 2;

      const label = makeLabel(`${workload.kind.toUpperCase()}/${workload.name}`, 30, 0.95, 0.58, "'Smooch Sans', sans-serif", '300');
      label.position.set(
        workloadX,
        0.14,
        workloadZ - workload.depth / 2 - 0.9
      );
      ns.group.add(label);
      ns.workloadLabels.set(workload.key, label);

      let podIndex = 0;
      for (const podMesh of workload.pods) {
        const podCol = podIndex % workload.cols;
        const podRow = Math.floor(podIndex / workload.cols);
        const h = podMesh.geometry.parameters.height || POD_BASE_SIZE;
        podMesh.position.set(
          workloadX + podCol * POD_STRIDE - (workload.cols * POD_STRIDE) / 2 + POD_STRIDE / 2,
          h / 2,
          workloadZ + podRow * POD_STRIDE - (workload.rows * POD_STRIDE) / 2 + POD_STRIDE / 2
        );
        podIndex++;
      }
    });

    if (workloads.length === 0) {
      for (const [, podMesh] of ns.pods) {
        const h = podMesh.geometry.parameters.height || POD_BASE_SIZE;
        podMesh.position.set(0, h / 2, 0);
      }
    }
  });

  // On first layout, pull camera back to show all islands
  if (!layoutNamespaces._initialDone && entries.length > 0) {
    layoutNamespaces._initialDone = true;
    const extent = Math.max(totalWidth, totalDepth, 20);
    const fovRad = THREE.MathUtils.degToRad(camera.fov / 2);
    const aspect = camera.aspect;
    const distForWidth = totalWidth / (2 * Math.tan(fovRad) * aspect);
    const distForDepth = totalDepth / (2 * Math.tan(fovRad));
    const dist = Math.max(distForWidth, distForDepth, 25) * 1.3;
    camera.position.set(0, dist * 0.45, dist);
    camera.lookAt(0, 0, 0);
    euler.setFromQuaternion(camera.quaternion);
  }
  // Refresh pod labels if spotlight is active
  if (spot.active && spot.nsName) {
    showPodLabels(spot.nsName);
    for (const { mesh } of spot.podLabels) {
      mesh.material.opacity = 0.85;
    }
  }
}

// ── Namespace/Pod Management ───────────────────────────────────
function ensureNamespace(name) {
  if (state.namespaces.has(name)) return state.namespaces.get(name);
  const group = new THREE.Group();
  group.userData = { type: 'namespace', name };
  scene.add(group);
  const ns = { group, platform: null, pods: new Map(), label: null, workloadLabels: new Map() };
  state.namespaces.set(name, ns);
  invalidateRayTargets();
  return ns;
}

function addOrUpdatePod(nsName, pod) {
  const ns = ensureNamespace(nsName);

  const w = podWidth(pod.cpuRequest);
  const d = podDepth(pod.memoryRequest);
  const height = POD_BASE_SIZE + Math.min(pod.restarts * 0.15, 2);

  if (ns.pods.has(pod.name)) {
    const existing = ns.pods.get(pod.name);
    existing.material.dispose();
    existing.material = podMaterial(pod.status);
    // Rebuild geometry if resources changed
    const oldPod = existing.userData.pod;
    if (oldPod.cpuRequest !== pod.cpuRequest || oldPod.memoryRequest !== pod.memoryRequest || oldPod.restarts !== pod.restarts) {
      existing.geometry.dispose();
      existing.geometry = new THREE.BoxGeometry(w, height, d);
    }
    existing.userData = { type: 'pod', pod };
    return;
  }

  const geo = new THREE.BoxGeometry(w, height, d);
  const mat = podMaterial(pod.status);
  const mesh = new THREE.Mesh(geo, mat);
  mesh.userData = { type: 'pod', pod };
  ns.pods.set(pod.name, mesh);
  ns.group.add(mesh);
  invalidateRayTargets();
}

function removePod(nsName, podName) {
  const ns = state.namespaces.get(nsName);
  if (!ns) return;
  const mesh = ns.pods.get(podName);
  if (mesh) {
    ns.group.remove(mesh);
    mesh.geometry.dispose();
    mesh.material.dispose();
    ns.pods.delete(podName);
    invalidateRayTargets();
  }
}

function removeNamespace(name) {
  const ns = state.namespaces.get(name);
  if (!ns) return;
  if (spot.nsName === name) {
    clearPodLabels();
    fadeOutSpotlight();
  }
  for (const [, mesh] of ns.pods) {
    disposeMesh(mesh);
  }
  for (const [, label] of ns.workloadLabels) {
    disposeMesh(label);
  }
  if (ns.platform) disposeMesh(ns.platform);
  if (ns.label) disposeMesh(ns.label);
  scene.remove(ns.group);
  state.namespaces.delete(name);
  invalidateRayTargets();
}

// ── Node Island ────────────────────────────────────────────────
function ensureNodeIsland() {
  if (state.nodeIsland) return state.nodeIsland;
  const group = new THREE.Group();
  group.userData = { type: 'namespace', name: '__nodes__' };
  scene.add(group);
  state.nodeIsland = { group, platform: null, blocks: new Map(), label: null };
  invalidateRayTargets();
  return state.nodeIsland;
}

function clearNodeIsland() {
  const island = state.nodeIsland;
  if (!island) return;
  if (spot.nsName === '__nodes__') {
    clearPodLabels();
    fadeOutSpotlight();
  }

  for (const [, mesh] of island.blocks) {
    island.group.remove(mesh);
    disposeMesh(mesh);
  }
  island.blocks.clear();

  if (island.platform) {
    island.group.remove(island.platform);
    disposeMesh(island.platform);
    island.platform = null;
  }
  if (island.label) {
    island.group.remove(island.label);
    disposeMesh(island.label);
    island.label = null;
  }

  scene.remove(island.group);
  state.nodeIsland = null;
  invalidateRayTargets();
}

function rebuildNodeIsland() {
  const island = ensureNodeIsland();

  // Remove old blocks
  for (const [, mesh] of island.blocks) {
    island.group.remove(mesh);
    mesh.geometry.dispose();
    mesh.material.dispose();
  }
  island.blocks.clear();

  // Create a block per node
  const nodeList = [...state.nodes.keys()].sort();
  for (const name of nodeList) {
    const info = state.nodes.get(name);
    const geo = new THREE.BoxGeometry(NODE_BLOCK_SIZE, NODE_BLOCK_SIZE, NODE_BLOCK_SIZE);
    const mat = nodeBlockMaterial(info.status);
    const mesh = new THREE.Mesh(geo, mat);
    mesh.userData = { type: 'nodeBlock', node: info };
    island.blocks.set(name, mesh);
    island.group.add(mesh);
  }
  invalidateRayTargets();
}

function layoutNodeIsland() {
  const island = state.nodeIsland;
  if (!island) return;

  const blockCount = island.blocks.size;
  if (blockCount === 0) return;

  const blockStride = NODE_BLOCK_SIZE + 1.2;
  const blockCols = Math.max(2, Math.ceil(Math.sqrt(blockCount)));
  const blockRows = Math.max(1, Math.ceil(blockCount / blockCols));
  const platWidth = blockCols * blockStride + 2;
  const platDepth = blockRows * blockStride + 2;

  // Rebuild platform
  if (island.platform) {
    island.group.remove(island.platform);
    disposeMesh(island.platform);
  }
  const platGeo = makeBeveledPlatformGeo(platWidth, PLATFORM_HEIGHT, platDepth);
  island.platform = new THREE.Mesh(platGeo, nodePlatformMaterial.clone());
  island.platform.position.y = -PLATFORM_HEIGHT / 2;
  island.platform.userData = { type: 'namespace', name: '__nodes__' };
  island.group.add(island.platform);

  // Rebuild label
  if (island.label) {
    island.group.remove(island.label);
    disposeMesh(island.label);
  }
  island.label = makeLabel('NODES', 64, 1.8, 0.82, "'Smooch Sans', sans-serif", '300');
  island.label.position.set(0, 0.15, platDepth / 2 + 2);
  island.group.add(island.label);

  // Lay out blocks
  let idx = 0;
  for (const [, mesh] of island.blocks) {
    const pc = idx % blockCols;
    const pr = Math.floor(idx / blockCols);
    mesh.position.set(
      pc * blockStride - (blockCols * blockStride) / 2 + blockStride / 2,
      NODE_BLOCK_SIZE / 2,
      pr * blockStride - (blockRows * blockStride) / 2 + blockStride / 2,
    );
    idx++;
  }

  return { platWidth, platDepth };
}

// ── Service Connection Lines ───────────────────────────────────
function selectorMatchesLabels(selector, labels) {
  if (!selector || !labels) return false;
  for (const [k, v] of Object.entries(selector)) {
    if (labels[k] !== v) return false;
  }
  return true;
}

function rebuildServiceLines() {
  if (state.serviceLines) {
    scene.remove(state.serviceLines);
    state.serviceLines.traverse((child) => {
      if (child.geometry) child.geometry.dispose();
      if (child.material) child.material.dispose();
    });
  }

  const group = new THREE.Group();
  group.userData = { type: 'serviceLines' };

  const lineMat = new THREE.LineBasicMaterial({
    color: 0x00aaff,
    transparent: true,
    opacity: 0.25,
    depthWrite: false,
  });

  for (const svc of state.services) {
    if (!svc.selector || Object.keys(svc.selector).length === 0) continue;

    const ns = state.namespaces.get(svc.namespace);
    if (!ns) continue;

    // Find matching pods
    const matchedMeshes = [];
    for (const [, podMesh] of ns.pods) {
      const pod = podMesh.userData.pod;
      if (pod && selectorMatchesLabels(svc.selector, pod.labels)) {
        matchedMeshes.push(podMesh);
      }
    }

    if (matchedMeshes.length < 2) continue;

    // Draw lines between all matched pods (star topology from first pod)
    const worldPos = (mesh) => {
      const v = new THREE.Vector3();
      mesh.getWorldPosition(v);
      return v;
    };

    const anchor = worldPos(matchedMeshes[0]);
    for (let j = 1; j < matchedMeshes.length; j++) {
      const target = worldPos(matchedMeshes[j]);
      // Curved arc: midpoint lifted above
      const mid = anchor.clone().add(target).multiplyScalar(0.5);
      mid.y += 2;
      const curve = new THREE.QuadraticBezierCurve3(anchor, mid, target);
      const points = curve.getPoints(16);
      const geo = new THREE.BufferGeometry().setFromPoints(points);
      const line = new THREE.Line(geo, lineMat.clone());
      group.add(line);
    }
  }

  state.serviceLines = group;
  scene.add(group);
}

// ── Ingress Orthogonal Connectors (Miro-style) ─────────────────
function orthogonalPath(sx, sz, ex, ez) {
  if (Math.abs(sx - ex) < 0.01) return [{ x: sx, z: sz }, { x: ex, z: ez }];
  if (Math.abs(sz - ez) < 0.01) return [{ x: sx, z: sz }, { x: ex, z: ez }];
  // Z-shape: vertical from source, horizontal mid-segment, vertical to target
  const midZ = (sz + ez) / 2;
  return [
    { x: sx, z: sz },
    { x: sx, z: midZ },
    { x: ex, z: midZ },
    { x: ex, z: ez },
  ];
}

function rebuildIngressLines() {
  if (state.ingressLines) {
    scene.remove(state.ingressLines);
    state.ingressLines.traverse((child) => {
      if (child.geometry) child.geometry.dispose();
      if (child.material) child.material.dispose();
    });
  }

  const group = new THREE.Group();
  group.userData = { type: 'ingressLines' };

  const lineY = PLATFORM_Y + PLATFORM_HEIGHT + 0.05;
  const lineMat = new THREE.LineBasicMaterial({
    color: 0xff8800,
    transparent: true,
    opacity: 0.35,
    depthWrite: false,
  });

  const nsMarkerCount = new Map();

  for (const ing of state.ingresses) {
    const ns = state.namespaces.get(ing.namespace);
    if (!ns || !ns.platWidth) continue;

    const targetServiceNames = new Set();
    if (ing.defaultBackend) targetServiceNames.add(ing.defaultBackend);
    for (const rule of ing.rules ?? []) {
      for (const p of rule.paths ?? []) {
        if (p.serviceName) targetServiceNames.add(p.serviceName);
      }
    }
    if (targetServiceNames.size === 0) continue;

    const targetPodMeshes = [];
    for (const svcName of targetServiceNames) {
      const svc = state.services.find(s => s.name === svcName && s.namespace === ing.namespace);
      if (!svc || !svc.selector || Object.keys(svc.selector).length === 0) continue;
      for (const [, podMesh] of ns.pods) {
        const pod = podMesh.userData.pod;
        if (pod && selectorMatchesLabels(svc.selector, pod.labels)) {
          targetPodMeshes.push(podMesh);
        }
      }
    }
    if (targetPodMeshes.length === 0) continue;

    // Marker on the platform, front-left corner
    const idx = nsMarkerCount.get(ing.namespace) ?? 0;
    nsMarkerCount.set(ing.namespace, idx + 1);
    const ml = {
      x: -ns.platWidth / 2 + 1 + idx * 2,
      z: ns.platDepth / 2 - 0.8,
    };

    const markerWorld = new THREE.Vector3(ml.x, lineY + 0.25, ml.z);
    ns.group.localToWorld(markerWorld);

    const markerGeo = new THREE.OctahedronGeometry(0.3, 0);
    const markerMat = new THREE.MeshStandardMaterial({
      color: 0xff8800,
      emissive: 0xff6600,
      emissiveIntensity: 0.4,
      transparent: true,
      opacity: 0.8,
    });
    const marker = new THREE.Mesh(markerGeo, markerMat);
    marker.position.copy(markerWorld);
    marker.userData = {
      type: 'ingress',
      ingress: ing,
      tooltipHTML: ingressTooltipHTML(ing),
    };
    group.add(marker);

    // Compute junction point: centroid X of target pods, Z slightly in front of pods
    let sumX = 0, sumZ = 0;
    for (const podMesh of targetPodMeshes) {
      sumX += podMesh.position.x;
      sumZ += podMesh.position.z;
    }
    const jx = sumX / targetPodMeshes.length;
    const jz = sumZ / targetPodMeshes.length;
    // Junction is offset toward the ingress marker (front of platform)
    const jzOffset = jz + (ml.z - jz) * 0.25;

    // Trunk line: ingress marker → junction point
    const trunkPath = orthogonalPath(ml.x, ml.z, jx, jzOffset);
    const trunkWorld = trunkPath.map(p => {
      const v = new THREE.Vector3(p.x, lineY, p.z);
      ns.group.localToWorld(v);
      return v;
    });
    if (trunkWorld.length >= 2) {
      const geo = new THREE.BufferGeometry().setFromPoints(trunkWorld);
      group.add(new THREE.Line(geo, lineMat.clone()));
    }

    // Branch lines: junction point → each pod
    for (const podMesh of targetPodMeshes) {
      const pl = { x: podMesh.position.x, z: podMesh.position.z };
      const branchPts = orthogonalPath(jx, jzOffset, pl.x, pl.z);
      const branchWorld = branchPts.map(p => {
        const v = new THREE.Vector3(p.x, lineY, p.z);
        ns.group.localToWorld(v);
        return v;
      });
      if (branchWorld.length >= 2) {
        const geo = new THREE.BufferGeometry().setFromPoints(branchWorld);
        group.add(new THREE.Line(geo, lineMat.clone()));
      }
    }
  }

  state.ingressLines = group;
  scene.add(group);
}

function ingressTooltipHTML(ing) {
  let html = `<div class="pod-name">${ing.name}</div>`;
  html += `<div class="pod-ns">${ing.namespace}</div>`;
  if (ing.ingressClassName) html += `<div>Class: ${ing.ingressClassName}</div>`;
  for (const rule of ing.rules ?? []) {
    const host = rule.host || '*';
    for (const p of rule.paths ?? []) {
      html += `<div style="opacity:0.7">${host}${p.path || '/'} → ${p.serviceName}:${p.servicePort}</div>`;
    }
  }
  if (ing.defaultBackend) html += `<div style="opacity:0.7">default → ${ing.defaultBackend}</div>`;
  return html;
}

// ── HUD Update ─────────────────────────────────────────────────
function updateHUD() {
  let pods = 0;
  for (const [, ns] of state.namespaces) pods += ns.pods.size;
  document.getElementById('ns-count').textContent = state.namespaces.size;
  document.getElementById('workload-count').textContent = state.workloads.size;
  document.getElementById('pod-count').textContent = pods;
  document.getElementById('node-count').textContent = state.nodes.size;
  document.getElementById('svc-count').textContent = state.services.length;
  document.getElementById('ingress-count').textContent = state.ingresses.length;
  updateProblemFilterUI();
}

// ── WebSocket ──────────────────────────────────────────────────
function connectWS() {
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
      // Clear existing
      for (const [name] of state.namespaces) removeNamespace(name);
      for (const ns of event.snapshot) {
        ensureNamespace(ns.name);
        for (const pod of ns.pods ?? []) {
          addOrUpdatePod(ns.name, pod);
        }
      }
      // Nodes
      state.nodes.clear();
      for (const node of event.nodes ?? []) {
        state.nodes.set(node.name, node);
      }
      // Workloads
      state.workloads.clear();
      for (const workload of event.workloads ?? []) {
        state.workloads.set(workloadKey(workload.namespace, workload.kind, workload.name), workload);
      }
      // Services
      state.services = event.services ?? [];
      // Ingresses
      state.ingresses = event.ingresses ?? [];
      layoutNamespaces();
      rebuildServiceLines();
      rebuildIngressLines();
      updateHUD();
      break;

    case 'pod_added':
    case 'pod_modified':
      addOrUpdatePod(event.namespace, event.pod);
      layoutNamespaces();
      rebuildServiceLines();
      rebuildIngressLines();
      updateHUD();
      break;

    case 'pod_deleted':
      removePod(event.namespace, event.pod.name);
      layoutNamespaces();
      rebuildServiceLines();
      rebuildIngressLines();
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

    case 'workloads_snapshot':
      state.workloads.clear();
      for (const workload of event.workloads ?? []) {
        state.workloads.set(workloadKey(workload.namespace, workload.kind, workload.name), workload);
      }
      layoutNamespaces();
      rebuildServiceLines();
      rebuildIngressLines();
      updateHUD();
      break;
  }
}

// ── Fly Camera Controller ──────────────────────────────────────
const velocity = new THREE.Vector3();
const euler = new THREE.Euler(0, 0, 0, 'YXZ');
const _camDir = new THREE.Vector3();
const keys = {};
let pointerLocked = false;

// Fly-to animation state
const flyTo = {
  active: false,
  startPos: new THREE.Vector3(),
  startQuat: new THREE.Quaternion(),
  endPos: new THREE.Vector3(),
  endQuat: new THREE.Quaternion(),
  progress: 0,
  duration: 1.4,
  targetResource: null,
};

function cancelFlyTo() {
  if (!flyTo.active && !spot.active) return;
  flyTo.active = false;
  euler.setFromQuaternion(camera.quaternion);
  fadeOutSpotlight();
}

function startFlyTo(nsName) {
  const island = nsName === '__nodes__' ? state.nodeIsland : state.namespaces.get(nsName);
  if (!island) return;

  // Fade out any existing spotlight before flying to new target
  fadeOutSpotlight();

  const worldPos = new THREE.Vector3();
  island.group.getWorldPosition(worldPos);

  flyTo.startPos.copy(camera.position);
  flyTo.startQuat.copy(camera.quaternion);
  flyTo.endPos.set(worldPos.x, worldPos.y + 10, worldPos.z + 12);

  // Compute end orientation: camera looking at the namespace center
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

// Smooth ease-in-out curve
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
        flyTo.targetResource = null;
      }
    }
  }
}

document.addEventListener('keydown', (e) => {
  // Omnisearch: Cmd/Ctrl+K or / or : (when not typing)
  if ((e.code === 'KeyK' && (e.metaKey || e.ctrlKey)) ||
      ((e.key === '/' || e.key === ':') && !searchOpen && document.activeElement === document.body)) {
    e.preventDefault();
    for (const k in keys) keys[k] = false;
    const prefix = e.key === ':' ? 'kind:' : e.key === '/' ? '/' : '';
    openSearch(prefix);
    return;
  }
  if (e.code === 'Escape' && searchOpen) { closeSearch(); return; }

  if (searchOpen) return;

  keys[e.code] = true;

  // Toggle Eagle Eye with E key
  if (e.code === 'KeyE' && !e.repeat) {
    toggleEagleEye();
    return;
  }

  // Cycle problem filters with F key
  if (e.code === 'KeyF' && !e.repeat) {
    const filters = [null, 'unhealthy', 'crashloop', 'unscheduled'];
    const idx = filters.indexOf(problemFilter.active);
    const next = filters[(idx + 1) % filters.length];
    problemFilter.active = next;
    updateProblemFilterUI();
    _lastDepthCamPos.set(Infinity, Infinity, Infinity);
    return;
  }

  const movement = ['KeyW','KeyS','KeyA','KeyD','ArrowUp','ArrowDown','ArrowLeft','ArrowRight','Space','ControlLeft','ControlRight'];
  if (movement.includes(e.code)) {
    // W/S zoom without cancelling the spotlight (other keys still dismiss it)
    if ((e.code === 'KeyW' || e.code === 'KeyS') && spot.active && !flyTo.active) return;
    cancelFlyTo();
  }
});
document.addEventListener('keyup', (e) => { keys[e.code] = false; });

function toggleEagleEye() {
  eagleEye.active = !eagleEye.active;

  if (eagleEye.active) {
    // Exit pointer lock when entering eagle eye
    if (pointerLocked) document.exitPointerLock();
    cancelFlyTo();

    // Center ortho camera over current perspective position
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

// Scroll-to-zoom in Eagle Eye mode
canvas.addEventListener('wheel', (e) => {
  if (!eagleEye.active) return;
  e.preventDefault();
  eagleEye.zoom = Math.max(10, Math.min(200, eagleEye.zoom + e.deltaY * 0.05));
  updateOrthoFrustum();
}, { passive: false });

function updateControlsHint() {
  const hint = document.getElementById('controls-hint');
  if (eagleEye.active) {
    hint.textContent = 'EAGLE EYE \u2022 WASD/Arrows: Pan \u2022 Scroll: Zoom \u2022 E: Exit';
  } else {
    hint.textContent = 'WASD/Arrows: Move \u00b7 Mouse: Look \u00b7 Shift: Fast \u00b7 Space/Ctrl: Up/Down \u00b7 Click: Lock cursor \u00b7 Esc: Unlock \u00b7 E: Eagle Eye \u00b7 /: Search';
  }
}

canvas.addEventListener('click', (e) => {
  if (pointerLocked || searchOpen) return;
  const clickMouse = new THREE.Vector2(
    (e.clientX / window.innerWidth) * 2 - 1,
    -(e.clientY / window.innerHeight) * 2 + 1,
  );
  const clickRay = new THREE.Raycaster();
  clickRay.setFromCamera(clickMouse, activeCamera());

  // Check for resource (pod / node block / ingress) clicks
  ensureRayTargets();
  const resHits = clickRay.intersectObjects(rayPodTargets);
  if (resHits.length > 0) {
    const resMesh = resHits[0].object;
    const resNs = resMesh.userData.type === 'pod'
      ? resMesh.userData.pod?.namespace
      : resMesh.userData.type === 'nodeBlock' ? '__nodes__'
      : resMesh.userData.type === 'ingress' ? resMesh.userData.ingress?.namespace
      : null;
    if (resNs) {
      if (selection.nsName === resNs) {
        // Island already selected — just spotlight the resource
        startResourceSpotlight(resMesh);
      } else {
        // Fly to the island first, then spotlight the resource on arrival
        if (eagleEye.active) toggleEagleEye();
        flyTo.targetResource = resMesh;
        startFlyTo(resNs);
      }
      return;
    }
  }

  // Phase 1: check for namespace / label clicks
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
      // Clicking the already-selected namespace: back to namespace phase if in resource, no-op if in namespace
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

  // Clicked empty space — deselect
  if (selection.phase !== 'none') {
    fadeOutSpotlight();
    return;
  }

  if (!eagleEye.active) canvas.requestPointerLock();
});

document.addEventListener('pointerlockchange', () => {
  pointerLocked = document.pointerLockElement === canvas;
});

let pendingMouseX = 0;
let pendingMouseY = 0;
let prevRawX = 0;
let prevRawY = 0;

// Firefox delivers integer-only movementX/Y during pointer lock with bursty
// frame-to-frame variance (e.g. -30, -70, -30 for constant mouse speed).
// We detect this and lower sensitivity to reduce the visual jitter magnitude.
let integerMouseDetected = false;
let mouseEventsSampled = 0;
const MOUSE_SAMPLE_COUNT = 20;
const SENSITIVITY_DEFAULT = 0.002;
const SENSITIVITY_INTEGER = 0.0013;
let mouseSensitivity = SENSITIVITY_DEFAULT;

document.addEventListener('mousemove', (e) => {
  if (!pointerLocked || searchOpen) return;
  cancelFlyTo();
  pendingMouseX += e.movementX;
  pendingMouseY += e.movementY;

  if (mouseEventsSampled < MOUSE_SAMPLE_COUNT) {
    if (e.movementX % 1 !== 0 || e.movementY % 1 !== 0) {
      integerMouseDetected = false;
      mouseEventsSampled = MOUSE_SAMPLE_COUNT;
      mouseSensitivity = SENSITIVITY_DEFAULT;
    } else {
      mouseEventsSampled++;
      if (mouseEventsSampled >= MOUSE_SAMPLE_COUNT) {
        integerMouseDetected = true;
        mouseSensitivity = SENSITIVITY_INTEGER;
      }
    }
  }
});

function updateMouseLook() {
  const rawX = pendingMouseX;
  const rawY = pendingMouseY;
  pendingMouseX = 0;
  pendingMouseY = 0;

  let dx, dy;
  if (integerMouseDetected) {
    // 2-frame conditional average: smooth steady-state jitter,
    // pass through raw on transitions for instant start/stop.
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

function updateCamera(dt) {
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

// ── Raycasting (hover tooltip) ─────────────────────────────────
const raycaster = new THREE.Raycaster();
const mouse = new THREE.Vector2();
let hoveredMesh = null;
let mouseDirty = false;
const tooltip = document.getElementById('tooltip');

// Cached raycast target lists — rebuilt only when the scene mutates
let rayNsTargets = [];
let rayPodTargets = [];
let rayTargetsDirty = true;

function invalidateRayTargets() { rayTargetsDirty = true; }

function ensureRayTargets() {
  if (!rayTargetsDirty) return;
  rayTargetsDirty = false;
  rayNsTargets = [];
  rayPodTargets = [];
  scene.traverse((obj) => {
    if (obj.userData.type === 'namespace' || obj.userData.type === 'label') rayNsTargets.push(obj);
    if (obj.isMesh && (obj.userData.type === 'pod' || obj.userData.type === 'nodeBlock' || obj.userData.type === 'ingress')) rayPodTargets.push(obj);
  });
}

document.addEventListener('mousemove', (e) => {
  if (pointerLocked) return;
  mouse.x = (e.clientX / window.innerWidth) * 2 - 1;
  mouse.y = -(e.clientY / window.innerHeight) * 2 + 1;
  mouseDirty = true;

  tooltip.style.left = (e.clientX + 16) + 'px';
  tooltip.style.top = (e.clientY + 16) + 'px';
});

function updateRaycast() {
  if (!mouseDirty) return;
  mouseDirty = false;

  ensureRayTargets();
  raycaster.setFromCamera(mouse, activeCamera());

  if (!pointerLocked) {
    const nsHits = raycaster.intersectObjects(rayNsTargets);
    let showPointer = nsHits.length > 0;
    if (!showPointer) {
      const resHits = raycaster.intersectObjects(rayPodTargets);
      showPointer = resHits.length > 0;
    }
    canvas.style.cursor = showPointer ? 'pointer' : 'default';
  }

  const intersects = raycaster.intersectObjects(rayPodTargets);

  if (hoveredMesh) {
    hoveredMesh.material.emissiveIntensity = 1;
    hoveredMesh = null;
  }

  if (intersects.length > 0) {
    hoveredMesh = intersects[0].object;
    hoveredMesh.material.emissiveIntensity = 3;

    if (hoveredMesh.userData.type === 'nodeBlock') {
      const node = hoveredMesh.userData.node;
      const statusClass = node.status === 'Ready' ? 'status-running' : 'status-error';
      tooltip.innerHTML = `
        <div class="pod-name">${node.name}</div>
        <div class="pod-ns">node</div>
        <div class="pod-status ${statusClass}">● ${node.status}</div>
        ${node.cpuCapacity ? `<div>CPU: ${node.cpuCapacity}m &middot; Mem: ${formatBytes(node.memoryCapacity)}</div>` : ''}
      `;
      tooltip.style.display = 'block';
    } else if (hoveredMesh.userData.type === 'ingress') {
      tooltip.innerHTML = hoveredMesh.userData.tooltipHTML;
      tooltip.style.display = 'block';
    } else {
      const pod = hoveredMesh.userData.pod;
      const owner = podWorkload(pod);
      const statusClass = pod.status === 'Running' ? 'status-running'
        : ['Pending', 'ContainerCreating', 'PodInitializing'].includes(pod.status) ? 'status-pending'
        : 'status-error';
      tooltip.innerHTML = `
        <div class="pod-name">${pod.name}</div>
        <div class="pod-ns">ns/${pod.namespace}${pod.nodeName ? ' · node/' + pod.nodeName : ''}</div>
        <div>${owner.kind}/${owner.name}</div>
        <div class="pod-status ${statusClass}">● ${pod.status}</div>
        <div>Ready: ${pod.ready ? 'YES' : 'NO'} &middot; Restarts: ${pod.restarts}</div>
        ${pod.cpuRequest || pod.memoryRequest ? `<div>CPU: ${pod.cpuRequest ? pod.cpuRequest + 'm' : '—'} &middot; Mem: ${pod.memoryRequest ? formatBytes(pod.memoryRequest) : '—'}</div>` : ''}
        <div>Age: ${pod.age}</div>
      `;
      tooltip.style.display = 'block';
    }
  } else {
    tooltip.style.display = 'none';
  }
}

// ── Pod animation ──────────────────────────────────────────────
function animatePods(time) {
  for (const [, ns] of state.namespaces) {
    let i = 0;
    for (const [, mesh] of ns.pods) {
      const pod = mesh.userData.pod;
      const h = mesh.geometry.parameters.height || POD_BASE_SIZE;
      if (pod && pod.status === 'Running') {
        mesh.position.y = h / 2 + Math.sin(time * 2 + i * 0.5) * 0.05;
      } else if (pod && (pod.status === 'CrashLoopBackOff' || pod.status === 'Error')) {
        mesh.position.y = h / 2 + Math.sin(time * 8 + i) * 0.15;
      }
      i++;
    }
  }
}

// ── Depth transparency ─────────────────────────────────────────
const DEPTH_FADE_START = 30;
const DEPTH_FADE_END = 120;
const DEPTH_MIN_OPACITY = 0.1;

const BASE_PLATFORM_OPACITY = 0.85;
const BASE_POD_OPACITY = 0.9;
const BASE_LABEL_OPACITY = 0.9;

function depthOpacityFactor(distance) {
  if (distance <= DEPTH_FADE_START) return 1;
  if (distance >= DEPTH_FADE_END) return DEPTH_MIN_OPACITY;
  const t = (distance - DEPTH_FADE_START) / (DEPTH_FADE_END - DEPTH_FADE_START);
  return 1 - t * (1 - DEPTH_MIN_OPACITY);
}

const _depthTmpVec = new THREE.Vector3();
const _lastDepthCamPos = new THREE.Vector3(Infinity, Infinity, Infinity);

function updateDepthTransparency() {
  const camPos = activeCamera().position;

  // Skip if camera hasn't moved meaningfully
  if (_lastDepthCamPos.distanceToSquared(camPos) < 0.01) return;
  _lastDepthCamPos.copy(camPos);

  const pf = problemFilter.active;

  for (const [, ns] of state.namespaces) {
    ns.group.getWorldPosition(_depthTmpVec);
    const dist = eagleEye.active ? 0 : camPos.distanceTo(_depthTmpVec);
    const f = depthOpacityFactor(dist);

    if (ns.platform) ns.platform.material.opacity = BASE_PLATFORM_OPACITY * f;
    if (ns.label) ns.label.material.opacity = BASE_LABEL_OPACITY * f;

    for (const [, mesh] of ns.pods) {
      const dimmed = pf && !podMatchesFilter(mesh.userData.pod, pf);
      mesh.material.opacity = (dimmed ? 0.06 : BASE_POD_OPACITY) * f;
    }
  }

  // Node island
  if (state.nodeIsland) {
    state.nodeIsland.group.getWorldPosition(_depthTmpVec);
    const dist = eagleEye.active ? 0 : camPos.distanceTo(_depthTmpVec);
    const f = depthOpacityFactor(dist);
    if (state.nodeIsland.platform) state.nodeIsland.platform.material.opacity = BASE_PLATFORM_OPACITY * f;
    if (state.nodeIsland.label) state.nodeIsland.label.material.opacity = BASE_LABEL_OPACITY * f;
    for (const [, mesh] of state.nodeIsland.blocks) {
      const node = mesh.userData.node;
      const dimmed = pf && !nodeMatchesFilter(node, pf);
      mesh.material.opacity = (dimmed ? 0.06 : BASE_POD_OPACITY) * f;
    }
  }
}

// ── Resize ─────────────────────────────────────────────────────
window.addEventListener('resize', () => {
  camera.aspect = window.innerWidth / window.innerHeight;
  camera.updateProjectionMatrix();
  updateOrthoFrustum();
  renderer.setSize(window.innerWidth, window.innerHeight);
  composer.setSize(window.innerWidth, window.innerHeight);
});

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

function updateDebugOverlay(dt, renderMs) {
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
    (integerMouseDetected ? '  [int-mouse]' : '');
}

// ── Omnisearch ─────────────────────────────────────────────────
const searchOverlay = document.getElementById('search-overlay');
const searchInput = document.getElementById('search-input');
const searchResultsEl = document.getElementById('search-results');

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

function openSearch(prefix = '') {
  if (searchOpen) return;
  searchOpen = true;
  searchOverlay.classList.add('active');
  searchInput.value = prefix;
  searchResultsEl.innerHTML = '';
  searchSelectedIdx = -1;
  searchLastMatches = [];
  searchItems = buildSearchIndex();
  searchInput.focus();
  if (pointerLocked) document.exitPointerLock();
  renderCompletions();
  renderSearchResults(prefix);
}

function closeSearch() {
  if (!searchOpen) return;
  searchOpen = false;
  searchOverlay.classList.remove('active');
  searchHintEl.classList.remove('active');
  hideCompletions();
  searchInput.blur();
}

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

const searchHintEl = document.getElementById('search-hint');

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
    // Fly to specific resource (pod or node block)
    const resNs = item.ns;
    flyTo.targetResource = item.mesh;
    startFlyTo(resNs);
  } else if (item.kind === 'workload') {
    // Fly to namespace, then find first pod of this workload
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
  } else {
    // Namespace or fallback
    startFlyTo(item.ns);
  }
}

// ── Autocomplete ──────────────────────────────────────────────
const searchCompletionsEl = document.getElementById('search-completions');
const searchGhostEl = document.getElementById('search-ghost');
let acItems = [];
let acSelectedIdx = -1;
let acActive = false;

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
];

function getCompletionContext(text, cursorPos) {
  const before = text.slice(0, cursorPos);
  const lastSpace = before.lastIndexOf(' ');
  const currentToken = before.slice(lastSpace + 1);
  const prefix = before.slice(0, lastSpace + 1);

  if (!currentToken) return null;

  const lower = currentToken.toLowerCase();

  // Typing a filter prefix like "ki" → suggest "kind:"
  for (const fp of FILTER_PREFIXES) {
    if (fp.startsWith(lower) && lower !== fp && lower.length >= 2) {
      return { type: 'prefix', partial: lower, prefix };
    }
  }

  if (lower.startsWith('kind:') || lower.startsWith('type:')) {
    const val = lower.split(':')[1];
    return { type: 'kind', partial: val, prefix, tokenPrefix: currentToken.split(':')[0] + ':' };
  }
  if (lower.startsWith('ns:') || lower.startsWith('namespace:')) {
    const val = lower.split(':').slice(1).join(':');
    return { type: 'ns', partial: val, prefix, tokenPrefix: currentToken.split(':')[0] + ':' };
  }
  if (lower.startsWith('status:')) {
    const val = lower.split(':')[1];
    return { type: 'status', partial: val, prefix, tokenPrefix: 'status:' };
  }
  if (lower.startsWith('node:')) {
    const val = lower.split(':')[1];
    return { type: 'node', partial: val, prefix, tokenPrefix: 'node:' };
  }
  if (lower === '-l' || (lower.startsWith('-l') && lower.length >= 2)) {
    const val = lower.length > 2 ? currentToken.slice(2) : '';
    return { type: 'label', partial: val, prefix, tokenPrefix: '-l' };
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

  if (frameCount & 1) {
    animatePods(time);
  }

  // Slowly rotate point light
  pointLight.position.x = Math.sin(time * 0.3) * 20;
  pointLight.position.z = Math.cos(time * 0.3) * 20;

  const renderStart = performance.now();
  composer.render();
  updateDebugOverlay(dt, performance.now() - renderStart);
}

// ── Boot ───────────────────────────────────────────────────────
animate();
connectWS();
