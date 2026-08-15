import { describe, expect, it } from "vitest";
import { CookieJar } from "tough-cookie";
import { toBrowserCookies } from "../src/browser-session.js";

describe("browser research session conversion", () => {
  it("preserves domain-cookie scope when importing the encrypted HTTP jar", () => {
    const host = "https://example-team.yuque.com";
    const jar = new CookieJar();
    jar.setCookieSync(
      "shared=one; Domain=yuque.com; Path=/; Secure; SameSite=None",
      host,
    );
    jar.setCookieSync("host=two; Path=/; HttpOnly; SameSite=Lax", host);

    const cookies = toBrowserCookies(
      {
        cookies: jar.serializeSync(),
        csrfToken: "not-used-by-conversion",
        account: { id: "1", login: "alice" },
        savedAt: new Date().toISOString(),
      },
      host,
    );

    expect(cookies.find((cookie) => cookie.name === "shared")).toMatchObject({
      domain: ".yuque.com",
      sameSite: "None",
      secure: true,
    });
    expect(cookies.find((cookie) => cookie.name === "host")).toMatchObject({
      domain: "example-team.yuque.com",
      sameSite: "Lax",
      httpOnly: true,
    });
  });
});
