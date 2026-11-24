import type { IgnoredDateRange } from './types';

export const DEFAULT_TIMEZONE = 'America/New_York';

/**
 * Parses an Odoo UTC datetime string (e.g. "2026-11-23 15:04:05" or ISO with/without Z)
 * strictly as UTC and returns a Date instance.
 */
export function parseOdooUtcToDate(odooUtcStr: string): Date {
  const trimmed = odooUtcStr.trim();
  if (!trimmed) {
    return new Date(NaN);
  }
  // If already has timezone designator (Z or +/-HH:MM)
  if (/[zZ]$|[+-]\d{2}:?\d{2}$/.test(trimmed)) {
    return new Date(trimmed.replace(' ', 'T'));
  }
  // Standard Odoo format "YYYY-MM-DD HH:mm:ss" -> treat explicitly as UTC
  const normalized = trimmed.includes('T') ? `${trimmed}Z` : `${trimmed.replace(' ', 'T')}Z`;
  return new Date(normalized);
}

/**
 * Formats a Date into local YYYY-MM-DD in the specified IANA timezone (default America/New_York).
 */
export function formatDateKeyInTimezone(date: Date, timezone: string = DEFAULT_TIMEZONE): string {
  const formatter = new Intl.DateTimeFormat('en-CA', {
    timeZone: timezone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  });
  const parts = formatter.formatToParts(date);
  const year = parts.find((p) => p.type === 'year')?.value ?? '1970';
  const month = parts.find((p) => p.type === 'month')?.value ?? '01';
  const day = parts.find((p) => p.type === 'day')?.value ?? '01';
  return `${year}-${month}-${day}`;
}

/**
 * Formats a Date into human-readable local datetime string in the specified IANA timezone.
 */
export function formatLocalDateTime(date: Date, timezone: string = DEFAULT_TIMEZONE): string {
  if (Number.isNaN(date.getTime())) return '';
  return new Intl.DateTimeFormat('en-US', {
    timeZone: timezone,
    year: 'numeric',
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
    timeZoneName: 'short',
  }).format(date);
}

/**
 * Formats a Date into ISO-like local string "YYYY-MM-DD HH:mm:ss" in the target timezone.
 */
export function formatLocalSqlTimestamp(date: Date, timezone: string = DEFAULT_TIMEZONE): string {
  if (Number.isNaN(date.getTime())) return '';
  const formatter = new Intl.DateTimeFormat('en-CA', {
    timeZone: timezone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hourCycle: 'h23',
  });
  const parts = formatter.formatToParts(date);
  const get = (type: string) => parts.find((p) => p.type === type)?.value ?? '00';
  const hour = get('hour') === '24' ? '00' : get('hour');
  return `${get('year')}-${get('month')}-${get('day')} ${hour}:${get('minute')}:${get('second')}`;
}

/**
 * Formats a Date into 24-hour local "HH:MM" in the target timezone (e.g., "16:05").
 */
export function formatLocalTimeHHMM(date: Date, timezone: string = DEFAULT_TIMEZONE): string {
  if (Number.isNaN(date.getTime())) return '00:00';
  const formatter = new Intl.DateTimeFormat('en-CA', {
    timeZone: timezone,
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  });
  const parts = formatter.formatToParts(date);
  const get = (type: string) => parts.find((p) => p.type === type)?.value ?? '00';
  const hour = get('hour') === '24' ? '00' : get('hour');
  return `${hour}:${get('minute')}`;
}

/**
 * Converts an Odoo UTC string directly to a local YYYY-MM-DD calendar date key.
 */
export function odooUtcToLocalDateKey(odooUtcStr: string, timezone: string = DEFAULT_TIMEZONE): string {
  const date = parseOdooUtcToDate(odooUtcStr);
  if (Number.isNaN(date.getTime())) return '';
  return formatDateKeyInTimezone(date, timezone);
}

/**
 * Converts an Odoo UTC string to a normalized local timestamp string ("YYYY-MM-DD HH:mm:ss").
 */
export function odooUtcToLocalTimestamp(odooUtcStr: string, timezone: string = DEFAULT_TIMEZONE): string {
  const date = parseOdooUtcToDate(odooUtcStr);
  if (Number.isNaN(date.getTime())) return odooUtcStr;
  return formatLocalSqlTimestamp(date, timezone);
}

/**
 * Converts a local calendar date's midnight ("YYYY-MM-DD" 00:00:00 in timezone)
 * to an Odoo-compatible UTC datetime string ("YYYY-MM-DD HH:mm:ss").
 * Accurately handles EST (-05:00) and EDT (-04:00) DST transitions.
 */
