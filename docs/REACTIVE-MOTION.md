# Reactive motion

Script Studio can keep playing one PoseLab gesture and then the idle loop, and layer a second performance on top: where the head looks, how the body accents a line, and how the mouth hits a caption. The PoseLab clip stays the base. Existing episodes that omit the block render exactly as before.

## What the pipeline already did

- **Body:** PoseLab normalized JSON is sampled into per-frame humanoid keys. Script Studio plays the gesture once, then loops idle. `evaluatePose` slerps those keys. The stage resets the VRM and calls `humanoid.setNormalizedPose` for that frame only.
- **Mouth:** spelling rules in `src/dialogue.mjs` pick `aa` / `ih` / `ou` / `ee` / `oh` and ramp the weight inside each cue. There is no audio file and no phoneme aligner.
- **Camera:** cuts, medium, close, directed (creep, push, release, handheld, depth), and storyboard. None of that moved the body.
- **Not running during a frame:** `vrm.lookAt.update()` and expression look presets as a second pass. Bone look-at eyes are written from the loaded range map inside the stage, once per frame. Spring bones stay at the imported rest unless `episode.secondary.springWindowFrames` replays a fixed window from rest. The solver keeps the previous tail position, so an open-ended step would change pixels when Remotion draws frames out of order.

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
| `beats` | Frames counted from the start of this shot. `0` is that shot's first frame, not the episode's. `kind` is `nod`, `point`, or `lean`. Optional `strength` (0–1, default 1) and `duration` (2–48 frames, default 12). A beat at 10 in a shot that starts at episode frame 90 plays at episode frame 100. |
| `armDelayFrames` | Episode-absolute frame before which arm aim stays off. Script Studio sets this to the end of the gesture clip. This one is not shot-local, because the gesture may begin before the current shot. |
| `intensityCues` | Optional energy marks on the same shot-local clock as `beats`. There is still no audio decoder. |

`look: "interest"` uses the same coordinates as the camera (`+Y` up, `+Z` toward the lens). The head anchor is about `[actorX, 1.5, 0.02]`. Side-by-side actors are `1.7` apart, matching the stage.

Evaluated actors gain a `motion` summary (`intensity`, `lookYaw`, `lookPitch`, `beat`) only when the block is present. It is not a second animation clip.

## What the layer drives

