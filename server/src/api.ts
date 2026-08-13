import { createServer, type Server } from "node:http";

import type { InventoryEnvironment, InventorySnapshot, ServiceDetailResponse } from "../../shared/inventory";

export interface InventoryReader {
  getInventory(environment: string): Promise<InventorySnapshot>;
}

export function safeNodeRequestMethod(method: string | undefined): "GET" | "HEAD" | "POST" {
  return method === undefined || method === "GET" ? "GET" : method === "HEAD" ? "HEAD" : "POST";
}

interface ApiErrorBody {
  readonly error: {
    readonly code: string;
    readonly message: string;
  };
}

const environments = new Set<InventoryEnvironment>(["all", "demo", "test", "shared"]);

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

export async function handleInventoryRequest(request: Request, reader: InventoryReader): Promise<Response> {
  const headOnly = request.method === "HEAD";
  if (request.method !== "GET" && !headOnly) {
    return jsonResponse(405, errorBody("method_not_allowed", "Only read-only GET and HEAD requests are supported."), false, { Allow: "GET, HEAD" });
  }

  const url = new URL(request.url);
  if (url.pathname === "/healthz") return jsonResponse(200, { status: "healthy" }, headOnly);

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

export function createInventoryHttpServer(reader: InventoryReader): Server {
  return createServer((incoming, outgoing) => {
    const request = new Request(new URL(incoming.url ?? "/", "http://inventory-api.local"), { method: safeNodeRequestMethod(incoming.method) });
    void handleInventoryRequest(request, reader).then(async (response) => {
      outgoing.statusCode = response.status;
      response.headers.forEach((value, key) => outgoing.setHeader(key, value));
      outgoing.end(Buffer.from(await response.arrayBuffer()));
    }).catch(() => {
      outgoing.statusCode = 500;
      outgoing.setHeader("Content-Type", "application/json; charset=utf-8");
      outgoing.end(JSON.stringify(errorBody("inventory_unavailable", "Inventory could not be assembled.")));
    });
  });
}
