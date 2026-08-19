import { createServer, type Server } from "node:http";

import type { AuthenticationAuditEvent, SessionUser, WorkspaceRole } from "../../shared/auth";
import type { InventoryEnvironment, InventorySnapshot, ServiceDetailResponse } from "../../shared/inventory";
import type { DeclareIncidentCommand, IncidentDetailResponse, IncidentListResponse, IncidentTransitionCommand } from "../../shared/incidents";
import type { LogQuery } from "../../shared/logs";
import type { PerformanceRange, PerformanceSnapshot } from "../../shared/performance";
import { IncidentRequestError } from "./incidents";
import { LogRequestError, type LogReader } from "./logs";
import { PerformanceRequestError } from "./prometheus";
import type { TopologyReader } from "./topology";
import { AuthenticationError, type AuthenticatedSession, type LogoutResult } from "./auth";
import type { SyntheticJourneyReader } from "./synthetic";

export interface InventoryReader {
  getInventory(environment: string): Promise<InventorySnapshot>;
}

export interface PerformanceReader {
  getPerformance(environment: string, serviceId: string, range: string): Promise<PerformanceSnapshot>;
}

export interface IncidentOperations {
  list(environment: string, statusFilter: string): Promise<IncidentListResponse>;
  getDetail(id: string): Promise<IncidentDetailResponse>;
  declare(command: DeclareIncidentCommand): Promise<IncidentDetailResponse>;
  transition(id: string, command: IncidentTransitionCommand): Promise<IncidentDetailResponse>;
}

export interface AuthenticatedIncidentOperations {
  list(environment: string, statusFilter: string, actor: SessionUser): Promise<IncidentListResponse>;
  getDetail(id: string, actor: SessionUser): Promise<IncidentDetailResponse>;
  declare(command: DeclareIncidentCommand, actor: SessionUser): Promise<IncidentDetailResponse>;
  transition(id: string, command: IncidentTransitionCommand, actor: SessionUser): Promise<IncidentDetailResponse>;
}

export interface WorkspaceAuthentication {
  readonly publicOrigin: string;
  authenticate(assertionHeader: string | null): Promise<AuthenticatedSession>;
  recordLogout(user: SessionUser): LogoutResult;
  recordAuthorizationDenied(user: SessionUser, action: string, reasonCode: string): void;
  listAudit(limit: number): readonly AuthenticationAuditEvent[];
}

export function safeNodeRequestMethod(method: string | undefined): "GET" | "HEAD" | "POST" | "DELETE" {
  if (method === undefined || method === "GET") return "GET";
  if (method === "HEAD") return "HEAD";
  if (method === "POST") return "POST";
  return "DELETE";
}

interface ApiErrorBody {
  readonly error: {
    readonly code: string;
    readonly message: string;
  };
}

const environments = new Set<InventoryEnvironment>(["all", "demo", "test", "portfolio", "shared"]);
const performanceRanges = new Set<PerformanceRange>(["15m", "1h", "6h", "24h"]);
const performanceParameters = new Set(["environment", "service", "range"]);
const topologyParameters = new Set(["environment"]);
const logParameters = new Set(["environment", "service", "range", "pod", "severity", "query", "correlationId"]);
const logEnvironments = new Set(["all", "demo", "test", "portfolio"]);
const logSeverities = new Set(["all", "error", "warning", "info", "debug", "unknown"]);
const incidentParameters = new Set(["environment", "status"]);
const incidentEnvironments = new Set(["all", "demo", "test", "portfolio"]);
const incidentStatusFilters = new Set(["active", "resolved", "all"]);
const MAX_INCIDENT_BODY_BYTES = 16_384;

class ApiRequestError extends Error {
  constructor(readonly status: 400 | 413, readonly code: string, message: string) {
    super(message);
  }
}

