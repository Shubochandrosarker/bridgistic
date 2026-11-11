import type { Connection, SiteRegistry } from "./types.js";

/**
 * The cloud analogue of mcp-server's file/env-backed ConnectionRegistry.
 * Every OAuth grant here is scoped to exactly one WordPress site (unlike
 * the local server's multi-site alias registry) - simpler by construction,
 * since "which site" was already decided at connect time, not per call.
 */
export class TenantRegistry implements SiteRegistry {
  constructor(private readonly connection: Connection) {}

  list(): Array<{ alias: string; siteUrl: string }> {
    return [{ alias: this.connection.alias, siteUrl: this.connection.siteUrl }];
  }

  resolve(_alias?: string): Connection {
    return this.connection;
  }
}
