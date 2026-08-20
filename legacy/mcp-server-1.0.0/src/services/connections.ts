import { readFileSync, existsSync } from "node:fs";
import type { Connection } from "../types.js";

/**
 * Resolves which WordPress site a tool call targets.
 *
 * Two modes, both supported simultaneously:
 *   1. Single-site (local dev): env WP_SITE_URL / BRIDGISTIC_KEY_ID / BRIDGISTIC_KEY_SECRET.
 *      Available under alias "default".
 *   2. Multi-tenant (agency): a JSON registry file (BRIDGISTIC_CONNECTIONS path)
 *      mapping aliases -> { siteUrl, keyId, secret }. The agent passes `site`.
 *
 * This is the core differentiator vs Novamira: one server, many sites.
 */
export class ConnectionRegistry {
  private connections = new Map<string, Connection>();

  constructor() {
    this.loadFromEnv();
    this.loadFromFile();
  }

  private loadFromEnv(): void {
    const siteUrl = process.env.WP_SITE_URL;
    const keyId = process.env.BRIDGISTIC_KEY_ID;
    const secret = process.env.BRIDGISTIC_KEY_SECRET;
    if (siteUrl && keyId && secret) {
      this.connections.set("default", {
        alias: "default",
        siteUrl: siteUrl.replace(/\/+$/, ""),
        keyId,
        secret,
      });
    }
  }

  private loadFromFile(): void {
    const path = process.env.BRIDGISTIC_CONNECTIONS;
    if (!path || !existsSync(path)) return;

    try {
      const raw = JSON.parse(readFileSync(path, "utf8")) as Record<
        string,
        { siteUrl: string; keyId: string; secret: string }
      >;
      for (const [alias, conf] of Object.entries(raw)) {
        if (conf?.siteUrl && conf?.keyId && conf?.secret) {
          this.connections.set(alias, {
            alias,
            siteUrl: conf.siteUrl.replace(/\/+$/, ""),
            keyId: conf.keyId,
            secret: conf.secret,
          });
        }
      }
    } catch (err) {
      // Logged to stderr only; never break the server over a bad registry.
      console.error(`[bridgistic] Failed to parse connections file: ${String(err)}`);
    }
  }

  /** List aliases the agent can target (no secrets). */
  list(): Array<{ alias: string; siteUrl: string }> {
    return [...this.connections.values()].map((c) => ({
      alias: c.alias,
      siteUrl: c.siteUrl,
    }));
  }

  /**
   * Resolve a connection. If `alias` omitted, uses "default" when it's the
   * only connection, otherwise throws so the agent must disambiguate.
   */
  resolve(alias?: string): Connection {
    if (alias) {
      const conn = this.connections.get(alias);
      if (!conn) {
        throw new Error(
          `Unknown site alias "${alias}". Available: ${this.list()
            .map((c) => c.alias)
            .join(", ") || "(none configured)"}`
        );
      }
      return conn;
    }

    if (this.connections.size === 1) {
      return [...this.connections.values()][0];
    }
    if (this.connections.size === 0) {
      throw new Error(
        "No WordPress connections configured. Set WP_SITE_URL / BRIDGISTIC_KEY_ID / BRIDGISTIC_KEY_SECRET, or provide a BRIDGISTIC_CONNECTIONS registry file."
      );
    }
    throw new Error(
      `Multiple sites configured; specify "site". Available: ${this.list()
        .map((c) => c.alias)
        .join(", ")}`
    );
  }
}
