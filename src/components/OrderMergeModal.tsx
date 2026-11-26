import {
  ArrowRight,
  Check,
  ExternalLink,
  GitMerge,
  Mail,
  MessageSquare,
  X,
} from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';
import { formatQty } from '../shared/generators';
import {
  findReplacementCandidates,
  isStandingRecurringOrder,
  previewMergeOutcome,
  resolveMergeDateOptions,
  scoreDuplicateOrder,
} from '../shared/orderMatching';
import { formatDateNoYear, formatShortCalendarDate } from '../shared/timezone';
import type {
  OrderItemLine,
  OrderMergeItemStrategy,
  OrderRecord,
  PickupChannel,
  TrackedItem,
} from '../shared/types';

export interface OrderMergeModalProps {
  open: boolean;
  targetOrder: OrderRecord | null;
  initialSourceOrderId: number | null;
  mode?: 'replace' | 'merge';
  allOrders: OrderRecord[];
  items: TrackedItem[];
  channels: PickupChannel[];
  readOnly?: boolean;
  onClose: () => void;
  onSelectOrder?: (orderId: number) => void;
  onApproveMerge: (
    targetOrderId: number,
    sourceOrderId: number,
    itemStrategy: OrderMergeItemStrategy,
    keepDate: string | null
  ) => Promise<void>;
  onDismissDuplicate?: (orderId: number, otherOrderId: number) => Promise<void>;
}

function formatStatusLabel(status: OrderRecord['status']): string {
  switch (status) {
    case 'confirmed':
      return 'Confirmed';
    case 'pre_approved':
      return 'Pre-Approved';
    case 'slotted':
      return 'Slotted';
    case 'ignored':
      return 'Ignored';
    default:
      return 'Waitlist';
  }
}

function statusColorClass(status: OrderRecord['status']): string {
  switch (status) {
    case 'confirmed':
      return 'text-[#4ADE80]';
    case 'pre_approved':
      return 'text-[#FBBF24]';
    case 'slotted':
      return 'text-[#38BDF8]';
    default:
      return 'text-[#C9D1D9]';
  }
}

function formatItemsLine(lines: OrderItemLine[], items: TrackedItem[]): string {
  if (lines.length === 0) return 'No tracked items';
  return lines
    .map((line) => {
      const meta = items.find((i) => i.id === line.trackedItemId);
      return `${formatQty(line.quantity)} ${meta ? `${meta.unitLabel} ${meta.name}` : `#${line.trackedItemId}`}`;
    })
    .join(', ');
}

function itemsSignature(lines: OrderItemLine[]): string {
  return [...lines]
    .filter((l) => l.quantity > 0)
    .sort((a, b) => a.trackedItemId - b.trackedItemId)
    .map((l) => `${l.trackedItemId}:${l.quantity}`)
    .join('|');
}

function getChannelDisplay(
  channelId: number | null,
  freeText: string | null,
  channels: PickupChannel[]
): string {
  if (channelId !== null) {
    const found = channels.find((c) => c.id === channelId);
    if (found) return found.name;
  }
  if (freeText && freeText.trim()) return freeText.trim();
  return 'Unassigned';
}

function getGeneralNotes(order: OrderRecord): string {
  const trimmedNotes = (order.notes || '').trim();
  const trimmedRaw = (order.odooRawNotes || '').trim();
  if (order.source === 'odoo' && trimmedRaw && trimmedNotes === trimmedRaw) {
    return '';
  }
  return trimmedNotes;
}

interface SideCardProps {
  order: OrderRecord;
  roleLabel: string;
  roleTone: 'amber' | 'emerald' | 'sky';
  roleSubtext: string;
  isHighlighted: boolean;
  dateDiffers: boolean;
  channelDiffers: boolean;
  itemsDiffer: boolean;
  items: TrackedItem[];
  channels: PickupChannel[];
  cardTestId: string;
  detailsTestId?: string;
  chatterTestId: string;
  openBtnTestId?: string;
  onOpenOrder?: () => void;
}

