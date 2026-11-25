import Database from 'better-sqlite3';
import fs from 'fs';
import path from 'path';
import {
  DEFAULT_PAUSED_SNIPPET_MESSAGE,
  DEFAULT_PUBLIC_SNIPPET_FOOTER,
  normalizeCutoffRules,
} from '../shared/generators';
import { DEFAULT_TIMEZONE } from '../shared/timezone';
import type {
  AppSettings,
  BackupInfo,
  BackupPreviewStatus,
  BackupTrigger,
  GithubPublishInterval,
  PreApprovalTemplate,
  SandboxStatus,
} from '../shared/types';

export interface Migration {
  version: number;
  name: string;
  sql: string;
}

const DEFAULT_EMAIL_TEMPLATE_BODY =
  "Hey {{name}}, you're pre-approved for {{items_summary}} on {{date}} ({{channel}}). Please place your order using the pre-approved option.";

const DEFAULT_SMS_TEMPLATE_BODY =
  "Hi {{name}}! You're pre-approved for {{items_summary}} on {{date}} ({{channel}}). Place your order using the pre-approved option.";

export function buildDefaultPreApprovalTemplates(
  legacyBody: string = DEFAULT_EMAIL_TEMPLATE_BODY
): PreApprovalTemplate[] {
  return [
    {
      id: 'default-email',
      name: 'Default Email',
      format: 'html',
      body: legacyBody || DEFAULT_EMAIL_TEMPLATE_BODY,
      isDefault: true,
      channelIds: [],
      itemIds: [],
    },
    {
      id: 'default-sms',
      name: 'Text / SMS',
      format: 'plain',
      body: DEFAULT_SMS_TEMPLATE_BODY,
      isDefault: false,
      channelIds: [],
      itemIds: [],
    },
  ];
}

function normalizePreApprovalTemplates(
  raw: unknown,
  legacyBody: string
): PreApprovalTemplate[] {
  if (!Array.isArray(raw) || raw.length === 0) {
    return buildDefaultPreApprovalTemplates(legacyBody);
  }
  const cleaned: PreApprovalTemplate[] = [];
  const seenIds = new Set<string>();
  for (let i = 0; i < raw.length; i += 1) {
    const entry = raw[i];
    if (!entry || typeof entry !== 'object') continue;
    const obj = entry as Record<string, unknown>;
    const rawId = typeof obj.id === 'string' && obj.id.trim() ? obj.id.trim() : `tmpl-${i + 1}`;
    const id = seenIds.has(rawId) ? `${rawId}-${i + 1}` : rawId;
    seenIds.add(id);
    const name = typeof obj.name === 'string' && obj.name.trim() ? obj.name.trim() : `Template ${i + 1}`;
    const format = obj.format === 'plain' ? 'plain' : 'html';
    const body = typeof obj.body === 'string' ? obj.body : '';
    const channelIds = Array.isArray(obj.channelIds)
      ? Array.from(
          new Set(
            obj.channelIds
              .map((v) => Number(v))
              .filter((n) => Number.isInteger(n) && n > 0)
          )
        )
      : [];
    const itemIds = Array.isArray(obj.itemIds)
      ? Array.from(
          new Set(
            obj.itemIds
              .map((v) => Number(v))
              .filter((n) => Number.isInteger(n) && n > 0)
          )
        )
      : [];
    cleaned.push({
      id,
      name,
      format,
      body,
      isDefault: Boolean(obj.isDefault),
      channelIds,
      itemIds,
    });
  }
  if (cleaned.length === 0) {
    return buildDefaultPreApprovalTemplates(legacyBody);
  }
  // Guarantee exactly one default template
  const firstDefaultIdx = cleaned.findIndex((t) => t.isDefault);
  const chosenDefaultIdx = firstDefaultIdx >= 0 ? firstDefaultIdx : 0;
  return cleaned.map((t, idx) => ({ ...t, isDefault: idx === chosenDefaultIdx }));
}

