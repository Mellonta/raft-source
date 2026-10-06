#!/usr/bin/env -S node --import=@oxc-node/core/register

import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

import {
  RISINGWAVE_ARTIFACT_CDC_TABLES,
  RISINGWAVE_BOOTSTRAP_ARTIFACTS,
  RISINGWAVE_CDC_TABLES,
  RISINGWAVE_LOCAL_SOURCE,
  RISINGWAVE_PUBLICATION_TABLES,
  RISINGWAVE_REQUIRED_RELATIONS,
  RISINGWAVE_SERVER_READ_RELATIONS,
  buildRisingWaveBootstrapStatements,
  createdRelationName,
} from "./raftdev-risingwave-bootstrap";

interface Options {
  sourceRoot: string;
  cdcOut: string;
  manifestOut: string;
  contractOut: string;
}

function parseArgs(argv: string[]): Options {
  const values = new Map<string, string>();
  for (let index = 0; index < argv.length; index += 2) {
    const flag = argv[index];
    const value = argv[index + 1];
    if (!flag?.startsWith("--") || !value) throw new Error(`invalid argument ${flag ?? "<missing>"}`);
    values.set(flag.slice(2), value);
  }
  const required = (name: string) => {
    const value = values.get(name)?.trim();
    if (!value) throw new Error(`--${name} is required`);
    return value;
  };
  return {
    sourceRoot: path.resolve(required("source-root")),
    cdcOut: path.resolve(required("cdc-out")),
    manifestOut: path.resolve(required("manifest-out")),
    contractOut: path.resolve(required("contract-out")),
  };
}

function sqlDocument(statements: readonly string[]): string {
  return `${statements.map((statement) => statement.trim().replace(/;?$/, ";")).join("\n\n")}\n`;
}

function rewriteSource(statement: string): string {
  return statement.replaceAll(new RegExp(`\\b${RISINGWAVE_LOCAL_SOURCE}\\b`, "g"), ':"rw_source_name"');
}

export function renderReleaseQaRisingWaveBootstrap(sourceRoot: string) {
  const artifacts = Object.fromEntries(
    RISINGWAVE_BOOTSTRAP_ARTIFACTS.map((artifact) => [
      artifact.file,
      readFileSync(path.join(sourceRoot, artifact.file), "utf8"),
    ]),
  );
  const allStatements = buildRisingWaveBootstrapStatements(artifacts);
  const cdcRelations = new Set(RISINGWAVE_CDC_TABLES.map((table) => table.name));
  const cdcStatements = allStatements.filter((statement) => {
    const relation = createdRelationName(statement);
    return relation !== null && cdcRelations.has(relation);
  });
  const manifestStatements = allStatements.filter((statement) => {
    const relation = createdRelationName(statement);
    return relation === null || !cdcRelations.has(relation);
  });
  const sourceStatement = [
    'CREATE SOURCE :"rw_source_name"',
    "WITH (",
    "  connector = 'postgres-cdc',",
    "  hostname = :'pg_host',",
    "  port = :'pg_port',",
    "  username = :'pg_user',",
    "  password = :'pg_password',",
    "  database.name = :'pg_database',",
    "  schema.name = 'public',",
    "  ssl.mode = :'pg_ssl_mode',",
    "  slot.name = :'pg_slot_name',",
    "  publication.name = :'pg_publication_name'",
    ")",
  ].join("\n");
  const contract = {
    schema_version: 1,
    publication_tables: [...RISINGWAVE_PUBLICATION_TABLES],
    cdc_relations: RISINGWAVE_CDC_TABLES.map((table) => table.name),
    artifact_cdc_relations: RISINGWAVE_ARTIFACT_CDC_TABLES.map((table) => table.name),
    required_relations: [...RISINGWAVE_REQUIRED_RELATIONS],
    server_read_relations: [...RISINGWAVE_SERVER_READ_RELATIONS],
  };
  return {
    cdcSql: sqlDocument([sourceStatement, ...cdcStatements.map(rewriteSource)]),
    manifestSql: sqlDocument(manifestStatements.map(rewriteSource)),
    contract,
  };
}

function writeExclusive(file: string, value: string): void {
  writeFileSync(file, value, { encoding: "utf8", flag: "wx", mode: 0o600 });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const options = parseArgs(process.argv.slice(2));
  const rendered = renderReleaseQaRisingWaveBootstrap(options.sourceRoot);
  writeExclusive(options.cdcOut, rendered.cdcSql);
  writeExclusive(options.manifestOut, rendered.manifestSql);
  writeExclusive(options.contractOut, `${JSON.stringify(rendered.contract, null, 2)}\n`);
  process.stdout.write(
    `${JSON.stringify({
      schema_version: 1,
      publication_table_count: rendered.contract.publication_tables.length,
      cdc_relation_count: rendered.contract.cdc_relations.length,
      required_relation_count: rendered.contract.required_relations.length,
      server_read_relation_count: rendered.contract.server_read_relations.length,
    })}\n`,
  );
}
