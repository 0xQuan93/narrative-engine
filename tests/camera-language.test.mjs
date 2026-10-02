import test from 'node:test';
import assert from 'node:assert/strict';
import {compileCameraMoves} from '../src/camera-language.mjs';
import {compileEpisode,validateEpisode} from '../src/episode.mjs';

const base={position:[0.03,1.56,2.05],target:[0,1.45,0],fov:26};
const moves=[
  {startFrame:30,endFrame:112,easing:'easeInOutQuad',delta:{position:[0,0,0],target:[0,0,0],fov:-2.5}},
  {startFrame:145,endFrame:157,easing:'easeOutCubic',delta:{position:[0,0,-0.28],target:[0.015,0,0],fov:-1.7}},
  {startFrame:264,endFrame:284,easing:'easeInOutQuad',delta:{position:[0,0,0.15],target:[0,0,0],fov:1.2}},
];

test('operator moves compile to holds, eased reactions and face-following focus keys',()=>{
  const {motion,focusMotion}=compileCameraMoves({base,durationFrames:341,moves});
  assert.deepEqual(motion.map(k=>k.frame),[0,30,112,145,157,264,284,341]);
  assert.deepEqual(focusMotion.map(k=>k.frame),motion.map(k=>k.frame));
  assert.deepEqual(motion[0].position,base.position);
  assert.equal(focusMotion[0].focusDistance,2.06);
  assert.equal(focusMotion[4].focusDistance,1.78);
  const episode={schema:'narrative-episode/0.1',fps:30,durationFrames:341,
    actors:[{id:'a',assetId:'a'}],shots:[{id:'one',startFrame:0,durationFrames:341,
      camera:{...base,motion,depthOfField:{focusDistance:2.06,aperture:.035,maxBlur:.055,focusMotion}},
      performances:[{actorId:'a',sequence:{duration:1,keyframes:[{time:0,pose:{}}]}}]}]};
  validateEpisode(episode);
  const sample=compileEpisode(episode);
  assert.equal(sample(112).camera.fov,23.5);
  assert.equal(sample(144).camera.fov,23.5);
  assert.ok(Math.abs(sample(151).camera.fov-22.0125)<1e-10);
  assert.ok(Math.abs(sample(151).camera.depthOfField.focusDistance-1.815)<1e-10);
  assert.equal(sample(284).camera.fov,23);
  for(const frame of [340,145,0,151,112,151,340])assert.deepEqual(sample(frame).camera,compileEpisode(episode)(frame).camera);
});

test('operator move compiler rejects overlapping or out-of-bounds moves',()=>{
  assert.throws(()=>compileCameraMoves({base,durationFrames:341,moves:[...moves,{...moves[0],startFrame:150,endFrame:180}]}),/ordered, non-overlapping/);
  assert.throws(()=>compileCameraMoves({base,durationFrames:341,moves:[{...moves[0],endFrame:342}]}),/within the shot/);
  assert.throws(()=>compileCameraMoves({base,durationFrames:341,moves:[{...moves[0],delta:{...moves[0].delta,fov:-100}}]}),/invalid pose/);
});
