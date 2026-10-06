import assert from "node:assert/strict";
import { parseSkillFrontmatter } from "./skillFrontmatter";

function md(...frontmatterLines: string[]): string {
  return ["---", ...frontmatterLines, "---", "", "# Body", "prose"].join("\n");
}

describe("skill frontmatter: the cases the line reader got wrong", () => {
  test("a literal block description keeps its lines, and the block marker is not the value", () => {
    const fm = parseSkillFrontmatter(
      md("name: deploy", "description: |", "  Deploy the service.", "  Use after a green build.", "user-invocable: true"),
    );
    // The old reader produced "|" here -- the block marker shown to the user as
    // the description.
    assert.notEqual(fm.description, "|");
    // Clip chomping (the default) keeps exactly one trailing newline.
    assert.equal(fm.description, "Deploy the service.\nUse after a green build.\n");
    // Keys after the block must still be read: the block must consume exactly
    // its own body and stop.
    assert.equal(fm["user-invocable"], "true");
    assert.equal(fm.name, "deploy");
  });

  test("a folded block description folds newlines into spaces", () => {
    const fm = parseSkillFrontmatter(
      md("description: >", "  Deploy the service", "  after a green build.", "name: deploy"),
    );
    assert.notEqual(fm.description, ">");
    assert.equal(fm.description, "Deploy the service after a green build.\n");
    assert.equal(fm.name, "deploy");
  });

  test("a folded block turns a blank line into a paragraph break", () => {
    const fm = parseSkillFrontmatter(
      md("description: >", "  First paragraph here.", "", "  Second paragraph here."),
    );
    assert.equal(fm.description, "First paragraph here.\nSecond paragraph here.\n");
  });

  test("block chomping indicators are accepted and not treated as the value", () => {
    for (const header of ["|-", "|+", ">-", ">+"]) {
      const fm = parseSkillFrontmatter(md(`description: ${header}`, "  Body line."));
      assert.notEqual(fm.description, header);
      assert.match(fm.description, /^Body line\.\n*$/);
    }
  });

  // @Huaihuai's CHANGES #2: the three modes must be TELLABLE APART. They differ
  // only in trailing newline count, so an assertion that trims -- or an
  // implementation that discards trailing blanks before chomping, as the first
  // version did -- collapses all three into one and proves nothing.
  test("strip, clip and keep produce different trailing newline counts", () => {
    const body = ["description: HEADER", "  Body line.", "", ""];
    const withHeader = (header: string) =>
      parseSkillFrontmatter(md(...body.map((l) => l.replace("HEADER", header)))).description;

    const strip = withHeader("|-");
    const clip = withHeader("|");
    const keep = withHeader("|+");

    const trailing = (v: string) => /\n*$/.exec(v)?.[0].length ?? 0;
    assert.equal(strip, "Body line.", "strip removes every trailing newline");
    assert.equal(clip, "Body line.\n", "clip keeps exactly one");
    assert.equal(keep, "Body line.\n\n\n", "keep preserves one per trailing blank line");
    assert.equal(trailing(strip), 0);
    assert.equal(trailing(clip), 1);
    assert.equal(trailing(keep), 3);
    assert.notEqual(strip, clip);
    assert.notEqual(clip, keep);
  });

  test("folded blocks chomp the same three ways", () => {
    const withHeader = (header: string) =>
      parseSkillFrontmatter(md(`description: ${header}`, "  One", "  two.", "", "")).description;
    assert.equal(withHeader(">-"), "One two.");
    assert.equal(withHeader(">"), "One two.\n");
    assert.equal(withHeader(">+"), "One two.\n\n\n");
  });

  test("an explicit indentation indicator is honoured", () => {
    const fm = parseSkillFrontmatter(md("description: |2", "  Body line.", "    Indented more."));
    assert.equal(fm.description, "Body line.\n  Indented more.\n");
  });

  test("a double-quoted description containing a colon survives with its quotes removed", () => {
    const fm = parseSkillFrontmatter(md('description: "Use when: the build is red"'));
    // The old reader kept the quote characters in the value.
    assert.equal(fm.description, "Use when: the build is red");
    assert.ok(!fm.description.includes('"'));
  });

  test("a single-quoted description unescapes doubled quotes", () => {
    const fm = parseSkillFrontmatter(md("description: 'It''s ready: go'"));
    assert.equal(fm.description, "It's ready: go");
  });

  test("a comment after a quoted scalar is stripped, and a hash inside the quotes is kept", () => {
    assert.equal(parseSkillFrontmatter(md('description: "Deploy it" # internal note')).description, "Deploy it");
    assert.equal(parseSkillFrontmatter(md("description: 'Deploy it' # internal note")).description, "Deploy it");
    // The hash is INSIDE the quotes here, so it is part of the value.
    assert.equal(parseSkillFrontmatter(md('description: "Fixes issue #42"')).description, "Fixes issue #42");
    assert.equal(parseSkillFrontmatter(md('description: "Fixes #42" # tracked')).description, "Fixes #42");
  });

  test("escaped quotes inside a double-quoted description are unescaped", () => {
    const fm = parseSkillFrontmatter(md('description: "He said \\"go\\" twice"'));
    assert.equal(fm.description, 'He said "go" twice');
  });
});

