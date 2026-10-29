# Script Studio

After `npm run setup`, start `npm run gui` and open <http://127.0.0.1:18994/>. The server binds to loopback. Set `NARRATIVE_GUI_PORT` to change the port.

Write a script, choose a reading pace and mouth strength, then choose the imported gesture plus idle or idle alone. Reactivity defaults to still, which keeps that gesture-and-idle performance. Subtle and lively add camera look, beat accents, and tighter mouth shapes on top of the PoseLab clip. See [Reactive motion](REACTIVE-MOTION.md). Camera options are cuts, medium, close-up, a directed take with a selected reveal word, or a storyboard of 2–8 script sections separated by blank lines. Choose landscape or portrait, apply changes to preview, and save or render. The silent MP4 and SRT/VTT links appear when rendering finishes.

The script compiler estimates word timings and maps written vowel groups to five VRM mouth expressions. It does not align to recorded speech. Imported PoseLab body poses continue across camera cuts. The directed preset adds a bounded lens creep, physical push, partial release, seeded handheld movement, and depth focus path. It assumes the avatar's face is near the configured stage depth and does not track a moving head.

Drafts and render jobs are local under `out/studio/`. The editor allows one render at a time. An incomplete storyboard may be saved, then finished later. A completed job records its exact episode JSON and render receipt. See [subtitle sidecars](SUBTITLES.md) for re-export from a saved episode.

Ctrl+C or SIGTERM stops the GUI and signals the in-progress render, including a render that was still running when Script Studio was opened again. Only a live `scripts/render.mjs` process counts as that render; an unrelated reused process id does not block the next take.
