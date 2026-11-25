import express, { type Express, type Request, type Response } from 'express';
import fs from 'fs';
import multer from 'multer';
import os from 'os';
import path from 'path';
import {
  renderPreApprovalMessage,
  selectBestPreApprovalTemplate,
} from '../shared/generators';
import { selectPrimaryOdooSide } from '../shared/orderMatching';
import {
  findEarliestValidSlotDate,
  isWeekdayAllowedForChannel,
  projectDailySupply,
} from '../shared/supplyEngine';
import {
  DEFAULT_TIMEZONE,
  addDays,
  compareWaitlistOrders,
  getMondayOfWeek,
  getTodayDateKey,
} from '../shared/timezone';
import type {
  AppSettings,
  OrderItemLine,
  OrderMergeItemStrategy,
  OrderStatus,
  OrderTimingType,
  StandingCadence,
  WorkspacePayload,
} from '../shared/types';
import {
  captureCheckpoint,
  listCheckpoints,
  restoreCheckpointById,
  undoLastCheckpoint,
} from './checkpointService';
import {
  getRedactedGithubPublishStatus,
  getRedactedOdooStatus,
  type RuntimeConfig,
} from './config';
import type { DatabaseManager } from './db';
import { testGithubPublishConnection } from './githubPublisher';
import {
  getLatestSyncLog,
  purgeOdooOrdersInFullIgnoredRanges,
  syncOdooCustomers,
  syncOdooQuotations,
  testOdooConnection,
  type FetchLike,
} from './odooService';
import {
  countOdooCustomers,
  getOrderById,
  listAllOrders,
  listCustomerDirectory,
  listDailySupplyEntries,
  listPickupChannels,
  listTrackedItems,
} from './repository';
import { buildSnippetForDatabase, publishSnippetSnapshotToGithub } from './snippetService';
import { listStandingOrders, materializeStandingOrders } from './standingEngine';

export interface CreateAppOptions {
  dbManager: DatabaseManager;
  config: RuntimeConfig;
  fetchFn?: FetchLike;
  getNow?: () => Date;
  onSettingsUpdated?: (settings: AppSettings) => void;
}

const VALID_DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const VALID_STATUSES: OrderStatus[] = ['waitlist', 'slotted', 'pre_approved', 'confirmed', 'ignored'];
const VALID_CADENCES: StandingCadence[] = ['weekly', 'biweekly', 'monthly'];

function parsePositiveId(raw: string): number | null {
  const n = Number(raw);
  return Number.isInteger(n) && n > 0 ? n : null;
}

function sanitizeOrderItems(raw: unknown): OrderItemLine[] {
  if (!Array.isArray(raw)) return [];
  const merged = new Map<number, number>();
  for (const entry of raw) {
    if (!entry || typeof entry !== 'object') continue;
    const itemId = Number((entry as { trackedItemId?: unknown }).trackedItemId);
    const qty = Number((entry as { quantity?: unknown }).quantity);
    if (Number.isInteger(itemId) && itemId > 0 && Number.isFinite(qty) && qty > 0) {
      merged.set(itemId, Math.round(((merged.get(itemId) ?? 0) + qty) * 1000) / 1000);
    }
  }
  return Array.from(merged.entries()).map(([trackedItemId, quantity]) => ({
    trackedItemId,
    quantity,
  }));
}

const AVAILABILITY_MUTATION_ROUTES: Array<{ method: string; pattern: RegExp }> = [
  { method: 'POST', pattern: /^\/items$/ },
  { method: 'PUT', pattern: /^\/items\/\d+$/ },
  { method: 'DELETE', pattern: /^\/items\/\d+$/ },
  { method: 'POST', pattern: /^\/channels$/ },
  { method: 'PUT', pattern: /^\/channels\/\d+$/ },
  { method: 'DELETE', pattern: /^\/channels\/\d+$/ },
  { method: 'PUT', pattern: /^\/supply\/\d+\/[^/]+$/ },
  { method: 'POST', pattern: /^\/orders$/ },
  { method: 'PUT', pattern: /^\/orders\/\d+$/ },
  { method: 'DELETE', pattern: /^\/orders\/\d+$/ },
  {
    method: 'POST',
    pattern: /^\/orders\/\d+\/(slot|pre-approve|release-hold|ignore|restore-ignored|reconcile|merge)$/,
  },
  { method: 'POST', pattern: /^\/orders\/auto-slot$/ },
  { method: 'POST', pattern: /^\/standing-orders$/ },
  { method: 'PUT', pattern: /^\/standing-orders\/\d+$/ },
  { method: 'DELETE', pattern: /^\/standing-orders\/\d+$/ },
  { method: 'POST', pattern: /^\/standing-orders\/\d+\/skip$/ },
  { method: 'POST', pattern: /^\/checkpoints\/undo$/ },
  { method: 'POST', pattern: /^\/checkpoints\/\d+\/restore$/ },
  { method: 'POST', pattern: /^\/backups\/[^/]+\/restore$/ },
  { method: 'POST', pattern: /^\/backups\/upload$/ },
];

const AVAILABILITY_AFFECTING_SETTINGS_KEYS: Array<keyof AppSettings> = [
  'timezone',
  'publicSnippetWeeks',
  'publicSnippetEnabled',
  'publicSnippetPausedPreset',
  'publicSnippetPausedMessage',
  'publicSnippetShowSameDay',
  'publicSnippetCutoffRules',
  'publicSnippetHeaderTitle',
  'publicSnippetHeaderText',
  'publicSnippetFooterText',
  'publicSnippetAutoAdvanceToday',
];

