import type Database from 'better-sqlite3';
import type { CheckpointSummary } from '../shared/types';

interface CheckpointState {
  orders: Record<string, unknown>[];
  orderItems: Record<string, unknown>[];
  orderChatter: Record<string, unknown>[];
  mergedOdooLinks?: Record<string, unknown>[];
  dismissedDuplicatePairs?: Record<string, unknown>[];
  dailySupplyEntries: Record<string, unknown>[];
  standingOrderExceptions: Record<string, unknown>[];
}

const MAX_AUTO_CHECKPOINTS = 25;

export function captureCheckpoint(
  db: Database.Database,
  label: string,
  isManual: boolean = false
): CheckpointSummary {
  const snapshot: CheckpointState = {
    orders: db.prepare('SELECT * FROM orders').all() as Record<string, unknown>[],
    orderItems: db.prepare('SELECT * FROM order_items').all() as Record<string, unknown>[],
    orderChatter: db.prepare('SELECT * FROM order_chatter').all() as Record<string, unknown>[],
    mergedOdooLinks: db
      .prepare('SELECT * FROM merged_odoo_links')
      .all() as Record<string, unknown>[],
    dismissedDuplicatePairs: db
      .prepare('SELECT * FROM dismissed_duplicate_pairs')
      .all() as Record<string, unknown>[],
    dailySupplyEntries: db
      .prepare('SELECT * FROM daily_supply_entries')
      .all() as Record<string, unknown>[],
    standingOrderExceptions: db
      .prepare('SELECT * FROM standing_order_exceptions')
      .all() as Record<string, unknown>[],
  };

  const nowIso = new Date().toISOString();
  const res = db
    .prepare(
      'INSERT INTO action_checkpoints (label, is_manual, snapshot_json, created_at) VALUES (?, ?, ?, ?)'
    )
    .run(label, isManual ? 1 : 0, JSON.stringify(snapshot), nowIso);

  // Prune older automatic checkpoints beyond retention cap
  db.prepare(
    `DELETE FROM action_checkpoints
     WHERE is_manual = 0 AND id NOT IN (
       SELECT id FROM action_checkpoints WHERE is_manual = 0 ORDER BY id DESC LIMIT ?
     )`
  ).run(MAX_AUTO_CHECKPOINTS);

  return {
    id: Number(res.lastInsertRowid),
    label,
    isManual,
    createdAt: nowIso,
  };
}

export function listCheckpoints(db: Database.Database): CheckpointSummary[] {
  const rows = db
    .prepare(
      'SELECT id, label, is_manual, created_at FROM action_checkpoints ORDER BY id DESC LIMIT 20'
    )
    .all() as Array<{ id: number; label: string; is_manual: number; created_at: string }>;

  return rows.map((r) => ({
    id: r.id,
    label: r.label,
    isManual: Boolean(r.is_manual),
    createdAt: r.created_at,
  }));
}

function insertRows(
  db: Database.Database,
  table: string,
  rows: Record<string, unknown>[]
): void {
  if (rows.length === 0) return;
  const cols = Object.keys(rows[0]);
  const placeholders = cols.map(() => '?').join(', ');
  const stmt = db.prepare(`INSERT INTO ${table} (${cols.join(', ')}) VALUES (${placeholders})`);
  for (const row of rows) {
    stmt.run(...cols.map((c) => row[c] ?? null));
  }
}

export function restoreCheckpointById(
  db: Database.Database,
  checkpointId: number,
  consumeAfterRestore: boolean = false
): { restoredLabel: string } {
  const row = db
    .prepare('SELECT id, label, snapshot_json FROM action_checkpoints WHERE id = ?')
    .get(checkpointId) as { id: number; label: string; snapshot_json: string } | undefined;

  if (!row) {
    throw new Error('Checkpoint not found');
  }

  const state = JSON.parse(row.snapshot_json) as CheckpointState;

  const tx = db.transaction(() => {
    db.prepare('DELETE FROM dismissed_duplicate_pairs').run();
    db.prepare('DELETE FROM merged_odoo_links').run();
    db.prepare('DELETE FROM order_chatter').run();
    db.prepare('DELETE FROM order_items').run();
    db.prepare('DELETE FROM orders').run();
    db.prepare('DELETE FROM daily_supply_entries').run();
    db.prepare('DELETE FROM standing_order_exceptions').run();

    insertRows(db, 'orders', state.orders);
    insertRows(db, 'order_items', state.orderItems);
    insertRows(db, 'order_chatter', state.orderChatter);
    if (Array.isArray(state.mergedOdooLinks)) {
      insertRows(db, 'merged_odoo_links', state.mergedOdooLinks);
    }
    if (Array.isArray(state.dismissedDuplicatePairs)) {
      insertRows(db, 'dismissed_duplicate_pairs', state.dismissedDuplicatePairs);
    }
    insertRows(db, 'daily_supply_entries', state.dailySupplyEntries);
    insertRows(db, 'standing_order_exceptions', state.standingOrderExceptions);

    if (consumeAfterRestore) {
      db.prepare('DELETE FROM action_checkpoints WHERE id = ?').run(checkpointId);
    }
  });

  tx();
  return { restoredLabel: row.label };
}

export function undoLastCheckpoint(db: Database.Database): { restoredLabel: string } {
  const latest = db
    .prepare('SELECT id FROM action_checkpoints ORDER BY id DESC LIMIT 1')
    .get() as { id: number } | undefined;
  if (!latest) {
    throw new Error('No actions available to undo');
  }
  return restoreCheckpointById(db, latest.id, true);
}
