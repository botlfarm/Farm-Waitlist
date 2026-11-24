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
}): BuiltSnippetBundle {
  const { dbManager, config, weeksOverride, now = new Date() } = params;
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

  materializeStandingOrders(db, today, endDate);

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
  overrides?: {
    repo?: string;
    branch?: string;
    filePath?: string;
    customPublicUrl?: string;
  };
  now?: Date;
  fetchFn?: typeof fetch;
}): Promise<GithubPublishResult & { githubPublishStatus: GithubPublishStatus }> {
  const { dbManager, config, force = false, overrides, now = new Date(), fetchFn } = params;
  const settings = dbManager.getSettings();
  const { jsonPayload } = buildSnippetForDatabase({ dbManager, config, now });

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

    // Skipped (no semantic changes) — clear stale error while preserving lastPublishedAt/Hash
    const currentStatus = settings.githubLastPublishStatus === 'error'
      ? dbManager.updateSettings({ githubLastPublishError: null })
      : settings;
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
