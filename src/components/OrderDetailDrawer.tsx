import {
  Calendar,
  CalendarCheck,
  Check,
  ChevronDown,
  ChevronUp,
  ExternalLink,
  Eye,
  GitMerge,
  Lock,
  Mail,
  MessageSquare,
  Plus,
  Sparkles,
  Trash2,
  Unlock,
  X,
} from 'lucide-react';
import { useEffect, useMemo, useRef, useState } from 'react';
import { CustomerAutocompleteInput } from './CustomerAutocompleteInput';
import { formatQty } from '../shared/generators';
import {
  channelHasScheduleRestriction,
  evaluateCandidateSlotDates,
  type CandidateSlotDate,
  type CandidateSlotFit,
} from '../shared/supplyEngine';
import {
  ISO_WEEKDAY_LABELS,
  formatAgingBadge,
  formatShortCalendarDate,
  getAgingHoldHours,
  getIsoWeekday,
} from '../shared/timezone';
import type {
  CalendarDayProjection,
  OrderItemLine,
  OrderMergeItemStrategy,
  OrderRecord,
  OrderStatus,
  PickupChannel,
  TrackedItem,
} from '../shared/types';

export type OrderSavePatch = Partial<{
  customerName: string;
  customerEmail: string | null;
  customerPhone: string | null;
  pickupChannelId: number | null;
  status: OrderStatus;
  requestedDate: string | null;
  slottedDate: string | null;
  isLocked: boolean;
  notes: string | null;
  items: OrderItemLine[];
  clearOdooUpdatedFlag: boolean;
}>;

interface OrderDetailDrawerProps {
  order: OrderRecord | null;
  allOrders?: OrderRecord[];
  items: TrackedItem[];
  channels: PickupChannel[];
  days: CalendarDayProjection[];
  today: string;
  weeks: number;
  holdThresholdHours: number;
  odooConfigured?: boolean;
  onClose: () => void;
  onSelectOrder?: (orderId: number) => void;
  onSaveOrder: (orderId: number, patch: OrderSavePatch) => Promise<void>;
  onQuickSlotOrder: (
    orderId: number,
    date: string,
    draftPatch?: OrderSavePatch
  ) => Promise<void>;
  onExtendWeeks: () => void;
  onPreApprove: (orderId: number) => Promise<void>;
  onReleaseHold: (orderId: number) => Promise<void>;
  onIgnore: (orderId: number) => Promise<void>;
  onRestoreIgnored: (orderId: number) => Promise<void>;
  onReconcile: (orderId: number, action: 'confirm' | 'keep') => Promise<void>;
  onMergeOrders?: (
    targetOrderId: number,
    sourceOrderId: number,
    itemStrategy: OrderMergeItemStrategy,
    keepDate?: string | null
  ) => Promise<void>;
  onDismissDuplicate?: (orderId: number, otherOrderId: number) => Promise<void>;
  onDeleteOrder: (orderId: number) => Promise<void>;
  onSkipStandingOccurrence: (standingId: number, occurrenceDate: string) => Promise<void>;
}

const STATUS_STEPS: Array<{ value: OrderStatus; label: string }> = [
  { value: 'waitlist', label: 'Waitlist' },
  { value: 'slotted', label: 'Slotted' },
  { value: 'pre_approved', label: 'Pre-Approved' },
  { value: 'confirmed', label: 'Confirmed' },
];

function fitStyle(fit: CandidateSlotFit): { label: string; text: string; rowHover: string } {
  switch (fit) {
    case 'fits':
      return {
        label: 'Fits',
        text: 'text-[#4ADE80]',
        rowHover: 'hover:bg-[#16A34A]/10',
      };
    case 'buffer':
      return {
        label: 'Buffer',
        text: 'text-[#FBBF24]',
        rowHover: 'hover:bg-[#D97706]/10',
      };
    case 'deficit':
      return {
        label: 'Short',
        text: 'text-[#F87171]',
        rowHover: 'hover:bg-[#DC2626]/10',
      };
    default:
      return {
        label: 'Select',
        text: 'text-[#38BDF8]',
        rowHover: 'hover:bg-[#1E2730]',
      };
  }
}

function formatCandidateDateLabel(dateYmd: string, isoWeekday: number, isToday: boolean): string {
  const base = `${ISO_WEEKDAY_LABELS[isoWeekday]}, ${formatShortCalendarDate(dateYmd)}`;
  return isToday ? `${base} (Today)` : base;
}

function isStandingRecurringOrder(order: OrderRecord): boolean {
  return order.source === 'standing' || order.standingOrderId !== null;
}

function scoreDuplicateOrder(target: OrderRecord, candidate: OrderRecord): number {
  if (isStandingRecurringOrder(target) || isStandingRecurringOrder(candidate)) {
    return 0;
  }
  let score = 0;

  if (
    target.odooPartnerId &&
    candidate.odooPartnerId &&
    target.odooPartnerId === candidate.odooPartnerId
  ) {
    score += 100;
  }

  const nameA = target.customerName.trim().toLowerCase().replace(/\s+/g, ' ');
  const nameB = candidate.customerName.trim().toLowerCase().replace(/\s+/g, ' ');
  if (nameA && nameB) {
    if (nameA === nameB) {
      score += 90;
    } else if (
      nameA.length >= 4 &&
      nameB.length >= 4 &&
      (nameA.includes(nameB) || nameB.includes(nameA))
    ) {
      score += 40;
    } else {
      const partsA = nameA.split(' ');
      const partsB = nameB.split(' ');
      // Only treat first-name-only match as a likely duplicate when one side has no last name
      if (
        (partsA.length === 1 || partsB.length === 1) &&
        partsA[0].length >= 3 &&
        partsA[0] === partsB[0]
      ) {
        score += 25;
      }
    }
  }

  const emailA = (target.customerEmail || '').trim().toLowerCase();
  const emailB = (candidate.customerEmail || '').trim().toLowerCase();
  if (emailA && emailB && emailA === emailB) {
    score += 85;
  }

  const phoneA = (target.customerPhone || '').replace(/\D/g, '');
  const phoneB = (candidate.customerPhone || '').replace(/\D/g, '');
  if (phoneA.length >= 7 && phoneB.length >= 7 && phoneA === phoneB) {
    score += 80;
  }

  return score;
}

