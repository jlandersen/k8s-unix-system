import * as THREE from 'three';
import { state, PVC_Y } from '../core/state.js';
import { scene } from '../core/scene.js';
import { applyLayerVisibility } from './layers.js';

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

export { rebuildPVCs };
