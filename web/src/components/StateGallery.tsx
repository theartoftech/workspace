import {
  ArrowsClockwiseIcon,
  ClockCountdownIcon,
  DatabaseIcon,
  LockKeyIcon,
  TrayIcon,
  WarningIcon
} from "@phosphor-icons/react";

interface StateDefinition {
  readonly label: string;
  readonly description: string;
  readonly tone: "neutral" | "warning" | "danger";
  readonly icon: React.ComponentType<{ readonly size?: number; readonly "aria-hidden"?: boolean }>;
}

const states: readonly StateDefinition[] = [
  { label: "Loading", description: "Fetching deployment inventory…", tone: "neutral", icon: ArrowsClockwiseIcon },
  { label: "Empty", description: "No services match the current filters.", tone: "neutral", icon: TrayIcon },
  { label: "Partial failure", description: "2 of 7 collectors did not respond.", tone: "warning", icon: WarningIcon },
  { label: "Stale", description: "Last successful refresh was 18 minutes ago.", tone: "warning", icon: ClockCountdownIcon },
  { label: "Unauthorized", description: "Your role cannot view this environment.", tone: "danger", icon: LockKeyIcon },
  { label: "No data", description: "The source returned no samples for this range.", tone: "neutral", icon: DatabaseIcon }
];

export function StateGallery(): React.JSX.Element {
  return (
    <div className="state-gallery" aria-label="Fixture state gallery">
      {states.map((state) => {
        const Icon = state.icon;
        return (
          <article className={`state-card state-card-${state.tone}`} key={state.label}>
            <Icon aria-hidden={true} size={22} />
            <div>
              <h3>{state.label}</h3>
              <p>{state.description}</p>
            </div>
          </article>
        );
      })}
    </div>
  );
}
