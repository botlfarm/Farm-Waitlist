import {
  DEFAULT_TIMEZONE,
  ISO_WEEKDAY_LABELS,
  addDays,
  formatFullDisplayDate,
  formatLocalDateTime,
  formatShortCalendarDate,
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
  PublicAvailabilityResult,
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

export function renderPreApprovalMessage(params: {
  template: string;
  order: OrderRecord;
  items: TrackedItem[];
  channels: PickupChannel[];
}): string {
  const { template, order, items, channels } = params;
  const itemsById = new Map(items.map((i) => [i.id, i]));
  const channel = order.pickupChannelId
    ? channels.find((c) => c.id === order.pickupChannelId)?.name ?? order.freeTextPickup ?? 'Farm Pickup'
    : order.freeTextPickup ?? 'Farm Pickup';

  const dateLabel = order.slottedDate
    ? formatFullDisplayDate(order.slottedDate)
    : order.requestedDate
      ? formatFullDisplayDate(order.requestedDate)
      : 'your scheduled pickup date';

  const itemsSummary = formatOrderItemsSummary(order, itemsById);
  const firstName = (order.customerName || 'there').trim();

  return template
    .replace(/\{\{\s*name\s*\}\}/gi, firstName)
    .replace(/\{\{\s*items_summary\s*\}\}/gi, itemsSummary)
    .replace(/\{\{\s*date\s*\}\}/gi, dateLabel)
    .replace(/\{\{\s*channel\s*\}\}/gi, channel);
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
    headerTitle,
    headerText,
    footerText,
    autoAdvanceToday = true,
  } = params;

  const publicItems = items.filter((i) => i.isActive && i.includeInPublicSnippet);
  const activeChannels = channels.filter((c) => c.isActive);
  const cutoffEnd = addDays(today, weeks * 7 - 1);
  const daysByDate = new Map(days.map((d) => [d.date, d]));

  const generatedAtDisplay = formatLocalDateTime(now, timezone);

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
        return `<div class="fw-cal-cell fw-cal-past" data-fw-date="${escapeHtml(day.date)}" aria-hidden="true"><div class="fw-cal-date">${escapeHtml(day.displayDate)}</div></div>`;
      }

      const channelHtml = day.channelNames.length
        ? `<div class="fw-cal-ch">${escapeHtml(day.channelNames.join(' · '))}</div>`
        : '';

      const itemsHtml = day.items
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

      return `<div class="fw-cal-cell${todayClass}" data-fw-date="${escapeHtml(day.date)}"><div class="fw-cal-date-row"><span class="fw-cal-date"><span class="fw-cal-mob-dow">${escapeHtml(day.weekdayLabel)}, </span>${escapeHtml(day.displayDate)}</span>${todayBadge}</div>${channelHtml}<div class="fw-cal-items">${itemsHtml}</div></div>`;
    })
    .join('\n      ');

  const headerIntroHtml = resolvedHeaderText
    ? `\n  <p class="fw-cal-intro">${renderInlineRichTextToSafeHtml(resolvedHeaderText)}</p>`
    : '';

  const footerHtml = resolvedFooterText
    ? `\n    <p class="fw-cal-foot">${renderInlineRichTextToSafeHtml(resolvedFooterText)}</p>`
    : '';

  const bodyHtml =
    publicItems.length === 0
      ? `<p style="margin:12px 0;color:#475569;font-size:14px;">No items are currently flagged for public availability display.</p>${footerHtml}`
      : `<div class="fw-cal-legend">
      <span><i style="background:#10b981;"></i>Available</span>
      <span><i style="background:#f59e0b;"></i>Limited</span>
      <span><i style="background:#ef4444;"></i>Waitlist Full</span>
    </div>
    <div class="fw-cal-dow">${weekdayHeadersHtml}</div>
    <div class="fw-cal-grid">
      ${calendarCellsHtml}
    </div>${footerHtml}`;

  // Optional progressive-enhancement script: automatically advances the "Today" highlight
  // and dims/hides elapsed days in the visitor's browser using the farm's timezone.
  const autoAdvanceScriptHtml = autoAdvanceToday
    ? `\n  <script>(function(){try{var s=document.currentScript,r=s&&s.closest?s.closest('.fw-cal'):null;if(!r)return;var tz=r.getAttribute('data-fw-tz')||'America/New_York',n=new Date(),t='';try{var p=new Intl.DateTimeFormat('en-CA',{timeZone:tz,year:'numeric',month:'2-digit',day:'2-digit'}).formatToParts(n),g=function(k){for(var i=0;i<p.length;i++)if(p[i].type===k)return p[i].value;return''};t=g('year')+'-'+g('month')+'-'+g('day')}catch(e){var m=String(n.getMonth()+1),d=String(n.getDate());t=n.getFullYear()+'-'+(m.length<2?'0'+m:m)+'-'+(d.length<2?'0'+d:d)}if(!/^\\d{4}-\\d{2}-\\d{2}$/.test(t))return;var c=r.querySelectorAll('[data-fw-date]');for(var i=0;i<c.length;i++){var el=c[i],dt=el.getAttribute('data-fw-date'),tag=el.querySelector('.fw-cal-today-tag');if(dt<t){el.classList.add('fw-cal-past');el.classList.remove('fw-cal-today');el.setAttribute('aria-hidden','true');if(tag)tag.remove()}else if(dt===t){el.classList.remove('fw-cal-past');el.classList.add('fw-cal-today');el.removeAttribute('aria-hidden');if(!tag){var row=el.querySelector('.fw-cal-date-row');if(row){var sp=document.createElement('span');sp.className='fw-cal-today-tag';sp.textContent='Today';row.appendChild(sp)}}}else{el.classList.remove('fw-cal-past','fw-cal-today');el.removeAttribute('aria-hidden');if(tag)tag.remove()}}}catch(e){}})();</script>`
    : '';

  const html = `<section class="fw-cal" data-fw-tz="${escapeHtml(timezone)}">
  <style>
    .fw-cal{max-width:880px;margin:0 auto;padding:18px;border:1px solid #e2e8f0;border-radius:10px;background:#ffffff;font-family:system-ui,-apple-system,Segoe UI,Roboto,sans-serif;color:#0f172a;box-sizing:border-box}
    .fw-cal *{box-sizing:border-box}
    .fw-cal-head{display:flex;flex-wrap:wrap;justify-content:space-between;align-items:baseline;gap:8px;margin-bottom:8px}
    .fw-cal-title{margin:0;font-size:18px;font-weight:700;color:#0f172a}
    .fw-cal-ts{font-size:12px;color:#64748b}
    .fw-cal-intro{margin:0 0 12px;font-size:13px;line-height:1.45;color:#334155}
    .fw-cal-legend{display:flex;flex-wrap:wrap;gap:14px;margin-bottom:12px;font-size:12px;color:#475569}
    .fw-cal-legend span{display:inline-flex;align-items:center;gap:6px}
    .fw-cal-legend i{display:inline-block;width:8px;height:8px;border-radius:999px}
    .fw-cal-dow{display:grid;grid-template-columns:repeat(7,minmax(0,1fr));gap:6px;margin-bottom:6px}
    .fw-cal-dow-cell{font-size:11px;font-weight:600;text-transform:uppercase;letter-spacing:.04em;color:#64748b;padding:0 4px}
    .fw-cal-grid{display:grid;grid-template-columns:repeat(7,minmax(0,1fr));gap:6px}
    .fw-cal-cell{min-height:84px;padding:8px;border:1px solid #e2e8f0;border-radius:8px;background:#f8fafc;display:flex;flex-direction:column;gap:5px}
    .fw-cal-today{border-color:#0284c7;background:#f0f9ff}
    .fw-cal-past{opacity:.38;background:#f8fafc}
    .fw-cal-past .fw-cal-items,.fw-cal-past .fw-cal-ch,.fw-cal-past .fw-cal-today-tag{display:none}
    .fw-cal-date-row{display:flex;align-items:center;justify-content:space-between;gap:4px}
    .fw-cal-date{font-size:12px;font-weight:700;color:#0f172a}
    .fw-cal-mob-dow{display:none}
    .fw-cal-today-tag{font-size:10px;font-weight:700;color:#0369a1;text-transform:uppercase;letter-spacing:.03em}
    .fw-cal-ch{font-size:11px;color:#64748b;line-height:1.25}
    .fw-cal-items{display:flex;flex-direction:column;gap:4px;margin-top:auto}
    .fw-cal-badge{padding:4px 6px;border-radius:5px;font-size:11px;font-weight:600;line-height:1.2;text-align:center}
    .fw-cal-item{display:flex;justify-content:space-between;align-items:center;gap:4px;padding:3px 6px;border-radius:5px;font-size:11px;font-weight:600;line-height:1.2}
    .fw-cal-item-name{overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-weight:500}
    .fw-cal-item-qty{white-space:nowrap}
    .fw-cal-foot{margin:12px 0 0;font-size:11px;line-height:1.45;color:#64748b}
    @media (max-width:640px){
      .fw-cal{padding:12px}
      .fw-cal-dow{display:none}
      .fw-cal-grid{grid-template-columns:1fr;gap:6px}
      .fw-cal-past{display:none}
      .fw-cal-cell{min-height:auto;flex-direction:row;flex-wrap:wrap;align-items:center;justify-content:space-between;padding:10px 12px}
      .fw-cal-mob-dow{display:inline}
      .fw-cal-items{margin-top:0;flex-direction:row;flex-wrap:wrap}
    }
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
    headerTitle: resolvedHeaderTitle,
    headerText: resolvedHeaderText,
    footerText: resolvedFooterText,
    autoAdvanceToday,
    days: availabilityDays,
    calendarDays,
    html,
  };
}
