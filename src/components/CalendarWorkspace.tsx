import {
  AlertTriangle,
  ArrowDown,
  ArrowUp,
  Bookmark,
  Calendar,
  CalendarClock,
  Check,
  ChevronRight,
  GripVertical,
  Lock,
  PanelRightClose,
  PanelRightOpen,
  RefreshCw,
  RotateCcw,
  Settings,
  Sparkles,
  X,
} from 'lucide-react';
import { useCallback, useEffect, useMemo, useRef, useState, type DragEvent } from 'react';
import { formatQty } from '../shared/generators';
import {
  channelHasScheduleRestriction,
  evaluateCandidateSlotDates,
  isChannelActiveOnDate,
  previewOrderMoveProjections,
} from '../shared/supplyEngine';
import {
  ISO_WEEKDAY_LABELS,
  compareWaitlistOrders,
  formatAgingBadge,
  formatLocalDateTime,
  formatShortCalendarDate,
  getAgingHoldHours,
  getIsoWeekday,
  getOrderArrivalInfo,
} from '../shared/timezone';
import type {
  AvailabilityTier,
  CalendarDayProjection,
  OrderRecord,
  WorkspacePayload,
} from '../shared/types';

interface CalendarWorkspaceProps {
  workspace: WorkspacePayload;
  focusedItemId: number | 'all';
  onChangeFocusedItem: (id: number | 'all') => void;
  onSelectDay: (day: CalendarDayProjection) => void;
  onSelectOrder: (order: OrderRecord) => void;
  onDropOrderOnDate: (orderId: number, date: string) => Promise<void>;
  onSyncNow: () => Promise<void>;
  syncing: boolean;
  onAutoSlotAsap: () => Promise<void>;
  autoSlotting: boolean;
  onUndo: () => Promise<void>;
  onCreateCheckpoint: () => Promise<void>;
  onRestoreCheckpoint: (id: number) => Promise<void>;
  onExtendWeeks: () => void;
  onOpenSettings: () => void;
  onReconcile: (orderId: number, action: 'confirm' | 'keep') => Promise<void>;
  onReleaseHold: (orderId: number) => Promise<void>;
  onRestoreIgnored: (orderId: number) => Promise<void>;
  onReorderWaitlist?: (orderIds: number[]) => Promise<void>;
  onResetWaitlistOrder?: () => Promise<void>;
}

const WEEKDAY_HEADERS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];

function tierStyles(
  tier: AvailabilityTier,
  sellableOpen?: number
): { text: string; bg: string; label: string } {
  if (tier === 'red') {
    return { text: 'text-[#F87171]', bg: 'bg-[#DC2626]/12', label: 'Deficit' };
  }
  if (tier === 'amber') {
    return { text: 'text-[#FBBF24]', bg: 'bg-[#D97706]/12', label: 'In Buffer' };
  }
  if (sellableOpen !== undefined && sellableOpen <= 0) {
    return { text: 'text-[#9BA3AE]', bg: 'bg-[#1E2730]/70', label: 'Full' };
  }
  return { text: 'text-[#4ADE80]', bg: 'bg-[#16A34A]/10', label: 'Open' };
}

function statusTextStyle(status: OrderRecord['status']): { label: string; className: string } {
  switch (status) {
    case 'confirmed':
      return { label: 'Confirmed', className: 'text-[#4ADE80]' };
    case 'pre_approved':
      return { label: 'Pre-Approved', className: 'text-[#FBBF24]' };
    case 'slotted':
      return { label: 'Slotted', className: 'text-[#38BDF8]' };
    case 'ignored':
      return { label: 'Ignored', className: 'text-[#8B949E]' };
    default:
      return { label: 'Waitlist', className: 'text-[#C9D1D9]' };
  }
}

export function computeDragAutoScrollStep(
  pointerY: number,
  minEdge: number,
  maxEdge: number,
  edgeZone = 88
): number {
  if (!Number.isFinite(pointerY) || maxEdge <= minEdge || edgeZone <= 0) return 0;
  const effectiveZone = Math.min(edgeZone, (maxEdge - minEdge) / 2);
  if (effectiveZone <= 0) return 0;

  if (pointerY < minEdge + effectiveZone) {
    const ratio = Math.min(1, Math.max(0, (minEdge + effectiveZone - pointerY) / effectiveZone));
    return -Math.round(4 + ratio * ratio * 18);
  }
  if (pointerY > maxEdge - effectiveZone) {
    const ratio = Math.min(1, Math.max(0, (pointerY - (maxEdge - effectiveZone)) / effectiveZone));
    return Math.round(4 + ratio * ratio * 18);
  }
  return 0;
}

