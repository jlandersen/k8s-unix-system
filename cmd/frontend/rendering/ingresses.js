import * as THREE from 'three';
import { state } from '../core/state.js';
import { scene } from '../core/scene.js';
import { makeLabel } from './labels.js';
import { selectorMatchesLabels } from './services.js';
import { invalidateMeshCache } from '../interaction/raycast.js';
import { applyLayerVisibility } from './layers.js';

// Resolve URLs for a pod: Ingress -> Service -> Pod chain
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

  // Group ingresses by namespace -- one gate per namespace
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

    // Top bar
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

export {
  podURLs,
  rebuildIngresses,
};
