import { describe, expect, it } from "vitest";
import { ContractError } from "../src/contracts.js";
import { toSafeToolError } from "../src/tool-error.js";
import { ReloginRequiredError, YuqueHttpError } from "../src/yuque-client.js";

describe("structured safe MCP tool errors", () => {
  it("classifies login, contract, permission and rate-limit errors", () => {
    expect(toSafeToolError(new ReloginRequiredError(), "request-1")).toEqual({
      ok: false,
      error: {
        code: "relogin_required",
        message: "Yuque login has expired; scan the login QR code again",
        request_id: "request-1",
        retriable: false,
        relogin_required: true,
      },
    });
    expect(
      toSafeToolError(new ContractError("shape changed"), "request-2").error
        .code,
    ).toBe("contract_incompatible");
    expect(
      toSafeToolError(new YuqueHttpError(403, "forbidden"), "request-3").error
        .code,
    ).toBe("permission_denied");
    expect(
      toSafeToolError(new YuqueHttpError(429, "slow down", 12), "request-4")
        .error,
    ).toMatchObject({
      code: "rate_limited",
      retriable: true,
      retry_after_seconds: 12,
    });
  });

  it("redacts credential-looking values and classifies strict mode", () => {
    const redacted = toSafeToolError(
      new Error("Cookie: secret-value token=another-secret"),
      "request-5",
    );
    expect(redacted.error.message).not.toContain("secret-value");
    expect(redacted.error.message).not.toContain("another-secret");

    expect(
      toSafeToolError(
        new Error("Remote Confirm is blocked by strict write consistency mode"),
        "request-6",
      ).error.code,
    ).toBe("strict_mode_blocked");
  });
});
