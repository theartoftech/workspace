import { describe, expect, it } from "vitest";

import type { AuthenticationAuditEvent, SessionUser } from "../../shared/auth";
import type { InventorySnapshot } from "../../shared/inventory";
import type { IncidentDetailResponse, IncidentListResponse } from "../../shared/incidents";
import {
  AuthenticationError,
  type AuthenticatedSession,
  type LogoutResult
} from "../src/auth";
import { handleWorkspaceRequest, type IncidentOperations, type InventoryReader, type WorkspaceAuthentication } from "../src/api";

const inventory: InventorySnapshot = {
  apiVersion: 1,
  mode: "live",
  assembledAt: "2026-08-16T12:00:00.000Z",
  lastObservedAt: null,
  environment: "all",
  summary: { total: 0, healthy: 0, degraded: 0, failing: 0, unknown: 0, paused: 0, stale: 0 },
  services: [],
  sources: []
};

const reader: InventoryReader = { getInventory: () => Promise.resolve(inventory) };
const incidentList = {
  apiVersion: 1,
  mode: "live",
  assembledAt: "2026-08-16T12:00:00.000Z",
  environment: "all",
  statusFilter: "active",
  truncated: false,
  summary: { total: 0, active: 0, resolved: 0, unacknowledged: 0, silenced: 0 },
  alertSource: { name: "inventory-health-evaluator", availability: "available", evaluatedAt: "2026-08-16T12:00:00.000Z", message: null },
  notification: { state: "unconfigured", message: "No destinations." },
  operator: { id: "access:operator", displayName: "Lab Operator", role: "operator", identityMode: "cloudflare-access" },
  incidents: []
} as const satisfies IncidentListResponse;
const incidentOperations: IncidentOperations = {
  list: () => Promise.resolve(incidentList),
  getDetail: () => Promise.reject(new Error("not used")),
  declare: () => Promise.reject(new Error("must not be called")),
  transition: () => Promise.reject(new Error("must not be called"))
};

const users = {
  viewer: { id: "access:viewer", displayName: "View Only", role: "viewer" },
  operator: { id: "access:operator", displayName: "Lab Operator", role: "operator" },
  administrator: { id: "access:administrator", displayName: "Lab Admin", role: "administrator" }
} as const satisfies Readonly<Record<string, SessionUser>>;

class FakeAuthentication implements WorkspaceAuthentication {
  readonly publicOrigin = "https://monitor.jefferyhaynes.net";
  user: SessionUser | null = users.operator;
  denied: Array<{ readonly user: SessionUser; readonly action: string; readonly reason: string }> = [];
  authenticationFailure: Error | null = null;
  auditFailure: Error | null = null;
  audit: readonly AuthenticationAuditEvent[] = [{
    id: 1, createdAt: "2026-08-16T12:00:00.000Z", actorId: users.administrator.id, displayName: users.administrator.displayName,
    action: "identity_validated", outcome: "succeeded", reasonCode: "cloudflare_access_jwt_validated", metadata: { role: "administrator" }
  }];

  authenticate(): Promise<AuthenticatedSession> {
    if (this.authenticationFailure !== null) return Promise.reject(this.authenticationFailure);
    if (this.user === null) return Promise.reject(new AuthenticationError(401, "authentication_required", "Authentication is required."));
    return Promise.resolve({ user: this.user, expiresAt: "2026-08-17T00:00:00.000Z" });
  }

  recordLogout(): LogoutResult {
    return { redirectTo: "/cdn-cgi/access/logout" };
  }

  recordAuthorizationDenied(user: SessionUser, action: string, reason: string): void {
    this.denied.push({ user, action, reason });
  }

  listAudit(): readonly AuthenticationAuditEvent[] {
    if (this.auditFailure !== null) throw this.auditFailure;
    return this.audit;
  }
}

function request(path: string, authentication: FakeAuthentication, init: RequestInit = {}): Promise<Response> {
  return handleWorkspaceRequest(new Request(`http://inventory-api.local${path}`, init), authentication, reader, undefined, undefined, incidentOperations);
}

