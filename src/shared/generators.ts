import {
  DEFAULT_TIMEZONE,
  ISO_WEEKDAY_LABELS,
  addDays,
  formatDateLongNoYear,
  formatDateNoYear,
  formatDateNumeric,
  formatFullDisplayDate,
  formatLocalDateNoYear,
  formatLocalDateTime,
  formatLocalDateTimeNoYear,
  formatLocalTimeHHMM,
  formatShortCalendarDate,
  formatWeekdayLong,
  getIsoWeekday,
  getMondayOfWeek,
  listDateRange,
} from './timezone';
import { isChannelActiveOnDate } from './supplyEngine';
import type {
  CalendarDayProjection,
  OrderRecord,
  PickupChannel,
  PreApprovalTemplate,
  PublicAvailabilityCalendarDay,
  PublicAvailabilityDay,
  PublicAvailabilityJsonPayload,
  PublicAvailabilityResult,
  SnippetCutoffRule,
  TrackedItem,
} from './types';

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

export function formatQty(qty: number): string {
  return Number.isInteger(qty) ? String(qty) : String(Number(qty.toFixed(2)));
}

export function formatOrderItemsSummary(
  order: Pick<OrderRecord, 'items'>,
  itemsById: Map<number, TrackedItem>
): string {
  if (!order.items.length) return 'your requested items';
  return order.items
    .map((line) => {
      const item = itemsById.get(line.trackedItemId);
      if (!item) return `${formatQty(line.quantity)} units`;
      return `${formatQty(line.quantity)} ${item.unitLabel} ${item.name}`;
    })
    .join(' + ');
}

export interface SplitCustomerName {
  fullName: string;
  firstName: string;
  lastName: string;
}

/**
 * Splits a full customer name on whitespace into firstName and lastName.
 * Single-word names return firstName = word and lastName = "".
 * Empty names fall back to "there" for fullName/firstName and "" for lastName.
 */
export function splitCustomerName(rawName: string | null | undefined): SplitCustomerName {
  const trimmed = (rawName ?? '').trim();
  if (!trimmed) {
    return { fullName: 'there', firstName: 'there', lastName: '' };
  }
  const parts = trimmed.split(/\s+/);
  return {
    fullName: trimmed,
    firstName: parts[0],
    lastName: parts.slice(1).join(' '),
  };
}

export interface TemplateVariableMeta {
  key: string;
  token: string;
  label: string;
  example: string;
  group: 'name' | 'date' | 'order' | 'hold' | 'cutoff';
}

export const PRE_APPROVAL_TEMPLATE_VARIABLES: TemplateVariableMeta[] = [
  { key: 'first_name', token: '{{first_name}}', label: 'First name', example: 'Alex', group: 'name' },
  { key: 'last_name', token: '{{last_name}}', label: 'Last name', example: 'Rivera', group: 'name' },
  { key: 'name', token: '{{name}}', label: 'Full name', example: 'Alex Rivera', group: 'name' },
  { key: 'date_short', token: '{{date_short}}', label: 'Short date (no year)', example: 'Sat, Nov 28', group: 'date' },
  { key: 'date_long', token: '{{date_long}}', label: 'Long date (no year)', example: 'Saturday, November 28', group: 'date' },
  { key: 'date_md', token: '{{date_md}}', label: 'Month & day', example: 'Nov 28', group: 'date' },
  { key: 'date_numeric', token: '{{date_numeric}}', label: 'Numeric date', example: '11/28', group: 'date' },
  { key: 'weekday', token: '{{weekday}}', label: 'Day of week', example: 'Saturday', group: 'date' },
  { key: 'date', token: '{{date}}', label: 'Full date (with year)', example: 'Sat, Nov 28, 2026', group: 'date' },
  { key: 'items_summary', token: '{{items_summary}}', label: 'Items summary', example: '2 dozens Standard Eggs', group: 'order' },
  { key: 'channel', token: '{{channel}}', label: 'Pickup channel', example: 'Farm Store', group: 'order' },
  { key: 'order_ref', token: '{{order_ref}}', label: 'Order reference', example: 'S00105', group: 'order' },
  { key: 'hold_cutoff', token: '{{hold_cutoff}}', label: 'Hold cutoff window', example: '48 hours', group: 'hold' },
  { key: 'hold_cutoff_by', token: '{{hold_cutoff_by}}', label: 'Hold deadline date & time', example: 'Fri, Nov 27 at 2:00 PM', group: 'hold' },
  { key: 'hold_cutoff_date', token: '{{hold_cutoff_date}}', label: 'Hold deadline date (no year)', example: 'Fri, Nov 27', group: 'hold' },
  { key: 'order_cutoff', token: '{{order_cutoff}}', label: 'Public order cutoff (date & time)', example: 'Fri, Nov 27 at 4:00 PM', group: 'cutoff' },
  { key: 'order_cutoff_date', token: '{{order_cutoff_date}}', label: 'Public order cutoff date (no year)', example: 'Fri, Nov 27', group: 'cutoff' },
  { key: 'order_cutoff_time', token: '{{order_cutoff_time}}', label: 'Public order cutoff time', example: '4:00 PM', group: 'cutoff' },
];

export function format24HourTimeTo12Hour(hhmm: string): string {
  const parts = hhmm.trim().split(':');
  if (parts.length !== 2) return hhmm;
  const h = Number(parts[0]);
  const m = parts[1];
  if (!Number.isFinite(h)) return hhmm;
  const suffix = h >= 12 ? 'PM' : 'AM';
  const hr12 = h % 12 === 0 ? 12 : h % 12;
  return `${hr12}:${m} ${suffix}`;
}

export function formatHoldCutoffDuration(hours: number): string {
  const safeHours = Number.isFinite(hours) && hours > 0 ? Math.round(hours) : 48;
  return safeHours === 1 ? '1 hour' : `${safeHours} hours`;
}

export function resolveHoldCutoffValues(params: {
  holdThresholdHours?: number;
  baseIso?: string | null;
  timezone?: string;
  now?: Date;
}): {
  holdCutoff: string;
  holdCutoffBy: string;
  holdCutoffDate: string;
} {
  const safeHours =
    typeof params.holdThresholdHours === 'number' &&
    Number.isFinite(params.holdThresholdHours) &&
    params.holdThresholdHours > 0
      ? Math.round(params.holdThresholdHours)
      : 48;
  const tz = params.timezone || DEFAULT_TIMEZONE;
  const baseDate = params.baseIso ? new Date(params.baseIso) : params.now ?? new Date();
  const validBase = Number.isNaN(baseDate.getTime()) ? params.now ?? new Date() : baseDate;
  const deadline = new Date(validBase.getTime() + safeHours * 3_600_000);

  return {
    holdCutoff: formatHoldCutoffDuration(safeHours),
    holdCutoffBy: formatLocalDateTimeNoYear(deadline, tz),
    holdCutoffDate: formatLocalDateNoYear(deadline, tz),
  };
}

/**
 * Resolves the earliest active Public Order Cutoff deadline (from Availability Snippet rules)
 * for a given pickup date, formatted for pre-approval message templates.
 */
