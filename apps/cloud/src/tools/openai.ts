import { contractFor } from "@bridgistic/contracts";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

type ToolConfig = Record<string, unknown>;

/**
 * OpenAI reads per-tool OAuth metadata from MCP tool `_meta`. Keep this
 * derived from the shared contract catalogue so the advertised scope cannot
 * drift from the WordPress scope enforced by the bridge.
 */
export function withOpenAiToolSecurity(server: McpServer): McpServer {
  const originalRegisterTool = server.registerTool.bind(server) as (
    name: string,
    config: ToolConfig,
    handler: unknown
  ) => unknown;

  return new Proxy(server, {
    get(target, property, receiver) {
      if (property !== "registerTool") return Reflect.get(target, property, receiver);

      return (name: string, config: ToolConfig, handler: unknown) => {
        const contract = contractFor(name);
        if (!contract) {
          throw new Error(`Cannot expose unknown Bridgistic tool in the MCP contract: ${name}`);
        }

        const existingMeta = config._meta;
        const meta =
          existingMeta && typeof existingMeta === "object"
            ? (existingMeta as Record<string, unknown>)
            : {};

        return originalRegisterTool(
          name,
          {
            ...config,
            _meta: {
              ...meta,
              securitySchemes: [
                {
                  type: "oauth2",
                  scopes: [...contract.requiredScopes],
                },
              ],
            },
          },
          handler
        );
      };
    },
  });
}
