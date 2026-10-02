# Subtitle sidecars

Script Studio writes SRT and WebVTT beside every completed GUI video. For an existing dialogue episode:

```bash
npm run subtitles -- out/setup/first-take.json out/first-take-captions
```

This creates `out/first-take-captions.srt` and `.vtt`. The destination directory must already exist. Existing files are protected unless you add `--force`. Captions reflect estimated script timing; they need a separate alignment pass if recorded speech differs.