export function resolvePublicOrderCutoffValues(params: {
  pickupDate?: string | null;
  cutoffRules?: SnippetCutoffRule[];
  showSameDay?: boolean;
}): {
  orderCutoff: string;
  orderCutoffDate: string;
  orderCutoffTime: string;
  hasRule: boolean;
} {
  const pickupDate = (params.pickupDate ?? '').trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(pickupDate)) {
    return {
      orderCutoff: 'the order cutoff',
      orderCutoffDate: 'the order cutoff date',
      orderCutoffTime: 'the cutoff time',
      hasRule: false,
    };
  }

  const normalizedRules = normalizeCutoffRules(params.cutoffRules ?? []);
  const pickupIso = getIsoWeekday(pickupDate);

  let earliest: { cutoffDate: string; cutoffTime: string; sortKey: string } | null = null;

  for (const rule of normalizedRules) {
    if (!rule.enabled) continue;
    if (rule.pickupWeekdays.length > 0 && !rule.pickupWeekdays.includes(pickupIso)) {
      continue;
    }

    let cutoffDate: string;
    if (rule.mode === 'weekly_day') {
      const delta = (pickupIso - rule.cutoffWeekday + 7) % 7;
      cutoffDate = addDays(pickupDate, -delta);
    } else {
      const daysBefore = Math.max(0, Math.min(14, Math.floor(rule.daysBefore || 0)));
      cutoffDate = addDays(pickupDate, -daysBefore);
    }

    const sortKey = `${cutoffDate}T${rule.cutoffTime}`;
    if (!earliest || sortKey < earliest.sortKey) {
      earliest = { cutoffDate, cutoffTime: rule.cutoffTime, sortKey };
    }
  }

  if (earliest) {
    const dateLabel = formatDateNoYear(earliest.cutoffDate);
    const timeLabel = format24HourTimeTo12Hour(earliest.cutoffTime);
    return {
      orderCutoff: `${dateLabel} at ${timeLabel}`,
      orderCutoffDate: dateLabel,
      orderCutoffTime: timeLabel,
      hasRule: true,
    };
  }

  if (params.showSameDay === false) {
    const prevDateLabel = formatDateNoYear(addDays(pickupDate, -1));
    return {
      orderCutoff: `${prevDateLabel} at 11:59 PM`,
      orderCutoffDate: prevDateLabel,
      orderCutoffTime: '11:59 PM',
      hasRule: true,
    };
  }

  const pickupLabel = formatDateNoYear(pickupDate);
  return {
    orderCutoff: pickupLabel,
    orderCutoffDate: pickupLabel,
    orderCutoffTime: 'pickup time',
    hasRule: false,
  };
}

interface ResolvedTemplateValues {
  name: string;
  firstName: string;
  lastName: string;
  date: string;
  dateShort: string;
  dateLong: string;
  dateMd: string;
  dateNumeric: string;
  weekday: string;
  itemsSummary: string;
  channel: string;
  orderRef: string;
  holdCutoff: string;
  holdCutoffBy: string;
  holdCutoffDate: string;
  orderCutoff: string;
  orderCutoffDate: string;
  orderCutoffTime: string;
}

function applyPreApprovalTemplateValues(template: string, values: ResolvedTemplateValues): string {
  return template
    .replace(/\{\{\s*first_name\s*\}\}/gi, values.firstName)
    .replace(/\{\{\s*last_name\s*\}\}/gi, values.lastName)
    .replace(/\{\{\s*name\s*\}\}/gi, values.name)
    .replace(/\{\{\s*date_short\s*\}\}/gi, values.dateShort)
    .replace(/\{\{\s*date_long\s*\}\}/gi, values.dateLong)
    .replace(/\{\{\s*date_md\s*\}\}/gi, values.dateMd)
    .replace(/\{\{\s*date_numeric\s*\}\}/gi, values.dateNumeric)
    .replace(/\{\{\s*weekday\s*\}\}/gi, values.weekday)
    .replace(/\{\{\s*date\s*\}\}/gi, values.date)
    .replace(/\{\{\s*items_summary\s*\}\}/gi, values.itemsSummary)
    .replace(/\{\{\s*channel\s*\}\}/gi, values.channel)
    .replace(/\{\{\s*order_ref\s*\}\}/gi, values.orderRef)
    .replace(/\{\{\s*hold_cutoff_by\s*\}\}/gi, values.holdCutoffBy)
    .replace(/\{\{\s*hold_cutoff_date\s*\}\}/gi, values.holdCutoffDate)
    .replace(/\{\{\s*hold_cutoff\s*\}\}/gi, values.holdCutoff)
    .replace(/\{\{\s*order_cutoff_date\s*\}\}/gi, values.orderCutoffDate)
    .replace(/\{\{\s*order_cutoff_time\s*\}\}/gi, values.orderCutoffTime)
    .replace(/\{\{\s*order_cutoff\s*\}\}/gi, values.orderCutoff);
}

function resolveDateFormatValues(effectiveYmd: string | null | undefined) {
  if (!effectiveYmd) {
    return {
      date: 'your scheduled pickup date',
      dateShort: 'your scheduled pickup date',
      dateLong: 'your scheduled pickup date',
      dateMd: 'your scheduled pickup date',
      dateNumeric: 'your scheduled pickup date',
      weekday: 'your pickup day',
    };
  }
  return {
    date: formatFullDisplayDate(effectiveYmd),
    dateShort: formatDateNoYear(effectiveYmd),
    dateLong: formatDateLongNoYear(effectiveYmd),
    dateMd: formatShortCalendarDate(effectiveYmd),
    dateNumeric: formatDateNumeric(effectiveYmd),
    weekday: formatWeekdayLong(effectiveYmd),
  };
}

export function renderPreApprovalMessage(params: {
  template: string;
  order: OrderRecord;
  items: TrackedItem[];
  channels: PickupChannel[];
  holdThresholdHours?: number;
  timezone?: string;
  now?: Date;
  publicSnippetCutoffRules?: SnippetCutoffRule[];
  publicSnippetShowSameDay?: boolean;
}): string {
  const {
    template,
    order,
    items,
    channels,
    holdThresholdHours,
    timezone,
    now,
    publicSnippetCutoffRules,
    publicSnippetShowSameDay,
  } = params;
  const itemsById = new Map(items.map((i) => [i.id, i]));
  const channel = order.pickupChannelId
    ? channels.find((c) => c.id === order.pickupChannelId)?.name ?? order.freeTextPickup ?? 'Farm Pickup'
    : order.freeTextPickup ?? 'Farm Pickup';

  const effectiveYmd = order.slottedDate || order.requestedDate || null;
  const dates = resolveDateFormatValues(effectiveYmd);
  const nameParts = splitCustomerName(order.customerName);
  const itemsSummary = formatOrderItemsSummary(order, itemsById);
  const orderRef = (order.odooQuotationName ?? '').trim();
  const holdValues = resolveHoldCutoffValues({
    holdThresholdHours,
    baseIso: order.preApprovedAt,
    timezone,
    now,
  });
  const orderCutoffValues = resolvePublicOrderCutoffValues({
    pickupDate: effectiveYmd,
    cutoffRules: publicSnippetCutoffRules,
    showSameDay: publicSnippetShowSameDay,
  });

  return applyPreApprovalTemplateValues(template, {
    name: nameParts.fullName,
    firstName: nameParts.firstName,
    lastName: nameParts.lastName,
    ...dates,
    itemsSummary,
    channel,
    orderRef,
    ...holdValues,
    orderCutoff: orderCutoffValues.orderCutoff,
    orderCutoffDate: orderCutoffValues.orderCutoffDate,
    orderCutoffTime: orderCutoffValues.orderCutoffTime,
  });
}

const SAMPLE_PREVIEW_ANCHOR_ISO = '2026-11-25T19:00:00Z'; // Wed, Nov 25 at 2:00 PM EST

