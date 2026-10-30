import { compileEpisode, validateEpisode } from './episode.mjs';
import { compileDialogue } from './dialogue.mjs';
import { compileCameraMoves } from './camera-language.mjs';
import { reactivityPreset } from './reactive-motion.mjs';

export const DEFAULT_SCRIPT_SETTINGS = Object.freeze({
  text: 'Welcome to the studio. This is a short first take using your avatar and your motion clips.',
  wordsPerMinute: 150, mouthStrength: 0.7, motion: 'wave-idle', camera: 'cuts',
  format: 'landscape', revealWordIndex: null, shotCameras: [],
  reactivity: 'off', reactivityAmount: 1,
});
export function validateScriptSettings(value) {
  const required = ['text', 'wordsPerMinute', 'mouthStrength', 'motion', 'camera'];
  const keys = Object.keys(DEFAULT_SCRIPT_SETTINGS);
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).some((key) => !keys.includes(key)) || required.some((key) => !Object.hasOwn(value, key))) throw new Error('Expected script settings: text, wordsPerMinute, mouthStrength, motion, camera');
  if (typeof value.text !== 'string' || !value.text.trim() || value.text.length > 4000) throw new Error('Script must contain 1–4000 characters');
  if (!Number.isFinite(value.wordsPerMinute) || value.wordsPerMinute < 80 || value.wordsPerMinute > 240) throw new Error('Speaking rate must be 80–240 words per minute');
  if (!Number.isFinite(value.mouthStrength) || value.mouthStrength < 0 || value.mouthStrength > 1) throw new Error('Mouth strength must be 0–1');
  if (!['wave-idle', 'idle'].includes(value.motion) || !['cuts', 'medium', 'close', 'directed', 'storyboard'].includes(value.camera)) throw new Error('Unsupported motion or camera preset');
  if (value.format !== undefined && !['landscape', 'portrait'].includes(value.format)) throw new Error('Unsupported video format');
  if (value.revealWordIndex !== undefined && value.revealWordIndex !== null && (!Number.isSafeInteger(value.revealWordIndex) || value.revealWordIndex < 0)) throw new Error('Reveal cue must be a word index');
  if (value.shotCameras !== undefined && (!Array.isArray(value.shotCameras) || value.shotCameras.length > 8 || value.shotCameras.some((camera) => !['wide', 'medium', 'close'].includes(camera)))) throw new Error('Shot cameras must be up to eight wide, medium or close choices');
  if (value.reactivity !== undefined && !['off', 'subtle', 'lively'].includes(value.reactivity)) throw new Error('Unsupported reactivity preset');
  if (value.reactivityAmount !== undefined && (!Number.isFinite(value.reactivityAmount) || value.reactivityAmount < 0 || value.reactivityAmount > 1)) throw new Error('Reactivity amount must be 0–1');
  return { ...value, text: value.text.trim() };
}

