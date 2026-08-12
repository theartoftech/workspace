import { incidentFixtures, serviceFixtures, trafficFixtures } from "./fixtures";
import type {
  EnvironmentId,
  MonitoringProvider,
  OverviewSnapshot,
  OverviewSummary,
  ServiceHealth,
  TimeRange
} from "./types";

const environments = new Set<EnvironmentId>(["all", "demo", "test", "shared"]);
const timeRanges = new Set<TimeRange>(["15m", "1h", "6h", "24h"]);

function summarize(services: readonly ServiceHealth[]): OverviewSummary {
  const healthyServices = services.filter((service) => service.status === "healthy").length;
  const degradedServices = services.filter((service) => service.status === "degraded").length;
  const criticalServices = services.filter((service) => service.status === "critical").length;
  const uptime = services.length === 0
    ? 0
    : services.reduce((total, service) => total + service.uptime, 0) / services.length;

  return {
    totalServices: services.length,
    healthyServices,
    degradedServices,
    criticalServices,
    uptime,
    activeIncidents: incidentFixtures.length
  };
}

export function createFixtureMonitoringProvider(): MonitoringProvider {
  return {
    async getOverview(environment: EnvironmentId, timeRange: TimeRange): Promise<OverviewSnapshot> {
      if (!environments.has(environment)) {
        throw new Error(`Unsupported environment: ${environment}`);
      }
      if (!timeRanges.has(timeRange)) {
        throw new Error(`Unsupported time range: ${timeRange}`);
      }

      const services = environment === "all"
        ? serviceFixtures
        : serviceFixtures.filter((service) => service.environment === environment);

      return Promise.resolve({
        mode: "fixture",
        generatedAt: "2026-08-12T11:15:00-04:00",
        environment,
        timeRange,
        summary: summarize(services),
        services,
        incidents: incidentFixtures,
        traffic: trafficFixtures
      });
    }
  };
}
