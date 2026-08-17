import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, isAbsolute } from "node:path";

const fileEnvironment = process.env.MCP_ENV_FILE
  ? parseEnvironment(await readFile(process.env.MCP_ENV_FILE, "utf8"))
  : {};
const publicBaseUrl =
  process.env.PUBLIC_BASE_URL || fileEnvironment.PUBLIC_BASE_URL;
const mcpUrl =
  process.env.MCP_URL ||
  (publicBaseUrl ? `${publicBaseUrl.replace(/\/$/, "")}/mcp` : undefined) ||
  "http://127.0.0.1:18080/mcp";
const serverBaseUrl =
  process.env.SOAK_SERVER_BASE_URL || deriveServerBaseUrl(mcpUrl);
const token = process.env.MCP_BEARER_TOKEN || fileEnvironment.MCP_BEARER_TOKEN;
if (!token) throw new Error("MCP_BEARER_TOKEN is required");

const packageVersion = JSON.parse(
  await readFile(new URL("../package.json", import.meta.url), "utf8"),
).version;
const durationSeconds = positiveInteger("SOAK_DURATION_SECONDS", 72 * 60 * 60);
const intervalSeconds = positiveInteger("SOAK_INTERVAL_SECONDS", 60);
const requestTimeoutMs = positiveInteger("SOAK_REQUEST_TIMEOUT_MS", 30_000);
const maxCycleGapSeconds = positiveInteger(
  "SOAK_MAX_CYCLE_GAP_SECONDS",
  Math.max(intervalSeconds * 5, 300),
);
const minimumCycleRatioPercent = percentageInteger(
  "SOAK_MIN_CYCLE_RATIO_PERCENT",
  95,
);
const expectedToolCount = positiveInteger("SOAK_EXPECTED_TOOL_COUNT", 38);
const expectedServerVersion =
  process.env.SOAK_EXPECTED_SERVER_VERSION || packageVersion;
const allowedBookUrl = optionalExactBookUrl(process.env.SOAK_ALLOWED_BOOK_URL);
const docUrl = optionalTargetUrl("SOAK_DOC_URL", allowedBookUrl);
const sheetUrl = optionalTargetUrl("SOAK_SHEET_URL", allowedBookUrl);
const stateFile = optionalAbsolutePath("SOAK_STATE_FILE");
const headers = {
  Authorization: `Bearer ${token}`,
  Accept: "application/json, text/event-stream",
  "Content-Type": "application/json",
};

let sessionId;
let requestId = 0;
let stopping = false;
let stopSignal;
const startedAt = new Date();
const deadline = startedAt.getTime() + durationSeconds * 1_000;
const expectedCycles = Math.max(
  1,
  Math.ceil(durationSeconds / intervalSeconds),
);
const minimumRequiredCycles = Math.max(
  1,
  Math.floor((expectedCycles * minimumCycleRatioPercent) / 100),
);
let lastCycleStartedAt;
let maxObservedCycleGapMs = 0;
const counters = {
  cycles: 0,
  health_checks: 0,
  ready_checks: 0,
  metrics_checks: 0,
  mcp_initializations: 0,
  mcp_session_reinitializations: 0,
  tools_list_checks: 0,
  capability_checks: 0,
  auth_status_checks: 0,
  doc_reads: 0,
  sheet_reads: 0,
  failures: 0,
};

for (const signal of ["SIGINT", "SIGTERM"]) {
  process.on(signal, () => {
    stopping = true;
    stopSignal = signal;
  });
}

let failure;
try {
  while (!stopping && Date.now() < deadline) {
    const cycleStartedAt = Date.now();
    assertCycleContinuity(cycleStartedAt);
    await runCycle();
    counters.cycles += 1;
    await checkpoint("running");
    const remaining = deadline - Date.now();
    if (remaining <= 0) break;
    const delay = Math.min(
      Math.max(0, intervalSeconds * 1_000 - (Date.now() - cycleStartedAt)),
      remaining,
    );
    await interruptibleDelay(delay);
  }
  if (!stopping && Date.now() >= deadline) validateCompletedRun();
} catch (error) {
  counters.failures += 1;
  failure = error instanceof Error ? error.message : String(error);
}

const completed = !failure && !stopSignal && Date.now() >= deadline;
const status = failure ? "failed" : completed ? "completed" : "interrupted";
await checkpoint(status, failure);
process.stdout.write(`${JSON.stringify(report(status, failure))}\n`);
if (failure) process.exitCode = 1;
else if (!completed) process.exitCode = 130;

