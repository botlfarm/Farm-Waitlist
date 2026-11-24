import { Check, Copy, Lock, Search } from 'lucide-react';
import { useMemo, useState } from 'react';
import { copyTextToClipboard } from '../lib/api';
import {
  DEFAULT_TIMEZONE,
  addDays,
  compareWaitlistOrders,
  formatFullDisplayDate,
  formatShortCalendarDate,
  getMondayOfWeek,
  getOrderArrivalInfo,
} from '../shared/timezone';
import type { OrderRecord, OrderStatus, PickupChannel, TrackedItem } from '../shared/types';

type DateScope = 'upcoming' | 'week' | 'all' | 'unslotted';

interface OrderListViewProps {
  today: string;
  timezone?: string;
  orders: OrderRecord[];
  items: TrackedItem[];
  channels: PickupChannel[];
  onSelectOrder: (order: OrderRecord) => void;
  onToast: (message: string, kind?: 'info' | 'error') => void;
}

const STATUS_LABELS: Record<OrderStatus, string> = {
  confirmed: 'Confirmed',
  pre_approved: 'Pre-Approved',
  slotted: 'Slotted',
  waitlist: 'Waitlist',
  ignored: 'Ignored',
};

function formatQty(value: number): string {
  if (!Number.isFinite(value)) return '0';
  return Number.isInteger(value) ? String(value) : String(Number(value.toFixed(2)));
}

function getStatusClasses(status: OrderStatus): string {
  switch (status) {
    case 'confirmed':
      return 'border-[#16A34A]/60 bg-[#16A34A]/15 text-[#4ADE80]';
    case 'pre_approved':
      return 'border-[#D97706]/60 bg-[#D97706]/15 text-[#FBBF24]';
    case 'slotted':
      return 'border-[#38BDF8]/50 bg-[#0EA5E9]/15 text-[#38BDF8]';
    case 'waitlist':
      return 'border-[#283340] bg-[#0F1419] text-[#C9D1D9]';
    default:
      return 'border-[#283340] bg-[#0F1419] text-[#8B949E]';
  }
}

