export interface Env {
  DB: D1Database;
  JOB: DurableObjectNamespace;
  RUN_QUEUE: Queue<JobRunMessage>;
  TENANT_ENC_KEY: string;
}

/** What travels on the queue. Ids only — no args, no secrets (INVARIANT 6). */
export interface JobRunMessage {
  jobId: string;
  organizationId: string;
  siteId: string;
  /** The tick this run belongs to, not the moment it was enqueued. */
  scheduledFor: number;
  attempt: number;
  /** unique(jobId, scheduledFor, attempt). */
  idempotencyKey: string;
}
