import { addDays, getIsoWeekday, listDateRange } from './timezone';
import type {
  AvailabilityTier,
  CalendarDayProjection,
  DailyItemProjection,
  DailySupplyEntry,
  OrderRecord,
  PickupChannel,
  TrackedItem,
} from './types';

function roundQty(value: number): number {
  return Math.round(value * 1000) / 1000;
}

export function computeTier(endingBalance: number, sellableOpen: number): AvailabilityTier {
  if (endingBalance < 0) return 'red';
  if (sellableOpen < 0) return 'amber';
  return 'green';
}

export function isChannelActiveOnDate(
  channel: Pick<PickupChannel, 'allowedWeekdays' | 'specificDates'>,
  dateYmd: string,
  isoWeekday: number = getIsoWeekday(dateYmd)
): boolean {
  const hasWeekdays = channel.allowedWeekdays.length > 0;
  const specific = channel.specificDates ?? [];
  const hasSpecific = specific.length > 0;
  if (!hasWeekdays && !hasSpecific) {
    return true; // Flexible any-date 1-off channel
  }
  if (hasWeekdays && channel.allowedWeekdays.includes(isoWeekday)) {
    return true;
  }
  if (hasSpecific && specific.includes(dateYmd)) {
    return true;
  }
  return false;
}

export function channelHasScheduleRestriction(
  channel: Pick<PickupChannel, 'allowedWeekdays' | 'specificDates'>
): boolean {
  const specific = channel.specificDates ?? [];
  if (channel.allowedWeekdays.length === 0 && specific.length === 0) return false;
  if (channel.allowedWeekdays.length === 7) return false;
  return true;
}

export interface ProjectSupplyInput {
  items: TrackedItem[];
  entries: DailySupplyEntry[];
  orders: OrderRecord[];
  startDate: string; // YYYY-MM-DD (typically Monday of current week)
  endDate: string;   // YYYY-MM-DD (6+ weeks ahead)
  today: string;     // YYYY-MM-DD in local timezone
}

/**
 * Deterministic running-balance projection engine.
 *
 * Rules:
 * 1. Afternoon Harvest -> Next-Day Availability: Whatever is harvested/produced on Day D
 *    (`estProduced`) is NOT available for Day D's orders—it rolls into Day D+1's starting
 *    inventory (`nextDayStarting = endingBalance + estProduced`).
 * 2. Continuous Daily Production items start with defaultDailyProduction unless
 *    a manual estProduced entry or cascade anchor sets a new rate forward until the next anchor/override.
 * 3. Discrete Batch/Harvest Drops items default to 0 produced per day unless explicitly entered on that date.
 * 4. Actual On-Hand overrides set the exact starting physical stock on hand for that day (morning count),
 *    immediately recalculating every subsequent date forward.
 * 5. Same-Day Balance = StartingBalance - SlottedOrders;
 *    SellableOpen = Same-Day Balance - EffectiveBuffer;
 *    NextDayStarting = Same-Day Balance + EstProduced.
 */
