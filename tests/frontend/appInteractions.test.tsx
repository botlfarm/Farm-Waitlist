// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import App from '../../src/App';
import type { PublicAvailabilityResult, WorkspacePayload } from '../../src/shared/types';

function makeBaseWorkspace(overrides?: Partial<WorkspacePayload>): WorkspacePayload {
  return {
    today: '2026-11-23',
    startDate: '2026-11-23',
    endDate: '2027-01-03',
    weeks: 6,
    settings: {
      timezone: 'America/New_York',
      odooSyncInterval: 'manual',
      odooSyncCutoffDate: '2026-11-01',
      odooIgnoredDateRanges: [],
      preApprovalTemplate:
        "Hey {{name}}, you're pre-approved for {{items_summary}} on {{date}} ({{channel}}).",
      holdThresholdHours: 48,
      backupScheduleEnabled: true,
      backupRetentionDays: 14,
      publicSnippetWeeks: 3,
    },
    odooStatus: {
      configured: true,
      source: 'env',
      urlHost: 'farm.odoo.com',
      database: 'farm_db',
    },
    lastSync: null,
    items: [
      {
        id: 1,
        name: 'Standard Eggs',
        unitLabel: 'dozens',
        isActive: true,
        supplyMode: 'continuous',
        defaultDailyProduction: 15,
        globalSafetyBuffer: 4,
        includeInPublicSnippet: true,
        keywordRules: ['standard'],
        sortOrder: 0,
        createdAt: '2026-11-23T00:00:00Z',
        updatedAt: '2026-11-23T00:00:00Z',
      },
      {
        id: 2,
        name: 'Pullet Eggs',
        unitLabel: 'dozens',
        isActive: true,
        supplyMode: 'continuous',
        defaultDailyProduction: 8,
        globalSafetyBuffer: 2,
        includeInPublicSnippet: true,
        keywordRules: ['pullet'],
        sortOrder: 1,
        createdAt: '2026-11-23T00:00:00Z',
        updatedAt: '2026-11-23T00:00:00Z',
      },
    ],
    channels: [
      {
        id: 1,
        name: 'Farm Store',
        allowedWeekdays: [1, 2, 3, 4, 5, 6, 7],
        colorToken: 'sky',
        isActive: true,
        sortOrder: 0,
      },
    ],
    days: [
      {
        date: '2026-11-23',
        isoWeekday: 1,
        isToday: true,
        isPast: false,
        byItem: {
          1: {
            trackedItemId: 1,
            date: '2026-11-23',
            startingBalance: 15,
            estProduced: 15,
            actualOnHand: 15,
            slottedQty: 2,
            endingBalance: 13,
            nextDayStarting: 28,
            effectiveBuffer: 4,
            extraBuffer: 0,
            hasBufferOverride: false,
            isCascadeAnchor: false,
            isManualProducedOverride: false,
            rawSellableOpen: 9,
            sellableOpen: 9,
            availablePhysical: 13,
            reservedForFuture: 0,
            constrainedByDate: null,
            tier: 'green',
            notes: null,
          },
          2: {
            trackedItemId: 2,
            date: '2026-11-23',
            startingBalance: 8,
            estProduced: 8,
            actualOnHand: 8,
            slottedQty: 0,
            endingBalance: 8,
            nextDayStarting: 16,
            effectiveBuffer: 2,
            extraBuffer: 0,
            hasBufferOverride: false,
            isCascadeAnchor: false,
            isManualProducedOverride: false,
            rawSellableOpen: 6,
            sellableOpen: 6,
            availablePhysical: 8,
            reservedForFuture: 0,
            constrainedByDate: null,
            tier: 'green',
            notes: null,
          },
        },
      },
      {
        date: '2026-11-24',
        isoWeekday: 2,
        isToday: false,
        isPast: false,
        byItem: {
          1: {
            trackedItemId: 1,
            date: '2026-11-24',
            startingBalance: 28,
            estProduced: 15,
            actualOnHand: null,
            slottedQty: 0,
            endingBalance: 28,
            nextDayStarting: 43,
            effectiveBuffer: 4,
            extraBuffer: 0,
            hasBufferOverride: false,
            isCascadeAnchor: false,
            isManualProducedOverride: false,
            rawSellableOpen: 24,
            sellableOpen: 24,
            availablePhysical: 28,
            reservedForFuture: 0,
            constrainedByDate: null,
            tier: 'green',
            notes: null,
          },
          2: {
            trackedItemId: 2,
            date: '2026-11-24',
            startingBalance: 16,
            estProduced: 8,
            actualOnHand: null,
            slottedQty: 0,
            endingBalance: 16,
            nextDayStarting: 24,
            effectiveBuffer: 2,
            extraBuffer: 0,
            hasBufferOverride: false,
            isCascadeAnchor: false,
            isManualProducedOverride: false,
            rawSellableOpen: 14,
            sellableOpen: 14,
            availablePhysical: 16,
            reservedForFuture: 0,
            constrainedByDate: null,
            tier: 'green',
            notes: null,
          },
        },
      },
    ],
    orders: [
      {
        id: 10,
        source: 'odoo',
        status: 'slotted',
        timingType: 'specific_date',
        requestedDate: '2026-11-23',
        slottedDate: '2026-11-23',
        isLocked: false,
        customerName: 'Clara Farmer',
        customerNameOverridden: false,
        customerEmail: 'clara@example.com',
        customerPhone: '555-0199',
        pickupChannelId: 1,
        freeTextPickup: null,
        notes: 'Please pack fresh',
        preApprovedAt: null,
        standingOrderId: null,
        standingOccurrenceDate: null,
        odooQuotationId: 500,
        odooQuotationName: 'S00500',
        odooPartnerId: 42,
        odooCreatedAtLocal: '2026-11-22 18:10:00',
        odooRawNotes: '2 dzn Standard Eggs',
        odooRawLines: ['2 × Standard Eggs'],
        odooUpdatedAfterSlot: false,
        odooMissingFlagged: false,
        odooSuggestedConfirmed: null,
        items: [{ trackedItemId: 1, quantity: 2 }],
        chatter: [
          {
            id: 1,
            orderId: 10,
            odooMessageId: 901,
            authorName: 'Clara Farmer',
            messageType: 'email',
            subtypeName: 'Discussions',
            bodyText: 'Can I grab these Monday afternoon?',
            createdAtUtc: '2026-11-22 23:10:00',
            createdAtLocal: '2026-11-22 18:10:00',
          },
        ],
        createdAt: '2026-11-22T23:10:00Z',
        updatedAt: '2026-11-22T23:10:00Z',
      },
      {
        id: 11,
        source: 'manual',
        status: 'waitlist',
        timingType: 'asap',
        requestedDate: null,
        slottedDate: null,
        isLocked: false,
        customerName: 'Waitlist Walt',
        customerNameOverridden: false,
        customerEmail: null,
        customerPhone: '555-0200',
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
        items: [{ trackedItemId: 1, quantity: 3 }],
        chatter: [],
        createdAt: '2026-11-23T12:00:00Z',
        updatedAt: '2026-11-23T12:00:00Z',
      },
    ],
    overdueOrders: [],
    reconciliationOrders: [],
    ignoredOrders: [],
    standingOrders: [],
    checkpoints: [
      { id: 1, label: 'Slot Clara Farmer -> 2026-11-23', isManual: false, createdAt: '2026-11-23T12:00:00Z' },
    ],
    ...overrides,
  };
}

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe('Farm Waitlist Frontend DOM & Interaction Tests', () => {
  it('shows blank-slate onboarding when 0 Tracked Items exist and navigates to Settings on click', async () => {
    const emptyWs = makeBaseWorkspace({ items: [], channels: [], orders: [] });
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: string) => {
        if (input.startsWith('./api/workspace')) {
          return new Response(JSON.stringify(emptyWs), { status: 200 });
        }
        return new Response(JSON.stringify([]), { status: 200 });
      })
    );

    const user = userEvent.setup();
    render(<App />);

    expect(await screen.findByTestId('blank-slate-onboarding')).toBeInTheDocument();
    await user.click(screen.getByTestId('blank-slate-open-settings-btn'));
    expect(await screen.findByTestId('settings-view')).toBeInTheDocument();
  });

  it('supports focused item vs All Items toggle, Day Drawer cascade forward, Order Drawer chatter + Pre-Approval copy, Drag-and-Drop slotting, and Undo', async () => {
    const ws = makeBaseWorkspace();
    const fetchCalls: Array<{ url: string; method: string; body?: string }> = [];

    const snippetPayload: PublicAvailabilityResult = {
      generatedAtDisplay: 'Nov 23, 2026, 10:00 AM EST',
      timezone: 'America/New_York',
      weeks: 3,
      days: [
        {
          date: '2026-11-23',
          displayDate: 'Nov 23',
          weekdayLabel: 'Mon',
          channelNames: ['Farm Store'],
          items: [
            {
              trackedItemId: 1,
              itemName: 'Standard Eggs',
              unitLabel: 'dozens',
              status: 'Available',
              approxAvailable: 9,
              approxLabel: 'Available (~9 dozens)',
            },
          ],
        },
      ],
      calendarDays: [
        {
          date: '2026-11-23',
          displayDate: 'Nov 23',
          weekdayLabel: 'Mon',
          isoWeekday: 1,
          isPast: false,
          isToday: true,
          channelNames: ['Farm Store'],
          items: [
            {
              trackedItemId: 1,
              itemName: 'Standard Eggs',
              unitLabel: 'dozens',
              status: 'Available',
              approxAvailable: 9,
              approxLabel: 'Available (~9 dozens)',
            },
          ],
        },
      ],
      html: '<section>Upcoming Pickup Availability</section>',
    };

    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: string, init?: RequestInit) => {
        const method = init?.method ?? 'GET';
        fetchCalls.push({ url: input, method, body: typeof init?.body === 'string' ? init.body : undefined });

        if (input.startsWith('./api/workspace')) {
          return new Response(JSON.stringify(ws), { status: 200 });
        }
        if (input.startsWith('./api/supply/')) {
          return new Response(JSON.stringify({ ok: true }), { status: 200 });
        }
        if (input === './api/orders/10/pre-approve') {
          return new Response(
            JSON.stringify({
              order: { ...ws.orders[0], status: 'pre_approved' },
              message: "Hey Clara Farmer, you're pre-approved for 2 dozens Standard Eggs on Mon, Nov 23, 2026 (Farm Store).",
            }),
            { status: 200 }
          );
        }
        if (input === './api/orders/11/slot') {
          return new Response(
            JSON.stringify({ ...ws.orders[1], status: 'slotted', slottedDate: '2026-11-24' }),
            { status: 200 }
          );
        }
        if (input === './api/checkpoints/undo') {
          return new Response(JSON.stringify({ restoredLabel: 'Slot Clara Farmer -> 2026-11-23' }), {
            status: 200,
          });
        }
        if (input.startsWith('./api/snippet')) {
          return new Response(JSON.stringify(snippetPayload), { status: 200 });
        }
        return new Response(JSON.stringify({ ok: true }), { status: 200 });
      })
    );

    const user = userEvent.setup();
    const writeText = vi.spyOn(navigator.clipboard, 'writeText').mockResolvedValue(undefined);
    render(<App />);

    // 1. Default Focused Item mode shows single-item breakdown on calendar cell
    expect(await screen.findByTestId('day-metrics-2026-11-23')).toBeInTheDocument();

    // Switch to All Items overview mode
    await user.click(screen.getByTestId('focus-item-all'));
    expect(screen.getByTestId('day-all-metrics-2026-11-23')).toBeInTheDocument();

    // Switch back to Standard Eggs
    await user.click(screen.getByTestId('focus-item-1'));
    expect(screen.getByTestId('day-metrics-2026-11-23')).toBeInTheDocument();

    // 2. Open Day Detail Drawer and Cascade Forward
    await user.click(screen.getByTestId('day-header-2026-11-23'));
    expect(await screen.findByTestId('day-detail-drawer')).toBeInTheDocument();
    const prodInput = screen.getByTestId('day-est-produced-input');
    await user.clear(prodInput);
    await user.type(prodInput, '18');
    await user.click(screen.getByTestId('day-cascade-forward-btn'));

    await waitFor(() => {
      const call = fetchCalls.find((c) => c.url === './api/supply/1/2026-11-23' && c.method === 'PUT');
      expect(call).toBeDefined();
      expect(JSON.parse(call!.body!)).toMatchObject({ estProduced: 18, cascadeForward: true });
    });

    // 3. Click Order Chip -> Inspect Odoo Chatter -> Click Pre-Approve -> Copy Message
    await user.click(screen.getByTestId('order-chip-10'));
    expect(await screen.findByTestId('order-detail-drawer')).toBeInTheDocument();
    expect(screen.getByTestId('chatter-msg-901')).toHaveTextContent(
      'Can I grab these Monday afternoon?'
    );

    await user.click(screen.getByTestId('order-pre-approve-btn'));
    expect(await screen.findByTestId('pre-approval-modal')).toBeInTheDocument();
    await user.click(screen.getByTestId('copy-pre-approval-btn'));
    expect(writeText).toHaveBeenCalledWith(
      expect.stringContaining("Hey Clara Farmer, you're pre-approved")
    );
    await user.click(screen.getByTestId('close-pre-approval-modal-btn'));
    await user.click(screen.getByTestId('close-order-drawer-btn'));

    // 4. Drag and Drop Waitlist Order 11 onto 2026-11-24
    const queueCard = screen.getByTestId('queue-order-11');
    const targetDay = screen.getByTestId('calendar-day-2026-11-24');
    const dataTransfer = {
      data: {} as Record<string, string>,
      setData(type: string, val: string) {
        this.data[type] = val;
      },
      getData(type: string) {
        return this.data[type] ?? '';
      },
      effectAllowed: 'move',
      dropEffect: 'move',
    };
    fireEvent.dragStart(queueCard, { dataTransfer });
    fireEvent.dragOver(targetDay, { dataTransfer });
    fireEvent.drop(targetDay, { dataTransfer });

    await waitFor(() => {
      const slotCall = fetchCalls.find((c) => c.url === './api/orders/11/slot');
      expect(slotCall).toBeDefined();
      expect(JSON.parse(slotCall!.body!)).toMatchObject({ date: '2026-11-24' });
    });

    // 5. Undo Last Action
    await user.click(screen.getByTestId('undo-action-btn'));
    await waitFor(() => {
      expect(fetchCalls.some((c) => c.url === './api/checkpoints/undo')).toBe(true);
    });

    // 6. Public Availability Snippet View + Copy HTML
    await user.click(screen.getByTestId('nav-snippet'));
    const preview = await screen.findByTestId('snippet-live-preview');
    expect(preview).toBeInTheDocument();
    expect(screen.getByTestId('snippet-calendar-grid')).toBeInTheDocument();
    expect(preview).toHaveTextContent('~9 dozens');
    await user.click(screen.getByTestId('copy-html-snippet-btn'));
    expect(writeText).toHaveBeenCalledWith('<section>Upcoming Pickup Availability</section>');
  });

  it('opens and closes the mobile navigation drawer and switches views cleanly', async () => {
    const ws = makeBaseWorkspace();
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: string) => {
        if (input.startsWith('./api/workspace')) {
          return new Response(JSON.stringify(ws), { status: 200 });
        }
        return new Response(JSON.stringify([]), { status: 200 });
      })
    );

    const user = userEvent.setup();
    render(<App />);

    expect(await screen.findByTestId('calendar-grid')).toBeInTheDocument();
    await user.click(screen.getByTestId('mobile-nav-toggle'));
    expect(screen.getByTestId('mobile-nav-drawer')).toBeInTheDocument();

    await user.click(screen.getByTestId('mobile-nav-settings'));
    expect(await screen.findByTestId('settings-view')).toBeInTheDocument();
    expect(screen.queryByTestId('mobile-nav-drawer')).not.toBeInTheDocument();
  });

  it('shows earliest-open hint on waitlist cards and schedules via 1-tap Schedule First Available inside OrderDetailDrawer', async () => {
    const ws = makeBaseWorkspace();
    // Make Day 1 have low open stock (1 open) so Waitlist Walt (3 dozens) fits first on Day 2 (24 open -> 21 left)
    ws.days[0].byItem[1].startingBalance = 7;
    ws.days[0].byItem[1].endingBalance = 5;
    ws.days[0].byItem[1].rawSellableOpen = 1;
    ws.days[0].byItem[1].sellableOpen = 1;
    ws.days[0].byItem[1].availablePhysical = 5;

    const slotCalls: Array<{ url: string; body: string }> = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: string, init?: RequestInit) => {
        if (input.startsWith('./api/workspace')) {
          return new Response(JSON.stringify(ws), { status: 200 });
        }
        if (input === './api/orders/11/slot') {
          slotCalls.push({ url: input, body: String(init?.body ?? '') });
          return new Response(
            JSON.stringify({ ...ws.orders[1], status: 'slotted', slottedDate: '2026-11-24' }),
            { status: 200 }
          );
        }
        return new Response(JSON.stringify({ ok: true }), { status: 200 });
      })
    );

    const user = userEvent.setup();
    render(<App />);

    // Waitlist card displays earliest open date hint (Tue, Nov 24)
    const earliestHint = await screen.findByTestId('queue-earliest-11');
    expect(earliestHint).toHaveTextContent('Nov 24');

    // Tap waitlist card -> OrderDetailDrawer opens with Schedule Pickup Slot panel
    await user.click(screen.getByTestId('queue-order-11'));
    expect(await screen.findByTestId('order-scheduler-panel')).toBeInTheDocument();

    // Day 1 shows Buffer (1 open -> -2 buffer), Day 2 shows Fits (24 open -> 21 left)
    expect(screen.getByTestId('slot-candidate-2026-11-23')).toHaveTextContent('Buffer');
    expect(screen.getByTestId('slot-candidate-2026-11-24')).toHaveTextContent('Fits');
    expect(screen.getByTestId('slot-candidate-2026-11-24')).toHaveTextContent('24 open → 21 left');

    // 1-tap Schedule First Available slots immediately onto 2026-11-24
    const firstBtn = screen.getByTestId('schedule-first-available-btn');
    expect(firstBtn).toHaveTextContent('Nov 24');
    await user.click(firstBtn);

    await waitFor(() => {
      expect(slotCalls).toHaveLength(1);
      expect(JSON.parse(slotCalls[0].body)).toMatchObject({ date: '2026-11-24', forceWeekday: false });
    });
  });

  it('ranks exact duplicate ahead of same-first-name customer and lets user pick a single date when merging orders on different dates', async () => {
    const ws = makeBaseWorkspace();
    ws.orders = [
      {
        ...ws.orders[0],
        id: 17,
        status: 'confirmed',
        slottedDate: '2026-11-23',
        customerName: 'Alex Kreopolides',
        customerEmail: 'other@example.com',
        odooQuotationId: 1700,
        odooQuotationName: 'S00700',
        odooPartnerId: 700,
      },
      {
        ...ws.orders[0],
        id: 9,
        status: 'confirmed',
        slottedDate: '2026-11-24',
        customerName: 'Alex Carpenter',
        customerEmail: 'alex.c@example.com',
        odooQuotationId: 1744,
        odooQuotationName: 'S00767',
        odooPartnerId: 910,
      },
      {
        ...ws.orders[0],
        id: 41,
        status: 'confirmed',
        slottedDate: '2026-11-23',
        customerName: 'Alex Carpenter',
        customerEmail: 'alex.c@example.com',
        odooQuotationId: 1745,
        odooQuotationName: 'S00768',
        odooPartnerId: 910,
      },
    ];

    const mergeCalls: Array<{ url: string; body: string }> = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: string, init?: RequestInit) => {
        if (input.startsWith('./api/workspace')) {
          return new Response(JSON.stringify(ws), { status: 200 });
        }
        if (input === './api/orders/9/merge') {
          mergeCalls.push({ url: input, body: String(init?.body ?? '') });
          return new Response(
            JSON.stringify({
              order: { ...ws.orders[1], slottedDate: '2026-11-23', mergedOdooNames: ['S00768'] },
              mergedOrderId: 41,
            }),
            { status: 200 }
          );
        }
        return new Response(JSON.stringify({ ok: true }), { status: 200 });
      })
    );

    const user = userEvent.setup();
    render(<App />);

    // Click Alex Carpenter's Nov 24 chip (id: 9)
    await user.click(await screen.findByTestId('order-chip-9'));
    const dupBanner = await screen.findByTestId('possible-duplicate-banner');
    // Must suggest Alex Carpenter (S00768), NOT Alex Kreopolides (S00700)!
    expect(dupBanner).toHaveTextContent('Alex Carpenter · S00768');
    expect(dupBanner).not.toHaveTextContent('Alex Kreopolides');

    // Open merge panel -> should display both date buttons for Nov 24 vs Nov 23
    await user.click(screen.getByTestId('open-merge-duplicate-btn'));
    expect(screen.getByTestId('merge-date-target')).toHaveTextContent('Keep Nov 24');
    expect(screen.getByTestId('merge-date-source')).toHaveTextContent('Move to Nov 23');

    // Pick Nov 23 as the single kept date and verify summary updates
    await user.click(screen.getByTestId('merge-date-source'));
    expect(screen.getByTestId('merge-result-summary')).toHaveTextContent('1 order on Nov 23');
    expect(screen.getByTestId('merge-result-summary')).toHaveTextContent('duplicate on Nov 24 will be removed');

    // Confirm merge -> sends keepDate: '2026-11-23' and closes drawer
    await user.click(screen.getByTestId('confirm-merge-orders-btn'));

    await waitFor(() => {
      expect(mergeCalls).toHaveLength(1);
      expect(JSON.parse(mergeCalls[0].body)).toEqual({
        sourceOrderId: 41,
        itemStrategy: 'keep_target',
        keepDate: '2026-11-23',
      });
    });

    await waitFor(() => {
      expect(screen.queryByTestId('order-detail-drawer')).not.toBeInTheDocument();
    });
  });

  it('flags future manual On-Hand overrides on the calendar and offers a 1-click reconnect button inside Today DayDetailDrawer', async () => {
    const ws = makeBaseWorkspace();
    // Simulate Tomorrow (2026-11-24) having a manual actualOnHand override of 11 that disconnects Today (2026-11-23)
    ws.days[1].byItem[1].actualOnHand = 11;
    ws.days[1].byItem[1].startingBalance = 11;

    const supplyCalls: Array<{ url: string; body: string }> = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: string, init?: RequestInit) => {
        if (input.startsWith('./api/workspace')) {
          return new Response(JSON.stringify(ws), { status: 200 });
        }
        if (input === './api/supply/1/2026-11-24') {
          supplyCalls.push({ url: input, body: String(init?.body ?? '') });
          return new Response(JSON.stringify({ ok: true }), { status: 200 });
        }
        return new Response(JSON.stringify({ ok: true }), { status: 200 });
      })
    );

    const user = userEvent.setup();
    render(<App />);

    // Calendar cell for Tomorrow (2026-11-24) visibly flags the future Override badge
    expect(await screen.findByTestId('day-future-override-2026-11-24')).toHaveTextContent('Override');

    // Clicking Today (2026-11-23) warns that Tomorrow has a manual override disconnecting Today
    await user.click(screen.getByTestId('day-header-2026-11-23'));
    const warning = await screen.findByTestId('day-next-override-warning');
    expect(warning).toHaveTextContent('Nov 24');
    expect(warning).toHaveTextContent('11 dozens');

    // 1-click reconnect clears actualOnHand on 2026-11-24
    await user.click(screen.getByTestId('clear-next-day-override-btn'));
    await waitFor(() => {
      expect(supplyCalls).toHaveLength(1);
      expect(JSON.parse(supplyCalls[0].body)).toMatchObject({ actualOnHand: null });
    });
  });

  it('allows backspacing egg quantities to empty and typing a new number without leaving a leading 0', async () => {
    const ws = makeBaseWorkspace();
    const updateCalls: Array<{ url: string; method: string; body: string }> = [];

    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: string, init?: RequestInit) => {
        const method = init?.method ?? 'GET';
        if (input.startsWith('./api/workspace')) {
          return new Response(JSON.stringify(ws), { status: 200 });
        }
        if (input === './api/orders' && method === 'POST') {
          updateCalls.push({ url: input, method, body: String(init?.body ?? '') });
          return new Response(JSON.stringify({ ...ws.orders[0], id: 99 }), { status: 201 });
        }
        if (input === './api/orders/10' && method === 'PUT') {
          updateCalls.push({ url: input, method, body: String(init?.body ?? '') });
          return new Response(JSON.stringify(ws.orders[0]), { status: 200 });
        }
        return new Response(JSON.stringify({ ok: true }), { status: 200 });
      })
    );

    const user = userEvent.setup();
    render(<App />);

    // 1. Test Quick Add Order modal quantity input
    await user.click(await screen.findByTestId('quick-add-order-btn'));
    const qaQty = await screen.findByTestId('quick-add-item-qty-0');
    expect(qaQty).toHaveValue('1');

    await user.click(qaQty);
    await user.keyboard('{Backspace}');
    expect(qaQty).toHaveValue('');

    await user.type(qaQty, '6');
    expect(qaQty).toHaveValue('6');

    await user.type(screen.getByTestId('quick-add-customer-input'), 'Hannah Eggbuyer');
    await user.click(screen.getByTestId('quick-add-submit-btn'));

    await waitFor(() => {
      const postCall = updateCalls.find((c) => c.url === './api/orders' && c.method === 'POST');
      expect(postCall).toBeDefined();
      expect(JSON.parse(postCall!.body).items).toEqual([{ trackedItemId: 1, quantity: 6 }]);
    });

    // 2. Test OrderDetailDrawer quantity input
    await user.click(screen.getByTestId('order-chip-10'));
    const drawerQty = await screen.findByTestId('order-item-qty-0');
    expect(drawerQty).toHaveValue('2');

    await user.click(drawerQty);
    await user.keyboard('{Backspace}');
    expect(drawerQty).toHaveValue('');

    await user.type(drawerQty, '4.5');
    expect(drawerQty).toHaveValue('4.5');

    await user.click(screen.getByTestId('order-save-btn'));
    await waitFor(() => {
      const putCall = updateCalls.find((c) => c.url === './api/orders/10' && c.method === 'PUT');
      expect(putCall).toBeDefined();
      expect(JSON.parse(putCall!.body).items).toEqual([{ trackedItemId: 1, quantity: 4.5 }]);
    });
  });

  it('supports switching between multiple pre-approval templates with clickable HTML link preview', async () => {
    const ws = makeBaseWorkspace();
    ws.settings.preApprovalTemplates = [
      {
        id: 'default-email',
        name: 'Default Email',
        format: 'html',
        body: 'Hi {{name}}, place your order for {{items_summary}} at <a href="https://botlfarm.com/shop">BOTL Farm Store</a> for {{date}}.',
        isDefault: true,
        channelIds: [],
        itemIds: [],
      },
      {
        id: 'text-sms',
        name: 'Text / SMS',
        format: 'plain',
        body: 'Hi {{name}}! Ready for {{date}} ({{channel}}): https://botlfarm.com/shop',
        isDefault: false,
        channelIds: [],
        itemIds: [],
      },
    ];

    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: string) => {
        if (input.startsWith('./api/workspace')) {
          return new Response(JSON.stringify(ws), { status: 200 });
        }
        if (input === './api/orders/10/pre-approve') {
          return new Response(
            JSON.stringify({
              order: { ...ws.orders[0], status: 'pre_approved' },
              message:
                'Hi Clara Farmer, place your order for 2 dozens Standard Eggs at <a href="https://botlfarm.com/shop">BOTL Farm Store</a> for Mon, Nov 23, 2026.',
              selectedTemplateId: 'default-email',
            }),
            { status: 200 }
          );
        }
        return new Response(JSON.stringify({ ok: true }), { status: 200 });
      })
    );

    const user = userEvent.setup();
    render(<App />);

    await user.click(await screen.findByTestId('order-chip-10'));
    await user.click(await screen.findByTestId('order-pre-approve-btn'));
    expect(await screen.findByTestId('pre-approval-modal')).toBeInTheDocument();

    // Live HTML link preview renders clickable <a> tag safely
    const preview = screen.getByTestId('pre-approval-preview');
    const link = preview.querySelector('a');
    expect(link).not.toBeNull();
    expect(link).toHaveAttribute('href', 'https://botlfarm.com/shop');
    expect(link).toHaveTextContent('BOTL Farm Store');
    expect(screen.getByTestId('copy-pre-approval-btn')).toHaveTextContent('Copy Email (with Links)');
    expect(screen.getByTestId('copy-pre-approval-plain-btn')).toBeInTheDocument();

    // Switch to Text / SMS template -> updates message for this order
    await user.click(screen.getByTestId('pre-approval-template-btn-text-sms'));
    expect(screen.getByTestId('pre-approval-message-textarea')).toHaveValue(
      'Hi Clara Farmer! Ready for Mon, Nov 23, 2026 (Farm Store): https://botlfarm.com/shop'
    );
    expect(screen.getByTestId('copy-pre-approval-btn')).toHaveTextContent('Copy Message');
  });

  it('displays the simple Order List view with dates, per-item quantities, totals, filters, and opens OrderDetailDrawer on row click', async () => {
    const ws = makeBaseWorkspace();
    ws.orders.push({
      ...ws.orders[0],
      id: 12,
      status: 'confirmed',
      slottedDate: '2026-11-24',
      customerName: 'Sam Pullet',
      odooQuotationId: null,
      odooQuotationName: null,
      items: [
        { trackedItemId: 1, quantity: 4 },
        { trackedItemId: 2, quantity: 3 },
      ],
    });

    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: string) => {
        if (input.startsWith('./api/workspace')) {
          return new Response(JSON.stringify(ws), { status: 200 });
        }
        return new Response(JSON.stringify({ ok: true }), { status: 200 });
      })
    );

    const user = userEvent.setup();
    render(<App />);

    await user.click(await screen.findByTestId('nav-orders'));
    expect(await screen.findByTestId('order-list-view')).toBeInTheDocument();

    // Summary totals across all 3 orders: Standard Eggs = 2 + 3 + 4 = 9 dozens, Pullet Eggs = 3 dozens
    expect(screen.getByTestId('order-list-total-item-1')).toHaveTextContent('9 dozens');
    expect(screen.getByTestId('order-list-total-item-2')).toHaveTextContent('3 dozens');

    // Table rows exist for all 3 orders
    expect(screen.getByTestId('order-list-row-10')).toHaveTextContent('Clara Farmer');
    expect(screen.getByTestId('order-list-row-11')).toHaveTextContent('Waitlist Walt');
    expect(screen.getByTestId('order-list-row-12')).toHaveTextContent('Sam Pullet');

    // Filter by Confirmed -> only Sam Pullet remains (4 Standard, 3 Pullet)
    await user.selectOptions(screen.getByTestId('order-list-status-filter'), 'confirmed');
    expect(screen.queryByTestId('order-list-row-10')).not.toBeInTheDocument();
    expect(screen.getByTestId('order-list-row-12')).toHaveTextContent('Sam Pullet');
    expect(screen.getByTestId('order-list-total-item-1')).toHaveTextContent('4 dozens');
    expect(screen.getByTestId('order-list-total-item-2')).toHaveTextContent('3 dozens');

    // Clicking a row opens the OrderDetailDrawer for that order
    await user.click(screen.getByTestId('order-list-row-12'));
    expect(await screen.findByTestId('order-detail-drawer')).toBeInTheDocument();
    expect(screen.getByTestId('order-customer-name-input')).toHaveValue('Sam Pullet');
  });

  it('allows editing header title, intro text, footer text, and auto-advance Today toggle on Availability Snippet', async () => {
    const ws = makeBaseWorkspace();
    const settingsSaves: Array<Record<string, unknown>> = [];
    let currentSnippetHtml = '<section class="fw-cal">Default HTML</section>';

    const buildSnippetResponse = (): PublicAvailabilityResult => ({
      generatedAtDisplay: 'Nov 23, 2026, 10:00 AM EST',
      timezone: 'America/New_York',
      weeks: 3,
      headerTitle: ws.settings.publicSnippetHeaderTitle || 'Upcoming Pickup Availability',
      headerText: ws.settings.publicSnippetHeaderText || '',
      footerText: ws.settings.publicSnippetFooterText ?? 'Default footer',
      autoAdvanceToday: ws.settings.publicSnippetAutoAdvanceToday ?? true,
      days: [
        {
          date: '2026-11-23',
          displayDate: 'Nov 23',
          weekdayLabel: 'Mon',
          channelNames: ['Farm Store'],
          items: [
            {
              trackedItemId: 1,
              itemName: 'Standard Eggs',
              unitLabel: 'dozens',
              status: 'Available',
              approxAvailable: 9,
              approxLabel: 'Available (~9 dozens)',
            },
          ],
        },
      ],
      calendarDays: [
        {
          date: '2026-11-23',
          displayDate: 'Nov 23',
          weekdayLabel: 'Mon',
          isoWeekday: 1,
          isPast: false,
          isToday: true,
          channelNames: ['Farm Store'],
          items: [
            {
              trackedItemId: 1,
              itemName: 'Standard Eggs',
              unitLabel: 'dozens',
              status: 'Available',
              approxAvailable: 9,
              approxLabel: 'Available (~9 dozens)',
            },
          ],
        },
      ],
      html: currentSnippetHtml,
    });

    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: string, init?: RequestInit) => {
        if (input.startsWith('./api/workspace')) {
          return new Response(JSON.stringify(ws), { status: 200 });
        }
        if (input === './api/settings' && init?.method === 'PUT') {
          const patch = JSON.parse(String(init.body ?? '{}')) as Record<string, unknown>;
          settingsSaves.push(patch);
          ws.settings = { ...ws.settings, ...patch };
          currentSnippetHtml = `<section class="fw-cal"><h3>${String(patch.publicSnippetHeaderTitle ?? '')}</h3><p>${String(patch.publicSnippetFooterText ?? '')}</p></section>`;
          return new Response(JSON.stringify({ settings: ws.settings, odooStatus: ws.odooStatus }), {
            status: 200,
          });
        }
        if (input.startsWith('./api/snippet')) {
          return new Response(JSON.stringify(buildSnippetResponse()), { status: 200 });
        }
        return new Response(JSON.stringify({ ok: true }), { status: 200 });
      })
    );

    const writeText = vi.spyOn(navigator.clipboard, 'writeText').mockResolvedValue(undefined);
    const user = userEvent.setup();
    render(<App />);

    await user.click(await screen.findByTestId('nav-snippet'));
    expect(await screen.findByTestId('snippet-customize-panel')).toBeInTheDocument();

    // Edit header title, header intro text (with store link), and footer text
    await user.type(screen.getByTestId('snippet-header-title-input'), 'BOTL Farm Eggs');
    await user.type(
      screen.getByTestId('snippet-header-text-input'),
      'Shop at https://botlfarm.com/shop'
    );
    const footerInput = screen.getByTestId('snippet-footer-text-input');
    await user.clear(footerInput);
    await user.type(footerInput, 'Updated farm pickup disclaimer.');

    // Live preview immediately reflects all custom header/footer text + clickable link
    expect(screen.getByTestId('snippet-preview-title')).toHaveTextContent('BOTL Farm Eggs');
    const introPreview = screen.getByTestId('snippet-preview-header-text');
    expect(introPreview.querySelector('a')).toHaveAttribute('href', 'https://botlfarm.com/shop');
    expect(screen.getByTestId('snippet-preview-footer-text')).toHaveTextContent(
      'Updated farm pickup disclaimer.'
    );

    // Clicking "Save & Copy HTML" persists settings, refreshes snippet, and copies updated HTML
    await user.click(screen.getByTestId('copy-html-snippet-btn'));

    await waitFor(() => {
      expect(settingsSaves).toHaveLength(1);
      expect(settingsSaves[0]).toMatchObject({
        publicSnippetHeaderTitle: 'BOTL Farm Eggs',
        publicSnippetHeaderText: 'Shop at https://botlfarm.com/shop',
        publicSnippetFooterText: 'Updated farm pickup disclaimer.',
        publicSnippetAutoAdvanceToday: true,
      });
      expect(writeText).toHaveBeenCalledWith(
        expect.stringContaining('BOTL Farm Eggs')
      );
    });
  });
});
