/**
 * Seek-safe spring replay. Each frame resets the solver and integrates only
 * the previous `windowFrames` poses, so the result depends on (episode, frame)
 * and not on which frame rendered last.
 *
 * Resetting onto the first pose of a short window kicks low-drag strands
 * sideways; that ring is still visible 24 frames later. `settleFrames` holds
 * the window-start pose and integrates until that kick dies, then the real
 * window runs. Settle is a pure function of the options, not of the last render.
 */

/** Hold the window-start pose this many steps before the visible window. */
export const SPRING_SETTLE_FRAMES = 24;

/**
 * Safer response for music nods. Low-drag VRM strands keep a nod's inertia and
 * stay lifted; these raise drag, gravity, and stiffness, then cap how far a
 * joint may rotate from the bind pose. Omit a field to use the default.
 * Set springGravity to 1, springDrag to 0, springStiffness to 1,
 * springMaxDegrees to 90, and springMaxStepDegrees to 45 to keep the
 * avatar's authored spring settings.
 */
export const SPRING_GRAVITY = 2.8;
export const SPRING_GRAVITY_FLOOR = 1.4;
export const SPRING_DRAG = 0.82;
export const SPRING_STIFFNESS = 1.6;
export const SPRING_STIFFNESS_FLOOR = 0.4;
export const SPRING_MAX_DEGREES = 12;
/** Front fringe stays on a tighter cone so the anti-lift boost is not what covers the eyes. */
export const SPRING_FRINGE_MAX_DEGREES = 8;
/** Per simulation step. Stops a nod from whipping a thin strand sideways. */
export const SPRING_MAX_STEP_DEGREES = 8;

const FRINGE_NAME = /bang|fringe|前髪|maegami|front[_ -]?hair|hair[_ -]?front/i;

/** Front hair, by joint name or a bind tail that sits in front of the head and above the eyes. */
export function isFringeSpringJoint(joint) {
  const name = joint?.bone?.name ?? '';
  if (FRINGE_NAME.test(name)) return true;
  const tail = joint?.child?.position ?? joint?.initialLocalChildPosition;
  if (!tail) return false;
  return tail.z > 0.03 && tail.y > -0.06 && Math.abs(tail.x) < 0.15;
}

const tunedManagers = new WeakSet();

/** Apply the spring response once. A second call does not compound. */
export function tuneSpringManager(manager, options = {}) {
  if (!manager || tunedManagers.has(manager)) return;
  tunedManagers.add(manager);
  const gravity = options.springGravity ?? SPRING_GRAVITY;
  const drag = options.springDrag ?? SPRING_DRAG;
  const stiffness = options.springStiffness ?? SPRING_STIFFNESS;
  const raiseGravity = options.springGravity == null;
  const raiseStiffness = options.springStiffness == null;
  for (const joint of manager.joints ?? []) {
    const settings = joint.settings;
    if (!settings) continue;
    const fringe = isFringeSpringJoint(joint);
    if (fringe && joint.bone) {
      joint.bone.userData ??= {};
      joint.bone.userData.narrativeFringe = true;
    }
    const scale = fringe && raiseGravity ? 1 : gravity;
    const powered = (settings.gravityPower ?? 0) * scale;
    settings.gravityPower = raiseGravity && !fringe ? Math.max(powered, SPRING_GRAVITY_FLOOR) : powered;
    settings.dragForce = Math.min(0.95, Math.max(settings.dragForce ?? 0, drag));
    const stiff = (settings.stiffness ?? 0) * stiffness;
    settings.stiffness = raiseStiffness ? Math.max(stiff, SPRING_STIFFNESS_FLOOR) : stiff;
  }
}

function captureRest(managers) {
  for (const manager of managers) {
    for (const joint of manager.joints ?? []) {
      const bone = joint.bone;
      if (!bone?.quaternion) continue;
      bone.userData ??= {};
      const q = bone.quaternion;
      bone.userData.narrativeSpringRest = [q.x, q.y, q.z, q.w];
      bone.userData.narrativeSpringPrev = [q.x, q.y, q.z, q.w];
    }
  }
}

function slerpComponents(from, to, t) {
  let dot = from[0] * to[0] + from[1] * to[1] + from[2] * to[2] + from[3] * to[3];
  let tx = to[0];
  let ty = to[1];
  let tz = to[2];
  let tw = to[3];
  if (dot < 0) {
    dot = -dot;
    tx = -tx;
    ty = -ty;
    tz = -tz;
    tw = -tw;
  }
  if (dot > 0.9995) {
    const x = from[0] + t * (tx - from[0]);
    const y = from[1] + t * (ty - from[1]);
    const z = from[2] + t * (tz - from[2]);
    const w = from[3] + t * (tw - from[3]);
    const length = Math.hypot(x, y, z, w) || 1;
    return [x / length, y / length, z / length, w / length];
  }
  const theta = Math.acos(Math.min(1, dot));
  const scale = Math.sin(theta);
  const fromWeight = Math.sin((1 - t) * theta) / scale;
  const toWeight = Math.sin(t * theta) / scale;
  return [
    from[0] * fromWeight + tx * toWeight,
    from[1] * fromWeight + ty * toWeight,
    from[2] * fromWeight + tz * toWeight,
    from[3] * fromWeight + tw * toWeight,
  ];
}