function DuplicateOrderDetailsBody({
  candidate,
  items,
  channels,
  chatterTestId = 'duplicate-compare-chatter',
}: {
  candidate: OrderRecord;
  items: TrackedItem[];
  channels: PickupChannel[];
  chatterTestId?: string;
}) {
  const channelName = candidate.pickupChannelId
    ? channels.find((c) => c.id === candidate.pickupChannelId)?.name ?? null
    : null;
  const arrivalLabel = candidate.odooCreatedAtLocal || candidate.createdAt.slice(0, 16).replace('T', ' ');
  const trimmedNotes = (candidate.notes || '').trim();
  const trimmedRawNotes = (candidate.odooRawNotes || '').trim();
  const showSeparateRawNotes = Boolean(trimmedRawNotes && trimmedRawNotes !== trimmedNotes);

  return (
    <div className="space-y-3 text-xs text-[#C9D1D9]">
      {/* Metadata summary grid */}
      <div className="grid grid-cols-1 gap-1.5 rounded-md border border-[#283340] bg-[#0B1117] p-2.5 text-[11px] sm:grid-cols-2">
        <div>
          <span className="text-[#8B949E]">Status: </span>
          <span className="font-semibold capitalize text-[#F0F6FC]">
            {candidate.status.replace('_', ' ')}
          </span>
        </div>
        <div>
          <span className="text-[#8B949E]">Scheduled: </span>
          <span className="font-mono text-[#F0F6FC]">
            {candidate.slottedDate ? formatShortCalendarDate(candidate.slottedDate) : 'Unslotted'}
          </span>
        </div>
        <div>
          <span className="text-[#8B949E]">Arrived: </span>
          <span className="font-mono text-[#C9D1D9]">{arrivalLabel}</span>
        </div>
        <div>
          <span className="text-[#8B949E]">Channel: </span>
          <span className="text-[#C9D1D9]">
            {channelName || candidate.freeTextPickup || 'Unassigned'}
          </span>
        </div>
        {candidate.requestedDate && (
          <div>
            <span className="text-[#8B949E]">Requested Date: </span>
            <span className="font-mono text-[#FBBF24]">
              {formatShortCalendarDate(candidate.requestedDate)}
            </span>
          </div>
        )}
        {(candidate.customerPhone || candidate.customerEmail) && (
          <div className="sm:col-span-2">
            <span className="text-[#8B949E]">Contact: </span>
            <span className="text-[#C9D1D9]">
              {[candidate.customerPhone, candidate.customerEmail].filter(Boolean).join(' · ')}
            </span>
          </div>
        )}
      </div>

      {/* Tracked Items + Raw Odoo Lines */}
      <div>
        <div className="text-[11px] font-semibold text-[#F0F6FC]">Items</div>
        <div className="mt-1 font-mono text-[11px] text-[#C9D1D9]">
          {candidate.items.length === 0
            ? 'No tracked items assigned'
            : candidate.items
                .map((l) => {
                  const meta = items.find((i) => i.id === l.trackedItemId);
                  return `${formatQty(l.quantity)} ${meta ? `${meta.unitLabel} ${meta.name}` : `#${l.trackedItemId}`}`;
                })
                .join(', ')}
        </div>
        {candidate.odooRawLines.length > 0 && (
          <ul className="mt-1.5 space-y-0.5 text-[11px] text-[#8B949E]">
            {candidate.odooRawLines.map((rawLine, idx) => (
              <li key={idx} className="font-mono">
                • {rawLine}
              </li>
            ))}
          </ul>
        )}
      </div>

      {/* Notes & Odoo Raw Notes */}
      {(trimmedNotes || showSeparateRawNotes) && (
        <div>
          <div className="text-[11px] font-semibold text-[#F0F6FC]">Notes</div>
          {trimmedNotes && (
            <pre className="mt-1 whitespace-pre-wrap rounded border border-[#283340] bg-[#0B1117] p-2 font-sans text-[11px] leading-relaxed text-[#C9D1D9]">
              {trimmedNotes}
            </pre>
          )}
          {showSeparateRawNotes && (
            <pre className="mt-1.5 whitespace-pre-wrap rounded border border-[#283340] bg-[#0B1117] p-2 font-sans text-[11px] leading-relaxed text-[#8B949E]">
              {trimmedRawNotes}
            </pre>
          )}
        </div>
      )}

      {/* Full Odoo Chatter for comparison */}
      <div data-testid={chatterTestId}>
        <div className="flex items-center justify-between">
          <span className="text-[11px] font-semibold text-[#F0F6FC]">
            Odoo Chatter ({candidate.chatter.length})
          </span>
          {candidate.chatter.length > 0 && (
            <span className="text-[10px] text-[#8B949E]">Comments &amp; Emails</span>
          )}
        </div>
        {candidate.chatter.length === 0 ? (
          <p className="mt-1 text-[11px] text-[#8B949E]">
            No chatter messages on this order.
          </p>
        ) : (
          <div className="mt-1.5 max-h-56 space-y-2 overflow-y-auto pr-0.5">
            {candidate.chatter.map((msg) => (
              <div
                key={msg.id}
                data-testid={`duplicate-chatter-msg-${msg.odooMessageId}`}
                className="rounded border border-[#283340] bg-[#0B1117] p-2.5"
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
                <p className="mt-1.5 whitespace-pre-wrap text-[11px] leading-relaxed text-[#C9D1D9]">
                  {msg.bodyText}
                </p>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

export function OrderDetailDrawer({
  order,
  allOrders = [],
  items,
  channels,
  days,
  today,
  weeks,
  holdThresholdHours,
  odooConfigured = false,
  onClose,
  onSelectOrder,
  onSaveOrder,
  onQuickSlotOrder,
  onExtendWeeks,
  onPreApprove,
  onReleaseHold,
  onIgnore,
  onRestoreIgnored,
  onReconcile,
  onMergeOrders,
  onDismissDuplicate,
  onDeleteOrder,
  onSkipStandingOccurrence,
}: OrderDetailDrawerProps) {
  const [customerName, setCustomerName] = useState('');
  const [customerEmail, setCustomerEmail] = useState('');
  const [customerPhone, setCustomerPhone] = useState('');
  const [pickupChannelId, setPickupChannelId] = useState<string>('');
  const [requestedDate, setRequestedDate] = useState<string>('');
  const [slottedDate, setSlottedDate] = useState<string>('');
  const [status, setStatus] = useState<OrderStatus>('waitlist');
  const [isLocked, setIsLocked] = useState(false);
  const [notes, setNotes] = useState('');
  const [orderItems, setOrderItems] = useState<
    Array<{ rowKey: string; trackedItemId: number; qtyText: string }>
  >([]);
  const [saving, setSaving] = useState(false);
  const [slottingTarget, setSlottingTarget] = useState<string | null>(null);
  const [onlyOpenDates, setOnlyOpenDates] = useState(false);
  const [showOffChannel, setShowOffChannel] = useState(false);

  // Merge orders & duplicate inspection state
  const [mergePanelOpen, setMergePanelOpen] = useState(false);
  const [mergeSourceId, setMergeSourceId] = useState<string>('');
  const [mergeStrategy, setMergeStrategy] = useState<OrderMergeItemStrategy>('keep_target');
  const [mergeKeepDate, setMergeKeepDate] = useState<string>('');
  const [merging, setMerging] = useState(false);
  const [dismissingDuplicateId, setDismissingDuplicateId] = useState<number | null>(null);
  const [localDismissedIds, setLocalDismissedIds] = useState<number[]>([]);
  const [inspectingDuplicateId, setInspectingDuplicateId] = useState<number | null>(null);
  const [showAllDuplicates, setShowAllDuplicates] = useState(false);
  const [showMergeSourceDetails, setShowMergeSourceDetails] = useState(true);
  const scrollContainerRef = useRef<HTMLDivElement | null>(null);
  const rowKeyCounter = useRef(0);

  useEffect(() => {
    if (!order) return;
    setCustomerName(order.customerName);
    setCustomerEmail(order.customerEmail ?? '');
    setCustomerPhone(order.customerPhone ?? '');
    setPickupChannelId(order.pickupChannelId ? String(order.pickupChannelId) : '');
    setRequestedDate(order.requestedDate ?? '');
    setSlottedDate(order.slottedDate ?? '');
    setStatus(order.status);
    setIsLocked(order.isLocked);
    setNotes(order.notes ?? '');
    setOrderItems(
      order.items.map((l, idx) => ({
        rowKey: `init-${order.id}-${idx}-${l.trackedItemId}`,
        trackedItemId: l.trackedItemId,
        qtyText: formatQty(l.quantity),
      }))
    );
    setOnlyOpenDates(false);
    setShowOffChannel(false);
    setSlottingTarget(null);
    setMergePanelOpen(false);
    setMergeSourceId('');
    setMergeStrategy('keep_target');
    setMergeKeepDate(order.slottedDate ?? '');
    setMerging(false);
    setDismissingDuplicateId(null);
    setLocalDismissedIds([]);
    setInspectingDuplicateId(null);
    setShowAllDuplicates(false);
    setShowMergeSourceDetails(true);
  }, [order]);

  const mergeCandidates = useMemo(() => {
    if (!order || isStandingRecurringOrder(order)) {
      return { likely: [] as OrderRecord[], others: [] as OrderRecord[] };
    }
    const dismissedSet = new Set<number>([
      ...(order.dismissedDuplicateOrderIds ?? []),
      ...localDismissedIds,
    ]);
    const eligible = allOrders.filter(
      (o) => o.id !== order.id && o.status !== 'ignored' && !isStandingRecurringOrder(o)
    );
    const likelyScored: Array<{ cand: OrderRecord; score: number }> = [];
    const others: OrderRecord[] = [];
    for (const cand of eligible) {
      const isDismissed =
        dismissedSet.has(cand.id) || (cand.dismissedDuplicateOrderIds ?? []).includes(order.id);
      const score = isDismissed ? 0 : scoreDuplicateOrder(order, cand);
      if (score > 0) {
        likelyScored.push({ cand, score });
      } else {
        others.push(cand);
      }
    }
    likelyScored.sort((a, b) => b.score - a.score || b.cand.id - a.cand.id);
    return { likely: likelyScored.map((entry) => entry.cand), others };
  }, [allOrders, order, localDismissedIds]);

  const selectedMergeSource = useMemo(() => {
    const id = Number(mergeSourceId);
    if (!id) return null;
    return allOrders.find((o) => o.id === id) ?? null;
  }, [allOrders, mergeSourceId]);

  useEffect(() => {
    if (!order) return;
    setMergeKeepDate(order.slottedDate || selectedMergeSource?.slottedDate || '');
  }, [order, selectedMergeSource?.id, selectedMergeSource?.slottedDate]);

  useEffect(() => {
    if (mergePanelOpen && scrollContainerRef.current) {
      if (typeof scrollContainerRef.current.scrollTo === 'function') {
        scrollContainerRef.current.scrollTo({ top: 0, behavior: 'smooth' });
      } else {
        scrollContainerRef.current.scrollTop = 0;
      }
    }
  }, [mergePanelOpen]);

  const parsedChannelId = pickupChannelId ? Number(pickupChannelId) : null;
  const selectedChannel = useMemo(
    () => (parsedChannelId ? channels.find((c) => c.id === parsedChannelId) ?? null : null),
    [channels, parsedChannelId]
  );
  const channelRestrictsWeekdays = Boolean(
    selectedChannel && channelHasScheduleRestriction(selectedChannel)
  );

  const parsedOrderItems = useMemo<OrderItemLine[]>(
    () =>
      orderItems
        .map((l) => ({ trackedItemId: l.trackedItemId, quantity: Number(l.qtyText) }))
        .filter((l) => Number.isFinite(l.quantity) && l.quantity > 0),
    [orderItems]
  );

  const candidateDates = useMemo<CandidateSlotDate[]>(() => {
    if (!order) return [];
    return evaluateCandidateSlotDates({
      order,
      draftItems: parsedOrderItems,
      draftPickupChannelId: parsedChannelId,
      draftRequestedDate: requestedDate || null,
      days,
      items,
      channels,
      today,
    });
  }, [order, parsedOrderItems, parsedChannelId, requestedDate, days, items, channels, today]);

  const firstAvailable = useMemo(
    () => candidateDates.find((c) => c.isFirstAvailable) ?? null,
    [candidateDates]
  );

  const requestedDateCandidate = useMemo(
    () => (requestedDate ? candidateDates.find((c) => c.date === requestedDate) ?? null : null),
    [candidateDates, requestedDate]
  );

  const visibleCandidates = useMemo(() => {
    return candidateDates.filter((c) => {
      if (!showOffChannel && !c.channelAllowed) return false;
      if (onlyOpenDates && c.fit !== 'fits') return false;
      return true;
    });
  }, [candidateDates, showOffChannel, onlyOpenDates]);

  if (!order) return null;

  const agingHours =
    order.status === 'pre_approved' ? getAgingHoldHours(order.preApprovedAt) : null;
  const isHoldOverThreshold = agingHours !== null && agingHours >= holdThresholdHours;

  const validDraftItems = parsedOrderItems;
  const itemsSummary =
    validDraftItems.length === 0
      ? 'No items assigned yet'
      : validDraftItems
          .map((l) => {
            const meta = items.find((i) => i.id === l.trackedItemId);
            return `${formatQty(l.quantity)} ${meta ? `${meta.unitLabel} ${meta.name}` : `#${l.trackedItemId}`}`;
          })
          .join(', ');

  const addItemLine = () => {
    const unused = items.find((i) => !orderItems.some((l) => l.trackedItemId === i.id)) ?? items[0];
    if (!unused) return;
    rowKeyCounter.current += 1;
    setOrderItems([
      ...orderItems,
      { rowKey: `new-${rowKeyCounter.current}`, trackedItemId: unused.id, qtyText: '1' },
    ]);
  };

  const buildDraftPatch = (): OrderSavePatch => ({
    customerName: customerName.trim() || order.customerName,
    customerEmail: customerEmail.trim() || null,
    customerPhone: customerPhone.trim() || null,
    pickupChannelId: parsedChannelId,
    requestedDate: requestedDate || null,
    isLocked,
    notes: notes.trim() || null,
    items: validDraftItems,
    clearOdooUpdatedFlag: true,
  });

  const handleSave = async () => {
    setSaving(true);
    try {
      await onSaveOrder(order.id, {
        ...buildDraftPatch(),
        status,
        slottedDate: slottedDate || null,
      });
    } finally {
      setSaving(false);
    }
  };

  const hasDraftEdits = (): boolean => {
    if ((customerName.trim() || order.customerName) !== order.customerName) return true;
    if ((customerEmail.trim() || null) !== order.customerEmail) return true;
    if ((customerPhone.trim() || null) !== order.customerPhone) return true;
    if (parsedChannelId !== order.pickupChannelId) return true;
    if ((requestedDate || null) !== order.requestedDate) return true;
    if (isLocked !== order.isLocked) return true;
    if ((notes.trim() || null) !== order.notes) return true;
    if (validDraftItems.length !== order.items.length) return true;
    return validDraftItems.some(
      (line, idx) =>
        line.trackedItemId !== order.items[idx]?.trackedItemId ||
        line.quantity !== order.items[idx]?.quantity
    );
  };

  const handleQuickSlot = async (targetDate: string) => {
    if (isLocked) return;
    setSlottingTarget(targetDate);
    try {
      await onQuickSlotOrder(order.id, targetDate, hasDraftEdits() ? buildDraftPatch() : undefined);
    } finally {
      setSlottingTarget(null);
    }
  };

  const resolvedMergeDate =
    mergeKeepDate || order.slottedDate || selectedMergeSource?.slottedDate || null;
  const hasDifferentMergeDates = Boolean(
    selectedMergeSource &&
      order.slottedDate &&
      selectedMergeSource.slottedDate &&
      order.slottedDate !== selectedMergeSource.slottedDate
  );

  const handleConfirmMerge = async () => {
    if (!onMergeOrders || !selectedMergeSource || merging) return;
    setMerging(true);
    try {
      await onMergeOrders(order.id, selectedMergeSource.id, mergeStrategy, resolvedMergeDate);
      setMergePanelOpen(false);
      setMergeSourceId('');
    } finally {
      setMerging(false);
    }
  };

  return (
    <div
      className="fixed inset-0 z-50 flex justify-end bg-black/60"
      data-testid="order-detail-drawer"
      role="dialog"
      aria-modal="true"
      aria-label={`Order details for ${order.customerName}`}
    >
      <div className="flex h-full w-full max-w-xl flex-col border-l border-[#283340] bg-[#161D24] text-[#E6EDF3]">
        <div className="flex items-start justify-between border-b border-[#283340] px-4 py-3.5 sm:px-6 sm:py-4">
          <div className="min-w-0 flex-1 pr-3">
            <div className="flex flex-wrap items-center gap-x-2 gap-y-0.5 text-xs text-[#8B949E]">
              <span className="capitalize">{order.source}</span>
              {order.odooQuotationName && (
                <>
                  <span aria-hidden="true">·</span>
                  <span className="font-mono text-[#C9D1D9]">{order.odooQuotationName}</span>
                </>
              )}
              {order.mergedOdooNames && order.mergedOdooNames.length > 0 && (
                <>
                  <span aria-hidden="true">·</span>
                  <span
                    data-testid="order-merged-refs"
                    className="font-mono text-[#38BDF8]"
                    title="Merged Odoo quotations/orders (suppressed from future duplicate syncs)"
                  >
                    Merged: {order.mergedOdooNames.join(', ')}
                  </span>
                </>
              )}
              {order.odooCreatedAtLocal && (
                <>
                  <span aria-hidden="true">·</span>
                  <span className="font-mono">{order.odooCreatedAtLocal}</span>
                </>
              )}
            </div>
            <h2 className="mt-1 truncate font-['Plus_Jakarta_Sans'] text-lg font-bold text-[#F0F6FC]">
              {order.customerName}
            </h2>
            <p className="mt-0.5 truncate font-mono text-xs tabular-nums text-[#C9D1D9]">
              {itemsSummary}
            </p>
            {requestedDate && (
              <div
                data-testid="order-header-requested-pickup"
                className="mt-1.5 inline-flex items-center gap-1.5 rounded border border-[#D97706]/50 bg-[#D97706]/15 px-2 py-0.5 text-[11px] font-semibold text-[#FBBF24]"
              >
                <Calendar className="h-3 w-3 shrink-0" aria-hidden="true" />
                <span>
                  Requested Pickup: {ISO_WEEKDAY_LABELS[getIsoWeekday(requestedDate)]},{' '}
                  {formatShortCalendarDate(requestedDate)}
                </span>
              </div>
            )}
          </div>
          <button
            type="button"
            data-testid="close-order-drawer-btn"
            onClick={onClose}
            className="flex h-9 w-9 shrink-0 items-center justify-center rounded-md text-[#8B949E] hover:bg-[#1E2730] hover:text-[#F0F6FC]"
            aria-label="Close order drawer"
          >
            <X className="h-5 w-5" />
          </button>
        </div>

        <div
          ref={scrollContainerRef}
          className="flex-1 space-y-5 overflow-y-auto px-4 py-4 sm:space-y-6 sm:px-6 sm:py-5"
        >
          {/* Odoo Reconciliation Warning (Always 1-click manual confirmation) */}
          {order.odooMissingFlagged && (
            <div
              data-testid="order-reconcile-box"
              className="rounded-md border border-[#D97706]/60 bg-[#D97706]/10 p-4 text-sm"
            >
              <p className="font-semibold text-[#FBBF24]">
                Odoo Draft Quotation Removed — Confirm Paid Order?
              </p>
              <p className="mt-1 text-xs text-[#E6EDF3]">
                {order.odooSuggestedConfirmed
                  ? `Suggested confirmed Odoo order: ${order.odooSuggestedConfirmed.odooOrderName} (${order.odooSuggestedConfirmed.partnerName}, ${order.odooSuggestedConfirmed.dateOrderLocal}).`
                  : 'This draft quotation is no longer in Odoo. Confirm if payment was completed on Eat From Farms.'}
              </p>
              <div className="mt-3 flex flex-wrap items-center gap-2">
                <button
                  type="button"
                  data-testid="drawer-reconcile-confirm-btn"
                  onClick={() => void onReconcile(order.id, 'confirm')}
                  className="inline-flex min-h-[36px] items-center gap-1.5 rounded-md bg-[#16A34A] px-3 py-1.5 text-xs font-semibold text-white hover:bg-[#22C55E]"
                >
                  <Check className="h-3.5 w-3.5" />
                  Confirm Order
                </button>
                <button
                  type="button"
                  data-testid="drawer-reconcile-keep-btn"
                  onClick={() => void onReconcile(order.id, 'keep')}
                  className="min-h-[36px] rounded-md border border-[#283340] bg-[#1E2730] px-3 py-1.5 text-xs font-medium text-[#C9D1D9] hover:border-[#38BDF8]"
                >
                  Keep Active &amp; Clear Flag
                </button>
              </div>
            </div>
          )}

          {/* Odoo Updated After Slotting Notice */}
          {order.odooUpdatedAfterSlot && (
            <div
              data-testid="order-odoo-updated-notice"
              className="rounded-md border border-[#38BDF8]/50 bg-[#38BDF8]/10 px-4 py-3 text-xs text-[#BAE6FD]"
            >
              Quantities or details were updated in Odoo after this order was slotted. Review items below and save to acknowledge.
            </div>
          )}

          {/* Smart Possible Duplicate Banner + Merge Panel */}
          {onMergeOrders &&
            order.status !== 'ignored' &&
            (mergeCandidates.likely.length > 0 || mergeCandidates.others.length > 0) && (
              <div className="space-y-2.5">
                {mergeCandidates.likely.length > 0 && !mergePanelOpen && (
                  <div
                    data-testid="possible-duplicate-banner"
                    className="space-y-2.5 rounded-md border border-[#38BDF8]/50 bg-[#0EA5E9]/10 px-3.5 py-2.5 text-xs"
                  >
                    <div className="flex flex-wrap items-center justify-between gap-2">
                      <p className="font-semibold text-[#38BDF8]">
                        Possible Duplicate Order Found ({mergeCandidates.likely.length})
                      </p>
                      <span className="text-[11px] text-[#8B949E]">
                        Click an order to inspect full details &amp; chatter
                      </span>
                    </div>

                    <div className="space-y-2">
                      {(showAllDuplicates
                        ? mergeCandidates.likely
                        : mergeCandidates.likely.slice(0, 1)
                      ).map((cand, idx) => {
                        const isInspecting = inspectingDuplicateId === cand.id;
                        return (
                          <div
                            key={cand.id}
                            className="rounded-md border border-[#283340] bg-[#11171D] p-2.5"
                          >
                            <div className="flex flex-wrap items-center justify-between gap-2">
                              <button
                                type="button"
                                data-testid={
                                  idx === 0
                                    ? 'inspect-duplicate-btn'
                                    : `inspect-duplicate-btn-${cand.id}`
                                }
                                data-candidate-id={cand.id}
                                onClick={() =>
                                  setInspectingDuplicateId((prev) =>
                                    prev === cand.id ? null : cand.id
                                  )
                                }
                                className="group flex min-w-0 flex-1 items-center gap-2 text-left"
                              >
                                <Eye
                                  className="h-3.5 w-3.5 shrink-0 text-[#38BDF8]"
                                  aria-hidden="true"
                                />
                                <div className="min-w-0 flex-1">
                                  <div className="truncate font-semibold text-[#F0F6FC] group-hover:text-[#38BDF8] group-hover:underline">
                                    {cand.customerName}
                                    {cand.odooQuotationName ? ` · ${cand.odooQuotationName}` : ''}
                                  </div>
                                  <div className="mt-0.5 flex flex-wrap items-center gap-x-1.5 text-[11px] text-[#8B949E]">
                                    <span className="capitalize">{cand.status.replace('_', ' ')}</span>
                                    <span>·</span>
                                    <span>
                                      {cand.slottedDate
                                        ? formatShortCalendarDate(cand.slottedDate)
                                        : 'Unslotted'}
                                    </span>
                                    {cand.chatter.length > 0 && (
                                      <>
                                        <span>·</span>
                                        <span className="text-[#38BDF8]">
                                          {cand.chatter.length} chatter
                                        </span>
                                      </>
                                    )}
                                    <span>·</span>
                                    <span className="text-[#38BDF8]">
                                      {isInspecting ? 'Hide Details' : 'Inspect Details'}
                                    </span>
                                  </div>
                                </div>
                              </button>

                              <div className="flex shrink-0 flex-wrap items-center gap-1.5">
                                {onDismissDuplicate && (
                                  <button
                                    type="button"
                                    data-testid={
                                      idx === 0
                                        ? 'dismiss-duplicate-btn'
                                        : `dismiss-duplicate-btn-${cand.id}`
                                    }
                                    disabled={dismissingDuplicateId === cand.id}
                                    onClick={async () => {
                                      setDismissingDuplicateId(cand.id);
                                      setLocalDismissedIds((prev) =>
                                        prev.includes(cand.id) ? prev : [...prev, cand.id]
                                      );
                                      if (inspectingDuplicateId === cand.id) {
                                        setInspectingDuplicateId(null);
                                      }
                                      try {
                                        await onDismissDuplicate(order.id, cand.id);
                                      } finally {
                                        setDismissingDuplicateId(null);
                                      }
                                    }}
                                    className="inline-flex min-h-[32px] shrink-0 items-center rounded-md border border-[#283340] bg-[#161D24] px-2.5 py-1 text-xs font-medium text-[#C9D1D9] hover:border-[#8B949E] hover:text-[#F0F6FC] disabled:opacity-50"
                                  >
                                    Not a Duplicate
                                  </button>
                                )}
                                <button
                                  type="button"
                                  data-testid={
                                    idx === 0
                                      ? 'open-merge-duplicate-btn'
                                      : `open-merge-duplicate-btn-${cand.id}`
                                  }
                                  onClick={() => {
                                    setMergeSourceId(String(cand.id));
                                    setMergeStrategy('keep_target');
                                    setMergePanelOpen(true);
                                    setInspectingDuplicateId(null);
                                  }}
                                  className="inline-flex min-h-[32px] shrink-0 items-center gap-1.5 rounded-md bg-[#0EA5E9] px-2.5 py-1 text-xs font-semibold text-[#0B1117] hover:bg-[#38BDF8]"
                                >
                                  <GitMerge className="h-3.5 w-3.5" />
                                  Merge Duplicate
                                </button>
                              </div>
                            </div>

                            {/* Expanded Full Duplicate Comparison Panel (including Chatter) */}
                            {isInspecting && (
                              <div
                                data-testid="duplicate-comparison-card"
                                className="mt-3 border-t border-[#283340] pt-3"
                              >
                                <div className="mb-2 flex items-center justify-between gap-2">
                                  <span className="text-[11px] font-bold uppercase tracking-wide text-[#38BDF8]">
                                    Full Potential Duplicate Details
                                  </span>
                                  <div className="flex items-center gap-2">
                                    {onSelectOrder && (
                                      <button
                                        type="button"
                                        data-testid="switch-to-duplicate-btn"
                                        onClick={() => onSelectOrder(cand.id)}
                                        className="inline-flex items-center gap-1 text-[11px] font-medium text-[#38BDF8] hover:underline"
                                      >
                                        <ExternalLink className="h-3 w-3" />
                                        Open Order
                                      </button>
                                    )}
                                    <button
                                      type="button"
                                      onClick={() => setInspectingDuplicateId(null)}
                                      className="text-[11px] text-[#8B949E] hover:text-[#F0F6FC]"
                                    >
                                      Close
                                    </button>
                                  </div>
                                </div>
                                <DuplicateOrderDetailsBody
                                  candidate={cand}
                                  items={items}
                                  channels={channels}
                                  chatterTestId="duplicate-compare-chatter"
                                />
                              </div>
                            )}
                          </div>
                        );
                      })}
                    </div>

                    {mergeCandidates.likely.length > 1 && (
                      <button
                        type="button"
                        data-testid="toggle-extra-duplicates-btn"
                        onClick={() => setShowAllDuplicates((prev) => !prev)}
                        className="inline-flex items-center gap-1 text-[11px] font-medium text-[#38BDF8] hover:underline"
                      >
                        {showAllDuplicates
                          ? 'Show top match only'
                          : `Show ${mergeCandidates.likely.length - 1} more possible ${
                              mergeCandidates.likely.length - 1 === 1 ? 'match' : 'matches'
                            }`}
                      </button>
                    )}
                  </div>
                )}

                {mergePanelOpen && (
                  <section
                    data-testid="order-merge-panel"
                    className="rounded-lg border border-[#38BDF8]/50 bg-[#11171D] p-3.5 sm:p-4"
                  >
                    <div className="flex items-center justify-between gap-2">
                      <div className="flex items-center gap-2">
                        <GitMerge className="h-4 w-4 text-[#38BDF8]" aria-hidden="true" />
                        <h3 className="font-['Plus_Jakarta_Sans'] text-sm font-bold text-[#F0F6FC]">
                          Merge Order / Quotation Into This One
                        </h3>
                      </div>
                      <div className="flex items-center gap-3">
                        {onDismissDuplicate &&
                          selectedMergeSource &&
                          mergeCandidates.likely.some((c) => c.id === selectedMergeSource.id) && (
                            <button
                              type="button"
                              data-testid="panel-dismiss-duplicate-btn"
                              disabled={dismissingDuplicateId === selectedMergeSource.id}
                              onClick={async () => {
                                const candId = selectedMergeSource.id;
                                setDismissingDuplicateId(candId);
                                setLocalDismissedIds((prev) =>
                                  prev.includes(candId) ? prev : [...prev, candId]
                                );
                                setMergePanelOpen(false);
                                setMergeSourceId('');
                                try {
                                  await onDismissDuplicate(order.id, candId);
                                } finally {
                                  setDismissingDuplicateId(null);
                                }
                              }}
                              className="text-xs font-medium text-[#C9D1D9] hover:text-[#F0F6FC] hover:underline disabled:opacity-50"
                            >
                              Not a Duplicate
                            </button>
                          )}
                        <button
                          type="button"
                          onClick={() => setMergePanelOpen(false)}
                          className="text-xs text-[#8B949E] hover:text-[#F0F6FC]"
                        >
                          Cancel
                        </button>
                      </div>
                    </div>

                    <p className="mt-1.5 text-xs text-[#8B949E]">
                      Select the duplicate or add-on order to fold into{' '}
                      <span className="font-semibold text-[#E6EDF3]">{order.customerName}</span>.
                      Its notes, chatter, and Odoo ID will be linked here so it won&apos;t re-import.
                    </p>

                    <div className="mt-3">
                      <label
                        htmlFor="merge-source-select"
                        className="mb-1 block text-xs font-medium text-[#C9D1D9]"
                      >
                        Order to Absorb &amp; Remove
                      </label>
                      <select
                        id="merge-source-select"
                        data-testid="merge-source-select"
                        value={mergeSourceId}
                        onChange={(e) => setMergeSourceId(e.target.value)}
                        className="min-h-[40px] w-full rounded-md border border-[#283340] bg-[#0F1419] px-3 py-2 text-xs text-[#F0F6FC] focus:border-[#38BDF8] focus:outline-none"
                      >
                        <option value="">Choose an order to merge...</option>
                        {mergeCandidates.likely.length > 0 && (
                          <optgroup label="Possible Duplicates">
                            {mergeCandidates.likely.map((cand) => {
                              const candSummary =
                                cand.items.length === 0
                                  ? 'No items'
                                  : cand.items
                                      .map((l) => {
                                        const meta = items.find((i) => i.id === l.trackedItemId);
                                        return `${formatQty(l.quantity)} ${meta ? meta.name : `#${l.trackedItemId}`}`;
                                      })
                                      .join(', ');
                              return (
                                <option key={cand.id} value={cand.id}>
                                  {cand.customerName}
                                  {cand.odooQuotationName ? ` (${cand.odooQuotationName})` : ''} ·{' '}
                                  {cand.status.replace('_', ' ')} ·{' '}
                                  {cand.slottedDate
                                    ? formatShortCalendarDate(cand.slottedDate)
                                    : 'Unslotted'}{' '}
                                  · {candSummary}
                                </option>
                              );
                            })}
                          </optgroup>
                        )}
                        {mergeCandidates.others.length > 0 && (
                          <optgroup label="All Other Active Orders">
                            {mergeCandidates.others.map((cand) => {
                              const candSummary =
                                cand.items.length === 0
                                  ? 'No items'
                                  : cand.items
                                      .map((l) => {
                                        const meta = items.find((i) => i.id === l.trackedItemId);
                                        return `${formatQty(l.quantity)} ${meta ? meta.name : `#${l.trackedItemId}`}`;
                                      })
                                      .join(', ');
                              return (
                                <option key={cand.id} value={cand.id}>
                                  {cand.customerName}
                                  {cand.odooQuotationName ? ` (${cand.odooQuotationName})` : ''} ·{' '}
                                  {cand.status.replace('_', ' ')} ·{' '}
                                  {cand.slottedDate
                                    ? formatShortCalendarDate(cand.slottedDate)
                                    : 'Unslotted'}{' '}
                                  · {candSummary}
                                </option>
                              );
                            })}
                          </optgroup>
                        )}
                      </select>
                    </div>

                    {selectedMergeSource && (
                      <div className="mt-3 space-y-2.5">
                        <div className="rounded border border-[#283340] bg-[#0F1419] p-2.5 text-[11px] text-[#C9D1D9]">
                          <div className="flex flex-wrap items-center justify-between gap-2">
                            <span className="font-semibold text-[#F0F6FC]">
                              Absorbing: {selectedMergeSource.customerName}
                              {selectedMergeSource.odooQuotationName
                                ? ` · ${selectedMergeSource.odooQuotationName}`
                                : ''}
                            </span>
                            <div className="flex items-center gap-2">
                              {onSelectOrder && (
                                <button
                                  type="button"
                                  data-testid="merge-open-source-order-btn"
                                  onClick={() => onSelectOrder(selectedMergeSource.id)}
                                  className="inline-flex items-center gap-1 text-[11px] font-medium text-[#38BDF8] hover:underline"
                                >
                                  <ExternalLink className="h-3 w-3" />
                                  Open
                                </button>
                              )}
                              <button
                                type="button"
                                data-testid="toggle-merge-source-details-btn"
                                onClick={() => setShowMergeSourceDetails((prev) => !prev)}
                                className="inline-flex items-center gap-1 text-[11px] font-medium text-[#38BDF8] hover:underline"
                              >
                                {showMergeSourceDetails ? (
                                  <>
                                    <ChevronUp className="h-3.5 w-3.5" />
                                    Hide Details
                                  </>
                                ) : (
                                  <>
                                    <ChevronDown className="h-3.5 w-3.5" />
                                    Inspect Details &amp; Chatter ({selectedMergeSource.chatter.length})
                                  </>
                                )}
                              </button>
                            </div>
                          </div>
                          {showMergeSourceDetails ? (
                            <div
                              data-testid="merge-source-details"
                              className="mt-2.5 border-t border-[#283340] pt-2.5"
                            >
                              <DuplicateOrderDetailsBody
                                candidate={selectedMergeSource}
                                items={items}
                                channels={channels}
                                chatterTestId="merge-source-chatter"
                              />
                            </div>
                          ) : (
                            <div className="mt-1 font-mono text-[#8B949E]">
                              Items:{' '}
                              {selectedMergeSource.items.length === 0
                                ? 'None'
                                : selectedMergeSource.items
                                    .map((l) => {
                                      const meta = items.find((i) => i.id === l.trackedItemId);
                                      return `${formatQty(l.quantity)} ${meta ? `${meta.unitLabel} ${meta.name}` : `#${l.trackedItemId}`}`;
                                    })
                                    .join(', ')}
                            </div>
                          )}
                        </div>

                        {hasDifferentMergeDates &&
                          order.slottedDate &&
                          selectedMergeSource.slottedDate && (
                            <div>
                              <span className="mb-1.5 block text-xs font-medium text-[#C9D1D9]">
                                These orders are on 2 different dates — keep which 1 date?
                              </span>
                              <div className="grid grid-cols-1 gap-1.5 sm:grid-cols-2">
                                <button
                                  type="button"
                                  data-testid="merge-date-target"
                                  onClick={() => setMergeKeepDate(order.slottedDate!)}
                                  className={`rounded-md border px-2.5 py-2 text-left transition-colors ${
                                    resolvedMergeDate === order.slottedDate
                                      ? 'border-[#38BDF8] bg-[#0EA5E9]/15 text-[#F0F6FC]'
                                      : 'border-[#283340] bg-[#0F1419] text-[#C9D1D9] hover:border-[#38BDF8]/50'
                                  }`}
                                >
                                  <div className="text-[11px] font-semibold">
                                    Keep {formatShortCalendarDate(order.slottedDate)}
                                  </div>
                                  <div className="text-[10px] text-[#8B949E]">
                                    Removes {formatShortCalendarDate(selectedMergeSource.slottedDate)}
                                  </div>
                                </button>
                                <button
                                  type="button"
                                  data-testid="merge-date-source"
                                  onClick={() => setMergeKeepDate(selectedMergeSource.slottedDate!)}
                                  className={`rounded-md border px-2.5 py-2 text-left transition-colors ${
                                    resolvedMergeDate === selectedMergeSource.slottedDate
                                      ? 'border-[#38BDF8] bg-[#0EA5E9]/15 text-[#F0F6FC]'
                                      : 'border-[#283340] bg-[#0F1419] text-[#C9D1D9] hover:border-[#38BDF8]/50'
                                  }`}
                                >
                                  <div className="text-[11px] font-semibold">
                                    Move to {formatShortCalendarDate(selectedMergeSource.slottedDate)}
                                  </div>
                                  <div className="text-[10px] text-[#8B949E]">
                                    Removes {formatShortCalendarDate(order.slottedDate)}
                                  </div>
                                </button>
                              </div>
                            </div>
                          )}

                        <div>
                          <span className="mb-1.5 block text-xs font-medium text-[#C9D1D9]">
                            How should items be handled?
                          </span>
                          <div className="grid grid-cols-1 gap-1.5 sm:grid-cols-3">
                            {(
                              [
                                {
                                  id: 'keep_target',
                                  title: 'Same Order',
                                  desc: 'Keep this order’s items',
                                },
                                {
                                  id: 'use_source',
                                  title: 'Same Order',
                                  desc: 'Use absorbed order’s items',
                                },
                                {
                                  id: 'combine',
                                  title: 'Add Together',
                                  desc: 'Sum quantities of both',
                                },
                              ] as const
                            ).map((opt) => (
                              <button
                                key={opt.id}
                                type="button"
                                data-testid={`merge-strategy-${opt.id}`}
                                onClick={() => setMergeStrategy(opt.id)}
                                className={`rounded-md border px-2.5 py-2 text-left transition-colors ${
                                  mergeStrategy === opt.id
                                    ? 'border-[#38BDF8] bg-[#0EA5E9]/15 text-[#F0F6FC]'
                                    : 'border-[#283340] bg-[#0F1419] text-[#C9D1D9] hover:border-[#38BDF8]/50'
                                }`}
                              >
                                <div className="text-[11px] font-semibold">{opt.title}</div>
                                <div className="text-[10px] text-[#8B949E]">{opt.desc}</div>
                              </button>
                            ))}
                          </div>
                        </div>

                        <div
                          data-testid="merge-result-summary"
                          className="rounded border border-[#38BDF8]/30 bg-[#0EA5E9]/10 px-2.5 py-2 text-[11px] text-[#BAE6FD]"
                        >
                          {resolvedMergeDate ? (
                            <>
                              Result: <span className="font-semibold text-[#F0F6FC]">1 order on {formatShortCalendarDate(resolvedMergeDate)}</span>
                              {hasDifferentMergeDates && order.slottedDate && selectedMergeSource.slottedDate
                                ? ` · duplicate on ${formatShortCalendarDate(
                                    resolvedMergeDate === order.slottedDate
                                      ? selectedMergeSource.slottedDate
                                      : order.slottedDate
                                  )} will be removed.`
                                : ' · duplicate will be removed.'}
                            </>
                          ) : (
                            <>
                              Result: <span className="font-semibold text-[#F0F6FC]">1 unslotted order</span> · duplicate will be removed.
                            </>
                          )}
                        </div>

                        <button
                          type="button"
                          disabled={merging}
                          data-testid="confirm-merge-orders-btn"
                          onClick={() => void handleConfirmMerge()}
                          className="inline-flex min-h-[40px] w-full items-center justify-center gap-1.5 rounded-md bg-[#0EA5E9] px-4 py-2 text-xs font-semibold text-[#0B1117] hover:bg-[#38BDF8] disabled:opacity-50"
                        >
                          <GitMerge className="h-3.5 w-3.5" />
                          {merging
                            ? 'Merging Orders...'
                            : resolvedMergeDate
                              ? `Merge Into 1 Order on ${formatShortCalendarDate(resolvedMergeDate)} (Undoable)`
                              : 'Merge Into 1 Order (Undoable)'}
                        </button>
                      </div>
                    )}
                  </section>
                )}
              </div>
            )}

          {/* Aging Pre-Approved Hold Notice */}
          {order.status === 'pre_approved' && agingHours !== null && (
            <div
              className={`flex flex-wrap items-center justify-between gap-3 rounded-md border px-4 py-3 text-xs ${
                isHoldOverThreshold
                  ? 'border-[#D97706]/70 bg-[#D97706]/10 text-[#FBBF24]'
                  : 'border-[#283340] bg-[#1E2730] text-[#C9D1D9]'
              }`}
            >
              <div>
                <span className="font-semibold">{formatAgingBadge(agingHours)}</span>
                <span className="ml-2 text-[#8B949E]">
                  Pre-approved hold threshold: {holdThresholdHours}h
                </span>
              </div>
              <button
                type="button"
                data-testid="order-release-hold-btn"
                onClick={() => void onReleaseHold(order.id)}
                className="min-h-[34px] shrink-0 whitespace-nowrap rounded-md border border-[#D97706]/70 bg-[#0F1419] px-3 py-1.5 text-xs font-semibold text-[#FBBF24] hover:bg-[#D97706]/20"
              >
                Release Hold / Return to Waitlist
              </button>
            </div>
          )}

          {/* Mobile-First Smart Pickup Slot Scheduler (Availability + 1-Tap First Available) */}
          {order.status !== 'ignored' && (
            <section
              data-testid="order-scheduler-panel"
              aria-label="Schedule Pickup Slot"
              className="rounded-lg border border-[#283340] bg-[#11171D] p-3.5 sm:p-4"
            >
              <div className="flex flex-wrap items-center justify-between gap-2">
                <div className="flex items-center gap-2">
                  <CalendarCheck className="h-4 w-4 text-[#38BDF8]" aria-hidden="true" />
                  <h3 className="font-['Plus_Jakarta_Sans'] text-sm font-bold text-[#F0F6FC]">
                    Schedule Pickup Slot
                  </h3>
                </div>
                {order.slottedDate && order.status !== 'waitlist' && (
                  <span className="font-mono text-xs tabular-nums text-[#38BDF8]">
                    Current: {formatShortCalendarDate(order.slottedDate)}
                  </span>
                )}
              </div>

              {/* Customer Requested Pickup Date (Editable + 1-Tap Try Requested Date) */}
              <div className="mt-3 rounded-md border border-[#D97706]/40 bg-[#D97706]/8 p-2.5">
                <div className="flex items-end gap-2">
                  <div className="flex-1">
                    <label
                      htmlFor="order-requested-date"
                      className="mb-1 flex items-center gap-1.5 text-xs font-semibold text-[#FBBF24]"
                    >
                      <Calendar className="h-3.5 w-3.5 shrink-0" aria-hidden="true" />
                      <span>Requested Pickup Date</span>
                    </label>
                    <input
                      id="order-requested-date"
                      data-testid="order-requested-date-input"
                      type="date"
                      value={requestedDate}
                      onChange={(e) => setRequestedDate(e.target.value)}
                      className="min-h-[38px] w-full rounded-md border border-[#283340] bg-[#0F1419] px-3 py-1.5 font-mono text-xs text-[#F0F6FC] focus:border-[#FBBF24] focus:outline-none"
                    />
                  </div>
                  {requestedDate && (
                    <button
                      type="button"
                      data-testid="clear-requested-date-btn"
                      onClick={() => setRequestedDate('')}
                      className="min-h-[38px] shrink-0 rounded-md border border-[#283340] bg-[#0F1419] px-2.5 py-1.5 text-xs font-medium text-[#8B949E] hover:text-[#F0F6FC]"
                    >
                      Clear
                    </button>
                  )}
                </div>
                {requestedDate && order.slottedDate !== requestedDate && (
                  <button
                    type="button"
                    data-testid="slot-requested-date-btn"
                    disabled={isLocked || slottingTarget !== null}
                    onClick={() => void handleQuickSlot(requestedDate)}
                    className={`mt-2 flex min-h-[38px] w-full items-center justify-between gap-2 rounded-md border px-3 py-1.5 text-left text-xs font-semibold transition-colors disabled:opacity-50 ${
                      requestedDateCandidate?.fit === 'fits'
                        ? 'border-[#22C55E]/60 bg-[#16A34A]/15 text-[#4ADE80] hover:bg-[#16A34A]/25'
                        : 'border-[#D97706]/60 bg-[#D97706]/15 text-[#FBBF24] hover:bg-[#D97706]/25'
                    }`}
                  >
                    <span className="truncate">
                      {slottingTarget === requestedDate
                        ? 'Scheduling...'
                        : `Slot on Requested Date · ${ISO_WEEKDAY_LABELS[getIsoWeekday(requestedDate)]}, ${formatShortCalendarDate(requestedDate)}`}
                    </span>
                    {requestedDateCandidate && (
                      <span className="shrink-0 font-mono text-[11px]">
                        {fitStyle(requestedDateCandidate.fit).label}
                      </span>
                    )}
                  </button>
                )}
              </div>

              {/* Pickup Channel selector right inside scheduler so channel days update live */}
              <div className="mt-3">
                <label
                  htmlFor="order-channel"
                  className="mb-1 flex items-center justify-between text-xs font-medium text-[#C9D1D9]"
                >
                  <span>Pickup Channel</span>
                  {selectedChannel && channelHasScheduleRestriction(selectedChannel) && (
                    <span className="font-mono text-[11px] text-[#8B949E]">
                      {selectedChannel.allowedWeekdays.length > 0
                        ? selectedChannel.allowedWeekdays
                            .map((d) => ISO_WEEKDAY_LABELS[d])
                            .join(' / ')
                        : `${(selectedChannel.specificDates ?? []).length} event date(s)`}
                    </span>
                  )}
                </label>
                <select
                  id="order-channel"
                  data-testid="order-channel-select"
                  value={pickupChannelId}
                  onChange={(e) => setPickupChannelId(e.target.value)}
                  className="min-h-[40px] w-full rounded-md border border-[#283340] bg-[#0F1419] px-3 py-2 text-sm text-[#F0F6FC] focus:border-[#38BDF8] focus:outline-none"
                >
                  <option value="">Unassigned / Any Day</option>
                  {channels.map((c) => (
                    <option key={c.id} value={c.id}>
                      {c.name}
                    </option>
                  ))}
                </select>
                {order.freeTextPickup && (
                  <p className="mt-1 text-xs text-[#8B949E]">
                    Form text: {order.freeTextPickup}
                  </p>
                )}
              </div>

              {isLocked && (
                <p className="mt-3 rounded-md border border-[#38BDF8]/40 bg-[#38BDF8]/10 px-3 py-2 text-xs text-[#BAE6FD]">
                  This order is locked. Unlock it below before rescheduling to a different date.
                </p>
              )}

              {/* Primary 1-Tap Schedule First Available Action */}
              {validDraftItems.length === 0 ? (
                <p className="mt-3 rounded-md border border-[#283340] bg-[#0F1419] px-3 py-2.5 text-xs text-[#8B949E]">
                  Assign at least one Tracked Item below to see live stock availability and the earliest open date.
                </p>
              ) : firstAvailable ? (
                <button
                  type="button"
                  data-testid="schedule-first-available-btn"
                  disabled={isLocked || slottingTarget !== null}
                  onClick={() => void handleQuickSlot(firstAvailable.date)}
                  className="mt-3 flex min-h-[46px] w-full items-center justify-between gap-2 rounded-md bg-[#0EA5E9] px-3.5 py-2.5 text-left text-sm font-semibold text-[#0B1117] transition-colors hover:bg-[#38BDF8] disabled:opacity-50"
                >
                  <span className="flex min-w-0 items-center gap-2">
                    <Sparkles className="h-4 w-4 shrink-0" aria-hidden="true" />
                    <span className="truncate">
                      {slottingTarget === firstAvailable.date
                        ? 'Scheduling...'
                        : `Schedule First Available · ${formatCandidateDateLabel(
                            firstAvailable.date,
                            firstAvailable.isoWeekday,
                            firstAvailable.isToday
                          )}`}
                    </span>
                  </span>
                  {firstAvailable.items.length === 1 && (
                    <span className="shrink-0 font-mono text-xs font-bold tabular-nums">
                      {formatQty(firstAvailable.items[0].afterOpen)} left
                    </span>
                  )}
                </button>
              ) : (
                <div
                  data-testid="no-open-slot-notice"
                  className="mt-3 flex flex-wrap items-center justify-between gap-2 rounded-md border border-[#D97706]/50 bg-[#D97706]/10 px-3 py-2.5 text-xs text-[#FBBF24]"
                >
                  <span>No dates fit above safety buffer in the next {weeks} weeks.</span>
                  <button
                    type="button"
                    data-testid="drawer-extend-weeks-btn"
                    onClick={onExtendWeeks}
                    className="shrink-0 rounded border border-[#D97706]/70 bg-[#0F1419] px-2.5 py-1 text-xs font-semibold text-[#FBBF24] hover:bg-[#D97706]/20"
                  >
                    Load +2 Weeks
                  </button>
                </div>
              )}

              {/* Live Availability Date List */}
              {candidateDates.length > 0 && (
                <div className="mt-3">
                  <div className="mb-1.5 flex flex-wrap items-center justify-between gap-2 text-xs">
                    <span className="font-medium text-[#C9D1D9]">
                      Tap a Date to Schedule ({visibleCandidates.length})
                    </span>
                    <div className="flex items-center gap-3">
                      {validDraftItems.length > 0 && (
                        <button
                          type="button"
                          data-testid="filter-open-dates-btn"
                          onClick={() => setOnlyOpenDates((prev) => !prev)}
                          className={`text-xs font-medium transition-colors ${
                            onlyOpenDates
                              ? 'text-[#4ADE80]'
                              : 'text-[#8B949E] hover:text-[#E6EDF3]'
                          }`}
                        >
                          {onlyOpenDates ? 'Showing open only' : 'Open only'}
                        </button>
                      )}
                      {channelRestrictsWeekdays && (
                        <button
                          type="button"
                          data-testid="toggle-off-channel-dates-btn"
                          onClick={() => setShowOffChannel((prev) => !prev)}
                          className={`text-xs font-medium transition-colors ${
                            showOffChannel
                              ? 'text-[#38BDF8]'
                              : 'text-[#8B949E] hover:text-[#E6EDF3]'
                          }`}
                        >
                          {showOffChannel ? 'Hide off-channel' : 'Show off-channel'}
                        </button>
                      )}
                    </div>
                  </div>

                  {visibleCandidates.length === 0 ? (
                    <div className="rounded-md border border-[#283340] bg-[#0F1419] px-3 py-4 text-center text-xs text-[#8B949E]">
                      No matching dates in the current {weeks}-week window.{' '}
                      {onlyOpenDates && (
                        <button
                          type="button"
                          onClick={() => setOnlyOpenDates(false)}
                          className="font-medium text-[#38BDF8] hover:underline"
                        >
                          Show all dates
                        </button>
                      )}
                    </div>
                  ) : (
                    <div
                      data-testid="slot-availability-list"
                      className="max-h-60 divide-y divide-[#283340] overflow-y-auto rounded-md border border-[#283340] bg-[#0F1419]"
                    >
                      {visibleCandidates.map((cand) => {
                        const style = fitStyle(cand.fit);
                        const isBusy = slottingTarget === cand.date;
                        return (
                          <button
                            key={cand.date}
                            type="button"
                            data-testid={`slot-candidate-${cand.date}`}
                            disabled={isLocked || slottingTarget !== null}
                            onClick={() => void handleQuickSlot(cand.date)}
                            className={`flex min-h-[52px] w-full flex-col gap-1 px-3 py-2.5 text-left transition-colors disabled:opacity-50 ${
                              cand.isCurrentSlot ? 'bg-[#38BDF8]/10' : style.rowHover
                            }`}
                          >
                            <div className="flex w-full items-center justify-between gap-2">
                              <div className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-0.5 text-xs">
                                <span className="font-semibold text-[#F0F6FC]">
                                  {formatCandidateDateLabel(
                                    cand.date,
                                    cand.isoWeekday,
                                    cand.isToday
                                  )}
                                </span>
                                {cand.isFirstAvailable && (
                                  <span className="font-semibold text-[#4ADE80]">Earliest</span>
                                )}
                                {cand.isCurrentSlot && (
                                  <span className="font-semibold text-[#38BDF8]">Current</span>
                                )}
                                {cand.isRequestedDate && (
                                  <span className="font-semibold text-[#FBBF24]">Requested</span>
                                )}
                                {!cand.channelAllowed && (
                                  <span className="text-[#8B949E]">Off-channel</span>
                                )}
                              </div>
                              <span
                                className={`shrink-0 text-xs font-semibold ${style.text}`}
                              >
                                {isBusy ? 'Slotting...' : style.label}
                              </span>
                            </div>

                            {cand.items.length > 0 && (
                              <div className="flex flex-col gap-0.5 font-mono text-[11px] tabular-nums text-[#C9D1D9]">
                                {cand.items.map((snap) => (
                                  <div
                                    key={snap.trackedItemId}
                                    className="flex flex-wrap items-center justify-between gap-x-2"
                                  >
                                    <span className="truncate text-[#8B949E]">
                                      {cand.items.length > 1 ? `${snap.itemName}: ` : ''}
                                      {formatQty(snap.currentOpen)} open →{' '}
                                      <span
                                        className={
                                          snap.minDownstreamEnding < 0
                                            ? 'font-semibold text-[#F87171]'
                                            : snap.minDownstreamOpen < 0
                                              ? 'font-semibold text-[#FBBF24]'
                                              : 'font-semibold text-[#4ADE80]'
                                        }
                                      >
                                        {snap.afterEnding < 0
                                          ? `${formatQty(snap.afterEnding)} short`
                                          : snap.afterOpen < 0
                                            ? `${formatQty(snap.afterOpen)} buffer`
                                            : `${formatQty(snap.afterOpen)} left`}
                                      </span>
                                    </span>
                                    {snap.constrainingDate && (
                                      <span className="text-[10px] text-[#FBBF24]">
                                        dips {formatShortCalendarDate(snap.constrainingDate)}
                                      </span>
                                    )}
                                  </div>
                                ))}
                              </div>
                            )}
                          </button>
                        );
                      })}
                    </div>
                  )}
                </div>
              )}

              {/* Secondary manual date input for custom dates outside the current window */}
              <div className="mt-3 flex items-end gap-2 border-t border-[#283340] pt-3">
                <div className="flex-1">
                  <label
                    htmlFor="order-slotted-date"
                    className="mb-1 block text-[11px] font-medium text-[#8B949E]"
                  >
                    Custom Pickup Date (Manual Entry)
                  </label>
                  <input
                    id="order-slotted-date"
                    data-testid="order-slotted-date-input"
                    type="date"
                    value={slottedDate}
                    onChange={(e) => {
                      setSlottedDate(e.target.value);
                      if (e.target.value && status === 'waitlist') {
                        setStatus('slotted');
                      }
                    }}
                    className="min-h-[38px] w-full rounded-md border border-[#283340] bg-[#0F1419] px-3 py-1.5 font-mono text-xs text-[#F0F6FC] focus:border-[#38BDF8] focus:outline-none"
                  />
                </div>
                {slottedDate && (
                  <button
                    type="button"
                    data-testid="clear-slotted-date-btn"
                    onClick={() => {
                      setSlottedDate('');
                      setStatus('waitlist');
                    }}
                    className="min-h-[38px] shrink-0 rounded-md border border-[#283340] bg-[#0F1419] px-3 py-1.5 text-xs font-medium text-[#8B949E] hover:text-[#F0F6FC]"
                  >
                    Unassign
                  </button>
                )}
              </div>
            </section>
          )}

          {/* Status Pipeline + Pre-Approve Trigger */}
          <div>
            <div className="mb-2 flex items-center justify-between">
              <label className="text-xs font-medium text-[#8B949E]">Order Status</label>
              <button
                type="button"
                data-testid="order-lock-toggle-btn"
                onClick={() => setIsLocked((prev) => !prev)}
                className={`inline-flex items-center gap-1.5 rounded-md border px-2.5 py-1 text-xs font-medium transition-colors ${
                  isLocked
                    ? 'border-[#38BDF8] bg-[#38BDF8]/15 text-[#38BDF8]'
                    : 'border-[#283340] bg-[#1E2730] text-[#8B949E] hover:text-[#E6EDF3]'
                }`}
              >
                {isLocked ? <Lock className="h-3.5 w-3.5" /> : <Unlock className="h-3.5 w-3.5" />}
                {isLocked ? 'Locked Slot' : 'Unlocked'}
              </button>
            </div>
            <div className="grid grid-cols-2 gap-1.5 sm:grid-cols-4">
              {STATUS_STEPS.map((step) => (
                <button
                  key={step.value}
                  type="button"
                  data-testid={`order-status-${step.value}`}
                  onClick={() => setStatus(step.value)}
                  className={`min-h-[38px] whitespace-nowrap rounded-md border px-2 py-1.5 text-xs font-medium transition-colors ${
                    status === step.value
                      ? 'border-[#38BDF8] bg-[#0EA5E9] text-[#0B1117]'
                      : 'border-[#283340] bg-[#0F1419] text-[#C9D1D9] hover:border-[#3B4958]'
                  }`}
                >
                  {step.label}
                </button>
              ))}
            </div>
            {order.status !== 'ignored' && (
              <button
                type="button"
                data-testid="order-pre-approve-btn"
                onClick={() => void onPreApprove(order.id)}
                className="mt-3 min-h-[40px] w-full rounded-md border border-[#22C55E]/60 bg-[#16A34A]/15 px-4 py-2 text-sm font-semibold text-[#4ADE80] transition-colors hover:bg-[#16A34A]/25"
              >
                Pre-Approve &amp; Open Copy Message
              </button>
            )}
          </div>

          {/* Assigned Tracked Items (kept right under Status so items can be adjusted quickly to re-check availability) */}
          <div className="border-t border-[#283340] pt-4">
            <div className="mb-2 flex items-center justify-between">
              <span className="text-xs font-semibold text-[#F0F6FC]">Assigned Tracked Items</span>
              <button
                type="button"
                data-testid="order-add-item-line-btn"
                onClick={addItemLine}
                disabled={items.length === 0}
                className="inline-flex items-center gap-1 text-xs font-medium text-[#38BDF8] hover:underline disabled:opacity-40"
              >
                <Plus className="h-3.5 w-3.5" />
                Add Item
              </button>
            </div>
            {orderItems.length === 0 ? (
              <p className="text-xs text-[#8B949E]">
                No Tracked Items assigned yet. Assign items here or ignore if unrelated.
              </p>
            ) : (
              <div className="space-y-2">
                {orderItems.map((line, idx) => (
                  <div key={line.rowKey} className="flex items-center gap-2">
                    <select
                      data-testid={`order-item-select-${idx}`}
                      value={line.trackedItemId}
                      onChange={(e) => {
                        const next = [...orderItems];
                        next[idx] = { ...line, trackedItemId: Number(e.target.value) };
                        setOrderItems(next);
                      }}
                      className="min-h-[38px] flex-1 rounded-md border border-[#283340] bg-[#0F1419] px-3 py-1.5 text-sm text-[#F0F6FC]"
                    >
                      {items.map((item) => (
                        <option key={item.id} value={item.id}>
                          {item.name} ({item.unitLabel})
                        </option>
                      ))}
                    </select>
                    <input
                      data-testid={`order-item-qty-${idx}`}
                      type="text"
                      inputMode="decimal"
                      placeholder="Qty"
                      value={line.qtyText}
                      onChange={(e) => {
                        const raw = e.target.value;
                        if (raw !== '' && !/^\d*\.?\d*$/.test(raw)) return;
                        const next = [...orderItems];
                        next[idx] = { ...line, qtyText: raw };
                        setOrderItems(next);
                      }}
                      className="min-h-[38px] w-24 rounded-md border border-[#283340] bg-[#0F1419] px-2.5 py-1.5 font-mono text-sm tabular-nums text-[#F0F6FC] placeholder:text-[#6E7681]"
                    />
                    <button
                      type="button"
                      onClick={() => setOrderItems(orderItems.filter((_, i) => i !== idx))}
                      className="flex h-9 w-9 items-center justify-center rounded-md text-[#8B949E] hover:bg-[#1E2730] hover:text-[#F87171]"
                      aria-label="Remove item line"
                    >
                      <Trash2 className="h-4 w-4" />
                    </button>
                  </div>
                ))}
              </div>
            )}
          </div>

          {/* Customer Info */}
          <div className="grid grid-cols-1 gap-4 border-t border-[#283340] pt-4 sm:grid-cols-2">
            <div className="sm:col-span-2">
              <CustomerAutocompleteInput
                id="order-customer-name"
                testId="order-customer-name-input"
                label="Customer Name"
                labelRight={
                  order.customerNameOverridden ? (
                    <span className="text-[11px] text-[#38BDF8]">
                      Local override preserved on Odoo sync
                    </span>
                  ) : undefined
                }
                value={customerName}
                odooConfigured={odooConfigured}
                onChange={setCustomerName}
                onSelectCustomer={(cust) => {
                  if (cust.email) setCustomerEmail(cust.email);
                  if (cust.phone) setCustomerPhone(cust.phone);
                }}
              />
            </div>

            <div>
              <label htmlFor="order-email" className="mb-1.5 block text-xs font-medium text-[#C9D1D9]">
                Email
              </label>
              <input
                id="order-email"
                data-testid="order-email-input"
                type="email"
                value={customerEmail}
                onChange={(e) => setCustomerEmail(e.target.value)}
                className="min-h-[40px] w-full rounded-md border border-[#283340] bg-[#0F1419] px-3 py-2 text-sm text-[#F0F6FC] focus:border-[#38BDF8] focus:outline-none"
              />
            </div>

            <div>
              <label htmlFor="order-phone" className="mb-1.5 block text-xs font-medium text-[#C9D1D9]">
                Phone
              </label>
              <input
                id="order-phone"
                data-testid="order-phone-input"
                type="text"
                value={customerPhone}
                onChange={(e) => setCustomerPhone(e.target.value)}
                className="min-h-[40px] w-full rounded-md border border-[#283340] bg-[#0F1419] px-3 py-2 text-sm text-[#F0F6FC] focus:border-[#38BDF8] focus:outline-none"
              />
            </div>
          </div>

          {/* Notes */}
          <div>
            <label htmlFor="order-notes" className="mb-1.5 block text-xs font-medium text-[#C9D1D9]">
              Notes
            </label>
            <textarea
              id="order-notes"
              data-testid="order-notes-input"
              rows={3}
              value={notes}
              onChange={(e) => setNotes(e.target.value)}
              className="w-full rounded-md border border-[#283340] bg-[#0F1419] px-3 py-2 text-sm text-[#F0F6FC] focus:border-[#38BDF8] focus:outline-none"
            />
          </div>

          {/* Raw Odoo Quotation Payload & Lines */}
          {(order.odooRawNotes || order.odooRawLines.length > 0) && (
            <div className="border-t border-[#283340] pt-4" data-testid="order-odoo-raw-section">
              <h3 className="text-xs font-semibold text-[#F0F6FC]">Odoo Order Details</h3>
              {order.odooRawLines.length > 0 && (
                <ul className="mt-2 space-y-1 text-xs text-[#C9D1D9]">
                  {order.odooRawLines.map((rawLine, idx) => (
                    <li key={idx} className="font-mono text-[#C9D1D9]">
                      • {rawLine}
                    </li>
                  ))}
                </ul>
              )}
              {order.odooRawNotes && (
                <pre className="mt-2 whitespace-pre-wrap rounded-md border border-[#283340] bg-[#0F1419] p-3 font-sans text-xs text-[#C9D1D9]">
                  {order.odooRawNotes}
                </pre>
              )}
            </div>
          )}

          {/* Synced Odoo Chatter Thread (Filtered comment & email messages) */}
          {order.source === 'odoo' && (
            <div className="border-t border-[#283340] pt-4" data-testid="order-chatter-section">
              <div className="mb-3 flex items-center justify-between">
                <h3 className="text-xs font-semibold text-[#F0F6FC]">
                  Odoo Chatter ({order.chatter.length})
                </h3>
                <span className="text-[11px] text-[#8B949E]">Comments &amp; Emails · Local Time</span>
              </div>
              {order.chatter.length === 0 ? (
                <p className="text-xs text-[#8B949E]">No comment or email messages synced yet.</p>
              ) : (
                <div className="space-y-3">
                  {order.chatter.map((msg) => (
                    <div
                      key={msg.id}
                      data-testid={`chatter-msg-${msg.odooMessageId}`}
                      className="rounded-md border border-[#283340] bg-[#0F1419] p-3"
                    >
                      <div className="flex items-center justify-between gap-2 text-xs text-[#8B949E]">
                        <span className="inline-flex items-center gap-1.5 font-medium text-[#E6EDF3]">
                          {msg.messageType === 'email' ? (
                            <Mail className="h-3.5 w-3.5 text-[#38BDF8]" aria-hidden="true" />
                          ) : (
                            <MessageSquare className="h-3.5 w-3.5 text-[#8B949E]" aria-hidden="true" />
                          )}
                          {msg.authorName}
                        </span>
                        <span className="font-mono text-[11px] tabular-nums">
                          {msg.createdAtLocal}
                        </span>
                      </div>
                      <p className="mt-2 whitespace-pre-wrap text-xs leading-relaxed text-[#C9D1D9]">
                        {msg.bodyText}
                      </p>
                    </div>
                  ))}
                </div>
              )}
            </div>
          )}
        </div>

        {/* Footer Actions */}
        <div className="flex flex-wrap items-center justify-between gap-2 border-t border-[#283340] px-4 py-3.5 sm:px-6 sm:py-4">
          <div className="flex flex-wrap items-center gap-2">
            {onMergeOrders &&
              order.status !== 'ignored' &&
              (mergeCandidates.likely.length > 0 || mergeCandidates.others.length > 0) && (
                <button
                  type="button"
                  data-testid="toggle-merge-panel-btn"
                  onClick={() => {
                    if (!mergePanelOpen && !mergeSourceId && mergeCandidates.likely.length > 0) {
                      setMergeSourceId(String(mergeCandidates.likely[0].id));
                    }
                    setMergePanelOpen((prev) => !prev);
                  }}
                  className="inline-flex min-h-[38px] items-center gap-1.5 whitespace-nowrap rounded-md border border-[#38BDF8]/50 bg-[#1E2730] px-3 py-1.5 text-xs font-medium text-[#38BDF8] hover:bg-[#25313D]"
                >
                  <GitMerge className="h-3.5 w-3.5" />
                  {mergePanelOpen ? 'Close Merge' : 'Merge...'}
                </button>
              )}
            {order.source === 'odoo' && order.status !== 'ignored' && (
              <button
                type="button"
                data-testid="order-ignore-btn"
                onClick={() => void onIgnore(order.id)}
                className="min-h-[38px] whitespace-nowrap rounded-md border border-[#283340] bg-[#1E2730] px-3 py-1.5 text-xs font-medium text-[#C9D1D9] hover:border-[#F87171] hover:text-[#F87171]"
              >
                Dismiss / Ignore
              </button>
            )}
            {order.status === 'ignored' && (
              <button
                type="button"
                data-testid="order-restore-ignored-btn"
                onClick={() => void onRestoreIgnored(order.id)}
                className="min-h-[38px] whitespace-nowrap rounded-md border border-[#38BDF8]/60 bg-[#1E2730] px-3 py-1.5 text-xs font-medium text-[#38BDF8]"
              >
                Restore to Waitlist
              </button>
            )}
            {order.source === 'standing' &&
              order.standingOrderId &&
              order.standingOccurrenceDate && (
                <button
                  type="button"
                  data-testid="order-skip-standing-btn"
                  onClick={() =>
                    void onSkipStandingOccurrence(
                      order.standingOrderId!,
                      order.standingOccurrenceDate!
                    )
                  }
                  className="min-h-[38px] whitespace-nowrap rounded-md border border-[#283340] bg-[#1E2730] px-3 py-1.5 text-xs font-medium text-[#FBBF24] hover:border-[#FBBF24]"
                >
                  Skip This Week
                </button>
              )}
            {order.source !== 'odoo' && (
              <button
                type="button"
                data-testid="order-delete-btn"
                onClick={() => void onDeleteOrder(order.id)}
                className="min-h-[38px] whitespace-nowrap rounded-md border border-[#283340] bg-[#1E2730] px-3 py-1.5 text-xs font-medium text-[#F87171] hover:border-[#F87171]"
              >
                Delete
              </button>
            )}
          </div>

          {mergePanelOpen ? (
            <button
              type="button"
              disabled={!selectedMergeSource || merging}
              data-testid="footer-confirm-merge-btn"
              onClick={() => void handleConfirmMerge()}
              className="inline-flex min-h-[40px] items-center gap-1.5 whitespace-nowrap rounded-md bg-[#0EA5E9] px-5 py-2 text-sm font-semibold text-[#0B1117] transition-colors hover:bg-[#38BDF8] disabled:opacity-50"
            >
              <GitMerge className="h-4 w-4" />
              {merging ? 'Merging...' : 'Merge Into 1 Order'}
            </button>
          ) : (
            <button
              type="button"
              disabled={saving}
              data-testid="order-save-btn"
              onClick={() => void handleSave()}
              className="min-h-[40px] whitespace-nowrap rounded-md bg-[#0EA5E9] px-5 py-2 text-sm font-semibold text-[#0B1117] transition-colors hover:bg-[#38BDF8] disabled:opacity-50"
            >
              {saving ? 'Saving...' : 'Save Changes'}
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
