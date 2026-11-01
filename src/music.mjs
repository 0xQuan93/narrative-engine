/**
 * Opt-in, frame-deterministic music performance.
 *
 * Nothing here runs unless an episode carries `music` or a performance
 * carries `groove` / `eyes` / `body` / `face`. Episodes that omit those
 * blocks never call into this module. There is no audio decode and no
 * Math.random: hashes and frame numbers are the only varying inputs.
 *
 * Craft defaults live in MUSIC_LIFE so a later pass can retune them
 * without a schema change. See docs/REACTIVE-MOTION.md.
 */

export const MUSIC_SCHEMA = 'narrative-music/0.1';
export const SECTION_LABELS = Object.freeze(['groove', 'hook', 'drop', 'outro']);
export const GROOVE_DIVISIONS = Object.freeze(['half', 'beat', 'bar']);
export const SWAY_DIVISIONS = Object.freeze(['bar', '2bar']);
export const MOOD_MODES = Object.freeze(['off', 'sections', 'intensity']);

export const MUSIC_LIFE = Object.freeze({
  blinkRate: 16,
  saccade: 0.5,
  headNodDegreesLook: 8,
  headNodDegreesFree: 12,
  neckOfHead: 0.3 / 0.7,
  chestCounter: 0.2,
  shoulderNodDegrees: 1,
  breathHz: 0.25,
  breathDegrees: 1.5,
  shoulderBreathDegrees: 1,
  swayDegrees: 4,
  swayYawDegrees: 1.5,
  fallbackSwayHz: 0.1,
  idleMouth: 0.03,
  moodFade: 20,
  moodCap: 0.48,
});

const DEG = Math.PI / 180;
const clamp = (value, min, max) => Math.min(max, Math.max(min, value));
const clamp01 = (value) => clamp(value, 0, 1);

const fail = (path, message) => {
  throw new TypeError(`${path}: ${message}`);
};
const own = (value, key) => Object.hasOwn(value, key);

function plainObject(value, path, allowed, required = allowed) {
  if (!value || typeof value !== 'object' || Array.isArray(value)
      || ![Object.prototype, null].includes(Object.getPrototypeOf(value))) fail(path, 'expected a plain object');
  for (const key of Object.keys(value)) if (!allowed.includes(key)) fail(`${path}.${key}`, 'unsupported field');
  for (const key of required) if (!own(value, key)) fail(`${path}.${key}`, 'required field');
}

function finite(value, path, min, max, integer = false) {
  if (!Number.isFinite(value) || value < min || value > max || (integer && !Number.isSafeInteger(value))) {
    fail(path, `expected ${integer ? 'a safe integer' : 'a finite number'} in [${min}, ${max}]`);
  }
}

function bool(value, path) {
  if (typeof value !== 'boolean') fail(path, 'expected a boolean');
}

/** Deterministic unit hash in [0, 1). Integer mixing only; no Math.random. */
export function hashUnit(seed, a, b = 0) {
  let x = (Math.imul(seed >>> 0, 0x9e3779b1) ^ Math.imul((a + 1) >>> 0, 0x85ebca6b) ^ Math.imul((b + 0x9e37) >>> 0, 0xc2b2ae35)) >>> 0;
  x = Math.imul(x ^ (x >>> 16), 0x7feb352d) >>> 0;
  x = Math.imul(x ^ (x >>> 15), 0x846ca68b) >>> 0;
  x = (x ^ (x >>> 16)) >>> 0;
  return x / 4294967296;
}

/** Rational approximation of the standard-normal inverse CDF (Acklam). */
function invNorm(p) {
  const a = [-3.969683028665376e+01, 2.209460984245205e+02, -2.759285104469687e+02, 1.383577518672690e+02, -3.066479806614716e+01, 2.506628277459239e+00];
  const b = [-5.447609879822406e+01, 1.615858368580409e+02, -1.556989798598866e+02, 6.680131188771972e+01, -1.328068155288572e+01];
  const c = [-7.784894002430293e-03, -3.223964580411365e-01, -2.400758277161838e+00, -2.549732539343734e+00, 4.374664141464968e+00, 2.938163982698783e+00];
  const d = [7.784695709041462e-03, 3.224671290700398e-01, 2.445134137142996e+00, 3.754408661907416e+00];
  const plow = 0.02425;
  const phigh = 1 - plow;
  if (p < plow) {
    const q = Math.sqrt(-2 * Math.log(p));
    return (((((c[0] * q + c[1]) * q + c[2]) * q + c[3]) * q + c[4]) * q + c[5]) / ((((d[0] * q + d[1]) * q + d[2]) * q + d[3]) * q + 1);
  }
  if (p > phigh) {
    const q = Math.sqrt(-2 * Math.log(1 - p));
    return -(((((c[0] * q + c[1]) * q + c[2]) * q + c[3]) * q + c[4]) * q + c[5]) / ((((d[0] * q + d[1]) * q + d[2]) * q + d[3]) * q + 1);
  }
  const q = p - 0.5;
  const r = q * q;
  return (((((a[0] * r + a[1]) * r + a[2]) * r + a[3]) * r + a[4]) * r + a[5]) * q / (((((b[0] * r + b[1]) * r + b[2]) * r + b[3]) * r + b[4]) * r + 1);
}

