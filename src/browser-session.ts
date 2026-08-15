import { CookieJar, type SerializedCookieJar } from "tough-cookie";
import type { BrowserContext } from "playwright-core";
import type { StoredWebSession } from "./types.js";

type BrowserCookie = Parameters<BrowserContext["addCookies"]>[0][number];

export function toBrowserCookies(
  session: StoredWebSession,
  yuqueHost: string,
): BrowserCookie[] {
  const jar = CookieJar.deserializeSync(session.cookies as SerializedCookieJar);
  return jar.getCookiesSync(yuqueHost).map((cookie) => {
    const expires = cookie.expiryTime();
    const normalizedDomain = (
      cookie.domain || new URL(yuqueHost).hostname
    ).replace(/^\./, "");
    const sameSite =
      cookie.sameSite === "strict"
        ? "Strict"
        : cookie.sameSite === "lax"
          ? "Lax"
          : cookie.sameSite === "none"
            ? "None"
            : undefined;
    return {
      name: cookie.key,
      value: cookie.value,
      domain: cookie.hostOnly ? normalizedDomain : `.${normalizedDomain}`,
      path: cookie.path || "/",
      ...(typeof expires === "number" && Number.isFinite(expires) && expires > 0
        ? { expires: Math.floor(expires / 1_000) }
        : {}),
      httpOnly: cookie.httpOnly,
      secure: cookie.secure,
      ...(sameSite ? { sameSite } : {}),
    };
  });
}
