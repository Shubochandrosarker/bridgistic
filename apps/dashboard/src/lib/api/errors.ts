export type ApiErrorKind = "network" | "auth" | "scope" | "not_found" | "needs_plugin_update" | "rate_limited" | "server";
export class ApiError extends Error {
  constructor(message: string, public kind: ApiErrorKind, public status = 0) {
    super(message);
  }
}
export function classify(status: number, code?: string): ApiErrorKind {
  if (status === 0) return "network";
  if (status === 401) return "auth";
  if (status === 403) {
    if (code?.includes("scope")) return "scope";
    // Only signature/key failures mean the key itself was rejected. Other 403s
    // (e.g. bridgistic_option_denied) are policy refusals; their message is the useful part.
    return !code || code.startsWith("bridgistic_auth") || code === "rest_forbidden" ? "auth" : "server";
  }
  if (status === 404) return code === "rest_no_route" ? "needs_plugin_update" : "not_found";
  if (status === 429) return "rate_limited";
  return "server";
}
