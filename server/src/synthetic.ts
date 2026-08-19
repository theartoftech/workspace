import type {
  SyntheticCleanupEvidence,
  SyntheticEnvironment,
  SyntheticFailureCode,
  SyntheticJourneyDefinitionId,
  SyntheticJourneySnapshot,
  SyntheticRunEvidence,
  SyntheticStepEvidence
} from "../../shared/synthetic";

export type SyntheticOperation =
  | "oauth_token"
  | "cpq_authenticated_read"
  | "cpq_create"
  | "cpq_read"
  | "cpq_update"
  | "cpq_verify"
  | "cpq_cleanup"
  | "mailpit_send"
  | "mailpit_confirm"
  | "mailpit_cleanup"
  | "erpnext_read";

export interface SyntheticStepDefinition {
  readonly id: string;
  readonly operation: SyntheticOperation;
  readonly cleanup: boolean;
}

export interface SyntheticJourneyDefinition {
  readonly id: SyntheticJourneyDefinitionId;
  readonly definitionVersion: 1;
  readonly displayName: string;
  readonly effect: "read-only" | "reversible";
  readonly steps: readonly SyntheticStepDefinition[];
  readonly cleanupSteps: readonly SyntheticStepDefinition[];
}

const step = (id: string, operation: SyntheticOperation): SyntheticStepDefinition => ({ id, operation, cleanup: false });
const cleanupStep = (id: string, operation: SyntheticOperation): SyntheticStepDefinition => ({ id, operation, cleanup: true });

export const syntheticJourneyDefinitions: readonly SyntheticJourneyDefinition[] = [
  {
    id: "oauth-cpq-read",
    definitionVersion: 1,
    displayName: "OAuth and CPQ authenticated read",
    effect: "read-only",
    steps: [step("acquire-token", "oauth_token"), step("authenticated-read", "cpq_authenticated_read")],
    cleanupSteps: []
  },
  {
    id: "cpq-record-lifecycle",
    definitionVersion: 1,
    displayName: "CPQ synthetic record lifecycle",
    effect: "reversible",
    steps: [
      step("acquire-token", "oauth_token"),
      step("create-record", "cpq_create"),
      step("read-record", "cpq_read"),
      step("update-record", "cpq_update"),
      step("verify-record", "cpq_verify")
    ],
    cleanupSteps: [cleanupStep("cleanup-record", "cpq_cleanup")]
  },
  {
    id: "mailpit-delivery",
    definitionVersion: 1,
    displayName: "Mailpit delivery confirmation",
    effect: "reversible",
    steps: [step("send-message", "mailpit_send"), step("confirm-message", "mailpit_confirm")],
    cleanupSteps: [cleanupStep("cleanup-message", "mailpit_cleanup")]
  },
  {
    id: "erpnext-read",
    definitionVersion: 1,
    displayName: "ERPNext read-only verification",
    effect: "read-only",
    steps: [step("read-erpnext", "erpnext_read")],
    cleanupSteps: []
  }
];

export interface SyntheticJourneyControl {
  readonly version: 1;
  readonly runnerEnabled: boolean;
  readonly journeys: readonly { readonly id: SyntheticJourneyDefinitionId; readonly enabled: boolean }[];
}

export const defaultSyntheticJourneyControl: SyntheticJourneyControl = {
  version: 1,
  runnerEnabled: false,
  journeys: syntheticJourneyDefinitions.map((definition) => ({ id: definition.id, enabled: false }))
};

