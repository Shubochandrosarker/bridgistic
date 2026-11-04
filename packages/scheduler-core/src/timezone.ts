/**
 * IANA-zone wall-clock arithmetic, with no dependencies and no fixed offsets.
 *
 * A job scheduled "daily at 02:00 Asia/Dhaka" must fire at 02:00 local every
 * day forever, including across a DST transition in whatever zone the customer
 * picked. Storing a UTC offset instead of a zone name is the classic way to get
 * this wrong, so nothing in this file accepts an offset.
 */

export interface WallClock {
  year: number;
  /** 1-12. */
  month: number;
  day: number;
  hour: number;
  minute: number;
  second: number;
}

const MINUTE_MS = 60_000;

const formatters = new Map<string, Intl.DateTimeFormat>();

function formatter(timeZone: string): Intl.DateTimeFormat {
  let f = formatters.get(timeZone);
  if (!f) {
    f = new Intl.DateTimeFormat("en-US", {
      timeZone,
      hourCycle: "h23",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
    });
    formatters.set(timeZone, f);
  }
  return f;
}

/** Throws RangeError on an unknown zone, which is exactly what we want at job-create time. */
export function assertValidTimeZone(timeZone: string): void {
  formatter(timeZone).format(0);
}

export function isValidTimeZone(timeZone: string): boolean {
  try {
    assertValidTimeZone(timeZone);
    return true;
  } catch {
    return false;
  }
}

/** The wall-clock reading a person in `timeZone` sees at UTC instant `utcMs`. */
export function toWallClock(utcMs: number, timeZone: string): WallClock {
  const parts = formatter(timeZone).formatToParts(utcMs);
  const get = (type: Intl.DateTimeFormatPartTypes): number => {
    const part = parts.find((p) => p.type === type);
    if (!part) throw new Error(`Intl returned no ${type} part for ${timeZone}`);
    return Number(part.value);
  };
  return {
    year: get("year"),
    month: get("month"),
    day: get("day"),
    hour: get("hour"),
    minute: get("minute"),
    second: get("second"),
  };
}

/** Treat a wall clock as if it were UTC. Used only for field arithmetic. */
export function wallClockToNaiveMs(wc: WallClock): number {
  return Date.UTC(wc.year, wc.month - 1, wc.day, wc.hour, wc.minute, wc.second);
}

export function naiveMsToWallClock(ms: number): WallClock {
  const d = new Date(ms);
  return {
    year: d.getUTCFullYear(),
    month: d.getUTCMonth() + 1,
    day: d.getUTCDate(),
    hour: d.getUTCHours(),
    minute: d.getUTCMinutes(),
    second: d.getUTCSeconds(),
  };
}

/** 0 = Sunday … 6 = Saturday, for a wall-clock date. */
export function wallClockDayOfWeek(wc: WallClock): number {
  return new Date(Date.UTC(wc.year, wc.month - 1, wc.day)).getUTCDay();
}

/** `localWallClock - utc`, in ms, at the given instant. Handles :30 and :45 zones. */
export function zoneOffsetMs(utcMs: number, timeZone: string): number {
  return wallClockToNaiveMs(toWallClock(utcMs, timeZone)) - utcMs;
}

function sameWallClock(a: WallClock, b: WallClock): boolean {
  return (
    a.year === b.year &&
    a.month === b.month &&
    a.day === b.day &&
    a.hour === b.hour &&
    a.minute === b.minute &&
    a.second === b.second
  );
}

/**
 * Every UTC instant at which `wc` is the local reading in `timeZone`, ascending.
 *
 *   length 0 — the time does not exist (spring forward skipped over it)
 *   length 1 — the normal case
 *   length 2 — the time is ambiguous (fall back repeated the hour)
 *
 * Returning the list rather than one answer is deliberate: the caller decides
 * the policy. `nextCronRun` skips gaps and takes the earlier of an ambiguous
 * pair, so a "daily at 01:30" job fires exactly once on a fall-back day rather
 * than zero times or twice.
 */
export function fromWallClock(wc: WallClock, timeZone: string): number[] {
  const naive = wallClockToNaiveMs(wc);

  // Probe offsets on both sides of the instant so a transition inside the
  // guess window still produces the right candidate.
  const probes = [naive, naive - 26 * 3_600_000, naive + 26 * 3_600_000];
  const candidates = new Set<number>();
  for (const probe of probes) {
    const offset = zoneOffsetMs(probe, timeZone);
    candidates.add(naive - offset);
  }
  // One more refinement pass: an offset sampled at the candidate itself.
  for (const candidate of [...candidates]) {
    candidates.add(naive - zoneOffsetMs(candidate, timeZone));
  }

  return [...candidates]
    .filter((t) => sameWallClock(toWallClock(t, timeZone), wc))
    .sort((a, b) => a - b);
}

/** Truncate an instant to the start of its local minute, as a wall clock. */
export function floorToMinute(utcMs: number, timeZone: string): WallClock {
  const wc = toWallClock(utcMs, timeZone);
  return { ...wc, second: 0 };
}

export function addMinutes(wc: WallClock, minutes: number): WallClock {
  return naiveMsToWallClock(wallClockToNaiveMs(wc) + minutes * MINUTE_MS);
}

/** Next local midnight after `wc` (same-day 00:00 is never returned). */
export function startOfNextDay(wc: WallClock): WallClock {
  const next = naiveMsToWallClock(Date.UTC(wc.year, wc.month - 1, wc.day + 1));
  return { ...next, hour: 0, minute: 0, second: 0 };
}

export function startOfNextMonth(wc: WallClock): WallClock {
  return { year: wc.month === 12 ? wc.year + 1 : wc.year, month: wc.month === 12 ? 1 : wc.month + 1, day: 1, hour: 0, minute: 0, second: 0 };
}

export function startOfNextHour(wc: WallClock): WallClock {
  const next = naiveMsToWallClock(Date.UTC(wc.year, wc.month - 1, wc.day, wc.hour + 1));
  return { ...next, minute: 0, second: 0 };
}
