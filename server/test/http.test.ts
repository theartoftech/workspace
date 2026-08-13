import { describe, expect, it, vi } from "vitest";

import { FetchJsonHttpClient, redactDiagnostic } from "../src/http";

describe("bounded upstream HTTP client", () => {
  it("redacts credentials, sensitive query values, and headers", () => {
    const diagnostic = redactDiagnostic("https://admin:secret@example.test/path?token=abc&safe=yes Authorization: Bearer xyz Cookie: session=123");
    expect(diagnostic).not.toMatch(/secret|abc|xyz|session=123/);
    expect(diagnostic).toContain("[REDACTED]");
  });

  it("maps timeouts and malformed JSON explicitly", async () => {
    const timeoutFetch = vi.fn(async (_input: string | URL | Request, init?: RequestInit): Promise<Response> => {
      await new Promise((_resolve, reject) => init?.signal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError"))));
      throw new Error("unreachable");
    });
    const timeoutClient = new FetchJsonHttpClient({ fetchImpl: timeoutFetch, timeoutMs: 5 });
    await expect(timeoutClient.getJson("https://example.test/status?token=secret")).rejects.toThrow("timed out");

    const malformedClient = new FetchJsonHttpClient({ fetchImpl: async (): Promise<Response> => new Response("not-json", { status: 200 }), timeoutMs: 100 });
    await expect(malformedClient.getJson("https://example.test/status")).rejects.toThrow("malformed JSON");
  });

  it("maps HTTP, authorization, and network failures and forwards read-only headers", async () => {
    const headersFetch = vi.fn(async (_input: string | URL | Request, init?: RequestInit): Promise<Response> => {
      expect(init?.method).toBe("GET");
      expect(init?.headers).toEqual({ Accept: "application/json" });
      return new Response(JSON.stringify({ ok: true }), { status: 200 });
    });
    await expect(new FetchJsonHttpClient({ fetchImpl: headersFetch, timeoutMs: 100 }).getJson("https://example.test", { headers: { Accept: "application/json" } })).resolves.toEqual({ ok: true });

    for (const status of [401, 403]) {
      const client = new FetchJsonHttpClient({ fetchImpl: async (): Promise<Response> => new Response("denied", { status }), timeoutMs: 100 });
      await expect(client.getJson("https://example.test")).rejects.toThrow("rejected read-only");
    }
    const http = new FetchJsonHttpClient({ fetchImpl: async (): Promise<Response> => new Response("down", { status: 503 }), timeoutMs: 100 });
    await expect(http.getJson("https://example.test")).rejects.toThrow("HTTP 503");

    const network = new FetchJsonHttpClient({ fetchImpl: async (): Promise<Response> => { throw new Error("connection refused"); }, timeoutMs: 100 });
    await expect(network.getJson("https://example.test")).rejects.toThrow("connection refused");
    const unknown = new FetchJsonHttpClient({ fetchImpl: async (): Promise<Response> => { throw "failed"; }, timeoutMs: 100 });
    await expect(unknown.getJson("https://example.test")).rejects.toThrow("unknown error");
  });

  it("rejects invalid client deadlines", () => {
    expect(() => new FetchJsonHttpClient({ timeoutMs: 0 })).toThrow("positive integer");
    expect(() => new FetchJsonHttpClient({ timeoutMs: 1.5 })).toThrow("positive integer");
  });
});
