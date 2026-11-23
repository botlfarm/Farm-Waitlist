import { ArrowRight, CalendarPlus, Check, X } from 'lucide-react';
import { useEffect, useState } from 'react';
import { formatQty } from '../shared/generators';
import { isChannelActiveOnDate } from '../shared/supplyEngine';
import { formatFullDisplayDate, formatShortCalendarDate } from '../shared/timezone';
import type { CalendarDayProjection, PickupChannel, TrackedItem } from '../shared/types';

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
      cascadeForward: boolean;
      bufferOverride: number | null;
      extraBuffer: number;
      notes: string | null;
    }
  ) => Promise<void>;
  onClearActualOverride?: (itemId: number, date: string) => Promise<void>;
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
  const [extraBuffer, setExtraBuffer] = useState<string>('');
  const [bufferOverride, setBufferOverride] = useState<string>('');
  const [notes, setNotes] = useState<string>('');
  const [saving, setSaving] = useState(false);
  const [togglingChannelId, setTogglingChannelId] = useState<number | null>(null);

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
    setEstProduced(String(proj.estProduced));
    setExtraBuffer(proj.extraBuffer > 0 ? String(proj.extraBuffer) : '');
    const savedBase = proj.hasBufferOverride
      ? Math.max(0, Number((proj.effectiveBuffer - proj.extraBuffer).toFixed(3)))
      : null;
    setBufferOverride(savedBase !== null ? String(savedBase) : '');
    setNotes(proj.notes ?? '');
  }, [
    day?.date,
    currentItem?.id,
    proj?.actualOnHand,
    proj?.estProduced,
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

  const handleSave = async (cascadeForward: boolean) => {
    if (!currentItem) return;
    setSaving(true);
    try {
      await onSaveSupply(currentItem.id, day.date, {
        actualOnHand: actualOnHand.trim() === '' ? null : Number(actualOnHand),
        estProduced: estProduced.trim() === '' ? null : Number(estProduced),
        cascadeForward,
        bufferOverride: bufferOverride.trim() === '' ? null : Math.max(0, Number(bufferOverride)),
        extraBuffer: extraBuffer.trim() === '' ? 0 : Math.max(0, Number(extraBuffer)),
        notes: notes.trim() || null,
      });
    } finally {
      setSaving(false);
    }
  };

  const previewBaseBuffer =
    bufferOverride.trim() !== '' && Number.isFinite(Number(bufferOverride))
      ? Math.max(0, Number(bufferOverride))
      : currentItem?.globalSafetyBuffer ?? 0;
  const previewExtraBuffer =
    extraBuffer.trim() !== '' && Number.isFinite(Number(extraBuffer))
      ? Math.max(0, Number(extraBuffer))
      : 0;
  const previewTotalBuffer = Math.round((previewBaseBuffer + previewExtraBuffer) * 1000) / 1000;

  const isFutureDay = Boolean(today && day.date > today);
  const nextDayProj = nextDay && currentItem ? nextDay.byItem[currentItem.id] : undefined;
  const nextDayHasManualOverride = Boolean(nextDay && nextDayProj && nextDayProj.actualOnHand !== null);

  const tierTextClass =
    proj?.tier === 'red'
      ? 'text-[#F87171]'
      : proj?.tier === 'amber'
        ? 'text-[#FBBF24]'
        : proj && proj.sellableOpen <= 0
          ? 'text-[#9BA3AE]'
          : 'text-[#4ADE80]';
  const tierLabel =
    proj?.tier === 'red'
      ? 'Deficit'
      : proj?.tier === 'amber'
        ? 'In Buffer'
        : proj && proj.sellableOpen <= 0
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
      <div className="flex h-full w-full max-w-md flex-col border-l border-[#283340] bg-[#161D24] text-[#E6EDF3]">
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

        <div className="flex-1 space-y-6 overflow-y-auto px-6 py-5">
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
              <div className="border-y border-[#283340] py-4">
                <div className="mb-3 flex items-baseline justify-between gap-2">
                  <span className="text-sm font-semibold text-[#F0F6FC]">{currentItem.name}</span>
                  <span className={`font-mono text-xs font-semibold tabular-nums ${tierTextClass}`}>
                    {proj.endingBalance < 0
                      ? `Deficit (${formatQty(proj.endingBalance)} ${currentItem.unitLabel})`
                      : proj.availablePhysical < 0 && proj.constrainedByDate
                        ? `Short ${formatQty(Math.abs(proj.availablePhysical))} on ${formatShortCalendarDate(proj.constrainedByDate)} · Can Sell 0`
                        : `${tierLabel} · Can Sell ${formatQty(Math.max(0, proj.sellableOpen))} ${currentItem.unitLabel}`}
                  </span>
                </div>
                <dl className="grid grid-cols-1 gap-y-2 text-xs sm:grid-cols-2 sm:gap-x-4">
                  <div className="flex justify-between">
                    <dt className="text-[#8B949E]">Morning On-Hand</dt>
                    <dd className="font-mono tabular-nums text-[#E6EDF3]">
                      {formatQty(proj.startingBalance)}
                    </dd>
                  </div>
                  <div className="flex justify-between">
                    <dt className="text-[#8B949E]">Slotted Orders</dt>
                    <dd className="font-mono tabular-nums text-[#E6EDF3]">
                      -{formatQty(proj.slottedQty)}
                    </dd>
                  </div>
                  <div className="flex justify-between">
                    <dt className="text-[#8B949E]">Remaining On-Hand</dt>
                    <dd className="font-mono font-semibold tabular-nums text-[#F0F6FC]">
                      {formatQty(proj.endingBalance)}
                    </dd>
                  </div>
                  <div className="flex justify-between">
                    <dt className="text-[#8B949E]">Total Safety Buffer</dt>
                    <dd className="font-mono tabular-nums text-[#E6EDF3]">
                      {formatQty(proj.effectiveBuffer)}
                      {proj.extraBuffer > 0
                        ? ` (+${formatQty(proj.extraBuffer)})`
                        : proj.hasBufferOverride
                          ? ' (override)'
                          : ''}
                    </dd>
                  </div>
                  {proj.reservedForFuture > 0 && (
                    <div className="flex justify-between sm:col-span-2">
                      <dt className="text-[#FBBF24]">
                        Reserved for Future
                        {proj.constrainedByDate
                          ? ` (${formatShortCalendarDate(proj.constrainedByDate)})`
                          : ''}
                      </dt>
                      <dd className="font-mono font-semibold tabular-nums text-[#FBBF24]">
                        -{formatQty(proj.reservedForFuture)}
                      </dd>
                    </div>
                  )}
                  <div className="flex justify-between">
                    <dt className="font-medium text-[#C9D1D9]">Can Sell Today</dt>
                    <dd className={`font-mono font-semibold tabular-nums ${tierTextClass}`}>
                      {formatQty(Math.max(0, proj.sellableOpen))}
                      {proj.sellableOpen < 0 ? ` (${formatQty(proj.sellableOpen)} net)` : ''}
                    </dd>
                  </div>
                  <div className="flex justify-between">
                    <dt className="text-[#8B949E]">Afternoon Harvest</dt>
                    <dd className="font-mono tabular-nums text-[#38BDF8]">
                      +{formatQty(proj.estProduced)} → Tom.
                    </dd>
                  </div>
                  <div className="flex justify-between border-t border-[#283340]/70 pt-2 sm:col-span-2">
                    <dt className="font-medium text-[#C9D1D9]">Projected Tomorrow On-Hand</dt>
                    <dd className="font-mono font-semibold tabular-nums text-[#F0F6FC]">
                      {formatQty(proj.nextDayStarting)} {currentItem.unitLabel}
                    </dd>
                  </div>
                </dl>
                {proj.reservedForFuture > 0 && proj.constrainedByDate && (
                  <p className="mt-3 rounded border border-[#D97706]/30 bg-[#D97706]/10 px-2.5 py-2 text-[11px] text-[#FBBF24]">
                    Holding {formatQty(proj.reservedForFuture)} {currentItem.unitLabel} on hand so
                    orders &amp; buffers on {formatShortCalendarDate(proj.constrainedByDate)} remain
                    covered.
                  </p>
                )}
                {nextDayHasManualOverride && nextDay && nextDayProj && (
                  <div
                    data-testid="day-next-override-warning"
                    className="mt-3 rounded border border-[#D97706]/50 bg-[#D97706]/10 px-3 py-2.5 text-[11px] text-[#FBBF24]"
                  >
                    <p>
                      <strong className="text-[#FDE68A]">
                        {formatShortCalendarDate(nextDay.date)}
                      </strong>{' '}
                      has a manual On-Hand override (
                      <span className="font-mono font-semibold">
                        {formatQty(nextDayProj.actualOnHand!)} {currentItem.unitLabel}
                      </span>
                      ), so this day&apos;s leftover + harvest isn&apos;t carrying into{' '}
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
                            await onClearActualOverride(currentItem.id, nextDay.date);
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
                {isFutureDay && proj.actualOnHand !== null && (
                  <div
                    data-testid="day-future-override-warning"
                    className="mt-3 rounded border border-[#D97706]/50 bg-[#D97706]/10 px-3 py-2.5 text-[11px] text-[#FBBF24]"
                  >
                    <p>
                      This future date has a manual On-Hand override (
                      <span className="font-mono font-semibold">
                        {formatQty(proj.actualOnHand)} {currentItem.unitLabel}
                      </span>
                      ). That replaces carry-over from prior days and stops earlier days from
                      reserving stock for orders on or after this date.
                    </p>
                    {onClearActualOverride && (
                      <button
                        type="button"
                        disabled={saving}
                        data-testid="day-clear-actual-btn"
                        onClick={async () => {
                          setSaving(true);
                          try {
                            await onClearActualOverride(currentItem.id, day.date);
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
              </div>

              <div className="space-y-4">
                <div>
                  <div className="mb-1.5 flex items-center justify-between gap-2">
                    <label
                      htmlFor="day-actual-on-hand"
                      className="block text-xs font-medium text-[#C9D1D9]"
                    >
                      Actual On-Hand Override ({currentItem.unitLabel})
                    </label>
                    {actualOnHand.trim() !== '' && (
                      <button
                        type="button"
                        onClick={() => setActualOnHand('')}
                        className="text-[11px] font-medium text-[#38BDF8] hover:underline"
                      >
                        Clear
                      </button>
                    )}
                  </div>
                  <input
                    id="day-actual-on-hand"
                    data-testid="day-actual-on-hand-input"
                    type="number"
                    step="0.5"
                    value={actualOnHand}
                    onChange={(e) => setActualOnHand(e.target.value)}
                    placeholder="Leave blank to carry prior day + harvest"
                    className="min-h-[40px] w-full rounded-md border border-[#283340] bg-[#0F1419] px-3 py-2 font-mono text-sm tabular-nums text-[#F0F6FC] placeholder:font-sans placeholder:text-[#6E7681] focus:border-[#38BDF8] focus:outline-none"
                  />
                  <p className="mt-1 text-xs text-[#8B949E]">
                    {isFutureDay
                      ? 'Leave blank for future dates so prior-day harvest and future-order reservations carry through automatically.'
                      : 'Sets physical morning stock on hand (before today’s orders are deducted) and recalculates all future dates forward.'}
                  </p>
                </div>

                <div>
                  <label
                    htmlFor="day-est-produced"
                    className="mb-1.5 block text-xs font-medium text-[#C9D1D9]"
                  >
                    {currentItem.supplyMode === 'continuous'
                      ? `Afternoon Harvest / Est. Produced (${currentItem.unitLabel})`
                      : `Afternoon Batch / Harvest Drop (${currentItem.unitLabel})`}
                  </label>
                  <input
                    id="day-est-produced"
                    data-testid="day-est-produced-input"
                    type="number"
                    step="0.5"
                    value={estProduced}
                    onChange={(e) => setEstProduced(e.target.value)}
                    className="min-h-[40px] w-full rounded-md border border-[#283340] bg-[#0F1419] px-3 py-2 font-mono text-sm tabular-nums text-[#F0F6FC] focus:border-[#38BDF8] focus:outline-none"
                  />
                  <p className="mt-1 text-xs text-[#8B949E]">
                    Harvested in the afternoon — becomes available in the following day&apos;s starting inventory.
                  </p>
                </div>

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
    </div>
  );
}
