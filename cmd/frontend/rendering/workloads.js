import * as THREE from 'three';
import { state, WORKLOAD_Y, WORKLOAD_BOX_HEIGHT } from '../core/state.js';
import { scene } from '../core/scene.js';
import { makeLabel } from './labels.js';
import { applyLayerVisibility } from './layers.js';

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

  // Workload kind abbreviations and colors
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

  // Track which pods are already claimed to avoid double-matching
  const claimedPods = new Set();

  // Process workloads: most specific owners first
  const wlSorted = [...state.workloads].sort((a, b) => {
    const order = { Job: 0, Deployment: 1, StatefulSet: 2, DaemonSet: 3, CronJob: 4 };
    return (order[a.kind] ?? 5) - (order[b.kind] ?? 5);
  });

  // Pre-count orphans per namespace for centering
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

    // Find matching pods (only unclaimed ones)
    const matchedMeshes = [];
    for (const [podName, podMesh] of ns.pods) {
      if (claimedPods.has(wl.namespace + '/' + podName)) continue;
      const pod = podMesh.userData.pod;
      if (!pod) continue;

      let matched = false;
      if (pod.ownerKind === wl.kind && pod.ownerName === wl.name) {
        matched = true;
      }
      // CronJob: match pods owned by child Jobs
      if (!matched && wl.kind === 'CronJob') {
        const jobNames = cronJobToJobs.get(wl.namespace + '/' + wl.name) || [];
        if (pod.ownerKind === 'Job' && jobNames.includes(pod.ownerName)) {
          matched = true;
        }
      }
      if (matched) {
        matchedMeshes.push(podMesh);
        claimedPods.add(wl.namespace + '/' + podName);
      }
    }

    const outlineColor = WL_COLORS[wl.kind] || 0x00ff88;
    let cx, cz, w, d;

    if (matchedMeshes.length === 0) {
      // Place orphan workloads in the orphan zone
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
      // Compute bounding box of matched pods
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

export { rebuildWorkloadGroups };
