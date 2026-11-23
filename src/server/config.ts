import fs from 'fs';
import path from 'path';
import { DEFAULT_TIMEZONE } from '../shared/timezone';
import type { OdooConnectionStatus } from '../shared/types';

export interface OdooCredentials {
  url: string;
  db: string;
  apiKey: string;
  source: 'ha_options' | 'env' | 'none';
}

export interface RuntimeConfig {
  port: number;
  dbPath: string;
  backupDir: string;
  haOptionsPath: string;
  timezone: string;
  odoo: OdooCredentials;
}

interface HaOptionsFile {
  odoo_url?: string;
  odoo_base_url?: string;
  odoo_db?: string;
  odoo_api_key?: string;
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
  const trimmed = rawUrl.trim().replace(/\/+$/, '');
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
  return `${parsed.origin}${parsed.pathname}`.replace(/\/+$/, '');
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

  return {
    port,
    dbPath,
    backupDir,
    haOptionsPath,
    timezone,
    odoo,
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
