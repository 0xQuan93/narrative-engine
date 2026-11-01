import * as THREE from 'three';
import {GLTFLoader} from 'three/addons/loaders/GLTFLoader.js';
import {VRMLoaderPlugin, VRMUtils} from '@pixiv/three-vrm';
import {compileEpisode, resolveEnvironment} from '../episode.mjs';
import {practicalGain} from '../music.mjs';
import {replaySprings} from './spring-window.mjs';
import {axesForVrm, poseForVrm} from '../vrm-pose.mjs';
import {stableDrawOrder} from './draw-order.mjs';
import {MOUTH_SHAPES} from '../dialogue.mjs';
import {applyMeasuredAim, boneLookEyeRotations, resolveExpressionWeights} from '../reactive-motion.mjs';
import {EffectComposer} from 'three/addons/postprocessing/EffectComposer.js';
import {RenderPass} from 'three/addons/postprocessing/RenderPass.js';
import {BokehPass} from 'three/addons/postprocessing/BokehPass.js';
import {OutputPass} from 'three/addons/postprocessing/OutputPass.js';

// No clocks, animation mixers, random blinks, or requestAnimationFrame.
// Spring bones stay at their imported rest unless episode.secondary sets
// springWindowFrames. That path resets the solver and replays a fixed window
// of evaluated poses, so a frame does not depend on seek order. vrm.lookAt.update is
// not called. Bone look-at avatars get leftEye/rightEye from the loaded range map
// before humanoid.update, which copies normalized bones onto the raw rig. A second
// update would stomp those eyes. Expression look-at stays on blendshape weights.
// Pointing is re-solved from the loaded arm rest so an A-pose does not stay out
// to the side. Actor slots are 1.7m apart, matching src/reactive-motion.mjs.
// All mutable avatar state is reset before each absolute-frame evaluation.

const LOOK_BLENDSHAPES = ['lookUp', 'lookDown', 'lookLeft', 'lookRight'];

function quatForMeta(quaternion, metaVersion) {
  return poseForVrm({hips: {rotation: quaternion}}, metaVersion).hips.rotation;
}

function applyLoadedAim(vrm, motion, metaVersion) {
  const aim = motion?.aim;
  if (!aim || aim.weight <= 0) return;
  const lower = vrm.humanoid.getNormalizedBoneNode('rightLowerArm');
  const hand = vrm.humanoid.getNormalizedBoneNode('rightHand');
  if (!lower || !hand) return;
  const upperRest = [lower.position.x, lower.position.y, lower.position.z];
  const lowerRest = [hand.position.x, hand.position.y, hand.position.z];
  const upperLength = Math.hypot(...upperRest);
  const lowerLength = Math.hypot(...lowerRest);
  if (upperLength < 1e-4 || lowerLength < 1e-4) return;
  const aimed = applyMeasuredAim({
    upper: quatForMeta(aim.upper, metaVersion),
    lower: quatForMeta(aim.lower, metaVersion),
    direction: axesForVrm(aim.direction, metaVersion),
    weight: aim.weight,
    upperRest,
    lowerRest,
    upperLength,
    lowerLength,
  });
  vrm.humanoid.setNormalizedPose({
    rightUpperArm: {rotation: aimed.upper},
    rightLowerArm: {rotation: aimed.lower},
  });
}

function applyBoneLook(vrm, motion, metaVersion) {
  const applier = vrm.lookAt?.applier;
  if (applier?.constructor?.type !== 'bone' || !motion) return false;
  // eyeYaw/eyePitch exist only when a reactivity eyes block added saccades.
  // Without them the look yaw and pitch are the pre-eyes values.
  const yaw = motion.eyeYaw ?? motion.lookYaw ?? 0;
  const pitch = motion.eyePitch ?? motion.lookPitch ?? 0;
  if (!applier.rangeMapHorizontalInner || Math.hypot(yaw, pitch) < 1e-6) return true;
  const eyes = boneLookEyeRotations(yaw, pitch, {
    horizontalInner: (value) => applier.rangeMapHorizontalInner.map(value),
    horizontalOuter: (value) => applier.rangeMapHorizontalOuter.map(value),
    verticalDown: (value) => applier.rangeMapVerticalDown.map(value),
    verticalUp: (value) => applier.rangeMapVerticalUp.map(value),
  });
  vrm.humanoid.setNormalizedPose({
    leftEye: {rotation: quatForMeta(eyes.left, metaVersion)},
    rightEye: {rotation: quatForMeta(eyes.right, metaVersion)},
  });
  return true;
}

