/** Calendar helpers shared by API and worker. Dates are YYYY-MM-DD strings in a given IANA zone. */

function parts(at: Date, timeZone: string) {
  const fmt = new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23",
  });
  const get = (type: string) => Number(fmt.formatToParts(at).find((p) => p.type === type)?.value ?? "0");
  return { year: get("year"), month: get("month"), day: get("day"), hour: get("hour"), minute: get("minute"), second: get("second") };
}

const pad = (n: number) => String(n).padStart(2, "0");

/** Calendar date of `at` in `timeZone`. */
export function localDate(at: Date, timeZone: string): string {
  const p = parts(at, timeZone);
  return `${p.year}-${pad(p.month)}-${pad(p.day)}`;
}

/** Wall-clock time of `at` in `timeZone`, as HH:MM. */
export function localTime(at: Date, timeZone: string): string {
  const p = parts(at, timeZone);
  return `${pad(p.hour)}:${pad(p.minute)}`;
}

export function addDays(date: string, days: number): string {
  const d = new Date(`${date}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

/** Offset of `timeZone` from UTC at instant `at`, in milliseconds. */
function offsetMs(at: Date, timeZone: string): number {
  const p = parts(at, timeZone);
  const asUtc = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second);
  return asUtc - Math.floor(at.getTime() / 1000) * 1000;
}

/** The instant at which `date` begins (00:00 local) in `timeZone`, DST-aware. */
export function startOfLocalDay(date: string, timeZone: string): Date {
  const [y, m, d] = date.split("-").map(Number) as [number, number, number];
  const guess = Date.UTC(y, m - 1, d, 0, 0, 0);
  let result = guess - offsetMs(new Date(guess), timeZone);
  // A second pass corrects days on which the offset changes around midnight.
  result = guess - offsetMs(new Date(result), timeZone);
  return new Date(result);
}

/** Month of `now` in `timeZone` and the instant it started. */
export function localMonthStart(now: Date, timeZone: string): { month: string; start: Date } {
  const month = localDate(now, timeZone).slice(0, 7);
  return { month, start: startOfLocalDay(`${month}-01`, timeZone) };
}

/** True when HH:MM `time` lies inside the quiet window [start, end), which may span midnight. */
export function inQuietHours(time: string, start: string | null, end: string | null): boolean {
  if (!start || !end || start === end) return false;
  return start < end ? time >= start && time < end : time >= start || time < end;
}
