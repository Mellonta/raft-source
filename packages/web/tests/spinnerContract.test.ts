import assert from "node:assert/strict";
import { execSync } from "node:child_process";
import { readFileSync, readdirSync } from "node:fs";
import { relative, resolve } from "node:path";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import ts from "typescript";
import { Spinner } from "raft-ui";

const repoRoot = resolve(import.meta.dirname, "..");
const read = (path: string) => readFileSync(resolve(repoRoot, path), "utf8");
const sourceFiles = (directory: string): string[] => readdirSync(directory, { withFileTypes: true })
  .flatMap((entry) => {
    const path = resolve(directory, entry.name);
    if (entry.isDirectory()) return sourceFiles(path);
    return /\.(?:ts|tsx)$/.test(entry.name) ? [path] : [];
  });

test("Spinner exposes xs/sm/md/lg + default/inverse + ring visual", () => {
  const xsDefault = renderToStaticMarkup(
    createElement(Spinner, { size: "xs" }),
  );
  const smDefault = renderToStaticMarkup(
    createElement(Spinner, { size: "sm" }),
  );
  const mdDefault = renderToStaticMarkup(
    createElement(Spinner, { size: "md" }),
  );
  const lgInverse = renderToStaticMarkup(
    createElement(Spinner, { size: "lg", variant: "inverse" }),
  );

  // Size axis is physical px tuned to the existing inline spinners the
  // primitive replaces. Don't add intermediate tiers without first
  // checking that no existing callsite already fits an existing tier.
  assert.match(xsDefault, /size-2\.5/);
  assert.match(smDefault, /size-4/);
  assert.match(mdDefault, /size-5/);
  assert.match(lgInverse, /size-8/);

  // Ring visual: rounded-full + animate-spin + border-2 with track + tip.
  assert.match(mdDefault, /rounded-full/);
  assert.match(mdDefault, /animate-spin/);
  assert.match(mdDefault, /border-2/);

  // Tone is owned by the RUI recipe: the ring paints with currentColor and the
  // root carries the tone (black on light, white on dark).
  assert.match(mdDefault, /text-black/);
  assert.match(mdDefault, /border-current\/20 border-t-current/);

  assert.match(lgInverse, /text-white/);
  assert.match(lgInverse, /border-current\/40 border-t-current/);
  // The adapter keeps the public RUI Spinner recipe wired in.
  assert.match(mdDefault, /data-slot="spinner"|data-spinner-ring|relative inline-flex/);

  // role=status + aria-label so screen readers announce the loading state
  // (the inline div spinners this replaces had no a11y at all).
  assert.match(mdDefault, /role="status"/);
  assert.match(mdDefault, /aria-label="Loading"/);
});

test("Spinner accepts an aria-label override and merges className", () => {
  const html = renderToStaticMarkup(
    createElement(Spinner, {
      size: "sm",
      "aria-label": "Uploading",
      className: "absolute bottom-2 right-2",
    }),
  );
  assert.match(html, /aria-label="Uploading"/);
  assert.match(html, /absolute bottom-2 right-2/);
});

test("no inline ring-style `rounded-full ... animate-spin` div outside Spinner.tsx", () => {
  // Pure CSS ring spinners must go through <Spinner>. Catches the pattern
  // `<div className="... rounded-full ... animate-spin ..." />` and its
  // span equivalent. Lucide icons spinning (RefreshCw, Loader2) are a
  // different concern — handled by the next test.
  const componentsDir = resolve(repoRoot, "src");
  let hits = "";
  try {
    hits = execSync(
      `grep -RnE '<(div|span)[^>]*rounded-full[^>]*animate-spin' ${componentsDir}`,
      { encoding: "utf8" },
    );
  } catch (err: any) {
    if (err.status === 1) hits = "";
    else throw err;
  }
  // Spinner.tsx is the only file allowed to emit this pattern.
  const allowed = hits
    .split("\n")
    .filter((line) => line && !line.includes("/components/ui/Spinner.tsx"))
    .join("\n");
  assert.equal(
    allowed.trim(),
    "",
    `inline ring spinners are banned — use <Spinner> instead:\n${allowed}`,
  );
});

