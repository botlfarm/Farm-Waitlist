import Database from 'better-sqlite3';
import fs from 'fs';
import path from 'path';
import { DEFAULT_TIMEZONE } from '../shared/timezone';
import type { AppSettings, BackupInfo, BackupTrigger } from '../shared/types';

export interface Migration {
  version: number;
  name: string;
  sql: string;
}

export const DEFAULT_APP_SETTINGS: AppSettings = {
  timezone: DEFAULT_TIMEZONE,
  odooSyncInterval: 'manual',
  odooSyncCutoffDate: null,
  odooIgnoredDateRanges: [],
  preApprovalTemplate:
    "Hey {{name}}, you're pre-approved for {{items_summary}} on {{date}} ({{channel}}). Place the order through EFF using the pre-approved option.",
  holdThresholdHours: 48,
  backupScheduleEnabled: true,
  backupRetentionDays: 14,
  publicSnippetWeeks: 3,
};

export const MIGRATIONS: Migration[] = [
  {
    version: 1,
    name: 'initial_schema',
    sql: `
      CREATE TABLE IF NOT EXISTS app_settings (
        key TEXT PRIMARY KEY,
        value_json TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS tracked_items (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        name TEXT NOT NULL,
        unit_label TEXT NOT NULL DEFAULT 'dozens',
        is_active INTEGER NOT NULL DEFAULT 1,
        supply_mode TEXT NOT NULL DEFAULT 'continuous' CHECK (supply_mode IN ('continuous', 'discrete')),
        default_daily_production REAL NOT NULL DEFAULT 0,
        global_safety_buffer REAL NOT NULL DEFAULT 0,
        include_in_public_snippet INTEGER NOT NULL DEFAULT 1,
        keyword_rules_json TEXT NOT NULL DEFAULT '[]',
        sort_order INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS pickup_channels (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        name TEXT NOT NULL,
        allowed_weekdays_json TEXT NOT NULL DEFAULT '[1,2,3,4,5,6,7]',
        color_token TEXT NOT NULL DEFAULT 'sky',
        is_active INTEGER NOT NULL DEFAULT 1,
        sort_order INTEGER NOT NULL DEFAULT 0
      );

      CREATE TABLE IF NOT EXISTS daily_supply_entries (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        tracked_item_id INTEGER NOT NULL,
        date TEXT NOT NULL,
        actual_on_hand REAL,
        est_produced REAL,
        is_cascade_anchor INTEGER NOT NULL DEFAULT 0,
        buffer_override REAL,
        notes TEXT,
        FOREIGN KEY (tracked_item_id) REFERENCES tracked_items(id) ON DELETE CASCADE,
        UNIQUE (tracked_item_id, date)
      );

      CREATE TABLE IF NOT EXISTS standing_orders (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        customer_name TEXT NOT NULL,
        customer_contact TEXT,
        pickup_channel_id INTEGER,
        cadence TEXT NOT NULL DEFAULT 'weekly' CHECK (cadence IN ('weekly', 'biweekly', 'monthly')),
        weekday INTEGER NOT NULL CHECK (weekday BETWEEN 1 AND 7),
        start_date TEXT NOT NULL,
        is_active INTEGER NOT NULL DEFAULT 1,
        notes TEXT,
        items_json TEXT NOT NULL DEFAULT '[]',
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        FOREIGN KEY (pickup_channel_id) REFERENCES pickup_channels(id) ON DELETE SET NULL
      );

      CREATE TABLE IF NOT EXISTS standing_order_exceptions (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        standing_order_id INTEGER NOT NULL,
        occurrence_date TEXT NOT NULL,
        action TEXT NOT NULL CHECK (action IN ('skipped', 'modified', 'deleted')),
        override_order_id INTEGER,
        FOREIGN KEY (standing_order_id) REFERENCES standing_orders(id) ON DELETE CASCADE,
        UNIQUE (standing_order_id, occurrence_date)
      );

      CREATE TABLE IF NOT EXISTS orders (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        source TEXT NOT NULL DEFAULT 'manual' CHECK (source IN ('odoo', 'manual', 'standing')),
        status TEXT NOT NULL DEFAULT 'waitlist' CHECK (status IN ('waitlist', 'slotted', 'pre_approved', 'confirmed', 'ignored')),
        timing_type TEXT NOT NULL DEFAULT 'asap' CHECK (timing_type IN ('asap', 'specific_date')),
        requested_date TEXT,
        slotted_date TEXT,
        is_locked INTEGER NOT NULL DEFAULT 0,
        customer_name TEXT NOT NULL,
        customer_name_overridden INTEGER NOT NULL DEFAULT 0,
        customer_email TEXT,
        customer_phone TEXT,
        pickup_channel_id INTEGER,
        free_text_pickup TEXT,
        notes TEXT,
        pre_approved_at TEXT,
        standing_order_id INTEGER,
        standing_occurrence_date TEXT,
        odoo_quotation_id INTEGER UNIQUE,
        odoo_quotation_name TEXT,
        odoo_partner_id INTEGER,
        odoo_created_at_local TEXT,
        odoo_raw_notes TEXT,
        odoo_raw_lines_json TEXT NOT NULL DEFAULT '[]',
        odoo_updated_after_slot INTEGER NOT NULL DEFAULT 0,
        odoo_missing_flagged INTEGER NOT NULL DEFAULT 0,
        odoo_suggested_confirmed_json TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        FOREIGN KEY (pickup_channel_id) REFERENCES pickup_channels(id) ON DELETE SET NULL,
        FOREIGN KEY (standing_order_id) REFERENCES standing_orders(id) ON DELETE SET NULL
      );

      CREATE INDEX IF NOT EXISTS idx_orders_slotted_date ON orders(slotted_date);
      CREATE INDEX IF NOT EXISTS idx_orders_status ON orders(status);
      CREATE INDEX IF NOT EXISTS idx_orders_standing ON orders(standing_order_id, standing_occurrence_date);

      CREATE TABLE IF NOT EXISTS order_items (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        order_id INTEGER NOT NULL,
        tracked_item_id INTEGER NOT NULL,
        quantity REAL NOT NULL CHECK (quantity > 0),
        FOREIGN KEY (order_id) REFERENCES orders(id) ON DELETE CASCADE,
        FOREIGN KEY (tracked_item_id) REFERENCES tracked_items(id) ON DELETE CASCADE
      );

      CREATE INDEX IF NOT EXISTS idx_order_items_order ON order_items(order_id);

      CREATE TABLE IF NOT EXISTS order_chatter (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        order_id INTEGER NOT NULL,
        odoo_message_id INTEGER NOT NULL,
        author_name TEXT NOT NULL,
        message_type TEXT NOT NULL CHECK (message_type IN ('comment', 'email')),
        subtype_name TEXT,
        body_text TEXT NOT NULL,
        created_at_utc TEXT NOT NULL,
        created_at_local TEXT NOT NULL,
        FOREIGN KEY (order_id) REFERENCES orders(id) ON DELETE CASCADE,
        UNIQUE (order_id, odoo_message_id)
      );

      CREATE TABLE IF NOT EXISTS sync_logs (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        started_at TEXT NOT NULL,
        finished_at TEXT,
        status TEXT NOT NULL CHECK (status IN ('running', 'success', 'error')),
        fetched_count INTEGER NOT NULL DEFAULT 0,
        imported_count INTEGER NOT NULL DEFAULT 0,
        updated_count INTEGER NOT NULL DEFAULT 0,
        flagged_missing_count INTEGER NOT NULL DEFAULT 0,
        error_message TEXT
      );

      CREATE TABLE IF NOT EXISTS action_checkpoints (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        label TEXT NOT NULL,
        is_manual INTEGER NOT NULL DEFAULT 0,
        snapshot_json TEXT NOT NULL,
        created_at TEXT NOT NULL
      );
    `,
  },
  {
    version: 2,
    name: 'add_extra_buffer_and_channel_specific_dates',
    sql: `
      ALTER TABLE daily_supply_entries ADD COLUMN extra_buffer REAL NOT NULL DEFAULT 0;
      ALTER TABLE pickup_channels ADD COLUMN specific_dates_json TEXT NOT NULL DEFAULT '[]';
    `,
  },
  {
    version: 3,
    name: 'add_merged_odoo_links',
    sql: `
      CREATE TABLE IF NOT EXISTS merged_odoo_links (
        odoo_quotation_id INTEGER PRIMARY KEY,
        target_order_id INTEGER NOT NULL,
        odoo_quotation_name TEXT,
        merged_at TEXT NOT NULL,
        FOREIGN KEY (target_order_id) REFERENCES orders(id) ON DELETE CASCADE
      );
      CREATE INDEX IF NOT EXISTS idx_merged_odoo_links_target ON merged_odoo_links(target_order_id);
    `,
  },
];

