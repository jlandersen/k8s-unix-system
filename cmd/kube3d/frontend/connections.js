import * as THREE from 'three';
import { state, PLATFORM_Y, PLATFORM_HEIGHT } from './state.js';
import { scene } from './scene.js';
import { registerRayTarget, unregisterRayTarget } from './raycast.js';

export function selectorMatchesLabels(selector, labels) {
  if (!selector || !labels) return false;
  for (const [k, v] of Object.entries(selector)) {
    if (labels[k] !== v) return false;
  }
  return true;
}

// Shared line materials — never cloned, never disposed
const serviceLineMat = new THREE.LineBasicMaterial({
  color: 0x00aaff, transparent: true, opacity: 0.25, depthWrite: false,
});
const ingressLineMat = new THREE.LineBasicMaterial({
  color: 0xff8800, transparent: true, opacity: 0.35, depthWrite: false,
});
const pvcLineMat = new THREE.LineBasicMaterial({
  color: 0xaa44ff, transparent: true, opacity: 0.35, depthWrite: false,
});

// Shared marker geometries — reused across all markers
const ingressMarkerGeo = new THREE.OctahedronGeometry(0.3, 0);
const pvcMarkerGeo = new THREE.CylinderGeometry(0.22, 0.22, 0.45, 8);

// Per-namespace sub-groups for incremental rebuilds
const svcNSGroups = new Map();
const ingNSGroups = new Map();
const pvcNSGroups = new Map();

const sharedGeos = new Set([ingressMarkerGeo, pvcMarkerGeo]);
const sharedMats = new Set([serviceLineMat, ingressLineMat, pvcLineMat]);

function teardownNSGroup(group) {
  for (const child of group.children) {
    if (child.isMesh) unregisterRayTarget(child);
    if (child.geometry && !sharedGeos.has(child.geometry)) child.geometry.dispose();
    if (child.material && !sharedMats.has(child.material)) child.material.dispose();
  }
}

function ensureParentGroup(stateKey) {
  if (!state[stateKey]) {
    state[stateKey] = new THREE.Group();
    state[stateKey].userData = { type: stateKey };
    scene.add(state[stateKey]);
  }
  return state[stateKey];
}

// dirtyNS: null = rebuild all, Set<string> = only these namespaces
function rebuildNSLines(nsGroupMap, parent, dirtyNS, buildFn) {
  const rebuildAll = !dirtyNS;

  if (rebuildAll) {
    for (const [nsName, group] of nsGroupMap) {
      if (!state.namespaces.has(nsName)) {
        parent.remove(group);
        teardownNSGroup(group);
        nsGroupMap.delete(nsName);
      }
    }
  }

  const namespaces = rebuildAll ? state.namespaces.keys() : dirtyNS;
  for (const nsName of namespaces) {
    const oldGroup = nsGroupMap.get(nsName);
    if (oldGroup) {
      parent.remove(oldGroup);
      teardownNSGroup(oldGroup);
      nsGroupMap.delete(nsName);
    }

    const ns = state.namespaces.get(nsName);
    if (!ns) continue;

    const nsGroup = buildFn(ns, nsName);
    if (nsGroup.children.length > 0) {
      nsGroupMap.set(nsName, nsGroup);
      parent.add(nsGroup);
    }
  }
}

// ── Service Lines ───────────────────────────────────────────────

export function rebuildServiceLines(dirtyNS) {
  rebuildNSLines(svcNSGroups, ensureParentGroup('serviceLines'), dirtyNS, buildServiceLinesForNS);
}

