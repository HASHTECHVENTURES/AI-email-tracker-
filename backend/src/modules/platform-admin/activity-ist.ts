/** India Standard Time (UTC+5:30) — used for admin activity date buckets. */
export const ACTIVITY_TIMEZONE = 'Asia/Kolkata';
const IST_OFFSET_MS = 5.5 * 60 * 60 * 1000;

export type IstDayBounds = {
  /** YYYY-MM-DD in IST */
  date_key: string;
  /** ISO UTC — inclusive start of IST calendar day */
  start_iso: string;
  /** ISO UTC — exclusive end (start of next IST day) */
  end_iso: string;
};

/** Calendar parts for "now" in IST. */
export function istNowParts(now = new Date()): { year: number; month: number; date: number } {
  const t = new Date(now.getTime() + IST_OFFSET_MS);
  return { year: t.getUTCFullYear(), month: t.getUTCMonth(), date: t.getUTCDate() };
}

function pad2(n: number): string {
  return String(n).padStart(2, '0');
}

/** Midnight IST for a given IST calendar day → UTC ISO string. */
export function istDayStartIso(year: number, month: number, date: number): string {
  const utcMs = Date.UTC(year, month, date, 0, 0, 0, 0) - IST_OFFSET_MS;
  return new Date(utcMs).toISOString();
}

export function istDayBounds(year: number, month: number, date: number): IstDayBounds {
  const next = new Date(Date.UTC(year, month, date + 1));
  return {
    date_key: `${year}-${pad2(month + 1)}-${pad2(date)}`,
    start_iso: istDayStartIso(year, month, date),
    end_iso: istDayStartIso(next.getUTCFullYear(), next.getUTCMonth(), next.getUTCDate()),
  };
}

/** IST calendar day offset from today (0 = today, 1 = yesterday). */
export function istDayBoundsFromToday(daysAgo: number, now = new Date()): IstDayBounds {
  const { year, month, date } = istNowParts(now);
  const anchor = new Date(Date.UTC(year, month, date - daysAgo));
  return istDayBounds(anchor.getUTCFullYear(), anchor.getUTCMonth(), anchor.getUTCDate());
}

/** Last N IST calendar days, oldest first (includes today). */
export function istLastNDays(n: number, now = new Date()): IstDayBounds[] {
  const out: IstDayBounds[] = [];
  for (let i = n - 1; i >= 0; i--) {
    out.push(istDayBoundsFromToday(i, now));
  }
  return out;
}

export function istMonthStartIso(now = new Date()): string {
  const { year, month } = istNowParts(now);
  return istDayStartIso(year, month, 1);
}

export function istWeekStartIso(now = new Date()): string {
  return istDayBoundsFromToday(6, now).start_iso;
}
