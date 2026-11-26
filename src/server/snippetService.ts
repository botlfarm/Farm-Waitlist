import {
  buildPublicAvailabilityJsonPayload,
  generateLiveEmbedHtml,
  generatePublicAvailability,
} from '../shared/generators';
import { projectDailySupply } from '../shared/supplyEngine';
import {
  DEFAULT_TIMEZONE,
  addDays,
  getMondayOfWeek,
  getTodayDateKey,
} from '../shared/timezone';
import type {
  AppSettings,
  GithubPublishStatus,
  PublicAvailabilityJsonPayload,
  PublicAvailabilityResult,
} from '../shared/types';
import { getRedactedGithubPublishStatus, type RuntimeConfig } from './config';
import type { DatabaseManager } from './db';
import {
  publishAvailabilityToGithub,
  type GithubPublishResult,
} from './githubPublisher';
import {
  listAllOrders,
  listDailySupplyEntries,
  listPickupChannels,
  listTrackedItems,
} from './repository';
import { materializeStandingOrders } from './standingEngine';

export interface BuiltSnippetBundle {
  snippet: PublicAvailabilityResult;
  jsonPayload: PublicAvailabilityJsonPayload;
  githubPublishStatus: GithubPublishStatus;
}

export function buildSnippetForDatabase(params: {
  dbManager: DatabaseManager;
  config: RuntimeConfig;
  weeksOverride?: number;
  now?: Date;
  accurateAsOf?: Date;
  skipMaterialize?: boolean;
}): BuiltSnippetBundle {
  const {
    dbManager,
    config,
    weeksOverride,
    now = new Date(),
    accurateAsOf,
    skipMaterialize = false,
  } = params;
  const db = dbManager.db;
  const settings = dbManager.getSettings();
  const timezone = settings.timezone || config.timezone || DEFAULT_TIMEZONE;
  const today = getTodayDateKey(timezone, now);
  const rawWeeks =
    weeksOverride !== undefined && Number.isFinite(weeksOverride) && weeksOverride > 0
      ? Math.floor(weeksOverride)
      : settings.publicSnippetWeeks || 3;
  const weeks = Math.max(1, Math.min(8, rawWeeks));

  const horizonWeeks = Math.max(6, weeks + 1);
  const startDate = getMondayOfWeek(today);
  const endDate = addDays(startDate, horizonWeeks * 7 - 1);

  if (!skipMaterialize && !dbManager.isBackupPreviewActive()) {
    materializeStandingOrders(db, today, endDate);
  }

  const items = listTrackedItems(db);
  const channels = listPickupChannels(db);
  const entries = listDailySupplyEntries(db);
  const activeOrders = listAllOrders(db).filter((o) => o.status !== 'ignored');

  const days = projectDailySupply({
    items,
    entries,
    orders: activeOrders,
    startDate,
    endDate,
    today,
  });

  const githubPublishStatus = getRedactedGithubPublishStatus(config, settings);
  const baseSnippet = generatePublicAvailability({
    items,
    days,
    channels,
    today,
    weeks,
    timezone,
    now,
    accurateAsOf,
    enabled: settings.publicSnippetEnabled !== false,
    pausedMessage: settings.publicSnippetPausedMessage,
    showSameDay: settings.publicSnippetShowSameDay !== false,
    cutoffRules: settings.publicSnippetCutoffRules ?? [],
    headerTitle: settings.publicSnippetHeaderTitle,
    headerText: settings.publicSnippetHeaderText,
    footerText: settings.publicSnippetFooterText,
    autoAdvanceToday: settings.publicSnippetAutoAdvanceToday ?? true,
  });

  const liveEmbedHtml = githubPublishStatus.publicUrl
    ? generateLiveEmbedHtml(githubPublishStatus.publicUrl)
    : null;

  const snippet: PublicAvailabilityResult = {
    ...baseSnippet,
    liveEmbedHtml,
    githubPublishStatus,
  };

  const jsonPayload = buildPublicAvailabilityJsonPayload(snippet, now);

  return {
    snippet,
    jsonPayload,
    githubPublishStatus,
  };
}

export async function publishSnippetSnapshotToGithub(params: {
  dbManager: DatabaseManager;
  config: RuntimeConfig;
  force?: boolean;
  /**
   * When true (used by background Automatic Sync), skips publishing unless:
   *  1. The user has made at least one availability-affecting edit since the last publish
   *     (preventing midnight date rollovers or cutoff clock ticks from refreshing "accurate as of"), AND
   *  2. At least `githubPublishIdleMinutes` of quiet time have elapsed since the latest edit
   *     (preventing half-finished edits from being pushed mid-session).
   */
  requireUserEdit?: boolean;
  overrides?: {
    repo?: string;
    branch?: string;
    filePath?: string;
    customPublicUrl?: string;
  };
  now?: Date;
  fetchFn?: typeof fetch;
}): Promise<
  GithubPublishResult & {
    githubPublishStatus: GithubPublishStatus;
    retryAfterMs?: number;
  }
