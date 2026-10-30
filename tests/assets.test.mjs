import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, rm, access } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { ASSET_SCHEMA, inspectVrm, importVrm } from '../src/assets.mjs';
import { canonicalExpressionName } from '../src/expression-names.mjs';

const required = ['hips', 'spine', 'head', ...['left', 'right'].flatMap((side) =>
  ['UpperLeg', 'LowerLeg', 'Foot', 'UpperArm', 'LowerArm', 'Hand'].map((part) => side + part))];
function png(width = 32, height = 16) {
  const image = Buffer.alloc(33);
  Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]).copy(image);
  image.writeUInt32BE(13, 8); image.write('IHDR', 12); image.writeUInt32BE(width, 16); image.writeUInt32BE(height, 20);
  return image;
}
function fixture(version = 0, image = png()) {
  const vrm = version === 0 ? {
    specVersion: '0.0', humanoid: { humanBones: required.map((bone, node) => ({ bone, node })) },
    blendShapeMaster: { blendShapeGroups: [{ presetName: 'joy', name: 'Smile' }] },
    meta: { title: 'Fixture', author: 'Test', licenseName: 'CC0', ignored: { data: 'omitted' } },
  } : {
    specVersion: '1.0', humanoid: { humanBones: Object.fromEntries(required.map((bone, node) => [bone, { node }])) },
    expressions: { preset: { happy: {} }, custom: { Curious: {} } }, meta: { name: 'Fixture', authors: ['Test'] },
  };
  return { json: {
    asset: { version: '2.0' }, buffers: [{ byteLength: image.length }],
    bufferViews: [{ buffer: 0, byteOffset: 0, byteLength: image.length }],
    images: [{ bufferView: 0, mimeType: 'image/png' }], textures: [{ source: 0 }],
    meshes: [{ primitives: [] }], nodes: required.map((name) => ({ name })),
    extensions: { [version === 0 ? 'VRM' : 'VRMC_vrm']: vrm },
  }, binary: image };
}
function glb({ json, binary }) {
  let jsonBytes = Buffer.from(JSON.stringify(json));
  jsonBytes = Buffer.concat([jsonBytes, Buffer.alloc((4 - jsonBytes.length % 4) % 4, 32)]);
  const bin = Buffer.concat([binary, Buffer.alloc((4 - binary.length % 4) % 4)]);
  const bytes = Buffer.alloc(12 + 8 + jsonBytes.length + 8 + bin.length);
  bytes.writeUInt32LE(0x46546c67, 0); bytes.writeUInt32LE(2, 4); bytes.writeUInt32LE(bytes.length, 8);
  bytes.writeUInt32LE(jsonBytes.length, 12); bytes.writeUInt32LE(0x4e4f534a, 16); jsonBytes.copy(bytes, 20);
  const offset = 20 + jsonBytes.length;
  bytes.writeUInt32LE(bin.length, offset); bytes.writeUInt32LE(0x004e4942, offset + 4); bin.copy(bytes, offset + 8);
  return bytes;
}

test('summarizes VRM0 and VRM1 with bounded metadata and embedded texture dimensions', () => {
  const zero = inspectVrm(glb(fixture()));
  assert.equal(zero.vrmVersion, '0.0'); assert.equal(zero.extension, 'VRM');
  assert.equal(zero.humanoidBoneCount, 15); assert.equal(zero.meshCount, 1);
  assert.deepEqual(zero.expressions, ['joy']);
  assert.deepEqual(zero.canonicalExpressions, ['happy']);
  assert.deepEqual(zero.canonicalExpressions, zero.expressions.map((name) => canonicalExpressionName(name)));
  assert.deepEqual(zero.imageDimensions, [[32, 16]]);
  assert.equal(zero.totalImagePixels, 512); assert.equal(zero.meta.ignored, undefined);
  const one = inspectVrm(glb(fixture(1)));
  assert.equal(one.vrmVersion, '1.0'); assert.deepEqual(one.expressions, ['Curious', 'happy']);
  assert.deepEqual(one.canonicalExpressions, ['Curious', 'happy']);
});

test('canonical expressions share VRM0 aliases and custom Surprised with resolve', () => {
  const value = fixture();
  value.json.extensions.VRM.blendShapeMaster.blendShapeGroups = [
    { presetName: 'joy', name: 'Smile' },
    { presetName: 'fun', name: 'Fun' },
    { presetName: 'sorrow', name: 'Sorrow' },
    { presetName: 'a', name: 'A' },
    { presetName: 'unknown', name: 'Surprised' },
    { presetName: 'unknown', name: 'Curious' },
  ];
  const summary = inspectVrm(glb(value));
  assert.deepEqual(summary.expressions, ['Curious', 'Surprised', 'a', 'fun', 'joy', 'sorrow']);
  assert.deepEqual(summary.canonicalExpressions, ['Curious', 'aa', 'happy', 'relaxed', 'sad', 'surprised']);
  assert.deepEqual(summary.canonicalExpressions, [...new Set(summary.expressions.map((name) => canonicalExpressionName(name)))].sort());
});

