/**
 * `@bridgistic/executor` — the one execution pipeline.
 *
 * MCP, the REST API, the scheduler and the dashboard all call `execute`, and
 * none of them implements any part of it. Three implementations of an approval
 * gate is three chances to get it wrong, and the wrong one will be whichever
 * nobody tested because it was "the same as the others".
 */

export { ActionExecutor } from "./executor.ts";
export type { ExecuteRequest, ExecuteResult } from "./executor.ts";

export type {
  ExecutorPorts,
  IdempotencyStore,
  IdempotencyClaim,
  ClaimOutcome,
  ClaimState,
  MeteringStore,
  Reservation,
  AdmissionOutcome,
  ApprovalStore,
  SnapshotStore,
  ConcurrencyLock,
  Transport,
  TransportRequest,
  TransportResult,
  AuditLog,
  AuditEntry,
} from "./ports.ts";
