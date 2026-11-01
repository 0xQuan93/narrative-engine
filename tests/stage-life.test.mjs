import test from 'node:test';
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {mkdtempSync, readFileSync, writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import * as THREE from 'three';
import {VRMSpringBoneJoint, VRMSpringBoneManager} from '@pixiv/three-vrm-springbone';
import {EPISODE_SCHEMA, evaluateEpisodeAtFrame, validateEpisode} from '../src/episode.mjs';
import {estimateHeadPosition} from '../src/camera-follow.mjs';
import {kickCues, labelSections, practicalGain} from '../src/music.mjs';
import {actorHeadPosition, eulerYXZ, limitRoll, quatYXZ} from '../src/reactive-motion.mjs';
import {replaySprings, SPRING_DRAG, SPRING_GRAVITY_FLOOR, SPRING_SETTLE_FRAMES, tuneSpringManager} from '../src/render/spring-window.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const close = (a, b, tolerance = 1e-6) => assert.ok(Math.abs(a - b) < tolerance, `${a} != ${b}`);

function episode(mutate) {
  const value = {
    schema: EPISODE_SCHEMA, fps: 30, durationFrames: 60,
    actors: [{id: 'a', assetId: 'synthetic'}],
    shots: [{
      id: 'shot', startFrame: 0, durationFrames: 60,
      camera: {position: [0, 1.5, 1.35], target: [0, 1.5, 0], fov: 20},
      performances: [{
        actorId: 'a',
        sequence: {duration: 2, keyframes: [
          {time: 0, pose: {}, easing: 'step'},
          {time: 0.5, pose: {spine: {rotation: quatYXZ(0, 0, 0.45)}}, easing: 'step'},
          {time: 2, pose: {spine: {rotation: quatYXZ(0, 0, 0.45)}}},
        ]},
        reactivity: {look: 'camera', head: 0.7, torso: 0.3, arm: 0, expression: 0.4, autoBeats: false},
      }],
    }],
  };
  mutate?.(value);
  return value;
}

const rise = [
  {frame: 0, energy: 0.35, onset: 0.3},
  {frame: 48, energy: 0.36, onset: 0.3},
  {frame: 96, energy: 0.34, onset: 0.3},
  {frame: 144, energy: 0.38, onset: 0.3},
  {frame: 192, energy: 0.37, onset: 0.3},
  {frame: 240, energy: 0.72, onset: 0.3},
  {frame: 288, energy: 0.75, onset: 0.3},
  {frame: 336, energy: 0.74, onset: 0.3},
];

test('head follow lags a lean and can loosen an extreme close-up without moving the look', () => {
  const rest = estimateHeadPosition(null, 0, 1);
  const anchor = actorHeadPosition(0, 1);
  rest.forEach((value, index) => close(value, anchor[index]));
  const plain = episode();
  const followed = episode((value) => {
    value.shots[0].camera.follow = {target: 'head', lagFrames: 6, amount: 1, margin: 0};
  });
  const early = evaluateEpisodeAtFrame(followed, 15);
  close(early.camera.target[0], 0, 1e-4);
  const latePlain = evaluateEpisodeAtFrame(plain, 21);
  const late = evaluateEpisodeAtFrame(followed, 21);
  const head = estimateHeadPosition(evaluateEpisodeAtFrame(plain, 15).actors[0].pose, 0, 1);
  const shift = head[0] - rest[0];
  assert.ok(Math.abs(shift) > 0.04, `lean shift ${shift}`);
  close(late.camera.target[0], shift);
  close(late.camera.position[0], latePlain.camera.position[0] + shift);
  close(late.actors[0].motion.lookYaw, latePlain.actors[0].motion.lookYaw);
  const loose = episode((value) => {
    value.shots[0].camera.follow = {target: 'head', lagFrames: 0, amount: 0, margin: 0.12};
    value.shots[0].camera.depthOfField = {focusDistance: 1.35, aperture: 0.01, maxBlur: 0.02};
  });
  const pulled = evaluateEpisodeAtFrame(loose, 21);
  const authored = evaluateEpisodeAtFrame(plain, 21);
  close(pulled.camera.target[0], authored.camera.target[0]);
  const distance = (camera) => Math.hypot(
    camera.position[0] - camera.target[0],
    camera.position[1] - camera.target[1],
    camera.position[2] - camera.target[2],
  );
  close(distance(pulled.camera) - distance(authored.camera), 0.12);
  close(pulled.camera.depthOfField.focusDistance, 1.47);
  const sequential = [15, 21, 0].map((frame) => evaluateEpisodeAtFrame(followed, frame));
  for (const frame of [21, 0, 15]) {
    assert.deepEqual(evaluateEpisodeAtFrame(followed, frame), sequential[[15, 21, 0].indexOf(frame)]);
  }
  assert.throws(() => validateEpisode(episode((value) => {
    value.shots[0].camera.follow = {target: 'hips'};
  })), /follow target/);
});

test('night-roof, light pulse, and spring window stay opt-in and validated', () => {
  assert.equal(practicalGain(10, [{frame: 10, strength: 1}], 0), 0);
  const kick = practicalGain(10, [{frame: 10, strength: 0.8}], 1);
  assert.ok(kick > 0.7);
  assert.equal(practicalGain(19, [{frame: 10, strength: 0.8}], 1), 0);
  const night = episode((value) => {
    value.environment = {base: 'night-roof', lightPulse: 0.8};
    value.secondary = {springWindowFrames: 24};
    value.shots[0].environment = 'studio';
  });
  assert.equal(validateEpisode(night), night);
  assert.equal(evaluateEpisodeAtFrame(night, 4).practical, undefined);
  assert.throws(() => validateEpisode(episode((value) => { value.environment = 'neon-room'; })), /environment/);
  assert.throws(() => validateEpisode(episode((value) => { value.environment = {base: 'studio', lightPulse: 2}; })), /lightPulse/);
  assert.throws(() => validateEpisode(episode((value) => { value.secondary = {springWindowFrames: 2}; })), /springWindowFrames/);
  assert.throws(() => validateEpisode(episode((value) => {
    value.secondary = {springWindowFrames: 24, springSettleFrames: 64};
  })), /springSettleFrames/);
  assert.doesNotThrow(() => validateEpisode(episode((value) => {
    value.secondary = {springWindowFrames: 32, springSettleFrames: 0};
  })));
});

test('bar energy labels a hook, a drop, and an outro without a hand-placed section', () => {
  assert.deepEqual(labelSections(rise), [
    {frame: 0, label: 'groove', energy: 0.36},
    {frame: 240, label: 'hook', energy: 0.737},
  ]);
  const drop = labelSections([
    {frame: 0, energy: 0.4, onset: 0.2},
    {frame: 40, energy: 0.42, onset: 0.2},
    {frame: 80, energy: 0.4, onset: 0.2},
    {frame: 120, energy: 0.41, onset: 0.2},
    {frame: 160, energy: 0.92, onset: 1},
    {frame: 200, energy: 0.9, onset: 0.45},
    {frame: 240, energy: 0.55, onset: 0.2},
    {frame: 280, energy: 0.4, onset: 0.2},
  ]);
  assert.equal(drop[0].label, 'groove');
  assert.deepEqual(drop[1], {frame: 160, label: 'drop', energy: 0.79});
  const modest = labelSections([
    {frame: 0, energy: 0.5, onset: 0.3},
    {frame: 30, energy: 0.52, onset: 0.3},
    {frame: 60, energy: 0.51, onset: 0.3},
    {frame: 90, energy: 0.62, onset: 0.7},
    {frame: 120, energy: 0.64, onset: 0.55},
    {frame: 150, energy: 0.63, onset: 0.4},
  ]);
  assert.equal(modest[1].label, 'hook');
  const borderline = labelSections([
    {frame: 0, energy: 0.4, onset: 0.2},
    {frame: 30, energy: 0.41, onset: 0.2},
    {frame: 60, energy: 0.71, onset: 0.6},
    {frame: 90, energy: 0.73, onset: 0.4},
    {frame: 120, energy: 0.72, onset: 0.35},
  ]);
  assert.equal(borderline[1].label, 'hook');
  assert.deepEqual(labelSections(rise.slice(0, 3)), [{frame: 0, label: 'groove', energy: 0.35}]);
  assert.deepEqual(labelSections([
    {frame: 0, energy: 0.5, onset: 0.2},
    {frame: 30, energy: 0.5, onset: 0.2},
    {frame: 60, energy: 0.5, onset: 0.2},
    {frame: 90, energy: 0.5, onset: 0.2},
  ]), [{frame: 0, label: 'groove', energy: 0.5}]);
  const outro = labelSections([
    {frame: 0, energy: 0.3, onset: 0.2},
    {frame: 30, energy: 0.32, onset: 0.2},
    {frame: 60, energy: 0.7, onset: 0.2},
    {frame: 90, energy: 0.72, onset: 0.2},
    {frame: 120, energy: 0.71, onset: 0.2},
    {frame: 150, energy: 0.3, onset: 0.2},
    {frame: 180, energy: 0.28, onset: 0.2},
    {frame: 210, energy: 0.31, onset: 0.2},
  ]);
  assert.ok(outro.some((section) => section.label === 'hook'));
  assert.ok(outro.some((section) => section.label === 'outro' && section.frame > outro.find((section) => section.label === 'hook').frame));
  const cues = kickCues([
    {frame: 0, strength: 0.9, downbeat: true},
    {frame: 12, strength: 0.4},
    {frame: 24, strength: 0.8, downbeat: true},
  ]);
  assert.deepEqual(cues.map((cue) => cue.frame), [0, 24]);
  const dir = mkdtempSync(path.join(tmpdir(), 'sections-'));
  const barsPath = path.join(dir, 'bars.json');
  writeFileSync(barsPath, JSON.stringify(rise));
  const python = spawnSync('python3', [
    path.join(root, 'scripts/extract-beats.py'), '--label-sections', barsPath,
  ], {encoding: 'utf8'});
  assert.equal(python.status, 0, python.stderr);
  assert.deepEqual(JSON.parse(python.stdout), labelSections(rise));
  const flatRise = JSON.parse(readFileSync(new URL('./fixtures/flat-rise-bars.json', import.meta.url), 'utf8'));
  const flatSections = labelSections(flatRise);
  assert.equal(flatSections[0].label, 'groove');
  assert.ok(flatSections[0].energy < 0.75, flatSections[0].energy);
  assert.deepEqual(flatSections[1], {frame: 288, label: 'hook', energy: 0.845});
  const flat = flatRise.map((bar, index) => ({...bar, energy: 0.7 + (index % 2 ? 0.01 : -0.01), onset: 0.4}));
  assert.deepEqual(labelSections(flat), [{frame: 0, label: 'groove', energy: 0.7}]);
  const flatPython = spawnSync('python3', [
    path.join(root, 'scripts/extract-beats.py'), '--label-sections',
    fileURLToPath(new URL('./fixtures/flat-rise-bars.json', import.meta.url)),
  ], {encoding: 'utf8'});
  assert.equal(flatPython.status, 0, flatPython.stderr);
  assert.deepEqual(JSON.parse(flatPython.stdout), flatSections);
});

test('music intensity cues feed section-less mood and do not change a cue-free take', () => {
  const base = episode((value) => {
    value.durationFrames = 90;
    value.shots[0].durationFrames = 90;
    value.shots[0].performances[0].reactivity = {
      look: 'off', head: 0, torso: 0, arm: 0, expression: 1, autoBeats: false,
      face: {mood: 'intensity', idleMouth: 0, breathMouth: false},
    };
    value.music = {
      bpm: 120,
      beats: [{frame: 0, strength: 0.2}, {frame: 40, strength: 0.9, downbeat: true}],
      intensityCues: [{frame: 40, intensity: 1, duration: 6}],
    };
  });
  const before = evaluateEpisodeAtFrame(base, 10).actors[0].expressions.happy ?? 0;
  const atKick = evaluateEpisodeAtFrame(base, 40).actors[0].expressions.happy ?? 0;
  assert.ok(atKick > before + 0.05, `${atKick} vs ${before}`);
  const quiet = episode((value) => {
    value.shots[0].performances[0].reactivity.face = undefined;
    delete value.shots[0].performances[0].reactivity.face;
    value.music = {
      bpm: 120,
      beats: [{frame: 0, strength: 0.2}, {frame: 40, strength: 0.9, downbeat: true}],
      intensityCues: [{frame: 40, intensity: 1, duration: 6}],
    };
  });
  const bare = structuredClone(quiet);
  delete bare.music.intensityCues;
  assert.deepEqual(evaluateEpisodeAtFrame(quiet, 40).actors[0], evaluateEpisodeAtFrame(bare, 40).actors[0]);
});

test('a fixed spring window is seek-stable and depends on more than the current frame', () => {
  const rootBone = new THREE.Group();
  const head = new THREE.Object3D();
  const hair = new THREE.Object3D();
  const tail = new THREE.Object3D();
  tail.position.set(0, -0.12, 0);
  hair.add(tail);
  head.add(hair);
  rootBone.add(head);
  rootBone.updateMatrixWorld(true);
  const joint = new VRMSpringBoneJoint(hair, tail, {
    stiffness: 0.6,
    dragForce: 0.25,
    gravityPower: 0.2,
    gravityDir: new THREE.Vector3(0, -1, 0),
    hitRadius: 0,
  }, []);
  const manager = new VRMSpringBoneManager();
  manager.addJoint(joint);
  manager.setInitState();
  const apply = (frame) => {
    head.rotation.z = Math.sin(frame / 3) * 0.8;
    rootBone.updateMatrixWorld(true);
  };
  const bind = () => {
    head.rotation.set(0, 0, 0);
    rootBone.updateMatrixWorld(true);
  };
  const read = () => hair.quaternion.toArray();
  bind();
  replaySprings([manager], 20, 12, 1 / 30, apply);
  const long = read();
  head.rotation.z = 1.4;
  rootBone.updateMatrixWorld(true);
  bind();
  replaySprings([manager], 4, 12, 1 / 30, apply);
  bind();
  replaySprings([manager], 20, 12, 1 / 30, apply);
  const again = read();
  long.forEach((value, index) => close(value, again[index], 1e-6));
  replaySprings([manager], 20, 1, 1 / 30, apply);
  const brief = read();
  const moved = long.some((value, index) => Math.abs(value - brief[index]) > 1e-3);
  assert.ok(moved, 'window length should change the sprung pose');
  assert.equal(SPRING_SETTLE_FRAMES, 24);
});

test('settling the window-start pose removes the rest-to-pose hair kick', () => {
  const poseSpring = (settleFrames) => {
    const rootBone = new THREE.Group();
    const head = new THREE.Object3D();
    const hair = new THREE.Object3D();
    const tail = new THREE.Object3D();
    tail.position.set(0.04, -0.2, 0);
    hair.add(tail);
    head.add(hair);
    rootBone.add(head);
    rootBone.updateMatrixWorld(true);
    const joint = new VRMSpringBoneJoint(hair, tail, {
      stiffness: 0.25,
      dragForce: 0.08,
      gravityPower: 0,
      gravityDir: new THREE.Vector3(0, -1, 0),
      hitRadius: 0,
    }, []);
    const manager = new VRMSpringBoneManager();
    manager.addJoint(joint);
    manager.setInitState();
    const apply = () => {
      head.rotation.z = 1.1;
      rootBone.updateMatrixWorld(true);
    };
    replaySprings([manager], 30, 6, 1 / 30, apply, {settleFrames});
    return hair.quaternion.clone();
  };
  const settled = poseSpring(80);
  const cold = poseSpring(0);
  const warm = poseSpring(SPRING_SETTLE_FRAMES);
  const coldAngle = settled.angleTo(cold);
  const warmAngle = settled.angleTo(warm);
  assert.ok(coldAngle > 0.4, `cold kick ${coldAngle}`);
  assert.ok(warmAngle < coldAngle * 0.45, `warm ${warmAngle} cold ${coldAngle}`);
});

test('spring response keeps a low-drag strand from staying lifted', () => {
  const rig = (settings) => {
    const rootBone = new THREE.Group();
    const head = new THREE.Object3D();
    const hair = new THREE.Object3D();
    const tail = new THREE.Object3D();
    tail.position.set(0.08, -0.35, 0.02);
    hair.add(tail);
    head.add(hair);
    rootBone.add(head);
    rootBone.updateMatrixWorld(true);
    const joint = new VRMSpringBoneJoint(hair, tail, {
      stiffness: 0.02,
      dragForce: 0.02,
      gravityPower: 0,
      gravityDir: new THREE.Vector3(0, -1, 0),
      hitRadius: 0,
      ...settings,
    }, []);
    const manager = new VRMSpringBoneManager();
    manager.addJoint(joint);
    manager.setInitState();
    return {rootBone, head, hair, joint, manager};
  };
  const tuned = rig();
  tuneSpringManager(tuned.manager, {});
  assert.ok(tuned.joint.settings.dragForce >= SPRING_DRAG);
  assert.ok(tuned.joint.settings.gravityPower >= SPRING_GRAVITY_FLOOR);
  const dragOnce = tuned.joint.settings.dragForce;
  const gravityOnce = tuned.joint.settings.gravityPower;
  tuneSpringManager(tuned.manager, {});
  assert.equal(tuned.joint.settings.dragForce, dragOnce);
  assert.equal(tuned.joint.settings.gravityPower, gravityOnce);
  const rawSettings = rig();
  tuneSpringManager(rawSettings.manager, {springGravity: 1, springDrag: 0, springStiffness: 1});
  close(rawSettings.joint.settings.gravityPower, 0);
  close(rawSettings.joint.settings.dragForce, 0.02);
  close(rawSettings.joint.settings.stiffness, 0.02);
  const nod = (bundle, frame) => {
    bundle.head.rotation.x = Math.sin(frame / 2) * 1.1;
    bundle.head.rotation.z = Math.sin(frame / 3) * 1.3;
    bundle.rootBone.updateMatrixWorld(true);
  };
  const swing = (bundle, options) => {
    bundle.head.rotation.set(0, 0, 0);
    bundle.rootBone.updateMatrixWorld(true);
    bundle.manager.reset();
    const rest = bundle.hair.quaternion.clone();
    replaySprings([bundle.manager], 48, 20, 1 / 30, (frame) => nod(bundle, frame), options);
    return rest.angleTo(bundle.hair.quaternion);
  };
  const lifted = swing(rig(), {settleFrames: 24});
  const tunedOnly = rig();
  tuneSpringManager(tunedOnly.manager, {});
  const softened = swing(tunedOnly, {settleFrames: 24});
  const heldBundle = rig();
  tuneSpringManager(heldBundle.manager, {});
  const held = swing(heldBundle, {settleFrames: 24, maxRadians: 32 * Math.PI / 180});
  const again = swing(heldBundle, {settleFrames: 24, maxRadians: 32 * Math.PI / 180});
  assert.ok(lifted > 32 * Math.PI / 180, `untuned lift ${lifted}`);
  assert.ok(softened < lifted, `tuned ${softened} raw ${lifted}`);
  assert.ok(held <= 32 * Math.PI / 180 + 1e-3, `clamped lift ${held}`);
  close(again, held, 1e-4);
  assert.throws(() => validateEpisode(episode((value) => {
    value.secondary = {springWindowFrames: 24, springMaxDegrees: 120};
  })), /springMaxDegrees/);
  assert.equal(validateEpisode(episode((value) => {
    value.secondary = {springWindowFrames: 24, springGravity: 1, springDrag: 0.2, springStiffness: 1, springMaxDegrees: 40};
  })).secondary.springMaxDegrees, 40);
});

test('a close-up can tame idle head roll without changing the next shot', () => {
  const roll = quatYXZ(0.15, -0.2, 0.5);
  const read = eulerYXZ(roll);
  const flat = eulerYXZ(limitRoll(roll, {scale: 0}));
  close(flat.roll, 0, 1e-5);
  close(flat.yaw, read.yaw, 1e-5);
  close(flat.pitch, read.pitch, 1e-5);
  const capped = eulerYXZ(limitRoll(roll, {maxRadians: 4 * Math.PI / 180}));
  close(Math.abs(capped.roll), 4 * Math.PI / 180, 1e-4);
  const spine = quatYXZ(0, 0, 0.35);
  const sequence = {duration: 1, keyframes: [
    {time: 0, pose: {head: {rotation: roll}, spine: {rotation: spine}}, easing: 'step'},
    {time: 1, pose: {head: {rotation: roll}, spine: {rotation: spine}}},
  ]};
  const value = episode((draft) => {
    draft.durationFrames = 60;
    draft.shots[0].durationFrames = 30;
    draft.shots[0].performances[0].sequence = sequence;
    draft.shots[0].performances[0].reactivity = {
      look: 'off', head: 0, torso: 0, arm: 0, expression: 0, autoBeats: false,
      roll: {scale: 0.2, maxDegrees: 4},
    };
    draft.shots.push({
      id: 'medium', startFrame: 30, durationFrames: 30,
      camera: draft.shots[0].camera,
      performances: [{
        actorId: 'a',
        sequence,
        reactivity: {look: 'off', head: 0, torso: 0, arm: 0, expression: 0, autoBeats: false},
      }],
    });
  });
  const closeUp = evaluateEpisodeAtFrame(value, 10).actors[0].pose;
  const medium = evaluateEpisodeAtFrame(value, 40).actors[0].pose;
  const closeHead = eulerYXZ(closeUp.head.rotation);
  const mediumHead = eulerYXZ(medium.head.rotation);
  close(Math.abs(closeHead.roll), 4 * Math.PI / 180, 1e-3);
  close(closeHead.pitch, read.pitch, 1e-3);
  close(closeHead.yaw, read.yaw, 1e-3);
  close(mediumHead.roll, read.roll, 1e-3);
  close(eulerYXZ(medium.spine.rotation).roll, 0.35, 1e-3);
  assert.ok(Math.abs(eulerYXZ(closeUp.spine.rotation).roll) < Math.abs(eulerYXZ(medium.spine.rotation).roll));
  assert.throws(() => validateEpisode(episode((draft) => {
    draft.shots[0].performances[0].reactivity.roll = {scale: 2};
  })), /roll.scale/);
  assert.throws(() => validateEpisode(episode((draft) => {
    draft.shots[0].performances[0].reactivity.roll = {};
  })), /expected scale or maxDegrees/);
});