const SQLITE_HEADER_MAGIC = Buffer.from('SQLite format 3\0', 'utf8');
const SAFE_BACKUP_FILENAME_RE = /^[a-zA-Z0-9._-]+\.db$/;

function formatBackupStamp(date: Date = new Date()): string {
  const pad = (n: number, len = 2) => String(n).padStart(len, '0');
  return `${date.getUTCFullYear()}${pad(date.getUTCMonth() + 1)}${pad(date.getUTCDate())}-${pad(date.getUTCHours())}${pad(date.getUTCMinutes())}${pad(date.getUTCSeconds())}-${pad(date.getUTCMilliseconds(), 3)}`;
}

function parseTriggerFromFilename(filename: string): BackupTrigger {
  if (filename.startsWith('pre-migrate-')) return 'pre-migrate';
  if (filename.startsWith('pre-restore-')) return 'pre-restore';
  if (filename.startsWith('scheduled-')) return 'scheduled';
  return 'manual';
}

export class DatabaseManager {
  public readonly dbPath: string;
  public readonly backupDir: string;
  private _db!: Database.Database;
  private migrations: Migration[];

  constructor(dbPath: string, backupDir: string, migrations: Migration[] = MIGRATIONS) {
    this.dbPath = path.resolve(dbPath);
    this.backupDir = path.resolve(backupDir);
    this.migrations = [...migrations].sort((a, b) => a.version - b.version);
    fs.mkdirSync(path.dirname(this.dbPath), { recursive: true });
    fs.mkdirSync(this.backupDir, { recursive: true });
    this.openConnection();
  }