function buildServiceLinesForNS(ns, nsName) {
  const group = new THREE.Group();

  for (const svc of state.services) {
    if (svc.namespace !== nsName) continue;
    if (!svc.selector || Object.keys(svc.selector).length === 0) continue;

    const matchedMeshes = [];
    for (const [, podMesh] of ns.pods) {
      const pod = podMesh.userData.pod;
      if (pod && selectorMatchesLabels(svc.selector, pod.labels)) {
        matchedMeshes.push(podMesh);
      }
    }

    if (matchedMeshes.length < 2) continue;

    const worldPos = (mesh) => {
      const v = new THREE.Vector3();
      mesh.getWorldPosition(v);
      return v;
    };

    const anchor = worldPos(matchedMeshes[0]);
    for (let j = 1; j < matchedMeshes.length; j++) {
      const target = worldPos(matchedMeshes[j]);
      const mid = anchor.clone().add(target).multiplyScalar(0.5);
      mid.y += 2;
      const curve = new THREE.QuadraticBezierCurve3(anchor, mid, target);
      const points = curve.getPoints(16);
      const geo = new THREE.BufferGeometry().setFromPoints(points);
      group.add(new THREE.Line(geo, serviceLineMat));
    }
  }

  return group;
}

// ── Ingress Orthogonal Connectors ──────────────────────────────
function orthogonalPath(sx, sz, ex, ez) {
  if (Math.abs(sx - ex) < 0.01) return [{ x: sx, z: sz }, { x: ex, z: ez }];
  if (Math.abs(sz - ez) < 0.01) return [{ x: sx, z: sz }, { x: ex, z: ez }];
  const midZ = (sz + ez) / 2;
  return [
    { x: sx, z: sz },
    { x: sx, z: midZ },
    { x: ex, z: midZ },
    { x: ex, z: ez },
  ];
}

export function rebuildIngressLines(dirtyNS) {
  rebuildNSLines(ingNSGroups, ensureParentGroup('ingressLines'), dirtyNS, buildIngressLinesForNS);
}

function buildIngressLinesForNS(ns, nsName) {
  const group = new THREE.Group();
  const lineY = PLATFORM_Y + PLATFORM_HEIGHT + 0.05;
  let markerIdx = 0;

  for (const ing of state.ingresses) {
    if (ing.namespace !== nsName) continue;
    if (!ns.platWidth) continue;

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
      const svc = state.services.find(s => s.name === svcName && s.namespace === nsName);
      if (!svc || !svc.selector || Object.keys(svc.selector).length === 0) continue;
      for (const [, podMesh] of ns.pods) {
        const pod = podMesh.userData.pod;
        if (pod && selectorMatchesLabels(svc.selector, pod.labels)) {
          targetPodMeshes.push(podMesh);
        }
      }
    }
    if (targetPodMeshes.length === 0) continue;

    const ml = {
      x: -ns.platWidth / 2 + 1 + markerIdx * 2,
      z: ns.platDepth / 2 - 0.8,
    };
    markerIdx++;

    const markerWorld = new THREE.Vector3(ml.x, lineY + 0.25, ml.z);
    ns.group.localToWorld(markerWorld);

    const markerMat = new THREE.MeshStandardMaterial({
      color: 0xff8800,
      emissive: 0xff6600,
      emissiveIntensity: 0.4,
      transparent: true,
      opacity: 0.8,
    });
    const marker = new THREE.Mesh(ingressMarkerGeo, markerMat);
    marker.position.copy(markerWorld);
    marker.userData = {
      type: 'ingress',
      ingress: ing,
      tooltipHTML: ingressTooltipHTML(ing),
    };
    group.add(marker);
    registerRayTarget(marker);

    let sumX = 0, sumZ = 0;
    for (const podMesh of targetPodMeshes) {
      sumX += podMesh.position.x;
      sumZ += podMesh.position.z;
    }
    const jx = sumX / targetPodMeshes.length;
    const jz = sumZ / targetPodMeshes.length;
    const jzOffset = jz + (ml.z - jz) * 0.25;

    const trunkPath = orthogonalPath(ml.x, ml.z, jx, jzOffset);
    const trunkWorld = trunkPath.map(p => {
      const v = new THREE.Vector3(p.x, lineY, p.z);
      ns.group.localToWorld(v);
      return v;
    });
    if (trunkWorld.length >= 2) {
      const geo = new THREE.BufferGeometry().setFromPoints(trunkWorld);
      group.add(new THREE.Line(geo, ingressLineMat));
    }

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
        group.add(new THREE.Line(geo, ingressLineMat));
      }
    }
  }

  return group;
}

