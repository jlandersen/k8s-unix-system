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

  spot.targetIntensity = SPOT_RES.intensity;
  spot.targetBeamOpacity = SPOT_RES.beamOpacity;
  spot.targetGlowOpacity = SPOT_RES.glowOpacity;
  spot.fadingIn = true;
  spot.fadingOut = false;

  selection.phase = 'resource';
  selection.resourceMesh = resourceMesh;

  startResourceFlyTo(resourceMesh);
}

function fadeOutSpotlight() {
  if (!spot.active && !spot.fadingOut) return;
  spot.fadingIn = false;
  spot.fadingOut = true;
  selection.phase = 'none';
  selection.nsName = null;
  selection.resourceMesh = null;
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
      const label = makeLabel(nodeName, 28);
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
    const label = makeLabel(podName, 28);
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
function makeLabel(text, fontSize = 64) {
  const cvs = document.createElement('canvas');
  const ctx = cvs.getContext('2d');
  const fontStr = `${fontSize}px 'Share Tech Mono', monospace`;
  ctx.font = fontStr;
  const metrics = ctx.measureText(text);
  cvs.width = Math.ceil(metrics.width) + 20;
  cvs.height = fontSize + 20;
  ctx.font = fontStr;
  ctx.fillStyle = '#00ff88';
  ctx.shadowColor = '#00ff88';
  ctx.shadowBlur = 12;
  ctx.fillText(text, 10, fontSize);
  const texture = new THREE.CanvasTexture(cvs);
  texture.minFilter = THREE.LinearFilter;
  const aspect = cvs.width / cvs.height;
  const planeW = aspect * 2.5;
  const planeH = 2.5;
  const geo = new THREE.PlaneGeometry(planeW, planeH);
  const mat = new THREE.MeshBasicMaterial({
    map: texture,
    transparent: true,
    opacity: 0.9,
    depthWrite: false,
    side: THREE.DoubleSide,
  });
  const mesh = new THREE.Mesh(geo, mat);
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
    ns.label = makeLabel(entry.nsName.toUpperCase());
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
        h / 2,
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
}

// ── Namespace/Pod Management ───────────────────────────────────
function ensureNamespace(name) {
  if (state.namespaces.has(name)) return state.namespaces.get(name);
  const group = new THREE.Group();
  group.userData = { type: 'namespace', name };
  scene.add(group);
  const ns = { group, platform: null, pods: new Map(), label: null };
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
  island.label = makeLabel('NODES');
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

// ── HUD Update ─────────────────────────────────────────────────
function updateHUD() {
  let pods = 0;
  for (const [, ns] of state.namespaces) pods += ns.pods.size;
  document.getElementById('ns-count').textContent = state.namespaces.size;
  document.getElementById('pod-count').textContent = pods;
  document.getElementById('node-count').textContent = state.nodes.size;
  document.getElementById('svc-count').textContent = state.services.length;
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
      // Services
      state.services = event.services ?? [];
      layoutNamespaces();
      rebuildServiceLines();
      updateHUD();
      break;

    case 'pod_added':
    case 'pod_modified':
      addOrUpdatePod(event.namespace, event.pod);
      layoutNamespaces();
      rebuildServiceLines();
      updateHUD();
      break;

    case 'pod_deleted':
      removePod(event.namespace, event.pod.name);
      layoutNamespaces();
      rebuildServiceLines();
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
    hint.textContent = 'WASD/Arrows: Move \u00b7 Mouse: Look \u00b7 Shift: Fast \u00b7 Space/Ctrl: Up/Down \u00b7 Click: Lock cursor \u00b7 Esc: Unlock \u00b7 E: Eagle Eye';
  }
}

canvas.addEventListener('click', (e) => {
  if (pointerLocked) return;
  const clickMouse = new THREE.Vector2(
    (e.clientX / window.innerWidth) * 2 - 1,
    -(e.clientY / window.innerHeight) * 2 + 1,
  );
  const clickRay = new THREE.Raycaster();
  clickRay.setFromCamera(clickMouse, activeCamera());

  // Check for resource (pod / node block) clicks
  ensureRayTargets();
  const resHits = clickRay.intersectObjects(rayPodTargets);
  if (resHits.length > 0) {
    const resMesh = resHits[0].object;
    const resNs = resMesh.userData.type === 'pod'
      ? resMesh.userData.pod?.namespace
      : resMesh.userData.type === 'nodeBlock' ? '__nodes__' : null;
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
  if (!pointerLocked) return;
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
    if (obj.isMesh && (obj.userData.type === 'pod' || obj.userData.type === 'nodeBlock')) rayPodTargets.push(obj);
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
    } else {
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