export function renderPreApprovalSamplePreview(
  template: string,
  channelName: string = 'Farm Store',
  options?: {
    holdThresholdHours?: number;
    timezone?: string;
    publicSnippetCutoffRules?: SnippetCutoffRule[];
    publicSnippetShowSameDay?: boolean;
  }
): string {
  const dates = resolveDateFormatValues('2026-11-28');
  const holdValues = resolveHoldCutoffValues({
    holdThresholdHours: options?.holdThresholdHours ?? 48,
    baseIso: SAMPLE_PREVIEW_ANCHOR_ISO,
    timezone: options?.timezone ?? DEFAULT_TIMEZONE,
  });
  const orderCutoffValues = resolvePublicOrderCutoffValues({
    pickupDate: '2026-11-28',
    cutoffRules: options?.publicSnippetCutoffRules,
    showSameDay: options?.publicSnippetShowSameDay,
  });
  return applyPreApprovalTemplateValues(template, {
    name: 'Alex Rivera',
    firstName: 'Alex',
    lastName: 'Rivera',
    ...dates,
    itemsSummary: '2 dozens Standard Eggs',
    channel: channelName || 'Farm Store',
    orderRef: 'S00105',
    ...holdValues,
    orderCutoff: orderCutoffValues.orderCutoff,
    orderCutoffDate: orderCutoffValues.orderCutoffDate,
    orderCutoffTime: orderCutoffValues.orderCutoffTime,
  });
}

