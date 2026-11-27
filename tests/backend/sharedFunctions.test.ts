import { describe, expect, it } from 'vitest';
import {
  buildPublicAvailabilityJsonPayload,
  format24HourTimeTo12Hour,
  formatHoldCutoffDuration,
  formatOrderItemsSummary,
  formatQty,
  generatePublicAvailability,
  isSafeHttpUrl,
  normalizeCutoffRules,
  resolveHoldCutoffValues,
  resolvePublicOrderCutoffValues,
  serializeAvailabilityForHash,
} from '../../src/shared/generators';
import {
  buildOrderOdooChain,
  findReplacementCandidates,
  isStandingRecurringOrder,
  scoreDuplicateOrder,
  selectPrimaryOdooSide,
} from '../../src/shared/orderMatching';
import {
  channelHasScheduleRestriction,
  computeNextBumpDate,
  computeTier,
  evaluateCandidateSlotDates,
  findEarliestValidSlotDate,
  isChannelActiveOnDate,
  previewOrderMoveProjections,
  projectDailySupply,
} from '../../src/shared/supplyEngine';
import {
  addDays,
  diffDays,
  formatAgingBadge,
  formatDateKeyInTimezone,
  formatDateLongNoYear,
  formatDateNoYear,
  formatDateNumeric,
  formatFullDisplayDate,
  formatLocalDateNoYear,
  formatLocalDateTime,
  formatLocalDateTimeNoYear,
  formatLocalSqlTimestamp,
  formatLocalTimeHHMM,
  formatShortCalendarDate,
  formatWeekdayLong,
  getAgingHoldHours,
  getIsoWeekday,
  getMondayOfWeek,
  getTodayDateKey,
  isDateInFullIgnoredRanges,
  isDateInIgnoredRanges,
  listDateRange,
  parseOdooUtcToDate,
} from '../../src/shared/timezone';
import type {
  DailySupplyEntry,
  OrderRecord,
  PickupChannel,
  TrackedItem,
} from '../../src/shared/types';

function makeOrder(overrides: Partial<OrderRecord> = {}): OrderRecord {
  return {
    id: 1,
    source: 'manual',
    status: 'waitlist',
    timingType: 'asap',
    requestedDate: null,
    slottedDate: null,
    isLocked: false,
    customerName: 'Alex Rivera',
    customerNameOverridden: false,
    customerEmail: 'alex@example.com',
    customerPhone: '203-555-0199',
    pickupChannelId: null,
    freeTextPickup: null,
    notes: null,
    preApprovedAt: null,
    standingOrderId: null,
    standingOccurrenceDate: null,
    odooQuotationId: null,
    odooQuotationName: null,
    odooPartnerId: null,
    odooCreatedAtLocal: null,
    odooRawNotes: null,
    odooRawLines: [],
    odooUpdatedAfterSlot: false,
    odooMissingFlagged: false,
    odooSuggestedConfirmed: null,
    items: [{ trackedItemId: 1, quantity: 4 }],
    chatter: [],
    createdAt: '2026-11-23T14:00:00.000Z',
    updatedAt: '2026-11-23T14:00:00.000Z',
    ...overrides,
  };
}

const eggsItem: TrackedItem = {
  id: 1,
  name: 'Standard Eggs',
  unitLabel: 'dozens',
  isActive: true,
  supplyMode: 'continuous',
  defaultDailyProduction: 10,
  globalSafetyBuffer: 4,
  includeInPublicSnippet: true,
  keywordRules: ['standard'],
  sortOrder: 0,
  createdAt: '',
  updatedAt: '',
};

