import * as THREE from 'three';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/addons/postprocessing/UnrealBloomPass.js';

// ── State ──────────────────────────────────────────────────────
const state = {
  namespaces: new Map(), // name -> { group, platform, pods: Map<name, mesh>, label }
  nodes: new Map(),      // name -> NodeInfo
  nodeIsland: null,      // { group, platform, blocks: Map<name, mesh>, label }
  services: [],          // [{name, namespace, type, clusterIP, selector}]
  serviceLines: null,    // THREE.Group holding connection lines
  ingresses: [],         // [{name, namespace, rules}]
  ingressGroup: null,    // THREE.Group for ingress visuals
  pvcs: [],              // [{name, namespace, status, capacity}]
  pvcGroup: null,        // THREE.Group for PVC disks
  workloads: [],         // [{name, namespace, kind, replicas, readyReplicas}]
  workloadGroup: null,   // THREE.Group for workload group outlines + labels
  resources: [],         // [{name, namespace, kind, data}]
  resourceGroup: null,   // THREE.Group for generic resource markers
};

// Layer visibility
const layers = {
  services: true,
  ingresses: true,
  pvcs: true,
  workloads: true,
  forbidden: true,
  nodes: true,
  configmaps: false,
  secrets: false,
  serviceaccounts: false,
  hpa: false,
  networkpolicies: false,
  pdb: false,
  replicasets: false,
  rbac: false,
  'other-resources': false,
};

const PLATFORM_GAP = 12;
const POD_BASE_SIZE = 0.7;
const POD_MIN_SIZE = 0.5;
const POD_MAX_SIZE = 1.8;
const POD_GAP = 1.5;
const POD_STRIDE = POD_MAX_SIZE + POD_GAP;
const PLATFORM_Y = 0;
const PLATFORM_HEIGHT = 0.3;
const LABEL_Y_OFFSET = 0.5;
const NODE_BLOCK_SIZE = 1.2;

// Layer heights — stacking order from bottom to top
const WORKLOAD_Y = PLATFORM_HEIGHT;          // workload outlines sit on top of platform
const WORKLOAD_BOX_HEIGHT = PLATFORM_HEIGHT; // same thickness as namespace platform
const PVC_Y = WORKLOAD_Y + WORKLOAD_BOX_HEIGHT + 0.05; // PVCs on top of workload
const POD_Y_OFFSET = WORKLOAD_Y + WORKLOAD_BOX_HEIGHT + 0.15; // pods on top of workload layer

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

// ── Scene Setup ────────────────────────────────────────────────
const canvas = document.getElementById('canvas');
const renderer = new THREE.WebGLRenderer({ canvas, antialias: true });
renderer.setPixelRatio(window.devicePixelRatio);
renderer.setSize(window.innerWidth, window.innerHeight);
renderer.setClearColor(0x020202);
renderer.localClippingEnabled = true;

const scene = new THREE.Scene();
scene.fog = new THREE.FogExp2(0x020202, 0.003);

const camera = new THREE.PerspectiveCamera(70, window.innerWidth / window.innerHeight, 0.1, 5000);
camera.position.set(0, 12, 25);
camera.lookAt(0, 0, 0);

