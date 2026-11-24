import type Database from 'better-sqlite3';
import type {
  CustomerSuggestion,
  DailySupplyEntry,
  OrderChatterMessage,
  OrderItemLine,
  OrderRecord,
  OrderSource,
  OrderStatus,
  OrderTimingType,
  PickupChannel,
  SuggestedConfirmedOrder,
  SupplyMode,
  TrackedItem,
} from '../shared/types';

function safeJsonParse<T>(raw: string | null | undefined, fallback: T): T {
  if (!raw) return fallback;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return fallback;
  }
}

export function listTrackedItems(db: Database.Database): TrackedItem[] {
  const rows = db
    .prepare('SELECT * FROM tracked_items ORDER BY sort_order ASC, id ASC')
    .all() as Array<{
    id: number;
    name: string;
    unit_label: string;
    is_active: number;
    supply_mode: SupplyMode;
    default_daily_production: number;
    global_safety_buffer: number;
    include_in_public_snippet: number;
    keyword_rules_json: string;
    sort_order: number;
    created_at: string;
    updated_at: string;
  }>;

  return rows.map((r) => ({
    id: r.id,
    name: r.name,
    unitLabel: r.unit_label,
    isActive: Boolean(r.is_active),
    supplyMode: r.supply_mode,
    defaultDailyProduction: r.default_daily_production,
    globalSafetyBuffer: r.global_safety_buffer,
    includeInPublicSnippet: Boolean(r.include_in_public_snippet),
    keywordRules: safeJsonParse<string[]>(r.keyword_rules_json, []),
    sortOrder: r.sort_order,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  }));
}

export function listPickupChannels(db: Database.Database): PickupChannel[] {
  const rows = db
    .prepare('SELECT * FROM pickup_channels ORDER BY sort_order ASC, id ASC')
    .all() as Array<{
    id: number;
    name: string;
    allowed_weekdays_json: string;
    specific_dates_json?: string | null;
    color_token: string;
    is_active: number;
    sort_order: number;
  }>;

  return rows.map((r) => ({
    id: r.id,
    name: r.name,
    allowedWeekdays: safeJsonParse<number[]>(r.allowed_weekdays_json, [1, 2, 3, 4, 5, 6, 7]),
    specificDates: safeJsonParse<string[]>(r.specific_dates_json, []),
    colorToken: r.color_token,
    isActive: Boolean(r.is_active),
    sortOrder: r.sort_order,
  }));
}

export function listDailySupplyEntries(db: Database.Database): DailySupplyEntry[] {
  const rows = db
    .prepare('SELECT * FROM daily_supply_entries ORDER BY date ASC')
    .all() as Array<{
    id: number;
    tracked_item_id: number;
    date: string;
    actual_on_hand: number | null;
    est_produced: number | null;
    actual_end_of_day?: number | null;
    is_cascade_anchor: number;
    buffer_override: number | null;
    extra_buffer?: number | null;
    notes: string | null;
  }>;

  return rows.map((r) => ({
    id: r.id,
    trackedItemId: r.tracked_item_id,
    date: r.date,
    actualOnHand: r.actual_on_hand,
    estProduced: r.est_produced,
    actualEndOfDay: typeof r.actual_end_of_day === 'number' ? r.actual_end_of_day : null,
    isCascadeAnchor: Boolean(r.is_cascade_anchor),
    bufferOverride: r.buffer_override,
    extraBuffer: typeof r.extra_buffer === 'number' ? r.extra_buffer : 0,
    notes: r.notes,
  }));
}

interface RawOrderRow {
  id: number;
  source: OrderSource;
  status: OrderStatus;
  timing_type: OrderTimingType;
  requested_date: string | null;
  slotted_date: string | null;
  is_locked: number;
  customer_name: string;
  customer_name_overridden: number;
  customer_email: string | null;
  customer_phone: string | null;
  pickup_channel_id: number | null;
  free_text_pickup: string | null;
  notes: string | null;
  pre_approved_at: string | null;
  standing_order_id: number | null;
  standing_occurrence_date: string | null;
  odoo_quotation_id: number | null;
  odoo_quotation_name: string | null;
  odoo_partner_id: number | null;
  odoo_created_at_local: string | null;
  odoo_raw_notes: string | null;
  odoo_raw_lines_json: string;
  odoo_updated_after_slot: number;
  odoo_missing_flagged: number;
  odoo_suggested_confirmed_json: string | null;
  waitlist_sort_order?: number | null;
  created_at: string;
  updated_at: string;
}

