import assert from "node:assert/strict";
import { en } from "../src/i18n/messages/en";
import { zhCn } from "../src/i18n/messages/zh-cn";

// The Computer detail page talks in the user's words (computer-upgrade-copy-
// proposal §2.3, §7). Policy / installer vocabulary leaked into it before:
// "this source is not currently eligible", "Pinned to v…", "controlled
// migration", "authorized". Any machine.detail.* string that uses one of these
// words fails here; reword the string instead of extending an allowlist.
const BANNED: ReadonlyArray<{ word: string; pattern: RegExp }> = [
  { word: "来源", pattern: /来源/ },
  { word: "符合…条件", pattern: /符合.{0,4}条件/ },
  { word: "授权", pattern: /授权/ },
  { word: "固定为", pattern: /固定为/ },
  { word: "受控迁移", pattern: /受控迁移/ },
  { word: "source", pattern: /\bsources?\b/i },
  { word: "eligible", pattern: /eligib/i },
  { word: "authorized", pattern: /authori[sz]/i },
  { word: "pinned", pattern: /\bpinned\b/i },
  { word: "supervisor", pattern: /supervisor/i },
];

function machineDetailEntries(catalog: Record<string, string>): Array<[string, string]> {
  return Object.entries(catalog).filter(([id]) => id.startsWith("machine.detail."));
}

for (const [locale, catalog] of [["en", en], ["zh-cn", zhCn]] as const) {
  test(`${locale}: machine.detail.* strings use no internal policy / installer words`, () => {
    const entries = machineDetailEntries(catalog);
    // Positive control: the scan really reads the detail-page catalog.
    assert.ok(entries.length > 100, `expected the machine.detail.* catalog, got ${entries.length} entries`);

    const hits = entries.flatMap(([id, text]) =>
      BANNED.filter(({ pattern }) => pattern.test(text)).map(({ word }) => `${id}: "${word}" in ${JSON.stringify(text)}`),
    );
    assert.deepEqual(hits, []);
  });
}
