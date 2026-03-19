import * as THREE from 'three';
import { state, layers } from '../core/state.js';
import { scene } from '../core/scene.js';
import { makeLabel } from './labels.js';
import { applyLayerVisibility } from './layers.js';

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

// Map resource kind to layer key
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

  // Group resources by namespace, then by layer
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

    // Group by layer key for visibility
    const byLayer = new Map();
    for (const res of nsResources) {
      const lk = resourceLayerKey(res.kind);
      if (!byLayer.has(lk)) byLayer.set(lk, []);
      byLayer.get(lk).push(res);
    }

    // Distribute layer groups around three edges: left, right, bottom
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

      // Summary label at the start of each strip
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

export {
  RESOURCE_COLORS,
  resourceLayerKey,
  rebuildResources,
};
