import type {
  RuntimeAccountUsageProvider,
  RuntimeAccountUsageSnapshot,
} from "@botiverse/raft-shared";
import api from "../api/client";

export const RUNTIME_ACCOUNT_USAGE_CLIENT_CACHE_MS = 60_000;
export const RUNTIME_ACCOUNT_USAGE_CLIENT_REFRESH_COOLDOWN_MS = 120_000;

export type RuntimeAccountUsageReadResult =
  | { state: "missing"; snapshot: null }
  | { state: "fresh" | "stale"; snapshot: RuntimeAccountUsageSnapshot };

export type RuntimeAccountUsageRefreshResult = {
  accepted: boolean;
  state: "requested" | "cooldown" | "computer_offline" | "fresh" | "timeout";
  /**
   * Present when `state === "fresh"`: the snapshot the machine just detected,
   * in the same shape the read path returns. Manual refreshes await the
   * machine's reply through the server relay and carry the value inline.
   */
  snapshot?: RuntimeAccountUsageSnapshot | null;
};

type GetJson = (url: string) => Promise<RuntimeAccountUsageReadResult>;
type PostJson = (url: string, body: unknown) => Promise<RuntimeAccountUsageRefreshResult>;

function requestKey(serverId: string, machineId: string, provider: RuntimeAccountUsageProvider): string {
  return `${serverId}\0${machineId}\0${provider}`;
}

export class RuntimeAccountUsageClient {
  private readonly cache = new Map<string, { value: RuntimeAccountUsageReadResult; expiresAt: number }>();
  private readonly reads = new Map<string, Promise<RuntimeAccountUsageReadResult>>();
  private readonly refreshes = new Map<string, Promise<RuntimeAccountUsageRefreshResult>>();
  private readonly refreshStartedAt = new Map<string, number>();

  constructor(
    private readonly getJson: GetJson,
    private readonly postJson: PostJson,
    private readonly now: () => number = Date.now,
  ) {}

  read(serverId: string, machineId: string, provider: RuntimeAccountUsageProvider): Promise<RuntimeAccountUsageReadResult> {
    const key = requestKey(serverId, machineId, provider);
    const cached = this.cache.get(key);
    if (cached && cached.expiresAt > this.now()) return Promise.resolve(cached.value);
    const pending = this.reads.get(key);
    if (pending) return pending;
    const url = `/servers/${serverId}/machines/${machineId}/runtime-account-usage/${provider}`;
    const request = this.getJson(url).then((value) => {
      this.cache.set(key, { value, expiresAt: this.now() + RUNTIME_ACCOUNT_USAGE_CLIENT_CACHE_MS });
      return value;
    }).finally(() => {
      if (this.reads.get(key) === request) this.reads.delete(key);
    });
    this.reads.set(key, request);
    return request;
  }

  refresh(
    serverId: string,
    machineId: string,
    provider: RuntimeAccountUsageProvider,
    reason: "manual" | "stale_or_missing",
  ): Promise<RuntimeAccountUsageRefreshResult> {
    const key = requestKey(serverId, machineId, provider);
    const pending = this.refreshes.get(key);
    if (pending) return pending;
    const lastStartedAt = this.refreshStartedAt.get(key);
    if (lastStartedAt !== undefined && this.now() - lastStartedAt < RUNTIME_ACCOUNT_USAGE_CLIENT_REFRESH_COOLDOWN_MS) {
      return Promise.resolve({ accepted: false, state: "cooldown" });
    }
    this.refreshStartedAt.set(key, this.now());
    const url = `/servers/${serverId}/machines/${machineId}/runtime-account-usage/${provider}/refresh`;
    const request = this.postJson(url, { reason }).then((result) => {
      // A manual refresh can wait for the machine's reply (server relay): a
      // `fresh` result carries the snapshot itself. Write it in the read-path
      // shape so the chip can render it in place and later reads reuse it.
      if (result.state === "fresh" && result.snapshot) {
        this.cache.set(key, {
          value: { state: "fresh", snapshot: result.snapshot },
          expiresAt: this.now() + RUNTIME_ACCOUNT_USAGE_CLIENT_CACHE_MS,
        });
      }
      return result;
    }).finally(() => {
      if (this.refreshes.get(key) === request) this.refreshes.delete(key);
    });
    this.refreshes.set(key, request);
    return request;
  }

  /** Milliseconds left before another refresh is allowed for this subject
   *  (0 when the window is open). Drives the chip's disabled + countdown state
   *  so a refused click is explained before it happens (task #704). */
  refreshCooldownRemainingMs(
    serverId: string,
    machineId: string,
    provider: RuntimeAccountUsageProvider,
  ): number {
    const lastStartedAt = this.refreshStartedAt.get(requestKey(serverId, machineId, provider));
    if (lastStartedAt === undefined) return 0;
    return Math.max(0, RUNTIME_ACCOUNT_USAGE_CLIENT_REFRESH_COOLDOWN_MS - (this.now() - lastStartedAt));
  }

  invalidate(serverId: string, machineId: string, provider: RuntimeAccountUsageProvider): void {
    this.cache.delete(requestKey(serverId, machineId, provider));
  }

  clear(): void {
    this.cache.clear();
    this.reads.clear();
    this.refreshes.clear();
    this.refreshStartedAt.clear();
  }
}

export const runtimeAccountUsageClient = new RuntimeAccountUsageClient(
  async (url) => (await api.get<RuntimeAccountUsageReadResult>(url)).data,
  async (url, body) => (await api.post<RuntimeAccountUsageRefreshResult>(url, body)).data,
);
