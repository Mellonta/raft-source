// Product event registry (RFC-067 §3.2).
//
// Every product event and its allowed properties is declared here, once, for
// every client and for server ingest. Clients get their typed `track()` API
// from it; ingest rejects (and counts) anything validateProductEvent refuses.
//
// Product events are designed on purpose. Add, rename or remove one only with
// the event-registry owner's sign-off, never as a side effect of feature work:
// each entry states the question it answers and who asked. Properties are
// low-cardinality ids/enums/counts only — never message text or other user
// content. Names starting with `$` are reserved for fields the pipeline adds.
//
// PRODUCT_EVENT_REGISTRY is plain JSON-shaped data on purpose: native clients
// (RFC-067 §6) will generate their APIs from a JSON export of it.

// NOT A SETTLED RULE — pending RFC-067 §9.4 (legal review of regional
// defaults). What "Share usage data" means for a user who has not chosen; the
// server gate and the settings UI both read it.
export const SHARE_USAGE_DATA_DEFAULT = false;

export const PRODUCT_EVENT_SOURCES = ["server", "web", "desktop", "android", "ios", "harmonyos"] as const;
export type ProductEventSource = (typeof PRODUCT_EVENT_SOURCES)[number];

export type ProductEventPropertySpec =
  | { readonly type: "enum"; readonly values: readonly string[] }
  | { readonly type: "boolean" }
  | { readonly type: "integer" }
  /**
   * Only for short tokens such as a campaign source; never free text. Values
   * must match PRODUCT_EVENT_STRING_TOKEN, so an email, phone number or
   * sentence cannot get through.
   */
  | { readonly type: "string"; readonly maxLength: number };

export const PRODUCT_EVENT_STRING_TOKEN = /^[a-z0-9_-]*$/;

export interface ProductEventSpec {
  /** The question this event answers. "It might be useful" is not one. */
  readonly question: string;
  /** Who asked for it (and reads the answer). */
  readonly requestedBy: string;
  readonly sources: readonly ProductEventSource[];
  readonly properties: Readonly<Record<string, ProductEventPropertySpec>>;
}

const WEB_CLIENTS = ["web", "desktop"] as const;

const PWA_INSTALL_PROPERTIES = {
  platform: { type: "enum", values: ["ios_safari", "ios_other", "android_chromium", "desktop_chromium", "other"] },
  surface: { type: "enum", values: ["notification_center", "ios_instruction_sheet", "settings"] },
  trigger: { type: "enum", values: ["supported_browser", "settings"] },
  display_mode: { type: "enum", values: ["browser", "standalone", "fullscreen", "minimal-ui", "unknown"] },
  session_count_bucket: { type: "enum", values: ["1", "2", "3-5", "6+"] },
  cooldown_state: { type: "enum", values: ["not_dismissed", "dismissed_active", "expired"] },
  outcome: { type: "enum", values: ["accepted", "dismissed"] },
} as const;

const PWA_INSTALL_QUESTION =
  "Does the add-to-home-screen prompt get mobile web users to install the app, and where do they drop off (per platform and surface)?";

export const PAGE_VIEW_ROUTES = [
  "channel", "dm", "activity", "tasks", "saved", "search", "members", "members_graph",
  "agent", "human", "computer", "computers", "settings", "release_notes",
] as const;

/** Settings tab ids (web `SETTINGS_TABS`; a web test keeps the two in sync). */
export const SETTINGS_PAGE_TABS = [
  "account", "language-region", "appearance", "notifications", "server", "billing", "administration",
  "im-bridges", "integrations", "labs", "mcp", "providers", "about", "feedback",
] as const;

export const AGENT_CREATE_ENTRIES = ["sidebar", "sidebar_external", "channel_members", "computer_detail"] as const;

// First journey batch, reviewed with Vivian / meichen in
// #raft-botiverse-user-analytics (2026-10-05). Outcomes (an agent exists) stay
// database facts; these record only the path.
const JOURNEY_REVIEW = "nova; reviewed by Vivian/meichen (2026-10-05)";

