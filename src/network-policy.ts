import { readFileSync } from "node:fs";
import { Agent, ProxyAgent, type Dispatcher } from "undici";
import type { AppConfig } from "./config.js";

export function createYuqueDispatcher(
  config: AppConfig,
): Dispatcher | undefined {
  const ca = config.yuqueCaFile
    ? readFileSync(config.yuqueCaFile, "utf8")
    : undefined;
  if (config.yuqueHttpsProxy) {
    const proxy = new URL(config.yuqueHttpsProxy);
    const token = proxy.username
      ? `Basic ${Buffer.from(
          `${decodeURIComponent(proxy.username)}:${decodeURIComponent(proxy.password)}`,
        ).toString("base64")}`
      : undefined;
    proxy.username = "";
    proxy.password = "";
    return new ProxyAgent({
      uri: proxy.toString(),
      ...(token ? { token } : {}),
      ...(ca ? { requestTls: { ca }, proxyTls: { ca } } : {}),
    });
  }
  return ca ? new Agent({ connect: { ca } }) : undefined;
}

export function playwrightProxy(
  config: AppConfig,
): { server: string; username?: string; password?: string } | undefined {
  if (!config.yuqueHttpsProxy) return undefined;
  const proxy = new URL(config.yuqueHttpsProxy);
  const result = {
    server: `${proxy.protocol}//${proxy.host}`,
    ...(proxy.username ? { username: decodeURIComponent(proxy.username) } : {}),
    ...(proxy.password ? { password: decodeURIComponent(proxy.password) } : {}),
  };
  return result;
}
