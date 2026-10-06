import { isElectronDesktopShell, shareableWebOrigin } from "../src/utils/desktopShell";

type MutableGlobal = typeof globalThis & { window?: unknown };

afterEach(() => {
  delete (globalThis as MutableGlobal).window;
});

describe("isElectronDesktopShell", () => {
  it("is true only when the Electron preload set raftDesktop.isDesktop", () => {
    (globalThis as MutableGlobal).window = { raftDesktop: { isDesktop: true } };
    expect(isElectronDesktopShell()).toBe(true);

    (globalThis as MutableGlobal).window = { raftDesktop: { isDesktop: false } };
    expect(isElectronDesktopShell()).toBe(false);

    (globalThis as MutableGlobal).window = {};
    expect(isElectronDesktopShell()).toBe(false);
  });
});

describe("shareableWebOrigin", () => {
  it("uses the compiled frontend origin in the desktop shell, where the page origin is app://raft", () => {
    // The bug: on desktop window.location.origin is the app://raft custom
    // protocol, so a join link built from it is unopenable. The compiled
    // VITE_FRONTEND_URL is the trusted browser-openable origin.
    expect(shareableWebOrigin(true, "app://raft", "https://app.raft.build")).toBe("https://app.raft.build");
  });

  it("returns the page origin on the Web app (no desktop shell), leaving Web unchanged", () => {
    expect(shareableWebOrigin(false, "https://raft.build", "https://app.raft.build")).toBe("https://raft.build");
    expect(shareableWebOrigin(false, "https://self-hosted.example", "")).toBe("https://self-hosted.example");
  });

  it("does not fabricate an origin: falls back to the page origin if the desktop build shipped without VITE_FRONTEND_URL", () => {
    // The Electron vite config sets a default, so this edge does not occur in
    // real builds; the test documents that we never invent an https origin.
    expect(shareableWebOrigin(true, "app://raft", "")).toBe("app://raft");
  });

  it("wires the real host by default: reads the Electron raftDesktop global for detection", () => {
    (globalThis as MutableGlobal).window = { raftDesktop: { isDesktop: true }, location: { origin: "app://raft" } };
    // desktop defaults to isElectronDesktopShell() (reads the global) -> true.
    expect(shareableWebOrigin(undefined, undefined, "https://app.raft.build")).toBe("https://app.raft.build");
  });
});
