import * as THREE from 'three';
import { state } from '../core/state.js';
import { scene } from '../core/scene.js';
import { invalidateMeshCache } from '../interaction/raycast.js';
import { applyLayerVisibility } from './layers.js';

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

  const TUBE_RADIUS = 0.06;
  const TUBE_SEGMENTS = 20;
  const TUBE_RADIAL = 6;

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

    if (matchedMeshes.length < 1) continue;

    const worldPos = (mesh) => {
      const v = new THREE.Vector3();
      mesh.getWorldPosition(v);
      return v;
    };

    // Compute service anchor point: center above all matched pods
    const center = new THREE.Vector3();
    for (const m of matchedMeshes) center.add(worldPos(m));
    center.divideScalar(matchedMeshes.length);
    center.y += 2.5;

    // Service hub -- a small glowing sphere at the anchor point
    const hubGeo = new THREE.SphereGeometry(0.18, 12, 12);
    const hubMat = new THREE.MeshPhongMaterial({
      color: 0x00aaff, emissive: 0x00aaff, emissiveIntensity: 0.8,
      transparent: true, opacity: 0.9,
    });
    const hub = new THREE.Mesh(hubGeo, hubMat);
    hub.position.copy(center);
    hub.userData = {
      type: 'service',
      service: svc,
      matchedPodCount: matchedMeshes.length,
    };
    group.add(hub);

    // Draw tubes from hub to each matched pod
    const tubeMat = new THREE.MeshPhongMaterial({
      color: 0x00aaff,
      emissive: 0x004466,
      emissiveIntensity: 0.5,
      transparent: true,
      opacity: 0.35,
      depthWrite: false,
    });

    for (const podMesh of matchedMeshes) {
      const target = worldPos(podMesh);
      const mid = center.clone().add(target).multiplyScalar(0.5);
      mid.y += 1.0;
      const curve = new THREE.QuadraticBezierCurve3(center, mid, target);
      const tubeGeo = new THREE.TubeGeometry(curve, TUBE_SEGMENTS, TUBE_RADIUS, TUBE_RADIAL, false);
      const tube = new THREE.Mesh(tubeGeo, tubeMat.clone());
      tube.userData = {
        type: 'service',
        service: svc,
        matchedPodCount: matchedMeshes.length,
      };
      group.add(tube);
    }
  }

  state.serviceLines = group;
  scene.add(group);
  invalidateMeshCache();
  applyLayerVisibility();
}

export {
  selectorMatchesLabels,
  rebuildServiceLines,
};
