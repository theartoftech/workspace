import { describe, expect, it, vi } from "vitest";

import {
  DisabledSyntheticJourneyService,
  SyntheticJourneyFailure,
  SyntheticJourneyRunner,
  defaultSyntheticJourneyControl,
  parseSyntheticJourneyControlJson,
  syntheticJourneyDefinitions,
  type SyntheticStepDriver
} from "../src/synthetic";

describe("safe synthetic journey policy", () => {
  it("versions four fixed journey definitions without arbitrary request operations", () => {
    expect(syntheticJourneyDefinitions.map((definition) => definition.id)).toEqual([
      "oauth-cpq-read",
      "cpq-record-lifecycle",
      "mailpit-delivery",
      "erpnext-read"
    ]);
    expect(syntheticJourneyDefinitions.every((definition) => definition.definitionVersion === 1)).toBe(true);
    expect(syntheticJourneyDefinitions.flatMap((definition) => definition.steps).every((step) => !step.cleanup)).toBe(true);
    expect(syntheticJourneyDefinitions.flatMap((definition) => definition.cleanupSteps).every((step) => step.cleanup)).toBe(true);
    expect(syntheticJourneyDefinitions.flatMap((definition) => [...definition.steps, ...definition.cleanupSteps]).map((step) => step.operation)).toEqual([
      "oauth_token", "cpq_authenticated_read",
      "oauth_token", "cpq_create", "cpq_read", "cpq_update", "cpq_verify", "cpq_cleanup",
      "mailpit_send", "mailpit_confirm", "mailpit_cleanup",
      "erpnext_read"
    ]);
  });

  it("uses an explicit disabled default and strictly validates independent controls", () => {
    expect(defaultSyntheticJourneyControl.runnerEnabled).toBe(false);
    expect(defaultSyntheticJourneyControl.journeys).toHaveLength(4);
    expect(defaultSyntheticJourneyControl.journeys.every((journey) => !journey.enabled)).toBe(true);

    const parsed = parseSyntheticJourneyControlJson(JSON.stringify({
      version: 1,
      runnerEnabled: true,
      journeys: defaultSyntheticJourneyControl.journeys.map((journey) => ({
        id: journey.id,
        enabled: journey.id === "erpnext-read"
      }))
    }));
    expect(parsed.journeys.find((journey) => journey.id === "erpnext-read")?.enabled).toBe(true);
    expect(parsed.journeys.filter((journey) => journey.enabled)).toHaveLength(1);

    for (const invalid of [
      "not-json",
      JSON.stringify({ version: 2, runnerEnabled: false, journeys: [] }),
      JSON.stringify({ ...defaultSyntheticJourneyControl, token: "must-not-be-accepted" }),
      JSON.stringify({ ...defaultSyntheticJourneyControl, journeys: defaultSyntheticJourneyControl.journeys.slice(0, 3) }),
      JSON.stringify({ ...defaultSyntheticJourneyControl, journeys: [defaultSyntheticJourneyControl.journeys[0], ...defaultSyntheticJourneyControl.journeys.slice(0, 3)] }),
      JSON.stringify({ ...defaultSyntheticJourneyControl, journeys: defaultSyntheticJourneyControl.journeys.map((journey) => ({ ...journey, enabled: true })) })
    ]) {
      expect(() => parseSyntheticJourneyControlJson(invalid)).toThrow();
    }
  });
});

