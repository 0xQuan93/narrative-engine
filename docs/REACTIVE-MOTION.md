# Reactive motion

Script Studio can keep playing one PoseLab gesture and then the idle loop, and layer a second performance on top: where the head looks, how the body accents a line, and how the mouth hits a caption. The PoseLab clip stays the base. Existing episodes that omit the block render exactly as before.

## What the pipeline already did

- **Body:** PoseLab normalized JSON is sampled into per-frame humanoid keys. Script Studio plays the gesture once, then loops idle. `evaluatePose` slerps those keys. The stage resets the VRM and calls `humanoid.setNormalizedPose` for that frame only.
- **Mouth:** spelling rules in `src/dialogue.mjs` pick `aa` / `ih` / `ou` / `ee` / `oh` and ramp the weight inside each cue. There is no audio file and no phoneme aligner.
- **Camera:** cuts, medium, close, directed (creep, push, release, handheld, depth), and storyboard. None of that moved the body.
- **Not running during a frame:** `@pixiv/three-vrm` look-at, expression look presets, and spring bones. Spring bones are left at the imported rest on purpose. Their solver keeps the previous tail position, and Remotion may draw frames out of order.

## Approach

Reactive state is a pure function of the frame, the clip pose, the camera, and the dialogue track (`src/reactive-motion.mjs`). The same frame always returns the same pose and expression weights. Preview and the silent MP4 both consume that result through the existing three-vrm humanoid and expression manager.

This is a small CCD aim for the right arm, not three-vrm's look-at applier and not a physics spring:

- three-vrm 3.5 does not ship a CCD or FABRIK solver. `VRMLookAt` can aim eyes, but only after a VRM is loaded, and a bone applier would add a second rotation on top of these offsets. Tests and CI have no avatar file, so the pose has to be knowable without one.
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

- **Look.** Yaw and pitch, clamped, are shared across spine, chest, upper chest, neck, and head and added to the clip. `lookLeft` / `lookRight` / `lookUp` / `lookDown` expression weights follow the same angles. Eye bones are not given an extra offset, so a rig that also has those blendshapes does not look twice. Eye bones still inherit the head turn.
- **Aim.** On `point` beats, a 12-step CCD solve aims a canonical right arm (rest direction `-X`, lengths 0.27 and 0.24) toward the camera and blends that pose with the clip by `arm`. The clip rotation is the other end of the blend, so the gesture is not replaced outright. The left arm gets a small counter roll.
- **Mouth and face.** With `expression` above 0, vowel cues ease toward a sine peak, neighboring cues bleed across gaps of at most three frames, and sentence ends blink. Nods add `happy`, points and camera punches add `surprised`, leans add `relaxed`. Weights stay in 0–1 and add to any authored track. Camera punch uses the change in distance and field of view from the previous frame of the same shot, plus handheld strength. Caption onsets are the speech cue. `intensityCues` can stand in for an external audio aligner.

Optional presets the avatar does not define are skipped (`happy`, `blink`, `lookLeft`, and the other names listed in `OPTIONAL_REACTIVE_EXPRESSIONS`). Mouth shapes required by the script, and any expression named in an authored track, still have to exist on the VRM.

## Limits

- No waveform, microphone, or cloud model is read at render time. Timing comes from the script estimator, camera keys, and any cues you write into the episode.
- Spring bones, hair, and cloth do not simulate. They stay at the imported rest so frames remain seekable.
- The arm solve does not measure the loaded skeleton. Extreme A-poses will not put the wrist on a prop; the result is a normalized aim offset, not a contact.
- Look uses a fixed head height, not a skinned head bone, and it does not read a VRM look-at range map.
- VRM 0 quaternions are still flipped by `poseForVrm` at draw time. Author offsets in the VRM 1 convention the rest of the episode uses.
- Reactivity does not change caption text, camera cuts, or the PoseLab hip track.
