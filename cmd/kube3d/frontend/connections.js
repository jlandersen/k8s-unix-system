import * as THREE from 'three';
import { state, PLATFORM_Y, PLATFORM_HEIGHT } from './state.js';
import { scene } from './scene.js';

export function selectorMatchesLabels(selector, labels) {
  if (!selector || !labels) return false;
  for (const [k, v] of Object.entries(selector)) {
    if (labels[k] !== v) return false;
  }
  return true;
}

export function rebuildServiceLines() {
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
      const line = new THREE.Line(geo, lineMat.clone());
      group.add(line);
    }
  }

  state.serviceLines = group;
  scene.add(group);
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

export function rebuildIngressLines() {
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
      group.add(new THREE.Line(geo, lineMat.clone()));
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
        group.add(new THREE.Line(geo, lineMat.clone()));
      }
    }
  }

  state.ingressLines = group;
  scene.add(group);
}

export function rebuildPVCLines() {
  if (state.pvcLines) {
    scene.remove(state.pvcLines);
    state.pvcLines.traverse((child) => {
      if (child.geometry) child.geometry.dispose();
      if (child.material) child.material.dispose();
    });
  }

  const group = new THREE.Group();
  group.userData = { type: 'pvcLines' };

  const lineY = PLATFORM_Y + PLATFORM_HEIGHT + 0.05;
  const lineMat = new THREE.LineBasicMaterial({
    color: 0xaa44ff,
    transparent: true,
    opacity: 0.35,
    depthWrite: false,
  });

  const nsMarkerCount = new Map();

  for (const pvc of state.pvcs) {
    const ns = state.namespaces.get(pvc.namespace);
    if (!ns || !ns.platWidth) continue;

    const targetPodMeshes = [];
    for (const [, podMesh] of ns.pods) {
      const pod = podMesh.userData.pod;
      if (pod && pod.pvcNames && pod.pvcNames.includes(pvc.name)) {
        targetPodMeshes.push(podMesh);
      }
    }
    if (targetPodMeshes.length === 0) continue;

    const idx = nsMarkerCount.get(pvc.namespace) ?? 0;
    nsMarkerCount.set(pvc.namespace, idx + 1);
    const ml = {
      x: ns.platWidth / 2 - 1 - idx * 2,
      z: ns.platDepth / 2 - 0.8,
    };

    const markerWorld = new THREE.Vector3(ml.x, lineY + 0.25, ml.z);
    ns.group.localToWorld(markerWorld);

    const markerGeo = new THREE.CylinderGeometry(0.22, 0.22, 0.45, 8);
    const markerMat = new THREE.MeshStandardMaterial({
      color: 0xaa44ff,
      emissive: 0x8822dd,
      emissiveIntensity: 0.4,
      transparent: true,
      opacity: 0.8,
    });
    const marker = new THREE.Mesh(markerGeo, markerMat);
    marker.position.copy(markerWorld);
    marker.userData = {
      type: 'pvc',
      pvc: pvc,
      tooltipHTML: pvcTooltipHTML(pvc),
    };
    group.add(marker);

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
      group.add(new THREE.Line(geo, lineMat.clone()));
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
        group.add(new THREE.Line(geo, lineMat.clone()));
      }
    }
  }

  state.pvcLines = group;
  scene.add(group);
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
