// The race's ending: each lane's final design as its 3D radiation lobe (the .glb that `noburf solve` writes for a
// far-field frequency), turning slowly. Loaded only when both run logs carry "lobe_glb".
import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';

const TURN_SECONDS = 14;
// noburf exports the lobe over 30 dB (radius 0 at 30 dB below the peak). A patch is broad, and over 30 dB it reads
// as a ball; over 20 dB its shape shows. Each vertex keeps its direction and its colour.
const EXPORTED_RANGE_DB = 30;
const SHOWN_RANGE_DB = 20;

function rescaleLobe(lobe) {
  const keep = (EXPORTED_RANGE_DB - SHOWN_RANGE_DB) / EXPORTED_RANGE_DB;
  lobe.traverse((node) => {
    if (!node.isMesh) return;
    const position = node.geometry.attributes.position;
    const v = new THREE.Vector3();
    let peak = 0;
    for (let n = 0; n < position.count; n++) peak = Math.max(peak, v.fromBufferAttribute(position, n).length());
    for (let n = 0; n < position.count; n++) {
      v.fromBufferAttribute(position, n);
      const level = v.length() / peak; // 0..1 over the exported range
      const shown = Math.max(0, (level - keep) / (1 - keep));
      v.setLength(shown * peak);
      position.setXYZ(n, v.x, v.y, v.z);
    }
    position.needsUpdate = true;
    node.geometry.computeVertexNormals();
  });
}

function lobeView(container, { url, colour, caption }) {
  const figure = Object.assign(document.createElement('figure'), { className: 'lobe' });
  figure.style.margin = '0';
  const canvas = document.createElement('canvas');
  const label = Object.assign(document.createElement('p'), { textContent: caption });
  label.style.color = colour;
  figure.append(canvas, label);
  container.append(figure);

  const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: true });
  renderer.setPixelRatio(2);
  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(32, 1, 0.1, 50);
  // The board plane, for scale and orientation: the lobe's +z (broadside) points up here.
  const board = new THREE.GridHelper(1.6, 8, 0x3a4456, 0x1b2230);
  scene.add(board);
  const turntable = new THREE.Group();
  scene.add(turntable);

  return new GLTFLoader().loadAsync(url).then((gltf) => {
    const lobe = gltf.scene;
    rescaleLobe(lobe);
    // glb.ts already turns the beam (+z) up (+y), as glTF expects: no rotation here.
    // noburf writes the lobe at true scale beside a board, its peak 0.1 m from the antenna: bring the peak to 1 so
    // it fills the view. Every lobe is drawn relative to its own peak, so this shows shape, not gain.
    const extent = new THREE.Box3().setFromObject(lobe);
    const reach = Math.max(...extent.min.toArray().map(Math.abs), ...extent.max.toArray().map(Math.abs));
    if (reach > 0) lobe.scale.setScalar(1 / reach);
    turntable.add(lobe);
    // Frame the lobe's bounding sphere so it fills the panel's smaller dimension, looking at its centre from a
    // little above the board. A patch's dB-scale lobe is a broad dome: from near the board plane it reads as one.
    lobe.updateMatrixWorld(true);
    const sphere = new THREE.Sphere(new THREE.Vector3(), -1);
    lobe.traverse((node) => {
      if (!node.isMesh) return;
      node.geometry.computeBoundingSphere();
      sphere.union(node.geometry.boundingSphere.clone().applyMatrix4(node.matrixWorld));
    });
    const fit = (aspect) => {
      const halfFovV = THREE.MathUtils.degToRad(camera.fov / 2);
      const halfFovH = Math.atan(Math.tan(halfFovV) * aspect);
      const distance = (1.12 * sphere.radius) / Math.sin(Math.min(halfFovV, halfFovH));
      const direction = new THREE.Vector3(1, 0.3, 1).normalize();
      camera.position.copy(sphere.center).addScaledVector(direction, distance);
      camera.lookAt(sphere.center);
    };
    const resize = () => {
      const { clientWidth: w, clientHeight: h } = canvas;
      renderer.setSize(w, h, false);
      camera.aspect = w / h;
      camera.updateProjectionMatrix();
      fit(camera.aspect);
    };
    return {
      start() {
        resize();
        renderer.setAnimationLoop((ms) => {
          turntable.rotation.y = ((ms / 1000) / TURN_SECONDS) * 2 * Math.PI;
          renderer.render(scene, camera);
        });
      },
    };
  });
}

/** Loads both lobes up front (so the ending does not wait on the network), and returns show(). */
export async function prepareLobes(container, lanes) {
  const views = await Promise.all(lanes.map((lane) => lobeView(container, lane)));
  return {
    show() {
      container.classList.add('shown');
      views.forEach((view) => view.start());
    },
  };
}
