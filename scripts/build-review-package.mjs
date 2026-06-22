#!/usr/bin/env node
// build-review-package.mjs — machine-generate the Current Worktree Inventory (RD-6)
//
// Phase 2 hand-assembled the worktree inventory + stats; the rename old/new
// expansion and the four count fields were error-prone to hand-count. This
// generator owns those facts so the main agent never hand-counts them and the
// final reviewer gets an authoritative inventory. Works for both agenthub and
// standalone review packages.
//
// `git status --porcelain=v1` line format:
//   XY <path>                 (modified/added/deleted/staged/unstaged)
//   ?? <path>                 (untracked)
//   R  <old> -> <new>         (rename; C is copy, same arrow form)
//
// Usage (CLI):
//   build-review-package.mjs            # runs `git status --porcelain=v1` in cwd
//   build-review-package.mjs --status-file=<path>   # read porcelain from a file
//   build-review-package.mjs --json     # emit JSON instead of markdown
// Module usage:
//   import { buildWorktreeInventory, renderInventoryMarkdown } from "./build-review-package.mjs";
import fs from "node:fs";
import { execSync } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";

// ── inline storage-layout (mirror host/storage-layout.ts:21-40; .mjs cannot import .ts) ──
// detectLayout judges ONLY on `<taskDir>/.machine/layout-version.json` existence.
function sourceStatePath(taskDir) {
  const sourceDerived = existsSync(join(taskDir, ".machine", "layout-version.json"));
  return sourceDerived
    ? join(taskDir, ".machine", "source", "state.json")
    : join(taskDir, "state.json");
}
// resolve current task's changeId to scope `specs/<changeId>/`.
// Returns null when no task-dir / no readable changeId (caller then does NO filtering = fail-open).
function resolveChangeId(taskDir) {
  if (!taskDir) return null;
  try {
    const st = JSON.parse(fs.readFileSync(sourceStatePath(taskDir), "utf8"));
    if (st && typeof st.changeId === "string" && st.changeId) return st.changeId;
    if (st && typeof st.taskId === "string" && st.taskId) return st.taskId;  // mirror state?.changeId || taskId
  } catch { /* fall through → null → fail-open */ }
  return null;
}
// An untracked `specs/...` path belongs to ANOTHER task iff it is under specs/
// but NOT under specs/<thisChangeId>/. Non-specs untracked paths are never filtered.
function isOtherTaskSpec(relpath, changeId) {
  if (!changeId) return false;                       // no signal → filter nothing
  if (!relpath.startsWith("specs/")) return false;   // only specs/ is task-partitioned
  return !relpath.startsWith(`specs/${changeId}/`);
}

// ── parse `git status --porcelain=v1` into structured rows + exact stats ──
export function buildWorktreeInventory(porcelain) {
  const text = String(porcelain || "");
  const lines = text.split("\n").map((l) => l.replace(/\r$/, "")).filter((l) => l.length > 0);

  const rows = [];
  const uniquePaths = new Set();
  let renameOldNewCount = 0;
  let untrackedCount = 0;
  let deletedCount = 0;

  for (const line of lines) {
    const xy = line.slice(0, 2);
    const rest = line.slice(3); // skip "XY "
    const isRename = /[RC]/.test(xy);
    const isUntracked = xy === "??";
    const isDeleted = xy.includes("D");

    if (isRename && rest.includes(" -> ")) {
      const [oldPath, newPath] = rest.split(" -> ").map((s) => s.trim());
      for (const p of [oldPath, newPath]) {
        rows.push({ status: xy, path: p, classification: "unclassified", reason: "" });
        uniquePaths.add(p);
        renameOldNewCount += 1;
      }
    } else {
      const path = rest.trim();
      rows.push({ status: xy, path, classification: "unclassified", reason: "" });
      uniquePaths.add(path);
    }

    if (isUntracked) untrackedCount += 1;
    if (isDeleted) deletedCount += 1;
  }

  return {
    rows,
    stats: {
      statusLineCount: lines.length,
      uniquePathCount: uniquePaths.size,
      renameOldNewCount,
      untrackedCount,
      deletedCount,
    },
  };
}

// ── FR-REVMAIN-002 (T010): untracked file size cap ──
// Untracked files are embedded whole because `git diff HEAD` does not show them.
// Large untracked files can inflate the review package significantly (a 200KB spec
// draft would otherwise be inlined in full). Cap at UNTRACKED_MAX_BYTES: truncate
// the body and append a clearly-marked truncation notice so the reviewer knows
// there is more content and can read it from the path in the worktree inventory.
// The cap is intentionally generous (32 KiB) — enough for real spec/plan drafts
// while protecting against accidental large binary-adjacent files being inlined.
const UNTRACKED_MAX_BYTES = 32768; // 32 KiB