export function CalendarWorkspace({
  workspace,
  focusedItemId,
  onChangeFocusedItem,
  onSelectDay,
  onSelectOrder,
  onDropOrderOnDate,
  onSyncNow,
  syncing,
  onAutoSlotAsap,
  autoSlotting,
  onUndo,
  onCreateCheckpoint,
  onRestoreCheckpoint,
  onExtendWeeks,
  onOpenSettings,
  onReconcile,
  onReleaseHold,
  onRestoreIgnored,
  onReorderWaitlist,
  onResetWaitlistOrder,
}: CalendarWorkspaceProps) {
  // Default open on desktop (>=1024px) and closed on mobile so mobile opens directly onto an unobstructed calendar
  const [queueOpen, setQueueOpen] = useState<boolean>(() =>
    typeof window === 'undefined' ? true : window.innerWidth >= 1024
  );
  const [showIgnored, setShowIgnored] = useState(false);
  const [showCheckpoints, setShowCheckpoints] = useState(false);
  const [dragOverDate, setDragOverDate] = useState<string | null>(null);
  const [draggingOrderId, setDraggingOrderId] = useState<number | null>(null);
  const [draggingQueueOrderId, setDraggingQueueOrderId] = useState<number | null>(null);
  const [dragPreviewQueueIds, setDragPreviewQueueIds] = useState<number[] | null>(null);
  const [optimisticQueueIds, setOptimisticQueueIds] = useState<number[] | null>(null);
  const queueScrollRef = useRef<HTMLDivElement | null>(null);
  const calendarScrollRef = useRef<HTMLDivElement | null>(null);
  const isDraggingRef = useRef(false);
  const dragPointerRef = useRef<{ x: number; y: number } | null>(null);
  const autoScrollRafRef = useRef<number | null>(null);

  const activeItems = useMemo(
    () => workspace.items.filter((i) => i.isActive),
    [workspace.items]
  );

  const itemsById = useMemo(
    () => new Map(workspace.items.map((i) => [i.id, i])),
    [workspace.items]
  );

  const channelsById = useMemo(
    () => new Map(workspace.channels.map((c) => [c.id, c])),
    [workspace.channels]
  );

  const ordersByDate = useMemo(() => {
    const map = new Map<string, OrderRecord[]>();
    for (const order of workspace.orders) {
      if (!order.slottedDate || order.status === 'waitlist') continue;
      const list = map.get(order.slottedDate) ?? [];
      list.push(order);
      map.set(order.slottedDate, list);
    }
    return map;
  }, [workspace.orders]);

  useEffect(() => {
    setOptimisticQueueIds(null);
  }, [workspace.orders]);

  const baseUnslottedOrders = useMemo(() => {
    const base = workspace.orders
      .filter((o) => o.status === 'waitlist' || !o.slottedDate)
      .sort((a, b) => compareWaitlistOrders(a, b, workspace.settings.timezone));

    if (!optimisticQueueIds) return base;
    const rankMap = new Map(optimisticQueueIds.map((id, idx) => [id, idx]));
    return [...base].sort((a, b) => {
      const ra = rankMap.get(a.id) ?? Number.MAX_SAFE_INTEGER;
      const rb = rankMap.get(b.id) ?? Number.MAX_SAFE_INTEGER;
      if (ra !== rb) return ra - rb;
      return compareWaitlistOrders(a, b, workspace.settings.timezone);
    });
  }, [workspace.orders, workspace.settings.timezone, optimisticQueueIds]);

  const unslottedOrders = useMemo(() => {
    if (!dragPreviewQueueIds) return baseUnslottedOrders;
    const rankMap = new Map(dragPreviewQueueIds.map((id, idx) => [id, idx]));
    return [...baseUnslottedOrders].sort((a, b) => {
      const ra = rankMap.get(a.id) ?? Number.MAX_SAFE_INTEGER;
      const rb = rankMap.get(b.id) ?? Number.MAX_SAFE_INTEGER;
      if (ra !== rb) return ra - rb;
      return compareWaitlistOrders(a, b, workspace.settings.timezone);
    });
  }, [baseUnslottedOrders, dragPreviewQueueIds]);

  const hasCustomWaitlistOrder = useMemo(
    () =>
      optimisticQueueIds !== null ||
      baseUnslottedOrders.some(
        (o) => typeof o.waitlistSortOrder === 'number' && Number.isFinite(o.waitlistSortOrder)
      ),
    [baseUnslottedOrders, optimisticQueueIds]
  );

  const earliestOpenByOrderId = useMemo(() => {
    const map = new Map<number, { date: string; isoWeekday: number } | null>();
    for (const order of baseUnslottedOrders) {
      if (order.items.length === 0) {
        map.set(order.id, null);
        continue;
      }
      const candidates = evaluateCandidateSlotDates({
        order,
        draftPickupChannelId: order.pickupChannelId,
        days: workspace.days,
        items: workspace.items,
        channels: workspace.channels,
        today: workspace.today,
      });
      const first = candidates.find((c) => c.isFirstAvailable);
      map.set(order.id, first ? { date: first.date, isoWeekday: first.isoWeekday } : null);
    }
    return map;
  }, [baseUnslottedOrders, workspace.days, workspace.items, workspace.channels, workspace.today]);

  const draggedOrder = useMemo(
    () =>
      draggingOrderId !== null
        ? workspace.orders.find((o) => o.id === draggingOrderId) ?? null
        : null,
    [draggingOrderId, workspace.orders]
  );

  const baseDaysByDate = useMemo(
    () => new Map(workspace.days.map((d) => [d.date, d])),
    [workspace.days]
  );

  const displayDays = useMemo(() => {
    if (!draggedOrder || !dragOverDate) return workspace.days;
    return previewOrderMoveProjections(
      workspace.days,
      workspace.items,
      draggedOrder,
      dragOverDate
    );
  }, [workspace.days, workspace.items, draggedOrder, dragOverDate]);

  // Group displayed days (with live hover preview when dragging over a date) into Mon–Sun week rows
  const weekRows = useMemo(() => {
    const rows: CalendarDayProjection[][] = [];
    for (let i = 0; i < displayDays.length; i += 7) {
      rows.push(displayDays.slice(i, i + 7));
    }
    return rows;
  }, [displayDays]);

  const effectiveFocusedId: number | 'all' =
    focusedItemId === 'all'
      ? 'all'
      : activeItems.some((i) => i.id === focusedItemId)
        ? focusedItemId
        : activeItems[0]?.id ?? 'all';

  const focusedItem =
    effectiveFocusedId === 'all' ? null : itemsById.get(effectiveFocusedId) ?? null;

  const formatCompactItems = (order: OrderRecord): string => {
    if (order.items.length === 0) return 'Unassigned items';
    return order.items
      .map((l) => {
        const item = itemsById.get(l.trackedItemId);
        const shortName = item ? item.name.split(' ')[0] : `#${l.trackedItemId}`;
        return `${formatQty(l.quantity)} ${shortName}`;
      })
      .join(' · ');
  };

  const stopDragAutoScroll = useCallback(() => {
    isDraggingRef.current = false;
    dragPointerRef.current = null;
    if (autoScrollRafRef.current !== null && typeof window !== 'undefined') {
      window.cancelAnimationFrame(autoScrollRafRef.current);
      autoScrollRafRef.current = null;
    }
  }, []);

  const performAutoScrollTick = useCallback(() => {
    if (!isDraggingRef.current || typeof window === 'undefined') {
      autoScrollRafRef.current = null;
      return;
    }

    const pointer = dragPointerRef.current;
    if (pointer) {
      let scrolledContainer = false;
      let pointerOverQueue = false;

      // 1. Auto-scroll the Unslotted Waitlist list when dragging near its top/bottom edges
      const queueEl = queueScrollRef.current;
      if (queueEl) {
        const rect = queueEl.getBoundingClientRect();
        const withinHorizontal =
          rect.width > 0 && pointer.x >= rect.left - 24 && pointer.x <= rect.right + 24;
        const withinVertical =
          rect.height > 0 && pointer.y >= rect.top - 72 && pointer.y <= rect.bottom + 72;

        if (withinHorizontal && withinVertical) {
          pointerOverQueue = true;
          if (queueEl.scrollHeight > queueEl.clientHeight + 2) {
            const step = computeDragAutoScrollStep(pointer.y, rect.top, rect.bottom, 88);
            if (step !== 0) {
              const before = queueEl.scrollTop;
              const maxScroll = Math.max(0, queueEl.scrollHeight - queueEl.clientHeight);
              queueEl.scrollTop = Math.min(maxScroll, Math.max(0, before + step));
              if (queueEl.scrollTop !== before) {
                scrolledContainer = true;
              }
            }
          }
        }
      }

      // 2. Otherwise auto-scroll the calendar pane or main window viewport (skip background scroll under mobile overlay)
      const isMobileQueueOverlay = pointerOverQueue && window.innerWidth < 1024;
      if (!scrolledContainer && !isMobileQueueOverlay) {
        const calEl = calendarScrollRef.current;
        if (calEl && calEl.scrollHeight > calEl.clientHeight + 2) {
          const rect = calEl.getBoundingClientRect();
          const withinHorizontal =
            rect.width > 0 && pointer.x >= rect.left - 16 && pointer.x <= rect.right + 16;
          if (withinHorizontal && rect.height > 0) {
            const step = computeDragAutoScrollStep(pointer.y, rect.top, rect.bottom, 96);
            if (step !== 0) {
              const before = calEl.scrollTop;
              const maxScroll = Math.max(0, calEl.scrollHeight - calEl.clientHeight);
              calEl.scrollTop = Math.min(maxScroll, Math.max(0, before + step));
              if (calEl.scrollTop !== before) {
                scrolledContainer = true;
              }
            }
          }
        }

        if (!scrolledContainer && window.innerHeight > 0) {
          const winStep = computeDragAutoScrollStep(pointer.y, 0, window.innerHeight, 108);
          if (winStep !== 0) {
            window.scrollBy(0, winStep);
          }
        }
      }
    }

    autoScrollRafRef.current = window.requestAnimationFrame(performAutoScrollTick);
  }, []);

  const startDragAutoScroll = useCallback(
    (initialX?: number, initialY?: number) => {
      isDraggingRef.current = true;
      if (
        typeof initialX === 'number' &&
        typeof initialY === 'number' &&
        (initialX !== 0 || initialY !== 0)
      ) {
        dragPointerRef.current = { x: initialX, y: initialY };
      }
      if (autoScrollRafRef.current === null && typeof window !== 'undefined') {
        autoScrollRafRef.current = window.requestAnimationFrame(performAutoScrollTick);
      }
    },
    [performAutoScrollTick]
  );

  const updateDragPointer = useCallback((clientX: number, clientY: number) => {
    if (!isDraggingRef.current) return;
    if (clientX === 0 && clientY === 0) return;
    dragPointerRef.current = { x: clientX, y: clientY };
  }, []);

  useEffect(() => {
    if (typeof window === 'undefined') return;
    const handleWindowDragOver = (e: globalThis.DragEvent) => {
      if (!isDraggingRef.current) return;
      updateDragPointer(e.clientX, e.clientY);
    };
    const handleWindowDragStop = () => {
      stopDragAutoScroll();
    };
    window.addEventListener('dragover', handleWindowDragOver, true);
    window.addEventListener('dragend', handleWindowDragStop, true);
    window.addEventListener('drop', handleWindowDragStop, true);
    return () => {
      window.removeEventListener('dragover', handleWindowDragOver, true);
      window.removeEventListener('dragend', handleWindowDragStop, true);
      window.removeEventListener('drop', handleWindowDragStop, true);
      stopDragAutoScroll();
    };
  }, [stopDragAutoScroll, updateDragPointer]);

  const handleDragStart = (e: DragEvent, orderId: number, fromQueue = false) => {
    e.dataTransfer.setData('text/plain', String(orderId));
    e.dataTransfer.effectAllowed = 'move';
    setDraggingOrderId(orderId);
    if (fromQueue) {
      setDraggingQueueOrderId(orderId);
      setDragPreviewQueueIds(null);
    }
    startDragAutoScroll(e.clientX, e.clientY);
  };

  const handleDragEnd = () => {
    stopDragAutoScroll();
    setDraggingOrderId(null);
    setDraggingQueueOrderId(null);
    setDragPreviewQueueIds(null);
    setDragOverDate(null);
  };

  const commitQueueOrder = async (nextIds: number[]) => {
    setOptimisticQueueIds(nextIds);
    if (onReorderWaitlist) {
      try {
        await onReorderWaitlist(nextIds);
      } catch {
        setOptimisticQueueIds(null);
      }
    }
  };

  const handleQueueCardDragOver = (e: DragEvent<HTMLDivElement>, targetOrderId: number) => {
    e.preventDefault();
    e.stopPropagation();
    e.dataTransfer.dropEffect = 'move';
    updateDragPointer(e.clientX, e.clientY);
    if (dragOverDate !== null) {
      setDragOverDate(null);
    }
    if (draggingQueueOrderId === null || draggingQueueOrderId === targetOrderId) {
      return;
    }

    const currentIds = unslottedOrders.map((o) => o.id);
    const fromIdx = currentIds.indexOf(draggingQueueOrderId);
    const toIdx = currentIds.indexOf(targetOrderId);
    if (fromIdx < 0 || toIdx < 0 || fromIdx === toIdx) {
      return;
    }

    // Hysteresis deadband prevents flicker when adjacent waitlist cards have different heights
    const rect = e.currentTarget.getBoundingClientRect();
    if (rect.height > 0 && e.clientY > 0) {
      if (fromIdx < toIdx && e.clientY < rect.top + rect.height * 0.35) {
        return;
      }
      if (fromIdx > toIdx && e.clientY > rect.top + rect.height * 0.65) {
        return;
      }
    }

    const nextIds = [...currentIds];
    const [moved] = nextIds.splice(fromIdx, 1);
    nextIds.splice(toIdx, 0, moved);
    setDragPreviewQueueIds(nextIds);
  };

  const handleQueueDrop = async (e: DragEvent, targetOrderId?: number) => {
    e.preventDefault();
    e.stopPropagation();
    stopDragAutoScroll();
    const rawId = e.dataTransfer?.getData('text/plain');
    const draggedId =
      draggingQueueOrderId ?? (rawId && Number.isInteger(Number(rawId)) ? Number(rawId) : null);

    const baselineIds = baseUnslottedOrders.map((o) => o.id);
    let finalIds: number[] | null = dragPreviewQueueIds;

    // Fallback when drop fires directly onto a card without a prior live-bump dragover
    if (!finalIds && draggedId !== null && targetOrderId !== undefined && draggedId !== targetOrderId) {
      const fromIdx = baselineIds.indexOf(draggedId);
      const toIdx = baselineIds.indexOf(targetOrderId);
      if (fromIdx >= 0 && toIdx >= 0) {
        const nextIds = [...baselineIds];
        const [moved] = nextIds.splice(fromIdx, 1);
        nextIds.splice(toIdx, 0, moved);
        finalIds = nextIds;
      }
    }

    setDraggingOrderId(null);
    setDraggingQueueOrderId(null);
    setDragPreviewQueueIds(null);
    setDragOverDate(null);

    if (!finalIds) return;
    const changed =
      finalIds.length === baselineIds.length &&
      finalIds.some((id, idx) => id !== baselineIds[idx]);
    if (changed) {
      await commitQueueOrder(finalIds);
    }
  };

  const handleMoveQueueOrder = async (orderId: number, direction: -1 | 1) => {
    const currentIds = baseUnslottedOrders.map((o) => o.id);
    const idx = currentIds.indexOf(orderId);
    const nextIdx = idx + direction;
    if (idx < 0 || nextIdx < 0 || nextIdx >= currentIds.length) return;
    const nextIds = [...currentIds];
    const [moved] = nextIds.splice(idx, 1);
    nextIds.splice(nextIdx, 0, moved);
    await commitQueueOrder(nextIds);
  };

  const handleDrop = async (e: DragEvent, date: string) => {
    e.preventDefault();
    stopDragAutoScroll();
    setDragOverDate(null);
    setDraggingOrderId(null);
    setDraggingQueueOrderId(null);
    setDragPreviewQueueIds(null);
    const rawId = e.dataTransfer.getData('text/plain');
    const orderId = Number(rawId);
    if (Number.isInteger(orderId) && orderId > 0) {
      await onDropOrderOnDate(orderId, date);
    }
  };

  const lastSyncLabel = workspace.lastSync?.finishedAt
    ? formatLocalDateTime(new Date(workspace.lastSync.finishedAt), workspace.settings.timezone)
    : 'Never synced';

  // Blank-Slate First Run Screen (Zero sample data seeded)
  if (workspace.items.length === 0) {
    return (
      <main
        className="mx-auto flex max-w-2xl flex-col items-start px-5 py-12 md:px-6 md:py-16"
        data-testid="blank-slate-onboarding"
      >
        <p className="text-xs font-medium text-[#38BDF8]">Clean First-Run Setup</p>
        <h1 className="mt-2 font-['Plus_Jakarta_Sans'] text-2xl font-bold tracking-tight text-[#F0F6FC] sm:text-3xl">
          Welcome to Farm Waitlist
        </h1>
        <p className="mt-3 text-sm leading-relaxed text-[#8B949E]">
          Your database starts as a clean slate with zero dummy customers or sample inventory.
          Configure your real products and pickup days in Settings to begin forecasting supply and
          scheduling waitlists.
        </p>

        <ol className="mt-8 w-full divide-y divide-[#283340] border-y border-[#283340] text-sm">
          <li className="flex flex-col gap-1 py-3.5 sm:flex-row sm:items-baseline sm:justify-between">
            <span className="font-medium text-[#F0F6FC]">01. Add Tracked Items</span>
            <span className="text-xs text-[#8B949E]">
              Units, continuous vs. batch mode &amp; safety buffers
            </span>
          </li>
          <li className="flex flex-col gap-1 py-3.5 sm:flex-row sm:items-baseline sm:justify-between">
            <span className="font-medium text-[#F0F6FC]">02. Configure Pickup Channels</span>
            <span className="text-xs text-[#8B949E]">
              Farm store &amp; farmers&apos; market weekdays
            </span>
          </li>
          <li className="flex flex-col gap-1 py-3.5 sm:flex-row sm:items-baseline sm:justify-between">
            <span className="font-medium text-[#F0F6FC]">03. Optional Odoo 19.3 Sync</span>
            <span className="text-xs text-[#8B949E]">
              Cutoff date, ignored ranges &amp; chatter import
            </span>
          </li>
        </ol>

        <button
          type="button"
          data-testid="blank-slate-open-settings-btn"
          onClick={onOpenSettings}
          className="mt-8 inline-flex min-h-[44px] items-center gap-2 rounded-md bg-[#0EA5E9] px-5 py-2.5 text-sm font-semibold text-[#0B1117] transition-colors hover:bg-[#38BDF8]"
        >
          <Settings className="h-4 w-4" aria-hidden="true" />
          Open Settings to Get Started
        </button>
      </main>
    );
  }

  return (
    <div className="flex min-h-[calc(100vh-59px)] flex-col md:min-h-[calc(100vh-65px)]">
      {/* Operational Utility Strip (clean stacked 2-row layout on mobile, single bar on desktop) */}
      <div className="flex flex-col gap-2.5 border-b border-[#283340] bg-[#161D24] px-4 py-3 lg:flex-row lg:items-center lg:justify-between lg:px-6">
        {/* Tracked Item Focus Selector + All Items Toggle (single-line horizontal scroll on mobile) */}
        <div
          className="flex items-center gap-1.5 overflow-x-auto pb-0.5 lg:pb-0"
          role="tablist"
          aria-label="Focused Tracked Item"
        >
          {activeItems.map((item) => {
            const selected = effectiveFocusedId === item.id;
            return (
              <button
                key={item.id}
                type="button"
                role="tab"
                aria-selected={selected}
                data-testid={`focus-item-${item.id}`}
                onClick={() => onChangeFocusedItem(item.id)}
                className={`min-h-[36px] shrink-0 whitespace-nowrap rounded-md px-3 py-1.5 text-xs font-semibold transition-colors ${
                  selected
                    ? 'bg-[#0EA5E9] text-[#0B1117]'
                    : 'border border-[#283340] bg-[#0F1419] text-[#C9D1D9] hover:border-[#38BDF8]'
                }`}
              >
                {item.name}
              </button>
            );
          })}
          <button
            type="button"
            role="tab"
            aria-selected={effectiveFocusedId === 'all'}
            data-testid="focus-item-all"
            onClick={() => onChangeFocusedItem('all')}
            className={`min-h-[36px] shrink-0 whitespace-nowrap rounded-md px-3 py-1.5 text-xs font-semibold transition-colors ${
              effectiveFocusedId === 'all'
                ? 'bg-[#0EA5E9] text-[#0B1117]'
                : 'border border-[#283340] bg-[#0F1419] text-[#C9D1D9] hover:border-[#38BDF8]'
            }`}
          >
            All Items
          </button>
        </div>

        {/* Action Controls (horizontally scrollable on narrow phones so buttons never overlap) */}
        <div className="flex items-center gap-2 overflow-x-auto pb-0.5 lg:overflow-visible lg:pb-0">
          <div className="mr-1 hidden items-center gap-2 text-xs text-[#8B949E] xl:flex">
            <span data-testid="last-synced-label">Last synced: {lastSyncLabel}</span>
          </div>

          <button
            type="button"
            data-testid="toggle-queue-btn"
            onClick={() => setQueueOpen((prev) => !prev)}
            className="inline-flex min-h-[36px] shrink-0 items-center gap-1.5 whitespace-nowrap rounded-md border border-[#38BDF8]/60 bg-[#0F1419] px-3 py-1.5 text-xs font-semibold text-[#F0F6FC] transition-colors hover:border-[#38BDF8] lg:order-last lg:border-[#283340] lg:font-medium"
          >
            {queueOpen ? (
              <PanelRightClose className="h-3.5 w-3.5" />
            ) : (
              <PanelRightOpen className="h-3.5 w-3.5" />
            )}
            Waitlist ({unslottedOrders.length})
          </button>

          <button
            type="button"
            data-testid="sync-now-btn"
            disabled={syncing || !workspace.odooStatus.configured}
            onClick={() => void onSyncNow()}
            title={
              workspace.odooStatus.configured
                ? 'Sync Draft Quotations & Chatter from Odoo 19.3'
                : 'Configure Odoo credentials in HA add-on options or .env'
            }
            className="inline-flex min-h-[36px] shrink-0 items-center gap-1.5 whitespace-nowrap rounded-md border border-[#283340] bg-[#0F1419] px-3 py-1.5 text-xs font-medium text-[#E6EDF3] transition-colors hover:border-[#38BDF8] disabled:opacity-45"
          >
            <RefreshCw className={`h-3.5 w-3.5 ${syncing ? 'animate-spin' : ''}`} />
            {syncing ? 'Syncing...' : 'Sync Now'}
          </button>

          <button
            type="button"
            data-testid="auto-slot-asap-btn"
            disabled={autoSlotting || unslottedOrders.length === 0}
            onClick={() => void onAutoSlotAsap()}
            className="inline-flex min-h-[36px] shrink-0 items-center gap-1.5 whitespace-nowrap rounded-md border border-[#38BDF8]/60 bg-[#0F1419] px-3 py-1.5 text-xs font-medium text-[#38BDF8] transition-colors hover:bg-[#1E2730] disabled:opacity-45"
          >
            <Sparkles className="h-3.5 w-3.5" />
            {autoSlotting ? 'Slotting...' : 'Auto-Slot ASAP'}
          </button>

          <button
            type="button"
            data-testid="undo-action-btn"
            disabled={workspace.checkpoints.length === 0}
            onClick={() => void onUndo()}
            className="inline-flex min-h-[36px] shrink-0 items-center gap-1.5 whitespace-nowrap rounded-md border border-[#283340] bg-[#0F1419] px-3 py-1.5 text-xs font-medium text-[#C9D1D9] transition-colors hover:border-[#38BDF8] disabled:opacity-40"
          >
            <RotateCcw className="h-3.5 w-3.5" />
            Undo
          </button>

          <div className="relative shrink-0">
            <button
              type="button"
              data-testid="checkpoint-menu-btn"
              onClick={() => setShowCheckpoints((prev) => !prev)}
              className="inline-flex min-h-[36px] shrink-0 items-center gap-1.5 whitespace-nowrap rounded-md border border-[#283340] bg-[#0F1419] px-3 py-1.5 text-xs font-medium text-[#C9D1D9] transition-colors hover:border-[#38BDF8]"
            >
              <Bookmark className="h-3.5 w-3.5" />
              Checkpoints
            </button>
          </div>
        </div>
      </div>

      {/* Viewport-Safe Checkpoints Sheet / Popover (never clips off mobile edges) */}
      {showCheckpoints && (
        <div
          className="fixed inset-0 z-50 flex items-start justify-center bg-black/60 p-4 pt-20 sm:justify-end sm:bg-transparent sm:p-6 sm:pt-28"
          onClick={() => setShowCheckpoints(false)}
        >
          <div
            data-testid="checkpoint-popover"
            onClick={(e) => e.stopPropagation()}
            className="w-full max-w-sm rounded-md border border-[#283340] bg-[#161D24] p-4 shadow-xl sm:w-80"
          >
            <div className="mb-3 flex items-center justify-between">
              <span className="text-xs font-semibold text-[#F0F6FC]">Quick Snapshots</span>
              <div className="flex items-center gap-3">
                <button
                  type="button"
                  data-testid="create-checkpoint-btn"
                  onClick={async () => {
                    await onCreateCheckpoint();
                    setShowCheckpoints(false);
                  }}
                  className="text-xs font-medium text-[#38BDF8] hover:underline"
                >
                  + Save Checkpoint
                </button>
                <button
                  type="button"
                  onClick={() => setShowCheckpoints(false)}
                  className="text-[#8B949E] hover:text-[#F0F6FC]"
                  aria-label="Close checkpoints"
                >
                  <X className="h-4 w-4" />
                </button>
              </div>
            </div>
            {workspace.checkpoints.length === 0 ? (
              <p className="text-xs text-[#8B949E]">No checkpoints captured yet.</p>
            ) : (
              <ul className="max-h-60 divide-y divide-[#283340] overflow-y-auto text-xs">
                {workspace.checkpoints.slice(0, 8).map((cp) => (
                  <li key={cp.id} className="flex items-center justify-between gap-2 py-2.5">
                    <div className="min-w-0">
                      <p className="truncate font-medium text-[#E6EDF3]">{cp.label}</p>
                      <p className="font-mono text-[10px] text-[#8B949E]">
                        {formatLocalDateTime(new Date(cp.createdAt), workspace.settings.timezone)}
                      </p>
                    </div>
                    <button
                      type="button"
                      data-testid={`restore-checkpoint-${cp.id}`}
                      onClick={async () => {
                        await onRestoreCheckpoint(cp.id);
                        setShowCheckpoints(false);
                      }}
                      className="shrink-0 rounded border border-[#283340] bg-[#0F1419] px-2.5 py-1.5 text-[11px] font-medium text-[#38BDF8] hover:border-[#38BDF8]"
                    >
                      Revert
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </div>
        </div>
      )}

      {/* Conditional Overdue / Needs Attention Banner */}
      {workspace.overdueOrders.length > 0 && (
        <div
          data-testid="overdue-banner"
          className="border-b border-[#DC2626]/50 bg-[#DC2626]/10 px-4 py-3 lg:px-6"
        >
          <div className="flex flex-col gap-2 lg:flex-row lg:items-center lg:justify-between">
            <div className="flex items-center gap-2 text-xs font-semibold text-[#F87171]">
              <AlertTriangle className="h-4 w-4 shrink-0" aria-hidden="true" />
              <span>
                Overdue / Needs Attention: {workspace.overdueOrders.length} past-date order(s) still in
                Slotted or Pre-Approved status
              </span>
            </div>
            <div className="flex flex-wrap items-center gap-2">
              {workspace.overdueOrders.map((order) => (
                <div
                  key={order.id}
                  data-testid={`overdue-order-${order.id}`}
                  className="inline-flex items-center gap-2 rounded-md border border-[#DC2626]/40 bg-[#0F1419] px-2.5 py-1 text-xs"
                >
                  <button
                    type="button"
                    onClick={() => onSelectOrder(order)}
                    className="font-medium text-[#F0F6FC] hover:text-[#38BDF8]"
                  >
                    {order.customerName} ({order.slottedDate})
                  </button>
                  <button
                    type="button"
                    data-testid={`overdue-release-${order.id}`}
                    onClick={() => void onReleaseHold(order.id)}
                    className="text-[11px] font-medium text-[#FBBF24] hover:underline"
                  >
                    Return to Waitlist
                  </button>
                </div>
              ))}
            </div>
          </div>
        </div>
      )}

      {/* Conditional Deleted Odoo Quotation Reconciliation Banner (Always 1-click manual confirmation) */}
      {workspace.reconciliationOrders.length > 0 && (
        <div
          data-testid="reconciliation-banner"
          className="border-b border-[#D97706]/50 bg-[#D97706]/10 px-4 py-3 lg:px-6"
        >
          <div className="flex flex-col gap-2">
            <div className="text-xs font-semibold text-[#FBBF24]">
              Odoo Draft Quotations Removed ({workspace.reconciliationOrders.length}) — Confirm paid
              Eat From Farms orders below:
            </div>
            <div className="flex flex-wrap gap-2">
              {workspace.reconciliationOrders.map((order) => (
                <div
                  key={order.id}
                  data-testid={`reconcile-item-${order.id}`}
                  className="flex flex-wrap items-center gap-3 rounded-md border border-[#D97706]/40 bg-[#0F1419] px-3 py-1.5 text-xs"
                >
                  <button
                    type="button"
                    onClick={() => onSelectOrder(order)}
                    className="font-semibold text-[#F0F6FC] hover:text-[#38BDF8]"
                  >
                    {order.customerName}
                  </button>
                  <span className="text-[#8B949E]">
                    {order.odooSuggestedConfirmed
                      ? `Match hint: ${order.odooSuggestedConfirmed.odooOrderName}`
                      : 'No confirmed SO match found'}
                  </span>
                  <button
                    type="button"
                    data-testid={`reconcile-confirm-${order.id}`}
                    onClick={() => void onReconcile(order.id, 'confirm')}
                    className="inline-flex items-center gap-1 rounded bg-[#16A34A] px-2.5 py-1 text-[11px] font-semibold text-white hover:bg-[#22C55E]"
                  >
                    <Check className="h-3 w-3" />
                    Confirm
                  </button>
                  <button
                    type="button"
                    data-testid={`reconcile-keep-${order.id}`}
                    onClick={() => void onReconcile(order.id, 'keep')}
                    className="text-[11px] text-[#C9D1D9] hover:text-white hover:underline"
                  >
                    Keep Open
                  </button>
                </div>
              ))}
            </div>
          </div>
        </div>
      )}

      {/* Main Workspace: Responsive Calendar (Vertical stacked days on mobile, 7-Col Mon-Sun on md+) + Waitlist Drawer/Sidebar */}
      <div className="flex flex-1">
        <div
          ref={calendarScrollRef}
          className="min-w-0 flex-1 overflow-x-auto p-3 sm:p-4 lg:p-6"
        >
          <div className="w-full md:min-w-[760px]">
            {/* Desktop-only Mon-Sun Column Header */}
            <div className="hidden grid-cols-7 border-x border-t border-[#283340] bg-[#161D24] md:grid">
              {WEEKDAY_HEADERS.map((label, idx) => {
                const iso = idx + 1;
                const dayChannels = workspace.channels.filter(
                  (c) => c.isActive && c.allowedWeekdays.includes(iso)
                );
                return (
                  <div
                    key={label}
                    className="border-r border-[#283340] px-3 py-2.5 last:border-r-0"
                  >
                    <div className="text-xs font-semibold text-[#F0F6FC]">{label}</div>
                    {dayChannels.length > 0 && (
                      <div className="mt-0.5 truncate text-[11px] text-[#8B949E]">
                        {dayChannels.map((c) => c.name).join(' · ')}
                      </div>
                    )}
                  </div>
                );
              })}
            </div>

            {/* Week Rows: 1-column full-width day cards on mobile, 7-column Mon-Sun grid on md+ */}
            <div className="divide-y divide-[#283340] border border-[#283340]" data-testid="calendar-grid">
              {weekRows.map((week, wIdx) => (
                <div key={week[0]?.date ?? wIdx}>
                  {/* Mobile Week Divider */}
                  {week[0] && (
                    <div className="border-b border-[#283340] bg-[#161D24] px-3 py-2 text-xs font-semibold text-[#8B949E] md:hidden">
                      Week of {formatShortCalendarDate(week[0].date)}
                    </div>
                  )}
                  <div className="grid grid-cols-1 divide-y divide-[#283340] md:grid-cols-7 md:divide-x md:divide-y-0">
                    {week.map((day) => {
                      const dayOrders = ordersByDate.get(day.date) ?? [];
                      const isDragTarget = dragOverDate === day.date;
                      const baseDay = baseDaysByDate.get(day.date) ?? day;
                      const focusedProj =
                        focusedItem ? day.byItem[focusedItem.id] : undefined;
                      const baseFocusedProj =
                        focusedItem ? baseDay.byItem[focusedItem.id] : undefined;
                      const focusedStyle = focusedProj
                        ? tierStyles(focusedProj.tier, focusedProj.sellableOpen)
                        : null;
                      const focusedPreviewChanged = Boolean(
                        draggedOrder &&
                          dragOverDate &&
                          focusedProj &&
                          baseFocusedProj &&
                          (focusedProj.startingBalance !== baseFocusedProj.startingBalance ||
                            focusedProj.slottedQty !== baseFocusedProj.slottedQty ||
                            focusedProj.sellableOpen !== baseFocusedProj.sellableOpen ||
                            focusedProj.endingBalance !== baseFocusedProj.endingBalance ||
                            focusedProj.reservedForFuture !== baseFocusedProj.reservedForFuture ||
                            focusedProj.tier !== baseFocusedProj.tier)
                      );
                      const focusedDisplayDelta =
                        focusedPreviewChanged && focusedProj && baseFocusedProj
                          ? Math.round((focusedProj.sellableOpen - baseFocusedProj.sellableOpen) * 1000) /
                            1000
                          : 0;
                      const dayChannels = workspace.channels.filter(
                        (c) => c.isActive && isChannelActiveOnDate(c, day.date, day.isoWeekday)
                      );
                      const eventDateChannels = workspace.channels.filter(
                        (c) =>
                          c.isActive &&
                          (c.specificDates ?? []).includes(day.date) &&
                          !c.allowedWeekdays.includes(day.isoWeekday)
                      );
                      const showPreviewChipHere = Boolean(
                        isDragTarget &&
                          draggedOrder &&
                          !(
                            draggedOrder.slottedDate === day.date &&
                            draggedOrder.status !== 'waitlist'
                          )
                      );
                      const draggedChannel =
                        draggedOrder?.pickupChannelId
                          ? channelsById.get(draggedOrder.pickupChannelId) ?? null
                          : null;
                      const previewOffSchedule = Boolean(
                        showPreviewChipHere &&
                          draggedChannel &&
                          channelHasScheduleRestriction(draggedChannel) &&
                          !isChannelActiveOnDate(draggedChannel, day.date, day.isoWeekday)
                      );

                      return (
                        <div
                          key={day.date}
                          data-testid={`calendar-day-${day.date}`}
                          onDragOver={(e) => {
                            e.preventDefault();
                            e.dataTransfer.dropEffect = 'move';
                            updateDragPointer(e.clientX, e.clientY);
                            if (dragPreviewQueueIds !== null) {
                              setDragPreviewQueueIds(null);
                            }
                            if (dragOverDate !== day.date) setDragOverDate(day.date);
                          }}
                          onDragLeave={(e) => {
                            const nextTarget = e.relatedTarget as Node | null;
                            if (nextTarget && e.currentTarget.contains(nextTarget)) {
                              return;
                            }
                            if (dragOverDate === day.date) setDragOverDate(null);
                          }}
                          onDrop={(e) => void handleDrop(e, day.date)}
                          className={`flex flex-col transition-colors md:min-h-[172px] ${
                            isDragTarget
                              ? 'bg-[#0EA5E9]/15 ring-1 ring-inset ring-[#38BDF8]'
                              : day.isToday
                                ? 'bg-[#18232E]'
                                : day.isPast
                                  ? 'bg-[#0F1419]/75 opacity-75'
                                  : 'bg-[#131A20]'
                          }`}
                        >
                          {/* Clickable Day Header + Availability Summary */}
                          <button
                            type="button"
                            data-testid={`day-header-${day.date}`}
                            onClick={() => onSelectDay(baseDay)}
                            className="w-full border-b border-[#283340]/80 px-3 py-2.5 text-left transition-colors hover:bg-[#1E2730] md:px-2.5 md:py-2"
                          >
                            <div className="flex items-center justify-between gap-2">
                              <div className="min-w-0">
                                <span
                                  className={`font-mono text-xs font-semibold tabular-nums ${
                                    day.isToday ? 'text-[#38BDF8]' : 'text-[#E6EDF3]'
                                  }`}
                                >
                                  <span className="md:hidden">
                                    {ISO_WEEKDAY_LABELS[day.isoWeekday]},{' '}
                                  </span>
                                  {formatShortCalendarDate(day.date)}
                                  {day.isToday ? ' · Today' : ''}
                                </span>
                                {dayChannels.length > 0 && (
                                  <span className="ml-2 text-[11px] text-[#8B949E] md:hidden">
                                    {dayChannels.map((c) => c.name).join(' · ')}
                                  </span>
                                )}
                              </div>
                                {focusedStyle && (
                                  <span
                                    data-testid={`day-tier-${day.date}`}
                                    className={`shrink-0 font-mono text-[11px] font-semibold tabular-nums ${focusedStyle.text}`}
                                  >
                                    {focusedStyle.label}
                                  </span>
                                )}
                              </div>

                              {(eventDateChannels.length > 0 || focusedProj?.notes) && (
                                <div className="mt-1 space-y-0.5">
                                  {eventDateChannels.length > 0 && (
                                    <div
                                      data-testid={`day-event-channels-${day.date}`}
                                      className="truncate text-[10px] font-semibold text-[#38BDF8]"
                                    >
                                      Event: {eventDateChannels.map((c) => c.name).join(' · ')}
                                    </div>
                                  )}
                                  {focusedProj?.notes && (
                                    <div
                                      title={focusedProj.notes}
                                      className="truncate text-[10px] text-[#8B949E]"
                                    >
                                      {focusedProj.notes}
                                    </div>
                                  )}
                                </div>
                              )}

                            {/* Focused Single Item View (On Hand + ATP Can Sell) */}
                            {focusedItem && focusedProj && focusedStyle && (
                              <div
                                data-testid={`day-metrics-${day.date}`}
                                data-preview-impacted={focusedPreviewChanged ? 'true' : undefined}
                                className={`mt-1.5 rounded-md border px-2 py-1.5 tabular-nums transition-colors ${focusedStyle.bg} ${
                                  focusedPreviewChanged
                                    ? 'border-[#38BDF8]/70 ring-1 ring-[#38BDF8]/40'
                                    : 'border-white/5'
                                }`}
                              >
                                {/* Primary Hero Metric: Can Sell / Short */}
                                <div
                                  className={`flex flex-wrap items-baseline justify-between gap-x-1.5 ${focusedStyle.text}`}
                                >
                                  <span className="whitespace-nowrap font-sans text-[10px] font-semibold uppercase tracking-wide opacity-90">
                                    {focusedProj.endingBalance < 0 ? 'Short' : 'Can Sell'}
                                  </span>
                                  <span className="whitespace-nowrap font-mono text-sm font-bold leading-tight">
                                    {focusedProj.endingBalance < 0
                                      ? formatQty(Math.abs(focusedProj.endingBalance))
                                      : formatQty(Math.max(0, focusedProj.sellableOpen))}
                                    <span className="ml-1 font-sans text-[10px] font-medium opacity-80">
                                      {focusedItem.unitLabel}
                                    </span>
                                    {focusedDisplayDelta !== 0 && (
                                      <span
                                        data-testid={`day-preview-delta-${day.date}`}
                                        className={`ml-1 rounded px-1 py-0.2 font-mono text-[10px] font-semibold ${
                                          focusedDisplayDelta > 0
                                            ? 'bg-[#16A34A]/25 text-[#4ADE80]'
                                            : 'bg-[#0EA5E9]/25 text-[#7DD3FC]'
                                        }`}
                                      >
                                        {focusedDisplayDelta > 0
                                          ? `+${formatQty(focusedDisplayDelta)}`
                                          : `-${formatQty(Math.abs(focusedDisplayDelta))}`}
                                      </span>
                                    )}
                                  </span>
                                </div>

                                {/* Secondary Breakdown: One clean row per metric */}
                                <div className="mt-1.5 space-y-0.5 border-t border-white/10 pt-1 text-[11px] leading-snug">
                                  <div
                                    className="flex items-baseline justify-between gap-2"
                                    title={
                                      focusedProj.slottedQty > 0
                                        ? `Morning on-hand ${formatQty(focusedProj.startingBalance)}, minus ${formatQty(focusedProj.slottedQty)} slotted today = ${formatQty(focusedProj.endingBalance)} remaining`
                                        : (focusedProj.actualOnHand !== null ||
                                              focusedProj.actualEndOfDay != null) &&
                                            day.date > workspace.today
                                          ? `Manual physical count override on a future date — disconnects carry-over between days`
                                          : `Physical stock on hand this morning`
                                    }
                                  >
                                    <span className="flex items-center gap-1 whitespace-nowrap font-sans text-[10px] text-[#9BA3AE]">
                                      <span>On Hand</span>
                                      {(focusedProj.actualOnHand !== null ||
                                        focusedProj.actualEndOfDay != null) &&
                                        day.date > workspace.today && (
                                          <span
                                            data-testid={`day-future-override-${day.date}`}
                                            className="rounded bg-[#D97706]/20 px-1 py-0.2 text-[9px] font-semibold text-[#FBBF24]"
                                          >
                                            Override
                                          </span>
                                        )}
                                    </span>
                                    <span className="whitespace-nowrap font-mono font-medium text-[#E6EDF3]">
                                      {formatQty(focusedProj.startingBalance)}
                                      {focusedProj.slottedQty > 0 && (
                                        <span className="text-[10px] text-[#8B949E]">
                                          {' '}
                                          (-{formatQty(focusedProj.slottedQty)})
                                        </span>
                                      )}
                                    </span>
                                  </div>

                                  {focusedProj.effectiveBuffer > 0 && (
                                    <div
                                      data-testid={
                                        focusedProj.extraBuffer > 0
                                          ? `day-extra-buf-${day.date}`
                                          : undefined
                                      }
                                      title={
                                        focusedProj.extraBuffer > 0
                                          ? `Safety buffer: ${formatQty(focusedProj.effectiveBuffer)} ${focusedItem.unitLabel} (includes +${formatQty(focusedProj.extraBuffer)} extra single-day holdback)`
                                          : `Safety buffer held back: ${formatQty(focusedProj.effectiveBuffer)} ${focusedItem.unitLabel}`
                                      }
                                      className={`flex items-baseline justify-between gap-2 ${
                                        focusedProj.extraBuffer > 0
                                          ? 'text-[#38BDF8]'
                                          : 'text-[#8B949E]'
                                      }`}
                                    >
                                      <span className="whitespace-nowrap font-sans text-[10px] font-medium">
                                        {focusedProj.extraBuffer > 0 ? 'Buf (+Ext)' : 'Buffer'}
                                      </span>
                                      <span className="whitespace-nowrap font-mono text-[10px] font-medium">
                                        -{formatQty(focusedProj.effectiveBuffer)}
                                        {focusedProj.extraBuffer > 0
                                          ? ` (+${formatQty(focusedProj.extraBuffer)})`
                                          : ''}
                                      </span>
                                    </div>
                                  )}

                                  <div
                                    className="flex items-baseline justify-between gap-2"
                                    title="Afternoon harvest rolls into tomorrow's on-hand inventory"
                                  >
                                    <span className="whitespace-nowrap font-sans text-[10px] text-[#8B949E]">
                                      Harv→
                                    </span>
                                    <span className="whitespace-nowrap font-mono text-[#9BA3AE]">
                                      +{formatQty(focusedProj.estProduced)}
                                    </span>
                                  </div>

                                  {focusedProj.endingBalance >= 0 &&
                                  focusedProj.availablePhysical < 0 &&
                                  focusedProj.constrainedByDate ? (
                                    <div
                                      data-testid={`day-future-short-${day.date}`}
                                      title={`Projected shortage of ${formatQty(Math.abs(focusedProj.availablePhysical))} ${focusedItem.unitLabel} on ${formatShortCalendarDate(focusedProj.constrainedByDate)}`}
                                      className="flex items-baseline justify-between gap-2 pt-0.5 text-[#F87171]"
                                    >
                                      <span className="whitespace-nowrap font-sans text-[10px] font-medium">
                                        Short
                                      </span>
                                      <span className="whitespace-nowrap font-mono text-[10px] font-semibold">
                                        {formatQty(Math.abs(focusedProj.availablePhysical))} →{' '}
                                        {formatShortCalendarDate(focusedProj.constrainedByDate)}
                                      </span>
                                    </div>
                                  ) : (
                                    focusedProj.reservedForFuture > 0 &&
                                    focusedProj.constrainedByDate && (
                                      <div
                                        data-testid={`day-held-${day.date}`}
                                        title={`${formatQty(focusedProj.reservedForFuture)} ${focusedItem.unitLabel} on hand is reserved to cover orders or event holdbacks on ${formatShortCalendarDate(focusedProj.constrainedByDate)}`}
                                        className="flex items-baseline justify-between gap-2 pt-0.5 text-[#FBBF24]"
                                      >
                                        <span className="whitespace-nowrap font-sans text-[10px] font-medium">
                                          Held
                                        </span>
                                        <span className="whitespace-nowrap font-mono text-[10px] font-semibold">
                                          {formatQty(focusedProj.reservedForFuture)} →{' '}
                                          {formatShortCalendarDate(focusedProj.constrainedByDate)}
                                        </span>
                                      </div>
                                    )
                                  )}
                                </div>
                              </div>
                            )}

                            {/* All Items Overview Mode */}
                            {effectiveFocusedId === 'all' && (
                              <div
                                data-testid={`day-all-metrics-${day.date}`}
                                className="mt-1.5 space-y-1 font-mono text-[11px] tabular-nums"
                              >
                                {activeItems.map((item) => {
                                  const p = day.byItem[item.id];
                                  const baseP = baseDay.byItem[item.id];
                                  if (!p) return null;
                                  const st = tierStyles(p.tier, p.sellableOpen);
                                  const itemPreviewChanged = Boolean(
                                    draggedOrder &&
                                      dragOverDate &&
                                      baseP &&
                                      (p.endingBalance !== baseP.endingBalance ||
                                        p.sellableOpen !== baseP.sellableOpen ||
                                        p.tier !== baseP.tier)
                                  );
                                  return (
                                    <div
                                      key={item.id}
                                      className={`flex items-center justify-between gap-1 ${
                                        itemPreviewChanged
                                          ? '-mx-1 rounded bg-[#0EA5E9]/12 px-1 py-0.5 ring-1 ring-[#38BDF8]/40'
                                          : ''
                                      }`}
                                    >
                                      <span className="truncate font-sans text-[11px] text-[#C9D1D9]">
                                        {item.name}
                                      </span>
                                      <span className="shrink-0 text-[10px] text-[#8B949E]">
                                        OH {formatQty(p.endingBalance)} ·{' '}
                                        <span className={`font-semibold ${st.text}`}>
                                          {p.endingBalance < 0
                                            ? `Short ${formatQty(Math.abs(p.endingBalance))}`
                                            : `Sell ${formatQty(Math.max(0, p.sellableOpen))}`}
                                        </span>
                                      </span>
                                    </div>
                                  );
                                })}
                              </div>
                            )}
                          </button>

                          {/* Slotted Order Chips */}
                          <div className="flex-1 space-y-1.5 p-2.5 md:p-2">
                            {dayOrders.length === 0 && !showPreviewChipHere && (
                              <p className="py-1 text-[11px] text-[#6E7681] md:hidden">
                                No slotted orders
                              </p>
                            )}
                            {showPreviewChipHere && draggedOrder && (
                              <div
                                data-testid="drag-preview-chip"
                                className={`pointer-events-none rounded border border-dashed px-2.5 py-2 md:px-2 md:py-1.5 ${
                                  previewOffSchedule
                                    ? 'border-[#FBBF24] bg-[#D97706]/15'
                                    : 'border-[#38BDF8] bg-[#0EA5E9]/15'
                                }`}
                              >
                                <div className="flex items-center justify-between gap-1">
                                  <span className="truncate text-xs font-semibold text-[#F0F6FC]">
                                    {draggedOrder.customerName}
                                  </span>
                                  <span
                                    className={`shrink-0 rounded px-1 py-0.5 text-[9px] font-semibold uppercase tracking-wide ${
                                      previewOffSchedule
                                        ? 'bg-[#D97706]/30 text-[#FBBF24]'
                                        : 'bg-[#0EA5E9]/30 text-[#7DD3FC]'
                                    }`}
                                  >
                                    {previewOffSchedule ? 'Off-Day' : 'Preview'}
                                  </span>
                                </div>
                                <div className="mt-0.5 truncate font-mono text-[11px] tabular-nums text-[#E6EDF3]">
                                  {formatCompactItems(draggedOrder)}
                                </div>
                              </div>
                            )}
                            {dayOrders.map((order) => {
                              const st = statusTextStyle(order.status);
                              const ch = order.pickupChannelId
                                ? channelsById.get(order.pickupChannelId)
                                : null;
                              const agingHours =
                                order.status === 'pre_approved'
                                  ? getAgingHoldHours(order.preApprovedAt)
                                  : null;
                              const overThreshold =
                                agingHours !== null &&
                                agingHours >= workspace.settings.holdThresholdHours;
                              const isMovingAway =
                                draggingOrderId === order.id &&
                                dragOverDate !== null &&
                                dragOverDate !== day.date;

                              return (
                                <button
                                  key={order.id}
                                  type="button"
                                  draggable={!order.isLocked}
                                  data-testid={`order-chip-${order.id}`}
                                  onDragStart={(e) => handleDragStart(e, order.id)}
                                  onDragEnd={handleDragEnd}
                                  onClick={() => onSelectOrder(order)}
                                  className={`w-full rounded border px-2.5 py-2 text-left transition-all hover:border-[#38BDF8] hover:bg-[#1E2730] md:px-2 md:py-1.5 ${
                                    isMovingAway
                                      ? 'border-dashed border-[#38BDF8]/60 bg-[#1A222B]/50 opacity-40'
                                      : 'border-[#283340] bg-[#1A222B]'
                                  }`}
                                >
                                  <div className="flex items-center justify-between gap-1">
                                    <span className="truncate text-xs font-semibold text-[#F0F6FC]">
                                      {order.customerName}
                                    </span>
                                    {order.isLocked && (
                                      <Lock
                                        className="h-3 w-3 shrink-0 text-[#8B949E]"
                                        aria-label="Locked order"
                                      />
                                    )}
                                  </div>
                                  <div className="mt-0.5 truncate font-mono text-[11px] tabular-nums text-[#C9D1D9]">
                                    {formatCompactItems(order)}
                                  </div>
                                  <div className="mt-1 flex flex-wrap items-center gap-x-1.5 text-[10px]">
                                    <span className={`font-medium ${st.className}`}>{st.label}</span>
                                    {ch && (
                                      <>
                                        <span className="text-[#484F58]">·</span>
                                        <span className="truncate text-[#8B949E]">{ch.name}</span>
                                      </>
                                    )}
                                    {overThreshold && agingHours !== null && (
                                      <>
                                        <span className="text-[#484F58]">·</span>
                                        <span className="font-semibold text-[#FBBF24]">
                                          {formatAgingBadge(agingHours)}
                                        </span>
                                      </>
                                    )}
                                    {order.odooUpdatedAfterSlot && (
                                      <>
                                        <span className="text-[#484F58]">·</span>
                                        <span className="font-semibold text-[#38BDF8]">
                                          Updated in Odoo
                                        </span>
                                      </>
                                    )}
                                  </div>
                                </button>
                              );
                            })}
                          </div>
                        </div>
                      );
                    })}
                  </div>
                </div>
              ))}
            </div>

            <div className="mt-4 flex flex-wrap items-center justify-between gap-2 text-xs text-[#8B949E]">
              <span>
                Showing {workspace.weeks} weeks ({workspace.startDate} to {workspace.endDate}) ·
                Afternoon harvests roll into next day&apos;s stock
              </span>
              <button
                type="button"
                data-testid="extend-weeks-btn"
                onClick={onExtendWeeks}
                className="inline-flex min-h-[36px] items-center gap-1 rounded-md border border-[#283340] bg-[#161D24] px-3 py-1.5 text-xs font-medium text-[#E6EDF3] hover:border-[#38BDF8]"
              >
                Load +2 More Weeks
                <ChevronRight className="h-3.5 w-3.5" />
              </button>
            </div>
          </div>
        </div>

        {/* Unslotted Waitlist Queue: Slide-over Drawer on Mobile (< lg), Sticky Viewport-Height Sidebar on Desktop (lg+) */}
        {queueOpen && (
          <div className="fixed inset-0 z-40 flex justify-end bg-black/65 lg:sticky lg:top-[65px] lg:inset-auto lg:z-auto lg:block lg:h-[calc(100vh-65px)] lg:shrink-0 lg:bg-transparent">
            <aside
              data-testid="unslotted-queue-sidebar"
              className="flex h-full w-full max-w-sm shrink-0 flex-col border-l border-[#283340] bg-[#161D24] lg:w-80"
            >
              <div
                onDragOver={(e) => {
                  if (draggingQueueOrderId !== null) {
                    e.preventDefault();
                    e.dataTransfer.dropEffect = 'move';
                    updateDragPointer(e.clientX, e.clientY);
                  }
                }}
                className="border-b border-[#283340] px-4 py-3"
              >
                <div className="flex items-center justify-between gap-2">
                  <div>
                    <h2 className="font-['Plus_Jakarta_Sans'] text-sm font-bold text-[#F0F6FC]">
                      Unslotted Waitlist
                    </h2>
                    <p className="text-[11px] text-[#8B949E]">
                      Drag to prioritize or drop onto a day
                    </p>
                  </div>
                  <div className="flex items-center gap-2">
                    <button
                      type="button"
                      data-testid="toggle-ignored-orders-btn"
                      onClick={() => setShowIgnored((prev) => !prev)}
                      className="text-xs font-medium text-[#8B949E] hover:text-[#38BDF8]"
                    >
                      {showIgnored
                        ? `Active (${unslottedOrders.length})`
                        : `Ignored (${workspace.ignoredOrders.length})`}
                    </button>
                    <button
                      type="button"
                      data-testid="close-mobile-queue-btn"
                      onClick={() => setQueueOpen(false)}
                      className="flex h-8 w-8 items-center justify-center rounded-md text-[#8B949E] hover:bg-[#1E2730] hover:text-[#F0F6FC] lg:hidden"
                      aria-label="Close waitlist drawer"
                    >
                      <X className="h-4 w-4" />
                    </button>
                  </div>
                </div>
                {!showIgnored && unslottedOrders.length > 1 && (
                  <div className="mt-2 flex items-center justify-between gap-2 text-[11px]">
                    <span className="text-[#8B949E]">
                      {hasCustomWaitlistOrder
                        ? 'Custom priority order'
                        : 'Sorted by arrival date (oldest first)'}
                    </span>
                    {hasCustomWaitlistOrder && onResetWaitlistOrder && (
                      <button
                        type="button"
                        data-testid="reset-waitlist-order-btn"
                        onClick={() => {
                          setOptimisticQueueIds(null);
                          void onResetWaitlistOrder();
                        }}
                        className="font-medium text-[#38BDF8] hover:underline"
                      >
                        Reset to Arrival
                      </button>
                    )}
                  </div>
                )}
              </div>

              <div
                ref={queueScrollRef}
                data-testid="unslotted-queue-scroll"
                onDragOver={(e) => {
                  if (draggingQueueOrderId !== null) {
                    e.preventDefault();
                    e.dataTransfer.dropEffect = 'move';
                    updateDragPointer(e.clientX, e.clientY);
                    if (dragOverDate !== null) {
                      setDragOverDate(null);
                    }
                  }
                }}
                onDrop={(e) => {
                  if (draggingQueueOrderId !== null) {
                    void handleQueueDrop(e);
                  }
                }}
                className="flex-1 space-y-2 overflow-y-auto p-3"
              >
                {showIgnored ? (
                  workspace.ignoredOrders.length === 0 ? (
                    <p className="py-8 text-center text-xs text-[#8B949E]">
                      No ignored Odoo quotations.
                    </p>
                  ) : (
                    workspace.ignoredOrders.map((order) => (
                      <div
                        key={order.id}
                        data-testid={`ignored-order-${order.id}`}
                        className="rounded-md border border-[#283340] bg-[#0F1419] p-3"
                      >
                        <div className="flex items-center justify-between gap-2">
                          <span className="truncate text-xs font-semibold text-[#C9D1D9]">
                            {order.customerName}
                          </span>
                          <button
                            type="button"
                            data-testid={`restore-ignored-${order.id}`}
                            onClick={() => void onRestoreIgnored(order.id)}
                            className="shrink-0 text-xs font-medium text-[#38BDF8] hover:underline"
                          >
                            Restore
                          </button>
                        </div>
                        {order.odooQuotationName && (
                          <p className="mt-1 font-mono text-[11px] text-[#8B949E]">
                            {order.odooQuotationName}
                          </p>
                        )}
                      </div>
                    ))
                  )
                ) : unslottedOrders.length === 0 ? (
                  <p
                    data-testid="empty-waitlist-queue"
                    className="py-10 text-center text-xs text-[#8B949E]"
                  >
                    Waitlist queue is clear. Use Quick Add Order or Sync Now to pull new requests.
                  </p>
                ) : (
                  unslottedOrders.map((order, idx) => {
                    const ch = order.pickupChannelId
                      ? channelsById.get(order.pickupChannelId)
                      : null;
                    const arrival = getOrderArrivalInfo(
                      order,
                      workspace.settings.timezone,
                      workspace.today
                    );
                    const isDraggingThis = draggingQueueOrderId === order.id;

                    return (
                      <div
                        key={order.id}
                        draggable
                        data-testid={`queue-order-${order.id}`}
                        onDragStart={(e) => handleDragStart(e, order.id, true)}
                        onDragEnd={handleDragEnd}
                        onDragOver={(e) => handleQueueCardDragOver(e, order.id)}
                        onDrop={(e) => void handleQueueDrop(e, order.id)}
                        onClick={() => {
                          onSelectOrder(order);
                          if (typeof window !== 'undefined' && window.innerWidth < 1024) {
                            setQueueOpen(false);
                          }
                        }}
                        role="button"
                        tabIndex={0}
                        onKeyDown={(e) => {
                          if (e.key === 'Enter' || e.key === ' ') {
                            e.preventDefault();
                            onSelectOrder(order);
                          }
                        }}
                        className={`relative cursor-grab rounded-md border p-3 transition-all duration-150 active:cursor-grabbing ${
                          isDraggingThis
                            ? 'border-dashed border-[#38BDF8] bg-[#0EA5E9]/12 ring-1 ring-[#38BDF8]/50'
                            : order.status === 'confirmed'
                              ? 'border-[#283340] border-l-2 border-l-[#22C55E] bg-[#0F1419] hover:border-[#38BDF8]'
                              : 'border-[#283340] bg-[#0F1419] hover:border-[#38BDF8]'
                        }`}
                      >
                        {/* Prominent Arrival Date & Priority Rank Bar */}
                        <div className="mb-2 flex items-center justify-between gap-2 border-b border-[#283340]/70 pb-1.5">
                          <div className="flex min-w-0 items-center gap-1.5">
                            <GripVertical
                              className={`h-3.5 w-3.5 shrink-0 ${
                                isDraggingThis ? 'text-[#38BDF8]' : 'text-[#6E7681]'
                              }`}
                              aria-hidden="true"
                            />
                            <span
                              className={`font-mono text-[10px] font-semibold tabular-nums ${
                                isDraggingThis ? 'text-[#38BDF8]' : 'text-[#8B949E]'
                              }`}
                            >
                              #{idx + 1}
                            </span>
                            <span
                              data-testid={`queue-arrived-${order.id}`}
                              title={`Order arrived ${arrival.fullLabel}`}
                              className="inline-flex min-w-0 items-center gap-1 truncate rounded bg-[#1E2730] px-1.5 py-0.5 text-[11px] font-semibold text-[#F0F6FC]"
                            >
                              <CalendarClock
                                className="h-3 w-3 shrink-0 text-[#38BDF8]"
                                aria-hidden="true"
                              />
                              <span className="truncate">Arrived {arrival.shortLabel}</span>
                              {arrival.ageLabel && (
                                <span className="shrink-0 font-normal text-[#9BA3AE]">
                                  ({arrival.ageLabel})
                                </span>
                              )}
                            </span>
                          </div>

                          {unslottedOrders.length > 1 && (
                            <div
                              className="flex shrink-0 items-center gap-0.5"
                              onClick={(e) => e.stopPropagation()}
                            >
                              <button
                                type="button"
                                disabled={idx === 0}
                                data-testid={`queue-move-up-${order.id}`}
                                aria-label={`Move ${order.customerName} up in waitlist`}
                                title="Move up"
                                onClick={(e) => {
                                  e.stopPropagation();
                                  void handleMoveQueueOrder(order.id, -1);
                                }}
                                className="flex h-6 w-6 items-center justify-center rounded text-[#8B949E] hover:bg-[#1E2730] hover:text-[#38BDF8] disabled:opacity-25"
                              >
                                <ArrowUp className="h-3 w-3" aria-hidden="true" />
                              </button>
                              <button
                                type="button"
                                disabled={idx === unslottedOrders.length - 1}
                                data-testid={`queue-move-down-${order.id}`}
                                aria-label={`Move ${order.customerName} down in waitlist`}
                                title="Move down"
                                onClick={(e) => {
                                  e.stopPropagation();
                                  void handleMoveQueueOrder(order.id, 1);
                                }}
                                className="flex h-6 w-6 items-center justify-center rounded text-[#8B949E] hover:bg-[#1E2730] hover:text-[#38BDF8] disabled:opacity-25"
                              >
                                <ArrowDown className="h-3 w-3" aria-hidden="true" />
                              </button>
                            </div>
                          )}
                        </div>

                        <div className="flex items-start justify-between gap-2">
                          <span className="truncate text-xs font-semibold text-[#F0F6FC]">
                            {order.customerName}
                          </span>
                          <span className="shrink-0 text-[10px] font-medium text-[#8B949E]">
                            {order.status === 'confirmed' ? (
                              <span className="font-semibold text-[#4ADE80]">
                                Confirmed · Needs Date
                              </span>
                            ) : !order.requestedDate ? (
                              'ASAP'
                            ) : null}
                          </span>
                        </div>

                        {order.requestedDate && (
                          <div
                            data-testid={`queue-requested-pickup-${order.id}`}
                            title={`Customer requested pickup on ${order.requestedDate}`}
                            className={`mt-1.5 flex items-center justify-between gap-2 rounded-md border px-2 py-1 text-[11px] font-semibold ${
                              order.requestedDate < workspace.today
                                ? 'border-[#DC2626]/50 bg-[#DC2626]/12 text-[#FCA5A5]'
                                : 'border-[#D97706]/55 bg-[#D97706]/15 text-[#FBBF24]'
                            }`}
                          >
                            <span className="inline-flex min-w-0 items-center gap-1.5 truncate">
                              <Calendar className="h-3.5 w-3.5 shrink-0" aria-hidden="true" />
                              <span className="truncate">
                                Requested Pickup:{' '}
                                {ISO_WEEKDAY_LABELS[getIsoWeekday(order.requestedDate)]},{' '}
                                {formatShortCalendarDate(order.requestedDate)}
                              </span>
                            </span>
                            {order.requestedDate === workspace.today ? (
                              <span className="shrink-0 rounded bg-[#D97706]/30 px-1 py-0.5 text-[10px] font-bold uppercase tracking-wide text-[#FDE68A]">
                                Today
                              </span>
                            ) : order.requestedDate < workspace.today ? (
                              <span className="shrink-0 rounded bg-[#DC2626]/30 px-1 py-0.5 text-[10px] font-bold uppercase tracking-wide text-[#FECACA]">
                                Past
                              </span>
                            ) : null}
                          </div>
                        )}
                        <div className="mt-1 font-mono text-[11px] tabular-nums text-[#C9D1D9]">
                          {formatCompactItems(order)}
                        </div>
                        <div className="mt-1.5 flex items-center gap-1.5 text-[11px] text-[#8B949E]">
                          <span className="capitalize">{order.source}</span>
                          {order.odooQuotationName && (
                            <>
                              <span aria-hidden="true">·</span>
                              <span className="font-mono">{order.odooQuotationName}</span>
                            </>
                          )}
                          {(ch?.name || order.freeTextPickup) && (
                            <>
                              <span aria-hidden="true">·</span>
                              <span className="truncate">{ch?.name || order.freeTextPickup}</span>
                            </>
                          )}
                          {ch && channelHasScheduleRestriction(ch) && (
                            <>
                              <span aria-hidden="true">·</span>
                              <span>
                                {ch.allowedWeekdays.length > 0
                                  ? ch.allowedWeekdays.map((d) => ISO_WEEKDAY_LABELS[d]).join('/')
                                  : `${(ch.specificDates ?? []).length} event date(s)`}
                              </span>
                            </>
                          )}
                        </div>
                        <div
                          data-testid={`queue-earliest-${order.id}`}
                          className="mt-1.5 border-t border-[#283340]/70 pt-1.5 text-[11px] font-medium"
                        >
                          {(() => {
                            if (order.items.length === 0) {
                              return (
                                <span className="text-[#8B949E]">
                                  Tap to assign items &amp; schedule
                                </span>
                              );
                            }
                            const earliest = earliestOpenByOrderId.get(order.id);
                            if (earliest) {
                              return (
                                <span className="text-[#4ADE80]">
                                  Earliest open: {ISO_WEEKDAY_LABELS[earliest.isoWeekday]},{' '}
                                  {formatShortCalendarDate(earliest.date)}
                                </span>
                              );
                            }
                            return (
                              <span className="text-[#FBBF24]">
                                No open slot in {workspace.weeks}w · Tap to inspect
                              </span>
                            );
                          })()}
                        </div>
                      </div>
                    );
                  })
                )}
              </div>
            </aside>
          </div>
        )}
      </div>
    </div>
  );
}
