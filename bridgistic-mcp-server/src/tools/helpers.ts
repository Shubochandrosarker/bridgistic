import { z } from "zod";
import { ConnectionRegistry } from "../services/connections.js";
import { BridgeRequestError } from "../services/wp-client.js";
import { CHARACTER_LIMIT } from "../constants.js";

export type ToolResult = {
  content: Array<{ type: "text"; text: string }>;
  structuredContent?: Record<string, unknown>;
  isError?: boolean;
};

/** Optional site selector shared by every site-targeting tool. */
export const siteParam = z
  .string()
  .optional()
  .describe(
    'Site alias to target (e.g. "guns2ammo"). Omit when only one site is configured.'
  );

/** Preview-only switch for any write tool. */
export const dryRunParam = z
  .boolean()
  .optional()
  .describe(
    "If true, return what WOULD change without modifying anything. Nothing is persisted, snapshotted, or queued."
  );

/** Re-submit token after a human approves a queued op. */
export const approvalIdParam = z
  .string()
  .optional()
  .describe(
    "Approval id returned by a previous call that needed approval. Re-pass the SAME args plus this id once an admin approves."
  );

/** Bypass the snapshot-required abort (irreversible). */
export const forceParam = z
  .boolean()
  .optional()
  .describe(
    "Proceed even if a pre-op snapshot could not be taken. Irreversible — use sparingly."
  );

/** Standard guard-param bundle to spread into a write tool's inputSchema. */
export const guardParams = {
  dry_run: dryRunParam,
  approval_id: approvalIdParam,
  force: forceParam,
};

/** Forward guard params into the request body if present. */
export function withGuard(
  body: Record<string, unknown>,
  args: { dry_run?: boolean; approval_id?: string; force?: boolean }
): Record<string, unknown> {
  if (args.dry_run !== undefined) body.dry_run = args.dry_run;
  if (args.approval_id !== undefined) body.approval_id = args.approval_id;
  if (args.force !== undefined) body.force = args.force;
  return body;
}

export async function run(fn: () => Promise<ToolResult>): Promise<ToolResult> {
  try {
    return await fn();
  } catch (err) {
    const message =
      err instanceof BridgeRequestError
        ? `Error (${err.code}): ${err.message}`
        : `Error: ${err instanceof Error ? err.message : String(err)}`;
    return { content: [{ type: "text", text: message }], isError: true };
  }
}

export function present(data: unknown): ToolResult {
  let text = JSON.stringify(data, null, 2);
  if (text.length > CHARACTER_LIMIT) {
    text =
      text.slice(0, CHARACTER_LIMIT) +
      `\n... [truncated at ${CHARACTER_LIMIT} chars — narrow your query]`;
  }
  return {
    content: [{ type: "text", text }],
    structuredContent: data as Record<string, unknown>,
  };
}

export type Registry = ConnectionRegistry;
