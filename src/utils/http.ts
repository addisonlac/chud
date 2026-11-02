import { childLogger } from "./logger.js";

const log = childLogger("http");

export class HttpError extends Error {
  constructor(
    message: string,
    public readonly status: number,
    public readonly body?: unknown,
  ) {
    super(message);
    this.name = "HttpError";
  }
}

interface FetchJsonOptions extends RequestInit {
  timeoutMs?: number;
  retries?: number;
  retryDelayMs?: number;
}

/**
 * fetch() wrapper with a timeout and bounded retries on 429/5xx/network
 * errors, so every API client gets resilience for free.
 */
export async function fetchJson<T>(url: string, options: FetchJsonOptions = {}): Promise<T> {
  const { timeoutMs = 10_000, retries = 2, retryDelayMs = 400, ...init } = options;

  let lastError: unknown;

  for (let attempt = 0; attempt <= retries; attempt++) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);

    try {
      const res = await fetch(url, { ...init, signal: controller.signal });
      clearTimeout(timer);

      if (!res.ok) {
        const body = await res.text().catch(() => undefined);
        const retryable = res.status === 429 || res.status >= 500;
        if (retryable && attempt < retries) {
          await sleep(retryDelayMs * (attempt + 1));
          continue;
        }
        throw new HttpError(`HTTP ${res.status} for ${url}`, res.status, body);
      }

      return (await res.json()) as T;
    } catch (err) {
      clearTimeout(timer);
      lastError = err;
      if (attempt < retries) {
        log.debug({ url, attempt, err: (err as Error).message }, "retrying request");
        await sleep(retryDelayMs * (attempt + 1));
        continue;
      }
    }
  }

  throw lastError instanceof Error ? lastError : new Error(`Request failed: ${url}`);
}

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export const USER_AGENT =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36 OutreachAudit/1.0";

export interface FetchTextResult {
  ok: boolean;
  status: number;
  /** Final URL after redirects. */
  url: string;
  html: string;
  headers: Headers;
  ms: number;
}

/**
 * GET a web page as text. Never throws for HTTP errors (a 404/500 is a
 * finding, not a crash); throws only on network/TLS/timeout failures.
 */
export async function fetchText(
  url: string,
  opts: { timeoutMs?: number; maxBytes?: number; headers?: Record<string, string> } = {},
): Promise<FetchTextResult> {
  const { timeoutMs = 15_000, maxBytes = 3_000_000 } = opts;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const start = Date.now();
  try {
    const res = await fetch(url, {
      redirect: "follow",
      signal: controller.signal,
      headers: { "user-agent": USER_AGENT, accept: "text/html,application/xhtml+xml,application/json;q=0.9,*/*;q=0.8", ...opts.headers },
    });
    const text = await res.text();
    return { ok: res.ok, status: res.status, url: res.url || url, html: text.slice(0, maxBytes), headers: res.headers, ms: Date.now() - start };
  } finally {
    clearTimeout(timer);
  }
}
