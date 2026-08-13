import { describe, expect, it } from "vitest";

import { UnavailableSourceCollector } from "../src/source";
import { catalogFixture } from "./fixtures";

describe("unavailable source collector", () => {
  it("reports absent least-privilege credentials as an explicit redacted failure", async () => {
    const collector = new UnavailableSourceCollector(
      "kubernetes",
      "https://kubernetes.example.test",
      "token=/run/secrets/super-secret is unavailable"
    );

    await expect(collector.collect(catalogFixture)).rejects.toThrow("[REDACTED]");
  });
});
