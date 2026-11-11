import { McpAgent } from "agents/mcp";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { registerTools } from "./tools/register.js";
import { resolveTenantRegistry, type TenantSessionEnv } from "./tenant-session.js";
import { SERVER_NAME, SERVER_VERSION } from "./constants.js";

export type Env = TenantSessionEnv;

/** Props threaded through from the OAuth access token (see default-handler.ts). */
type Props = { tenantId: string };

/**
 * One Durable Object instance per MCP session. `props.tenantId` comes from
 * the OAuth access token that OAuthProvider already validated before this
 * agent is ever invoked - by the time init() runs, the caller is proven to
 * hold a token scoped to exactly this tenant, nothing else to check here.
 * The "which tenant, which errors" logic lives in tenant-session.ts (see
 * its docblock for why: this file imports `agents/mcp`, which isn't
 * importable outside the Workers runtime, so it can't be unit-tested
 * directly - tenant-session.ts's resolveTenantRegistry() can be).
 */
export class BridgisticMcpAgent extends McpAgent<Env, unknown, Props> {
  server = new McpServer({ name: SERVER_NAME, version: SERVER_VERSION });

  async init(): Promise<void> {
    const registry = await resolveTenantRegistry(this.env, this.props?.tenantId);
    registerTools(this.server, registry);
  }
}