/** Script timing drives an immutable recipe. PoseLab clips stay the body; reactivity is an optional offset. */
export function createScriptEpisode({ baseEpisode, wave, idle, settings, minimumSeconds = 12, holdFinalCaption = false }) {
  settings = validateScriptSettings(settings);
  if (!Number.isSafeInteger(minimumSeconds) || minimumSeconds < 1 || minimumSeconds > 90 || typeof holdFinalCaption !== 'boolean') {
    throw new Error('Invalid minimumSeconds or holdFinalCaption');
  }
  const actor = baseEpisode.actors[0];
  if (!actor || baseEpisode.fps !== 30) throw new Error('Script Studio requires a 30fps actor template');
  const fps = 30;
  const dialogue = compileDialogue({ text: settings.text, actorId: actor.id, fps, wordsPerMinute: settings.wordsPerMinute, mouthStrength: settings.mouthStrength, startFrame: 0 });
  const durationFrames = Math.max(minimumSeconds * fps, dialogue.durationFrames + 12);
  if (durationFrames > 90 * fps) throw new Error('Script exceeds the 90-second studio limit; shorten it or increase the speaking rate');
  if (holdFinalCaption && dialogue.captions.length) {
    dialogue.captions.at(-1).endFrame = durationFrames;
    dialogue.durationFrames = durationFrames;
  }
  const cameras = baseEpisode.shots.slice(0, 3).map((shot) => structuredClone(shot.camera));
  if (cameras.length !== 3) throw new Error('Template requires wide, medium and close cameras');
  function sampler(sequence) {
    const durationFrames = Math.ceil(sequence.duration * fps) + 1;
    return compileEpisode({ schema: 'narrative-episode/0.1', fps, durationFrames, actors: [actor], shots: [{ id: 'source', startFrame: 0, durationFrames, camera: cameras[0], performances: [{ actorId: actor.id, sequence }] }] });
  }
  const sampleWave = sampler(wave), sampleIdle = sampler(idle);
  const waveFrames = Math.max(1, Math.floor(wave.duration * fps));
  const idleFrames = Math.max(1, Math.floor(idle.duration * fps));
  const firstIdle = settings.motion === 'wave-idle' ? waveFrames : 0;
  const sample = (frame) => frame < firstIdle ? sampleWave(frame).actors[0].pose : sampleIdle((frame - firstIdle) % idleFrames).actors[0].pose;
  let cuts = settings.camera === 'cuts'
    ? durationFrames < 360
      ? [0, Math.floor(durationFrames * 0.36), Math.floor(durationFrames * 0.7), durationFrames]
      : [0, Math.min(129, durationFrames), Math.min(249, durationFrames), durationFrames]
    : [0, durationFrames];
  if (settings.camera === 'storyboard') {
    const paragraphs = settings.text.split(/\n\s*\n/u).map((part) => part.trim()).filter(Boolean);
    if (paragraphs.length < 2 || paragraphs.length > 8) throw new Error('Storyboard needs 2–8 script sections separated by blank lines');
    const words = dialogue.captions.flatMap((caption) => caption.words);
    let wordIndex = 0;
    cuts = [0];
    for (const paragraph of paragraphs.slice(0, -1)) {
      wordIndex += paragraph.split(/\s+/u).length;
      cuts.push(words[wordIndex].startFrame);
    }
    cuts.push(durationFrames);
  }
  let revealFrame = null;
  const shots = cuts.slice(0, -1).map((startFrame, index) => {
    const count = cuts[index + 1] - startFrame;
    const shotCamera = settings.camera === 'storyboard' ? (settings.shotCameras?.[index] ?? ['wide', 'medium', 'close'][index % 3]) : null;
    const cameraIndex = settings.camera === 'medium' || shotCamera === 'medium' ? 1
      : ['close', 'directed'].includes(settings.camera) || shotCamera === 'close' ? 2 : settings.camera === 'cuts' ? index : 0;
    return { id: `script-shot-${index + 1}`, startFrame, durationFrames: count, camera: cameras[cameraIndex], performances: [{ actorId: actor.id,
      sequence: { duration: count / fps, keyframes: Array.from({ length: count + 1 }, (_, f) => ({ time: f / fps, pose: sample(startFrame + f), easing: 'linear' })) },
    }] };
  });
  if (settings.camera === 'directed') {
    const words = dialogue.captions.flatMap((caption) => caption.words);
    const cueIndex = settings.revealWordIndex ?? Math.floor(words.length * 0.45);
    if (cueIndex >= words.length) throw new Error('Reveal cue no longer matches the script; select a word again');
    const cue = words[cueIndex];
    revealFrame = cue.endFrame + 6;
    const pushStart = revealFrame;
    const pushEnd = pushStart + 14;
    if (pushEnd + 32 >= durationFrames) throw new Error('Choose an earlier reveal word so the camera has room to hold and release');
    const move = (startFrame, endFrame, easing, position, target, fov) => ({startFrame, endFrame, easing,
      delta: {position, target, fov}});
    const moves = [];
    const creepEnd = cue.startFrame - 6;
    if (creepEnd >= 18) moves.push(move(Math.max(0, creepEnd - 90), creepEnd, 'easeInOutQuad', [0, 0, 0], [0, 0, 0], -2.5));
    moves.push(move(pushStart, pushEnd, 'easeOutCubic', [0, 0, -0.27], [0.012, 0, 0], -1.7));
    const releaseStart = Math.max(pushEnd + 24, Math.round(durationFrames * 0.78));
    const releaseEnd = Math.min(durationFrames - 1, releaseStart + 22);
    if (releaseEnd > releaseStart) moves.push(move(releaseStart, releaseEnd, 'easeInOutQuad', [0, 0, 0.13], [0, 0, 0], 1));
    const camera = shots[0].camera;
    camera.handheld = {seed: 904, strength: 0.72};
    camera.depthOfField = {focusDistance: +(camera.position[2] + 0.01).toFixed(4), aperture: 0.035, maxBlur: 0.055};
    const {motion, focusMotion} = compileCameraMoves({base: camera, durationFrames, moves});
    camera.motion = motion;
    camera.depthOfField.focusMotion = focusMotion;
  }
  const preset = reactivityPreset(settings.reactivity ?? 'off', settings.reactivityAmount ?? 1);
  if (preset) {
    for (const shot of shots) {
      const beats = [];
      if (revealFrame !== null && revealFrame >= shot.startFrame && revealFrame < shot.startFrame + shot.durationFrames) {
        beats.push({ frame: revealFrame - shot.startFrame, kind: 'point', strength: 0.85, duration: 16 });
      }
      for (const performance of shot.performances) {
        performance.reactivity = {
          ...preset,
          ...(firstIdle > 0 ? { armDelayFrames: Math.min(firstIdle, durationFrames) } : {}),
          ...(beats.length ? { beats } : {}),
        };
      }
    }
  }
  const episode = { schema: 'narrative-episode/0.1', fps, durationFrames, actors: [structuredClone(actor)], shots, dialogue };
  if (settings.camera === 'directed') episode.environment = 'depth-studio';
  validateEpisode(episode);
  return episode;
}