export function buildPreApprovalMailtoHref(params: {
  email?: string | null;
  order?: Pick<OrderRecord, 'slottedDate' | 'requestedDate' | 'odooQuotationName'> | null;
  message: string;
  subject?: string;
}): string | null {
  const rawEmail = (params.email ?? '').trim();
  const sanitizedEmail = rawEmail.replace(/[\r\n\s?&#<>]/g, '');
  const hasValidEmail = /^[^\s@<>?,&]+@[^\s@<>?,&]+$/.test(sanitizedEmail);
  if (!hasValidEmail && rawEmail.length > 0) {
    return null;
  }

  const effectiveYmd = params.order?.slottedDate || params.order?.requestedDate || null;
  const dateSuffix = effectiveYmd ? ` — ${formatDateNoYear(effectiveYmd)}` : '';
  const refSuffix = params.order?.odooQuotationName?.trim()
    ? ` (${params.order.odooQuotationName.trim()})`
    : '';
  const resolvedSubject =
    params.subject?.trim() || `Order Pre-Approved${dateSuffix}${refSuffix}`;
  const plainBody = renderMessageToPlainText(params.message);

  const recipient = hasValidEmail ? sanitizedEmail : '';
  return `mailto:${recipient}?subject=${encodeURIComponent(resolvedSubject)}&body=${encodeURIComponent(plainBody)}`;
}

/**
 * Selects the best matching Pre-Approval template for an order:
 * 1. Templates with both matching pickupChannelId AND matching trackedItemId (highest priority)
 * 2. Templates matching trackedItemId (when no channel restriction) or pickupChannelId (when no item restriction)
 * 3. Template marked isDefault (or first template as fallback)
 */
export function selectBestPreApprovalTemplate(
  templates: PreApprovalTemplate[],
  order: Pick<OrderRecord, 'pickupChannelId' | 'items'>
): PreApprovalTemplate | null {
  if (!templates.length) return null;

  const orderItemIds = new Set(order.items.map((i) => i.trackedItemId));
  let bestRuleMatch: { template: PreApprovalTemplate; score: number } | null = null;

  for (const tmpl of templates) {
    const hasChannelRule = tmpl.channelIds.length > 0;
    const hasItemRule = tmpl.itemIds.length > 0;
    if (!hasChannelRule && !hasItemRule) continue;

    const channelMatches =
      !hasChannelRule ||
      (order.pickupChannelId !== null && tmpl.channelIds.includes(order.pickupChannelId));
    const itemMatches =
      !hasItemRule || tmpl.itemIds.some((id) => orderItemIds.has(id));

    if (!channelMatches || !itemMatches) continue;

    const score = (hasChannelRule && hasItemRule ? 30 : 0) + (hasItemRule ? 12 : 0) + (hasChannelRule ? 10 : 0);
    if (!bestRuleMatch || score > bestRuleMatch.score) {
      bestRuleMatch = { template: tmpl, score };
    }
  }

  if (bestRuleMatch) return bestRuleMatch.template;
  return templates.find((t) => t.isDefault) ?? templates[0];
}

export type SafeRichMessageSegment =
  | { type: 'text'; text: string }
  | { type: 'link'; label: string; href: string }
  | { type: 'newline' };

export function isSafeHttpUrl(rawUrl: string): boolean {
  try {
    const parsed = new URL(rawUrl.trim());
    return parsed.protocol === 'https:' || parsed.protocol === 'http:';
  } catch {
    return false;
  }
}

/**
 * Parses a message containing optional HTML `<a href="https://...">Label</a>`,
 * Markdown `[Label](https://...)`, or bare `https://...` URLs into safe, typed
 * segments (blocking `javascript:`, `data:`, and all other HTML tags/scripts).
 */
export function parseSafeRichMessageSegments(rawText: string): SafeRichMessageSegment[] {
  const normalized = rawText.replace(/\r\n/g, '\n').replace(/<br\s*\/?>/gi, '\n');
  const lines = normalized.split('\n');
  const segments: SafeRichMessageSegment[] = [];

  // Matches:
  // 1) <a ... href="url" ...>label</a>
  // 2) [label](url)
  // 3) bare https?://... URL
  const tokenRe =
    /<a\b[^>]*\bhref\s*=\s*(?:"([^"]+)"|'([^']+)')[^>]*>([\s\S]*?)<\/a>|\[([^\]\n]+)\]\((https?:\/\/[^\s)]+)\)|(https?:\/\/[^\s<>"')]+)/gi;

  lines.forEach((line, lineIdx) => {
    if (lineIdx > 0) {
      segments.push({ type: 'newline' });
    }
    let lastIndex = 0;
    tokenRe.lastIndex = 0;
    let match: RegExpExecArray | null;
    while ((match = tokenRe.exec(line)) !== null) {
      if (match.index > lastIndex) {
        segments.push({ type: 'text', text: line.slice(lastIndex, match.index) });
      }

      const htmlHref = match[1] ?? match[2];
      const htmlLabelRaw = match[3];
      const mdLabel = match[4];
      const mdHref = match[5];
      const bareUrl = match[6];

      if (htmlHref !== undefined) {
        const cleanLabel = (htmlLabelRaw ?? '').replace(/<[^>]+>/g, '').trim() || htmlHref.trim();
        if (isSafeHttpUrl(htmlHref)) {
          segments.push({ type: 'link', label: cleanLabel, href: htmlHref.trim() });
        } else {
          segments.push({ type: 'text', text: cleanLabel });
        }
      } else if (mdHref !== undefined && mdLabel !== undefined) {
        if (isSafeHttpUrl(mdHref)) {
          segments.push({ type: 'link', label: mdLabel.trim() || mdHref.trim(), href: mdHref.trim() });
        } else {
          segments.push({ type: 'text', text: match[0] });
        }
      } else if (bareUrl !== undefined) {
        // Trim trailing sentence punctuation from bare URLs (e.g. "https://farm.com/shop.")
        let urlPart = bareUrl;
        let trailing = '';
        while (urlPart.length > 8 && /[.,!?;:]$/.test(urlPart)) {
          trailing = urlPart.slice(-1) + trailing;
          urlPart = urlPart.slice(0, -1);
        }
        if (isSafeHttpUrl(urlPart)) {
          segments.push({ type: 'link', label: urlPart, href: urlPart });
          if (trailing) {
            segments.push({ type: 'text', text: trailing });
          }
        } else {
          segments.push({ type: 'text', text: match[0] });
        }
      }

      lastIndex = tokenRe.lastIndex;
    }

    if (lastIndex < line.length) {
      segments.push({ type: 'text', text: line.slice(lastIndex) });
    }
  });

  return segments;
}

export function messageHasLinks(rawText: string): boolean {
  return parseSafeRichMessageSegments(rawText).some((s) => s.type === 'link');
}

/**
 * Renders a message into strictly sanitized HTML safe for rich-text email clipboard pasting.
 */
export function renderMessageToSafeHtml(rawText: string): string {
  const segments = parseSafeRichMessageSegments(rawText);
  const body = segments
    .map((seg) => {
      if (seg.type === 'newline') return '<br>';
      if (seg.type === 'link') {
        return `<a href="${escapeHtml(seg.href)}" target="_blank" rel="noopener noreferrer">${escapeHtml(seg.label)}</a>`;
      }
      return escapeHtml(seg.text);
    })
    .join('');
  return `<div>${body}</div>`;
}

/**
 * Renders a message into clean plain text suitable for SMS / text messages.
 * HTML/Markdown links become "Label (https://...)" (or just the URL if label matches URL).
 */
export function renderMessageToPlainText(rawText: string): string {
  const segments = parseSafeRichMessageSegments(rawText);
  return segments
    .map((seg) => {
      if (seg.type === 'newline') return '\n';
      if (seg.type === 'link') {
        if (seg.label.toLowerCase() === seg.href.toLowerCase()) {
          return seg.href;
        }
        return `${seg.label} (${seg.href})`;
      }
      return seg.text;
    })
    .join('');
}

export const DEFAULT_PUBLIC_SNIPPET_FOOTER =
  'Quantities are approximate post-buffer estimates subject to daily farm harvest.';

export interface PausedSnippetPreset {
  id: string;
  label: string;
  message: string;
}

export const PAUSED_SNIPPET_PRESETS: PausedSnippetPreset[] = [
  {
    id: 'unknown',
    label: 'Availability Unknown',
    message: 'Availability is currently unknown — please check back soon for upcoming pickup dates.',
  },
  {
    id: 'off_season',
    label: 'Closed for Season',
    message: 'Our waitlist is currently closed for the season. Thank you for supporting our farm!',
  },
  {
    id: 'walkup_only',
    label: 'Walk-Ups Only',
    message: 'Online pre-ordering is currently paused. Walk-up availability is first-come, first-served at the farm stand.',
  },
  {
    id: 'custom',
    label: 'Custom Message',
    message: '',
  },
];

export const DEFAULT_PAUSED_SNIPPET_MESSAGE = PAUSED_SNIPPET_PRESETS[0].message;

export function normalizeCutoffRules(raw: unknown): SnippetCutoffRule[] {
  if (!Array.isArray(raw)) return [];
  const validTimeRe = /^([01]\d|2[0-3]):([0-5]\d)$/;
  const out: SnippetCutoffRule[] = [];
  const seen = new Set<string>();

  for (let i = 0; i < raw.length; i += 1) {
    const entry = raw[i];
    if (!entry || typeof entry !== 'object') continue;
    const obj = entry as Record<string, unknown>;
    const rawId = typeof obj.id === 'string' && obj.id.trim() ? obj.id.trim() : `cutoff-${i + 1}`;
    const id = seen.has(rawId) ? `${rawId}-${i + 1}` : rawId;
    seen.add(id);

    const mode = obj.mode === 'weekly_day' ? 'weekly_day' : 'days_before';
    const daysBeforeRaw = Number(obj.daysBefore);
    const daysBefore = Number.isFinite(daysBeforeRaw)
      ? Math.max(0, Math.min(14, Math.floor(daysBeforeRaw)))
      : 1;
    const cutoffWeekdayRaw = Number(obj.cutoffWeekday);
    const cutoffWeekday =
      Number.isInteger(cutoffWeekdayRaw) && cutoffWeekdayRaw >= 1 && cutoffWeekdayRaw <= 7
        ? cutoffWeekdayRaw
        : 5;
    const cutoffTime =
      typeof obj.cutoffTime === 'string' && validTimeRe.test(obj.cutoffTime.trim())
        ? obj.cutoffTime.trim()
        : '16:00';
    const pickupWeekdays = Array.isArray(obj.pickupWeekdays)
      ? Array.from(
          new Set(
            obj.pickupWeekdays
              .map((v) => Number(v))
              .filter((n) => Number.isInteger(n) && n >= 1 && n <= 7)
          )
        ).sort((a, b) => a - b)
      : [];

    out.push({
      id,
      enabled: obj.enabled !== false,
      mode,
      daysBefore,
      cutoffWeekday,
      cutoffTime,
      pickupWeekdays,
    });
  }

  return out;
}

/**
 * Evaluates whether ordering is closed for a future/same-day pickup date `pickupDate`
 * given the current local date (`today`), current 24h local time (`currentTimeHHMM`),
 * `showSameDay`, and any active flexible cutoff rules (`days_before` or `weekly_day`).
 */
export function evaluateDateOrderingClosed(params: {
  pickupDate: string;
  today: string;
  currentTimeHHMM: string;
  showSameDay: boolean;
  cutoffRules: SnippetCutoffRule[];
}): boolean {
  const { pickupDate, today, currentTimeHHMM, showSameDay, cutoffRules } = params;
  if (pickupDate < today) return false;
  if (pickupDate === today && !showSameDay) return true;

  const pickupIso = getIsoWeekday(pickupDate);

  for (const rule of cutoffRules) {
    if (!rule.enabled) continue;
    if (rule.pickupWeekdays.length > 0 && !rule.pickupWeekdays.includes(pickupIso)) {
      continue;
    }

    let cutoffDate: string;
    if (rule.mode === 'weekly_day') {
      // Most recent date <= pickupDate matching rule.cutoffWeekday (0..6 days before pickup)
      const delta = (pickupIso - rule.cutoffWeekday + 7) % 7;
      cutoffDate = addDays(pickupDate, -delta);
    } else {
      const daysBefore = Math.max(0, Math.min(14, Math.floor(rule.daysBefore || 0)));
      cutoffDate = addDays(pickupDate, -daysBefore);
    }

    if (today > cutoffDate || (today === cutoffDate && currentTimeHHMM >= rule.cutoffTime)) {
      return true;
    }
  }

  return false;
}

function renderInlineRichTextToSafeHtml(rawText: string): string {
  const segments = parseSafeRichMessageSegments(rawText);
  return segments
    .map((seg) => {
      if (seg.type === 'newline') return '<br>';
      if (seg.type === 'link') {
        return `<a href="${escapeHtml(seg.href)}" target="_blank" rel="noopener noreferrer" style="color:#0284c7;text-decoration:underline;">${escapeHtml(seg.label)}</a>`;
      }
      return escapeHtml(seg.text);
    })
    .join('');
}

const SHARED_PUBLIC_SNIPPET_CSS = `
    .fw-cal{max-width:880px;margin:0 auto;padding:18px;border:1px solid #e2e8f0;border-radius:10px;background:#ffffff;font-family:system-ui,-apple-system,Segoe UI,Roboto,sans-serif;color:#0f172a;box-sizing:border-box}
    .fw-cal *{box-sizing:border-box}
    .fw-cal-head{display:flex;flex-wrap:wrap;justify-content:space-between;align-items:baseline;gap:8px;margin-bottom:8px}
    .fw-cal-title{margin:0;font-size:18px;font-weight:700;color:#0f172a}
    .fw-cal-ts{font-size:12px;color:#64748b}
    .fw-cal-intro{margin:0 0 12px;font-size:13px;line-height:1.45;color:#334155}
    .fw-cal-paused{margin:10px 0 4px;padding:16px 18px;border:1px solid #cbd5e1;border-radius:8px;background:#f8fafc;color:#1e293b;font-size:14px;line-height:1.55}
    .fw-cal-legend{display:flex;flex-wrap:wrap;gap:14px;margin-bottom:12px;font-size:12px;color:#475569}
    .fw-cal-legend span{display:inline-flex;align-items:center;gap:6px}
    .fw-cal-legend i{display:inline-block;width:8px;height:8px;border-radius:999px}
    .fw-cal-dow{display:grid;grid-template-columns:repeat(7,minmax(0,1fr));gap:6px;margin-bottom:6px}
    .fw-cal-dow-cell{font-size:11px;font-weight:600;text-transform:uppercase;letter-spacing:.04em;color:#64748b;padding:0 4px}
    .fw-cal-grid{display:grid;grid-template-columns:repeat(7,minmax(0,1fr));gap:6px}
    .fw-cal-cell{min-height:84px;padding:8px;border:1px solid #e2e8f0;border-radius:8px;background:#f8fafc;display:flex;flex-direction:column;gap:5px}
    .fw-cal-today{border-color:#0284c7;background:#f0f9ff}
    .fw-cal-past{opacity:.42;background:#f8fafc}
    .fw-cal-past .fw-cal-items,.fw-cal-past .fw-cal-ch,.fw-cal-past .fw-cal-today-tag,.fw-cal-past .fw-cal-closed{display:none}
    .fw-cal-past-tag{display:none;font-size:10px;font-weight:600;color:#64748b;text-transform:uppercase;letter-spacing:.03em}
    .fw-cal-past .fw-cal-past-tag{display:inline}
    .fw-cal-date-row{display:flex;align-items:center;justify-content:space-between;gap:4px}
    .fw-cal-date{font-size:12px;font-weight:700;color:#0f172a}
    .fw-cal-mob-dow{display:none}
    .fw-cal-today-tag{font-size:10px;font-weight:700;color:#0369a1;text-transform:uppercase;letter-spacing:.03em}
    .fw-cal-ch{font-size:11px;color:#64748b;line-height:1.25}
    .fw-cal-items{display:flex;flex-direction:column;gap:4px;margin-top:auto}
    .fw-cal-badge{padding:4px 6px;border-radius:5px;font-size:11px;font-weight:600;line-height:1.2;text-align:center}
    .fw-cal-closed{padding:4px 6px;border-radius:5px;font-size:11px;font-weight:600;line-height:1.2;text-align:center;background:#f1f5f9;color:#475569;border:1px solid #cbd5e1}
    .fw-cal-item{display:flex;justify-content:space-between;align-items:center;gap:4px;padding:3px 6px;border-radius:5px;font-size:11px;font-weight:600;line-height:1.2}
    .fw-cal-item-name{overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-weight:500}
    .fw-cal-item-qty{white-space:nowrap}
    .fw-cal-foot{margin:12px 0 0;font-size:11px;line-height:1.45;color:#64748b}
    @media (max-width:640px){
      .fw-cal{padding:12px}
      .fw-cal-dow{display:none}
      .fw-cal-grid{grid-template-columns:1fr;gap:6px}
      .fw-cal-cell{min-height:auto;flex-direction:row;flex-wrap:wrap;align-items:center;justify-content:space-between;padding:10px 12px}
      .fw-cal-past{padding:7px 12px}
      .fw-cal-mob-dow{display:inline}
      .fw-cal-items{margin-top:0;flex-direction:row;flex-wrap:wrap}
    }`.trim();

/**
 * Generates anonymized public availability with approximate post-buffer ATP quantities
 * in a clean Monday–Sunday calendar layout for items flagged `includeInPublicSnippet`,
 * with zero customer names exposed.
 */
export function generatePublicAvailability(params: {
  items: TrackedItem[];
  days: CalendarDayProjection[];
  channels: PickupChannel[];
  today: string;
  weeks?: number;
  timezone?: string;
  now?: Date;
  accurateAsOf?: Date;
  enabled?: boolean;
  pausedMessage?: string;
  showSameDay?: boolean;
  cutoffRules?: SnippetCutoffRule[];
  headerTitle?: string;
  headerText?: string;
  footerText?: string;
  autoAdvanceToday?: boolean;
}): PublicAvailabilityResult {
  const {
    items,
    days,
    channels,
    today,
    weeks = 3,
    timezone = DEFAULT_TIMEZONE,
    now = new Date(),
    accurateAsOf,
    enabled = true,
    pausedMessage,
    showSameDay = true,
    cutoffRules = [],
    headerTitle,
    headerText,
    footerText,
    autoAdvanceToday = true,
  } = params;

  const isPaused = enabled === false;
  const resolvedPausedMessage =
    typeof pausedMessage === 'string' && pausedMessage.trim()
      ? pausedMessage.trim()
      : DEFAULT_PAUSED_SNIPPET_MESSAGE;
  const normalizedCutoffRules = normalizeCutoffRules(cutoffRules);
  const currentTimeHHMM = formatLocalTimeHHMM(now, timezone);

  const publicItems = items.filter((i) => i.isActive && i.includeInPublicSnippet);
  const activeChannels = channels.filter((c) => c.isActive);
  const cutoffEnd = addDays(today, weeks * 7 - 1);
  const daysByDate = new Map(days.map((d) => [d.date, d]));

  const generatedAtDisplay = formatLocalDateTime(accurateAsOf ?? now, timezone);

  const buildDayItems = (dayProj: CalendarDayProjection | undefined): PublicAvailabilityDay['items'] =>
    publicItems.map((item) => {
      const proj = dayProj?.byItem[item.id];
      const sellable = Math.max(0, proj ? proj.sellableOpen : 0);
      const limitedThreshold = Math.max(3, Math.ceil(item.defaultDailyProduction * 0.25));
      let status: 'Available' | 'Limited' | 'Waitlist Full' = 'Waitlist Full';
      if (sellable > limitedThreshold) {
        status = 'Available';
      } else if (sellable > 0) {
        status = 'Limited';
      }

      const approxAvailable =
        sellable <= 0 ? 0 : sellable < 1 ? Number(sellable.toFixed(1)) : Math.floor(sellable);
      const approxLabel =
        approxAvailable <= 0
          ? 'Waitlist Full'
          : `${status} (~${formatQty(approxAvailable)} ${item.unitLabel})`;

      return {
        trackedItemId: item.id,
        itemName: item.name,
        unitLabel: item.unitLabel,
        status,
        approxAvailable,
        approxLabel,
      };
    });

  const buildDayEntry = (date: string): PublicAvailabilityCalendarDay => {
    const dayProj = daysByDate.get(date);
    const isoWeekday = dayProj?.isoWeekday ?? getIsoWeekday(date);
    const isPast = date < today;
    const isToday = date === today;
    const isOrderingClosed = isPast
      ? false
      : evaluateDateOrderingClosed({
          pickupDate: date,
          today,
          currentTimeHHMM,
          showSameDay,
          cutoffRules: normalizedCutoffRules,
        });
    const channelNames = isPast
      ? []
      : activeChannels
          .filter((c) => isChannelActiveOnDate(c, date, isoWeekday))
          .map((c) => c.name);

    return {
      date,
      displayDate: formatShortCalendarDate(date),
      weekdayLabel: ISO_WEEKDAY_LABELS[isoWeekday] ?? '',
      isoWeekday,
      isPast,
      isToday,
      isOrderingClosed,
      channelNames,
      items: isPast ? [] : buildDayItems(dayProj),
    };
  };

  // Upcoming days (today through today + weeks*7 - 1)
  const targetDays = days.filter((d) => d.date >= today && d.date <= cutoffEnd);
  const availabilityDays: PublicAvailabilityDay[] = targetDays.map((day) => {
    const entry = buildDayEntry(day.date);
    return {
      date: entry.date,
      displayDate: entry.displayDate,
      weekdayLabel: entry.weekdayLabel,
      channelNames: entry.channelNames,
      items: entry.items,
    };
  });

  // Full Monday–Sunday aligned calendar grid covering today's week through Sunday of cutoffEnd's week
  const calendarStart = getMondayOfWeek(today);
  const calendarEnd = addDays(getMondayOfWeek(cutoffEnd), 6);
  const calendarDays: PublicAvailabilityCalendarDay[] = listDateRange(
    calendarStart,
    calendarEnd
  ).map(buildDayEntry);

  const singleItem = publicItems.length === 1 ? publicItems[0] : null;

  const defaultHeadingTitle = singleItem
    ? `Upcoming Pickup Availability — ${singleItem.name}`
    : `Upcoming Pickup Availability (Next ${weeks} Weeks)`;
  const resolvedHeaderTitle =
    typeof headerTitle === 'string' && headerTitle.trim()
      ? headerTitle.trim()
      : defaultHeadingTitle;
  const resolvedHeaderText = typeof headerText === 'string' ? headerText.trim() : '';
  const resolvedFooterText =
    footerText === undefined ? DEFAULT_PUBLIC_SNIPPET_FOOTER : footerText.trim();

  const badgeStyle = (status: 'Available' | 'Limited' | 'Waitlist Full') => {
    if (status === 'Available') {
      return 'background:#ecfdf5;color:#065f46;border:1px solid #a7f3d0;';
    }
    if (status === 'Limited') {
      return 'background:#fffbeb;color:#92400e;border:1px solid #fde68a;';
    }
    return 'background:#fef2f2;color:#991b1b;border:1px solid #fecaca;';
  };

  const weekdayHeadersHtml = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun']
    .map((label) => `<div class="fw-cal-dow-cell">${label}</div>`)
    .join('');

  const calendarCellsHtml = calendarDays
    .map((day) => {
      if (day.isPast) {
        return `<div class="fw-cal-cell fw-cal-past" data-fw-date="${escapeHtml(day.date)}"><div class="fw-cal-date-row"><span class="fw-cal-date"><span class="fw-cal-mob-dow">${escapeHtml(day.weekdayLabel)}, </span>${escapeHtml(day.displayDate)}</span><span class="fw-cal-past-tag">Past</span></div></div>`;
      }

      const channelHtml = day.channelNames.length
        ? `<div class="fw-cal-ch">${escapeHtml(day.channelNames.join(' · '))}</div>`
        : '';

      const itemsHtml = day.isOrderingClosed
        ? `<div class="fw-cal-closed">Ordering Closed</div>`
        : day.items
            .map((item) => {
              const compactQty =
                item.approxAvailable <= 0
                  ? 'Waitlist Full'
                  : `~${formatQty(item.approxAvailable)} ${item.unitLabel}`;
              if (singleItem) {
                return `<div class="fw-cal-badge" style="${badgeStyle(item.status)}" title="${escapeHtml(item.approxLabel)}">${escapeHtml(compactQty)}</div>`;
              }
              return `<div class="fw-cal-item" style="${badgeStyle(item.status)}" title="${escapeHtml(`${item.itemName}: ${item.approxLabel}`)}"><span class="fw-cal-item-name">${escapeHtml(item.itemName)}</span><span class="fw-cal-item-qty">${escapeHtml(compactQty)}</span></div>`;
            })
            .join('');

      const todayClass = day.isToday ? ' fw-cal-today' : '';
      const todayBadge = day.isToday ? '<span class="fw-cal-today-tag">Today</span>' : '';

      return `<div class="fw-cal-cell${todayClass}" data-fw-date="${escapeHtml(day.date)}"><div class="fw-cal-date-row"><span class="fw-cal-date"><span class="fw-cal-mob-dow">${escapeHtml(day.weekdayLabel)}, </span>${escapeHtml(day.displayDate)}</span>${todayBadge}<span class="fw-cal-past-tag">Past</span></div>${channelHtml}<div class="fw-cal-items">${itemsHtml}</div></div>`;
    })
    .join('\n      ');

  const headerIntroHtml = resolvedHeaderText
    ? `\n  <p class="fw-cal-intro">${renderInlineRichTextToSafeHtml(resolvedHeaderText)}</p>`
    : '';

  const footerHtml = resolvedFooterText
    ? `\n    <p class="fw-cal-foot">${renderInlineRichTextToSafeHtml(resolvedFooterText)}</p>`
    : '';

  const hasOrderingClosedRules =
    !showSameDay || normalizedCutoffRules.some((r) => r.enabled);

  const bodyHtml = isPaused
    ? `<div class="fw-cal-paused">${renderInlineRichTextToSafeHtml(resolvedPausedMessage)}</div>${footerHtml}`
    : publicItems.length === 0
      ? `<p style="margin:12px 0;color:#475569;font-size:14px;">No items are currently flagged for public availability display.</p>${footerHtml}`
      : `<div class="fw-cal-legend">
      <span><i style="background:#10b981;"></i>Available</span>
      <span><i style="background:#f59e0b;"></i>Limited</span>
      <span><i style="background:#ef4444;"></i>Waitlist Full</span>${
        hasOrderingClosedRules
          ? `\n      <span><i style="background:#94a3b8;"></i>Ordering Closed</span>`
          : ''
      }
    </div>
    <div class="fw-cal-dow">${weekdayHeadersHtml}</div>
    <div class="fw-cal-grid">
      ${calendarCellsHtml}
    </div>${footerHtml}`;

  const runtimeCutoffConfig = JSON.stringify({
    s: showSameDay,
    r: normalizedCutoffRules
      .filter((r) => r.enabled)
      .map((r) => ({
        m: r.mode === 'weekly_day' ? 'w' : 'd',
        b: r.daysBefore,
        w: r.cutoffWeekday,
        t: r.cutoffTime,
        p: r.pickupWeekdays,
      })),
  });

  // Optional progressive-enhancement script: automatically advances the "Today" highlight,
  // dims elapsed days (shown dimmed on both mobile & desktop), and applies ordering cutoff rules
  // in real time in the farm's timezone using safe DOM methods (zero innerHTML).
  const autoAdvanceScriptHtml =
    !isPaused && autoAdvanceToday
      ? `\n  <script>(function(){try{var s=document.currentScript,r=s&&s.closest?s.closest('.fw-cal'):null;if(!r)return;var tz=r.getAttribute('data-fw-tz')||'America/New_York',cfg={s:true,r:[]};try{cfg=JSON.parse(r.getAttribute('data-fw-rules')||'{"s":true,"r":[]}')}catch(e){}var n=new Date(),t='',hm='00:00';try{var p=new Intl.DateTimeFormat('en-CA',{timeZone:tz,year:'numeric',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',hourCycle:'h23'}).formatToParts(n),g=function(k){for(var i=0;i<p.length;i++)if(p[i].type===k)return p[i].value;return''};t=g('year')+'-'+g('month')+'-'+g('day');var hh=g('hour');if(hh==='24')hh='00';hm=hh+':'+g('minute')}catch(e){var m=String(n.getMonth()+1),d=String(n.getDate()),h=String(n.getHours()),mi=String(n.getMinutes());t=n.getFullYear()+'-'+(m.length<2?'0'+m:m)+'-'+(d.length<2?'0'+d:d);hm=(h.length<2?'0'+h:h)+':'+(mi.length<2?'0'+mi:mi)}if(!/^\\d{4}-\\d{2}-\\d{2}$/.test(t))return;var addD=function(ymd,delta){var a=ymd.split('-').map(Number),dt=new Date(Date.UTC(a[0],a[1]-1,a[2]+delta)),pad=function(v){return v<10?'0'+v:''+v};return dt.getUTCFullYear()+'-'+pad(dt.getUTCMonth()+1)+'-'+pad(dt.getUTCDate())};var isoW=function(ymd){var a=ymd.split('-').map(Number),w=new Date(Date.UTC(a[0],a[1]-1,a[2])).getUTCDay();return w===0?7:w};var isClosed=function(dt){if(dt===t&&!cfg.s)return true;var pi=isoW(dt),rules=cfg.r||[];for(var j=0;j<rules.length;j++){var ru=rules[j];if(ru.p&&ru.p.length&&ru.p.indexOf(pi)===-1)continue;var cd=ru.m==='w'?addD(dt,-((pi-ru.w+7)%7)):addD(dt,-(ru.b||0));if(t>cd||(t===cd&&hm>=ru.t))return true}return false};var c=r.querySelectorAll('[data-fw-date]');for(var i=0;i<c.length;i++){var el=c[i],dt=el.getAttribute('data-fw-date'),tag=el.querySelector('.fw-cal-today-tag');if(dt<t){el.classList.add('fw-cal-past');el.classList.remove('fw-cal-today');if(tag)tag.remove()}else{el.classList.remove('fw-cal-past');if(dt===t){el.classList.add('fw-cal-today');if(!tag){var row=el.querySelector('.fw-cal-date-row');if(row){var sp=document.createElement('span');sp.className='fw-cal-today-tag';sp.textContent='Today';row.appendChild(sp)}}}else{el.classList.remove('fw-cal-today');if(tag)tag.remove()}if(isClosed(dt)){var box=el.querySelector('.fw-cal-items');if(box&&!box.querySelector('.fw-cal-closed')){while(box.firstChild)box.removeChild(box.firstChild);var cl=document.createElement('div');cl.className='fw-cal-closed';cl.textContent='Ordering Closed';box.appendChild(cl)}}}}}catch(e){}})();</script>`
      : '';

  const html = `<section class="fw-cal" data-fw-tz="${escapeHtml(timezone)}" data-fw-rules="${escapeHtml(runtimeCutoffConfig)}">
  <style>
    ${SHARED_PUBLIC_SNIPPET_CSS}
  </style>
  <div class="fw-cal-head">
    <h3 class="fw-cal-title">${escapeHtml(resolvedHeaderTitle)}</h3>
    <span class="fw-cal-ts">Availability accurate as of ${escapeHtml(generatedAtDisplay)}</span>
  </div>${headerIntroHtml}
  ${bodyHtml}${autoAdvanceScriptHtml}
</section>`;

  return {
    generatedAtDisplay,
    timezone,
    weeks,
    paused: isPaused,
    pausedMessage: resolvedPausedMessage,
    showSameDay,
    cutoffRules: normalizedCutoffRules,
    headerTitle: resolvedHeaderTitle,
    headerText: resolvedHeaderText,
    footerText: resolvedFooterText,
    autoAdvanceToday,
    days: availabilityDays,
    calendarDays,
    html,
  };
}

/**
 * Builds the strictly anonymized JSON snapshot pushed to a user's GitHub Pages repo.
 * Contains zero customer names, emails, phones, or internal order IDs.
 */
export function buildPublicAvailabilityJsonPayload(
  result: PublicAvailabilityResult,
  now: Date = new Date()
): PublicAvailabilityJsonPayload {
  const firstActive = result.calendarDays.find((d) => !d.isPast && d.items.length > 0);
  const singleItemName =
    firstActive && firstActive.items.length === 1 ? firstActive.items[0].itemName : null;

  return {
    version: 1,
    generatedAtIso: now.toISOString(),
    generatedAtDisplay: result.generatedAtDisplay,
    timezone: result.timezone,
    weeks: result.weeks,
    paused: Boolean(result.paused),
    pausedMessage: result.pausedMessage ?? DEFAULT_PAUSED_SNIPPET_MESSAGE,
    headerTitle: result.headerTitle ?? 'Upcoming Pickup Availability',
    headerText: result.headerText ?? '',
    footerText: result.footerText ?? '',
    showSameDay: result.showSameDay !== false,
    cutoffRules: result.cutoffRules ?? [],
    autoAdvanceToday: result.autoAdvanceToday !== false,
    singleItemName,
    calendarDays: result.paused ? [] : result.calendarDays,
  };
}

/**
 * Produces a canonical string of the semantic availability payload (omitting volatile timestamps
 * and clock-derived per-day flags like isPast/isToday/isOrderingClosed) so scheduled auto-publish
 * detects real inventory/settings changes and ignores midnight or cutoff clock rollovers.
 */
export function serializeAvailabilityForHash(payload: PublicAvailabilityJsonPayload): string {
  const { generatedAtIso: _iso, generatedAtDisplay: _disp, calendarDays, ...rest } = payload;
  const normalizedDays = calendarDays.map(
    ({ isPast: _p, isToday: _t, isOrderingClosed: _c, ...daySemantic }) => daySemantic
  );
  return JSON.stringify({ ...rest, calendarDays: normalizedDays });
}

/**
 * Generates a self-contained one-time Embed Code snippet for Odoo Website (or any website)
 * that fetches the user's public `availability.json` and renders it safely via DOM APIs
 * (zero innerHTML, strict http/https link validation, live farm-timezone Today & cutoff rules).
 */
export function generateLiveEmbedHtml(publicJsonUrl: string): string {
  const trimmed = publicJsonUrl.trim();
  if (!isSafeHttpUrl(trimmed)) {
    return '';
  }

  return `<section class="fw-cal" data-fw-src="${escapeHtml(trimmed)}">
  <style>
    ${SHARED_PUBLIC_SNIPPET_CSS}
    .fw-cal-loading{padding:18px 0;font-size:13px;color:#64748b}
  </style>
  <div class="fw-cal-mount"><p class="fw-cal-loading">Loading current farm availability...</p></div>
  <script>(function(){try{var s=document.currentScript,root=s&&s.closest?s.closest('.fw-cal'):null;if(!root)return;var src=root.getAttribute('data-fw-src')||'',mount=root.querySelector('.fw-cal-mount');if(!src||!mount)return;var ce=function(t,c,txt){var el=document.createElement(t);if(c)el.className=c;if(txt!==undefined&&txt!==null)el.textContent=String(txt);return el};var safeUrl=function(u){try{var p=new URL(String(u).trim());return p.protocol==='https:'||p.protocol==='http:'?p.href:''}catch(e){return''}};var appendRich=function(parent,raw){var norm=String(raw||'').replace(/\\r\\n/g,'\\n').replace(/<br\\s*\\/?>/gi,'\\n');var lines=norm.split('\\n');var re=/<a\\b[^>]*\\bhref\\s*=\\s*(?:"([^"]+)"|'([^']+)')[^>]*>([\\s\\S]*?)<\\/a>|\\[([^\\]\\n]+)\\]\\((https?:\\/\\/[^\\s)]+)\\)|(https?:\\/\\/[^\\s<>"')]+)/gi;for(var li=0;li<lines.length;li++){if(li>0)parent.appendChild(document.createElement('br'));var line=lines[li],last=0,m;re.lastIndex=0;while((m=re.exec(line))!==null){if(m.index>last)parent.appendChild(document.createTextNode(line.slice(last,m.index)));var href='',lbl='';if(m[1]||m[2]){href=safeUrl(m[1]||m[2]);lbl=String(m[3]||'').replace(/<[^>]+>/g,'').trim()||href}else if(m[5]){href=safeUrl(m[5]);lbl=(m[4]||'').trim()||href}else if(m[6]){var u=m[6],tr='';while(u.length>8&&/[.,!?;:]$/.test(u)){tr=u.slice(-1)+tr;u=u.slice(0,-1)}href=safeUrl(u);lbl=u;if(href){var a0=ce('a','',lbl);a0.href=href;a0.target='_blank';a0.rel='noopener noreferrer';a0.style.color='#0284c7';a0.style.textDecoration='underline';parent.appendChild(a0);if(tr)parent.appendChild(document.createTextNode(tr));last=re.lastIndex;continue}}if(href){var a=ce('a','',lbl);a.href=href;a.target='_blank';a.rel='noopener noreferrer';a.style.color='#0284c7';a.style.textDecoration='underline';parent.appendChild(a)}else{parent.appendChild(document.createTextNode(lbl||m[0]))}last=re.lastIndex}if(last<line.length)parent.appendChild(document.createTextNode(line.slice(last)))}};var fmtQty=function(q){return Number.isInteger(q)?String(q):String(Number(Number(q).toFixed(2)))};var addD=function(ymd,delta){var a=ymd.split('-').map(Number),dt=new Date(Date.UTC(a[0],a[1]-1,a[2]+delta)),pad=function(v){return v<10?'0'+v:''+v};return dt.getUTCFullYear()+'-'+pad(dt.getUTCMonth()+1)+'-'+pad(dt.getUTCDate())};var isoW=function(ymd){var a=ymd.split('-').map(Number),w=new Date(Date.UTC(a[0],a[1]-1,a[2])).getUTCDay();return w===0?7:w};var badgeColors=function(st){if(st==='Available')return{bg:'#ecfdf5',fg:'#065f46',bd:'#a7f3d0'};if(st==='Limited')return{bg:'#fffbeb',fg:'#92400e',bd:'#fde68a'};return{bg:'#fef2f2',fg:'#991b1b',bd:'#fecaca'}};var render=function(data){while(mount.firstChild)mount.removeChild(mount.firstChild);var head=ce('div','fw-cal-head');head.appendChild(ce('h3','fw-cal-title',data.headerTitle||'Upcoming Pickup Availability'));if(data.generatedAtDisplay)head.appendChild(ce('span','fw-cal-ts','Availability accurate as of '+data.generatedAtDisplay));mount.appendChild(head);if(data.headerText){var intro=ce('p','fw-cal-intro');appendRich(intro,data.headerText);mount.appendChild(intro)}if(data.paused){var pbox=ce('div','fw-cal-paused');appendRich(pbox,data.pausedMessage||'Availability is currently unknown.');mount.appendChild(pbox)}else{var days=Array.isArray(data.calendarDays)?data.calendarDays:[];var tz=data.timezone||'America/New_York',n=new Date(),liveToday='',liveHM='00:00';if(data.autoAdvanceToday!==false){try{var pts=new Intl.DateTimeFormat('en-CA',{timeZone:tz,year:'numeric',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',hourCycle:'h23'}).formatToParts(n),gp=function(k){for(var i=0;i<pts.length;i++)if(pts[i].type===k)return pts[i].value;return''};liveToday=gp('year')+'-'+gp('month')+'-'+gp('day');var hh=gp('hour');if(hh==='24')hh='00';liveHM=hh+':'+gp('minute')}catch(e){liveToday=''}}var rules=Array.isArray(data.cutoffRules)?data.cutoffRules:[];var showSame=data.showSameDay!==false;var isClosedLive=function(dt){if(!liveToday)return false;if(dt===liveToday&&!showSame)return true;var pi=isoW(dt);for(var j=0;j<rules.length;j++){var ru=rules[j];if(!ru||ru.enabled===false)continue;if(ru.pickupWeekdays&&ru.pickupWeekdays.length&&ru.pickupWeekdays.indexOf(pi)===-1)continue;var cd=ru.mode==='weekly_day'?addD(dt,-((pi-(ru.cutoffWeekday||5)+7)%7)):addD(dt,-(ru.daysBefore||0));if(liveToday>cd||(liveToday===cd&&liveHM>=(ru.cutoffTime||'16:00')))return true}return false};var hasActiveItems=days.some(function(d){return Array.isArray(d.items)&&d.items.length>0});if(!hasActiveItems){mount.appendChild(ce('p','fw-cal-loading','No items are currently flagged for public availability display.'))}else{var legend=ce('div','fw-cal-legend');var legItems=[['#10b981','Available'],['#f59e0b','Limited'],['#ef4444','Waitlist Full']];if(!showSame||rules.some(function(r){return r&&r.enabled!==false}))legItems.push(['#94a3b8','Ordering Closed']);for(var li=0;li<legItems.length;li++){var sp=ce('span');var dot=ce('i');dot.style.background=legItems[li][0];sp.appendChild(dot);sp.appendChild(document.createTextNode(legItems[li][1]));legend.appendChild(sp)}mount.appendChild(legend);var dow=ce('div','fw-cal-dow');['Mon','Tue','Wed','Thu','Fri','Sat','Sun'].forEach(function(w){dow.appendChild(ce('div','fw-cal-dow-cell',w))});mount.appendChild(dow);var grid=ce('div','fw-cal-grid');var single=Boolean(data.singleItemName);days.forEach(function(day){var isPast=liveToday?day.date<liveToday:Boolean(day.isPast);var isToday=liveToday?day.date===liveToday:Boolean(day.isToday);var isClosed=!isPast&&(Boolean(day.isOrderingClosed)||isClosedLive(day.date));var cls='fw-cal-cell'+(isPast?' fw-cal-past':'')+(isToday?' fw-cal-today':'');var cell=ce('div',cls);cell.setAttribute('data-fw-date',day.date||'');var drow=ce('div','fw-cal-date-row');var dspan=ce('span','fw-cal-date');dspan.appendChild(ce('span','fw-cal-mob-dow',(day.weekdayLabel||'')+', '));dspan.appendChild(document.createTextNode(day.displayDate||day.date||''));drow.appendChild(dspan);if(isToday)drow.appendChild(ce('span','fw-cal-today-tag','Today'));if(isPast)drow.appendChild(ce('span','fw-cal-past-tag','Past'));cell.appendChild(drow);if(!isPast){if(Array.isArray(day.channelNames)&&day.channelNames.length){cell.appendChild(ce('div','fw-cal-ch',day.channelNames.join(' · ')))}var itemsBox=ce('div','fw-cal-items');if(isClosed){itemsBox.appendChild(ce('div','fw-cal-closed','Ordering Closed'))}else{(day.items||[]).forEach(function(it){var txt=it.approxAvailable<=0?'Waitlist Full':'~'+fmtQty(it.approxAvailable)+' '+(it.unitLabel||'');var col=badgeColors(it.status);if(single){var b=ce('div','fw-cal-badge',txt);b.title=it.approxLabel||txt;b.style.background=col.bg;b.style.color=col.fg;b.style.border='1px solid '+col.bd;itemsBox.appendChild(b)}else{var rowIt=ce('div','fw-cal-item');rowIt.title=(it.itemName||'')+': '+(it.approxLabel||txt);rowIt.style.background=col.bg;rowIt.style.color=col.fg;rowIt.style.border='1px solid '+col.bd;rowIt.appendChild(ce('span','fw-cal-item-name',it.itemName||''));rowIt.appendChild(ce('span','fw-cal-item-qty',txt));itemsBox.appendChild(rowIt)}})}cell.appendChild(itemsBox)}grid.appendChild(cell)});mount.appendChild(grid)}}if(data.footerText){var foot=ce('p','fw-cal-foot');appendRich(foot,data.footerText);mount.appendChild(foot)}};var sep=src.indexOf('?')>=0?'&':'?';var bucket=Math.floor(Date.now()/60000);fetch(src+sep+'v='+bucket,{cache:'no-store'}).then(function(r){if(!r.ok)throw new Error('HTTP '+r.status);return r.json()}).then(render).catch(function(){while(mount.firstChild)mount.removeChild(mount.firstChild);mount.appendChild(ce('p','fw-cal-loading','Current farm availability is temporarily unavailable. Please check back shortly.'))})}catch(e){}})();</script>
</section>`;
}
