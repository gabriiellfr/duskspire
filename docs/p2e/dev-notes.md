# Dev environment notes (fork)

## Windows: repo path with a space breaks the gate preflight

`npm run gate` probes ffmpeg/ffprobe by execution with `shell: true` on
Windows (`scripts/gate.mjs`). With the repo under a path containing a space
(for example `D:\Projects 2026\...`), cmd.exe splits the unquoted binary path
and the probe fails with "missing required SFX audio tooling" even though the
binaries are installed and healthy. The conformance steps themselves
(`scripts/sfx/conform_audio.mjs`) use `execFileSync` without a shell and are
unaffected.

Workaround (no upstream file modified): copy the two binaries to a space-free
path and use the sanctioned overrides:

```
WOC_FFMPEG_PATH=C:\Users\<you>\AppData\Local\Temp\claude\woctools\ffmpeg.exe
WOC_FFPROBE_PATH=C:\Users\<you>\AppData\Local\Temp\claude\woctools\ffprobe.exe
npm run gate
```

Refresh the copies after any `npm ci` that bumps the ffmpeg-static or
ffprobe-static versions.

Candidate upstream PR (PLAN.md section 4, "upstream what is generic"): quote
the tool path in the gate preflight probe, or probe with `shell: false` and
keep the shell only for the npm/npx steps that need it.
