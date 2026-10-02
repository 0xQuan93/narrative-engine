import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { compileDialogue, validateDialogue, evaluateDialogueAtFrame, MOUTH_SHAPES } from '../src/dialogue.mjs';

const mouthIsClosed = (result) => assert.ok(Object.values(result.mouth).every((weight) => weight === 0));

test('compiles readable captions in original word order without interpreting markup', () => {
  const text = '<b>Hello</b> & "you" are welcome to our little room. A new day begins!';
  const dialogue = compileDialogue({ text });
  assert.deepEqual(dialogue.captions.flatMap((caption) => caption.words.map((word) => word.text)), text.split(' '));
  assert.ok(dialogue.captions.every((caption) => caption.words.length <= 6 && caption.text.length <= 42));
  assert.ok(dialogue.captions[0].text.includes('<b>Hello</b>'));
  assert.equal(validateDialogue(dialogue), dialogue);
});

test('balances one-word sentence tails while preserving every existing word and mouth timing', () => {
  const text = 'Every story begins with a small signal. And bringing this world to life together.';
  const dialogue = compileDialogue({ text });
  assert.deepEqual(dialogue.captions.map((caption) => caption.text), [
    'Every story begins with', 'a small signal.', 'And bringing this world', 'to life together.',
  ]);
  assert.deepEqual(dialogue.captions.map((caption) => caption.words.length), [4, 3, 4, 3]);
  assert.ok(dialogue.captions.every((caption) => caption.text.length <= 42));
  assert.equal(validateDialogue(dialogue), dialogue);
  const timing = { durationFrames: dialogue.durationFrames, words: dialogue.captions.flatMap((caption) => caption.words), mouthCues: dialogue.mouthCues };
  // Receipt captured before the caption-grouping change; only grouping may move.
  assert.equal(createHash('sha256').update(JSON.stringify(timing)).digest('hex'), '62e1c303633095cfc26104573ee43d02faa1bcc8f81d5a3a3b806a82c5a9490f');
  assert.deepEqual(compileDialogue({ text }), dialogue);
  for (let index = 1; index < dialogue.captions.length; index++) {
    assert.equal(dialogue.captions[index - 1].endFrame, dialogue.captions[index].startFrame);
  }
});

test('retains single-word sentences and a tail that cannot fit with another word', () => {
  assert.equal(compileDialogue({ text: 'Hello! We are here.' }).captions[0].text, 'Hello!');
  const longWord = 'a'.repeat(41) + '.';
  const dialogue = compileDialogue({ text: `One two three four five six ${longWord}` });
  assert.equal(dialogue.captions.at(-1).text, longWord);
  assert.ok(dialogue.captions.every((caption) => caption.words.length <= 6 && caption.text.length <= 42));
});

test('punctuation inserts silence, word highlights end, and final pause closes mouth', () => {
  const dialogue = compileDialogue({ text: 'Hello, friend. We are here!' });
  const words = dialogue.captions.flatMap((caption) => caption.words);
  assert.ok(words[1].startFrame - words[0].endFrame >= 5);
  assert.ok(words[2].startFrame - words[1].endFrame >= 9);
  for (let index = 0; index < words.length - 1; index++) {
    for (let frame = words[index].endFrame; frame < words[index + 1].startFrame; frame++) {
      const result = evaluateDialogueAtFrame(dialogue, frame);
      mouthIsClosed(result); assert.equal(result.wordIndex, -1);
    }
  }
  assert.ok(dialogue.durationFrames - words.at(-1).endFrame >= 12);
  for (let frame = words.at(-1).endFrame; frame <= dialogue.durationFrames + 10; frame++) mouthIsClosed(evaluateDialogueAtFrame(dialogue, frame));
  assert.equal(evaluateDialogueAtFrame(dialogue, dialogue.durationFrames).caption, null);
});

test('English vowel-group mapping handles silent final e and explicit five shapes', () => {
  const dialogue = compileDialogue({ text: 'Make see bit boat moon.' });
  assert.deepEqual(dialogue.mouthCues.map((cue) => cue.shape), ['aa', 'ee', 'ih', 'oh', 'ou']);
  assert.deepEqual(MOUTH_SHAPES, ['aa', 'ih', 'ou', 'ee', 'oh']);
});

test('GM greeting receives spoken-letter mouth cues despite consonant spelling', () => {
  const dialogue = compileDialogue({text: 'GM, builders.'});
  const greeting = dialogue.captions[0].words[0];
  assert.deepEqual(dialogue.mouthCues.filter((cue) => cue.startFrame >= greeting.startFrame
    && cue.endFrame <= greeting.endFrame).map((cue) => cue.shape), ['ee', 'ee']);
});

