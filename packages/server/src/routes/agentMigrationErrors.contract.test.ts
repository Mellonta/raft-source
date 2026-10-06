import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import ts from "typescript";

const routeSource = readFileSync(new URL("./agents.ts", import.meta.url), "utf8");
const migrationStart = routeSource.indexOf("// Owner-initiated no-card migration.");
const migrationEnd = routeSource.indexOf("// Start agent (routes to machine via agentOrchestrator)");

function propertyName(node: ts.ObjectLiteralElementLike): string | null {
  if (!ts.isPropertyAssignment(node) && !ts.isShorthandPropertyAssignment(node)) return null;
  return ts.isIdentifier(node.name) || ts.isStringLiteral(node.name) ? node.name.text : null;
}

test("owner-facing migration errors cannot bypass the typed response helper", () => {
  assert.ok(migrationStart >= 0 && migrationEnd > migrationStart, "migration route boundary markers must remain present");
  const file = ts.createSourceFile("agents.ts", routeSource, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const directCodeResponses: number[] = [];

  const visit = (node: ts.Node): void => {
    if (
      node.pos >= migrationStart
      && node.end <= migrationEnd
      && ts.isCallExpression(node)
      && ts.isPropertyAccessExpression(node.expression)
      && node.expression.name.text === "json"
      && node.arguments.length > 0
      && ts.isObjectLiteralExpression(node.arguments[0])
      && node.arguments[0].properties.some((property) => propertyName(property) === "code")
    ) {
      directCodeResponses.push(file.getLineAndCharacterOfPosition(node.getStart(file)).line + 1);
    }
    ts.forEachChild(node, visit);
  };
  visit(file);

  assert.deepEqual(
    directCodeResponses,
    [],
    `migration routes emitted coded JSON outside sendMigrationError at lines ${directCodeResponses.join(", ")}`,
  );
});

test("typed migration errors always publish a nonempty machine-readable cause", () => {
  const helperStart = routeSource.indexOf("function sendMigrationError(");
  const helperEnd = routeSource.indexOf("\n}\n\nfunction isoOrNull", helperStart);
  assert.ok(helperStart >= 0 && helperEnd > helperStart, "sendMigrationError helper must remain present");
  const helper = routeSource.slice(helperStart, helperEnd);
  assert.match(helper, /details:\s*\{[\s\S]*failureReason:\s*code/);
});

test("Built-in migration validates and leases the target catalog before provisioning", () => {
  assert.ok(migrationStart >= 0 && migrationEnd > migrationStart, "migration route boundary markers must remain present");
  const migration = routeSource.slice(migrationStart, migrationEnd);
  // The route may validate directly, or through the write-path wrapper added by #proj-daemon
  // task #322 (it demotes catalog-missing to a warning and rethrows every other code). Both
  // spellings discharge the same obligation, so either is accepted here -- but accepting a second
  // name must not let a pure rename satisfy this contract, which is what the delegation assertion
  // at the end is for. That is precisely how this test went red: it pins a STRING in the source,
  // and #8063 moved the string.
  const validateOffsets = [
    "validateBuiltInPresetForWrite(",
    "validateBuiltInPresetForMachine(",
  ]
    .map((call) => migration.indexOf(call))
    .filter((at) => at >= 0);
  const validate = validateOffsets.length > 0 ? Math.min(...validateOffsets) : -1;
  const acquire = migration.indexOf("acquireBuiltInCatalogAuthority(", validate);
  const provision = migration.indexOf("beginAgentMigrationProvisioning(");
  const release = migration.indexOf("releaseCatalogAuthority();", provision);

  assert.ok(validate >= 0, "Built-in migration must validate the target catalog");
  assert.ok(acquire > validate, "migration must bind validation to its connection generation");
  assert.ok(provision > acquire, "catalog authority must be held before migration state is provisioned");
  assert.ok(release > provision, "catalog authority must release from the migration finally path");

  // Validating "through the wrapper" only counts if the wrapper still reaches the orchestrator.
  // Without this, the obligation could be satisfied by a function that merely has the right name.
  if (migration.includes("validateBuiltInPresetForWrite(")) {
    const wrapperStart = routeSource.indexOf("async function validateBuiltInPresetForWrite(");
    assert.ok(wrapperStart >= 0, "validateBuiltInPresetForWrite must be defined in this file");
    const wrapperEnd = routeSource.indexOf("\n}\n", wrapperStart);
    assert.ok(wrapperEnd > wrapperStart, "validateBuiltInPresetForWrite body must be delimitable");
    assert.match(
      routeSource.slice(wrapperStart, wrapperEnd),
      /agentOrchestrator\.validateBuiltInPresetForMachine\(/,
      "the write-path wrapper must still delegate to the catalog validator",
    );
  }
});