function hydrateOrders(db: Database.Database, rows: RawOrderRow[]): OrderRecord[] {
  if (rows.length === 0) return [];

  const itemRows = db
    .prepare('SELECT id, order_id, tracked_item_id, quantity FROM order_items ORDER BY id ASC')
    .all() as Array<{ id: number; order_id: number; tracked_item_id: number; quantity: number }>;

  const chatterRows = db
    .prepare(
      `SELECT id, order_id, odoo_message_id, author_name, message_type, subtype_name,
              body_text, created_at_utc, created_at_local
       FROM order_chatter
       ORDER BY created_at_utc ASC, id ASC`
    )
    .all() as Array<{
    id: number;
    order_id: number;
    odoo_message_id: number;
    author_name: string;
    message_type: 'comment' | 'email';
    subtype_name: string | null;
    body_text: string;
    created_at_utc: string;
    created_at_local: string;
  }>;

  const itemsByOrder = new Map<number, OrderItemLine[]>();
  for (const r of itemRows) {
    const arr = itemsByOrder.get(r.order_id) ?? [];
    arr.push({
      id: r.id,
      orderId: r.order_id,
      trackedItemId: r.tracked_item_id,
      quantity: r.quantity,
    });
    itemsByOrder.set(r.order_id, arr);
  }

  const chatterByOrder = new Map<number, OrderChatterMessage[]>();
  for (const c of chatterRows) {
    const arr = chatterByOrder.get(c.order_id) ?? [];
    arr.push({
      id: c.id,
      orderId: c.order_id,
      odooMessageId: c.odoo_message_id,
      authorName: c.author_name,
      messageType: c.message_type,
      subtypeName: c.subtype_name,
      bodyText: c.body_text,
      createdAtUtc: c.created_at_utc,
      createdAtLocal: c.created_at_local,
    });
    chatterByOrder.set(c.order_id, arr);
  }

  const mergedRows = db
    .prepare(
      `SELECT target_order_id, odoo_quotation_id, odoo_quotation_name
       FROM merged_odoo_links
       ORDER BY merged_at ASC`
    )
    .all() as Array<{
    target_order_id: number;
    odoo_quotation_id: number;
    odoo_quotation_name: string | null;
  }>;

  const mergedNamesByOrder = new Map<number, string[]>();
  for (const m of mergedRows) {
    const arr = mergedNamesByOrder.get(m.target_order_id) ?? [];
    arr.push(m.odoo_quotation_name || `SO-${m.odoo_quotation_id}`);
    mergedNamesByOrder.set(m.target_order_id, arr);
  }

  const dismissedRows = db
    .prepare('SELECT order_id_a, order_id_b FROM dismissed_duplicate_pairs')
    .all() as Array<{ order_id_a: number; order_id_b: number }>;

  const dismissedByOrder = new Map<number, number[]>();
  for (const pair of dismissedRows) {
    const arrA = dismissedByOrder.get(pair.order_id_a) ?? [];
    arrA.push(pair.order_id_b);
    dismissedByOrder.set(pair.order_id_a, arrA);

    const arrB = dismissedByOrder.get(pair.order_id_b) ?? [];
    arrB.push(pair.order_id_a);
    dismissedByOrder.set(pair.order_id_b, arrB);
  }

  return rows.map((r) => ({
    id: r.id,
    source: r.source,
    status: r.status,
    timingType: r.timing_type,
    requestedDate: r.requested_date,
    slottedDate: r.slotted_date,
    isLocked: Boolean(r.is_locked),
    customerName: r.customer_name,
    customerNameOverridden: Boolean(r.customer_name_overridden),
    customerEmail: r.customer_email,
    customerPhone: r.customer_phone,
    pickupChannelId: r.pickup_channel_id,
    freeTextPickup: r.free_text_pickup,
    notes: r.notes,
    preApprovedAt: r.pre_approved_at,
    standingOrderId: r.standing_order_id,
    standingOccurrenceDate: r.standing_occurrence_date,
    odooQuotationId: r.odoo_quotation_id,
    odooQuotationName: r.odoo_quotation_name,
    odooPartnerId: r.odoo_partner_id,
    odooCreatedAtLocal: r.odoo_created_at_local,
    odooRawNotes: r.odoo_raw_notes,
    odooRawLines: safeJsonParse<string[]>(r.odoo_raw_lines_json, []),
    odooUpdatedAfterSlot: Boolean(r.odoo_updated_after_slot),
    odooMissingFlagged: Boolean(r.odoo_missing_flagged),
    odooSuggestedConfirmed: safeJsonParse<SuggestedConfirmedOrder | null>(
      r.odoo_suggested_confirmed_json,
      null
    ),
    mergedOdooNames: mergedNamesByOrder.get(r.id) ?? [],
    dismissedDuplicateOrderIds: dismissedByOrder.get(r.id) ?? [],
    waitlistSortOrder: typeof r.waitlist_sort_order === 'number' ? r.waitlist_sort_order : null,
    items: itemsByOrder.get(r.id) ?? [],
    chatter: chatterByOrder.get(r.id) ?? [],
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  }));
}

