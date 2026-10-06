import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, resolve } from "node:path";

const srcRoot = resolve(import.meta.dirname, "../src");

/**
 * Elegant palette call-site guard (task #623).
 *
 * `--primary-50..950` and `--accent-50..950` and `--color-soft-signal` only
 * exist as the brutal palette (the numeric scales are defined in the default
 * / brutal scope only). Any call site that renders them without a
 * `theme-brutal:` guard paints brutal yellow/pink inside the elegant family —
 * that is the bug this task cleaned up, and this guard is the ratchet that
 * keeps it out:
 *
 *   - a `theme-brutal:`-prefixed token is always fine (that IS the guard);
 *   - a line evaluating an `isBrutal` / `=== "brutal"` / `data-theme="brutal"`
 *     branch is fine (the miniature previews pick the brutal palette on
 *     purpose, per family);
 *   - comments are ignored;
 *   - the files below keep their brutal palette on purpose and are listed
 *     with the ruling or reason next to them.
 *
 * Replacements go to the semantic pair instead: `*-soft` / `*-strong`
 * (buttons/faces) and the `theme-brutal:` override keeps the old look.
 */

const INTENTIONAL: ReadonlyArray<readonly [file: string, reason: string]> = [
  ["components/layout/LeftRail.tsx", "brand signature strip — intentional across all themes (Grace ruling)"],
  ["components/auth/ServerCreatePreview.tsx", "onboarding brutal mock (A1)"],
  ["components/auth/AccountIdentitySetupPage.tsx", "onboarding brutal mock (A1)"],
  ["components/onboarding/ServerSetupHandoffStep.tsx", "onboarding brutal mock (A1)"],
  ["pages/PaletteAuditPage.tsx", "brutal palette audit page — the yellow is the content"],
  ["components/workspace/WorkspaceGridDemo.tsx", "workspace grid demo palette"],
  ["components/workspace/WorkspaceGridRealPanel.tsx", "workspace grid palette"],
  ["components/workspace/WorkspaceGridDemo.css", "workspace grid demo palette"],
  ["components/ConfirmDialog.tsx", "legacy class-string → rui variant map (keys are identifiers, not rendered)"],
  ["index.css", "token table (definitions + global ::selection now on the semantic pair)"],
];

const TOKEN = /(?:^|[\s"'`({[])((?:[a-z-]+(?:\/[a-z-]+)?:)*)((?:bg|text|border|ring|fill|stroke|outline|shadow|decoration|divide|from|to|via|caret|accent|placeholder)-)(soft-signal|primary-(?:50|[1-9]00|950)|accent-(?:50|[1-9]00|950))/g;

function isCommentLine(line: string): boolean {
  const trimmed = line.trim();
  return trimmed.startsWith("//") || trimmed.startsWith("*") || trimmed.startsWith("/*");
}

function isBrutalScoped(line: string): boolean {
  return (
    /\bisBrutal\b/.test(line) ||
    /===\s*"brutal"/.test(line) ||
    /data-theme="brutal"/.test(line) ||
    /data-theme='brutal'/.test(line)
  );
}

/** Returns the offending `prefix+utility+family` tokens on one line. */
export function findElegantPaletteOffenders(line: string): string[] {
  if (isCommentLine(line) || isBrutalScoped(line)) return [];
  const offenders: string[] = [];
  for (const match of line.matchAll(TOKEN)) {
    const prefix = match[1] ?? "";
    if (prefix.includes("theme-brutal:")) continue;
    offenders.push(`${prefix}${match[2]}${match[3]}`);
  }
  return offenders;
}

function walk(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      out.push(...walk(full));
    } else if (/\.(ts|tsx|css)$/.test(entry)) {
      out.push(full);
    }
  }
  return out;
}

test("CONTROL: the scanner flags an unguarded palette token", () => {
  assert.deepEqual(findElegantPaletteOffenders('className="bg-soft-signal/30"'), [
    "bg-soft-signal",
  ]);
  assert.deepEqual(findElegantPaletteOffenders('className="hover:bg-primary-400"'), [
    "hover:bg-primary-400",
  ]);
  assert.deepEqual(findElegantPaletteOffenders('className="text-primary-950/70"'), [
    "text-primary-950",
  ]);
  // …and clears every allowed shape.
  assert.deepEqual(findElegantPaletteOffenders('className="theme-brutal:bg-primary-400"'), []);
  assert.deepEqual(findElegantPaletteOffenders("// historic: bg-soft-signal/30 hover"), []);
  assert.deepEqual(
    findElegantPaletteOffenders('className={`${isBrutal ? "bg-primary-400" : "bg-primary-soft"}`}'),
    [],
  );
});

test("no unguarded brutal-palette call sites outside the intentional surfaces", () => {
  const allowed = new Set(INTENTIONAL.map(([file]) => file));
  const offenders: string[] = [];
  for (const file of walk(srcRoot)) {
    const rel = relative(srcRoot, file);
    if (allowed.has(rel)) continue;
    const lines = readFileSync(file, "utf8").split("\n");
    lines.forEach((line, index) => {
      for (const token of findElegantPaletteOffenders(line)) {
        offenders.push(`${rel}:${index + 1}: ${token}`);
      }
    });
  }
  assert.deepEqual(
    offenders,
    [],
    `Unguarded brutal-palette call sites found. Use the semantic pair (*-soft / *-strong), or prefix the token with theme-brutal: when the brutal look is intended:\n${offenders.join("\n")}`,
  );
});