function withoutLookBlendshapes(expressions) {
  const next = {...expressions};
  for (const name of LOOK_BLENDSHAPES) delete next[name];
  return next;
}

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

  const dressing = [];
  const practicals = [];
  const mesh = (geometry, color, x, y, z, emissive = false) => {
    const material = emissive ? new THREE.MeshBasicMaterial({color})
      : new THREE.MeshStandardMaterial({color, roughness: 0.8, metalness: 0.15});
    const object = new THREE.Mesh(geometry, material);
    object.position.set(x, y, z); scene.add(object); dressing.push(object); return object;
  };
  const markPractical = (object, peak) => {
    object.userData.restColor = object.material.color.clone();
    object.userData.peakColor = new THREE.Color(peak);
    practicals.push(object);
    return object;
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
  markPractical(mesh(new THREE.SphereGeometry(0.19, 32, 16), '#e2bd83', 2.1, 1.8, -1.9, true), '#fff1c7');
  mesh(new THREE.CylinderGeometry(0.02, 0.02, 1.6, 12), '#516168', 2.1, 0.8, -1.9);
  const episodeEnv = resolveEnvironment(episode.environment);
  const shotEnvs = episode.shots.map((shot) => resolveEnvironment(shot.environment ?? episode.environment));
  const usesDepth = episodeEnv.base === 'depth-studio' || shotEnvs.some((env) => env.base === 'depth-studio');
  const usesNight = episodeEnv.base === 'night-roof' || shotEnvs.some((env) => env.base === 'night-roof');
  const usesPulse = episodeEnv.lightPulse > 0 || shotEnvs.some((env) => env.lightPulse > 0);
  const studioBackground = new THREE.Color('#10191d');
  const nightBackground = new THREE.Color('#070b14');
  if (usesDepth) {
    // Deliberate depth cues behind the actor: thin edges and round practicals
    // reveal the circle-of-confusion in a matched sharp/blur comparison.
    for (const x of [-0.48, 0.48]) {
      mesh(new THREE.BoxGeometry(0.018, 1.65, 0.018), '#79d7dc', x, 1.38, -2.17, true);
      for (let i = 0; i < 6; i++) {
        markPractical(mesh(new THREE.SphereGeometry(0.038, 16, 12), i % 2 ? '#fac78f' : '#b6fcf4',
          x + (x > 0 ? -0.10 : 0.10), 0.62 + i * 0.32, -2.11 - (i % 2) * 0.1, true), '#fff6e4');
      }
    }
    for (const x of [-0.31, 0.31]) {
      mesh(new THREE.BoxGeometry(0.012, 0.8, 0.016), '#497982', x, 1.62, -2.24, true);
    }
  }
  let nightGroup = null;
  if (usesNight) {
    nightGroup = new THREE.Group();
    nightGroup.visible = false;
    scene.add(nightGroup);
    const nightMesh = (geometry, color, x, y, z, emissive = false) => {
      const material = emissive ? new THREE.MeshBasicMaterial({color})
        : new THREE.MeshStandardMaterial({color, roughness: 0.9, metalness: 0.05});
      const object = new THREE.Mesh(geometry, material);
      object.position.set(x, y, z);
      nightGroup.add(object);
      return object;
    };
    const roof = nightMesh(new THREE.PlaneGeometry(60, 60), '#141820', 0, -0.02, 0);
    roof.rotation.x = -Math.PI / 2;
    nightMesh(new THREE.BoxGeometry(18, 6, 0.2), '#0c1018', 0, 2.2, -4.2);
    nightMesh(new THREE.BoxGeometry(16, 0.08, 0.4), '#1b2433', 0, 3.4, -4);
    for (const [x, color] of [[-2.4, '#163a46'], [0.2, '#3a2a18'], [2.2, '#123044']]) {
      markPractical(nightMesh(new THREE.BoxGeometry(0.7, 1.1, 0.05), color, x, 2.1, -4.05, true), '#d7fbff');
    }
    nightMesh(new THREE.SphereGeometry(0.16, 24, 16), '#d8e4ef', -3.4, 3.5, -3.2, true);
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
      const authored = new Set();
      for (const shot of episode.shots) for (const performance of shot.performances) {
        if (performance.actorId !== actor.id) continue;
        for (const key of performance.expressions ?? []) for (const name of Object.keys(key.values)) authored.add(name);
      }
      // Frozen secondary bones retain their imported rest transforms.
      avatars.set(actor.id, {vrm, wrapper, rest, authored});
    }
  } catch (error) {
    dispose(); throw error;
  }
  const order = stableDrawOrder(scene);
  renderer.setOpaqueSort(order.opaque);
  renderer.setTransparentSort(order.transparent);

  function restoreRest(avatar) {
    for (const entry of avatar.rest) {
      entry.object.position.copy(entry.position);
      entry.object.quaternion.copy(entry.quaternion);
      entry.object.scale.copy(entry.scale);
    }
  }

  function applyActorPose(actor, avatar) {
    const {vrm} = avatar;
    restoreRest(avatar);
    vrm.humanoid.resetNormalizedPose();
    const metaVersion = vrm.meta.metaVersion;
    vrm.humanoid.setNormalizedPose(poseForVrm(actor.pose, metaVersion));
    applyLoadedAim(vrm, actor.motion, metaVersion);
    const boneEyes = applyBoneLook(vrm, actor.motion, metaVersion);
    vrm.humanoid.update();
    vrm.nodeConstraintManager?.update();
    return boneEyes;
  }

  function applyActorExpressions(actor, avatar, boneEyes) {
    const {vrm, authored} = avatar;
    const expressions = boneEyes ? withoutLookBlendshapes(actor.expressions) : actor.expressions;
    const weights = resolveExpressionWeights(
      expressions,
      (name) => Boolean(vrm.expressionManager?.getExpression(name)),
      authored,
      actor.id,
    );
    vrm.expressionManager?.resetValues();
    for (const [name, weight] of weights) vrm.expressionManager.setValue(name, weight);
    vrm.expressionManager?.update();
  }

  function poseActors(sample) {
    const performing = new Set(episode.shots.find((shot) => shot.id === sample.shotId).performances.map((p) => p.actorId));
    const boneEyes = new Map();
    for (const actor of sample.actors) {
      const avatar = avatars.get(actor.id);
      avatar.wrapper.visible = performing.has(actor.id);
      boneEyes.set(actor.id, applyActorPose(actor, avatar));
    }
    return boneEyes;
  }

  function renderAtFrame(frame) {
    const state = evaluateFrame(frame);
    camera.position.fromArray(state.camera.position);
    // Portrait exports keep the avatar and authored gestures within the
    // narrow viewport while preserving the scene's camera-cut directions.
    camera.fov = width < height ? Math.min(85, state.camera.fov * 1.4) : state.camera.fov;
    camera.up.set(0, 1, 0);
    camera.lookAt(...state.camera.target);
    camera.rotateZ(THREE.MathUtils.degToRad(state.camera.rollDegrees ?? 0));
    camera.updateProjectionMatrix();
    const windowFrames = episode.secondary?.springWindowFrames ?? 0;
    const managers = windowFrames > 0
      ? [...avatars.values()].map((avatar) => avatar.vrm.springBoneManager).filter((manager) => manager?.joints?.size)
      : [];
    let boneEyes;
    if (managers.length) {
      for (const avatar of avatars.values()) {
        restoreRest(avatar);
        avatar.vrm.humanoid.resetNormalizedPose();
      }
      scene.updateMatrixWorld(true);
      replaySprings(managers, frame, windowFrames, 1 / episode.fps, (cursor) => {
        const sample = cursor === frame ? state : evaluateFrame(cursor);
        boneEyes = poseActors(sample);
        scene.updateMatrixWorld(true);
      });
    } else {
      boneEyes = poseActors(state);
    }
    for (const actor of state.actors) applyActorExpressions(actor, avatars.get(actor.id), boneEyes.get(actor.id));
    const shot = episode.shots.find((entry) => entry.id === state.shotId);
    const env = resolveEnvironment(shot.environment ?? episode.environment);
    if (usesNight) {
      const night = env.base === 'night-roof';
      for (const object of dressing) object.visible = !night;
      if (nightGroup) nightGroup.visible = night;
      scene.background.copy(night ? nightBackground : studioBackground);
      scene.fog.color.copy(night ? nightBackground : studioBackground);
    }
    if (usesPulse) {
      const gain = practicalGain(state.frame, episode.music?.beats, env.lightPulse);
      for (const object of practicals) {
        object.material.color.copy(object.userData.restColor).lerp(object.userData.peakColor, gain);
      }
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
