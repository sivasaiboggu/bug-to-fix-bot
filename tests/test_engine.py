"""Tests for the bug-to-fix engine.

Covers: traceback parsing, file location, sandboxed reproduction
(fail before the patch, pass after), patch application, PR payload
building, and the no-token honesty rule. No network is used; the
GitHub calls are never made in tests — only the guard that refuses
to open a PR without a token.
"""

import shutil
import sys
import tempfile
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "engine"))

import bugfix
from bugfix import BugfixError, parse_traceback

PROJECT = Path(__file__).resolve().parent.parent
DEMO_REPO = PROJECT / "demo-repo"

TRACE_PAGINATION = """Traceback (most recent call last):
  File "/app/api.py", line 42, in list_items
    return page_slice(items, page, size)
  File "/app/bugs/bug1_pagination.py", line 10, in page_slice
    return items[start:start + size]
IndexError: list index out of range
"""

TRACE_NONE = """Traceback (most recent call last):
  File "/app/views.py", line 17, in show_user
    name = display_name(user)
  File "/app/bugs/bug2_profile.py", line 9, in display_name
    return user["profile"]["name"].strip()
AttributeError: 'NoneType' object has no attribute 'strip'
"""

TRACE_KEY = """Traceback (most recent call last):
  File "/app/orders.py", line 31, in checkout
    total = total_price(order)
  File "/app/bugs/bug3_pricing.py", line 9, in total_price
    return sum(item["price"] * item["qty"] for item in order["items"])
KeyError: 'price'
"""


# --- parsing -------------------------------------------------------------

def test_parse_pagination_traceback():
    parsed = parse_traceback(TRACE_PAGINATION)
    assert parsed.exception_type == "IndexError"
    assert parsed.file.endswith("bug1_pagination.py")
    assert parsed.line == 10
    assert parsed.function == "page_slice"


def test_parse_none_dereference_traceback():
    parsed = parse_traceback(TRACE_NONE)
    assert parsed.exception_type == "AttributeError"
    assert "NoneType" in (parsed.message or "")
    assert parsed.file.endswith("bug2_profile.py")
    assert parsed.line == 9


def test_parse_key_error_traceback():
    parsed = parse_traceback(TRACE_KEY)
    assert parsed.exception_type == "KeyError"
    assert parsed.file.endswith("bug3_pricing.py")
    assert parsed.line == 9


def test_parse_uses_innermost_frame_not_first():
    parsed = parse_traceback(TRACE_PAGINATION)
    # First frame is api.py; the crash is in bug1_pagination.py.
    assert "api.py" not in (parsed.file or "")
    assert parsed.function == "page_slice"


def test_parse_garbage_log_returns_empty():
    parsed = parse_traceback("something went wrong\nno traceback here\n")
    assert parsed.file is None
    assert parsed.exception_type is None


def test_parse_chained_exception_uses_last_traceback():
    chained = TRACE_NONE + (
        "\nDuring handling of the above exception, another exception occurred:\n\n"
        + TRACE_KEY
    )
    parsed = parse_traceback(chained)
    assert parsed.exception_type == "KeyError"
    assert parsed.file.endswith("bug3_pricing.py")


# --- locating ------------------------------------------------------------

def test_locate_finds_bug_file_in_demo_repo():
    located = bugfix.locate(DEMO_REPO, parse_traceback(TRACE_PAGINATION))
    assert located is not None
    assert located.name == "bug1_pagination.py"


def test_locate_missing_file_returns_none():
    parsed = parse_traceback(TRACE_PAGINATION)
    parsed.file = "/app/nope.py"
    assert bugfix.locate(DEMO_REPO, parsed) is None


# --- reproduction + patch (real subprocess, real pytest) ------------------

@pytest.fixture()
def repo_copy(tmp_path):
    dest = tmp_path / "repo"
    shutil.copytree(DEMO_REPO, dest)
    return dest


def test_reproduce_fails_before_patch(repo_copy):
    reproduced, results, _output = bugfix.reproduce(repo_copy)
    assert reproduced is True
    assert len(results) == 8
    assert sum(1 for r in results if not r.passed) == 5


def test_apply_known_fix_pagination(repo_copy):
    diff = bugfix.apply_known_fix(repo_copy, "bug1_pagination.py")
    assert "-    start = page * size" in diff
    assert "+    start = (page - 1) * size" in diff
    assert "bug1_pagination.py" in diff


def test_apply_known_fix_twice_is_blocked(repo_copy):
    bugfix.apply_known_fix(repo_copy, "bug1_pagination.py")
    with pytest.raises(BugfixError, match="already be patched"):
        bugfix.apply_known_fix(repo_copy, "bug1_pagination.py")


def test_apply_known_fix_unknown_bug_is_blocked(repo_copy):
    with pytest.raises(BugfixError, match="No known fix"):
        bugfix.apply_known_fix(repo_copy, "bug9_mystery.py")


def test_full_pipeline_all_three_bugs_go_green(repo_copy):
    for trace in (TRACE_PAGINATION, TRACE_NONE, TRACE_KEY):
        result = bugfix.run_pipeline(repo_copy, trace)
        assert result.reproduced is True
        assert result.patch_applied is True
        assert result.tests, "verify step must report per-test results"
    # After all three patches the whole suite is green.
    _reproduced, results, _output = bugfix.reproduce(repo_copy)
    assert len(results) == 8
    assert all(r.passed for r in results)


def test_pipeline_unparseable_log_is_blocked(repo_copy):
    with pytest.raises(BugfixError, match="Could not parse"):
        bugfix.run_pipeline(repo_copy, "nothing to see here")


def test_pipeline_bug_not_in_repo_is_blocked(repo_copy):
    with pytest.raises(BugfixError, match="not in this repo"):
        bugfix.run_pipeline(repo_copy, TRACE_PAGINATION.replace(
            "bug1_pagination.py", "bug1_elsewhere.py"))


# --- PR honesty ----------------------------------------------------------

def test_open_pr_without_token_is_refused_plainly():
    with pytest.raises(BugfixError, match="No GitHub token"):
        bugfix.open_pr("someone", "somerepo", None, "fix/x", "main",
                       {"a.py": "x"}, "fix: x", "body")


def test_open_pr_with_empty_token_is_refused():
    with pytest.raises(BugfixError, match="No GitHub token"):
        bugfix.open_pr("someone", "somerepo", "", "fix/x", "main",
                       {"a.py": "x"}, "fix: x", "body")


def test_pipeline_open_pr_without_token_reports_blocked(repo_copy, monkeypatch):
    monkeypatch.delenv("GITHUB_TOKEN", raising=False)
    result = bugfix.run_pipeline(repo_copy, TRACE_PAGINATION, open_pr_flag=True,
                                 owner="someone", repo="somerepo")
    assert result.pr_state == "blocked-no-token"
    assert result.pr_url is None
    assert result.pr_error is not None
    assert "No GitHub token" in result.pr_error
    assert all(r.passed for r in result.tests)


def test_pr_body_contains_reproduction_and_tests():
    parsed = parse_traceback(TRACE_PAGINATION)
    body = bugfix.build_pr_body("bug1_pagination", parsed, "1 failed, 7 passed",
                                [bugfix.TestResult("test_page_1_returns_first_items", True)])
    assert "IndexError" in body
    assert "bug1_pagination.py" in body
    assert "PASS test_page_1_returns_first_items" in body
    assert "http" not in body  # no fake PR link anywhere in the body
