import { createHash } from "node:crypto";
import { safeBufferEqual } from "./crypto.js";

export interface AuthenticatedOwner {
  ownerId: string;
}

export class AuthService {
  private readonly expectedDigest: Buffer;

  constructor(
    private readonly ownerId: string,
    bearerToken: string,
  ) {
    if (Buffer.byteLength(bearerToken, "utf8") < 32) {
      throw new Error("MCP Bearer Token must contain at least 32 bytes");
    }
    this.expectedDigest = tokenDigest(bearerToken);
  }

  authenticate(token: string): AuthenticatedOwner | undefined {
    const candidate = tokenDigest(token);
    return safeBufferEqual(candidate, this.expectedDigest)
      ? { ownerId: this.ownerId }
      : undefined;
  }
}

function tokenDigest(token: string): Buffer {
  return createHash("sha256").update(token, "utf8").digest();
}
