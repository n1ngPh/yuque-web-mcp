import { createHash } from "node:crypto";
import type { UserCredentials } from "./types.js";

export interface AuthenticatedOwner {
  ownerId: string;
}

export class AuthService {
  private readonly ownerByDigest = new Map<string, string>();
  private readonly ownerByAgentId = new Map<string, string>();

  constructor(users: UserCredentials[]);
  constructor(ownerId: string, bearerToken: string);
  constructor(
    usersOrOwnerId: UserCredentials[] | string,
    bearerToken?: string,
  ) {
    const users: UserCredentials[] = Array.isArray(usersOrOwnerId)
      ? usersOrOwnerId
      : [{ ownerId: usersOrOwnerId, bearerToken: bearerToken ?? "" }];
    if (users.length === 0) {
      throw new Error("At least one user is required");
    }
    for (const user of users) {
      if (Buffer.byteLength(user.bearerToken, "utf8") < 32) {
        throw new Error("MCP Bearer Token must contain at least 32 bytes");
      }
      const digest = tokenDigest(user.bearerToken);
      if (this.ownerByDigest.has(digest)) {
        throw new Error("Duplicate bearer token");
      }
      this.ownerByDigest.set(digest, user.ownerId);
      if (user.agentId) {
        const normalized = normalizeAgentId(user.agentId);
        if (this.ownerByAgentId.has(normalized)) {
          throw new Error("Duplicate agent_id");
        }
        this.ownerByAgentId.set(normalized, user.ownerId);
      }
    }
  }

  authenticate(token: string): AuthenticatedOwner | undefined {
    const ownerId = this.ownerByDigest.get(tokenDigest(token));
    return ownerId ? { ownerId } : undefined;
  }

  authenticateByAgentId(agentId: string): AuthenticatedOwner | undefined {
    const ownerId = this.ownerByAgentId.get(normalizeAgentId(agentId));
    return ownerId ? { ownerId } : undefined;
  }
}

function tokenDigest(token: string): string {
  return createHash("sha256").update(token, "utf8").digest("hex");
}

function normalizeAgentId(agentId: string): string {
  return agentId.trim();
}
