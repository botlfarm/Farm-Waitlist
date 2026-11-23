import type Database from 'better-sqlite3';
import type {
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
