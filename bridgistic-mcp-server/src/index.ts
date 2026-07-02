#!/usr/bin/env node
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import express from "express";
import type { Request } from "express";
import { timingSafeEqual } from "node:crypto";
import { ConnectionRegistry } from "./services/connections.js";
import { registerTools } from "./tools/register.js";
import { SERVER_NAME, SERVER_VERSION } from "./constants.js";

function buildServer(): McpServer {
  const server = new McpServer({ name: SERVER_NAME, version: SERVER_VERSION });
  const registry = new ConnectionRegistry();
  registerTools(server, registry);
  return server;
}

async function runStdio(): Promise<void> {
  const server = buildServer();
  const transport = new StdioServerTransport();
  await server.connect(transport);
  // stdio servers must log only to stderr.
  console.error(`${SERVER_NAME} v${SERVER_VERSION} running on stdio`);
}

/** Constant-time check of an `Authorization: Bearer <token>` header. */
function bearerMatches(header: string | undefined, token: string): boolean {
  if (!header) return false;
  const m = /^Bearer\s+(.+)$/.exec(header);
  if (!m) return false;
  const given = Buffer.from(m[1]);
  const want = Buffer.from(token);
  return given.length === want.length && timingSafeEqual(given, want);
}

function isLoopback(req: Request): boolean {
  const ip = req.socket.remoteAddress ?? "";
  return ip === "127.0.0.1" || ip === "::1" || ip === "::ffff:127.0.0.1";
}

async function runHttp(): Promise<void> {
  const app = express();
  app.use(express.json({ limit: "5mb" }));

  // The registry holds every connected site's signing secret, so an open /mcp
  // endpoint = full control of all of them. Require a bearer token; without one,
  // only accept loopback requests and bind to localhost.
  const httpToken = process.env.BRIDGISTIC_HTTP_TOKEN || "";
  const host = process.env.HOST || (httpToken ? "0.0.0.0" : "127.0.0.1");

  app.get("/health", (_req, res) => {
    res.json({ ok: true, server: SERVER_NAME, version: SERVER_VERSION });
  });

  // Stateless: a fresh server + transport per request avoids ID collisions
  // and scales horizontally behind a load balancer.
  app.post("/mcp", async (req, res) => {
    if (httpToken) {
      if (!bearerMatches(req.headers.authorization, httpToken)) {
        res.status(401).json({ error: "unauthorized" });
        return;
      }
    } else if (!isLoopback(req)) {
      res.status(401).json({
        error:
          "Refusing a non-local request: set BRIDGISTIC_HTTP_TOKEN and send it as 'Authorization: Bearer <token>' to expose /mcp beyond localhost.",
      });
      return;
    }
    const server = buildServer();
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: undefined,
      enableJsonResponse: true,
    });
    res.on("close", () => {
      transport.close();
      server.close();
    });
    await server.connect(transport);
    await transport.handleRequest(req, res, req.body);
  });

  const port = parseInt(process.env.PORT || "3000", 10);
  app.listen(port, host, () => {
    console.error(`${SERVER_NAME} v${SERVER_VERSION} on http://${host}:${port}/mcp`);
    if (!httpToken) {
      console.error(
        "[bridgistic] No BRIDGISTIC_HTTP_TOKEN set — /mcp accepts loopback requests only. Set it to serve Cowork/remote clients."
      );
    }
  });
}

const transport = process.env.TRANSPORT || "stdio";
(transport === "http" ? runHttp() : runStdio()).catch((err) => {
  console.error("Fatal:", err);
  process.exit(1);
});
