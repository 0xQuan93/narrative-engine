# PoseLab motion input

The importer accepts PoseLab's already normalized animation JSON, with explicit humanoid quaternion tracks. It samples Three.js quaternion interpolants at fixed frame times, strips absolute hips translation for in-place playback, and saves a `.sequence.json` plus a `.sequence.source.json` provenance file. It does not synthesize body motion.

Run the one-command local setup from the [README](../README.md), or import a clip separately:

```bash
npm run import:motion -- /path/to/clip-animation.json out/my-clip.sequence.json --source-vrm 0 --fps 30
```

`--source-vrm` is mandatory because historical bank JSON has no source avatar convention. Use `0` for VRM 0 normalized playback or `1` for VRM 1. The output sequence is converted to the engine's canonical VRM 1 axes and later adapted to the target avatar. The option does not grant asset rights or infer them from file metadata.

To inspect a local PoseLab checkout's declared bank, run `npm run motions -- /path/to/poselabstudio`. Some catalog entries may have only FBX sources and are unsupported by this JSON importer. The complete `.pose` scene/Director importer, FBX conversion, and root movement remain future work.

Looping uses the same crossfade as PoseLab's `animationManager`, not a seek back to frame 0. A `sequence` with `"loop": true` plays through, then spends `loopFade` seconds (default 0.3, the mixer's fade-in) blending the end of the clip into a copy that has already started at the beginning. The blend is a linear weight with no time warp, matching `crossFadeTo(..., false)`. A one-shot that hands off to idle uses 0.5 seconds, matching PoseLab's fade into `idle-neutral`. The pose at a time depends only on that time, so a Remotion seek across the seam matches sequential playback. Omit `loop` and the clip still holds its last key.

PoseLab's calm loop is Neutral Idle (`idle-neutral-animation.json`, about 8.1s). On that clip the body stays under about 1.5° per frame. Happy Idle (`idle-happy-animation.json`, about 2.93s) is a different performance: around 0.5–1.0s the head moves about 4.9°/frame, the hips about 3°/frame, and the left arm about 19°/frame, then the same swing returns every loop. Script Studio's idle bake follows the Neutral Idle rate. It limits each bone to 2°/frame with one forward pass over the clip (`idleCalm`, default true). A clip that is already under that step is left as authored. `idleCalm: false` keeps the energetic swing. The pass is not a groove change and does not run on the gesture that plays before idle.

PoseLab’s Face AR stack (MediaPipe Face Landmarker, ARKit-style blendshapes, a LAN companion) is not an input to this engine. Narrative Engine does not record or retarget a face take. Blink, saccade, breath, and section mood in [Reactive motion](REACTIVE-MOTION.md) are procedural layers on the VRM presets already in the file (`blink`, `blink_l` / `blink_r`, `joy` / `fun`, vowels). They are not a stand-in for ARKit brows, cheeks, or a recorded viseme track. A rig without those extra shapes cannot grow them here.