describe('Shared Supply Engine Unit Tests & Cross-Function Parity', () => {
  it('computes availability tiers accurately across green, amber, and red thresholds', () => {
    expect(computeTier(5, 1)).toBe('green');
    expect(computeTier(4, 0)).toBe('green');
    expect(computeTier(2, -2)).toBe('amber');
    expect(computeTier(0, -4)).toBe('amber');
    expect(computeTier(-0.5, -4.5)).toBe('red');
  });

  it('evaluates pickup channel schedules and restrictions for weekly, specific-date, and flexible channels', () => {
    const flexible = { allowedWeekdays: [], specificDates: [] };
    const everyDay = { allowedWeekdays: [1, 2, 3, 4, 5, 6, 7], specificDates: [] };
    const satOnly = { allowedWeekdays: [6], specificDates: [] };
    const eventOnly = { allowedWeekdays: [], specificDates: ['2026-11-26'] };
    const hybrid = { allowedWeekdays: [6], specificDates: ['2026-11-25'] };

    expect(channelHasScheduleRestriction(flexible)).toBe(false);
    expect(channelHasScheduleRestriction(everyDay)).toBe(false);
    expect(channelHasScheduleRestriction(satOnly)).toBe(true);
    expect(channelHasScheduleRestriction(eventOnly)).toBe(true);
    expect(channelHasScheduleRestriction(hybrid)).toBe(true);

    // 2026-11-25 is Wed (3), 2026-11-26 is Thu (4), 2026-11-28 is Sat (6)
    expect(isChannelActiveOnDate(flexible, '2026-11-25')).toBe(true);
    expect(isChannelActiveOnDate(satOnly, '2026-11-25')).toBe(false);
    expect(isChannelActiveOnDate(satOnly, '2026-11-28')).toBe(true);
    expect(isChannelActiveOnDate(eventOnly, '2026-11-26')).toBe(true);
    expect(isChannelActiveOnDate(eventOnly, '2026-11-28')).toBe(false);
    expect(isChannelActiveOnDate(hybrid, '2026-11-25')).toBe(true);
    expect(isChannelActiveOnDate(hybrid, '2026-11-28')).toBe(true);
  });

  it('computes the next valid bump date respecting active channel weekdays and specific event dates', () => {
    const channels: PickupChannel[] = [
      {
        id: 1,
        name: 'Wed & Sat Pickup',
        allowedWeekdays: [3, 6],
        specificDates: [],
        colorToken: 'sky',
        isActive: true,
        sortOrder: 0,
      },
      {
        id: 2,
        name: 'Special Holiday Pop-Up',
        allowedWeekdays: [],
        specificDates: ['2026-12-01'],
        colorToken: 'emerald',
        isActive: true,
        sortOrder: 1,
      },
    ];

    // Past-slotted order bumps starting from today (Thu 2026-11-26 -> Sat 2026-11-28)
    expect(
      computeNextBumpDate(
        { slottedDate: '2026-11-25', pickupChannelId: 1 },
        channels,
        '2026-11-26'
      )
    ).toBe('2026-11-28');

    // Today-slotted order bumps strictly past today (Sat 2026-11-28 -> Wed 2026-12-02)
    expect(
      computeNextBumpDate(
        { slottedDate: '2026-11-28', pickupChannelId: 1 },
        channels,
        '2026-11-28'
      )
    ).toBe('2026-12-02');

    // Specific-date event channel jumps to its scheduled event date
    expect(
      computeNextBumpDate(
        { slottedDate: '2026-11-25', pickupChannelId: 2 },
        channels,
        '2026-11-26'
      )
    ).toBe('2026-12-01');

    // Unassigned channel bumps to today if overdue, or next day if today/future
    expect(
      computeNextBumpDate({ slottedDate: '2026-11-24', pickupChannelId: null }, channels, '2026-11-26')
    ).toBe('2026-11-26');
    expect(
      computeNextBumpDate({ slottedDate: '2026-11-26', pickupChannelId: null }, channels, '2026-11-26')
    ).toBe('2026-11-27');
  });

  it('maintains strict cross-function parity across projectDailySupply, previewOrderMoveProjections, evaluateCandidateSlotDates, findEarliestValidSlotDate, and generatePublicAvailability with all consumption/buffer fields populated', () => {
    const entries: DailySupplyEntry[] = [
      {
        id: 1,
        trackedItemId: 1,
        date: '2026-11-23',
        actualOnHand: 15,
        estProduced: null,
        actualEndOfDay: null,
        isCascadeAnchor: false,
        bufferOverride: null,
        extraBuffer: 0,
        selfConsumption: 3,
        walkUpConsumption: 2,
        notes: null,
      },
      {
        id: 2,
        trackedItemId: 1,
        date: '2026-11-24',
        actualOnHand: null,
        estProduced: 6,
        actualEndOfDay: null,
        isCascadeAnchor: false,
        bufferOverride: null,
        extraBuffer: 2,
        selfConsumption: 1,
        walkUpConsumption: 5,
        notes: null,
      },
      {
        id: 3,
        trackedItemId: 1,
        date: '2026-11-25',
        actualOnHand: null,
        estProduced: null,
        actualEndOfDay: null,
        isCascadeAnchor: false,
        bufferOverride: null,
        extraBuffer: 0,
        selfConsumption: 2,
        walkUpConsumption: 1,
        notes: null,
      },
    ];

    const existingOrder = makeOrder({
      id: 10,
      status: 'confirmed',
      slottedDate: '2026-11-24',
      items: [{ trackedItemId: 1, quantity: 4 }],
    });
    const candidateOrder = makeOrder({
      id: 11,
      status: 'waitlist',
      slottedDate: null,
      items: [{ trackedItemId: 1, quantity: 6 }],
    });

    const baseDays = projectDailySupply({
      items: [eggsItem],
      entries,
      orders: [existingOrder],
      startDate: '2026-11-23',
      endDate: '2026-11-28',
      today: '2026-11-23',
    });

    // Candidate evaluator must match previewOrderMoveProjections AND authoritative projectDailySupply on every day
    const candidates = evaluateCandidateSlotDates({
      order: candidateOrder,
      days: baseDays,
      items: [eggsItem],
      channels: [],
      today: '2026-11-23',
    });

    for (const cand of candidates) {
      const preview = previewOrderMoveProjections(baseDays, [eggsItem], candidateOrder, cand.date);
      const authoritative = projectDailySupply({
        items: [eggsItem],
        entries,
        orders: [
          existingOrder,
          { ...candidateOrder, status: 'slotted', slottedDate: cand.date },
        ],
        startDate: '2026-11-23',
        endDate: '2026-11-28',
        today: '2026-11-23',
      });

      expect(preview).toEqual(authoritative);
      const authDay = authoritative.find((d) => d.date === cand.date)!.byItem[1];
      expect(cand.items[0].afterOpen).toBe(authDay.sellableOpen);
      expect(cand.items[0].afterEnding).toBe(authDay.availablePhysical);
    }

    // findEarliestValidSlotDate must choose the exact same date as evaluateCandidateSlotDates's isFirstAvailable
    const firstFromCandidates = candidates.find((c) => c.isFirstAvailable)?.date ?? null;
    const earliest = findEarliestValidSlotDate({
      order: candidateOrder,
      items: [eggsItem],
      entries,
      existingOrders: [existingOrder],
      channels: [],
      today: '2026-11-23',
      startDate: '2026-11-23',
      endDate: '2026-11-28',
    });
    expect(earliest).toBe(firstFromCandidates);

    // Public snippet availability must equal Math.max(0, Math.floor(sellableOpen)) from projectDailySupply
    const snippet = generatePublicAvailability({
      items: [eggsItem],
      days: baseDays,
      channels: [],
      today: '2026-11-23',
      weeks: 1,
      timezone: 'America/New_York',
      now: new Date('2026-11-23T15:00:00Z'),
    });
    for (const day of snippet.days) {
      const proj = baseDays.find((d) => d.date === day.date)?.byItem[1];
      if (!proj) continue;
      expect(day.items[0].approxAvailable).toBe(Math.max(0, Math.floor(proj.sellableOpen)));
    }
  });
});

