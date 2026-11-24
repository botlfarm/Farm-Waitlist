import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterEach, describe, expect, it } from 'vitest';
import { createExpressApp } from '../../src/server/app';
import { loadRuntimeConfig, normalizeOdooBaseUrl } from '../../src/server/config';
import { DatabaseManager } from '../../src/server/db';
import {
  callOdooJson2,
  stripHtmlToPlainText,
  syncOdooCustomers,
  syncOdooQuotations,
  type FetchLike,
} from '../../src/server/odooService';
import { listAllOrders, listPickupChannels, listTrackedItems } from '../../src/server/repository';
import {
  localDateStartToOdooUtc,
  odooUtcToLocalDateKey,
  odooUtcToLocalTimestamp,
} from '../../src/shared/timezone';

const tmpDirs: string[] = [];

function createTempDb() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'farm-waitlist-odoo-'));
  tmpDirs.push(dir);
  return new DatabaseManager(path.join(dir, 'waitlist.db'), path.join(dir, 'backups'));
}

afterEach(() => {
  while (tmpDirs.length > 0) {
    fs.rmSync(tmpDirs.pop()!, { recursive: true, force: true });
  }
});

describe('Odoo UTC -> America/New_York Timezone Normalization', () => {
  it('converts EST (-05:00) and EDT (-04:00) local midnight accurately to Odoo UTC strings', () => {
    // Winter (EST, UTC-5): 2026-11-23 00:00:00 ET == 2026-11-23 05:00:00 UTC
    expect(localDateStartToOdooUtc('2026-11-23', 'America/New_York')).toBe('2026-11-23 05:00:00');
    // Summer (EDT, UTC-4): 2026-07-15 00:00:00 ET == 2026-07-15 04:00:00 UTC
    expect(localDateStartToOdooUtc('2026-07-15', 'America/New_York')).toBe('2026-07-15 04:00:00');
  });

  it('normalizes late-evening Odoo UTC timestamps back to the true America/New_York calendar date', () => {
    // 2026-11-24 02:30:00 UTC is 2026-11-23 21:30:00 EST!
    expect(odooUtcToLocalDateKey('2026-11-24 02:30:00', 'America/New_York')).toBe('2026-11-23');
    expect(odooUtcToLocalTimestamp('2026-11-24 02:30:00', 'America/New_York')).toBe(
      '2026-11-23 21:30:00'
    );
  });
});