async function runCycle() {
  await expectHttp("/healthz", false);
  counters.health_checks += 1;
  await expectHttp("/readyz", false);
  counters.ready_checks += 1;
  await expectHttp("/metrics", true);
  counters.metrics_checks += 1;

  await ensureSession();
  const tools = await mcpRequest("tools/list", {});
  const toolCount = tools?.result?.tools?.length;
  if (toolCount !== expectedToolCount) {
    throw new Error(
      `expected ${String(expectedToolCount)} tools, received ${String(toolCount)}`,
    );
  }
  counters.tools_list_checks += 1;

  const capability = await callTool("yuque_get_capabilities", {});
  if (capability?.server_version !== expectedServerVersion) {
    throw new Error(
      `expected server ${expectedServerVersion}, received ${String(capability?.server_version)}`,
    );
  }
  counters.capability_checks += 1;

  await callTool("yuque_auth_status", {});
  counters.auth_status_checks += 1;
  if (docUrl) {
    await callTool("yuque_get_doc", { doc_url: docUrl, max_chars: 1 });
    counters.doc_reads += 1;
  }
  if (sheetUrl) {
    await callTool("yuque_get_sheet", {
      doc_url: sheetUrl,
      range: "A1:A1",
      include_formulas: true,
      include_styles: true,
    });
    counters.sheet_reads += 1;
  }
}

async function expectHttp(path, authenticated) {
  const response = await timedFetch(new URL(path, `${serverBaseUrl}/`), {
    headers: authenticated ? { Authorization: `Bearer ${token}` } : {},
  });
  if (!response.ok) {
    await response.body?.cancel();
    throw new Error(`${path} failed: ${String(response.status)}`);
  }
  await response.body?.cancel();
}

async function ensureSession(reinitialized = false) {
  if (sessionId) return;
  const response = await timedFetch(mcpUrl, {
    method: "POST",
    headers,
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: nextRequestId(),
      method: "initialize",
      params: {
        protocolVersion: "2025-03-26",
        capabilities: {},
        clientInfo: { name: "yuque-web-mcp-soak", version: packageVersion },
      },
    }),
  });
  if (!response.ok) {
    await response.body?.cancel();
    throw new Error(`initialize failed: ${String(response.status)}`);
  }
  const nextSession = response.headers.get("mcp-session-id");
  if (!nextSession) throw new Error("initialize did not return Mcp-Session-Id");
  const payload = await mcpPayload(response);
  if (payload?.error)
    throw new Error(`initialize failed: ${payload.error.code}`);
  sessionId = nextSession;
  counters.mcp_initializations += 1;
  if (reinitialized) counters.mcp_session_reinitializations += 1;
}

async function mcpRequest(method, params, allowSessionRefresh = true) {
  await ensureSession();
  const response = await timedFetch(mcpUrl, {
    method: "POST",
    headers: { ...headers, "Mcp-Session-Id": sessionId },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: nextRequestId(),
      method,
      params,
    }),
  });
  if (
    allowSessionRefresh &&
    [400, 404].includes(response.status) &&
    (await response.clone().text()).toLowerCase().includes("session")
  ) {
    await response.body?.cancel();
    sessionId = undefined;
    await ensureSession(true);
    return mcpRequest(method, params, false);
  }
  if (!response.ok) {
    await response.body?.cancel();
    throw new Error(`${method} failed: ${String(response.status)}`);
  }
  const payload = await mcpPayload(response);
  if (payload?.error) {
    throw new Error(`${method} failed: ${String(payload.error.code)}`);
  }
  return payload;
}

async function callTool(name, args) {
  const payload = await mcpRequest("tools/call", {
    name,
    arguments: args,
  });
  if (payload?.result?.isError)
    throw new Error(`${name} returned a tool error`);
  const text = payload?.result?.content?.find(
    (item) => item?.type === "text",
  )?.text;
  if (typeof text !== "string") {
    throw new Error(`${name} did not return JSON text content`);
  }
  return JSON.parse(text);
}

async function mcpPayload(response) {
  const text = await response.text();
  const dataLine = text
    .split("\n")
    .find((line) => line.startsWith("data:"))
    ?.slice(5)
    .trim();
  return JSON.parse(dataLine || text);
}

async function timedFetch(url, options) {
  return fetch(url, {
    ...options,
    signal: AbortSignal.timeout(requestTimeoutMs),
  });
}

async function checkpoint(status, error) {
  if (!stateFile) return;
  await mkdir(dirname(stateFile), { recursive: true, mode: 0o700 });
  const temporary = `${stateFile}.tmp-${String(process.pid)}`;
  await writeFile(
    temporary,
    `${JSON.stringify(report(status, error), null, 2)}\n`,
    { mode: 0o600 },
  );
  await rename(temporary, stateFile);
}

function report(status, error) {
  return {
    status,
    version: packageVersion,
    started_at: startedAt.toISOString(),
    updated_at: new Date().toISOString(),
    required_duration_seconds: durationSeconds,
    elapsed_seconds: Math.floor((Date.now() - startedAt.getTime()) / 1_000),
    ...(stopSignal ? { signal: stopSignal } : {}),
    ...(error ? { error } : {}),
    targets: {
      document_enabled: Boolean(docUrl),
      sheet_enabled: Boolean(sheetUrl),
    },
    counters: { ...counters },
    continuity: {
      interval_seconds: intervalSeconds,
      max_allowed_cycle_gap_seconds: maxCycleGapSeconds,
      max_observed_cycle_gap_seconds: Math.ceil(maxObservedCycleGapMs / 1_000),
      expected_cycles: expectedCycles,
      minimum_cycle_ratio_percent: minimumCycleRatioPercent,
      minimum_required_cycles: minimumRequiredCycles,
    },
    secret_material_persisted: false,
    content_persisted: false,
  };
}

