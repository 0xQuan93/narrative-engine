// GLTF material IDs depend on asynchronous texture decoding. Keep draw ordering
// based on the completed scene's source order instead of those allocation IDs.
export function stableDrawOrder(scene) {
  const objects = new WeakMap();
  const materials = new WeakMap();
  let objectRank = 0, materialRank = 0;
  scene.traverse((object) => {
    objects.set(object, objectRank++);
    for (const material of [object.material].flat().filter(Boolean)) {
      if (!materials.has(material)) materials.set(material, materialRank++);
    }
  });
  const rank = (map, value) => {
    if (!map.has(value)) throw new Error('Scene changed after deterministic draw ranks were assigned');
    return map.get(value);
  };
  const base = (a, b) => a.groupOrder - b.groupOrder || a.renderOrder - b.renderOrder;
  const tie = (a, b) => rank(objects, a.object) - rank(objects, b.object)
    || (a.group?.start ?? 0) - (b.group?.start ?? 0);
  return {
    opaque: (a, b) => base(a, b) || rank(materials, a.material) - rank(materials, b.material)
      || (a.materialVariant ?? 0) - (b.materialVariant ?? 0) || a.z - b.z || tie(a, b),
    transparent: (a, b) => base(a, b) || b.z - a.z || tie(a, b),
  };
}
