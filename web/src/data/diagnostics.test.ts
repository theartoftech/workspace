import { describe, expect, it } from "vitest";

import { createFixtureMonitoringProvider } from "./provider";
import { buildLogDiagnosticBundle } from "./diagnostics";

describe("redacted log diagnostic bundle", () => {
  it("declares sources, omissions, bounds, and server redaction without adding browser state", async () => {
    const response = await createFixtureMonitoringProvider().getLogs?.({ environment: "demo", serviceId: "cpq-demo", range: "1h", pod: null, severity: "all", query: "", correlationId: "" });
    if (response === undefined) throw new Error("Fixture log provider is unavailable");
    const bundle = buildLogDiagnosticBundle(response);
    expect(bundle.bundleVersion).toBe(1);
    expect(bundle.sourcePolicy).toBe("server-redacted");
    expect(bundle.evidence.limits.maxEntries).toBe(500);
    expect(bundle.evidence.redaction.applied).toBe(true);
    expect(Array.isArray(bundle.evidence.sources)).toBe(true);
    expect(Array.isArray(bundle.evidence.omissions)).toBe(true);
    expect(JSON.stringify(bundle)).not.toContain("localStorage");
  });
});
