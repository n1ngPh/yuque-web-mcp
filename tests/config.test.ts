import { afterEach, describe, expect, it, vi } from "vitest";
import { loadConfig } from "../src/config.js";

afterEach(() => vi.unstubAllEnvs());

describe("production configuration", () => {
  it("defaults write consistency to strict", () => {
    requiredEnvironment();
    expect(loadConfig().writeConsistencyMode).toBe("strict");
  });

  it("accepts only explicit strict or best_effort values", () => {
    requiredEnvironment();
    vi.stubEnv("WRITE_CONSISTENCY_MODE", "best_effort");
    expect(loadConfig().writeConsistencyMode).toBe("best_effort");

    vi.stubEnv("WRITE_CONSISTENCY_MODE", "unsafe");
    expect(() => loadConfig()).toThrow(
      "WRITE_CONSISTENCY_MODE must be strict or best_effort",
    );
  });
});

function requiredEnvironment(): void {
  vi.stubEnv("MCP_OWNER_ID", "employee.a");
  vi.stubEnv("MCP_BEARER_TOKEN", "t".repeat(40));
  vi.stubEnv("SESSION_ENCRYPTION_KEY", Buffer.alloc(32, 7).toString("base64"));
  vi.stubEnv("DATA_DIR", "/tmp/yuque-web-mcp-config-test");
  vi.stubEnv("CONTRACT_PATH", "/tmp/yuque-web-mcp-contract-test.json");
  vi.stubEnv("HOST", "127.0.0.1");
}
