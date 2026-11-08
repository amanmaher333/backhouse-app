/**
 * Supplier delivery dates.
 *
 * A supplier delivers to a site on certain weekdays (0 = Sunday … 6 = Saturday),
 * with an order cut-off time and a lead time in days. Ordering before the
 * cut-off counts from today; after it, from tomorrow. The order must be in at
 * least `leadTimeDays` before delivery. All times are in the site's time zone.
 */

export interface DeliverySchedule {
  deliveryDays: number[];
  cutoffTime?: string | null;
  leadTimeDays?: number;
}

/** Local date and time parts in a time zone, from an instant. */
export function localParts(at: Date, timeZone: string): { date: string; weekday: number; minutes: number } {
  const fmt = new Intl.DateTimeFormat('en-GB', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    weekday: 'short',
    hourCycle: 'h23',
  });
  const parts = Object.fromEntries(fmt.formatToParts(at).map((p) => [p.type, p.value]));
  const weekday = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].indexOf(parts.weekday!);
  return { date: `${parts.year}-${parts.month}-${parts.day}`, weekday, minutes: Number(parts.hour) * 60 + Number(parts.minute) };
}

/** Add days to a YYYY-MM-DD date (calendar arithmetic, no time zone involved). */
export function addDays(date: string, days: number): string {
  const d = new Date(`${date}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

export function weekdayOf(date: string): number {
  return new Date(`${date}T00:00:00Z`).getUTCDay();
}

/**
 * Earliest delivery date (YYYY-MM-DD) for an order placed at `now`.
 * With no delivery days set, any day counts.
 */
export function nextDeliveryDate(now: Date, timeZone: string, schedule: DeliverySchedule): string {
  const local = localParts(now, timeZone);
  let orderDay = local.date;
  if (schedule.cutoffTime) {
    const [h, m] = schedule.cutoffTime.split(':').map(Number);
    if (local.minutes >= h! * 60 + m!) orderDay = addDays(orderDay, 1);
  }
  const earliest = addDays(orderDay, Math.max(0, schedule.leadTimeDays ?? 1));
  const days = schedule.deliveryDays.length ? new Set(schedule.deliveryDays) : null;
  for (let i = 0; i < 14; i++) {
    const candidate = addDays(earliest, i);
    if (!days || days.has(weekdayOf(candidate))) return candidate;
  }
  return earliest;
}

/** Whole days from `from` to `to` (YYYY-MM-DD), negative if `to` is earlier. */
export function daysBetween(from: string, to: string): number {
  return Math.round((new Date(`${to}T00:00:00Z`).getTime() - new Date(`${from}T00:00:00Z`).getTime()) / 86_400_000);
}
