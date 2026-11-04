/**
 * `@bridgistic/observability` — structured logs that cannot leak.
 *
 * `redact` is the control and `Logger` is the only way to emit, so redaction
 * is unconditional rather than something a caller remembers.
 */

export { redact, redactString, findLeaks, REDACTED } from "./redact.ts";
export type { RedactOptions } from "./redact.ts";

export { Logger, requestIdFrom, errorClassOf, LOG_LEVELS } from "./log.ts";
export type { LogLevel, LogFields, LogLine, Sink, LoggerOptions } from "./log.ts";