  get db(): Database.Database {
    return this._db;
  }

  private openConnection(): void {
    this._db = new Database(this.dbPath);
    this._db.pragma('journal_mode = WAL');
    this._db.pragma('foreign_keys = ON');
    this._db.pragma('busy_timeout = 5000');
  }

  public close(): void {
    if (this._db && this._db.open) {
      this._db.close();
    }
  }

  /**
   * Runs pending versioned migrations automatically.
   * If any pending migration exists on an already-initialized database, saves a
   * pre-migrate-<timestamp>.db snapshot first via SQLite's online backup API.
   */
  public async init(defaultTimezone: string = DEFAULT_TIMEZONE): Promise<{
    appliedVersions: number[];
    preMigrateBackup: string | null;
  }> {
    this._db.exec(`
      CREATE TABLE IF NOT EXISTS schema_migrations (
        version INTEGER PRIMARY KEY,
        name TEXT NOT NULL,
        applied_at TEXT NOT NULL
      );
    `);

    const appliedRows = this._db
      .prepare('SELECT version FROM schema_migrations ORDER BY version ASC')
      .all() as Array<{ version: number }>;
    const appliedSet = new Set(appliedRows.map((r) => r.version));

    const pending = this.migrations.filter((m) => !appliedSet.has(m.version));
    let preMigrateBackup: string | null = null;

    // Only snapshot before migrating if the database already contains prior schema/data
    const existingTables = this._db
      .prepare(
        "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' AND name != 'schema_migrations'"
      )
      .all();

    if (pending.length > 0 && existingTables.length > 0) {
      const info = await this.createBackup('pre-migrate');
      preMigrateBackup = info.filename;
    }

    const appliedVersions: number[] = [];
    for (const migration of pending) {
      const runMigration = this._db.transaction(() => {
        this._db.exec(migration.sql);
        this._db
          .prepare('INSERT INTO schema_migrations (version, name, applied_at) VALUES (?, ?, ?)')
          .run(migration.version, migration.name, new Date().toISOString());
      });
      runMigration();
      appliedVersions.push(migration.version);
    }

    // Ensure default settings exist (blank-slate: zero sample items, channels, or orders!)
    this.ensureDefaultSettings(defaultTimezone);

    return { appliedVersions, preMigrateBackup };
  }

  private ensureDefaultSettings(defaultTimezone: string): void {
    const defaults: AppSettings = {
      ...DEFAULT_APP_SETTINGS,
      timezone: defaultTimezone || DEFAULT_TIMEZONE,
    };
    const now = new Date().toISOString();
    const stmt = this._db.prepare(
      'INSERT OR IGNORE INTO app_settings (key, value_json, updated_at) VALUES (?, ?, ?)'
    );
    const tx = this._db.transaction(() => {
      for (const [key, value] of Object.entries(defaults)) {
        stmt.run(key, JSON.stringify(value), now);
      }
    });
    tx();
  }

  public getSettings(): AppSettings {
    const rows = this._db
      .prepare('SELECT key, value_json FROM app_settings')
      .all() as Array<{ key: string; value_json: string }>;
    const merged: Record<string, unknown> = { ...DEFAULT_APP_SETTINGS };
    for (const row of rows) {
      try {
        merged[row.key] = JSON.parse(row.value_json);
      } catch {
        // Ignore malformed setting
      }
    }
    return merged as unknown as AppSettings;
  }

  public updateSettings(patch: Partial<AppSettings>): AppSettings {
    const current = this.getSettings();
    const next: AppSettings = { ...current, ...patch };
    const now = new Date().toISOString();
    const stmt = this._db.prepare(
      `INSERT INTO app_settings (key, value_json, updated_at) VALUES (?, ?, ?)
       ON CONFLICT(key) DO UPDATE SET value_json = excluded.value_json, updated_at = excluded.updated_at`
    );
    const tx = this._db.transaction(() => {
      for (const [key, value] of Object.entries(next)) {
        stmt.run(key, JSON.stringify(value), now);
      }
    });
    tx();
    return this.getSettings();
  }

