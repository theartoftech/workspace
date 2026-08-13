export type UpstreamErrorCode = "timeout" | "network" | "malformed" | "unauthorized" | "http" | "unavailable";

export function redactDiagnostic(message: string): string {
  return message
    .replace(/(https?:\/\/)[^\s/@]+(?::[^\s/@]*)?@/giu, "$1[REDACTED]@")
    .replace(/([?&](?:access_token|api_key|apikey|password|secret|token)=)[^&\s]*/giu, "$1[REDACTED]")
    .replace(/\b(?:access_token|api_key|apikey|password|secret|token)=\S+/giu, (match) => `${match.split("=", 1)[0]}=[REDACTED]`)
    .replace(/\b(authorization|cookie|set-cookie|x-api-key):\s*[^\r\n]*/giu, "$1: [REDACTED]")
    .replace(/\bBearer\s+[A-Za-z0-9._~+/-]+=*/giu, "Bearer [REDACTED]");
}

export class UpstreamError extends Error {
  readonly code: UpstreamErrorCode;

  constructor(code: UpstreamErrorCode, message: string) {
    super(redactDiagnostic(message));
    this.name = "UpstreamError";
    this.code = code;
  }
}

export interface JsonRequestOptions {
  readonly headers?: Readonly<Record<string, string>>;
}

export interface JsonHttpClient {
  getJson(url: string, options?: JsonRequestOptions): Promise<unknown>;
}

export interface FetchJsonHttpClientOptions {
  readonly fetchImpl?: typeof fetch;
  readonly timeoutMs: number;
}

export class FetchJsonHttpClient implements JsonHttpClient {
  private readonly fetchImpl: typeof fetch;
  private readonly timeoutMs: number;

  constructor(options: FetchJsonHttpClientOptions) {
    if (!Number.isInteger(options.timeoutMs) || options.timeoutMs < 1) throw new Error("timeoutMs must be a positive integer");
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.timeoutMs = options.timeoutMs;
  }

  async getJson(url: string, options: JsonRequestOptions = {}): Promise<unknown> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.timeoutMs);
    let response: Response;
    try {
      response = await this.fetchImpl(url, { method: "GET", headers: options.headers, signal: controller.signal });
    } catch (cause: unknown) {
      if (controller.signal.aborted || (cause instanceof DOMException && cause.name === "AbortError")) {
        throw new UpstreamError("timeout", `Upstream request timed out after ${this.timeoutMs} ms: ${url}`);
      }
      throw new UpstreamError("network", `Upstream request failed: ${url}; ${cause instanceof Error ? cause.message : "unknown error"}`);
    } finally {
      clearTimeout(timeout);
    }
    if (response.status === 401 || response.status === 403) throw new UpstreamError("unauthorized", `Upstream rejected read-only request with HTTP ${response.status}: ${url}`);
    if (!response.ok) throw new UpstreamError("http", `Upstream returned HTTP ${response.status}: ${url}`);
    try {
      return await response.json() as unknown;
    } catch (cause: unknown) {
      throw new UpstreamError("malformed", `Upstream returned malformed JSON: ${url}; ${cause instanceof Error ? cause.message : "parse failure"}`);
    }
  }
}