describe('Shared Order Matching Unit Tests', () => {
  it('detects recurring standing orders cleanly', () => {
    expect(isStandingRecurringOrder(makeOrder({ source: 'standing' }))).toBe(true);
    expect(isStandingRecurringOrder(makeOrder({ source: 'manual', standingOrderId: 9 }))).toBe(true);
    expect(isStandingRecurringOrder(makeOrder({ source: 'odoo', standingOrderId: null }))).toBe(false);
  });

  it('scores duplicate orders across partner ID, name, email, phone and excludes standing orders', () => {
    const a = makeOrder({
      id: 1,
      odooPartnerId: 50,
      customerName: 'Jane Doe',
      customerEmail: 'JANE@example.com',
      customerPhone: '(203) 555-1234',
    });
    const exactMatch = makeOrder({
      id: 2,
      odooPartnerId: 50,
      customerName: 'jane   doe',
      customerEmail: 'jane@example.com',
      customerPhone: '2035551234',
    });
    const substringFirstName = makeOrder({
      id: 3,
      odooPartnerId: null,
      customerName: 'Jane',
      customerEmail: null,
      customerPhone: null,
    });
    const shortFullName = makeOrder({
      id: 30,
      odooPartnerId: null,
      customerName: 'Amy Doe',
      customerEmail: null,
      customerPhone: null,
    });
    const shortFirstNameOnly = makeOrder({
      id: 31,
      odooPartnerId: null,
      customerName: 'Amy',
      customerEmail: null,
      customerPhone: null,
    });
    const differentLastName = makeOrder({
      id: 4,
      odooPartnerId: null,
      customerName: 'Jane Smith',
      customerEmail: null,
      customerPhone: null,
    });
    const standing = makeOrder({ id: 5, source: 'standing', customerName: 'Jane Doe' });

    expect(scoreDuplicateOrder(a, exactMatch)).toBe(100 + 90 + 85 + 80);
    expect(scoreDuplicateOrder(a, substringFirstName)).toBe(40);
    expect(scoreDuplicateOrder(shortFullName, shortFirstNameOnly)).toBe(25);
    expect(scoreDuplicateOrder(a, differentLastName)).toBe(0);
    expect(scoreDuplicateOrder(a, standing)).toBe(0);
  });

  it('ranks replacement candidates for cancelled Odoo quotations and respects dismissals', () => {
    const cancelled = makeOrder({
      id: 10,
      source: 'odoo',
      status: 'pre_approved',
      odooQuotationId: 100,
      odooQuotationName: 'S00100',
      odooMissingFlagged: true,
      odooCreatedAtLocal: '2026-11-20 09:00:00',
      customerName: 'Sam Patel',
      customerEmail: 'sam@example.com',
      dismissedDuplicateOrderIds: [13],
      items: [{ trackedItemId: 1, quantity: 3 }],
    });

    const bestReplacement = makeOrder({
      id: 11,
      source: 'odoo',
      status: 'waitlist',
      odooQuotationId: 105,
      odooQuotationName: 'S00105',
      odooCreatedAtLocal: '2026-11-22 10:00:00',
      customerName: 'Sam Patel',
      customerEmail: 'sam@example.com',
      items: [{ trackedItemId: 1, quantity: 3 }],
    });

    const manualOrder = makeOrder({
      id: 12,
      source: 'manual',
      status: 'slotted',
      customerName: 'Sam Patel',
      customerEmail: null,
      items: [{ trackedItemId: 1, quantity: 2 }],
    });

    const dismissedOrder = makeOrder({
      id: 13,
      source: 'odoo',
      status: 'waitlist',
      odooQuotationId: 106,
      customerName: 'Sam Patel',
      customerEmail: 'sam@example.com',
    });

    const ranked = findReplacementCandidates(cancelled, [
      cancelled,
      manualOrder,
      dismissedOrder,
      bestReplacement,
    ]);
    expect(ranked.map((r) => r.order.id)).toEqual([11, 12]);
    expect(ranked[0].reasons).toContain('new in waitlist');
    expect(ranked[0].reasons).toContain('same items');
  });

  it('selects the primary Odoo quotation side and builds deduplicated chronological Odoo order chains', () => {
    const cancelled = {
      odooQuotationId: 100,
      odooCreatedAtLocal: '2026-11-20 09:00:00',
      status: 'pre_approved' as const,
      odooMissingFlagged: true,
    };
    const activeNewer = {
      odooQuotationId: 105,
      odooCreatedAtLocal: '2026-11-22 09:00:00',
      status: 'waitlist' as const,
      odooMissingFlagged: false,
    };
    const activeConfirmed = {
      odooQuotationId: 102,
      odooCreatedAtLocal: '2026-11-21 09:00:00',
      status: 'confirmed' as const,
      odooMissingFlagged: false,
    };
    const manualOnly = {
      odooQuotationId: null,
      odooCreatedAtLocal: null,
      status: 'slotted' as const,
      odooMissingFlagged: false,
    };

    expect(selectPrimaryOdooSide(cancelled, activeNewer)).toBe('source');
    expect(selectPrimaryOdooSide(activeNewer, cancelled)).toBe('target');
    expect(selectPrimaryOdooSide(activeNewer, activeConfirmed)).toBe('source');
    expect(selectPrimaryOdooSide(manualOnly, activeNewer)).toBe('source');
    expect(selectPrimaryOdooSide(activeNewer, manualOnly)).toBe('target');

    expect(
      buildOrderOdooChain({
        odooQuotationName: 'S00105',
        mergedOdooNames: ['S00100', ' S00102 ', 'S00100', 'S00105', ''],
      })
    ).toEqual(['S00100', 'S00102', 'S00105']);
  });
});