export function projectDailySupply(input: ProjectSupplyInput): CalendarDayProjection[] {
  const { items, entries, orders, startDate, endDate, today } = input;
  const dates = listDateRange(startDate, endDate);

  // Index entries by itemId -> date
  const entryMap = new Map<number, Map<string, DailySupplyEntry>>();
  for (const entry of entries) {
    let byDate = entryMap.get(entry.trackedItemId);
    if (!byDate) {
      byDate = new Map();
      entryMap.set(entry.trackedItemId, byDate);
    }
    byDate.set(entry.date, entry);
  }

  // Index slotted order quantities by itemId -> date
  const slottedQtyMap = new Map<number, Map<string, number>>();
  for (const order of orders) {
    if (!order.slottedDate) continue;
    if (order.status === 'waitlist' || order.status === 'ignored') continue;

    for (const line of order.items) {
      let byDate = slottedQtyMap.get(line.trackedItemId);
      if (!byDate) {
        byDate = new Map();
        slottedQtyMap.set(line.trackedItemId, byDate);
      }
      const prev = byDate.get(order.slottedDate) ?? 0;
      byDate.set(order.slottedDate, roundQty(prev + line.quantity));
    }
  }

  // Precompute per-item projections
  const perItemResults = new Map<number, Map<string, DailyItemProjection>>();

  for (const item of items) {
    const itemEntries = entryMap.get(item.id) ?? new Map<string, DailySupplyEntry>();
    const itemSlotted = slottedQtyMap.get(item.id) ?? new Map<string, number>();

    // Determine initial cascade production rate and carried-over balance from any anchor strictly before startDate
    let activeCascadeRate = item.supplyMode === 'continuous' ? item.defaultDailyProduction : 0;
    const priorAnchors = Array.from(itemEntries.values())
      .filter(
        (e) =>
          e.date < startDate &&
          (e.actualOnHand !== null || (e.actualEndOfDay !== undefined && e.actualEndOfDay !== null))
      )
      .sort((a, b) => a.date.localeCompare(b.date));

    let runningBalance = 0;
    if (priorAnchors.length > 0) {
      const latestAnchor = priorAnchors[priorAnchors.length - 1];
      const latestHasEod =
        latestAnchor.actualEndOfDay !== undefined && latestAnchor.actualEndOfDay !== null;

      // Initialize cascade rate from any anchor prior to our carry-forward start date
      const preAnchorCascades = Array.from(itemEntries.values())
        .filter(
          (e) =>
            (latestHasEod ? e.date <= latestAnchor.date : e.date < latestAnchor.date) &&
            e.isCascadeAnchor &&
            e.estProduced !== null
        )
        .sort((a, b) => a.date.localeCompare(b.date));
      if (preAnchorCascades.length > 0 && item.supplyMode === 'continuous') {
        activeCascadeRate = preAnchorCascades[preAnchorCascades.length - 1].estProduced!;
      }

      const carryStart = latestHasEod ? addDays(latestAnchor.date, 1) : latestAnchor.date;
      const carryEnd = addDays(startDate, -1);
      runningBalance = latestHasEod
        ? roundQty(latestAnchor.actualEndOfDay!)
        : roundQty(latestAnchor.actualOnHand!);

      // Roll forward day-by-day through the day before startDate
      if (carryStart <= carryEnd) {
        const carryDates = listDateRange(carryStart, carryEnd);
        for (const carryDate of carryDates) {
          const carryEntry = itemEntries.get(carryDate);
          const startBal =
            carryEntry && carryEntry.actualOnHand !== null
              ? roundQty(carryEntry.actualOnHand)
              : roundQty(runningBalance);

          let prod = 0;
          if (item.supplyMode === 'continuous') {
            if (carryEntry && carryEntry.estProduced !== null) {
              prod = roundQty(carryEntry.estProduced);
              if (carryEntry.isCascadeAnchor) {
                activeCascadeRate = prod;
              }
            } else {
              prod = roundQty(activeCascadeRate);
            }
          } else if (carryEntry && carryEntry.estProduced !== null) {
            prod = roundQty(carryEntry.estProduced);
          }

          const slotted = roundQty(itemSlotted.get(carryDate) ?? 0);
          const carryEod =
            carryEntry && carryEntry.actualEndOfDay !== undefined && carryEntry.actualEndOfDay !== null
              ? roundQty(carryEntry.actualEndOfDay)
              : null;
          runningBalance = carryEod !== null ? carryEod : roundQty(startBal - slotted + prod);
        }
      }
    } else {
      const priorAnchorDates = Array.from(itemEntries.values())
        .filter((e) => e.date < startDate && e.isCascadeAnchor && e.estProduced !== null)
        .sort((a, b) => a.date.localeCompare(b.date));
      if (priorAnchorDates.length > 0 && item.supplyMode === 'continuous') {
        activeCascadeRate = priorAnchorDates[priorAnchorDates.length - 1].estProduced!;
      }
    }

    const dayMap = new Map<string, DailyItemProjection>();

    for (const date of dates) {
      const entry = itemEntries.get(date);

      // Determine expected vs actual morning starting balance
      const expectedStartingBalance = roundQty(runningBalance);
      const startingBalance =
        entry && entry.actualOnHand !== null ? roundQty(entry.actualOnHand) : expectedStartingBalance;

      // Determine afternoon Est. Produced (rolls into tomorrow's starting inventory)
      let estProduced = 0;
      let isManualProducedOverride = false;
      const isCascadeAnchor = Boolean(entry?.isCascadeAnchor);

      if (item.supplyMode === 'continuous') {
        if (entry && entry.estProduced !== null) {
          estProduced = roundQty(entry.estProduced);
          isManualProducedOverride = true;
          if (entry.isCascadeAnchor) {
            activeCascadeRate = estProduced;
          }
        } else {
          estProduced = roundQty(activeCascadeRate);
        }
      } else {
        // Discrete batch / harvest drop mode
        if (entry && entry.estProduced !== null) {
          estProduced = roundQty(entry.estProduced);
          isManualProducedOverride = true;
        } else {
          estProduced = 0;
        }
      }

      const expectedProduced =
        item.supplyMode === 'continuous' ? roundQty(activeCascadeRate) : 0;

      const slottedQty = roundQty(itemSlotted.get(date) ?? 0);

      // Orders today draw ONLY from today's starting stock; afternoon harvest becomes available tomorrow
      const endingBalance = roundQty(startingBalance - slottedQty);
      const expectedNextDayStarting = roundQty(endingBalance + estProduced);
      const actualEndOfDay =
        entry && entry.actualEndOfDay !== undefined && entry.actualEndOfDay !== null
          ? roundQty(entry.actualEndOfDay)
          : null;
      const nextDayStarting = actualEndOfDay !== null ? actualEndOfDay : expectedNextDayStarting;

      const hasBufferOverride = entry !== undefined && entry.bufferOverride !== null;
      const baseBuffer = hasBufferOverride
        ? roundQty(entry!.bufferOverride!)
        : roundQty(item.globalSafetyBuffer);
      const extraBuffer =
        entry && typeof entry.extraBuffer === 'number' && entry.extraBuffer > 0
          ? roundQty(entry.extraBuffer)
          : 0;
      const effectiveBuffer = roundQty(baseBuffer + extraBuffer);
      const rawSellableOpen = roundQty(endingBalance - effectiveBuffer);

      dayMap.set(date, {
        trackedItemId: item.id,
        date,
        expectedStartingBalance,
        startingBalance,
        expectedProduced,
        estProduced,
        actualOnHand: entry?.actualOnHand ?? null,
        actualEndOfDay,
        slottedQty,
        endingBalance,
        expectedNextDayStarting,
        nextDayStarting,
        effectiveBuffer,
        extraBuffer,
        hasBufferOverride,
        isCascadeAnchor,
        isManualProducedOverride,
        rawSellableOpen,
        availablePhysical: endingBalance,
        reservedForFuture: 0,
        constrainedByDate: null,
        sellableOpen: rawSellableOpen,
        tier: computeTier(endingBalance, rawSellableOpen),
        notes: entry?.notes ?? null,
      });

      // Carry forward end-of-day physical count (or remaining balance + afternoon harvest) into tomorrow's morning stock
      runningBalance = nextDayStarting;
    }

    // Second pass (Backward Available-to-Promise / ATP pass):
    // You cannot sell stock on Day D that is already required to fulfill slotted/pre-approved/confirmed
    // orders on future dates k > D (stopping at any morning Actual On-Hand or end-of-day physical reset).
    let downstreamMinOpen = Infinity;
    let downstreamMinOpenDate: string | null = null;
    let downstreamMinEnding = Infinity;

    for (let i = dates.length - 1; i >= 0; i--) {
      const date = dates[i];
      const proj = dayMap.get(date);
      if (!proj) continue;

      // If this day has an explicit physical End-of-Day count, tomorrow's inventory is pinned
      // independently of today's daytime sales, so downstream days do not constrain today.
      if (proj.actualEndOfDay !== null && proj.actualEndOfDay !== undefined) {
        downstreamMinOpen = Infinity;
        downstreamMinOpenDate = null;
        downstreamMinEnding = Infinity;
      }

      const atpOpen =
        downstreamMinOpen < proj.rawSellableOpen
          ? roundQty(downstreamMinOpen)
          : proj.rawSellableOpen;
      const atpPhysical =
        downstreamMinEnding < proj.endingBalance
          ? roundQty(downstreamMinEnding)
          : proj.endingBalance;

      const constrainedByDate =
        downstreamMinOpen < proj.rawSellableOpen ? downstreamMinOpenDate : null;
      const rawHeld = Math.max(0, roundQty(proj.rawSellableOpen - atpOpen));
      const reservedForFuture = Math.min(Math.max(0, proj.endingBalance), rawHeld);

      proj.sellableOpen = atpOpen;
      proj.availablePhysical = atpPhysical;
      proj.reservedForFuture = reservedForFuture;
      proj.constrainedByDate = constrainedByDate;
      proj.tier = computeTier(atpPhysical, atpOpen);

      if (proj.actualOnHand !== null) {
        // Explicit morning physical count breaks carry-over linkage for days strictly before this date
        downstreamMinOpen = Infinity;
        downstreamMinOpenDate = null;
        downstreamMinEnding = Infinity;
      } else {
        if (proj.rawSellableOpen <= downstreamMinOpen) {
          downstreamMinOpen = proj.rawSellableOpen;
          downstreamMinOpenDate = date;
        }
        if (proj.endingBalance <= downstreamMinEnding) {
          downstreamMinEnding = proj.endingBalance;
        }
      }
    }

    perItemResults.set(item.id, dayMap);
  }

  return dates.map((date) => {
    const byItem: Record<number, DailyItemProjection> = {};
    for (const item of items) {
      const proj = perItemResults.get(item.id)?.get(date);
      if (proj) {
        byItem[item.id] = proj;
      }
    }
    return {
      date,
      isoWeekday: getIsoWeekday(date),
      isToday: date === today,
      isPast: date < today,
      byItem,
    };
  });
}

