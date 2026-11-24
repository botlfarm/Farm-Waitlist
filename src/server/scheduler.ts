import type { AppSettings, GithubPublishInterval, SyncInterval } from '../shared/types';
import type { RuntimeConfig } from './config';
import type { DatabaseManager } from './db';
import { syncOdooQuotations } from './odooService';
import { listPickupChannels, listTrackedItems } from './repository';
import { publishSnippetSnapshotToGithub } from './snippetService';

const INTERVAL_MS: Record<SyncInterval, number | null> = {
  '15m': 15 * 60 * 1000,
  '30m': 30 * 60 * 1000,
  '1h': 60 * 60 * 1000,
  '6h': 6 * 60 * 60 * 1000,
  manual: null,
};

const GITHUB_INTERVAL_MS: Record<GithubPublishInterval, number> = {
  '15m': 15 * 60 * 1000,
  '30m': 30 * 60 * 1000,
  '1h': 60 * 60 * 1000,
  '6h': 6 * 60 * 60 * 1000,
};

const ONE_DAY_MS = 24 * 60 * 60 * 1000;

export class BackgroundScheduler {
  private dbManager: DatabaseManager;
  private config: RuntimeConfig;
  private odooTimer: ReturnType<typeof setInterval> | null = null;
  private backupTimer: ReturnType<typeof setInterval> | null = null;
  private githubPublishTimer: ReturnType<typeof setInterval> | null = null;
  private githubRetryTimer: ReturnType<typeof setTimeout> | null = null;
  private syncInFlight = false;
  private githubPublishInFlight = false;

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

    // 3. Automatic change-only GitHub Pages availability publish
    const configuredRepo = (
      settings.githubPublishRepo ||
      this.config.githubPublish?.defaultRepo ||
      ''
    ).trim();
    if (
      settings.githubPublishMode === 'auto' &&
      this.config.githubPublish?.token &&
      configuredRepo
    ) {
      const intervalKey = settings.githubPublishInterval ?? '30m';
      const publishMs = GITHUB_INTERVAL_MS[intervalKey] ?? GITHUB_INTERVAL_MS['30m'];
      this.githubPublishTimer = setInterval(() => {
        void this.runGithubPublishSafe();
      }, publishMs);
      this.githubPublishTimer.unref?.();
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
    if (this.githubPublishTimer) {
      clearInterval(this.githubPublishTimer);
      this.githubPublishTimer = null;
    }
    if (this.githubRetryTimer) {
      clearTimeout(this.githubRetryTimer);
      this.githubRetryTimer = null;
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

  private async runGithubPublishSafe(): Promise<void> {
    if (this.githubPublishInFlight) return;
    this.githubPublishInFlight = true;
    try {
      const result = await publishSnippetSnapshotToGithub({
        dbManager: this.dbManager,
        config: this.config,
        force: false,
        requireUserEdit: true,
      });

      // If edits were too recent, schedule a single follow-up check right when the quiet window ends
      if (result.skipped && typeof result.retryAfterMs === 'number' && result.retryAfterMs > 0) {
        if (this.githubRetryTimer) {
          clearTimeout(this.githubRetryTimer);
        }
        const delayMs = Math.min(result.retryAfterMs + 1000, 60 * 60 * 1000);
        this.githubRetryTimer = setTimeout(() => {
          this.githubRetryTimer = null;
          void this.runGithubPublishSafe();
        }, delayMs);
        this.githubRetryTimer.unref?.();
      }
    } catch (err) {
      console.error(
        '[Farm Waitlist] Scheduled GitHub availability publish failed:',
        err instanceof Error ? err.message : err
      );
    } finally {
      this.githubPublishInFlight = false;
    }
  }
}
