/** A resolved WordPress connection target. */
export interface Connection {
  /** Friendly alias used by the agent (e.g. "guns2ammo", "default"). */
  alias: string;
  /** Base site URL, no trailing slash (e.g. https://example.com). */
  siteUrl: string;
  /** Public key id minted by the bridge plugin. */
  keyId: string;
  /** Signing secret (never logged, never returned to the model). */
  secret: string;
}

/** Standard success envelope returned by the bridge plugin. */
export interface BridgeOk<T = unknown> {
  ok: true;
  data: T;
}

/** Error shape WordPress returns on WP_Error. */
export interface BridgeError {
  code: string;
  message: string;
  data?: { status?: number };
}

export type Json =
  | string
  | number
  | boolean
  | null
  | Json[]
  | { [key: string]: Json };
