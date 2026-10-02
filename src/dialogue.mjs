/**
 * Deterministic English-spelling mouth animation and caption timing.
 * This is a text heuristic, NOT phoneme recognition, speech, or audio alignment.
 * Captions are plain strings; consumers must render text rather than HTML.
 * All intervals are absolute, half-open frame intervals [startFrame,endFrame).
 */
export const MOUTH_SHAPES = Object.freeze(['aa', 'ih', 'ou', 'ee', 'oh']);
export const DIALOGUE_SCHEMA = 'narrative-dialogue/0.1';
const MAX_TEXT = 4000;
const MAX_SECONDS = 180;
const MAX_CAPTION_CHARS = 42;
const MAX_CAPTION_WORDS = 6;
const ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const fail = (path, message) => { throw new TypeError(`${path}: ${message}`); };
const own = (value, key) => Object.hasOwn(value, key);

function object(value, path, fields, required = fields) {
  if (!value || typeof value !== 'object' || Array.isArray(value)
      || ![Object.prototype, null].includes(Object.getPrototypeOf(value))) fail(path, 'expected a plain object');
  for (const field of Object.keys(value)) if (!fields.includes(field)) fail(`${path}.${field}`, 'unsupported field');
  for (const field of required) if (!own(value, field)) fail(`${path}.${field}`, 'required field');
}
function numeric(value, path, min, max, integer = false) {
  if (!Number.isFinite(value) || value < min || value > max || (integer && !Number.isSafeInteger(value))) {
    fail(path, `expected ${integer ? 'a safe integer' : 'a finite number'} in [${min},${max}]`);
  }
}
function identifier(value, path) { if (typeof value !== 'string' || !ID.test(value)) fail(path, 'invalid identifier'); }
function plainText(value, path, maximum = MAX_TEXT, empty = false) {
  if (typeof value !== 'string' || value.length > maximum || (!empty && !value.length)
      || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(value)) fail(path, `expected plain text of at most ${maximum} characters`);
}
function array(value, path, maximum = 4000) {
  if (!Array.isArray(value) || value.length > maximum) fail(path, 'expected a bounded array');
  for (let i = 0; i < value.length; i++) if (!own(value, i)) fail(`${path}[${i}]`, 'missing array item');
}
function interval(value, path, endLimit) {
  numeric(value.startFrame, `${path}.startFrame`, 0, Number.MAX_SAFE_INTEGER, true);
  numeric(value.endFrame, `${path}.endFrame`, 1, endLimit, true);
  if (value.startFrame >= value.endFrame) fail(path, 'expected a nonempty half-open frame interval');
}
const silence = () => Object.fromEntries(MOUTH_SHAPES.map((shape) => [shape, 0]));

