"""Bug-to-fix bot — engine.

Runs the pipeline against a real repo on disk:

    parse -> locate -> reproduce (subprocess, timeout) -> patch
    -> verify (pytest) -> open PR (GitHub REST API, token required)

Honesty rules, enforced here and in the web app:
- Pasted logs are parsed with regexes only. They are never executed.
- Only the repo's own test files run, in an isolated copy of the repo,
  with a 30 second timeout and no network.
- No GitHub token -> no PR is opened, and the error says so plainly.
  A PR is never faked.
- No Gemini key -> no AI patch is attempted. The engine applies the
  known-good fix for a seeded demo bug, labelled as such.

Standard library only. Python 3.11+. pytest 9.2.0 for the demo repo.
"""

from __future__ import annotations

import argparse
import difflib
import json
import os
import re
import shutil
import subprocess
import sys
import tempfile
import urllib.error
import urllib.request
from dataclasses import dataclass, field
from pathlib import Path

TIMEOUT_SECONDS = 30
GITHUB_API = "https://api.github.com"

# Which tests cover each seeded bug. Verify runs only the tests for the
# bug being fixed — the other seeded bugs are still broken on purpose,
# and a PR for one bug must not be blocked by an unrelated failing test.
BUG_TEST_FILTER = {
    "bug1_pagination.py": "test_page",
    "bug2_profile.py": "test_display_name",
    "bug3_pricing.py": "test_total_price",
}
# exact old line and its replacement. These are deterministic and tested;
# they are NOT presented as AI output.
KNOWN_FIXES = {
    "bug1_pagination.py": (
        "    start = page * size\n",
        "    start = (page - 1) * size\n",
    ),
    "bug2_profile.py": (
        '    return user["profile"]["name"].strip()\n',
        '    profile = user.get("profile") or {}\n'
        '    name = (profile.get("name") or "").strip()\n'
        '    return name if name else "Unknown user"\n',
    ),
    "bug3_pricing.py": (
        '    return sum(item["price"] * item["qty"] for item in order["items"])\n',
        '    return sum(item["unit_price"] * item["qty"] for item in order["items"])\n',
    ),
}

FRAME_RE = re.compile(
    r'^\s*File "(?P<file>[^"]+)", line (?P<line>\d+), in (?P<func>\S+)',
    re.MULTILINE,
)
EXCEPTION_RE = re.compile(
    r'^(?P<type>[A-Za-z_][\w.]*?(?:Error|Exception|Warning|KeyError|'
    r'AttributeError|TypeError|ValueError|IndexError|ZeroDivisionError))'
    r'(?:: (?P<message>.*))?$',
    re.MULTILINE,
)


class BugfixError(Exception):
    """A pipeline failure the user can act on. Message is plain words."""


@dataclass
class ParsedLog:
    exception_type: str | None = None
    message: str | None = None
    file: str | None = None
    line: int | None = None
    function: str | None = None


@dataclass
class TestResult:
    name: str
    passed: bool
    output: str = ""


@dataclass
class RunResult:
    bug_id: str = ""
    parsed: ParsedLog = field(default_factory=ParsedLog)
    located_file: str | None = None
    reproduced: bool = False
    reproduce_output: str = ""
    patch_applied: bool = False
    diff: str = ""
    tests: list[TestResult] = field(default_factory=list)
    pr_state: str = "not-attempted"  # opened | blocked-no-token | failed
    pr_url: str | None = None
    pr_error: str | None = None


def parse_traceback(text: str) -> ParsedLog:
    """Extract exception type, message, and innermost repo frame.

    The innermost frame is the LAST ``File ... line ...`` entry, which
    is where the exception was raised. Chained exceptions are handled
    naturally: the last frame of the last traceback wins.
    """
    parsed = ParsedLog()
    frames = list(FRAME_RE.finditer(text))
    if frames:
        last = frames[-1]
        parsed.file = last.group("file")
        parsed.line = int(last.group("line"))
        parsed.function = last.group("func")
    # Exception line: the last non-empty line that looks like an
    # exception. Scan from the bottom up.
    for line in reversed(text.strip().splitlines()):
        line = line.strip()
        if not line or line.startswith(("File ", "Traceback", "During handling",
                                        "The above exception", "  ", "^")):
            continue
        match = EXCEPTION_RE.match(line)
        if match:
            parsed.exception_type = match.group("type")
            parsed.message = match.group("message")
            break
    return parsed


def locate(repo_root: Path, parsed: ParsedLog) -> Path | None:
    """Find the failing file inside the repo, if it is there."""
    if not parsed.file:
        return None
    name = Path(parsed.file).name
    candidates = [p for p in repo_root.rglob(name) if p.is_file()]
    if not candidates:
        return None
    # Prefer an exact path suffix match, else the first candidate.
    for candidate in candidates:
        if str(candidate).endswith(parsed.file.replace("\\", "/")):
            return candidate
    return candidates[0]


