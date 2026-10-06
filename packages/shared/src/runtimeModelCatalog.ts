/**
 * Model-label catalog (task #700): one shared source for model display names.
 *
 * The daemon reports each runtime's model list (the runtime's own id + label
 * pairs); the server stores it per machine and serves it to every member, so
 * the runtime-config dropdown and every display surface (name rows, machine
 * page, panel badge, profile card) resolve the same (runtime, id) to the same
 * string.
 */

export interface RuntimeModelCatalogEntry {
  id: string;
  label: string;
}

export const RUNTIME_MODEL_CATALOG_MAX_ENTRIES = 500;
export const RUNTIME_MODEL_CATALOG_MAX_ID_LENGTH = 200;
export const RUNTIME_MODEL_CATALOG_MAX_LABEL_LENGTH = 200;

/** Per-runtime slice of a machine's catalog. */
export interface MachineRuntimeModelCatalogEntry {
  models: RuntimeModelCatalogEntry[];
  /** Server receive time of the latest report for this runtime (ISO). */
  updatedAt: string;
}

/** One machine's catalog: runtime id -> its model list. */
export interface MachineRuntimeModelCatalog {
  runtimes: Record<string, MachineRuntimeModelCatalogEntry>;
}

/**
 * The member-readable API shape: machine id -> that machine's catalog.
 * Deliberately only ids, labels and timestamps — no machine paths, provider
 * configuration or anything else from the computer.
 */
export interface ServerModelLabelCatalog {
  machines: Record<string, MachineRuntimeModelCatalog>;
}

/**
 * Strictly validate a report's model list. Cards are display-only data, so
 * anything malformed, duplicated or oversized is dropped instead of trusted;
 * a report with zero valid entries is rejected (null) and the server keeps
 * its previous copy.
 */
/** C0/C1 control characters. Mirrors the daemon-side sanitization: labels
 *  are cleaned, ids carrying control characters drop the whole entry. */
const CONTROL_CHAR_TEST = /[\u0000-\u001f\u007f-\u009f]/;
const CONTROL_CHARS = /[\u0000-\u001f\u007f-\u009f]/g;

export function safeParseRuntimeModelCatalogEntries(value: unknown): RuntimeModelCatalogEntry[] | null {
  if (!Array.isArray(value) || value.length === 0 || value.length > RUNTIME_MODEL_CATALOG_MAX_ENTRIES) {
    return null;
  }
  const byId = new Map<string, RuntimeModelCatalogEntry>();
  for (const candidate of value) {
    if (!candidate || typeof candidate !== "object" || Array.isArray(candidate)) continue;
    const record = candidate as Record<string, unknown>;
    const id = typeof record.id === "string" ? record.id.trim() : "";
    if (!id || CONTROL_CHAR_TEST.test(id)) continue;
    const rawLabel = typeof record.label === "string" ? record.label : "";
    const label = rawLabel.replace(CONTROL_CHARS, "").trim();
    if (!label) continue;
    if (id.length > RUNTIME_MODEL_CATALOG_MAX_ID_LENGTH) continue;
    if (label.length > RUNTIME_MODEL_CATALOG_MAX_LABEL_LENGTH) continue;
    byId.set(id, { id, label });
  }
  return byId.size > 0 ? [...byId.values()] : null;
}