function optionalExactBookUrl(value) {
  if (!value) return undefined;
  const url = new URL(value);
  const parts = url.pathname.split("/").filter(Boolean);
  if (
    url.protocol !== "https:" ||
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    parts.length !== 2
  ) {
    throw new Error(
      "SOAK_ALLOWED_BOOK_URL must be one exact HTTPS knowledge-base URL",
    );
  }
  return `${url.origin}/${parts.join("/")}`;
}

function optionalTargetUrl(name, bookUrl) {
  const value = process.env[name];
  if (!value) return undefined;
  if (!bookUrl) {
    throw new Error(`${name} requires SOAK_ALLOWED_BOOK_URL`);
  }
  const target = new URL(value);
  const book = new URL(bookUrl);
  const targetParts = target.pathname.split("/").filter(Boolean);
  const bookParts = book.pathname.split("/").filter(Boolean);
  if (
    target.protocol !== "https:" ||
    target.origin !== book.origin ||
    target.username ||
    target.password ||
    target.search ||
    target.hash ||
    targetParts.length !== 3 ||
    targetParts[0] !== bookParts[0] ||
    targetParts[1] !== bookParts[1]
  ) {
    throw new Error(`${name} must identify a direct child of the allowed book`);
  }
  return `${target.origin}/${targetParts.join("/")}`;
}

function optionalAbsolutePath(name) {
  const value = process.env[name]?.trim();
  if (!value) return undefined;
  if (!isAbsolute(value)) throw new Error(`${name} must be an absolute path`);
  return value;
}

function positiveInteger(name, fallback) {
  const value = process.env[name];
  if (!value) return fallback;
  const parsed = Number.parseInt(value, 10);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) {
    throw new Error(`${name} must be a positive integer`);
  }
  return parsed;
}

function percentageInteger(name, fallback) {
  const parsed = positiveInteger(name, fallback);
  if (parsed > 100) throw new Error(`${name} must be between 1 and 100`);
  return parsed;
}

function assertCycleContinuity(cycleStartedAt) {
  if (lastCycleStartedAt !== undefined) {
    const gap = cycleStartedAt - lastCycleStartedAt;
    maxObservedCycleGapMs = Math.max(maxObservedCycleGapMs, gap);
    if (gap > maxCycleGapSeconds * 1_000) {
      throw new Error(
        `cycle gap ${String(Math.ceil(gap / 1_000))}s exceeded ${String(maxCycleGapSeconds)}s`,
      );
    }
  }
  lastCycleStartedAt = cycleStartedAt;
}

function validateCompletedRun() {
  if (lastCycleStartedAt === undefined) {
    throw new Error("soak completed without a successful cycle");
  }
  const terminalGap = Date.now() - lastCycleStartedAt;
  maxObservedCycleGapMs = Math.max(maxObservedCycleGapMs, terminalGap);
  if (terminalGap > maxCycleGapSeconds * 1_000) {
    throw new Error(
      `terminal cycle gap ${String(Math.ceil(terminalGap / 1_000))}s exceeded ${String(maxCycleGapSeconds)}s`,
    );
  }
  if (counters.cycles < minimumRequiredCycles) {
    throw new Error(
      `completed only ${String(counters.cycles)} cycles; at least ${String(minimumRequiredCycles)} required`,
    );
  }
}

function nextRequestId() {
  requestId += 1;
  return requestId;
}

function deriveServerBaseUrl(value) {
  const url = new URL(value);
  url.pathname = url.pathname.replace(/\/mcp\/?$/, "/");
  url.search = "";
  url.hash = "";
  return url.toString().replace(/\/$/, "");
}

function parseEnvironment(serialized) {
  const values = {};
  for (const line of serialized.split(/\r?\n/)) {
    if (!line || line.trimStart().startsWith("#")) continue;
    const separator = line.indexOf("=");
    if (separator < 1) continue;
    values[line.slice(0, separator)] = line.slice(separator + 1);
  }
  return values;
}

function interruptibleDelay(milliseconds) {
  return new Promise((resolve) => {
    if (stopping || milliseconds <= 0) return resolve();
    const finish = () => {
      clearTimeout(timer);
      clearInterval(poll);
      resolve();
    };
    const timer = setTimeout(finish, milliseconds);
    const poll = setInterval(
      () => {
        if (!stopping) return;
        finish();
      },
      Math.min(250, milliseconds),
    );
  });
}
