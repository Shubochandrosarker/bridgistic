import type { KeyEnvironment } from "@bridgistic/identity";

export interface Env {
  DB: D1Database;
  USAGE_COUNTER: DurableObjectNamespace;
  TENANT_ENC_KEY: string;
  ENVIRONMENT: KeyEnvironment;
  STRIPE_SECRET_KEY?: string;
  STRIPE_WEBHOOK_SECRET?: string;
  WPISTIC_API_TOKEN?: string;
}