function quatAngle(from, to) {
  const dot = Math.abs(from[0] * to[0] + from[1] * to[1] + from[2] * to[2] + from[3] * to[3]);
  return 2 * Math.acos(Math.min(1, dot));
}

/** Keep the verlet tails on the clamped bone so the next step does not undo it. */
function plantSpringJoint(joint) {
  const bone = joint.bone;
  if (!bone || !joint._currentTail || !joint._initialLocalChildPosition || typeof joint._getMatrixWorldToCenter !== 'function') return;
  bone.updateMatrix();
  if (bone.parent) bone.matrixWorld.multiplyMatrices(bone.parent.matrixWorld, bone.matrix);
  else bone.matrixWorld.copy(bone.matrix);
  bone.localToWorld(joint._currentTail.copy(joint._initialLocalChildPosition)).applyMatrix4(joint._getMatrixWorldToCenter());
  joint._prevTail?.copy(joint._currentTail);
}

function pullQuaternion(bone, toward, maxRadians) {
  const q = bone.quaternion;
  const current = [q.x, q.y, q.z, q.w];
  const angle = quatAngle(toward, current);
  if (angle <= maxRadians + 1e-4) return false;
  const next = slerpComponents(toward, current, maxRadians / angle);
  q.set(next[0], next[1], next[2], next[3]);
  return true;
}

/** Pull each joint back toward the rotation it had just after reset(). */
export function clampSpringDisplacement(managers, maxRadians, fringeRadians = undefined) {
  if (!Number.isFinite(maxRadians) || maxRadians < 0) return;
  for (const manager of managers) {
    for (const joint of manager.joints ?? []) {
      const bone = joint.bone;
      const rest = bone?.userData?.narrativeSpringRest;
      if (!rest || !bone.quaternion) continue;
      const cap = bone.userData?.narrativeFringe && Number.isFinite(fringeRadians)
        ? Math.min(maxRadians, fringeRadians)
        : maxRadians;
      if (pullQuaternion(bone, rest, cap)) plantSpringJoint(joint);
    }
  }
}

function clampSpringStep(managers, maxStepRadians) {
  if (!Number.isFinite(maxStepRadians) || maxStepRadians < 0) return;
  for (const manager of managers) {
    for (const joint of manager.joints ?? []) {
      const bone = joint.bone;
      const prev = bone?.userData?.narrativeSpringPrev;
      if (!prev || !bone.quaternion) continue;
      if (pullQuaternion(bone, prev, maxStepRadians)) plantSpringJoint(joint);
      const q = bone.quaternion;
      bone.userData.narrativeSpringPrev = [q.x, q.y, q.z, q.w];
    }
  }
}

function constrainSprings(managers, maxRadians, maxStepRadians, fringeRadians) {
  if (Number.isFinite(maxStepRadians)) clampSpringStep(managers, maxStepRadians);
  if (Number.isFinite(maxRadians)) clampSpringDisplacement(managers, maxRadians, fringeRadians);
  if (Number.isFinite(maxStepRadians)) {
    for (const manager of managers) {
      for (const joint of manager.joints ?? []) {
        const bone = joint.bone;
        if (!bone?.quaternion) continue;
        const q = bone.quaternion;
        bone.userData.narrativeSpringPrev = [q.x, q.y, q.z, q.w];
      }
    }
  }
}

export function replaySprings(managers, frame, windowFrames, delta, applyFrame, {
  settleFrames = SPRING_SETTLE_FRAMES, maxRadians, maxStepRadians, fringeRadians,
} = {}) {
  const start = Math.max(0, frame - windowFrames + 1);
  const settle = Math.max(0, settleFrames);
  const limited = Number.isFinite(maxRadians) || Number.isFinite(maxStepRadians);
  // reset() samples the current parent matrices. Callers restore the bind pose first.
  for (const manager of managers) manager.reset();
  if (limited) captureRest(managers);
  const integrate = () => {
    for (const manager of managers) manager.update(delta);
    if (limited) constrainSprings(managers, maxRadians, maxStepRadians, fringeRadians);
  };
  if (settle > 0) {
    applyFrame(start);
    for (let step = 0; step < settle; step += 1) integrate();
  }
  for (let cursor = start; cursor <= frame; cursor += 1) {
    applyFrame(cursor);
    integrate();
  }
}