function frameJitter(seed, index, phase) {
  const pick = hashUnit(seed, index, 7);
  let jitter = pick < 1 / 3 ? -1 : pick < 2 / 3 ? 0 : 1;
  if (Math.abs(phase) <= 1) {
    if (phase + jitter > 1) jitter = 1 - phase;
    if (phase + jitter < -1) jitter = -1 - phase;
  }
  return jitter;
}

/**
 * Asymmetric nod: fast settle onto the beat (35% of the window), then a
 * slower rebound that overshoots rest by at most ~14% and returns to 0.
 * `u` is 0 at the start of the window and 1 at the end. The bottom is u=0.35.
 */
export function grooveCurve(u) {
  if (u < 0 || u >= 1) return 0;
  if (u <= 0.35) return Math.sin((u / 0.35) * (Math.PI / 2));
  const t = (u - 0.35) / 0.65;
  return (1 - t) * (1 - t) * (1 - 3.15 * t);
}

function sampleWindow(frame, land, window) {
  const start = land - window * 0.35;
  return grooveCurve((frame - start) / window);
}

export function selectGrooveBeats(beats, division) {
  const sorted = [...beats].sort((a, b) => a.frame - b.frame);
  if (division === 'beat' || sorted.length === 0) return sorted;
  if (division === 'bar') {
    const downs = sorted.filter((beat) => beat.downbeat);
    return downs.length ? downs : sorted.filter((_, index) => index % 4 === 0);
  }
  const origin = Math.max(0, sorted.findIndex((beat) => beat.downbeat));
  return sorted.filter((_, index) => (index - origin) % 2 === 0);
}

function downbeatMarks(beats, division) {
  const downs = beats.filter((beat) => beat.downbeat).map((beat) => beat.frame);
  if (downs.length >= 2 && division !== '2bar') return downs;
  if (downs.length >= 2 && division === '2bar') return downs.filter((_, index) => index % 2 === 0);
  return downs;
}

/** Phase 0 at each mark, so a sine on this phase crosses zero on the downbeat. */
export function barPhase(frame, marks) {
  if (!marks || marks.length < 2) return null;
  if (frame <= marks[0]) {
    const span = marks[1] - marks[0] || 1;
    return (frame - marks[0]) / span;
  }
  let index = 0;
  while (index + 1 < marks.length && marks[index + 1] <= frame) index += 1;
  const start = marks[index];
  const end = index + 1 < marks.length ? marks[index + 1] : start + (start - marks[index - 1] || 1);
  return (frame - start) / Math.max(1, end - start);
}

export function barIndex(frame, marks, fallbackFrames) {
  if (marks && marks.length) {
    let index = 0;
    for (let cursor = 0; cursor < marks.length; cursor += 1) if (marks[cursor] <= frame) index = cursor;
    return index;
  }
  const span = Math.max(1, fallbackFrames);
  return Math.floor(frame / span);
}

function cueStrength(frame, cues) {
  let peak = 0;
  for (const cue of cues ?? []) {
    const duration = cue.duration ?? 8;
    if (frame < cue.frame || frame >= cue.frame + duration) continue;
    const u = (frame - cue.frame) / duration;
    peak = Math.max(peak, Math.sin(Math.PI * u) * cue.intensity);
  }
  return clamp01(peak);
}

/**
 * @returns {object} radian offsets for this absolute frame. `fromMusic` false
 * means nod-kind reactivity beats were consumed and must not also take the
 * symmetric pulse.
 */
