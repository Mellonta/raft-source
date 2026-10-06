import { spawn } from "node:child_process";

type TtyReadable = NodeJS.ReadableStream & {
  isTTY?: boolean;
  pause?: () => unknown;
  resume?: () => unknown;
};

export function canInstallEnterToOpenUrl(input: NodeJS.ReadableStream | undefined): boolean {
  const tty = input as TtyReadable | undefined;
  return Boolean(tty?.isTTY === true && typeof tty.on === "function" && typeof tty.off === "function");
}

/**
 * Only a parsed http(s) URL is ever handed to the OS opener, as its
 * normalized form (no spaces or quotes survive normalization). Anything else
 * returns null and is left for the user to copy from the printed text.
 */
export function normalizeBrowserUrl(url: string): string | null {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return null;
  }
  if (parsed.protocol !== "https:" && parsed.protocol !== "http:") return null;
  if (/[\s"]/.test(parsed.href)) return null;
  return parsed.href;
}

export function browserOpenCommand(
  url: string,
  platform: NodeJS.Platform = process.platform,
): { command: string; args: string[] } | null {
  const href = normalizeBrowserUrl(url);
  if (!href) return null;
  if (platform === "darwin") return { command: "open", args: [href] };
  // Windows: hand the URL straight to the URL protocol handler. No cmd.exe,
  // so characters such as & or ^ in the query are never interpreted.
  if (platform === "win32") return { command: "rundll32.exe", args: ["url.dll,FileProtocolHandler", href] };
  return { command: "xdg-open", args: [href] };
}

export function openUrlInBrowser(url: string, spawnImpl: typeof spawn = spawn): void {
  const opener = browserOpenCommand(url);
  if (!opener) return;

  const child = spawnImpl(opener.command, opener.args, {
    detached: true,
    stdio: "ignore",
    windowsHide: true,
  });
  child.on("error", () => {
    // Best-effort convenience only. The URL is already printed for manual copy.
  });
  child.unref();
}

export function installEnterToOpenUrl(options: {
  input: NodeJS.ReadableStream | undefined;
  url: string;
  openUrl?: (url: string) => void;
}): () => void {
  if (!canInstallEnterToOpenUrl(options.input)) return () => {};

  const input = options.input as TtyReadable;
  const openUrl = options.openUrl ?? openUrlInBrowser;
  let active = true;

  const cleanup = () => {
    if (!active) return;
    active = false;
    input.off("data", onData);
    input.pause?.();
  };

  const onData = (chunk: unknown) => {
    const text = Buffer.isBuffer(chunk) ? chunk.toString("utf8") : String(chunk);
    if (!text.includes("\n") && !text.includes("\r")) return;
    cleanup();
    openUrl(options.url);
  };

  input.on("data", onData);
  input.resume?.();
  return cleanup;
}
