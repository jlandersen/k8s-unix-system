import * as THREE from 'three';
import {
  state, PLATFORM_GAP, POD_BASE_SIZE, POD_STRIDE, WORKLOAD_GAP,
  PLATFORM_Y, PLATFORM_HEIGHT, NODE_BLOCK_SIZE,
} from './state.js';
import { scene, camera } from './scene.js';
import { platformMaterial, podMaterial, disposeMesh, podWidth, podDepth } from './materials.js';
import { makeLabel, makeBeveledPlatformGeo, buildWorkloadGroups } from './labels.js';
import { spot, showPodLabels, clearPodLabels, fadeOutSpotlight } from './spotlight.js';
import { rebuildNodeIsland, layoutNodeIsland, clearNodeIsland } from './nodes.js';
import { registerRayTarget, unregisterRayTarget } from './raycast.js';
import { euler } from './camera-controller.js';

// ── Namespace Layout ───────────────────────────────────────────
export function layoutNamespaces() {
  if (state.nodes.size > 0) {
    rebuildNodeIsland();
    layoutNodeIsland();
  } else {
    clearNodeIsland();
  }

  const entries = [];
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

  const colWidths = new Array(cols).fill(0);
  const rowDepths = new Array(rows).fill(0);
  entries.forEach((entry, i) => {
    const col = i % cols;
    const row = Math.floor(i / cols);
    colWidths[col] = Math.max(colWidths[col], entry.platWidth);
    rowDepths[row] = Math.max(rowDepths[row], entry.platDepth);
  });

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

    if (!entry.nsName) return;

    const ns = state.namespaces.get(entry.nsName);
    ns.platWidth = entry.platWidth;
    ns.platDepth = entry.platDepth;

    if (ns.platform) {
      ns.group.remove(ns.platform);
      unregisterRayTarget(ns.platform);
      disposeMesh(ns.platform);
    }
    const platGeo = makeBeveledPlatformGeo(entry.platWidth, PLATFORM_HEIGHT, entry.platDepth);
    ns.platform = new THREE.Mesh(platGeo, platformMaterial.clone());
    ns.platform.position.y = -PLATFORM_HEIGHT / 2;
    ns.platform.userData = { type: 'namespace', name: entry.nsName };
    ns.group.add(ns.platform);
    registerRayTarget(ns.platform);

    if (ns.label) {
      ns.group.remove(ns.label);
      unregisterRayTarget(ns.label);
      disposeMesh(ns.label);
    }
    ns.label = makeLabel(entry.nsName.toUpperCase(), 64, 1.8, 0.82, "'Smooch Sans', sans-serif", '300');
    ns.label.position.set(0, 0.15, entry.platDepth / 2 + 2);
    ns.group.add(ns.label);
    registerRayTarget(ns.label);

    for (const [, label] of ns.workloadLabels) {
      ns.group.remove(label);
      unregisterRayTarget(label);
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
      registerRayTarget(label);
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

  if (!layoutNamespaces._initialDone && entries.length > 0) {
    layoutNamespaces._initialDone = true;
    const fovRad = THREE.MathUtils.degToRad(camera.fov / 2);
    const aspect = camera.aspect;
    const distForWidth = totalWidth / (2 * Math.tan(fovRad) * aspect);
    const distForDepth = totalDepth / (2 * Math.tan(fovRad));
    const dist = Math.max(distForWidth, distForDepth, 25) * 1.3;
    camera.position.set(0, dist * 0.45, dist);
    camera.lookAt(0, 0, 0);
    euler.setFromQuaternion(camera.quaternion);
  }

  if (spot.active && spot.nsName) {
    showPodLabels(spot.nsName);
    for (const { mesh } of spot.podLabels) {
      mesh.material.opacity = 0.85;
    }
  }
}

// ── Namespace/Pod Management ───────────────────────────────────
export function ensureNamespace(name) {
  if (state.namespaces.has(name)) return state.namespaces.get(name);
  const group = new THREE.Group();
  group.userData = { type: 'namespace', name };
  scene.add(group);
  const ns = { group, platform: null, pods: new Map(), label: null, workloadLabels: new Map() };
  state.namespaces.set(name, ns);
  registerRayTarget(group);
  return ns;
}

export function addOrUpdatePod(nsName, pod) {
  const ns = ensureNamespace(nsName);

  const w = podWidth(pod.cpuRequest);
  const d = podDepth(pod.memoryRequest);
  const height = POD_BASE_SIZE + Math.min(pod.restarts * 0.15, 2);

  if (ns.pods.has(pod.name)) {
    const existing = ns.pods.get(pod.name);
    existing.material.dispose();
    existing.material = podMaterial(pod.status);
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
  registerRayTarget(mesh);
}

export function removePod(nsName, podName) {
  const ns = state.namespaces.get(nsName);
  if (!ns) return;
  const mesh = ns.pods.get(podName);
  if (mesh) {
    ns.group.remove(mesh);
    unregisterRayTarget(mesh);
    mesh.geometry.dispose();
    mesh.material.dispose();
    ns.pods.delete(podName);
  }
}

export function removeNamespace(name) {
  const ns = state.namespaces.get(name);
  if (!ns) return;
  if (spot.nsName === name) {
    clearPodLabels();
    fadeOutSpotlight();
  }
  for (const [, mesh] of ns.pods) {
    unregisterRayTarget(mesh);
    disposeMesh(mesh);
  }
  for (const [, label] of ns.workloadLabels) {
    unregisterRayTarget(label);
    disposeMesh(label);
  }
  if (ns.platform) { unregisterRayTarget(ns.platform); disposeMesh(ns.platform); }
  if (ns.label) { unregisterRayTarget(ns.label); disposeMesh(ns.label); }
  scene.remove(ns.group);
  unregisterRayTarget(ns.group);
  state.namespaces.delete(name);
}
