export type UpstreamErrorCode = "timeout" | "network" | "malformed" | "unauthorized" | "http" | "unavailable";

export function redactDiagnostic(message: string): string {
  return message
    .replace(/(https?:\/\/)[^\s/@]+(?::[^\s/@]*)?@/giu, "$1[REDACTED]@")
    .replace(/([?&](?:access_token|api_key|apikey|password|secret|token)=)[^&\s]*/giu, "$1[REDACTED]")
    .replace(/\b(?:access_token|api_key|apikey|password|secret|token)=\S+/giu, (match) => `${match.split("=", 1)[0]}=[REDACTED]`)
    .replace(/\b(authorization|cookie|set-cookie|x-api-key):\s*[^\r\n]*/giu, "$1: [REDACTED]")
    .replace(/(["'](?:access_token|api_key|apikey|authorization|cookie|password|secret|token)["']\s*:\s*["'])[^"'\r\n]*/giu, "$1[REDACTED]")
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

export interface TextRequestOptions extends JsonRequestOptions {
  readonly maxBytes: number;
}

export interface TextHttpClient {
  getText(url: string, options: TextRequestOptions): Promise<string>;
}

export interface FetchJsonHttpClientOptions {
  readonly fetchImpl?: typeof fetch;
  readonly timeoutMs: number;
}

interface PendingResponse {
  readonly response: Response;
  readonly signal: AbortSignal;
  finish(): void;
}

export class FetchJsonHttpClient implements JsonHttpClient, TextHttpClient {
  private readonly fetchImpl: typeof fetch;
  private readonly timeoutMs: number;

  constructor(options: FetchJsonHttpClientOptions) {
    if (!Number.isInteger(options.timeoutMs) || options.timeoutMs < 1) throw new Error("timeoutMs must be a positive integer");
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.timeoutMs = options.timeoutMs;
  }

  private async get(url: string, options: JsonRequestOptions): Promise<PendingResponse> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.timeoutMs);
    let response: Response;
    try {
      response = await this.fetchImpl(url, { method: "GET", headers: options.headers, signal: controller.signal });
    } catch (cause: unknown) {
      clearTimeout(timeout);
      if (controller.signal.aborted || (cause instanceof DOMException && cause.name === "AbortError")) {
        throw new UpstreamError("timeout", `Upstream request timed out after ${this.timeoutMs} ms: ${url}`);
      }
      throw new UpstreamError("network", `Upstream request failed: ${url}; ${cause instanceof Error ? cause.message : "unknown error"}`);
    }
    if (response.status === 401 || response.status === 403) {
      clearTimeout(timeout);
      throw new UpstreamError("unauthorized", `Upstream rejected read-only request with HTTP ${response.status}: ${url}`);
    }
    if (!response.ok) {
      clearTimeout(timeout);
      throw new UpstreamError("http", `Upstream returned HTTP ${response.status}: ${url}`);
    }
    return { response, signal: controller.signal, finish: () => clearTimeout(timeout) };
  }

  async getJson(url: string, options: JsonRequestOptions = {}): Promise<unknown> {
    const pending = await this.get(url, options);
    try {
      return await pending.response.json() as unknown;
    } catch (cause: unknown) {
      if (pending.signal.aborted || (cause instanceof DOMException && cause.name === "AbortError")) {
        throw new UpstreamError("timeout", `Upstream request timed out after ${this.timeoutMs} ms: ${url}`);
      }
      throw new UpstreamError("malformed", `Upstream returned malformed JSON: ${url}; ${cause instanceof Error ? cause.message : "parse failure"}`);
    } finally {
      pending.finish();
    }
  }

  async getText(url: string, options: TextRequestOptions): Promise<string> {
    if (!Number.isInteger(options.maxBytes) || options.maxBytes < 1 || options.maxBytes > 1_000_000) {
      throw new Error("Text response maxBytes must be 1..1000000");
    }
    const pending = await this.get(url, options);
    try {
      const declaredLength = pending.response.headers.get("content-length");
      if (declaredLength !== null && Number(declaredLength) > options.maxBytes) {
        throw new UpstreamError("malformed", `Upstream text response exceeds ${options.maxBytes} bytes: ${url}`);
      }
      const reader = pending.response.body?.getReader();
      if (reader === undefined) return "";
      const chunks: Uint8Array[] = [];
      let byteLength = 0;
      let result = await reader.read();
      while (!result.done) {
        byteLength += result.value.byteLength;
        if (byteLength > options.maxBytes) {
          try { await reader.cancel(); } catch { /* bounded rejection is already explicit */ }
          throw new UpstreamError("malformed", `Upstream text response exceeds ${options.maxBytes} bytes: ${url}`);
        }
        chunks.push(result.value);
        result = await reader.read();
      }
      const bytes = new Uint8Array(byteLength);
      let offset = 0;
      for (const chunk of chunks) {
        bytes.set(chunk, offset);
        offset += chunk.byteLength;
      }
      try {
        return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
      } catch {
        throw new UpstreamError("malformed", `Upstream returned invalid UTF-8 text: ${url}`);
      }
    } catch (cause: unknown) {
      if (pending.signal.aborted || (cause instanceof DOMException && cause.name === "AbortError")) {
        throw new UpstreamError("timeout", `Upstream request timed out after ${this.timeoutMs} ms: ${url}`);
      }
      throw cause;
    } finally {
      pending.finish();
    }
  }
}