export function localDateStartToOdooUtc(localDateYmd: string, timezone: string = DEFAULT_TIMEZONE): string {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(localDateYmd.trim());
  if (!match) {
    throw new Error(`Invalid local date format: ${localDateYmd}`);
  }
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);

  // Initial UTC guess: treat midnight as UTC, then measure how far off the target TZ wall-clock is
  const targetWallMs = Date.UTC(year, month - 1, day, 0, 0, 0);
  let guessMs = targetWallMs;

  for (let i = 0; i < 3; i++) {
    const guessDate = new Date(guessMs);
    const localParts = new Intl.DateTimeFormat('en-CA', {
      timeZone: timezone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
      hourCycle: 'h23',
    }).formatToParts(guessDate);

    const getNum = (t: string) => Number(localParts.find((p) => p.type === t)?.value ?? '0');
    const h = getNum('hour') === 24 ? 0 : getNum('hour');
    const observedWallMs = Date.UTC(
      getNum('year'),
      getNum('month') - 1,
      getNum('day'),
      h,
      getNum('minute'),
      getNum('second')
    );

    const diffMs = targetWallMs - observedWallMs;
    if (diffMs === 0) break;
    guessMs += diffMs;
  }

  const utcDate = new Date(guessMs);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${utcDate.getUTCFullYear()}-${pad(utcDate.getUTCMonth() + 1)}-${pad(utcDate.getUTCDate())} ${pad(utcDate.getUTCHours())}:${pad(utcDate.getUTCMinutes())}:${pad(utcDate.getUTCSeconds())}`;
}

export function getTodayDateKey(timezone: string = DEFAULT_TIMEZONE, now: Date = new Date()): string {
  return formatDateKeyInTimezone(now, timezone);
}

/**
 * Adds delta days to a YYYY-MM-DD calendar key using UTC calendar arithmetic (DST-proof).
 */
export function addDays(ymd: string, delta: number): string {
  const [y, m, d] = ymd.split('-').map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d + delta));
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${dt.getUTCFullYear()}-${pad(dt.getUTCMonth() + 1)}-${pad(dt.getUTCDate())}`;
}

export function diffDays(startYmd: string, endYmd: string): number {
  const [y1, m1, d1] = startYmd.split('-').map(Number);
  const [y2, m2, d2] = endYmd.split('-').map(Number);
  const t1 = Date.UTC(y1, m1 - 1, d1);
  const t2 = Date.UTC(y2, m2 - 1, d2);
  return Math.round((t2 - t1) / 86_400_000);
}

/**
 * Returns ISO weekday: 1 = Monday .. 7 = Sunday.
 */
export function getIsoWeekday(ymd: string): number {
  const [y, m, d] = ymd.split('-').map(Number);
  const jsDay = new Date(Date.UTC(y, m - 1, d)).getUTCDay(); // 0=Sun..6=Sat
  return jsDay === 0 ? 7 : jsDay;
}

export function getMondayOfWeek(ymd: string): string {
  const iso = getIsoWeekday(ymd);
  return addDays(ymd, -(iso - 1));
}

export function listDateRange(startYmd: string, endYmd: string): string[] {
  const out: string[] = [];
  let cursor = startYmd;
  let guard = 0;
  while (cursor <= endYmd && guard < 400) {
    out.push(cursor);
    cursor = addDays(cursor, 1);
    guard += 1;
  }
  return out;
}

export function isDateInIgnoredRanges(localYmd: string, ranges: IgnoredDateRange[]): boolean {
  if (!localYmd) return false;
  return ranges.some((r) => r.startDate && r.endDate && localYmd >= r.startDate && localYmd <= r.endDate);
}

export const ISO_WEEKDAY_LABELS: Record<number, string> = {
  1: 'Mon',
  2: 'Tue',
  3: 'Wed',
  4: 'Thu',
  5: 'Fri',
  6: 'Sat',
  7: 'Sun',
};

export function formatShortCalendarDate(ymd: string): string {
  const [y, m, d] = ymd.split('-').map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  return new Intl.DateTimeFormat('en-US', {
    timeZone: 'UTC',
    month: 'short',
    day: 'numeric',
  }).format(dt);
}

export function formatFullDisplayDate(ymd: string): string {
  const [y, m, d] = ymd.split('-').map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  return new Intl.DateTimeFormat('en-US', {
    timeZone: 'UTC',
    weekday: 'short',
    month: 'short',
    day: 'numeric',
    year: 'numeric',
  }).format(dt);
}