export function OrderListView({
  today,
  timezone = DEFAULT_TIMEZONE,
  orders,
  items,
  channels,
  onSelectOrder,
  onToast,
}: OrderListViewProps) {
  const [scope, setScope] = useState<DateScope>('upcoming');
  const [statusFilter, setStatusFilter] = useState<'all' | Exclude<OrderStatus, 'ignored'>>('all');
  const [channelFilter, setChannelFilter] = useState<string>('all');
  const [searchQuery, setSearchQuery] = useState('');
  const [copied, setCopied] = useState(false);

  const activeItems = useMemo(() => items.filter((i) => i.isActive), [items]);
  const itemById = useMemo(() => new Map(items.map((i) => [i.id, i])), [items]);
  const channelById = useMemo(() => new Map(channels.map((c) => [c.id, c])), [channels]);
  const activeItemIds = useMemo(() => new Set(activeItems.map((i) => i.id)), [activeItems]);

  const weekStart = useMemo(() => getMondayOfWeek(today), [today]);
  const weekEnd = useMemo(() => addDays(weekStart, 6), [weekStart]);

  const filteredOrders = useMemo(() => {
    const query = searchQuery.trim().toLowerCase();

    const matches = orders.filter((order) => {
      if (order.status === 'ignored') return false;

      if (statusFilter !== 'all' && order.status !== statusFilter) {
        return false;
      }

      if (channelFilter !== 'all') {
        if (channelFilter === 'unassigned') {
          if (order.pickupChannelId !== null) return false;
        } else if (String(order.pickupChannelId ?? '') !== channelFilter) {
          return false;
        }
      }

      if (scope === 'upcoming') {
        if (order.slottedDate && order.slottedDate < today) {
          return false;
        }
      } else if (scope === 'week') {
        if (!order.slottedDate || order.slottedDate < weekStart || order.slottedDate > weekEnd) {
          return false;
        }
      } else if (scope === 'unslotted') {
        if (order.slottedDate !== null) {
          return false;
        }
      }

      if (query) {
        const channelName = order.pickupChannelId
          ? channelById.get(order.pickupChannelId)?.name ?? ''
          : '';
        const haystack = [
          order.customerName,
          order.odooQuotationName ?? '',
          channelName,
          order.freeTextPickup ?? '',
          order.notes ?? '',
          order.slottedDate ?? '',
          order.requestedDate ?? '',
        ]
          .join(' ')
          .toLowerCase();
        if (!haystack.includes(query)) return false;
      }

      return true;
    });

    return matches.sort((a, b) => {
      // Slotted orders chronologically first, then unslotted orders
      if (a.slottedDate && b.slottedDate) {
        if (a.slottedDate !== b.slottedDate) {
          return a.slottedDate.localeCompare(b.slottedDate);
        }
        return a.customerName.localeCompare(b.customerName);
      }
      if (a.slottedDate && !b.slottedDate) return -1;
      if (!a.slottedDate && b.slottedDate) return 1;

      // Both unslotted: follow waitlist priority order & arrival date (oldest first)
      return compareWaitlistOrders(a, b, timezone);
    });
  }, [orders, statusFilter, channelFilter, scope, today, timezone, weekStart, weekEnd, searchQuery, channelById]);

  const totalsByItem = useMemo(() => {
    const totals = new Map<number, number>();
    for (const item of activeItems) {
      totals.set(item.id, 0);
    }
    let hasOtherItems = false;

    for (const order of filteredOrders) {
      for (const line of order.items) {
        if (activeItemIds.has(line.trackedItemId)) {
          totals.set(
            line.trackedItemId,
            Number(((totals.get(line.trackedItemId) ?? 0) + line.quantity).toFixed(3))
          );
        } else if (line.quantity > 0) {
          hasOtherItems = true;
        }
      }
    }
    return { totals, hasOtherItems };
  }, [filteredOrders, activeItems, activeItemIds]);

  const handleCopyPlainList = async () => {
    const lines: string[] = [];
    lines.push(`Farm Waitlist — Order List (${filteredOrders.length} orders)`);
    lines.push('');

    for (const order of filteredOrders) {
      const dateLabel = order.slottedDate
        ? formatFullDisplayDate(order.slottedDate)
        : order.requestedDate
        ? `Unslotted (Req ${formatShortCalendarDate(order.requestedDate)})`
        : 'Unslotted (ASAP)';
      const channelName = order.pickupChannelId
        ? channelById.get(order.pickupChannelId)?.name ?? ''
        : order.freeTextPickup ?? '';
      const qtyParts = order.items
        .map((line) => {
          const item = itemById.get(line.trackedItemId);
          return `${formatQty(line.quantity)} ${item?.name ?? `Item #${line.trackedItemId}`}`;
        })
        .join(', ');
      const channelSuffix = channelName ? ` | ${channelName}` : '';
      lines.push(
        `- ${dateLabel} | ${order.customerName}${channelSuffix} | ${STATUS_LABELS[order.status]} | ${qtyParts || 'No items'}`
      );
    }

    if (activeItems.length > 0) {
      lines.push('');
      const totalSummary = activeItems
        .map((item) => `${item.name}: ${formatQty(totalsByItem.totals.get(item.id) ?? 0)} ${item.unitLabel}`)
        .join(' | ');
      lines.push(`Totals: ${totalSummary}`);
    }

    const ok = await copyTextToClipboard(lines.join('\n'));
    if (ok) {
      setCopied(true);
      onToast('Order list copied to clipboard');
      setTimeout(() => setCopied(false), 2000);
    } else {
      onToast('Could not access clipboard', 'error');
    }
  };

  const getOrderQtyForItem = (order: OrderRecord, itemId: number): number => {
    let sum = 0;
    for (const line of order.items) {
      if (line.trackedItemId === itemId) {
        sum += line.quantity;
      }
    }
    return Number(sum.toFixed(3));
  };

  const getOtherItemsLabel = (order: OrderRecord): string => {
    const other = order.items.filter((l) => !activeItemIds.has(l.trackedItemId) && l.quantity > 0);
    if (other.length === 0) return '—';
    return other
      .map((l) => {
        const item = itemById.get(l.trackedItemId);
        return `${formatQty(l.quantity)} ${item?.name ?? `#${l.trackedItemId}`}`;
      })
      .join(', ');
  };

  const SCOPE_BUTTONS: Array<{ id: DateScope; label: string }> = [
    { id: 'upcoming', label: 'Upcoming & Waitlist' },
    { id: 'week', label: 'This Week' },
    { id: 'unslotted', label: 'Unslotted Only' },
    { id: 'all', label: 'All Dates' },
  ];

  return (
    <main data-testid="order-list-view" className="mx-auto max-w-7xl px-4 py-6 md:px-6">
      {/* Header Row */}
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <h1 className="font-['Plus_Jakarta_Sans'] text-xl font-bold text-[#F0F6FC]">
            Order List
          </h1>
          <p className="mt-1 text-xs text-[#8B949E]">
            Simple chronological summary of orders, dates, and item quantities. Click any order to
            edit, slot, or send a pre-approval message.
          </p>
        </div>

        <button
          type="button"
          data-testid="order-list-copy-btn"
          onClick={() => void handleCopyPlainList()}
          disabled={filteredOrders.length === 0}
          className="inline-flex min-h-[38px] items-center gap-1.5 rounded-md border border-[#283340] bg-[#161D24] px-3.5 py-1.5 text-xs font-semibold text-[#E6EDF3] transition-colors hover:border-[#38BDF8] disabled:opacity-40"
        >
          {copied ? (
            <>
              <Check className="h-3.5 w-3.5 text-[#4ADE80]" />
              Copied List
            </>
          ) : (
            <>
              <Copy className="h-3.5 w-3.5 text-[#38BDF8]" />
              Copy Plain List
            </>
          )}
        </button>
      </div>

      {/* Filters Toolbar */}
      <section className="mt-5 rounded-lg border border-[#283340] bg-[#161D24] p-3.5">
        <div className="flex flex-col gap-3 lg:flex-row lg:items-center lg:justify-between">
          {/* Date Scope Switcher */}
          <div className="flex flex-wrap gap-1.5" role="group" aria-label="Date Scope">
            {SCOPE_BUTTONS.map((btn) => {
              const active = scope === btn.id;
              return (
                <button
                  key={btn.id}
                  type="button"
                  data-testid={`order-list-scope-${btn.id}`}
                  onClick={() => setScope(btn.id)}
                  className={`min-h-[34px] rounded-md border px-3 py-1 text-xs font-medium transition-colors ${
                    active
                      ? 'border-[#38BDF8] bg-[#0EA5E9]/20 text-[#F0F6FC]'
                      : 'border-[#283340] bg-[#0F1419] text-[#8B949E] hover:text-[#E6EDF3]'
                  }`}
                >
                  {btn.label}
                </button>
              );
            })}
          </div>

          {/* Search, Status & Channel Filters */}
          <div className="grid grid-cols-1 gap-2 sm:grid-cols-3 lg:flex lg:items-center">
            <div className="relative">
              <Search
                className="pointer-events-none absolute top-1/2 left-2.5 h-3.5 w-3.5 -translate-y-1/2 text-[#8B949E]"
                aria-hidden="true"
              />
              <input
                type="search"
                data-testid="order-list-search-input"
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
                placeholder="Search customer, ref..."
                className="min-h-[36px] w-full rounded-md border border-[#283340] bg-[#0F1419] py-1.5 pr-3 pl-8 text-xs text-[#F0F6FC] placeholder:text-[#6E7681] focus:border-[#38BDF8] focus:outline-none lg:w-52"
              />
            </div>

            <select
              data-testid="order-list-status-filter"
              aria-label="Filter by status"
              value={statusFilter}
              onChange={(e) =>
                setStatusFilter(e.target.value as 'all' | Exclude<OrderStatus, 'ignored'>)
              }
              className="min-h-[36px] rounded-md border border-[#283340] bg-[#0F1419] px-2.5 py-1.5 text-xs text-[#F0F6FC] focus:border-[#38BDF8] focus:outline-none"
            >
              <option value="all">All Statuses</option>
              <option value="confirmed">Confirmed</option>
              <option value="pre_approved">Pre-Approved</option>
              <option value="slotted">Slotted</option>
              <option value="waitlist">Waitlist</option>
            </select>

            <select
              data-testid="order-list-channel-filter"
              aria-label="Filter by pickup channel"
              value={channelFilter}
              onChange={(e) => setChannelFilter(e.target.value)}
              className="min-h-[36px] rounded-md border border-[#283340] bg-[#0F1419] px-2.5 py-1.5 text-xs text-[#F0F6FC] focus:border-[#38BDF8] focus:outline-none"
            >
              <option value="all">All Channels</option>
              {channels
                .filter((c) => c.isActive)
                .map((c) => (
                  <option key={c.id} value={String(c.id)}>
                    {c.name}
                  </option>
                ))}
              <option value="unassigned">Unassigned Channel</option>
            </select>
          </div>
        </div>

        {/* Summary Totals Bar */}
        <div
          data-testid="order-list-totals"
          className="mt-3 flex flex-wrap items-center gap-x-5 gap-y-1.5 border-t border-[#283340]/80 pt-3 text-xs"
        >
          <span className="font-semibold text-[#F0F6FC] tabular-nums">
            {filteredOrders.length} {filteredOrders.length === 1 ? 'order' : 'orders'}
          </span>
          {activeItems.map((item) => {
            const total = totalsByItem.totals.get(item.id) ?? 0;
            return (
              <span
                key={item.id}
                data-testid={`order-list-total-item-${item.id}`}
                className="text-[#C9D1D9] tabular-nums"
              >
                <span className="text-[#8B949E]">{item.name}:</span>{' '}
                <span className="font-semibold text-[#F0F6FC]">
                  {formatQty(total)} {item.unitLabel}
                </span>
              </span>
            );
          })}
        </div>
      </section>

      {/* Empty State */}
      {filteredOrders.length === 0 ? (
        <div
          data-testid="order-list-empty"
          className="mt-5 rounded-lg border border-dashed border-[#283340] bg-[#161D24]/60 px-6 py-12 text-center"
        >
          <p className="text-sm font-medium text-[#E6EDF3]">No orders match the current filters.</p>
          <p className="mt-1 text-xs text-[#8B949E]">
            Try switching the date scope to &ldquo;All Dates&rdquo; or clearing the search filter.
          </p>
        </div>
      ) : (
        <>
          {/* Desktop Table */}
          <div className="mt-5 hidden overflow-x-auto rounded-lg border border-[#283340] bg-[#161D24] md:block">
            <table className="w-full border-collapse text-left text-xs">
              <thead>
                <tr className="border-b border-[#283340] bg-[#121920] text-[11px] font-semibold tracking-wider text-[#8B949E] uppercase">
                  <th className="px-4 py-3">Date</th>
                  <th className="px-4 py-3">Customer</th>
                  <th className="px-4 py-3">Channel</th>
                  <th className="px-4 py-3">Status</th>
                  {activeItems.map((item) => (
                    <th key={item.id} className="px-4 py-3 text-right whitespace-nowrap">
                      <div>{item.name}</div>
                      <div className="text-[10px] font-normal normal-case text-[#6E7681]">
                        {item.unitLabel}
                      </div>
                    </th>
                  ))}
                  {totalsByItem.hasOtherItems && (
                    <th className="px-4 py-3 text-right whitespace-nowrap">Other Items</th>
                  )}
                </tr>
              </thead>
              <tbody className="divide-y divide-[#283340]/70">
                {filteredOrders.map((order) => {
                  const channel = order.pickupChannelId
                    ? channelById.get(order.pickupChannelId)
                    : null;
                  const isToday = order.slottedDate === today;
                  const isOverdue =
                    Boolean(order.slottedDate && order.slottedDate < today) &&
                    order.status !== 'confirmed';

                  return (
                    <tr
                      key={order.id}
                      data-testid={`order-list-row-${order.id}`}
                      onClick={() => onSelectOrder(order)}
                      className="cursor-pointer transition-colors hover:bg-[#1E2730]/80"
                    >
                      <td className="px-4 py-3 whitespace-nowrap align-middle">
                        {order.slottedDate ? (
                          <div>
                            <div className="flex items-center gap-2">
                              <span className="font-medium text-[#F0F6FC] tabular-nums">
                                {formatFullDisplayDate(order.slottedDate)}
                              </span>
                              {isToday && (
                                <span className="rounded bg-[#0EA5E9]/20 px-1.5 py-0.5 text-[10px] font-semibold text-[#38BDF8]">
                                  Today
                                </span>
                              )}
                              {isOverdue && (
                                <span className="rounded bg-[#DC2626]/20 px-1.5 py-0.5 text-[10px] font-semibold text-[#F87171]">
                                  Overdue
                                </span>
                              )}
                            </div>
                            {order.requestedDate && order.requestedDate !== order.slottedDate && (
                              <div className="mt-0.5 text-[11px] font-medium text-[#FBBF24]">
                                Requested {formatShortCalendarDate(order.requestedDate)}
                              </div>
                            )}
                          </div>
                        ) : (
                          <div>
                            <div className="flex items-center gap-1.5 text-[#C9D1D9]">
                              <span className="font-semibold text-[#F0F6FC]">
                                Arrived {getOrderArrivalInfo(order, timezone, today).shortLabel}
                              </span>
                              {!order.requestedDate && (
                                <span className="text-[11px] text-[#8B949E]">· ASAP</span>
                              )}
                            </div>
                            {order.requestedDate ? (
                              <div className="mt-0.5 text-[11px] font-semibold text-[#FBBF24]">
                                Requested Pickup: {formatShortCalendarDate(order.requestedDate)}
                              </div>
                            ) : (
                              <div className="text-[10px] text-[#8B949E]">Unslotted waitlist</div>
                            )}
                          </div>
                        )}
                      </td>

                      <td className="px-4 py-3 align-middle">
                        <div className="flex items-center gap-1.5">
                          <span className="font-semibold text-[#F0F6FC]">{order.customerName}</span>
                          {order.isLocked && (
                            <Lock
                              className="h-3 w-3 shrink-0 text-[#8B949E]"
                              aria-label="Locked order"
                            />
                          )}
                        </div>
                        <div className="mt-0.5 flex flex-wrap items-center gap-2 text-[11px] text-[#8B949E]">
                          {order.odooQuotationName && (
                            <span className="font-mono text-[10px] text-[#8B949E]">
                              {order.odooQuotationName}
                            </span>
                          )}
                          {order.source === 'standing' && (
                            <span className="text-[10px] text-[#38BDF8]">Standing</span>
                          )}
                          {order.notes && (
                            <span className="max-w-[240px] truncate text-[#6E7681]">
                              {order.notes}
                            </span>
                          )}
                        </div>
                      </td>

                      <td className="px-4 py-3 whitespace-nowrap align-middle text-[#C9D1D9]">
                        {channel ? (
                          <span>{channel.name}</span>
                        ) : order.freeTextPickup ? (
                          <span className="text-[#8B949E]">{order.freeTextPickup}</span>
                        ) : (
                          <span className="text-[#6E7681]">—</span>
                        )}
                      </td>

                      <td className="px-4 py-3 whitespace-nowrap align-middle">
                        <span
                          className={`inline-flex items-center rounded border px-2 py-0.5 text-[11px] font-medium ${getStatusClasses(
                            order.status
                          )}`}
                        >
                          {STATUS_LABELS[order.status]}
                        </span>
                      </td>

                      {activeItems.map((item) => {
                        const qty = getOrderQtyForItem(order, item.id);
                        return (
                          <td
                            key={item.id}
                            className={`px-4 py-3 text-right whitespace-nowrap align-middle tabular-nums ${
                              qty > 0 ? 'font-semibold text-[#F0F6FC]' : 'text-[#485563]'
                            }`}
                          >
                            {qty > 0 ? formatQty(qty) : '—'}
                          </td>
                        );
                      })}

                      {totalsByItem.hasOtherItems && (
                        <td className="px-4 py-3 text-right whitespace-nowrap align-middle text-[#C9D1D9]">
                          {getOtherItemsLabel(order)}
                        </td>
                      )}
                    </tr>
                  );
                })}
              </tbody>
              <tfoot>
                <tr
                  data-testid="order-list-table-totals"
                  className="border-t border-[#283340] bg-[#121920] font-semibold text-[#F0F6FC]"
                >
                  <td colSpan={4} className="px-4 py-3 text-xs text-[#C9D1D9]">
                    Total ({filteredOrders.length}{' '}
                    {filteredOrders.length === 1 ? 'order' : 'orders'})
                  </td>
                  {activeItems.map((item) => (
                    <td
                      key={item.id}
                      className="px-4 py-3 text-right whitespace-nowrap tabular-nums text-[#38BDF8]"
                    >
                      {formatQty(totalsByItem.totals.get(item.id) ?? 0)}
                    </td>
                  ))}
                  {totalsByItem.hasOtherItems && <td className="px-4 py-3" />}
                </tr>
              </tfoot>
            </table>
          </div>

          {/* Mobile Card List */}
          <div className="mt-4 space-y-2.5 md:hidden">
            {filteredOrders.map((order) => {
              const channel = order.pickupChannelId
                ? channelById.get(order.pickupChannelId)
                : null;
              const isToday = order.slottedDate === today;
              const isOverdue =
                Boolean(order.slottedDate && order.slottedDate < today) &&
                order.status !== 'confirmed';

              return (
                <button
                  key={order.id}
                  type="button"
                  data-testid={`order-list-card-${order.id}`}
                  onClick={() => onSelectOrder(order)}
                  className="w-full rounded-lg border border-[#283340] bg-[#161D24] p-3.5 text-left transition-colors hover:border-[#38BDF8]/60"
                >
                  <div className="flex items-start justify-between gap-2">
                    <div>
                      <div className="flex items-center gap-1.5 text-xs font-medium text-[#38BDF8] tabular-nums">
                        <span>
                          {order.slottedDate
                            ? formatFullDisplayDate(order.slottedDate)
                            : `Arrived ${getOrderArrivalInfo(order, timezone, today).shortLabel} · ${
                                order.requestedDate
                                  ? `Req ${formatShortCalendarDate(order.requestedDate)}`
                                  : 'ASAP'
                              }`}
                        </span>
                        {isToday && (
                          <span className="rounded bg-[#0EA5E9]/20 px-1.5 py-0.5 text-[10px] font-semibold text-[#38BDF8]">
                            Today
                          </span>
                        )}
                        {isOverdue && (
                          <span className="rounded bg-[#DC2626]/20 px-1.5 py-0.5 text-[10px] font-semibold text-[#F87171]">
                            Overdue
                          </span>
                        )}
                      </div>
                      {order.requestedDate && (
                        <p className="mt-0.5 text-[11px] font-semibold text-[#FBBF24]">
                          Requested Pickup: {formatShortCalendarDate(order.requestedDate)}
                        </p>
                      )}
                      <p className="mt-1 text-sm font-semibold text-[#F0F6FC]">
                        {order.customerName}
                      </p>
                      {(channel || order.freeTextPickup) && (
                        <p className="text-[11px] text-[#8B949E]">
                          {channel?.name ?? order.freeTextPickup}
                        </p>
                      )}
                    </div>
                    <span
                      className={`shrink-0 rounded border px-2 py-0.5 text-[11px] font-medium ${getStatusClasses(
                        order.status
                      )}`}
                    >
                      {STATUS_LABELS[order.status]}
                    </span>
                  </div>

                  <div className="mt-2.5 flex flex-wrap gap-x-4 gap-y-1 border-t border-[#283340]/70 pt-2 text-xs tabular-nums">
                    {order.items.length === 0 ? (
                      <span className="text-[#8B949E]">No items attached</span>
                    ) : (
                      order.items.map((line) => {
                        const item = itemById.get(line.trackedItemId);
                        return (
                          <span key={`${order.id}-${line.trackedItemId}`} className="text-[#E6EDF3]">
                            <span className="font-semibold text-[#F0F6FC]">
                              {formatQty(line.quantity)}
                            </span>{' '}
                            <span className="text-[#8B949E]">
                              {item ? `${item.name} (${item.unitLabel})` : `Item #${line.trackedItemId}`}
                            </span>
                          </span>
                        );
                      })
                    )}
                  </div>
                </button>
              );
            })}
          </div>
        </>
      )}
    </main>
  );
}
