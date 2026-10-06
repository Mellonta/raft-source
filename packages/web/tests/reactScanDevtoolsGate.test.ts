import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import assert from "node:assert/strict";
import ts from "typescript";

// True when `await` (or `for await`) runs at module top level, i.e. outside any function.
function hasTopLevelAwait(source: string): boolean {
  const file = ts.createSourceFile("main.tsx", source, ts.ScriptTarget.Latest, false, ts.ScriptKind.TSX);
  const visit = (node: ts.Node): boolean => {
    if (ts.isFunctionLike(node)) return false;
    if (ts.isAwaitExpression(node)) return true;
    if (ts.isForOfStatement(node) && node.awaitModifier) return true;
    return ts.forEachChild(node, visit) ?? false;
  };
  return visit(file);
}

const webRoot = resolve(import.meta.dirname, "..");

test("React Scan devtools are switch-off by default for shared dev preview", () => {
  const mainSource = readFileSync(resolve(webRoot, "src/main.tsx"), "utf8");
  const devtoolsSource = readFileSync(resolve(webRoot, "src/devtools/localReactDevTools.ts"), "utf8");
  const envExample = readFileSync(resolve(webRoot, ".env.example"), "utf8");

  assert.match(mainSource, /import\.meta\.env\.DEV\s*\?\s*import\("\.\/devtools\/localReactDevTools"\)/);
  // A top-level await anywhere in the graph makes Rolldown skip common-chunk
  // merging for the whole production build, so the dev gate must not use one.
  assert.equal(hasTopLevelAwait(mainSource), false, "src/main.tsx must not use top-level await");
  assert.doesNotMatch(
    mainSource,
    /import\.meta\.env\.DEV\s*&&\s*import\.meta\.env\.VITE_ENABLE_REACT_SCAN\s*===\s*"true"/,
  );

  assert.match(devtoolsSource, /import\("react-scan"\)/);
  assert.match(devtoolsSource, /initiallyEnabled\s*=\s*import\.meta\.env\.VITE_ENABLE_REACT_SCAN\s*===\s*"true"/);
  assert.match(devtoolsSource, /enabled:\s*initiallyEnabled/);
  assert.match(devtoolsSource, /showToolbar:\s*true/);
  assert.match(envExample, /VITE_ENABLE_REACT_SCAN=true/);
  assert.match(envExample, /screenshots, and screen recordings/);
});
