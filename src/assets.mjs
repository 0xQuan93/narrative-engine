/** Local VRM preflight and immutable asset import; not a full glTF validator. */
import { createHash, randomUUID } from 'node:crypto';
import { canonicalExpressionName } from './expression-names.mjs';
import { mkdir, open, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';

export const ASSET_SCHEMA = 'narrative-assets/0.1';
export const MAX_VRM_BYTES = 64 * 1024 * 1024;
const MAX_IMAGE_DIMENSION = 8192;
const MAX_TOTAL_IMAGE_PIXELS = 128 * 1024 * 1024;
const REQUIRED_BONES = ['hips', 'spine', 'head', ...['left', 'right'].flatMap((side) =>
  ['UpperLeg', 'LowerLeg', 'Foot', 'UpperArm', 'LowerArm', 'Hand'].map((bone) => side + bone))];
const IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const fail = (message) => { throw new Error(`VRM preflight: ${message}`); };
const isObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
const uint = (value) => Number.isSafeInteger(value) && value >= 0;
const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');

function pngSize(bytes) {
  const signature = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
  if (bytes.length < 33 || !bytes.subarray(0, 8).equals(signature)
      || bytes.readUInt32BE(8) !== 13 || bytes.toString('ascii', 12, 16) !== 'IHDR') {
    fail('invalid embedded PNG header');
  }
  return [bytes.readUInt32BE(16), bytes.readUInt32BE(20)];
}

function jpegSize(bytes) {
  if (bytes.length < 4 || bytes[0] !== 0xff || bytes[1] !== 0xd8) fail('invalid embedded JPEG header');
  const sizeMarkers = new Set([0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf]);
  let offset = 2;
  while (offset < bytes.length) {
    if (bytes[offset++] !== 0xff) fail('invalid JPEG marker');
    while (offset < bytes.length && bytes[offset] === 0xff) offset++;
    if (offset >= bytes.length) break;
    const marker = bytes[offset++];
    if (marker === 0xda || marker === 0xd9) break;
    if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) continue;
    if (offset + 2 > bytes.length) fail('truncated JPEG segment');
    const length = bytes.readUInt16BE(offset);
    if (length < 2 || offset + length > bytes.length) fail('invalid JPEG segment length');
    if (sizeMarkers.has(marker)) {
      if (length < 8) fail('truncated JPEG dimensions');
      return [bytes.readUInt16BE(offset + 5), bytes.readUInt16BE(offset + 3)];
    }
    offset += length;
  }
  fail('JPEG dimensions not found');
}

function safeMeta(meta) {
  if (!isObject(meta)) return {};
  // Metadata is reported as claims from the file, never interpreted as permission.
  const fields = ['title', 'name', 'version', 'author', 'authors', 'contactInformation',
    'reference', 'references', 'allowedUserName', 'violentUssageName', 'sexualUssageName',
    'commercialUssageName', 'otherPermissionUrl', 'licenseName', 'otherLicenseUrl',
    'licenseUrl', 'copyrightInformation', 'avatarPermission', 'commercialUsage',
    'creditNotation', 'allowRedistribution', 'modification', 'otherLicenseUrl',
    'allowExcessivelyViolentUsage', 'allowExcessivelySexualUsage', 'allowPoliticalOrReligiousUsage',
    'allowAntisocialOrHateUsage'];
  return Object.fromEntries([...new Set(fields)].filter((key) => Object.hasOwn(meta, key)).map((key) => {
    const value = meta[key];
    if (typeof value === 'string') return [key, value.slice(0, 4096)];
    if (typeof value === 'boolean') return [key, value];
    if (Array.isArray(value) && value.every((item) => typeof item === 'string')) {
      return [key, value.slice(0, 32).map((item) => item.slice(0, 4096))];
    }
    return null;
  }).filter(Boolean));
}