// Eagle Eye: overhead orthographic camera
const ORTHO_DEFAULT_ZOOM = 60;
const orthoCamera = (() => {
  const aspect = window.innerWidth / window.innerHeight;
  const half = ORTHO_DEFAULT_ZOOM / 2;
  return new THREE.OrthographicCamera(
    -half * aspect, half * aspect, half, -half, 0.1, 5000,
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
const bloom = new UnrealBloomPass(new THREE.Vector2(window.innerWidth, window.innerHeight), 0.6, 0.4, 0.85);
composer.addPass(bloom);

// Horizon gradient sky (Jurassic Park FSN style)
// Use a very large radius so the sphere is never perceived as a dome
const skyGeo = new THREE.SphereGeometry(4000, 32, 32);
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
      // Match fog/clear color exactly to avoid visible sphere edge
      vec3 bg    = vec3(0.008, 0.008, 0.008);
      vec3 green = vec3(0.03, 0.18, 0.08);

      vec3 col;
      if (h > 0.0) {
        // Very narrow horizon glow that fades quickly to background
        float t = smoothstep(0.0, 0.04, h);
        col = mix(green, bg, t);
      } else {
        col = bg;
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

// Spotlight animation state
const spot = {
  active: false,
  fadingIn: false,
  fadingOut: false,
  intensity: 0,
  beamOpacity: 0,
  glowOpacity: 0,
  targetIntensity: 60,
  targetBeamOpacity: 0.03,
  targetGlowOpacity: 0.09,
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

  const sourcePos = wp.clone().add(BEAM_SOURCE_OFFSET);
  spotlight.position.copy(sourcePos);
  spotlight.target.position.copy(wp);

  // Extend cone generously past ground — a clipping plane at ground level
  // will cut it cleanly. The base circle is perpendicular to the tilted beam
  // axis, so it must overshoot to cover the full ground footprint.
  const coneEnd = wp.clone();
  const beamDir = new THREE.Vector3().subVectors(coneEnd, sourcePos).normalize();
  const sinTilt = Math.sqrt(beamDir.x * beamDir.x + beamDir.z * beamDir.z);
  const overshoot = (BEAM_BOT_RADIUS * sinTilt / Math.abs(beamDir.y)) * 1.5;
  coneEnd.addScaledVector(beamDir, overshoot);

  beamClipPlane.set(new THREE.Vector3(0, 1, 0), -wp.y);

  const dist = sourcePos.distanceTo(coneEnd);
  beamCone.scale.set(1, dist, 1);
  const mid = sourcePos.clone().add(coneEnd).multiplyScalar(0.5);
  beamCone.position.copy(mid);
  const upDir = new THREE.Vector3().subVectors(sourcePos, coneEnd).normalize();
  beamCone.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), upDir);

  // Shape the glow disc to match the cone's elliptical ground footprint.
  // The cone radius at ground level is smaller than BEAM_BOT_RADIUS (base is
  // below ground due to overshoot), and the tilt stretches it into an ellipse.
  const distToGround = sourcePos.distanceTo(wp);
  const tParam = distToGround / dist;
  const rGround = BEAM_TOP_RADIUS + (BEAM_BOT_RADIUS - BEAM_TOP_RADIUS) * tParam;
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
  positionSpotlight(nsName);
  beamCone.visible = true;
  glowDisc.visible = true;
  spot.fadingIn = true;
  spot.fadingOut = false;
  spot.active = true;
  showPodLabels(nsName);
}

function fadeOutSpotlight() {
  if (!spot.active && !spot.fadingOut) return;
  spot.fadingIn = false;
  spot.fadingOut = true;
}

function updateSpotlight(dt) {
  if (spot.fadingIn) {
    spot.intensity = Math.min(spot.intensity + spot.fadeSpeed * dt * spot.targetIntensity, spot.targetIntensity);
    spot.beamOpacity = Math.min(spot.beamOpacity + spot.fadeSpeed * dt * spot.targetBeamOpacity, spot.targetBeamOpacity);
    spot.glowOpacity = Math.min(spot.glowOpacity + spot.fadeSpeed * dt * spot.targetGlowOpacity, spot.targetGlowOpacity);
    ambient.intensity = Math.max(ambient.intensity - spot.fadeSpeed * dt * (BASE_AMBIENT - DIM_AMBIENT), DIM_AMBIENT);
    if (spot.intensity >= spot.targetIntensity) spot.fadingIn = false;
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
      const nodeInfo = state.nodes.get(nodeName);
      const nodeColor = nodeInfo && nodeInfo.status === 'Ready' ? '#44ccee' : '#ff6666';
      const label = makeLabel(nodeName, 48, nodeColor, { billboard: true });
      label.scale.set(0.14, 0.14, 0.14);
      label.position.set(blockMesh.position.x, 1.2, blockMesh.position.z);
      label.material.opacity = 0;
      island.group.add(label);
      spot.podLabels.push({ mesh: label, group: island.group });
    }
    return;
  }

  const ns = state.namespaces.get(nsName);
  if (!ns) return;
  for (const [podName, podMesh] of ns.pods) {
    const pod = podMesh.userData.pod;
    const podColor = pod ? '#' + new THREE.Color(statusColor(pod.status)).getHexString() : '#00ff88';
    const label = makeLabel(podName, 48, podColor, { billboard: true });
    label.scale.set(0.14, 0.14, 0.14);
    label.position.set(podMesh.position.x, podMesh.position.y + 1.0, podMesh.position.z);
    label.material.opacity = 0;
    ns.group.add(label);
    spot.podLabels.push({ mesh: label, group: ns.group });
  }
}

function clearPodLabels() {
  for (const { mesh, group } of spot.podLabels) {
    group.remove(mesh);
    mesh.geometry.dispose();
    mesh.material.map?.dispose();
    mesh.material.dispose();
  }
  spot.podLabels = [];
  _billboardCacheDirty = true;
}

// Solid black ground plane
const groundGeo = new THREE.PlaneGeometry(600, 600);
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

const forbiddenPlatformMaterial = new THREE.MeshPhongMaterial({
  color: 0x111111,
  emissive: 0x000000,
  shininess: 10,
  transparent: true,
  opacity: 0.6,
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

// ── Text Labels (canvas texture → flat on ground or billboard) ──
function makeLabel(text, fontSize = 64, color = '#00ff88', { billboard = false } = {}) {
  const padding = 14;
  const cvs = document.createElement('canvas');
  const ctx = cvs.getContext('2d');
  const fontStr = `${fontSize}px 'Share Tech Mono', monospace`;
  ctx.font = fontStr;
  const metrics = ctx.measureText(text);
  cvs.width = Math.ceil(metrics.width) + padding * 2;
  cvs.height = fontSize + padding * 2;
  // Dark background for contrast
  ctx.fillStyle = 'rgba(0, 8, 4, 0.75)';
  ctx.fillRect(0, 0, cvs.width, cvs.height);
  // Border
  ctx.strokeStyle = color;
  ctx.globalAlpha = 0.3;
  ctx.lineWidth = 2;
  ctx.strokeRect(1, 1, cvs.width - 2, cvs.height - 2);
  ctx.globalAlpha = 1;
  // Text
  ctx.font = fontStr;
  ctx.fillStyle = color;
  ctx.shadowColor = color;
  ctx.shadowBlur = 8;
  ctx.fillText(text, padding, fontSize + padding / 2);
  const texture = new THREE.CanvasTexture(cvs);
  texture.minFilter = THREE.LinearFilter;
  const aspect = cvs.width / cvs.height;
  const scaleFactor = fontSize / 64;
  const planeH = 2.5 * scaleFactor;
  const planeW = aspect * planeH;
  const geo = new THREE.PlaneGeometry(planeW, planeH);
  const mat = new THREE.MeshBasicMaterial({
    map: texture,
    transparent: true,
    opacity: 0.9,
    depthWrite: false,
    side: THREE.DoubleSide,
  });
  const mesh = new THREE.Mesh(geo, mat);
  if (billboard) {
    // Billboard labels are updated each frame to face the camera
    mesh.userData = { type: 'label', billboard: true };
  } else {
    mesh.rotation.x = -Math.PI / 2; // lay flat on ground
    mesh.userData = { type: 'label' };
  }
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

// ── Pod geometry by owner kind ─────────────────────────────────
// Shared pod geometries — created once, reused for all pods of same type
const _sharedGeo = {
  box: new THREE.BoxGeometry(POD_BASE_SIZE, POD_BASE_SIZE, POD_BASE_SIZE),
  cylinder: new THREE.CylinderGeometry(POD_BASE_SIZE * 0.5, POD_BASE_SIZE * 0.5, POD_BASE_SIZE, 6),
  octahedron: new THREE.OctahedronGeometry(POD_BASE_SIZE * 0.5),
  cone: new THREE.ConeGeometry(POD_BASE_SIZE * 0.45, POD_BASE_SIZE, 5),
};

function podGeometry(ownerKind) {
  switch (ownerKind) {
    case 'StatefulSet':  return _sharedGeo.cylinder;
    case 'DaemonSet':    return _sharedGeo.octahedron;
    case 'Job':
    case 'CronJob':      return _sharedGeo.cone;
    default:             return _sharedGeo.box;
  }
}

// Container count rings around a pod mesh
function addContainerRings(parentGroup, mesh, containerCount, podColor) {
  // Remove old rings
  const oldRings = parentGroup.children.filter(c => c.userData._ringFor === mesh.uuid);
  for (const r of oldRings) {
    parentGroup.remove(r);
    r.geometry.dispose();
    r.material.dispose();
  }
  if (containerCount <= 1) return;

  const bbox = new THREE.Box3().setFromObject(mesh);
  const size = new THREE.Vector3();
  bbox.getSize(size);
  const baseRadius = Math.max(size.x, size.z) * 0.55;

  for (let i = 1; i < containerCount; i++) {
    const ringRadius = baseRadius + i * 0.15;
    const ringGeo = new THREE.TorusGeometry(ringRadius, 0.03, 6, 24);
    const ringMat = new THREE.MeshBasicMaterial({
      color: podColor,
      transparent: true,
      opacity: 0.6,
      depthWrite: false,
    });
    const ring = new THREE.Mesh(ringGeo, ringMat);
    ring.rotation.x = Math.PI / 2;
    ring.position.copy(mesh.position);
    ring.position.y = 0.05 + i * 0.12;
    ring.userData = { _ringFor: mesh.uuid };
    parentGroup.add(ring);
  }
}

// ── Namespace Layout ───────────────────────────────────────────
function layoutNamespaces() {
  // Build the node island first so we can include it in the grid
  if (state.nodes.size > 0) {
    rebuildNodeIsland();
    layoutNodeIsland();
  }

  // Collect all islands: node island (if any) + namespace groups
  const entries = []; // { group, platWidth, platDepth }
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
    const podCount = ns.pods.size;
    const podCols = Math.max(2, Math.ceil(Math.sqrt(podCount)));
    const podRows = Math.max(1, Math.ceil(podCount / podCols));
    const platWidth = podCols * POD_STRIDE + 2;
    const platDepth = podRows * POD_STRIDE + 2;
    entries.push({ group: ns.group, platWidth, platDepth, nsName });
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

    // Rebuild platform geometry
    if (ns.platform) {
      ns.platform.material.dispose();
      ns.group.remove(ns.platform);
    }
    const platGeo = makeBeveledPlatformGeo(entry.platWidth, PLATFORM_HEIGHT, entry.platDepth);
    const mat = ns.forbidden ? forbiddenPlatformMaterial.clone() : platformMaterial.clone();
    ns.platform = new THREE.Mesh(platGeo, mat);
    ns.platform.position.y = -PLATFORM_HEIGHT / 2;
    ns.platform.userData = { type: 'namespace', name: entry.nsName };
    ns.group.add(ns.platform);

    // Reposition label
    if (ns.label) ns.group.remove(ns.label);
    ns.label = ns.forbidden
      ? makeLabel(entry.nsName.toUpperCase(), 64, '#666666')
      : makeLabel(entry.nsName.toUpperCase(), 64, '#cc6699');
    ns.label.position.set(0, 0.15, entry.platDepth / 2 + 2);
    ns.group.add(ns.label);

    // Lay out pods
    const podCols = Math.max(2, Math.ceil(Math.sqrt(ns.pods.size)));
    const podRows = Math.max(1, Math.ceil(ns.pods.size / podCols));
    let idx = 0;
    for (const [, podMesh] of ns.pods) {
      const pc = idx % podCols;
      const pr = Math.floor(idx / podCols);
      const h = podMesh.geometry.parameters.height || POD_BASE_SIZE;
      podMesh.position.set(
        pc * POD_STRIDE - (podCols * POD_STRIDE) / 2 + POD_STRIDE / 2,
        POD_Y_OFFSET + h / 2,
        pr * POD_STRIDE - (podRows * POD_STRIDE) / 2 + POD_STRIDE / 2
      );
      idx++;
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
  invalidateMeshCache();
}

// ── Namespace/Pod Management ───────────────────────────────────
function ensureNamespace(name, forbidden = false) {
  if (state.namespaces.has(name)) {
    const ns = state.namespaces.get(name);
    ns.forbidden = ns.forbidden || forbidden;
    return ns;
  }
  const group = new THREE.Group();
  group.userData = { type: 'namespace', name };
  scene.add(group);
  const ns = { group, platform: null, pods: new Map(), label: null, forbidden, wireframe: null, platWidth: 0, platDepth: 0 };
  state.namespaces.set(name, ns);
  return ns;
}

function addOrUpdatePod(nsName, pod) {
  const ns = ensureNamespace(nsName);

  const w = podWidth(pod.cpuRequest);
  const d = podDepth(pod.memoryRequest);
  const height = POD_BASE_SIZE + Math.min(pod.restarts * 0.15, 2);
  const sx = w / POD_BASE_SIZE;
  const sy = height / POD_BASE_SIZE;
  const sz = d / POD_BASE_SIZE;

  if (ns.pods.has(pod.name)) {
    const existing = ns.pods.get(pod.name);
    existing.material.dispose();
    existing.material = podMaterial(pod.status);
    existing.geometry = podGeometry(pod.ownerKind);
    existing.scale.set(sx, sy, sz);
    existing.userData = { type: 'pod', pod };
    addContainerRings(ns.group, existing, pod.containerCount || 1, statusColor(pod.status));
    return;
  }

  const geo = podGeometry(pod.ownerKind);
  const mat = podMaterial(pod.status);
  const mesh = new THREE.Mesh(geo, mat);
  mesh.scale.set(sx, sy, sz);
  mesh.userData = { type: 'pod', pod };
  ns.pods.set(pod.name, mesh);
  ns.group.add(mesh);
  addContainerRings(ns.group, mesh, pod.containerCount || 1, statusColor(pod.status));
  invalidateMeshCache();
}

function removePod(nsName, podName) {
  const ns = state.namespaces.get(nsName);
  if (!ns) return;
  const mesh = ns.pods.get(podName);
  if (mesh) {
    // Remove container rings
    const rings = ns.group.children.filter(c => c.userData._ringFor === mesh.uuid);
    for (const r of rings) {
      ns.group.remove(r);
      r.geometry.dispose();
      r.material.dispose();
    }
    ns.group.remove(mesh);
    // geometry is shared — don't dispose it
    mesh.material.dispose();
    ns.pods.delete(podName);
    invalidateMeshCache();
  }
}

function removeNamespace(name) {
  const ns = state.namespaces.get(name);
  if (!ns) return;
  for (const [, mesh] of ns.pods) {
    // geometry is shared — don't dispose it
    mesh.material.dispose();
  }
  if (ns.platform) ns.platform.material.dispose();
  if (ns.wireframe) ns.wireframe.material.dispose();
  scene.remove(ns.group);
  state.namespaces.delete(name);
}

// ── Node Island ────────────────────────────────────────────────
function ensureNodeIsland() {
  if (state.nodeIsland) return state.nodeIsland;
  const group = new THREE.Group();
  group.userData = { type: 'namespace', name: '__nodes__' };
  scene.add(group);
  state.nodeIsland = { group, platform: null, blocks: new Map(), label: null };
  return state.nodeIsland;
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
    island.platform.material.dispose();
    island.group.remove(island.platform);
  }
  const platGeo = makeBeveledPlatformGeo(platWidth, PLATFORM_HEIGHT, platDepth);
  island.platform = new THREE.Mesh(platGeo, nodePlatformMaterial.clone());
  island.platform.position.y = -PLATFORM_HEIGHT / 2;
  island.platform.userData = { type: 'namespace', name: '__nodes__' };
  island.group.add(island.platform);

  // Rebuild label
  if (island.label) island.group.remove(island.label);
  island.label = makeLabel('NODES', 64, '#5599bb');
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

// Resolve URLs for a pod: Ingress → Service → Pod chain
function podURLs(pod) {
  if (!pod || !pod.labels) return [];
  const urls = [];
  // Find services that select this pod
  const matchedSvcs = state.services.filter(
    s => s.namespace === pod.namespace && selectorMatchesLabels(s.selector, pod.labels)
  );
  // Find ingresses that target those services
  for (const ing of state.ingresses) {
    for (const rule of ing.rules || []) {
      if (!rule.serviceName) continue;
      const targetNs = rule.serviceNamespace || ing.namespace;
      if (targetNs !== pod.namespace) continue;
      if (matchedSvcs.some(s => s.name === rule.serviceName)) {
        const proto = 'https://';
        const host = rule.host || '';
        const path = rule.path && rule.path !== '/' ? rule.path : '';
        if (host) {
          urls.push(proto + host + path);
        }
      }
    }
  }
  return [...new Set(urls)]; // deduplicate
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
  invalidateMeshCache();
  applyLayerVisibility();
}

// ── Ingress Rendering ───────────────────────────────────────────
function rebuildIngresses() {
  if (state.ingressGroup) {
    scene.remove(state.ingressGroup);
    state.ingressGroup.traverse((child) => {
      if (child.geometry) child.geometry.dispose();
      if (child.material) child.material.dispose();
    });
  }

  const group = new THREE.Group();
  group.userData = { type: 'ingressGroup' };

  // Group ingresses by namespace — one gate per namespace
  const ingressesByNs = new Map();
  for (const ing of state.ingresses) {
    const list = ingressesByNs.get(ing.namespace) || [];
    list.push(ing);
    ingressesByNs.set(ing.namespace, list);
  }

  for (const [nsName, nsIngresses] of ingressesByNs) {
    const ns = state.namespaces.get(nsName);
    if (!ns || !ns.platform) continue;

    const platGeo = ns.platform.geometry;
    const platW = platGeo.parameters.width || 4;
    const nsWorldPos = new THREE.Vector3();
    ns.group.getWorldPosition(nsWorldPos);

    // Single arch per namespace
    const archX = nsWorldPos.x - platW / 2 - 1.5;
    const archZ = nsWorldPos.z;
    const archColor = 0xffaa00;
    const postMat = new THREE.MeshBasicMaterial({ color: archColor, transparent: true, opacity: 0.6 });
    const archData = { type: 'ingressArch', namespace: nsName, ingresses: nsIngresses };

    // Left post
    const postGeo = new THREE.BoxGeometry(0.1, 2.5, 0.1);
    const leftPost = new THREE.Mesh(postGeo, postMat.clone());
    leftPost.position.set(archX, 1.25, archZ - 0.8);
    leftPost.userData = archData;
    group.add(leftPost);

    // Right post
    const rightPost = new THREE.Mesh(postGeo.clone(), postMat.clone());
    rightPost.position.set(archX, 1.25, archZ + 0.8);
    rightPost.userData = archData;
    group.add(rightPost);

    // Top bar — wider for easier clicking
    const barGeo = new THREE.BoxGeometry(0.3, 0.3, 1.7);
    const bar = new THREE.Mesh(barGeo, postMat.clone());
    bar.position.set(archX, 2.5, archZ);
    bar.userData = archData;
    group.add(bar);

    // Count label above arch
    const routeCount = nsIngresses.reduce((n, ing) => n + (ing.rules || []).length, 0);
    const label = makeLabel(`${nsIngresses.length} ING · ${routeCount} routes`, 28, '#ffaa00', { billboard: true });
    label.scale.set(0.3, 0.3, 0.3);
    label.position.set(archX, 3.0, archZ);
    group.add(label);

    // Lines from arch to target services' pods
    for (const ing of nsIngresses) {
      for (const rule of ing.rules || []) {
        if (!rule.serviceName) continue;
        const targetNs = rule.serviceNamespace || ing.namespace;
        const svc = state.services.find(s => s.name === rule.serviceName && s.namespace === targetNs);
        if (!svc || !svc.selector) continue;

        const targetNsState = state.namespaces.get(targetNs);
        if (!targetNsState) continue;
        for (const [, podMesh] of targetNsState.pods) {
          const pod = podMesh.userData.pod;
          if (!pod || !selectorMatchesLabels(svc.selector, pod.labels)) continue;

          const podWorld = new THREE.Vector3();
          podMesh.getWorldPosition(podWorld);
          const archPos = new THREE.Vector3(archX, 2.0, archZ);
          const mid = archPos.clone().add(podWorld).multiplyScalar(0.5);
          mid.y += 1.5;

          const curve = new THREE.QuadraticBezierCurve3(archPos, mid, podWorld);
          const points = curve.getPoints(16);
          const lineGeo = new THREE.BufferGeometry().setFromPoints(points);
          const lineMat = new THREE.LineBasicMaterial({
            color: archColor,
            transparent: true,
            opacity: 0.2,
            depthWrite: false,
          });
          group.add(new THREE.Line(lineGeo, lineMat));
        }
      }
    }
  }

  state.ingressGroup = group;
  scene.add(group);
  invalidateMeshCache();
  applyLayerVisibility();
}

// ── PVC Rendering ───────────────────────────────────────────────
function rebuildPVCs() {
  if (state.pvcGroup) {
    scene.remove(state.pvcGroup);
    state.pvcGroup.traverse((child) => {
      if (child.geometry) child.geometry.dispose();
      if (child.material) child.material.dispose();
    });
  }

  const group = new THREE.Group();
  group.userData = { type: 'pvcGroup' };

  for (const pvc of state.pvcs) {
    const ns = state.namespaces.get(pvc.namespace);
    if (!ns) continue;

    // Find pods that reference this PVC
    for (const [, podMesh] of ns.pods) {
      const pod = podMesh.userData.pod;
      if (!pod || !pod.pvcNames || !pod.pvcNames.includes(pvc.name)) continue;

      const podWorld = new THREE.Vector3();
      podMesh.getWorldPosition(podWorld);

      // Disk beneath the pod
      const radius = 0.45;
      const diskGeo = new THREE.CylinderGeometry(radius, radius, 0.12, 16);
      const diskColor = pvc.status === 'Bound' ? 0x8844cc
        : pvc.status === 'Pending' ? 0xffcc00
        : 0xff4444;
      const diskMat = new THREE.MeshPhongMaterial({
        color: diskColor,
        emissive: new THREE.Color(diskColor).multiplyScalar(0.3),
        transparent: true,
        opacity: 0.7,
      });
      const disk = new THREE.Mesh(diskGeo, diskMat);
      disk.position.set(podWorld.x, PVC_Y, podWorld.z);
      disk.userData = { type: 'pvc', pvc, podName: pod.name };
      group.add(disk);
    }
  }

  state.pvcGroup = group;
  scene.add(group);
  applyLayerVisibility();
}

// ── Workload Group Rendering ────────────────────────────────────
function rebuildWorkloadGroups() {
  if (state.workloadGroup) {
    scene.remove(state.workloadGroup);
    state.workloadGroup.traverse((child) => {
      if (child.geometry) child.geometry.dispose();
      if (child.material) child.material.dispose();
    });
  }

  const group = new THREE.Group();
  group.userData = { type: 'workloadGroup' };

  const WL_ABBREV = { Deployment: 'deploy', StatefulSet: 'sts', DaemonSet: 'ds', CronJob: 'cj', Job: 'job' };
  const WL_COLORS = { Deployment: 0x00ff88, StatefulSet: 0x00aaff, DaemonSet: 0x44ccaa, CronJob: 0xffaa00, Job: 0xffcc66 };

  // For CronJobs, pods are owned by Jobs (not CronJobs directly).
  const cronJobToJobs = new Map();
  for (const wl of state.workloads) {
    if (wl.kind === 'Job') {
      for (const cjWl of state.workloads) {
        if (cjWl.kind === 'CronJob' && cjWl.namespace === wl.namespace && wl.name.startsWith(cjWl.name + '-')) {
          if (!cronJobToJobs.has(cjWl.namespace + '/' + cjWl.name)) {
            cronJobToJobs.set(cjWl.namespace + '/' + cjWl.name, []);
          }
          cronJobToJobs.get(cjWl.namespace + '/' + cjWl.name).push(wl.name);
        }
      }
    }
  }

  const claimedPods = new Set();

  const wlSorted = [...state.workloads].sort((a, b) => {
    const order = { Job: 0, Deployment: 1, StatefulSet: 2, DaemonSet: 3, CronJob: 4 };
    return (order[a.kind] ?? 5) - (order[b.kind] ?? 5);
  });

  // Pre-count orphans per namespace
  const orphanTotals = {};
  for (const wl of wlSorted) {
    const ns = state.namespaces.get(wl.namespace);
    if (!ns) continue;
    let hasPod = false;
    for (const [, podMesh] of ns.pods) {
      const pod = podMesh.userData.pod;
      if (!pod) continue;
      if (pod.ownerKind === wl.kind && pod.ownerName === wl.name) { hasPod = true; break; }
      if (wl.kind === 'CronJob') {
        const jobNames = cronJobToJobs.get(wl.namespace + '/' + wl.name) || [];
        if (pod.ownerKind === 'Job' && jobNames.includes(pod.ownerName)) { hasPod = true; break; }
      }
    }
    if (!hasPod) orphanTotals[wl.namespace] = (orphanTotals[wl.namespace] || 0) + 1;
  }
  const orphanCounters = {};

  for (const wl of wlSorted) {
    const ns = state.namespaces.get(wl.namespace);
    if (!ns) continue;

    const matchedMeshes = [];
    for (const [podName, podMesh] of ns.pods) {
      if (claimedPods.has(wl.namespace + '/' + podName)) continue;
      const pod = podMesh.userData.pod;
      if (!pod) continue;

      let matched = false;
      if (pod.ownerKind === wl.kind && pod.ownerName === wl.name) matched = true;
      if (!matched && wl.kind === 'CronJob') {
        const jobNames = cronJobToJobs.get(wl.namespace + '/' + wl.name) || [];
        if (pod.ownerKind === 'Job' && jobNames.includes(pod.ownerName)) matched = true;
      }
      if (matched) {
        matchedMeshes.push(podMesh);
        claimedPods.add(wl.namespace + '/' + podName);
      }
    }

    const outlineColor = WL_COLORS[wl.kind] || 0x00ff88;
    let cx, cz, w, d;

    if (matchedMeshes.length === 0) {
      if (!orphanCounters[wl.namespace]) orphanCounters[wl.namespace] = 0;
      const orphanIdx = orphanCounters[wl.namespace]++;
      const nsGroup = ns.group;
      const halfD = (ns.platDepth || 6) / 2;
      const ozDepth = ns.orphanZoneDepth || 3;
      const totalOrphans = orphanTotals[wl.namespace] || 1;
      const orphanSpacing = 2.5;
      const orphanCols = Math.max(2, Math.min(totalOrphans, Math.floor((ns.platWidth || 6) / orphanSpacing)));
      const col = orphanIdx % orphanCols;
      const row = Math.floor(orphanIdx / orphanCols);
      const totalOrphanCols = Math.min(orphanCols, totalOrphans);
      const orphanRows = Math.ceil(totalOrphans / orphanCols);
      const orphanBlockDepth = orphanRows * orphanSpacing;
      const orphanZoneCenter = halfD - ozDepth / 2;
      cx = nsGroup.position.x + (col - (totalOrphanCols - 1) / 2) * orphanSpacing;
      cz = nsGroup.position.z + orphanZoneCenter - orphanBlockDepth / 2 + row * orphanSpacing + orphanSpacing / 2;
      w = 2.0;
      d = 2.0;
    } else {
      let minX = Infinity, maxX = -Infinity, minZ = Infinity, maxZ = -Infinity;
      for (const mesh of matchedMeshes) {
        const wp = new THREE.Vector3();
        mesh.getWorldPosition(wp);
        minX = Math.min(minX, wp.x);
        maxX = Math.max(maxX, wp.x);
        minZ = Math.min(minZ, wp.z);
        maxZ = Math.max(maxZ, wp.z);
      }
      const pad = 0.5;
      w = Math.max(maxX - minX + pad * 2, 1.5);
      d = Math.max(maxZ - minZ + pad * 2, 1.5);
      cx = (minX + maxX) / 2;
      cz = (minZ + maxZ) / 2;
    }

    // Workload box
    const outlineGeo = new THREE.BoxGeometry(w, WORKLOAD_BOX_HEIGHT, d);
    const outlineMat = new THREE.MeshBasicMaterial({
      color: outlineColor,
      transparent: true,
      opacity: 0.08,
      depthWrite: false,
    });
    const outline = new THREE.Mesh(outlineGeo, outlineMat);
    outline.position.set(cx, WORKLOAD_Y + WORKLOAD_BOX_HEIGHT / 2, cz);
    outline.userData = {
      type: 'workload',
      workload: { name: wl.name, namespace: wl.namespace, kind: wl.kind, replicas: wl.replicas, readyReplicas: wl.readyReplicas, schedule: wl.schedule, suspended: wl.suspended, lastSchedule: wl.lastSchedule, activeJobs: wl.activeJobs },
    };
    group.add(outline);

    // Wireframe edges
    const edgesGeo = new THREE.EdgesGeometry(outlineGeo);
    const edgesMat = new THREE.LineBasicMaterial({
      color: outlineColor,
      transparent: true,
      opacity: 0.4,
    });
    const edges = new THREE.LineSegments(edgesGeo, edgesMat);
    edges.position.copy(outline.position);
    group.add(edges);

    // Label
    const abbrev = WL_ABBREV[wl.kind] || wl.kind.toLowerCase();
    let labelText, labelColor;
    if (wl.kind === 'CronJob') {
      labelColor = wl.suspended ? '#ff4444' : '#ffaa00';
      labelText = `${abbrev}/${wl.name} ${wl.schedule || '?'}${wl.suspended ? ' SUSPENDED' : ''}`;
    } else if (wl.kind === 'Job') {
      labelColor = wl.readyReplicas >= wl.replicas ? '#ffcc66' : '#ffcc00';
      labelText = `${abbrev}/${wl.name} ${wl.readyReplicas}/${wl.replicas}`;
    } else {
      const healthy = wl.readyReplicas >= wl.replicas;
      const WL_LABEL_COLORS = { Deployment: '#00ff88', StatefulSet: '#00aaff', DaemonSet: '#44ccaa', ReplicaSet: '#448899' };
      labelColor = healthy ? (WL_LABEL_COLORS[wl.kind] || '#00ff88') : '#ffcc00';
      labelText = `${abbrev}/${wl.name} ${wl.readyReplicas}/${wl.replicas}`;
    }
    const label = makeLabel(labelText, 28, labelColor, { billboard: true });
    label.scale.set(0.35, 0.35, 0.35);
    label.position.set(cx, WORKLOAD_Y + WORKLOAD_BOX_HEIGHT + 1.5, cz - d / 2 - 0.1);
    group.add(label);
  }

  state.workloadGroup = group;
  scene.add(group);
  applyLayerVisibility();
}

// ── Generic Resource Rendering ──────────────────────────────────

const RESOURCE_COLORS = {
  ConfigMap: 0x66bbcc,
  Secret: 0xcc6666,
  ServiceAccount: 0x88cc44,
  Endpoints: 0x777777,
  ResourceQuota: 0x777777,
  LimitRange: 0x777777,
  PersistentVolume: 0x777777,
  HPA: 0xdd8844,
  NetworkPolicy: 0xcc44aa,
  PDB: 0xaa88dd,
  ReplicaSet: 0x448899,
  Role: 0x998844,
  RoleBinding: 0x998844,
  ClusterRole: 0x998844,
  ClusterRoleBinding: 0x998844,
};

function resourceLayerKey(kind) {
  switch (kind) {
    case 'ConfigMap': return 'configmaps';
    case 'Secret': return 'secrets';
    case 'ServiceAccount': return 'serviceaccounts';
    case 'HPA': return 'hpa';
    case 'NetworkPolicy': return 'networkpolicies';
    case 'PDB': return 'pdb';
    case 'ReplicaSet': return 'replicasets';
    case 'Role': case 'RoleBinding': case 'ClusterRole': case 'ClusterRoleBinding': return 'rbac';
    default: return 'other-resources';
  }
}

const RESOURCE_MARKER_SIZE = 0.2;
const RESOURCE_Y = -0.1;
const RESOURCE_SPACING = RESOURCE_MARKER_SIZE * 2.5;
const RESOURCE_EDGE_GAP = 1.2;

function rebuildResources() {
  if (state.resourceGroup) {
    scene.remove(state.resourceGroup);
    state.resourceGroup.traverse((child) => {
      if (child.geometry) child.geometry.dispose();
      if (child.material) child.material.dispose();
    });
  }

  const group = new THREE.Group();
  group.userData = { type: 'resourceGroup' };

  const byNs = new Map();
  for (const res of state.resources) {
    const nsKey = res.namespace || '__cluster__';
    if (!byNs.has(nsKey)) byNs.set(nsKey, []);
    byNs.get(nsKey).push(res);
  }

  for (const [nsName, nsResources] of byNs) {
    const ns = state.namespaces.get(nsName);
    if (!ns && nsName !== '__cluster__') continue;

    const cx = ns ? ns.group.position.x : -20;
    const cz = ns ? ns.group.position.z : -20;
    const halfW = ns ? (ns.platWidth || 6) / 2 : 4;
    const halfD = ns ? (ns.platDepth || 6) / 2 : 4;

    const byLayer = new Map();
    for (const res of nsResources) {
      const lk = resourceLayerKey(res.kind);
      if (!byLayer.has(lk)) byLayer.set(lk, []);
      byLayer.get(lk).push(res);
    }

    const layerEntries = [...byLayer.entries()];
    const edgeSlots = [];
    const sides = ['left', 'bottom', 'right'];
    const sideCounters = { left: 0, bottom: 0, right: 0 };

    for (let li = 0; li < layerEntries.length; li++) {
      const side = sides[li % sides.length];
      edgeSlots.push({ side, stripIdx: sideCounters[side] });
      sideCounters[side]++;
    }

    for (let li = 0; li < layerEntries.length; li++) {
      const [layerKey, resources] = layerEntries[li];
      const { side, stripIdx } = edgeSlots[li];

      const subGroup = new THREE.Group();
      subGroup.userData = { layerKey };
      subGroup.visible = !!layers[layerKey];

      const platH = halfD * 2;
      const platW = halfW * 2;

      let maxAlong;
      if (side === 'left' || side === 'right') {
        maxAlong = Math.max(1, Math.floor(platH / RESOURCE_SPACING));
      } else {
        maxAlong = Math.max(1, Math.floor(platW / RESOURCE_SPACING));
      }
      const wrapCols = Math.ceil(resources.length / maxAlong);
      const stripBase = stripIdx * (wrapCols * RESOURCE_SPACING + RESOURCE_SPACING);

      for (let i = 0; i < resources.length; i++) {
        const res = resources[i];
        const color = RESOURCE_COLORS[res.kind] || 0x777777;

        const geo = new THREE.BoxGeometry(RESOURCE_MARKER_SIZE, RESOURCE_MARKER_SIZE * 0.6, RESOURCE_MARKER_SIZE);
        const mat = new THREE.MeshPhongMaterial({
          color,
          emissive: new THREE.Color(color).multiplyScalar(0.4),
          transparent: true,
          opacity: 0.8,
        });
        const mesh = new THREE.Mesh(geo, mat);

        const along = i % maxAlong;
        const perp = Math.floor(i / maxAlong);

        let mx, mz;
        if (side === 'left') {
          mx = cx - halfW - RESOURCE_EDGE_GAP - stripBase - perp * RESOURCE_SPACING;
          mz = cz - halfD + along * RESOURCE_SPACING + RESOURCE_SPACING / 2;
        } else if (side === 'right') {
          mx = cx + halfW + RESOURCE_EDGE_GAP + stripBase + perp * RESOURCE_SPACING;
          mz = cz - halfD + along * RESOURCE_SPACING + RESOURCE_SPACING / 2;
        } else {
          mx = cx - halfW + along * RESOURCE_SPACING + RESOURCE_SPACING / 2;
          mz = cz + halfD + RESOURCE_EDGE_GAP + stripBase + perp * RESOURCE_SPACING;
        }

        mesh.position.set(mx, RESOURCE_Y + RESOURCE_MARKER_SIZE / 2, mz);
        mesh.userData = { type: 'resource', resource: res };
        subGroup.add(mesh);
      }

      if (resources.length > 0) {
        const kindCounts = {};
        for (const r of resources) kindCounts[r.kind] = (kindCounts[r.kind] || 0) + 1;
        const labelParts = Object.entries(kindCounts).map(([k, v]) => `${v}`);
        const firstKind = resources[0].kind;
        const labelText = `${firstKind} ${labelParts.join('+')}`;
        const color = RESOURCE_COLORS[firstKind] || 0x777777;
        const hexColor = '#' + new THREE.Color(color).getHexString();
        const label = makeLabel(labelText, 20, hexColor, { billboard: true });
        label.scale.set(0.2, 0.2, 0.2);

        let lx, lz;
        if (side === 'left') {
          lx = cx - halfW - RESOURCE_EDGE_GAP - stripBase;
          lz = cz - halfD - 0.3;
        } else if (side === 'right') {
          lx = cx + halfW + RESOURCE_EDGE_GAP + stripBase;
          lz = cz - halfD - 0.3;
        } else {
          lx = cx - halfW - 0.3;
          lz = cz + halfD + RESOURCE_EDGE_GAP + stripBase;
        }
        label.position.set(lx, RESOURCE_Y + 0.8, lz);
        subGroup.add(label);
      }

      group.add(subGroup);
    }
  }

  state.resourceGroup = group;
  scene.add(group);
  applyLayerVisibility();
}

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

// ── HUD Update ─────────────────────────────────────────────────
function updateHUD() {
  let pods = 0;
  for (const [, ns] of state.namespaces) pods += ns.pods.size;
  document.getElementById('ns-count').textContent = state.namespaces.size;
  document.getElementById('pod-count').textContent = pods;
  document.getElementById('node-count').textContent = state.nodes.size;
  document.getElementById('svc-count').textContent = state.services.length;
  document.getElementById('ing-count').textContent = state.ingresses.length;
  document.getElementById('pvc-count').textContent = state.pvcs.length;
  document.getElementById('wl-count').textContent = state.workloads.length;
  document.getElementById('res-count').textContent = state.resources.length;
}

// ── Context Switcher ───────────────────────────────────────────
async function loadContexts() {
  try {
    const res = await fetch('/api/contexts');
    const data = await res.json();
    const sel = document.getElementById('ctx-select');
    sel.innerHTML = '';
    for (const ctx of (data.contexts || []).sort()) {
      const opt = document.createElement('option');
      opt.value = ctx;
      opt.textContent = ctx;
      sel.appendChild(opt);
    }
    sel.value = data.active || data.current;
  } catch (e) {
    console.error('Failed to load contexts:', e);
  }
}

document.getElementById('ctx-select').addEventListener('change', async (e) => {
  const newCtx = e.target.value;
  const sel = e.target;
  const switching = document.getElementById('ctx-switching');
  sel.disabled = true;
  switching.style.display = 'inline';

  try {
    const res = await fetch('/api/context/switch', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ context: newCtx }),
    });
    if (!res.ok) {
      const err = await res.text();
      console.error('Context switch failed:', err);
      // Revert selection
      await loadContexts();
    }
    // The server will push a new snapshot via WebSocket automatically
  } catch (e) {
    console.error('Context switch error:', e);
    await loadContexts();
  } finally {
    sel.disabled = false;
    switching.style.display = 'none';
  }
});

loadContexts();

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
      // Update active context in dropdown
      if (event.context) {
        const sel = document.getElementById('ctx-select');
        if (sel.value !== event.context) sel.value = event.context;
        document.getElementById('ctx-switching').style.display = 'none';
      }
      // Clear existing
      for (const [name] of state.namespaces) removeNamespace(name);
      for (const ns of event.snapshot) {
        ensureNamespace(ns.name, ns.forbidden || false);
        for (const pod of ns.pods ?? []) {
          addOrUpdatePod(ns.name, pod);
        }
      }
      // Nodes
      state.nodes.clear();
      for (const node of event.nodes ?? []) {
        state.nodes.set(node.name, node);
      }
      // Services
      state.services = event.services ?? [];
      // Ingresses
      state.ingresses = event.ingresses ?? [];
      // PVCs
      state.pvcs = event.pvcs ?? [];
      // Workloads
      state.workloads = event.workloads ?? [];
      // Resources
      state.resources = event.resources ?? [];
      layoutNamespaces();
      rebuildServiceLines();
      rebuildIngresses();
      rebuildPVCs();
      rebuildWorkloadGroups();
      rebuildResources();
      updateHUD();
      break;

    case 'pod_added':
    case 'pod_modified':
      addOrUpdatePod(event.namespace, event.pod);
      layoutNamespaces();
      rebuildServiceLines();
      rebuildIngresses();
      rebuildPVCs();
      rebuildWorkloadGroups();
      updateHUD();
      break;

    case 'pod_deleted':
      removePod(event.namespace, event.pod.name);
      layoutNamespaces();
      rebuildServiceLines();
      rebuildIngresses();
      rebuildPVCs();
      rebuildWorkloadGroups();
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
      rebuildIngresses();
      rebuildPVCs();
      rebuildWorkloadGroups();
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
      updateHUD();
      break;

    case 'svc_deleted':
      if (event.service) {
        state.services = state.services.filter(s => !(s.name === event.service.name && s.namespace === event.service.namespace));
      }
      rebuildServiceLines();
      rebuildIngresses();
      updateHUD();
      break;

    case 'ingress_updated':
      if (event.ingress) {
        const idx = state.ingresses.findIndex(i => i.name === event.ingress.name && i.namespace === event.ingress.namespace);
        if (idx >= 0) state.ingresses[idx] = event.ingress;
        else state.ingresses.push(event.ingress);
      }
      rebuildIngresses();
      updateHUD();
      break;

    case 'ingress_deleted':
      if (event.ingress) {
        state.ingresses = state.ingresses.filter(i => !(i.name === event.ingress.name && i.namespace === event.ingress.namespace));
      }
      rebuildIngresses();
      updateHUD();
      break;

    case 'pvc_updated':
      if (event.pvc) {
        const idx = state.pvcs.findIndex(p => p.name === event.pvc.name && p.namespace === event.pvc.namespace);
        if (idx >= 0) state.pvcs[idx] = event.pvc;
        else state.pvcs.push(event.pvc);
      }
      rebuildPVCs();
      updateHUD();
      break;

    case 'pvc_deleted':
      if (event.pvc) {
        state.pvcs = state.pvcs.filter(p => !(p.name === event.pvc.name && p.namespace === event.pvc.namespace));
      }
      rebuildPVCs();
      updateHUD();
      break;

    case 'workload_updated':
      if (event.workload) {
        const idx = state.workloads.findIndex(w => w.name === event.workload.name && w.namespace === event.workload.namespace && w.kind === event.workload.kind);
        if (idx >= 0) state.workloads[idx] = event.workload;
        else state.workloads.push(event.workload);
      }
      rebuildWorkloadGroups();
      updateHUD();
      break;

    case 'workload_deleted':
      if (event.workload) {
        state.workloads = state.workloads.filter(w => !(w.name === event.workload.name && w.namespace === event.workload.namespace && w.kind === event.workload.kind));
      }
      rebuildWorkloadGroups();
      updateHUD();
      break;

    case 'resource_updated':
      if (event.resource) {
        const idx = state.resources.findIndex(r => r.name === event.resource.name && r.namespace === event.resource.namespace && r.kind === event.resource.kind);
        if (idx >= 0) state.resources[idx] = event.resource;
        else state.resources.push(event.resource);
      }
      rebuildResources();
      updateHUD();
      break;

    case 'resource_deleted':
      if (event.resource) {
        state.resources = state.resources.filter(r => !(r.name === event.resource.name && r.namespace === event.resource.namespace && r.kind === event.resource.kind));
      }
      rebuildResources();
      updateHUD();
      break;
  }
}

