/**
 * Narrow import leaf for the `client` rule stage so the Feature Flag Admin Worker shares the server's
 * exact validation, matching and conflict rules without importing the package root.
 */
export * from "./src/featureFlagClientRules";
