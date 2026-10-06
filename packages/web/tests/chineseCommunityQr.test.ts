import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import {
  CHINESE_COMMUNITY_QR_CONFIG_URL,
  getChineseCommunityQrConfigUrl,
  isChineseCommunityQrExpired,
  normalizeChineseCommunityQrConfig,
  resolveChineseCommunityQrConfig,
} from "../src/utils/chineseCommunityQr";

test("Chinese community QR public config placeholder exists at the fetched path", () => {
  const config = JSON.parse(readFileSync(new URL("../public/community/chinese-qr.json", import.meta.url), "utf8")) as {
    imageUrl?: unknown;
  };
  assert.equal(typeof config.imageUrl, "string");
  if (typeof config.imageUrl === "string" && config.imageUrl.startsWith("/community/")) {
    const publicAssetPath = config.imageUrl.replace("/community/", "../public/community/");
    assert.equal(existsSync(new URL(publicAssetPath, import.meta.url)), true);
  }
});

test("Chinese community QR config normalizes only valid image URLs", () => {
  assert.deepEqual(
    normalizeChineseCommunityQrConfig({
      imageUrl: " /community/qr.png ",
      updatedAt: " 2026-09-08 ",
      expiresAt: " 2026-10-08 ",
      fallbackContact: " support@raft.build ",
    }),
    {
      imageUrl: "/community/qr.png",
      updatedAt: "2026-09-08",
      expiresAt: "2026-10-08",
      fallbackContact: "support@raft.build",
    },
  );
  assert.equal(normalizeChineseCommunityQrConfig({ imageUrl: " " }), null);
  assert.equal(normalizeChineseCommunityQrConfig(null), null);
});

test("Chinese community QR config resolves only same-origin community images", () => {
  assert.equal(
    resolveChineseCommunityQrConfig(
      { imageUrl: "/community/qr.png" },
      "https://static.raft.build/community/chinese-qr.json",
    )?.imageUrl,
    "https://static.raft.build/community/qr.png",
  );
  assert.equal(
    resolveChineseCommunityQrConfig(
      { imageUrl: "https://example.com/community/qr.png" },
      "https://static.raft.build/community/chinese-qr.json",
    ),
    null,
  );
  assert.equal(
    resolveChineseCommunityQrConfig(
      { imageUrl: "/other/qr.png" },
      "https://static.raft.build/community/chinese-qr.json",
    ),
    null,
  );
  assert.equal(
    resolveChineseCommunityQrConfig(
      { imageUrl: "/community/qr.png?version=1" },
      "https://static.raft.build/community/chinese-qr.json",
    ),
    null,
  );
  assert.equal(
    resolveChineseCommunityQrConfig(
      { imageUrl: "/community/qr.png" },
      "http://static.raft.build/community/chinese-qr.json",
    ),
    null,
  );
});

test("Chinese community QR expiry ignores invalid dates and flags past dates", () => {
  assert.equal(isChineseCommunityQrExpired(undefined, new Date("2026-09-08T00:00:00.000Z")), false);
  assert.equal(isChineseCommunityQrExpired("not-a-date", new Date("2026-09-08T00:00:00.000Z")), false);
  assert.equal(isChineseCommunityQrExpired("2026-09-07T23:59:59.999Z", new Date("2026-09-08T00:00:00.000Z")), true);
  assert.equal(isChineseCommunityQrExpired("2026-09-08T00:00:00.000Z", new Date("2026-09-08T00:00:00.000Z")), false);
});

test("Chinese community QR config URL defaults to the static assets site", () => {
  assert.equal(getChineseCommunityQrConfigUrl(), CHINESE_COMMUNITY_QR_CONFIG_URL);
});
