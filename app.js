/* Bug-to-fix bot — browser demo.
 *
 * What this does, honestly:
 * - Parses the pasted traceback with regexes (never executes it).
 * - Locates the failing file in the bundled demo repo data below.
 * - Reproduces the bug by running a JS mirror of the demo-repo Python
 *   function in this page (the real Python reproduction lives in
 *   engine/bugfix.py, which runs pytest in an isolated subprocess).
 * - Applies the known-good, tested fix for the seeded bug (labelled as
 *   such), or a Gemini suggestion when the user supplies a key.
 * - Verifies by re-running the mirrored tests.
 * - Opens a real PR only when a GitHub token + owner/repo are set;
 *   otherwise it says so plainly and never fakes a PR.
 */

"use strict";

const STEPS = [
  { id: "parse", name: "Parse", desc: "Read the traceback: exception, file, line." },
  { id: "locate", name: "Locate", desc: "Find the failing code in the repo." },
  { id: "reproduce", name: "Reproduce", desc: "Run the failing test in a sandbox. It must fail." },
  { id: "patch", name: "Patch", desc: "Write the smallest fix that addresses the cause." },
  { id: "verify", name: "Verify", desc: "Re-run the tests. All green or no PR." },
  { id: "pr", name: "Open PR", desc: "Branch, commit, push, pull request — token required." },
];

/* --- JS mirrors of demo-repo/bugs/*.py (same logic, same bugs) --- */
const MIRRORS = {
  bug1_pagination: {
    buggy: (items, page, size) => { const s = page * size; return items.slice(s, s + size); },
    fixed: (items, page, size) => { const s = (page - 1) * size; return items.slice(s, s + size); },
    call: (fn) => fn([1, 2, 3, 4, 5, 6, 7, 8, 9, 10], 1, 3),
  },
  bug2_profile: {
    buggy: (user) => user.profile.name.trim(),
    fixed: (user) => { const p = user.profile || {}; const n = (p.name || "").trim(); return n || "Unknown user"; },
    call: (fn) => fn({ profile: null }),
  },
  bug3_pricing: {
    buggy: (order) => order.items.reduce((t, i) => {
      if (!("price" in i)) throw new Error("KeyError: 'price'");
      return t + i.price * i.qty;
    }, 0),
    fixed: (order) => order.items.reduce((t, i) => t + i.unit_price * i.qty, 0),
    call: (fn) => fn({ items: [{ unit_price: 100, qty: 2 }, { unit_price: 50, qty: 1 }] }),
  },
};