test('recognizes JPEG dimensions without decoding image data', () => {
  const image = Buffer.from([0xff, 0xd8, 0xff, 0xc0, 0, 11, 8, 0, 16, 0, 32, 1, 1, 0x11, 0, 0xff, 0xd9]);
  const value = fixture(1, image); value.json.images[0].mimeType = 'image/jpeg';
  assert.deepEqual(inspectVrm(glb(value)).imageDimensions, [[32, 16]]);
});

test('rejects malformed GLB containers and unsupported asset structures', () => {
  assert.throws(() => inspectVrm(Buffer.from('not a model')), /not a binary GLB/);
  const short = glb(fixture()).subarray(0, 30);
  assert.throws(() => inspectVrm(short), /length/);
  const wrongVersion = glb(fixture()); wrongVersion.writeUInt32LE(1, 4);
  assert.throws(() => inspectVrm(wrongVersion), /version 2/);
  const malformed = glb(fixture()); malformed.writeUInt32LE(0xfffffffc, 12);
  assert.throws(() => inspectVrm(malformed), /chunk length/);
  const cases = [
    [/VRM or VRMC_vrm/, (v) => { v.json.extensions = {}; }],
    [/humanoid/, (v) => { delete v.json.extensions.VRM.humanoid; }],
    [/required humanoid/, (v) => { v.json.extensions.VRM.humanoid.humanBones.pop(); }],
    [/bone mapping/, (v) => { v.json.extensions.VRM.humanoid.humanBones[0].node = 999; }],
    [/duplicate/, (v) => { v.json.extensions.VRM.humanoid.humanBones[1].node = 0; }],
    [/buffer URIs/, (v) => { v.json.buffers[0].uri = 'https://example.invalid/asset.bin'; }],
    [/image URIs/, (v) => { v.json.images[0].uri = 'data:image/png;base64,AAAA'; }],
    [/bufferView/, (v) => { v.json.bufferViews[0].byteLength += 99; }],
    [/buffer length/, (v) => { v.json.buffers[0].byteLength += 99; }],
    [/texture/, (v) => { v.json.textures[0].source = 4; }],
    [/PNG and JPEG/, (v) => { v.json.images[0].mimeType = 'image/webp'; }],
  ];
  for (const [pattern, change] of cases) { const value = fixture(); change(value); assert.throws(() => inspectVrm(glb(value)), pattern); }
  assert.throws(() => inspectVrm(glb(fixture(0, png(9000, 16)))), /dimensions/);
});

test('imports exact content-addressed bytes, preserves IDs, and repeats without lock drift', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'narrative-assets-test-'));
  try {
    const source = path.join(root, 'source.vrm'); const bytes = glb(fixture()); await writeFile(source, bytes);
    const first = await importVrm(source, root, 'first');
    assert.match(first.sha256, /^[a-f0-9]{64}$/);
    assert.equal(first.file, `assets/${first.sha256}.vrm`);
    assert.deepEqual(await readFile(path.join(root, 'public', first.file)), bytes);
    await importVrm(source, root, 'second');
    const lockBefore = await readFile(path.join(root, 'assets.lock.json'), 'utf8');
    assert.deepEqual(await importVrm(source, root, 'first'), first);
    assert.equal(await readFile(path.join(root, 'assets.lock.json'), 'utf8'), lockBefore);
    const lock = JSON.parse(lockBefore); assert.equal(lock.schema, ASSET_SCHEMA);
    assert.deepEqual(Object.keys(lock.assets), ['first', 'second']);
    await assert.rejects(access(path.join(root, '.assets-import.lock')), /ENOENT/);
    await writeFile(path.join(root, 'public', first.file), Buffer.alloc(bytes.length));
    await assert.rejects(importVrm(source, root, 'first'), /does not match its hash/);
    assert.equal(await readFile(path.join(root, 'assets.lock.json'), 'utf8'), lockBefore);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('does not overwrite invalid manifests or concurrent import lock', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'narrative-assets-test-'));
  try {
    const source = path.join(root, 'source.vrm'); await writeFile(source, glb(fixture()));
    await assert.rejects(importVrm(source, root, '../escape'), /assetId/);
    await writeFile(path.join(root, 'assets.lock.json'), '{broken');
    await assert.rejects(importVrm(source, root, 'safe'));
    assert.equal(await readFile(path.join(root, 'assets.lock.json'), 'utf8'), '{broken');
    await writeFile(path.join(root, '.assets-import.lock'), 'active');
    await assert.rejects(importVrm(source, root, 'safe'), /Another import is active/);
    assert.equal(await readFile(path.join(root, '.assets-import.lock'), 'utf8'), 'active');
  } finally { await rm(root, { recursive: true, force: true }); }
});
