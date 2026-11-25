import { expect, test } from '@playwright/test';
import express from 'express';
import fs from 'fs';
import http from 'http';
import os from 'os';
import path from 'path';
import { createApiRouter } from '../../src/server/app';
import { loadRuntimeConfig } from '../../src/server/config';
import { DatabaseManager } from '../../src/server/db';
import type { FetchLike } from '../../src/server/odooService';

const INGRESS_PREFIX = '/api/hassio_ingress/test';

test.describe('Home Assistant Ingress E2E Smoke Suite', () => {
  let server: http.Server;
  let dbManager: DatabaseManager;
  let tmpDir: string;
  let baseUrl: string;

  test.beforeAll(async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'farm-waitlist-e2e-'));
    const dbPath = path.join(tmpDir, 'waitlist.db');
    const backupDir = path.join(tmpDir, 'backups');

    dbManager = new DatabaseManager(dbPath, backupDir);
    await dbManager.init('America/New_York');

    const config = loadRuntimeConfig({
      dbPath,
      backupDir,
      timezone: 'America/New_York',
      odoo: {
        url: 'https://mock-odoo.local',
        db: 'test_farm',
        apiKey: 'mock-key',
        source: 'env',
      },
    });

    // Mock Odoo /json/2/ endpoint so E2E verifies full chatter drawer flow too
    const mockOdooFetch: FetchLike = async (url) => {
      if (url.endsWith('/json/2/sale.order/search_read')) {
        return new Response(
          JSON.stringify([
            {
              id: 801,
              name: 'S00801',
              state: 'draft',
              create_date: '2026-11-23 15:00:00',
              partner_id: [10, 'E2E Odoo Customer'],
              note: '<p>2 Standard Eggs ASAP</p>',
              order_line: [],
            },
          ]),
          { status: 200 }
        );
      }
      if (url.endsWith('/json/2/res.partner/search_read')) {
        return new Response(
          JSON.stringify([{ id: 10, name: 'E2E Odoo Customer', email: 'e2e@farm.test', phone: '555-7777' }]),
          { status: 200 }
        );
      }
      if (url.endsWith('/json/2/mail.message/search_read')) {
        return new Response(
          JSON.stringify([
            {
              id: 5001,
              res_id: 801,
              author_id: [10, 'E2E Odoo Customer'],
              message_type: 'comment',
              subtype_id: [1, 'Discussions'],
              body: '<p>Hello from Odoo Chatter E2E!</p>',
              date: '2026-11-23 15:05:00',
            },
          ]),
          { status: 200 }
        );
      }
      return new Response('[]', { status: 200 });
    };

    const app = express();
    app.use(express.json({ limit: '5mb' }));

    const distDir = path.resolve(process.cwd(), 'dist');
    const ingressRouter = express.Router();
    ingressRouter.use(
      '/api',
      createApiRouter({
        dbManager,
        config,
        fetchFn: mockOdooFetch,
        getNow: () => new Date('2026-11-23T16:00:00Z'), // Mon Nov 23, 2026 11:00 AM ET
      })
    );
    ingressRouter.use(express.static(distDir));
    ingressRouter.get('*', (_req, res) => {
      res.sendFile(path.join(distDir, 'index.html'));
    });

    // Mount exclusively under simulated HA Ingress subpath (root '/' intentionally 404s!)
    app.use(INGRESS_PREFIX, ingressRouter);

    await new Promise<void>((resolve) => {
      server = app.listen(0, '127.0.0.1', () => {
        const addr = server.address() as { port: number };
        baseUrl = `http://127.0.0.1:${addr.port}${INGRESS_PREFIX}/`;
        resolve();
      });
    });
  });

  test.afterAll(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    dbManager.close();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  test('renders dark theme under HA Ingress subpath, schedules orders, inspects Odoo chatter, generates snippet, and completes backup/restore', async ({
    page,
  }) => {
    const failedResponses: string[] = [];
    page.on('response', (res) => {
      if (res.status() >= 400) {
        failedResponses.push(`${res.status()} ${res.url()}`);
      }
    });

    await page.goto(baseUrl, { waitUntil: 'networkidle' });

    // Verify dark theme background (#0F1419 => rgb(15, 20, 25))
    const bgColor = await page.evaluate(() => getComputedStyle(document.body).backgroundColor);
    expect(bgColor).toBe('rgb(15, 20, 25)');

    // 1. Blank-slate first run -> Open Settings
    await expect(page.getByTestId('blank-slate-onboarding')).toBeVisible();
    await page.getByTestId('blank-slate-open-settings-btn').click();

    // 2. Add Tracked Item ("Standard Eggs") & Pickup Channel ("Farm Store")
    await page.getByTestId('settings-item-name-input').fill('Standard Eggs');
    await page.getByTestId('settings-item-keywords-input').fill('standard');
    await page.getByTestId('settings-add-item-btn').click();
    await expect(page.getByText('Standard Eggs')).toBeVisible();

    await page.getByTestId('settings-tab-channels').click();
    await page.getByTestId('settings-channel-name-input').fill('Farm Store');
    await page.getByTestId('settings-add-channel-btn').click();
    await expect(page.getByText('Farm Store')).toBeVisible();

    // 3. Navigate to Calendar -> Verify Mon-Sun running grid & Focused Item + All toggle
    await page.getByTestId('nav-calendar').click();
    await expect(page.getByTestId('calendar-grid')).toBeVisible();
    await expect(page.getByTestId('day-metrics-2026-11-23')).toBeVisible();
    await page.getByTestId('focus-item-all').click();
    await expect(page.getByTestId('day-all-metrics-2026-11-23')).toBeVisible();
    await page.getByTestId('focus-item-1').click();

    // 4. Quick Add manual ASAP order & drag onto Tuesday 2026-11-24
    await page.getByTestId('quick-add-order-btn').click();
    await page.getByTestId('quick-add-customer-input').fill('Manual Morgan');
    await page.getByTestId('quick-add-submit-btn').click();

    const queueCard = page.locator('[data-testid^="queue-order-"]').first();
    await expect(queueCard).toContainText('Manual Morgan');
    await queueCard.dragTo(page.getByTestId('calendar-day-2026-11-24'));
    await expect(page.getByTestId('calendar-day-2026-11-24')).toContainText('Manual Morgan');

    // 5. Sync from mock Odoo -> Inspect Chatter -> Pre-Approve copy modal
    await page.getByTestId('sync-now-btn').click();
    const odooQueueItem = page.locator('[data-testid^="queue-order-"]', {
      hasText: 'E2E Odoo Customer',
    });
    await expect(odooQueueItem).toBeVisible();
    await odooQueueItem.click();
    await expect(page.getByTestId('order-detail-drawer')).toBeVisible();
    await expect(page.getByTestId('chatter-msg-5001')).toContainText('Hello from Odoo Chatter E2E!');

    await page.getByTestId('order-pre-approve-btn').click();
    await expect(page.getByTestId('pre-approval-modal')).toBeVisible();
    await expect(page.getByTestId('pre-approval-message-textarea')).toContainText(
      'E2E Odoo Customer'
    );
    await page.getByTestId('copy-pre-approval-btn').click();
    await page.getByTestId('close-pre-approval-modal-btn').click();
    await page.getByTestId('close-order-drawer-btn').click();

    // 6. Public Availability Snippet Preview & Raw HTML (Calendar View)
    await page.getByTestId('nav-snippet').click();
    await expect(page.getByTestId('snippet-live-preview')).toBeVisible();
    await expect(page.getByTestId('snippet-calendar-grid')).toBeVisible();
    await expect(page.getByTestId('snippet-timestamp')).toContainText('Availability accurate as of');
    await page.getByTestId('toggle-raw-html-btn').click();
    const rawHtml = await page.getByTestId('snippet-raw-html-textarea').inputValue();
    expect(rawHtml).toContain('Standard Eggs');
    expect(rawHtml).toContain('fw-cal-grid');
    expect(rawHtml).not.toContain('Manual Morgan');

    // 7. Backup & Restore Round-Trip
    await page.getByTestId('nav-settings').click();
    await page.getByTestId('settings-tab-backups').click();
    await page.getByTestId('create-backup-now-btn').click();
    const backupRow = page.locator('[data-testid^="backup-row-manual-"]').first();
    await expect(backupRow).toBeVisible();

    // Add a temporary item after snapshot, then restore snapshot and confirm temp item disappears
    await page.getByTestId('settings-tab-items').click();
    await page.getByTestId('settings-item-name-input').fill('Temporary Test Squash');
    await page.getByTestId('settings-add-item-btn').click();
    await expect(page.getByText('Temporary Test Squash')).toBeVisible();

    await page.getByTestId('settings-tab-backups').click();
    await page.locator('[data-testid^="backup-restore-manual-"]').first().click();
    await page.locator('[data-testid^="backup-confirm-restore-manual-"]').first().click();

    await page.getByTestId('settings-tab-items').click();
    await expect(page.getByText('Standard Eggs')).toBeVisible();
    await expect(page.getByText('Temporary Test Squash')).toHaveCount(0);

    // Zero broken relative assets or 404/500 responses under HA Ingress subpath
    expect(failedResponses).toEqual([]);
  });

  test('renders cleanly on mobile (390x844) with zero overlapping menus, slide-over waitlist queue, and next-day harvest display', async ({
    browser,
  }) => {
    const context = await browser.newContext({ viewport: { width: 390, height: 844 } });
    const page = await context.newPage();

    await page.goto(baseUrl, { waitUntil: 'networkidle' });

    // Calendar should be directly visible without waitlist queue covering or squishing it
    await expect(page.getByTestId('calendar-grid')).toBeVisible();
    await expect(page.getByTestId('unslotted-queue-sidebar')).toHaveCount(0);

    // Verify no horizontal document overflow on mobile
    const overflow = await page.evaluate(
      () => document.documentElement.scrollWidth - window.innerWidth
    );
    expect(overflow).toBeLessThanOrEqual(1);

    // Verify On Hand, Can Sell (ATP), and next-day harvest metrics are shown clearly on day cards
    const mondayMetrics = page.getByTestId('day-metrics-2026-11-23');
    await expect(mondayMetrics).toContainText('On Hand');
    await expect(mondayMetrics).toContainText('Can Sell');
    await expect(mondayMetrics).toContainText('Harv→');

    // Open mobile Waitlist slide-over cleanly and close it
    await page.getByTestId('toggle-queue-btn').click();
    await expect(page.getByTestId('unslotted-queue-sidebar')).toBeVisible();
    await page.getByTestId('close-mobile-queue-btn').click();
    await expect(page.getByTestId('unslotted-queue-sidebar')).toHaveCount(0);

    // Quick Add a mobile waitlist order, open it from Waitlist Queue, see availability & 1-tap Schedule First Available
    await page.getByTestId('quick-add-order-btn').click();
    await page.getByTestId('quick-add-customer-input').fill('Mobile Molly');
    await page.getByTestId('quick-add-submit-btn').click();

    await page.getByTestId('toggle-queue-btn').click();
    const mobileWaitlistCard = page.locator('[data-testid^="queue-order-"]', {
      hasText: 'Mobile Molly',
    });
    await expect(mobileWaitlistCard).toBeVisible();
    await expect(mobileWaitlistCard).toContainText('Earliest open:');
    await mobileWaitlistCard.click();

    await expect(page.getByTestId('order-scheduler-panel')).toBeVisible();
    await page.getByTestId('toggle-availability-picker-btn').click();
    await expect(page.getByTestId('slot-availability-list')).toBeVisible();
    // Monday starts at 0 stock (afternoon harvest rolls to Tuesday), so Monday is Short and Tuesday is First Available
    await expect(page.getByTestId('slot-candidate-2026-11-23')).toContainText('Short');
    await expect(page.getByTestId('slot-candidate-2026-11-24')).toContainText('Fits');
    await expect(page.getByTestId('schedule-first-available-btn')).toContainText('Nov 24');

    await page.getByTestId('schedule-first-available-btn').click();
    await expect(page.getByTestId('order-detail-drawer')).toHaveCount(0);
    await expect(page.getByTestId('calendar-day-2026-11-24')).toContainText('Mobile Molly');

    // Open mobile navigation menu, navigate to Settings, confirm drawer closes cleanly
    await page.getByTestId('mobile-nav-toggle').click();
    await expect(page.getByTestId('mobile-nav-drawer')).toBeVisible();
    await page.getByTestId('mobile-nav-settings').click();
    await expect(page.getByTestId('settings-view')).toBeVisible();
    await expect(page.getByTestId('mobile-nav-drawer')).toHaveCount(0);

    const settingsOverflow = await page.evaluate(
      () => document.documentElement.scrollWidth - window.innerWidth
    );
    expect(settingsOverflow).toBeLessThanOrEqual(1);

    await context.close();
  });
});