function OrderComparisonColumn({
  order,
  roleLabel,
  roleTone,
  roleSubtext,
  isHighlighted,
  dateDiffers,
  channelDiffers,
  itemsDiffer,
  items,
  channels,
  cardTestId,
  detailsTestId,
  chatterTestId,
  openBtnTestId,
  onOpenOrder,
}: SideCardProps) {
  const effectiveDate = order.slottedDate || order.requestedDate;
  const dateKind = order.slottedDate
    ? 'Scheduled'
    : order.requestedDate
      ? 'Requested'
      : 'Unslotted';
  const channelName = getChannelDisplay(order.pickupChannelId, order.freeTextPickup, channels);
  const arrivalLabel =
    order.odooCreatedAtLocal || order.createdAt.slice(0, 16).replace('T', ' ');
  const generalNotes = getGeneralNotes(order);
  const rawNotes = (order.odooRawNotes || '').trim();
  const refLabel = order.odooQuotationName || `Order #${order.id}`;

  const kickerClass =
    roleTone === 'amber'
      ? 'text-[#FBBF24]'
      : roleTone === 'emerald'
        ? 'text-[#4ADE80]'
        : 'text-[#38BDF8]';

  return (
    <div
      data-testid={cardTestId}
      className={`flex flex-col rounded-lg border bg-[#11171D] ${
        isHighlighted ? 'border-[#38BDF8]/60' : 'border-[#283340]'
      }`}
    >
      {/* Column Header */}
      <div className="border-b border-[#283340] px-4 py-3">
        <div className="flex items-start justify-between gap-2">
          <div className="min-w-0">
            <div className={`text-xs font-semibold ${kickerClass}`}>{roleLabel}</div>
            <div className="mt-0.5 flex flex-wrap items-baseline gap-x-2 gap-y-0.5">
              <h3 className="truncate font-['Plus_Jakarta_Sans'] text-sm font-bold text-[#F0F6FC]">
                {order.customerName}
              </h3>
              <span className="font-mono text-xs text-[#7DD3FC]">{refLabel}</span>
            </div>
            <p className="mt-0.5 text-[11px] text-[#8B949E]">{roleSubtext}</p>
          </div>
          {onOpenOrder && (
            <button
              type="button"
              data-testid={openBtnTestId}
              onClick={onOpenOrder}
              className="inline-flex shrink-0 items-center gap-1 whitespace-nowrap rounded-md border border-[#283340] bg-[#0F1419] px-2.5 py-1 text-[11px] font-medium text-[#38BDF8] transition-colors hover:border-[#38BDF8]"
            >
              <ExternalLink className="h-3 w-3" aria-hidden="true" />
              Open
            </button>
          )}
        </div>
      </div>

      {/* Aligned Comparison Fields */}
      <div data-testid={detailsTestId} className="flex-1 divide-y divide-[#283340]/80 px-4 text-xs">
        {/* Status & Arrival */}
        <div className="grid grid-cols-2 gap-3 py-2.5">
          <div>
            <div className="text-[11px] text-[#8B949E]">Status</div>
            <div className={`mt-0.5 font-semibold ${statusColorClass(order.status)}`}>
              {formatStatusLabel(order.status)}
              {order.odooMissingFlagged ? ' · Removed in Odoo' : ''}
            </div>
          </div>
          <div>
            <div className="text-[11px] text-[#8B949E]">Arrived</div>
            <div className="mt-0.5 font-mono text-[11px] tabular-nums text-[#C9D1D9]">
              {arrivalLabel}
            </div>
          </div>
        </div>

        {/* Date */}
        <div className="py-2.5">
          <div className="flex items-center justify-between gap-2">
            <span className="text-[11px] text-[#8B949E]">Pickup Date ({dateKind})</span>
            {dateDiffers && (
              <span className="text-[11px] font-medium text-[#FBBF24]">Differs</span>
            )}
          </div>
          <div
            className={`mt-0.5 font-mono text-sm font-semibold tabular-nums ${
              effectiveDate ? 'text-[#F0F6FC]' : 'text-[#8B949E]'
            }`}
          >
            {effectiveDate ? formatDateNoYear(effectiveDate) : 'Unslotted / ASAP'}
          </div>
          {order.slottedDate && order.requestedDate && order.requestedDate !== order.slottedDate && (
            <div className="mt-0.5 text-[11px] text-[#8B949E]">
              Originally requested {formatShortCalendarDate(order.requestedDate)}
            </div>
          )}
        </div>

        {/* Pickup Channel */}
        <div className="py-2.5">
          <div className="flex items-center justify-between gap-2">
            <span className="text-[11px] text-[#8B949E]">Pickup Channel</span>
            {channelDiffers && (
              <span className="text-[11px] font-medium text-[#FBBF24]">Differs</span>
            )}
          </div>
          <div className="mt-0.5 font-medium text-[#E6EDF3]">{channelName}</div>
        </div>

        {/* Items */}
        <div className="py-2.5">
          <div className="flex items-center justify-between gap-2">
            <span className="text-[11px] text-[#8B949E]">Items</span>
            {itemsDiffer && (
              <span className="text-[11px] font-medium text-[#FBBF24]">Differs</span>
            )}
          </div>
          <div className="mt-0.5 font-mono text-xs font-semibold tabular-nums text-[#F0F6FC]">
            {formatItemsLine(order.items, items)}
          </div>
          {order.odooRawLines.length > 0 && (
            <ul className="mt-1 space-y-0.5 text-[11px] text-[#8B949E]">
              {order.odooRawLines.map((rawLine, idx) => (
                <li key={idx} className="font-mono">
                  • {rawLine}
                </li>
              ))}
            </ul>
          )}
        </div>

        {/* Contact */}
        {(order.customerPhone || order.customerEmail) && (
          <div className="py-2.5">
            <div className="text-[11px] text-[#8B949E]">Contact</div>
            <div className="mt-0.5 break-words text-[11px] text-[#C9D1D9]">
              {[order.customerPhone, order.customerEmail].filter(Boolean).join(' · ')}
            </div>
          </div>
        )}

        {/* Notes */}
        {(generalNotes || rawNotes) && (
          <div className="py-2.5">
            <div className="text-[11px] text-[#8B949E]">Notes &amp; Order Details</div>
            {generalNotes && (
              <p className="mt-1 whitespace-pre-wrap text-[11px] leading-relaxed text-[#E6EDF3]">
                {generalNotes}
              </p>
            )}
            {rawNotes && (
              <p className="mt-1 whitespace-pre-wrap text-[11px] leading-relaxed text-[#8B949E]">
                {rawNotes}
              </p>
            )}
          </div>
        )}

        {/* Odoo Chatter */}
        <div data-testid={chatterTestId} className="py-2.5">
          <div className="flex items-center justify-between gap-2 text-[11px]">
            <span className="text-[#8B949E]">Odoo Chatter ({order.chatter.length})</span>
            {order.chatter.length > 0 && (
              <span className="text-[#8B949E]">Kept in merged order</span>
            )}
          </div>
          {order.chatter.length === 0 ? (
            <p className="mt-1 text-[11px] text-[#8B949E]">No chatter messages.</p>
          ) : (
            <div className="mt-1.5 max-h-36 space-y-2 overflow-y-auto pr-1">
              {order.chatter.map((msg) => (
                <div
                  key={msg.id}
                  className="border-t border-[#283340]/70 pt-1.5 first:border-t-0 first:pt-0"
                >
                  <div className="flex items-center justify-between gap-2 text-[11px] text-[#8B949E]">
                    <span className="inline-flex items-center gap-1 font-medium text-[#E6EDF3]">
                      {msg.messageType === 'email' ? (
                        <Mail className="h-3 w-3 text-[#38BDF8]" aria-hidden="true" />
                      ) : (
                        <MessageSquare className="h-3 w-3 text-[#8B949E]" aria-hidden="true" />
                      )}
                      {msg.authorName}
                    </span>
                    <span className="font-mono text-[10px] tabular-nums">{msg.createdAtLocal}</span>
                  </div>
                  <p className="mt-0.5 whitespace-pre-wrap text-[11px] leading-relaxed text-[#C9D1D9]">
                    {msg.bodyText}
                  </p>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

export function OrderMergeModal({
  open,
  targetOrder,
  initialSourceOrderId,
  mode = 'merge',
  allOrders,
  items,
  channels,
  readOnly = false,
  onClose,
  onSelectOrder,
  onApproveMerge,
  onDismissDuplicate,
}: OrderMergeModalProps) {
  const [sourceId, setSourceId] = useState<string>('');
  const [itemStrategy, setItemStrategy] = useState<OrderMergeItemStrategy>('keep_target');
  const [keepDate, setKeepDate] = useState<string>('');
  const [submitting, setSubmitting] = useState(false);
  const [dismissing, setDismissing] = useState(false);

  const candidates = useMemo(() => {
    if (!targetOrder || isStandingRecurringOrder(targetOrder)) {
      return { likely: [] as OrderRecord[], others: [] as OrderRecord[] };
    }
    if (targetOrder.odooMissingFlagged) {
      const replacementMatches = findReplacementCandidates(targetOrder, allOrders).map(
        (c) => c.order
      );
      const matchIds = new Set(replacementMatches.map((o) => o.id));
      const others = allOrders.filter(
        (o) =>
          o.id !== targetOrder.id &&
          o.status !== 'ignored' &&
          !isStandingRecurringOrder(o) &&
          !matchIds.has(o.id)
      );
      return { likely: replacementMatches, others };
    }

    const dismissedSet = new Set<number>(targetOrder.dismissedDuplicateOrderIds ?? []);
    const eligible = allOrders.filter(
      (o) => o.id !== targetOrder.id && o.status !== 'ignored' && !isStandingRecurringOrder(o)
    );
    const likelyScored: Array<{ cand: OrderRecord; score: number }> = [];
    const others: OrderRecord[] = [];
    for (const cand of eligible) {
      const isDismissed =
        dismissedSet.has(cand.id) ||
        (cand.dismissedDuplicateOrderIds ?? []).includes(targetOrder.id);
      const score = isDismissed ? 0 : scoreDuplicateOrder(targetOrder, cand);
      if (score > 0) {
        likelyScored.push({ cand, score });
      } else {
        others.push(cand);
      }
    }
    likelyScored.sort((a, b) => b.score - a.score || b.cand.id - a.cand.id);
    return { likely: likelyScored.map((e) => e.cand), others };
  }, [allOrders, targetOrder]);

  // Reset source selection whenever modal opens for a target/source pair
  useEffect(() => {
    if (!open || !targetOrder) return;
    const defaultSourceId =
      initialSourceOrderId ??
      candidates.likely[0]?.id ??
      candidates.others[0]?.id ??
      null;
    setSourceId(defaultSourceId ? String(defaultSourceId) : '');
    setSubmitting(false);
    setDismissing(false);
  }, [open, targetOrder?.id, initialSourceOrderId]);

  const selectedSource = useMemo(() => {
    const num = Number(sourceId);
    if (!num) return null;
    return allOrders.find((o) => o.id === num) ?? null;
  }, [allOrders, sourceId]);

  // Auto-select recommended date & item strategy whenever the compared pair changes
  useEffect(() => {
    if (!open || !targetOrder || !selectedSource) return;
    const dateOpts = resolveMergeDateOptions(targetOrder, selectedSource);
    setKeepDate(dateOpts.recommendedDate ?? '');

    const isReplacingCancelled =
      mode === 'replace' ||
      (targetOrder.odooMissingFlagged && !selectedSource.odooMissingFlagged);
    if (isReplacingCancelled) {
      setItemStrategy('use_source');
    } else if (!targetOrder.odooMissingFlagged && selectedSource.odooMissingFlagged) {
      setItemStrategy('keep_target');
    } else if (selectedSource.status === 'confirmed' && targetOrder.status !== 'confirmed') {
      setItemStrategy('use_source');
    } else {
      setItemStrategy('keep_target');
    }
  }, [open, targetOrder?.id, selectedSource?.id, mode]);

  if (!open || !targetOrder) return null;

  const isTargetCancelled = Boolean(targetOrder.odooMissingFlagged);
  const isSourceCancelled = Boolean(selectedSource?.odooMissingFlagged);
  const isCancelledMatch = isTargetCancelled !== isSourceCancelled || mode === 'replace';

  const dateOpts = selectedSource ? resolveMergeDateOptions(targetOrder, selectedSource) : null;
  const resolvedDate =
    keepDate ||
    dateOpts?.recommendedDate ||
    targetOrder.slottedDate ||
    selectedSource?.slottedDate ||
    null;

  const outcome = selectedSource
    ? previewMergeOutcome(targetOrder, selectedSource, itemStrategy, resolvedDate)
    : null;

  const targetRef = targetOrder.odooQuotationName || `Order #${targetOrder.id}`;
  const sourceRef = selectedSource
    ? selectedSource.odooQuotationName || `Order #${selectedSource.id}`
    : '';

  const targetChannelDisplay = getChannelDisplay(
    targetOrder.pickupChannelId,
    targetOrder.freeTextPickup,
    channels
  );
  const sourceChannelDisplay = selectedSource
    ? getChannelDisplay(selectedSource.pickupChannelId, selectedSource.freeTextPickup, channels)
    : '';
  const finalChannelDisplay = outcome
    ? getChannelDisplay(outcome.nextPickupChannelId, outcome.nextFreeTextPickup, channels)
    : targetChannelDisplay;

  const dateDiffers = Boolean(dateOpts?.hasDifferentDates);
  const channelDiffers = Boolean(
    selectedSource && targetChannelDisplay !== sourceChannelDisplay
  );
  const itemsDiffer = Boolean(
    selectedSource && itemsSignature(targetOrder.items) !== itemsSignature(selectedSource.items)
  );

  const combinedItemsPreview = selectedSource
    ? previewMergeOutcome(targetOrder, selectedSource, 'combine', resolvedDate).mergedItems
    : [];

  const targetRole = isTargetCancelled
    ? {
        label: 'Cancelled Pre-Order · Removed in Odoo',
        tone: 'amber' as const,
        subtext: 'Original waitlist/pre-order · will be archived into order history',
        highlighted: false,
      }
    : isSourceCancelled
      ? {
          label: 'Actual Order · Active in Odoo',
          tone: 'emerald' as const,
          subtext: 'Live order · stays active and synced with Odoo',
          highlighted: true,
        }
      : {
          label: 'Order A · Currently Open',
          tone: 'sky' as const,
          subtext:
            outcome?.primaryOdooSide === 'target'
              ? 'Primary Odoo link stays synced after merge'
              : 'History preserved in merged order',
          highlighted: outcome?.primaryOdooSide === 'target',
        };

  const sourceRole = isSourceCancelled
    ? {
        label: 'Cancelled Pre-Order · Removed in Odoo',
        tone: 'amber' as const,
        subtext: 'Original pre-order · will be archived into order history',
        highlighted: false,
      }
    : isTargetCancelled || mode === 'replace'
      ? {
          label: 'Actual Replacement Order · Active in Odoo',
          tone: 'emerald' as const,
          subtext: 'Live replacement order · stays active and synced with Odoo',
          highlighted: true,
        }
      : {
          label: 'Order B · Merging With Order A',
          tone: 'sky' as const,
          subtext:
            outcome?.primaryOdooSide === 'source'
              ? 'Newer/confirmed Odoo link stays synced after merge'
              : 'Will be folded into the single surviving order',
          highlighted: outcome?.primaryOdooSide === 'source',
        };

  const canDismissPair = Boolean(
    onDismissDuplicate &&
      selectedSource &&
      !isTargetCancelled &&
      candidates.likely.some((c) => c.id === selectedSource.id)
  );

  const handleApprove = async () => {
    if (readOnly || !selectedSource || submitting) return;
    setSubmitting(true);
    try {
      await onApproveMerge(targetOrder.id, selectedSource.id, itemStrategy, resolvedDate);
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div
      data-testid="order-merge-modal"
      role="dialog"
      aria-modal="true"
      aria-label={
        isCancelledMatch
          ? 'Match cancelled pre-order with actual order'
          : 'Compare and merge orders'
      }
      className="fixed inset-0 z-[60] flex items-center justify-center bg-black/75 p-3 sm:p-5"
      onClick={onClose}
    >
      <div
        data-testid="order-merge-panel"
        onClick={(e) => e.stopPropagation()}
        className="flex max-h-[92vh] w-full max-w-5xl flex-col overflow-hidden rounded-lg border border-[#283340] bg-[#0F1419] shadow-2xl"
      >
        {/* Top Modal Header */}
        <div className="flex flex-wrap items-start justify-between gap-3 border-b border-[#283340] bg-[#161D24] px-4 py-3.5 sm:px-6">
          <div className="min-w-0">
            <div className="flex items-center gap-2">
              <GitMerge className="h-4 w-4 shrink-0 text-[#38BDF8]" aria-hidden="true" />
              <h2 className="font-['Plus_Jakarta_Sans'] text-base font-bold text-[#F0F6FC]">
                {isCancelledMatch
                  ? 'Match Cancelled Pre-Order with Actual Order'
                  : 'Compare & Merge Two Orders Into One'}
              </h2>
            </div>
            <p className="mt-1 text-xs text-[#8B949E]">
              Compare both orders side by side, choose the pickup date and items to keep, and
              review the final result below before approving.
            </p>
          </div>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close merge comparison"
            className="inline-flex h-9 w-9 shrink-0 items-center justify-center rounded-md border border-[#283340] bg-[#0F1419] text-[#8B949E] transition-colors hover:border-[#38BDF8] hover:text-[#F0F6FC]"
          >
            <X className="h-4 w-4" />
          </button>
        </div>

        {/* Scrollable Body */}
        <div className="flex-1 space-y-5 overflow-y-auto px-4 py-4 sm:px-6 sm:py-5">
          {/* Order Picker Bar (allows switching which order is compared on the right) */}
          <div className="flex flex-wrap items-center justify-between gap-2">
            <label
              htmlFor="merge-source-select"
              className="text-xs font-medium text-[#C9D1D9]"
            >
              {isTargetCancelled
                ? 'Comparing cancelled pre-order against:'
                : 'Comparing open order against:'}
            </label>
            <select
              id="merge-source-select"
              data-testid="merge-source-select"
              value={sourceId}
              onChange={(e) => setSourceId(e.target.value)}
              className="min-h-[38px] w-full max-w-xl rounded-md border border-[#283340] bg-[#161D24] px-3 py-1.5 text-xs text-[#F0F6FC] focus:border-[#38BDF8] focus:outline-none sm:w-auto sm:min-w-[340px]"
            >
              <option value="">Choose an order to compare...</option>
              {candidates.likely.length > 0 && (
                <optgroup
                  label={
                    isTargetCancelled
                      ? 'Matching Replacement Orders'
                      : 'Possible Duplicate Orders'
                  }
                >
                  {candidates.likely.map((cand) => {
                    const candDate = cand.slottedDate || cand.requestedDate;
                    return (
                      <option key={cand.id} value={cand.id}>
                        {cand.customerName}
                        {cand.odooQuotationName ? ` (${cand.odooQuotationName})` : ''} ·{' '}
                        {formatStatusLabel(cand.status)} ·{' '}
                        {candDate
                          ? `${cand.slottedDate ? '' : 'Req '}${formatShortCalendarDate(candDate)}`
                          : 'Unslotted'}{' '}
                        · {formatItemsLine(cand.items, items)}
                      </option>
                    );
                  })}
                </optgroup>
              )}
              {candidates.others.length > 0 && (
                <optgroup label="All Other Active Orders">
                  {candidates.others.map((cand) => {
                    const candDate = cand.slottedDate || cand.requestedDate;
                    return (
                      <option key={cand.id} value={cand.id}>
                        {cand.customerName}
                        {cand.odooQuotationName ? ` (${cand.odooQuotationName})` : ''} ·{' '}
                        {formatStatusLabel(cand.status)} ·{' '}
                        {candDate
                          ? `${cand.slottedDate ? '' : 'Req '}${formatShortCalendarDate(candDate)}`
                          : 'Unslotted'}{' '}
                        · {formatItemsLine(cand.items, items)}
                      </option>
                    );
                  })}
                </optgroup>
              )}
            </select>
          </div>

          {/* Side-by-Side Comparison Grid */}
          {selectedSource ? (
            <>
              <div className="grid grid-cols-1 items-stretch gap-4 md:grid-cols-2">
                <OrderComparisonColumn
                  order={targetOrder}
                  roleLabel={targetRole.label}
                  roleTone={targetRole.tone}
                  roleSubtext={targetRole.subtext}
                  isHighlighted={targetRole.highlighted}
                  dateDiffers={dateDiffers}
                  channelDiffers={channelDiffers}
                  itemsDiffer={itemsDiffer}
                  items={items}
                  channels={channels}
                  cardTestId="merge-target-card"
                  chatterTestId="merge-target-chatter"
                  openBtnTestId="merge-open-target-order-btn"
                  onOpenOrder={
                    onSelectOrder
                      ? () => {
                          onClose();
                          onSelectOrder(targetOrder.id);
                        }
                      : undefined
                  }
                />

                <OrderComparisonColumn
                  order={selectedSource}
                  roleLabel={sourceRole.label}
                  roleTone={sourceRole.tone}
                  roleSubtext={sourceRole.subtext}
                  isHighlighted={sourceRole.highlighted}
                  dateDiffers={dateDiffers}
                  channelDiffers={channelDiffers}
                  itemsDiffer={itemsDiffer}
                  items={items}
                  channels={channels}
                  cardTestId="merge-source-card"
                  detailsTestId="merge-source-details"
                  chatterTestId="merge-source-chatter"
                  openBtnTestId="merge-open-source-order-btn"
                  onOpenOrder={
                    onSelectOrder
                      ? () => {
                          onClose();
                          onSelectOrder(selectedSource.id);
                        }
                      : undefined
                  }
                />
              </div>

              {/* Decision Controls — Date Selection */}
              {dateDiffers && dateOpts?.targetDate && dateOpts?.sourceDate && (
                <div className="space-y-2 border-t border-[#283340] pt-4">
                  <div className="flex flex-wrap items-baseline justify-between gap-2">
                    <span className="text-xs font-semibold text-[#F0F6FC]">
                      1. Which pickup date should the merged order use?
                    </span>
                    <span className="text-[11px] text-[#8B949E]">
                      These orders have 2 different dates — only 1 stays on the calendar.
                    </span>
                  </div>
                  <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
                    <button
                      type="button"
                      data-testid="merge-date-target"
                      onClick={() => setKeepDate(dateOpts.targetDate!)}
                      className={`rounded-md border px-3.5 py-2.5 text-left transition-colors ${
                        resolvedDate === dateOpts.targetDate
                          ? 'border-[#38BDF8] bg-[#0EA5E9]/15 text-[#F0F6FC]'
                          : 'border-[#283340] bg-[#161D24] text-[#C9D1D9] hover:border-[#38BDF8]/50'
                      }`}
                    >
                      <div className="flex items-center justify-between gap-2 text-xs font-semibold">
                        <span>Keep {formatShortCalendarDate(dateOpts.targetDate)}</span>
                        <span className="text-[11px] font-medium text-[#38BDF8]">
                          {resolvedDate === dateOpts.targetDate
                            ? 'Selected'
                            : dateOpts.recommendedSide === 'target'
                              ? 'Recommended'
                              : ''}
                        </span>
                      </div>
                      <div className="mt-1 text-[11px] text-[#8B949E]">
                        {formatDateNoYear(dateOpts.targetDate)} · from {targetRef} (
                        {isTargetCancelled
                          ? 'Cancelled Pre-Order'
                          : dateOpts.targetDateKind === 'requested'
                            ? 'Requested'
                            : 'Scheduled'}
                        ) · removes {formatShortCalendarDate(dateOpts.sourceDate)}
                      </div>
                    </button>

                    <button
                      type="button"
                      data-testid="merge-date-source"
                      onClick={() => setKeepDate(dateOpts.sourceDate!)}
                      className={`rounded-md border px-3.5 py-2.5 text-left transition-colors ${
                        resolvedDate === dateOpts.sourceDate
                          ? 'border-[#38BDF8] bg-[#0EA5E9]/15 text-[#F0F6FC]'
                          : 'border-[#283340] bg-[#161D24] text-[#C9D1D9] hover:border-[#38BDF8]/50'
                      }`}
                    >
                      <div className="flex items-center justify-between gap-2 text-xs font-semibold">
                        <span>Move to {formatShortCalendarDate(dateOpts.sourceDate)}</span>
                        <span className="text-[11px] font-medium text-[#4ADE80]">
                          {dateOpts.recommendedSide === 'source'
                            ? resolvedDate === dateOpts.sourceDate
                              ? 'Selected · Recommended'
                              : 'Recommended'
                            : resolvedDate === dateOpts.sourceDate
                              ? 'Selected'
                              : ''}
                        </span>
                      </div>
                      <div className="mt-1 text-[11px] text-[#8B949E]">
                        {formatDateNoYear(dateOpts.sourceDate)} · from {sourceRef} (
                        {isTargetCancelled
                          ? 'Actual Order'
                          : dateOpts.sourceDateKind === 'requested'
                            ? 'Requested'
                            : 'Scheduled'}
                        ) · removes {formatShortCalendarDate(dateOpts.targetDate)}
                      </div>
                    </button>
                  </div>
                </div>
              )}

              {/* Decision Controls — Items Selection */}
              <div className="space-y-2 border-t border-[#283340] pt-4">
                <div className="flex flex-wrap items-baseline justify-between gap-2">
                  <span className="text-xs font-semibold text-[#F0F6FC]">
                    {dateDiffers ? '2. Which items should be kept?' : '1. Which items should be kept?'}
                  </span>
                  {!itemsDiffer && (
                    <span className="text-[11px] text-[#8B949E]">
                      Both orders currently list the same items.
                    </span>
                  )}
                </div>
                <div className="grid grid-cols-1 gap-2.5 md:grid-cols-3">
                  {(
                    [
                      {
                        id: 'keep_target' as const,
                        title: `Keep ${targetRef}’s Items`,
                        summary: formatItemsLine(
                          targetOrder.items.length > 0 ? targetOrder.items : selectedSource.items,
                          items
                        ),
                        recommended: outcome?.recommendedItemStrategy === 'keep_target',
                      },
                      {
                        id: 'use_source' as const,
                        title: `Use ${sourceRef}’s Items`,
                        summary: formatItemsLine(
                          selectedSource.items.length > 0 ? selectedSource.items : targetOrder.items,
                          items
                        ),
                        recommended: outcome?.recommendedItemStrategy === 'use_source',
                      },
                      {
                        id: 'combine' as const,
                        title: 'Add Both Together',
                        summary: formatItemsLine(combinedItemsPreview, items),
                        recommended: false,
                      },
                    ]
                  ).map((opt) => (
                    <button
                      key={opt.id}
                      type="button"
                      data-testid={`merge-strategy-${opt.id}`}
                      onClick={() => setItemStrategy(opt.id)}
                      className={`rounded-md border px-3 py-2.5 text-left transition-colors ${
                        itemStrategy === opt.id
                          ? 'border-[#38BDF8] bg-[#0EA5E9]/15 text-[#F0F6FC]'
                          : 'border-[#283340] bg-[#161D24] text-[#C9D1D9] hover:border-[#38BDF8]/50'
                      }`}
                    >
                      <div className="flex items-center justify-between gap-1.5 text-xs font-semibold">
                        <span className="truncate">{opt.title}</span>
                        {opt.recommended && (
                          <span className="shrink-0 text-[10px] font-medium text-[#4ADE80]">
                            Recommended
                          </span>
                        )}
                      </div>
                      <div className="mt-1 font-mono text-[11px] tabular-nums text-[#8B949E]">
                        {opt.summary}
                      </div>
                    </button>
                  ))}
                </div>
              </div>

              {/* Explicit "What Will Happen When You Approve" Preview */}
              {outcome && (
                <div
                  data-testid="merge-result-summary"
                  className="rounded-lg border border-[#38BDF8]/40 bg-[#0EA5E9]/10 p-4 text-xs"
                >
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <span className="font-['Plus_Jakarta_Sans'] text-xs font-bold text-[#F0F6FC]">
                      What Will Change When You Approve
                    </span>
                    <span className="text-[11px] text-[#7DD3FC]">
                      {resolvedDate ? (
                        <>
                          Result:{' '}
                          <strong className="font-semibold text-[#F0F6FC]">
                            1 order on {formatShortCalendarDate(resolvedDate)}
                          </strong>
                          {dateDiffers && dateOpts?.targetDate && dateOpts?.sourceDate
                            ? ` · duplicate on ${formatShortCalendarDate(
                                resolvedDate === dateOpts.targetDate
                                  ? dateOpts.sourceDate
                                  : dateOpts.targetDate
                              )} will be removed`
                            : ' · duplicate will be removed'}
                        </>
                      ) : (
                        <>
                          Result:{' '}
                          <strong className="font-semibold text-[#F0F6FC]">
                            1 unslotted order
                          </strong>{' '}
                          · duplicate will be removed
                        </>
                      )}
                    </span>
                  </div>

                  <div className="mt-3 grid grid-cols-1 gap-x-6 gap-y-2 border-t border-[#38BDF8]/20 pt-3 sm:grid-cols-2 lg:grid-cols-4">
                    <div>
                      <div className="text-[11px] text-[#7DD3FC]/80">Final Date</div>
                      <div className="mt-0.5 font-mono text-xs font-semibold tabular-nums text-[#F0F6FC]">
                        {outcome.nextSlottedDate
                          ? formatDateNoYear(outcome.nextSlottedDate)
                          : 'Waitlist (Unslotted)'}
                      </div>
                      {dateDiffers &&
                        dateOpts?.targetDate &&
                        outcome.nextSlottedDate &&
                        outcome.nextSlottedDate !== dateOpts.targetDate && (
                          <div className="mt-0.5 inline-flex items-center gap-1 text-[11px] text-[#FBBF24]">
                            <span>{formatShortCalendarDate(dateOpts.targetDate)}</span>
                            <ArrowRight className="h-3 w-3" aria-hidden="true" />
                            <span>{formatShortCalendarDate(outcome.nextSlottedDate)}</span>
                          </div>
                        )}
                    </div>

                    <div>
                      <div className="text-[11px] text-[#7DD3FC]/80">Final Status &amp; Channel</div>
                      <div className="mt-0.5 text-xs font-semibold text-[#F0F6FC]">
                        <span className={statusColorClass(outcome.nextStatus)}>
                          {formatStatusLabel(outcome.nextStatus)}
                        </span>
                        <span className="text-[#8B949E]"> · </span>
                        <span>{finalChannelDisplay}</span>
                      </div>
                      {channelDiffers && finalChannelDisplay !== targetChannelDisplay && (
                        <div className="mt-0.5 text-[11px] text-[#FBBF24]">
                          Channel updates from {targetChannelDisplay}
                        </div>
                      )}
                    </div>

                    <div>
                      <div className="text-[11px] text-[#7DD3FC]/80">Final Items</div>
                      <div className="mt-0.5 font-mono text-xs font-semibold tabular-nums text-[#F0F6FC]">
                        {formatItemsLine(outcome.mergedItems, items)}
                      </div>
                    </div>

                    <div>
                      <div className="text-[11px] text-[#7DD3FC]/80">Odoo Sync &amp; History</div>
                      <div className="mt-0.5 font-mono text-xs text-[#F0F6FC]">
                        {outcome.archivedOdooRef && outcome.primaryOdooRef ? (
                          <>
                            <span className="text-[#8B949E]">{outcome.archivedOdooRef}</span>
                            <span className="mx-1 text-[#7DD3FC]">→</span>
                            <span className="font-semibold text-[#4ADE80]">
                              {outcome.primaryOdooRef}
                            </span>
                          </>
                        ) : outcome.primaryOdooRef ? (
                          <span className="font-semibold text-[#4ADE80]">
                            {outcome.primaryOdooRef}
                          </span>
                        ) : (
                          'Local order'
                        )}
                      </div>
                      <div className="mt-0.5 text-[11px] text-[#BAE6FD]/80">
                        Notes &amp; {outcome.combinedChatterCount} chatter kept · old ref won&apos;t
                        re-import
                      </div>
                    </div>
                  </div>
                </div>
              )}
            </>
          ) : (
            <div className="rounded-lg border border-[#283340] bg-[#161D24] px-4 py-8 text-center text-xs text-[#8B949E]">
              Select an order from the dropdown above to compare both orders side by side.
            </div>
          )}
        </div>

        {/* Sticky Modal Footer */}
        <div className="flex flex-wrap items-center justify-between gap-3 border-t border-[#283340] bg-[#161D24] px-4 py-3 sm:px-6">
          <div className="flex flex-wrap items-center gap-2.5">
            <button
              type="button"
              onClick={onClose}
              className="inline-flex min-h-[38px] items-center rounded-md border border-[#283340] bg-[#0F1419] px-3.5 py-2 text-xs font-medium text-[#C9D1D9] transition-colors hover:border-[#8B949E] hover:text-[#F0F6FC]"
            >
              Cancel
            </button>
            {canDismissPair && selectedSource && (
              <button
                type="button"
                data-testid="panel-dismiss-duplicate-btn"
                disabled={readOnly || dismissing || submitting}
                onClick={async () => {
                  if (!onDismissDuplicate) return;
                  setDismissing(true);
                  try {
                    await onDismissDuplicate(targetOrder.id, selectedSource.id);
                    onClose();
                  } finally {
                    setDismissing(false);
                  }
                }}
                className="inline-flex min-h-[38px] items-center rounded-md border border-[#283340] px-3.5 py-2 text-xs font-medium text-[#C9D1D9] transition-colors hover:border-[#8B949E] hover:text-[#F0F6FC] disabled:opacity-45"
              >
                {dismissing ? 'Dismissing...' : 'Not a Duplicate'}
              </button>
            )}
          </div>

          <button
            type="button"
            disabled={readOnly || !selectedSource || submitting}
            data-testid="confirm-merge-orders-btn"
            onClick={() => void handleApprove()}
            className="inline-flex min-h-[40px] items-center justify-center gap-1.5 whitespace-nowrap rounded-md bg-[#0EA5E9] px-4 py-2 text-xs font-semibold text-[#0B1117] transition-colors hover:bg-[#38BDF8] disabled:cursor-not-allowed disabled:opacity-45"
          >
            <Check className="h-3.5 w-3.5" aria-hidden="true" />
            {submitting
              ? 'Merging Orders...'
              : resolvedDate
                ? `${isCancelledMatch ? 'Approve Match' : 'Approve Merge'} — 1 Order on ${formatShortCalendarDate(resolvedDate)} (Undoable)`
                : `${isCancelledMatch ? 'Approve Match' : 'Approve Merge'} — 1 Order (Undoable)`}
          </button>
        </div>
      </div>
    </div>
  );
}
