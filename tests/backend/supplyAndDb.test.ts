import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterEach, describe, expect, it } from 'vitest';
import { captureCheckpoint, undoLastCheckpoint } from '../../src/server/checkpointService';
import { DatabaseManager, MIGRATIONS, type Migration } from '../../src/server/db';
import {
  listAllOrders,
  listDailySupplyEntries,
  listPickupChannels,
  listTrackedItems,
} from '../../src/server/repository';
import {
  computeStandingOccurrenceDates,
  materializeStandingOrders,
} from '../../src/server/standingEngine';
import { generatePublicAvailability } from '../../src/shared/generators';
import {
  evaluateCandidateSlotDates,
  findEarliestValidSlotDate,
  isWeekdayAllowedForChannel,
  projectDailySupply,
} from '../../src/shared/supplyEngine';
import type { OrderRecord, PickupChannel, TrackedItem } from '../../src/shared/types';

const tmpDirs: string[] = [];

function createTempPaths() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'farm-waitlist-test-'));
  tmpDirs.push(dir);
  return {
    dir,
    dbPath: path.join(dir, 'waitlist.db'),
    backupDir: path.join(dir, 'backups'),
  };
}

afterEach(() => {
  while (tmpDirs.length > 0) {
    const dir = tmpDirs.pop()!;
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

describe('SQLite Blank-Slate Init, Startup Migrations & Backup/Restore', () => {
  it('initializes as a completely clean blank slate with zero sample items, channels, or orders', async () => {
    const { dbPath, backupDir } = createTempPaths();
    const mgr = new DatabaseManager(dbPath, backupDir);
    const res = await mgr.init('America/New_York');

    expect(res.appliedVersions).toEqual([1, 2, 3]);
    expect(res.preMigrateBackup).toBeNull();
    expect(listTrackedItems(mgr.db)).toHaveLength(0);
    expect(listPickupChannels(mgr.db)).toHaveLength(0);
    expect(listAllOrders(mgr.db)).toHaveLength(0);
    expect(mgr.getSettings().timezone).toBe('America/New_York');
    mgr.close();
  });

  it('creates an automatic pre-migrate snapshot before applying new schema migrations on an existing DB', async () => {
    const { dbPath, backupDir } = createTempPaths();
    const mgr1 = new DatabaseManager(dbPath, backupDir, MIGRATIONS);
    await mgr1.init('America/New_York');
    mgr1.close();

    const extendedMigrations: Migration[] = [
      ...MIGRATIONS,
      {
        version: 4,
        name: 'add_test_marker_table',
        sql: 'CREATE TABLE IF NOT EXISTS migration_v4_test (id INTEGER PRIMARY KEY);',
      },
    ];

    const mgr2 = new DatabaseManager(dbPath, backupDir, extendedMigrations);
    const res = await mgr2.init('America/New_York');
    expect(res.appliedVersions).toEqual([4]);
    expect(res.preMigrateBackup).toMatch(/^pre-migrate-.*\.db$/);
    expect(fs.existsSync(path.join(backupDir, res.preMigrateBackup!))).toBe(true);
    mgr2.close();
  });

  it('validates SQLite uploads, saves a pre-restore safety snapshot, and restores cleanly', async () => {
    const { dir, dbPath, backupDir } = createTempPaths();
    const mgr = new DatabaseManager(dbPath, backupDir);
    await mgr.init('America/New_York');

    // Insert real item before backup
    const now = new Date().toISOString();
    mgr.db
      .prepare(
        `INSERT INTO tracked_items (name, unit_label, is_active, supply_mode, default_daily_production, global_safety_buffer, include_in_public_snippet, keyword_rules_json, sort_order, created_at, updated_at)
         VALUES ('Standard Eggs', 'dozens', 1, 'continuous', 20, 5, 1, '[]', 0, ?, ?)`
      )
      .run(now, now);

    const manualSnap = await mgr.createBackup('manual');
    expect(manualSnap.trigger).toBe('manual');
    expect(manualSnap.sizeBytes).toBeGreaterThan(100);

    // Reject a bogus non-SQLite file
    const badFile = path.join(dir, 'not-a-db.db');
    fs.writeFileSync(badFile, 'This is plain text, not a sqlite database file at all!');
    await expect(mgr.restoreFromFile(badFile)).rejects.toThrow(/SQLite/i);

    // Mutate DB (delete item) then restore from manualSnap
    mgr.db.prepare('DELETE FROM tracked_items').run();
    expect(listTrackedItems(mgr.db)).toHaveLength(0);

    const snapPath = mgr.resolveSafeBackupPath(manualSnap.filename);
    const restored = await mgr.restoreFromFile(snapPath);
    expect(restored.safetySnapshot.trigger).toBe('pre-restore');
    expect(listTrackedItems(mgr.db)).toHaveLength(1);
    expect(listTrackedItems(mgr.db)[0].name).toBe('Standard Eggs');

    // Path traversal guard
    expect(() => mgr.resolveSafeBackupPath('../waitlist.db')).toThrow(/Invalid backup filename/);
    mgr.close();
  });
});

describe('Daily Supply Projection Math, Buffers, Cascade Forward & ASAP Auto-Slot', () => {
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

  const turkeyItem: TrackedItem = {
    id: 2,
    name: 'Holiday Turkeys',
    unitLabel: 'birds',
    isActive: true,
    supplyMode: 'discrete',
    defaultDailyProduction: 0,
    globalSafetyBuffer: 2,
    includeInPublicSnippet: false,
    keywordRules: ['turkey'],
    sortOrder: 1,
    createdAt: '',
    updatedAt: '',
  };

  it('computes next-day afternoon harvest rollover, Actual On-Hand overrides, Cascade Forward, per-day buffer overrides, and status tiers', () => {
    const orders: OrderRecord[] = [
      {
        id: 10,
        source: 'manual',
        status: 'slotted',
        timingType: 'specific_date',
        requestedDate: '2026-11-24',
        slottedDate: '2026-11-24',
        isLocked: false,
        customerName: 'Alice',
        customerNameOverridden: false,
        customerEmail: null,
        customerPhone: null,
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
        items: [{ trackedItemId: 1, quantity: 14.5 }],
        chatter: [],
        createdAt: '',
        updatedAt: '',
      },
    ];

    const days = projectDailySupply({
      items: [eggsItem, turkeyItem],
      entries: [
        // Day 1 (Mon 2026-11-23): Morning Actual On-Hand = 5, Afternoon Harvest = 10
        // Today's Ending = 5 - 0 = 5, Buffer = 4 -> Open Today = 1 (green); Tomorrow Starting = 5 + 10 = 15
        {
          id: 1,
          trackedItemId: 1,
          date: '2026-11-23',
          actualOnHand: 5,
          estProduced: null,
          isCascadeAnchor: false,
          bufferOverride: null,
          notes: null,
        },
        // Day 2 (Tue 2026-11-24): Starting = 15 (from Day 1 afternoon harvest), Slotted = 14.5, Afternoon Cascade Harvest = 2
        // Today's Ending = 15 - 14.5 = 0.5, Buffer = 4 -> Open Today = -3.5 (amber); Tomorrow Starting = 0.5 + 2 = 2.5
        {
          id: 2,
          trackedItemId: 1,
          date: '2026-11-24',
          actualOnHand: null,
          estProduced: 2,
          isCascadeAnchor: true,
          bufferOverride: null,
          notes: null,
        },
        // Day 3 (Wed 2026-11-25): Starting = 2.5, Slotted = 0, inherits cascaded afternoon harvest = 2, buffer override = 6
        // Today's Ending = 2.5, Buffer = 6 -> Open Today = -3.5 (amber); Tomorrow Starting = 2.5 + 2 = 4.5
        {
          id: 3,
          trackedItemId: 1,
          date: '2026-11-25',
          actualOnHand: null,
          estProduced: null,
          isCascadeAnchor: false,
          bufferOverride: 6,
          notes: null,
        },
        // Discrete turkey afternoon harvest drop on Day 2 = 12 birds -> NOT available on Day 2, becomes available on Day 3
        {
          id: 4,
          trackedItemId: 2,
          date: '2026-11-24',
          actualOnHand: null,
          estProduced: 12,
          isCascadeAnchor: false,
          bufferOverride: null,
          notes: null,
        },
      ],
      orders,
      startDate: '2026-11-23',
      endDate: '2026-11-26',
      today: '2026-11-23',
    });

    // Day 1 Eggs: afternoon harvest (+10) does NOT inflate Day 1 On-Hand; rolls into Day 2 Starting.
    // Raw Day 1 open is 1, but Day 2's 14.5 order brings Day 2 raw open to -3.5 -> backward ATP constrains Day 1 to -3.5 (amber)
    expect(days[0].byItem[1].startingBalance).toBe(5);
    expect(days[0].byItem[1].estProduced).toBe(10);
    expect(days[0].byItem[1].endingBalance).toBe(5);
    expect(days[0].byItem[1].nextDayStarting).toBe(15);
    expect(days[0].byItem[1].rawSellableOpen).toBe(1);
    expect(days[0].byItem[1].sellableOpen).toBe(-3.5);
    expect(days[0].byItem[1].availablePhysical).toBe(0.5);
    expect(days[0].byItem[1].reservedForFuture).toBe(4.5);
    expect(days[0].byItem[1].constrainedByDate).toBe('2026-11-24');
    expect(days[0].byItem[1].tier).toBe('amber');

    // Day 2 Eggs: starts with 15 from Day 1 harvest, dips into buffer after 14.5 slotted -> amber
    expect(days[1].byItem[1].startingBalance).toBe(15);
    expect(days[1].byItem[1].estProduced).toBe(2);
    expect(days[1].byItem[1].endingBalance).toBe(0.5);
    expect(days[1].byItem[1].nextDayStarting).toBe(2.5);
    expect(days[1].byItem[1].sellableOpen).toBe(-3.5);
    expect(days[1].byItem[1].tier).toBe('amber');

    // Day 3 Eggs: starts with 2.5, cascaded afternoon harvest of 2 + buffer override 6
    expect(days[2].byItem[1].startingBalance).toBe(2.5);
    expect(days[2].byItem[1].estProduced).toBe(2);
    expect(days[2].byItem[1].effectiveBuffer).toBe(6);
    expect(days[2].byItem[1].endingBalance).toBe(2.5);
    expect(days[2].byItem[1].nextDayStarting).toBe(4.5);
    expect(days[2].byItem[1].sellableOpen).toBe(-3.5);
    expect(days[2].byItem[1].tier).toBe('amber');

    // Day 4 Eggs: starts with 4.5, returns to global buffer 4 -> Ending 4.5, Open 0.5 green, Tomorrow Starting 6.5
    expect(days[3].byItem[1].startingBalance).toBe(4.5);
    expect(days[3].byItem[1].estProduced).toBe(2);
    expect(days[3].byItem[1].effectiveBuffer).toBe(4);
    expect(days[3].byItem[1].endingBalance).toBe(4.5);
    expect(days[3].byItem[1].nextDayStarting).toBe(6.5);
    expect(days[3].byItem[1].sellableOpen).toBe(0.5);
    expect(days[3].byItem[1].tier).toBe('green');

    // Discrete Turkeys: harvested afternoon of Day 2 (+12) -> NOT available Day 2 (ending 0, open -2), available Day 3 (starting 12, open 10 green)
    expect(days[0].byItem[2].estProduced).toBe(0);
    expect(days[1].byItem[2].estProduced).toBe(12);
    expect(days[1].byItem[2].endingBalance).toBe(0);
    expect(days[1].byItem[2].sellableOpen).toBe(-2);
    expect(days[1].byItem[2].nextDayStarting).toBe(12);
    expect(days[2].byItem[2].startingBalance).toBe(12);
    expect(days[2].byItem[2].estProduced).toBe(0);
    expect(days[2].byItem[2].endingBalance).toBe(12);
    expect(days[2].byItem[2].sellableOpen).toBe(10);
    expect(days[2].byItem[2].tier).toBe('green');
  });

  it('computes Available-to-Promise (ATP) sellable availability when a future pre-approved order consumes today’s on-hand stock', () => {
    const farmEggs: TrackedItem = {
      ...eggsItem,
      defaultDailyProduction: 5,
      globalSafetyBuffer: 4,
    };

    const preApprovedOn27th: OrderRecord = {
      id: 77,
      source: 'manual',
      status: 'pre_approved',
      timingType: 'specific_date',
      requestedDate: '2026-11-27',
      slottedDate: '2026-11-27',
      isLocked: false,
      customerName: 'Big Buyer',
      customerNameOverridden: false,
      customerEmail: null,
      customerPhone: null,
      pickupChannelId: null,
      freeTextPickup: null,
      notes: null,
      preApprovedAt: '2026-11-25T15:00:00Z',
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
      items: [{ trackedItemId: 1, quantity: 19 }],
      chatter: [],
      createdAt: '',
      updatedAt: '',
    };

    const days = projectDailySupply({
      items: [farmEggs],
      entries: [
        // Nov 26: 21 on hand, buffer 4 -> raw open = 17, afternoon harvest = +5 -> Nov 27 starts with 26
        // Nov 27: 26 - 19 pre-approved = 7 remaining on hand, buffer 4 -> Can Sell = 3
        // Therefore on Nov 26 you have 21 On Hand, 14 Held for Nov 27, and Can Sell only 3 (NOT 17)!
        {
          id: 10,
          trackedItemId: 1,
          date: '2026-11-26',
          actualOnHand: 21,
          estProduced: null,
          isCascadeAnchor: false,
          bufferOverride: null,
          notes: null,
        },
      ],
      orders: [preApprovedOn27th],
      startDate: '2026-11-26',
      endDate: '2026-11-28',
      today: '2026-11-26',
    });

    const nov26 = days[0].byItem[1];
    const nov27 = days[1].byItem[1];
    const nov28 = days[2].byItem[1];

    expect(nov26.startingBalance).toBe(21);
    expect(nov26.endingBalance).toBe(21);
    expect(nov26.rawSellableOpen).toBe(17);
    expect(nov26.sellableOpen).toBe(3);
    expect(nov26.availablePhysical).toBe(7);
    expect(nov26.reservedForFuture).toBe(14);
    expect(nov26.constrainedByDate).toBe('2026-11-27');
    expect(nov26.tier).toBe('green');

    expect(nov27.startingBalance).toBe(26);
    expect(nov27.slottedQty).toBe(19);
    expect(nov27.endingBalance).toBe(7);
    expect(nov27.sellableOpen).toBe(3);
    expect(nov27.reservedForFuture).toBe(0);
    expect(nov27.constrainedByDate).toBeNull();

    // Nov 28 starts with 7 + 5 = 12, buffer 4 -> Can Sell 8
    expect(nov28.startingBalance).toBe(12);
    expect(nov28.sellableOpen).toBe(8);

    // Public calendar snippet must also report ~3 dozens (not ~17 dozens) on Nov 26
    const snippet = generatePublicAvailability({
      items: [farmEggs],
      days,
      channels: [],
      today: '2026-11-26',
      weeks: 1,
      timezone: 'America/New_York',
      now: new Date('2026-11-26T15:00:00Z'),
    });
    expect(snippet.days[0].date).toBe('2026-11-26');
    expect(snippet.days[0].items[0].approxAvailable).toBe(3);
    expect(snippet.html).toContain('~3 dozens');
    expect(snippet.html).not.toContain('~17 dozens');
    expect(snippet.html).toContain('fw-cal-grid');
  });

  it('supports single-day additional safety buffer (walk-up holdback) with ATP carry-back and one-off / specific-date pickup channels', () => {
    const farmEggs: TrackedItem = {
      ...eggsItem,
      defaultDailyProduction: 5,
      globalSafetyBuffer: 4,
    };

    const days = projectDailySupply({
      items: [farmEggs],
      entries: [
        // Nov 26: 20 on hand, global buffer 4 -> raw open 16, harvest +5 -> Nov 27 starts at 25
        {
          id: 1,
          trackedItemId: 1,
          date: '2026-11-26',
          actualOnHand: 20,
          estProduced: null,
          isCascadeAnchor: false,
          bufferOverride: null,
          extraBuffer: 0,
          notes: null,
        },
        // Nov 27 (Event Day): +15 additional safety buffer for walk-ups -> effectiveBuffer = 4 + 15 = 19!
        // Nov 27 raw open = 25 - 19 = 6 -> ATP pulls Nov 26 Can Sell down from 16 to 6 (Holding 10 for Nov 27)
        // Nov 28 returns to normal global buffer 4 -> starting 30, Can Sell 26
        {
          id: 2,
          trackedItemId: 1,
          date: '2026-11-27',
          actualOnHand: null,
          estProduced: null,
          isCascadeAnchor: false,
          bufferOverride: null,
          extraBuffer: 15,
          notes: 'Monthly Brewery Pop-Up',
        },
      ],
      orders: [],
      startDate: '2026-11-26',
      endDate: '2026-11-28',
      today: '2026-11-26',
    });

    // Nov 26 holds back 10 so Nov 27's walk-up buffer isn't oversold
    expect(days[0].byItem[1].rawSellableOpen).toBe(16);
    expect(days[0].byItem[1].sellableOpen).toBe(6);
    expect(days[0].byItem[1].reservedForFuture).toBe(10);
    expect(days[0].byItem[1].constrainedByDate).toBe('2026-11-27');

    // Nov 27 has effectiveBuffer = 19 (4 global + 15 extra)
    expect(days[1].byItem[1].extraBuffer).toBe(15);
    expect(days[1].byItem[1].effectiveBuffer).toBe(19);
    expect(days[1].byItem[1].sellableOpen).toBe(6);

    // Nov 28 automatically returns to global buffer 4
    expect(days[2].byItem[1].extraBuffer).toBe(0);
    expect(days[2].byItem[1].effectiveBuffer).toBe(4);
    expect(days[2].byItem[1].sellableOpen).toBe(26);

    // One-off / monthly varying-date channel (specificDates only, empty allowedWeekdays)
    const monthlyPopup: PickupChannel = {
      id: 10,
      name: 'Monthly Brewery Pop-Up',
      allowedWeekdays: [],
      specificDates: ['2026-11-27'],
      colorToken: 'sky',
      isActive: true,
      sortOrder: 0,
    };
    const flexibleOneOff: PickupChannel = {
      id: 11,
      name: 'One-Off Barn Pickup',
      allowedWeekdays: [],
      specificDates: [],
      colorToken: 'sky',
      isActive: true,
      sortOrder: 1,
    };

    expect(isWeekdayAllowedForChannel('2026-11-26', 10, [monthlyPopup, flexibleOneOff]).allowed).toBe(false);
    expect(isWeekdayAllowedForChannel('2026-11-27', 10, [monthlyPopup, flexibleOneOff]).allowed).toBe(true);
    expect(isWeekdayAllowedForChannel('2026-11-26', 11, [monthlyPopup, flexibleOneOff]).allowed).toBe(true);

    // Public snippet displays the specific-date event channel ONLY on Nov 27
    const snippet = generatePublicAvailability({
      items: [farmEggs],
      days,
      channels: [monthlyPopup],
      today: '2026-11-26',
      weeks: 1,
      timezone: 'America/New_York',
      now: new Date('2026-11-26T15:00:00Z'),
    });
    expect(snippet.days.find((d) => d.date === '2026-11-26')?.channelNames).toEqual([]);
    expect(snippet.days.find((d) => d.date === '2026-11-27')?.channelNames).toEqual([
      'Monthly Brewery Pop-Up',
    ]);
  });

  it('rolls prior Actual On-Hand anchors forward across intervening days before startDate and never reports reservedForFuture above remaining physical stock', () => {
    // Anchor on Fri 2026-11-20 = 10 on hand, daily prod = 4, buffer = 1
    // Fri Nov 20: 10 - 6 (order) + 4 = 8 -> Sat Nov 21: 8 - 0 + 4 = 12 -> Sun Nov 22: 12 - 4 (order) + 4 = 12 -> Mon Nov 23 starts at 12!
    const farmEggs: TrackedItem = {
      ...eggsItem,
      defaultDailyProduction: 4,
      globalSafetyBuffer: 1,
    };
    const makeConfirmed = (id: number, date: string, qty: number): OrderRecord => ({
      id,
      source: 'manual',
      status: 'confirmed',
      timingType: 'specific_date',
      requestedDate: date,
      slottedDate: date,
      isLocked: false,
      customerName: `Customer ${id}`,
      customerNameOverridden: false,
      customerEmail: null,
      customerPhone: null,
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
      items: [{ trackedItemId: 1, quantity: qty }],
      chatter: [],
      createdAt: '',
      updatedAt: '',
    });

    const days = projectDailySupply({
      items: [farmEggs],
      entries: [
        {
          id: 1,
          trackedItemId: 1,
          date: '2026-11-20',
          actualOnHand: 10,
          estProduced: null,
          isCascadeAnchor: false,
          bufferOverride: null,
          extraBuffer: 0,
          notes: null,
        },
      ],
      orders: [
        makeConfirmed(1, '2026-11-20', 6),
        makeConfirmed(2, '2026-11-22', 4),
        // Mon Nov 23 uses all 12 on hand -> endingBalance = 0; Tue Nov 24 has 10 ordered (short -6)
        makeConfirmed(3, '2026-11-23', 12),
        makeConfirmed(4, '2026-11-24', 10),
      ],
      startDate: '2026-11-23',
      endDate: '2026-11-25',
      today: '2026-11-23',
    });

    // Mon Nov 23 starts at rolled-forward 12 (not stale 10!)
    expect(days[0].byItem[1].startingBalance).toBe(12);
    expect(days[0].byItem[1].endingBalance).toBe(0);
    // Tue Nov 24 goes short -6 (4 - 10 = -6), so Mon Nov 23 has availablePhysical = -6 (red),
    // but reservedForFuture is capped at endingBalance (0), never claiming stock is held on hand when 0 remains!
    expect(days[0].byItem[1].availablePhysical).toBe(-6);
    expect(days[0].byItem[1].tier).toBe('red');
    expect(days[0].byItem[1].reservedForFuture).toBe(0);
  });

  it('auto-slots ASAP orders onto earliest channel-allowed weekday keeping Sellable Open >= 0 using prior-day harvests', () => {
    const saturdayMarket: PickupChannel = {
      id: 1,
      name: 'Wooster Square',
      allowedWeekdays: [6], // Saturdays only
      colorToken: 'sky',
      isActive: true,
      sortOrder: 0,
    };

    const asapOrder: OrderRecord = {
      id: 99,
      source: 'manual',
      status: 'waitlist',
      timingType: 'asap',
      requestedDate: null,
      slottedDate: null,
      isLocked: false,
      customerName: 'Bob',
      customerNameOverridden: false,
      customerEmail: null,
      customerPhone: null,
      pickupChannelId: 1,
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
      items: [{ trackedItemId: 1, quantity: 30 }],
      chatter: [],
      createdAt: '',
      updatedAt: '',
    };

    const chosen = findEarliestValidSlotDate({
      order: asapOrder,
      items: [eggsItem],
      entries: [],
      existingOrders: [],
      channels: [saturdayMarket],
      today: '2026-11-23', // Monday
      startDate: '2026-11-23',
      endDate: '2026-12-13',
    });

    // Mon–Fri (5 afternoons) * 10 = 50 on hand Saturday morning 2026-11-28, buffer 4 -> Open 46 >= 30
    expect(chosen).toBe('2026-11-28');
  });

  it('generates anonymized public HTML availability snippet reflecting next-day harvest availability with zero customer names', () => {
    const days = projectDailySupply({
      items: [eggsItem, turkeyItem],
      entries: [],
      orders: [],
      startDate: '2026-11-23',
      endDate: '2026-12-20',
      today: '2026-11-23',
    });

    const snippet = generatePublicAvailability({
      items: [eggsItem, turkeyItem],
      days,
      channels: [],
      today: '2026-11-23',
      weeks: 3,
      timezone: 'America/New_York',
      now: new Date('2026-11-23T15:00:00Z'),
    });

    expect(snippet.days).toHaveLength(21);
    expect(snippet.calendarDays).toHaveLength(21);
    // Only Standard Eggs has includeInPublicSnippet = true
    expect(snippet.days[0].items.map((i) => i.itemName)).toEqual(['Standard Eggs']);
    // Day 1 starts at 0 (afternoon harvest isn't available yet -> Waitlist Full); Day 2 starts at 10, buffer 4 -> ~6 dozens
    expect(snippet.days[0].items[0].status).toBe('Waitlist Full');
    expect(snippet.days[0].items[0].approxAvailable).toBe(0);
    expect(snippet.days[0].items[0].approxLabel).toBe('Waitlist Full');
    expect(snippet.days[1].items[0].status).toBe('Available');
    expect(snippet.days[1].items[0].approxAvailable).toBe(6);
    expect(snippet.days[1].items[0].approxLabel).toBe('Available (~6 dozens)');
    expect(snippet.html).toContain('Availability accurate as of');
    expect(snippet.html).toContain('Standard Eggs');
    expect(snippet.html).toContain('fw-cal-grid');
    expect(snippet.html).toContain('~6 dozens');
    expect(snippet.html).not.toContain('Holiday Turkeys');
  });

  it('evaluates candidate slot dates with live open/buffer/short availability and identifies first available channel date', () => {
    const wedSatMarket: PickupChannel = {
      id: 2,
      name: 'Midweek & Sat Market',
      allowedWeekdays: [3, 6], // Wed & Sat
      colorToken: 'sky',
      isActive: true,
      sortOrder: 0,
    };

    const days = projectDailySupply({
      items: [eggsItem],
      entries: [
        // Day 1 Mon 2026-11-23: Morning stock 0, afternoon harvest +10 -> Open -4
        // Day 2 Tue 2026-11-24: Morning stock 10, afternoon harvest +10 -> Open 6
        // Day 3 Wed 2026-11-25: Morning stock 20, afternoon harvest +10 -> Open 16
      ],
      orders: [],
      startDate: '2026-11-23',
      endDate: '2026-11-29',
      today: '2026-11-23',
    });

    const waitlistOrder: OrderRecord = {
      id: 55,
      source: 'manual',
      status: 'waitlist',
      timingType: 'asap',
      requestedDate: null,
      slottedDate: null,
      isLocked: false,
      customerName: 'Waitlist Wendy',
      customerNameOverridden: false,
      customerEmail: null,
      customerPhone: null,
      pickupChannelId: 2,
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
      items: [{ trackedItemId: 1, quantity: 8 }],
      chatter: [],
      createdAt: '',
      updatedAt: '',
    };

    const candidates = evaluateCandidateSlotDates({
      order: waitlistOrder,
      draftPickupChannelId: 2,
      days,
      items: [eggsItem],
      channels: [wedSatMarket],
      today: '2026-11-23',
    });

    // Day 1 Mon (0 on hand, -4 open): deficit & off-channel
    expect(candidates[0].date).toBe('2026-11-23');
    expect(candidates[0].channelAllowed).toBe(false);
    expect(candidates[0].fit).toBe('deficit');

    // Day 2 Tue (10 on hand, 6 open, needs 8 -> afterEnding 2 >= 0, afterOpen -2 < 0): buffer & off-channel
    expect(candidates[1].date).toBe('2026-11-24');
    expect(candidates[1].channelAllowed).toBe(false);
    expect(candidates[1].fit).toBe('buffer');
    expect(candidates[1].items[0].afterOpen).toBe(-2);

    // Day 3 Wed (20 on hand, 16 open, needs 8 -> afterOpen 8 >= 0): fits & channelAllowed -> First Available!
    expect(candidates[2].date).toBe('2026-11-25');
    expect(candidates[2].channelAllowed).toBe(true);
    expect(candidates[2].fit).toBe('fits');
    expect(candidates[2].isFirstAvailable).toBe(true);
    expect(candidates[2].items[0].currentOpen).toBe(16);
    expect(candidates[2].items[0].afterOpen).toBe(8);

    // Only one candidate is flagged isFirstAvailable
    expect(candidates.filter((c) => c.isFirstAvailable).map((c) => c.date)).toEqual(['2026-11-25']);
  });
});

describe('Standing Orders Materialization, Per-Week Exceptions & Undo Checkpoints', () => {
  it('materializes locked weekly/biweekly standing orders and respects single-week skip exceptions', async () => {
    const { dbPath, backupDir } = createTempPaths();
    const mgr = new DatabaseManager(dbPath, backupDir);
    await mgr.init('America/New_York');
    const now = new Date().toISOString();

    const itemId = Number(
      mgr.db
        .prepare(
          `INSERT INTO tracked_items (name, unit_label, is_active, supply_mode, default_daily_production, global_safety_buffer, include_in_public_snippet, keyword_rules_json, sort_order, created_at, updated_at)
           VALUES ('Standard Eggs', 'dozens', 1, 'continuous', 20, 4, 1, '[]', 0, ?, ?)`
        )
        .run(now, now).lastInsertRowid
    );

    const standingId = Number(
      mgr.db
        .prepare(
          `INSERT INTO standing_orders (customer_name, customer_contact, pickup_channel_id, cadence, weekday, start_date, is_active, notes, items_json, created_at, updated_at)
           VALUES ('Bakery Co', '555-0100', NULL, 'biweekly', 6, '2026-11-23', 1, 'Standing', ?, ?, ?)`
        )
        .run(JSON.stringify([{ trackedItemId: itemId, quantity: 6 }]), now, now).lastInsertRowid
    );

    const dates = computeStandingOccurrenceDates(
      { cadence: 'biweekly', weekday: 6, startDate: '2026-11-23' },
      '2026-11-23',
      '2026-12-27'
    );
    expect(dates).toEqual(['2026-11-28', '2026-12-12', '2026-12-26']);

    const mat1 = materializeStandingOrders(mgr.db, '2026-11-23', '2026-12-27');
    expect(mat1.createdCount).toBe(3);

    const orders = listAllOrders(mgr.db);
    expect(orders).toHaveLength(3);
    expect(orders.every((o) => o.isLocked && o.source === 'standing')).toBe(true);

    // Record undo checkpoint, skip 2026-12-12, re-materialize -> should stay skipped
    captureCheckpoint(mgr.db, 'Before skipping Dec 12');
    mgr.db
      .prepare(
        `INSERT INTO standing_order_exceptions (standing_order_id, occurrence_date, action)
         VALUES (?, '2026-12-12', 'skipped')`
      )
      .run(standingId);
    mgr.db
      .prepare(`DELETE FROM orders WHERE standing_order_id = ? AND standing_occurrence_date = '2026-12-12'`)
      .run(standingId);

    materializeStandingOrders(mgr.db, '2026-11-23', '2026-12-27');
    expect(listAllOrders(mgr.db).map((o) => o.slottedDate)).toEqual(['2026-11-28', '2026-12-26']);

    // Undo restores the skipped occurrence & clears the exception!
    const undone = undoLastCheckpoint(mgr.db);
    expect(undone.restoredLabel).toBe('Before skipping Dec 12');
    expect(listAllOrders(mgr.db).map((o) => o.slottedDate)).toEqual([
      '2026-11-28',
      '2026-12-12',
      '2026-12-26',
    ]);
    expect(listDailySupplyEntries(mgr.db)).toHaveLength(0);
    mgr.close();
  });
});