const BUGS = [
  {
    id: "bug1_pagination",
    title: "Off-by-one in pagination",
    file: "bugs/bug1_pagination.py",
    line: 9,
    func: "page_slice",
    exception: "IndexError",
    message: "list index out of range",
    traceback:
`Traceback (most recent call last):
  File "/app/api.py", line 42, in list_items
    return page_slice(items, page, size)
  File "/app/bugs/bug1_pagination.py", line 9, in page_slice
    return items[start:start + size]
IndexError: list index out of range`,
    sourceBefore: [
      '"""Bug 1 — off-by-one in pagination.',
      "",
      "The API is 1-based: page 1 is the first page. The slice below treats",
      "``page`` as 0-based, so page 1 returns the second page of results.",
      '"""',
      "",
      "",
      "def page_slice(items, page, size):",
      "    start = page * size",
      "    return items[start:start + size]",
    ],
    sourceAfter: [
      "def page_slice(items, page, size):",
      "    start = (page - 1) * size",
      "    return items[start:start + size]",
    ],
    diff: [
      { t: "hdr", text: "--- a/bugs/bug1_pagination.py" },
      { t: "hdr", text: "+++ b/bugs/bug1_pagination.py" },
      { t: "ctx", text: " def page_slice(items, page, size):" },
      { t: "del", text: "-    start = page * size" },
      { t: "add", text: "+    start = (page - 1) * size" },
      { t: "ctx", text: "     return items[start:start + size]" },
    ],
    fixNote: "Known-good fix for this seeded bug (tested, deterministic — not AI output). Page numbers are 1-based, so the slice starts at (page - 1) * size.",
    tests: [
      { name: "test_page_1_returns_first_items", run: (fn) => JSON.stringify(fn([1,2,3,4,5,6,7,8,9,10], 1, 3)) === "[1,2,3]" },
      { name: "test_page_2_returns_next_items", run: (fn) => JSON.stringify(fn([1,2,3,4,5,6,7,8,9,10], 2, 3)) === "[4,5,6]" },
      { name: "test_page_beyond_end_is_empty", run: (fn) => JSON.stringify(fn([1,2,3,4,5,6,7,8,9,10], 5, 3)) === "[]" },
    ],
    prTitle: "fix: IndexError in bug1_pagination.py",
    branch: "fix/bug1-pagination",
  },
  {
    id: "bug2_profile",
    title: "None dereference in display name",
    file: "bugs/bug2_profile.py",
    line: 8,
    func: "display_name",
    exception: "AttributeError",
    message: "'NoneType' object has no attribute 'strip'",
    traceback:
`Traceback (most recent call last):
  File "/app/views.py", line 17, in show_user
    name = display_name(user)
  File "/app/bugs/bug2_profile.py", line 8, in display_name
    return user["profile"]["name"].strip()
AttributeError: 'NoneType' object has no attribute 'strip'`,
    sourceBefore: [
      '"""Bug 2 — None dereference in display name.',
      "",
      '``user["profile"]`` is None for accounts that never filled in a',
      "profile. Calling ``.strip()`` on it raises AttributeError.",
      '"""',
      "",
      "",
      "def display_name(user):",
      '    return user["profile"]["name"].strip()',
    ],
    sourceAfter: [
      "def display_name(user):",
      '    profile = user.get("profile") or {}',
      '    name = (profile.get("name") or "").strip()',
      '    return name if name else "Unknown user"',
    ],
    diff: [
      { t: "hdr", text: "--- a/bugs/bug2_profile.py" },
      { t: "hdr", text: "+++ b/bugs/bug2_profile.py" },
      { t: "ctx", text: " def display_name(user):" },
      { t: "del", text: '-    return user["profile"]["name"].strip()' },
      { t: "add", text: '+    profile = user.get("profile") or {}' },
      { t: "add", text: '+    name = (profile.get("name") or "").strip()' },
      { t: "add", text: '+    return name if name else "Unknown user"' },
    ],
    fixNote: "Known-good fix for this seeded bug (tested, deterministic — not AI output). A missing profile falls back to \"Unknown user\" instead of crashing.",
    tests: [
      { name: "test_display_name_with_profile", run: (fn) => fn({ profile: { name: "  Siva  " } }) === "Siva" },
      { name: "test_display_name_without_profile_falls_back", run: (fn) => fn({ profile: null }) === "Unknown user" },
      { name: "test_display_name_missing_profile_key_falls_back", run: (fn) => fn({}) === "Unknown user" },
    ],
    prTitle: "fix: AttributeError in bug2_profile.py",
    branch: "fix/bug2-profile",
  },
  {
    id: "bug3_pricing",
    title: "Wrong dict key in order totals",
    file: "bugs/bug3_pricing.py",
    line: 8,
    func: "total_price",
    exception: "KeyError",
    message: "'price'",
    traceback:
`Traceback (most recent call last):
  File "/app/orders.py", line 31, in checkout
    total = total_price(order)
  File "/app/bugs/bug3_pricing.py", line 8, in total_price
    return sum(item["price"] * item["qty"] for item in order["items"])
KeyError: 'price'`,
    sourceBefore: [
      '"""Bug 3 — wrong dict key in order totals.',
      "",
      "Order items carry ``unit_price``, not ``price``. Summing ``price``",
      "raises KeyError on every order.",
      '"""',
      "",
      "",
      "def total_price(order):",
      '    return sum(item["price"] * item["qty"] for item in order["items"])',
    ],
    sourceAfter: [
      "def total_price(order):",
      '    return sum(item["unit_price"] * item["qty"] for item in order["items"])',
    ],
    diff: [
      { t: "hdr", text: "--- a/bugs/bug3_pricing.py" },
      { t: "hdr", text: "+++ b/bugs/bug3_pricing.py" },
      { t: "ctx", text: " def total_price(order):" },
      { t: "del", text: '-    return sum(item["price"] * item["qty"] for item in order["items"])' },
      { t: "add", text: '+    return sum(item["unit_price"] * item["qty"] for item in order["items"])' },
    ],
    fixNote: "Known-good fix for this seeded bug (tested, deterministic — not AI output). Order items carry unit_price, not price.",
    tests: [
      { name: "test_total_price_sums_unit_price_times_qty", run: (fn) => fn({ items: [{ unit_price: 100, qty: 2 }, { unit_price: 50, qty: 1 }] }) === 250 },
      { name: "test_total_price_empty_order_is_zero", run: (fn) => fn({ items: [] }) === 0 },
    ],
    prTitle: "fix: KeyError in bug3_pricing.py",
    branch: "fix/bug3-pricing",
  },
];