// ── FR-RVW-002: gather the ACTUAL changed-file content so the review package is
// self-contained (reviewer must not have to go read files elsewhere). For tracked
// changes we embed `git diff HEAD` (staged + unstaged); for untracked files (which a
// diff against HEAD does not show) we embed their full current content. ──
export function gatherChangedContent(repoDir, inventory, changeId /* = null */) {
  const cwd = repoDir || process.cwd();
  let trackedDiff = "";
  try {
    // Include both staged and unstaged changes relative to HEAD.
    trackedDiff = execSync("git diff HEAD", { cwd, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
  } catch {
    trackedDiff = "";
  }
  const untracked = [];
  for (const r of inventory.rows) {
    if (r.status === "??") {
      // R1 other-task pollution guard: an untracked specs/ path belonging to a
      // DIFFERENT task's changeId is not embedded (body withheld). The inventory
      // row still lists the path, so visibility / step-3b-1 classification is kept.
      if (isOtherTaskSpec(r.path, changeId)) {
        untracked.push({ path: r.path, body: "(omitted — belongs to another task's specs/<changeId>)" });
        continue;
      }
      try {
        const raw = fs.readFileSync(`${cwd}/${r.path}`, "utf8");
        // FR-REVMAIN-002: cap large untracked file bodies at UNTRACKED_MAX_BYTES.
        // Gate and truncate by UTF-8 BYTES (not JS char count) so multibyte content
        // (e.g. CJK, 3 bytes/char) is correctly bounded. Small files pass through whole.
        // We walk back from the byte cap to the nearest non-continuation byte to avoid
        // splitting a multibyte sequence (Node's toString("utf8") emits U+FFFD for
        // incomplete sequences rather than dropping them, which would exceed the cap).
        const totalBytes = Buffer.byteLength(raw, "utf8");
        let body;
        if (totalBytes > UNTRACKED_MAX_BYTES) {
          const buf = Buffer.from(raw, "utf8");
          let cutAt = UNTRACKED_MAX_BYTES;
          // UTF-8 continuation bytes are 10xxxxxx (0x80–0xBF); walk back to a sequence start.
          while (cutAt > 0 && (buf[cutAt] & 0xC0) === 0x80) {
            cutAt--;
          }
          const kept = buf.subarray(0, cutAt).toString("utf8");
          const keptBytes = Buffer.byteLength(kept, "utf8");
          body = kept
            + `\n\n[truncated: ${keptBytes} bytes of ${totalBytes} total — untracked size cap (UNTRACKED_MAX_BYTES=${UNTRACKED_MAX_BYTES}); read full file from path for complete content]`;
        } else {
          body = raw;
        }
        untracked.push({ path: r.path, body });
      } catch {
        untracked.push({ path: r.path, body: "(unreadable — binary or removed)" });
      }
    }
  }
  return { trackedDiff, untracked };
}

// ── render the embedded changed-file content section ──
export function renderChangedContentMarkdown(changed) {
  const lines = [
    "## Changed File Contents",
    "",
    "Self-contained changed-file content for this review (do not go read these files elsewhere).",
    "",
  ];
  lines.push("### Tracked Changes (git diff HEAD)", "");
  if (changed.trackedDiff && changed.trackedDiff.trim()) {
    lines.push("```diff", changed.trackedDiff.replace(/\n$/, ""), "```", "");
  } else {
    lines.push("(no tracked changes)", "");
  }
  lines.push("### Untracked Files (full content)", "");
  if (changed.untracked.length === 0) {
    lines.push("(no untracked files)", "");
  } else {
    for (const u of changed.untracked) {
      lines.push(`#### ${u.path}`, "", "```", u.body.replace(/\n$/, ""), "```", "");
    }
  }
  return lines.join("\n");
}

// ── render the inventory as the `## Current Worktree Inventory` review-package section ──
export function renderInventoryMarkdown(inventory) {
  const { rows, stats } = inventory;
  const lines = [
    "## Current Worktree Inventory",
    "",
    "Machine-generated from `git status --porcelain=v1` (authoritative; do not hand-edit).",
    "",
    "### Inventory Stats",
    "",
    `- statusLineCount: ${stats.statusLineCount}`,
    `- uniquePathCount: ${stats.uniquePathCount}`,
    `- renameOldNewCount: ${stats.renameOldNewCount}`,
    `- untrackedCount: ${stats.untrackedCount}`,
    `- deletedCount: ${stats.deletedCount}`,
    "",
    "### Structured Inventory",
    "",
    "| status | path | classification | reason |",
    "|---|---|---|---|",
  ];
  for (const r of rows) {
    lines.push(`| \`${r.status}\` | ${r.path} | ${r.classification} | ${r.reason} |`);
  }
  lines.push("");
  return lines.join("\n");
}

// ── CLI ──
function isMain() {
  return process.argv[1] && process.argv[1].endsWith("build-review-package.mjs");
}
if (isMain()) {
  const args = process.argv.slice(2);
  const get = (n) => {
    const a = args.find((x) => x.startsWith(`--${n}=`));
    return a ? a.slice(n.length + 3) : undefined;
  };
  const statusFile = get("status-file");
  const repoDir = get("repo") || process.cwd();
  const taskDir = get("task-dir");                 // NEW
  const changeId = resolveChangeId(taskDir);       // NEW — null when absent (fail-open)
  let porcelain;
  if (statusFile) {
    porcelain = fs.readFileSync(statusFile, "utf8");
  } else {
    porcelain = execSync("git status --porcelain=v1 -uall", { cwd: repoDir, encoding: "utf8" });
  }
  const inv = buildWorktreeInventory(porcelain);
  // FR-RVW-002: embed the actual changed-file content so the package is self-contained.
  const changed = gatherChangedContent(repoDir, inv, changeId);    // CHANGED — pass changeId
  if (args.includes("--json")) {
    process.stdout.write(JSON.stringify({ ...inv, changed }, null, 2) + "\n");
  } else {
    process.stdout.write(renderInventoryMarkdown(inv) + "\n");
    process.stdout.write(renderChangedContentMarkdown(changed) + "\n");
  }
}