describe('Odoo 19.3 /json/2/ Synchronization, Chatter Filtering & Reconciliation', () => {
  it('enforces cutoff date, ignored ranges, comment/email chatter filter, missing partner handling, live re-sync preservation, and always-flag deleted reconciliation', async () => {
    const mgr = createTempDb();
    await mgr.init('America/New_York');
    const now = new Date().toISOString();

    // Seed 2 Tracked Items & 1 Pickup Channel for matching tests
    const stdId = Number(
      mgr.db
        .prepare(
          `INSERT INTO tracked_items (name, unit_label, is_active, supply_mode, default_daily_production, global_safety_buffer, include_in_public_snippet, keyword_rules_json, sort_order, created_at, updated_at)
           VALUES ('Standard Eggs', 'dozens', 1, 'continuous', 20, 4, 1, '["standard","large eggs"]', 0, ?, ?)`
        )
        .run(now, now).lastInsertRowid
    );
    const pulletId = Number(
      mgr.db
        .prepare(
          `INSERT INTO tracked_items (name, unit_label, is_active, supply_mode, default_daily_production, global_safety_buffer, include_in_public_snippet, keyword_rules_json, sort_order, created_at, updated_at)
           VALUES ('Pullet Eggs', 'dozens', 1, 'continuous', 10, 2, 1, '["pullet"]', 1, ?, ?)`
        )
        .run(now, now).lastInsertRowid
    );
    const marketId = Number(
      mgr.db
        .prepare(
          `INSERT INTO pickup_channels (name, allowed_weekdays_json, color_token, is_active, sort_order)
           VALUES ('Wooster Square', '[6]', 'sky', 1, 0)`
        )
        .run().lastInsertRowid
    );

    mgr.updateSettings({
      timezone: 'America/New_York',
      odooSyncCutoffDate: '2026-11-01',
      odooIgnoredDateRanges: [
        { id: 'summer', startDate: '2026-11-05', endDate: '2026-11-10', label: 'Off-week' },
      ],
    });

    const recordedCalls: Array<{ url: string; headers: Record<string, string>; body: Record<string, unknown> }> = [];
    let syncPhase = 1;

    const mockFetch: FetchLike = async (url, init) => {
      const headers = (init?.headers ?? {}) as Record<string, string>;
      const body = JSON.parse(String(init?.body || '{}')) as Record<string, unknown>;
      recordedCalls.push({ url, headers, body });

      if (url.endsWith('/json/2/sale.order/search_read')) {
        const domain = JSON.stringify(body.domain);

        // Confirmed order reconciliation lookup (queries ONLY sale/done, not draft/sent)
        if (!domain.includes('"draft"') && domain.includes('"sale"') && domain.includes('"done"')) {
          return new Response(
            JSON.stringify([
              {
                id: 9001,
                name: 'S00901',
                state: 'sale',
                date_order: '2026-11-24 14:00:00',
                create_date: '2026-11-24 14:00:00',
                partner_id: [501, 'Jane Doe'],
                amount_total: 24.0,
              },
            ]),
            { status: 200 }
          );
        }

        // Phase 1: 3 open draft quotations (1 in ignored date range, 1 missing partner_id, 1 normal)
        if (syncPhase === 1) {
          return new Response(
            JSON.stringify([
              {
                id: 101,
                name: 'S00101',
                state: 'draft',
                // 2026-11-06 16:00 UTC -> 2026-11-06 ET (inside ignored range Nov 5-10!)
                create_date: '2026-11-06 16:00:00',
                partner_id: [500, 'Off Season Buyer'],
                note: '<p>2 standard eggs</p>',
                order_line: [],
              },
              {
                id: 102,
                name: 'S00102',
                state: 'draft',
                // 2026-11-24 02:30:00 UTC -> 2026-11-23 21:30:00 ET
                create_date: '2026-11-24 02:30:00',
                partner_id: false, // Missing partner_id!
                note: '<p>Name: Mystery Caller<br/>Pickup: Wooster Square<br/>ASAP please</p>',
                order_line: [201, 202],
              },
              {
                id: 103,
                name: 'S00103',
                state: 'sent',
                create_date: '2026-11-23 15:00:00',
                partner_id: [501, 'Jane Doe'],
                note: '<p>Need 1.5 pullet eggs for 2026-11-28</p>',
                order_line: [],
              },
            ]),
            { status: 200 }
          );
        }

        // Phase 2: Quotation 102 has updated quantity & new chatter; Quotation 103 was deleted in Odoo!
        if (domain.includes('103') && !domain.includes('create_date')) {
          return new Response(JSON.stringify([]), { status: 200 });
        }
        return new Response(
          JSON.stringify([
            {
              id: 102,
              name: 'S00102',
              state: 'draft',
              create_date: '2026-11-24 02:30:00',
              partner_id: [502, 'Linked Contact Name'],
              note: '<p>Updated note</p>',
              order_line: [201],
            },
          ]),
          { status: 200 }
        );
      }

      if (url.endsWith('/json/2/sale.order.line/search_read')) {
        if (syncPhase === 1) {
          return new Response(
            JSON.stringify([
              { id: 201, order_id: [102, 'S00102'], name: 'Standard Eggs (Dozen)', product_uom_qty: 2 },
              { id: 202, order_id: [102, 'S00102'], name: 'Pullet Eggs (Dozen)', product_uom_qty: 1.5 },
            ]),
            { status: 200 }
          );
        }
        return new Response(
          JSON.stringify([
            { id: 201, order_id: [102, 'S00102'], name: 'Standard Eggs (Dozen)', product_uom_qty: 4 },
          ]),
          { status: 200 }
        );
      }

      if (url.endsWith('/json/2/res.partner/search_read')) {
        return new Response(
          JSON.stringify([
            { id: 501, name: 'Jane Doe', email: 'jane@example.com', phone: '555-1212' },
            { id: 502, name: 'Linked Contact Name', email: 'linked@example.com', phone: '555-9999' },
          ]),
          { status: 200 }
        );
      }

      if (url.endsWith('/json/2/mail.message/search_read')) {
        return new Response(
          JSON.stringify([
            {
              id: 7001,
              res_id: 102,
              author_id: [2, 'Website Form'],
              message_type: 'comment',
              subtype_id: [1, 'Discussions'],
              body: '<p>Form submitted:<br/>Customer wants <b>Wooster Square</b></p>',
              date: '2026-11-24 02:31:00', // -> 2026-11-23 21:31:00 ET
            },
            {
              id: 7002,
              res_id: 102,
              author_id: [1, 'OdooBot'],
              message_type: 'notification', // Must be excluded!
              subtype_id: [2, 'Note'],
              body: '<p>State changed to Draft</p>',
              date: '2026-11-24 02:32:00',
            },
            {
              id: 7003,
              res_id: 103,
              author_id: false,
              email_from: 'jane@example.com',
              message_type: 'email',
              subtype_id: [1, 'Discussions'],
              body: '<p>Hi! Can I pick up Saturday?</p>',
              date: '2026-11-23 15:05:00',
            },
          ]),
          { status: 200 }
        );
      }

      return new Response('[]', { status: 200 });
    };

    const odooCreds = {
      url: 'https://demo.odoo.example',
      db: 'farm_db',
      apiKey: 'secret-test-key',
      source: 'env' as const,
    };

    // --- SYNC 1 ---
    const res1 = await syncOdooQuotations({
      db: mgr.db,
      odoo: odooCreds,
      settings: mgr.getSettings(),
      trackedItems: listTrackedItems(mgr.db),
      channels: listPickupChannels(mgr.db),
      fetchFn: mockFetch,
    });

    expect(res1.syncLog.status).toBe('success');
    expect(res1.syncLog.importedCount).toBe(2); // 101 skipped due to ignored date range!

    // Verify Bearer header, X-Odoo-Database header, UTC cutoff date, and mail.message comment/email filter
    const saleCall = recordedCalls.find((c) => c.url.endsWith('/json/2/sale.order/search_read'))!;
    expect(saleCall.headers.Authorization).toBe('bearer secret-test-key');
    expect(saleCall.headers['X-Odoo-Database']).toBe('farm_db');
    expect(JSON.stringify(saleCall.body.domain)).toContain('2026-11-01 04:00:00'); // Nov 1 2026 is still EDT (-04:00)!

    const chatterCall = recordedCalls.find((c) => c.url.endsWith('/json/2/mail.message/search_read'))!;
    expect(JSON.stringify(chatterCall.body.domain)).toContain('"comment"');
    expect(JSON.stringify(chatterCall.body.domain)).toContain('"email"');

    const partnerCall = recordedCalls.find((c) => c.url.endsWith('/json/2/res.partner/search_read'))!;
    expect(partnerCall.body.fields).toEqual(['id', 'name', 'email', 'phone']);
    expect(partnerCall.body.fields).not.toContain('mobile');

    const ordersAfter1 = listAllOrders(mgr.db);
    expect(ordersAfter1).toHaveLength(2);

    const order102 = ordersAfter1.find((o) => o.odooQuotationId === 102)!;
    expect(order102.customerName).toBe('Mystery Caller'); // Extracted from note when partner_id missing
    expect(order102.pickupChannelId).toBe(marketId);
    expect(order102.odooCreatedAtLocal).toBe('2026-11-23 21:30:00'); // Normalized to America/New_York!
    expect(order102.items).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ trackedItemId: stdId, quantity: 2 }),
        expect.objectContaining({ trackedItemId: pulletId, quantity: 1.5 }),
      ])
    );
    // Notification message 7002 must NOT be stored; comment 7001 must have sanitized text & local time
    expect(order102.chatter).toHaveLength(1);
    expect(order102.chatter[0].odooMessageId).toBe(7001);
    expect(order102.chatter[0].bodyText).toBe('Form submitted:\nCustomer wants Wooster Square');
    expect(order102.chatter[0].createdAtLocal).toBe('2026-11-23 21:31:00');

    const order103 = ordersAfter1.find((o) => o.odooQuotationId === 103)!;
    expect(order103.customerName).toBe('Jane Doe');
    expect(order103.timingType).toBe('specific_date');
    expect(order103.requestedDate).toBe('2026-11-28');
    expect(order103.items[0]).toMatchObject({ trackedItemId: pulletId, quantity: 1.5 });
    expect(order103.chatter).toHaveLength(1);
    expect(order103.chatter[0].messageType).toBe('email');

    // Locally slot & lock order 102 AND override customer name manually
    mgr.db
      .prepare(
        `UPDATE orders
         SET slotted_date = '2026-11-28', status = 'slotted', is_locked = 1,
             customer_name = 'My Manual Name', customer_name_overridden = 1
         WHERE id = ?`
      )
      .run(order102.id);

    // Move cutoff date forward past Nov 24 — existing active orders must STILL re-sync & reconcile!
    mgr.updateSettings({ odooSyncCutoffDate: '2026-11-30' });

    // --- SYNC 2 ---
    syncPhase = 2;
    const res2 = await syncOdooQuotations({
      db: mgr.db,
      odoo: odooCreds,
      settings: mgr.getSettings(),
      trackedItems: listTrackedItems(mgr.db),
      channels: listPickupChannels(mgr.db),
      fetchFn: mockFetch,
    });

    expect(res2.syncLog.updatedCount).toBe(1);
    expect(res2.syncLog.flaggedMissingCount).toBe(1);

    const ordersAfter2 = listAllOrders(mgr.db);
    const updated102 = ordersAfter2.find((o) => o.odooQuotationId === 102)!;
    // Manual name, slot date, lock & status preserved while contact & qty updated!
    expect(updated102.customerName).toBe('My Manual Name');
    expect(updated102.customerEmail).toBe('linked@example.com');
    expect(updated102.slottedDate).toBe('2026-11-28');
    expect(updated102.isLocked).toBe(true);
    expect(updated102.odooUpdatedAfterSlot).toBe(true);
    expect(updated102.items).toEqual([expect.objectContaining({ trackedItemId: stdId, quantity: 4 })]);

    // Order 103 disappeared in Odoo -> ALWAYS flagged for 1-click confirmation (NOT auto-confirmed!)
    const missing103 = ordersAfter2.find((o) => o.odooQuotationId === 103)!;
    expect(missing103.status).toBe('waitlist');
    expect(missing103.odooMissingFlagged).toBe(true);
    expect(missing103.odooSuggestedConfirmed?.odooOrderName).toBe('S00901');

    expect(stripHtmlToPlainText('<script>alert(1)</script><p>Safe &amp; clean</p>')).toBe(
      'Safe & clean'
    );
    mgr.close();
  });

  it('loads Odoo credentials from only ODOO_BASE_URL, ODOO_DB, and ODOO_API_KEY with automatic runtime defaults', () => {
    const prevBase = process.env.ODOO_BASE_URL;
    const prevUrl = process.env.ODOO_URL;
    const prevDb = process.env.ODOO_DB;
    const prevKey = process.env.ODOO_API_KEY;
    const prevPort = process.env.PORT;
    try {
      delete process.env.ODOO_URL;
      delete process.env.PORT;
      process.env.ODOO_BASE_URL = 'https://farm.odoo.com/';
      process.env.ODOO_DB = 'farm_prod';
      process.env.ODOO_API_KEY = 'test-secret-key';

      const cfg = loadRuntimeConfig({ haOptionsPath: '/nonexistent/options.json' });
      expect(cfg.odoo).toEqual({
        url: 'https://farm.odoo.com',
        db: 'farm_prod',
        apiKey: 'test-secret-key',
        source: 'env',
      });
      expect(cfg.port).toBe(3000);
      expect(cfg.timezone).toBeTruthy();
    } finally {
      if (prevBase === undefined) delete process.env.ODOO_BASE_URL;
      else process.env.ODOO_BASE_URL = prevBase;
      if (prevUrl === undefined) delete process.env.ODOO_URL;
      else process.env.ODOO_URL = prevUrl;
      if (prevDb === undefined) delete process.env.ODOO_DB;
      else process.env.ODOO_DB = prevDb;
      if (prevKey === undefined) delete process.env.ODOO_API_KEY;
      else process.env.ODOO_API_KEY = prevKey;
      if (prevPort === undefined) delete process.env.PORT;
      else process.env.PORT = prevPort;
    }
  });

  it('imports processed Odoo Sales Orders (sale/done) read-only, handles commitment_date fallback, and promotes in-place confirmed quotations', async () => {
    const mgr = createTempDb();
    await mgr.init('America/New_York');
    const now = new Date().toISOString();

    const stdId = Number(
      mgr.db
        .prepare(
          `INSERT INTO tracked_items (name, unit_label, is_active, supply_mode, default_daily_production, global_safety_buffer, include_in_public_snippet, keyword_rules_json, sort_order, created_at, updated_at)
           VALUES ('Standard Eggs', 'dozens', 1, 'continuous', 20, 4, 1, '["standard","eggs"]', 0, ?, ?)`
        )
        .run(now, now).lastInsertRowid
    );

    const calledEndpoints: string[] = [];
    let phase = 1;
    let simulateNoSaleStock = false;

    const mockFetch: FetchLike = async (url, init) => {
      calledEndpoints.push(url);
      const body = JSON.parse(String(init?.body || '{}')) as {
        fields?: string[];
        domain?: unknown[];
      };

      if (url.endsWith('/json/2/sale.order/search_read')) {
        if (simulateNoSaleStock && Array.isArray(body.fields) && body.fields.includes('commitment_date')) {
          return new Response(
            JSON.stringify({ message: "Invalid field 'commitment_date' on model 'sale.order'" }),
            { status: 400 }
          );
        }

        if (phase === 1) {
          return new Response(
            JSON.stringify([
              // Brand-new Sales Order with Delivery Date (commitment_date) -> confirmed + auto-slotted!
              {
                id: 301,
                name: 'S00301',
                state: 'sale',
                create_date: '2026-11-23 14:00:00',
                date_order: '2026-11-23 14:05:00',
                commitment_date: '2026-11-28 15:00:00', // -> 2026-11-28 ET
                partner_id: [601, 'Direct Buyer With Date'],
                note: false,
                order_line: [401],
              },
              // Brand-new Sales Order WITHOUT commitment_date -> confirmed + unslotted (needs pickup date!)
              {
                id: 302,
                name: 'S00302',
                state: 'done',
                create_date: '2026-11-23 16:00:00',
                date_order: '2026-11-23 16:10:00',
                commitment_date: false,
                partner_id: [602, 'Direct Buyer No Date'],
                note: false,
                order_line: [402],
              },
              // Open draft quotation that will be confirmed in-place in phase 2
              {
                id: 303,
                name: 'S00303',
                state: 'draft',
                create_date: '2026-11-23 17:00:00',
                date_order: '2026-11-23 17:00:00',
                commitment_date: false,
                partner_id: [603, 'Waitlist To Sale'],
                note: false,
                order_line: [403],
              },
            ]),
            { status: 200 }
          );
        }

        // Phase 2: S00303 is now confirmed in-place as state='sale' (and test without sale_stock!)
        return new Response(
          JSON.stringify([
            {
              id: 301,
              name: 'S00301',
              state: 'sale',
              create_date: '2026-11-23 14:00:00',
              date_order: '2026-11-23 14:05:00',
              partner_id: [601, 'Direct Buyer With Date'],
              note: false,
              order_line: [401],
            },
            {
              id: 302,
              name: 'S00302',
              state: 'done',
              create_date: '2026-11-23 16:00:00',
              date_order: '2026-11-23 16:10:00',
              partner_id: [602, 'Direct Buyer No Date'],
              note: false,
              order_line: [402],
            },
            {
              id: 303,
              name: 'S00303',
              state: 'sale',
              create_date: '2026-11-23 17:00:00',
              date_order: '2026-11-24 12:00:00',
              partner_id: [603, 'Waitlist To Sale'],
              note: false,
              order_line: [403],
            },
          ]),
          { status: 200 }
        );
      }

      if (url.endsWith('/json/2/sale.order.line/search_read')) {
        return new Response(
          JSON.stringify([
            { id: 401, order_id: [301, 'S00301'], name: 'Standard Eggs', product_uom_qty: 6 },
            { id: 402, order_id: [302, 'S00302'], name: 'Standard Eggs', product_uom_qty: 3 },
            { id: 403, order_id: [303, 'S00303'], name: 'Standard Eggs', product_uom_qty: 5 },
          ]),
          { status: 200 }
        );
      }

      if (url.endsWith('/json/2/res.partner/search_read')) {
        return new Response(
          JSON.stringify([
            { id: 601, name: 'Direct Buyer With Date', email: 'b1@example.com', phone: false },
            { id: 602, name: 'Direct Buyer No Date', email: 'b2@example.com', phone: false },
            { id: 603, name: 'Waitlist To Sale', email: 'b3@example.com', phone: false },
          ]),
          { status: 200 }
        );
      }

      return new Response('[]', { status: 200 });
    };

    const odooCreds = {
      url: 'https://demo.odoo.example',
      db: 'farm_db',
      apiKey: 'secret-key',
      source: 'env' as const,
    };

    const r1 = await syncOdooQuotations({
      db: mgr.db,
      odoo: odooCreds,
      settings: mgr.getSettings(),
      trackedItems: listTrackedItems(mgr.db),
      channels: listPickupChannels(mgr.db),
      fetchFn: mockFetch,
    });
    expect(r1.syncLog.importedCount).toBe(3);

    const after1 = listAllOrders(mgr.db);
    const o301 = after1.find((o) => o.odooQuotationId === 301)!;
    const o302 = after1.find((o) => o.odooQuotationId === 302)!;
    const o303 = after1.find((o) => o.odooQuotationId === 303)!;

    // 301: Confirmed Sales Order with commitment_date -> directly confirmed & slotted onto Nov 28
    expect(o301.status).toBe('confirmed');
    expect(o301.slottedDate).toBe('2026-11-28');
    expect(o301.requestedDate).toBe('2026-11-28');
    expect(o301.items).toEqual([expect.objectContaining({ trackedItemId: stdId, quantity: 6 })]);

    // 302: Confirmed Sales Order without commitment_date -> confirmed & unslotted so farmer assigns date
    expect(o302.status).toBe('confirmed');
    expect(o302.slottedDate).toBeNull();

    // 303: Open draft quotation -> waitlist & unslotted
    expect(o303.status).toBe('waitlist');
    expect(o303.slottedDate).toBeNull();

    // Farmer locally slots 303 onto 2026-11-27 as pre_approved
    mgr.db
      .prepare(`UPDATE orders SET status = 'pre_approved', slotted_date = '2026-11-27' WHERE id = ?`)
      .run(o303.id);

    // Phase 2: 303 becomes state='sale' in Odoo AND simulate missing sale_stock commitment_date field
    phase = 2;
    simulateNoSaleStock = true;
    const r2 = await syncOdooQuotations({
      db: mgr.db,
      odoo: odooCreds,
      settings: mgr.getSettings(),
      trackedItems: listTrackedItems(mgr.db),
      channels: listPickupChannels(mgr.db),
      fetchFn: mockFetch,
    });
    expect(r2.syncLog.status).toBe('success');

    const after2 = listAllOrders(mgr.db);
    const promoted303 = after2.find((o) => o.odooQuotationId === 303)!;
    expect(promoted303.status).toBe('confirmed');
    expect(promoted303.slottedDate).toBe('2026-11-27'); // Preserved local calendar slot!

    // Guarantee 100% read-only Odoo usage: every single call MUST end with /search_read
    expect(calledEndpoints.length).toBeGreaterThan(0);
    for (const ep of calledEndpoints) {
      expect(ep.endsWith('/search_read')).toBe(true);
    }

    mgr.close();
  });

  it('merges duplicate Odoo quotation + sales order cleanly, prevents re-import on next sync, supports combine quantities, and rolls back on Undo', async () => {
    const mgr = createTempDb();
    await mgr.init('America/New_York');
    const now = new Date().toISOString();

    const stdId = Number(
      mgr.db
        .prepare(
          `INSERT INTO tracked_items (name, unit_label, is_active, supply_mode, default_daily_production, global_safety_buffer, include_in_public_snippet, keyword_rules_json, sort_order, created_at, updated_at)
           VALUES ('Standard Eggs', 'dozens', 1, 'continuous', 20, 4, 1, '["standard","eggs"]', 0, ?, ?)`
        )
        .run(now, now).lastInsertRowid
    );

    const mockFetch: FetchLike = async (url) => {
      if (url.endsWith('/json/2/sale.order/search_read')) {
        return new Response(
          JSON.stringify([
            {
              id: 801,
              name: 'S00801',
              state: 'draft',
              create_date: '2026-11-23 13:00:00',
              date_order: '2026-11-23 13:00:00',
              commitment_date: false,
              partner_id: [701, 'Alex Rivera'],
              note: '<p>Waitlist request</p>',
              order_line: [901],
            },
            {
              id: 802,
              name: 'S00802',
              state: 'sale',
              create_date: '2026-11-23 18:00:00',
              date_order: '2026-11-23 18:05:00',
              commitment_date: false,
              partner_id: [701, 'Alex Rivera'],
              note: '<p>Paid on EFF</p>',
              order_line: [902],
            },
          ]),
          { status: 200 }
        );
      }
      if (url.endsWith('/json/2/sale.order.line/search_read')) {
        return new Response(
          JSON.stringify([
            { id: 901, order_id: [801, 'S00801'], name: 'Standard Eggs', product_uom_qty: 2 },
            { id: 902, order_id: [802, 'S00802'], name: 'Standard Eggs', product_uom_qty: 2 },
          ]),
          { status: 200 }
        );
      }
      if (url.endsWith('/json/2/res.partner/search_read')) {
        return new Response(
          JSON.stringify([{ id: 701, name: 'Alex Rivera', email: 'alex@example.com', phone: '555-0101' }]),
          { status: 200 }
        );
      }
      if (url.endsWith('/json/2/mail.message/search_read')) {
        return new Response(
          JSON.stringify([
            {
              id: 8801,
              res_id: 801,
              author_id: [2, 'Alex Rivera'],
              message_type: 'comment',
              subtype_id: [1, 'Discussions'],
              body: '<p>Original waitlist message</p>',
              date: '2026-11-23 13:01:00',
            },
            {
              id: 8802,
              res_id: 802,
              author_id: [2, 'Alex Rivera'],
              message_type: 'comment',
              subtype_id: [1, 'Discussions'],
              body: '<p>Checkout confirmation message</p>',
              date: '2026-11-23 18:06:00',
            },
          ]),
          { status: 200 }
        );
      }
      return new Response('[]', { status: 200 });
    };

    const odooCreds = {
      url: 'https://demo.odoo.example',
      db: 'farm_db',
      apiKey: 'secret-key',
      source: 'env' as const,
    };

    // Initial sync brings in Alex's draft quotation (801) AND confirmed sales order (802)
    await syncOdooQuotations({
      db: mgr.db,
      odoo: odooCreds,
      settings: mgr.getSettings(),
      trackedItems: listTrackedItems(mgr.db),
      channels: listPickupChannels(mgr.db),
      fetchFn: mockFetch,
    });

    const initialOrders = listAllOrders(mgr.db);
    expect(initialOrders).toHaveLength(2);
    const alexDraft = initialOrders.find((o) => o.odooQuotationId === 801)!;
    const alexSale = initialOrders.find((o) => o.odooQuotationId === 802)!;

    // Farmer slots Alex's draft quotation onto 2026-11-28 as pre_approved
    mgr.db
      .prepare(`UPDATE orders SET slotted_date = '2026-11-28', status = 'pre_approved' WHERE id = ?`)
      .run(alexDraft.id);

    // Boot Express app on ephemeral port to test POST /api/orders/:id/merge + /api/checkpoints/undo
    const app = createExpressApp({
      dbManager: mgr,
      config: {
        port: 0,
        dbPath: mgr.dbPath,
        backupDir: mgr.backupDir,
        timezone: 'America/New_York',
        haOptionsPath: '/nonexistent/options.json',
        odoo: odooCreds,
      },
      fetchFn: mockFetch,
    });
    const server = await new Promise<import('http').Server>((resolve) => {
      const s = app.listen(0, '127.0.0.1', () => resolve(s));
    });
    const port = (server.address() as import('net').AddressInfo).port;
    const baseUrl = `http://127.0.0.1:${port}`;

    try {
      // Merge Alex's confirmed Sales Order (802) into Alex's slotted draft (801) using keep_target (same order)
      const mergeRes = await fetch(`${baseUrl}/api/orders/${alexDraft.id}/merge`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ sourceOrderId: alexSale.id, itemStrategy: 'keep_target' }),
      });
      expect(mergeRes.status).toBe(200);
      const mergePayload = (await mergeRes.json()) as {
        order: ReturnType<typeof listAllOrders>[number];
        mergedOrderId: number;
      };
      expect(mergePayload.mergedOrderId).toBe(alexSale.id);

      const afterMerge = listAllOrders(mgr.db);
      expect(afterMerge).toHaveLength(1);
      const kept = afterMerge[0];
      // Kept calendar slot, promoted status to confirmed, kept 2 doz (not 4), promoted primary Odoo ID to S00802, tracked S00801 as merged!
      expect(kept.slottedDate).toBe('2026-11-28');
      expect(kept.status).toBe('confirmed');
      expect(kept.odooQuotationId).toBe(802);
      expect(kept.odooQuotationName).toBe('S00802');
      expect(kept.mergedOdooNames).toEqual(['S00801']);
      expect(kept.items).toEqual([expect.objectContaining({ trackedItemId: stdId, quantity: 2 })]);
      expect(kept.chatter.map((c) => c.odooMessageId)).toEqual([8801, 8802]);
      expect(kept.notes).toContain('Waitlist request');
      expect(kept.notes).toContain('Paid on EFF');

      // Re-run Odoo sync returning BOTH 801 and 802 -> 801 MUST NOT re-import as a duplicate!
      const resync = await syncOdooQuotations({
        db: mgr.db,
        odoo: odooCreds,
        settings: mgr.getSettings(),
        trackedItems: listTrackedItems(mgr.db),
        channels: listPickupChannels(mgr.db),
        fetchFn: mockFetch,
      });
      expect(resync.syncLog.importedCount).toBe(0);
      expect(listAllOrders(mgr.db)).toHaveLength(1);

      // 1-click Undo restores both orders AND removes the merged link
      const undoRes = await fetch(`${baseUrl}/api/checkpoints/undo`, { method: 'POST' });
      expect(undoRes.status).toBe(200);
      expect(listAllOrders(mgr.db)).toHaveLength(2);

      // Now test 'combine' strategy (adds 2 + 2 = 4 dozens)
      const combineRes = await fetch(`${baseUrl}/api/orders/${alexDraft.id}/merge`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ sourceOrderId: alexSale.id, itemStrategy: 'combine' }),
      });
      expect(combineRes.status).toBe(200);
      const combinedOrders = listAllOrders(mgr.db);
      expect(combinedOrders).toHaveLength(1);
      expect(combinedOrders[0].items).toEqual([
        expect.objectContaining({ trackedItemId: stdId, quantity: 4 }),
      ]);
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
      mgr.close();
    }
  });

  it('merges two confirmed Odoo orders on different dates into 1 single order on the chosen keepDate and keeps only that 1 date across re-syncs', async () => {
    const mgr = createTempDb();
    await mgr.init('America/New_York');
    const now = new Date().toISOString();

    const stdId = Number(
      mgr.db
        .prepare(
          `INSERT INTO tracked_items (name, unit_label, is_active, supply_mode, default_daily_production, global_safety_buffer, include_in_public_snippet, keyword_rules_json, sort_order, created_at, updated_at)
           VALUES ('Standard Eggs', 'dozens', 1, 'continuous', 20, 4, 1, '["standard","eggs"]', 0, ?, ?)`
        )
        .run(now, now).lastInsertRowid
    );

    const mockFetch: FetchLike = async (url) => {
      if (url.endsWith('/json/2/sale.order/search_read')) {
        return new Response(
          JSON.stringify([
            {
              id: 1744,
              name: 'S00767',
              state: 'sale',
              create_date: '2026-11-23 13:00:00',
              date_order: '2026-11-23 13:00:00',
              commitment_date: '2026-11-29 15:00:00', // -> 2026-11-29 ET
              partner_id: [910, 'Alex Carpenter'],
              note: false,
              order_line: [1901],
            },
            {
              id: 1745,
              name: 'S00768',
              state: 'sale',
              create_date: '2026-11-23 18:00:00',
              date_order: '2026-11-23 18:05:00',
              commitment_date: '2026-11-28 15:00:00', // -> 2026-11-28 ET
              partner_id: [910, 'Alex Carpenter'],
              note: false,
              order_line: [1902],
            },
          ]),
          { status: 200 }
        );
      }
      if (url.endsWith('/json/2/sale.order.line/search_read')) {
        return new Response(
          JSON.stringify([
            { id: 1901, order_id: [1744, 'S00767'], name: 'Standard Eggs', product_uom_qty: 3 },
            { id: 1902, order_id: [1745, 'S00768'], name: 'Standard Eggs', product_uom_qty: 3 },
          ]),
          { status: 200 }
        );
      }
      if (url.endsWith('/json/2/res.partner/search_read')) {
        return new Response(
          JSON.stringify([{ id: 910, name: 'Alex Carpenter', email: 'alex.c@example.com', phone: false }]),
          { status: 200 }
        );
      }
      return new Response('[]', { status: 200 });
    };

    const odooCreds = {
      url: 'https://demo.odoo.example',
      db: 'farm_db',
      apiKey: 'secret-key',
      source: 'env' as const,
    };

    await syncOdooQuotations({
      db: mgr.db,
      odoo: odooCreds,
      settings: mgr.getSettings(),
      trackedItems: listTrackedItems(mgr.db),
      channels: listPickupChannels(mgr.db),
      fetchFn: mockFetch,
    });

    const before = listAllOrders(mgr.db);
    expect(before).toHaveLength(2);
    const nov29Order = before.find((o) => o.odooQuotationId === 1744)!;
    const nov28Order = before.find((o) => o.odooQuotationId === 1745)!;
    expect(nov29Order.slottedDate).toBe('2026-11-29');
    expect(nov28Order.slottedDate).toBe('2026-11-28');

    const app = createExpressApp({
      dbManager: mgr,
      config: {
        port: 0,
        dbPath: mgr.dbPath,
        backupDir: mgr.backupDir,
        timezone: 'America/New_York',
        haOptionsPath: '/nonexistent/options.json',
        odoo: odooCreds,
      },
      fetchFn: mockFetch,
    });
    const server = await new Promise<import('http').Server>((resolve) => {
      const s = app.listen(0, '127.0.0.1', () => resolve(s));
    });
    const port = (server.address() as import('net').AddressInfo).port;
    const baseUrl = `http://127.0.0.1:${port}`;

    try {
      // Open Nov 29 order as target, absorb Nov 28 order, and explicitly choose to move onto 2026-11-28!
      const mergeRes = await fetch(`${baseUrl}/api/orders/${nov29Order.id}/merge`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          sourceOrderId: nov28Order.id,
          itemStrategy: 'keep_target',
          keepDate: '2026-11-28',
        }),
      });
      expect(mergeRes.status).toBe(200);

      const afterMerge = listAllOrders(mgr.db);
      expect(afterMerge).toHaveLength(1);
      expect(afterMerge[0].slottedDate).toBe('2026-11-28');
      expect(afterMerge[0].status).toBe('confirmed');
      expect(afterMerge[0].mergedOdooNames).toEqual(['S00768']);
      expect(afterMerge[0].items).toEqual([
        expect.objectContaining({ trackedItemId: stdId, quantity: 3 }),
      ]);
      // Confirm 2026-11-29 now has 0 orders!
      expect(afterMerge.filter((o) => o.slottedDate === '2026-11-29')).toHaveLength(0);

      // Re-run Odoo sync returning BOTH S00767 (Nov 29 in Odoo) and S00768 (Nov 28 in Odoo)
      // Must import 0 duplicates and keep the single merged order on 2026-11-28!
      const resync = await syncOdooQuotations({
        db: mgr.db,
        odoo: odooCreds,
        settings: mgr.getSettings(),
        trackedItems: listTrackedItems(mgr.db),
        channels: listPickupChannels(mgr.db),
        fetchFn: mockFetch,
      });
      expect(resync.syncLog.importedCount).toBe(0);
      const afterResync = listAllOrders(mgr.db);
      expect(afterResync).toHaveLength(1);
      expect(afterResync[0].slottedDate).toBe('2026-11-28');

      // Undo and test merging onto 2026-11-29 instead
      const undoRes = await fetch(`${baseUrl}/api/checkpoints/undo`, { method: 'POST' });
      expect(undoRes.status).toBe(200);
      expect(listAllOrders(mgr.db)).toHaveLength(2);

      const mergeKeep29 = await fetch(`${baseUrl}/api/orders/${nov29Order.id}/merge`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          sourceOrderId: nov28Order.id,
          itemStrategy: 'keep_target',
          keepDate: '2026-11-29',
        }),
      });
      expect(mergeKeep29.status).toBe(200);
      const afterKeep29 = listAllOrders(mgr.db);
      expect(afterKeep29).toHaveLength(1);
      expect(afterKeep29[0].slottedDate).toBe('2026-11-29');
      expect(afterKeep29.filter((o) => o.slottedDate === '2026-11-28')).toHaveLength(0);
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
      mgr.close();
    }
  });

  it('normalizes Odoo URLs by stripping /odoo, /web, and /json/2 suffixes while preserving reverse-proxy paths', () => {
    expect(normalizeOdooBaseUrl('https://botlfarm.odoo.com/')).toBe('https://botlfarm.odoo.com');
    expect(normalizeOdooBaseUrl('https://botlfarm.odoo.com/odoo')).toBe('https://botlfarm.odoo.com');
    expect(normalizeOdooBaseUrl('https://botlfarm.odoo.com/odoo/sales/42?debug=1')).toBe(
      'https://botlfarm.odoo.com'
    );
    expect(normalizeOdooBaseUrl('https://botlfarm.odoo.com/web#action=123')).toBe(
      'https://botlfarm.odoo.com'
    );
    expect(normalizeOdooBaseUrl('https://botlfarm.odoo.com/json/2/')).toBe(
      'https://botlfarm.odoo.com'
    );
    expect(normalizeOdooBaseUrl('https://botlfarm.odoo.com/json/2/sale.order/search_read')).toBe(
      'https://botlfarm.odoo.com'
    );
    expect(normalizeOdooBaseUrl('https://farm.example.com/erp/odoo/sales')).toBe(
      'https://farm.example.com/erp'
    );
    expect(normalizeOdooBaseUrl('ftp://botlfarm.odoo.com')).toBe('');
  });

  it('follows HTTP 301/302 redirects while preserving POST, headers, and JSON body and blocks unsafe redirects', async () => {
    const calls: Array<{ url: string; method?: string; redirect?: RequestRedirect; auth?: string; body?: string }> = [];

    // 1. HTTP -> HTTPS (301) followed by apex -> www (302) must preserve POST + Bearer + body
    const redirectFetch: FetchLike = async (url, init) => {
      const headers = (init?.headers ?? {}) as Record<string, string>;
      calls.push({
        url,
        method: init?.method,
        redirect: init?.redirect,
        auth: headers.Authorization,
        body: typeof init?.body === 'string' ? init.body : undefined,
      });

      if (url === 'http://farm.example.com/json/2/sale.order/search_read') {
        return new Response(null, {
          status: 301,
          headers: { location: 'https://farm.example.com/json/2/sale.order/search_read' },
        });
      }
      if (url === 'https://farm.example.com/json/2/sale.order/search_read') {
        return new Response(null, {
          status: 302,
          headers: { location: 'https://www.farm.example.com/json/2/sale.order/search_read' },
        });
      }
      return new Response(JSON.stringify([{ id: 42 }]), { status: 200 });
    };

    const rows = await callOdooJson2<Array<{ id: number }>>({
      odoo: {
        url: 'http://farm.example.com/odoo/sales',
        db: 'botl_prod',
        apiKey: 'super-secret-api-key',
        source: 'ha_options',
      },
      model: 'sale.order',
      method: 'search_read',
      payload: { domain: [], fields: ['id'], limit: 1 },
      fetchFn: redirectFetch,
    });

    expect(rows).toEqual([{ id: 42 }]);
    expect(calls).toHaveLength(3);
    expect(calls.map((c) => c.url)).toEqual([
      'http://farm.example.com/json/2/sale.order/search_read',
      'https://farm.example.com/json/2/sale.order/search_read',
      'https://www.farm.example.com/json/2/sale.order/search_read',
    ]);
    for (const c of calls) {
      expect(c.method).toBe('POST');
      expect(c.redirect).toBe('manual');
      expect(c.auth).toBe('bearer super-secret-api-key');
      expect(c.body).toContain('"fields":["id"]');
    }

    // 2. HTTPS -> HTTP downgrade must be rejected without leaking API key
    await expect(
      callOdooJson2({
        odoo: {
          url: 'https://farm.example.com',
          db: 'botl_prod',
          apiKey: 'super-secret-api-key',
          source: 'ha_options',
        },
        model: 'sale.order',
        method: 'search_read',
        payload: { domain: [] },
        fetchFn: async () =>
          new Response(null, {
            status: 301,
            headers: { location: 'http://farm.example.com/json/2/sale.order/search_read' },
          }),
      })
    ).rejects.toThrow(/Refused insecure redirect from HTTPS to HTTP/);

    // 3. Cross-host redirect must be rejected with helpful origin message and never expose the API key
    let crossHostErr = '';
    try {
      await callOdooJson2({
        odoo: {
          url: 'https://custom.farm.example',
          db: 'botl_prod',
          apiKey: 'super-secret-api-key',
          source: 'ha_options',
        },
        model: 'sale.order',
        method: 'search_read',
        payload: { domain: [] },
        fetchFn: async () =>
          new Response(null, {
            status: 301,
            headers: { location: 'https://botlfarm.odoo.com/json/2/sale.order/search_read' },
          }),
      });
    } catch (err) {
      crossHostErr = err instanceof Error ? err.message : String(err);
    }
    expect(crossHostErr).toContain('https://botlfarm.odoo.com');
    expect(crossHostErr).not.toContain('super-secret-api-key');

    // 4. Redirect off /json/2/ (e.g. /web/login or database selector) must give a clear error
    await expect(
      callOdooJson2({
        odoo: {
          url: 'https://botlfarm.odoo.com',
          db: 'wrong_db',
          apiKey: 'super-secret-api-key',
          source: 'ha_options',
        },
        model: 'sale.order',
        method: 'search_read',
        payload: { domain: [] },
        fetchFn: async () =>
          new Response(null, {
            status: 303,
            headers: { location: '/web/database/selector' },
          }),
      })
    ).rejects.toThrow(/Redirected to https:\/\/botlfarm\.odoo\.com\/web\/database\/selector/);
  });

  it('syncs active Odoo res.partner customers read-only (excluding mobile) and serves deduplicated autocomplete via /api/customers', async () => {
    const mgr = createTempDb();
    await mgr.init('America/New_York');
    const now = new Date().toISOString();

    // Seed a local manual order customer to test merging Odoo + local history
    mgr.db
      .prepare(
        `INSERT INTO orders (
           source, status, timing_type, customer_name, customer_name_overridden,
           customer_email, customer_phone, created_at, updated_at
         ) VALUES ('manual', 'waitlist', 'asap', 'Local Laura', 0, 'laura@local.test', '555-7777', ?, ?)`
      )
      .run(now, now);

    const partnerCalls: Array<{ url: string; fields?: unknown }> = [];
    const mockFetch: FetchLike = async (url, init) => {
      const body = JSON.parse(String(init?.body || '{}')) as { fields?: unknown };
      if (url.endsWith('/json/2/res.partner/search_read')) {
        partnerCalls.push({ url, fields: body.fields });
        return new Response(
          JSON.stringify([
            { id: 1001, name: 'Elena Vance', email: 'elena@farm.test', phone: '555-1001' },
            { id: 1002, name: 'Eliot Green', email: false, phone: '555-1002' },
            { id: 1003, name: '   ', email: 'blank@skip.test', phone: false },
          ]),
          { status: 200 }
        );
      }
      return new Response('[]', { status: 200 });
    };

    const odooCreds = {
      url: 'https://demo.odoo.example',
      db: 'farm_db',
      apiKey: 'secret-key',
      source: 'env' as const,
    };

    const directSync = await syncOdooCustomers({
      db: mgr.db,
      odoo: odooCreds,
      fetchFn: mockFetch,
    });
    expect(directSync).toEqual({ fetchedCount: 3, syncedCount: 2 });
    expect(partnerCalls).toHaveLength(1);
    expect(partnerCalls[0].fields).toEqual(['id', 'name', 'email', 'phone']);
    expect(partnerCalls[0].fields).not.toContain('mobile');

    const app = createExpressApp({
      dbManager: mgr,
      config: {
        port: 0,
        dbPath: mgr.dbPath,
        backupDir: mgr.backupDir,
        timezone: 'America/New_York',
        haOptionsPath: '/nonexistent/options.json',
        odoo: odooCreds,
      },
      fetchFn: mockFetch,
    });
    const server = await new Promise<import('http').Server>((resolve) => {
      const s = app.listen(0, '127.0.0.1', () => resolve(s));
    });
    const port = (server.address() as import('net').AddressInfo).port;
    const baseUrl = `http://127.0.0.1:${port}`;

    try {
      const syncRes = await fetch(`${baseUrl}/api/odoo/customers/sync`, { method: 'POST' });
      expect(syncRes.status).toBe(200);
      const syncBody = (await syncRes.json()) as { syncedCount: number; odooCustomersCount: number };
      expect(syncBody.syncedCount).toBe(2);
      expect(syncBody.odooCustomersCount).toBe(2);

      // Search "el" -> returns both Elena Vance & Eliot Green from Odoo
      const searchEl = await fetch(`${baseUrl}/api/customers?q=el`);
      expect(searchEl.status).toBe(200);
      const elBody = (await searchEl.json()) as {
        customers: Array<{ name: string; email: string | null; phone: string | null; source: string }>;
        odooCustomersCount: number;
        odooConfigured: boolean;
      };
      expect(elBody.odooConfigured).toBe(true);
      expect(elBody.odooCustomersCount).toBe(2);
      expect(elBody.customers.map((c) => c.name)).toEqual(['Elena Vance', 'Eliot Green']);
      expect(elBody.customers[0]).toMatchObject({
        email: 'elena@farm.test',
        phone: '555-1001',
        source: 'odoo',
      });
      expect(elBody.customers[1]).toMatchObject({
        email: null,
        phone: '555-1002',
        source: 'odoo',
      });

      // Empty query includes both Odoo contacts and Local Laura
      const allRes = await fetch(`${baseUrl}/api/customers`);
      const allBody = (await allRes.json()) as {
        customers: Array<{ name: string; source: string }>;
      };
      expect(allBody.customers.map((c) => c.name)).toEqual([
        'Elena Vance',
        'Eliot Green',
        'Local Laura',
      ]);
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
      mgr.close();
    }
  });

  it('auto-discovers Odoo "Requested Pickup" quotation field read-only, parses free-text fallback, and supports manual requestedDate CRUD', async () => {
    const mgr = createTempDb();
    await mgr.init('America/New_York');
    const now = new Date().toISOString();

    const stdId = Number(
      mgr.db
        .prepare(
          `INSERT INTO tracked_items (name, unit_label, is_active, supply_mode, default_daily_production, global_safety_buffer, include_in_public_snippet, keyword_rules_json, sort_order, created_at, updated_at)
           VALUES ('Standard Eggs', 'dozens', 1, 'continuous', 20, 4, 1, '["standard","eggs"]', 0, ?, ?)`
        )
        .run(now, now).lastInsertRowid
    );

    const saleOrderFieldsRequested: string[][] = [];

    const mockFetch: FetchLike = async (url, init) => {
      const body = JSON.parse(String(init?.body || '{}')) as { fields?: string[] };

      if (url.endsWith('/json/2/ir.model.fields/search_read')) {
        return new Response(
          JSON.stringify([
            {
              name: 'x_studio_requested_pickup',
              field_description: 'Requested Pickup',
              ttype: 'date',
            },
          ]),
          { status: 200 }
        );
      }

      if (url.endsWith('/json/2/sale.order/search_read')) {
        if (Array.isArray(body.fields)) {
          saleOrderFieldsRequested.push(body.fields);
        }
        return new Response(
          JSON.stringify([
            {
              id: 2101,
              name: 'S02101',
              state: 'draft',
              create_date: '2026-11-24 14:00:00',
              date_order: '2026-11-24 14:00:00',
              commitment_date: false,
              x_studio_requested_pickup: '2026-11-28',
              partner_id: [1201, 'Clara Woods'],
              note: false,
              order_line: [3101],
            },
            {
              id: 2102,
              name: 'S02102',
              state: 'draft',
              create_date: '2026-11-24 15:00:00',
              date_order: '2026-11-24 15:00:00',
              commitment_date: false,
              x_studio_requested_pickup: false,
              partner_id: [1202, 'Devon Brooks'],
              note: '<p>Requested Pickup: 11/30/2026</p>',
              order_line: [3102],
            },
          ]),
          { status: 200 }
        );
      }

      if (url.endsWith('/json/2/sale.order.line/search_read')) {
        return new Response(
          JSON.stringify([
            { id: 3101, order_id: [2101, 'S02101'], name: 'Standard Eggs', product_uom_qty: 2 },
            { id: 3102, order_id: [2102, 'S02102'], name: 'Standard Eggs', product_uom_qty: 3 },
          ]),
          { status: 200 }
        );
      }

      if (url.endsWith('/json/2/res.partner/search_read')) {
        return new Response(
          JSON.stringify([
            { id: 1201, name: 'Clara Woods', email: 'clara@farm.test', phone: '555-3101' },
            { id: 1202, name: 'Devon Brooks', email: 'devon@farm.test', phone: '555-3102' },
          ]),
          { status: 200 }
        );
      }

      return new Response('[]', { status: 200 });
    };

    const odooCreds = {
      url: 'https://demo.odoo.example',
      db: 'farm_db',
      apiKey: 'secret-key',
      source: 'env' as const,
    };

    await syncOdooQuotations({
      db: mgr.db,
      odoo: odooCreds,
      settings: mgr.getSettings(),
      trackedItems: listTrackedItems(mgr.db),
      channels: listPickupChannels(mgr.db),
      fetchFn: mockFetch,
    });

    // Discovered custom Odoo field must have been requested on sale.order/search_read
    expect(saleOrderFieldsRequested[0]).toContain('x_studio_requested_pickup');

    const orders = listAllOrders(mgr.db);
    const clara = orders.find((o) => o.odooQuotationId === 2101)!;
    const devon = orders.find((o) => o.odooQuotationId === 2102)!;

    // Draft quotations stay on the Waitlist (unslotted) while preserving customer Requested Pickup Date!
    expect(clara.status).toBe('waitlist');
    expect(clara.slottedDate).toBeNull();
    expect(clara.requestedDate).toBe('2026-11-28');

    expect(devon.status).toBe('waitlist');
    expect(devon.slottedDate).toBeNull();
    expect(devon.requestedDate).toBe('2026-11-30');

    // Verify manual POST /api/orders (Waitlist with requestedDate) and PUT /api/orders/:id update/clear
    const app = createExpressApp({
      dbManager: mgr,
      config: {
        port: 0,
        dbPath: mgr.dbPath,
        backupDir: mgr.backupDir,
        timezone: 'America/New_York',
        haOptionsPath: '/nonexistent/options.json',
        odoo: odooCreds,
      },
      fetchFn: mockFetch,
    });
    const server = await new Promise<import('http').Server>((resolve) => {
      const s = app.listen(0, '127.0.0.1', () => resolve(s));
    });
    const port = (server.address() as import('net').AddressInfo).port;
    const baseUrl = `http://127.0.0.1:${port}`;

    try {
      const createRes = await fetch(`${baseUrl}/api/orders`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          customerName: 'Waitlist With Target',
          timingType: 'asap',
          requestedDate: '2026-12-03',
          items: [{ trackedItemId: stdId, quantity: 2 }],
        }),
      });
      expect(createRes.status).toBe(201);
      const created = (await createRes.json()) as {
        id: number;
        status: string;
        slottedDate: string | null;
        requestedDate: string | null;
      };
      expect(created.status).toBe('waitlist');
      expect(created.slottedDate).toBeNull();
      expect(created.requestedDate).toBe('2026-12-03');

      const updateRes = await fetch(`${baseUrl}/api/orders/${created.id}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ requestedDate: '2026-12-05' }),
      });
      expect(updateRes.status).toBe(200);
      const updated = (await updateRes.json()) as { requestedDate: string | null };
      expect(updated.requestedDate).toBe('2026-12-05');

      const clearRes = await fetch(`${baseUrl}/api/orders/${created.id}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ requestedDate: null }),
      });
      expect(clearRes.status).toBe(200);
      const cleared = (await clearRes.json()) as { requestedDate: string | null };
      expect(cleared.requestedDate).toBeNull();
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
      mgr.close();
    }
  });
});
