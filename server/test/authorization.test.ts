import { describe, expect, it } from "vitest";

import type { AuthenticationAuditEvent, SessionUser } from "../../shared/auth";
import type { InventorySnapshot } from "../../shared/inventory";
import type { IncidentDetailResponse, IncidentListResponse } from "../../shared/incidents";
import {
  AuthenticationError,
  type AuthenticatedSession,
  type LoginCompletion,
  type LoginStart,
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
  operator: { id: "oidc:operator", displayName: "Lab Operator", role: "operator", identityMode: "authenticated-session" },
  incidents: []
} as const satisfies IncidentListResponse;
const incidentOperations: IncidentOperations = {
  list: () => Promise.resolve(incidentList),
  getDetail: () => Promise.reject(new Error("not used")),
  declare: () => Promise.reject(new Error("must not be called")),
  transition: () => Promise.reject(new Error("must not be called"))
};

const users = {
  viewer: { id: "oidc:viewer", displayName: "View Only", role: "viewer" },
  operator: { id: "oidc:operator", displayName: "Lab Operator", role: "operator" },
  administrator: { id: "oidc:administrator", displayName: "Lab Admin", role: "administrator" }
} as const satisfies Readonly<Record<string, SessionUser>>;

class FakeAuthentication implements WorkspaceAuthentication {
  readonly publicOrigin = "https://monitor.jefferyhaynes.net";
  user: SessionUser | null = users.operator;
  denied: Array<{ readonly user: SessionUser; readonly action: string; readonly reason: string }> = [];
  authenticationFailure: Error | null = null;
  loginFailure: Error | null = null;
  auditFailure: Error | null = null;
  audit: readonly AuthenticationAuditEvent[] = [{
    id: 1, createdAt: "2026-08-16T12:00:00.000Z", actorId: users.administrator.id, displayName: users.administrator.displayName,
    action: "login_succeeded", outcome: "succeeded", reasonCode: "oidc_callback_validated", metadata: { role: "administrator" }
  }];

  startLogin(): Promise<LoginStart> {
    if (this.loginFailure !== null) return Promise.reject(this.loginFailure);
    return Promise.resolve({ authorizationUrl: "https://identity.example.test/authorize", transactionCookie: "__Host-workspace_oidc=transaction; Secure; HttpOnly; SameSite=Lax" });
  }

  completeLoginQuery(): Promise<LoginCompletion> {
    return Promise.resolve({
      user: users.operator,
      sessionCookie: "__Host-workspace_session=session; Secure; HttpOnly; SameSite=Lax",
      clearTransactionCookie: "__Host-workspace_oidc=; Max-Age=0; Secure; HttpOnly; SameSite=Lax",
      returnTo: "/incidents"
    });
  }

  authenticate(): Promise<AuthenticatedSession> {
    if (this.authenticationFailure !== null) return Promise.reject(this.authenticationFailure);
    if (this.user === null) return Promise.reject(new AuthenticationError(401, "authentication_required", "Authentication is required."));
    return Promise.resolve({ user: this.user, expiresAt: "2026-08-17T00:00:00.000Z", idleExpiresAt: "2026-08-16T13:00:00.000Z" });
  }

  logout(): Promise<LogoutResult> {
    return Promise.resolve({ clearSessionCookie: "__Host-workspace_session=; Max-Age=0; Secure; HttpOnly; SameSite=Lax", redirectTo: "https://monitor.jefferyhaynes.net/", providerLogoutAvailable: false });
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
      expiresAt: "2026-08-17T00:00:00.000Z",
      idleExpiresAt: "2026-08-16T13:00:00.000Z"
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

  it("handles login, callback, and local-first logout without exposing provider tokens", async () => {
    const authentication = new FakeAuthentication();
    const login = await request("/auth/login?returnTo=%2Fincidents", authentication);
    expect(login.status).toBe(302);
    expect(login.headers.get("location")).toBe("https://identity.example.test/authorize");
    expect(login.headers.get("set-cookie")).toContain("__Host-workspace_oidc=");

    const callback = await request("/auth/callback?code=one-use&state=bound", authentication, { headers: { Cookie: "__Host-workspace_oidc=transaction" } });
    expect(callback.status).toBe(303);
    expect(callback.headers.get("location")).toBe("/incidents");
    expect(callback.headers.getSetCookie()).toHaveLength(2);

    const logout = await request("/auth/logout", authentication, {
      method: "POST",
      headers: { Cookie: "__Host-workspace_session=session", Origin: authentication.publicOrigin, "Sec-Fetch-Site": "same-origin" }
    });
    expect(logout.status).toBe(303);
    expect(logout.headers.get("location")).toBe(authentication.publicOrigin + "/");
    expect(logout.headers.get("set-cookie")).toContain("Max-Age=0");

    expect((await request("/auth/login", authentication, { method: "HEAD" })).status).toBe(405);
    expect((await request("/auth/callback?code=x&state=y", authentication, { method: "HEAD" })).status).toBe(405);
  });

  it("rejects malformed authentication routes and reports internal auth failures generically", async () => {
    const authentication = new FakeAuthentication();
    expect((await request("/auth/login?unexpected=1", authentication)).status).toBe(400);
    expect((await request("/auth/login?returnTo=%2F&returnTo=%2Flogs", authentication)).status).toBe(400);
    expect((await request("/auth/logout", authentication)).status).toBe(405);
    expect((await request("/auth/logout", authentication, { method: "POST" })).status).toBe(403);
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

    authentication.authenticationFailure = null;
    authentication.loginFailure = new Error("discovery detail must not leak");
    const loginUnavailable = await request("/auth/login", authentication);
    expect(loginUnavailable.status).toBe(503);
    expect(await loginUnavailable.text()).not.toContain("discovery detail");
  });
});