// ── Fly Camera Controller ──────────────────────────────────────
const velocity = new THREE.Vector3();
const euler = new THREE.Euler(0, 0, 0, 'YXZ');
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
  flyTo.active = true;
  flyTo.targetNs = nsName;
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
    if (flyTo.targetNs) startSpotlight(flyTo.targetNs);
  }
}

document.addEventListener('keydown', (e) => {
  keys[e.code] = true;

  // Toggle Eagle Eye with E key
  if (e.code === 'KeyE' && !e.repeat) {
    toggleEagleEye();
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

function computeLayoutExtent() {
  let minX = Infinity, maxX = -Infinity, minZ = Infinity, maxZ = -Infinity;
  for (const [, ns] of state.namespaces) {
    const pos = ns.group.position;
    minX = Math.min(minX, pos.x);
    maxX = Math.max(maxX, pos.x);
    minZ = Math.min(minZ, pos.z);
    maxZ = Math.max(maxZ, pos.z);
  }
  if (state.nodeIsland) {
    const pos = state.nodeIsland.group.position;
    minX = Math.min(minX, pos.x);
    maxX = Math.max(maxX, pos.x);
    minZ = Math.min(minZ, pos.z);
    maxZ = Math.max(maxZ, pos.z);
  }
  if (!isFinite(minX)) return { cx: 0, cz: 0, extent: ORTHO_DEFAULT_ZOOM };
  const cx = (minX + maxX) / 2;
  const cz = (minZ + maxZ) / 2;
  const w = maxX - minX + 20; // padding
  const h = maxZ - minZ + 20;
  const aspect = window.innerWidth / window.innerHeight;
  const extent = Math.max(h, w / aspect) * 1.2;
  return { cx, cz, extent: Math.max(extent, ORTHO_DEFAULT_ZOOM) };
}

function toggleEagleEye() {
  eagleEye.active = !eagleEye.active;

  if (eagleEye.active) {
    // Exit pointer lock when entering eagle eye
    if (pointerLocked) document.exitPointerLock();
    cancelFlyTo();

    // Auto-fit: center on layout and zoom to show everything
    const { cx, cz, extent } = computeLayoutExtent();
    eagleEye.panX = cx;
    eagleEye.panZ = cz;
    eagleEye.zoom = extent;
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
  eagleEye.zoom = Math.max(10, Math.min(600, eagleEye.zoom + e.deltaY * 0.1));
  updateOrthoFrustum();
}, { passive: false });

function updateControlsHint() {
  const hint = document.getElementById('controls-hint');
  if (eagleEye.active) {
    hint.textContent = 'EAGLE EYE \u2022 WASD/Arrows: Pan \u2022 Scroll: Zoom \u2022 E: Exit';
  } else {
    hint.textContent = 'WASD/Arrows: Move \u00b7 Mouse: Look \u00b7 Shift: Fast \u00b7 Space/Ctrl: Up/Down \u00b7 Click: Lock cursor \u00b7 Esc: Unlock \u00b7 E: Eagle Eye';
  }
}

canvas.addEventListener('click', (e) => {
  if (pointerLocked) return;
  // Raycast against namespace labels and platforms
  const clickMouse = new THREE.Vector2(
    (e.clientX / window.innerWidth) * 2 - 1,
    -(e.clientY / window.innerHeight) * 2 + 1,
  );
  const clickRay = new THREE.Raycaster();
  clickRay.setFromCamera(clickMouse, activeCamera());

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
      if (eagleEye.active) toggleEagleEye();
      startFlyTo(nsName);
      return;
    }
  }
  if (!eagleEye.active) canvas.requestPointerLock();
});

document.addEventListener('pointerlockchange', () => {
  pointerLocked = document.pointerLockElement === canvas;
});

document.addEventListener('mousemove', (e) => {
  if (!pointerLocked) return;
  cancelFlyTo();
  euler.setFromQuaternion(camera.quaternion);
  euler.y -= e.movementX * 0.002;
  euler.x -= e.movementY * 0.002;
  euler.x = Math.max(-Math.PI / 2, Math.min(Math.PI / 2, euler.x));
  camera.quaternion.setFromEuler(euler);
});

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
  const direction = new THREE.Vector3();

  if (keys['KeyW'] || keys['ArrowUp']) direction.z -= 1;
  if (keys['KeyS'] || keys['ArrowDown']) direction.z += 1;
  if (keys['KeyA'] || keys['ArrowLeft']) direction.x -= 1;
  if (keys['KeyD'] || keys['ArrowRight']) direction.x += 1;
  if (keys['Space']) direction.y += 1;
  if (keys['ControlLeft'] || keys['ControlRight']) direction.y -= 1;

  direction.normalize();
  direction.applyQuaternion(camera.quaternion);

  velocity.lerp(direction.multiplyScalar(speed), 0.1);
  camera.position.addScaledVector(velocity, dt);
}