export function sampleGroove({
  frame, fps, groove, musicBeats = [], nodBeats = [], intensityCues = [], lookActive = false,
}) {
  const amount = groove.amount ?? 1;
  const phase = groove.phaseFrames ?? -1;
  const rollGain = groove.roll ?? 0.65;
  const seed = groove.seed ?? 1;
  const musicHere = musicBeats.length > 0;
  const division = groove.division ?? (musicHere ? 'half' : 'beat');
  const source = selectGrooveBeats(musicHere ? musicBeats : nodBeats, division);
  const lead = Math.max(1, Math.round(2 * fps / 30));
  const lag = Math.max(1, Math.round(fps / 30));
  const cap = (lookActive ? MUSIC_LIFE.headNodDegreesLook : MUSIC_LIFE.headNodDegreesFree) * DEG * amount;
  let headSum = 0;
  let neckSum = 0;
  let chestSum = 0;
  const lands = [];
  source.forEach((beat, index) => {
    const next = source[index + 1]?.frame;
    const prev = source[index - 1]?.frame;
    const interval = next != null ? next - beat.frame : (prev != null ? beat.frame - prev : Math.round(fps * 0.5));
    const window = clamp(Math.round(Math.max(8, interval) * 0.92), 10, 48);
    const jitter = frameJitter(seed, index, phase);
    const land = beat.frame + phase + jitter;
    lands.push(land);
    const ampJitter = 0.9 + 0.2 * hashUnit(seed, index, 8);
    let gain = clamp01(beat.strength ?? 1);
    if (!musicHere) {
      const marked = cueStrength(beat.frame, intensityCues);
      if (marked > 0) gain = clamp01(gain * (0.55 + 0.45 * marked));
    }
    if (beat.downbeat) gain = Math.max(gain, 0.85);
    gain = clamp01(gain * ampJitter);
    headSum += gain * sampleWindow(frame, land, window);
    neckSum += gain * sampleWindow(frame + lead, land, window);
    chestSum += -MUSIC_LIFE.chestCounter * gain * sampleWindow(frame - lag, land, window);
  });
  const headUnit = clamp(headSum, -0.2, 1.15);
  const neckUnit = clamp(neckSum, -0.2, 1.15);
  const headPitch = clamp(headUnit * cap, -0.2 * cap, cap);
  const neckPitch = clamp(neckUnit * cap * MUSIC_LIFE.neckOfHead, -0.35 * cap, cap);
  const chestPitch = chestSum * cap;
  const marks = downbeatMarks(musicHere ? musicBeats : [], 'bar');
  const fallback = source.length >= 2 ? Math.max(8, (source.at(-1).frame - source[0].frame) / source.length * 4) : Math.round(fps * 1.6);
  const roll = grooveRoll(frame, marks, fallback, rollGain, headUnit);
  const shoulderPitch = Math.max(0, headUnit) * MUSIC_LIFE.shoulderNodDegrees * DEG * amount;
  return {
    fromMusic: musicHere,
    headPitch, neckPitch, chestPitch, spinePitch: chestPitch * 0.45,
    roll, shoulderPitch,
    head: headUnit,
    neck: neckUnit,
    lands,
  };
}

function snapToSafe(center, safeFrames, window) {
  let best = center;
  let bestDistance = window + 1;
  for (const safe of safeFrames) {
    const distance = Math.abs(safe - center);
    if (distance <= window && (distance < bestDistance || (distance === bestDistance && safe > best))) {
      best = safe;
      bestDistance = distance;
    }
  }
  return best;
}

/** Close in ~3 frames at 30fps, hold one frame, open in ~7. `offset` 0 is shut. */
export function blinkEnvelope(offset, fps) {
  const closeN = Math.max(2, Math.min(3, Math.round(fps * 0.1)));
  const openN = Math.max(5, Math.min(7, Math.round(fps * 0.22)));
  if (offset <= -closeN || offset >= 1 + openN) return 0;
  if (offset < 0) return Math.sin(((offset + closeN) / closeN) * (Math.PI / 2));
  if (offset < 1) return 1;
  return Math.cos(((offset - 1) / openN) * (Math.PI / 2));
}

export function blinkEvents({duration, fps, rate, seed, safeFrames = []}) {
  const median = (60 / rate) * fps;
  const sigma = 0.45;
  const window = Math.max(4, Math.round((8 * fps) / 30));
  const events = [];
  let cursor = Math.round(median * (0.28 + 0.32 * hashUnit(seed, 0, 11)));
  for (let index = 0; cursor < duration && index < 160; index += 1) {
    const center = clamp(Math.round(snapToSafe(Math.round(cursor), safeFrames, window)), 0, duration - 1);
    const asymmetric = hashUnit(seed, index, 12) < 0.22;
    const side = hashUnit(seed, index, 13) < 0.5 ? 'blinkLeft' : 'blinkRight';
    events.push({center, asymmetric, side});
    if (hashUnit(seed, index, 4) < 0.1) {
      const gap = Math.round(((6 + 4 * hashUnit(seed, index, 5)) * fps) / 30);
      events.push({center: Math.min(duration - 1, center + gap), asymmetric: false, side: null});
    }
    const unit = clamp(hashUnit(seed, index, 6), 1e-4, 1 - 1e-4);
    const interval = median * Math.exp(sigma * invNorm(unit));
    cursor = center + clamp(interval, median * 0.45, median * 2.4);
  }
  return events;
}

export function blinkWeightsAt(frame, events, fps) {
  let blink = 0;
  let blinkLeft = 0;
  let blinkRight = 0;
  for (const event of events) {
    const weight = blinkEnvelope(frame - event.center, fps);
    if (weight <= 0) continue;
    blink = Math.max(blink, weight);
    if (event.asymmetric && event.side) {
      const lead = blinkEnvelope(frame - (event.center - 1), fps);
      if (event.side === 'blinkLeft') blinkLeft = Math.max(blinkLeft, lead);
      else blinkRight = Math.max(blinkRight, lead);
    }
  }
  return {blink, blinkLeft, blinkRight};
}

