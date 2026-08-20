export interface Env {
  DB: D1Database;
  USAGE_COUNTER: DurableObjectNamespace;
  TENANT_ENC_KEY: string;
  STRIPE_SECRET_KEY?: string;
  STRIPE_WEBHOOK_SECRET?: string;
  WPISTIC_API_TOKEN?: string;
}
