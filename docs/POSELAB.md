# PoseLab motion input

The importer accepts PoseLab's already normalized animation JSON, with explicit humanoid quaternion tracks. It samples Three.js quaternion interpolants at fixed frame times, strips absolute hips translation for in-place playback, and saves a `.sequence.json` plus a `.sequence.source.json` provenance file. It does not synthesize body motion.

Run the one-command local setup from the [README](../README.md), or import a clip separately:

```bash
npm run import:motion -- /path/to/clip-animation.json out/my-clip.sequence.json --source-vrm 0 --fps 30
```

`--source-vrm` is mandatory because historical bank JSON has no source avatar convention. Use `0` for VRM 0 normalized playback or `1` for VRM 1. The output sequence is converted to the engine's canonical VRM 1 axes and later adapted to the target avatar. The option does not grant asset rights or infer them from file metadata.

To inspect a local PoseLab checkout's declared bank, run `npm run motions -- /path/to/poselabstudio`. Some catalog entries may have only FBX sources and are unsupported by this JSON importer. The complete `.pose` scene/Director importer, FBX conversion, and root movement remain future work.

Looping uses the same crossfade as PoseLab's `animationManager`, not a seek back to frame 0. A `sequence` with `"loop": true` plays through, then spends `loopFade` seconds (default 0.3, the mixer's fade-in) blending the end of the clip into a copy that has already started at the beginning. The two clips are still sampled with no time warp. The blend weight is a smoothstep, so it is flat at both ends of the fade instead of a linear ramp. A one-shot that hands off to idle uses 0.5 seconds, matching PoseLab's fade into `idle-neutral`. The pose at a time depends only on that time, so a Remotion seek across the seam matches sequential playback. Omit `loop` and the clip still holds its last key.

PoseLab ships two different idles. **Neutral Idle** (`assets/poselab/idle-neutral-animation.json`, about 8.1s) is the calm loop: the body stays under about 1.5° per frame. **Happy Idle** (about 2.93s) is the energetic one: around 0.5–1.0s the head moves about 4.9°/frame, the hips about 3°/frame, and the left arm about 19°/frame, then that swing returns every loop. Script Studio's music-cut idle is Neutral Idle (`idleClip: "neutral"`, the default). It is sampled with the same importer as any other bank clip. `sourceVrm` follows setup (`0` or `1`). `idleClip: "imported"` uses the idle file from setup instead. `idleCalm` (default true) then eases steps above 2° on a log curve, so a pop shrinks without a run of identical 2° frames. `idleCalm: false` keeps that imported clip untouched. Neither path changes the gesture that plays before idle, or groove nods.

PoseLab’s Face AR stack (MediaPipe Face Landmarker, ARKit-style blendshapes, a LAN companion) is not an input to this engine. Narrative Engine does not record or retarget a face take. Blink, saccade, breath, and section mood in [Reactive motion](REACTIVE-MOTION.md) are procedural layers on the VRM presets already in the file (`blink`, `blink_l` / `blink_r`, `joy` / `fun`, vowels). They are not a stand-in for ARKit brows, cheeks, or a recorded viseme track. A rig without those extra shapes cannot grow them here.