// ── Raycasting (hover tooltip) ─────────────────────────────────
const raycaster = new THREE.Raycaster();
const mouse = new THREE.Vector2();
let hoveredMesh = null;
const tooltip = document.getElementById('tooltip');

let _mouseDirty = false;
document.addEventListener('mousemove', (e) => {
  mouse.x = (e.clientX / window.innerWidth) * 2 - 1;
  mouse.y = -(e.clientY / window.innerHeight) * 2 + 1;
  _mouseDirty = true;

  // Tooltip position
  tooltip.style.left = (e.clientX + 16) + 'px';
  tooltip.style.top = (e.clientY + 16) + 'px';
});

// Cached mesh arrays — rebuilt only when scene changes
let _cachedHoverTargets = [];
let _cachedNsTargets = [];
let _meshCacheDirty = true;

function invalidateMeshCache() {
  _meshCacheDirty = true;
  _billboardCacheDirty = true;
}

const HOVERABLE_TYPES = new Set(['pod', 'nodeBlock', 'namespace', 'service']);

function rebuildMeshCache() {
  if (!_meshCacheDirty) return;
  _cachedHoverTargets = [];
  _cachedNsTargets = [];
  scene.traverse((obj) => {
    if (obj.isMesh && HOVERABLE_TYPES.has(obj.userData.type)) {
      _cachedHoverTargets.push(obj);
    }
    if (obj.userData.type === 'namespace' || obj.userData.type === 'label') {
      _cachedNsTargets.push(obj);
    }
  });
  _meshCacheDirty = false;
}

