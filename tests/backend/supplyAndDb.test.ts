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
import {
  buildPreApprovalMailtoHref,
  generatePublicAvailability,
  messageHasLinks,
  parseSafeRichMessageSegments,
  renderMessageToPlainText,
  renderMessageToSafeHtml,
  renderPreApprovalMessage,
  renderPreApprovalSamplePreview,
  selectBestPreApprovalTemplate,
  splitCustomerName,
} from '../../src/shared/generators';
import {
  previewMergeOutcome,
  resolveMergeDateOptions,
} from '../../src/shared/orderMatching';
import {
  evaluateCandidateSlotDates,
  findEarliestValidSlotDate,
  isWeekdayAllowedForChannel,
  previewOrderMoveProjections,
  projectDailySupply,
} from '../../src/shared/supplyEngine';
import type {
  OrderRecord,
  PickupChannel,
  PreApprovalTemplate,
  TrackedItem,
} from '../../src/shared/types';

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

    expect(res.appliedVersions).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
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
        version: 11,
        name: 'add_test_marker_table',
        sql: 'CREATE TABLE IF NOT EXISTS migration_v11_test (id INTEGER PRIMARY KEY);',
      },
    ];

    const mgr2 = new DatabaseManager(dbPath, backupDir, extendedMigrations);
    const res = await mgr2.init('America/New_York');
    expect(res.appliedVersions).toEqual([11]);
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

  it('keeps live drag-and-drop previewOrderMoveProjections 100% identical to projectDailySupply with self consumption, walk-up sales, physical resets, and extra buffers', () => {
    const entries = [
      {
        id: 1,
        trackedItemId: 1,
        date: '2026-11-23',
        actualOnHand: 20,
        estProduced: null,
        actualEndOfDay: null,
        isCascadeAnchor: false,
        bufferOverride: null,
        extraBuffer: 0,
        selfConsumption: 2.5,
        walkUpConsumption: 3,
        notes: null,
      },
      {
        id: 2,
        trackedItemId: 1,
        date: '2026-11-24',
        actualOnHand: null,
        estProduced: 8,
        actualEndOfDay: null,
        isCascadeAnchor: true,
        bufferOverride: null,
        extraBuffer: 2,
        selfConsumption: 1,
        walkUpConsumption: 4.5,
        notes: null,
      },
      {
        id: 3,
        trackedItemId: 1,
        date: '2026-11-25',
        actualOnHand: null,
        estProduced: null,
        actualEndOfDay: 18,
        isCascadeAnchor: false,
        bufferOverride: null,
        extraBuffer: 0,
        selfConsumption: 1.5,
        walkUpConsumption: 0,
        notes: null,
      },
      {
        id: 4,
        trackedItemId: 1,
        date: '2026-11-26',
        actualOnHand: null,
        estProduced: null,
        actualEndOfDay: null,
        isCascadeAnchor: false,
        bufferOverride: 5,
        extraBuffer: 3,
        selfConsumption: 0,
        walkUpConsumption: 2,
        notes: null,
      },
      {
        id: 5,
        trackedItemId: 1,
        date: '2026-11-27',
        actualOnHand: 22,
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

    const makeOrder = (
      id: number,
      status: OrderRecord['status'],
      slottedDate: string | null,
      qty: number
    ): OrderRecord => ({
      id,
      source: 'manual',
      status,
      timingType: slottedDate ? 'specific_date' : 'asap',
      requestedDate: slottedDate,
      slottedDate,
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

    const movableOrder = makeOrder(10, 'pre_approved', '2026-11-24', 6);
    const otherOrder = makeOrder(11, 'confirmed', '2026-11-26', 9);
    const waitlistOrder = makeOrder(12, 'waitlist', null, 5);
    const initialOrders = [movableOrder, otherOrder, waitlistOrder];

    const baseDays = projectDailySupply({
      items: [eggsItem, turkeyItem],
      entries,
      orders: initialOrders,
      startDate: '2026-11-23',
      endDate: '2026-11-29',
      today: '2026-11-23',
    });

    // Case 1: Dragging an already-slotted order from Tue (Nov 24) to Sat (Nov 28) across EOD & Morning resets
    const previewMoved = previewOrderMoveProjections(
      baseDays,
      [eggsItem, turkeyItem],
      movableOrder,
      '2026-11-28'
    );
    const afterMoved = projectDailySupply({
      items: [eggsItem, turkeyItem],
      entries,
      orders: [
        { ...movableOrder, slottedDate: '2026-11-28' },
        otherOrder,
        waitlistOrder,
      ],
      startDate: '2026-11-23',
      endDate: '2026-11-29',
      today: '2026-11-23',
    });
    expect(previewMoved).toEqual(afterMoved);

    // Unaffected days separated by physical resets (e.g. Nov 26 after Nov 25 EOD count) must not spuriously drift
    expect(previewMoved[3].byItem[1].endingBalance).toBe(baseDays[3].byItem[1].endingBalance);
    expect(previewMoved[3].byItem[1].sellableOpen).toBe(baseDays[3].byItem[1].sellableOpen);

    // Case 2: Dragging a waitlist order onto Wed (Nov 25)
    const previewWaitlist = previewOrderMoveProjections(
      baseDays,
      [eggsItem, turkeyItem],
      waitlistOrder,
      '2026-11-25'
    );
    const afterWaitlist = projectDailySupply({
      items: [eggsItem, turkeyItem],
      entries,
      orders: [
        movableOrder,
        otherOrder,
        { ...waitlistOrder, status: 'slotted', slottedDate: '2026-11-25' },
      ],
      startDate: '2026-11-23',
      endDate: '2026-11-29',
      today: '2026-11-23',
    });
    expect(previewWaitlist).toEqual(afterWaitlist);
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

describe('Multi-Template Pre-Approval Engine, Safe HTML Links & Persistence', () => {
  const baseOrder: OrderRecord = {
    id: 1,
    source: 'manual',
    status: 'slotted',
    timingType: 'specific_date',
    requestedDate: '2026-11-28',
    slottedDate: '2026-11-28',
    isLocked: false,
    customerName: 'Clara',
    customerNameOverridden: false,
    customerEmail: 'clara@example.com',
    customerPhone: '555-0100',
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
    items: [{ trackedItemId: 5, quantity: 3 }],
    chatter: [],
    createdAt: '',
    updatedAt: '',
  };

  it('auto-selects templates by specificity: channel+item > item > channel > default', () => {
    const templates: PreApprovalTemplate[] = [
      {
        id: 'default-email',
        name: 'Default Email',
        format: 'html',
        body: 'Default body',
        isDefault: true,
        channelIds: [],
        itemIds: [],
      },
      {
        id: 'channel-only',
        name: 'Market Email',
        format: 'html',
        body: 'Channel body',
        isDefault: false,
        channelIds: [2],
        itemIds: [],
      },
      {
        id: 'item-only',
        name: 'Turkey Email',
        format: 'html',
        body: 'Item body',
        isDefault: false,
        channelIds: [],
        itemIds: [5],
      },
      {
        id: 'channel-and-item',
        name: 'Market Turkey Email',
        format: 'html',
        body: 'Channel + Item body',
        isDefault: false,
        channelIds: [2],
        itemIds: [5],
      },
    ];

    expect(selectBestPreApprovalTemplate(templates, baseOrder)?.id).toBe('channel-and-item');
    expect(selectBestPreApprovalTemplate(templates.slice(0, 3), baseOrder)?.id).toBe('item-only');
    expect(selectBestPreApprovalTemplate(templates.slice(0, 2), baseOrder)?.id).toBe('channel-only');
    expect(
      selectBestPreApprovalTemplate(templates, {
        ...baseOrder,
        pickupChannelId: 99,
        items: [{ trackedItemId: 88, quantity: 1 }],
      })?.id
    ).toBe('default-email');
  });

  it('parses safe http/https HTML, markdown, and bare links while neutralizing javascript: URLs and raw HTML tags', () => {
    const safeMsg =
      'Hi Clara! Order at <a href="https://botlfarm.com/shop">our farm store</a> or [Pickup Info](https://botlfarm.com/pickup) or https://botlfarm.com/faq.';
    expect(messageHasLinks(safeMsg)).toBe(true);
    const segments = parseSafeRichMessageSegments(safeMsg);
    const links = segments.filter((s) => s.type === 'link');
    expect(links).toEqual([
      { type: 'link', label: 'our farm store', href: 'https://botlfarm.com/shop' },
      { type: 'link', label: 'Pickup Info', href: 'https://botlfarm.com/pickup' },
      { type: 'link', label: 'https://botlfarm.com/faq', href: 'https://botlfarm.com/faq' },
    ]);

    const html = renderMessageToSafeHtml(safeMsg);
    expect(html).toContain(
      '<a href="https://botlfarm.com/shop" target="_blank" rel="noopener noreferrer">our farm store</a>'
    );
    expect(html).toContain(
      '<a href="https://botlfarm.com/pickup" target="_blank" rel="noopener noreferrer">Pickup Info</a>'
    );

    const plain = renderMessageToPlainText(safeMsg);
    expect(plain).toContain('our farm store (https://botlfarm.com/shop)');
    expect(plain).toContain('Pickup Info (https://botlfarm.com/pickup)');
    expect(plain).toContain('https://botlfarm.com/faq');

    // XSS / unsafe protocol attempts must NOT produce link segments or executable HTML
    const malicious =
      'Click <a href="javascript:alert(1)">Bad Link</a> and <script>alert(2)</script> <img src=x onerror=alert(3)>';
    const unsafeSegs = parseSafeRichMessageSegments(malicious);
    expect(unsafeSegs.filter((s) => s.type === 'link')).toHaveLength(0);
    const escapedHtml = renderMessageToSafeHtml(malicious);
    expect(escapedHtml).not.toContain('<script>');
    expect(escapedHtml).not.toContain('<a ');
    expect(escapedHtml).not.toContain('<img');
    expect(escapedHtml).toContain('&lt;script&gt;');
  });

  it('migrates legacy preApprovalTemplate into preApprovalTemplates and persists multiple templates cleanly', async () => {
    const { dbPath, backupDir } = createTempPaths();
    const mgr = new DatabaseManager(dbPath, backupDir);
    await mgr.init('America/New_York');

    // Simulate a legacy DB row that only has preApprovalTemplate and no preApprovalTemplates key
    mgr.db.prepare(`DELETE FROM app_settings WHERE key = 'preApprovalTemplates'`).run();
    mgr.db
      .prepare(
        `INSERT INTO app_settings (key, value_json, updated_at) VALUES ('preApprovalTemplate', ?, ?)
         ON CONFLICT(key) DO UPDATE SET value_json = excluded.value_json`
      )
      .run(JSON.stringify('Legacy custom hello {{name}}!'), new Date().toISOString());

    const migrated = mgr.getSettings();
    expect(migrated.preApprovalTemplates?.length).toBeGreaterThanOrEqual(2);
    const defaultTmpl = migrated.preApprovalTemplates!.find((t) => t.isDefault);
    expect(defaultTmpl?.body).toBe('Legacy custom hello {{name}}!');

    // Save custom multi-template list and verify reload + legacy sync
    const updated = mgr.updateSettings({
      preApprovalTemplates: [
        {
          id: 'email-store',
          name: 'Store Link Email',
          format: 'html',
          body: 'Hi {{name}}, place your order at <a href="https://botlfarm.com/shop">BOTL Farm Store</a>!',
          isDefault: true,
          channelIds: [],
          itemIds: [],
        },
        {
          id: 'sms-short',
          name: 'Text / SMS',
          format: 'plain',
          body: 'Hi {{name}}, your eggs are ready for {{date}}: https://botlfarm.com/shop',
          isDefault: false,
          channelIds: [1],
          itemIds: [],
        },
      ],
    });

    expect(updated.preApprovalTemplates).toHaveLength(2);
    expect(updated.preApprovalTemplate).toContain('BOTL Farm Store');
    expect(mgr.getSettings().preApprovalTemplates?.[1].channelIds).toEqual([1]);
    mgr.close();
  });

  it('supports customizable snippet header/footer text (with safe links) and optional daily Today auto-advance script', () => {
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

    const days = projectDailySupply({
      items: [eggsItem],
      entries: [],
      orders: [],
      startDate: '2026-11-23',
      endDate: '2026-12-06',
      today: '2026-11-23',
    });

    const withCustom = generatePublicAvailability({
      items: [eggsItem],
      days,
      channels: [],
      today: '2026-11-23',
      weeks: 2,
      timezone: 'America/New_York',
      now: new Date('2026-11-23T15:00:00Z'),
      headerTitle: 'BOTL Farm Fresh Egg Availability',
      headerText:
        'Order at <a href="https://botlfarm.com/shop">BOTL Farm Store</a> <script>alert(1)</script>',
      footerText: 'Questions? Email us or visit https://botlfarm.com/contact',
      autoAdvanceToday: true,
    });

    expect(withCustom.headerTitle).toBe('BOTL Farm Fresh Egg Availability');
    expect(withCustom.html).toContain('BOTL Farm Fresh Egg Availability');
    expect(withCustom.html).toContain('<p class="fw-cal-intro">Order at <a href="https://botlfarm.com/shop"');
    expect(withCustom.html).toContain('&lt;script&gt;alert(1)&lt;/script&gt;');
    expect(withCustom.html).toContain('https://botlfarm.com/contact');
    expect(withCustom.html).toContain('data-fw-tz="America/New_York"');
    expect(withCustom.html).toContain('data-fw-date="2026-11-23"');
    expect(withCustom.html).toContain('<script>(function(){');

    // Empty footer hides footer element; autoAdvanceToday: false emits zero <script> tags
    const staticNoFooter = generatePublicAvailability({
      items: [eggsItem],
      days,
      channels: [],
      today: '2026-11-23',
      weeks: 2,
      timezone: 'America/New_York',
      now: new Date('2026-11-23T15:00:00Z'),
      footerText: '',
      autoAdvanceToday: false,
    });

    expect(staticNoFooter.html).not.toContain('<p class="fw-cal-foot">');
    expect(staticNoFooter.html).not.toContain('<script');
  });

  it('supports end-of-day physical count adjustments (actualEndOfDay), pre-startDate EOD carry-over, and Undo persistence', async () => {
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

    // 1. Pre-startDate EOD count on Sunday (2026-11-22) sets Monday morning starting stock to 22
    // 2. Monday (2026-11-23): Morning expected 22, slotted 4 -> remaining 18 + harvest 10 = expected EOD 28,
    //    overridden by actualEndOfDay = 24 -> Tuesday morning starts at 24!
    // 3. Tuesday (2026-11-24): Morning expected 24, slotted 22 -> ending 2 (buffer 4 -> rawSellableOpen -2).
    //    Because Monday has actualEndOfDay = 24, Tuesday's tight supply does NOT constrain Monday's daytime ATP!
    const projected = projectDailySupply({
      items: [eggsItem],
      entries: [
        {
          id: 1,
          trackedItemId: 1,
          date: '2026-11-22',
          actualOnHand: null,
          estProduced: null,
          actualEndOfDay: 22,
          isCascadeAnchor: false,
          bufferOverride: null,
          extraBuffer: 0,
          notes: null,
        },
        {
          id: 2,
          trackedItemId: 1,
          date: '2026-11-23',
          actualOnHand: null,
          estProduced: null,
          actualEndOfDay: 24,
          isCascadeAnchor: false,
          bufferOverride: null,
          extraBuffer: 0,
          notes: null,
        },
      ],
      orders: [
        {
          id: 101,
          source: 'manual',
          status: 'slotted',
          timingType: 'specific_date',
          requestedDate: '2026-11-23',
          slottedDate: '2026-11-23',
          isLocked: false,
          customerName: 'Mon Buyer',
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
          items: [{ trackedItemId: 1, quantity: 4 }],
          chatter: [],
          createdAt: '',
          updatedAt: '',
        },
        {
          id: 102,
          source: 'manual',
          status: 'slotted',
          timingType: 'specific_date',
          requestedDate: '2026-11-24',
          slottedDate: '2026-11-24',
          isLocked: false,
          customerName: 'Tue Buyer',
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
          items: [{ trackedItemId: 1, quantity: 22 }],
          chatter: [],
          createdAt: '',
          updatedAt: '',
        },
      ],
      startDate: '2026-11-23',
      endDate: '2026-11-25',
      today: '2026-11-23',
    });

    const mon = projected[0].byItem[1];
    const tue = projected[1].byItem[1];
    const wed = projected[2].byItem[1];

    expect(mon.expectedStartingBalance).toBe(22);
    expect(mon.startingBalance).toBe(22);
    expect(mon.endingBalance).toBe(18);
    expect(mon.expectedProduced).toBe(10);
    expect(mon.expectedNextDayStarting).toBe(28);
    expect(mon.actualEndOfDay).toBe(24);
    expect(mon.nextDayStarting).toBe(24);
    // Monday ATP is unconstrained by Tuesday because Monday's EOD is physically pinned at 24
    expect(mon.sellableOpen).toBe(14);
    expect(mon.reservedForFuture).toBe(0);

    expect(tue.expectedStartingBalance).toBe(24);
    expect(tue.startingBalance).toBe(24);
    expect(tue.endingBalance).toBe(2);
    expect(tue.expectedNextDayStarting).toBe(12);
    expect(tue.nextDayStarting).toBe(12);
    expect(tue.sellableOpen).toBe(-2);

    expect(wed.expectedStartingBalance).toBe(12);
    expect(wed.startingBalance).toBe(12);

    // Verify SQLite persistence + checkpoint Undo restores actual_end_of_day cleanly
    const { dbPath, backupDir } = createTempPaths();
    const mgr = new DatabaseManager(dbPath, backupDir);
    await mgr.init('America/New_York');
    const now = new Date().toISOString();
    const itemId = Number(
      mgr.db
        .prepare(
          `INSERT INTO tracked_items (name, unit_label, is_active, supply_mode, default_daily_production, global_safety_buffer, include_in_public_snippet, keyword_rules_json, sort_order, created_at, updated_at)
           VALUES ('Standard Eggs', 'dozens', 1, 'continuous', 10, 4, 1, '[]', 0, ?, ?)`
        )
        .run(now, now).lastInsertRowid
    );

    mgr.db
      .prepare(
        `INSERT INTO daily_supply_entries (tracked_item_id, date, actual_on_hand, est_produced, actual_end_of_day, is_cascade_anchor, buffer_override, extra_buffer, notes)
         VALUES (?, '2026-11-23', 20, 11, 27, 0, NULL, 0, 'Evening recount')`
      )
      .run(itemId);

    captureCheckpoint(mgr.db, 'Before changing EOD');
    mgr.db
      .prepare(
        `UPDATE daily_supply_entries SET actual_end_of_day = 19 WHERE tracked_item_id = ? AND date = '2026-11-23'`
      )
      .run(itemId);
    expect(listDailySupplyEntries(mgr.db)[0].actualEndOfDay).toBe(19);

    undoLastCheckpoint(mgr.db);
    expect(listDailySupplyEntries(mgr.db)[0].actualEndOfDay).toBe(27);
    mgr.close();
  });

  it('sorts waitlist orders by earliest arrival date by default and persists custom waitlist_sort_order priority', async () => {
    const { compareWaitlistOrders, getOrderArrivalInfo } = await import('../../src/shared/timezone');
    const { createExpressApp } = await import('../../src/server/app');

    const { dbPath, backupDir } = createTempPaths();
    const mgr = new DatabaseManager(dbPath, backupDir);
    await mgr.init('America/New_York');

    const now = new Date().toISOString();
    const itemId = Number(
      mgr.db
        .prepare(
          `INSERT INTO tracked_items (name, unit_label, is_active, supply_mode, default_daily_production, global_safety_buffer, include_in_public_snippet, keyword_rules_json, sort_order, created_at, updated_at)
           VALUES ('Standard Eggs', 'dozens', 1, 'continuous', 10, 0, 1, '[]', 0, ?, ?)`
        )
        .run(now, now).lastInsertRowid
    );

    const insertOrder = (name: string, odooLocal: string | null, createdAt: string) => {
      const id = Number(
        mgr.db
          .prepare(
            `INSERT INTO orders (source, status, timing_type, customer_name, odoo_created_at_local, created_at, updated_at)
             VALUES (?, 'waitlist', 'asap', ?, ?, ?, ?)`
          )
          .run(odooLocal ? 'odoo' : 'manual', name, odooLocal, createdAt, createdAt).lastInsertRowid
      );
      mgr.db
        .prepare(`INSERT INTO order_items (order_id, tracked_item_id, quantity) VALUES (?, ?, 5)`)
        .run(id, itemId);
      return id;
    };

    const idNov22 = insertOrder('Newest Buyer', '2026-11-22 14:00:00', '2026-11-22T19:00:00Z');
    const idNov18 = insertOrder('Oldest Buyer', '2026-11-18 09:30:00', '2026-11-18T14:30:00Z');
    const idNov20 = insertOrder('Middle Manual', null, '2026-11-20T16:00:00Z');

    const initial = listAllOrders(mgr.db).sort((a, b) =>
      compareWaitlistOrders(a, b, 'America/New_York')
    );
    expect(initial.map((o) => o.id)).toEqual([idNov18, idNov20, idNov22]);
    expect(getOrderArrivalInfo(initial[0], 'America/New_York', '2026-11-24').shortLabel).toBe('Nov 18');
    expect(getOrderArrivalInfo(initial[0], 'America/New_York', '2026-11-24').ageLabel).toBe('6d ago');

    // Reorder via PUT /api/orders/waitlist-order
    const app = createExpressApp({
      dbManager: mgr,
      config: {
        port: 0,
        dbPath,
        backupDir,
        haOptionsPath: '',
        timezone: 'America/New_York',
        odoo: { url: '', db: '', apiKey: '', source: 'none' },
      },
    });

    const server = app.listen(0);
    const addr = server.address();
    const port = typeof addr === 'object' && addr ? addr.port : 0;
    try {
      const reorderRes = await fetch(`http://127.0.0.1:${port}/api/orders/waitlist-order`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ orderIds: [idNov22, idNov18, idNov20] }),
      });
      expect(reorderRes.status).toBe(200);

      const reordered = listAllOrders(mgr.db).sort((a, b) =>
        compareWaitlistOrders(a, b, 'America/New_York')
      );
      expect(reordered.map((o) => o.id)).toEqual([idNov22, idNov18, idNov20]);
      expect(reordered.map((o) => o.waitlistSortOrder)).toEqual([0, 1, 2]);

      const resetRes = await fetch(`http://127.0.0.1:${port}/api/orders/waitlist-order`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ reset: true }),
      });
      expect(resetRes.status).toBe(200);

      const resetList = listAllOrders(mgr.db).sort((a, b) =>
        compareWaitlistOrders(a, b, 'America/New_York')
      );
      expect(resetList.map((o) => o.id)).toEqual([idNov18, idNov20, idNov22]);
      expect(resetList.every((o) => o.waitlistSortOrder === null)).toBe(true);
    } finally {
      server.close();
      mgr.close();
    }
  });

  it('persists dismissed duplicate pairs symmetrically via POST /api/orders/:id/dismiss-duplicate and cleans up on order deletion', async () => {
    const { createExpressApp } = await import('../../src/server/app');
    const { dbPath, backupDir } = createTempPaths();
    const mgr = new DatabaseManager(dbPath, backupDir);
    await mgr.init('America/New_York');

    const now = new Date().toISOString();
    const idA = Number(
      mgr.db
        .prepare(
          `INSERT INTO orders (source, status, timing_type, customer_name, customer_email, created_at, updated_at)
           VALUES ('manual', 'slotted', 'asap', 'Sam Buyer', 'sam@example.com', ?, ?)`
        )
        .run(now, now).lastInsertRowid
    );
    const idB = Number(
      mgr.db
        .prepare(
          `INSERT INTO orders (source, status, timing_type, customer_name, customer_email, created_at, updated_at)
           VALUES ('manual', 'waitlist', 'asap', 'Sam Buyer', 'sam@example.com', ?, ?)`
        )
        .run(now, now).lastInsertRowid
    );

    const app = createExpressApp({
      dbManager: mgr,
      config: {
        port: 0,
        dbPath,
        backupDir,
        haOptionsPath: '',
        timezone: 'America/New_York',
        odoo: { url: '', db: '', apiKey: '', source: 'none' },
      },
    });
    const server = app.listen(0);
    const addr = server.address();
    const port = typeof addr === 'object' && addr ? addr.port : 0;

    try {
      const res = await fetch(`http://127.0.0.1:${port}/api/orders/${idB}/dismiss-duplicate`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ otherOrderId: idA }),
      });
      expect(res.status).toBe(200);
      const body = (await res.json()) as { ok: boolean; orderIdA: number; orderIdB: number };
      expect(body).toEqual({ ok: true, orderIdA: Math.min(idA, idB), orderIdB: Math.max(idA, idB) });

      // Both orders symmetrically list each other in dismissedDuplicateOrderIds
      const orders = listAllOrders(mgr.db);
      expect(orders.find((o) => o.id === idA)?.dismissedDuplicateOrderIds).toEqual([idB]);
      expect(orders.find((o) => o.id === idB)?.dismissedDuplicateOrderIds).toEqual([idA]);

      // Deleting one order cascades the dismissal row cleanly
      mgr.db.prepare('DELETE FROM orders WHERE id = ?').run(idB);
      const afterDelete = listAllOrders(mgr.db);
      expect(afterDelete.find((o) => o.id === idA)?.dismissedDuplicateOrderIds).toEqual([]);
    } finally {
      server.close();
      mgr.close();
    }
  });

  it('supports Sandbox Mode: creates pre-sandbox snapshot, isolates changes in a duplicate DB, blocks live publish/backups, and restores live DB on exit or restart', async () => {
    const { createExpressApp } = await import('../../src/server/app');
    const { dbPath, backupDir } = createTempPaths();
    const mgr = new DatabaseManager(dbPath, backupDir);
    await mgr.init('America/New_York');

    const now = new Date().toISOString();
    const liveItemId = Number(
      mgr.db
        .prepare(
          `INSERT INTO tracked_items (name, unit_label, is_active, supply_mode, default_daily_production, global_safety_buffer, include_in_public_snippet, sort_order, created_at, updated_at)
           VALUES ('Standard Eggs', 'dozens', 1, 'continuous', 12, 2, 1, 0, ?, ?)`
        )
        .run(now, now).lastInsertRowid
    );
    const liveOrderId = Number(
      mgr.db
        .prepare(
          `INSERT INTO orders (source, status, timing_type, customer_name, created_at, updated_at)
           VALUES ('manual', 'waitlist', 'asap', 'Live Customer', ?, ?)`
        )
        .run(now, now).lastInsertRowid
    );
    mgr.db
      .prepare('INSERT INTO order_items (order_id, tracked_item_id, quantity) VALUES (?, ?, ?)')
      .run(liveOrderId, liveItemId, 3);

    let settingsCallbackCount = 0;
    const app = createExpressApp({
      dbManager: mgr,
      config: {
        port: 0,
        dbPath,
        backupDir,
        haOptionsPath: '',
        timezone: 'America/New_York',
        odoo: { url: '', db: '', apiKey: '', source: 'none' },
        githubPublish: { token: 'ghp_test', defaultRepo: 'farm/avail', source: 'env' },
      },
      onSettingsUpdated: () => {
        settingsCallbackCount += 1;
      },
    });
    const server = app.listen(0);
    const addr = server.address();
    const port = typeof addr === 'object' && addr ? addr.port : 0;

    try {
      // 1. Enter Sandbox Mode
      const enterRes = await fetch(`http://127.0.0.1:${port}/api/sandbox/enter`, { method: 'POST' });
      expect(enterRes.status).toBe(201);
      const enterBody = (await enterRes.json()) as {
        sandboxStatus: { active: boolean; startedAt: string | null; snapshotFilename: string | null };
        backup: { filename: string; trigger: string };
      };
      expect(enterBody.sandboxStatus.active).toBe(true);
      expect(enterBody.backup.trigger).toBe('pre-sandbox');
      expect(enterBody.backup.filename).toMatch(/^pre-sandbox-.*\.db$/);
      expect(enterBody.sandboxStatus.snapshotFilename).toBe(enterBody.backup.filename);
      expect(fs.existsSync(mgr.sandboxDbPath)).toBe(true);
      expect(settingsCallbackCount).toBe(1);

      // Workspace reflects active sandbox status & copied live order
      const wsSandboxRes = await fetch(`http://127.0.0.1:${port}/api/workspace`);
      const wsSandbox = (await wsSandboxRes.json()) as {
        sandboxStatus: { active: boolean; snapshotFilename: string | null };
        orders: Array<{ id: number; customerName: string }>;
      };
      expect(wsSandbox.sandboxStatus.active).toBe(true);
      expect(wsSandbox.orders.map((o) => o.customerName)).toEqual(['Live Customer']);

      // 2. Make destructive changes inside Sandbox (delete live copy & add sandbox-only order)
      const delRes = await fetch(`http://127.0.0.1:${port}/api/orders/${liveOrderId}`, {
        method: 'DELETE',
      });
      expect(delRes.status).toBe(200);

      const addSandboxRes = await fetch(`http://127.0.0.1:${port}/api/orders`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          customerName: 'Sandbox Experiment',
          timingType: 'asap',
          items: [{ trackedItemId: liveItemId, quantity: 9 }],
        }),
      });
      expect(addSandboxRes.status).toBe(201);
      expect(listAllOrders(mgr.db).map((o) => o.customerName)).toEqual(['Sandbox Experiment']);

      // 3. Live GitHub publish & live backup mutations are blocked with 409 while in Sandbox Mode
      const publishBlocked = await fetch(`http://127.0.0.1:${port}/api/snippet/github/publish`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ force: true }),
      });
      expect(publishBlocked.status).toBe(409);

      const backupBlocked = await fetch(`http://127.0.0.1:${port}/api/backups`, {
        method: 'POST',
      });
      expect(backupBlocked.status).toBe(409);

      // 4. Exit Sandbox Mode -> temporary sandbox file deleted, live DB untouched!
      const exitRes = await fetch(`http://127.0.0.1:${port}/api/sandbox/exit`, { method: 'POST' });
      expect(exitRes.status).toBe(200);
      const exitBody = (await exitRes.json()) as {
        sandboxStatus: { active: boolean; startedAt: string | null; snapshotFilename: string | null };
      };
      expect(exitBody.sandboxStatus).toEqual({
        active: false,
        startedAt: null,
        snapshotFilename: null,
      });
      expect(fs.existsSync(mgr.sandboxDbPath)).toBe(false);
      expect(settingsCallbackCount).toBe(2);

      // Live database still has exact original order and none of the sandbox mutations
      expect(listAllOrders(mgr.db).map((o) => o.customerName)).toEqual(['Live Customer']);

      // Pre-sandbox backup snapshot remains preserved in backup history
      const backups = mgr.listBackups();
      expect(backups.some((b) => b.filename === enterBody.backup.filename && b.trigger === 'pre-sandbox')).toBe(true);
    } finally {
      server.close();
      mgr.close();
    }

    // 5. Simulated crash recovery: leftover sandbox file is cleaned up on startup & live DB opens cleanly
    fs.writeFileSync(mgr.sandboxDbPath, 'stale-sandbox-data');
    const restarted = new DatabaseManager(dbPath, backupDir);
    try {
      expect(restarted.isSandboxActive()).toBe(false);
      expect(fs.existsSync(restarted.sandboxDbPath)).toBe(false);
      expect(listAllOrders(restarted.db).map((o) => o.customerName)).toEqual(['Live Customer']);
    } finally {
      restarted.close();
    }
  });

  it('deducts daily selfConsumption and walkUpConsumption like fixed same-day orders across carry-over, ATP reservations, PUT /api/supply, and Undo', async () => {
    const { createExpressApp } = await import('../../src/server/app');
    const farmEggs: TrackedItem = {
      id: 1,
      name: 'Standard Eggs',
      unitLabel: 'dozens',
      isActive: true,
      supplyMode: 'continuous',
      defaultDailyProduction: 4,
      globalSafetyBuffer: 2,
      includeInPublicSnippet: true,
      keywordRules: ['standard'],
      sortOrder: 0,
      createdAt: '2026-11-01T00:00:00Z',
      updatedAt: '2026-11-01T00:00:00Z',
    };

    // Unit math:
    // Nov 22 (before startDate): anchor 12 on hand, selfConsumption 2, walkUpConsumption 2, harvest +4 -> Nov 23 starts with 12
    // Nov 23: starts 12, selfConsumption 0, walkUpConsumption 0, buffer 2 -> raw open 10, harvest +4 -> Nov 24 starts with 16
    // Nov 24: starts 16, selfConsumption 5, walkUpConsumption 6 (11 total), buffer 2 -> endingBalance 5, raw open 3 -> ATP pulls Nov 23 open from 10 down to 3 (Holding 7)!
    // Nov 25: starts 5 + 4 = 9, buffer 2 -> open 7
    const days = projectDailySupply({
      items: [farmEggs],
      entries: [
        {
          id: 1,
          trackedItemId: 1,
          date: '2026-11-22',
          actualOnHand: 12,
          estProduced: null,
          isCascadeAnchor: false,
          bufferOverride: null,
          selfConsumption: 2,
          walkUpConsumption: 2,
          notes: null,
        },
        {
          id: 2,
          trackedItemId: 1,
          date: '2026-11-24',
          actualOnHand: null,
          estProduced: null,
          isCascadeAnchor: false,
          bufferOverride: null,
          selfConsumption: 5,
          walkUpConsumption: 6,
          notes: 'Family baking + farmstand walk-ups',
        },
      ],
      orders: [],
      startDate: '2026-11-23',
      endDate: '2026-11-25',
      today: '2026-11-23',
    });

    expect(days[0].byItem[1].startingBalance).toBe(12);
    expect(days[0].byItem[1].selfConsumption).toBe(0);
    expect(days[0].byItem[1].walkUpConsumption).toBe(0);
    expect(days[0].byItem[1].rawSellableOpen).toBe(10);
    expect(days[0].byItem[1].sellableOpen).toBe(3);
    expect(days[0].byItem[1].reservedForFuture).toBe(7);
    expect(days[0].byItem[1].constrainedByDate).toBe('2026-11-24');

    expect(days[1].byItem[1].startingBalance).toBe(16);
    expect(days[1].byItem[1].selfConsumption).toBe(5);
    expect(days[1].byItem[1].walkUpConsumption).toBe(6);
    expect(days[1].byItem[1].endingBalance).toBe(5);
    expect(days[1].byItem[1].sellableOpen).toBe(3);

    expect(days[2].byItem[1].startingBalance).toBe(9);
    expect(days[2].byItem[1].sellableOpen).toBe(7);

    // End-to-end persistence via PUT /api/supply/:itemId/:date + Undo checkpoint
    const { dbPath, backupDir } = createTempPaths();
    const mgr = new DatabaseManager(dbPath, backupDir);
    await mgr.init('America/New_York');
    const now = new Date().toISOString();
    const itemId = Number(
      mgr.db
        .prepare(
          `INSERT INTO tracked_items (name, unit_label, is_active, supply_mode, default_daily_production, global_safety_buffer, include_in_public_snippet, sort_order, created_at, updated_at)
           VALUES ('Standard Eggs', 'dozens', 1, 'continuous', 10, 2, 1, 0, ?, ?)`
        )
        .run(now, now).lastInsertRowid
    );

    const app = createExpressApp({
      dbManager: mgr,
      config: {
        port: 0,
        dbPath,
        backupDir,
        haOptionsPath: '',
        timezone: 'America/New_York',
        odoo: { url: '', db: '', apiKey: '', source: 'none' },
      },
      getNow: () => new Date('2026-11-23T15:00:00Z'),
    });
    const server = app.listen(0);
    const addr = server.address();
    const port = typeof addr === 'object' && addr ? addr.port : 0;

    try {
      const putRes = await fetch(`http://127.0.0.1:${port}/api/supply/${itemId}/2026-11-23`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          actualOnHand: 14,
          estProduced: null,
          actualEndOfDay: null,
          cascadeForward: false,
          bufferOverride: null,
          extraBuffer: 0,
          selfConsumption: 2.5,
          walkUpConsumption: 3.5,
          notes: 'Kitchen eggs + walk-up table',
        }),
      });
      expect(putRes.status).toBe(200);

      const wsRes = await fetch(`http://127.0.0.1:${port}/api/workspace`);
      const ws = (await wsRes.json()) as {
        days: Array<{
          date: string;
          byItem: Record<
            number,
            {
              startingBalance: number;
              selfConsumption: number;
              walkUpConsumption: number;
              endingBalance: number;
              sellableOpen: number;
            }
          >;
        }>;
      };
      const mon = ws.days.find((d) => d.date === '2026-11-23')!.byItem[itemId];
      expect(mon.startingBalance).toBe(14);
      expect(mon.selfConsumption).toBe(2.5);
      expect(mon.walkUpConsumption).toBe(3.5);
      expect(mon.endingBalance).toBe(8);
      expect(mon.sellableOpen).toBe(6);

      // Undo reverts both self-consumption and walk-up consumption cleanly
      const undoRes = await fetch(`http://127.0.0.1:${port}/api/checkpoints/undo`, { method: 'POST' });
      expect(undoRes.status).toBe(200);

      const wsAfterUndoRes = await fetch(`http://127.0.0.1:${port}/api/workspace`);
      const wsAfterUndo = (await wsAfterUndoRes.json()) as {
        days: Array<{
          date: string;
          byItem: Record<number, { selfConsumption: number; walkUpConsumption: number }>;
        }>;
      };
      expect(wsAfterUndo.days.find((d) => d.date === '2026-11-23')!.byItem[itemId].selfConsumption).toBe(0);
      expect(wsAfterUndo.days.find((d) => d.date === '2026-11-23')!.byItem[itemId].walkUpConsumption).toBe(0);
    } finally {
      server.close();
      mgr.close();
    }
  });

  it('renders expanded template variables (first/last name split, date formats without year, order_ref) and builds safe mailto links', () => {
    expect(splitCustomerName('Alex Rivera')).toEqual({
      fullName: 'Alex Rivera',
      firstName: 'Alex',
      lastName: 'Rivera',
    });
    expect(splitCustomerName('  Mary   Jane Smith ')).toEqual({
      fullName: 'Mary   Jane Smith',
      firstName: 'Mary',
      lastName: 'Jane Smith',
    });
    expect(splitCustomerName('Madonna')).toEqual({
      fullName: 'Madonna',
      firstName: 'Madonna',
      lastName: '',
    });
    expect(splitCustomerName('   ')).toEqual({
      fullName: 'there',
      firstName: 'there',
      lastName: '',
    });

    const items: TrackedItem[] = [
      {
        id: 5,
        name: 'Standard Eggs',
        unitLabel: 'dozens',
        isActive: true,
        supplyMode: 'continuous',
        defaultDailyProduction: 10,
        globalSafetyBuffer: 2,
        includeInPublicSnippet: true,
        keywordRules: ['standard'],
        sortOrder: 0,
        createdAt: '',
        updatedAt: '',
      },
    ];
    const channels: PickupChannel[] = [
      {
        id: 2,
        name: 'Saturday Market',
        allowedWeekdays: [6],
        colorToken: 'sky',
        isActive: true,
        sortOrder: 0,
      },
    ];

    const multiWordOrder: OrderRecord = {
      ...baseOrder,
      customerName: 'Clara Oswald',
      slottedDate: '2026-11-28',
      odooQuotationName: 'S00412',
    };

    const rendered = renderPreApprovalMessage({
      template:
        'Hi {{first_name}} ({{last_name}} / {{name}})! Ref {{order_ref}}: {{items_summary}} on {{date_short}} | {{date_long}} | {{date_md}} | {{date_numeric}} | {{weekday}} | {{date}} via {{channel}}.',
      order: multiWordOrder,
      items,
      channels,
    });

    expect(rendered).toBe(
      'Hi Clara (Oswald / Clara Oswald)! Ref S00412: 3 dozens Standard Eggs on Sat, Nov 28 | Saturday, November 28 | Nov 28 | 11/28 | Saturday | Sat, Nov 28, 2026 via Saturday Market.'
    );

    // Single-word name cleanly leaves {{last_name}} empty
    const singleWordRendered = renderPreApprovalMessage({
      template: 'Hi {{first_name}}{{last_name}} for {{date_short}}',
      order: { ...baseOrder, customerName: 'Clara', slottedDate: '2026-11-28' },
      items,
      channels,
    });
    expect(singleWordRendered).toBe('Hi Clara for Sat, Nov 28');

    // Sample preview helper renders all new variables
    const preview = renderPreApprovalSamplePreview(
      'Hi {{first_name}} {{last_name}}, pickup {{date_short}} ({{weekday}}) ref {{order_ref}}',
      'Farm Store'
    );
    expect(preview).toBe('Hi Alex Rivera, pickup Sat, Nov 28 (Saturday) ref S00105');

    // Mailto builder includes recipient, formatted subject without year, and plain-text body
    const href = buildPreApprovalMailtoHref({
      email: 'clara@example.com',
      order: multiWordOrder,
      message: 'Hi Clara, order at <a href="https://farm.example.com/shop">Farm Store</a>!',
    });
    expect(href).toBeTruthy();
    expect(href!.startsWith('mailto:clara@example.com?subject=')).toBe(true);
    const decoded = decodeURIComponent(href!);
    expect(decoded).toContain('Order Pre-Approved — Sat, Nov 28 (S00412)');
    expect(decoded).toContain('Farm Store (https://farm.example.com/shop)');
  });

  it('supports Read-Only Backup Preview Mode: opens snapshot read-only, rejects all writes with 409, restores live DB on exit, supports restoring previewed backup, and cleans up on restart', async () => {
    const { createExpressApp } = await import('../../src/server/app');
    const { dbPath, backupDir } = createTempPaths();
    const mgr = new DatabaseManager(dbPath, backupDir);
    await mgr.init('America/New_York');

    const now = new Date().toISOString();
    const itemId = Number(
      mgr.db
        .prepare(
          `INSERT INTO tracked_items (name, unit_label, is_active, supply_mode, default_daily_production, global_safety_buffer, include_in_public_snippet, sort_order, created_at, updated_at)
           VALUES ('Standard Eggs', 'dozens', 1, 'continuous', 12, 2, 1, 0, ?, ?)`
        )
        .run(now, now).lastInsertRowid
    );
    const snapshotOrderId = Number(
      mgr.db
        .prepare(
          `INSERT INTO orders (source, status, timing_type, customer_name, created_at, updated_at)
           VALUES ('manual', 'waitlist', 'asap', 'Snapshot Alice', ?, ?)`
        )
        .run(now, now).lastInsertRowid
    );
    mgr.db
      .prepare('INSERT INTO order_items (order_id, tracked_item_id, quantity) VALUES (?, ?, ?)')
      .run(snapshotOrderId, itemId, 2);

    // Take backup snapshot containing ONLY Snapshot Alice
    const snapshot = await mgr.createBackup('manual');

    // Add a later live-only order after the backup was taken
    const liveOnlyOrderId = Number(
      mgr.db
        .prepare(
          `INSERT INTO orders (source, status, timing_type, customer_name, created_at, updated_at)
           VALUES ('manual', 'waitlist', 'asap', 'Live-Only Bob', ?, ?)`
        )
        .run(now, now).lastInsertRowid
    );
    mgr.db
      .prepare('INSERT INTO order_items (order_id, tracked_item_id, quantity) VALUES (?, ?, ?)')
      .run(liveOnlyOrderId, itemId, 4);

    let settingsCallbackCount = 0;
    const app = createExpressApp({
      dbManager: mgr,
      config: {
        port: 0,
        dbPath,
        backupDir,
        haOptionsPath: '',
        timezone: 'America/New_York',
        odoo: { url: '', db: '', apiKey: '', source: 'none' },
        githubPublish: { token: 'ghp_test', defaultRepo: 'farm/avail', source: 'env' },
      },
      onSettingsUpdated: () => {
        settingsCallbackCount += 1;
      },
    });
    const server = app.listen(0);
    const addr = server.address();
    const port = typeof addr === 'object' && addr ? addr.port : 0;

    try {
      // 1. Enter Read-Only Backup Preview for the earlier snapshot
      const enterRes = await fetch(`http://127.0.0.1:${port}/api/backups/preview/enter`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ filename: snapshot.filename }),
      });
      expect(enterRes.status).toBe(200);
      const enterBody = (await enterRes.json()) as {
        backupPreviewStatus: {
          active: boolean;
          filename: string | null;
          startedAt: string | null;
          backupCreatedAt: string | null;
        };
      };
      expect(enterBody.backupPreviewStatus.active).toBe(true);
      expect(enterBody.backupPreviewStatus.filename).toBe(snapshot.filename);
      expect(fs.existsSync(mgr.previewDbPath)).toBe(true);
      expect(settingsCallbackCount).toBe(1);

      // 2. GET /api/workspace shows ONLY Snapshot Alice & active backupPreviewStatus
      const wsPreviewRes = await fetch(`http://127.0.0.1:${port}/api/workspace`);
      expect(wsPreviewRes.status).toBe(200);
      const wsPreview = (await wsPreviewRes.json()) as {
        backupPreviewStatus: { active: boolean; filename: string | null };
        orders: Array<{ id: number; customerName: string }>;
      };
      expect(wsPreview.backupPreviewStatus.active).toBe(true);
      expect(wsPreview.backupPreviewStatus.filename).toBe(snapshot.filename);
      expect(wsPreview.orders.map((o) => o.customerName)).toEqual(['Snapshot Alice']);

      // 3. Every write endpoint is strictly rejected with 409 { readOnlyPreview: true }
      const writeChecks = [
        fetch(`http://127.0.0.1:${port}/api/orders`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            customerName: 'Blocked Order',
            timingType: 'asap',
            items: [{ trackedItemId: itemId, quantity: 1 }],
          }),
        }),
        fetch(`http://127.0.0.1:${port}/api/supply/${itemId}/2026-11-23`, {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ actualOnHand: 20 }),
        }),
        fetch(`http://127.0.0.1:${port}/api/settings`, {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ holdThresholdHours: 72 }),
        }),
        fetch(`http://127.0.0.1:${port}/api/sandbox/enter`, { method: 'POST' }),
        fetch(`http://127.0.0.1:${port}/api/backups`, { method: 'POST' }),
        fetch(`http://127.0.0.1:${port}/api/snippet/github/publish`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ force: true }),
        }),
      ];
      for (const req of writeChecks) {
        const res = await req;
        expect(res.status).toBe(409);
        const body = (await res.json()) as { readOnlyPreview?: boolean };
        expect(body.readOnlyPreview).toBe(true);
      }

      // 4. Exit Backup Preview -> cleans up temp preview DB & returns to untouched live DB (both orders intact)
      const exitRes = await fetch(`http://127.0.0.1:${port}/api/backups/preview/exit`, {
        method: 'POST',
      });
      expect(exitRes.status).toBe(200);
      const exitBody = (await exitRes.json()) as {
        backupPreviewStatus: { active: boolean; filename: string | null };
      };
      expect(exitBody.backupPreviewStatus.active).toBe(false);
      expect(exitBody.backupPreviewStatus.filename).toBeNull();
      expect(fs.existsSync(mgr.previewDbPath)).toBe(false);
      expect(listAllOrders(mgr.db).map((o) => o.customerName)).toEqual([
        'Snapshot Alice',
        'Live-Only Bob',
      ]);

      // 5. Re-enter preview and restore directly via POST /api/backups/preview/restore
      const reEnterRes = await fetch(`http://127.0.0.1:${port}/api/backups/preview/enter`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ filename: snapshot.filename }),
      });
      expect(reEnterRes.status).toBe(200);

      const restoreRes = await fetch(`http://127.0.0.1:${port}/api/backups/preview/restore`, {
        method: 'POST',
      });
      expect(restoreRes.status).toBe(200);
      const restoreBody = (await restoreRes.json()) as {
        restoredFrom: string;
        safetySnapshot: { filename: string; trigger: string };
        backupPreviewStatus: { active: boolean };
      };
      expect(restoreBody.restoredFrom).toBe(snapshot.filename);
      expect(restoreBody.safetySnapshot.trigger).toBe('pre-restore');
      expect(restoreBody.backupPreviewStatus.active).toBe(false);
      expect(fs.existsSync(mgr.previewDbPath)).toBe(false);

      // Live DB is now restored to Snapshot Alice only
      expect(listAllOrders(mgr.db).map((o) => o.customerName)).toEqual(['Snapshot Alice']);

      // And the pre-restore safety snapshot captured Live-Only Bob before overwriting!
      const verifySafetyRes = await fetch(`http://127.0.0.1:${port}/api/backups/preview/enter`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ filename: restoreBody.safetySnapshot.filename }),
      });
      expect(verifySafetyRes.status).toBe(200);
      expect(listAllOrders(mgr.db).map((o) => o.customerName)).toEqual([
        'Snapshot Alice',
        'Live-Only Bob',
      ]);
      await fetch(`http://127.0.0.1:${port}/api/backups/preview/exit`, { method: 'POST' });
    } finally {
      server.close();
      mgr.close();
    }

    // 6. Startup crash recovery cleans up any orphaned .preview.db file and boots into live DB
    fs.writeFileSync(mgr.previewDbPath, 'stale-preview-data');
    const restarted = new DatabaseManager(dbPath, backupDir);
    try {
      expect(restarted.isBackupPreviewActive()).toBe(false);
      expect(fs.existsSync(restarted.previewDbPath)).toBe(false);
      expect(listAllOrders(restarted.db).map((o) => o.customerName)).toEqual(['Snapshot Alice']);
    } finally {
      restarted.close();
    }
  });

  it('surfaces expired hold cutoff orders alongside overdue orders, bumps forward with hold timer reset, and renders hold_cutoff template variables', async () => {
    const { createExpressApp } = await import('../../src/server/app');
    const { dbPath, backupDir } = createTempPaths();
    const mgr = new DatabaseManager(dbPath, backupDir);
    await mgr.init('America/New_York');

    const now = new Date('2026-11-25T19:00:00Z'); // Wed, Nov 25 at 2:00 PM EST
    const nowIso = now.toISOString();
    const itemId = Number(
      mgr.db
        .prepare(
          `INSERT INTO tracked_items (name, unit_label, is_active, supply_mode, default_daily_production, global_safety_buffer, include_in_public_snippet, sort_order, created_at, updated_at)
           VALUES ('Standard Eggs', 'dozens', 1, 'continuous', 10, 2, 1, 0, ?, ?)`
        )
        .run(nowIso, nowIso).lastInsertRowid
    );
    // Saturday-only channel to verify bump respects channel pickup days
    const satChannelId = Number(
      mgr.db
        .prepare(
          `INSERT INTO pickup_channels (name, allowed_weekdays_json, color_token, is_active, sort_order)
           VALUES ('Saturday Market', '[6]', 'amber', 1, 0)`
        )
        .run().lastInsertRowid
    );
    // Daily channel (Mon-Sun)
    const dailyChannelId = Number(
      mgr.db
        .prepare(
          `INSERT INTO pickup_channels (name, allowed_weekdays_json, color_token, is_active, sort_order)
           VALUES ('Farm Store', '[1,2,3,4,5,6,7]', 'sky', 1, 1)`
        )
        .run().lastInsertRowid
    );

    mgr.updateSettings({
      holdThresholdHours: 48,
      preApprovalTemplate:
        'Hi {{first_name}}, held for {{hold_cutoff}} — please order by {{hold_cutoff_by}} ({{hold_cutoff_date}}) for {{date_short}}.',
      preApprovalTemplates: [
        {
          id: 'default',
          name: 'Default',
          format: 'plain',
          body: 'Hi {{first_name}}, held for {{hold_cutoff}} — please order by {{hold_cutoff_by}} ({{hold_cutoff_date}}) for {{date_short}}.',
          channelIds: [],
          itemIds: [],
          isDefault: true,
        },
      ],
    });

    // Order 1: Past-date pre_approved on daily channel (Tue Nov 24, today is Wed Nov 25)
    const pastOrderId = Number(
      mgr.db
        .prepare(
          `INSERT INTO orders (source, status, timing_type, slotted_date, customer_name, pickup_channel_id, pre_approved_at, created_at, updated_at)
           VALUES ('manual', 'pre_approved', 'specific_date', '2026-11-24', 'Past Paula', ?, '2026-11-24T12:00:00Z', ?, ?)`
        )
        .run(dailyChannelId, nowIso, nowIso).lastInsertRowid
    );
    mgr.db
      .prepare('INSERT INTO order_items (order_id, tracked_item_id, quantity) VALUES (?, ?, 2)')
      .run(pastOrderId, itemId);

    // Order 2: Future pre_approved on Saturday Market (Sat Nov 28) whose hold expired (50h ago > 48h)
    const expiredHoldOrderId = Number(
      mgr.db
        .prepare(
          `INSERT INTO orders (source, status, timing_type, slotted_date, customer_name, pickup_channel_id, pre_approved_at, created_at, updated_at)
           VALUES ('manual', 'pre_approved', 'specific_date', '2026-11-28', 'Expired Eddie', ?, '2026-11-23T17:00:00Z', ?, ?)`
        )
        .run(satChannelId, nowIso, nowIso).lastInsertRowid
    );
    mgr.db
      .prepare('INSERT INTO order_items (order_id, tracked_item_id, quantity) VALUES (?, ?, 3)')
      .run(expiredHoldOrderId, itemId);

    // Order 3: Fresh slotted order to test pre-approve template rendering with hold cutoff variables
    const freshOrderId = Number(
      mgr.db
        .prepare(
          `INSERT INTO orders (source, status, timing_type, slotted_date, customer_name, pickup_channel_id, created_at, updated_at)
           VALUES ('manual', 'slotted', 'specific_date', '2026-11-28', 'Fresh Fiona', ?, ?, ?)`
        )
        .run(dailyChannelId, nowIso, nowIso).lastInsertRowid
    );
    mgr.db
      .prepare('INSERT INTO order_items (order_id, tracked_item_id, quantity) VALUES (?, ?, 1)')
      .run(freshOrderId, itemId);

    const app = createExpressApp({
      dbManager: mgr,
      config: {
        port: 0,
        dbPath,
        backupDir,
        haOptionsPath: '',
        timezone: 'America/New_York',
        odoo: { url: '', db: '', apiKey: '', source: 'none' },
      },
      getNow: () => now,
    });
    const server = app.listen(0);
    const addr = server.address();
    const port = typeof addr === 'object' && addr ? addr.port : 0;

    try {
      // 1. Workspace exposes both overdueOrders and expiredHoldOrders
      const wsRes = await fetch(`http://127.0.0.1:${port}/api/workspace`);
      const ws = (await wsRes.json()) as {
        overdueOrders: Array<{ id: number }>;
        expiredHoldOrders: Array<{ id: number }>;
      };
      expect(ws.overdueOrders.map((o) => o.id)).toEqual([pastOrderId]);
      expect(ws.expiredHoldOrders.map((o) => o.id)).toEqual([expiredHoldOrderId]);

      // 2. Pre-approving Fresh Fiona renders {{hold_cutoff}}, {{hold_cutoff_by}}, and {{hold_cutoff_date}}
      const preRes = await fetch(`http://127.0.0.1:${port}/api/orders/${freshOrderId}/pre-approve`, {
        method: 'POST',
      });
      expect(preRes.status).toBe(200);
      const preBody = (await preRes.json()) as { message: string };
      expect(preBody.message).toBe(
        'Hi Fresh, held for 48 hours — please order by Fri, Nov 27 at 2:00 PM (Fri, Nov 27) for Sat, Nov 28.'
      );

      // 3. Bumping Past Paula moves her from past Tue Nov 24 -> today Wed Nov 25 and resets hold timer
      const bumpPastRes = await fetch(`http://127.0.0.1:${port}/api/orders/${pastOrderId}/bump`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({}),
      });
      expect(bumpPastRes.status).toBe(200);
      const bumpPastBody = (await bumpPastRes.json()) as {
        previousDate: string;
        bumpedToDate: string;
        order: { slottedDate: string; preApprovedAt: string; status: string };
      };
      expect(bumpPastBody.previousDate).toBe('2026-11-24');
      expect(bumpPastBody.bumpedToDate).toBe('2026-11-25');
      expect(bumpPastBody.order.preApprovedAt).toBe(nowIso);
      expect(bumpPastBody.order.status).toBe('pre_approved');

      // 4. Bumping Expired Eddie (Saturday Market, Sat Nov 28) advances to next Saturday Dec 5 & resets hold timer
      const bumpExpiredRes = await fetch(
        `http://127.0.0.1:${port}/api/orders/${expiredHoldOrderId}/bump`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({}),
        }
      );
      expect(bumpExpiredRes.status).toBe(200);
      const bumpExpiredBody = (await bumpExpiredRes.json()) as {
        bumpedToDate: string;
        order: { slottedDate: string; preApprovedAt: string };
      };
      expect(bumpExpiredBody.bumpedToDate).toBe('2026-12-05');
      expect(bumpExpiredBody.order.preApprovedAt).toBe(nowIso);

      // 5. After bumping both, both overdueOrders and expiredHoldOrders are now empty!
      const wsAfterRes = await fetch(`http://127.0.0.1:${port}/api/workspace`);
      const wsAfter = (await wsAfterRes.json()) as {
        overdueOrders: Array<{ id: number }>;
        expiredHoldOrders: Array<{ id: number }>;
      };
      expect(wsAfter.overdueOrders).toHaveLength(0);
      expect(wsAfter.expiredHoldOrders).toHaveLength(0);

      // 6. Undo cleanly restores Expired Eddie back to Sat Nov 28
      const undoRes = await fetch(`http://127.0.0.1:${port}/api/checkpoints/undo`, {
        method: 'POST',
      });
      expect(undoRes.status).toBe(200);
      const wsUndoRes = await fetch(`http://127.0.0.1:${port}/api/workspace`);
      const wsUndo = (await wsUndoRes.json()) as {
        expiredHoldOrders: Array<{ id: number; slottedDate: string }>;
      };
      expect(wsUndo.expiredHoldOrders.map((o) => o.id)).toEqual([expiredHoldOrderId]);
      expect(wsUndo.expiredHoldOrders[0].slottedDate).toBe('2026-11-28');
    } finally {
      server.close();
      mgr.close();
    }
  });

  it('resolves {{order_cutoff}}, {{order_cutoff_date}}, and {{order_cutoff_time}} from Public Order Cutoff Rules on pre-approval', async () => {
    const { createExpressApp } = await import('../../src/server/app');
    const { dbPath, backupDir } = createTempPaths();
    const mgr = new DatabaseManager(dbPath, backupDir);
    await mgr.init('America/New_York');

    const fixedNow = new Date('2026-11-25T19:00:00Z'); // Wed, Nov 25, 2026 2:00 PM EST
    const nowIso = fixedNow.toISOString();

    const itemId = Number(
      mgr.db
        .prepare(
          `INSERT INTO tracked_items (name, unit_label, is_active, supply_mode, default_daily_production, global_safety_buffer, include_in_public_snippet, sort_order, created_at, updated_at)
           VALUES ('Standard Eggs', 'dozens', 1, 'continuous', 12, 0, 1, 1, ?, ?)`
        )
        .run(nowIso, nowIso).lastInsertRowid
    );
    const channelId = Number(
      mgr.db
        .prepare(
          `INSERT INTO pickup_channels (name, allowed_weekdays_json, color_token, is_active, sort_order)
           VALUES ('Farm Store', '[1,2,3,4,5,6,7]', 'sky', 1, 1)`
        )
        .run().lastInsertRowid
    );

    const templateBody =
      'Hi {{first_name}}, please order by {{order_cutoff}} ({{order_cutoff_date}} at {{order_cutoff_time}}) for {{date_short}}.';
    mgr.updateSettings({
      preApprovalTemplate: templateBody,
      preApprovalTemplates: [
        {
          id: 'default',
          name: 'Default',
          format: 'plain',
          body: templateBody,
          channelIds: [],
          itemIds: [],
          isDefault: true,
        },
      ],
      publicSnippetShowSameDay: true,
      publicSnippetCutoffRules: [
        // Rule 1: 1 day before at 4:00 PM for all pickup days
        {
          id: 'r-1day',
          enabled: true,
          mode: 'days_before',
          daysBefore: 1,
          cutoffWeekday: 5,
          cutoffTime: '16:00',
          pickupWeekdays: [],
        },
        // Rule 2: Weekly Thursday at 6:00 PM specifically for Saturday pickups (earlier than Fri 4pm!)
        {
          id: 'r-sat-thu',
          enabled: true,
          mode: 'weekly_day',
          daysBefore: 1,
          cutoffWeekday: 4,
          cutoffTime: '18:00',
          pickupWeekdays: [6],
        },
      ],
    });

    const satOrderId = Number(
      mgr.db
        .prepare(
          `INSERT INTO orders (source, status, timing_type, slotted_date, customer_name, pickup_channel_id, created_at, updated_at)
           VALUES ('manual', 'slotted', 'specific_date', '2026-11-28', 'Sam Saturday', ?, ?, ?)`
        )
        .run(channelId, nowIso, nowIso).lastInsertRowid
    );
    const monOrderId = Number(
      mgr.db
        .prepare(
          `INSERT INTO orders (source, status, timing_type, slotted_date, customer_name, pickup_channel_id, created_at, updated_at)
           VALUES ('manual', 'slotted', 'specific_date', '2026-11-30', 'Mona Monday', ?, ?, ?)`
        )
        .run(channelId, nowIso, nowIso).lastInsertRowid
    );
    mgr.db
      .prepare(`INSERT INTO order_items (order_id, tracked_item_id, quantity) VALUES (?, ?, 2)`)
      .run(satOrderId, itemId);
    mgr.db
      .prepare(`INSERT INTO order_items (order_id, tracked_item_id, quantity) VALUES (?, ?, 2)`)
      .run(monOrderId, itemId);

    const app = createExpressApp({
      dbManager: mgr,
      config: {
        port: 0,
        dbPath,
        backupDir,
        haOptionsPath: '',
        timezone: 'America/New_York',
        odoo: { url: '', db: '', apiKey: '', source: 'none' },
      },
      getNow: () => fixedNow,
    });
    const server = app.listen(0);
    const address = server.address();
    const port = typeof address === 'object' && address ? address.port : 0;

    try {
      // Saturday Nov 28 matches both rules; earliest is Thu, Nov 26 at 6:00 PM
      const satRes = await fetch(`http://127.0.0.1:${port}/api/orders/${satOrderId}/pre-approve`, {
        method: 'POST',
      });
      expect(satRes.status).toBe(200);
      const satBody = (await satRes.json()) as { message: string };
      expect(satBody.message).toBe(
        'Hi Sam, please order by Thu, Nov 26 at 6:00 PM (Thu, Nov 26 at 6:00 PM) for Sat, Nov 28.'
      );

      // Monday Nov 30 matches only the 1-day-before rule -> Sun, Nov 29 at 4:00 PM
      const monRes = await fetch(`http://127.0.0.1:${port}/api/orders/${monOrderId}/pre-approve`, {
        method: 'POST',
      });
      expect(monRes.status).toBe(200);
      const monBody = (await monRes.json()) as { message: string };
      expect(monBody.message).toBe(
        'Hi Mona, please order by Sun, Nov 29 at 4:00 PM (Sun, Nov 29 at 4:00 PM) for Mon, Nov 30.'
      );
    } finally {
      server.close();
      mgr.close();
    }
  });

  it('writes clean rollback-journal backups with zero WAL/SHM sidecars and restores both direct and previewed snapshots with live item/order counts', async () => {
    const Database = (await import('better-sqlite3')).default;
    const { createExpressApp } = await import('../../src/server/app');
    const { dir, dbPath, backupDir } = createTempPaths();
    const mgr = new DatabaseManager(dbPath, backupDir);
    await mgr.init('America/New_York');

    const nowIso = '2026-11-25T15:00:00.000Z';
    const itemId = Number(
      mgr.db
        .prepare(
          `INSERT INTO tracked_items (name, unit_label, is_active, supply_mode, default_daily_production, global_safety_buffer, include_in_public_snippet, sort_order, created_at, updated_at)
           VALUES ('Restored Duck Eggs', 'dozens', 1, 'continuous', 10, 2, 1, 0, ?, ?)`
        )
        .run(nowIso, nowIso).lastInsertRowid
    );
    const orderId = Number(
      mgr.db
        .prepare(
          `INSERT INTO orders (source, status, timing_type, slotted_date, customer_name, created_at, updated_at)
           VALUES ('manual', 'confirmed', 'specific_date', '2026-11-26', 'Restored Ruth', ?, ?)`
        )
        .run(nowIso, nowIso).lastInsertRowid
    );
    mgr.db
      .prepare(`INSERT INTO order_items (order_id, tracked_item_id, quantity) VALUES (?, ?, 3)`)
      .run(orderId, itemId);

    // 1. Create a manual snapshot and verify it is normalized out of WAL mode with zero sidecar files
    const snap = await mgr.createBackup('manual');
    const backupEntriesAfterCreate = fs.readdirSync(backupDir);
    expect(backupEntriesAfterCreate.some((f) => f.endsWith('-wal') || f.endsWith('-shm'))).toBe(false);
    const snapHeader = fs.readFileSync(path.join(backupDir, snap.filename)).subarray(0, 20);
    expect(snapHeader[18]).toBe(1);
    expect(snapHeader[19]).toBe(1);

    // 2. Also create a legacy WAL-mode backup file inside backupDir and validate it without creating sidecars
    const legacyWalSnapName = 'manual-2026-11-25T14-00-00-000Z-legacy-wal.db';
    const legacyWalPath = path.join(backupDir, legacyWalSnapName);
    fs.copyFileSync(path.join(backupDir, snap.filename), legacyWalPath);
    const legacyDb = new Database(legacyWalPath);
    legacyDb.pragma('journal_mode = WAL');
    legacyDb.close();
    // Clean any sidecars from our test fixture creation before calling validateSqliteFile
    for (const suffix of ['-wal', '-shm']) {
      if (fs.existsSync(`${legacyWalPath}${suffix}`)) fs.unlinkSync(`${legacyWalPath}${suffix}`);
    }
    const legacyHeader = fs.readFileSync(legacyWalPath).subarray(0, 20);
    expect(legacyHeader[18]).toBe(2); // Confirms fixture is marked WAL in header

    mgr.validateSqliteFile(legacyWalPath);
    const backupEntriesAfterValidate = fs.readdirSync(backupDir);
    expect(backupEntriesAfterValidate.some((f) => f.endsWith('-wal') || f.endsWith('-shm'))).toBe(false);

    // 3. Wipe the live DB so we can verify real HTTP restore replaces it completely
    mgr.db.prepare('DELETE FROM order_items').run();
    mgr.db.prepare('DELETE FROM orders').run();
    mgr.db.prepare('DELETE FROM tracked_items').run();
    expect(listTrackedItems(mgr.db)).toHaveLength(0);
    expect(listAllOrders(mgr.db)).toHaveLength(0);

    const app = createExpressApp({
      dbManager: mgr,
      config: {
        port: 0,
        dbPath,
        backupDir,
        haOptionsPath: '',
        timezone: 'America/New_York',
        odoo: { url: '', db: '', apiKey: '', source: 'none' },
      },
    });
    const server = app.listen(0);
    const address = server.address();
    const port = typeof address === 'object' && address ? address.port : 0;

    try {
      // 4. Direct restore via POST /api/backups/:filename/restore with JSON '{}' body
      const restoreRes = await fetch(
        `http://127.0.0.1:${port}/api/backups/${encodeURIComponent(legacyWalSnapName)}/restore`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: '{}',
        }
      );
      expect(restoreRes.status).toBe(200);
      const restoreBody = (await restoreRes.json()) as {
        restoredFrom: string;
        safetySnapshot: { trigger: string };
        itemsCount: number;
        ordersCount: number;
      };
      expect(restoreBody.restoredFrom).toBe(legacyWalSnapName);
      expect(restoreBody.safetySnapshot.trigger).toBe('pre-restore');
      expect(restoreBody.itemsCount).toBe(1);
      expect(restoreBody.ordersCount).toBe(1);
      expect(listTrackedItems(mgr.db).map((i) => i.name)).toEqual(['Restored Duck Eggs']);
      expect(listAllOrders(mgr.db).map((o) => o.customerName)).toEqual(['Restored Ruth']);

      // 5. Wipe live DB again, enter Backup Preview, and restore from Preview banner endpoint
      mgr.db.prepare('DELETE FROM order_items').run();
      mgr.db.prepare('DELETE FROM orders').run();
      mgr.db.prepare('DELETE FROM tracked_items').run();

      const previewRes = await fetch(`http://127.0.0.1:${port}/api/backups/preview/enter`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ filename: snap.filename }),
      });
      expect(previewRes.status).toBe(200);

      const previewRestoreRes = await fetch(`http://127.0.0.1:${port}/api/backups/preview/restore`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: '{}',
      });
      expect(previewRestoreRes.status).toBe(200);
      const previewRestoreBody = (await previewRestoreRes.json()) as {
        restoredFrom: string;
        itemsCount: number;
        ordersCount: number;
      };
      expect(previewRestoreBody.restoredFrom).toBe(snap.filename);
      expect(previewRestoreBody.itemsCount).toBe(1);
      expect(previewRestoreBody.ordersCount).toBe(1);
      expect(listTrackedItems(mgr.db).map((i) => i.name)).toEqual(['Restored Duck Eggs']);
      expect(listAllOrders(mgr.db).map((o) => o.customerName)).toEqual(['Restored Ruth']);

      // Zero stray -wal / -shm files in backupDir after all operations
      const finalBackupEntries = fs.readdirSync(backupDir);
      expect(finalBackupEntries.some((f) => f.endsWith('-wal') || f.endsWith('-shm'))).toBe(false);
    } finally {
      server.close();
      mgr.close();
      expect(fs.existsSync(dir)).toBe(true);
    }
  });

  it('recommends the actual replacement order date/channel/items over a cancelled pre-order and applies them cleanly via POST /api/orders/:id/merge', async () => {
    const { createExpressApp } = await import('../../src/server/app');
    const { dbPath, backupDir } = createTempPaths();
    const mgr = new DatabaseManager(dbPath, backupDir);
    await mgr.init('America/New_York');

    const nowIso = '2026-11-23T15:00:00.000Z';
    const itemId = Number(
      mgr.db
        .prepare(
          `INSERT INTO tracked_items (name, unit_label, is_active, supply_mode, default_daily_production, global_safety_buffer, include_in_public_snippet, sort_order, created_at, updated_at)
           VALUES ('Standard Eggs', 'dozens', 1, 'continuous', 20, 4, 1, 0, ?, ?)`
        )
        .run(nowIso, nowIso).lastInsertRowid
    );
    const channelFarmId = Number(
      mgr.db
        .prepare(
          `INSERT INTO pickup_channels (name, allowed_weekdays_json, color_token, is_active, sort_order)
           VALUES ('Farm Pickup', '[2,4]', 'sky', 1, 0)`
        )
        .run().lastInsertRowid
    );
    const channelMarketId = Number(
      mgr.db
        .prepare(
          `INSERT INTO pickup_channels (name, allowed_weekdays_json, color_token, is_active, sort_order)
           VALUES ('Saturday Farmers Market', '[6]', 'emerald', 1, 1)`
        )
        .run().lastInsertRowid
    );

    const cancelledId = Number(
      mgr.db
        .prepare(
          `INSERT INTO orders (source, status, timing_type, requested_date, slotted_date, customer_name, customer_email, pickup_channel_id, odoo_quotation_id, odoo_quotation_name, odoo_missing_flagged, created_at, updated_at)
           VALUES ('odoo', 'pre_approved', 'specific_date', '2026-11-24', '2026-11-24', 'Hannah Brooks', 'hannah@example.com', ?, 810, 'S00810', 1, ?, ?)`
        )
        .run(channelFarmId, nowIso, nowIso).lastInsertRowid
    );
    mgr.db
      .prepare(`INSERT INTO order_items (order_id, tracked_item_id, quantity) VALUES (?, ?, 2)`)
      .run(cancelledId, itemId);
    mgr.db
      .prepare(
        `INSERT INTO order_chatter (order_id, odoo_message_id, author_name, body_text, created_at_utc, created_at_local, message_type)
         VALUES (?, 9001, 'Staff', 'Pre-approved for Nov 24', '2026-11-22T15:00:00Z', '2026-11-22 10:00:00', 'comment')`
      )
      .run(cancelledId);

    const replacementId = Number(
      mgr.db
        .prepare(
          `INSERT INTO orders (source, status, timing_type, requested_date, slotted_date, customer_name, customer_email, pickup_channel_id, odoo_quotation_id, odoo_quotation_name, odoo_missing_flagged, created_at, updated_at)
           VALUES ('odoo', 'confirmed', 'specific_date', '2026-11-28', '2026-11-28', 'Hannah Brooks', 'hannah@example.com', ?, 820, 'S00820', 0, ?, ?)`
        )
        .run(channelMarketId, nowIso, nowIso).lastInsertRowid
    );
    mgr.db
      .prepare(`INSERT INTO order_items (order_id, tracked_item_id, quantity) VALUES (?, ?, 3)`)
      .run(replacementId, itemId);
    mgr.db
      .prepare(
        `INSERT INTO order_chatter (order_id, odoo_message_id, author_name, body_text, created_at_utc, created_at_local, message_type)
         VALUES (?, 9002, 'Hannah Brooks', 'Switched to Saturday Nov 28', '2026-11-23T16:00:00Z', '2026-11-23 11:00:00', 'email')`
      )
      .run(replacementId);

    const allOrdersBefore = listAllOrders(mgr.db);
    const cancelledOrder = allOrdersBefore.find((o) => o.id === cancelledId)!;
    const replacementOrder = allOrdersBefore.find((o) => o.id === replacementId)!;

    // Pure helpers recommend the actual replacement order date/items/channel in both argument orders
    const dateOptsForward = resolveMergeDateOptions(cancelledOrder, replacementOrder);
    expect(dateOptsForward.hasDifferentDates).toBe(true);
    expect(dateOptsForward.recommendedSide).toBe('source');
    expect(dateOptsForward.recommendedDate).toBe('2026-11-28');

    const dateOptsReverse = resolveMergeDateOptions(replacementOrder, cancelledOrder);
    expect(dateOptsReverse.recommendedSide).toBe('target');
    expect(dateOptsReverse.recommendedDate).toBe('2026-11-28');

    const preview = previewMergeOutcome(cancelledOrder, replacementOrder, 'use_source', '2026-11-28');
    expect(preview.nextSlottedDate).toBe('2026-11-28');
    expect(preview.nextStatus).toBe('confirmed');
    expect(preview.nextPickupChannelId).toBe(channelMarketId);
    expect(
      preview.mergedItems.map(({ trackedItemId, quantity }) => ({ trackedItemId, quantity }))
    ).toEqual([{ trackedItemId: itemId, quantity: 3 }]);
    expect(preview.primaryOdooRef).toBe('S00820');
    expect(preview.archivedOdooRef).toBe('S00810');
    expect(preview.combinedChatterCount).toBe(2);

    const app = createExpressApp({
      dbManager: mgr,
      config: {
        port: 0,
        dbPath,
        backupDir,
        haOptionsPath: '',
        timezone: 'America/New_York',
        odoo: { url: '', db: '', apiKey: '', source: 'none' },
      },
    });
    const server = app.listen(0);
    const address = server.address();
    const port = typeof address === 'object' && address ? address.port : 0;

    try {
      const mergeRes = await fetch(`http://127.0.0.1:${port}/api/orders/${cancelledId}/merge`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          sourceOrderId: replacementId,
          itemStrategy: 'use_source',
          keepDate: '2026-11-28',
        }),
      });
      expect(mergeRes.status).toBe(200);

      const remaining = listAllOrders(mgr.db);
      expect(remaining).toHaveLength(1);
      const surviving = remaining[0];
      expect(surviving.id).toBe(cancelledId);
      expect(surviving.slottedDate).toBe('2026-11-28');
      expect(surviving.status).toBe('confirmed');
      expect(surviving.pickupChannelId).toBe(channelMarketId);
      expect(surviving.odooQuotationName).toBe('S00820');
      expect(surviving.mergedOdooNames).toEqual(['S00810']);
      expect(surviving.odooMissingFlagged).toBe(false);
      expect(
        surviving.items.map(({ trackedItemId, quantity }) => ({ trackedItemId, quantity }))
      ).toEqual([{ trackedItemId: itemId, quantity: 3 }]);
      expect(surviving.chatter).toHaveLength(2);
    } finally {
      server.close();
      mgr.close();
    }
  });
});
