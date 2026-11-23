# bug-to-fix bot

Paste an error log. Get a tested PR.

The bot finds the failing code, reproduces the bug in a sandbox, writes a minimal patch, proves it with tests, and opens a pull request — live. It never opens a PR it can't prove, and never fakes one it didn't open.

## How it works

1. **Parse** — the pasted traceback is parsed with regexes (exception type, file, line, function). Pasted logs are never executed.
2. **Locate** — the failing file is found in the repo and shown with the crashing line highlighted.
3. **Reproduce** — the repo's own tests run in an isolated copy with a 30-second timeout. The bug must fail first, or there is nothing to fix.
4. **Patch** — the smallest fix for the cause. For the 3 seeded demo bugs this is a tested, deterministic fix (labelled as such). With your own free Gemini key, the bot can also propose an AI patch, which you approve or discard.
5. **Verify** — the tests for that bug re-run. Any red test blocks the PR.
6. **Open PR** — branch, commit, push, pull request via the GitHub REST API, with the reproduction log and test output in the PR body.

## Demo (no keys needed)

Open `index.html` in a browser (or serve the folder with any static host). Click a sample log — off-by-one, None dereference, or wrong dict key — then **Run the pipeline**.

- The browser demo reproduces the 3 seeded bugs in a page sandbox that mirrors the code in `demo-repo/bugs/`.
- The real Python reproduction lives in `engine/bugfix.py`, which runs pytest in an isolated subprocess copy of the repo.

Deep link to a finished run (used for screenshots): `index.html?bug=bug1_pagination&autorun=1`

## The seeded bugs (`demo-repo/`)

| Bug | File | Fault | Failing tests before fix |
| --- | --- | --- | --- |
| 1 | `bugs/bug1_pagination.py` | off-by-one: 1-based page treated as 0-based | 2 of 3 page tests |
| 2 | `bugs/bug2_profile.py` | `None` profile dereferenced | 2 of 3 display-name tests |
| 3 | `bugs/bug3_pricing.py` | wrong dict key (`price` vs `unit_price`) | 1 of 2 pricing tests |

Before any fix: `pytest demo-repo/tests/test_bugs.py` → **5 failed, 3 passed**. After all three fixes: **8 passed, 0 failed**.

## Engine (command line)

```bash
pip install pytest==9.2.0
python3 engine/bugfix.py --repo demo-repo --log /tmp/traceback.txt
```

Options: `--open-pr --owner <you> --repo-name <repo> --base main` opens a real PR. It reads the token from `GITHUB_TOKEN` in the environment. Without a token it reports `blocked-no-token` and opens nothing.

```bash
GITHUB_TOKEN=ghp_… python3 engine/bugfix.py --repo demo-repo --log /tmp/traceback.txt --open-pr --owner you --repo-name your-repo
```

## Keys (optional, yours only)

- **Gemini API key** (free tier, `gemini-2.5-flash`): paste it in Settings in the web app. It is stored in `localStorage` only and sent only to Google's API. Without it, the app uses the tested known-good fixes for the seeded bugs and says so.
- **GitHub personal access token** (classic, `repo` scope) + a repo you own: required for a real PR. Without it, the PR step shows a plain "No GitHub token — no PR was opened" box. No fake PR number or URL is ever shown.

## Honest limits

- No real PR without a GitHub token and a repo you own — a hard requirement, not a bug.
- No live AI patch without your own free Gemini key.
- The demo only promises deterministic, test-backed bugs in a repo you control. Real-world bugs that need production data, timing, or a specific environment are out of scope.
- The sandbox is an isolated subprocess with a timeout (Docker is the planned v2 upgrade).

## Tests

```bash
python3 -m pytest tests/test_engine.py -q
```

**19 passed, 0 failed.** Covers traceback parsing (including chained exceptions), file location, sandboxed reproduction (fail before patch, pass after), patch application, the full pipeline for all three bugs, and the no-token PR refusal.

## Stack (versions verified 23 Nov 2026)

- Frontend: plain HTML/CSS/JS, no framework, no build step. JetBrains Mono.
- Engine: Python 3.11+ (latest stable 3.15.2, 25 Oct 2026), pytest 9.2.0 (27 Oct 2026), standard library only.
- Model (optional): Gemini API, `gemini-2.5-flash`, free tier.
- PRs: GitHub REST API v3. No third-party dependencies anywhere.

## Design

Rust `#B45309` + JetBrains Mono. One signature idea: a numbered pipeline rail (01–06) that fills in as the run progresses. References: Linear (dense pipeline rail, mono type), Raycast (plain copy, keyboard-first feel), Mobbin (real flows). No gradients, no glows, no decorative symbols. Plain human copy throughout.

## Files

```
index.html  styles.css  app.js     — web app (static, works from file://)
PLAN.md                             — deepened SaaS-level plan
demo-repo/bugs/                     — 3 seeded buggy Python modules
demo-repo/tests/test_bugs.py        — 8 tests (5 fail before fixes)
engine/bugfix.py                    — real pipeline CLI (stdlib only)
tests/test_engine.py                — 19 engine tests
screenshots/                        — desktop + mobile renders
```

## License

MIT — Sivasai Boggu, 2026.