/** Inspect embedded GLB/VRM0 or VRM1 bytes without invoking a renderer. */
export function inspectVrm(input) {
  if (!(input instanceof Uint8Array) && !(input instanceof ArrayBuffer)) fail('expected binary bytes');
  const bytes = input instanceof ArrayBuffer ? Buffer.from(input)
    : Buffer.from(input.buffer, input.byteOffset, input.byteLength);
  if (bytes.length > MAX_VRM_BYTES) fail('source exceeds the 64 MiB limit');
  if (bytes.length < 20 || bytes.readUInt32LE(0) !== 0x46546c67) fail('not a binary GLB file');
  if (bytes.readUInt32LE(4) !== 2) fail('only GLB version 2 is supported');
  if (bytes.readUInt32LE(8) !== bytes.length) fail('declared GLB length does not match actual bytes');
  let offset = 12;
  let json;
  let binary;
  let chunks = 0;
  while (offset < bytes.length) {
    if (offset + 8 > bytes.length) fail('truncated chunk header');
    const length = bytes.readUInt32LE(offset);
    const type = bytes.readUInt32LE(offset + 4);
    offset += 8;
    if (length % 4 || offset + length > bytes.length) fail('invalid chunk length or alignment');
    if (type === 0x4e4f534a && chunks === 0) {
      if (length > 8 * 1024 * 1024) fail('JSON chunk exceeds 8 MiB');
      try { json = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes.subarray(offset, offset + length))); }
      catch { fail('invalid UTF-8 or JSON chunk'); }
    } else if (type === 0x004e4942 && chunks === 1) {
      binary = bytes.subarray(offset, offset + length);
    } else {
      fail('expected one JSON chunk followed by one BIN chunk');
    }
    offset += length;
    chunks++;
  }
  if (!isObject(json) || !binary || chunks !== 2) fail('missing JSON object or embedded BIN chunk');
  if (json.asset?.version !== '2.0') fail('expected glTF asset version 2.0');
  const lists = {};
  for (const [key, maximum] of Object.entries({ nodes: 10000, meshes: 2000, textures: 512, images: 512, bufferViews: 100000 })) {
    const list = json[key] ?? [];
    if (!Array.isArray(list) || list.length > maximum || list.some((item) => !isObject(item))) fail(`invalid or excessive ${key}`);
    lists[key] = list;
  }
  if (!lists.nodes.length || !lists.meshes.length) fail('avatar needs nodes and meshes');
  if (!Array.isArray(json.buffers) || json.buffers.length !== 1 || !isObject(json.buffers[0])) fail('expected one embedded buffer');
  const buffer = json.buffers[0];
  if (Object.hasOwn(buffer, 'uri')) fail('buffer URIs are unsupported; use embedded BIN data');
  if (!uint(buffer.byteLength) || buffer.byteLength < 1 || buffer.byteLength > binary.length
      || binary.length - buffer.byteLength > 3) fail('embedded buffer length mismatch');
  const views = lists.bufferViews.map((view) => {
    const start = view.byteOffset ?? 0;
    if (view.buffer !== 0 || !uint(start) || !uint(view.byteLength) || view.byteLength < 1
        || start + view.byteLength > buffer.byteLength) fail('bufferView is outside the embedded buffer');
    return binary.subarray(start, start + view.byteLength);
  });
  let totalImagePixels = 0;
  const imageDimensions = lists.images.map((image) => {
    if (Object.hasOwn(image, 'uri')) fail('image URIs are unsupported, including data URIs; use bufferView images');
    if (!uint(image.bufferView) || image.bufferView >= views.length) fail('invalid image bufferView');
    const imageBytes = views[image.bufferView];
    let dimensions;
    if (image.mimeType === 'image/png') dimensions = pngSize(imageBytes);
    else if (image.mimeType === 'image/jpeg') dimensions = jpegSize(imageBytes);
    else fail('only embedded PNG and JPEG images are supported');
    if (dimensions.some((size) => size < 1 || size > MAX_IMAGE_DIMENSION)) fail('image dimensions must be 1..8192 pixels');
    totalImagePixels += dimensions[0] * dimensions[1];
    if (totalImagePixels > MAX_TOTAL_IMAGE_PIXELS) fail('combined images exceed 128 Mi-pixels');
    return dimensions;
  });
  for (const texture of lists.textures) {
    if (!uint(texture.source) || texture.source >= lists.images.length) fail('texture must reference an embedded PNG/JPEG image');
  }
  const hasV0 = isObject(json.extensions?.VRM);
  const hasV1 = isObject(json.extensions?.VRMC_vrm);
  if (hasV0 === hasV1) fail('expected exactly one VRM or VRMC_vrm extension');
  const extension = hasV0 ? 'VRM' : 'VRMC_vrm';
  const vrm = json.extensions[extension];
  const humanBones = vrm.humanoid?.humanBones;
  let mappings;
  if (hasV0 && Array.isArray(humanBones)) mappings = humanBones.map((entry) => [entry?.bone, entry?.node]);
  else if (hasV1 && isObject(humanBones)) mappings = Object.entries(humanBones).map(([bone, entry]) => [bone, entry?.node]);
  else fail('missing or malformed humanoid humanBones');
  const boneNames = new Set();
  const boneNodes = new Set();
  for (const [bone, node] of mappings) {
    if (typeof bone !== 'string' || !/^[A-Za-z][A-Za-z0-9]{0,63}$/.test(bone)
        || !uint(node) || node >= lists.nodes.length) fail('invalid humanoid bone mapping');
    if (boneNames.has(bone) || boneNodes.has(node)) fail('duplicate humanoid bone or node mapping');
    boneNames.add(bone); boneNodes.add(node);
  }
  const missing = REQUIRED_BONES.filter((bone) => !boneNames.has(bone));
  if (missing.length) fail(`missing required humanoid bones: ${missing.join(', ')}`);
  let expressionNames;
  if (hasV0) {
    const groups = vrm.blendShapeMaster?.blendShapeGroups ?? [];
    if (!Array.isArray(groups) || groups.length > 512) fail('invalid expression groups');
    expressionNames = groups.map((group) => group?.presetName && group.presetName !== 'unknown' ? group.presetName : group?.name);
  } else {
    const preset = vrm.expressions?.preset ?? {};
    const custom = vrm.expressions?.custom ?? {};
    if (!isObject(preset) || !isObject(custom)) fail('invalid expression maps');
    expressionNames = [...Object.keys(preset), ...Object.keys(custom)];
  }
  if (expressionNames.length > 512 || expressionNames.some((name) => typeof name !== 'string' || !name.length || name.length > 256)) fail('invalid expression names');
  return {
    vrmVersion: typeof vrm.specVersion === 'string' ? vrm.specVersion.slice(0, 32) : hasV0 ? '0.x' : '1.x',
    extension,
    humanoidBoneCount: boneNames.size,
    humanoidBones: [...boneNames].sort(),
    expressions: [...new Set(expressionNames)].sort(),
    canonicalExpressions: [...new Set(expressionNames.map((name) => canonicalExpressionName(name)))].sort(),
    nodeCount: lists.nodes.length,
    meshCount: lists.meshes.length,
    textureCount: lists.textures.length,
    imageCount: lists.images.length,
    imageDimensions,
    totalImagePixels,
    meta: safeMeta(vrm.meta),
  };
}

