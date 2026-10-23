/** Public, non-secret configuration. Set at build time via Vite env vars. */
export const PAY_URL = import.meta.env.VITE_PAY_URL ?? "https://pay.bridgistic.app";
export const LICENSE_API = "https://admin.bridgistic.app/api/v1/licenses";
export const ACCOUNT_URL = "https://admin.bridgistic.app";
/** Same-origin-friendly relay that signs and forwards bridge calls. Some hosts
 * answer browser preflights without CORS headers, which blocks every direct
 * call; the relay avoids that entirely. */
export const RELAY_URL = import.meta.env.VITE_RELAY_URL ?? "https://admin.bridgistic.app/api/relay";
