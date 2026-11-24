import { AlertTriangle, ArrowRight, CalendarPlus, Check, RotateCcw, X } from 'lucide-react';
import { useEffect, useState } from 'react';
import { formatQty } from '../shared/generators';
import { computeTier, isChannelActiveOnDate } from '../shared/supplyEngine';
import { formatFullDisplayDate, formatShortCalendarDate } from '../shared/timezone';
import type { CalendarDayProjection, PickupChannel, TrackedItem } from '../shared/types';

function roundQty(value: number): number {
  return Math.round(value * 1000) / 1000;
}

function parseOptionalNumber(raw: string): number | null {
  const trimmed = raw.trim();
  if (trimmed === '') return null;
  const parsed = Number(trimmed);
  return Number.isFinite(parsed) ? roundQty(parsed) : null;
}

function formatVariance(actual: number, expected: number): { label: string; positive: boolean } | null {
  const diff = roundQty(actual - expected);
  if (diff === 0) return null;
  return {
    label: `${diff > 0 ? '+' : '-'}${formatQty(Math.abs(diff))}`,
    positive: diff > 0,
  };
}

interface DayDetailDrawerProps {
  day: CalendarDayProjection | null;
  today?: string;
  nextDay?: CalendarDayProjection | null;
  items: TrackedItem[];
  channels: PickupChannel[];
  initialFocusedItemId: number | 'all';
  onClose: () => void;
  onSaveSupply: (
    itemId: number,
    date: string,
    payload: {
      actualOnHand: number | null;
      estProduced: number | null;
      actualEndOfDay: number | null;
      cascadeForward: boolean;
      bufferOverride: number | null;
      extraBuffer: number;
      notes: string | null;
    }
  ) => Promise<void>;
  onClearActualOverride?: (
    itemId: number,
    date: string,
    scope?: 'morning' | 'both'
  ) => Promise<void>;
  onToggleChannelDate?: (channel: PickupChannel, date: string, attach: boolean) => Promise<void>;
}

