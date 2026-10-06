import assert from "node:assert/strict";
import {
  PRODUCT_EVENT_REGISTRY,
  type ProductEventSpec,
  validateProductEvent,
} from "./productEvents";

// Product events are designed on purpose (RFC-067 §3.2). Changing this list is
// a deliberate act that needs the event-registry owner's sign-off.
test("the product event registry changes only on purpose", () => {
  assert.deepEqual(Object.keys(PRODUCT_EVENT_REGISTRY).sort(), [
    "activity_item_open",
    "activity_mark",
    "activity_open",
    "agent_create_opened",
    "community_cn_qr_page_view",
    "page_viewed",
    "pwa_install_appinstalled",
    "pwa_install_cta_clicked",
    "pwa_install_cta_shown",
    "pwa_install_eligible",
    "pwa_install_ios_instruction_dismissed",
    "pwa_install_native_prompt_result",
    "pwa_install_standalone_detected",
  ]);
});

test("every entry states its question and stays JSON-shaped", () => {
  const entries: Array<[string, ProductEventSpec]> = Object.entries(PRODUCT_EVENT_REGISTRY);
  for (const [name, spec] of entries) {
    assert.match(name, /^[a-z][a-z0-9_]*$/, name);
    assert.ok(spec.question.trim().length > 0, `${name} needs a question`);
    assert.ok(spec.requestedBy.trim().length > 0, `${name} needs a requester`);
    assert.ok(spec.sources.length > 0, `${name} needs a source`);
    for (const property of Object.keys(spec.properties)) {
      assert.match(property, /^[a-z][a-z0-9_]*$/, `${name}.${property}: \`$\` names are reserved for the pipeline`);
    }
  }
  // Native clients generate their APIs from a JSON export (RFC-067 §6).
  assert.deepEqual(JSON.parse(JSON.stringify(PRODUCT_EVENT_REGISTRY)), PRODUCT_EVENT_REGISTRY);
});

test("validateProductEvent accepts registered events and rejects everything else", () => {
  assert.deepEqual(validateProductEvent("activity_open", { from: "rail" }, "web"), { ok: true, event: "activity_open" });
  assert.deepEqual(validateProductEvent("activity_open", {}, "desktop"), { ok: true, event: "activity_open" });
  assert.deepEqual(
    validateProductEvent("community_cn_qr_page_view", { from: "wechat_group_3" }, "web"),
    { ok: true, event: "community_cn_qr_page_view" },
  );

  assert.deepEqual(validateProductEvent("button_clicked", {}, "web"), { ok: false, reason: "unregistered_event" });
  assert.deepEqual(validateProductEvent("toString", {}, "web"), { ok: false, reason: "unregistered_event" });
  assert.deepEqual(validateProductEvent("activity_open", { from: "rail" }, "ios"), { ok: false, reason: "source_not_allowed" });
  assert.deepEqual(
    validateProductEvent("activity_open", { from: "rail", text: "hello" }, "web"),
    { ok: false, reason: "unknown_property", property: "text" },
  );
  assert.deepEqual(
    validateProductEvent("activity_open", { from: "elsewhere" }, "web"),
    { ok: false, reason: "invalid_property_value", property: "from" },
  );
  assert.deepEqual(
    validateProductEvent("community_cn_qr_page_view", { from: "x".repeat(65) }, "web"),
    { ok: false, reason: "invalid_property_value", property: "from" },
  );
  for (const from of ["someone@example.com", "+86 138 0000 0000", "WeChat", "join the group"]) {
    assert.deepEqual(
      validateProductEvent("community_cn_qr_page_view", { from }, "web"),
      { ok: false, reason: "invalid_property_value", property: "from" },
      from,
    );
  }
});