describe("synthetic journey execution invariants", () => {
  it("records ordered bounded evidence and always cleans reversible success", async () => {
    const operations: string[] = [];
    const driver: SyntheticStepDriver = {
      execute: vi.fn(async (request): Promise<void> => { operations.push(`${request.environment}:${request.operation}`); })
    };
    let tick = 0;
    const runner = new SyntheticJourneyRunner({ driver, now: () => tick++ * 10, runId: () => "run-000000000001" });

    const result = await runner.run({ definitionId: "cpq-record-lifecycle", environment: "test", executionKey: "scheduled-2026-08-17T14:00Z" });

    expect(result.status).toBe("succeeded");
    expect(result.steps.map((step) => [step.stepId, step.status, step.durationMs])).toEqual([
      ["acquire-token", "succeeded", 10],
      ["create-record", "succeeded", 10],
      ["read-record", "succeeded", 10],
      ["update-record", "succeeded", 10],
      ["verify-record", "succeeded", 10]
    ]);
    expect(result.cleanup).toMatchObject({ status: "succeeded", stepId: "cleanup-record", durationMs: 10 });
    expect(result.orphanIdentifier).toBeNull();
    expect(operations).toEqual([
      "test:oauth_token", "test:cpq_create", "test:cpq_read", "test:cpq_update", "test:cpq_verify", "test:cpq_cleanup"
    ]);
    expect(driver.execute).toHaveBeenCalledWith(expect.objectContaining({ marker: "WSM_SYN_V1_TEST_run-000000000001" }));
  });

  it("retains partial failure evidence without fabricating later steps and still cleans", async () => {
    const operations: string[] = [];
    const driver: SyntheticStepDriver = {
      execute: async (request): Promise<void> => {
        operations.push(request.operation);
        if (request.operation === "cpq_create") throw new SyntheticJourneyFailure("provider_timeout");
      }
    };
    let tick = 0;
    const runner = new SyntheticJourneyRunner({ driver, now: () => tick++ * 5, runId: () => "run-000000000002" });

    const result = await runner.run({ definitionId: "cpq-record-lifecycle", environment: "demo", executionKey: "scheduled-2026-08-17T14:05Z" });

    expect(result.status).toBe("failed");
    expect(result.steps.map((step) => step.stepId)).toEqual(["acquire-token", "create-record"]);
    expect(result.steps[1]?.failure).toEqual({ code: "provider_timeout", message: "Provider request timed out." });
    expect(result.cleanup.status).toBe("succeeded");
    expect(result.orphanIdentifier).toBeNull();
    expect(operations).toEqual(["oauth_token", "cpq_create", "cpq_cleanup"]);
  });

  it("makes cleanup failure distinct and exposes only the bounded synthetic marker", async () => {
    const driver: SyntheticStepDriver = {
      execute: async (request): Promise<void> => {
        if (request.operation === "mailpit_cleanup") throw new Error("Authorization: Bearer private-token; destination user@example.test");
      }
    };
    let tick = 0;
    const runner = new SyntheticJourneyRunner({ driver, now: () => tick++ * 7, runId: () => "run-000000000003" });

    const result = await runner.run({ definitionId: "mailpit-delivery", environment: "test", executionKey: "scheduled-2026-08-17T14:10Z" });

    expect(result.status).toBe("failed");
    expect(result.cleanup).toEqual({
      status: "failed",
      stepId: "cleanup-message",
      durationMs: 7,
      failure: { code: "cleanup_failed", message: "Synthetic cleanup could not be completed." }
    });
    expect(result.orphanIdentifier).toBe("WSM_SYN_V1_TEST_run-000000000003");
    expect(JSON.stringify(result)).not.toMatch(/private-token|user@example\.test|Bearer/u);
  });

  it("deduplicates replay and never crosses the selected environment", async () => {
    const driver: SyntheticStepDriver = { execute: vi.fn(async (): Promise<void> => undefined) };
    const runner = new SyntheticJourneyRunner({ driver, now: () => 100, runId: () => "run-000000000004" });
    const command = { definitionId: "erpnext-read", environment: "test", executionKey: "scheduled-2026-08-17T14:15Z" } as const;

    const [first, replay] = await Promise.all([runner.run(command), runner.run(command)]);

    expect(replay).toEqual(first);
    expect(driver.execute).toHaveBeenCalledTimes(1);
    expect(driver.execute).toHaveBeenCalledWith(expect.objectContaining({ environment: "test" }));
  });

  it("rejects unsafe caller-controlled run identifiers and keys before any step", async () => {
    const driver: SyntheticStepDriver = { execute: vi.fn(async (): Promise<void> => undefined) };
    const unsafeId = new SyntheticJourneyRunner({ driver, now: () => 100, runId: () => "../../secret" });
    await expect(unsafeId.run({ definitionId: "erpnext-read", environment: "test", executionKey: "safe-key" })).rejects.toThrow("run identifier");
    expect(driver.execute).not.toHaveBeenCalled();

    const runner = new SyntheticJourneyRunner({ driver, now: () => 100, runId: () => "run-000000000005" });
    await expect(runner.run({ definitionId: "erpnext-read", environment: "demo", executionKey: "token=should-not-enter-ledger" })).rejects.toThrow("execution key");
    await expect(runner.run({ definitionId: "erpnext-read", environment: "all" as never, executionKey: "safe-key" })).rejects.toThrow("environment");
    expect(driver.execute).not.toHaveBeenCalled();
  });
});

describe("disabled synthetic journey evidence", () => {
  it("reports every journey independently without exposing configuration or fabricating runs", async () => {
    const snapshot = await new DisabledSyntheticJourneyService().getSyntheticJourneys();

    expect(snapshot).toMatchObject({ apiVersion: 1, definitionVersion: 1, runner: { state: "disabled" } });
    expect(snapshot.journeys.map((journey) => journey.id)).toEqual(syntheticJourneyDefinitions.map((definition) => definition.id));
    expect(snapshot.journeys.every((journey) => !journey.enabled && journey.state === "disabled")).toBe(true);
    expect(snapshot.recentRuns).toEqual([]);
    expect(JSON.stringify(snapshot)).not.toMatch(/secret|credential|token=/iu);
  });
});
