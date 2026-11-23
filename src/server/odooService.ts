import type Database from 'better-sqlite3';
import {
  DEFAULT_TIMEZONE,
  isDateInIgnoredRanges,
  localDateStartToOdooUtc,
  odooUtcToLocalDateKey,
  odooUtcToLocalTimestamp,
} from '../shared/timezone';
import type {
  AppSettings,
  OrderItemLine,
  OrderTimingType,
  PickupChannel,
  SuggestedConfirmedOrder,
  SyncLog,
  TrackedItem,
} from '../shared/types';
import { normalizeOdooBaseUrl, type OdooCredentials } from './config';

export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);
const MAX_ODOO_REDIRECTS = 3;

function isSafeOdooRedirectHost(fromHostname: string, toHostname: string): boolean {
  const normFrom = fromHostname.toLowerCase().replace(/^www\./, '');
  const normTo = toHostname.toLowerCase().replace(/^www\./, '');
  return normFrom === normTo;
}

interface OdooSaleOrder {
  id: number;
  name: string;
  state: string;
  create_date: string;
  date_order?: string | false | null;
  commitment_date?: string | false | null;
  partner_id: [number, string] | false | null;
  note?: string | false | null;
  order_line?: number[];
  amount_total?: number;
}

const BASE_SALE_ORDER_FIELDS = [
  'id',
  'name',
  'state',
  'create_date',
  'date_order',
  'partner_id',
  'note',
  'order_line',
] as const;

const EXTENDED_SALE_ORDER_FIELDS = [...BASE_SALE_ORDER_FIELDS, 'commitment_date'] as const;

const SYNCABLE_ODOO_STATES = ['draft', 'sent', 'sale', 'done'] as const;

interface OdooOrderLine {
  id: number;
  order_id: [number, string] | false | null;
  name: string;
  product_uom_qty: number;
}

interface OdooPartner {
  id: number;
  name: string;
  email?: string | false | null;
  phone?: string | false | null;
}

interface OdooMailMessage {
  id: number;
  res_id: number;
  author_id: [number, string] | false | null;
  email_from?: string | false | null;
  message_type: string;
  subtype_id?: [number, string] | false | null;
  body?: string | false | null;
  date: string;
}

/**
 * Strips HTML markup from Odoo notes / mail.message bodies into clean, safe plain text.
 */