describe("skill frontmatter: behaviour that must not change", () => {
  test("a plain single-line description is unchanged", () => {
    const fm = parseSkillFrontmatter(md("name: codex-skill", "description: CODEX_HOME scoped skill", "user-invocable: false"));
    assert.equal(fm.name, "codex-skill");
    assert.equal(fm.description, "CODEX_HOME scoped skill");
    assert.equal(fm["user-invocable"], "false");
  });

  test("an unquoted plain value keeps text after its first colon", () => {
    const fm = parseSkillFrontmatter(md("description: Use this: always"));
    assert.equal(fm.description, "Use this: always");
  });

  test("no frontmatter yields no keys", () => {
    assert.deepEqual(parseSkillFrontmatter("# Just a heading\ntext"), {});
    assert.deepEqual(parseSkillFrontmatter(""), {});
  });

  test("CRLF frontmatter parses the same as LF", () => {
    const lf = parseSkillFrontmatter(md("description: |", "  Line one.", "  Line two."));
    const crlf = parseSkillFrontmatter(
      ["---", "description: |", "  Line one.", "  Line two.", "---", "", "# Body"].join("\r\n"),
    );
    assert.deepEqual(crlf, lf);
  });

  test("a trailing comment is stripped from a plain scalar but a bare hash is kept", () => {
    assert.equal(parseSkillFrontmatter(md("description: Deploy it # internal note")).description, "Deploy it");
    assert.equal(parseSkillFrontmatter(md("description: Build for C# targets")).description, "Build for C# targets");
  });

  test("a comment line and a blank line in frontmatter are ignored", () => {
    const fm = parseSkillFrontmatter(md("# a comment", "", "description: Deploy it", "name: deploy"));
    assert.equal(fm.description, "Deploy it");
    assert.equal(fm.name, "deploy");
  });
});

describe("skill frontmatter: unsupported syntax fails closed", () => {
  // @跳虎's condition for accepting an explicitly-parsed subset was that the
  // subset is locked by documentation AND tests. Writing these caught the
  // module claiming a property it did not have: every one of these forms was
  // passing through as raw text, so an anchor or tag would have been shown to
  // the user as the skill's description -- the same class of defect as
  // displaying the block marker `|`.
  const unsupported: Array<[string, string]> = [
    ["anchor", "description: &a Reusable text"],
    ["alias", "description: *a"],
    ["tag", "description: !!str Tagged"],
    ["flow sequence", "description: [one, two]"],
    ["flow mapping", "description: {a: b}"],
    ["complex mapping key", "description: ? weird"],
    ["reserved @", "description: @reserved"],
    ["reserved backtick", "description: `reserved"],
    ["directive %", "description: %YAML 1.2"],
    ["sequence entry", "description: - first"],
    ["unterminated double quote", 'description: "unclosed'],
    ["unterminated single quote", "description: 'unclosed"],
    ["malformed block header", "description: |junk"],
  ];

  for (const [label, line] of unsupported) {
    test(`${label} yields no description rather than raw syntax`, () => {
      const fm = parseSkillFrontmatter(["---", line, "---", "", "body"].join("\n"));
      assert.equal(
        fm.description,
        "",
        `${label} must fail closed; a wrong description is worse than a missing one`,
      );
    });
  }

  test("failing closed does not stop the remaining frontmatter from parsing", () => {
    const fm = parseSkillFrontmatter(
      ["---", "description: &anchor text", "name: still-read", "user-invocable: true", "---", "", "body"].join("\n"),
    );
    assert.equal(fm.description, "");
    assert.equal(fm.name, "still-read");
    assert.equal(fm["user-invocable"], "true");
  });

  test("an indicator character inside a plain scalar is still allowed", () => {
    // Only the FIRST character is an indicator position. A description is
    // allowed to contain these; requiring quotes for them would break values
    // that work today.
    const fm = parseSkillFrontmatter(
      ["---", "description: Deploy a&b, build [x] and {y}", "---", "", "body"].join("\n"),
    );
    assert.equal(fm.description, "Deploy a&b, build [x] and {y}");
  });
});

