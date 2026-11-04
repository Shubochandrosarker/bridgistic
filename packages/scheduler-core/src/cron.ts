/**
 * A 5-field cron parser: minute hour day-of-month month day-of-week.
 *
 * Deliberately not a general-purpose cron: no seconds field, no `L`/`W`/`#`.
 * Those are the parts of cron whose semantics differ between implementations,
 * and a scheduler a customer pays for should not be ambiguous about when it
 * fires. Anything unsupported is a parse error at job-create time, not a
 * surprise at run time.
 */

export interface CronFields {
  minutes: ReadonlySet<number>;
  hours: ReadonlySet<number>;
  daysOfMonth: ReadonlySet<number>;
  months: ReadonlySet<number>;
  daysOfWeek: ReadonlySet<number>;
  /** True when the field was not `*` — decides the classic DOM/DOW OR rule. */
  domRestricted: boolean;
  dowRestricted: boolean;
  expression: string;
}

export class CronParseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CronParseError";
  }
}

const MONTH_NAMES = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];
const DAY_NAMES = ["sun", "mon", "tue", "wed", "thu", "fri", "sat"];

const ALIASES: Record<string, string> = {
  "@yearly": "0 0 1 1 *",
  "@annually": "0 0 1 1 *",
  "@monthly": "0 0 1 * *",
  "@weekly": "0 0 * * 0",
  "@daily": "0 0 * * *",
  "@midnight": "0 0 * * *",
  "@hourly": "0 * * * *",
};

interface FieldSpec {
  name: string;
  min: number;
  max: number;
  names?: string[];
}

const FIELDS: FieldSpec[] = [
  { name: "minute", min: 0, max: 59 },
  { name: "hour", min: 0, max: 23 },
  { name: "day-of-month", min: 1, max: 31 },
  { name: "month", min: 1, max: 12, names: MONTH_NAMES },
  { name: "day-of-week", min: 0, max: 7, names: DAY_NAMES },
];

function parseValue(token: string, spec: FieldSpec): number {
  const lower = token.toLowerCase();
  if (spec.names) {
    const idx = spec.names.indexOf(lower);
    if (idx !== -1) return spec.name === "month" ? idx + 1 : idx;
  }
  if (!/^\d+$/.test(token)) {
    throw new CronParseError(`"${token}" is not a valid ${spec.name}.`);
  }
  const n = Number(token);
  if (n < spec.min || n > spec.max) {
    throw new CronParseError(`${spec.name} ${n} is outside ${spec.min}-${spec.max}.`);
  }
  return n;
}

function parseField(raw: string, spec: FieldSpec): { values: Set<number>; restricted: boolean } {
  const values = new Set<number>();
  let restricted = false;

  for (const part of raw.split(",")) {
    if (part === "") throw new CronParseError(`Empty ${spec.name} entry in "${raw}".`);

    const [rangePart, stepPart, ...extra] = part.split("/");
    if (extra.length > 0) throw new CronParseError(`Too many "/" in ${spec.name} "${part}".`);

    let step = 1;
    if (stepPart !== undefined) {
      if (!/^\d+$/.test(stepPart) || Number(stepPart) === 0) {
        throw new CronParseError(`Step "${stepPart}" in ${spec.name} must be a positive integer.`);
      }
      step = Number(stepPart);
    }

    let from: number;
    let to: number;
    const range = rangePart ?? "";
    if (range === "*" || range === "?") {
      from = spec.min;
      to = spec.max;
      if (stepPart !== undefined) restricted = true;
    } else if (range.includes("-")) {
      const [a, b, ...rest] = range.split("-");
      if (rest.length > 0 || a === undefined || b === undefined) {
        throw new CronParseError(`Malformed range "${range}" in ${spec.name}.`);
      }
      from = parseValue(a, spec);
      to = parseValue(b, spec);
      if (from > to) throw new CronParseError(`Range "${range}" in ${spec.name} runs backwards.`);
      restricted = true;
    } else {
      from = parseValue(range, spec);
      to = stepPart === undefined ? from : spec.max;
      restricted = true;
    }

    for (let v = from; v <= to; v += step) values.add(v);
  }

  // Cron lets 7 mean Sunday. Normalise so the matcher only ever sees 0-6.
  if (spec.name === "day-of-week" && values.delete(7)) values.add(0);

  if (values.size === 0) throw new CronParseError(`${spec.name} matched nothing.`);
  return { values, restricted };
}

export function parseCron(expression: string): CronFields {
  const normalised = (ALIASES[expression.trim().toLowerCase()] ?? expression).trim();
  const parts = normalised.split(/\s+/);

  if (parts.length !== 5) {
    throw new CronParseError(
      `Expected 5 cron fields (minute hour day-of-month month day-of-week), got ${parts.length}: "${expression}".`
    );
  }

  const parsed = parts.map((part, i) => parseField(part, FIELDS[i]!));

  return {
    minutes: parsed[0]!.values,
    hours: parsed[1]!.values,
    daysOfMonth: parsed[2]!.values,
    months: parsed[3]!.values,
    daysOfWeek: parsed[4]!.values,
    domRestricted: parsed[2]!.restricted,
    dowRestricted: parsed[4]!.restricted,
    expression: normalised,
  };
}

/**
 * The classic (Vixie) day rule: when BOTH day-of-month and day-of-week are
 * restricted, a date matches if EITHER matches. When only one is restricted,
 * only that one applies.
 */
export function matchesDay(fields: CronFields, dayOfMonth: number, dayOfWeek: number): boolean {
  const domHit = fields.daysOfMonth.has(dayOfMonth);
  const dowHit = fields.daysOfWeek.has(dayOfWeek);

  if (fields.domRestricted && fields.dowRestricted) return domHit || dowHit;
  if (fields.domRestricted) return domHit;
  if (fields.dowRestricted) return dowHit;
  return true;
}

/**
 * The tightest gap this expression can produce, in seconds — used to reject a
 * job whose cadence is below the plan's `min_interval_seconds` at create time
 * rather than throttling it silently later.
 */
export function tightestIntervalSeconds(fields: CronFields): number {
  const gap = (values: ReadonlySet<number>, wrap: number): number => {
    const sorted = [...values].sort((a, b) => a - b);
    if (sorted.length <= 1) return wrap;
    let min = wrap - sorted[sorted.length - 1]! + sorted[0]!;
    for (let i = 1; i < sorted.length; i++) min = Math.min(min, sorted[i]! - sorted[i - 1]!);
    return min;
  };

  if (fields.minutes.size > 1) return gap(fields.minutes, 60) * 60;
  if (fields.hours.size > 1) return gap(fields.hours, 24) * 3_600;
  return 86_400;
}
