# Reactive motion

Script Studio can keep playing one PoseLab gesture and then the idle loop, and layer a second performance on top: where the head looks, how the body accents a line, and how the mouth hits a caption. The PoseLab clip stays the base. Existing episodes that omit the block render exactly as before.

## What the pipeline already did

- **Body:** PoseLab normalized JSON is sampled into per-frame humanoid keys. Script Studio plays the gesture once, then loops idle. `evaluatePose` slerps those keys. The stage resets the VRM and calls `humanoid.setNormalizedPose` for that frame only.
- **Mouth:** spelling rules in `src/dialogue.mjs` pick `aa` / `ih` / `ou` / `ee` / `oh` and ramp the weight inside each cue. There is no audio file and no phoneme aligner.
- **Camera:** cuts, medium, close, directed (creep, push, release, handheld, depth), and storyboard. None of that moved the body.
- **Not running during a frame:** `vrm.lookAt.update()`, expression look presets as a second pass, and spring bones. Bone look-at eyes are written from the loaded range map inside the stage, once per frame. Spring bones stay at the imported rest on purpose. Their solver keeps the previous tail position, and Remotion may draw frames out of order.

## Approach

Reactive state is a pure function of the frame, the clip pose, the camera, and the dialogue track (`src/reactive-motion.mjs`). The same frame always returns the same pose and expression weights. Preview and the silent MP4 both consume that result through the existing three-vrm humanoid and expression manager.

This is a small CCD aim for the right arm, plus a draw-time eye pass, not a physics spring:

- three-vrm 3.5 does not ship a CCD or FABRIK solver. `VRMLookAt` can aim eyes, but only after a VRM is loaded, and calling `lookAt.update()` would fight the head offsets and depend on a target object. The evaluator stays avatar-free. When the loaded applier type is `bone`, the stage copies that applier's range map onto `leftEye` / `rightEye` and lets `humanoid.update()` transfer them. Tests and CI have no avatar file, so the pose and the default eye map have to be knowable without one.
- `VRMSpringBoneJoint` integrates from the previous tail. Calling it would make a frame depend on which frame ran last. Resimulating from frame 0 on every seek would still be avatar-specific and would not match the episode state under test.

No new dependency is added. Remotion stays under its own license, as the readme already says.

## Script Studio

In Performance, **Reactivity** defaults to **Still · gesture and idle**. That writes no `reactivity` block.

- **Subtle** looks toward the camera, with light nods and a little arm follow-through.
- **Lively** uses a stronger look, beat accents, and mouth tightening.
- **Amount** scales the preset from 0 to 100%.

A directed take adds a `point` beat when the camera pushes in. Wave-then-idle delays arm aim until the gesture clip has finished, so the point does not fight the wave. The head can still nod during the wave.

Apply to preview, then render, the same way as any other take.

## Episode JSON

Put `reactivity` on a performance. Omit it, or leave it off the Script Studio preset, and the clip is unchanged.

```json
{
  "actorId": "performer",
  "sequence": { "duration": 4, "keyframes": [{ "time": 0, "pose": {} }, { "time": 4, "pose": {} }] },
  "reactivity": {
    "look": "camera",
    "head": 0.7,
    "torso": 0.35,
    "arm": 0.55,
    "expression": 0.6,
    "autoBeats": true,
    "armDelayFrames": 0,
    "beats": [{ "frame": 40, "kind": "point", "strength": 0.8, "duration": 14 }],
    "intensityCues": [{ "frame": 48, "intensity": 1, "duration": 8 }]
  }
}
```

| Field | Meaning |
| --- | --- |
| `look` | `off`, `camera` (the lens), or `interest` (a world point, required as `interest: [x, y, z]`). |
| `head`, `torso`, `arm`, `expression` | 0–1 gains. Defaults when omitted: 0.7, 0.35, 0.55, 0.6. |
| `autoBeats` | Default true. Sentence starts nod, `?` leans, `!` points. Set false to keep only `beats`. |
| `beats` | Shot-local absolute frames. `kind` is `nod`, `point`, or `lean`. Optional `strength` (0–1, default 1) and `duration` (2–48 frames, default 12). |
| `armDelayFrames` | Absolute frame before which arm aim stays off. Script Studio sets this to the end of the gesture clip. |
| `intensityCues` | Optional energy marks, for beats you aligned outside this tool. There is still no audio decoder. |

`look: "interest"` uses the same coordinates as the camera (`+Y` up, `+Z` toward the lens). The head anchor is about `[actorX, 1.5, 0.02]`. Side-by-side actors are `1.7` apart, matching the stage.