/**
 * The line reader this module replaced, kept TEST-ONLY as a reference oracle.
 *
 * @Huaihuai's CHANGES #3: reporting "10 cases fail on the old parser" from an
 * ad-hoc run leaves no evidence in the repository. Pinning the old algorithm
 * here makes each new behaviour permanently demonstrate what it fixed, and it
 * fails loudly if someone later "simplifies" the new parser back toward the
 * old one.
 *
 * Copied verbatim from `parseSkillMd` as it stood on staging at 55ee8183e.
 */
function legacyLineReader(content: string): Record<string, string> {
  const result: Record<string, string> = {};
  const match = content.match(/^---\n([\s\S]*?)\n---/);
  if (!match) return result;
  for (const line of match[1].split("\n")) {
    const colonIdx = line.indexOf(":");
    if (colonIdx === -1) continue;
    result[line.slice(0, colonIdx).trim()] = line.slice(colonIdx + 1).trim();
  }
  return result;
}

describe("skill frontmatter: each fix is a real difference from the old reader", () => {
  const fixed: Array<[string, string, string]> = [
    ["literal block", md("description: |", "  One.", "  Two."), "One.\nTwo.\n"],
    ["folded block", md("description: >", "  One", "  two."), "One two.\n"],
    ["chomp strip", md("description: |-", "  One."), "One."],
    ["chomp keep", md("description: |+", "  One.", "", ""), "One.\n\n\n"],
    ["explicit indent", md("description: |2", "  One.", "    Two."), "One.\n  Two.\n"],
    ["double-quoted with colon", md('description: "Use when: red"'), "Use when: red"],
    ["single-quoted unescape", md("description: 'It''s red'"), "It's red"],
    ["escaped quotes", md('description: "He said \\"go\\""'), 'He said "go"'],
    ["quoted then comment", md('description: "Deploy it" # note'), "Deploy it"],
    ["plain trailing comment", md("description: Deploy it # note"), "Deploy it"],
    ["anchor fails closed", md("description: &a text"), ""],
    ["flow sequence fails closed", md("description: [a, b]"), ""],
    ["tag fails closed", md("description: !!str x"), ""],
  ];

  for (const [label, source, expected] of fixed) {
    test(`${label}: new parser is correct AND the old reader is not`, () => {
      assert.equal(parseSkillFrontmatter(source).description, expected);
      assert.notEqual(
        legacyLineReader(source).description,
        expected,
        `${label} must differ from the old reader, otherwise this case proves nothing`,
      );
    });
  }

  const preserved: Array<[string, string]> = [
    ["plain single line", md("description: CODEX_HOME scoped skill")],
    ["text after first colon", md("description: Use this: always")],
    ["bare hash kept", md("description: Build for C# targets")],
  ];

  for (const [label, source] of preserved) {
    test(`${label}: unchanged from the old reader, on purpose`, () => {
      assert.equal(
        parseSkillFrontmatter(source).description,
        legacyLineReader(source).description,
        `${label} is a compatibility case: it must agree with the old reader`,
      );
    });
  }
});

describe("skill frontmatter: nesting is unsupported STRUCTURALLY, not just in values", () => {
  // @XX (task #281): a nested mapping's children are themselves well-formed
  // `key: value` lines, so a line-scanning reader promotes them to top-level
  // metadata. Declaring nesting "unsupported" in the value position does
  // nothing about it -- the fix has to act on structure.
  test("a nested description does not override the real top-level one", () => {
    const fm = parseSkillFrontmatter(
      md("description: real one", "user-invocable: false", "examples:", "  description: nested one", "  user-invocable: true"),
    );
    assert.equal(fm.description, "real one");
    assert.equal(fm["user-invocable"], "false");
  });

  test("a nested user-invocable cannot raise a skill that declared itself false", () => {
    const fm = parseSkillFrontmatter(
      md("user-invocable: false", "meta:", "  user-invocable: true"),
    );
    assert.equal(fm["user-invocable"], "false");
  });

  test("a key whose only content is a nested mapping fails closed", () => {
    const fm = parseSkillFrontmatter(md("name: s", "metadata:", "  description: nested only"));
    assert.equal(fm.description, undefined);
    assert.equal(fm.metadata, "");
    assert.equal(fm.name, "s");
  });

  test("nesting deeper than one level is ignored too", () => {
    const fm = parseSkillFrontmatter(
      md("description: top", "a:", "  b:", "    description: deep", "    user-invocable: true"),
    );
    assert.equal(fm.description, "top");
    assert.equal(fm["user-invocable"], undefined);
  });

  test("a block scalar's body is still consumed and not mistaken for nesting", () => {
    const fm = parseSkillFrontmatter(
      md("description: |", "  line one", "  key-like: not a key", "user-invocable: true"),
    );
    assert.equal(fm.description, "line one\nkey-like: not a key\n");
    assert.equal(fm["user-invocable"], "true");
    assert.equal(fm["key-like"], undefined);
  });
});