// ── PVC Lines ───────────────────────────────────────────────────

export function rebuildPVCLines(dirtyNS) {
  rebuildNSLines(pvcNSGroups, ensureParentGroup('pvcLines'), dirtyNS, buildPVCLinesForNS);
}

function buildPVCLinesForNS(ns, nsName) {
  const group = new THREE.Group();
  const lineY = PLATFORM_Y + PLATFORM_HEIGHT + 0.05;
  let markerIdx = 0;

  for (const pvc of state.pvcs) {
    if (pvc.namespace !== nsName) continue;
    if (!ns.platWidth) continue;

    const targetPodMeshes = [];
    for (const [, podMesh] of ns.pods) {
      const pod = podMesh.userData.pod;
      if (pod && pod.pvcNames && pod.pvcNames.includes(pvc.name)) {
        targetPodMeshes.push(podMesh);
      }
    }
    if (targetPodMeshes.length === 0) continue;

    const ml = {
      x: ns.platWidth / 2 - 1 - markerIdx * 2,
      z: ns.platDepth / 2 - 0.8,
    };
    markerIdx++;

    const markerWorld = new THREE.Vector3(ml.x, lineY + 0.25, ml.z);
    ns.group.localToWorld(markerWorld);

    const markerMat = new THREE.MeshStandardMaterial({
      color: 0xaa44ff,
      emissive: 0x8822dd,
      emissiveIntensity: 0.4,
      transparent: true,
      opacity: 0.8,
    });
    const marker = new THREE.Mesh(pvcMarkerGeo, markerMat);
    marker.position.copy(markerWorld);
    marker.userData = {
      type: 'pvc',
      pvc: pvc,
      tooltipHTML: pvcTooltipHTML(pvc),
    };
    group.add(marker);
    registerRayTarget(marker);

    let sumX = 0, sumZ = 0;
    for (const podMesh of targetPodMeshes) {
      sumX += podMesh.position.x;
      sumZ += podMesh.position.z;
    }
    const jx = sumX / targetPodMeshes.length;
    const jz = sumZ / targetPodMeshes.length;
    const jzOffset = jz + (ml.z - jz) * 0.25;

    const trunkPath = orthogonalPath(ml.x, ml.z, jx, jzOffset);
    const trunkWorld = trunkPath.map(p => {
      const v = new THREE.Vector3(p.x, lineY, p.z);
      ns.group.localToWorld(v);
      return v;
    });
    if (trunkWorld.length >= 2) {
      const geo = new THREE.BufferGeometry().setFromPoints(trunkWorld);
      group.add(new THREE.Line(geo, pvcLineMat));
    }

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
        group.add(new THREE.Line(geo, pvcLineMat));
      }
    }
  }

  return group;
}

export function pvcTooltipHTML(pvc) {
  const statusColor = pvc.status === 'Bound' ? '#00ff88' : pvc.status === 'Pending' ? '#ffcc00' : '#ff4444';
  let html = `<div class="pod-name">${pvc.name}</div>`;
  html += `<div class="pod-ns">${pvc.namespace}</div>`;
  html += `<div class="pod-status" style="color:${statusColor}">● ${pvc.status}</div>`;
  if (pvc.requestedStorage) html += `<div>Storage: ${pvc.requestedStorage}</div>`;
  if (pvc.storageClassName) html += `<div style="opacity:0.7">StorageClass: ${pvc.storageClassName}</div>`;
  if (pvc.volumeName) html += `<div style="opacity:0.7">PV: ${pvc.volumeName}</div>`;
  return html;
}

export function ingressTooltipHTML(ing) {
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