test('arbitrary repeated/shuffled seeks agree with sequential evaluation and do not mutate data', () => {
  const dialogue = compileDialogue({ text: 'We build a scene. You bring the story!', startFrame: 11 });
  const before = JSON.stringify(dialogue);
  const sequential = Array.from({ length: dialogue.durationFrames + 2 }, (_, frame) => evaluateDialogueAtFrame(dialogue, frame));
  for (let frame = sequential.length - 1; frame >= 0; frame--) {
    assert.deepEqual(evaluateDialogueAtFrame(dialogue, frame), sequential[frame]);
    assert.deepEqual(evaluateDialogueAtFrame(dialogue, frame), sequential[frame]);
  }
  const returned = evaluateDialogueAtFrame(dialogue, 11);
  returned.caption.words[0].text = 'changed';
  assert.equal(JSON.stringify(dialogue), before);
  assert.deepEqual(compileDialogue({ text: 'We build a scene. You bring the story!', startFrame: 11 }), dialogue);
  assert.equal(evaluateDialogueAtFrame(dialogue, 10).caption, null);
  mouthIsClosed(evaluateDialogueAtFrame(dialogue, 10));
});

test('mouth attack/release is bounded, symmetrical, and zero outside cue', () => {
  const dialogue = compileDialogue({ text: 'aa', wordsPerMinute: 80, mouthStrength: 0.6 });
  const cue = dialogue.mouthCues[0];
  const at = (frame) => evaluateDialogueAtFrame(dialogue, frame).mouth.aa;
  assert.equal(at(cue.startFrame - 1), 0);
  assert.equal(at(cue.endFrame), 0);
  assert.equal(at(cue.startFrame), 0.3);
  assert.equal(at(cue.startFrame + 1), 0.6);
  assert.equal(at(cue.endFrame - 1), 0.3);
  for (let frame = 0; frame < dialogue.durationFrames; frame++) {
    const values = Object.values(evaluateDialogueAtFrame(dialogue, frame).mouth);
    assert.ok(values.every((weight) => weight >= 0 && weight <= 0.6));
    assert.ok(values.filter((weight) => weight > 0).length <= 1);
  }
});

test('short words and dense vowel groups receive valid nonoverlapping frame budgets', () => {
  const dialogue = compileDialogue({ text: 'I a eye automatically unusual.', fps: 12, wordsPerMinute: 240 });
  assert.equal(validateDialogue(dialogue), dialogue);
  assert.ok(dialogue.mouthCues.every((cue) => cue.endFrame - cue.startFrame >= 2));
  for (let i = 1; i < dialogue.mouthCues.length; i++) assert.ok(dialogue.mouthCues[i].startFrame >= dialogue.mouthCues[i - 1].endFrame);
});

test('empty input has zero duration regardless of offset; consonant-only words stay closed', () => {
  const empty = compileDialogue({ text: '\n \t ', startFrame: 100 });
  assert.equal(empty.durationFrames, 0); assert.deepEqual(empty.captions, []); assert.deepEqual(empty.mouthCues, []);
  mouthIsClosed(evaluateDialogueAtFrame(empty, 100));
  const consonants = compileDialogue({ text: 'hmm psst' });
  assert.ok(consonants.durationFrames > 0); assert.deepEqual(consonants.mouthCues, []);
});

test('validates containing episode fps, actor and duration constraints', () => {
  const dialogue = compileDialogue({ text: 'Hello.', actorId: 'guest', startFrame: 30 });
  assert.equal(validateDialogue(dialogue, { fps: 30, actorIds: new Set(['guest']), durationFrames: dialogue.durationFrames }), dialogue);
  assert.throws(() => validateDialogue(dialogue, { fps: 24 }), /fps/);
  assert.throws(() => validateDialogue(dialogue, { actorIds: ['another-performer'] }), /unknown actor/);
  assert.throws(() => validateDialogue(dialogue, { durationFrames: 10 }), /exceeds/);
});

test('rejects invalid weights, cue overlap, silence intrusion and malformed caption ordering', () => {
  const original = compileDialogue({ text: 'Hello, friend.' });
  const cases = [
    (d) => { d.mouthCues[0].weight = NaN; },
    (d) => { d.mouthCues[0].weight = 1.1; },
    (d) => { d.mouthCues[0].shape = 'unknown'; },
    (d) => { d.mouthCues[1].startFrame = d.mouthCues[0].startFrame; },
    (d) => { d.mouthCues[0].endFrame = d.captions[0].words[0].endFrame + 1; d.mouthCues.splice(1); },
    (d) => { d.captions[0].words[1].startFrame = 0; },
    (d) => { d.captions[0].text = 'Wrong text'; },
    (d) => { d.mouthCues[0].extra = true; },
    (d) => { d.mouthCues[0].startFrame = 1.5; },
  ];
  for (const change of cases) { const dialogue = structuredClone(original); change(dialogue); assert.throws(() => validateDialogue(dialogue)); }
});

test('rejects invalid compilation inputs, giant words, excessive durations and frame requests', () => {
  for (const options of [
    { text: 'x'.repeat(43) }, { text: 'x '.repeat(2001) }, { text: 'hello', wordsPerMinute: 79 },
    { text: 'hello', wordsPerMinute: 241 }, { text: 'hello', mouthStrength: -0.1 },
    { text: 'hello', fps: 29.97 }, { text: 'hello', startFrame: -1 }, { text: 'a\u0000b' },
    { text: 'hello', seed: 1 }, { text: 'word '.repeat(400), wordsPerMinute: 80 },
  ]) assert.throws(() => compileDialogue(options));
  const dialogue = compileDialogue({ text: 'Hello.' });
  for (const frame of [-1, 1.5, NaN, Infinity]) assert.throws(() => evaluateDialogueAtFrame(dialogue, frame), /frame/);
});
