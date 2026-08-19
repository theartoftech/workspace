export type SyntheticEnvironment = "demo" | "test";
export type SyntheticJourneyDefinitionId = "oauth-cpq-read" | "cpq-record-lifecycle" | "mailpit-delivery" | "erpnext-read";
export type SyntheticJourneyState = "disabled" | "not-configured" | "running" | "healthy" | "failing" | "unavailable";
export type SyntheticRunStatus = "succeeded" | "failed";
export type SyntheticStepStatus = "succeeded" | "failed";
export type SyntheticFailureCode =
  | "token_rejected"
  | "token_timeout"
  | "token_malformed"
  | "token_expired"
  | "wrong_environment"
  | "provider_timeout"
  | "provider_rejected"
  | "provider_malformed"
  | "provider_unavailable"
  | "cleanup_failed";

export interface SyntheticFailureEvidence {
  readonly code: SyntheticFailureCode;
  readonly message: string;
}

export interface SyntheticStepEvidence {
  readonly stepId: string;
  readonly status: SyntheticStepStatus;
  readonly durationMs: number;
  readonly failure: SyntheticFailureEvidence | null;
}

export type SyntheticCleanupEvidence =
  | { readonly status: "not-required"; readonly stepId: null; readonly durationMs: 0; readonly failure: null }
  | { readonly status: "succeeded"; readonly stepId: string; readonly durationMs: number; readonly failure: null }
  | { readonly status: "failed"; readonly stepId: string; readonly durationMs: number; readonly failure: SyntheticFailureEvidence };

export interface SyntheticRunEvidence {
  readonly runId: string;
  readonly definitionId: SyntheticJourneyDefinitionId;
  readonly environment: SyntheticEnvironment;
  readonly status: SyntheticRunStatus;
  readonly startedAt: string;
  readonly finishedAt: string;
  readonly steps: readonly SyntheticStepEvidence[];
  readonly cleanup: SyntheticCleanupEvidence;
  readonly orphanIdentifier: string | null;
}

export interface SyntheticJourneySummary {
  readonly id: SyntheticJourneyDefinitionId;
  readonly displayName: string;
  readonly effect: "read-only" | "reversible";
  readonly enabled: boolean;
  readonly state: SyntheticJourneyState;
  readonly lastRun: SyntheticRunEvidence | null;
}

export interface SyntheticJourneySnapshot {
  readonly apiVersion: 1;
  readonly definitionVersion: 1;
  readonly assembledAt: string;
  readonly runner: {
    readonly state: "disabled" | "available" | "unavailable";
    readonly message: string;
  };
  readonly journeys: readonly SyntheticJourneySummary[];
  readonly recentRuns: readonly SyntheticRunEvidence[];
}
