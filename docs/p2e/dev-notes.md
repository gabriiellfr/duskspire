# Dev environment notes (fork)

## Baseline gate result on this Windows machine (2026-07-30)

Full `npm run gate` on the untouched fork point: 22,683 tests passed, 198
failed across 51 files. Every inspected failure is environment-shaped, not a
code regression: CRLF byte-pinning breaks under `core.autocrlf` (upstream CI
checks out LF on Linux), jsdom-canvas gaps, suites that need a running
Postgres, and ffmpeg-dependent suites hitting the path-space issue below.
Consequences for this fork:

- The AUTHORITATIVE gate is the fork's GitHub Actions CI (Linux), which runs
  the same steps. Treat local Windows full-gate red as advisory; targeted
  `npx vitest run <file>` and `npx tsc --noEmit` remain reliable locally.
- Recommended local fix to try later: `git config core.autocrlf false` plus a
  fresh checkout, which should clear the byte-pin class of failures.

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