  public async createBackup(trigger: BackupTrigger): Promise<BackupInfo> {
    fs.mkdirSync(this.backupDir, { recursive: true });
    const stamp = formatBackupStamp();
    const filename = `${trigger}-${stamp}.db`;
    const destPath = this.resolveSafeBackupPath(filename);
    await this._db.backup(destPath);
    const stat = fs.statSync(destPath);
    return {
      filename,
      trigger,
      sizeBytes: stat.size,
      createdAt: stat.mtime.toISOString(),
    };
  }

  public listBackups(): BackupInfo[] {
    if (!fs.existsSync(this.backupDir)) return [];
    const entries = fs.readdirSync(this.backupDir);
    const results: BackupInfo[] = [];
    for (const entry of entries) {
      if (!SAFE_BACKUP_FILENAME_RE.test(entry)) continue;
      const fullPath = path.join(this.backupDir, entry);
      const stat = fs.statSync(fullPath);
      if (!stat.isFile()) continue;
      results.push({
        filename: entry,
        trigger: parseTriggerFromFilename(entry),
        sizeBytes: stat.size,
        createdAt: stat.mtime.toISOString(),
      });
    }
    return results.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }

  public resolveSafeBackupPath(filename: string): string {
    if (!SAFE_BACKUP_FILENAME_RE.test(filename) || filename.includes('..')) {
      throw new Error('Invalid backup filename');
    }
    const baseDir = path.resolve(this.backupDir);
    const resolved = path.resolve(baseDir, filename);
    if (!resolved.startsWith(baseDir + path.sep)) {
      throw new Error('Backup path outside confined directory');
    }
    return resolved;
  }

  public validateSqliteFile(candidatePath: string): void {
    if (!fs.existsSync(candidatePath)) {
      throw new Error('Backup file not found');
    }
    const stat = fs.statSync(candidatePath);
    if (!stat.isFile() || stat.size < 100) {
      throw new Error('Uploaded file is not a valid SQLite database (file too small)');
    }
    const fd = fs.openSync(candidatePath, 'r');
    try {
      const header = Buffer.alloc(16);
      fs.readSync(fd, header, 0, 16, 0);
      if (!header.equals(SQLITE_HEADER_MAGIC)) {
        throw new Error('Uploaded file does not have a valid SQLite 3 file header');
      }
    } finally {
      fs.closeSync(fd);
    }

    let testDb: Database.Database | null = null;
    try {
      testDb = new Database(candidatePath, { readonly: true, fileMustExist: true });
      const rows = testDb.pragma('integrity_check') as Array<{ integrity_check: string }>;
      if (!rows.length || rows[0].integrity_check !== 'ok') {
        throw new Error('SQLite integrity check failed');
      }
    } catch (err) {
      throw new Error(
        `Invalid SQLite database: ${err instanceof Error ? err.message : 'corrupted file'}`
      );
    } finally {
      if (testDb && testDb.open) testDb.close();
    }
  }

  public async restoreFromFile(
    sourcePath: string,
    defaultTimezone: string = DEFAULT_TIMEZONE
  ): Promise<{ safetySnapshot: BackupInfo; appliedVersions: number[] }> {
    this.validateSqliteFile(sourcePath);

    // Automatically save a safety snapshot of the active database before overwriting
    const safetySnapshot = await this.createBackup('pre-restore');

    // Copy to temp path first in case sourcePath is inside backupDir or tmp upload
    const tempRestorePath = `${this.dbPath}.restoring`;
    fs.copyFileSync(sourcePath, tempRestorePath);

    try {
      this.close();
      for (const suffix of ['-wal', '-shm']) {
        const sidecar = `${this.dbPath}${suffix}`;
        if (fs.existsSync(sidecar)) {
          fs.unlinkSync(sidecar);
        }
      }
      fs.renameSync(tempRestorePath, this.dbPath);
      this.openConnection();
      const { appliedVersions } = await this.init(defaultTimezone);
      return { safetySnapshot, appliedVersions };
    } catch (err) {
      if (fs.existsSync(tempRestorePath)) {
        fs.unlinkSync(tempRestorePath);
      }
      if (!this._db || !this._db.open) {
        this.openConnection();
      }
      throw err;
    }
  }

  public pruneScheduledBackups(retentionDays: number): number {
    const keepCount = Math.max(1, Math.floor(retentionDays));
    const scheduled = this.listBackups().filter((b) => b.trigger === 'scheduled');
    let deleted = 0;
    for (let i = keepCount; i < scheduled.length; i++) {
      const target = this.resolveSafeBackupPath(scheduled[i].filename);
      if (fs.existsSync(target)) {
        fs.unlinkSync(target);
        deleted += 1;
      }
    }
    return deleted;
  }
}
