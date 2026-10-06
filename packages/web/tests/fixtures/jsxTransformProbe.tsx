import assert from "node:assert/strict";

function ProbeElement() {
  return <span data-probe="tsx-jsx" />;
}

test("tsx uses automatic JSX transform for web test fixtures", () => {
  const element = ProbeElement();
  assert.equal(element.props["data-probe"], "tsx-jsx");
});