/**
 * Live drag-and-drop forecast preview: simulates slotting (or moving) `order` onto `targetDate`
 * across all calendar days, updating forward balances (`startingBalance`, `slottedQty`,
 * `endingBalance`, `nextDayStarting`) and backward ATP (`sellableOpen`, `availablePhysical`,
 * `reservedForFuture`, `constrainedByDate`, `tier`) identically to `projectDailySupply`.
 */
export function previewOrderMoveProjections(
  days: CalendarDayProjection[],
  items: TrackedItem[],
  order: OrderRecord,
  targetDate: string
): CalendarDayProjection[] {
  if (days.length === 0 || order.items.length === 0) return days;

  const isCurrentlySlotted =
    Boolean(order.slottedDate) && order.status !== 'waitlist' && order.status !== 'ignored';
  const sourceDate = isCurrentlySlotted ? order.slottedDate : null;
  if (sourceDate === targetDate) return days;

  // Aggregate item quantities for the dragged order
  const qtyByItem = new Map<number, number>();
  for (const line of order.items) {
    if (line.quantity <= 0) continue;
    qtyByItem.set(line.trackedItemId, roundQty((qtyByItem.get(line.trackedItemId) ?? 0) + line.quantity));
  }
  if (qtyByItem.size === 0) return days;

  // Recompute forward + backward ATP only for affected tracked items
  const updatedByItem = new Map<number, DailyItemProjection[]>();

  for (const item of items) {
    const orderQty = qtyByItem.get(item.id);
    if (!orderQty) continue;

    const itemDays: DailyItemProjection[] = [];
    let prevNextDayStarting = 0;

    for (let i = 0; i < days.length; i++) {
      const day = days[i];
      const base = day.byItem[item.id];
      if (!base) {
        continue;
      }

      const expectedStartingBalance =
        i === 0 ? (base.expectedStartingBalance ?? base.startingBalance) : roundQty(prevNextDayStarting);
      const startingBalance =
        i === 0
          ? base.startingBalance
          : base.actualOnHand !== null
            ? base.actualOnHand
            : expectedStartingBalance;

      let deltaSlotted = 0;
      if (sourceDate && day.date === sourceDate) {
        deltaSlotted = roundQty(deltaSlotted - orderQty);
      }
      if (day.date === targetDate) {
        deltaSlotted = roundQty(deltaSlotted + orderQty);
      }

      const slottedQty = roundQty(base.slottedQty + deltaSlotted);
      const endingBalance = roundQty(startingBalance - slottedQty);
      const expectedNextDayStarting = roundQty(endingBalance + base.estProduced);
      const nextDayStarting =
        base.actualEndOfDay !== null && base.actualEndOfDay !== undefined
          ? base.actualEndOfDay
          : expectedNextDayStarting;
      const rawSellableOpen = roundQty(endingBalance - base.effectiveBuffer);

      itemDays.push({
        ...base,
        expectedStartingBalance,
        startingBalance,
        slottedQty,
        endingBalance,
        expectedNextDayStarting,
        nextDayStarting,
        rawSellableOpen,
        availablePhysical: endingBalance,
        reservedForFuture: 0,
        constrainedByDate: null,
        sellableOpen: rawSellableOpen,
        tier: computeTier(endingBalance, rawSellableOpen),
      });

      prevNextDayStarting = nextDayStarting;
    }

    // Backward ATP reservation pass (identical boundary rules to projectDailySupply)
    let downstreamMinOpen = Infinity;
    let downstreamMinOpenDate: string | null = null;
    let downstreamMinEnding = Infinity;

    for (let i = itemDays.length - 1; i >= 0; i--) {
      const proj = itemDays[i];

      if (proj.actualEndOfDay !== null && proj.actualEndOfDay !== undefined) {
        downstreamMinOpen = Infinity;
        downstreamMinOpenDate = null;
        downstreamMinEnding = Infinity;
      }

      const atpOpen =
        downstreamMinOpen < proj.rawSellableOpen
          ? roundQty(downstreamMinOpen)
          : proj.rawSellableOpen;
      const atpPhysical =
        downstreamMinEnding < proj.endingBalance
          ? roundQty(downstreamMinEnding)
          : proj.endingBalance;

      const constrainedByDate =
        downstreamMinOpen < proj.rawSellableOpen ? downstreamMinOpenDate : null;
      const rawHeld = Math.max(0, roundQty(proj.rawSellableOpen - atpOpen));
      const reservedForFuture = Math.min(Math.max(0, proj.endingBalance), rawHeld);

      proj.sellableOpen = atpOpen;
      proj.availablePhysical = atpPhysical;
      proj.reservedForFuture = reservedForFuture;
      proj.constrainedByDate = constrainedByDate;
      proj.tier = computeTier(atpPhysical, atpOpen);

      if (proj.actualOnHand !== null) {
        downstreamMinOpen = Infinity;
        downstreamMinOpenDate = null;
        downstreamMinEnding = Infinity;
      } else {
        if (proj.rawSellableOpen <= downstreamMinOpen) {
          downstreamMinOpen = proj.rawSellableOpen;
          downstreamMinOpenDate = proj.date;
        }
        if (proj.endingBalance <= downstreamMinEnding) {
          downstreamMinEnding = proj.endingBalance;
        }
      }
    }

    updatedByItem.set(item.id, itemDays);
  }

  return days.map((day, idx) => {
    const byItem: Record<number, DailyItemProjection> = { ...day.byItem };
    for (const [itemId, projList] of updatedByItem.entries()) {
      const updated = projList[idx];
      if (updated) {
        byItem[itemId] = updated;
      }
    }
    return {
      ...day,
      byItem,
    };
  });
}