// Store original material state for unhover restore
let _hoverSavedState = null;

function applyHoverHighlight(mesh) {
  const mat = mesh.material;
  _hoverSavedState = {
    emissiveIntensity: mat.emissiveIntensity,
    opacity: mat.opacity,
    emissive: mat.emissive ? mat.emissive.clone() : null,
  };
  if (mat.emissive) {
    mat.emissiveIntensity = Math.max(mat.emissiveIntensity * 3, 2);
  }
  // Boost opacity for transparent objects
  if (mat.transparent && mat.opacity < 0.5) {
    mat.opacity = Math.min(mat.opacity * 3, 0.6);
  }
}

function removeHoverHighlight(mesh) {
  if (!_hoverSavedState) return;
  const mat = mesh.material;
  if (_hoverSavedState.emissive) {
    mat.emissiveIntensity = _hoverSavedState.emissiveIntensity;
  }
  mat.opacity = _hoverSavedState.opacity;
  _hoverSavedState = null;
}

function updateRaycast() {
  if (!_mouseDirty) return;
  _mouseDirty = false;

  rebuildMeshCache();
  raycaster.setFromCamera(mouse, activeCamera());

  // Cursor hint for clickable namespace labels/platforms
  if (!pointerLocked) {
    const nsHits = raycaster.intersectObjects(_cachedNsTargets);
    canvas.style.cursor = nsHits.length > 0 ? 'pointer' : 'default';
  }

  const intersects = raycaster.intersectObjects(_cachedHoverTargets);

  if (hoveredMesh) {
    removeHoverHighlight(hoveredMesh);
    hoveredMesh = null;
  }

  if (intersects.length > 0) {
    hoveredMesh = intersects[0].object;
    applyHoverHighlight(hoveredMesh);
    canvas.style.cursor = 'pointer';

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
    } else if (hoveredMesh.userData.type === 'pod') {
      const pod = hoveredMesh.userData.pod;
      const statusClass = pod.status === 'Running' ? 'status-running'
        : ['Pending', 'ContainerCreating', 'PodInitializing'].includes(pod.status) ? 'status-pending'
        : 'status-error';
      tooltip.innerHTML = `
        <div class="pod-name">${pod.name}</div>
        <div class="pod-ns">ns/${pod.namespace}${pod.nodeName ? ' · node/' + pod.nodeName : ''}</div>
        <div class="pod-status ${statusClass}">● ${pod.status}</div>
        <div>Ready: ${pod.ready ? 'YES' : 'NO'} &middot; Restarts: ${pod.restarts}</div>
        ${pod.cpuRequest || pod.memoryRequest ? `<div>CPU: ${pod.cpuRequest ? pod.cpuRequest + 'm' : '—'} &middot; Mem: ${pod.memoryRequest ? formatBytes(pod.memoryRequest) : '—'}</div>` : ''}
        <div>Age: ${pod.age}</div>
      `;
      tooltip.style.display = 'block';
    } else {
      tooltip.style.display = 'none';
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
        mesh.position.y = POD_Y_OFFSET + h / 2 + Math.sin(time * 2 + i * 0.5) * 0.05;
      } else if (pod && (pod.status === 'CrashLoopBackOff' || pod.status === 'Error')) {
        mesh.position.y = POD_Y_OFFSET + h / 2 + Math.sin(time * 8 + i) * 0.15;
      }
      i++;
    }
  }
}

