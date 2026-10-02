# PoseLab motion input

The importer accepts PoseLab's already normalized animation JSON, with explicit humanoid quaternion tracks. It samples Three.js quaternion interpolants at fixed frame times, strips absolute hips translation for in-place playback, and saves a `.sequence.json` plus a `.sequence.source.json` provenance file. It does not synthesize body motion.

Run the one-command local setup from the [README](../README.md), or import a clip separately:

```bash
npm run import:motion -- /path/to/clip-animation.json out/my-clip.sequence.json --source-vrm 0 --fps 30
```

`--source-vrm` is mandatory because historical bank JSON has no source avatar convention. Use `0` for VRM 0 normalized playback or `1` for VRM 1. The output sequence is converted to the engine's canonical VRM 1 axes and later adapted to the target avatar. The option does not grant asset rights or infer them from file metadata.

To inspect a local PoseLab checkout's declared bank, run `npm run motions -- /path/to/poselabstudio`. Some catalog entries may have only FBX sources and are unsupported by this JSON importer. The complete `.pose` scene/Director importer, FBX conversion, root movement, and clip blending remain future work.