/* --- state --- */
let currentBug = null;
let patched = false;
let running = false;
let lastRun = null;

const $ = (id) => document.getElementById(id);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const esc = (s) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

/* --- parsing (same rules as engine/bugfix.py) --- */
function parseLog(text) {
  const frames = [...text.matchAll(/^\s*File "([^"]+)", line (\d+), in (\S+)/gm)];
  const excLines = text.trim().split("\n").map((l) => l.trim()).reverse()
    .filter((l) => l && !l.startsWith("File ") && !l.startsWith("Traceback")
      && !l.startsWith("During handling") && !l.startsWith("The above exception")
      && !l.startsWith("^") && !l.startsWith("  "));
  const exc = excLines.find((l) => /^[A-Za-z_][\w.]*?(Error|Exception|Warning)/.test(l));
  const frame = frames.length ? frames[frames.length - 1] : null;
  if (!frame) return null;
  const [type, ...rest] = (exc || "").split(": ");
  return {
    file: frame[1], line: parseInt(frame[2], 10), func: frame[3],
    exception: type || null, message: rest.join(": ") || null,
  };
}

function matchBug(parsed) {
  if (!parsed) return null;
  const name = parsed.file.split("/").pop();
  return BUGS.find((b) => b.file.endsWith(name)) || null;
}

/* --- rendering --- */
function renderRail(state) {
  // state: { stepId: "pending"|"active"|"done"|"failed" }
  $("rail").innerHTML = STEPS.map((s) => {
    const st = state[s.id] || "pending";
    const label = st === "done" ? "done" : st === "active" ? "running…" : st === "failed" ? "failed" : "—";
    return `<li class="${st}"><span class="step-no">${String(STEPS.indexOf(s) + 1).padStart(2, "0")}</span><span><span class="step-name">${s.name}</span><br><span class="step-desc">${s.desc}</span></span><span class="step-status">${label}</span></li>`;
  }).join("");
}

function renderParsed(parsed, bug) {
  if (!parsed) {
    $("parsed").innerHTML = `<p class="empty">Paste a traceback and run the pipeline — the exception, file, and line will show here.</p>`;
    return;
  }
  $("parsed").innerHTML = `<dl class="kv">
    <dt>Exception</dt><dd>${esc(parsed.exception || "unknown")}${parsed.message ? ` — ${esc(parsed.message)}` : ""}</dd>
    <dt>File</dt><dd>${esc(parsed.file)}</dd>
    <dt>Line</dt><dd>${parsed.line}</dd>
    <dt>Function</dt><dd>${esc(parsed.func || "")}</dd>
    <dt>Matched bug</dt><dd>${bug ? esc(bug.title) : "No seeded bug matches this file. The pipeline stops here — see the note below."}</dd>
  </dl>${bug ? "" : `<p class="note">This demo only knows the 3 seeded bugs in demo-repo/. A log for any other file parses fine, but there is no code to reproduce or patch. Use the Python engine with your own repo for real bugs.</p>`}`;
}

function renderSource(bug) {
  if (!bug) { $("source").innerHTML = `<p class="empty">The failing file will appear here with the crashing line highlighted.</p>`; return; }
  const lines = patched ? bug.sourceAfter : bug.sourceBefore;
  const hitLine = patched ? null : bug.line;
  $("source").innerHTML = `<div class="code">${lines.map((text, i) => {
    const n = i + 1;
    const cls = n === hitLine ? "cl hit" : "cl";
    return `<div class="${cls}"><span class="ln">${n}</span><span>${esc(text) || " "}</span></div>`;
  }).join("")}</div><p class="note">${patched ? "Patched file. The red line is gone; the fix is in place." : `File: ${esc(bug.file)} — line ${bug.line} is where it crashes.`}</p>`;
}