describe('Shared Generators Helper Unit Tests', () => {
  it('formats quantities, item summaries, 12-hour times, and hold cutoff durations cleanly', () => {
    expect(formatQty(3)).toBe('3');
    expect(formatQty(2.5)).toBe('2.5');
    expect(formatQty(1.2500001)).toBe('1.25');

    const itemsById = new Map<number, TrackedItem>([[1, eggsItem]]);
    expect(formatOrderItemsSummary({ items: [] }, itemsById)).toBe('your requested items');
    expect(
      formatOrderItemsSummary(
        {
          items: [
            { trackedItemId: 1, quantity: 2.5 },
            { trackedItemId: 99, quantity: 3 },
          ],
        },
        itemsById
      )
    ).toBe('2.5 dozens Standard Eggs + 3 units');

    expect(format24HourTimeTo12Hour('00:05')).toBe('12:05 AM');
    expect(format24HourTimeTo12Hour('12:00')).toBe('12:00 PM');
    expect(format24HourTimeTo12Hour('16:30')).toBe('4:30 PM');
    expect(format24HourTimeTo12Hour('invalid')).toBe('invalid');

    expect(formatHoldCutoffDuration(1)).toBe('1 hour');
    expect(formatHoldCutoffDuration(48)).toBe('48 hours');
    expect(formatHoldCutoffDuration(0)).toBe('48 hours');
  });

  it('resolves hold cutoff and public order cutoff template values across rule modes', () => {
    const hold = resolveHoldCutoffValues({
      holdThresholdHours: 24,
      baseIso: '2026-11-26T19:00:00.000Z', // Thu Nov 26 2:00 PM EST
      timezone: 'America/New_York',
    });
    expect(hold.holdCutoff).toBe('24 hours');
    expect(hold.holdCutoffDate).toBe('Fri, Nov 27');
    expect(hold.holdCutoffBy).toBe('Fri, Nov 27 at 2:00 PM');

    const cutoffFromRules = resolvePublicOrderCutoffValues({
      pickupDate: '2026-11-28', // Saturday
      showSameDay: false,
      cutoffRules: [
        {
          id: 'r1',
          enabled: true,
          mode: 'days_before',
          daysBefore: 1,
          cutoffWeekday: 5,
          cutoffTime: '16:00',
          pickupWeekdays: [6],
        },
        {
          id: 'r2',
          enabled: true,
          mode: 'weekly_day',
          daysBefore: 1,
          cutoffWeekday: 4, // Thursday earlier than Friday
          cutoffTime: '18:00',
          pickupWeekdays: [6],
        },
      ],
    });
    expect(cutoffFromRules.hasRule).toBe(true);
    expect(cutoffFromRules.orderCutoffDate).toBe('Thu, Nov 26');
    expect(cutoffFromRules.orderCutoffTime).toBe('6:00 PM');
    expect(cutoffFromRules.orderCutoff).toBe('Thu, Nov 26 at 6:00 PM');

    const fallbackNoSameDay = resolvePublicOrderCutoffValues({
      pickupDate: '2026-11-28',
      showSameDay: false,
      cutoffRules: [],
    });
    expect(fallbackNoSameDay.orderCutoff).toBe('Fri, Nov 27 at 11:59 PM');

    const missingDate = resolvePublicOrderCutoffValues({ pickupDate: null });
    expect(missingDate.hasRule).toBe(false);
    expect(missingDate.orderCutoff).toBe('the order cutoff');
  });

  it('validates safe HTTP URLs, normalizes cutoff rules, and strips volatile clock fields in serializeAvailabilityForHash', () => {
    expect(isSafeHttpUrl('https://botlfarm.com/shop')).toBe(true);
    expect(isSafeHttpUrl('http://localhost:3000/test')).toBe(true);
    expect(isSafeHttpUrl('javascript:alert(1)')).toBe(false);
    expect(isSafeHttpUrl('data:text/html,hi')).toBe(false);
    expect(isSafeHttpUrl('not a url')).toBe(false);

    const normalized = normalizeCutoffRules([
      {
        id: 'dup',
        enabled: true,
        mode: 'days_before',
        daysBefore: 99,
        cutoffWeekday: 9,
        cutoffTime: 'bad',
        pickupWeekdays: [6, 3, 6, 99],
      },
      {
        id: 'dup',
        enabled: false,
        mode: 'weekly_day',
        daysBefore: -5,
        cutoffWeekday: 5,
        cutoffTime: '14:30',
        pickupWeekdays: [6],
      },
      null,
    ]);
    expect(normalized).toHaveLength(2);
    expect(normalized[0]).toEqual({
      id: 'dup',
      enabled: true,
      mode: 'days_before',
      daysBefore: 14,
      cutoffWeekday: 5,
      cutoffTime: '16:00',
      pickupWeekdays: [3, 6],
    });
    expect(normalized[1].id).toBe('dup-2');
    expect(normalized[1].enabled).toBe(false);
    expect(normalized[1].daysBefore).toBe(0);

    // serializeAvailabilityForHash ignores generatedAt/today/isPast/isToday/isOrderingClosed
    const days = projectDailySupply({
      items: [eggsItem],
      entries: [],
      orders: [],
      startDate: '2026-11-23',
      endDate: '2026-11-29',
      today: '2026-11-23',
    });
    const resA = generatePublicAvailability({
      items: [eggsItem],
      days,
      channels: [],
      today: '2026-11-23',
      weeks: 1,
      timezone: 'America/New_York',
      now: new Date('2026-11-23T15:00:00Z'),
    });
    const resB = generatePublicAvailability({
      items: [eggsItem],
      days,
      channels: [],
      today: '2026-11-23',
      weeks: 1,
      timezone: 'America/New_York',
      now: new Date('2026-11-23T23:55:00Z'),
    });
    const payloadA = buildPublicAvailabilityJsonPayload(resA);
    const payloadB = buildPublicAvailabilityJsonPayload(resB);
    expect(serializeAvailabilityForHash(payloadA)).toBe(serializeAvailabilityForHash(payloadB));
  });
});

