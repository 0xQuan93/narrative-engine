/**
 * Shared VRM 0 ↔ VRM 1 expression names.
 *
 * three-vrm renames file presets on load (joy → happy, a → aa) and leaves
 * unmapped groups under their blendshape name, so a custom "Surprised" stays
 * "Surprised". Resolve and inspect both go through this table.
 */

export const VRM0_EXPRESSION_ALIASES = Object.freeze({
  a: 'aa',
  i: 'ih',
  u: 'ou',
  e: 'ee',
  o: 'oh',
  joy: 'happy',
  angry: 'angry',
  sorrow: 'sad',
  fun: 'relaxed',
  blink: 'blink',
  lookup: 'lookUp',
  lookdown: 'lookDown',
  lookleft: 'lookLeft',
  lookright: 'lookRight',
  blink_l: 'blinkLeft',
  blink_r: 'blinkRight',
  neutral: 'neutral',
  surprised: 'surprised',
});

const VRM1_TO_VRM0 = Object.freeze(Object.fromEntries(
  Object.entries(VRM0_EXPRESSION_ALIASES).filter(([vrm0, vrm1]) => vrm0 !== vrm1).map(([vrm0, vrm1]) => [vrm1, vrm0]),
));

const VRM1_BY_LOWER = new Map(Object.values(VRM0_EXPRESSION_ALIASES).map((name) => [name.toLowerCase(), name]));

/** Logical VRM 1 preset, or the original string for an unknown custom name. */
export function canonicalExpressionName(name) {
  if (typeof name !== 'string' || !name) return name;
  const key = name.toLowerCase();
  if (Object.hasOwn(VRM0_EXPRESSION_ALIASES, key)) return VRM0_EXPRESSION_ALIASES[key];
  return VRM1_BY_LOWER.get(key) ?? name;
}

function pushUnique(list, name) {
  if (typeof name === 'string' && name.length && !list.includes(name)) list.push(name);
}

/** Exact, case, and VRM 0/1 spellings to try, most specific first. */
export function expressionLookupNames(name) {
  const canonical = canonicalExpressionName(name);
  const vrm0 = VRM1_TO_VRM0[canonical];
  const names = [];
  for (const seed of [name, canonical, vrm0]) {
    if (typeof seed !== 'string' || !seed) continue;
    pushUnique(names, seed);
    pushUnique(names, seed.toLowerCase());
    pushUnique(names, seed.charAt(0).toUpperCase() + seed.slice(1));
  }
  return names;
}

/** First spelling `hasExpression` accepts, or null. */
export function resolveExpressionName(name, hasExpression) {
  for (const candidate of expressionLookupNames(name)) {
    if (hasExpression(candidate)) return candidate;
  }
  return null;
}
