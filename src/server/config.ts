import fs from 'fs';
import path from 'path';
import { DEFAULT_TIMEZONE } from '../shared/timezone';
import type { AppSettings, GithubPublishStatus, OdooConnectionStatus } from '../shared/types';
import { deriveGithubPagesPublicUrl } from './githubPublisher';

export interface OdooCredentials {
  url: string;
  db: string;
  apiKey: string;
  source: 'ha_options' | 'env' | 'none';
}

export interface GithubPublishCredentials {
  token: string;
  defaultRepo: string;
  source: 'ha_options' | 'env' | 'none';
}

export interface RuntimeConfig {
  port: number;
  dbPath: string;
  backupDir: string;
  haOptionsPath: string;
  timezone: string;
  odoo: OdooCredentials;
  githubPublish?: GithubPublishCredentials;
}

interface HaOptionsFile {
  odoo_url?: string;
  odoo_base_url?: string;
  odoo_db?: string;
  odoo_api_key?: string;
  github_publish_token?: string;
  github_publish_repo?: string;
  timezone?: string;
}

function readHaOptions(optionsPath: string): HaOptionsFile | null {
  try {
    if (!fs.existsSync(optionsPath)) return null;
    const raw = fs.readFileSync(optionsPath, 'utf-8');
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === 'object') {
      return parsed as HaOptionsFile;
    }
    return null;
  } catch {
    return null;
  }
}

export function normalizeOdooBaseUrl(rawUrl: string): string {
  const trimmed = rawUrl.trim();
  if (!trimmed) return '';
  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    return '';
  }
  if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
    return '';
  }
  const cleanedPath = parsed.pathname
    .replace(/\/(odoo|web|json\/2|jsonrpc|xmlrpc)(\/.*)?$/i, '')
    .replace(/\/+$/, '');
  return `${parsed.origin}${cleanedPath}`;
}

export function loadRuntimeConfig(overrides?: Partial<RuntimeConfig>): RuntimeConfig {
  const haOptionsPath = overrides?.haOptionsPath ?? process.env.HA_OPTIONS_PATH ?? '/data/options.json';
  const haOpts = readHaOptions(haOptionsPath);

  const hasHaDataDir = fs.existsSync('/data') && fs.statSync('/data').isDirectory();
  const defaultDbPath = hasHaDataDir ? '/data/waitlist.db' : path.resolve(process.cwd(), 'data', 'waitlist.db');
  const defaultBackupDir = hasHaDataDir ? '/data/backups' : path.resolve(process.cwd(), 'data', 'backups');

  const port = overrides?.port ?? Number(process.env.PORT || 3000);
  const dbPath = overrides?.dbPath ?? process.env.DB_PATH ?? defaultDbPath;
  const backupDir = overrides?.backupDir ?? process.env.BACKUP_DIR ?? defaultBackupDir;
  const timezone =
    overrides?.timezone ??
    (haOpts?.timezone?.trim() || process.env.TZ?.trim() || DEFAULT_TIMEZONE);

  let odoo: OdooCredentials = {
    url: '',
    db: '',
    apiKey: '',
    source: 'none',
  };

  const haUrl = haOpts?.odoo_url || haOpts?.odoo_base_url || '';
  const envUrl = process.env.ODOO_BASE_URL || process.env.ODOO_URL || '';

  if (overrides?.odoo) {
    odoo = overrides.odoo;
  } else if (haOpts && (haUrl || haOpts.odoo_api_key || haOpts.odoo_db)) {
    odoo = {
      url: normalizeOdooBaseUrl(haUrl),
      db: (haOpts.odoo_db ?? '').trim(),
      apiKey: (haOpts.odoo_api_key ?? '').trim(),
      source: 'ha_options',
    };
  } else if (envUrl || process.env.ODOO_API_KEY || process.env.ODOO_DB) {
    odoo = {
      url: normalizeOdooBaseUrl(envUrl),
      db: (process.env.ODOO_DB ?? '').trim(),
      apiKey: (process.env.ODOO_API_KEY ?? '').trim(),
      source: 'env',
    };
  }

  let githubPublish: GithubPublishCredentials = {
    token: '',
    defaultRepo: '',
    source: 'none',
  };

  if (overrides?.githubPublish) {
    githubPublish = overrides.githubPublish;
  } else if (haOpts && (haOpts.github_publish_token || haOpts.github_publish_repo)) {
    githubPublish = {
      token: (haOpts.github_publish_token ?? '').trim(),
      defaultRepo: (haOpts.github_publish_repo ?? '').trim(),
      source: (haOpts.github_publish_token ?? '').trim() ? 'ha_options' : 'none',
    };
  } else if (process.env.GITHUB_PUBLISH_TOKEN || process.env.GITHUB_PUBLISH_REPO) {
    githubPublish = {
      token: (process.env.GITHUB_PUBLISH_TOKEN ?? '').trim(),
      defaultRepo: (process.env.GITHUB_PUBLISH_REPO ?? '').trim(),
      source: (process.env.GITHUB_PUBLISH_TOKEN ?? '').trim() ? 'env' : 'none',
    };
  }

  return {
    port,
    dbPath,
    backupDir,
    haOptionsPath,
    timezone,
    odoo,
    githubPublish,
  };
}

export function getRedactedOdooStatus(config: RuntimeConfig): OdooConnectionStatus {
  const configured = Boolean(config.odoo.url && config.odoo.apiKey);
  let urlHost: string | null = null;
  if (config.odoo.url) {
    try {
      urlHost = new URL(config.odoo.url).host;
    } catch {
      urlHost = null;
    }
  }
  return {
    configured,
    source: configured ? config.odoo.source : 'none',
    urlHost,
    database: config.odoo.db || null,
  };
}

export function getRedactedGithubPublishStatus(
  config: RuntimeConfig,
  settings: AppSettings
): GithubPublishStatus {
  const tokenConfigured = Boolean(config.githubPublish?.token);
  const repo = (settings.githubPublishRepo ?? '').trim() || config.githubPublish?.defaultRepo || '';
  const branch = (settings.githubPublishBranch ?? '').trim() || 'main';
  const filePath = (settings.githubPublishPath ?? '').trim() || 'availability.json';
  const customUrl = (settings.githubPublishPublicUrl ?? '').trim();
  const publicUrl = deriveGithubPagesPublicUrl(repo, filePath, customUrl);

  const lastPublishedAt = settings.githubLastPublishedAt ?? null;
  const lastEditedAt = settings.availabilityLastEditedAt ?? null;
  const lastEditedMs = lastEditedAt ? Date.parse(lastEditedAt) : NaN;
  const lastPublishedMs = lastPublishedAt ? Date.parse(lastPublishedAt) : NaN;
  const hasUnpublishedEdits =
    Number.isFinite(lastEditedMs) &&
    (!Number.isFinite(lastPublishedMs) || lastEditedMs > lastPublishedMs);

  return {
    tokenConfigured,
    tokenSource: tokenConfigured ? (config.githubPublish?.source ?? 'none') : 'none',
    repo,
    branch,
    filePath,
    publicUrl,
    mode: settings.githubPublishMode === 'auto' ? 'auto' : 'manual',
    interval: settings.githubPublishInterval ?? '30m',
    idleMinutes: settings.githubPublishIdleMinutes ?? 15,
    lastPublishedAt,
    lastPublishStatus: settings.githubLastPublishStatus ?? 'never',
    lastPublishError: settings.githubLastPublishError ?? null,
    lastPublishedHash: settings.githubLastPublishedHash ?? null,
    lastEditedAt,
    hasUnpublishedEdits,
  };
}