- **Look.** Yaw and pitch, clamped, are shared across spine, chest, upper chest, neck, and head. Head and neck take a smaller share than the torso chain, and that share is capped, so a nod or a PoseLab head key does not stack on top of the look. While the look is active the clip's head and neck rotations fade toward rest before the look offset is applied. `lookLeft` / `lookRight` / `lookUp` / `lookDown` weights are still written for expression look-at. On a bone look-at avatar the stage ignores those weights and writes `leftEye` / `rightEye` from the file's range map (`lookYaw` / `lookPitch` in radians, positive yaw toward +X, positive pitch looking down). `vrm.lookAt.update()` is not called.
- **Aim.** On `point` beats the aim direction is chest-local: torso yaw already used for the look is removed, the direction is lifted slightly, then clamped to a 32° cone around +Z so a wide lens does not swing the hand to the floor or out to the side. A 12-step CCD solves a canonical right arm (rest `-X`, lengths 0.27 and 0.24) to about 96% of full reach, so the elbow stays slightly soft and the hand points along the forearm. At draw time the stage measures `rightLowerArm` and `rightHand` rest offsets and solves again, then blends onto the clip. The wrist rolls to lift the thumb, the index stays nearly straight, and the other fingers curl into the palm. Bones the avatar does not have are skipped. Lively's arm gain arrives in that cone. Subtle stays a small blend. The left arm gets a small counter roll. Preset numbers are unchanged.
- **Mouth and face.** With `expression` above 0, vowel cues ease toward a sine peak, neighboring cues bleed across gaps of at most three frames, and sentence ends blink. Nods add `happy`, points and camera punches add `surprised`, leans add `relaxed`, unless `face.mood` is `sections` or `intensity` (see [Music close-ups](#music-close-ups)). Weights stay in 0–1 and add to any authored track. Camera punch uses the change in distance and field of view from the previous frame of the same shot, plus handheld strength. Caption onsets are the speech cue. `intensityCues` can stand in for an external audio aligner.

Optional presets the avatar does not define are skipped (`happy`, `blink`, `lookLeft`, and the other names in `OPTIONAL_REACTIVE_EXPRESSIONS`). Names are matched case-insensitively, and VRM 0 file presets alias to VRM 1 (`joy`/`happy`, `fun`/`relaxed`, `sorrow`/`sad`, `a`/`aa`, and the rest of the table in `src/expression-names.mjs`). A custom `Surprised` group matches `surprised`. `inspectVrm` keeps the file spellings on `expressions` and adds `canonicalExpressions` from the same table. Mouth shapes required by the script, and any expression named in an authored track, still have to exist after that lookup.

Evaluated `motion` also includes `aim` while a point is active: `direction` (unit vector, stage space), `weight`, and the clip arm quaternions the stage blends from. Episode JSON does not gain a field.

## Limits

- No waveform, microphone, or cloud model is read at render time. Timing comes from the script estimator, camera keys, cues in the episode, and an optional offline `music` block.
- Spring bones, hair, and cloth do not simulate. They stay at the imported rest so frames remain seekable.
- The evaluated arm solve uses canonical lengths. The stage re-solves from the loaded rest offsets, still as a normalized aim, not a contact with a prop.
- Look uses a fixed head height, not a skinned head bone. Bone look-at range maps are read at draw time. Expression look-at uses the blendshape weights above.
- VRM 0 quaternions and aim directions are flipped with `poseForVrm` / `axesForVrm` at draw time. Author offsets in the VRM 1 convention the rest of the episode uses.
- Reactivity does not change caption text, camera cuts, or the PoseLab hip track.

## Music close-ups

These blocks are opt-in. An episode that does not set `music`, and whose performances do not set `groove`, `eyes`, `body`, or `face`, evaluates on the path above. Script Studio does not write them yet. There is still no audio decoder inside Remotion. Analyze the track offline and store frames.

`tests/fixtures/music-groove.json` is a 6 second, 152 BPM grid (half-time nods, groove then hook) with no dialogue. `npm run evaluate -- tests/fixtures/music-groove.json 47` prints one downbeat.

### `episode.music`

Episode-absolute frames. `bpm` is required (40–300). `beats` holds up to 4096 items, strictly increasing, each with `frame` and `strength` (0–1). `downbeat` marks the “1”. `sections` holds up to 64 of `groove`, `hook`, `drop`, or `outro`, each with `energy` (0–1). Optional `intensityCues` (up to 256, duration 2–48) are episode-absolute kick marks. `offsetSeconds` records where the slice sat in the source file. The renderer does not read it.

```bash
npm run import:beats -- beats.json --episode episode.json --out episode-music.json
npm run import:beats -- song.mp3 --start 144.13 --duration 20 --fps 30 --out beats.json
```

The mp3/wav path shells out to `scripts/extract-beats.py` (HPSS, percussive onset, beat track, kick energy under 150 Hz, downbeat by kick phase, then bar RMS and onset for sections). It needs a local `python3` with `librosa` and `numpy`, and it fails with that message when they are missing. Rendering never calls it. Above about 130 BPM, set `groove.division` to `half`. At or under 100 BPM, `beat` is enough. `bar` keeps only downbeats.

### `reactivity.groove`

`{ "division": "half", "amount": 1, "phaseFrames": -1, "roll": 0.65, "seed": 1 }`. Division, amount, phase, roll, and seed can be omitted.

Nods use an asymmetric curve: the head lands on `beat + phaseFrames` (default one frame early), about 35% of the gap going down and the rest recovering, with a rebound past rest of about 14%. The neck reaches that bottom 2 frames earlier at 30 fps. The chest counters at about 20% of the head, one frame late. Shoulders take a 1° bounce. Roll alternates side each bar, from about 2° to 4° as `roll` goes from 0 to 1. On an extreme close-up, a lower `roll` (about 0.2–0.4) keeps that sway inside the frame; the default stays 0.65. Downbeats are at least strength 0.85 before a seeded ±10% jitter. While `look` is `camera` or `interest`, the head nod stays within about 8°. With look off, the cap is about 12°.

When `episode.music` has beats in the shot, those beats drive the groove and any explicit `beats` still add with the older symmetric pulse. Dialogue `autoBeats` are unchanged. With no music beats in the shot, groove reshapes nod-kind `beats` (default division `beat`, so a list you already thinned to half-time is not thinned again) and does not also play the sine. `intensityCues` scale those reshaped nods. They do not open the mouth on every hit.

### `reactivity.eyes`

`{ "blinkRate": 16, "saccade": 0.5, "seed": 1 }`. `blinkRate` is blinks per minute, 6–40. This is what makes a music cut blink. Without `eyes`, blinks still happen only at sentence-ending punctuation for the speaker.

Intervals are log-normal from `hash(seed, index)`, not a metronome. At 30 fps the lid shuts in 2–3 frames, holds one frame, and opens over 5–7. About one blink in ten is a double, 6–10 frames later. About one in five leads with `blinkLeft` or `blinkRight` by one frame (skipped when the avatar has no such preset). A scheduled blink snaps to a cut, a section boundary, or the frame after a groove landing when one of those is within 8 frames. `happy` or `relaxed` above 0.5 suppresses the blink for that frame, which is the VRM `overrideBlink` case. A hard camera punch does too.

Saccades are 2–5° steps over 2 frames, then a fixation of 0.5–2.5 s. They are added to `motion.eyeYaw` / `motion.eyePitch` for the eyes only. Head bones stay on `lookYaw` / `lookPitch`. Optional `gazeAway` cues are shot-local `{ frame, duration, yaw, pitch }` and also move only the eyes. Bone look-at avatars still pass those angles through the file’s range map, which is often only about 10° of output, so the iris travel stays small. A larger eye gain is not in this pass.

### `reactivity.body`

`{ "breath": 1, "sway": 0.8, "swayDivision": "bar", "seed": 0 }`. Breath is chest and upper-chest pitch at 0.25 Hz, about ±1.5° at `breath` 1, plus a small shoulder lift. Sway is spine and chest roll, about ±4° at `sway` 1, phase-locked so it crosses zero on downbeats (`bar`, or `2bar`). With no music beats, sway falls back to a 0.1 Hz drift. While look is on, neck and head counter-rotate so the face keeps less than half of the chest roll.

### `reactivity.face`

`{ "idleMouth": 0.03, "breathMouth": true, "mood": "sections" }`. `mood` may be `sections`, `intensity`, or `off`.

`sections` follows `music.sections`, fading over 20 frames: groove holds a low `relaxed`, hook raises `happy` to about 0.25, drop adds a `surprised` blip under 8 frames and then `happy`, outro holds `relaxed`. Weights stay under 0.5 so they do not trip blink suppression. `intensity` uses a slow attack and release on `intensityCues` instead of a spike per cue. Both modes **stop the per-nod `happy` pulse**. `mood: "off"` keeps that pulse, which is what older episodes still do.

Idle mouth writes a small `oh` / `aa` (default peak near 0.03, a little more on the exhale). Downbeats stronger than 0.8 add a short exhale, still under 0.2 combined. Nothing is added on a frame that already has a dialogue mouth cue, and nothing is added on every kick. The avatar needs an `oh` or `aa` preset (VRM 0 `o` / `a` alias). Those names are not optional: a face block on a rig without them fails at draw time, same as a script vowel the rig cannot play.

### Camera follow

`camera.follow` is opt-in on a shot. Without it the lens is unchanged.

```json
"follow": {"target": "head", "lagFrames": 4, "amount": 0.75, "margin": 0.12}
```

`target` is `head`. The evaluator estimates the head from the normalized pose (hips through head) and shifts the camera position and target by that delta, `lagFrames` earlier (0–12, default 3). Look still aims at the authored lens, so the eyes do not chase the lag. `amount` is 0–1. `margin` (0–0.5 m, default 0) pulls the camera back along the view and adds the same distance to depth-of-field focus, which is the hook extreme close-up fix when idle lean plus handheld walks the face off the frame. A starting point for that shot is lag 4, amount 0.75, margin 0.12. The shift is capped at 0.45 m. Follow does not look across a cut.

The tilt on that close-up is the idle clip and the head chain, not `groove.roll`. Set `reactivity.roll` on that shot only: `scale` (0–1) multiplies roll on hips, spine, chest, upper chest, neck, and head, and `maxDegrees` (0–30) caps what remains. Yaw and pitch, including `reactivity.head`, stay. A shot that omits `roll` keeps its full idle energy, so a medium shot beside the close-up does not change. `{ "scale": 0.25, "maxDegrees": 4 }` is a level ECU. `groove.roll` still only adds the bar-count lean.

### Hair

`episode.secondary = {"springWindowFrames": 24}` (4–48) asks the stage to reset VRM spring bones and replay that many evaluated poses ending on the current frame. Before those poses it holds the window-start pose for `springSettleFrames` steps (default 24, range 0–48) so the jump from rest does not still ring in a short window. The same frame is the same hair. Omit `secondary` and springs stay at the imported rest.

Music nods still leave thin, low-drag strands lifted after that settle, because the joint's own drag and gravity keep the nod. While `secondary` is on, each joint is tuned once: gravity is multiplied by `springGravity` (default 1.8) and raised to at least 0.35, drag is raised to `springDrag` (default 0.55), stiffness is multiplied by `springStiffness` (default 1.25) and raised to at least 0.12, and the local rotation is kept within `springMaxDegrees` of the bind pose (default 32, range 0–90). Set `springGravity` to 1, `springDrag` to 0, `springStiffness` to 1, and `springMaxDegrees` to 90 to keep the avatar's authored spring settings. An explicit gravity or stiffness value is only a multiplier; the floors apply when those fields are omitted.

`springWindowFrames` 24 with that default settle is the usual setting. If a strand still flicks, raise the window to 32–48 so more of the actual nod is inside it; settle 0 is the old rest kick. The window still forgets motion older than itself. There is no avatar in CI, so the seek test uses a synthetic joint, not a pixel render.

### Scenery

`environment` may still be `"studio"` or `"depth-studio"`. It may also be `"night-roof"`, or `{ "base": "studio" | "depth-studio" | "night-roof", "lightPulse": 0–1 }`. A shot may set `environment` the same way and override the episode for that shot only. `night-roof` is a local sky, skyline, and midground practicals placed so a 20° close-up still has lit windows beside the head instead of a black field. `lightPulse` brightens those practicals on kick beats (strength at least 0.35, decay 8 frames) and leaves them at the rest color between hits. Episodes that stay on `studio` or `depth-studio` do not add this geometry and do not recolor lights.

### Import

`extract-beats.py` labels `groove`, `hook`, `drop`, and `outro` from per-bar RMS and onset. A short slice, or one whose bars stay within about 0.06 of each other, stays one groove. A sustained rise above the earlier bars is a hook even when the whole slice is already loud (around 0.7). A drop needs both a large energy step (at least 0.25 from the previous bar) and a clear onset spike (at least 0.45). A modest rise, including one whose onset only ticks up, stays a hook, so a chorus is not a surprised blip. Rename that section in the episode if it should read as a drop. A quiet tail is an outro. `npm run import:beats` also writes `music.intensityCues` from strong kicks when the beats file does not already have them. Groove nod size already follows each beat's kick `strength`. Those cues feed `face.mood: "intensity"` when the performance has no `intensityCues` of its own. They do not add a per-kick smile on the older nod path, and they do not change a take that has no `face` block.

### Camera, for authors

This pass does not add a cut planner or a new Script Studio camera. For a music close-up, keep the lens mostly still: head-and-shoulders around 22–28° FOV for the groove, 18–22° for a few bars of the hook, and a wider frame on a drop. Cut on a downbeat, or one frame before it, at a phrase boundary (every 2–8 bars), and change angle by at least 30° between cuts. On the hook close-up, set `camera.follow` so idle lean and handheld do not walk the face out of frame. Decide the close-ups before adding moves. Depth of field, when you want it, stays on the eyes via `depth-studio`.

### What is still out of reach

PoseLab’s Face AR / ARKit companion (MediaPipe, the 52 blendshapes, a LAN recorder) lives in PoseLab, not in this importer. This pass does not read a face take, does not drive brows or asymmetric smiles, and does not replace a recorded viseme track. There is no automatic shot list, no Rhubarb mouth import, no VRMA dance clip, and no Script Studio control for these blocks. Spring history longer than the window, scenery beyond `night-roof` plus a kick pulse, eye gain past the bone range map, and a camera that leads the eyes are still out.

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