/**
 * Checks whether slotting an order on `candidateDate` respects pickup channel allowed weekdays
 * AND keeps `sellableOpen >= 0` for every Tracked Item on the order on `candidateDate`
 * and every subsequent date in the horizon (so future locked/standing orders aren't pushed into buffer/deficit).
 */
export function findEarliestValidSlotDate(params: {
  order: OrderRecord;
  items: TrackedItem[];
  entries: DailySupplyEntry[];
  existingOrders: OrderRecord[];
  channels: PickupChannel[];
  today: string;
  startDate: string;
  endDate: string;
}): string | null {
  const { order, items, entries, existingOrders, channels, today, startDate, endDate } = params;
  if (order.items.length === 0) return null;

  const channel = order.pickupChannelId
    ? channels.find((c) => c.id === order.pickupChannelId) ?? null
    : null;

  const baseProjection = projectDailySupply({
    items,
    entries,
    orders: existingOrders,
    startDate,
    endDate,
    today,
  });

  const candidateDays = baseProjection.filter(
    (d) => d.date >= today && (!channel || isChannelActiveOnDate(channel, d.date, d.isoWeekday))
  );

  for (const candidate of candidateDays) {
    let fits = true;
    for (const line of order.items) {
      const dayProj = candidate.byItem[line.trackedItemId];
      if (!dayProj) continue;
      // Because `sellableOpen` already equals min_{k >= D} rawSellableOpen(k) up to the next actualOnHand reset,
      // verifying `sellableOpen - quantity >= 0` guarantees no current or future date dips into buffer.
      if (roundQty(dayProj.sellableOpen - line.quantity) < 0) {
        fits = false;
        break;
      }
    }

    if (fits) {
      return candidate.date;
    }
  }

  return null;
}

