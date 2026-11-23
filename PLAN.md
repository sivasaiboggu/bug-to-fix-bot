# Bug-to-fix bot — deepened plan (SaaS level)

## 1. Project brief
- **Name:** bug-to-fix bot
- **Type:** Developer tool / SaaS (AI debugging agent)
- **What it does (1 sentence):** Paste an error log and it finds the failing code, reproduces the bug in a sandbox, writes a minimal patch, proves it with tests, and opens a pull request.
- **Target user and pain:** A solo developer or small team drowning in tracebacks from CI, Sentry, or a user report. Reading a stack trace, reproducing the failure, and writing the fix is 30–90 minutes of context-switching per bug; most of it is mechanical.
- **Core promise:** Paste a log, get a tested PR — reproduction, patch, and proof included.
- **Tone:** Technical, plain, calm. A workshop bench, not a marketing page.
- **Design identity (this project only):** rust `#B45309` + JetBrains Mono. Paper-white background, hairline borders, one signature idea: a numbered pipeline rail (01 Parse → 02 Locate → 03 Reproduce → 04 Patch → 05 Verify → 06 PR) that fills in as the run progresses. References: Linear (dense pipeline rail, mono type, restrained accent), Raycast (command-like, keyboard-first, plain copy), Mobbin (real flows, nothing decorative).
- **Platforms:** Web app (static, no build step) + a real Python engine (CLI) for local/CI use.