function vowelShapes(token) {
  // A small explicit spelling for the recurring greeting; bare consonants
  // would otherwise leave a visibly closed mouth for the entire "GM" caption.
  if (/^GM[,.!?]?$/u.test(token)) return ['ee', 'ee'];
  let letters = token.normalize('NFKD').replace(/\p{Mark}/gu, '').toLowerCase().replace(/[^a-z]/g, '');
  // Keep common pronounced final e; drop the usual consonant + silent e.
  if (letters.length > 2 && !['the', 'she'].includes(letters) && /[^aeiouy]e$/.test(letters)) letters = letters.slice(0, -1);
  return (letters.match(/[aeiouy]+/g) ?? []).map((group) => {
    if (/oo|ou/.test(group) || group.startsWith('u')) return 'ou';
    if (group.startsWith('a')) return 'aa';
    if (group.startsWith('e')) return 'ee';
    if (group.startsWith('o')) return 'oh';
    return 'ih';
  });
}
const endsSentence = (token) => /[.!?][\u2019\u201d"')\]}]*$/.test(token);
function pauseFrames(token, fps, finalWord) {
  let seconds = endsSentence(token) ? 0.32 : /[,;:][\u2019\u201d"')\]}]*$/.test(token) ? 0.18
    : /[\u2014\u2013-]$/.test(token) ? 0.14 : 0.04;
  if (finalWord) seconds = Math.max(seconds, 0.4);
  return Math.max(1, Math.round(seconds * fps));
}

/** Compile text only. WPM is speaking pace; punctuation and rest gaps add time. */
export function compileDialogue(options) {
  object(options, 'dialogue options', ['text', 'actorId', 'fps', 'wordsPerMinute', 'mouthStrength', 'startFrame'], ['text']);
  const { text, actorId = 'performer', fps = 30, wordsPerMinute = 150, mouthStrength = 0.7, startFrame = 0 } = options;
  plainText(text, 'text', MAX_TEXT, true);
  identifier(actorId, 'actorId');
  numeric(fps, 'fps', 1, 240, true);
  numeric(wordsPerMinute, 'wordsPerMinute', 80, 240);
  numeric(mouthStrength, 'mouthStrength', 0, 1);
  numeric(startFrame, 'startFrame', 0, Number.MAX_SAFE_INTEGER, true);
  const result = { schema: DIALOGUE_SCHEMA, fps, actorId, durationFrames: 0, captions: [], mouthCues: [] };
  const tokens = text.trim().split(/\s+/u).filter(Boolean);
  if (!tokens.length) return result;
  for (const token of tokens) if (token.length > MAX_CAPTION_CHARS) fail('text', 'a word exceeds 42 characters; split it explicitly');
  const baseFrames = 60 * fps / wordsPerMinute;
  const edgeRest = Math.max(1, Math.round(fps / 30));
  const cueGap = Math.max(1, Math.round(fps / 30));
  const timedWords = [];
  let cursor = startFrame;
  tokens.forEach((token, index) => {
    const shapes = vowelShapes(token);
    // Give even short vowel groups two samples and leave closed-mouth edges.
    const wordFrames = Math.max(1,
      Math.round((index + 1) * baseFrames) - Math.round(index * baseFrames),
      shapes.length ? edgeRest * 2 + shapes.length * 2 + (shapes.length - 1) * cueGap : 1);
    const endFrame = cursor + wordFrames;
    const slotEnd = endFrame + pauseFrames(token, fps, index === tokens.length - 1);
    if (!Number.isSafeInteger(slotEnd) || slotEnd - startFrame > MAX_SECONDS * fps) fail('text', 'compiled dialogue exceeds 180 seconds or safe frame range');
    timedWords.push({ text: token, startFrame: cursor, endFrame, slotEnd });
    if (shapes.length) {
      const available = wordFrames - 2 * edgeRest - (shapes.length - 1) * cueGap;
      const size = Math.floor(available / shapes.length);
      const remainder = available % shapes.length;
      let cueStart = cursor + edgeRest;
      shapes.forEach((shape, group) => {
        const cueEnd = cueStart + size + (group < remainder ? 1 : 0);
        result.mouthCues.push({ shape, startFrame: cueStart, endFrame: cueEnd, weight: mouthStrength });
        cueStart = cueEnd + cueGap;
      });
    }
    cursor = slotEnd;
  });
  result.durationFrames = cursor;
  let group = [];
  const finishCaption = () => {
    if (!group.length) return;
    result.captions.push({
      id: `caption-${result.captions.length + 1}`,
      text: group.map((word) => word.text).join(' '),
      startFrame: group[0].startFrame,
      endFrame: group.at(-1).slotEnd,
      words: group.map(({ text, startFrame, endFrame }) => ({ text, startFrame, endFrame })),
    });
    group = [];
  };
  for (const word of timedWords) {
    if (group.length && (group.length === MAX_CAPTION_WORDS
        || [...group.map((item) => item.text), word.text].join(' ').length > MAX_CAPTION_CHARS)) finishCaption();
    group.push(word);
    if (endsSentence(word.text)) finishCaption();
  }
  finishCaption();
  // Rebalance an avoidable one-word sentence tail without changing any timed
  // word or mouth cue. Prefer 4+3 over 6+1; a genuine one-word sentence stays.
  for (let index = 1; index < result.captions.length; index++) {
    const current = result.captions[index];
    const previous = result.captions[index - 1];
    if (current.words.length !== 1 || endsSentence(previous.words.at(-1).text)
        || (index !== result.captions.length - 1 && !endsSentence(current.words[0].text))) continue;
    const combined = [...previous.words, ...current.words];
    let bestSplit;
    for (let split = 2; split <= combined.length - 2; split++) {
      const left = combined.slice(0, split);
      const right = combined.slice(split);
      if ([left, right].some((words) => words.length > MAX_CAPTION_WORDS
          || words.map((word) => word.text).join(' ').length > MAX_CAPTION_CHARS)) continue;
      if (bestSplit === undefined || Math.abs(combined.length - 2 * split) <= Math.abs(combined.length - 2 * bestSplit)) bestSplit = split;
    }
    if (bestSplit === undefined) continue;
    previous.words = combined.slice(0, bestSplit);
    current.words = combined.slice(bestSplit);
    previous.text = previous.words.map((word) => word.text).join(' ');
    current.text = current.words.map((word) => word.text).join(' ');
    current.startFrame = current.words[0].startFrame;
    previous.endFrame = current.startFrame;
  }
  validateDialogue(result);
  return result;
}

/** Validate structure and optional containing-episode constraints; no mutation. */
export function validateDialogue(dialogue, constraints = {}) {
  object(constraints, 'dialogue constraints', ['fps', 'durationFrames', 'actorIds'], []);
  object(dialogue, 'dialogue', ['schema', 'fps', 'actorId', 'durationFrames', 'captions', 'mouthCues']);
  if (dialogue.schema !== DIALOGUE_SCHEMA) fail('dialogue.schema', `expected ${DIALOGUE_SCHEMA}`);
  numeric(dialogue.fps, 'dialogue.fps', 1, 240, true);
  identifier(dialogue.actorId, 'dialogue.actorId');
  numeric(dialogue.durationFrames, 'dialogue.durationFrames', 0, Number.MAX_SAFE_INTEGER, true);
  if (own(constraints, 'fps')) {
    numeric(constraints.fps, 'dialogue constraints.fps', 1, 240, true);
    if (constraints.fps !== dialogue.fps) fail('dialogue.fps', 'does not match episode fps');
  }
  if (own(constraints, 'durationFrames')) {
    numeric(constraints.durationFrames, 'dialogue constraints.durationFrames', 0, Number.MAX_SAFE_INTEGER, true);
    if (dialogue.durationFrames > constraints.durationFrames) fail('dialogue.durationFrames', 'exceeds episode duration');
  }
  if (own(constraints, 'actorIds')) {
    if (!(constraints.actorIds instanceof Set) && !Array.isArray(constraints.actorIds)) fail('dialogue constraints.actorIds', 'expected an array or Set');
    const ids = new Set(constraints.actorIds);
    for (const id of ids) identifier(id, 'dialogue constraints.actorIds');
    if (!ids.has(dialogue.actorId)) fail('dialogue.actorId', 'unknown actor');
  }
  array(dialogue.captions, 'dialogue.captions');
  array(dialogue.mouthCues, 'dialogue.mouthCues');
  if (!dialogue.captions.length) {
    if (dialogue.durationFrames !== 0 || dialogue.mouthCues.length) fail('dialogue', 'empty dialogue must have zero duration and no mouth cues');
    return dialogue;
  }
  const ids = new Set();
  let priorCaptionEnd = 0;
  let totalTextLength = 0;
  const words = [];
  dialogue.captions.forEach((caption, index) => {
    const cp = `dialogue.captions[${index}]`;
    object(caption, cp, ['id', 'text', 'startFrame', 'endFrame', 'words']);
    identifier(caption.id, `${cp}.id`);
    if (ids.has(caption.id)) fail(`${cp}.id`, 'duplicate caption');
    ids.add(caption.id);
    plainText(caption.text, `${cp}.text`, MAX_CAPTION_CHARS);
    interval(caption, cp, dialogue.durationFrames);
    if (caption.startFrame < priorCaptionEnd) fail(cp, 'captions must be ordered without overlap');
    priorCaptionEnd = caption.endFrame;
    array(caption.words, `${cp}.words`, MAX_CAPTION_WORDS);
    if (!caption.words.length) fail(`${cp}.words`, 'caption needs at least one word');
    let previousEnd = caption.startFrame;
    caption.words.forEach((word, wordIndex) => {
      const wp = `${cp}.words[${wordIndex}]`;
      object(word, wp, ['text', 'startFrame', 'endFrame']);
      plainText(word.text, `${wp}.text`, MAX_CAPTION_CHARS);
      if (/\s/u.test(word.text)) fail(`${wp}.text`, 'expected a single whitespace-delimited word');
      interval(word, wp, caption.endFrame);
      if (word.startFrame < previousEnd) fail(wp, 'words must be ordered without overlap and inside caption');
      previousEnd = word.endFrame;
      words.push(word);
    });
    if (caption.startFrame !== caption.words[0].startFrame) fail(cp, 'caption must start with its first word');
    if (caption.text !== caption.words.map((word) => word.text).join(' ')) fail(`${cp}.text`, 'must equal its words joined with spaces');
    totalTextLength += caption.text.length + (index ? 1 : 0);
  });
  if (totalTextLength > MAX_TEXT) fail('dialogue.captions', 'text exceeds 4000 characters');
  if (dialogue.durationFrames - dialogue.captions[0].startFrame > MAX_SECONDS * dialogue.fps) fail('dialogue.durationFrames', 'dialogue span exceeds 180 seconds');
  let priorCueEnd = 0;
  let wordCursor = 0;
  dialogue.mouthCues.forEach((cue, index) => {
    const cp = `dialogue.mouthCues[${index}]`;
    object(cue, cp, ['shape', 'startFrame', 'endFrame', 'weight']);
    if (!MOUTH_SHAPES.includes(cue.shape)) fail(`${cp}.shape`, 'unsupported mouth shape');
    numeric(cue.weight, `${cp}.weight`, 0, 1);
    interval(cue, cp, dialogue.durationFrames);
    if (cue.startFrame < priorCueEnd) fail(cp, 'mouth cues must be ordered without overlap');
    priorCueEnd = cue.endFrame;
    while (wordCursor < words.length && words[wordCursor].endFrame <= cue.startFrame) wordCursor++;
    const word = words[wordCursor];
    if (!word || cue.startFrame < word.startFrame || cue.endFrame > word.endFrame) fail(cp, 'mouth cue must stay inside one spoken word, outside silent gaps');
  });
  return dialogue;
}

/** Any nonnegative frame is allowed; outside dialogue returns closed mouth. */
export function evaluateDialogueAtFrame(dialogue, frame) {
  validateDialogue(dialogue);
  numeric(frame, 'frame', 0, Number.MAX_SAFE_INTEGER, true);
  const result = { caption: null, wordIndex: -1, mouth: silence() };
  if (frame >= dialogue.durationFrames) return result;
  const caption = dialogue.captions.find((item) => frame >= item.startFrame && frame < item.endFrame);
  if (caption) {
    result.caption = { ...caption, words: caption.words.map((word) => ({ ...word })) };
    result.wordIndex = caption.words.findIndex((word) => frame >= word.startFrame && frame < word.endFrame);
  }
  const cue = dialogue.mouthCues.find((item) => frame >= item.startFrame && frame < item.endFrame);
  if (cue) {
    const ramp = Math.max(2, Math.min(3, Math.round(dialogue.fps * 0.08)));
    const attack = (frame - cue.startFrame + 1) / ramp;
    const release = (cue.endFrame - frame) / ramp;
    result.mouth[cue.shape] = cue.weight * Math.min(1, attack, release);
  }
  return result;
}