describe("skill frontmatter: folded break counting", () => {
  test("a run of k blank lines yields k breaks", () => {
    assert.equal(parseSkillFrontmatter(md("description: >", "  alpha", "", "  beta")).description, "alpha\nbeta\n");
    assert.equal(parseSkillFrontmatter(md("description: >", "  alpha", "", "", "  beta")).description, "alpha\n\nbeta\n");
    assert.equal(parseSkillFrontmatter(md("description: >", "  alpha", "", "", "", "  beta")).description, "alpha\n\n\nbeta\n");
  });

  test("a single break between equally indented lines folds to a space", () => {
    assert.equal(parseSkillFrontmatter(md("description: >", "  alpha", "  beta")).description, "alpha beta\n");
  });

  test("a more-indented line keeps the breaks on both sides of it", () => {
    assert.equal(
      parseSkillFrontmatter(md("description: >", "  alpha", "    code", "  omega")).description,
      "alpha\n  code\nomega\n",
    );
  });

  test("a blank line before a more-indented paragraph adds to the structural break", () => {
    assert.equal(
      parseSkillFrontmatter(md("description: >", "  alpha", "", "    code", "  omega")).description,
      "alpha\n\n  code\nomega\n",
    );
  });
});

describe("skill frontmatter: invalid indentation indicators fail closed", () => {
  // YAML's indentation indicator is 1-9. Zero is not a valid indicator, and a
  // reader that accepts it silently treats a malformed header as a block.
  for (const header of ["|0", ">0", "|10", ">99", "|-0"]) {
    test(`${header} is not read as a block`, () => {
      const fm = parseSkillFrontmatter(md(`description: ${header}`, "  hello"));
      assert.equal(fm.description, "", `${header} must fail closed`);
    });
  }

  test("valid indicators 1 through 9 are still accepted", () => {
    const fm = parseSkillFrontmatter(md("description: |1", " hello"));
    assert.equal(fm.description, "hello\n");
  });
});

describe("skill frontmatter: only key-bearing lines decide the structural level", () => {
  // @XX (task #281, successor round): a root `#` comment above indented
  // metadata set baseIndent to 0 and erased the whole document. A comment
  // carries no mapping level. Covered as a class -- anything that cannot hold
  // a key must not set the level -- rather than as the one reported input.
  test("a root comment cannot erase indented metadata", () => {
    assert.equal(parseSkillFrontmatter(md("# comment", "  description: hello")).description, "hello");
  });

  test("a comment indented deeper than the keys changes nothing", () => {
    assert.equal(parseSkillFrontmatter(md("description: a", "  # deep comment")).description, "a");
  });

  test("a line with no colon cannot set the level", () => {
    assert.equal(parseSkillFrontmatter(md("just text", "  description: hello")).description, "hello");
  });

  test("a colon inside a block body does not set the level", () => {
    const fm = parseSkillFrontmatter(md("description: |", "  a: b", "user-invocable: true"));
    assert.equal(fm["user-invocable"], "true");
    assert.equal(fm.a, undefined);
  });

  test("a document whose keys are all indented still parses", () => {
    const fm = parseSkillFrontmatter(md("  description: x", "  name: y"));
    assert.equal(fm.description, "x");
    assert.equal(fm.name, "y");
  });

  test("a frontmatter of comments alone yields no keys", () => {
    assert.deepEqual(parseSkillFrontmatter(md("# just a comment")), {});
  });
});

describe("skill frontmatter: leading blank lines inside a block are content", () => {
  test("folded: a leading blank line becomes a leading break", () => {
    assert.equal(parseSkillFrontmatter(md("description: >", "", "  alpha")).description, "\nalpha\n");
  });

  test("folded: two leading blanks become two breaks", () => {
    assert.equal(parseSkillFrontmatter(md("description: >", "", "", "  alpha")).description, "\n\nalpha\n");
  });

  test("literal: a leading blank line is preserved too", () => {
    assert.equal(parseSkillFrontmatter(md("description: |", "", "  alpha")).description, "\nalpha\n");
  });

  test("a block body of only blank lines yields the empty string", () => {
    assert.equal(parseSkillFrontmatter(md("description: >", "", "")).description, "");
    assert.equal(parseSkillFrontmatter(md("description: |", "", "")).description, "");
  });
});
