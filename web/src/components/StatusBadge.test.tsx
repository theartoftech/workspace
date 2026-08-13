import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { StatusBadge } from "./StatusBadge";

describe("StatusBadge", () => {
  it.each(["healthy", "degraded", "failing", "unknown", "paused", "stale"] as const)("renders the %s status", (status) => {
    const labels = {
      healthy: "Healthy",
      degraded: "Degraded",
      failing: "Failing",
      unknown: "Unknown",
      paused: "Paused",
      stale: "Stale"
    } as const;
    render(<StatusBadge status={status} />);
    expect(screen.getByText(labels[status])).toBeInTheDocument();
  });

  it("keeps a compact status accessible", () => {
    render(<StatusBadge status="healthy" compact />);
    expect(screen.getByText("Healthy")).toHaveClass("sr-only");
  });
});
