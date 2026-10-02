# Narrative Engine Community

**Developer preview.** A local pipeline for silent VRM scenes: import normalized PoseLab motion JSON, write a script in Script Studio, preview it, and render an MP4 with SRT/VTT captions. Episodes are frame-addressed JSON recipes; the renderer uses Three.js, `@pixiv/three-vrm`, and Remotion.

This export contains source, synthetic test fixtures, and one open-license font. It contains **no personal avatar, motion pack, story, pilot, social post, render, or asset lock**. You are responsible for confirming the rights to use each VRM and motion clip you supply. Local imports and renders are ignored by Git.

## Requirements

- Node.js 22 or newer and npm.
- A local Chromium executable for preview and rendering. The renderer defaults to `/usr/bin/chromium`; set `NARRATIVE_BROWSER` to another absolute executable path. The automated tests do not launch Chromium.
- A structurally valid, embedded-texture humanoid VRM 0 or VRM 1 file with standard mouth presets (`a/i/u/e/o` for VRM 0, `aa/ih/ou/ee/oh` for VRM 1). The GUI needs these for text-driven mouth cues. Import preflight is not a full visual compatibility check.
- Two PoseLab **normalized animation JSON** clips: one gesture and one idle. The importer does not accept FBX, raw Mixamo tracks, or a complete `.pose` project. Use clips and models with appropriate rights.

## First run

```bash
npm ci
npm test
npm run test:gui
npm run setup -- \
  --vrm /path/to/your-avatar.vrm \
  --wave /path/to/your-wave-animation.json \
  --idle /path/to/your-idle-animation.json \
  --source-vrm 0
npm run gui
```

Open <http://127.0.0.1:18994/>. The setup command validates and imports the avatar and motion files, then writes a generic first take under `out/setup/`. `--source-vrm` describes the **motion clip's original normalized playback convention**, not the VRM version of the avatar being imported. PoseLab's older bank JSON does not record that convention; choose `0` or `1` based on how the source clip was authored. See [PoseLab input](docs/POSELAB.md).

Script Studio uses the imported gesture once, then loops the idle clip. It offers camera cuts, medium/close views, a word-cued directed take, and 2–8 section storyboards. Save a local draft, preview, or render a silent MP4 with captions. See [Script Studio](docs/SCRIPT-STUDIO.md).

Render the generated first take directly from the CLI:

```bash
npm run render -- --episode out/setup/first-take.json --out out/first-take.mp4 --verify-frames
npm run subtitles -- out/setup/first-take.json out/first-take-captions
```

The `subtitles` command writes `out/first-take-captions.srt` and `.vtt`. `npm run evaluate -- out/setup/first-take.json 0` prints the deterministic state at frame 0. To reuse or modify a take, edit a copy of the generated episode JSON, then pass it to `npm run render -- --episode ... --out ...`. `npm run studio` opens Remotion Studio after setup. Repeating the same render command verifies and reuses a matching saved artifact; `--force` renders again.

## Local files and limits

`assets.lock.json` and `public/assets/` hold your imported VRM locally. `out/setup/` holds the imported sequences, provenance, and first take. `out/studio/` holds drafts, episodes, output, receipts, and logs. These paths are ignored by Git; do not force-add them when sharing a fork. The original VRM and motion sources are not altered.

The current GUI uses one configured avatar and two configured clips; it does not yet upload arbitrary assets from the page or browse the whole PoseLab bank. Frame-based camera motion, seeded handheld motion, depth blur, captions, and approximate spelling-based vowel animation are implemented. Voice, music, sound, precise speech alignment, full PoseLab Director import, root motion, independent actor placement, and hosted rendering are outside this preview. Arbitrary rigs, especially VRM 1, still need visual acceptance. This is a local authoring tool, not a hardened public upload service.

## License and CI

Project source is [MIT licensed](LICENSE). [Third-party notices](THIRD_PARTY_NOTICES.md) cover the bundled font, PoseLab mapping attribution, and dependencies. **Remotion has separate terms**, including conditions for some commercial uses; read [Remotion's current license](https://www.remotion.dev/license) for your use. The GitHub Actions workflow runs `npm ci`, core tests, and GUI server tests without local assets or a browser. It does not claim a successful video render on its runner.