test("no generic lucide `animate-spin` loader outside Spinner.tsx", () => {
  // Key the guard to the behavior, not whichever loader icon name happened
  // to be migrated first. A spinning refresh glyph is the affordance for its
  // own action; every other lucide spinner must use the shared <Spinner>.
  const affordanceAllowlist = new Set(["RefreshCw"]);
  const violations: string[] = [];

  for (const file of sourceFiles(resolve(repoRoot, "src"))) {
    const source = readFileSync(file, "utf8");
    const sourceFile = ts.createSourceFile(
      file,
      source,
      ts.ScriptTarget.Latest,
      true,
      file.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
    );
    const lucideLocals = new Set<string>();
    sourceFile.forEachChild((node) => {
      if (
        !ts.isImportDeclaration(node)
        || !ts.isStringLiteral(node.moduleSpecifier)
        || node.moduleSpecifier.text !== "lucide-react"
        || !node.importClause?.namedBindings
        || !ts.isNamedImports(node.importClause.namedBindings)
      ) return;
      for (const specifier of node.importClause.namedBindings.elements) {
        lucideLocals.add(specifier.name.text);
      }
    });

    const inspect = (node: ts.Node) => {
      if (ts.isJsxSelfClosingElement(node) || ts.isJsxOpeningElement(node)) {
        const icon = ts.isIdentifier(node.tagName) ? node.tagName.text : null;
        const spins = node.attributes.properties.some((property) => (
          ts.isJsxAttribute(property)
          && property.name.getText(sourceFile) === "className"
          && property.initializer?.getText(sourceFile).includes("animate-spin")
        ));
        if (
          icon
          && spins
          && lucideLocals.has(icon)
          && !affordanceAllowlist.has(icon)
        ) {
          const line = sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile)).line + 1;
          violations.push(`${relative(repoRoot, file)}:${line}: <${icon}>`);
        }
      }
      ts.forEachChild(node, inspect);
    };
    inspect(sourceFile);
  }

  assert.equal(
    violations.join("\n"),
    "",
    `generic spinning lucide icons are banned — use <Spinner> instead:\n${violations.join("\n")}`,
  );
});

test("migrated callsites import and use Spinner", () => {
  const imageLightbox = read("src/components/ImageLightbox.tsx");
  const attachmentChip = read("src/components/message/AttachmentChip.tsx");
  const messageItem = read("src/components/message/MessageItem.tsx");
  const messageInput = read("src/components/message/MessageInput.tsx");
  const selectModeToolbar = read("src/components/message/SelectModeToolbar.tsx");
  const agentWorkspace = read("src/components/agent/AgentWorkspace.tsx");

  assert.match(imageLightbox, /import\s*\{[^}]*\bSpinner\b[^}]*\}\s*from\s*"raft-ui"/);
  assert.match(imageLightbox, /<Spinner size="lg" variant="inverse"/);

  assert.match(attachmentChip, /import\s*\{[^}]*\bSpinner\b[^}]*\}\s*from\s*"raft-ui"/);
  assert.match(attachmentChip, /<Spinner size="sm"/);

  assert.match(messageItem, /import\s*\{[^}]*\bSpinner\b[^}]*\}\s*from\s*"raft-ui"/);
  assert.match(messageItem, /<Spinner size="xs"/);
  assert.match(messageItem, /<Spinner size="md" variant="inverse"/);

  assert.match(messageInput, /import\s*\{[^}]*\bSpinner\b[^}]*\}\s*from\s*"raft-ui"/);
  assert.match(messageInput, /<Spinner size="sm"/);

  assert.match(selectModeToolbar, /import\s*\{[^}]*\bSpinner\b[^}]*\}\s*from\s*"raft-ui"/);
  assert.match(selectModeToolbar, /<Spinner size="sm"/);

  assert.match(agentWorkspace, /import\s*\{[^}]*\bSpinner\b[^}]*\}\s*from\s*"raft-ui"/);
  assert.match(agentWorkspace, /<Spinner size="xs"/);
});
