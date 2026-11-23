import type { AppSettings, SyncInterval } from '../shared/types';
import type { RuntimeConfig } from './config';
import type { DatabaseManager } from './db';
import { syncOdooQuotations } from './odooService';
import { listPickupChannels, listTrackedItems } from './repository';

const INTERVAL_MS: Record<SyncInterval, number | null> = {
  '15m': 15 * 60 * 1000,
  '30m': 30 * 60 * 1000,
  '1h': 60 * 60 * 1000,
  '6h': 6 * 60 * 60 * 1000,
  manual: null,
};

const ONE_DAY_MS = 24 * 60 * 60 * 1000;

export class BackgroundScheduler {
  private dbManager: DatabaseManager;
  private config: RuntimeConfig;
  private odooTimer: ReturnType<typeof setInterval> | null = null;
  private backupTimer: ReturnType<typeof setInterval> | null = null;
  private syncInFlight = false;

  constructor(dbManager: DatabaseManager, config: RuntimeConfig) {
    this.dbManager = dbManager;
    this.config = config;
  }

  public start(): void {
    this.configure(this.dbManager.getSettings());
  }

  public configure(settings: AppSettings): void {
    this.stop();

    // 1. Odoo polling schedule
    const pollMs = INTERVAL_MS[settings.odooSyncInterval];
    if (pollMs && this.config.odoo.url && this.config.odoo.apiKey) {
      this.odooTimer = setInterval(() => {
        void this.runOdooSyncSafe();
      }, pollMs);
      this.odooTimer.unref?.();
    }

    // 2. Daily scheduled SQLite backup + retention pruning
    if (settings.backupScheduleEnabled) {
      this.backupTimer = setInterval(() => {
        void this.runScheduledBackupSafe();
      }, ONE_DAY_MS);
      this.backupTimer.unref?.();
    }
  }

  public stop(): void {
    if (this.odooTimer) {
      clearInterval(this.odooTimer);
      this.odooTimer = null;
    }
    if (this.backupTimer) {
      clearInterval(this.backupTimer);
      this.backupTimer = null;
    }
  }

  private async runOdooSyncSafe(): Promise<void> {
    if (this.syncInFlight) return;
    this.syncInFlight = true;
    try {
      const db = this.dbManager.db;
      await syncOdooQuotations({
        db,
        odoo: this.config.odoo,
        settings: this.dbManager.getSettings(),
        trackedItems: listTrackedItems(db),
        channels: listPickupChannels(db),
      });
    } catch (err) {
      console.error('[Farm Waitlist] Scheduled Odoo sync failed:', err instanceof Error ? err.message : err);
    } finally {
      this.syncInFlight = false;
    }
  }

  private async runScheduledBackupSafe(): Promise<void> {
    try {
      const settings = this.dbManager.getSettings();
      await this.dbManager.createBackup('scheduled');
      this.dbManager.pruneScheduledBackups(settings.backupRetentionDays);
    } catch (err) {
      console.error('[Farm Waitlist] Scheduled backup failed:', err instanceof Error ? err.message : err);
    }
  }
}