// ── Depth transparency ─────────────────────────────────────────
const DEPTH_FADE_START = 60;
const DEPTH_FADE_END = 250;
const DEPTH_MIN_OPACITY = 0.25;

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
const _lastCamPos = new THREE.Vector3();
let _depthDirty = true;

function markDepthDirty() { _depthDirty = true; }

function updateDepthTransparency() {
  const camPos = activeCamera().position;
  // Skip if camera hasn't moved significantly
  if (!_depthDirty && _lastCamPos.distanceToSquared(camPos) < 0.01) return;
  _lastCamPos.copy(camPos);
  _depthDirty = false;

  for (const [, ns] of state.namespaces) {
    ns.group.getWorldPosition(_depthTmpVec);
    const dist = eagleEye.active ? 0 : camPos.distanceTo(_depthTmpVec);
    const f = depthOpacityFactor(dist);

    if (ns.platform) ns.platform.material.opacity = BASE_PLATFORM_OPACITY * f;
    if (ns.label) ns.label.material.opacity = BASE_LABEL_OPACITY * f;

    for (const [, mesh] of ns.pods) {
      mesh.material.opacity = BASE_POD_OPACITY * f;
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
      mesh.material.opacity = BASE_POD_OPACITY * f;
    }
  }
}

// ── Billboard labels (face camera) ────────────────────────────
let _billboardMeshes = [];
let _billboardCacheDirty = true;

function invalidateBillboardCache() { _billboardCacheDirty = true; }

function updateBillboards() {
  const cam = activeCamera();
  if (_billboardCacheDirty) {
    _billboardMeshes = [];
    scene.traverse((obj) => {
      if (obj.isMesh && obj.userData.billboard) _billboardMeshes.push(obj);
    });
    _billboardCacheDirty = false;
  }
  for (const mesh of _billboardMeshes) {
    mesh.quaternion.copy(cam.quaternion);
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
animate();
connectWS();