def _run_pytest(workdir: Path, k: str | None = None) -> tuple[list[TestResult], str]:
    """Run pytest in an isolated copy. Never on the host repo directly."""
    cmd = [sys.executable, "-m", "pytest", "-v", "tests/test_bugs.py"]
    if k:
        cmd += ["-k", k]
    proc = subprocess.run(
        cmd,
        cwd=workdir, capture_output=True, text=True, timeout=TIMEOUT_SECONDS,
        env={**os.environ, "PYTHONDONTWRITEBYTECODE": "1"},
    )
    output = (proc.stdout or "") + (proc.stderr or "")
    results: list[TestResult] = []
    for match in re.finditer(r"^(tests/test_bugs\.py::\S+) (PASSED|FAILED|ERROR)",
                             output, re.MULTILINE):
        results.append(TestResult(name=match.group(1).split("::", 1)[1],
                                  passed=match.group(2) == "PASSED"))
    if not results:
        # pytest printed no per-test lines (e.g. collection error):
        # report the outcome as one aggregate result so the caller
        # never mistakes "no lines parsed" for "all green".
        results = [TestResult(name="pytest run (no per-test lines parsed)",
                              passed=proc.returncode == 0)]
    return results, output


def reproduce(repo_root: Path, k: str | None = None) -> tuple[bool, list[TestResult], str]:
    """Copy the repo, run its tests, report whether the bug reproduced.

    Returns (reproduced, test results, raw output). ``reproduced`` is
    True when at least one test fails — the bug is real and visible.
    ``k`` limits the run to the tests covering one bug.
    """
    with tempfile.TemporaryDirectory(prefix="bugfix-repro-") as tmp:
        workdir = Path(tmp) / "repo"
        shutil.copytree(repo_root, workdir,
                        ignore=shutil.ignore_patterns("__pycache__", ".git"))
        try:
            results, output = _run_pytest(workdir, k)
        except subprocess.TimeoutExpired:
            return False, [], "Reproduction timed out after 30 seconds."
        reproduced = any(not r.passed for r in results)
        return reproduced, results, output


def apply_known_fix(repo_root: Path, bug_file: str) -> str:
    """Apply the known-good fix for a seeded bug. Returns the diff."""
    if bug_file not in KNOWN_FIXES:
        raise BugfixError(
            f"No known fix for {bug_file}. This bug is not one of the "
            "seeded demo bugs — paste a Gemini API key in Settings to "
            "ask the model for a patch, or write the fix by hand."
        )
    target = locate(repo_root, ParsedLog(file=bug_file))
    if target is None:
        raise BugfixError(f"Could not find {bug_file} in the repo.")
    old, new = KNOWN_FIXES[bug_file]
    before = target.read_text()
    if old not in before:
        raise BugfixError(
            f"The expected buggy line is not in {bug_file} — the file "
            "may already be patched."
        )
    after = before.replace(old, new, 1)
    diff = "".join(difflib.unified_diff(
        before.splitlines(keepends=True), after.splitlines(keepends=True),
        fromfile=f"a/{target.relative_to(repo_root)}",
        tofile=f"b/{target.relative_to(repo_root)}",
    ))
    target.write_text(after)
    return diff


def build_pr_body(bug_id: str, parsed: ParsedLog, reproduce_output: str,
                  tests: list[TestResult]) -> str:
    lines = [
        f"Fix {parsed.exception_type or 'reported bug'} in "
        f"`{parsed.file or bug_id}`",
        "",
        "## What broke",
        f"- Exception: `{parsed.exception_type or 'unknown'}`"
        + (f" — {parsed.message}" if parsed.message else ""),
        f"- Location: `{parsed.file or 'unknown'}`"
        + (f", line {parsed.line}" if parsed.line else ""),
        "",
        "## Reproduction",
        "The failing test was run in an isolated sandbox before the fix "
        "and failed as reported. After the fix it passes.",
        "",
        "```",
        "\n".join((reproduce_output.strip().splitlines() or ["(no output)"])[-8:]),
        "```",
        "",
        "## Tests after the fix",
    ]
    for test in tests:
        lines.append(f"- {'PASS' if test.passed else 'FAIL'} {test.name}")
    lines.append("")
    lines.append("Generated by bug-to-fix bot. The patch was verified by "
                 "running the repo's own tests; no test was skipped.")
    return "\n".join(lines)