Evaluated actors gain a `motion` summary (`intensity`, `lookYaw`, `lookPitch`, `beat`) only when the block is present. It is not a second animation clip.

## What the layer drives

- **Look.** Yaw and pitch, clamped, are shared across spine, chest, upper chest, neck, and head. Head and neck take a smaller share than the torso chain, and that share is capped, so a nod or a PoseLab head key does not stack on top of the look. While the look is active the clip's head and neck rotations fade toward rest before the look offset is applied. `lookLeft` / `lookRight` / `lookUp` / `lookDown` weights are still written for expression look-at. On a bone look-at avatar the stage ignores those weights and writes `leftEye` / `rightEye` from the file's range map (`lookYaw` / `lookPitch` in radians, positive yaw toward +X, positive pitch looking down). `vrm.lookAt.update()` is not called.
- **Aim.** On `point` beats the aim direction is chest-local: torso yaw already used for the look is removed, the direction is lifted slightly, then clamped to a 32° cone around +Z so a wide lens does not swing the hand to the floor or out to the side. A 12-step CCD solves a canonical right arm (rest `-X`, lengths 0.27 and 0.24) for tests and for the evaluated pose. At draw time the stage measures `rightLowerArm` and `rightHand` rest offsets and solves again, then blends onto the clip. Lively's arm gain arrives in that cone. Subtle stays a small blend. The left arm gets a small counter roll. Preset numbers are unchanged.
- **Mouth and face.** With `expression` above 0, vowel cues ease toward a sine peak, neighboring cues bleed across gaps of at most three frames, and sentence ends blink. Nods add `happy`, points and camera punches add `surprised`, leans add `relaxed`. Weights stay in 0–1 and add to any authored track. Camera punch uses the change in distance and field of view from the previous frame of the same shot, plus handheld strength. Caption onsets are the speech cue. `intensityCues` can stand in for an external audio aligner.

Optional presets the avatar does not define are skipped (`happy`, `blink`, `lookLeft`, and the other names in `OPTIONAL_REACTIVE_EXPRESSIONS`). Names are matched case-insensitively, and VRM 0 file presets alias to VRM 1 (`joy`/`happy`, `fun`/`relaxed`, `sorrow`/`sad`, `a`/`aa`, and the rest of the table in `src/expression-names.mjs`). A custom `Surprised` group matches `surprised`. `inspectVrm` keeps the file spellings on `expressions` and adds `canonicalExpressions` from the same table. Mouth shapes required by the script, and any expression named in an authored track, still have to exist after that lookup.

Evaluated `motion` also includes `aim` while a point is active: `direction` (unit vector, stage space), `weight`, and the clip arm quaternions the stage blends from. Episode JSON does not gain a field.

## Limits

- No waveform, microphone, or cloud model is read at render time. Timing comes from the script estimator, camera keys, and any cues you write into the episode.
- Spring bones, hair, and cloth do not simulate. They stay at the imported rest so frames remain seekable.
- The evaluated arm solve uses canonical lengths. The stage re-solves from the loaded rest offsets, still as a normalized aim, not a contact with a prop.
- Look uses a fixed head height, not a skinned head bone. Bone look-at range maps are read at draw time. Expression look-at uses the blendshape weights above.
- VRM 0 quaternions and aim directions are flipped with `poseForVrm` / `axesForVrm` at draw time. Author offsets in the VRM 1 convention the rest of the episode uses.
- Reactivity does not change caption text, camera cuts, or the PoseLab hip track.

## Check a Lively take locally

Setup stays on this machine. Nothing is uploaded.

```bash
npm run setup -- \
  --vrm /path/to/your-avatar.vrm \
  --wave /path/to/your-wave-animation.json \
  --idle /path/to/your-idle-animation.json \
  --source-vrm 0
npm run gui
```

In Performance, set Reactivity to **Lively** and Amount to 100%. Use a short line that nods, leans, and points, for example `Wait. Is that it? Look!`, with Cuts or a wide camera. Apply to preview, then render.

To render a saved episode from the CLI:

```bash
npm run render -- --episode out/studio/your-episode.json --out out/lively-test.mp4 --frames 0-89
```

On a VRM 0 file, a wide point should bring the right hand forward toward the lens, a custom `Surprised` shape should move on `!` and on camera punches, and bone look-at eyes should follow the lens. Head nods still play, and they no longer add on top of an active look. Spring bones stay at rest. The default Still preset still writes no `reactivity` block.