/** Copy into public/assets and atomically upsert assets.lock.json by assetId. */
export async function importVrm(sourcePath, projectRoot, assetId = 'avatar') {
  if (typeof assetId !== 'string' || !IDENTIFIER.test(assetId)) throw new Error('Invalid assetId');
  const sourceInfo = await stat(sourcePath);
  if (!sourceInfo.isFile() || sourceInfo.size > MAX_VRM_BYTES) throw new Error('Source must be a file no larger than 64 MiB');
  const bytes = await readFile(sourcePath);
  const summary = inspectVrm(bytes);
  const hash = sha256(bytes);
  const entry = { sha256: hash, file: `assets/${hash}.vrm`, bytes: bytes.length, summary };
  const root = path.resolve(projectRoot);
  await mkdir(path.join(root, 'public', 'assets'), { recursive: true });
  const mutexPath = path.join(root, '.assets-import.lock');
  let mutex;
  try { mutex = await open(mutexPath, 'wx'); }
  catch (error) {
    if (error.code === 'EEXIST') throw new Error('Another import is active (.assets-import.lock exists); retry after it finishes, or inspect a stale lock');
    throw error;
  }
  const lockPath = path.join(root, 'assets.lock.json');
  let temporary;
  try {
    let lock = { schema: ASSET_SCHEMA, assets: {} };
    try {
      const lockInfo = await stat(lockPath);
      if (lockInfo.size > 8 * 1024 * 1024) throw new Error('Asset lock exceeds 8 MiB');
      lock = JSON.parse(await readFile(lockPath, 'utf8'));
      if (lock.schema !== ASSET_SCHEMA || !isObject(lock.assets)) throw new Error('Invalid existing asset lock');
    } catch (error) { if (error.code !== 'ENOENT') throw error; }
    const destination = path.join(root, 'public', entry.file);
    try { await writeFile(destination, bytes, { flag: 'wx' }); }
    catch (error) {
      if (error.code !== 'EEXIST') throw error;
      const existingInfo = await stat(destination);
      if (existingInfo.size !== bytes.length || sha256(await readFile(destination)) !== hash) {
        throw new Error('Existing content-addressed asset does not match its hash');
      }
    }
    const entries = { ...lock.assets, [assetId]: entry };
    lock = { schema: ASSET_SCHEMA, assets: Object.fromEntries(Object.keys(entries).sort().map((key) => [key, entries[key]])) };
    temporary = `${lockPath}.${process.pid}.${randomUUID()}.tmp`;
    await writeFile(temporary, JSON.stringify(lock, null, 2) + '\n', { flag: 'wx' });
    await rename(temporary, lockPath);
    temporary = undefined;
    return entry;
  } finally {
    if (temporary) await rm(temporary, { force: true });
    await mutex.close();
    await rm(mutexPath, { force: true });
  }
}