export function saccadeOffset(frame, fps, amount, seed) {
  if (!(amount > 0)) return {yaw: 0, pitch: 0};
  const minFix = Math.max(2, Math.round(fps * 0.5));
  const maxFix = Math.max(minFix, Math.round(fps * 2.5));
  const stepN = Math.max(2, Math.round((2 * fps) / 30));
  let cursor = 0;
  let prevYaw = 0;
  let prevPitch = 0;
  for (let index = 0; index < 256 && cursor <= frame; index += 1) {
    const span = minFix + Math.floor(hashUnit(seed, index, 1) * (maxFix - minFix + 1));
    const amp = (2 + 3 * hashUnit(seed, index, 2)) * DEG * amount;
    const angle = hashUnit(seed, index, 3) * Math.PI * 2;
    const nextYaw = Math.cos(angle) * amp;
    const nextPitch = Math.sin(angle) * amp * 0.65;
    if (frame < cursor + span) {
      const t = clamp((frame - cursor) / stepN, 0, 1);
      const smooth = t * t * (3 - 2 * t);
      return {
        yaw: prevYaw + (nextYaw - prevYaw) * smooth,
        pitch: prevPitch + (nextPitch - prevPitch) * smooth,
      };
    }
    prevYaw = nextYaw;
    prevPitch = nextPitch;
    cursor += span;
  }
  return {yaw: prevYaw, pitch: prevPitch};
}

/** Half-sine per bar: 0 on each downbeat, opposite peaks mid-bar, slope matches across the bar. */
function grooveRoll(frame, marks, fallback, rollGain, headUnit) {
  const amp = (2 + 2 * rollGain) * DEG * (0.7 + 0.3 * clamp01(headUnit));
  const phase = marks && marks.length >= 2 ? barPhase(frame, marks) : null;
  if (phase == null) {
    const span = Math.max(1, fallback);
    return Math.sin(Math.PI * (frame / span)) * amp;
  }
  const sign = barIndex(frame, marks, fallback) % 2 === 0 ? 1 : -1;
  return sign * Math.sin(Math.PI * Math.min(1, phase)) * amp;
}

function smooth01(t) {
  const x = clamp(t, 0, 1);
  return x * x * (3 - 2 * x);
}

/**
 * Look-away still reaches the cue. The edge is a smoothstep long enough that
 * the steepest frame stays near 2°, instead of a 4-frame linear ramp.
 */
function gazeOffset(localFrame, cues) {
  let yaw = 0;
  let pitch = 0;
  for (const cue of cues ?? []) {
    if (localFrame < cue.frame || localFrame >= cue.frame + cue.duration) continue;
    const travel = Math.hypot(cue.yaw, cue.pitch);
    const half = Math.max(1, Math.floor((cue.duration - 1) / 2));
    const wanted = Math.ceil((travel * 1.5) / (2 * DEG));
    const attack = Math.min(half, Math.max(4, wanted));
    const into = localFrame - cue.frame;
    const remain = cue.frame + cue.duration - 1 - localFrame;
    const edge = Math.min(smooth01(into / attack), smooth01(remain / attack));
    yaw += cue.yaw * edge;
    pitch += cue.pitch * edge;
  }
  return {yaw, pitch};
}

export function sampleEyes({
  localFrame, shotDuration, fps, eyes, safeFrames = [], happy = 0, relaxed = 0, punch = 0,
}) {
  const rate = eyes.blinkRate ?? MUSIC_LIFE.blinkRate;
  const seed = eyes.seed ?? 1;
  const events = blinkEvents({duration: shotDuration, fps, rate, seed, safeFrames});
  let weights = blinkWeightsAt(localFrame, events, fps);
  if (happy > 0.5 || relaxed > 0.5) weights = {blink: 0, blinkLeft: 0, blinkRight: 0};
  else if (punch > 0.75) {
    const scale = clamp01(1 - punch);
    weights = {blink: weights.blink * scale, blinkLeft: weights.blinkLeft * scale, blinkRight: weights.blinkRight * scale};
  }
  const saccade = saccadeOffset(localFrame, fps, eyes.saccade ?? MUSIC_LIFE.saccade, seed);
  const gaze = gazeOffset(localFrame, eyes.gazeAway);
  return {...weights, yaw: saccade.yaw + gaze.yaw, pitch: saccade.pitch + gaze.pitch};
}

