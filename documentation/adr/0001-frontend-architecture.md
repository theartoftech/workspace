# ADR 0001: Sprint 1 frontend architecture

- Status: Accepted
- Date: 2026-08-12
- Sprint: 1 — Enterprise application shell

## Context

Workspace Monitor needs an enterprise monitoring shell that can be reviewed and navigated before it is coupled to Prometheus, Gatus, Grafana, or the deployment catalog. Sprint 1 must therefore exercise the approved information architecture with deterministic fixture data while preserving a clean path to live providers in later sprints.

## Decision

Use a strictly typed React and TypeScript single-page application built with Vite. React Router owns the six approved routes. Recharts supplies data visualizations and Phosphor supplies interface icons.

All screen data crosses a `MonitoringProvider` boundary. Sprint 1 uses `createFixtureMonitoringProvider`; future adapters must implement the same interface and throw explicit errors for unsupported requests. Components do not import infrastructure clients or raw fixture records directly.

The UI uses a compact tokenized dark enterprise theme with an always-visible fixture-mode banner. Loading, empty, partial-failure, stale, unauthorized, no-data, and invalid-route states are independently rendered and testable.

## Success criteria

1. Every primary route is keyboard and pointer navigable without a backend.
2. Environment and time controls request typed provider snapshots.
3. Fixture mode is globally and unambiguously labeled.
4. The shell is usable at desktop, tablet, and narrow mobile widths.
5. Unit, interaction, accessibility, lint, typecheck, production-build, and repository server-coverage gates pass.

## Failure modes considered

- Unsupported environment or time-range values throw instead of silently falling back.
- Provider rejection displays an alert state rather than leaving an indefinite skeleton.
- Unknown routes display an explicit route error.
- Small viewports replace the fixed sidebar with a dismissible navigation drawer.
- Keyboard search avoids stealing `/` while an input, textarea, or select is active.

## Consequences

The shell is realistic and reviewable now, but no values should be interpreted as live telemetry. Later sprints can replace the fixture provider at the composition boundary without rewriting route components.
