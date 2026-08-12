import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router-dom";
import { describe, expect, it } from "vitest";

import { App } from "./App";

function renderApp(route = "/"): void {
  render(
    <MemoryRouter initialEntries={[route]}>
      <App />
    </MemoryRouter>
  );
}

describe("enterprise application shell", () => {
  it("labels fixture mode and exposes every primary route", async () => {
    renderApp();

    expect(await screen.findByRole("heading", { name: "Fleet overview" })).toBeInTheDocument();
    expect(screen.getByText("Fixture data")).toBeInTheDocument();
    for (const route of ["Overview", "Deployments", "Infrastructure", "Performance", "Incidents", "Settings"]) {
      expect(screen.getByRole("link", { name: route })).toBeInTheDocument();
    }
  });

  it("navigates between primary routes without a backend", async () => {
    const user = userEvent.setup();
    renderApp();

    await user.click(screen.getByRole("link", { name: "Deployments" }));
    expect(await screen.findByRole("heading", { name: "Deployments" })).toBeInTheDocument();

    await user.click(screen.getByRole("link", { name: "Performance" }));
    expect(await screen.findByRole("heading", { name: "Performance & capacity" })).toBeInTheDocument();
  });

  it("opens command search with the keyboard and navigates from a result", async () => {
    const user = userEvent.setup();
    renderApp();

    await user.keyboard("/");
    const search = screen.getByRole("dialog", { name: "Command search" });
    expect(search).toBeInTheDocument();

    await user.type(screen.getByRole("searchbox"), "incident");
    await user.click(screen.getByRole("option", { name: /Incidents/ }));
    expect(await screen.findByRole("heading", { name: "Incidents" })).toBeInTheDocument();
  });

  it("shows all required fixture states in the settings gallery", async () => {
    renderApp("/settings");

    expect(await screen.findByRole("heading", { name: "Settings" })).toBeInTheDocument();
    for (const state of ["Loading", "Empty", "Partial failure", "Stale", "Unauthorized", "No data"]) {
      expect(screen.getByText(state)).toBeInTheDocument();
    }
  });

  it("filters fixture services by environment and accepts a new time range", async () => {
    const user = userEvent.setup();
    renderApp();

    await screen.findByRole("heading", { name: "Fleet overview" });
    await user.selectOptions(screen.getByRole("combobox", { name: "Environment" }), "demo");
    await screen.findByText("2 services in current scope");
    expect(screen.queryByText("CPQ Test")).not.toBeInTheDocument();

    await user.selectOptions(screen.getByRole("combobox", { name: "Time range" }), "6h");
    expect(screen.getByRole("combobox", { name: "Time range" })).toHaveValue("6h");
  });

  it("opens and dismisses utility menus", async () => {
    const user = userEvent.setup();
    renderApp();

    await screen.findByRole("heading", { name: "Fleet overview" });
    await user.click(screen.getByRole("button", { name: "Open alerts, 2 active" }));
    expect(screen.getByText("Keycloak p95 above SLO")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Open operator menu" }));
    expect(screen.getByRole("button", { name: "Operator profile" })).toBeInTheDocument();
    await user.keyboard("{Escape}");
    expect(screen.queryByText("Keycloak p95 above SLO")).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Operator profile" })).not.toBeInTheDocument();
  });

  it("supports empty command results and explicit close controls", async () => {
    const user = userEvent.setup();
    renderApp();

    await user.click(screen.getByRole("button", { name: /Search workspace/ }));
    await user.type(screen.getByRole("searchbox"), "no-such-command");
    expect(screen.getByText("No matching commands.")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Close command search" }));
    expect(screen.queryByRole("dialog", { name: "Command search" })).not.toBeInTheDocument();
  });

  it("renders infrastructure and rejects unknown routes explicitly", async () => {
    const { unmount } = render(
      <MemoryRouter initialEntries={["/infrastructure"]}>
        <App />
      </MemoryRouter>
    );
    expect(await screen.findByRole("heading", { name: "Infrastructure" })).toBeInTheDocument();
    expect(screen.getByText("Dependency topology")).toBeInTheDocument();
    unmount();

    renderApp("/not-a-monitoring-route");
    expect(await screen.findByRole("alert")).toHaveTextContent("The requested monitoring route does not exist.");
  });
});
