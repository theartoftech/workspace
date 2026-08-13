import { render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import axe from "axe-core";
import { describe, expect, it } from "vitest";

import { App } from "./App";
import { createFixtureMonitoringProvider } from "../data/provider";

describe("application shell accessibility", () => {
  it("has no automatically detectable critical or serious violations", async () => {
    const { container } = render(
      <MemoryRouter initialEntries={["/"]}>
        <App provider={createFixtureMonitoringProvider()} />
      </MemoryRouter>
    );

    await screen.findByRole("heading", { name: "Fleet overview" });
    const results = await axe.run(container, {
      resultTypes: ["violations"],
      rules: {
        "color-contrast": { enabled: false }
      }
    });
    const blocking = results.violations.filter((violation) =>
      violation.impact === "critical" || violation.impact === "serious"
    );
    expect(blocking).toEqual([]);
  });
});
