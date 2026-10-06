import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createRequire } from "node:module";
import { readFileSync, realpathSync } from "node:fs";
import { dirname, extname, join, relative, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import ts from "typescript";

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const repoRoot = resolve(packageRoot, "../..");
const packageName = "@botiverse/raft-shared";

const expectedExports = {
  ".": {
    types: "./src/index.ts",
    default: "./src/index.ts",
  },
  "./feature-flag-admin-privileges": {
    types: "./feature-flag-admin-privileges.ts",
    default: "./feature-flag-admin-privileges.ts",
  },
  "./feature-flag-client-rules": {
    types: "./feature-flag-client-rules.ts",
    default: "./feature-flag-client-rules.ts",
  },
  "./feature-flag-taxonomy": {
    types: "./feature-flag-taxonomy.ts",
    default: "./feature-flag-taxonomy.ts",
  },
  "./feature-flag-taxonomy-internal": {
    types: "./feature-flag-taxonomy-internal.ts",
    default: "./feature-flag-taxonomy-internal.ts",
  },
  "./src/agentApiChannelJoin": {
    types: "./src/agentApiChannelJoin.ts",
    default: "./src/agentApiChannelJoin.ts",
  },
  "./src/agentApiClient": {
    types: "./src/agentApiClient.ts",
    default: "./src/agentApiClient.ts",
  },
  "./src/agentApiContract": {
    types: "./src/agentApiContract.ts",
    default: "./src/agentApiContract.ts",
  },
  "./src/agentApiMessageContract": {
    types: "./src/agentApiMessageContract.ts",
    default: "./src/agentApiMessageContract.ts",
  },
  "./src/agentApiMessages": {
    types: "./src/agentApiMessages.ts",
    default: "./src/agentApiMessages.ts",
  },
  "./src/agentApiRawClient": {
    types: "./src/agentApiRawClient.ts",
    default: "./src/agentApiRawClient.ts",
  },
  "./src/agentApiRouteMeta": {
    types: "./src/agentApiRouteMeta.ts",
    default: "./src/agentApiRouteMeta.ts",
  },
  "./src/agentMessageText": {
    types: "./src/agentMessageText.ts",
    default: "./src/agentMessageText.ts",
  },
  "./src/agentOps/hint.testkit": {
    types: "./src/agentOps/hint.testkit.ts",
    default: "./src/agentOps/hint.testkit.ts",
  },
  "./src/agentOps/index": {
    types: "./src/agentOps/index.ts",
    default: "./src/agentOps/index.ts",
  },
  "./src/agentOps/seenPolicy/index": {
    types: "./src/agentOps/seenPolicy/index.ts",
    default: "./src/agentOps/seenPolicy/index.ts",
  },
  "./src/agentText/index": {
    types: "./src/agentText/index.ts",
    default: "./src/agentText/index.ts",
  },
  "./src/generated/agentApiRoutes": {
    types: "./src/generated/agentApiRoutes.ts",
    default: "./src/generated/agentApiRoutes.ts",
  },
  "./src/appConfigTransport": {
    types: "./src/appConfigTransport.ts",
    default: "./src/appConfigTransport.ts",
  },
  "./src/appRuntimeTrace": {
    types: "./src/appRuntimeTrace.ts",
    default: "./src/appRuntimeTrace.ts",
  },
  "./src/apps/cleaner/configProtocol": {
    types: "./src/apps/cleaner/configProtocol.ts",
    default: "./src/apps/cleaner/configProtocol.ts",
  },
  "./src/apps/reminder/protocol": {
    types: "./src/apps/reminder/protocol.ts",
    default: "./src/apps/reminder/protocol.ts",
  },
  "./src/attachmentUploadContract": {
    types: "./src/attachmentUploadContract.ts",
    default: "./src/attachmentUploadContract.ts",
  },
  "./unread-activity-diagnostic": {
    types: "./src/unreadActivityDiagnostic.ts",
    default: "./src/unreadActivityDiagnostic.ts",
  },
  "./src/clock": {
    types: "./src/clock.ts",
    default: "./src/clock.ts",
  },
  "./src/unreadActivityDiagnostic": {
    types: "./src/unreadActivityDiagnostic.ts",
    default: "./src/unreadActivityDiagnostic.ts",
  },
  "./src/generated/openapi": {
    types: "./src/generated/openapi.ts",
    default: "./src/generated/openapi.ts",
  },
  "./src/testVectors/messageRepliesDiscussionGraph.vectors.json":
    "./src/testVectors/messageRepliesDiscussionGraph.vectors.json",
  "./src/testVectors/threadRepliesReadModel.vectors.json":
    "./src/testVectors/threadRepliesReadModel.vectors.json",
  "./package.json": "./package.json",
} as const;

type ExportValue = string | { types: string; default: string };

interface ImportUse {
  file: string;
  specifier: string;
}

function trackedSourceFiles(): string[] {
  return execFileSync("git", ["-C", repoRoot, "ls-files", "-z"], {
    encoding: "utf8",
  })
    .split("\0")
    .filter(Boolean)
    .filter((file) => [".cjs", ".cts", ".js", ".jsx", ".mjs", ".mts", ".ts", ".tsx"].includes(extname(file)));
}

function scriptKind(file: string): ts.ScriptKind {
  if (file.endsWith(".tsx")) return ts.ScriptKind.TSX;
  if (file.endsWith(".jsx")) return ts.ScriptKind.JSX;
  if (file.endsWith(".js") || file.endsWith(".mjs") || file.endsWith(".cjs")) return ts.ScriptKind.JS;
  return ts.ScriptKind.TS;
}

function sharedImportUses(): ImportUse[] {
  const uses: ImportUse[] = [];

  for (const relativeFile of trackedSourceFiles()) {
    const file = join(repoRoot, relativeFile);
    const sourceFile = ts.createSourceFile(
      file,
      readFileSync(file, "utf8"),
      ts.ScriptTarget.Latest,
      true,
      scriptKind(file),
    );

    const record = (literal: ts.StringLiteralLike | undefined): void => {
      const specifier = literal?.text;
      if (specifier === packageName || specifier?.startsWith(`${packageName}/`)) {
        uses.push({ file, specifier });
      }
    };

    const visit = (node: ts.Node): void => {
      if (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) {
        record(node.moduleSpecifier && ts.isStringLiteralLike(node.moduleSpecifier) ? node.moduleSpecifier : undefined);
      } else if (ts.isImportEqualsDeclaration(node)) {
        const reference = node.moduleReference;
        if (ts.isExternalModuleReference(reference)) {
          record(reference.expression && ts.isStringLiteralLike(reference.expression) ? reference.expression : undefined);
        }
      } else if (ts.isImportTypeNode(node)) {
        const argument = node.argument;
        if (ts.isLiteralTypeNode(argument)) {
          record(ts.isStringLiteralLike(argument.literal) ? argument.literal : undefined);
        }
      } else if (
        ts.isCallExpression(node)
        && node.arguments.length === 1
        && ts.isStringLiteralLike(node.arguments[0])
        && (node.expression.kind === ts.SyntaxKind.ImportKeyword
          || (ts.isIdentifier(node.expression) && node.expression.text === "require"))
      ) {
        record(node.arguments[0]);
      }
      ts.forEachChild(node, visit);
    };

    visit(sourceFile);
  }

  return uses;
}

function exportKey(specifier: string): string {
  return specifier === packageName ? "." : `.${specifier.slice(packageName.length)}`;
}

function targetFor(value: ExportValue): string {
  return typeof value === "string" ? value : value.default;
}

function resolvedTarget(value: ExportValue): string {
  return realpathSync(join(packageRoot, targetFor(value)));
}

const trackedUses = sharedImportUses();

test("public exports preserve every tracked raft-shared consumer", (context) => {
  const packageJson = JSON.parse(readFileSync(join(packageRoot, "package.json"), "utf8")) as {
    exports?: unknown;
    files?: unknown;
    sideEffects?: unknown;
  };
  assert.deepEqual(packageJson.exports, expectedExports);
  assert.equal(packageJson.files, undefined, "public entry points must not silently change the packed-file list");
  assert.equal(packageJson.sideEffects, undefined, "public entry points must not assert an unaudited side-effect contract");
  assert.equal(Object.keys(expectedExports).some((key) => key.includes("*")), false, "wildcard exports would reopen internal paths");

  assert.ok(trackedUses.length > 0, "expected tracked raft-shared consumers");
  const rootUseCount = trackedUses.filter(({ specifier }) => specifier === packageName).length;
  const publicLeafUseCount = trackedUses.filter(
    ({ specifier }) => specifier === `${packageName}/feature-flag-admin-privileges`,
  ).length;
  context.annotate(
    `${trackedUses.length} imports in ${new Set(trackedUses.map(({ file }) => file)).size} tracked files; `
      + `${rootUseCount} root, ${publicLeafUseCount} public leaf, `
      + `${trackedUses.length - rootUseCount - publicLeafUseCount} compatibility deep imports; `
      + `${new Set(trackedUses.map(({ specifier }) => specifier)).size} package entry points`,
  );

  const missing = trackedUses.filter(({ specifier }) => !(exportKey(specifier) in expectedExports));
  assert.deepEqual(
    missing.map(({ file, specifier }) => `${specifier} in ${relative(repoRoot, file)}`),
    [],
    "every tracked consumer must resolve through an explicit public or compatibility export",
  );

  for (const [key, value] of Object.entries(expectedExports)) {
    assert.doesNotThrow(
      () => resolvedTarget(value),
      `${key} must target a real file`,
    );
  }
});

test("Node resolves root, public leaf, and current deep imports to the declared files", () => {
  const representativeBySpecifier = new Map<string, string>();
  for (const use of trackedUses) representativeBySpecifier.set(use.specifier, use.file);

  for (const [specifier, importer] of representativeBySpecifier) {
    const key = exportKey(specifier) as keyof typeof expectedExports;
    const expected = resolvedTarget(expectedExports[key]);
    const requireResolved = realpathSync(createRequire(pathToFileURL(importer)).resolve(specifier));
    const importResolved = realpathSync(fileURLToPath(import.meta.resolve(specifier)));
    assert.equal(requireResolved, expected, `require.resolve: ${specifier} from ${importer}`);
    assert.equal(importResolved, expected, `import.meta.resolve: ${specifier}`);
  }

  const representative = trackedUses[0]?.file;
  assert.ok(representative, "expected a representative raft-shared importer");
  assert.throws(
    () => createRequire(pathToFileURL(representative)).resolve(`${packageName}/src/index.js`),
    (error: unknown) => {
      assert.equal((error as NodeJS.ErrnoException).code, "ERR_PACKAGE_PATH_NOT_EXPORTED");
      return true;
    },
  );
  assert.throws(
    () => import.meta.resolve(`${packageName}/src/index.js`),
    (error: unknown) => {
      assert.equal((error as NodeJS.ErrnoException).code, "ERR_PACKAGE_PATH_NOT_EXPORTED");
      return true;
    },
  );
});

test("TypeScript consumer modes resolve every tracked import through the same targets", () => {
  const modes = [
    ["Bundler", ts.ModuleResolutionKind.Bundler, ts.ModuleKind.ESNext],
    ["Node16", ts.ModuleResolutionKind.Node16, ts.ModuleKind.Node16],
    ["NodeNext", ts.ModuleResolutionKind.NodeNext, ts.ModuleKind.NodeNext],
  ] as const;

  for (const [label, moduleResolution, module] of modes) {
    for (const { file, specifier } of trackedUses) {
      const result = ts.resolveModuleName(
        specifier,
        file,
        {
          allowJs: true,
          module,
          moduleResolution,
          resolveJsonModule: true,
        },
        ts.sys,
      ).resolvedModule;
      assert.ok(result, `${label} must resolve ${specifier} from ${file}`);
      const key = exportKey(specifier) as keyof typeof expectedExports;
      assert.equal(realpathSync(result.resolvedFileName), resolvedTarget(expectedExports[key]), `${label}: ${specifier} from ${file}`);
    }
  }
});