function responseHeaders(extra: Readonly<Record<string, string>> = {}): Headers {
  return new Headers({
    "Cache-Control": "no-store",
    "Content-Type": "application/json; charset=utf-8",
    "Referrer-Policy": "no-referrer",
    "X-Content-Type-Options": "nosniff",
    "X-Frame-Options": "DENY",
    ...extra
  });
}

function jsonResponse(status: number, body: unknown, headOnly: boolean, extraHeaders: Readonly<Record<string, string>> = {}): Response {
  const serialized = JSON.stringify(body);
  const headers = responseHeaders({ "Content-Length": String(Buffer.byteLength(serialized)), ...extraHeaders });
  return new Response(headOnly ? null : serialized, { status, headers });
}

function errorBody(code: string, message: string): ApiErrorBody {
  return { error: { code, message } };
}

function serviceIdFrom(pathname: string): string | null {
  const prefix = "/api/v1/services/";
  if (!pathname.startsWith(prefix) || pathname.length === prefix.length) return null;
  const encoded = pathname.slice(prefix.length);
  if (encoded.includes("/")) return null;
  try {
    return decodeURIComponent(encoded);
  } catch {
    return null;
  }
}

function incidentPath(pathname: string): { readonly id: string; readonly transition: boolean } | null {
  const match = /^\/api\/v1\/incidents\/(INC-[0-9]{6})(\/transitions)?$/u.exec(pathname);
  return match === null ? null : { id: match[1] ?? "", transition: match[2] !== undefined };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

async function strictJsonBody(request: Request, allowedFields: ReadonlySet<string>): Promise<Record<string, unknown>> {
  const mediaType = (request.headers.get("content-type") ?? "").split(";", 1)[0]?.trim().toLowerCase();
  if (mediaType !== "application/json") {
    throw new ApiRequestError(400, "invalid_content_type", "Incident commands require application/json.");
  }
  const body = await request.text();
  if (Buffer.byteLength(body) > MAX_INCIDENT_BODY_BYTES) throw new ApiRequestError(413, "incident_command_too_large", "Incident command exceeds the 16384-byte limit.");
  let parsed: unknown;
  try {
    parsed = JSON.parse(body) as unknown;
  } catch {
    throw new ApiRequestError(400, "malformed_json", "Incident command body is not valid JSON.");
  }
  if (!isRecord(parsed)) throw new ApiRequestError(400, "invalid_incident_command", "Incident command body must be a JSON object.");
  const unexpected = Object.keys(parsed).find((field) => !allowedFields.has(field));
  if (unexpected !== undefined) throw new ApiRequestError(400, "invalid_incident_command", `Unsupported incident command field: ${unexpected}`);
  return parsed;
}

function declareCommand(raw: Record<string, unknown>): DeclareIncidentCommand {
  if (typeof raw.serviceId !== "string" || typeof raw.title !== "string" || typeof raw.severity !== "string" || typeof raw.reason !== "string") {
    throw new ApiRequestError(400, "invalid_incident_command", "Declaration requires serviceId, title, severity, and reason strings.");
  }
  return { serviceId: raw.serviceId, title: raw.title, severity: raw.severity as DeclareIncidentCommand["severity"], reason: raw.reason };
}

function transitionCommand(raw: Record<string, unknown>): IncidentTransitionCommand {
  if (typeof raw.action !== "string" || !Number.isSafeInteger(raw.expectedVersion) || typeof raw.reason !== "string") {
    throw new ApiRequestError(400, "invalid_incident_command", "Transition requires action, integer expectedVersion, and reason.");
  }
  if (raw.durationMinutes !== undefined && !Number.isInteger(raw.durationMinutes)) {
    throw new ApiRequestError(400, "invalid_incident_command", "durationMinutes must be an integer when provided.");
  }
  return {
    action: raw.action as IncidentTransitionCommand["action"],
    expectedVersion: raw.expectedVersion as number,
    reason: raw.reason,
    ...(raw.durationMinutes === undefined ? {} : { durationMinutes: raw.durationMinutes as IncidentTransitionCommand["durationMinutes"] })
  };
}

async function handleIncidentRequest(request: Request, operations: IncidentOperations | undefined, url: URL, headOnly: boolean): Promise<Response | null> {
  if (url.pathname !== "/api/v1/incidents" && incidentPath(url.pathname) === null) return null;
  if (operations === undefined) return jsonResponse(503, errorBody("incidents_unavailable", "Incident operations are not configured."), headOnly);
  try {
    if (url.pathname === "/api/v1/incidents") {
      if (request.method === "GET" || request.method === "HEAD") {
        const unexpected = [...url.searchParams.keys()].find((parameter) => !incidentParameters.has(parameter));
        if (unexpected !== undefined) throw new ApiRequestError(400, "invalid_parameter", `Unsupported incident parameter: ${unexpected}`);
        const environment = url.searchParams.get("environment") ?? "all";
        const status = url.searchParams.get("status") ?? "active";
        if (!incidentEnvironments.has(environment)) throw new ApiRequestError(400, "invalid_environment", `Unsupported environment: ${environment}`);
        if (!incidentStatusFilters.has(status)) throw new ApiRequestError(400, "invalid_incident_filter", `Unsupported incident status: ${status}`);
        return jsonResponse(200, await operations.list(environment, status), headOnly);
      }
      if (request.method === "POST") {
        if ([...url.searchParams.keys()].length > 0) throw new ApiRequestError(400, "invalid_parameter", "Incident declarations do not accept query parameters.");
        const raw = await strictJsonBody(request, new Set(["serviceId", "title", "severity", "reason"]));
        return jsonResponse(201, await operations.declare(declareCommand(raw)), false);
      }
      return jsonResponse(405, errorBody("method_not_allowed", "Only GET, HEAD, and POST are supported for incidents."), false, { Allow: "GET, HEAD, POST" });
    }

    const path = incidentPath(url.pathname);
    if (path === null) return null;
    if ([...url.searchParams.keys()].length > 0) throw new ApiRequestError(400, "invalid_parameter", "Incident detail and transition routes do not accept query parameters.");
    if (path.transition) {
      if (request.method !== "POST") return jsonResponse(405, errorBody("method_not_allowed", "Only POST is supported for incident transitions."), false, { Allow: "POST" });
      const raw = await strictJsonBody(request, new Set(["action", "expectedVersion", "reason", "durationMinutes"]));
      return jsonResponse(200, await operations.transition(path.id, transitionCommand(raw)), false);
    }
    if (request.method !== "GET" && request.method !== "HEAD") return jsonResponse(405, errorBody("method_not_allowed", "Only GET and HEAD are supported for incident detail."), false, { Allow: "GET, HEAD" });
    return jsonResponse(200, await operations.getDetail(path.id), headOnly);
  } catch (cause: unknown) {
    if (cause instanceof IncidentRequestError) return jsonResponse(cause.status, errorBody(cause.code, cause.message), headOnly);
    if (cause instanceof ApiRequestError) return jsonResponse(cause.status, errorBody(cause.code, cause.message), headOnly);
    return jsonResponse(500, errorBody("incidents_unavailable", "Incident operations could not be completed."), headOnly);
  }
}

export async function handleInventoryRequest(request: Request, reader: InventoryReader, performanceReader?: PerformanceReader, topologyReader?: TopologyReader, incidentOperations?: IncidentOperations, logReader?: LogReader, syntheticJourneyReader?: SyntheticJourneyReader): Promise<Response> {
  const headOnly = request.method === "HEAD";
  const url = new URL(request.url);
  const incidentResponse = await handleIncidentRequest(request, incidentOperations, url, headOnly);
  if (incidentResponse !== null) return incidentResponse;
  if (request.method !== "GET" && !headOnly) {
    return jsonResponse(405, errorBody("method_not_allowed", "Only read-only GET and HEAD requests are supported."), false, { Allow: "GET, HEAD" });
  }

  if (url.pathname === "/healthz") return jsonResponse(200, { status: "healthy" }, headOnly);

  if (url.pathname === "/api/v1/journeys") {
    if (syntheticJourneyReader === undefined) return jsonResponse(503, errorBody("synthetic_journeys_unavailable", "Synthetic journey evidence is not configured."), headOnly);
    if ([...url.searchParams.keys()].length > 0) return jsonResponse(400, errorBody("invalid_parameter", "Synthetic journey evidence does not accept query parameters."), headOnly);
    try {
      return jsonResponse(200, await syntheticJourneyReader.getSyntheticJourneys(), headOnly);
    } catch {
      return jsonResponse(500, errorBody("synthetic_journeys_unavailable", "Synthetic journey evidence could not be assembled."), headOnly);
    }
  }

  if (url.pathname === "/api/v1/performance") {
    if (performanceReader === undefined) return jsonResponse(503, errorBody("performance_unavailable", "Performance telemetry is not configured."), headOnly);
    const unexpected = [...url.searchParams.keys()].find((parameter) => !performanceParameters.has(parameter));
    if (unexpected !== undefined) return jsonResponse(400, errorBody("invalid_parameter", `Unsupported performance parameter: ${unexpected}`), headOnly);
    const environment = url.searchParams.get("environment") ?? "all";
    const serviceId = url.searchParams.get("service") ?? "all";
    const range = url.searchParams.get("range") ?? "1h";
    if (!environments.has(environment as InventoryEnvironment)) {
      return jsonResponse(400, errorBody("invalid_environment", `Unsupported environment: ${environment}`), headOnly);
    }
    if (!performanceRanges.has(range as PerformanceRange)) {
      return jsonResponse(400, errorBody("invalid_range", `Unsupported performance range: ${range}`), headOnly);
    }
    try {
      return jsonResponse(200, await performanceReader.getPerformance(environment, serviceId, range), headOnly);
    } catch (cause: unknown) {
      if (cause instanceof PerformanceRequestError) return jsonResponse(400, errorBody("invalid_performance_filter", cause.message), headOnly);
      return jsonResponse(500, errorBody("performance_unavailable", "Performance telemetry could not be assembled."), headOnly);
    }
  }

  if (url.pathname === "/api/v1/topology") {
    if (topologyReader === undefined) return jsonResponse(503, errorBody("topology_unavailable", "Infrastructure topology is not configured."), headOnly);
    const unexpected = [...url.searchParams.keys()].find((parameter) => !topologyParameters.has(parameter));
    if (unexpected !== undefined) return jsonResponse(400, errorBody("invalid_parameter", `Unsupported topology parameter: ${unexpected}`), headOnly);
    const environment = url.searchParams.get("environment") ?? "all";
    if (!environments.has(environment as InventoryEnvironment)) return jsonResponse(400, errorBody("invalid_environment", `Unsupported environment: ${environment}`), headOnly);
    try {
      return jsonResponse(200, await topologyReader.getTopology(environment), headOnly);
    } catch {
      return jsonResponse(500, errorBody("topology_unavailable", "Infrastructure topology could not be assembled."), headOnly);
    }
  }

  if (url.pathname === "/api/v1/logs") {
    if (logReader === undefined) return jsonResponse(503, errorBody("logs_unavailable", "Log and event correlation is not configured."), headOnly);
    const unexpected = [...url.searchParams.keys()].find((parameter) => !logParameters.has(parameter));
    if (unexpected !== undefined) return jsonResponse(400, errorBody("invalid_parameter", `Unsupported log parameter: ${unexpected}`), headOnly);
    const duplicate = [...logParameters].find((parameter) => url.searchParams.getAll(parameter).length > 1);
    if (duplicate !== undefined) return jsonResponse(400, errorBody("invalid_parameter", `Log parameter must not be repeated: ${duplicate}`), headOnly);
    const environment = url.searchParams.get("environment") ?? "all";
    const serviceId = url.searchParams.get("service") ?? "";
    const range = url.searchParams.get("range") ?? "1h";
    const pod = url.searchParams.get("pod");
    const severity = url.searchParams.get("severity") ?? "all";
    const textQuery = url.searchParams.get("query") ?? "";
    const correlationId = url.searchParams.get("correlationId") ?? "";
    if (!logEnvironments.has(environment)) return jsonResponse(400, errorBody("invalid_environment", `Unsupported environment: ${environment}`), headOnly);
    if (serviceId === "") return jsonResponse(400, errorBody("invalid_log_filter", "A service parameter is required."), headOnly);
    if (!performanceRanges.has(range as PerformanceRange)) return jsonResponse(400, errorBody("invalid_range", `Unsupported log range: ${range}`), headOnly);
    if (!logSeverities.has(severity)) return jsonResponse(400, errorBody("invalid_log_filter", `Unsupported log severity: ${severity}`), headOnly);
    const query: LogQuery = {
      environment: environment as LogQuery["environment"], serviceId, range: range as LogQuery["range"], pod,
      severity: severity as LogQuery["severity"], query: textQuery, correlationId
    };
    try {
      return jsonResponse(200, await logReader.getLogs(query), headOnly);
    } catch (cause: unknown) {
      if (cause instanceof LogRequestError) return jsonResponse(400, errorBody("invalid_log_filter", cause.message), headOnly);
      return jsonResponse(500, errorBody("logs_unavailable", "Log correlation could not be assembled."), headOnly);
    }
  }

  try {
    if (url.pathname === "/api/v1/inventory") {
      const environment = url.searchParams.get("environment") ?? "all";
      if (!environments.has(environment as InventoryEnvironment)) {
        return jsonResponse(400, errorBody("invalid_environment", `Unsupported environment: ${environment}`), headOnly);
      }
      return jsonResponse(200, await reader.getInventory(environment), headOnly);
    }

    const serviceId = serviceIdFrom(url.pathname);
    if (serviceId !== null) {
      const snapshot = await reader.getInventory("all");
      const service = snapshot.services.find((item) => item.id === serviceId);
      if (service === undefined) {
        return jsonResponse(404, errorBody("service_not_found", "The requested service is not in the monitoring catalog."), headOnly);
      }
      const detail: ServiceDetailResponse = {
        apiVersion: 1,
        mode: snapshot.mode,
        assembledAt: snapshot.assembledAt,
        service,
        sources: snapshot.sources
      };
      return jsonResponse(200, detail, headOnly);
    }
  } catch {
    return jsonResponse(500, errorBody("inventory_unavailable", "Inventory could not be assembled."), headOnly);
  }

  return jsonResponse(404, errorBody("not_found", "The requested API route does not exist."), headOnly);
}

const roleRank: Readonly<Record<WorkspaceRole, number>> = { viewer: 1, operator: 2, administrator: 3 };

function hasRole(user: SessionUser, required: WorkspaceRole): boolean {
  return roleRank[user.role] >= roleRank[required];
}

function mutationOriginIsValid(request: Request, authentication: WorkspaceAuthentication): boolean {
  return request.headers.get("origin") === authentication.publicOrigin && request.headers.get("sec-fetch-site") === "same-origin";
}

function logoutRequestIsValid(request: Request, authentication: WorkspaceAuthentication): boolean {
  return request.headers.get("origin") === authentication.publicOrigin && request.headers.get("x-workspace-csrf") === "logout";
}

function authError(cause: unknown, headOnly: boolean): Response {
  if (cause instanceof AuthenticationError) return jsonResponse(cause.status, errorBody(cause.code, cause.message), headOnly);
  return jsonResponse(503, errorBody("authentication_unavailable", "Authentication could not be completed."), headOnly);
}

export async function handleWorkspaceRequest(
  request: Request,
  authentication: WorkspaceAuthentication,
  reader: InventoryReader,
  performanceReader?: PerformanceReader,
  topologyReader?: TopologyReader,
  incidentOperations?: AuthenticatedIncidentOperations,
  logReader?: LogReader,
  syntheticJourneyReader?: SyntheticJourneyReader
): Promise<Response> {
  const url = new URL(request.url);
  const headOnly = request.method === "HEAD";
  if (url.pathname === "/healthz") return handleInventoryRequest(request, reader, performanceReader, topologyReader, undefined, logReader);
  const logoutRoute = url.pathname === "/auth/logout";
  if (!url.pathname.startsWith("/api/v1/") && !logoutRoute) return jsonResponse(404, errorBody("not_found", "The requested route does not exist."), headOnly);

  let session: AuthenticatedSession;
  try {
    session = await authentication.authenticate(request.headers.get("cf-access-jwt-assertion"));
  } catch (cause: unknown) {
    return authError(cause, headOnly);
  }

  if (logoutRoute) {
    if (request.method !== "POST") return jsonResponse(405, errorBody("method_not_allowed", "Only POST is supported for logout."), false, { Allow: "POST" });
    if (!logoutRequestIsValid(request, authentication)) {
      authentication.recordAuthorizationDenied(session.user, "auth.logout", "csrf_rejected");
      return jsonResponse(403, errorBody("csrf_rejected", "The request origin is not allowed."), false);
    }
    try {
      authentication.recordLogout(session.user);
      return new Response(null, { status: 204, headers: responseHeaders({ "Content-Length": "0" }) });
    } catch (cause: unknown) {
      return authError(cause, false);
    }
  }

  if (url.pathname === "/api/v1/session") {
    if (request.method !== "GET" && !headOnly) return jsonResponse(405, errorBody("method_not_allowed", "Only GET and HEAD are supported for the session endpoint."), false, { Allow: "GET, HEAD" });
    if ([...url.searchParams.keys()].length > 0) return jsonResponse(400, errorBody("invalid_parameter", "The session endpoint does not accept query parameters."), headOnly);
    return jsonResponse(200, { apiVersion: 1, authenticated: true, user: session.user, expiresAt: session.expiresAt }, headOnly);
  }

  if (url.pathname === "/api/v1/auth-check") {
    if (request.method !== "GET" && !headOnly) return jsonResponse(405, errorBody("method_not_allowed", "Only GET and HEAD are supported for authentication checks."), false, { Allow: "GET, HEAD" });
    return new Response(null, { status: 204, headers: responseHeaders({ "Content-Length": "0" }) });
  }

  if (url.pathname === "/api/v1/auth/audit") {
    if (request.method !== "GET" && !headOnly) return jsonResponse(405, errorBody("method_not_allowed", "Only GET and HEAD are supported for authentication audit."), false, { Allow: "GET, HEAD" });
    if (!hasRole(session.user, "administrator")) {
      authentication.recordAuthorizationDenied(session.user, "auth.audit.read", "insufficient_role");
      return jsonResponse(403, errorBody("forbidden", "The authenticated role is not allowed to read authentication audit history."), headOnly);
    }
    const unexpected = [...url.searchParams.keys()].find((parameter) => parameter !== "limit");
    if (unexpected !== undefined || url.searchParams.getAll("limit").length > 1) return jsonResponse(400, errorBody("invalid_parameter", "Authentication audit accepts one limit parameter."), headOnly);
    const rawLimit = url.searchParams.get("limit") ?? "100";
    if (!/^[1-9][0-9]{0,2}$/u.test(rawLimit)) return jsonResponse(400, errorBody("invalid_audit_limit", "Authentication audit limit must be 1 to 100."), headOnly);
    const limit = Number(rawLimit);
    if (limit > 100) return jsonResponse(400, errorBody("invalid_audit_limit", "Authentication audit limit must be 1 to 100."), headOnly);
    try {
      return jsonResponse(200, { apiVersion: 1, events: authentication.listAudit(limit) }, headOnly);
    } catch (cause: unknown) {
      return authError(cause, headOnly);
    }
  }

  const mutating = request.method !== "GET" && request.method !== "HEAD";
  const incidentMutation = request.method === "POST" && (url.pathname === "/api/v1/incidents" || incidentPath(url.pathname)?.transition === true);
  if (mutating && !mutationOriginIsValid(request, authentication)) {
    authentication.recordAuthorizationDenied(session.user, incidentMutation ? "incident.mutate" : "request.mutate", "csrf_rejected");
    return jsonResponse(403, errorBody("csrf_rejected", "The request origin is not allowed."), false);
  }
  if (incidentMutation && !hasRole(session.user, "operator")) {
    authentication.recordAuthorizationDenied(session.user, "incident.mutate", "insufficient_role");
    return jsonResponse(403, errorBody("forbidden", "The authenticated role is not allowed to mutate incidents."), false);
  }
  const boundIncidentOperations: IncidentOperations | undefined = incidentOperations === undefined ? undefined : {
    list: (environment, statusFilter) => incidentOperations.list(environment, statusFilter, session.user),
    getDetail: (id) => incidentOperations.getDetail(id, session.user),
    declare: (command) => incidentOperations.declare(command, session.user),
    transition: (id, command) => incidentOperations.transition(id, command, session.user)
  };
  return handleInventoryRequest(request, reader, performanceReader, topologyReader, boundIncidentOperations, logReader, syntheticJourneyReader);
}

export function createInventoryHttpServer(authentication: WorkspaceAuthentication, reader: InventoryReader, performanceReader?: PerformanceReader, topologyReader?: TopologyReader, incidentOperations?: AuthenticatedIncidentOperations, logReader?: LogReader, syntheticJourneyReader?: SyntheticJourneyReader): Server {
  return createServer((incoming, outgoing) => {
    const chunks: Buffer[] = [];
    let size = 0;
    let oversized = false;
    incoming.on("data", (chunk: Buffer | string) => {
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      size += buffer.byteLength;
      if (size > MAX_INCIDENT_BODY_BYTES) oversized = true;
      else chunks.push(buffer);
    });
    incoming.on("end", () => {
      const method = safeNodeRequestMethod(incoming.method);
      const body = Buffer.concat(chunks);
      const headers = new Headers();
      for (const name of ["accept", "content-type", "cf-access-jwt-assertion", "origin", "sec-fetch-site", "x-workspace-csrf"] as const) {
        const value = incoming.headers[name];
        if (typeof value === "string") headers.set(name, value);
      }
      const request = new Request(new URL(incoming.url ?? "/", "http://inventory-api.local"), {
        method,
        headers,
        body: method === "POST" && body.byteLength > 0 ? body : undefined
      });
      const responsePromise = oversized
        ? Promise.resolve(jsonResponse(413, errorBody("incident_command_too_large", "Incident command exceeds the 16384-byte limit."), false))
        : handleWorkspaceRequest(request, authentication, reader, performanceReader, topologyReader, incidentOperations, logReader, syntheticJourneyReader);
      void responsePromise.then(async (response) => {
        outgoing.statusCode = response.status;
        response.headers.forEach((value, key) => {
          if (key !== "set-cookie") outgoing.setHeader(key, value);
        });
        const cookies = response.headers.getSetCookie();
        if (cookies.length > 0) outgoing.setHeader("Set-Cookie", cookies);
        outgoing.end(Buffer.from(await response.arrayBuffer()));
      }).catch(() => {
        outgoing.statusCode = 500;
        outgoing.setHeader("Content-Type", "application/json; charset=utf-8");
        outgoing.end(JSON.stringify(errorBody("inventory_unavailable", "Inventory could not be assembled.")));
      });
    });
  });
}