export function sampleBody({frame, fps, body, musicBeats = [], lookActive = false}) {
  const breathGain = body.breath ?? 1;
  const swayGain = body.sway ?? 0.8;
  const seed = body.seed ?? 0;
  const breathPeriod = fps / MUSIC_LIFE.breathHz;
  const breath = Math.sin((2 * Math.PI * frame) / breathPeriod + seed * 0.017);
  const breathAmp = MUSIC_LIFE.breathDegrees * DEG * breathGain;
  const division = body.swayDivision ?? 'bar';
  const marks = downbeatMarks(musicBeats, division);
  let sway;
  const phased = barPhase(frame, marks.length >= 2 ? marks : null);
  if (phased == null) {
    const drift = fps / MUSIC_LIFE.fallbackSwayHz;
    sway = Math.sin((2 * Math.PI * frame) / drift + seed * 0.11);
  } else sway = Math.sin(2 * Math.PI * phased);
  const chestRoll = sway * MUSIC_LIFE.swayDegrees * DEG * swayGain;
  const spineRoll = chestRoll * 0.45;
  const spineYaw = sway * MUSIC_LIFE.swayYawDegrees * DEG * swayGain;
  return {
    breath,
    sway,
    chestPitch: breath * breathAmp,
    upperPitch: breath * breathAmp * 0.75,
    spinePitch: breath * breathAmp * 0.35,
    shoulderPitch: breath * MUSIC_LIFE.shoulderBreathDegrees * DEG * breathGain,
    chestRoll,
    spineRoll,
    spineYaw,
    neckCounterRoll: lookActive ? -0.55 * chestRoll : 0,
    headCounterRoll: lookActive ? -0.7 * chestRoll : 0,
    neckCounterYaw: lookActive ? -0.5 * spineYaw : 0,
    headCounterYaw: lookActive ? -0.35 * spineYaw : 0,
  };
}

const MOOD = Object.freeze({
  groove: {relaxed: 0.35, happy: 0.04, surprised: 0},
  hook: {relaxed: 0.08, happy: 0.25, surprised: 0},
  drop: {relaxed: 0.04, happy: 0.3, surprised: 0},
  outro: {relaxed: 0.48, happy: 0.05, surprised: 0},
});

function scaleMood(preset, energy, expressionWeight) {
  const gain = expressionWeight * (0.55 + 0.45 * clamp01(energy ?? 0.6));
  return {
    relaxed: Math.min(MUSIC_LIFE.moodCap, preset.relaxed * gain),
    happy: Math.min(MUSIC_LIFE.moodCap, preset.happy * gain),
    surprised: Math.min(0.4, preset.surprised * gain),
  };
}

function blendMood(left, right, t) {
  return {
    relaxed: left.relaxed + (right.relaxed - left.relaxed) * t,
    happy: left.happy + (right.happy - left.happy) * t,
    surprised: left.surprised + (right.surprised - left.surprised) * t,
  };
}

function sectionMood(frame, sections, expressionWeight) {
  let index = 0;
  for (let cursor = 0; cursor < sections.length; cursor += 1) if (sections[cursor].frame <= frame) index = cursor;
  const current = sections[index];
  const target = scaleMood(MOOD[current.label] ?? MOOD.groove, current.energy, expressionWeight);
  const into = frame - current.frame;
  let mood = target;
  if (into < MUSIC_LIFE.moodFade) {
    const previous = index > 0
      ? scaleMood(MOOD[sections[index - 1].label] ?? MOOD.groove, sections[index - 1].energy, expressionWeight)
      : {relaxed: 0, happy: 0, surprised: 0};
    mood = blendMood(previous, target, into / MUSIC_LIFE.moodFade);
  }
  if (current.label === 'drop' && into < 8) {
    const blip = 0.3 * expressionWeight * (0.55 + 0.45 * clamp01(current.energy)) * (1 - into / 8);
    mood = {...mood, surprised: Math.max(mood.surprised, Math.min(0.4, blip))};
  }
  return mood;
}

function intensityMood(frame, cues, expressionWeight, fps) {
  const release = Math.max(12, Math.round(fps * 1.35));
  const attack = Math.max(6, Math.round(fps * 0.45));
  let env = 0;
  for (const cue of cues ?? []) {
    const delta = frame - cue.frame;
    if (delta < -attack || delta > release) continue;
    const weight = delta < 0 ? (delta + attack) / attack : Math.exp(-delta / (release / 2.2));
    env = Math.max(env, clamp01(cue.intensity) * clamp01(weight));
  }
  return {
    relaxed: Math.min(MUSIC_LIFE.moodCap, expressionWeight * (0.3 * (1 - env) + 0.08)),
    happy: Math.min(MUSIC_LIFE.moodCap, expressionWeight * 0.22 * env),
    surprised: 0,
  };
}

export function sampleFace({
  frame, fps, face, sections = [], intensityCues = [], downbeats = [], speaking = false, expressionWeight = 1, seed = 0,
}) {
  const moodMode = face.mood ?? 'sections';
  let mood = {relaxed: 0, happy: 0, surprised: 0};
  if (moodMode === 'sections' && sections.length) mood = sectionMood(frame, sections, expressionWeight);
  else if (moodMode === 'intensity' || (moodMode === 'sections' && !sections.length)) {
    mood = intensityCues?.length
      ? intensityMood(frame, intensityCues, expressionWeight, fps)
      : {relaxed: Math.min(MUSIC_LIFE.moodCap, expressionWeight * 0.3), happy: 0, surprised: 0};
  }
  const idleMouth = face.idleMouth ?? MUSIC_LIFE.idleMouth;
  const breathMouth = face.breathMouth ?? true;
  let oh = 0;
  let aa = 0;
  if (!speaking && idleMouth > 0) {
    const period = fps / MUSIC_LIFE.breathHz;
    const breath = Math.sin((2 * Math.PI * frame) / period + seed * 0.017);
    const exhale = clamp01(-breath);
    oh = idleMouth * (0.8 + 0.55 * exhale);
    aa = idleMouth * 0.25 * exhale;
    if (breathMouth) {
      for (const beat of downbeats) {
        if ((beat.strength ?? 0) < 0.8) continue;
        const delta = frame - beat.frame;
        if (delta < 0 || delta >= 6) continue;
        oh += (0.08 + 0.05 * beat.strength) * Math.sin(((delta + 0.5) / 6) * Math.PI);
      }
    }
    oh = clamp(oh, 0, 0.16);
    aa = clamp(aa, 0, 0.04);
  }
  return {...mood, oh, aa};
}

