// Episode rotations use the VRM1 (+Z forward) convention. VRM0 normalized
// skeletons retain the older axes even after rotateVRM0 turns the visible root.
// Match three-vrm-animation's VRM0 quaternion/translation convention conversion.
export function axesForVrm(vector, metaVersion) {
  return vector.map((value, index) => metaVersion === '0' && index !== 1 ? -value : value);
}

export function poseForVrm(pose, metaVersion) {
  return Object.fromEntries(Object.entries(pose).map(([bone, transform]) => {
    const result = {};
    if (transform.rotation) result.rotation = transform.rotation.map((v, i) => metaVersion === '0' && i % 2 === 0 ? -v : v);
    if (transform.position) {
      if (bone !== 'hips' && transform.position.some((v) => v !== 0)) {
        throw new Error(`Rendering supports translation on hips only; ${bone} has a nonzero position`);
      }
      result.position = transform.position.map((v, i) => metaVersion === '0' && i !== 1 ? -v : v);
    }
    return [bone, result];
  }));
}
