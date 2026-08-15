import { ContractError } from "./contracts.js";
import { ReloginRequiredError, YuqueHttpError } from "./yuque-client.js";

export interface SafeToolError {
  ok: false;
  error: {
    code: string;
    message: string;
    request_id: string;
    retriable: boolean;
    relogin_required: boolean;
    retry_after_seconds?: number;
  };
}

export function toSafeToolError(
  error: unknown,
  requestId: string,
): SafeToolError {
  const message = safeMessage(error);
  if (error instanceof ReloginRequiredError) {
    return failure("relogin_required", message, requestId, false, true);
  }
  if (error instanceof ContractError) {
    return failure("contract_incompatible", message, requestId, false, false);
  }
  if (error instanceof YuqueHttpError) {
    const code =
      error.status === 403
        ? "permission_denied"
        : error.status === 404
          ? "not_found"
          : error.status === 409
            ? "conflict"
            : error.status === 422
              ? "upstream_validation_failed"
              : error.status === 429
                ? "rate_limited"
                : "upstream_error";
    return {
      ...failure(
        code,
        message,
        requestId,
        error.status === 429 || error.status >= 500,
        false,
      ),
      ...(error.retryAfterSeconds === undefined
        ? {}
        : {
            error: {
              ...failure(
                code,
                message,
                requestId,
                error.status === 429 || error.status >= 500,
                false,
              ).error,
              retry_after_seconds: error.retryAfterSeconds,
            },
          }),
    };
  }
  const lower = message.toLowerCase();
  if (lower.includes("result is unknown") || lower.includes("do not retry")) {
    return failure("write_result_unknown", message, requestId, false, false);
  }
  if (
    lower.includes("conflict") ||
    lower.includes("changed after preview") ||
    lower.includes("repreview")
  ) {
    return failure("conflict", message, requestId, false, false);
  }
  if (lower.includes("strict write consistency mode")) {
    return failure("strict_mode_blocked", message, requestId, false, false);
  }
  if (lower.includes("required") || lower.includes("must be")) {
    return failure("invalid_argument", message, requestId, false, false);
  }
  return failure("operation_failed", message, requestId, false, false);
}

function failure(
  code: string,
  message: string,
  requestId: string,
  retriable: boolean,
  reloginRequired: boolean,
): SafeToolError {
  return {
    ok: false,
    error: {
      code,
      message,
      request_id: requestId,
      retriable,
      relogin_required: reloginRequired,
    },
  };
}

function safeMessage(error: unknown): string {
  if (!(error instanceof Error)) return "Operation failed";
  return error.message
    .replace(/(Bearer|Cookie|csrf|token)\s*[:=]\s*\S+/gi, "$1=[redacted]")
    .slice(0, 500);
}