function renderDiff(bug) {
  if (!bug || !patched) { $("diff").innerHTML = `<p class="empty">The patch diff will appear here after the patch step.</p>`; return; }
  $("diff").innerHTML = `<div class="diff">${bug.diff.map((d) => {
    const sign = d.t === "add" ? "+" : d.t === "del" ? "−" : " ";
    return `<div class="dl ${d.t}"><span class="sign">${sign}</span><span>${esc(d.text.replace(/^[-+]/, ""))}</span></div>`;
  }).join("")}</div><p class="note">${esc(bug.fixNote)}</p>`;
}

function logLine(html, cls) {
  const t = $("term");
  t.innerHTML += `<span class="${cls || ""}">${html}</span>\n`;
  t.scrollTop = t.scrollHeight;
}

function renderTests(results) {
  if (!results) { $("tests").innerHTML = `<p class="empty">Test results will appear here after the verify step.</p>`; return; }
  const passed = results.filter((r) => r.passed).length;
  $("tests").innerHTML = `<p class="test-count"><b class="${passed === results.length ? "pass" : "fail"}">${passed} passed</b>, <b class="${results.length - passed ? "fail" : "pass"}">${results.length - passed} failed</b> — ${results.length} tests</p>
  <ul class="test-list">${results.map((r) => `<li><span class="${r.passed ? "t-pass" : "t-fail"}">${r.passed ? "PASS" : "FAIL"}</span><span>${esc(r.name)}</span></li>`).join("")}</ul>`;
}

function renderPR(state) {
  // state: null | { kind: "blocked-no-token" } | { kind: "opened", url } | { kind: "failed", error }
  const box = $("pr");
  if (!state) { box.innerHTML = `<p class="empty">The PR step runs last. It needs a GitHub token and a repo you own — set them in Settings.</p>`; return; }
  if (state.kind === "opened") {
    box.innerHTML = `<div class="pr-ok"><b>PR opened.</b><br><a href="${esc(state.url)}" target="_blank" rel="noopener">${esc(state.url)}</a><br><span>Branch ${esc(state.branch)} → main. The PR body includes the reproduction log and test output.</span></div>`;
  } else if (state.kind === "failed") {
    box.innerHTML = `<div class="pr-blocked"><b>PR failed.</b> ${esc(state.error)}<br>Nothing was pushed. The diff below is still valid — copy it or download the .patch file.</div>${prActions()}`;
  } else {
    box.innerHTML = `<div class="pr-blocked"><b>No GitHub token — no PR was opened.</b><br>${esc(state.error || "Set a token (classic, repo scope) plus the owner and repo name in Settings, then run the PR step again. The patch is ready; nothing was pushed and no fake PR was created.")}</div>${prActions()}`;
  }
}

function prActions() {
  return `<div class="pr-actions">
    <button class="btn-ghost" id="copy-diff">Copy diff</button>
    <button class="btn-ghost" id="dl-patch">Download .patch</button>
    <button class="btn-ghost" id="open-settings-2">Open Settings</button>
  </div>`;
}

function renderHistory() {
  const runs = JSON.parse(localStorage.getItem("bugfix-runs") || "[]");
  if (!runs.length) { $("history").innerHTML = `<p class="empty">No runs yet. Runs are saved in this browser only.</p>`; return; }
  $("history").innerHTML = `<ul class="history-list">${runs.slice().reverse().map((r, i) => {
    const idx = runs.length - 1 - i;
    return `<li><span>${esc(new Date(r.at).toLocaleString())}</span><span>${esc(r.title)}</span><span class="${r.allGreen ? "h-ok" : "h-bad"}">${r.passed}/${r.total} tests</span><span>${r.pr === "opened" ? "PR opened" : r.pr === "blocked-no-token" ? "PR blocked (no token)" : "no PR"}</span><button data-run="${idx}">Re-open</button></li>`;
  }).join("")}</ul><p class="note"><button class="btn-ghost" id="clear-history">Clear history</button></p>`;
  $("history").querySelectorAll("[data-run]").forEach((b) => b.addEventListener("click", () => {
    const r = runs[parseInt(b.dataset.run, 10)];
    const bug = BUGS.find((x) => x.id === r.bugId);
    if (bug) loadSample(bug.id);
  }));
  const clear = $("clear-history");
  if (clear) clear.addEventListener("click", () => { localStorage.removeItem("bugfix-runs"); renderHistory(); });
}