describe("server-side authentication and authorization boundary", () => {
  it("keeps health public while denying anonymous monitoring evidence", async () => {
    const authentication = new FakeAuthentication();
    authentication.user = null;
    expect((await request("/healthz", authentication)).status).toBe(200);
    const denied = await request("/api/v1/inventory?environment=all", authentication);
    expect(denied.status).toBe(401);
    expect(await denied.json()).toEqual({ error: { code: "authentication_required", message: "Authentication is required." } });
    expect(denied.headers.get("cache-control")).toBe("no-store");
  });

  it("returns only safe derived session identity", async () => {
    const authentication = new FakeAuthentication();
    const response = await request("/api/v1/session", authentication);
    expect(response.status).toBe(200);
    const body = await response.json() as unknown;
    expect(body).toEqual({
      apiVersion: 1,
      authenticated: true,
      user: users.operator,
      expiresAt: "2026-08-17T00:00:00.000Z"
    });
    expect(JSON.stringify(body)).not.toMatch(/issuer|subject|group|token|claim/iu);
  });

  it("allows viewers to read but denies and audits every incident mutation", async () => {
    const authentication = new FakeAuthentication();
    authentication.user = users.viewer;
    expect((await request("/api/v1/inventory", authentication)).status).toBe(200);
    const denied = await request("/api/v1/incidents", authentication, {
      method: "POST",
      headers: { "Content-Type": "application/json", Origin: authentication.publicOrigin, "Sec-Fetch-Site": "same-origin" },
      body: JSON.stringify({ serviceId: "cpq-demo", title: "Denied", severity: "P2", reason: "Viewer cannot mutate" })
    });
    expect(denied.status).toBe(403);
    expect(authentication.denied).toEqual([{ user: users.viewer, action: "incident.mutate", reason: "insufficient_role" }]);
  });

  it("rejects missing, cross-origin, and cross-site mutation requests before operations", async () => {
    const authentication = new FakeAuthentication();
    for (const headers of [
      { "Content-Type": "application/json" },
      { "Content-Type": "application/json", Origin: "https://attacker.example", "Sec-Fetch-Site": "cross-site" },
      { "Content-Type": "application/json", Origin: authentication.publicOrigin, "Sec-Fetch-Site": "none" }
    ]) {
      const response = await request("/api/v1/incidents", authentication, { method: "POST", headers, body: "{}" });
      expect(response.status).toBe(403);
      expect(await response.text()).not.toContain("attacker.example");
    }
    expect(authentication.denied).toEqual([
      { user: users.operator, action: "incident.mutate", reason: "csrf_rejected" },
      { user: users.operator, action: "incident.mutate", reason: "csrf_rejected" },
      { user: users.operator, action: "incident.mutate", reason: "csrf_rejected" }
    ]);
  });

  it("allows only administrators to read bounded authentication audit history", async () => {
    const authentication = new FakeAuthentication();
    authentication.user = users.operator;
    expect((await request("/api/v1/auth/audit", authentication)).status).toBe(403);
    authentication.user = users.administrator;
    const response = await request("/api/v1/auth/audit?limit=50", authentication);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ apiVersion: 1, events: authentication.audit });
    expect((await request("/api/v1/auth/audit?limit=101", authentication)).status).toBe(400);
  });

  it("acknowledges logout only for an authenticated same-origin request with the application CSRF header", async () => {
    const authentication = new FakeAuthentication();
    const logout = await request("/auth/logout", authentication, {
      method: "POST",
      headers: { Origin: authentication.publicOrigin, "X-Workspace-CSRF": "logout" }
    });
    expect(logout.status).toBe(204);
    expect(logout.headers.get("location")).toBeNull();
    expect(logout.headers.get("set-cookie")).toBeNull();

    expect((await request("/auth/logout", authentication)).status).toBe(405);
    expect((await request("/auth/logout", authentication, { method: "POST" })).status).toBe(403);
    expect((await request("/auth/logout", authentication, {
      method: "POST",
      headers: { Origin: "https://attacker.example", "X-Workspace-CSRF": "logout" }
    })).status).toBe(403);
    expect((await request("/auth/logout", authentication, {
      method: "POST",
      headers: { Origin: authentication.publicOrigin, "X-Workspace-CSRF": "wrong" }
    })).status).toBe(403);
    expect(authentication.denied.at(-1)).toEqual({ user: users.operator, action: "auth.logout", reason: "csrf_rejected" });
  });

  it("rejects obsolete authentication routes and reports internal auth failures generically", async () => {
    const authentication = new FakeAuthentication();
    expect((await request("/auth/login", authentication)).status).toBe(404);
    expect((await request("/auth/callback?code=must-not-be-consumed", authentication)).status).toBe(404);
    expect((await request("/auth/not-a-route", authentication)).status).toBe(404);
    expect((await request("/not-an-api-route", authentication)).status).toBe(404);

    expect((await request("/api/v1/session?unexpected=1", authentication)).status).toBe(400);
    expect((await request("/api/v1/session", authentication, { method: "POST" })).status).toBe(405);
    expect((await request("/api/v1/auth-check", authentication, { method: "POST" })).status).toBe(405);

    authentication.user = users.administrator;
    expect((await request("/api/v1/auth/audit", authentication, { method: "POST" })).status).toBe(405);
    expect((await request("/api/v1/auth/audit?unexpected=1", authentication)).status).toBe(400);
    expect((await request("/api/v1/auth/audit?limit=1&limit=2", authentication)).status).toBe(400);
    expect((await request("/api/v1/auth/audit?limit=0", authentication)).status).toBe(400);
    authentication.auditFailure = new Error("database detail must not leak");
    const auditUnavailable = await request("/api/v1/auth/audit", authentication);
    expect(auditUnavailable.status).toBe(503);
    expect(await auditUnavailable.text()).not.toContain("database detail");

    authentication.auditFailure = null;
    authentication.authenticationFailure = new Error("session store detail must not leak");
    const sessionUnavailable = await request("/api/v1/inventory", authentication);
    expect(sessionUnavailable.status).toBe(503);
    expect(await sessionUnavailable.text()).not.toContain("session store detail");

  });
});
