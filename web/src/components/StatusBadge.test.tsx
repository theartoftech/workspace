import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { StatusBadge } from "./StatusBadge";

describe("StatusBadge", () => {
  it.each(["healthy", "degraded", "critical", "unknown"] as const)("renders the %s status", (status) => {
    const labels = {
      healthy: "Healthy",
      degraded: "Degraded",
      critical: "Critical",
      unknown: "Unknown"
    } as const;
    render(<StatusBadge status={status} />);
    expect(screen.getByText(labels[status])).toBeInTheDocument();
  });

  it("keeps a compact status accessible", () => {
    render(<StatusBadge status="healthy" compact />);
    expect(screen.getByText("Healthy")).toHaveClass("sr-only");
  });
});