export function DayDetailDrawer({
  day,
  today,
  nextDay,
  items,
  channels,
  initialFocusedItemId,
  onClose,
  onSaveSupply,
  onClearActualOverride,
  onToggleChannelDate,
}: DayDetailDrawerProps) {
  const activeItems = items.filter((i) => i.isActive);
  const [selectedItemId, setSelectedItemId] = useState<number>(
    initialFocusedItemId !== 'all'
      ? initialFocusedItemId
      : activeItems[0]?.id ?? 0
  );
  const [actualOnHand, setActualOnHand] = useState<string>('');
  const [estProduced, setEstProduced] = useState<string>('');
  const [actualEndOfDay, setActualEndOfDay] = useState<string>('');
  const [extraBuffer, setExtraBuffer] = useState<string>('');
  const [bufferOverride, setBufferOverride] = useState<string>('');
  const [notes, setNotes] = useState<string>('');
  const [saving, setSaving] = useState(false);
  const [togglingChannelId, setTogglingChannelId] = useState<number | null>(null);
  const [pendingOverrideCascade, setPendingOverrideCascade] = useState<boolean | null>(null);

  useEffect(() => {
    if (!day) return;
    const defaultId =
      initialFocusedItemId !== 'all' && activeItems.some((i) => i.id === initialFocusedItemId)
        ? initialFocusedItemId
        : activeItems[0]?.id ?? 0;
    setSelectedItemId(defaultId);
  }, [day?.date, initialFocusedItemId]);

  const currentItem = activeItems.find((i) => i.id === selectedItemId) ?? activeItems[0];
  const proj = day && currentItem ? day.byItem[currentItem.id] : undefined;

  useEffect(() => {
    if (!proj) return;
    setActualOnHand(proj.actualOnHand !== null ? String(proj.actualOnHand) : '');
    setEstProduced(proj.isManualProducedOverride ? String(proj.estProduced) : '');
    setActualEndOfDay(
      proj.actualEndOfDay !== null && proj.actualEndOfDay !== undefined
        ? String(proj.actualEndOfDay)
        : ''
    );
    setExtraBuffer(proj.extraBuffer > 0 ? String(proj.extraBuffer) : '');
    const savedBase = proj.hasBufferOverride
      ? Math.max(0, Number((proj.effectiveBuffer - proj.extraBuffer).toFixed(3)))
      : null;
    setBufferOverride(savedBase !== null ? String(savedBase) : '');
    setNotes(proj.notes ?? '');
    setPendingOverrideCascade(null);
  }, [
    day?.date,
    currentItem?.id,
    proj?.actualOnHand,
    proj?.estProduced,
    proj?.actualEndOfDay,
    proj?.isManualProducedOverride,
    proj?.effectiveBuffer,
    proj?.extraBuffer,
    proj?.hasBufferOverride,
    proj?.notes,
  ]);

  if (!day) return null;

  const activeChannelsForDay = channels.filter(
    (c) => c.isActive && isChannelActiveOnDate(c, day.date, day.isoWeekday)
  );
  // Channels that are NOT already scheduled via regular weekday on this date can be toggled onto this specific event date
  const toggleableEventChannels = channels.filter(
    (c) => c.isActive && !c.allowedWeekdays.includes(day.isoWeekday)
  );

  const previewBaseBuffer =
    bufferOverride.trim() !== '' && Number.isFinite(Number(bufferOverride))
      ? Math.max(0, Number(bufferOverride))
      : currentItem?.globalSafetyBuffer ?? 0;
  const previewExtraBuffer =
    extraBuffer.trim() !== '' && Number.isFinite(Number(extraBuffer))
      ? Math.max(0, Number(extraBuffer))
      : 0;
  const previewTotalBuffer = roundQty(previewBaseBuffer + previewExtraBuffer);

  // Live daily inventory math (updates immediately as user types in any of the 3 adjustment inputs)
  const expectedMorning = proj
    ? proj.expectedStartingBalance ?? proj.startingBalance
    : 0;
  const parsedMorning = parseOptionalNumber(actualOnHand);
  const liveMorning = parsedMorning ?? expectedMorning;
  const morningVariance =
    parsedMorning !== null ? formatVariance(parsedMorning, expectedMorning) : null;

  const slottedQty = proj?.slottedQty ?? 0;
  const liveEndingBalance = roundQty(liveMorning - slottedQty);

  const expectedHarvest = proj ? proj.expectedProduced ?? proj.estProduced : 0;
  const parsedHarvest = parseOptionalNumber(estProduced);
  const liveHarvest = parsedHarvest ?? expectedHarvest;
  const harvestVariance =
    parsedHarvest !== null ? formatVariance(parsedHarvest, expectedHarvest) : null;

  const liveExpectedEndOfDay = roundQty(liveEndingBalance + liveHarvest);
  const parsedEndOfDay = parseOptionalNumber(actualEndOfDay);
  const liveTomorrowStarting = parsedEndOfDay ?? liveExpectedEndOfDay;
  const eodVariance =
    parsedEndOfDay !== null ? formatVariance(parsedEndOfDay, liveExpectedEndOfDay) : null;

  const savedEod = proj?.actualEndOfDay ?? null;
  const inputsMatchSaved = Boolean(
    proj &&
      parsedMorning === proj.actualOnHand &&
      parsedEndOfDay === savedEod &&
      previewTotalBuffer === proj.effectiveBuffer
  );

  const liveRawSellable = roundQty(liveEndingBalance - previewTotalBuffer);
  const morningDelta = proj ? roundQty(liveMorning - proj.startingBalance) : 0;
  const liveSellableOpen = !proj
    ? 0
    : inputsMatchSaved
      ? proj.sellableOpen
      : parsedEndOfDay !== null
        ? liveRawSellable
        : proj.reservedForFuture > 0
          ? roundQty(Math.min(liveRawSellable, proj.sellableOpen + morningDelta))
          : liveRawSellable;
  const liveAvailablePhysical = !proj
    ? 0
    : inputsMatchSaved
      ? proj.availablePhysical
      : parsedEndOfDay !== null
        ? liveEndingBalance
        : proj.reservedForFuture > 0
          ? roundQty(Math.min(liveEndingBalance, proj.availablePhysical + morningDelta))
          : liveEndingBalance;
  const liveReservedForFuture = !proj
    ? 0
    : inputsMatchSaved
      ? proj.reservedForFuture
      : parsedEndOfDay !== null
        ? 0
        : Math.min(Math.max(0, liveEndingBalance), Math.max(0, roundQty(liveRawSellable - liveSellableOpen)));
  const liveTier = computeTier(liveAvailablePhysical, liveSellableOpen);

  const isNotToday = Boolean(today && day.date !== today);
  const isOverwritingMorning = Boolean(
    proj && parsedMorning !== null && parsedMorning !== proj.actualOnHand
  );
  const isOverwritingEod = Boolean(proj && parsedEndOfDay !== null && parsedEndOfDay !== savedEod);
  const shouldWarnNonTodayOverride = isNotToday && (isOverwritingMorning || isOverwritingEod);

  const executeSave = async (cascadeForward: boolean) => {
    if (!currentItem) return;
    setSaving(true);
    try {
      const nextEstProduced =
        parsedHarvest !== null ? parsedHarvest : cascadeForward ? expectedHarvest : null;
      await onSaveSupply(currentItem.id, day.date, {
        actualOnHand: parsedMorning,
        estProduced: nextEstProduced,
        actualEndOfDay: parsedEndOfDay,
        cascadeForward,
        bufferOverride: bufferOverride.trim() === '' ? null : Math.max(0, Number(bufferOverride)),
        extraBuffer: extraBuffer.trim() === '' ? 0 : Math.max(0, Number(extraBuffer)),
        notes: notes.trim() || null,
      });
      setPendingOverrideCascade(null);
    } finally {
      setSaving(false);
    }
  };

  const handleSave = async (cascadeForward: boolean) => {
    if (!currentItem) return;
    if (shouldWarnNonTodayOverride) {
      setPendingOverrideCascade(cascadeForward);
      return;
    }
    await executeSave(cascadeForward);
  };

  const isFutureDay = Boolean(today && day.date > today);
  const nextDayProj = nextDay && currentItem ? nextDay.byItem[currentItem.id] : undefined;
  const nextDayHasManualOverride = Boolean(nextDay && nextDayProj && nextDayProj.actualOnHand !== null);
  const currentDayHasFutureOverride = Boolean(
    isFutureDay && proj && (proj.actualOnHand !== null || (proj.actualEndOfDay ?? null) !== null)
  );

  const tierTextClass =
    liveTier === 'red'
      ? 'text-[#F87171]'
      : liveTier === 'amber'
        ? 'text-[#FBBF24]'
        : liveSellableOpen <= 0
          ? 'text-[#9BA3AE]'
          : 'text-[#4ADE80]';
  const tierLabel =
    liveTier === 'red'
      ? 'Deficit'
      : liveTier === 'amber'
        ? 'In Buffer'
        : liveSellableOpen <= 0
          ? 'Full'
          : 'Open';

  return (
    <div
      className="fixed inset-0 z-50 flex justify-end bg-black/60"
      data-testid="day-detail-drawer"
      role="dialog"
      aria-modal="true"
      aria-label={`Day supply details for ${day.date}`}
    >
      <div className="flex h-full w-full max-w-lg flex-col border-l border-[#283340] bg-[#161D24] text-[#E6EDF3]">
        <div className="flex items-start justify-between border-b border-[#283340] px-6 py-4">
          <div>
            <h2 className="font-['Plus_Jakarta_Sans'] text-lg font-bold text-[#F0F6FC]">
              {formatFullDisplayDate(day.date)}
            </h2>
            <p className="mt-0.5 text-xs text-[#8B949E]">
              {day.isToday ? 'Today · ' : ''}
              {activeChannelsForDay.length > 0
                ? activeChannelsForDay.map((c) => c.name).join(' · ')
                : 'No scheduled pickup channels'}
            </p>
          </div>
          <button
            type="button"
            data-testid="close-day-drawer-btn"
            onClick={onClose}
            className="flex h-9 w-9 items-center justify-center rounded-md text-[#8B949E] hover:bg-[#1E2730] hover:text-[#F0F6FC]"
            aria-label="Close day detail drawer"
          >
            <X className="h-5 w-5" />
          </button>
        </div>

        <div className="flex-1 space-y-5 overflow-y-auto px-6 py-5">
          {activeItems.length > 1 && (
            <div>
              <label className="mb-2 block text-xs font-medium text-[#8B949E]">
                Tracked Item
              </label>
              <div className="flex flex-wrap gap-1.5">
                {activeItems.map((item) => (
                  <button
                    key={item.id}
                    type="button"
                    data-testid={`day-drawer-item-${item.id}`}
                    onClick={() => setSelectedItemId(item.id)}
                    className={`min-h-[36px] whitespace-nowrap rounded-md px-3 py-1.5 text-xs font-medium transition-colors ${
                      currentItem?.id === item.id
                        ? 'bg-[#0EA5E9] text-[#0B1117]'
                        : 'border border-[#283340] bg-[#1E2730] text-[#C9D1D9] hover:border-[#38BDF8]'
                    }`}
                  >
                    {item.name}
                  </button>
                ))}
              </div>
            </div>
          )}

          {currentItem && proj ? (
            <>
              {/* Header status row */}
              <div className="flex flex-wrap items-baseline justify-between gap-2">
                <span className="text-sm font-semibold text-[#F0F6FC]">
                  {currentItem.name}{' '}
                  <span className="text-xs font-normal text-[#8B949E]">
                    ({currentItem.unitLabel})
                  </span>
                </span>
                <span className={`font-mono text-xs font-semibold tabular-nums ${tierTextClass}`}>
                  {liveEndingBalance < 0
                    ? `Deficit (${formatQty(liveEndingBalance)} ${currentItem.unitLabel})`
                    : liveAvailablePhysical < 0 && proj.constrainedByDate && parsedEndOfDay === null
                      ? `Short ${formatQty(Math.abs(liveAvailablePhysical))} on ${formatShortCalendarDate(proj.constrainedByDate)} · Can Sell 0`
                      : `${tierLabel} · Can Sell ${formatQty(Math.max(0, liveSellableOpen))} ${currentItem.unitLabel}`}
                </span>
              </div>

              {/* Inline Daily Inventory Flow: Expected right next to Actual / Adjustment */}
              <div className="overflow-hidden rounded-md border border-[#283340] bg-[#0F1419]/75">
                <div className="grid grid-cols-[minmax(0,1fr)_auto_136px] items-center gap-3 border-b border-[#283340] bg-[#121920] px-3.5 py-2 text-[10px] font-semibold uppercase tracking-wider text-[#8B949E]">
                  <span>Stage of Day</span>
                  <span className="text-right">Expected</span>
                  <span className="text-right">Actual / Adjust</span>
                </div>

                {/* 1. Morning Count (Beginning of Day) */}
                <div className="grid grid-cols-[minmax(0,1fr)_auto_136px] items-center gap-3 border-b border-[#283340]/80 px-3.5 py-3">
                  <div className="min-w-0">
                    <label
                      htmlFor="day-actual-on-hand"
                      className="block text-xs font-semibold text-[#F0F6FC]"
                    >
                      Morning Count
                    </label>
                    <p className="mt-0.5 text-[11px] text-[#8B949E]">
                      {parsedMorning !== null ? (
                        <span className="text-[#38BDF8]">Adjusted morning stock</span>
                      ) : (
                        'Beginning of day carry-over'
                      )}
                    </p>
                  </div>
                  <div className="text-right">
                    <span
                      data-testid="day-morning-expected"
                      className="font-mono text-sm font-semibold tabular-nums text-[#C9D1D9]"
                    >
                      {formatQty(expectedMorning)}
                    </span>
                    {morningVariance && (
                      <div
                        className={`font-mono text-[10px] font-semibold tabular-nums ${
                          morningVariance.positive ? 'text-[#4ADE80]' : 'text-[#FBBF24]'
                        }`}
                      >
                        {morningVariance.label}
                      </div>
                    )}
                  </div>
                  <div className="flex flex-col items-end gap-1">
                    <div className="flex w-full items-center gap-1">
                      <input
                        id="day-actual-on-hand"
                        data-testid="day-actual-on-hand-input"
                        type="number"
                        step="0.5"
                        value={actualOnHand}
                        onChange={(e) => setActualOnHand(e.target.value)}
                        placeholder={formatQty(expectedMorning)}
                        aria-label="Morning count adjustment"
                        className={`min-h-[38px] w-full rounded-md border bg-[#161D24] px-2.5 py-1.5 text-right font-mono text-sm tabular-nums text-[#F0F6FC] placeholder:text-[#6E7681] focus:border-[#38BDF8] focus:outline-none ${
                          parsedMorning !== null ? 'border-[#38BDF8]/80' : 'border-[#283340]'
                        }`}
                      />
                      {actualOnHand.trim() !== '' && (
                        <button
                          type="button"
                          onClick={() => setActualOnHand('')}
                          title="Use expected morning carry-over"
                          aria-label="Clear morning adjustment"
                          className="flex h-8 w-8 shrink-0 items-center justify-center rounded border border-[#283340] bg-[#161D24] text-[#8B949E] hover:border-[#38BDF8] hover:text-[#38BDF8]"
                        >
                          <RotateCcw className="h-3.5 w-3.5" aria-hidden="true" />
                        </button>
                      )}
                    </div>
                  </div>
                </div>

                {/* Daytime Orders & Sellable Sub-Strip */}
                <div className="space-y-1.5 border-b border-[#283340]/80 bg-[#131A21]/70 px-3.5 py-2.5 text-xs">
                  <div className="flex items-center justify-between gap-2">
                    <span className="text-[#8B949E]">Slotted Orders Today</span>
                    <span className="font-mono tabular-nums text-[#E6EDF3]">
                      -{formatQty(slottedQty)}
                    </span>
                  </div>
                  <div className="flex items-center justify-between gap-2">
                    <span className="text-[#8B949E]">Remaining Before Harvest</span>
                    <span className="font-mono font-semibold tabular-nums text-[#F0F6FC]">
                      {formatQty(liveEndingBalance)}
                    </span>
                  </div>
                  <div className="flex items-center justify-between gap-2">
                    <span className="text-[#8B949E]">
                      Safety Buffer
                      {previewExtraBuffer > 0
                        ? ` (+${formatQty(previewExtraBuffer)} extra)`
                        : bufferOverride.trim() !== ''
                          ? ' (override)'
                          : ''}
                    </span>
                    <span className="font-mono tabular-nums text-[#C9D1D9]">
                      -{formatQty(previewTotalBuffer)}
                    </span>
                  </div>
                  {liveReservedForFuture > 0 && (
                    <div className="flex items-center justify-between gap-2 text-[#FBBF24]">
                      <span>
                        Reserved for Future
                        {proj.constrainedByDate
                          ? ` (${formatShortCalendarDate(proj.constrainedByDate)})`
                          : ''}
                      </span>
                      <span className="font-mono font-semibold tabular-nums">
                        -{formatQty(liveReservedForFuture)}
                      </span>
                    </div>
                  )}
                  <div className="flex items-center justify-between gap-2 border-t border-[#283340]/70 pt-1.5">
                    <span className="font-medium text-[#C9D1D9]">Can Sell Today</span>
                    <span className={`font-mono font-semibold tabular-nums ${tierTextClass}`}>
                      {formatQty(Math.max(0, liveSellableOpen))}
                      {liveSellableOpen < 0 ? ` (${formatQty(liveSellableOpen)} net)` : ''}
                    </span>
                  </div>
                </div>

                {/* 2. Afternoon Harvest */}
                <div className="grid grid-cols-[minmax(0,1fr)_auto_136px] items-center gap-3 border-b border-[#283340]/80 px-3.5 py-3">
                  <div className="min-w-0">
                    <label
                      htmlFor="day-est-produced"
                      className="block text-xs font-semibold text-[#F0F6FC]"
                    >
                      {currentItem.supplyMode === 'continuous'
                        ? 'Afternoon Harvest'
                        : 'Afternoon Batch'}
                    </label>
                    <p className="mt-0.5 text-[11px] text-[#8B949E]">
                      {parsedHarvest !== null ? (
                        <span className="text-[#38BDF8]">Adjusted harvest count</span>
                      ) : (
                        'Rolls into tomorrow morning'
                      )}
                    </p>
                  </div>
                  <div className="text-right">
                    <span
                      data-testid="day-harvest-expected"
                      className="font-mono text-sm font-semibold tabular-nums text-[#38BDF8]"
                    >
                      +{formatQty(expectedHarvest)}
                    </span>
                    {harvestVariance && (
                      <div
                        className={`font-mono text-[10px] font-semibold tabular-nums ${
                          harvestVariance.positive ? 'text-[#4ADE80]' : 'text-[#FBBF24]'
                        }`}
                      >
                        {harvestVariance.label}
                      </div>
                    )}
                  </div>
                  <div className="flex flex-col items-end gap-1">
                    <div className="flex w-full items-center gap-1">
                      <input
                        id="day-est-produced"
                        data-testid="day-est-produced-input"
                        type="number"
                        step="0.5"
                        value={estProduced}
                        onChange={(e) => setEstProduced(e.target.value)}
                        placeholder={formatQty(expectedHarvest)}
                        aria-label="Afternoon harvest adjustment"
                        className={`min-h-[38px] w-full rounded-md border bg-[#161D24] px-2.5 py-1.5 text-right font-mono text-sm tabular-nums text-[#F0F6FC] placeholder:text-[#6E7681] focus:border-[#38BDF8] focus:outline-none ${
                          parsedHarvest !== null ? 'border-[#38BDF8]/80' : 'border-[#283340]'
                        }`}
                      />
                      {estProduced.trim() !== '' && (
                        <button
                          type="button"
                          onClick={() => setEstProduced('')}
                          title="Reset to expected harvest rate"
                          aria-label="Clear harvest adjustment"
                          className="flex h-8 w-8 shrink-0 items-center justify-center rounded border border-[#283340] bg-[#161D24] text-[#8B949E] hover:border-[#38BDF8] hover:text-[#38BDF8]"
                        >
                          <RotateCcw className="h-3.5 w-3.5" aria-hidden="true" />
                        </button>
                      )}
                    </div>
                  </div>
                </div>

                {/* 3. End of Day (After Harvest -> Tomorrow's Morning) */}
                <div className="grid grid-cols-[minmax(0,1fr)_auto_136px] items-center gap-3 px-3.5 py-3">
                  <div className="min-w-0">
                    <label
                      htmlFor="day-actual-end-of-day"
                      className="block text-xs font-semibold text-[#F0F6FC]"
                    >
                      End of Day (After Harvest)
                    </label>
                    <p className="mt-0.5 text-[11px] text-[#8B949E]">
                      {parsedEndOfDay !== null ? (
                        <span className="text-[#38BDF8]">Sets tomorrow&apos;s morning count</span>
                      ) : (
                        'Remaining + afternoon harvest'
                      )}
                    </p>
                  </div>
                  <div className="text-right">
                    <span
                      data-testid="day-eod-expected"
                      className="font-mono text-sm font-semibold tabular-nums text-[#C9D1D9]"
                    >
                      {formatQty(liveExpectedEndOfDay)}
                    </span>
                    {eodVariance && (
                      <div
                        className={`font-mono text-[10px] font-semibold tabular-nums ${
                          eodVariance.positive ? 'text-[#4ADE80]' : 'text-[#FBBF24]'
                        }`}
                      >
                        {eodVariance.label}
                      </div>
                    )}
                  </div>
                  <div className="flex flex-col items-end gap-1">
                    <div className="flex w-full items-center gap-1">
                      <input
                        id="day-actual-end-of-day"
                        data-testid="day-actual-end-of-day-input"
                        type="number"
                        step="0.5"
                        value={actualEndOfDay}
                        onChange={(e) => setActualEndOfDay(e.target.value)}
                        placeholder={formatQty(liveExpectedEndOfDay)}
                        aria-label="End of day actual count adjustment"
                        className={`min-h-[38px] w-full rounded-md border bg-[#161D24] px-2.5 py-1.5 text-right font-mono text-sm tabular-nums text-[#F0F6FC] placeholder:text-[#6E7681] focus:border-[#38BDF8] focus:outline-none ${
                          parsedEndOfDay !== null ? 'border-[#38BDF8]/80' : 'border-[#283340]'
                        }`}
                      />
                      {actualEndOfDay.trim() !== '' && (
                        <button
                          type="button"
                          onClick={() => setActualEndOfDay('')}
                          title="Use calculated end-of-day count"
                          aria-label="Clear end of day adjustment"
                          className="flex h-8 w-8 shrink-0 items-center justify-center rounded border border-[#283340] bg-[#161D24] text-[#8B949E] hover:border-[#38BDF8] hover:text-[#38BDF8]"
                        >
                          <RotateCcw className="h-3.5 w-3.5" aria-hidden="true" />
                        </button>
                      )}
                    </div>
                  </div>
                </div>

                {/* Tomorrow carry-over footer strip */}
                <div className="flex items-center justify-between gap-2 border-t border-[#283340] bg-[#121920] px-3.5 py-2.5 text-xs">
                  <span className="font-medium text-[#C9D1D9]">
                    Tomorrow Morning Starts With
                  </span>
                  <span
                    data-testid="day-tomorrow-starting"
                    className="font-mono font-semibold tabular-nums text-[#F0F6FC]"
                  >
                    {formatQty(liveTomorrowStarting)} {currentItem.unitLabel}
                    {parsedEndOfDay !== null && (
                      <span className="ml-1.5 font-sans text-[10px] font-medium text-[#38BDF8]">
                        (actual EOD)
                      </span>
                    )}
                  </span>
                </div>
              </div>

              {liveReservedForFuture > 0 && proj.constrainedByDate && parsedEndOfDay === null && (
                <p className="rounded border border-[#D97706]/30 bg-[#D97706]/10 px-3 py-2 text-[11px] text-[#FBBF24]">
                  Holding {formatQty(liveReservedForFuture)} {currentItem.unitLabel} on hand so
                  orders &amp; buffers on {formatShortCalendarDate(proj.constrainedByDate)} remain
                  covered.
                </p>
              )}

              {nextDayHasManualOverride && nextDay && nextDayProj && (
                <div
                  data-testid="day-next-override-warning"
                  className="rounded border border-[#D97706]/50 bg-[#D97706]/10 px-3 py-2.5 text-[11px] text-[#FBBF24]"
                >
                  <p>
                    <strong className="text-[#FDE68A]">
                      {formatShortCalendarDate(nextDay.date)}
                    </strong>{' '}
                    has a manual Morning override (
                    <span className="font-mono font-semibold">
                      {formatQty(nextDayProj.actualOnHand!)} {currentItem.unitLabel}
                    </span>
                    ), so this day&apos;s end-of-day stock isn&apos;t carrying into{' '}
                    {formatShortCalendarDate(nextDay.date)} and future orders aren&apos;t reserving
                    against this day.
                  </p>
                  {onClearActualOverride && (
                    <button
                      type="button"
                      disabled={saving}
                      data-testid="clear-next-day-override-btn"
                      onClick={async () => {
                        setSaving(true);
                        try {
                          await onClearActualOverride(currentItem.id, nextDay.date, 'morning');
                        } finally {
                          setSaving(false);
                        }
                      }}
                      className="mt-2 inline-flex min-h-[32px] items-center rounded border border-[#D97706]/70 bg-[#0F1419] px-2.5 py-1 text-[11px] font-semibold text-[#FBBF24] hover:bg-[#D97706]/20 disabled:opacity-50"
                    >
                      Clear {formatShortCalendarDate(nextDay.date)} Override &amp; Reconnect
                    </button>
                  )}
                </div>
              )}

              {currentDayHasFutureOverride && (
                <div
                  data-testid="day-future-override-warning"
                  className="rounded border border-[#D97706]/50 bg-[#D97706]/10 px-3 py-2.5 text-[11px] text-[#FBBF24]"
                >
                  <p>
                    This future date has a manual count override (
                    {proj.actualOnHand !== null && (
                      <span className="font-mono font-semibold">
                        Morning: {formatQty(proj.actualOnHand)} {currentItem.unitLabel}
                      </span>
                    )}
                    {proj.actualOnHand !== null && proj.actualEndOfDay != null ? ' · ' : ''}
                    {proj.actualEndOfDay != null && (
                      <span className="font-mono font-semibold">
                        End of Day: {formatQty(proj.actualEndOfDay)} {currentItem.unitLabel}
                      </span>
                    )}
                    ). Leave future counts blank so carry-over and reservations flow automatically.
                  </p>
                  {onClearActualOverride && (
                    <button
                      type="button"
                      disabled={saving}
                      data-testid="day-clear-actual-btn"
                      onClick={async () => {
                        setSaving(true);
                        try {
                          await onClearActualOverride(currentItem.id, day.date, 'both');
                        } finally {
                          setSaving(false);
                        }
                      }}
                      className="mt-2 inline-flex min-h-[32px] items-center rounded border border-[#D97706]/70 bg-[#0F1419] px-2.5 py-1 text-[11px] font-semibold text-[#FBBF24] hover:bg-[#D97706]/20 disabled:opacity-50"
                    >
                      Clear Override (Use Auto Carry-Over)
                    </button>
                  )}
                </div>
              )}

              <div className="space-y-4">
                {/* Single-Day Additional Safety Buffer / Event Walk-Up Holdback */}
                <div className="rounded-md border border-[#283340] bg-[#0F1419]/60 p-3.5">
                  <label
                    htmlFor="day-extra-buffer"
                    className="mb-1.5 block text-xs font-semibold text-[#F0F6FC]"
                  >
                    Additional Safety Buffer / Walk-Up Holdback (+{currentItem.unitLabel})
                  </label>
                  <input
                    id="day-extra-buffer"
                    data-testid="day-extra-buffer-input"
                    type="number"
                    step="0.5"
                    min="0"
                    value={extraBuffer}
                    onChange={(e) => setExtraBuffer(e.target.value)}
                    placeholder="0 (e.g., 15 for event walk-ups or last-minute orders)"
                    className="min-h-[40px] w-full rounded-md border border-[#283340] bg-[#0F1419] px-3 py-2 font-mono text-sm tabular-nums text-[#F0F6FC] placeholder:font-sans placeholder:text-[#6E7681] focus:border-[#38BDF8] focus:outline-none"
                  />
                  <p className="mt-1.5 text-xs text-[#8B949E]">
                    Adds extra holdback on <strong className="text-[#E6EDF3]">this day only</strong>{' '}
                    and automatically reserves stock on earlier days so walk-up stock isn&apos;t
                    oversold.
                  </p>
                  <div className="mt-2 font-mono text-[11px] tabular-nums text-[#38BDF8]">
                    Effective buffer on this day: {formatQty(previewTotalBuffer)}{' '}
                    {currentItem.unitLabel} ({formatQty(previewBaseBuffer)}{' '}
                    {bufferOverride.trim() !== '' ? 'override' : 'global'}
                    {previewExtraBuffer > 0 ? ` + ${formatQty(previewExtraBuffer)} extra` : ''})
                  </div>

                  <div className="mt-3 border-t border-[#283340]/80 pt-3">
                    <label
                      htmlFor="day-buffer-override"
                      className="mb-1 block text-[11px] font-medium text-[#8B949E]"
                    >
                      Base Safety Buffer Override (Global default:{' '}
                      {formatQty(currentItem.globalSafetyBuffer)})
                    </label>
                    <input
                      id="day-buffer-override"
                      data-testid="day-buffer-override-input"
                      type="number"
                      step="0.5"
                      min="0"
                      value={bufferOverride}
                      onChange={(e) => setBufferOverride(e.target.value)}
                      placeholder={`Global default (${formatQty(currentItem.globalSafetyBuffer)})`}
                      className="min-h-[36px] w-full rounded-md border border-[#283340] bg-[#0F1419] px-3 py-1.5 font-mono text-xs tabular-nums text-[#F0F6FC] placeholder:font-sans placeholder:text-[#6E7681] focus:border-[#38BDF8] focus:outline-none"
                    />
                  </div>
                </div>

                {/* One-Off / Monthly Event Pickup Channels on this specific date */}
                {onToggleChannelDate && toggleableEventChannels.length > 0 && (
                  <div className="rounded-md border border-[#283340] bg-[#0F1419]/60 p-3.5">
                    <div className="mb-2 flex items-center gap-1.5 text-xs font-semibold text-[#F0F6FC]">
                      <CalendarPlus className="h-3.5 w-3.5 text-[#38BDF8]" aria-hidden="true" />
                      <span>Event / One-Off Channels on This Date</span>
                    </div>
                    <p className="mb-2.5 text-[11px] text-[#8B949E]">
                      Tap a channel to schedule or remove it on {formatShortCalendarDate(day.date)}:
                    </p>
                    <div className="flex flex-wrap gap-1.5">
                      {toggleableEventChannels.map((ch) => {
                        const attached = (ch.specificDates ?? []).includes(day.date);
                        const busy = togglingChannelId === ch.id;
                        return (
                          <button
                            key={ch.id}
                            type="button"
                            disabled={busy}
                            data-testid={`day-toggle-channel-${ch.id}`}
                            onClick={async () => {
                              setTogglingChannelId(ch.id);
                              try {
                                await onToggleChannelDate(ch, day.date, !attached);
                              } finally {
                                setTogglingChannelId(null);
                              }
                            }}
                            className={`inline-flex min-h-[34px] items-center gap-1.5 rounded-md border px-2.5 py-1 text-xs font-medium transition-colors disabled:opacity-50 ${
                              attached
                                ? 'border-[#38BDF8] bg-[#0EA5E9]/20 text-[#38BDF8]'
                                : 'border-[#283340] bg-[#161D24] text-[#C9D1D9] hover:border-[#38BDF8]'
                            }`}
                          >
                            {attached && <Check className="h-3.5 w-3.5" aria-hidden="true" />}
                            {ch.name}
                          </button>
                        );
                      })}
                    </div>
                  </div>
                )}

                <div>
                  <label
                    htmlFor="day-notes"
                    className="mb-1.5 block text-xs font-medium text-[#C9D1D9]"
                  >
                    Day / Event Note
                  </label>
                  <textarea
                    id="day-notes"
                    data-testid="day-notes-input"
                    rows={2}
                    value={notes}
                    onChange={(e) => setNotes(e.target.value)}
                    placeholder="Optional note (e.g., Monthly brewery pop-up, walk-up holdback)"
                    className="w-full rounded-md border border-[#283340] bg-[#0F1419] px-3 py-2 text-sm text-[#F0F6FC] placeholder:font-sans placeholder:text-[#6E7681] focus:border-[#38BDF8] focus:outline-none"
                  />
                </div>
              </div>
            </>
          ) : (
            <p className="text-sm text-[#8B949E]">
              Configure at least one active Tracked Item in Settings to forecast daily supply.
            </p>
          )}
        </div>

        {currentItem && (
          <div className="flex flex-col gap-2 border-t border-[#283340] px-6 py-4">
            <div className="flex items-center gap-2">
              <button
                type="button"
                disabled={saving}
                data-testid="day-save-btn"
                onClick={() => void handleSave(false)}
                className="min-h-[40px] flex-1 whitespace-nowrap rounded-md bg-[#0EA5E9] px-4 py-2 text-sm font-semibold text-[#0B1117] transition-colors hover:bg-[#38BDF8] disabled:opacity-50"
              >
                {saving ? 'Saving...' : 'Save Day'}
              </button>
              {currentItem.supplyMode === 'continuous' && (
                <button
                  type="button"
                  disabled={saving}
                  data-testid="day-cascade-forward-btn"
                  onClick={() => void handleSave(true)}
                  className="inline-flex min-h-[40px] flex-1 items-center justify-center gap-1.5 whitespace-nowrap rounded-md border border-[#38BDF8]/60 bg-[#1E2730] px-3 py-2 text-sm font-medium text-[#38BDF8] transition-colors hover:bg-[#25313D] disabled:opacity-50"
                >
                  Cascade Forward
                  <ArrowRight className="h-4 w-4" aria-hidden="true" />
                </button>
              )}
            </div>
          </div>
        )}
      </div>

      {/* Non-blocking warning when overwriting Morning or End-of-Day count on a date other than today */}
      {pendingOverrideCascade !== null && currentItem && (
        <div
          className="fixed inset-0 z-[60] flex items-center justify-center bg-black/70 p-4"
          data-testid="non-today-override-modal"
          role="alertdialog"
          aria-modal="true"
          aria-labelledby="non-today-override-title"
        >
          <div className="w-full max-w-md rounded-lg border border-[#D97706]/60 bg-[#161D24] p-5 text-[#E6EDF3] shadow-2xl">
            <div className="flex items-start gap-3">
              <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-md bg-[#D97706]/15 text-[#FBBF24]">
                <AlertTriangle className="h-5 w-5" aria-hidden="true" />
              </div>
              <div className="min-w-0 flex-1">
                <h3
                  id="non-today-override-title"
                  className="font-['Plus_Jakarta_Sans'] text-base font-bold text-[#F0F6FC]"
                >
                  Overwriting Count on {formatShortCalendarDate(day.date)}
                </h3>
                <p className="mt-1.5 text-xs leading-relaxed text-[#C9D1D9]">
                  You&apos;re manually overwriting the{' '}
                  <strong className="text-[#FDE68A]">
                    {isOverwritingMorning && isOverwritingEod
                      ? 'Morning and End-of-Day'
                      : isOverwritingMorning
                        ? 'Morning'
                        : 'End-of-Day'}
                  </strong>{' '}
                  count for a {isFutureDay ? 'future' : 'past'} day instead of today. Manual counts
                  on other days disconnect automatic carry-over and stock reservations across dates.
                </p>
                <div className="mt-3 space-y-1.5 rounded-md border border-[#283340] bg-[#0F1419]/80 p-3 text-xs text-[#C9D1D9]">
                  <p className="font-semibold text-[#F0F6FC]">Consider instead:</p>
                  <ul className="list-disc space-y-1 pl-4 text-[#9BA3AE]">
                    <li>
                      <strong className="text-[#E6EDF3]">Setting aside stock?</strong> Add an{' '}
                      <span className="text-[#38BDF8]">Additional Safety Buffer / Holdback</span> on
                      this day so earlier days automatically reserve inventory.
                    </li>
                    <li>
                      <strong className="text-[#E6EDF3]">Expecting different harvest?</strong>{' '}
                      Adjust <span className="text-[#38BDF8]">Afternoon Harvest</span> (or{' '}
                      <span className="text-[#38BDF8]">Cascade Forward</span>) to keep running
                      carry-over connected.
                    </li>
                  </ul>
                </div>
              </div>
            </div>

            <div className="mt-5 flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
              <button
                type="button"
                disabled={saving}
                data-testid="cancel-non-today-override-btn"
                onClick={() => setPendingOverrideCascade(null)}
                className="min-h-[38px] rounded-md border border-[#283340] bg-[#1E2730] px-3.5 py-2 text-xs font-semibold text-[#E6EDF3] transition-colors hover:border-[#38BDF8] hover:text-[#F0F6FC] disabled:opacity-50"
              >
                Go Back &amp; Adjust
              </button>
              <button
                type="button"
                disabled={saving}
                data-testid="confirm-non-today-override-btn"
                onClick={() => void executeSave(pendingOverrideCascade)}
                className="min-h-[38px] rounded-md bg-[#D97706] px-3.5 py-2 text-xs font-semibold text-[#0B1117] transition-colors hover:bg-[#F59E0B] disabled:opacity-50"
              >
                {saving ? 'Saving...' : 'Save Override Anyway'}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
