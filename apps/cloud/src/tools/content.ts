import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { SiteRegistry } from "../types.js";
import { callBridge } from "../services/wp-client.js";
import { siteParam, guardParams, withGuard, run, present } from "./helpers.js";

const WRITE = {
  readOnlyHint: false,
  destructiveHint: true,
  idempotentHint: false,
  openWorldHint: true,
} as const;

const READ = {
  readOnlyHint: true,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: true,
} as const;

export function registerContentTools(server: McpServer, registry: SiteRegistry): void {
  // ---- posts.list ---------------------------------------------------------
  server.registerTool(
    "bridgistic_list_posts",
    {
      title: "List posts / pages / CPTs",
      description:
        "List content with pagination. Scope: `posts:read`. Args: post_type (default 'post'), status (default 'any'), search, per_page (≤100), page. Returns id/title/type/status/slug/link + total + has_more.",
      inputSchema: {
        site: siteParam,
        post_type: z.string().optional(),
        status: z.string().optional(),
        search: z.string().optional(),
        per_page: z.number().int().min(1).max(100).optional(),
        page: z.number().int().min(1).optional(),
      },
      annotations: READ,
    },
    async ({ site, ...q }) =>
      run(async () => {
        const conn = registry.resolve(site);
        const qs = new URLSearchParams();
        for (const [k, v] of Object.entries(q)) if (v !== undefined) qs.set(k, String(v));
        const route = "posts" + (qs.toString() ? `?${qs}` : "");
        return present(await callBridge(conn, "GET", route));
      })
  );

  // ---- posts.get ----------------------------------------------------------
  server.registerTool(
    "bridgistic_get_post",
    {
      title: "Get a single post",
      description:
        "Fetch one post/page/CPT by id with full content + meta. Scope: `posts:read`.",
      inputSchema: { site: siteParam, id: z.number().int().positive() },
      annotations: READ,
    },
    async ({ site, id }) =>
      run(async () => present(await callBridge(registry.resolve(site), "GET", `posts/${id}`)))
  );

  // ---- posts.create -------------------------------------------------------
  server.registerTool(
    "bridgistic_create_post",
    {
      title: "Create a post",
      description:
        "Create a post/page/CPT. Scope: `posts:write`. Args: title, content, excerpt, status (draft|publish|...), slug, type, author, parent, meta (object). Supports dry_run and approval flow.",
      inputSchema: {
        site: siteParam,
        title: z.string().optional(),
        content: z.string().optional(),
        excerpt: z.string().optional(),
        status: z.string().optional(),
        slug: z.string().optional(),
        type: z.string().optional(),
        author: z.number().int().optional(),
        parent: z.number().int().optional(),
        meta: z.record(z.string(), z.unknown()).optional(),
        ...guardParams,
      },
    annotations: { ...WRITE, destructiveHint: false },
    },
    async ({ site, dry_run, approval_id, force, ...fields }) =>
      run(async () => {
        const body = withGuard({ ...fields }, { dry_run, approval_id, force });
        return present(await callBridge(registry.resolve(site), "POST", "posts", body));
      })
  );

  // ---- posts.update -------------------------------------------------------
  server.registerTool(
    "bridgistic_update_post",
    {
      title: "Update a post",
      description:
        "Update an existing post by id. Scope: `posts:write`. Auto-snapshots the post first (rollback via snapshot_id). Same fields as create. Supports dry_run + approval.",
      inputSchema: {
        site: siteParam,
        id: z.number().int().positive(),
        title: z.string().optional(),
        content: z.string().optional(),
        excerpt: z.string().optional(),
        status: z.string().optional(),
        slug: z.string().optional(),
        meta: z.record(z.string(), z.unknown()).optional(),
        ...guardParams,
      },
      annotations: WRITE,
    },
    async ({ site, id, dry_run, approval_id, force, ...fields }) =>
      run(async () => {
        const body = withGuard({ ...fields }, { dry_run, approval_id, force });
        return present(await callBridge(registry.resolve(site), "POST", `posts/${id}`, body));
      })
  );

  // ---- posts.delete -------------------------------------------------------
  server.registerTool(
    "bridgistic_delete_post",
    {
      title: "Delete a post",
      description:
        "Trash (default) or permanently delete a post. Scope: `posts:write`. Auto-snapshots first. Set permanent=true to skip trash. Supports dry_run + approval.",
      inputSchema: {
        site: siteParam,
        id: z.number().int().positive(),
        permanent: z.boolean().optional(),
        ...guardParams,
      },
      annotations: WRITE,
    },
    async ({ site, id, permanent, dry_run, approval_id, force }) =>
      run(async () => {
        const body = withGuard({ permanent }, { dry_run, approval_id, force });
        return present(await callBridge(registry.resolve(site), "DELETE", `posts/${id}`, body));
      })
  );

  // ---- media.list ---------------------------------------------------------
  server.registerTool(
    "bridgistic_list_media",
    {
      title: "List media",
      description: "List attachments (id/title/mime/url). Scope: `posts:read`. Args: per_page, page.",
      inputSchema: {
        site: siteParam,
        per_page: z.number().int().min(1).max(100).optional(),
        page: z.number().int().min(1).optional(),
      },
      annotations: READ,
    },
    async ({ site, per_page, page }) =>
      run(async () => {
        const qs = new URLSearchParams();
        if (per_page) qs.set("per_page", String(per_page));
        if (page) qs.set("page", String(page));
        const route = "media" + (qs.toString() ? `?${qs}` : "");
        return present(await callBridge(registry.resolve(site), "GET", route));
      })
  );

  // ---- media.upload -------------------------------------------------------
  server.registerTool(
    "bridgistic_upload_media",
    {
      title: "Upload media",
      description:
        "Upload to the media library from a URL or base64. Scope: `media:write`. Provide either url, or filename + content_base64. Supports dry_run + approval.",
      inputSchema: {
        site: siteParam,
        url: z.string().url().optional(),
        filename: z.string().optional(),
        content_base64: z.string().optional(),
        ...guardParams,
      },
      annotations: { ...WRITE, destructiveHint: false },
    },
    async ({ site, url, filename, content_base64, dry_run, approval_id, force }) =>
      run(async () => {
        const body = withGuard({ url, filename, content_base64 }, { dry_run, approval_id, force });
        return present(await callBridge(registry.resolve(site), "POST", "media", body));
      })
  );

  // ---- media.delete -------------------------------------------------------
  server.registerTool(
    "bridgistic_delete_media",
    {
      title: "Delete media",
      description: "Permanently delete an attachment by id. Scope: `media:write`. Auto-snapshots first.",
      inputSchema: { site: siteParam, id: z.number().int().positive(), ...guardParams },
      annotations: WRITE,
    },
    async ({ site, id, dry_run, approval_id, force }) =>
      run(async () => {
        const body = withGuard({}, { dry_run, approval_id, force });
        return present(await callBridge(registry.resolve(site), "DELETE", `media/${id}`, body));
      })
  );

  // ---- users.list ---------------------------------------------------------
  server.registerTool(
    "bridgistic_list_users",
    {
      title: "List users",
      description:
        "List users (id/login/email/display_name/roles). Scope: `users:read`. Never returns passwords. Args: search, per_page, page.",
      inputSchema: {
        site: siteParam,
        search: z.string().optional(),
        per_page: z.number().int().min(1).max(100).optional(),
        page: z.number().int().min(1).optional(),
      },
      annotations: READ,
    },
    async ({ site, ...q }) =>
      run(async () => {
        const qs = new URLSearchParams();
        for (const [k, v] of Object.entries(q)) if (v !== undefined) qs.set(k, String(v));
        const route = "users" + (qs.toString() ? `?${qs}` : "");
        return present(await callBridge(registry.resolve(site), "GET", route));
      })
  );

  // ---- users.create -------------------------------------------------------
  server.registerTool(
    "bridgistic_create_user",
    {
      title: "Create a user",
      description:
        "Create a user. Scope: `users:write`. Args: login, email (both required), role (default subscriber), display_name, password (auto-generated if omitted). Supports dry_run + approval.",
      inputSchema: {
        site: siteParam,
        login: z.string(),
        email: z.string().email(),
        role: z.string().optional(),
        display_name: z.string().optional(),
        password: z.string().optional(),
        ...guardParams,
      },
      annotations: { ...WRITE, destructiveHint: false },
    },
    async ({ site, dry_run, approval_id, force, ...fields }) =>
      run(async () => {
        const body = withGuard({ ...fields }, { dry_run, approval_id, force });
        return present(await callBridge(registry.resolve(site), "POST", "users", body));
      })
  );

  // ---- users.update -------------------------------------------------------
  server.registerTool(
    "bridgistic_update_user",
    {
      title: "Update a user",
      description:
        "Update a user by id (email, display_name, role). Scope: `users:write`. Auto-snapshots the user first. Supports dry_run + approval.",
      inputSchema: {
        site: siteParam,
        id: z.number().int().positive(),
        email: z.string().email().optional(),
        display_name: z.string().optional(),
        role: z.string().optional(),
        ...guardParams,
      },
      annotations: WRITE,
    },
    async ({ site, id, dry_run, approval_id, force, ...fields }) =>
      run(async () => {
        const body = withGuard({ ...fields }, { dry_run, approval_id, force });
        return present(await callBridge(registry.resolve(site), "POST", `users/${id}`, body));
      })
  );
}