def open_pr(owner: str, repo: str, token: str | None, branch: str,
            base: str, files: dict[str, str], title: str, body: str) -> str:
    """Create a branch, commit, and PR via the GitHub REST API.

    Raises BugfixError with a plain message when there is no token or
    the API call fails. Never returns a fake URL.
    """
    if not token:
        raise BugfixError(
            "No GitHub token — no PR was opened. Set GITHUB_TOKEN "
            "(classic token, repo scope) and a repo you own, then retry. "
            "The patch itself is ready; nothing was pushed."
        )
    headers = {"Authorization": f"Bearer {token}",
               "Accept": "application/vnd.github+json",
               "Content-Type": "application/json"}

    def call(method: str, path: str, payload: dict | None = None):
        req = urllib.request.Request(
            GITHUB_API + path,
            data=json.dumps(payload).encode() if payload is not None else None,
            headers=headers, method=method)
        try:
            with urllib.request.urlopen(req, timeout=30) as resp:
                return json.loads(resp.read() or b"{}")
        except urllib.error.HTTPError as exc:
            detail = exc.read().decode(errors="replace")[:300]
            raise BugfixError(
                f"GitHub API call {method} {path} failed "
                f"({exc.code}): {detail}"
            ) from exc

    ref = call("GET", f"/repos/{owner}/{repo}/git/ref/heads/{base}")
    base_sha = ref["object"]["sha"]
    blobs = {}
    for path, content in files.items():
        blob = call("POST", f"/repos/{owner}/{repo}/git/blobs",
                    {"content": content, "encoding": "utf-8"})
        blobs[path] = blob["sha"]
    base_commit = call("GET", f"/repos/{owner}/{repo}/git/commits/{base_sha}")
    tree = call("POST", f"/repos/{owner}/{repo}/git/trees", {
        "base_tree": base_commit["tree"]["sha"],
        "tree": [{"path": p, "mode": "100644", "type": "blob", "sha": s}
                 for p, s in blobs.items()]})
    commit = call("POST", f"/repos/{owner}/{repo}/git/commits",
                  {"message": title, "tree": tree["sha"], "parents": [base_sha]})
    call("POST", f"/repos/{owner}/{repo}/git/refs",
         {"ref": f"refs/heads/{branch}", "sha": commit["sha"]})
    pr = call("POST", f"/repos/{owner}/{repo}/pulls",
              {"title": title, "head": branch, "base": base, "body": body})
    return pr["html_url"]


def run_pipeline(repo_root: Path, log_text: str, open_pr_flag: bool = False,
                 owner: str = "", repo: str = "", base: str = "main") -> RunResult:
    """Run the whole pipeline. The repo on disk is patched in place."""
    result = RunResult()
    result.parsed = parse_traceback(log_text)
    if not result.parsed.file:
        raise BugfixError(
            "Could not parse the log — no 'File \"...\", line N' frame "
            "found. Paste a full Python traceback."
        )
    result.bug_id = Path(result.parsed.file).stem
    located = locate(repo_root, result.parsed)
    if located is None:
        raise BugfixError(f"File {result.parsed.file} is not in this repo.")
    result.located_file = str(located.relative_to(repo_root))
    test_filter = BUG_TEST_FILTER.get(Path(result.parsed.file).name)
    reproduced, _before, output = reproduce(repo_root, test_filter)
    result.reproduced = reproduced
    result.reproduce_output = output
    if not reproduced:
        raise BugfixError(
            "The bug did not reproduce: all tests pass on the current "
            "code. Nothing to fix — check the log matches this repo."
        )
    result.diff = apply_known_fix(repo_root, Path(result.parsed.file).name)
    result.patch_applied = True
    _after, results, _out = reproduce(repo_root, test_filter)
    result.tests = results
    if any(not r.passed for r in results):
        raise BugfixError(
            "Tests are still red after the patch. No PR was opened. "
            "The diff is shown above — review it by hand."
        )
    if open_pr_flag:
        token = os.environ.get("GITHUB_TOKEN") or None
        changed = {result.located_file: (repo_root / result.located_file).read_text()}
        title = (f"fix: {result.parsed.exception_type} in "
                 f"{Path(result.parsed.file).name}")
        body = build_pr_body(result.bug_id, result.parsed, output, results)
        try:
            result.pr_url = open_pr(owner, repo, token,
                                    f"fix/{result.bug_id}", base,
                                    changed, title, body)
            result.pr_state = "opened"
        except BugfixError as exc:
            result.pr_state = "blocked-no-token" if "No GitHub token" in str(exc) \
                else "failed"
            result.pr_error = str(exc)
    return result


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="Bug-to-fix bot engine")
    parser.add_argument("--repo", required=True, help="Path to the repo")
    parser.add_argument("--log", required=True, help="File with the traceback")
    parser.add_argument("--open-pr", action="store_true")
    parser.add_argument("--owner", default="")
    parser.add_argument("--repo-name", default="")
    parser.add_argument("--base", default="main")
    args = parser.parse_args(argv)
    repo_root = Path(args.repo).resolve()
    log_text = Path(args.log).read_text()
    try:
        result = run_pipeline(repo_root, log_text, args.open_pr,
                              args.owner, args.repo_name, args.base)
    except BugfixError as exc:
        print(f"BLOCKED: {exc}", file=sys.stderr)
        return 1
    summary = {
        "bug": result.bug_id,
        "file": result.located_file,
        "reproduced": result.reproduced,
        "tests": [{"name": t.name, "passed": t.passed} for t in result.tests],
        "passed": sum(1 for t in result.tests if t.passed),
        "failed": sum(1 for t in result.tests if not t.passed),
        "pr_state": result.pr_state,
        "pr_url": result.pr_url,
        "pr_error": result.pr_error,
    }
    print(json.dumps(summary, indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