export function listAllOrders(db: Database.Database): OrderRecord[] {
  const rows = db
    .prepare('SELECT * FROM orders ORDER BY COALESCE(slotted_date, requested_date, created_at) ASC, id ASC')
    .all() as RawOrderRow[];
  return hydrateOrders(db, rows);
}

export function getOrderById(db: Database.Database, id: number): OrderRecord | null {
  const row = db.prepare('SELECT * FROM orders WHERE id = ?').get(id) as RawOrderRow | undefined;
  if (!row) return null;
  return hydrateOrders(db, [row])[0] ?? null;
}

export function countOdooCustomers(db: Database.Database): number {
  const row = db.prepare('SELECT COUNT(*) as cnt FROM odoo_customers').get() as
    | { cnt: number }
    | undefined;
  return row?.cnt ?? 0;
}

/**
 * Returns deduplicated customer autocomplete suggestions combining synced Odoo contacts
 * (`odoo_customers`) and local order / standing order customer history.
 */
export function listCustomerDirectory(
  db: Database.Database,
  query = '',
  limit = 50
): CustomerSuggestion[] {
  const normalizedQuery = query.trim().toLowerCase();
  const safeLimit = Number.isFinite(limit) ? Math.max(1, Math.min(200, Math.floor(limit))) : 50;

  const odooRows = db
    .prepare(
      `SELECT odoo_partner_id, name, email, phone
       FROM odoo_customers
       ORDER BY name COLLATE NOCASE ASC`
    )
    .all() as Array<{
    odoo_partner_id: number;
    name: string;
    email: string | null;
    phone: string | null;
  }>;

  const localOrderRows = db
    .prepare(
      `SELECT customer_name, customer_email, customer_phone, odoo_partner_id, updated_at
       FROM orders
       WHERE TRIM(customer_name) != ''
       ORDER BY updated_at DESC, id DESC`
    )
    .all() as Array<{
    customer_name: string;
    customer_email: string | null;
    customer_phone: string | null;
    odoo_partner_id: number | null;
    updated_at: string;
  }>;

  const standingRows = db
    .prepare(
      `SELECT customer_name, customer_contact, updated_at
       FROM standing_orders
       WHERE TRIM(customer_name) != ''
       ORDER BY updated_at DESC, id DESC`
    )
    .all() as Array<{
    customer_name: string;
    customer_contact: string | null;
    updated_at: string;
  }>;

  const byKey = new Map<string, CustomerSuggestion>();
  const byPartnerId = new Map<number, CustomerSuggestion>();

  const normalizeNameKey = (name: string) => name.trim().toLowerCase().replace(/\s+/g, ' ');

  // 1. Seed with Odoo directory first (authoritative contact details + partner ID)
  for (const row of odooRows) {
    const cleanName = row.name.trim();
    if (!cleanName) continue;
    const entry: CustomerSuggestion = {
      key: `odoo:${row.odoo_partner_id}`,
      name: cleanName,
      email: row.email?.trim() || null,
      phone: row.phone?.trim() || null,
      odooPartnerId: row.odoo_partner_id,
      source: 'odoo',
    };
    const nameKey = normalizeNameKey(cleanName);
    const dedupeKey = entry.email ? `${nameKey}|${entry.email.toLowerCase()}` : nameKey;
    if (!byKey.has(dedupeKey)) {
      byKey.set(dedupeKey, entry);
    }
    byPartnerId.set(row.odoo_partner_id, entry);
  }

  // 2. Supplement with local order customers not already represented
  for (const row of localOrderRows) {
    const cleanName = row.customer_name.trim();
    if (!cleanName) continue;
    const email = row.customer_email?.trim() || null;
    const phone = row.customer_phone?.trim() || null;

    if (row.odoo_partner_id && byPartnerId.has(row.odoo_partner_id)) {
      const existing = byPartnerId.get(row.odoo_partner_id)!;
      if (!existing.email && email) existing.email = email;
      if (!existing.phone && phone) existing.phone = phone;
      continue;
    }

    const nameKey = normalizeNameKey(cleanName);
    const existingByName = Array.from(byKey.values()).find(
      (c) => normalizeNameKey(c.name) === nameKey
    );
    if (existingByName) {
      if (!existingByName.email && email) existingByName.email = email;
      if (!existingByName.phone && phone) existingByName.phone = phone;
      continue;
    }

    const key = `local:${nameKey}`;
    if (!byKey.has(key)) {
      byKey.set(key, {
        key,
        name: cleanName,
        email,
        phone,
        odooPartnerId: row.odoo_partner_id,
        source: 'local',
      });
    }
  }

  // 3. Supplement with standing order customers
  for (const row of standingRows) {
    const cleanName = row.customer_name.trim();
    if (!cleanName) continue;
    const contact = row.customer_contact?.trim() || null;
    const looksLikeEmail = Boolean(contact && contact.includes('@'));
    const email = looksLikeEmail ? contact : null;
    const phone = !looksLikeEmail ? contact : null;

    const nameKey = normalizeNameKey(cleanName);
    const existingByName = Array.from(byKey.values()).find(
      (c) => normalizeNameKey(c.name) === nameKey
    );
    if (existingByName) {
      if (!existingByName.email && email) existingByName.email = email;
      if (!existingByName.phone && phone) existingByName.phone = phone;
      continue;
    }

    const key = `local:${nameKey}`;
    if (!byKey.has(key)) {
      byKey.set(key, {
        key,
        name: cleanName,
        email,
        phone,
        odooPartnerId: null,
        source: 'local',
      });
    }
  }

  const all = Array.from(byKey.values());
  const filtered = normalizedQuery
    ? all.filter((c) => {
        const hayName = c.name.toLowerCase();
        const hayEmail = (c.email ?? '').toLowerCase();
        const hayPhone = (c.phone ?? '').toLowerCase();
        return (
          hayName.includes(normalizedQuery) ||
          hayEmail.includes(normalizedQuery) ||
          hayPhone.includes(normalizedQuery)
        );
      })
    : all;

  filtered.sort((a, b) => {
    if (normalizedQuery) {
      const aStarts = a.name.toLowerCase().startsWith(normalizedQuery) ? 0 : 1;
      const bStarts = b.name.toLowerCase().startsWith(normalizedQuery) ? 0 : 1;
      if (aStarts !== bStarts) return aStarts - bStarts;
    }
    if (a.source !== b.source) {
      return a.source === 'odoo' ? -1 : 1;
    }
    return a.name.localeCompare(b.name, undefined, { sensitivity: 'base' });
  });

  return filtered.slice(0, safeLimit);
}