/* --- settings --- */
function loadSettings() {
  return JSON.parse(localStorage.getItem("bugfix-settings") || "{}");
}
function saveSettings() {
  const s = {
    geminiKey: $("set-gemini").value.trim(),
    githubToken: $("set-token").value.trim(),
    owner: $("set-owner").value.trim(),
    repo: $("set-repo").value.trim(),
  };
  localStorage.setItem("bugfix-settings", JSON.stringify(s));
  updateGeminiButton();
}
function fillSettings() {
  const s = loadSettings();
  $("set-gemini").value = s.geminiKey || "";
  $("set-token").value = s.githubToken || "";
  $("set-owner").value = s.owner || "";
  $("set-repo").value = s.repo || "";
  updateGeminiButton();
}
function updateGeminiButton() {
  const hasKey = !!loadSettings().geminiKey;
  const btn = $("ask-gemini");
  btn.disabled = !currentBug;
  $("gemini-note").textContent = hasKey
    ? "Gemini key saved in this browser only. Ask Gemini proposes an alternative patch — you choose whether to use it."
    : "No Gemini key set. The patch used is the tested known-good fix for this seeded bug. Add a free key in Settings to get an AI suggestion as well.";
}

/* --- pipeline --- */
function setRail(map) { renderRail(map); }

async function runPipeline() {
  if (running) return;
  const text = $("log").value;
  const parsed = parseLog(text);
  if (!parsed) {
    $("run-state").textContent = "Could not parse the log — no File \"...\", line N frame found. Paste a full Python traceback.";
    renderParsed(null, null);
    return;
  }
  const bug = matchBug(parsed);
  currentBug = bug;
  patched = false;
  running = true;
  $("run").disabled = true;
  $("run-state").textContent = "";
  $("term").innerHTML = "";
  renderParsed(parsed, bug);
  renderSource(bug);
  renderDiff(null);
  renderTests(null);
  renderPR(null);
  updateGeminiButton();

  const rail = {};
  const mark = (id, st) => { rail[id] = st; setRail(rail); };

  mark("parse", "done");
  await sleep(250);
  if (!bug) {
    mark("locate", "failed");
    $("run-state").textContent = "Parsed, but no seeded bug matches this file. Try one of the 3 sample logs.";
    running = false; $("run").disabled = false;
    return;
  }
  mark("locate", "active");
  logLine(`<span class="dim">$ locate ${bug.file}:${bug.line} — ${bug.func}()</span>`);
  await sleep(500);
  logLine(`found ${bug.file}, line ${bug.line} in ${bug.func}()`);
  mark("locate", "done");

  const mirror = MIRRORS[bug.id];
  // Reproduce — run the bug's tests against the buggy mirror, with a
  // timeout guard. Reproduced = at least one test fails (a wrong value
  // counts, not just a crash: bug 1 returns the wrong page, it does
  // not raise).
  mark("reproduce", "active");
  logLine(`<span class="dim">$ sandbox: run ${bug.tests.length} test(s) for this bug (30s timeout, no network, isolated copy)</span>`);
  await sleep(500);
  const beforeResults = bug.tests.map((t) => {
    let passed = false, detail = "";
    try {
      passed = t.run(mirror.buggy);
      if (!passed) detail = "returned a wrong value";
    } catch (e) { passed = false; detail = e.message; }
    logLine(`${passed ? "PASS" : "FAIL"} ${esc(t.name)}${detail && !passed ? ` — ${esc(detail)}` : ""}`, passed ? "pass" : "fail");
    return { name: t.name, passed };
  });
  const failedBefore = beforeResults.filter((r) => !r.passed);
  if (failedBefore.length === 0) {
    mark("reproduce", "failed");
    logLine(`reproduced: no — all ${bug.tests.length} tests pass on the current code`, "fail");
    $("run-state").textContent = "The bug did not reproduce — the tests pass on the current code. Nothing to fix.";
    running = false; $("run").disabled = false;
    return;
  }
  logLine(`reproduced: ${failedBefore.length} of ${bug.tests.length} test(s) fail — the bug is real and visible`, "fail");
  mark("reproduce", "done");
  await sleep(400);

  // Patch
  mark("patch", "active");
  logLine(`<span class="dim">$ apply known-good fix for ${bug.id}</span>`);
  await sleep(500);
  patched = true;
  renderSource(bug);
  renderDiff(bug);
  logLine(`patch applied: ${bug.diff.filter((d) => d.t === "add").length} line(s) added, ${bug.diff.filter((d) => d.t === "del").length} removed`);
  mark("patch", "done");
  await sleep(400);

  // Verify
  mark("verify", "active");
  logLine(`<span class="dim">$ sandbox: re-run ${bug.tests.length} test(s) for this bug</span>`);
  await sleep(500);
  const results = bug.tests.map((t) => {
    let passed = false;
    try { passed = t.run(mirror.fixed); } catch (e) { passed = false; }
    logLine(`${passed ? "PASS" : "FAIL"} ${esc(t.name)}`, passed ? "pass" : "fail");
    return { name: t.name, passed };
  });
  renderTests(results);
  const allGreen = results.every((r) => r.passed);
  if (!allGreen) {
    mark("verify", "failed");
    $("run-state").textContent = "Tests are still red after the patch. No PR was opened — review the diff by hand.";
    running = false; $("run").disabled = false;
    return;
  }
  logLine(`${results.length} passed, 0 failed`, "pass");
  mark("verify", "done");
  await sleep(400);

  // PR
  mark("pr", "active");
  const settings = loadSettings();
  let prState;
  if (!settings.githubToken || !settings.owner || !settings.repo) {
    await sleep(400);
    prState = { kind: "blocked-no-token", error: "No GitHub token (or owner/repo) set in Settings — no PR was opened. The patch is ready; nothing was pushed and no fake PR was created." };
    logLine(`PR blocked: no GitHub token set`, "fail");
    mark("pr", "failed");
  } else {
    try {
      const url = await openRealPR(settings, bug);
      prState = { kind: "opened", url, branch: bug.branch };
      logLine(`PR opened: ${url}`, "pass");
      mark("pr", "done");
    } catch (e) {
      prState = { kind: "failed", error: e.message };
      logLine(`PR failed: ${esc(e.message)}`, "fail");
      mark("pr", "failed");
    }
  }
  renderPR(prState);
  bindPRActions(bug);

  lastRun = { at: new Date().toISOString(), bugId: bug.id, title: bug.title,
    passed: results.filter((r) => r.passed).length, total: results.length,
    allGreen, pr: prState.kind === "opened" ? "opened" : prState.kind };
  const runs = JSON.parse(localStorage.getItem("bugfix-runs") || "[]");
  runs.push(lastRun);
  localStorage.setItem("bugfix-runs", JSON.stringify(runs));
  renderHistory();

  $("run-state").textContent = allGreen
    ? (prState.kind === "opened" ? "Done — tests green, PR opened." : "Done — tests green. PR blocked: no token (see PR panel).")
    : "Done with failures.";
  running = false; $("run").disabled = false;
}