export function stripHtmlToPlainText(raw: string | false | null | undefined): string {
  if (!raw) return '';
  return raw
    .replace(/<style[\s\S]*?<\/style>/gi, '')
    .replace(/<script[\s\S]*?<\/script>/gi, '')
    .replace(/<(br|\/p|\/div|\/li|\/tr|\/h[1-6])\s*\/?>/gi, '\n')
    .replace(/<li[^>]*>/gi, '• ')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'")
    .replace(/&#x27;/gi, "'")
    .replace(/\r\n/g, '\n')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

export async function callOdooJson2<T>(params: {
  odoo: OdooCredentials;
  model: string;
  method: string;
  payload: Record<string, unknown>;
  fetchFn?: FetchLike;
}): Promise<T> {
  const { odoo, model, method, payload, fetchFn = fetch } = params;
  const normalizedBaseUrl = normalizeOdooBaseUrl(odoo.url);
  if (!normalizedBaseUrl || !odoo.apiKey) {
    throw new Error('Odoo credentials are not configured');
  }

  const expectedApiPath = `/json/2/${encodeURIComponent(model)}/${encodeURIComponent(method)}`;
  const bodyJson = JSON.stringify(payload);
  const headers: Record<string, string> = {
    Authorization: `bearer ${odoo.apiKey}`,
    'Content-Type': 'application/json; charset=utf-8',
    'User-Agent': 'FarmWaitlist-HA-Addon/1.0',
  };
  if (odoo.db) {
    headers['X-Odoo-Database'] = odoo.db;
  }

  let currentUrl = new URL(`${normalizedBaseUrl}${expectedApiPath}`);
  let response: Response | null = null;

  for (let hop = 0; hop <= MAX_ODOO_REDIRECTS; hop += 1) {
    response = await fetchFn(currentUrl.toString(), {
      method: 'POST',
      headers,
      body: bodyJson,
      redirect: 'manual',
    });

    if (!REDIRECT_STATUSES.has(response.status)) {
      break;
    }

    const location = response.headers.get('location');
    if (!location) {
      throw new Error(
        `Odoo API error (${model}.${method}): ${response.status} redirect without Location header at ${currentUrl.origin}${currentUrl.pathname}`
      );
    }

    if (hop === MAX_ODOO_REDIRECTS) {
      throw new Error(
        `Odoo API error (${model}.${method}): Too many redirects while connecting to ${currentUrl.origin}`
      );
    }

    let nextUrl: URL;
    try {
      nextUrl = new URL(location, currentUrl);
    } catch {
      throw new Error(
        `Odoo API error (${model}.${method}): Invalid redirect target returned by ${currentUrl.origin}`
      );
    }

    if (nextUrl.protocol !== 'https:' && nextUrl.protocol !== 'http:') {
      throw new Error(
        `Odoo API error (${model}.${method}): Refused redirect to unsupported protocol (${nextUrl.protocol})`
      );
    }

    if (currentUrl.protocol === 'https:' && nextUrl.protocol === 'http:') {
      throw new Error(
        `Odoo API error (${model}.${method}): Refused insecure redirect from HTTPS to HTTP (${nextUrl.origin}). Update your Odoo URL to https://.`
      );
    }

    if (!isSafeOdooRedirectHost(currentUrl.hostname, nextUrl.hostname)) {
      throw new Error(
        `Odoo API error (${model}.${method}): ${currentUrl.host} redirected to a different host (${nextUrl.host}). Update your Odoo URL directly to ${nextUrl.origin}.`
      );
    }

    if (!nextUrl.pathname.endsWith(expectedApiPath)) {
      throw new Error(
        `Odoo API error (${model}.${method}): Redirected to ${nextUrl.origin}${nextUrl.pathname} instead of ${expectedApiPath}. Check your Odoo URL (use https://<host> without /odoo or /web) and Odoo Database name.`
      );
    }

    currentUrl = nextUrl;
  }

  if (!response) {
    throw new Error(`Odoo API error (${model}.${method}): No response received from Odoo`);
  }

  const rawText = await response.text();
  let parsedBody: unknown = null;
  if (rawText) {
    try {
      parsedBody = JSON.parse(rawText);
    } catch {
      parsedBody = null;
    }
  }

  if (!response.ok) {
    let detail = `${response.status} ${response.statusText}`;
    if (parsedBody && typeof parsedBody === 'object') {
      const errObj = parsedBody as {
        message?: string;
        name?: string;
        error?: { message?: string; data?: { message?: string } };
      };
      const msg =
        errObj.message || errObj.error?.data?.message || errObj.error?.message;
      if (msg) {
        detail = `${response.status}: ${msg}`;
      }
    }
    if (response.status === 404) {
      detail = `${detail} (POST ${currentUrl.origin}${currentUrl.pathname} — verify Odoo URL is the base https://<host> without /odoo or /web)`;
    }
    throw new Error(`Odoo API error (${model}.${method}): ${detail}`);
  }

  if (parsedBody === null) {
    throw new Error(
      `Odoo API (${model}.${method}) returned a non-JSON response. Verify your Odoo Base URL.`
    );
  }

  if (
    parsedBody &&
    typeof parsedBody === 'object' &&
    !Array.isArray(parsedBody) &&
    'error' in parsedBody
  ) {
    const errObj = (parsedBody as { error?: { message?: string; data?: { message?: string } } }).error;
    const msg = errObj?.data?.message || errObj?.message || 'Unknown Odoo error';
    throw new Error(`Odoo API error (${model}.${method}): ${msg}`);
  }

  return parsedBody as T;
}

export interface ParsedOrderSignals {
  matchedItems: OrderItemLine[];
  timingType: OrderTimingType;
  requestedDate: string | null;
  pickupChannelId: number | null;
  freeTextPickup: string | null;
  inferredCustomerName: string | null;
}

function escapeRegex(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Extracts Tracked Item quantities, timing hints (ASAP vs specific YYYY-MM-DD),
 * pickup channel matches, and fallback customer name from order notes, line descriptions,
 * and filtered chatter text.
 */
export function parseOdooOrderSignals(params: {
  noteText: string;
  lines: OdooOrderLine[];
  chatterTexts: string[];
  trackedItems: TrackedItem[];
  channels: PickupChannel[];
}): ParsedOrderSignals {
  const { noteText, lines, chatterTexts, trackedItems, channels } = params;
  const lineDescriptions = lines.map((l) => `${l.product_uom_qty} ${l.name}`.trim());
  const combinedText = [noteText, ...lineDescriptions, ...chatterTexts].filter(Boolean).join('\n');
  const combinedLower = combinedText.toLowerCase();

  const qtyByItem = new Map<number, number>();

  // 1. Match directly from Odoo order lines first (most structured)
  for (const line of lines) {
    const lineLower = (line.name || '').toLowerCase();
    for (const item of trackedItems) {
      const keywords = [item.name.toLowerCase(), ...item.keywordRules.map((k) => k.toLowerCase())].filter(
        Boolean
      );
      if (keywords.some((kw) => lineLower.includes(kw))) {
        const qty = Number(line.product_uom_qty) > 0 ? Number(line.product_uom_qty) : 1;
        qtyByItem.set(item.id, Math.round(((qtyByItem.get(item.id) ?? 0) + qty) * 1000) / 1000);
        break;
      }
    }
  }

  // 2. If no structured order lines matched, scan free-text notes & chatter for "<qty> [unit] <keyword>"
  if (qtyByItem.size === 0) {
    const freeText = [noteText, ...chatterTexts].filter(Boolean).join('\n');
    for (const item of trackedItems) {
      const keywords = [item.name, ...item.keywordRules].map((k) => k.trim()).filter(Boolean);
      for (const kw of keywords) {
        const kwEsc = escapeRegex(kw);
        const beforeRe = new RegExp(`(\\d+(?:\\.\\d+)?)\\s*(?:[a-zA-Z.]{1,12}\\s+)?${kwEsc}`, 'i');
        const afterRe = new RegExp(`${kwEsc}\\s*[:\\-x]?\\s*(\\d+(?:\\.\\d+)?)`, 'i');
        const matchBefore = beforeRe.exec(freeText);
        const matchAfter = afterRe.exec(freeText);
        const rawNum = matchBefore?.[1] ?? matchAfter?.[1];
        if (rawNum) {
          const parsed = Number(rawNum);
          if (parsed > 0) {
            qtyByItem.set(item.id, Math.round(parsed * 1000) / 1000);
            break;
          }
        }
      }
    }
  }

  // 3. Pickup channel matching
  let pickupChannelId: number | null = null;
  for (const ch of channels) {
    if (ch.name && combinedLower.includes(ch.name.toLowerCase())) {
      pickupChannelId = ch.id;
      break;
    }
  }
  const pickupLineMatch = /(?:pickup|location|market|channel)\s*[:\-]\s*([^\n]+)/i.exec(combinedText);
  const freeTextPickup = pickupLineMatch ? pickupLineMatch[1].trim().slice(0, 120) : null;

  // 4. Timing extraction (YYYY-MM-DD explicit date vs ASAP)
  let timingType: OrderTimingType = 'asap';
  let requestedDate: string | null = null;
  const isoDateMatch = /\b(20\d{2}-\d{2}-\d{2})\b/.exec(combinedText);
  if (isoDateMatch && !/\basap\b/i.test(combinedText)) {
    timingType = 'specific_date';
    requestedDate = isoDateMatch[1];
  } else if (isoDateMatch && /(?:for|on|date|pickup)\s*[:\-]?\s*20\d{2}-\d{2}-\d{2}/i.test(combinedText)) {
    timingType = 'specific_date';
    requestedDate = isoDateMatch[1];
  }

  // 5. Fallback customer name from form text if partner_id missing
  const nameMatch = /(?:^|\n)\s*(?:customer|name|from)\s*[:\-]\s*([^\n<]{2,80})/i.exec(combinedText);
  const inferredCustomerName = nameMatch ? nameMatch[1].trim() : null;

  const matchedItems: OrderItemLine[] = Array.from(qtyByItem.entries()).map(
    ([trackedItemId, quantity]) => ({ trackedItemId, quantity })
  );

  return {
    matchedItems,
    timingType,
    requestedDate,
    pickupChannelId,
    freeTextPickup,
    inferredCustomerName,
  };
}

function itemsSignature(items: OrderItemLine[]): string {
  return [...items]
    .sort((a, b) => a.trackedItemId - b.trackedItemId)
    .map((i) => `${i.trackedItemId}:${i.quantity}`)
    .join('|');
}

export async function testOdooConnection(
  odoo: OdooCredentials,
  fetchFn?: FetchLike
): Promise<{ ok: boolean; message: string; sampleCount?: number }> {
  if (!odoo.url || !odoo.apiKey) {
    return {
      ok: false,
      message: 'Odoo URL or API key not configured in Home Assistant add-on options or .env',
    };
  }
  const rows = await callOdooJson2<Array<{ id: number }>>({
    odoo,
    model: 'sale.order',
    method: 'search_read',
    payload: {
      domain: [['state', 'in', [...SYNCABLE_ODOO_STATES]]],
      fields: ['id'],
      limit: 1,
      context: { lang: 'en_US' },
    },
    fetchFn,
  });
  return {
    ok: true,
    message: `Connected to Odoo 19.3 (/json/2/, read-only). Found ${rows.length >= 1 ? 'quotations / sales orders' : '0 quotations or sales orders right now'}.`,
    sampleCount: rows.length,
  };
}

export interface SyncResult {
  syncLog: SyncLog;
}

/**
 * Full read-only Odoo 19.3 /json/2/ sync (uses search_read exclusively — NEVER writes to Odoo):
 * - Fetches both open Quotations (draft, sent) AND processed Sales Orders (sale, done)
 * - Applies syncCutoffDate (local timezone midnight converted to UTC) across create_date or date_order
 * - Also re-queries existing non-ignored local odoo_quotation_ids so they keep updating even if cutoff moves forward
 * - Requests commitment_date (Delivery Date) with automatic fallback if sale_stock is not installed
 * - Normalizes Odoo UTC timestamps -> settings.timezone (default America/New_York)
 * - Skips brand-new orders inside ignoredDateRanges or locally ignored IDs
 * - Pulls mail.message filtered strictly to message_type in ['comment', 'email']
 * - Brand-new confirmed Sales Orders import directly as status='confirmed' (auto-slotted onto
 *   requested/commitment date if present, or queued at the top of Unslotted Queue as Confirmed if no date set)
 * - Existing quotations confirmed in-place in Odoo promote to status='confirmed' while preserving local slots
 * - Updates existing orders without overwriting local slot/lock/overridden name
 * - Flags missing/deleted/cancelled Odoo draft quotations with optional suggested confirmed order match (NEVER auto-confirms)
 */
export async function syncOdooQuotations(params: {
  db: Database.Database;
  odoo: OdooCredentials;
  settings: AppSettings;
  trackedItems: TrackedItem[];
  channels: PickupChannel[];
  fetchFn?: FetchLike;
}): Promise<SyncResult> {
  const { db, odoo, settings, trackedItems, channels, fetchFn } = params;
  const timezone = settings.timezone || DEFAULT_TIMEZONE;
  const startedAt = new Date().toISOString();

  const logInsert = db
    .prepare(
      `INSERT INTO sync_logs (started_at, status, fetched_count, imported_count, updated_count, flagged_missing_count)
       VALUES (?, 'running', 0, 0, 0, 0)`
    )
    .run(startedAt);
  const logId = Number(logInsert.lastInsertRowid);

  let supportsCommitmentDate = true;
  const searchReadSaleOrders = async (
    domain: unknown[],
    options: { order?: string; limit: number }
  ): Promise<OdooSaleOrder[]> => {
    const queryWithFields = (fields: readonly string[]) =>
      callOdooJson2<OdooSaleOrder[]>({
        odoo,
        model: 'sale.order',
        method: 'search_read',
        payload: {
          domain,
          fields: [...fields],
          ...(options.order ? { order: options.order } : {}),
          limit: options.limit,
          context: { lang: 'en_US' },
        },
        fetchFn,
      });

    if (!supportsCommitmentDate) {
      return queryWithFields(BASE_SALE_ORDER_FIELDS);
    }
    try {
      return await queryWithFields(EXTENDED_SALE_ORDER_FIELDS);
    } catch (err) {
      const msg = err instanceof Error ? err.message : '';
      if (/commitment_date|invalid field/i.test(msg)) {
        supportsCommitmentDate = false;
        return queryWithFields(BASE_SALE_ORDER_FIELDS);
      }
      throw err;
    }
  };

  try {
    // Load existing local Odoo orders (both active and ignored)
    const localOdooRows = db
      .prepare(
        `SELECT id, status, timing_type, requested_date, slotted_date, is_locked,
                customer_name, customer_name_overridden,
                odoo_quotation_id, odoo_partner_id, odoo_missing_flagged
         FROM orders
         WHERE source = 'odoo' AND odoo_quotation_id IS NOT NULL`
      )
      .all() as Array<{
      id: number;
      status: string;
      timing_type: OrderTimingType;
      requested_date: string | null;
      slotted_date: string | null;
      is_locked: number;
      customer_name: string;
      customer_name_overridden: number;
      odoo_quotation_id: number;
      odoo_partner_id: number | null;
      odoo_missing_flagged: number;
    }>;

    const localByOdooId = new Map(localOdooRows.map((r) => [r.odoo_quotation_id, r]));
    const syncedLocalOdooIds = localOdooRows
      .filter((r) => r.status !== 'ignored')
      .map((r) => r.odoo_quotation_id);

    const mergedOdooRows = db
      .prepare('SELECT odoo_quotation_id FROM merged_odoo_links')
      .all() as Array<{ odoo_quotation_id: number }>;
    const mergedOdooIdSet = new Set(mergedOdooRows.map((r) => r.odoo_quotation_id));

    // 1. Fetch Quotations (draft, sent) AND processed Sales Orders (sale, done) matching cutoff date
    let openDomain: unknown[];
    if (settings.odooSyncCutoffDate) {
      const cutoffUtc = localDateStartToOdooUtc(settings.odooSyncCutoffDate, timezone);
      openDomain = [
        '&',
        ['state', 'in', [...SYNCABLE_ODOO_STATES]],
        '|',
        ['create_date', '>=', cutoffUtc],
        ['date_order', '>=', cutoffUtc],
      ];
    } else {
      openDomain = [['state', 'in', [...SYNCABLE_ODOO_STATES]]];
    }

    const fetchedNewWindow = await searchReadSaleOrders(openDomain, {
      order: 'create_date asc',
      limit: 500,
    });

    // 2. Also fetch already-imported non-ignored local Odoo orders by ID (independent of cutoff date)
    const fetchedById = new Map<number, OdooSaleOrder>();
    for (const q of fetchedNewWindow) {
      fetchedById.set(q.id, q);
    }

    const missingActiveFromWindow = syncedLocalOdooIds.filter((id) => !fetchedById.has(id));
    if (missingActiveFromWindow.length > 0) {
      const existingCheck = await searchReadSaleOrders(
        [
          ['id', 'in', missingActiveFromWindow],
          ['state', 'in', [...SYNCABLE_ODOO_STATES]],
        ],
        { limit: 500 }
      );
      for (const q of existingCheck) {
        fetchedById.set(q.id, q);
      }
    }

    const allFetchedOrders = Array.from(fetchedById.values());

    // Filter out brand-new orders that are locally ignored, already merged into another order, or inside ignored date ranges
    const eligibleQuotations = allFetchedOrders.filter((q) => {
      if (mergedOdooIdSet.has(q.id)) {
        return false;
      }
      const existing = localByOdooId.get(q.id);
      if (existing) {
        return existing.status !== 'ignored';
      }
      const isConfirmedInOdoo = q.state === 'sale' || q.state === 'done';
      const anchorTimestamp =
        isConfirmedInOdoo && typeof q.date_order === 'string' && q.date_order
          ? q.date_order
          : q.create_date;
      const localOrderDate = odooUtcToLocalDateKey(anchorTimestamp, timezone);
      if (isDateInIgnoredRanges(localOrderDate, settings.odooIgnoredDateRanges)) {
        return false;
      }
      return true;
    });

    const eligibleIds = eligibleQuotations.map((q) => q.id);

    // 3. Batch fetch sale.order.line, res.partner, and mail.message (filtered to comment & email ONLY)
    let allLines: OdooOrderLine[] = [];
    let allPartners: OdooPartner[] = [];
    let allMessages: OdooMailMessage[] = [];

    if (eligibleIds.length > 0) {
      const lineIds = eligibleQuotations.flatMap((q) => q.order_line ?? []);
      if (lineIds.length > 0) {
        allLines = await callOdooJson2<OdooOrderLine[]>({
          odoo,
          model: 'sale.order.line',
          method: 'search_read',
          payload: {
            domain: [['id', 'in', lineIds]],
            fields: ['id', 'order_id', 'name', 'product_uom_qty'],
            limit: 2000,
            context: { lang: 'en_US' },
          },
          fetchFn,
        });
      }

      const partnerIds = Array.from(
        new Set(
          eligibleQuotations
            .map((q) => (Array.isArray(q.partner_id) ? q.partner_id[0] : null))
            .filter((id): id is number => id !== null)
        )
      );
      if (partnerIds.length > 0) {
        allPartners = await callOdooJson2<OdooPartner[]>({
          odoo,
          model: 'res.partner',
          method: 'search_read',
          payload: {
            domain: [['id', 'in', partnerIds]],
            fields: ['id', 'name', 'email', 'phone'],
            limit: 1000,
            context: { lang: 'en_US' },
          },
          fetchFn,
        });
      }

      // Strictly filter mail.message to message_type in ['comment', 'email']
      allMessages = await callOdooJson2<OdooMailMessage[]>({
        odoo,
        model: 'mail.message',
        method: 'search_read',
        payload: {
          domain: [
            ['model', '=', 'sale.order'],
            ['res_id', 'in', eligibleIds],
            ['message_type', 'in', ['comment', 'email']],
          ],
          fields: ['id', 'res_id', 'author_id', 'email_from', 'message_type', 'subtype_id', 'body', 'date'],
          order: 'date asc',
          limit: 2000,
          context: { lang: 'en_US' },
        },
        fetchFn,
      });
    }

    const linesByOrder = new Map<number, OdooOrderLine[]>();
    for (const line of allLines) {
      const oid = Array.isArray(line.order_id) ? line.order_id[0] : null;
      if (!oid) continue;
      const arr = linesByOrder.get(oid) ?? [];
      arr.push(line);
      linesByOrder.set(oid, arr);
    }

    const partnersById = new Map<number, OdooPartner>(allPartners.map((p) => [p.id, p]));

    const messagesByOrder = new Map<number, OdooMailMessage[]>();
    for (const msg of allMessages) {
      // Defensive guard: enforce comment/email filter even if remote API returned extras
      if (msg.message_type !== 'comment' && msg.message_type !== 'email') continue;
      const arr = messagesByOrder.get(msg.res_id) ?? [];
      arr.push(msg);
      messagesByOrder.set(msg.res_id, arr);
    }

    let importedCount = 0;
    let updatedCount = 0;
    const nowIso = new Date().toISOString();

    // 4. Upsert orders & chatter inside a transaction
    const upsertTx = db.transaction(() => {
      for (const q of eligibleQuotations) {
        const existing = localByOdooId.get(q.id);
        const isConfirmedInOdoo = q.state === 'sale' || q.state === 'done';
        const partnerId = Array.isArray(q.partner_id) ? q.partner_id[0] : null;
        const partner = partnerId ? partnersById.get(partnerId) : undefined;
        const partnerName = partner?.name || (Array.isArray(q.partner_id) ? q.partner_id[1] : null);
        const partnerEmail = partner?.email || null;
        const partnerPhone = partner?.phone || null;

        const qLines = linesByOrder.get(q.id) ?? [];
        const qMsgs = messagesByOrder.get(q.id) ?? [];
        const noteText = stripHtmlToPlainText(q.note);
        const chatterTexts = qMsgs.map((m) => stripHtmlToPlainText(m.body)).filter(Boolean);
        const rawLineStrings = qLines.map((l) => `${l.product_uom_qty} × ${l.name}`);
        const createdAtLocal = odooUtcToLocalTimestamp(q.create_date, timezone);
        const commitmentDateLocal =
          typeof q.commitment_date === 'string' && q.commitment_date.trim()
            ? odooUtcToLocalDateKey(q.commitment_date, timezone)
            : null;

        const signals = parseOdooOrderSignals({
          noteText,
          lines: qLines,
          chatterTexts,
          trackedItems,
          channels,
        });

        const explicitPickupDate = signals.requestedDate || commitmentDateLocal || null;
        const resolvedTimingType: OrderTimingType = explicitPickupDate
          ? 'specific_date'
          : signals.timingType;

        const resolvedName =
          partnerName || signals.inferredCustomerName || `Order ${q.name || `#${q.id}`}`;

        let localOrderId: number;

        if (!existing) {
          // Brand-new confirmed Sales Orders enter directly as 'confirmed' (slotted onto their
          // explicit pickup/delivery date if set, or left unslotted at top of queue to assign a day).
          // Open Quotations (draft/sent) always enter as unslotted 'waitlist'.
          const initialStatus = isConfirmedInOdoo ? 'confirmed' : 'waitlist';
          const initialSlottedDate = isConfirmedInOdoo ? explicitPickupDate : null;

          const insertRes = db
            .prepare(
              `INSERT INTO orders (
                source, status, timing_type, requested_date, slotted_date, is_locked,
                customer_name, customer_name_overridden, customer_email, customer_phone,
                pickup_channel_id, free_text_pickup, notes,
                odoo_quotation_id, odoo_quotation_name, odoo_partner_id, odoo_created_at_local,
                odoo_raw_notes, odoo_raw_lines_json, odoo_updated_after_slot, odoo_missing_flagged,
                created_at, updated_at
              ) VALUES (
                'odoo', ?, ?, ?, ?, 0,
                ?, 0, ?, ?,
                ?, ?, ?,
                ?, ?, ?, ?,
                ?, ?, 0, 0,
                ?, ?
              )`
            )
            .run(
              initialStatus,
              resolvedTimingType,
              explicitPickupDate,
              initialSlottedDate,
              resolvedName,
              partnerEmail,
              partnerPhone,
              signals.pickupChannelId,
              signals.freeTextPickup,
              noteText || null,
              q.id,
              q.name || `SO-${q.id}`,
              partnerId,
              createdAtLocal,
              noteText || null,
              JSON.stringify(rawLineStrings),
              nowIso,
              nowIso
            );

          localOrderId = Number(insertRes.lastInsertRowid);
          const itemStmt = db.prepare(
            'INSERT INTO order_items (order_id, tracked_item_id, quantity) VALUES (?, ?, ?)'
          );
          for (const line of signals.matchedItems) {
            itemStmt.run(localOrderId, line.trackedItemId, line.quantity);
          }
          importedCount += 1;
        } else {
          localOrderId = existing.id;
          const existingItems = db
            .prepare('SELECT tracked_item_id, quantity FROM order_items WHERE order_id = ?')
            .all(localOrderId) as Array<{ tracked_item_id: number; quantity: number }>;
          const prevSig = itemsSignature(
            existingItems.map((e) => ({ trackedItemId: e.tracked_item_id, quantity: e.quantity }))
          );
          const nextSig = itemsSignature(signals.matchedItems);
          const quantitiesChanged =
            signals.matchedItems.length > 0 && prevSig !== nextSig;
          const flagUpdatedAfterSlot =
            quantitiesChanged && Boolean(existing.slotted_date) ? 1 : 0;

          const nextName = existing.customer_name_overridden ? existing.customer_name : resolvedName;
          const nextStatus =
            isConfirmedInOdoo && existing.status !== 'confirmed'
              ? 'confirmed'
              : existing.status;
          const nextSlottedDate =
            existing.slotted_date ?? (isConfirmedInOdoo ? explicitPickupDate : null);
          const nextRequestedDate = existing.requested_date ?? explicitPickupDate;
          const nextTimingType: OrderTimingType = nextRequestedDate
            ? 'specific_date'
            : existing.timing_type;

          db.prepare(
            `UPDATE orders SET
               status = ?,
               timing_type = ?,
               requested_date = ?,
               slotted_date = ?,
               customer_name = ?,
               customer_email = COALESCE(?, customer_email),
               customer_phone = COALESCE(?, customer_phone),
               odoo_quotation_name = ?,
               odoo_partner_id = ?,
               odoo_created_at_local = ?,
               odoo_raw_notes = ?,
               odoo_raw_lines_json = ?,
               odoo_missing_flagged = 0,
               odoo_suggested_confirmed_json = NULL,
               odoo_updated_after_slot = CASE WHEN ? = 1 THEN 1 ELSE odoo_updated_after_slot END,
               updated_at = ?
             WHERE id = ?`
          ).run(
            nextStatus,
            nextTimingType,
            nextRequestedDate,
            nextSlottedDate,
            nextName,
            partnerEmail,
            partnerPhone,
            q.name || `SO-${q.id}`,
            partnerId,
            createdAtLocal,
            noteText || null,
            JSON.stringify(rawLineStrings),
            flagUpdatedAfterSlot,
            nowIso,
            localOrderId
          );

          if (quantitiesChanged) {
            db.prepare('DELETE FROM order_items WHERE order_id = ?').run(localOrderId);
            const itemStmt = db.prepare(
              'INSERT INTO order_items (order_id, tracked_item_id, quantity) VALUES (?, ?, ?)'
            );
            for (const line of signals.matchedItems) {
              itemStmt.run(localOrderId, line.trackedItemId, line.quantity);
            }
          }
          updatedCount += 1;
        }

        // Upsert filtered chatter messages (comment & email only) with normalized local timestamps
        const chatterStmt = db.prepare(
          `INSERT INTO order_chatter (
             order_id, odoo_message_id, author_name, message_type, subtype_name,
             body_text, created_at_utc, created_at_local
           ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT(order_id, odoo_message_id) DO UPDATE SET
             author_name = excluded.author_name,
             body_text = excluded.body_text,
             created_at_local = excluded.created_at_local`
        );
        for (const msg of qMsgs) {
          const authorName = Array.isArray(msg.author_id)
            ? msg.author_id[1]
            : msg.email_from || 'Odoo User';
          const subtypeName = Array.isArray(msg.subtype_id) ? msg.subtype_id[1] : null;
          const bodyText = stripHtmlToPlainText(msg.body);
          if (!bodyText) continue;
          const localMsgTime = odooUtcToLocalTimestamp(msg.date, timezone);
          chatterStmt.run(
            localOrderId,
            msg.id,
            authorName,
            msg.message_type,
            subtypeName,
            bodyText,
            msg.date,
            localMsgTime
          );
        }
      }
    });

    upsertTx();

    // 5. Deleted / Cancelled Quotation Reconciliation (ALWAYS flag for 1-click manual confirmation; NEVER auto-confirm)
    const missingLocalOrders = localOdooRows.filter(
      (r) =>
        r.status !== 'ignored' &&
        r.status !== 'confirmed' &&
        !fetchedById.has(r.odoo_quotation_id)
    );

    let flaggedMissingCount = 0;
    if (missingLocalOrders.length > 0) {
      // Query recent confirmed sale.orders in Odoo to attach a helpful suggested match hint
      let confirmedOrders: OdooSaleOrder[] = [];
      try {
        confirmedOrders = await callOdooJson2<OdooSaleOrder[]>({
          odoo,
          model: 'sale.order',
          method: 'search_read',
          payload: {
            domain: [['state', 'in', ['sale', 'done']]],
            fields: ['id', 'name', 'state', 'date_order', 'create_date', 'partner_id', 'amount_total'],
            order: 'date_order desc',
            limit: 100,
            context: { lang: 'en_US' },
          },
          fetchFn,
        });
      } catch {
        confirmedOrders = [];
      }

      const flagTx = db.transaction(() => {
        for (const missing of missingLocalOrders) {
          const matchedConfirmed = confirmedOrders.find((c) => {
            const cPartnerId = Array.isArray(c.partner_id) ? c.partner_id[0] : null;
            const cPartnerName = Array.isArray(c.partner_id) ? c.partner_id[1] : '';
            if (missing.odoo_partner_id && cPartnerId === missing.odoo_partner_id) return true;
            if (
              cPartnerName &&
              missing.customer_name &&
              cPartnerName.toLowerCase().trim() === missing.customer_name.toLowerCase().trim()
            ) {
              return true;
            }
            return false;
          });

          const suggestion: SuggestedConfirmedOrder | null = matchedConfirmed
            ? {
                odooOrderId: matchedConfirmed.id,
                odooOrderName: matchedConfirmed.name,
                partnerName: Array.isArray(matchedConfirmed.partner_id)
                  ? matchedConfirmed.partner_id[1]
                  : missing.customer_name,
                dateOrderLocal: odooUtcToLocalTimestamp(
                  (typeof matchedConfirmed.date_order === 'string' && matchedConfirmed.date_order) ||
                    matchedConfirmed.create_date,
                  timezone
                ),
                state: matchedConfirmed.state,
                amountTotal: matchedConfirmed.amount_total,
              }
            : null;

          db.prepare(
            `UPDATE orders
             SET odoo_missing_flagged = 1,
                 odoo_suggested_confirmed_json = ?,
                 updated_at = ?
             WHERE id = ?`
          ).run(suggestion ? JSON.stringify(suggestion) : null, nowIso, missing.id);
          flaggedMissingCount += 1;
        }
      });
      flagTx();
    }

    const finishedAt = new Date().toISOString();
    db.prepare(
      `UPDATE sync_logs
       SET finished_at = ?, status = 'success', fetched_count = ?, imported_count = ?,
           updated_count = ?, flagged_missing_count = ?
       WHERE id = ?`
    ).run(
      finishedAt,
      allFetchedOrders.length,
      importedCount,
      updatedCount,
      flaggedMissingCount,
      logId
    );

    const syncLog: SyncLog = getSyncLogById(db, logId) ?? {
      id: logId,
      startedAt,
      finishedAt,
      status: 'success',
      fetchedCount: allFetchedOrders.length,
      importedCount,
      updatedCount,
      flaggedMissingCount,
      errorMessage: null,
    };
    return { syncLog };
  } catch (err) {
    const finishedAt = new Date().toISOString();
    const message = err instanceof Error ? err.message : 'Unknown Odoo sync error';
    db.prepare(
      `UPDATE sync_logs SET finished_at = ?, status = 'error', error_message = ? WHERE id = ?`
    ).run(finishedAt, message, logId);
    throw err;
  }
}

export function getSyncLogById(db: Database.Database, id: number): SyncLog | null {
  const r = db.prepare('SELECT * FROM sync_logs WHERE id = ?').get(id) as
    | {
        id: number;
        started_at: string;
        finished_at: string | null;
        status: 'running' | 'success' | 'error';
        fetched_count: number;
        imported_count: number;
        updated_count: number;
        flagged_missing_count: number;
        error_message: string | null;
      }
    | undefined;
  if (!r) return null;
  return {
    id: r.id,
    startedAt: r.started_at,
    finishedAt: r.finished_at,
    status: r.status,
    fetchedCount: r.fetched_count,
    importedCount: r.imported_count,
    updatedCount: r.updated_count,
    flaggedMissingCount: r.flagged_missing_count,
    errorMessage: r.error_message,
  };
}

export function getLatestSyncLog(db: Database.Database): SyncLog | null {
  const row = db.prepare('SELECT id FROM sync_logs ORDER BY id DESC LIMIT 1').get() as
    | { id: number }
    | undefined;
  return row ? getSyncLogById(db, row.id) : null;
}
