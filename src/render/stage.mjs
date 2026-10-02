import * as THREE from 'three';
import {GLTFLoader} from 'three/addons/loaders/GLTFLoader.js';
import {VRMLoaderPlugin, VRMUtils} from '@pixiv/three-vrm';
import {compileEpisode} from '../episode.mjs';
import {poseForVrm} from '../vrm-pose.mjs';
import {stableDrawOrder} from './draw-order.mjs';
import {MOUTH_SHAPES} from '../dialogue.mjs';
import {EffectComposer} from 'three/addons/postprocessing/EffectComposer.js';
import {RenderPass} from 'three/addons/postprocessing/RenderPass.js';
import {BokehPass} from 'three/addons/postprocessing/BokehPass.js';
import {OutputPass} from 'three/addons/postprocessing/OutputPass.js';

// No clocks, animation mixers, random blinks, spring physics or requestAnimationFrame.
// All mutable avatar state is reset before each absolute-frame evaluation.
export async function createStage({canvas, width, height, episode, assets, assetUrl}) {
  const evaluateFrame = compileEpisode(episode);
  const renderer = new THREE.WebGLRenderer({canvas, antialias: true, alpha: false,
    preserveDrawingBuffer: true, powerPreference: 'high-performance'});
  renderer.setPixelRatio(1);
  renderer.setSize(width, height, false);
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  renderer.toneMapping = THREE.NoToneMapping;
  const scene = new THREE.Scene();
  scene.background = new THREE.Color('#10191d');
  scene.fog = new THREE.Fog('#10191d', 8, 24);
  const camera = new THREE.PerspectiveCamera(38, width / height, 0.05, 60);
  const usesDepthOfField = episode.shots.some((shot) => shot.camera.depthOfField?.aperture > 0);
  const composer = usesDepthOfField ? new EffectComposer(renderer) : null;
  const bokeh = usesDepthOfField ? new BokehPass(scene, camera, {focus: 2.5, aperture: 0, maxblur: 0}) : null;
  const outputPass = usesDepthOfField ? new OutputPass() : null;
  if (composer) { composer.addPass(new RenderPass(scene, camera)); composer.addPass(bokeh); composer.addPass(outputPass); }
  scene.add(new THREE.HemisphereLight('#f0f6ff', '#72766d', 2));
  const key = new THREE.DirectionalLight('#fff1df', 2.4);
  key.position.set(3, 5, 4); scene.add(key);
  const fill = new THREE.DirectionalLight('#8bd6ef', 1.2);
  fill.position.set(-3, 2.5, 1); scene.add(fill);
  const rim = new THREE.DirectionalLight('#8ee9dc', 2);
  rim.position.set(0, 3, -3); scene.add(rim);

  const mesh = (geometry, color, x, y, z, emissive = false) => {
    const material = emissive ? new THREE.MeshBasicMaterial({color})
      : new THREE.MeshStandardMaterial({color, roughness: 0.8, metalness: 0.15});
    const object = new THREE.Mesh(geometry, material);
    object.position.set(x, y, z); scene.add(object); return object;
  };
  const floor = mesh(new THREE.PlaneGeometry(60, 60), '#283237', 0, -0.025, 0);
  floor.rotation.x = -Math.PI / 2;
  mesh(new THREE.CylinderGeometry(1.2, 1.25, 0.035, 96), '#38464a', 0, -0.012, 0);
  const ring = mesh(new THREE.TorusGeometry(1.15, 0.008, 8, 128), '#78b8b1', 0, 0.012, 0, true);
  ring.rotation.x = Math.PI / 2;
  mesh(new THREE.BoxGeometry(10, 5, 0.12), '#17272e', 0, 2, -2.5);
  for (const x of [-3.8, -2.5, -1.2, 1.2, 2.5, 3.8]) {
    mesh(new THREE.BoxGeometry(0.024, 3.2, 0.04), '#38616a', x, 1.7, -2.41, true);
  }
  mesh(new THREE.BoxGeometry(8, 0.022, 0.04), '#64878a', 0, 0.45, -2.4, true);
  mesh(new THREE.SphereGeometry(0.19, 32, 16), '#e2bd83', 2.1, 1.8, -1.9, true);
  mesh(new THREE.CylinderGeometry(0.02, 0.02, 1.6, 12), '#516168', 2.1, 0.8, -1.9);
  if (episode.environment === 'depth-studio') {
    // Deliberate depth cues behind the actor: thin edges and round practicals
    // reveal the circle-of-confusion in a matched sharp/blur comparison.
    for (const x of [-0.48, 0.48]) {
      mesh(new THREE.BoxGeometry(0.018, 1.65, 0.018), '#79d7dc', x, 1.38, -2.17, true);
      for (let i = 0; i < 6; i++) {
        mesh(new THREE.SphereGeometry(0.038, 16, 12), i % 2 ? '#fac78f' : '#b6fcf4',
          x + (x > 0 ? -0.10 : 0.10), 0.62 + i * 0.32, -2.11 - (i % 2) * 0.1, true);
      }
    }
    for (const x of [-0.31, 0.31]) {
      mesh(new THREE.BoxGeometry(0.012, 0.8, 0.016), '#497982', x, 1.62, -2.24, true);
    }
  }

  const avatars = new Map();
  const loader = new GLTFLoader();
  loader.register((parser) => new VRMLoaderPlugin(parser, {autoUpdateHumanBones: true}));
  try {
    for (const [index, actor] of episode.actors.entries()) {
      const asset = assets[actor.assetId];
      if (!asset?.file) throw new Error(`Missing locked asset: ${actor.assetId}`);
      const gltf = await loader.loadAsync(assetUrl(asset.file));
      const vrm = gltf.userData.vrm;
      if (!vrm?.humanoid) throw new Error(`Asset ${actor.assetId} did not load as a humanoid VRM`);
      VRMUtils.rotateVRM0(vrm);
      vrm.scene.updateMatrixWorld(true);
      const bounds = new THREE.Box3().setFromObject(vrm.scene);
      const modelHeight = bounds.max.y - bounds.min.y;
      if (!Number.isFinite(modelHeight) || modelHeight < 0.2 || modelHeight > 20) {
        throw new Error(`Implausible avatar bounds for ${actor.assetId}`);
      }
      const wrapper = new THREE.Group();
      const scale = 1.72 / modelHeight;
      wrapper.scale.setScalar(scale);
      wrapper.position.set((index - (episode.actors.length - 1) / 2) * 1.7, -bounds.min.y * scale, 0);
      wrapper.add(vrm.scene); scene.add(wrapper);
      vrm.scene.traverse((object) => { if (object.isMesh) object.frustumCulled = false; });
      const rest = [];
      vrm.scene.traverse((object) => rest.push({object, position: object.position.clone(),
        quaternion: object.quaternion.clone(), scale: object.scale.clone()}));
      for (const shot of episode.shots) for (const performance of shot.performances.filter((p) => p.actorId === actor.id)) {
        for (const key of performance.sequence.keyframes) poseForVrm(key.pose, vrm.meta.metaVersion);
        for (const key of performance.expressions ?? []) for (const name of Object.keys(key.values)) {
          if (!vrm.expressionManager?.getExpression(name)) throw new Error(`Avatar ${actor.id} has no expression '${name}'`);
        }
      }
      if (episode.dialogue?.actorId === actor.id) {
        for (const name of MOUTH_SHAPES) if (!vrm.expressionManager?.getExpression(name)) {
          throw new Error(`Avatar ${actor.id} needs the '${name}' mouth expression for script animation`);
        }
      }
      // Frozen secondary bones retain their imported rest transforms.
      avatars.set(actor.id, {vrm, wrapper, rest});
    }
  } catch (error) {
    dispose(); throw error;
  }
  const order = stableDrawOrder(scene);
  renderer.setOpaqueSort(order.opaque);
  renderer.setTransparentSort(order.transparent);

  function renderAtFrame(frame) {
    const state = evaluateFrame(frame);
    const active = new Set(episode.shots.find((shot) => shot.id === state.shotId).performances.map((p) => p.actorId));
    camera.position.fromArray(state.camera.position);
    // Portrait exports keep the avatar and authored gestures within the
    // narrow viewport while preserving the scene's camera-cut directions.
    camera.fov = width < height ? Math.min(85, state.camera.fov * 1.4) : state.camera.fov;
    camera.up.set(0, 1, 0);
    camera.lookAt(...state.camera.target);
    camera.rotateZ(THREE.MathUtils.degToRad(state.camera.rollDegrees ?? 0));
    camera.updateProjectionMatrix();
    for (const actor of state.actors) {
      const {vrm, wrapper, rest} = avatars.get(actor.id);
      wrapper.visible = active.has(actor.id);
      for (const entry of rest) {
        entry.object.position.copy(entry.position);
        entry.object.quaternion.copy(entry.quaternion);
        entry.object.scale.copy(entry.scale);
      }
      vrm.humanoid.resetNormalizedPose();
      vrm.humanoid.setNormalizedPose(poseForVrm(actor.pose, vrm.meta.metaVersion));
      vrm.humanoid.update();
      vrm.nodeConstraintManager?.update();
      vrm.expressionManager?.resetValues();
      for (const [name, weight] of Object.entries(actor.expressions)) {
        if (!vrm.expressionManager?.getExpression(name)) {
          throw new Error(`Avatar ${actor.id} has no expression '${name}'`);
        }
        vrm.expressionManager.setValue(name, weight);
      }
      vrm.expressionManager?.update();
    }
    scene.updateMatrixWorld(true);
    if (composer && state.camera.depthOfField?.aperture > 0) {
      const {focusDistance, aperture, maxBlur} = state.camera.depthOfField;
      bokeh.uniforms.focus.value = focusDistance;
      bokeh.uniforms.aperture.value = aperture;
      bokeh.uniforms.maxblur.value = maxBlur;
      composer.render(0);
    } else renderer.render(scene, camera);
    renderer.getContext().finish();
    return state;
  }

  async function pixelsHash() {
    const gl = renderer.getContext();
    const pixels = new Uint8Array(width * height * 4);
    gl.readPixels(0, 0, width, height, gl.RGBA, gl.UNSIGNED_BYTE, pixels);
    const digest = await crypto.subtle.digest('SHA-256', pixels);
    return [...new Uint8Array(digest)].map((v) => v.toString(16).padStart(2, '0')).join('');
  }

  async function verifyFrameOrder() {
    const mouthFrames = MOUTH_SHAPES.flatMap((shape) => {
      const cue = episode.dialogue?.mouthCues.find((entry) => entry.shape === shape);
      return cue ? [Math.floor((cue.startFrame + cue.endFrame) / 2), Math.min(cue.endFrame, episode.durationFrames - 1)] : [];
    });
    const frames = [...new Set([0, episode.durationFrames - 1,
      ...mouthFrames,
      ...episode.shots.flatMap((shot) => [shot.startFrame,
        shot.startFrame + Math.floor(shot.durationFrames / 2),
        shot.startFrame + shot.durationFrames - 1])])].sort((a, b) => a - b);
    const baseline = {};
    for (const frame of frames) { renderAtFrame(frame); baseline[frame] = await pixelsHash(); }
    const shuffled = [...frames.filter((_, i) => i % 2), ...frames.filter((_, i) => !(i % 2)).reverse()];
    for (const frame of shuffled) {
      renderAtFrame(frame);
      if (await pixelsHash() !== baseline[frame]) throw new Error(`Frame ${frame} depends on render order`);
    }
    const gl = renderer.getContext();
    const debug = gl.getExtension('WEBGL_debug_renderer_info');
    return {passed: true, method: 'same-context RGBA SHA-256', frames, order: shuffled,
      distinctFrames: new Set(Object.values(baseline)).size, hashes: baseline,
      webgl: {version: gl.getParameter(gl.VERSION), renderer: debug ? gl.getParameter(debug.UNMASKED_RENDERER_WEBGL) : gl.getParameter(gl.RENDERER)}};
  }

  function dispose() {
    bokeh?.dispose();
    outputPass?.dispose();
    composer?.dispose();
    scene.traverse((object) => {
      object.geometry?.dispose();
      for (const material of [object.material].flat().filter(Boolean)) {
        for (const value of Object.values(material)) if (value?.isTexture) value.dispose();
        material.dispose();
      }
    });
    renderer.dispose();
  }
  return {renderAtFrame, verifyFrameOrder, dispose};
}
