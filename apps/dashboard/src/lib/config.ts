/** Public, non-secret configuration. Set at build time via Vite env vars. */
export const PAY_URL = import.meta.env.VITE_PAY_URL ?? "https://pay.bridgistic.app";
export const LICENSE_API = "https://api.wpistic.com/api/v1/licenses";
export const ACCOUNT_URL = "https://app.wpistic.com/licenses";
