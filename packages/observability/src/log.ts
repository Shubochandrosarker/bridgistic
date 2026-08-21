/**
 * Structured logging.
 *
 * One shape for every log line, so a customer report ("it failed around 3pm")
 * maps to a query rather than to a search. The fields are the ones
 * `SECURITY_MODEL.md` and the brief name, and no others: adding a field is a
 * decision about what we retain, not a convenience.
 *
 * Every value goes through `redact` on the way out. Not "should" — the log
 * function is the only way to emit, and it redacts unconditionally, because a
 * rule that depends on the caller remembering is a rule that holds until the
 * first person in a hurry.
 */

import { redact } from "./redact.ts";
import type { RedactOptions } from "./redact.ts";

export const LOG_LEVELS = ["debug", "info", "warn", "error"] as const;
export type LogLevel = (typeof LOG_LEVELS)[number];

/**
 * The fields a log line may carry.
 *
 * `organizationId` and `siteId` are here because an incident is unworkable
 * without them, and they are identifiers rather than content. Nothing derived
 * from a request body appears at all — `requestDigest` is `sha256(canonical(args))`,
 * which is enough to correlate two identical calls and useless for
 * reconstructing either.
 */
export interface LogFields {
  readonly requestId?: string;
  readonly traceId?: string;
  readonly organizationId?: string;
  readonly siteId?: string;
  readonly actorId?: string;
  readonly actorType?: "user" | "api_key" | "service_account" | "scheduler" | "system";
  readonly tool?: string;
  readonly actionId?: string;
  readonly jobRunId?: string;
  readonly outcome?: "success" | "denied" | "failed" | "timeout" | "cancelled";
  readonly durationMs?: number;
  readonly retryCount?: number;
  readonly errorClass?: string;
  readonly queueLatencyMs?: number;
  readonly reservationStatus?: "reserved" | "settled" | "released" | "expired";
  readonly requestDigest?: string;
  readonly environment?: string;
  /** Anything else. Redacted like everything else, and bounded. */
  readonly extra?: Record<string, unknown>;
}

export interface LogLine extends LogFields {
  readonly level: LogLevel;
  readonly message: string;
  readonly timestamp: string;
}

export type Sink = (line: LogLine) => void;

export interface LoggerOptions {
  readonly sink?: Sink;
  readonly minLevel?: LogLevel;
  readonly redactOptions?: RedactOptions;
  /** Fields attached to every line from this logger. */
  readonly base?: LogFields;
  /** Injected so tests are deterministic and the runtime has no clock argument. */
  readonly now?: () => Date;
}

const LEVEL_ORDER: Record<LogLevel, number> = { debug: 0, info: 1, warn: 2, error: 3 };

/** The default sink. One JSON object per line, which is what a log pipeline wants. */
const consoleSink: Sink = (line) => {
  const serialised = JSON.stringify(line);
  if (line.level === "error") console.error(serialised);
  else if (line.level === "warn") console.warn(serialised);
  else console.log(serialised);
};

export class Logger {
  readonly #sink: Sink;
  readonly #minLevel: LogLevel;
  readonly #redactOptions: RedactOptions;
  readonly #base: LogFields;
  readonly #now: () => Date;

  constructor(options: LoggerOptions = {}) {
    this.#sink = options.sink ?? consoleSink;
    this.#minLevel = options.minLevel ?? "info";
    this.#redactOptions = options.redactOptions ?? {};
    this.#base = options.base ?? {};
    this.#now = options.now ?? (() => new Date());
  }

  /** A logger carrying additional fields. Used per-request, per-action, per-run. */
  child(fields: LogFields): Logger {
    return new Logger({
      sink: this.#sink,
      minLevel: this.#minLevel,
      redactOptions: this.#redactOptions,
      base: { ...this.#base, ...fields },
      now: this.#now,
    });
  }

  debug(message: string, fields: LogFields = {}): void {
    this.#emit("debug", message, fields);
  }
  info(message: string, fields: LogFields = {}): void {
    this.#emit("info", message, fields);
  }
  warn(message: string, fields: LogFields = {}): void {
    this.#emit("warn", message, fields);
  }

  /**
   * `error` takes an Error rather than a pre-formatted string.
   *
   * `log.error(\`failed: ${e}\`)` is how a request body reaches a log: the
   * template literal stringifies whatever the error carries, before anything
   * can redact it. Taking the error itself means it goes through `redact`,
   * which walks `.cause` and drops the stack.
   */
  error(message: string, error?: unknown, fields: LogFields = {}): void {
    this.#emit("error", message, {
      ...fields,
      errorClass: fields.errorClass ?? errorClassOf(error),
      ...(error === undefined ? {} : { extra: { ...fields.extra, error } }),
    });
  }

  #emit(level: LogLevel, message: string, fields: LogFields): void {
    if (LEVEL_ORDER[level] < LEVEL_ORDER[this.#minLevel]) return;

    const merged = { ...this.#base, ...fields };
    // The whole line, including the message. A message is a string somebody
    // interpolated something into often enough that exempting it would defeat
    // the purpose.
    const safe = redact({ ...merged, message }, this.#redactOptions) as Record<string, unknown>;

    this.#sink({
      ...(safe as LogFields),
      level,
      message: typeof safe.message === "string" ? safe.message : "[unloggable message]",
      timestamp: this.#now().toISOString(),
    });
  }
}

/**
 * The error's class name, for grouping. Never its message.
 *
 * `error.name` alone is wrong for a subclass: `class TimeoutError extends
 * Error {}` inherits `name` from `Error.prototype`, so every custom error type
 * groups as "Error" and the grouping stops distinguishing anything. The
 * constructor name is what people actually mean, so it wins unless `name` was
 * explicitly overridden to something more specific.
 */
export function errorClassOf(error: unknown): string | undefined {
  if (error === undefined || error === null) return undefined;
  if (!(error instanceof Error)) return typeof error;

  const constructorName = error.constructor?.name;
  if (error.name && error.name !== "Error") return error.name;
  return constructorName || error.name || "Error";
}

/**
 * A request id: caller-supplied if it looks like one, generated if not.
 *
 * Caller-supplied ids are bounded and character-restricted before use. An id
 * flows into every log line for the request, and an unbounded one is a way to
 * write arbitrary content into the log — including newlines, which is how a
 * forged log entry gets injected next to a real one.
 */
export function requestIdFrom(header: string | null | undefined): string {
  if (typeof header === "string" && /^[A-Za-z0-9_-]{8,64}$/.test(header)) return header;
  return crypto.randomUUID();
}