export function isWeekdayAllowedForChannel(
  dateYmd: string,
  channelId: number | null,
  channels: PickupChannel[]
): {
  allowed: boolean;
  channelName: string | null;
  allowedWeekdays: number[];
  specificDates: string[];
} {
  if (!channelId) {
    return {
      allowed: true,
      channelName: null,
      allowedWeekdays: [1, 2, 3, 4, 5, 6, 7],
      specificDates: [],
    };
  }
  const channel = channels.find((c) => c.id === channelId);
  if (!channel) {
    return {
      allowed: true,
      channelName: null,
      allowedWeekdays: [1, 2, 3, 4, 5, 6, 7],
      specificDates: [],
    };
  }
  const iso = getIsoWeekday(dateYmd);
  return {
    allowed: isChannelActiveOnDate(channel, dateYmd, iso),
    channelName: channel.name,
    allowedWeekdays: channel.allowedWeekdays,
    specificDates: channel.specificDates ?? [],
  };
}

export type CandidateSlotFit = 'fits' | 'buffer' | 'deficit' | 'no_items';

export interface CandidateSlotItemAvailability {
  trackedItemId: number;
  itemName: string;
  unitLabel: string;
  requestedQty: number;
  currentOpen: number;
  afterOpen: number;
  afterEnding: number;
  minDownstreamOpen: number;
  minDownstreamEnding: number;
  constrainingDate: string | null;
}