export function createApiRouter(options: CreateAppOptions): express.Router {
  const { dbManager, config, fetchFn, getNow = () => new Date(), onSettingsUpdated } = options;
  const router = express.Router();

  // Stamp availabilityLastEditedAt synchronously before responding to real user mutations
  // (midnight rollovers, cutoff clock ticks, and background Odoo syncs intentionally do NOT set this)
  router.use((req, res, next) => {
    const matchesAvailabilityMutation = AVAILABILITY_MUTATION_ROUTES.some(
      (rule) => rule.method === req.method && rule.pattern.test(req.path)
    );
    if (matchesAvailabilityMutation) {
      const origJson = res.json.bind(res);
      res.json = ((body: unknown) => {
        if (res.statusCode >= 200 && res.statusCode < 300) {
          dbManager.markAvailabilityEdited(getNow());
        }
        return origJson(body);
      }) as Response['json'];
    }
    next();
  });

  const upload = multer({
    dest: path.join(os.tmpdir(), 'farm-waitlist-uploads'),
    limits: { fileSize: 100 * 1024 * 1024 }, // 100 MB max SQLite upload
  });

  function getHorizon(weeksParam?: unknown): {
    today: string;
    startDate: string;
    endDate: string;
    weeks: number;
    timezone: string;
  } {
    const settings = dbManager.getSettings();
    const timezone = settings.timezone || config.timezone || DEFAULT_TIMEZONE;
    const today = getTodayDateKey(timezone, getNow());
    const parsedWeeks = Number(weeksParam);
    const weeks =
      Number.isInteger(parsedWeeks) && parsedWeeks >= 6 && parsedWeeks <= 26 ? parsedWeeks : 6;
    const startDate = getMondayOfWeek(today);
    const endDate = addDays(startDate, weeks * 7 - 1);
    return { today, startDate, endDate, weeks, timezone };
  }

  function buildWorkspace(weeksParam?: unknown): WorkspacePayload {
    const db = dbManager.db;
    const { today, startDate, endDate, weeks } = getHorizon(weeksParam);

    // Always ensure standing orders are materialized across the active horizon
    materializeStandingOrders(db, today, endDate);

    const settings = dbManager.getSettings();
    const items = listTrackedItems(db);
    const channels = listPickupChannels(db);
    const entries = listDailySupplyEntries(db);
    const allOrders = listAllOrders(db);
    const activeOrders = allOrders.filter((o) => o.status !== 'ignored');
    const ignoredOrders = allOrders.filter((o) => o.status === 'ignored');

    const days = projectDailySupply({
      items,
      entries,
      orders: activeOrders,
      startDate,
      endDate,
      today,
    });

    const overdueOrders = activeOrders.filter(
      (o) =>
        o.slottedDate !== null &&
        o.slottedDate < today &&
        (o.status === 'slotted' || o.status === 'pre_approved')
    );

    const reconciliationOrders = activeOrders.filter(
      (o) => o.source === 'odoo' && o.odooMissingFlagged && o.status !== 'confirmed'
    );

    return {
      today,
      startDate,
      endDate,
      weeks,
      settings,
      odooStatus: getRedactedOdooStatus(config),
      odooCustomersCount: countOdooCustomers(db),
      githubPublishStatus: getRedactedGithubPublishStatus(config, settings),
      lastSync: getLatestSyncLog(db),
      items,
      channels,
      days,
      orders: activeOrders,
      overdueOrders,
      reconciliationOrders,
      ignoredOrders,
      standingOrders: listStandingOrders(db),
      checkpoints: listCheckpoints(db),
    };
  }

  // Health check
  router.get('/health', (_req: Request, res: Response) => {
    res.json({ ok: true, app: 'farm-waitlist', timezone: dbManager.getSettings().timezone });
  });

  // Main workspace bootstrap
  router.get('/workspace', (req: Request, res: Response) => {
    try {
      res.json(buildWorkspace(req.query.weeks));
    } catch (err) {
      res.status(500).json({ error: err instanceof Error ? err.message : 'Failed to load workspace' });
    }
  });

  // --- Tracked Items CRUD ---
  router.post('/items', (req: Request, res: Response) => {
    const db = dbManager.db;
    const {
      name,
      unitLabel = 'dozens',
      isActive = true,
      supplyMode = 'continuous',
      defaultDailyProduction = 0,
      globalSafetyBuffer = 0,
      includeInPublicSnippet = true,
      keywordRules = [],
    } = req.body ?? {};

    if (typeof name !== 'string' || !name.trim()) {
      res.status(400).json({ error: 'Item name is required' });
      return;
    }
    if (supplyMode !== 'continuous' && supplyMode !== 'discrete') {
      res.status(400).json({ error: 'Invalid supply mode' });
      return;
    }

    const nowIso = new Date().toISOString();
    const keywords = Array.isArray(keywordRules)
      ? keywordRules.map((k) => String(k).trim()).filter(Boolean)
      : [];
    const maxSort = (
      db.prepare('SELECT COALESCE(MAX(sort_order), -1) as m FROM tracked_items').get() as {
        m: number;
      }
    ).m;

    const info = db
      .prepare(
        `INSERT INTO tracked_items (
          name, unit_label, is_active, supply_mode, default_daily_production,
          global_safety_buffer, include_in_public_snippet, keyword_rules_json,
          sort_order, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        name.trim(),
        String(unitLabel).trim() || 'units',
        isActive ? 1 : 0,
        supplyMode,
        Number(defaultDailyProduction) || 0,
        Math.max(0, Number(globalSafetyBuffer) || 0),
        includeInPublicSnippet ? 1 : 0,
        JSON.stringify(keywords),
        maxSort + 1,
        nowIso,
        nowIso
      );

    const created = listTrackedItems(db).find((i) => i.id === Number(info.lastInsertRowid));
    res.status(201).json(created);
  });

  router.put('/items/:id', (req: Request, res: Response) => {
    const id = parsePositiveId(String(req.params.id));
    if (!id) {
      res.status(400).json({ error: 'Invalid item ID' });
      return;
    }
    const db = dbManager.db;
    const existing = listTrackedItems(db).find((i) => i.id === id);
    if (!existing) {
      res.status(404).json({ error: 'Tracked item not found' });
      return;
    }

    const body = req.body ?? {};
    const name = typeof body.name === 'string' && body.name.trim() ? body.name.trim() : existing.name;
    const unitLabel =
      typeof body.unitLabel === 'string' && body.unitLabel.trim()
        ? body.unitLabel.trim()
        : existing.unitLabel;
    const isActive = typeof body.isActive === 'boolean' ? body.isActive : existing.isActive;
    const supplyMode =
      body.supplyMode === 'continuous' || body.supplyMode === 'discrete'
        ? body.supplyMode
        : existing.supplyMode;
    const defaultDailyProduction =
      body.defaultDailyProduction !== undefined
        ? Number(body.defaultDailyProduction) || 0
        : existing.defaultDailyProduction;
    const globalSafetyBuffer =
      body.globalSafetyBuffer !== undefined
        ? Math.max(0, Number(body.globalSafetyBuffer) || 0)
        : existing.globalSafetyBuffer;
    const includeInPublicSnippet =
      typeof body.includeInPublicSnippet === 'boolean'
        ? body.includeInPublicSnippet
        : existing.includeInPublicSnippet;
    const keywordRules = Array.isArray(body.keywordRules)
      ? body.keywordRules.map((k: unknown) => String(k).trim()).filter(Boolean)
      : existing.keywordRules;

    db.prepare(
      `UPDATE tracked_items SET
         name = ?, unit_label = ?, is_active = ?, supply_mode = ?,
         default_daily_production = ?, global_safety_buffer = ?,
         include_in_public_snippet = ?, keyword_rules_json = ?, updated_at = ?
       WHERE id = ?`
    ).run(
      name,
      unitLabel,
      isActive ? 1 : 0,
      supplyMode,
      defaultDailyProduction,
      globalSafetyBuffer,
      includeInPublicSnippet ? 1 : 0,
      JSON.stringify(keywordRules),
      new Date().toISOString(),
      id
    );

    const updated = listTrackedItems(db).find((i) => i.id === id);
    res.json(updated);
  });

  router.delete('/items/:id', (req: Request, res: Response) => {
    const id = parsePositiveId(String(req.params.id));
    if (!id) {
      res.status(400).json({ error: 'Invalid item ID' });
      return;
    }
    const info = dbManager.db.prepare('DELETE FROM tracked_items WHERE id = ?').run(id);
    if (info.changes === 0) {
      res.status(404).json({ error: 'Tracked item not found' });
      return;
    }
    res.json({ deleted: true });
  });

  // --- Pickup Channels CRUD ---
  router.post('/channels', (req: Request, res: Response) => {
    const db = dbManager.db;
    const {
      name,
      allowedWeekdays = [1, 2, 3, 4, 5, 6, 7],
      specificDates = [],
      colorToken = 'sky',
      isActive = true,
    } = req.body ?? {};

    if (typeof name !== 'string' || !name.trim()) {
      res.status(400).json({ error: 'Channel name is required' });
      return;
    }
    const weekdays = Array.isArray(allowedWeekdays)
      ? Array.from(
          new Set(
            allowedWeekdays
              .map(Number)
              .filter((d) => Number.isInteger(d) && d >= 1 && d <= 7)
          )
        ).sort((a, b) => a - b)
      : [1, 2, 3, 4, 5, 6, 7];

    const dates = Array.isArray(specificDates)
      ? Array.from(
          new Set(
            specificDates
              .map((d) => String(d).trim())
              .filter((d) => VALID_DATE_RE.test(d))
          )
        ).sort()
      : [];

    const maxSort = (
      db.prepare('SELECT COALESCE(MAX(sort_order), -1) as m FROM pickup_channels').get() as {
        m: number;
      }
    ).m;

    const info = db
      .prepare(
        `INSERT INTO pickup_channels (name, allowed_weekdays_json, specific_dates_json, color_token, is_active, sort_order)
         VALUES (?, ?, ?, ?, ?, ?)`
      )
      .run(
        name.trim(),
        JSON.stringify(weekdays),
        JSON.stringify(dates),
        String(colorToken),
        isActive ? 1 : 0,
        maxSort + 1
      );

    const created = listPickupChannels(db).find((c) => c.id === Number(info.lastInsertRowid));
    res.status(201).json(created);
  });

  router.put('/channels/:id', (req: Request, res: Response) => {
    const id = parsePositiveId(String(req.params.id));
    if (!id) {
      res.status(400).json({ error: 'Invalid channel ID' });
      return;
    }
    const db = dbManager.db;
    const existing = listPickupChannels(db).find((c) => c.id === id);
    if (!existing) {
      res.status(404).json({ error: 'Pickup channel not found' });
      return;
    }
    const body = req.body ?? {};
    const name = typeof body.name === 'string' && body.name.trim() ? body.name.trim() : existing.name;
    const weekdays: number[] = Array.isArray(body.allowedWeekdays)
      ? Array.from(
          new Set<number>(
            body.allowedWeekdays
              .map((d: unknown) => Number(d))
              .filter((d: number) => Number.isInteger(d) && d >= 1 && d <= 7)
          )
        ).sort((a, b) => a - b)
      : existing.allowedWeekdays;
    const dates: string[] = Array.isArray(body.specificDates)
      ? Array.from(
          new Set<string>(
            body.specificDates
              .map((d: unknown) => String(d).trim())
              .filter((d: string) => VALID_DATE_RE.test(d))
          )
        ).sort()
      : (existing.specificDates ?? []);
    const colorToken = typeof body.colorToken === 'string' ? body.colorToken : existing.colorToken;
    const isActive = typeof body.isActive === 'boolean' ? body.isActive : existing.isActive;

    db.prepare(
      `UPDATE pickup_channels
       SET name = ?, allowed_weekdays_json = ?, specific_dates_json = ?, color_token = ?, is_active = ?
       WHERE id = ?`
    ).run(name, JSON.stringify(weekdays), JSON.stringify(dates), colorToken, isActive ? 1 : 0, id);

    res.json(listPickupChannels(db).find((c) => c.id === id));
  });

  router.delete('/channels/:id', (req: Request, res: Response) => {
    const id = parsePositiveId(String(req.params.id));
    if (!id) {
      res.status(400).json({ error: 'Invalid channel ID' });
      return;
    }
    const info = dbManager.db.prepare('DELETE FROM pickup_channels WHERE id = ?').run(id);
    if (info.changes === 0) {
      res.status(404).json({ error: 'Pickup channel not found' });
      return;
    }
    res.json({ deleted: true });
  });

  // --- Daily Supply Entry (Actual On-Hand, Est. Produced, Cascade Forward, Buffer Override) ---
  router.put('/supply/:itemId/:date', (req: Request, res: Response) => {
    const itemId = parsePositiveId(String(req.params.itemId));
    const date = String(req.params.date);
    if (!itemId || !VALID_DATE_RE.test(date)) {
      res.status(400).json({ error: 'Invalid itemId or date (YYYY-MM-DD)' });
      return;
    }

    const db = dbManager.db;
    const item = listTrackedItems(db).find((i) => i.id === itemId);
    if (!item) {
      res.status(404).json({ error: 'Tracked item not found' });
      return;
    }

    const body = req.body ?? {};
    const actualOnHand =
      body.actualOnHand === null || body.actualOnHand === '' || body.actualOnHand === undefined
        ? null
        : Number(body.actualOnHand);
    const estProduced =
      body.estProduced === null || body.estProduced === '' || body.estProduced === undefined
        ? null
        : Number(body.estProduced);
    const actualEndOfDay =
      body.actualEndOfDay === null ||
      body.actualEndOfDay === '' ||
      body.actualEndOfDay === undefined
        ? null
        : Number(body.actualEndOfDay);
    const bufferOverride =
      body.bufferOverride === null || body.bufferOverride === '' || body.bufferOverride === undefined
        ? null
        : Math.max(0, Number(body.bufferOverride));
    const extraBuffer =
      body.extraBuffer === null || body.extraBuffer === '' || body.extraBuffer === undefined
        ? 0
        : Math.max(0, Number(body.extraBuffer));
    const cascadeForward = Boolean(body.cascadeForward);
    const notes = typeof body.notes === 'string' && body.notes.trim() ? body.notes.trim() : null;

    if (
      (actualOnHand !== null && !Number.isFinite(actualOnHand)) ||
      (estProduced !== null && !Number.isFinite(estProduced)) ||
      (actualEndOfDay !== null && !Number.isFinite(actualEndOfDay)) ||
      (bufferOverride !== null && !Number.isFinite(bufferOverride)) ||
      !Number.isFinite(extraBuffer)
    ) {
      res.status(400).json({ error: 'Numeric supply values must be finite numbers' });
      return;
    }

    captureCheckpoint(db, `Supply update (${item.name} on ${date})`);

    db.prepare(
      `INSERT INTO daily_supply_entries (
         tracked_item_id, date, actual_on_hand, est_produced, actual_end_of_day, is_cascade_anchor, buffer_override, extra_buffer, notes
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(tracked_item_id, date) DO UPDATE SET
         actual_on_hand = excluded.actual_on_hand,
         est_produced = excluded.est_produced,
         actual_end_of_day = excluded.actual_end_of_day,
         is_cascade_anchor = excluded.is_cascade_anchor,
         buffer_override = excluded.buffer_override,
         extra_buffer = excluded.extra_buffer,
         notes = excluded.notes`
    ).run(
      itemId,
      date,
      actualOnHand,
      estProduced,
      actualEndOfDay,
      cascadeForward && estProduced !== null ? 1 : 0,
      bufferOverride,
      extraBuffer,
      notes
    );

    res.json({ ok: true });
  });

  // --- Orders CRUD & Scheduling ---
  router.get('/orders', (_req: Request, res: Response) => {
    res.json(listAllOrders(dbManager.db));
  });

  router.post('/orders', (req: Request, res: Response) => {
    const db = dbManager.db;
    const body = req.body ?? {};
    const customerName = typeof body.customerName === 'string' ? body.customerName.trim() : '';
    if (!customerName) {
      res.status(400).json({ error: 'Customer name is required' });
      return;
    }

    const timingType = body.timingType === 'specific_date' ? 'specific_date' : 'asap';
    const requestedDate =
      typeof body.requestedDate === 'string' && VALID_DATE_RE.test(body.requestedDate)
        ? body.requestedDate
        : null;

    if (timingType === 'specific_date' && !requestedDate) {
      res.status(400).json({ error: 'Specific date is required when timing is Specific Date' });
      return;
    }

    const pickupChannelId =
      body.pickupChannelId !== undefined && body.pickupChannelId !== null && body.pickupChannelId !== ''
        ? parsePositiveId(String(body.pickupChannelId))
        : null;

    const items = sanitizeOrderItems(body.items);
    if (items.length === 0) {
      res.status(400).json({ error: 'Add at least one Tracked Item with quantity > 0' });
      return;
    }

    // Validate weekday for specific_date unless forceWeekday is set
    if (timingType === 'specific_date' && requestedDate && !body.forceWeekday) {
      const check = isWeekdayAllowedForChannel(
        requestedDate,
        pickupChannelId,
        listPickupChannels(db)
      );
      if (!check.allowed) {
        res.status(409).json({
          error: `${check.channelName} is not scheduled for that date.`,
          weekdayWarning: true,
          channelName: check.channelName,
          allowedWeekdays: check.allowedWeekdays,
          specificDates: check.specificDates,
        });
        return;
      }
    }

    captureCheckpoint(db, `Add order (${customerName})`);

    const nowIso = new Date().toISOString();
    const initialStatus: OrderStatus = timingType === 'specific_date' ? 'slotted' : 'waitlist';
    const slottedDate = timingType === 'specific_date' ? requestedDate : null;

    const tx = db.transaction(() => {
      const info = db
        .prepare(
          `INSERT INTO orders (
             source, status, timing_type, requested_date, slotted_date, is_locked,
             customer_name, customer_name_overridden, customer_email, customer_phone,
             pickup_channel_id, free_text_pickup, notes, created_at, updated_at
           ) VALUES (
             'manual', ?, ?, ?, ?, ?,
             ?, 0, ?, ?,
             ?, ?, ?, ?, ?
           )`
        )
        .run(
          initialStatus,
          timingType,
          requestedDate,
          slottedDate,
          body.isLocked ? 1 : 0,
          customerName,
          body.customerEmail ? String(body.customerEmail).trim() : null,
          body.customerPhone ? String(body.customerPhone).trim() : null,
          pickupChannelId,
          body.freeTextPickup ? String(body.freeTextPickup).trim() : null,
          body.notes ? String(body.notes).trim() : null,
          nowIso,
          nowIso
        );

      const orderId = Number(info.lastInsertRowid);
      const itemStmt = db.prepare(
        'INSERT INTO order_items (order_id, tracked_item_id, quantity) VALUES (?, ?, ?)'
      );
      for (const line of items) {
        itemStmt.run(orderId, line.trackedItemId, line.quantity);
      }
      return orderId;
    });

    const createdId = tx();
    res.status(201).json(getOrderById(db, createdId));
  });

  router.put('/orders/waitlist-order', (req: Request, res: Response) => {
    const db = dbManager.db;
    const body = req.body ?? {};

    if (body.reset === true) {
      db.prepare(`UPDATE orders SET waitlist_sort_order = NULL WHERE status = 'waitlist' OR slotted_date IS NULL`).run();
      res.json({ ok: true });
      return;
    }

    if (!Array.isArray(body.orderIds)) {
      res.status(400).json({ error: 'orderIds array or reset: true is required' });
      return;
    }

    const cleanedIds = Array.from(
      new Set(
        body.orderIds
          .map((v: unknown) => Number(v))
          .filter((n: number) => Number.isInteger(n) && n > 0)
      )
    ) as number[];

    const tx = db.transaction(() => {
      const updateStmt = db.prepare('UPDATE orders SET waitlist_sort_order = ? WHERE id = ?');
      cleanedIds.forEach((orderId, index) => {
        updateStmt.run(index, orderId);
      });
    });
    tx();

    res.json({ ok: true });
  });

  router.put('/orders/:id', (req: Request, res: Response) => {
    const id = parsePositiveId(String(req.params.id));
    if (!id) {
      res.status(400).json({ error: 'Invalid order ID' });
      return;
    }
    const db = dbManager.db;
    const existing = getOrderById(db, id);
    if (!existing) {
      res.status(404).json({ error: 'Order not found' });
      return;
    }

    const body = req.body ?? {};
    const nextCustomerName =
      typeof body.customerName === 'string' && body.customerName.trim()
        ? body.customerName.trim()
        : existing.customerName;
    const nameChanged = nextCustomerName !== existing.customerName;
    const nextNameOverridden = existing.customerNameOverridden || nameChanged;

    const nextStatus: OrderStatus =
      typeof body.status === 'string' && VALID_STATUSES.includes(body.status as OrderStatus)
        ? (body.status as OrderStatus)
        : existing.status;

    const nextSlottedDate =
      body.slottedDate === null || body.slottedDate === ''
        ? null
        : typeof body.slottedDate === 'string' && VALID_DATE_RE.test(body.slottedDate)
          ? body.slottedDate
          : existing.slottedDate;

    const nextRequestedDate =
      body.requestedDate === null || body.requestedDate === ''
        ? null
        : typeof body.requestedDate === 'string' && VALID_DATE_RE.test(body.requestedDate)
          ? body.requestedDate
          : existing.requestedDate;
    const nextTimingType: OrderTimingType =
      body.requestedDate !== undefined
        ? nextRequestedDate
          ? 'specific_date'
          : 'asap'
        : existing.timingType;

    const nextChannelId =
      body.pickupChannelId === null || body.pickupChannelId === ''
        ? null
        : body.pickupChannelId !== undefined
          ? parsePositiveId(String(body.pickupChannelId))
          : existing.pickupChannelId;

    const nextLocked = typeof body.isLocked === 'boolean' ? body.isLocked : existing.isLocked;
    const nextNotes =
      body.notes !== undefined
        ? body.notes
          ? String(body.notes).trim()
          : null
        : existing.notes;
    const nextEmail =
      body.customerEmail !== undefined
        ? body.customerEmail
          ? String(body.customerEmail).trim()
          : null
        : existing.customerEmail;
    const nextPhone =
      body.customerPhone !== undefined
        ? body.customerPhone
          ? String(body.customerPhone).trim()
          : null
        : existing.customerPhone;
    const clearOdooUpdatedFlag = body.clearOdooUpdatedFlag ? 0 : existing.odooUpdatedAfterSlot ? 1 : 0;

    // If modifying a materialized standing occurrence, record exception so re-materialization doesn't overwrite it
    captureCheckpoint(db, `Edit order (${existing.customerName})`);

    const nowIso = new Date().toISOString();
    const nextPreApprovedAt =
      nextStatus === 'pre_approved'
        ? existing.preApprovedAt ?? nowIso
        : nextStatus === 'waitlist'
          ? null
          : existing.preApprovedAt;

    const tx = db.transaction(() => {
      db.prepare(
        `UPDATE orders SET
           customer_name = ?,
           customer_name_overridden = ?,
           customer_email = ?,
           customer_phone = ?,
           pickup_channel_id = ?,
           status = ?,
           timing_type = ?,
           requested_date = ?,
           slotted_date = ?,
           is_locked = ?,
           notes = ?,
           pre_approved_at = ?,
           odoo_updated_after_slot = ?,
           updated_at = ?
         WHERE id = ?`
      ).run(
        nextCustomerName,
        nextNameOverridden ? 1 : 0,
        nextEmail,
        nextPhone,
        nextChannelId,
        nextStatus,
        nextTimingType,
        nextRequestedDate,
        nextStatus === 'waitlist' ? null : nextSlottedDate,
        nextLocked ? 1 : 0,
        nextNotes,
        nextPreApprovedAt,
        clearOdooUpdatedFlag,
        nowIso,
        id
      );

      if (Array.isArray(body.items)) {
        const sanitized = sanitizeOrderItems(body.items);
        db.prepare('DELETE FROM order_items WHERE order_id = ?').run(id);
        const stmt = db.prepare(
          'INSERT INTO order_items (order_id, tracked_item_id, quantity) VALUES (?, ?, ?)'
        );
        for (const line of sanitized) {
          stmt.run(id, line.trackedItemId, line.quantity);
        }
      }

      if (existing.source === 'standing' && existing.standingOrderId && existing.standingOccurrenceDate) {
        db.prepare(
          `INSERT INTO standing_order_exceptions (standing_order_id, occurrence_date, action, override_order_id)
           VALUES (?, ?, 'modified', ?)
           ON CONFLICT(standing_order_id, occurrence_date) DO UPDATE SET action = 'modified', override_order_id = excluded.override_order_id`
        ).run(existing.standingOrderId, existing.standingOccurrenceDate, id);
      }
    });
    tx();

    res.json(getOrderById(db, id));
  });

  router.delete('/orders/:id', (req: Request, res: Response) => {
    const id = parsePositiveId(String(req.params.id));
    if (!id) {
      res.status(400).json({ error: 'Invalid order ID' });
      return;
    }
    const db = dbManager.db;
    const existing = getOrderById(db, id);
    if (!existing) {
      res.status(404).json({ error: 'Order not found' });
      return;
    }

    captureCheckpoint(db, `Delete order (${existing.customerName})`);

    const tx = db.transaction(() => {
      if (existing.source === 'standing' && existing.standingOrderId && existing.standingOccurrenceDate) {
        db.prepare(
          `INSERT INTO standing_order_exceptions (standing_order_id, occurrence_date, action, override_order_id)
           VALUES (?, ?, 'deleted', NULL)
           ON CONFLICT(standing_order_id, occurrence_date) DO UPDATE SET action = 'deleted', override_order_id = NULL`
        ).run(existing.standingOrderId, existing.standingOccurrenceDate);
      }
      db.prepare('DELETE FROM orders WHERE id = ?').run(id);
    });
    tx();

    res.json({ deleted: true });
  });

  // Slot / move an order onto a date (or back to waitlist if date is null)
  router.post('/orders/:id/slot', (req: Request, res: Response) => {
    const id = parsePositiveId(String(req.params.id));
    if (!id) {
      res.status(400).json({ error: 'Invalid order ID' });
      return;
    }
    const db = dbManager.db;
    const existing = getOrderById(db, id);
    if (!existing) {
      res.status(404).json({ error: 'Order not found' });
      return;
    }

    const { date, forceWeekday = false, overrideLock = false } = req.body ?? {};
    if (existing.isLocked && !overrideLock && date !== existing.slottedDate) {
      res.status(409).json({
        error: 'This order is locked. Unlock it first before moving to another date.',
        locked: true,
      });
      return;
    }

    if (date !== null && (typeof date !== 'string' || !VALID_DATE_RE.test(date))) {
      res.status(400).json({ error: 'Invalid date format (expected YYYY-MM-DD or null)' });
      return;
    }

    if (date && !forceWeekday) {
      const check = isWeekdayAllowedForChannel(
        date,
        existing.pickupChannelId,
        listPickupChannels(db)
      );
      if (!check.allowed) {
        res.status(409).json({
          error: `${check.channelName} is not scheduled for that date.`,
          weekdayWarning: true,
          channelName: check.channelName,
          allowedWeekdays: check.allowedWeekdays,
          specificDates: check.specificDates,
        });
        return;
      }
    }

    captureCheckpoint(
      db,
      date ? `Slot ${existing.customerName} -> ${date}` : `Un-slot ${existing.customerName}`
    );

    const nextStatus: OrderStatus =
      date === null
        ? 'waitlist'
        : existing.status === 'waitlist'
          ? 'slotted'
          : existing.status;

    db.prepare(
      `UPDATE orders
       SET slotted_date = ?, status = ?, pre_approved_at = CASE WHEN ? = 'waitlist' THEN NULL ELSE pre_approved_at END, updated_at = ?
       WHERE id = ?`
    ).run(date, nextStatus, nextStatus, new Date().toISOString(), id);

    if (existing.source === 'standing' && existing.standingOrderId && existing.standingOccurrenceDate) {
      db.prepare(
        `INSERT INTO standing_order_exceptions (standing_order_id, occurrence_date, action, override_order_id)
         VALUES (?, ?, 'modified', ?)
         ON CONFLICT(standing_order_id, occurrence_date) DO UPDATE SET action = 'modified', override_order_id = excluded.override_order_id`
      ).run(existing.standingOrderId, existing.standingOccurrenceDate, id);
    }

    res.json(getOrderById(db, id));
  });

  // Pre-Approve order -> marks status=pre_approved, records pre_approved_at, returns ready-to-copy message
  router.post('/orders/:id/pre-approve', (req: Request, res: Response) => {
    const id = parsePositiveId(String(req.params.id));
    if (!id) {
      res.status(400).json({ error: 'Invalid order ID' });
      return;
    }
    const db = dbManager.db;
    const existing = getOrderById(db, id);
    if (!existing) {
      res.status(404).json({ error: 'Order not found' });
      return;
    }

    captureCheckpoint(db, `Pre-approve ${existing.customerName}`);

    const nowIso = new Date().toISOString();
    db.prepare(
      `UPDATE orders SET status = 'pre_approved', pre_approved_at = COALESCE(pre_approved_at, ?), updated_at = ? WHERE id = ?`
    ).run(nowIso, nowIso, id);

    const updated = getOrderById(db, id)!;
    const settings = dbManager.getSettings();
    const templates = settings.preApprovalTemplates ?? [];
    const matchedTemplate = selectBestPreApprovalTemplate(templates, updated);
    const message = renderPreApprovalMessage({
      template: matchedTemplate?.body ?? settings.preApprovalTemplate,
      order: updated,
      items: listTrackedItems(db),
      channels: listPickupChannels(db),
    });

    res.json({
      order: updated,
      message,
      selectedTemplateId: matchedTemplate?.id ?? null,
    });
  });

  // Release Hold -> returns order to Waitlist & clears slotted_date/pre_approved_at
  router.post('/orders/:id/release-hold', (req: Request, res: Response) => {
    const id = parsePositiveId(String(req.params.id));
    if (!id) {
      res.status(400).json({ error: 'Invalid order ID' });
      return;
    }
    const db = dbManager.db;
    const existing = getOrderById(db, id);
    if (!existing) {
      res.status(404).json({ error: 'Order not found' });
      return;
    }

    captureCheckpoint(db, `Release hold (${existing.customerName})`);

    db.prepare(
      `UPDATE orders
       SET status = 'waitlist', slotted_date = NULL, pre_approved_at = NULL, is_locked = 0, updated_at = ?
       WHERE id = ?`
    ).run(new Date().toISOString(), id);

    res.json(getOrderById(db, id));
  });

  // Dismiss / Ignore Odoo quotation (or restore from Ignored)
  router.post('/orders/:id/ignore', (req: Request, res: Response) => {
    const id = parsePositiveId(String(req.params.id));
    if (!id) {
      res.status(400).json({ error: 'Invalid order ID' });
      return;
    }
    const db = dbManager.db;
    const existing = getOrderById(db, id);
    if (!existing) {
      res.status(404).json({ error: 'Order not found' });
      return;
    }

    captureCheckpoint(db, `Ignore quotation (${existing.customerName})`);

    db.prepare(
      `UPDATE orders SET status = 'ignored', slotted_date = NULL, odoo_missing_flagged = 0, updated_at = ? WHERE id = ?`
    ).run(new Date().toISOString(), id);

    res.json(getOrderById(db, id));
  });

  router.post('/orders/:id/restore-ignored', (req: Request, res: Response) => {
    const id = parsePositiveId(String(req.params.id));
    if (!id) {
      res.status(400).json({ error: 'Invalid order ID' });
      return;
    }
    const db = dbManager.db;
    const existing = getOrderById(db, id);
    if (!existing) {
      res.status(404).json({ error: 'Order not found' });
      return;
    }

    db.prepare(`UPDATE orders SET status = 'waitlist', updated_at = ? WHERE id = ?`).run(
      new Date().toISOString(),
      id
    );
    res.json(getOrderById(db, id));
  });

  // 1-click manual reconciliation for deleted Odoo quotations
  router.post('/orders/:id/reconcile', (req: Request, res: Response) => {
    const id = parsePositiveId(String(req.params.id));
    if (!id) {
      res.status(400).json({ error: 'Invalid order ID' });
      return;
    }
    const db = dbManager.db;
    const existing = getOrderById(db, id);
    if (!existing) {
      res.status(404).json({ error: 'Order not found' });
      return;
    }
    const action = req.body?.action;
    if (action !== 'confirm' && action !== 'keep' && action !== 'ignore') {
      res.status(400).json({ error: 'Action must be "confirm", "keep", or "ignore"' });
      return;
    }

    captureCheckpoint(
      db,
      action === 'confirm'
        ? `Confirm reconciled order (${existing.customerName})`
        : action === 'ignore'
          ? `Remove cancelled Odoo order (${existing.customerName})`
          : `Keep order & clear missing flag (${existing.customerName})`
    );

    const nowIso = new Date().toISOString();
    if (action === 'confirm') {
      db.prepare(
        `UPDATE orders
         SET status = 'confirmed',
             odoo_missing_flagged = 0,
             odoo_missing_dismissed = 0,
             odoo_suggested_confirmed_json = NULL,
             updated_at = ?
         WHERE id = ?`
      ).run(nowIso, id);
    } else if (action === 'ignore') {
      db.prepare(
        `UPDATE orders
         SET status = 'ignored',
             slotted_date = NULL,
             is_locked = 0,
             odoo_missing_flagged = 0,
             odoo_missing_dismissed = 0,
             odoo_suggested_confirmed_json = NULL,
             updated_at = ?
         WHERE id = ?`
      ).run(nowIso, id);
    } else {
      db.prepare(
        `UPDATE orders
         SET odoo_missing_flagged = 0,
             odoo_missing_dismissed = 1,
             odoo_suggested_confirmed_json = NULL,
             updated_at = ?
         WHERE id = ?`
      ).run(nowIso, id);
    }
    res.json(getOrderById(db, id));
  });

  // Merge another duplicate or add-on order/quotation into this target order (with Undo checkpoint & anti-re-import link)
  router.post('/orders/:id/merge', (req: Request, res: Response) => {
    const targetId = parsePositiveId(String(req.params.id));
    const sourceId = parsePositiveId(String(req.body?.sourceOrderId ?? ''));
    if (!targetId || !sourceId) {
      res.status(400).json({ error: 'Valid target and source order IDs are required' });
      return;
    }
    if (targetId === sourceId) {
      res.status(400).json({ error: 'Cannot merge an order with itself' });
      return;
    }

    const db = dbManager.db;
    const target = getOrderById(db, targetId);
    const source = getOrderById(db, sourceId);
    if (!target || !source) {
      res.status(404).json({ error: 'One or both orders could not be found' });
      return;
    }

    const rawStrategy = req.body?.itemStrategy;
    const itemStrategy: OrderMergeItemStrategy =
      rawStrategy === 'use_source' || rawStrategy === 'combine' ? rawStrategy : 'keep_target';

    const hasKeepDate =
      req.body !== null &&
      typeof req.body === 'object' &&
      Object.prototype.hasOwnProperty.call(req.body, 'keepDate');
    let explicitKeepDate: string | null | undefined;
    if (hasKeepDate) {
      const rawKeepDate = req.body.keepDate;
      if (rawKeepDate === null || rawKeepDate === '') {
        explicitKeepDate = null;
      } else if (typeof rawKeepDate === 'string' && VALID_DATE_RE.test(rawKeepDate)) {
        explicitKeepDate = rawKeepDate;
      } else {
        res.status(400).json({ error: 'Invalid keepDate format (expected YYYY-MM-DD or null)' });
        return;
      }
    }

    captureCheckpoint(
      db,
      `Merge ${source.odooQuotationName || source.customerName} -> ${target.odooQuotationName || target.customerName}`
    );

    const statusRank: Record<OrderStatus, number> = {
      ignored: -1,
      waitlist: 0,
      slotted: 1,
      pre_approved: 2,
      confirmed: 3,
    };

    let nextStatus: OrderStatus =
      statusRank[source.status] > statusRank[target.status] ? source.status : target.status;
    const nextSlottedDate =
      explicitKeepDate !== undefined
        ? explicitKeepDate
        : (target.slottedDate ?? source.slottedDate ?? null);
    if (nextSlottedDate && nextStatus === 'waitlist') {
      nextStatus = 'slotted';
    } else if (!nextSlottedDate && nextStatus === 'slotted') {
      nextStatus = 'waitlist';
    }

    const nextLocked = target.isLocked || source.isLocked;
    const nextPickupChannelId = target.pickupChannelId ?? source.pickupChannelId ?? null;
    const nextFreeTextPickup = target.freeTextPickup ?? source.freeTextPickup ?? null;
    const nextRequestedDate =
      explicitKeepDate !== undefined
        ? explicitKeepDate === source.slottedDate && source.slottedDate !== target.slottedDate
          ? (source.requestedDate ?? explicitKeepDate)
          : (explicitKeepDate ?? target.requestedDate ?? source.requestedDate ?? null)
        : (target.requestedDate ?? source.requestedDate ?? null);
    const nextTimingType = nextRequestedDate ? 'specific_date' : target.timingType;
    const nextEmail = target.customerEmail ?? source.customerEmail ?? null;
    const nextPhone = target.customerPhone ?? source.customerPhone ?? null;
    const nextPreApprovedAt = target.preApprovedAt ?? source.preApprovedAt ?? null;

    // Resolve merged item lines
    let mergedItems: OrderItemLine[] = [];
    if (itemStrategy === 'keep_target') {
      mergedItems = target.items.length > 0 ? target.items : source.items;
    } else if (itemStrategy === 'use_source') {
      mergedItems = source.items.length > 0 ? source.items : target.items;
    } else {
      const qtyByItem = new Map<number, number>();
      for (const line of [...target.items, ...source.items]) {
        const prev = qtyByItem.get(line.trackedItemId) ?? 0;
        qtyByItem.set(
          line.trackedItemId,
          Math.round((prev + Number(line.quantity)) * 1000) / 1000
        );
      }
      mergedItems = Array.from(qtyByItem.entries())
        .filter(([, qty]) => qty > 0)
        .map(([trackedItemId, quantity]) => ({ trackedItemId, quantity }));
    }

    // Merge distinct notes, raw Odoo notes, and raw lines cleanly
    const sourceLabel = source.odooQuotationName || source.customerName;
    const combineDistinctText = (primary: string | null, secondary: string | null): string | null => {
      const a = (primary || '').trim();
      const b = (secondary || '').trim();
      if (!a && !b) return null;
      if (!a) return b;
      if (!b || a === b || a.includes(b)) return a;
      return `${a}\n\n[Merged from ${sourceLabel}]\n${b}`;
    };

    const extractGeneralNotes = (ord: {
      source: string;
      notes: string | null;
      odooRawNotes: string | null;
    }): string | null => {
      const trimmedNotes = (ord.notes || '').trim();
      if (!trimmedNotes) return null;
      const trimmedRaw = (ord.odooRawNotes || '').trim();
      if (ord.source === 'odoo' && trimmedRaw && trimmedNotes === trimmedRaw) {
        return null;
      }
      return ord.notes;
    };

    const nextNotes = combineDistinctText(
      extractGeneralNotes(target),
      extractGeneralNotes(source)
    );
    const nextOdooRawNotes = combineDistinctText(target.odooRawNotes, source.odooRawNotes);

    // Determine primary Odoo linkage vs suppressed merged_odoo_links history entry.
    // Active (non-missing) quotations always beat cancelled/missing ones, confirmed beats
    // unconfirmed, and a newer active draft (e.g., replacement order) replaces an older waitlist draft
    // so cancelling the old waitlist quotation in Odoo never breaks sync or triggers alerts.
    const rawPrimaryPref = req.body?.primaryOdooPreference;
    const primarySide: 'target' | 'source' =
      rawPrimaryPref === 'source' && source.odooQuotationId !== null
        ? 'source'
        : rawPrimaryPref === 'target' && target.odooQuotationId !== null
          ? 'target'
          : selectPrimaryOdooSide(target, source);

    let nextOrderSource = target.source;
    let nextOdooId = target.odooQuotationId;
    let nextOdooName = target.odooQuotationName;
    let nextOdooPartnerId = target.odooPartnerId ?? source.odooPartnerId ?? null;
    // Preserve earliest arrival timestamp when chaining waitlist -> replacement order
    const earliestArrival =
      target.odooCreatedAtLocal && source.odooCreatedAtLocal
        ? target.odooCreatedAtLocal <= source.odooCreatedAtLocal
          ? target.odooCreatedAtLocal
          : source.odooCreatedAtLocal
        : (target.odooCreatedAtLocal ?? source.odooCreatedAtLocal ?? null);
    let nextOdooCreatedAtLocal = earliestArrival;
    let nextCustomerName = target.customerName;
    let suppressedOdooLink: { id: number; name: string | null } | null = null;

    if (!target.odooQuotationId && source.odooQuotationId) {
      // Target was manual/standing; adopt source's Odoo identity directly
      nextOdooId = source.odooQuotationId;
      nextOdooName = source.odooQuotationName;
      nextOdooPartnerId = source.odooPartnerId ?? target.odooPartnerId ?? null;
      nextOdooCreatedAtLocal = source.odooCreatedAtLocal ?? target.odooCreatedAtLocal ?? null;
      if (target.source === 'manual') {
        nextOrderSource = 'odoo';
      }
    } else if (target.odooQuotationId && source.odooQuotationId) {
      if (primarySide === 'source') {
        suppressedOdooLink = { id: target.odooQuotationId, name: target.odooQuotationName };
        nextOdooId = source.odooQuotationId;
        nextOdooName = source.odooQuotationName;
        nextOdooPartnerId = source.odooPartnerId ?? target.odooPartnerId ?? null;
        if (
          !target.customerNameOverridden &&
          /^Order\s+/i.test(target.customerName) &&
          source.customerName &&
          !/^Order\s+/i.test(source.customerName)
        ) {
          nextCustomerName = source.customerName;
        }
      } else {
        suppressedOdooLink = { id: source.odooQuotationId, name: source.odooQuotationName };
      }
    }

    const nextRawLines =
      primarySide === 'source'
        ? Array.from(new Set([...source.odooRawLines, ...target.odooRawLines]))
        : Array.from(new Set([...target.odooRawLines, ...source.odooRawLines]));

    const nowIso = new Date().toISOString();

    const tx = db.transaction(() => {
      // Clear source's unique odoo_quotation_id first to avoid UNIQUE collision if target adopts it
      if (source.odooQuotationId !== null) {
        db.prepare('UPDATE orders SET odoo_quotation_id = NULL WHERE id = ?').run(source.id);
      }

      db.prepare(
        `UPDATE orders SET
           source = ?,
           status = ?,
           timing_type = ?,
           requested_date = ?,
           slotted_date = ?,
           is_locked = ?,
           customer_name = ?,
           customer_email = ?,
           customer_phone = ?,
           pickup_channel_id = ?,
           free_text_pickup = ?,
           notes = ?,
           pre_approved_at = ?,
           odoo_quotation_id = ?,
           odoo_quotation_name = ?,
           odoo_partner_id = ?,
           odoo_created_at_local = ?,
           odoo_raw_notes = ?,
           odoo_raw_lines_json = ?,
           odoo_updated_after_slot = 0,
           odoo_missing_flagged = 0,
           odoo_missing_dismissed = 0,
           odoo_suggested_confirmed_json = NULL,
           updated_at = ?
         WHERE id = ?`
      ).run(
        nextOrderSource,
        nextStatus,
        nextTimingType,
        nextRequestedDate,
        nextStatus === 'waitlist' ? null : nextSlottedDate,
        nextLocked ? 1 : 0,
        nextCustomerName,
        nextEmail,
        nextPhone,
        nextPickupChannelId,
        nextFreeTextPickup,
        nextNotes,
        nextPreApprovedAt,
        nextOdooId,
        nextOdooName,
        nextOdooPartnerId,
        nextOdooCreatedAtLocal,
        nextOdooRawNotes,
        JSON.stringify(nextRawLines),
        nowIso,
        target.id
      );

      // Update merged order items
      db.prepare('DELETE FROM order_items WHERE order_id = ?').run(target.id);
      const itemStmt = db.prepare(
        'INSERT INTO order_items (order_id, tracked_item_id, quantity) VALUES (?, ?, ?)'
      );
      for (const line of mergedItems) {
        itemStmt.run(target.id, line.trackedItemId, line.quantity);
      }

      // Copy chatter messages from source onto target without duplicating message IDs
      db.prepare(
        `INSERT OR IGNORE INTO order_chatter (
           order_id, odoo_message_id, author_name, message_type, subtype_name,
           body_text, created_at_utc, created_at_local
         )
         SELECT ?, odoo_message_id, author_name, message_type, subtype_name,
                body_text, created_at_utc, created_at_local
         FROM order_chatter
         WHERE order_id = ?`
      ).run(target.id, source.id);

      // Repoint any prior merged_odoo_links from source -> target before deleting source
      db.prepare('UPDATE merged_odoo_links SET target_order_id = ? WHERE target_order_id = ?').run(
        target.id,
        source.id
      );

      if (suppressedOdooLink) {
        db.prepare(
          `INSERT OR REPLACE INTO merged_odoo_links (odoo_quotation_id, target_order_id, odoo_quotation_name, merged_at)
           VALUES (?, ?, ?, ?)`
        ).run(suppressedOdooLink.id, target.id, suppressedOdooLink.name, nowIso);
      }

      if (source.source === 'standing' && source.standingOrderId && source.standingOccurrenceDate) {
        db.prepare(
          `INSERT INTO standing_order_exceptions (standing_order_id, occurrence_date, action, override_order_id)
           VALUES (?, ?, 'deleted', NULL)
           ON CONFLICT(standing_order_id, occurrence_date) DO UPDATE SET action = 'deleted', override_order_id = NULL`
        ).run(source.standingOrderId, source.standingOccurrenceDate);
      }

      db.prepare('DELETE FROM orders WHERE id = ?').run(source.id);
    });
    tx();

    res.json({ order: getOrderById(db, target.id), mergedOrderId: source.id });
  });

  // Dismiss a suggested possible-duplicate order pair (symmetrical & persisted in SQLite)
  router.post('/orders/:id/dismiss-duplicate', (req: Request, res: Response) => {
    const db = dbManager.db;
    const orderId = Number(req.params.id);
    const otherOrderId = Number(req.body?.otherOrderId);

    if (
      !Number.isInteger(orderId) ||
      orderId <= 0 ||
      !Number.isInteger(otherOrderId) ||
      otherOrderId <= 0
    ) {
      res.status(400).json({ error: 'Valid order IDs are required.' });
      return;
    }
    if (orderId === otherOrderId) {
      res.status(400).json({ error: 'Cannot dismiss an order against itself.' });
      return;
    }

    const orderA = getOrderById(db, orderId);
    const orderB = getOrderById(db, otherOrderId);
    if (!orderA || !orderB) {
      res.status(404).json({ error: 'Order not found.' });
      return;
    }

    const idA = Math.min(orderId, otherOrderId);
    const idB = Math.max(orderId, otherOrderId);
    const nowIso = new Date().toISOString();

    db.prepare(
      `INSERT OR IGNORE INTO dismissed_duplicate_pairs (order_id_a, order_id_b, dismissed_at)
       VALUES (?, ?, ?)`
    ).run(idA, idB, nowIso);

    res.json({ ok: true, orderIdA: idA, orderIdB: idB });
  });

  // Auto-Slot ASAP Orders
  router.post('/orders/auto-slot', (req: Request, res: Response) => {
    const db = dbManager.db;
    const { today, startDate, endDate, timezone } = getHorizon(req.body?.weeks);

    materializeStandingOrders(db, today, endDate);

    const items = listTrackedItems(db);
    const channels = listPickupChannels(db);
    const entries = listDailySupplyEntries(db);
    const allOrders = listAllOrders(db).filter((o) => o.status !== 'ignored');

    const asapQueue = allOrders
      .filter((o) => o.status === 'waitlist' && o.timingType === 'asap' && o.items.length > 0)
      .sort((a, b) => compareWaitlistOrders(a, b, timezone));

    if (asapQueue.length === 0) {
      res.json({ slottedCount: 0, skippedCount: 0, placements: [] });
      return;
    }

    captureCheckpoint(db, `Auto-slot ${asapQueue.length} ASAP order(s)`);

    const workingOrders = allOrders.map((o) => ({ ...o }));
    const placements: Array<{ orderId: number; customerName: string; date: string }> = [];
    let skippedCount = 0;

    const tx = db.transaction(() => {
      for (const order of asapQueue) {
        const chosenDate = findEarliestValidSlotDate({
          order,
          items,
          entries,
          existingOrders: workingOrders,
          channels,
          today,
          startDate,
          endDate,
        });

        if (chosenDate) {
          db.prepare(
            `UPDATE orders SET slotted_date = ?, status = 'slotted', updated_at = ? WHERE id = ?`
          ).run(chosenDate, new Date().toISOString(), order.id);

          const ref = workingOrders.find((w) => w.id === order.id);
          if (ref) {
            ref.slottedDate = chosenDate;
            ref.status = 'slotted';
          }
          placements.push({
            orderId: order.id,
            customerName: order.customerName,
            date: chosenDate,
          });
        } else {
          skippedCount += 1;
        }
      }
    });
    tx();

    res.json({ slottedCount: placements.length, skippedCount, placements });
  });

  // --- Standing Orders CRUD ---
  router.get('/standing-orders', (_req: Request, res: Response) => {
    res.json(listStandingOrders(dbManager.db));
  });

  router.post('/standing-orders', (req: Request, res: Response) => {
    const db = dbManager.db;
    const body = req.body ?? {};
    const customerName = typeof body.customerName === 'string' ? body.customerName.trim() : '';
    const cadence = VALID_CADENCES.includes(body.cadence) ? body.cadence : 'weekly';
    const weekday = Number(body.weekday);
    const items = sanitizeOrderItems(body.items);

    if (!customerName) {
      res.status(400).json({ error: 'Customer name is required' });
      return;
    }
    if (!Number.isInteger(weekday) || weekday < 1 || weekday > 7) {
      res.status(400).json({ error: 'Weekday must be 1 (Mon) through 7 (Sun)' });
      return;
    }
    if (items.length === 0) {
      res.status(400).json({ error: 'Add at least one Tracked Item' });
      return;
    }

    const { today, endDate } = getHorizon();
    const startDate =
      typeof body.startDate === 'string' && VALID_DATE_RE.test(body.startDate)
        ? body.startDate
        : today;
    const pickupChannelId =
      body.pickupChannelId !== undefined && body.pickupChannelId !== null && body.pickupChannelId !== ''
        ? parsePositiveId(String(body.pickupChannelId))
        : null;

    const nowIso = new Date().toISOString();
    const info = db
      .prepare(
        `INSERT INTO standing_orders (
           customer_name, customer_contact, pickup_channel_id, cadence, weekday,
           start_date, is_active, notes, items_json, created_at, updated_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        customerName,
        body.customerContact ? String(body.customerContact).trim() : null,
        pickupChannelId,
        cadence,
        weekday,
        startDate,
        body.isActive === false ? 0 : 1,
        body.notes ? String(body.notes).trim() : null,
        JSON.stringify(items),
        nowIso,
        nowIso
      );

    materializeStandingOrders(db, today, endDate);
    const created = listStandingOrders(db).find((s) => s.id === Number(info.lastInsertRowid));
    res.status(201).json(created);
  });

  router.put('/standing-orders/:id', (req: Request, res: Response) => {
    const id = parsePositiveId(String(req.params.id));
    if (!id) {
      res.status(400).json({ error: 'Invalid standing order ID' });
      return;
    }
    const db = dbManager.db;
    const existing = listStandingOrders(db).find((s) => s.id === id);
    if (!existing) {
      res.status(404).json({ error: 'Standing order not found' });
      return;
    }

    const body = req.body ?? {};
    const customerName =
      typeof body.customerName === 'string' && body.customerName.trim()
        ? body.customerName.trim()
        : existing.customerName;
    const cadence = VALID_CADENCES.includes(body.cadence) ? body.cadence : existing.cadence;
    const weekday =
      body.weekday !== undefined && Number.isInteger(Number(body.weekday))
        ? Number(body.weekday)
        : existing.weekday;
    const startDate =
      typeof body.startDate === 'string' && VALID_DATE_RE.test(body.startDate)
        ? body.startDate
        : existing.startDate;
    const isActive = typeof body.isActive === 'boolean' ? body.isActive : existing.isActive;
    const items = Array.isArray(body.items) ? sanitizeOrderItems(body.items) : existing.items;
    const pickupChannelId =
      body.pickupChannelId === null || body.pickupChannelId === ''
        ? null
        : body.pickupChannelId !== undefined
          ? parsePositiveId(String(body.pickupChannelId))
          : existing.pickupChannelId;

    db.prepare(
      `UPDATE standing_orders SET
         customer_name = ?, customer_contact = ?, pickup_channel_id = ?, cadence = ?,
         weekday = ?, start_date = ?, is_active = ?, notes = ?, items_json = ?, updated_at = ?
       WHERE id = ?`
    ).run(
      customerName,
      body.customerContact !== undefined
        ? body.customerContact
          ? String(body.customerContact).trim()
          : null
        : existing.customerContact,
      pickupChannelId,
      cadence,
      weekday,
      startDate,
      isActive ? 1 : 0,
      body.notes !== undefined ? (body.notes ? String(body.notes).trim() : null) : existing.notes,
      JSON.stringify(items),
      new Date().toISOString(),
      id
    );

    const { today, endDate } = getHorizon();
    materializeStandingOrders(db, today, endDate);
    res.json(listStandingOrders(db).find((s) => s.id === id));
  });

  router.delete('/standing-orders/:id', (req: Request, res: Response) => {
    const id = parsePositiveId(String(req.params.id));
    if (!id) {
      res.status(400).json({ error: 'Invalid standing order ID' });
      return;
    }
    const db = dbManager.db;
    const { today } = getHorizon();
    const tx = db.transaction(() => {
      db.prepare(
        `DELETE FROM orders
         WHERE source = 'standing' AND standing_order_id = ? AND standing_occurrence_date >= ? AND status = 'slotted'`
      ).run(id, today);
      db.prepare('DELETE FROM standing_orders WHERE id = ?').run(id);
    });
    tx();
    res.json({ deleted: true });
  });

  router.post('/standing-orders/:id/skip', (req: Request, res: Response) => {
    const id = parsePositiveId(String(req.params.id));
    const occurrenceDate = String(req.body?.occurrenceDate || '');
    if (!id || !VALID_DATE_RE.test(occurrenceDate)) {
      res.status(400).json({ error: 'Invalid standing order ID or occurrenceDate' });
      return;
    }
    const db = dbManager.db;
    captureCheckpoint(db, `Skip standing occurrence (${occurrenceDate})`);
    const tx = db.transaction(() => {
      db.prepare(
        `INSERT INTO standing_order_exceptions (standing_order_id, occurrence_date, action, override_order_id)
         VALUES (?, ?, 'skipped', NULL)
         ON CONFLICT(standing_order_id, occurrence_date) DO UPDATE SET action = 'skipped', override_order_id = NULL`
      ).run(id, occurrenceDate);
      db.prepare(
        `DELETE FROM orders WHERE source = 'standing' AND standing_order_id = ? AND standing_occurrence_date = ?`
      ).run(id, occurrenceDate);
    });
    tx();
    res.json({ skipped: true });
  });

  // --- Settings ---
  router.get('/settings', (_req: Request, res: Response) => {
    const settings = dbManager.getSettings();
    res.json({
      settings,
      odooStatus: getRedactedOdooStatus(config),
      githubPublishStatus: getRedactedGithubPublishStatus(config, settings),
    });
  });

  router.put('/settings', (req: Request, res: Response) => {
    const patch = (req.body ?? {}) as Partial<AppSettings>;
    const previous = dbManager.getSettings();
    const snippetFieldChanged = AVAILABILITY_AFFECTING_SETTINGS_KEYS.some(
      (key) =>
        patch[key] !== undefined && JSON.stringify(patch[key]) !== JSON.stringify(previous[key])
    );
    const nextPatch: Partial<AppSettings> = snippetFieldChanged
      ? { ...patch, availabilityLastEditedAt: getNow().toISOString() }
      : patch;
    let updated = dbManager.updateSettings(nextPatch);

    let removedIgnoredOrdersCount = 0;
    if (patch.odooIgnoredDateRanges !== undefined) {
      const purged = purgeOdooOrdersInFullIgnoredRanges(
        dbManager.db,
        updated.odooIgnoredDateRanges,
        updated.timezone
      );
      removedIgnoredOrdersCount = purged.removedCount;
      if (purged.affectedCalendar) {
        updated = dbManager.updateSettings({ availabilityLastEditedAt: getNow().toISOString() });
      }
    }

    onSettingsUpdated?.(updated);
    res.json({
      settings: updated,
      odooStatus: getRedactedOdooStatus(config),
      githubPublishStatus: getRedactedGithubPublishStatus(config, updated),
      removedIgnoredOrdersCount,
    });
  });

  // --- Odoo 19.3 Integration ---
  router.post('/odoo/test', async (_req: Request, res: Response) => {
    try {
      const result = await testOdooConnection(config.odoo, fetchFn);
      res.json(result);
    } catch (err) {
      res.status(502).json({
        ok: false,
        message: err instanceof Error ? err.message : 'Failed to connect to Odoo',
      });
    }
  });

  router.post('/odoo/sync', async (_req: Request, res: Response) => {
    try {
      const db = dbManager.db;
      const result = await syncOdooQuotations({
        db,
        odoo: config.odoo,
        settings: dbManager.getSettings(),
        trackedItems: listTrackedItems(db),
        channels: listPickupChannels(db),
        fetchFn,
      });
      res.json(result);
    } catch (err) {
      res.status(502).json({
        error: err instanceof Error ? err.message : 'Odoo sync failed',
      });
    }
  });

  // --- Customer Directory & Odoo Partner Autocomplete ---
  router.get('/customers', (req: Request, res: Response) => {
    const db = dbManager.db;
    const q = typeof req.query.q === 'string' ? req.query.q : '';
    const limit = req.query.limit !== undefined ? Number(req.query.limit) : 50;
    const customers = listCustomerDirectory(db, q, limit);
    res.json({
      customers,
      odooCustomersCount: countOdooCustomers(db),
      odooConfigured: Boolean(config.odoo),
    });
  });

  router.post('/odoo/customers/sync', async (_req: Request, res: Response) => {
    try {
      const db = dbManager.db;
      const result = await syncOdooCustomers({
        db,
        odoo: config.odoo,
        fetchFn,
      });
      res.json({
        ...result,
        odooCustomersCount: countOdooCustomers(db),
      });
    } catch (err) {
      res.status(502).json({
        error: err instanceof Error ? err.message : 'Failed to sync Odoo customers',
      });
    }
  });

  // --- Public Website Availability Snippet & GitHub Pages Live Sync ---
  router.get('/snippet', (req: Request, res: Response) => {
    const parsedWeeks = req.query.weeks !== undefined ? Number(req.query.weeks) : undefined;
    const { snippet } = buildSnippetForDatabase({
      dbManager,
      config,
      weeksOverride: parsedWeeks && Number.isFinite(parsedWeeks) ? parsedWeeks : undefined,
      now: getNow(),
    });
    res.json(snippet);
  });

  router.post('/snippet/github/test', async (req: Request, res: Response) => {
    try {
      const settings = dbManager.getSettings();
      const body = (req.body ?? {}) as Record<string, unknown>;
      const repo =
        typeof body.repo === 'string' && body.repo.trim()
          ? body.repo.trim()
          : (settings.githubPublishRepo ?? '').trim() ||
            (config.githubPublish?.defaultRepo ?? '').trim();
      const branch =
        typeof body.branch === 'string' && body.branch.trim()
          ? body.branch.trim()
          : (settings.githubPublishBranch ?? '').trim() || 'main';
      const filePath =
        typeof body.filePath === 'string' && body.filePath.trim()
          ? body.filePath.trim()
          : (settings.githubPublishPath ?? '').trim() || 'availability.json';
      const customPublicUrl =
        typeof body.publicUrl === 'string'
          ? body.publicUrl.trim()
          : (settings.githubPublishPublicUrl ?? '').trim();

      const result = await testGithubPublishConnection({
        token: config.githubPublish?.token ?? '',
        repo,
        branch,
        filePath,
        customPublicUrl,
        fetchFn: fetchFn as typeof fetch | undefined,
      });
      res.json(result);
    } catch (err) {
      res.status(502).json({
        ok: false,
        message: err instanceof Error ? err.message : 'GitHub connection test failed',
        publicUrl: null,
      });
    }
  });

  router.post('/snippet/github/publish', async (req: Request, res: Response) => {
    try {
      const body = (req.body ?? {}) as Record<string, unknown>;
      const force = body.force === undefined ? true : Boolean(body.force);
      const overrides = {
        repo: typeof body.repo === 'string' ? body.repo : undefined,
        branch: typeof body.branch === 'string' ? body.branch : undefined,
        filePath: typeof body.filePath === 'string' ? body.filePath : undefined,
        customPublicUrl: typeof body.publicUrl === 'string' ? body.publicUrl : undefined,
      };
      const result = await publishSnippetSnapshotToGithub({
        dbManager,
        config,
        force,
        overrides,
        now: getNow(),
        fetchFn: fetchFn as typeof fetch | undefined,
      });
      res.json(result);
    } catch (err) {
      const settings = dbManager.getSettings();
      res.status(502).json({
        error: err instanceof Error ? err.message : 'Failed to publish availability to GitHub',
        githubPublishStatus: getRedactedGithubPublishStatus(config, settings),
      });
    }
  });

  // --- Undo & Checkpoints ---
  router.get('/checkpoints', (_req: Request, res: Response) => {
    res.json(listCheckpoints(dbManager.db));
  });

  router.post('/checkpoints', (req: Request, res: Response) => {
    const label =
      typeof req.body?.label === 'string' && req.body.label.trim()
        ? req.body.label.trim()
        : `Manual checkpoint (${new Date().toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' })})`;
    const created = captureCheckpoint(dbManager.db, label, true);
    res.status(201).json(created);
  });

  router.post('/checkpoints/undo', (_req: Request, res: Response) => {
    try {
      const result = undoLastCheckpoint(dbManager.db);
      res.json(result);
    } catch (err) {
      res.status(400).json({ error: err instanceof Error ? err.message : 'Nothing to undo' });
    }
  });

  router.post('/checkpoints/:id/restore', (req: Request, res: Response) => {
    const id = parsePositiveId(String(req.params.id));
    if (!id) {
      res.status(400).json({ error: 'Invalid checkpoint ID' });
      return;
    }
    try {
      const result = restoreCheckpointById(dbManager.db, id, false);
      res.json(result);
    } catch (err) {
      res.status(404).json({ error: err instanceof Error ? err.message : 'Restore failed' });
    }
  });

  // --- SQLite Backup & Restore ---
  router.get('/backups', (_req: Request, res: Response) => {
    res.json(dbManager.listBackups());
  });

  router.post('/backups', async (_req: Request, res: Response) => {
    try {
      const info = await dbManager.createBackup('manual');
      res.status(201).json(info);
    } catch (err) {
      res.status(500).json({ error: err instanceof Error ? err.message : 'Backup failed' });
    }
  });

  router.get('/backups/:filename/download', (req: Request, res: Response) => {
    try {
      const filename = String(req.params.filename);
      const safePath = dbManager.resolveSafeBackupPath(filename);
      if (!fs.existsSync(safePath)) {
        res.status(404).json({ error: 'Backup not found' });
        return;
      }
      res.download(safePath, filename);
    } catch (err) {
      res.status(400).json({ error: err instanceof Error ? err.message : 'Invalid filename' });
    }
  });

  router.post('/backups/:filename/restore', async (req: Request, res: Response) => {
    try {
      const filename = String(req.params.filename);
      const safePath = dbManager.resolveSafeBackupPath(filename);
      if (!fs.existsSync(safePath)) {
        res.status(404).json({ error: 'Backup not found' });
        return;
      }
      const result = await dbManager.restoreFromFile(safePath, config.timezone);
      res.json({ restored: true, ...result });
    } catch (err) {
      res.status(400).json({ error: err instanceof Error ? err.message : 'Restore failed' });
    }
  });

  router.post('/backups/upload', upload.single('database'), async (req: Request, res: Response) => {
    const file = req.file;
    if (!file) {
      res.status(400).json({ error: 'No .db file uploaded' });
      return;
    }
    try {
      const result = await dbManager.restoreFromFile(file.path, config.timezone);
      res.json({ restored: true, ...result });
    } catch (err) {
      res.status(400).json({ error: err instanceof Error ? err.message : 'Uploaded file invalid' });
    } finally {
      if (fs.existsSync(file.path)) {
        fs.unlinkSync(file.path);
      }
    }
  });

  return router;
}

export function createExpressApp(options: CreateAppOptions): Express {
  const app = express();
  app.use(express.json({ limit: '5mb' }));
  app.use('/api', createApiRouter(options));
  return app;
}
