import type Database from 'better-sqlite3';
import { addDays, diffDays, getIsoWeekday, listDateRange } from '../shared/timezone';
import type { StandingCadence, StandingOrder, StandingOrderItemLine } from '../shared/types';

function computeMonthlyOrdinal(ymd: string): number {
  const dayOfMonth = Number(ymd.split('-')[2]);
  return Math.floor((dayOfMonth - 1) / 7) + 1; // 1st..5th weekday of month
}

/**
 * Generates all occurrence dates for a standing order within [horizonStart, horizonEnd].
 */
export function computeStandingOccurrenceDates(
  standing: Pick<StandingOrder, 'cadence' | 'weekday' | 'startDate'>,
  horizonStart: string,
  horizonEnd: string
): string[] {
  const effectiveStart = standing.startDate > horizonStart ? standing.startDate : horizonStart;
  if (effectiveStart > horizonEnd) return [];

  // Find first matching weekday on or after standing.startDate
  let anchorDate = standing.startDate;
  while (getIsoWeekday(anchorDate) !== standing.weekday) {
    anchorDate = addDays(anchorDate, 1);
  }
  const anchorOrdinal = computeMonthlyOrdinal(anchorDate);

  const allDates = listDateRange(effectiveStart, horizonEnd);
  const occurrences: string[] = [];

  for (const date of allDates) {
    if (getIsoWeekday(date) !== standing.weekday) continue;
    if (date < anchorDate) continue;

    if (standing.cadence === 'weekly') {
      occurrences.push(date);
    } else if (standing.cadence === 'biweekly') {
      const weeksSince = Math.floor(diffDays(anchorDate, date) / 7);
      if (weeksSince % 2 === 0) {
        occurrences.push(date);
      }
    } else if (standing.cadence === 'monthly') {
      const ord = computeMonthlyOrdinal(date);
      if (ord === anchorOrdinal) {
        occurrences.push(date);
      }
    }
  }

  return occurrences;
}

interface RawStandingRow {
  id: number;
  customer_name: string;
  customer_contact: string | null;
  pickup_channel_id: number | null;
  cadence: StandingCadence;
  weekday: number;
  start_date: string;
  is_active: number;
  notes: string | null;
  items_json: string;
  created_at: string;
  updated_at: string;
}

export function listStandingOrders(db: Database.Database): StandingOrder[] {
  const rows = db
    .prepare('SELECT * FROM standing_orders ORDER BY is_active DESC, customer_name ASC')
    .all() as RawStandingRow[];

  return rows.map((r) => {
    let items: StandingOrderItemLine[] = [];
    try {
      items = JSON.parse(r.items_json) as StandingOrderItemLine[];
    } catch {
      items = [];
    }
    return {
      id: r.id,
      customerName: r.customer_name,
      customerContact: r.customer_contact,
      pickupChannelId: r.pickup_channel_id,
      cadence: r.cadence,
      weekday: r.weekday,
      startDate: r.start_date,
      isActive: Boolean(r.is_active),
      notes: r.notes,
      items,
      createdAt: r.created_at,
      updatedAt: r.updated_at,
    };
  });
}

/**
 * Materializes active standing orders across [today, horizonEnd] as locked slotted orders,
 * honoring per-occurrence exceptions (`skipped`, `modified`, `deleted`).
 * Never overwrites past orders or user-modified occurrences.
 */
export function materializeStandingOrders(
  db: Database.Database,
  today: string,
  horizonEnd: string
): { createdCount: number; removedPausedCount: number } {
  const templates = listStandingOrders(db);
  const nowIso = new Date().toISOString();

  // Build valid tracked item ID set to avoid FK failures if an item was removed
  const validItemIds = new Set(
    (db.prepare('SELECT id FROM tracked_items').all() as Array<{ id: number }>).map((r) => r.id)
  );

  let createdCount = 0;
  let removedPausedCount = 0;

  const tx = db.transaction(() => {
    for (const template of templates) {
      if (!template.isActive) {
        // Remove future untouched slotted standing instances for paused rules
        const info = db
          .prepare(
            `DELETE FROM orders
             WHERE source = 'standing'
               AND standing_order_id = ?
               AND standing_occurrence_date >= ?
               AND status = 'slotted'`
          )
          .run(template.id, today);
        removedPausedCount += info.changes;
        continue;
      }

      const validItems = template.items.filter(
        (line) => validItemIds.has(line.trackedItemId) && line.quantity > 0
      );
      if (validItems.length === 0) continue;

      const exceptionRows = db
        .prepare('SELECT occurrence_date, action FROM standing_order_exceptions WHERE standing_order_id = ?')
        .all(template.id) as Array<{ occurrence_date: string; action: string }>;
      const exceptionSet = new Set(exceptionRows.map((e) => e.occurrence_date));

      const existingRows = db
        .prepare(
          `SELECT id, standing_occurrence_date, status FROM orders
           WHERE source = 'standing' AND standing_order_id = ? AND standing_occurrence_date IS NOT NULL`
        )
        .all(template.id) as Array<{ id: number; standing_occurrence_date: string; status: string }>;
      const existingByDate = new Map(existingRows.map((r) => [r.standing_occurrence_date, r]));

      const targetDates = computeStandingOccurrenceDates(template, today, horizonEnd);
      const targetDateSet = new Set(targetDates);

      // Clean up future unmodified occurrences that no longer match edited cadence/weekday
      for (const existing of existingRows) {
        if (
          existing.standing_occurrence_date >= today &&
          existing.status === 'slotted' &&
          !targetDateSet.has(existing.standing_occurrence_date) &&
          !exceptionSet.has(existing.standing_occurrence_date)
        ) {
          db.prepare('DELETE FROM orders WHERE id = ?').run(existing.id);
        }
      }

      for (const occDate of targetDates) {
        if (exceptionSet.has(occDate)) continue;
        if (existingByDate.has(occDate)) continue;

        const insertRes = db
          .prepare(
            `INSERT INTO orders (
               source, status, timing_type, requested_date, slotted_date, is_locked,
               customer_name, customer_name_overridden, customer_phone, pickup_channel_id,
               notes, standing_order_id, standing_occurrence_date, created_at, updated_at
             ) VALUES (
               'standing', 'slotted', 'specific_date', ?, ?, 1,
               ?, 0, ?, ?,
               ?, ?, ?, ?, ?
             )`
          )
          .run(
            occDate,
            occDate,
            template.customerName,
            template.customerContact,
            template.pickupChannelId,
            template.notes,
            template.id,
            occDate,
            nowIso,
            nowIso
          );

        const orderId = Number(insertRes.lastInsertRowid);
        const itemStmt = db.prepare(
          'INSERT INTO order_items (order_id, tracked_item_id, quantity) VALUES (?, ?, ?)'
        );
        for (const line of validItems) {
          itemStmt.run(orderId, line.trackedItemId, line.quantity);
        }
        createdCount += 1;
      }
    }
  });

  tx();
  return { createdCount, removedPausedCount };
}