export const PRODUCT_EVENT_REGISTRY = {
  page_viewed: {
    question: "Which parts of the Raft app do people use, and how often? (In-app navigation only; not raft.build / docs site visits.)",
    requestedBy: JOURNEY_REVIEW,
    sources: WEB_CLIENTS,
    properties: {
      route: { type: "enum", values: PAGE_VIEW_ROUTES },
      settings_tab: { type: "enum", values: SETTINGS_PAGE_TABS },
    },
  },
  agent_create_opened: {
    question: "From which entry points, outside the onboarding wizard, do people start creating an agent?",
    requestedBy: JOURNEY_REVIEW,
    sources: WEB_CLIENTS,
    properties: { entry: { type: "enum", values: AGENT_CREATE_ENTRIES } },
  },
  activity_open: {
    question: "How often do people open Activity, and from which entry point?",
    requestedBy: "stdrc",
    sources: WEB_CLIENTS,
    properties: { from: { type: "enum", values: ["rail", "sidebar"] } },
  },
  activity_item_open: {
    question: "Which kinds of Activity items do people open?",
    requestedBy: "stdrc",
    sources: WEB_CLIENTS,
    properties: { item_kind: { type: "enum", values: ["channel", "dm", "thread", "mention_action"] } },
  },
  activity_mark: {
    question: "Do people triage Activity items (mark read / done)?",
    requestedBy: "stdrc",
    sources: WEB_CLIENTS,
    properties: { action: { type: "enum", values: ["read", "done"] } },
  },
  community_cn_qr_page_view: {
    question: "How many people reach the Chinese community QR page, and from which campaign source?",
    requestedBy: "iynewz",
    sources: WEB_CLIENTS,
    properties: { from: { type: "string", maxLength: 64 } },
  },
  pwa_install_eligible: { question: PWA_INSTALL_QUESTION, requestedBy: "stdrc", sources: WEB_CLIENTS, properties: PWA_INSTALL_PROPERTIES },
  pwa_install_cta_shown: { question: PWA_INSTALL_QUESTION, requestedBy: "stdrc", sources: WEB_CLIENTS, properties: PWA_INSTALL_PROPERTIES },
  pwa_install_cta_clicked: { question: PWA_INSTALL_QUESTION, requestedBy: "stdrc", sources: WEB_CLIENTS, properties: PWA_INSTALL_PROPERTIES },
  pwa_install_native_prompt_result: { question: PWA_INSTALL_QUESTION, requestedBy: "stdrc", sources: WEB_CLIENTS, properties: PWA_INSTALL_PROPERTIES },
  pwa_install_ios_instruction_dismissed: { question: PWA_INSTALL_QUESTION, requestedBy: "stdrc", sources: WEB_CLIENTS, properties: PWA_INSTALL_PROPERTIES },
  pwa_install_appinstalled: { question: PWA_INSTALL_QUESTION, requestedBy: "stdrc", sources: WEB_CLIENTS, properties: PWA_INSTALL_PROPERTIES },
  pwa_install_standalone_detected: { question: PWA_INSTALL_QUESTION, requestedBy: "stdrc", sources: WEB_CLIENTS, properties: PWA_INSTALL_PROPERTIES },
} as const satisfies Record<string, ProductEventSpec>;

type Registry = typeof PRODUCT_EVENT_REGISTRY;

export type ProductEventName = keyof Registry;

type PropertyValue<S> =
  S extends { type: "enum"; values: readonly (infer V)[] } ? V
    : S extends { type: "boolean" } ? boolean
      : S extends { type: "integer" } ? number
        : string;

export type ProductEventProperties<E extends ProductEventName> = {
  -readonly [K in keyof Registry[E]["properties"]]?: PropertyValue<Registry[E]["properties"][K]>;
};

export type ProductEventRejection =
  | "unregistered_event"
  | "source_not_allowed"
  | "unknown_property"
  | "invalid_property_value";

export type ProductEventValidation =
  | { ok: true; event: ProductEventName }
  | { ok: false; reason: ProductEventRejection; property?: string };

export function isProductEventName(name: string): name is ProductEventName {
  return Object.prototype.hasOwnProperty.call(PRODUCT_EVENT_REGISTRY, name);
}

function isValidPropertyValue(spec: ProductEventPropertySpec, value: unknown): boolean {
  switch (spec.type) {
    case "enum":
      return typeof value === "string" && spec.values.includes(value);
    case "boolean":
      return typeof value === "boolean";
    case "integer":
      return Number.isSafeInteger(value);
    case "string":
      return typeof value === "string" && value.length <= spec.maxLength && PRODUCT_EVENT_STRING_TOKEN.test(value);
  }
}

/**
 * Checks an incoming event against the registry. Missing properties are
 * allowed; unknown ones and values outside the declared type are not.
 */
export function validateProductEvent(
  name: string,
  properties: Readonly<Record<string, unknown>>,
  source: ProductEventSource,
): ProductEventValidation {
  if (!isProductEventName(name)) return { ok: false, reason: "unregistered_event" };
  const spec: ProductEventSpec = PRODUCT_EVENT_REGISTRY[name];
  if (!spec.sources.includes(source)) return { ok: false, reason: "source_not_allowed" };
  for (const [property, value] of Object.entries(properties)) {
    if (value === undefined) continue;
    const propertySpec = Object.prototype.hasOwnProperty.call(spec.properties, property)
      ? spec.properties[property]
      : undefined;
    if (!propertySpec) return { ok: false, reason: "unknown_property", property };
    if (!isValidPropertyValue(propertySpec, value)) {
      return { ok: false, reason: "invalid_property_value", property };
    }
  }
  return { ok: true, event: name };
}
