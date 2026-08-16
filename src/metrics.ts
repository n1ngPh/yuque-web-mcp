export class ServiceMetrics {
  readonly startedAt = Date.now();
  requestsTotal = 0;
  requestErrorsTotal = 0;
  authenticationFailuresTotal = 0;
  rateLimitedTotal = 0;
  activeRequests = 0;

  render(input: {
    activeSessions: number;
    activeLogins: number;
    activeWrites: number;
    ready: boolean;
  }): string {
    const lines = [
      "# HELP yuque_web_mcp_up Whether the process is running.",
      "# TYPE yuque_web_mcp_up gauge",
      "yuque_web_mcp_up 1",
      "# HELP yuque_web_mcp_ready Whether the service accepts new MCP work.",
      "# TYPE yuque_web_mcp_ready gauge",
      `yuque_web_mcp_ready ${input.ready ? "1" : "0"}`,
      "# TYPE yuque_web_mcp_requests_total counter",
      `yuque_web_mcp_requests_total ${String(this.requestsTotal)}`,
      "# TYPE yuque_web_mcp_request_errors_total counter",
      `yuque_web_mcp_request_errors_total ${String(this.requestErrorsTotal)}`,
      "# TYPE yuque_web_mcp_authentication_failures_total counter",
      `yuque_web_mcp_authentication_failures_total ${String(this.authenticationFailuresTotal)}`,
      "# TYPE yuque_web_mcp_rate_limited_total counter",
      `yuque_web_mcp_rate_limited_total ${String(this.rateLimitedTotal)}`,
      "# TYPE yuque_web_mcp_active_requests gauge",
      `yuque_web_mcp_active_requests ${String(this.activeRequests)}`,
      "# TYPE yuque_web_mcp_active_sessions gauge",
      `yuque_web_mcp_active_sessions ${String(input.activeSessions)}`,
      "# TYPE yuque_web_mcp_active_logins gauge",
      `yuque_web_mcp_active_logins ${String(input.activeLogins)}`,
      "# TYPE yuque_web_mcp_active_writes gauge",
      `yuque_web_mcp_active_writes ${String(input.activeWrites)}`,
      "# TYPE yuque_web_mcp_uptime_seconds gauge",
      `yuque_web_mcp_uptime_seconds ${String(Math.floor((Date.now() - this.startedAt) / 1000))}`,
      "",
    ];
    return lines.join("\n");
  }
}