function record(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

function exactFields(value: Record<string, unknown>, fields: readonly string[], label: string): void {
  const allowed = new Set(fields);
  const unexpected = Object.keys(value).find((field) => !allowed.has(field));
  if (unexpected !== undefined || fields.some((field) => !(field in value))) throw new Error(`${label} has unsupported or missing fields`);
}

export function parseSyntheticJourneyControlJson(source: string): SyntheticJourneyControl {
  let parsed: unknown;
  try {
    parsed = JSON.parse(source) as unknown;
  } catch {
    throw new Error("Synthetic journey control is not valid JSON");
  }
  const root = record(parsed);
  if (root === null) throw new Error("Synthetic journey control must be an object");
  exactFields(root, ["version", "runnerEnabled", "journeys"], "Synthetic journey control");
  if (root.version !== 1 || typeof root.runnerEnabled !== "boolean" || !Array.isArray(root.journeys)) {
    throw new Error("Synthetic journey control has an unsupported contract");
  }
  const enabledById = new Map<SyntheticJourneyDefinitionId, boolean>();
  for (const value of root.journeys) {
    const item = record(value);
    if (item === null) throw new Error("Synthetic journey control entry must be an object");
    exactFields(item, ["id", "enabled"], "Synthetic journey control entry");
    if (typeof item.id !== "string" || typeof item.enabled !== "boolean" || !syntheticJourneyDefinitions.some((definition) => definition.id === item.id)) {
      throw new Error("Synthetic journey control entry is invalid");
    }
    const id = item.id as SyntheticJourneyDefinitionId;
    if (enabledById.has(id)) throw new Error(`Synthetic journey control repeats ${id}`);
    enabledById.set(id, item.enabled);
  }
  if (enabledById.size !== syntheticJourneyDefinitions.length || syntheticJourneyDefinitions.some((definition) => !enabledById.has(definition.id))) {
    throw new Error("Synthetic journey control must include each definition exactly once");
  }
  const journeys = syntheticJourneyDefinitions.map((definition) => ({ id: definition.id, enabled: enabledById.get(definition.id) === true }));
  if (!root.runnerEnabled && journeys.some((journey) => journey.enabled)) throw new Error("Synthetic journeys cannot be enabled while the runner is disabled");
  return { version: 1, runnerEnabled: root.runnerEnabled, journeys };
}

export interface SyntheticStepRequest {
  readonly definitionId: SyntheticJourneyDefinitionId;
  readonly environment: SyntheticEnvironment;
  readonly runId: string;
  readonly marker: string;
  readonly operation: SyntheticOperation;
}

export interface SyntheticStepDriver {
  execute(request: SyntheticStepRequest): Promise<void>;
}

const safeFailureMessages: Readonly<Record<Exclude<SyntheticFailureCode, "cleanup_failed">, string>> = {
  token_rejected: "Identity provider rejected the request.",
  token_timeout: "Identity provider request timed out.",
  token_malformed: "Identity provider returned a malformed response.",
  token_expired: "Identity provider returned an expired result.",
  wrong_environment: "Provider evidence did not match the selected environment.",
  provider_timeout: "Provider request timed out.",
  provider_rejected: "Provider rejected the request.",
  provider_malformed: "Provider returned a malformed response.",
  provider_unavailable: "Provider is unavailable."
};

export class SyntheticJourneyFailure extends Error {
  constructor(readonly code: Exclude<SyntheticFailureCode, "cleanup_failed">) {
    super(safeFailureMessages[code]);
    this.name = "SyntheticJourneyFailure";
  }
}

export interface SyntheticJourneyRunnerOptions {
  readonly driver: SyntheticStepDriver;
  readonly now?: () => number;
  readonly runId?: () => string;
}

export interface RunSyntheticJourneyCommand {
  readonly definitionId: SyntheticJourneyDefinitionId;
  readonly environment: SyntheticEnvironment;
  readonly executionKey: string;
}

function isoTimestamp(value: number): string {
  return new Date(value).toISOString();
}

function definitionById(id: SyntheticJourneyDefinitionId): SyntheticJourneyDefinition {
  const definition = syntheticJourneyDefinitions.find((candidate) => candidate.id === id);
  if (definition === undefined) throw new Error(`Unsupported synthetic journey definition: ${id}`);
  return definition;
}

function stepFailure(cause: unknown): { readonly code: SyntheticFailureCode; readonly message: string } {
  return cause instanceof SyntheticJourneyFailure
    ? { code: cause.code, message: cause.message }
    : { code: "provider_unavailable", message: "Synthetic step could not be completed." };
}

function isSyntheticEnvironment(value: unknown): value is SyntheticEnvironment {
  return value === "demo" || value === "test";
}

export class SyntheticJourneyRunner {
  private readonly driver: SyntheticStepDriver;
  private readonly now: () => number;
  private readonly makeRunId: () => string;
  private readonly completed = new Map<string, SyntheticRunEvidence>();
  private readonly inFlight = new Map<string, Promise<SyntheticRunEvidence>>();

  constructor(options: SyntheticJourneyRunnerOptions) {
    this.driver = options.driver;
    this.now = options.now ?? Date.now;
    this.makeRunId = options.runId ?? (() => `run-${crypto.randomUUID().replaceAll("-", "").slice(0, 12)}`);
  }

  run(command: RunSyntheticJourneyCommand): Promise<SyntheticRunEvidence> {
    if (!/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/u.test(command.executionKey)) return Promise.reject(new Error("Synthetic execution key is invalid"));
    if (!isSyntheticEnvironment(command.environment)) return Promise.reject(new Error("Synthetic environment is invalid"));
    const deduplicationKey = `${command.definitionId}:${command.environment}:${command.executionKey}`;
    const existing = this.completed.get(deduplicationKey);
    if (existing !== undefined) return Promise.resolve(existing);
    const active = this.inFlight.get(deduplicationKey);
    if (active !== undefined) return active;
    const execution = this.executeClaimed(command, deduplicationKey);
    this.inFlight.set(deduplicationKey, execution);
    void execution.then(
      () => { this.inFlight.delete(deduplicationKey); },
      () => { this.inFlight.delete(deduplicationKey); }
    );
    return execution;
  }

  private async executeClaimed(command: RunSyntheticJourneyCommand, deduplicationKey: string): Promise<SyntheticRunEvidence> {
    const definition = definitionById(command.definitionId);
    const runId = this.makeRunId();
    if (!/^run-[a-z0-9]{12}$/u.test(runId)) throw new Error("Synthetic run identifier is invalid");
    const marker = `WSM_SYN_V1_${command.environment.toUpperCase()}_${runId}`;
    const started = this.now();
    let finished = started;
    const steps: SyntheticStepEvidence[] = [];
    let primaryFailed = false;
    for (const current of definition.steps) {
      const stepStarted = this.now();
      try {
        await this.driver.execute({ definitionId: definition.id, environment: command.environment, runId, marker, operation: current.operation });
        finished = this.now();
        steps.push({ stepId: current.id, status: "succeeded", durationMs: Math.max(0, finished - stepStarted), failure: null });
      } catch (cause: unknown) {
        finished = this.now();
        steps.push({ stepId: current.id, status: "failed", durationMs: Math.max(0, finished - stepStarted), failure: stepFailure(cause) });
        primaryFailed = true;
        break;
      }
    }

    let cleanup: SyntheticCleanupEvidence = { status: "not-required", stepId: null, durationMs: 0, failure: null };
    for (const current of definition.cleanupSteps) {
      const cleanupStarted = this.now();
      try {
        await this.driver.execute({ definitionId: definition.id, environment: command.environment, runId, marker, operation: current.operation });
        finished = this.now();
        cleanup = { status: "succeeded", stepId: current.id, durationMs: Math.max(0, finished - cleanupStarted), failure: null };
      } catch {
        finished = this.now();
        cleanup = {
          status: "failed",
          stepId: current.id,
          durationMs: Math.max(0, finished - cleanupStarted),
          failure: { code: "cleanup_failed", message: "Synthetic cleanup could not be completed." }
        };
        break;
      }
    }
    const result: SyntheticRunEvidence = {
      runId,
      definitionId: definition.id,
      environment: command.environment,
      status: primaryFailed || cleanup.status === "failed" ? "failed" : "succeeded",
      startedAt: isoTimestamp(started),
      finishedAt: isoTimestamp(finished),
      steps,
      cleanup,
      orphanIdentifier: cleanup.status === "failed" ? marker : null
    };
    this.completed.set(deduplicationKey, result);
    return result;
  }
}

export interface SyntheticJourneyReader {
  getSyntheticJourneys(): Promise<SyntheticJourneySnapshot>;
}

export class DisabledSyntheticJourneyService implements SyntheticJourneyReader {
  getSyntheticJourneys(): Promise<SyntheticJourneySnapshot> {
    return Promise.resolve({
      apiVersion: 1,
      definitionVersion: 1,
      assembledAt: new Date().toISOString(),
      runner: { state: "disabled", message: "No synthetic journey is enabled. Existing monitoring remains independent." },
      journeys: syntheticJourneyDefinitions.map((definition) => ({
        id: definition.id,
        displayName: definition.displayName,
        effect: definition.effect,
        enabled: false,
        state: "disabled",
        lastRun: null
      })),
      recentRuns: []
    });
  }
}