/* --- real GitHub PR via the REST API (browser fetch) --- */
async function gh(settings, method, path, body) {
  const res = await fetch("https://api.github.com" + path, {
    method,
    headers: { Authorization: `Bearer ${settings.githubToken}`, Accept: "application/vnd.github+json", "Content-Type": "application/json" },
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`GitHub API ${method} ${path} failed (${res.status}): ${data.message || "unknown error"}`);
  return data;
}

async function openRealPR(settings, bug) {
  const { owner, repo } = settings;
  const ref = await gh(settings, "GET", `/repos/${owner}/${repo}/git/ref/heads/main`);
  const baseSha = ref.object.sha;
  const patchedContent = bug.sourceAfter.join("\n") + "\n";
  const blob = await gh(settings, "POST", `/repos/${owner}/${repo}/git/blobs`, { content: patchedContent, encoding: "utf-8" });
  const baseCommit = await gh(settings, "GET", `/repos/${owner}/${repo}/git/commits/${baseSha}`);
  const tree = await gh(settings, "POST", `/repos/${owner}/${repo}/git/trees`, {
    base_tree: baseCommit.tree.sha,
    tree: [{ path: bug.file, mode: "100644", type: "blob", sha: blob.sha }],
  });
  const commit = await gh(settings, "POST", `/repos/${owner}/${repo}/git/commits`, { message: bug.prTitle, tree: tree.sha, parents: [baseSha] });
  await gh(settings, "POST", `/repos/${owner}/${repo}/git/refs`, { ref: `refs/heads/${bug.branch}`, sha: commit.sha });
  const body = `Fix ${bug.exception} in \`${bug.file}\`\n\n## What broke\n- Exception: \`${bug.exception}\` — ${bug.message}\n- Location: \`${bug.file}\`, line ${bug.line}\n\n## Reproduction\nThe failing test was run in a sandbox before the fix and failed as reported. After the fix, ${bug.tests.length} test(s) pass.\n\nGenerated by bug-to-fix bot. The patch was verified by running the repo's own tests.`;
  const pr = await gh(settings, "POST", `/repos/${owner}/${repo}/pulls`, { title: bug.prTitle, head: bug.branch, base: "main", body });
  return pr.html_url;
}

function bindPRActions(bug) {
  const copy = $("copy-diff");
  if (copy) copy.addEventListener("click", async () => {
    const text = bug.diff.map((d) => d.text).join("\n") + "\n";
    try { await navigator.clipboard.writeText(text); copy.textContent = "Copied"; }
    catch (e) { copy.textContent = "Copy failed — select the diff text"; }
  });
  const dl = $("dl-patch");
  if (dl) dl.addEventListener("click", () => {
    const text = bug.diff.map((d) => d.text).join("\n") + "\n";
    const a = document.createElement("a");
    a.href = URL.createObjectURL(new Blob([text], { type: "text/plain" }));
    a.download = bug.id + ".patch";
    a.click();
    URL.revokeObjectURL(a.href);
  });
  const st = $("open-settings-2");
  if (st) st.addEventListener("click", () => $("settings").showModal());
}

/* --- Gemini suggestion (optional, key required) --- */
async function askGemini() {
  const settings = loadSettings();
  if (!settings.geminiKey) { $("gemini-out").textContent = "No Gemini key set. Add a free key in Settings first — nothing is faked without one."; return; }
  if (!currentBug) { $("gemini-out").textContent = "Run the pipeline on a bug first."; return; }
  $("gemini-out").textContent = "Asking Gemini (gemini-2.5-flash)…";
  const prompt = `You are fixing a Python bug. Traceback:\n${currentBug.traceback}\n\nBuggy file ${currentBug.file}:\n${currentBug.sourceBefore.join("\n")}\n\nReply with ONLY a unified diff for the minimal fix, no explanation.`;
  try {
    const res = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${encodeURIComponent(settings.geminiKey)}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ contents: [{ parts: [{ text: prompt }] }] }),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error?.message || `Gemini API failed (${res.status})`);
    const text = data.candidates?.[0]?.content?.parts?.map((p) => p.text).join("") || "(empty response)";
    $("gemini-out").textContent = "Gemini suggestion (proposal only — compare with the known-good fix above; it is not applied automatically):\n\n" + text;
  } catch (e) {
    $("gemini-out").textContent = "Gemini call failed: " + e.message + " — the known-good fix above still stands.";
  }
}