export function speakingAt(dialogue, frame) {
  return Boolean(dialogue?.mouthCues?.some((cue) => frame >= cue.startFrame && frame < cue.endFrame));
}

function round3(value) {
  return Math.round(value * 1000) / 1000;
}

function average(values) {
  if (!values.length) return 0;
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

/**
 * Label groove / hook / drop / outro from per-bar energy and onset.
 * `bars` are `{frame, energy, onset}` in episode frames, one bar each.
 * Fewer than four bars stays a single groove. A sustained rise above the
 * earlier bars is a hook, including a loud slice whose absolute level is
 * already high. A sharp onset jump is a drop. A quiet tail of at least two
 * bars is an outro. The same rules are ported in scripts/extract-beats.py.
 */
export function labelSections(bars) {
  const clean = (Array.isArray(bars) ? bars : []).map((bar) => ({
    frame: bar.frame,
    energy: clamp01(bar.energy ?? 0),
    onset: clamp01(bar.onset ?? 0),
  })).filter((bar) => Number.isSafeInteger(bar.frame) && bar.frame >= 0);
  clean.sort((left, right) => left.frame - right.frame);
  if (!clean.length) return [{frame: 0, label: 'groove', energy: 0.6}];
  if (clean.length < 4) {
    const frame = clean[0].frame;
    return [{frame, label: 'groove', energy: round3(average(clean.map((bar) => bar.energy)))}];
  }
  const smooth = clean.map((bar, index) => {
    const window = clean.slice(Math.max(0, index - 1), Math.min(clean.length, index + 2));
    return average(window.map((item) => item.energy));
  });
  const sorted = [...smooth].sort((left, right) => left - right);
  const median = sorted[Math.floor((sorted.length - 1) / 2)];
  const highCut = Math.max(median * 1.18, sorted[Math.floor(sorted.length * 0.7)] ?? 1);
  const floor = median + 0.08;
  const high = smooth.map((value) => value >= highCut && value >= floor);
  // A loud, nearly flat slice (energy around 0.7) never clears a percentile
  // cut that includes the hook. Compare each bar with the mean of the bars
  // before it so a sustained step still reads as a section.
  const relative = clean.map((bar, index) => {
    if (index < 2 || index + 1 >= clean.length) return false;
    const baseline = average(clean.slice(0, index).map((item) => item.energy));
    return bar.energy >= baseline + 0.06 && clean[index + 1].energy >= baseline + 0.05;
  });
  const runsOf = (flags) => {
    const found = [];
    let start = -1;
    for (let index = 0; index <= flags.length; index += 1) {
      if (index < flags.length && flags[index]) {
        if (start < 0) start = index;
      } else if (start >= 0) {
        if (index - start >= 2) found.push([start, index]);
        start = -1;
      }
    }
    return found;
  };
  const mergeRuns = (runs) => {
    const sorted = [...runs].sort((left, right) => left[0] - right[0] || left[1] - right[1]);
    const merged = [];
    for (const run of sorted) {
      const last = merged.at(-1);
      if (!last || run[0] > last[1]) merged.push([run[0], run[1]]);
      else last[1] = Math.max(last[1], run[1]);
    }
    return merged;
  };
  const runs = mergeRuns([...runsOf(high), ...runsOf(relative)]);
  const sections = [];
  const push = (frame, label, energy) => {
    const previous = sections.at(-1);
    if (previous?.label === label) return;
    sections.push({frame, label, energy: round3(clamp01(energy))});
  };
  const quietEnd = runs.length ? runs[0][0] : clean.length;
  if (quietEnd > 0) push(0, 'groove', average(clean.slice(0, quietEnd).map((bar) => bar.energy)) || 0.6);
  for (let index = 0; index < runs.length; index += 1) {
    const [from, to] = runs[index];
    const previousEnergy = from > 0 ? clean[from - 1].energy : clean[from].energy;
    const previousOnset = from > 0 ? clean[from - 1].onset : 0;
    const jump = clean[from].energy - previousEnergy;
    const onsetJump = clean[from].onset - previousOnset;
    // A drop is a sharp hit. A modest rise (about 0.06–0.2), including one
    // whose onset only ticks up, stays a hook so a chorus is not a surprise blip.
    const label = jump >= 0.25 && onsetJump >= 0.45 ? 'drop' : 'hook';
    push(clean[from].frame, label, average(clean.slice(from, to).map((bar) => bar.energy)));
  }
  if (runs.length) {
    const tailStart = runs.at(-1)[1];
    if (clean.length - tailStart >= 2) {
      const tailEnergy = average(clean.slice(tailStart).map((bar) => bar.energy));
      if (tailEnergy <= median * 0.95) push(clean[tailStart].frame, 'outro', tailEnergy);
    }
  }
  if (!sections.length) return [{frame: 0, label: 'groove', energy: 0.6}];
  if (sections[0].frame > 0) sections.unshift({frame: 0, label: 'groove', energy: sections[0].energy});
  return sections;
}

/** Strong kicks as episode-absolute intensity cues. Groove nod size already uses beat strength. */
export function kickCues(beats, limit = 64) {
  const chosen = (beats ?? []).filter((beat) => {
    const strength = beat.strength ?? 0;
    return (beat.downbeat && strength >= 0.45) || strength >= 0.72;
  });
  const ranked = [...chosen].sort((left, right) => (right.strength ?? 0) - (left.strength ?? 0) || left.frame - right.frame);
  return ranked.slice(0, limit).sort((left, right) => left.frame - right.frame).map((beat) => ({
    frame: beat.frame,
    intensity: round3(clamp01(beat.strength ?? 0)),
    duration: 6,
  }));
}

/** 0 at rest, up to `lightPulse` on a kick, back to 0 eight frames later. */
export function practicalGain(frame, beats, lightPulse = 1) {
  const pulse = clamp01(lightPulse);
  if (pulse <= 0) return 0;
  let level = 0;
  for (const beat of beats ?? []) {
    const age = frame - beat.frame;
    if (age < 0 || age > 8) continue;
    const strength = beat.strength ?? 0;
    if (strength < 0.35) continue;
    level = Math.max(level, strength * (1 - age / 8));
  }
  return clamp01(level) * pulse;
}

function validateBeats(beats, path, durationFrames) {
  if (!Array.isArray(beats) || beats.length > 4096) fail(path, 'expected at most 4096 beats');
  let previous = -1;
  beats.forEach((beat, index) => {
    const item = `${path}[${index}]`;
    plainObject(beat, item, ['frame', 'strength', 'downbeat'], ['frame', 'strength']);
    finite(beat.frame, `${item}.frame`, 0, durationFrames - 1, true);
    if (beat.frame <= previous) fail(`${item}.frame`, 'beats must be strictly increasing');
    previous = beat.frame;
    finite(beat.strength, `${item}.strength`, 0, 1);
    if (own(beat, 'downbeat')) bool(beat.downbeat, `${item}.downbeat`);
  });
}

function validateSections(sections, path, durationFrames) {
  if (!Array.isArray(sections) || sections.length > 64) fail(path, 'expected at most 64 sections');
  let previous = -1;
  sections.forEach((section, index) => {
    const item = `${path}[${index}]`;
    plainObject(section, item, ['frame', 'label', 'energy']);
    finite(section.frame, `${item}.frame`, 0, durationFrames - 1, true);
    if (section.frame <= previous) fail(`${item}.frame`, 'sections must be strictly increasing');
    previous = section.frame;
    if (!SECTION_LABELS.includes(section.label)) fail(`${item}.label`, 'unsupported section');
    finite(section.energy, `${item}.energy`, 0, 1);
  });
}

function validateIntensityCues(cues, path, durationFrames) {
  if (!Array.isArray(cues) || cues.length > 256) fail(path, 'expected at most 256 intensity cues');
  let previous = -1;
  cues.forEach((cue, index) => {
    const item = `${path}[${index}]`;
    plainObject(cue, item, ['frame', 'intensity', 'duration']);
    finite(cue.frame, `${item}.frame`, 0, durationFrames - 1, true);
    if (cue.frame <= previous) fail(`${item}.frame`, 'intensity cues must be strictly increasing');
    previous = cue.frame;
    finite(cue.intensity, `${item}.intensity`, 0, 1);
    finite(cue.duration, `${item}.duration`, 2, 48, true);
  });
}

/** Validate episode.music. Absent means no musical timeline. */
export function validateMusic(value, path, {durationFrames}) {
  plainObject(value, path, ['schema', 'bpm', 'offsetSeconds', 'beats', 'sections', 'intensityCues'], ['bpm', 'beats']);
  if (own(value, 'schema') && value.schema !== MUSIC_SCHEMA) fail(`${path}.schema`, `expected ${MUSIC_SCHEMA}`);
  finite(value.bpm, `${path}.bpm`, 40, 300);
  if (own(value, 'offsetSeconds')) finite(value.offsetSeconds, `${path}.offsetSeconds`, 0, 100000);
  validateBeats(value.beats, `${path}.beats`, durationFrames);
  if (own(value, 'sections')) validateSections(value.sections, `${path}.sections`, durationFrames);
  if (own(value, 'intensityCues')) validateIntensityCues(value.intensityCues, `${path}.intensityCues`, durationFrames);
  return value;
}

/** Validate the optional life blocks on one reactivity object. */
export function validateLifeBlocks(value, path, shotDuration) {
  if (own(value, 'groove')) {
    const groove = value.groove;
    const item = `${path}.groove`;
    plainObject(groove, item, ['division', 'amount', 'phaseFrames', 'roll', 'seed'], []);
    if (own(groove, 'division') && !GROOVE_DIVISIONS.includes(groove.division)) fail(`${item}.division`, 'unsupported division');
    if (own(groove, 'amount')) finite(groove.amount, `${item}.amount`, 0, 1);
    if (own(groove, 'phaseFrames')) finite(groove.phaseFrames, `${item}.phaseFrames`, -3, 3, true);
    if (own(groove, 'roll')) finite(groove.roll, `${item}.roll`, 0, 1);
    if (own(groove, 'seed')) finite(groove.seed, `${item}.seed`, 0, 65535, true);
  }
  if (own(value, 'eyes')) {
    const eyes = value.eyes;
    const item = `${path}.eyes`;
    plainObject(eyes, item, ['blinkRate', 'saccade', 'seed', 'gazeAway'], []);
    if (own(eyes, 'blinkRate')) finite(eyes.blinkRate, `${item}.blinkRate`, 6, 40);
    if (own(eyes, 'saccade')) finite(eyes.saccade, `${item}.saccade`, 0, 1);
    if (own(eyes, 'seed')) finite(eyes.seed, `${item}.seed`, 0, 65535, true);
    if (own(eyes, 'gazeAway')) {
      if (!Array.isArray(eyes.gazeAway) || eyes.gazeAway.length > 8) fail(`${item}.gazeAway`, 'expected at most 8 gaze cues');
      eyes.gazeAway.forEach((cue, index) => {
        const cuePath = `${item}.gazeAway[${index}]`;
        plainObject(cue, cuePath, ['frame', 'duration', 'yaw', 'pitch']);
        finite(cue.frame, `${cuePath}.frame`, 0, Math.max(0, shotDuration - 1), true);
        finite(cue.duration, `${cuePath}.duration`, 8, 150, true);
        if (cue.frame + cue.duration > shotDuration + 8) fail(`${cuePath}.duration`, 'gaze runs past the shot');
        finite(cue.yaw, `${cuePath}.yaw`, -0.8, 0.8);
        finite(cue.pitch, `${cuePath}.pitch`, -0.8, 0.8);
      });
    }
  }
  if (own(value, 'body')) {
    const body = value.body;
    const item = `${path}.body`;
    plainObject(body, item, ['breath', 'sway', 'swayDivision', 'seed'], []);
    if (own(body, 'breath')) finite(body.breath, `${item}.breath`, 0, 1);
    if (own(body, 'sway')) finite(body.sway, `${item}.sway`, 0, 1);
    if (own(body, 'swayDivision') && !SWAY_DIVISIONS.includes(body.swayDivision)) fail(`${item}.swayDivision`, 'unsupported division');
    if (own(body, 'seed')) finite(body.seed, `${item}.seed`, 0, 65535, true);
  }
  if (own(value, 'face')) {
    const face = value.face;
    const item = `${path}.face`;
    plainObject(face, item, ['idleMouth', 'breathMouth', 'mood', 'gestures'], []);
    if (own(face, 'idleMouth')) finite(face.idleMouth, `${item}.idleMouth`, 0, 0.1);
    if (own(face, 'breathMouth')) bool(face.breathMouth, `${item}.breathMouth`);
    if (own(face, 'mood') && !MOOD_MODES.includes(face.mood)) fail(`${item}.mood`, 'unsupported mood');
    if (own(face, 'gestures')) bool(face.gestures, `${item}.gestures`);
  }
}

function defaultStrength(value) {
  return value == null ? 0.7 : value;
}

/** Turn an offline beats document into an episode `music` block. */
export function normalizeImportedMusic(doc, durationFrames) {
  if (!doc || typeof doc !== 'object' || Array.isArray(doc)) throw new TypeError('beats file must be a JSON object');
  const source = doc.music && typeof doc.music === 'object' ? doc.music : doc;
  const beats = (source.beats ?? []).map((beat) => ({
    frame: beat.frame,
    strength: defaultStrength(beat.strength),
    ...(beat.downbeat ? {downbeat: true} : {}),
  }));
  const intensityCues = source.intensityCues ?? kickCues(beats);
  const music = {
    schema: MUSIC_SCHEMA,
    bpm: source.bpm,
    ...(source.offsetSeconds != null ? {offsetSeconds: source.offsetSeconds} : {}),
    beats,
    ...(source.sections ? {sections: source.sections} : {}),
    ...(intensityCues.length ? {intensityCues} : {}),
  };
  validateMusic(music, 'music', {durationFrames});
  return music;
}
