import { CheckCircleIcon, PauseCircleIcon, QuestionIcon, TimerIcon, WarningCircleIcon, XCircleIcon } from "@phosphor-icons/react";

import type { HealthStatus } from "../data/types";

interface StatusBadgeProps {
  readonly status: HealthStatus;
  readonly compact?: boolean;
}

const labels: Readonly<Record<HealthStatus, string>> = {
  healthy: "Healthy",
  degraded: "Degraded",
  failing: "Failing",
  unknown: "Unknown",
  paused: "Paused",
  stale: "Stale"
};

export function StatusBadge({ status, compact = false }: StatusBadgeProps): React.JSX.Element {
  const Icon = status === "healthy"
    ? CheckCircleIcon
    : status === "degraded"
      ? WarningCircleIcon
      : status === "failing"
        ? XCircleIcon
        : status === "paused"
          ? PauseCircleIcon
          : status === "stale"
            ? TimerIcon
            : QuestionIcon;

  return (
    <span className={`status-badge status-${status}`}>
      <Icon aria-hidden="true" size={14} weight="fill" />
      {compact ? <span className="sr-only">{labels[status]}</span> : labels[status]}
    </span>
  );
}
