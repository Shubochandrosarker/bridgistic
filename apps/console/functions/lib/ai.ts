/**
 * One AI chat client for the console.
 *
 * The website-agent generator (`/api/ai/generate`) already talked to OpenRouter
 * with a key stored in `settings.ai` (or `OPENROUTER_KEY`). The agent registry
 * needs the same thing, so the call moved here instead of being copied.
 *
 * Providers, in order:
 *   1. `AI_GATEWAY_URL` + `AI_GATEWAY_TOKEN` — an OpenAI-compatible
 *      chat-completions gateway. This is the deployment-level path, preferred
 *      because it is one credential for every console feature.
 *   2. The existing OpenRouter key from admin settings, then `OPENROUTER_KEY`.
 *
 * With neither configured, `chat()` returns `ai_not_configured` (HTTP 503) so a
 * caller can say exactly that. It never returns an empty success.
 */

import { getSetting } from "./auth.ts";

type Fetch = typeof fetch;

export interface AiEnv {
  DB: D1Database;
  AI_GATEWAY_URL?: string;
  AI_GATEWAY_TOKEN?: string;
  AI_GATEWAY_MODEL?: string;
  OPENROUTER_KEY?: string;
}

export interface ChatMessage {
  role: "system" | "user";
  content: string;
}

export type AiResult =
  | { ok: true; text: string; model: string; provider: "gateway" | "openrouter" }
  | { ok: false; status: number; error: string; message: string };

export interface AiProvider {
  kind: "gateway" | "openrouter";
  url: string;
  token: string;
  model: string;
}

/**
 * Gateways are configured either as the base URL (append the OpenAI path) or as
 * the full completions URL. Both are accepted because both are what people
 * paste; anything else would fail at the first run instead of at boot.
 */
export function completionsUrl(base: string): string {
  const trimmed = base.trim().replace(/\/+$/, "");
  return /\/chat\/completions$/.test(trimmed) ? trimmed : `${trimmed}/chat/completions`;
}

export async function resolveProvider(env: AiEnv): Promise<AiProvider | { error: string; message: string }> {
  const settings = (await getSetting(env.DB, "ai")) as { openrouter_key?: string; openai_model?: string } | null;
  const gatewayUrl = (env.AI_GATEWAY_URL ?? "").trim();
  if (gatewayUrl) {
    const token = (env.AI_GATEWAY_TOKEN ?? "").trim();
    if (!token) {
      return {
        error: "ai_not_configured",
        message:
          "AI_GATEWAY_URL is set but AI_GATEWAY_TOKEN is missing. Add the gateway token, or unset the URL to fall back to the OpenRouter key.",
      };
    }
    return {
      kind: "gateway",
      url: completionsUrl(gatewayUrl),
      token,
      model: (env.AI_GATEWAY_MODEL ?? "").trim() || settings?.openai_model || "gpt-4o-mini",
    };
  }
  const openrouterKey = (settings?.openrouter_key ?? "").trim() || (env.OPENROUTER_KEY ?? "").trim();
  if (!openrouterKey) {
    return {
      error: "ai_not_configured",
      message:
        "AI is not configured on this deployment. Set AI_GATEWAY_URL + AI_GATEWAY_TOKEN, or add an OpenRouter key in Platform admin → AI configuration.",
    };
  }
  return {
    kind: "openrouter",
    url: "https://openrouter.ai/api/v1/chat/completions",
    token: openrouterKey,
    model: settings?.openai_model || "openai/gpt-4o-mini",
  };
}

export async function chat(
  env: AiEnv,
  messages: ChatMessage[],
  opts: { maxTokens?: number; timeoutMs?: number } = {},
  fetchImpl: Fetch = fetch
): Promise<AiResult> {
  const provider = await resolveProvider(env);
  if ("error" in provider) return { ok: false, status: 503, error: provider.error, message: provider.message };

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), opts.timeoutMs ?? 60_000);
  try {
    const upstream = await fetchImpl(provider.url, {
      method: "POST",
      headers: { Authorization: "Bearer " + provider.token, "Content-Type": "application/json" },
      body: JSON.stringify({ model: provider.model, max_tokens: opts.maxTokens ?? 1200, messages }),
      signal: controller.signal,
      cache: "no-store",
    });
    const json = (await upstream.json().catch(() => ({}))) as {
      choices?: { message?: { content?: string } }[];
      error?: { message?: string };
    };
    if (!upstream.ok) {
      return {
        ok: false,
        status: 502,
        error: "ai_upstream",
        message: json.error?.message ?? `The AI provider returned HTTP ${upstream.status}.`,
      };
    }
    const text = json.choices?.[0]?.message?.content ?? "";
    if (!text.trim()) {
      return { ok: false, status: 502, error: "ai_empty", message: "The AI provider returned an empty answer." };
    }
    return { ok: true, text, model: provider.model, provider: provider.kind };
  } catch {
    return { ok: false, status: 502, error: "ai_unreachable", message: "Could not reach the AI provider." };
  } finally {
    clearTimeout(timer);
  }
}