> {
  const {
    dbManager,
    config,
    force = false,
    requireUserEdit = false,
    overrides,
    now = new Date(),
    fetchFn,
  } = params;
  const settings = dbManager.getSettings();

  if (!force && requireUserEdit) {
    const statusNow = getRedactedGithubPublishStatus(config, settings);
    const lastEditedMs = settings.availabilityLastEditedAt
      ? Date.parse(settings.availabilityLastEditedAt)
      : NaN;
    const lastPublishedMs = settings.githubLastPublishedAt
      ? Date.parse(settings.githubLastPublishedAt)
      : NaN;

    // Guardrail 1: Never auto-publish if the user has not edited availability since the last publish
    // (prevents midnight rollovers and ordering cutoff clock ticks from bumping "accurate as of").
    if (
      !Number.isFinite(lastEditedMs) ||
      (Number.isFinite(lastPublishedMs) && lastEditedMs <= lastPublishedMs)
    ) {
      return {
        published: false,
        skipped: true,
        reason: 'No user edits since last publish (midnight and clock rollovers are skipped)',
        hash: settings.githubLastPublishedHash ?? '',
        publicUrl: statusNow.publicUrl ?? '',
        publishedAt: settings.githubLastPublishedAt ?? now.toISOString(),
        githubPublishStatus: statusNow,
      };
    }

    // Guardrail 2: Wait for a quiet period after the most recent edit so mid-session changes settle.
    const idleMinutes = settings.githubPublishIdleMinutes ?? 15;
    const idleMs = Math.max(0, idleMinutes) * 60 * 1000;
    const elapsedMs = now.getTime() - lastEditedMs;
    if (idleMs > 0 && elapsedMs < idleMs) {
      const remainingMs = idleMs - elapsedMs;
      const remainingMin = Math.max(1, Math.ceil(remainingMs / 60000));
      return {
        published: false,
        skipped: true,
        reason: `Waiting ${remainingMin} min for recent edits to settle before auto-publishing`,
        retryAfterMs: remainingMs,
        hash: settings.githubLastPublishedHash ?? '',
        publicUrl: statusNow.publicUrl ?? '',
        publishedAt: settings.githubLastPublishedAt ?? now.toISOString(),
        githubPublishStatus: statusNow,
      };
    }
  }

  // For background auto-publishes, display the timestamp when the user actually edited
  // availability rather than when the background interval woke up (so a late-evening edit
  // never shows a 12:25 AM midnight timestamp). Manual "Publish to Website" uses `now`.
  const editedMsForDisplay =
    !force && requireUserEdit && settings.availabilityLastEditedAt
      ? Date.parse(settings.availabilityLastEditedAt)
      : NaN;
  const accurateAsOf = Number.isFinite(editedMsForDisplay) ? new Date(editedMsForDisplay) : now;

  const { jsonPayload } = buildSnippetForDatabase({ dbManager, config, now, accurateAsOf });

  const repo =
    (overrides?.repo ?? '').trim() ||
    (settings.githubPublishRepo ?? '').trim() ||
    (config.githubPublish?.defaultRepo ?? '').trim();
  const branch =
    (overrides?.branch ?? '').trim() || (settings.githubPublishBranch ?? '').trim() || 'main';
  const filePath =
    (overrides?.filePath ?? '').trim() ||
    (settings.githubPublishPath ?? '').trim() ||
    'availability.json';
  const customPublicUrl =
    overrides?.customPublicUrl !== undefined
      ? overrides.customPublicUrl.trim()
      : (settings.githubPublishPublicUrl ?? '').trim();

  try {
    const result = await publishAvailabilityToGithub({
      token: config.githubPublish?.token ?? '',
      repo,
      branch,
      filePath,
      customPublicUrl,
      payload: jsonPayload,
      previousHash: settings.githubLastPublishedHash ?? null,
      force,
      fetchFn,
    });

    if (result.published) {
      const updated = dbManager.updateSettings({
        githubLastPublishedAt: result.publishedAt,
        githubLastPublishedHash: result.hash,
        githubLastPublishStatus: 'success',
        githubLastPublishError: null,
      });
      return {
        ...result,
        githubPublishStatus: getRedactedGithubPublishStatus(config, updated),
      };
    }

    // Skipped (no semantic changes) — acknowledge any stale pending edit timestamp so it never
    // lingers until midnight when yesterday rolls into isPast, and clear stale errors.
    const ackPatch: Partial<AppSettings> = {};
    if (settings.githubLastPublishStatus === 'error') {
      ackPatch.githubLastPublishError = null;
    }
    const lastEditedMsNow = settings.availabilityLastEditedAt
      ? Date.parse(settings.availabilityLastEditedAt)
      : NaN;
    const lastPublishedMsNow = settings.githubLastPublishedAt
      ? Date.parse(settings.githubLastPublishedAt)
      : NaN;
    if (
      Number.isFinite(lastEditedMsNow) &&
      (!Number.isFinite(lastPublishedMsNow) || lastEditedMsNow > lastPublishedMsNow)
    ) {
      ackPatch.availabilityLastEditedAt = settings.githubLastPublishedAt ?? null;
    }
    const currentStatus =
      Object.keys(ackPatch).length > 0 ? dbManager.updateSettings(ackPatch) : settings;
    return {
      ...result,
      githubPublishStatus: getRedactedGithubPublishStatus(config, currentStatus),
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : 'GitHub publish failed';
    dbManager.updateSettings({
      githubLastPublishStatus: 'error',
      githubLastPublishError: message,
    });
    throw err;
  }
}