export const DEFAULT_APP_SETTINGS: AppSettings = {
  timezone: DEFAULT_TIMEZONE,
  odooSyncInterval: 'manual',
  odooSyncCutoffDate: null,
  odooIgnoredDateRanges: [],
  preApprovalTemplate: DEFAULT_EMAIL_TEMPLATE_BODY,
  preApprovalTemplates: buildDefaultPreApprovalTemplates(DEFAULT_EMAIL_TEMPLATE_BODY),
  holdThresholdHours: 48,
  backupScheduleEnabled: true,
  backupRetentionDays: 14,
  publicSnippetWeeks: 3,
  publicSnippetEnabled: true,
  publicSnippetPausedPreset: 'unknown',
  publicSnippetPausedMessage: DEFAULT_PAUSED_SNIPPET_MESSAGE,
  publicSnippetShowSameDay: true,
  publicSnippetCutoffRules: [],
  publicSnippetHeaderTitle: '',
  publicSnippetHeaderText: '',
  publicSnippetFooterText: DEFAULT_PUBLIC_SNIPPET_FOOTER,
  publicSnippetAutoAdvanceToday: true,
  githubPublishMode: 'manual',
  githubPublishInterval: '30m',
  githubPublishIdleMinutes: 15,
  githubPublishRepo: '',
  githubPublishBranch: 'main',
  githubPublishPath: 'availability.json',
  githubPublishPublicUrl: '',
  githubLastPublishedAt: null,
  githubLastPublishedHash: null,
  githubLastPublishStatus: 'never',
  githubLastPublishError: null,
  availabilityLastEditedAt: null,
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
  {
    version: 4,
    name: 'add_actual_end_of_day',
    sql: `
      ALTER TABLE daily_supply_entries ADD COLUMN actual_end_of_day REAL;
    `,
  },
  {
    version: 5,
    name: 'add_waitlist_sort_order',
    sql: `
      ALTER TABLE orders ADD COLUMN waitlist_sort_order INTEGER;
    `,
  },
  {
    version: 6,
    name: 'add_dismissed_duplicate_pairs',
    sql: `
      CREATE TABLE IF NOT EXISTS dismissed_duplicate_pairs (
        order_id_a INTEGER NOT NULL,
        order_id_b INTEGER NOT NULL,
        dismissed_at TEXT NOT NULL,
        PRIMARY KEY (order_id_a, order_id_b),
        FOREIGN KEY (order_id_a) REFERENCES orders(id) ON DELETE CASCADE,
        FOREIGN KEY (order_id_b) REFERENCES orders(id) ON DELETE CASCADE
      );
      CREATE INDEX IF NOT EXISTS idx_dismissed_dup_b ON dismissed_duplicate_pairs(order_id_b);
    `,
  },
  {
    version: 7,
    name: 'add_odoo_customers',
    sql: `
      CREATE TABLE IF NOT EXISTS odoo_customers (
        odoo_partner_id INTEGER PRIMARY KEY,
        name TEXT NOT NULL,
        email TEXT,
        phone TEXT,
        updated_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_odoo_customers_name ON odoo_customers(name COLLATE NOCASE);
    `,
  },
  {
    version: 8,
    name: 'add_odoo_missing_dismissed',
    sql: `
      ALTER TABLE orders ADD COLUMN odoo_missing_dismissed INTEGER NOT NULL DEFAULT 0;
    `,
  },
  {
    version: 9,
    name: 'add_daily_self_consumption',
    sql: `
      ALTER TABLE daily_supply_entries ADD COLUMN self_consumption REAL NOT NULL DEFAULT 0;
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
  if (filename.startsWith('pre-sandbox-')) return 'pre-sandbox';
  if (filename.startsWith('scheduled-')) return 'scheduled';
  return 'manual';
}

export class DatabaseManager {
  public readonly dbPath: string;
  public readonly sandboxDbPath: string;
  public readonly previewDbPath: string;
  public readonly backupDir: string;
  private _db!: Database.Database;
  private migrations: Migration[];
  private _sandboxActive = false;
  private _sandboxStartedAt: string | null = null;
  private _sandboxSnapshotFilename: string | null = null;
  private _backupPreviewActive = false;
  private _backupPreviewFilename: string | null = null;
  private _backupPreviewStartedAt: string | null = null;
  private _backupPreviewCreatedAt: string | null = null;

  constructor(dbPath: string, backupDir: string, migrations: Migration[] = MIGRATIONS) {
    this.dbPath = path.resolve(dbPath);
    const parsedDb = path.parse(this.dbPath);
    this.sandboxDbPath = path.join(parsedDb.dir, `${parsedDb.name}.sandbox${parsedDb.ext || '.db'}`);
    this.previewDbPath = path.join(parsedDb.dir, `${parsedDb.name}.preview${parsedDb.ext || '.db'}`);
    this.backupDir = path.resolve(backupDir);
    this.migrations = [...migrations].sort((a, b) => a.version - b.version);
    fs.mkdirSync(path.dirname(this.dbPath), { recursive: true });
    fs.mkdirSync(this.backupDir, { recursive: true });
    // Always discard any leftover sandbox or preview files from an interrupted run and boot into the live DB
    this.cleanupSandboxFiles();
    this.cleanupPreviewFiles();
    this.openConnection(this.dbPath);
  }

  get db(): Database.Database {
    return this._db;
  }

  public isSandboxActive(): boolean {
    return this._sandboxActive;
  }

  public isBackupPreviewActive(): boolean {
    return this._backupPreviewActive;
  }

  public isNonLiveMode(): boolean {
    return this._sandboxActive || this._backupPreviewActive;
  }

  public getSandboxStatus(): SandboxStatus {
    return {
      active: this._sandboxActive,
      startedAt: this._sandboxStartedAt,
      snapshotFilename: this._sandboxSnapshotFilename,
    };
  }

  public getBackupPreviewStatus(): BackupPreviewStatus {
    return {
      active: this._backupPreviewActive,
      filename: this._backupPreviewFilename,
      startedAt: this._backupPreviewStartedAt,
      backupCreatedAt: this._backupPreviewCreatedAt,
    };
  }

  private cleanupSandboxFiles(): void {
    for (const candidate of [
      this.sandboxDbPath,
      `${this.sandboxDbPath}-wal`,
      `${this.sandboxDbPath}-shm`,
    ]) {
      if (fs.existsSync(candidate)) {
        try {
          fs.unlinkSync(candidate);
        } catch {
          // Ignore transient cleanup failure if file was already removed
        }
      }
    }
  }

  private cleanupPreviewFiles(): void {
    for (const candidate of [
      this.previewDbPath,
      `${this.previewDbPath}-wal`,
      `${this.previewDbPath}-shm`,
    ]) {
      if (fs.existsSync(candidate)) {
        try {
          fs.unlinkSync(candidate);
        } catch {
          // Ignore transient cleanup failure if file was already removed
        }
      }
    }
  }

  private openConnection(targetPath: string = this.dbPath, readonly = false): void {
    if (readonly) {
      this._db = new Database(targetPath, { readonly: true, fileMustExist: true });
      this._db.pragma('busy_timeout = 5000');
      return;
    }
    this._db = new Database(targetPath);
    this._db.pragma('journal_mode = WAL');
    this._db.pragma('foreign_keys = ON');
    this._db.pragma('busy_timeout = 5000');
  }

  public close(): void {
    if (this._db && this._db.open) {
      this._db.close();
    }
    if (this._sandboxActive) {
      this.cleanupSandboxFiles();
      this._sandboxActive = false;
      this._sandboxStartedAt = null;
      this._sandboxSnapshotFilename = null;
    }
    if (this._backupPreviewActive) {
      this.cleanupPreviewFiles();
      this._backupPreviewActive = false;
      this._backupPreviewFilename = null;
      this._backupPreviewStartedAt = null;
      this._backupPreviewCreatedAt = null;
    }
  }

  /**
   * Starts Sandbox Mode safely:
   * 1. Creates a full safety backup snapshot of the live database in BACKUP_DIR (`pre-sandbox-*.db`).
   * 2. Duplicates the live database into a separate temporary sandbox SQLite file.
   * 3. Switches the active SQLite connection to the sandbox duplicate while leaving the live file untouched.
   */
  public async enterSandbox(): Promise<{ sandboxStatus: SandboxStatus; backup: BackupInfo }> {
    if (this._sandboxActive) {
      throw new Error('Sandbox Mode is already active');
    }
    if (this._backupPreviewActive) {
      throw new Error('Exit Backup Preview before entering Sandbox Mode');
    }

    const backup = await this.createBackup('pre-sandbox');
    this.cleanupSandboxFiles();

    try {
      await this._db.backup(this.sandboxDbPath);
      if (this._db && this._db.open) {
        this._db.close();
      }
      this.openConnection(this.sandboxDbPath);
      this._sandboxActive = true;
      this._sandboxStartedAt = new Date().toISOString();
      this._sandboxSnapshotFilename = backup.filename;
      return {
        sandboxStatus: this.getSandboxStatus(),
        backup,
      };
    } catch (err) {
      this.cleanupSandboxFiles();
      this._sandboxActive = false;
      this._sandboxStartedAt = null;
      this._sandboxSnapshotFilename = null;
      if (!this._db || !this._db.open) {
        this.openConnection(this.dbPath);
      }
      throw err;
    }
  }

  /**
   * Exits Sandbox Mode, discards the temporary sandbox database, and reconnects to the untouched live database.
   */
  public exitSandbox(): { sandboxStatus: SandboxStatus } {
    if (!this._sandboxActive) {
      return { sandboxStatus: this.getSandboxStatus() };
    }

    if (this._db && this._db.open) {
      this._db.close();
    }
    this.cleanupSandboxFiles();
    this._sandboxActive = false;
    this._sandboxStartedAt = null;
    this._sandboxSnapshotFilename = null;
    this.openConnection(this.dbPath);
    return { sandboxStatus: this.getSandboxStatus() };
  }

  /**
   * Opens a stored backup snapshot in strict Read-Only Preview Mode:
   * 1. Validates the filename & SQLite integrity without touching the original backup file.
   * 2. Copies it to a temporary preview file and applies any missing read-compatibility migrations
   *    (so older backups can still be inspected without errors or modifying BACKUP_DIR).
   * 3. Reopens the temporary copy with `{ readonly: true }` so zero writes can occur.
   */
  public enterBackupPreview(
    filename: string,
    defaultTimezone: string = DEFAULT_TIMEZONE
  ): { backupPreviewStatus: BackupPreviewStatus } {
    if (this._sandboxActive) {
      throw new Error('Exit Sandbox Mode before previewing a backup');
    }

    const safePath = this.resolveSafeBackupPath(filename);
    this.validateSqliteFile(safePath);
    const stat = fs.statSync(safePath);

    try {
      if (this._db && this._db.open) {
        this._db.close();
      }
      this.cleanupPreviewFiles();
      fs.copyFileSync(safePath, this.previewDbPath);

      // Bring older backup copies up to current read schema in-place on the temp copy only,
      // switching journal_mode back to DELETE so the readonly connection needs no -wal/-shm files.
      const prepDb = new Database(this.previewDbPath);
      try {
        prepDb.pragma('journal_mode = DELETE');
        prepDb.pragma('foreign_keys = ON');
        prepDb.exec(`
          CREATE TABLE IF NOT EXISTS schema_migrations (
            version INTEGER PRIMARY KEY,
            name TEXT NOT NULL,
            applied_at TEXT NOT NULL
          );
        `);
        const appliedRows = prepDb
          .prepare('SELECT version FROM schema_migrations ORDER BY version ASC')
          .all() as Array<{ version: number }>;
        const appliedSet = new Set(appliedRows.map((r) => r.version));
        const pending = this.migrations.filter((m) => !appliedSet.has(m.version));
        for (const migration of pending) {
          const runMigration = prepDb.transaction(() => {
            prepDb.exec(migration.sql);
            prepDb
              .prepare('INSERT INTO schema_migrations (version, name, applied_at) VALUES (?, ?, ?)')
              .run(migration.version, migration.name, new Date().toISOString());
          });
          runMigration();
        }
        // Ensure default settings rows exist in temp copy if previewing a very early backup
        const defaults: AppSettings = {
          ...DEFAULT_APP_SETTINGS,
          timezone: defaultTimezone || DEFAULT_TIMEZONE,
        };
        const now = new Date().toISOString();
        const stmt = prepDb.prepare(
          'INSERT OR IGNORE INTO app_settings (key, value_json, updated_at) VALUES (?, ?, ?)'
        );
        const seedTx = prepDb.transaction(() => {
          for (const [key, value] of Object.entries(defaults)) {
            stmt.run(key, JSON.stringify(value), now);
          }
        });
        seedTx();
      } finally {
        if (prepDb.open) prepDb.close();
      }

      this.openConnection(this.previewDbPath, true);
      this._backupPreviewActive = true;
      this._backupPreviewFilename = filename;
      this._backupPreviewStartedAt = new Date().toISOString();
      this._backupPreviewCreatedAt = stat.mtime.toISOString();

      return { backupPreviewStatus: this.getBackupPreviewStatus() };
    } catch (err) {
      if (this._db && this._db.open) {
        this._db.close();
      }
      this.cleanupPreviewFiles();
      this._backupPreviewActive = false;
      this._backupPreviewFilename = null;
      this._backupPreviewStartedAt = null;
      this._backupPreviewCreatedAt = null;
      this.openConnection(this.dbPath);
      throw err;
    }
  }

  /**
   * Exits Read-Only Backup Preview Mode, deletes the temporary preview file, and reconnects to the live database.
   */
  public exitBackupPreview(): { backupPreviewStatus: BackupPreviewStatus } {
    if (!this._backupPreviewActive) {
      return { backupPreviewStatus: this.getBackupPreviewStatus() };
    }

    if (this._db && this._db.open) {
      this._db.close();
    }
    this.cleanupPreviewFiles();
    this._backupPreviewActive = false;
    this._backupPreviewFilename = null;
    this._backupPreviewStartedAt = null;
    this._backupPreviewCreatedAt = null;
    this.openConnection(this.dbPath);
    return { backupPreviewStatus: this.getBackupPreviewStatus() };
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
    let hasExplicitTemplates = false;
    for (const row of rows) {
      try {
        merged[row.key] = JSON.parse(row.value_json);
        if (row.key === 'preApprovalTemplates') {
          hasExplicitTemplates = true;
        }
      } catch {
        // Ignore malformed setting
      }
    }
    const legacyBody =
      typeof merged.preApprovalTemplate === 'string' && merged.preApprovalTemplate
        ? merged.preApprovalTemplate
        : DEFAULT_EMAIL_TEMPLATE_BODY;
    const templates = normalizePreApprovalTemplates(
      hasExplicitTemplates ? merged.preApprovalTemplates : null,
      legacyBody
    );
    const defaultTemplate = templates.find((t) => t.isDefault) ?? templates[0];
    merged.preApprovalTemplates = templates;
    merged.preApprovalTemplate = defaultTemplate?.body ?? legacyBody;

    const rawWeeks = Number(merged.publicSnippetWeeks);
    merged.publicSnippetWeeks = Number.isFinite(rawWeeks)
      ? Math.max(1, Math.min(8, Math.floor(rawWeeks)))
      : 3;
    merged.publicSnippetEnabled = merged.publicSnippetEnabled !== false;
    merged.publicSnippetPausedPreset =
      typeof merged.publicSnippetPausedPreset === 'string' && merged.publicSnippetPausedPreset.trim()
        ? merged.publicSnippetPausedPreset.trim()
        : 'unknown';
    merged.publicSnippetPausedMessage =
      typeof merged.publicSnippetPausedMessage === 'string'
        ? merged.publicSnippetPausedMessage
        : DEFAULT_PAUSED_SNIPPET_MESSAGE;
    merged.publicSnippetShowSameDay = merged.publicSnippetShowSameDay !== false;
    merged.publicSnippetCutoffRules = normalizeCutoffRules(merged.publicSnippetCutoffRules);
    merged.githubPublishMode = merged.githubPublishMode === 'auto' ? 'auto' : 'manual';
    const validIntervals: GithubPublishInterval[] = ['15m', '30m', '1h', '6h'];
    merged.githubPublishInterval = validIntervals.includes(
      merged.githubPublishInterval as GithubPublishInterval
    )
      ? merged.githubPublishInterval
      : '30m';
    const rawIdle = Number(merged.githubPublishIdleMinutes);
    merged.githubPublishIdleMinutes = Number.isFinite(rawIdle)
      ? Math.max(0, Math.min(120, Math.floor(rawIdle)))
      : 15;
    merged.githubPublishRepo =
      typeof merged.githubPublishRepo === 'string' ? merged.githubPublishRepo.trim() : '';
    merged.githubPublishBranch =
      typeof merged.githubPublishBranch === 'string' && merged.githubPublishBranch.trim()
        ? merged.githubPublishBranch.trim()
        : 'main';
    merged.githubPublishPath =
      typeof merged.githubPublishPath === 'string' && merged.githubPublishPath.trim()
        ? merged.githubPublishPath.trim()
        : 'availability.json';
    merged.githubPublishPublicUrl =
      typeof merged.githubPublishPublicUrl === 'string' ? merged.githubPublishPublicUrl.trim() : '';
    merged.availabilityLastEditedAt =
      typeof merged.availabilityLastEditedAt === 'string' && merged.availabilityLastEditedAt.trim()
        ? merged.availabilityLastEditedAt.trim()
        : null;

    return merged as unknown as AppSettings;
  }

  public updateSettings(patch: Partial<AppSettings>): AppSettings {
    const current = this.getSettings();
    const next: AppSettings = { ...current, ...patch };

    if (patch.publicSnippetWeeks !== undefined) {
      const parsed = Number(patch.publicSnippetWeeks);
      next.publicSnippetWeeks = Number.isFinite(parsed)
        ? Math.max(1, Math.min(8, Math.floor(parsed)))
        : current.publicSnippetWeeks;
    }

    if (patch.publicSnippetCutoffRules !== undefined) {
      next.publicSnippetCutoffRules = normalizeCutoffRules(patch.publicSnippetCutoffRules);
    }

    if (patch.githubPublishMode !== undefined) {
      next.githubPublishMode = patch.githubPublishMode === 'auto' ? 'auto' : 'manual';
    }

    if (patch.githubPublishInterval !== undefined) {
      const validIntervals: GithubPublishInterval[] = ['15m', '30m', '1h', '6h'];
      next.githubPublishInterval = validIntervals.includes(patch.githubPublishInterval)
        ? patch.githubPublishInterval
        : current.githubPublishInterval ?? '30m';
    }

    if (patch.githubPublishIdleMinutes !== undefined) {
      const parsedIdle = Number(patch.githubPublishIdleMinutes);
      next.githubPublishIdleMinutes = Number.isFinite(parsedIdle)
        ? Math.max(0, Math.min(120, Math.floor(parsedIdle)))
        : current.githubPublishIdleMinutes ?? 15;
    }

    if (patch.githubPublishRepo !== undefined) {
      next.githubPublishRepo = String(patch.githubPublishRepo ?? '').trim();
    }
    if (patch.githubPublishBranch !== undefined) {
      next.githubPublishBranch = String(patch.githubPublishBranch ?? '').trim() || 'main';
    }
    if (patch.githubPublishPath !== undefined) {
      next.githubPublishPath = String(patch.githubPublishPath ?? '').trim() || 'availability.json';
    }
    if (patch.githubPublishPublicUrl !== undefined) {
      next.githubPublishPublicUrl = String(patch.githubPublishPublicUrl ?? '').trim();
    }
    if (patch.availabilityLastEditedAt !== undefined) {
      next.availabilityLastEditedAt =
        typeof patch.availabilityLastEditedAt === 'string' && patch.availabilityLastEditedAt.trim()
          ? patch.availabilityLastEditedAt.trim()
          : null;
    }

    if (Array.isArray(patch.preApprovalTemplates)) {
      const normalized = normalizePreApprovalTemplates(
        patch.preApprovalTemplates,
        next.preApprovalTemplate
      );
      next.preApprovalTemplates = normalized;
      const defaultTmpl = normalized.find((t) => t.isDefault) ?? normalized[0];
      if (defaultTmpl) {
        next.preApprovalTemplate = defaultTmpl.body;
      }
    } else if (typeof patch.preApprovalTemplate === 'string') {
      // Legacy callers updating only preApprovalTemplate sync the default template body too
      const existingList = normalizePreApprovalTemplates(
        current.preApprovalTemplates,
        patch.preApprovalTemplate
      );
      next.preApprovalTemplates = existingList.map((t) =>
        t.isDefault ? { ...t, body: patch.preApprovalTemplate! } : t
      );
    }

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

  /**
   * Records that the user made an explicit edit affecting public availability (orders, supply counts,
   * items, channels, standing orders, or snippet configuration). Used by Automatic Sync to ensure
   * pushes only happen after real user edits have settled — never on midnight or clock rollovers.
   */
  public markAvailabilityEdited(now: Date = new Date()): string {
    const iso = now.toISOString();
    if (this._backupPreviewActive) {
      return iso;
    }
    this._db
      .prepare(
        `INSERT INTO app_settings (key, value_json, updated_at) VALUES (?, ?, ?)
         ON CONFLICT(key) DO UPDATE SET value_json = excluded.value_json, updated_at = excluded.updated_at`
      )
      .run('availabilityLastEditedAt', JSON.stringify(iso), iso);
    return iso;
  }

  public async createBackup(trigger: BackupTrigger): Promise<BackupInfo> {
    if (this._sandboxActive) {
      throw new Error('Exit Sandbox Mode before creating live database backups');
    }
    if (this._backupPreviewActive) {
      throw new Error('Exit Backup Preview before creating live database backups');
    }
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
    if (this._sandboxActive) {
      throw new Error('Exit Sandbox Mode before restoring a live database backup');
    }
    this.validateSqliteFile(sourcePath);

    // If currently previewing a backup, exit preview first so the pre-restore snapshot captures the LIVE database
    if (this._backupPreviewActive) {
      this.exitBackupPreview();
    }

    // Automatically save a safety snapshot of the active live database before overwriting
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
