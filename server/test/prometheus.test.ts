import { describe, expect, it } from "vitest";

import type { JsonHttpClient } from "../src/http";
import { UpstreamError } from "../src/http";
import { loadCatalog } from "../src/catalog";
import { PerformanceRequestError, PrometheusPerformanceReader } from "../src/prometheus";
import { catalogFixture } from "./fixtures";

const now = new Date("2026-08-13T18:00:00Z");

function matrix(values: readonly (readonly [number, string])[]): unknown {
  return { status: "success", data: { resultType: "matrix", result: [{ metric: {}, values }] } };
}

function reader(client: JsonHttpClient, catalog = catalogFixture): PrometheusPerformanceReader {
  return new PrometheusPerformanceReader({
    apiUrl: "http://prometheus.test:9090",
    catalog,
    client,
    now: () => now
  });
}

describe("allow-listed Prometheus performance reader", () => {
  it("uses only fixed range-query templates and bounds a 24-hour request", async () => {
    const urls: string[] = [];
    const client: JsonHttpClient = {
      async getJson(url): Promise<unknown> {
        urls.push(url);
        return matrix([[now.getTime() / 1000, "1.5"]]);
      }
    };

    const snapshot = await reader(client).getPerformance("demo", "cpq-demo", "24h");

    expect(snapshot.window).toEqual({
      range: "24h",
      start: "2026-08-12T18:00:00.000Z",
      end: "2026-08-13T18:00:00.000Z",
      stepSeconds: 900,
      maxPoints: 97
    });
    expect(snapshot.metrics).toHaveLength(12);
    expect(snapshot.metrics.every((metric) => !("query" in metric))).toBe(true);
    expect(urls).toHaveLength(12);
    for (const rawUrl of urls) {
      const url = new URL(rawUrl);
      expect(url.pathname).toBe("/api/v1/query_range");
      expect(url.searchParams.get("step")).toBe("900");
      expect(url.searchParams.get("query")).toMatch(/^(?:sum|avg|quantile|100)/u);
      expect(url.searchParams.has("promql")).toBe(false);
    }
  });

  it("uses portfolio Nginx counters for actual request totals", async () => {
    const queries: string[] = [];
    const client: JsonHttpClient = {
      async getJson(url): Promise<unknown> {
        queries.push(new URL(url).searchParams.get("query") ?? "");
        return matrix([[now.getTime() / 1000, "42"]]);
      }
    };

    const snapshot = await reader(client, await loadCatalog("catalog/services.json")).getPerformance("demo", "portfolio", "1h");
    const total = snapshot.metrics.find((metric) => metric.id === "request-total");

    expect(total).toMatchObject({ label: "Requests in selected window", unit: "requests", latest: 42 });
    expect(queries.some((query) => query.includes('increase(nginx_http_requests_total{service=~"portfolio"}[1h])'))).toBe(true);
    expect(queries.some((query) => query.includes("rate(") && query.includes("nginx_http_requests_total"))).toBe(true);
  });

  it("distinguishes real zero traffic from missing telemetry", async () => {
    const client: JsonHttpClient = {
      async getJson(url): Promise<unknown> {
        const query = new URL(url).searchParams.get("query") ?? "";
        if (query.includes("kube_pod_container_status_restarts_total")) {
          return { status: "success", data: { resultType: "matrix", result: [] } };
        }
        return matrix([[now.getTime() / 1000, query.includes("http_server_requests_seconds_count") ? "0" : "12.5"]]);
      }
    };

    const snapshot = await reader(client).getPerformance("all", "all", "1h");
    const requestRate = snapshot.metrics.find((metric) => metric.id === "request-rate");
    const restarts = snapshot.metrics.find((metric) => metric.id === "pod-restarts");

    expect(requestRate).toMatchObject({ status: "ok", latest: 0, message: null });
    expect(restarts).toMatchObject({ status: "no-data", latest: null, points: [] });
    expect(snapshot.mode).toBe("live");
  });

  it("retains successful panels and redacts an individual query failure", async () => {
    const client: JsonHttpClient = {
      async getJson(url): Promise<unknown> {
        const query = new URL(url).searchParams.get("query") ?? "";
        if (query.includes("process_cpu_usage")) {
          throw new UpstreamError("unavailable", "Prometheus token=super-secret unavailable");
        }
        return matrix([[now.getTime() / 1000, "2"]]);
      }
    };

    const snapshot = await reader(client).getPerformance("demo", "cpq-demo", "15m");
    const processCpu = snapshot.metrics.find((metric) => metric.id === "process-cpu");

    expect(snapshot.mode).toBe("partial");
    expect(snapshot.source.availability).toBe("partial");
    expect(processCpu?.status).toBe("error");
    expect(processCpu?.message).toContain("[REDACTED]");
    expect(processCpu?.message).not.toContain("super-secret");
    expect(snapshot.metrics.find((metric) => metric.id === "request-rate")?.status).toBe("ok");
  });

  it("rejects unsupported filters before issuing any Prometheus request", async () => {
    const client: JsonHttpClient = { async getJson(): Promise<unknown> { throw new Error("must not query"); } };
    const performance = reader(client);

    await expect(performance.getPerformance("production", "all", "1h")).rejects.toBeInstanceOf(PerformanceRequestError);
    await expect(performance.getPerformance("all", "not-in-catalog", "1h")).rejects.toThrow("service");
    await expect(performance.getPerformance("all", "all", "30d")).rejects.toThrow("range");
    await expect(performance.getPerformance("test", "cpq-demo", "1h")).rejects.toThrow("selected environment");
  });

  it("turns malformed and non-finite Prometheus samples into explicit panel errors", async () => {
    let calls = 0;
    const client: JsonHttpClient = {
      async getJson(): Promise<unknown> {
        calls += 1;
        if (calls === 1) return { status: "error", error: "bad query" };
        if (calls === 2) return { status: "success", data: { resultType: "vector", result: [] } };
        return matrix([[now.getTime() / 1000, "NaN"]]);
      }
    };

    const snapshot = await reader(client).getPerformance("all", "all", "6h");
    expect(snapshot.mode).toBe("partial");
    expect(snapshot.metrics.every((metric) => metric.status === "error")).toBe(true);
  });
});