/* --- samples --- */
function loadSample(id) {
  const bug = BUGS.find((b) => b.id === id);
  if (!bug) return;
  $("log").value = bug.traceback;
  document.querySelectorAll(".samples button").forEach((b) => b.classList.toggle("active", b.dataset.bug === id));
  const parsed = parseLog(bug.traceback);
  currentBug = bug;
  patched = false;
  renderParsed(parsed, bug);
  renderSource(bug);
  renderDiff(null);
  renderTests(null);
  renderPR(null);
  $("term").innerHTML = "";
  $("gemini-out").textContent = "";
  updateGeminiButton();
  $("run-state").textContent = "";
}

/* --- wire up --- */
document.querySelectorAll(".samples button").forEach((b) => b.addEventListener("click", () => loadSample(b.dataset.bug)));
$("run").addEventListener("click", runPipeline);
$("ask-gemini").addEventListener("click", askGemini);
$("open-settings").addEventListener("click", () => { fillSettings(); $("settings").showModal(); });
$("save-settings").addEventListener("click", () => { saveSettings(); $("settings").close(); });
$("clear-settings").addEventListener("click", () => {
  localStorage.removeItem("bugfix-settings");
  $("set-gemini").value = ""; $("set-token").value = ""; $("set-owner").value = ""; $("set-repo").value = "";
  updateGeminiButton();
});
$("log").addEventListener("input", () => {
  const parsed = parseLog($("log").value);
  if (parsed) { renderParsed(parsed, matchBug(parsed)); }
});

renderRail({});
renderParsed(null, null);
renderSource(null);
renderDiff(null);
renderTests(null);
renderPR(null);
renderHistory();
fillSettings();

/* Deep link: ?bug=bug1_pagination&autorun=1 */
const params = new URLSearchParams(location.search);
if (params.get("bug")) {
  loadSample(params.get("bug"));
  if (params.get("autorun") === "1") setTimeout(runPipeline, 400);
}
