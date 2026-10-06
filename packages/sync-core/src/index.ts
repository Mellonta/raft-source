export * from "./core";
export * from "./types";
export * from "./violations";
export * from "./testing";
export * from "./domains/activity";
export * from "./domains/read-state";
export type {
  ActivityFilter,
  ActivityScope,
  ActivityWindow,
  ChannelActivityRow,
  DifferenceIngress,
  DmActivityRow,
  NotModifiedIngress,
  SnapshotIngress,
  SnapshotRequiredBody,
  ThreadActivityRow,
} from "../contracts/activity-v1/generated/bindings/activity-sync";

/**
 * The CANONICAL generated Activity row union, exported under a DISTINCT name.
 *
 * It cannot be exported as `ActivityRow`: the root already re-exports a
 * permissive runtime `ActivityRow` (`ActivityRowBase & {type: string} &
 * Record<string, unknown>`) via `export * from "./domains/activity"`, and a
 * same-name export collapses to an unconstrained surface — silently removing
 * every compile-time guarantee a consumer thinks it is getting. (@赵梓淇 P1.)
 */
export type { ActivityRow as ActivityContractRow } from "../contracts/activity-v1/generated/bindings/activity-sync";