export function getAgingHoldHours(preApprovedAtIso: string | null, now: Date = new Date()): number | null {
  if (!preApprovedAtIso) return null;
  const dt = new Date(preApprovedAtIso);
  if (Number.isNaN(dt.getTime())) return null;
  return Math.max(0, (now.getTime() - dt.getTime()) / 3_600_000);
}

export function formatAgingBadge(hours: number): string {
  if (hours < 24) {
    return `Waiting ${Math.floor(hours)}h`;
  }
  const days = Math.floor(hours / 24);
  return `Waiting ${days}d`;
}

export interface OrderArrivalInfo {
  sortKey: string; // "YYYY-MM-DD HH:mm:ss" in local farm timezone
  dateKey: string; // "YYYY-MM-DD" in local farm timezone
  shortLabel: string; // e.g. "Nov 20" (or "Nov 20, 2025" if prior year)
  ageLabel: string | null; // e.g. "Today", "1d ago", "4d ago"
  fullLabel: string; // e.g. "Nov 20, 2026 09:15"
}

export function getOrderArrivalInfo(
  order: { odooCreatedAtLocal: string | null; createdAt: string },
  timezone: string = DEFAULT_TIMEZONE,
  today?: string
): OrderArrivalInfo {
  let sortKey = '';
  const odooLocal = order.odooCreatedAtLocal?.trim() ?? '';
  if (/^\d{4}-\d{2}-\d{2}/.test(odooLocal)) {
    sortKey = odooLocal.length >= 19 ? odooLocal.slice(0, 19) : `${odooLocal.slice(0, 10)} 00:00:00`;
  } else if (order.createdAt) {
    const dt = new Date(order.createdAt);
    if (!Number.isNaN(dt.getTime())) {
      sortKey = formatLocalSqlTimestamp(dt, timezone);
    }
  }

  const dateKey = /^\d{4}-\d{2}-\d{2}/.test(sortKey) ? sortKey.slice(0, 10) : '';
  if (!dateKey) {
    return {
      sortKey: '9999-12-31 23:59:59',
      dateKey: '',
      shortLabel: 'Unknown',
      ageLabel: null,
      fullLabel: 'Unknown arrival date',
    };
  }

  const todayYear = today && /^\d{4}/.test(today) ? today.slice(0, 4) : dateKey.slice(0, 4);
  const shortLabel =
    dateKey.slice(0, 4) !== todayYear
      ? `${formatShortCalendarDate(dateKey)}, ${dateKey.slice(0, 4)}`
      : formatShortCalendarDate(dateKey);

  let ageLabel: string | null = null;
  if (today && /^\d{4}-\d{2}-\d{2}$/.test(today)) {
    const daysAgo = diffDays(dateKey, today);
    if (daysAgo === 0) ageLabel = 'Today';
    else if (daysAgo > 0) ageLabel = `${daysAgo}d ago`;
  }

  const timePart = sortKey.length >= 16 ? sortKey.slice(11, 16) : '';
  const fullLabel = `${formatFullDisplayDate(dateKey)}${timePart ? ` at ${timePart}` : ''}`;

  return { sortKey, dateKey, shortLabel, ageLabel, fullLabel };
}

export function compareWaitlistOrders(
  a: {
    id: number;
    status: string;
    odooCreatedAtLocal: string | null;
    createdAt: string;
    waitlistSortOrder?: number | null;
  },
  b: {
    id: number;
    status: string;
    odooCreatedAtLocal: string | null;
    createdAt: string;
    waitlistSortOrder?: number | null;
  },
  timezone: string = DEFAULT_TIMEZONE
): number {
  const aRank = typeof a.waitlistSortOrder === 'number' && Number.isFinite(a.waitlistSortOrder)
    ? a.waitlistSortOrder
    : null;
  const bRank = typeof b.waitlistSortOrder === 'number' && Number.isFinite(b.waitlistSortOrder)
    ? b.waitlistSortOrder
    : null;

  if (aRank !== null && bRank !== null && aRank !== bRank) {
    return aRank - bRank;
  }
  if (aRank !== null && bRank === null) return -1;
  if (aRank === null && bRank !== null) return 1;

  // Default order when not manually ranked: confirmed-needs-date first, then earliest arrival first
  const aConfirmed = a.status === 'confirmed' ? 0 : 1;
  const bConfirmed = b.status === 'confirmed' ? 0 : 1;
  if (aConfirmed !== bConfirmed) {
    return aConfirmed - bConfirmed;
  }

  const aArrival = getOrderArrivalInfo(a, timezone).sortKey;
  const bArrival = getOrderArrivalInfo(b, timezone).sortKey;
  if (aArrival !== bArrival) {
    return aArrival.localeCompare(bArrival);
  }

  return a.id - b.id;
}