describe('Shared Timezone & Date Utility Unit Tests', () => {
  it('parses Odoo UTC strings and formats local dates/times accurately across EST/EDT', () => {
    const dt = parseOdooUtcToDate('2026-11-24 02:30:00');
    expect(dt.toISOString()).toBe('2026-11-24T02:30:00.000Z');
    expect(Number.isNaN(parseOdooUtcToDate('').getTime())).toBe(true);
    expect(parseOdooUtcToDate('2026-11-24T02:30:00+00:00').toISOString()).toBe(
      '2026-11-24T02:30:00.000Z'
    );

    // 2026-11-24 02:30:00 UTC is 2026-11-23 21:30:00 EST (previous calendar day!)
    expect(formatDateKeyInTimezone(dt, 'America/New_York')).toBe('2026-11-23');
    expect(getTodayDateKey('America/New_York', dt)).toBe('2026-11-23');
    expect(formatLocalSqlTimestamp(dt, 'America/New_York')).toBe('2026-11-23 21:30:00');
    expect(formatLocalTimeHHMM(dt, 'America/New_York')).toBe('21:30');
    expect(formatLocalDateNoYear(dt, 'America/New_York')).toBe('Mon, Nov 23');
    expect(formatLocalDateTimeNoYear(dt, 'America/New_York')).toBe('Mon, Nov 23 at 9:30 PM');
    expect(formatLocalDateTime(dt, 'America/New_York')).toContain('Nov 23, 2026');
  });

  it('performs DST-safe calendar arithmetic, ISO weekday helpers, range checks, and display formatting', () => {
    expect(addDays('2026-03-07', 2)).toBe('2026-03-09'); // crosses US spring-forward DST
    expect(diffDays('2026-11-23', '2026-11-28')).toBe(5);
    expect(getIsoWeekday('2026-11-23')).toBe(1); // Monday
    expect(getIsoWeekday('2026-11-29')).toBe(7); // Sunday
    expect(getMondayOfWeek('2026-11-29')).toBe('2026-11-23');
    expect(listDateRange('2026-11-23', '2026-11-25')).toEqual([
      '2026-11-23',
      '2026-11-24',
      '2026-11-25',
    ]);

    const ranges = [
      { id: '1', startDate: '2026-01-01', endDate: '2026-02-15', label: 'Winter', ignoreExisting: false },
      { id: '2', startDate: '2026-07-01', endDate: '2026-07-10', label: 'Summer', ignoreExisting: true },
    ];
    expect(isDateInIgnoredRanges('2026-01-20', ranges)).toBe(true);
    expect(isDateInIgnoredRanges('2026-03-01', ranges)).toBe(false);
    expect(isDateInFullIgnoredRanges('2026-01-20', ranges)).toBe(false);
    expect(isDateInFullIgnoredRanges('2026-07-05', ranges)).toBe(true);

    expect(formatShortCalendarDate('2026-11-28')).toBe('Nov 28');
    expect(formatFullDisplayDate('2026-11-28')).toBe('Sat, Nov 28, 2026');
    expect(formatDateNoYear('2026-11-28')).toBe('Sat, Nov 28');
    expect(formatDateLongNoYear('2026-11-28')).toBe('Saturday, November 28');
    expect(formatDateNumeric('2026-11-28')).toBe('11/28');
    expect(formatWeekdayLong('2026-11-28')).toBe('Saturday');

    const now = new Date('2026-11-25T15:00:00.000Z');
    expect(getAgingHoldHours(null, now)).toBeNull();
    expect(getAgingHoldHours('2026-11-25T03:00:00.000Z', now)).toBe(12);
    expect(formatAgingBadge(12.8)).toBe('Waiting 12h');
    expect(formatAgingBadge(50)).toBe('Waiting 2d');
  });
});