export interface CandidateSlotDate {
  date: string;
  isoWeekday: number;
  channelAllowed: boolean;
  isToday: boolean;
  isCurrentSlot: boolean;
  isRequestedDate: boolean;
  fit: CandidateSlotFit;
  isFirstAvailable: boolean;
  items: CandidateSlotItemAvailability[];
}

/**
 * Evaluates every upcoming calendar date (`>= today`) for a given order, showing live
 * ATP stock availability before and after slotting the order and identifying the earliest
 * channel-allowed date that stays above safety buffers across downstream dates.
 *
 * Works cleanly for both unslotted waitlist orders and already-slotted orders being rescheduled
 * (by adding back the order's currently-slotted quantities onto raw daily balances before simulating).
 */
export function evaluateCandidateSlotDates(params: {
  order: Pick<OrderRecord, 'status' | 'slottedDate' | 'requestedDate' | 'timingType' | 'items'>;
  draftItems?: OrderRecord['items'];
  draftPickupChannelId?: number | null;
  draftRequestedDate?: string | null;
  days: CalendarDayProjection[];
  items: TrackedItem[];
  channels: PickupChannel[];
  today: string;
}): CandidateSlotDate[] {
  const { order, days, items, channels, today } = params;
  const activeLines = (params.draftItems ?? order.items).filter((l) => l.quantity > 0);

  // Merge duplicate item lines if present
  const draftQtyByItem = new Map<number, number>();
  for (const line of activeLines) {
    draftQtyByItem.set(
      line.trackedItemId,
      roundQty((draftQtyByItem.get(line.trackedItemId) ?? 0) + line.quantity)
    );
  }

  const itemsById = new Map(items.map((i) => [i.id, i]));
  const channel =
    params.draftPickupChannelId !== undefined && params.draftPickupChannelId !== null
      ? channels.find((c) => c.id === params.draftPickupChannelId) ?? null
      : null;

  // If the order is already counted in `days`, compute the index where its current quantities are deducted
  const isCurrentlyCounted =
    Boolean(order.slottedDate) && order.status !== 'waitlist' && order.status !== 'ignored';
  const oldSlottedIdx = isCurrentlyCounted
    ? days.findIndex((d) => d.date === order.slottedDate)
    : -1;

  const oldQtyByItem = new Map<number, number>();
  if (isCurrentlyCounted) {
    for (const line of order.items) {
      if (line.quantity <= 0) continue;
      oldQtyByItem.set(
        line.trackedItemId,
        roundQty((oldQtyByItem.get(line.trackedItemId) ?? 0) + line.quantity)
      );
    }
  }

  // Build baseline day-alone (raw) open & ending balances without this order's current slot
  const baselineRawOpenByItem = new Map<number, number[]>();
  const baselineEndingByItem = new Map<number, number[]>();

  for (const trackedItemId of draftQtyByItem.keys()) {
    const rawOpens: number[] = [];
    const endings: number[] = [];
    const oldQty = oldQtyByItem.get(trackedItemId) ?? 0;
    let restoringOld = false;

    for (let i = 0; i < days.length; i++) {
      const proj = days[i].byItem[trackedItemId];
      if (!proj) {
        rawOpens.push(0);
        endings.push(0);
        continue;
      }

      if (oldSlottedIdx >= 0 && i === oldSlottedIdx) {
        restoringOld = true;
      } else if (
        restoringOld &&
        (proj.actualOnHand !== null ||
          (i > 0 && days[i - 1].byItem[trackedItemId]?.actualEndOfDay != null))
      ) {
        restoringOld = false;
      }

      const delta = restoringOld ? oldQty : 0;
      const baseRaw = proj.rawSellableOpen !== undefined ? proj.rawSellableOpen : proj.sellableOpen;
      rawOpens.push(roundQty(baseRaw + delta));
      endings.push(roundQty(proj.endingBalance + delta));
    }

    baselineRawOpenByItem.set(trackedItemId, rawOpens);
    baselineEndingByItem.set(trackedItemId, endings);
  }

  const results: CandidateSlotDate[] = [];
  let foundFirstAvailable = false;

  for (let candIdx = 0; candIdx < days.length; candIdx++) {
    const day = days[candIdx];
    if (day.date < today) continue;

    const channelAllowed = !channel || isChannelActiveOnDate(channel, day.date, day.isoWeekday);
    const isCurrentSlot = isCurrentlyCounted && order.slottedDate === day.date;
    const effectiveRequestedDate =
      params.draftRequestedDate !== undefined ? params.draftRequestedDate : order.requestedDate;
    const isRequestedDate = Boolean(effectiveRequestedDate && effectiveRequestedDate === day.date);

    if (draftQtyByItem.size === 0) {
      results.push({
        date: day.date,
        isoWeekday: day.isoWeekday,
        channelAllowed,
        isToday: day.isToday,
        isCurrentSlot,
        isRequestedDate,
        fit: 'no_items',
        isFirstAvailable: false,
        items: [],
      });
      continue;
    }

    const itemSnapshots: CandidateSlotItemAvailability[] = [];
    let worstFit: CandidateSlotFit = 'fits';

    for (const [trackedItemId, qty] of draftQtyByItem.entries()) {
      const itemMeta = itemsById.get(trackedItemId);
      const baseRawOpens = baselineRawOpenByItem.get(trackedItemId) ?? [];
      const baseEndings = baselineEndingByItem.get(trackedItemId) ?? [];

      // Compute true ATP available-to-sell on candIdx BEFORE placing this order
      let currentAtpOpen = baseRawOpens[candIdx] ?? 0;
      let currentAtpEnding = baseEndings[candIdx] ?? 0;
      let constrainingDate: string | null = null;

      const candHasEodOverride = days[candIdx].byItem[trackedItemId]?.actualEndOfDay != null;
      if (!candHasEodOverride) {
        for (let i = candIdx + 1; i < days.length; i++) {
          const proj = days[i].byItem[trackedItemId];
          if (!proj) continue;
          if (proj.actualOnHand !== null) break;
          if (days[i - 1].byItem[trackedItemId]?.actualEndOfDay != null) break;

          const nextOpen = baseRawOpens[i] ?? 0;
          const nextEnding = baseEndings[i] ?? 0;

          if (nextOpen < currentAtpOpen) {
            currentAtpOpen = nextOpen;
            constrainingDate = days[i].date;
          }
          if (nextEnding < currentAtpEnding) {
            currentAtpEnding = nextEnding;
          }
        }
      }

      const afterOpen = roundQty(currentAtpOpen - qty);
      const afterEnding = roundQty(currentAtpEnding - qty);

      if (afterEnding < 0) {
        worstFit = 'deficit';
      } else if (afterOpen < 0 && worstFit !== 'deficit') {
        worstFit = 'buffer';
      }

      itemSnapshots.push({
        trackedItemId,
        itemName: itemMeta?.name ?? `Item #${trackedItemId}`,
        unitLabel: itemMeta?.unitLabel ?? 'units',
        requestedQty: qty,
        currentOpen: roundQty(currentAtpOpen),
        afterOpen,
        afterEnding,
        minDownstreamOpen: afterOpen,
        minDownstreamEnding: afterEnding,
        constrainingDate: afterOpen < 0 ? constrainingDate : null,
      });
    }

    let isFirstAvailable = false;
    if (!foundFirstAvailable && channelAllowed && worstFit === 'fits') {
      isFirstAvailable = true;
      foundFirstAvailable = true;
    }

    results.push({
      date: day.date,
      isoWeekday: day.isoWeekday,
      channelAllowed,
      isToday: day.isToday,
      isCurrentSlot,
      isRequestedDate,
      fit: worstFit,
      isFirstAvailable,
      items: itemSnapshots,
    });
  }

  return results;
}