## 2. Stack (versions verified 23 Nov 2026)
- Frontend: plain HTML/CSS/JS, no framework, no build step — the app opens from `file://` or any static host. JetBrains Mono via Google Fonts (system mono fallback offline).
- Engine: Python 3.11+ (latest stable 3.15.2, 25 Oct 2026; local VM runs 3.12.3), pytest 9.2.0 (27 Oct 2026), standard library only (`urllib`, `subprocess`, `difflib`) — zero third-party dependencies, so the engine runs anywhere Python runs.
- Model (optional): Gemini API, `gemini-2.5-flash` — free tier, key supplied by the user in Settings, stored in `localStorage` only, never sent anywhere except Google's API.
- PRs: GitHub REST API v3 over `urllib` (engine) / `fetch` (browser). No PyGithub dependency.
- Reproduction sandbox: isolated subprocess with a 30 s timeout, a copied repo tree (never the user's working tree), no network, no shell. Docker is the v2 upgrade; subprocess-with-timeout is the honest v1.

## 3. Feature set (SaaS level, demoable in 24–48 h)
1. **Paste-a-log intake** — big mono textarea; accepts Python tracebacks, `pytest` failure output, and plain `Exception: ...` lines. One-click sample logs for the 3 seeded bugs. Paste is never executed: the log is parsed with regexes only.
2. **Parser** — extracts exception type, message, and the innermost repo frame (file, line, function). Handles chained exceptions (`During handling of the above exception`) and multi-frame traces. Unknown formats get a plain "could not parse" state, never a guessed file.
3. **Locator** — matches the parsed file/line against the repo index, shows the file with the failing line highlighted and 6 lines of context either side.
4. **Sandboxed reproducer** — runs the failing test (or a minimal repro script) in an isolated subprocess with a 30 s timeout and captures stdout/stderr. Before the patch it must fail; after the patch it must pass. A run that times out is reported as a timeout, not a pass.
5. **Patcher** — two sources, both labelled honestly:
   - *Known-good fix* for the 3 seeded demo bugs (deterministic, tested).
   - *Gemini suggestion* when the user pastes a free Gemini key in Settings; the suggestion is shown as a proposal the user applies or discards — never auto-applied blind.
   - No key present → no AI patch is faked. The UI says so.
6. **Diff viewer** — unified diff, red/green lines, file header, line numbers. Copy-diff and download-`.patch` buttons.
7. **Verifier** — re-runs the full test file after the patch and shows per-test pass/fail with counts and elapsed time. PR is blocked while any test is red.
8. **PR opener (real)** — with a GitHub personal access token (classic, `repo` scope) and a repo the user owns: creates branch `fix/<slug>`, commits the patch, pushes, opens a PR whose body contains the reproduction log and test output. Without a token: a clear error box — "No GitHub token — no PR was opened" — never a fake PR, never a fake PR number or URL.
9. **Run history** — every run saved in `localStorage` (time, bug, result, test counts, PR state). Re-open a past run. Clear-history button. Nothing leaves the browser.
10. **Settings** — Gemini API key + GitHub token fields, `localStorage` only, show/hide, clear buttons, and a plain note explaining exactly where each key goes and that neither is ever sent to any server except its own API.
11. **Engine CLI** — `python3 engine/bugfix.py` runs the same pipeline (parse → locate → reproduce → patch → verify → PR) against a real repo on disk, for local use and CI. Same honesty rules.
12. **Pages/states** — main workbench; empty state (what to paste, with samples); running state (rail fills, live log lines); success state (green tests + PR panel); blocked state (red tests → diff only, no PR); error states (unparseable log, missing token, API failure) each with the next step in plain words. 404/500 not applicable to a static app; a broken Settings key is handled inline.

## 4. Data model
- `Bug` — `{ id, title, kind, file, line, function, exception, message, traceback, sourceBefore, sourceAfter, diff, tests: [{name, input, expected}], prTitle, prBody, branch }`
- `Run` — `{ id, startedAt, bugId, source: "sample" | "pasted", steps: [{name, status, startedAt, endedAt, log[]}], testResults: [{name, passed}], pr: {state: "not-attempted" | "opened" | "blocked-no-token" | "failed", url?, error?} }`
- `Settings` — `{ geminiKey, githubToken, githubOwner, githubRepo }` in `localStorage` only.
- Demo repo (real Python, `demo-repo/`): `bugs/bug1_pagination.py` (off-by-one), `bugs/bug2_profile.py` (`None` dereference), `bugs/bug3_pricing.py` (wrong dict key); `tests/test_bugs.py` with one failing test per bug plus regression tests. Tests are written against correct behaviour, so they fail on buggy code and pass after the patch — that is the demo.

## 5. Complete user flow, end to end
1. Open the app. Empty state explains in one sentence what it does and offers 3 sample logs.
2. User pastes a traceback (or clicks a sample). Parser runs instantly: exception type, file, line shown; the file view opens with the failing line highlighted.
3. User clicks **Run the pipeline**. The rail advances: Parse (done) → Locate → Reproduce (sandbox run fails, log shown, red) → Patch (diff appears) → Verify (tests re-run, all green) → PR.
4. PR step: if a GitHub token + owner/repo are set in Settings, the app creates the branch, commit, and PR via the GitHub API and shows the real PR link. If not, it shows the blocked box with the exact next step and offers Copy diff / Download .patch instead.
5. Optional: with a Gemini key set, **Ask Gemini** proposes an alternative patch for the same bug; the user compares it with the known-good fix and chooses which to apply before Verify.
6. The run is saved to history. The user can re-open it, re-run it, or clear history.
7. CLI path: `python3 engine/bugfix.py --repo demo-repo --log <file>` does the same on disk and prints a JSON summary; `--open-pr` requires `GITHUB_TOKEN` in the environment.

## 6. 2-minute demo script
- **0:00–0:20:** "Every bug report starts as a wall of text." Paste the pagination traceback (sample 1). The bot names the exception, file, and line.
- **0:20–1:00:** Watch the reproducer fail in the sandbox (red log, real failure), then the patch land in the diff viewer and the tests go green — 4 passed, 0 failed.
- **1:00–1:40:** PR step: no token in this machine, so the app says so plainly and shows the exact diff that would be opened; then show the pre-made fallback — the patch file and the PR body it generates. (If a token is present, the PR opens live instead.)
- **1:40–2:00:** Close: "Paste a log, get a tested PR — reproduction, patch, and proof included. It never opens a PR it can't prove, and never fakes one it didn't open."

## 7. Honest limits (stated in README and in the app)
- No real PR without a GitHub personal access token and a repo the user owns — hard requirement, not a bug.
- No live AI patch without the user's own free Gemini key — the seeded bugs use tested, deterministic fixes instead, labelled as such.
- The browser demo reproduces the 3 seeded bugs in a browser sandbox that mirrors the demo-repo code; the Python engine runs the real reproduction with pytest in a subprocess. Real-world bugs that need production data, timing, or a specific environment are out of scope for the demo.
- Pasted logs are never executed. Only the repo's own test files run, in an isolated copy, with a 30 s timeout.

## 8. Quality bar
- pytest suite for the engine: exact pass count reported, 0 failures.
- Headless-Chrome screenshots at 1280 px and 390 px, zero horizontal overflow, read and fixed.
- README + MIT LICENSE (Sivasai Boggu, 2026). No gradients, no glows, no sparkle emoji, no cliché copy. No fake data presented as real; no dead controls.

## 9. V2 ideas (not built now)
Docker-based sandbox per run; GitHub App install instead of PAT; Sentry/webhook intake (paste a Sentry link, not a log); multi-file patches; flaky-test detection (run 3×); private repo support via the GitHub App; team run-history (shared, server-side); cost tracking per Gemini call; auto-triage labels on the PR.
