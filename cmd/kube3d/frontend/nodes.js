import * as THREE from 'three';
import { state, NODE_BLOCK_SIZE, PLATFORM_HEIGHT } from './state.js';
import { scene } from './scene.js';
import { disposeMesh, nodePlatformMaterial, nodeBlockMaterial } from './materials.js';
import { makeLabel, makeBeveledPlatformGeo } from './labels.js';
import { spot, clearPodLabels, fadeOutSpotlight } from './spotlight.js';
import { registerRayTarget, unregisterRayTarget } from './raycast.js';

export function ensureNodeIsland() {
  if (state.nodeIsland) return state.nodeIsland;
  const group = new THREE.Group();
  group.userData = { type: 'namespace', name: '__nodes__' };
  scene.add(group);
  state.nodeIsland = { group, platform: null, blocks: new Map(), label: null };
  registerRayTarget(group);
  return state.nodeIsland;
}

export function clearNodeIsland() {
  const island = state.nodeIsland;
  if (!island) return;
  if (spot.nsName === '__nodes__') {
    clearPodLabels();
    fadeOutSpotlight();
  }

  for (const [, mesh] of island.blocks) {
    island.group.remove(mesh);
    unregisterRayTarget(mesh);
    disposeMesh(mesh);
  }
  island.blocks.clear();

  if (island.platform) {
    island.group.remove(island.platform);
    unregisterRayTarget(island.platform);
    disposeMesh(island.platform);
    island.platform = null;
  }
  if (island.label) {
    island.group.remove(island.label);
    unregisterRayTarget(island.label);
    disposeMesh(island.label);
    island.label = null;
  }

  scene.remove(island.group);
  unregisterRayTarget(island.group);
  state.nodeIsland = null;
}

export function rebuildNodeIsland() {
  const island = ensureNodeIsland();

  let changed = false;

  for (const [name, mesh] of island.blocks) {
    if (!state.nodes.has(name)) {
      island.group.remove(mesh);
      unregisterRayTarget(mesh);
      mesh.geometry.dispose();
      mesh.material.dispose();
      island.blocks.delete(name);
      changed = true;
    }
  }

  for (const [name, info] of state.nodes) {
    const existing = island.blocks.get(name);
    if (existing) {
      if (existing.userData.node.status !== info.status) {
        existing.material.dispose();
        existing.material = nodeBlockMaterial(info.status);
      }
      existing.userData = { type: 'nodeBlock', node: info };
    } else {
      const geo = new THREE.BoxGeometry(NODE_BLOCK_SIZE, NODE_BLOCK_SIZE, NODE_BLOCK_SIZE);
      const mat = nodeBlockMaterial(info.status);
      const mesh = new THREE.Mesh(geo, mat);
      mesh.userData = { type: 'nodeBlock', node: info };
      island.blocks.set(name, mesh);
      island.group.add(mesh);
      registerRayTarget(mesh);
      changed = true;
    }
  }

  if (changed && island.blocks.size > 1) {
    const sorted = [...island.blocks.entries()].sort((a, b) => a[0].localeCompare(b[0]));
    island.blocks.clear();
    for (const [name, mesh] of sorted) island.blocks.set(name, mesh);
  }
}

export function layoutNodeIsland() {
  const island = state.nodeIsland;
  if (!island) return;

  const blockCount = island.blocks.size;
  if (blockCount === 0) return;

  const blockStride = NODE_BLOCK_SIZE + 1.2;
  const blockCols = Math.max(2, Math.ceil(Math.sqrt(blockCount)));
  const blockRows = Math.max(1, Math.ceil(blockCount / blockCols));
  const platWidth = blockCols * blockStride + 2;
  const platDepth = blockRows * blockStride + 2;

  const dimChanged = island._platWidth !== platWidth || island._platDepth !== platDepth;

  if (dimChanged) {
    if (island.platform) {
      island.group.remove(island.platform);
      unregisterRayTarget(island.platform);
      disposeMesh(island.platform);
    }
    const platGeo = makeBeveledPlatformGeo(platWidth, PLATFORM_HEIGHT, platDepth);
    island.platform = new THREE.Mesh(platGeo, nodePlatformMaterial.clone());
    island.platform.position.y = -PLATFORM_HEIGHT / 2;
    island.platform.userData = { type: 'namespace', name: '__nodes__' };
    island.group.add(island.platform);
    registerRayTarget(island.platform);

    if (!island.label) {
      island.label = makeLabel('NODES', 64, 1.8, 0.82, "'Smooch Sans', sans-serif", '300');
      island.group.add(island.label);
      registerRayTarget(island.label);
    }
    island.label.position.set(0, 0.15, platDepth / 2 + 2);

    island._platWidth = platWidth;
    island._platDepth = platDepth;
  }

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
