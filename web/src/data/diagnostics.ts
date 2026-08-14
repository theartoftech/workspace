import type { LogCorrelationSnapshot } from "../../../shared/logs";

export interface LogDiagnosticBundle {
  readonly bundleVersion: 1;
  readonly createdAt: string;
  readonly sourcePolicy: "server-redacted";
  readonly notice: string;
  readonly evidence: LogCorrelationSnapshot;
}

export function buildLogDiagnosticBundle(evidence: LogCorrelationSnapshot): LogDiagnosticBundle {
  const redaction: unknown = evidence.redaction;
  if (typeof redaction !== "object" || redaction === null || Array.isArray(redaction)
    || (redaction as Record<string, unknown>).applied !== true
    || (redaction as Record<string, unknown>).replacement !== "[REDACTED]") {
    throw new Error("Diagnostic export requires server-redacted evidence");
  }
  return {
    bundleVersion: 1,
    createdAt: evidence.assembledAt,
    sourcePolicy: "server-redacted",
    notice: "This bounded bundle contains only server-redacted log and Kubernetes event evidence. Review it before sharing.",
    evidence
  };
}
