// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import App from '../../src/App';
import { computeDragAutoScrollStep } from '../../src/components/CalendarWorkspace';
import { resetCustomerAutocompleteSessionCache } from '../../src/components/CustomerAutocompleteInput';
import { copyRichMessageToClipboard } from '../../src/lib/api';
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

    // Tap waitlist card -> OrderDetailDrawer opens with Pickup & Schedule panel
    await user.click(screen.getByTestId('queue-order-11'));
    expect(await screen.findByTestId('order-scheduler-panel')).toBeInTheDocument();

    // Availability date list starts condensed (no nested scroll box); clicking expands it inline
    expect(screen.queryByTestId('slot-availability-list')).not.toBeInTheDocument();
    await user.click(screen.getByTestId('toggle-availability-picker-btn'));
    const availabilityList = screen.getByTestId('slot-availability-list');
    expect(availabilityList).not.toHaveClass('overflow-y-auto');

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

  it('supports Weeks Ahead, Paused mode presets, flexible cutoff rules, dimmed past days, and GitHub Pages live publishing on Availability Snippet', async () => {
    const ws = makeBaseWorkspace({
      githubPublishStatus: {
        tokenConfigured: true,
        tokenSource: 'ha_options',
        repo: '',
        branch: 'main',
        filePath: 'availability.json',
        publicUrl: null,
        mode: 'manual',
        interval: '30m',
        lastPublishedAt: null,
        lastPublishStatus: 'never',
        lastPublishError: null,
        lastPublishedHash: null,
      },
    });

    const settingsSaves: Array<Record<string, unknown>> = [];
    const publishCalls: Array<Record<string, unknown>> = [];

    const buildSnippet = (): PublicAvailabilityResult => ({
      generatedAtDisplay: 'Nov 24, 2026, 4:30 PM EST',
      timezone: 'America/New_York',
      weeks: ws.settings.publicSnippetWeeks,
      paused: ws.settings.publicSnippetEnabled === false,
      pausedMessage: ws.settings.publicSnippetPausedMessage ?? 'Availability is currently unknown.',
      showSameDay: ws.settings.publicSnippetShowSameDay !== false,
      cutoffRules: ws.settings.publicSnippetCutoffRules ?? [],
      liveEmbedHtml: ws.settings.githubPublishRepo
        ? `<section class="fw-cal" data-fw-src="https://myfarm.github.io/avail/availability.json"></section>`
        : null,
      githubPublishStatus: ws.githubPublishStatus,
      days: [],
      calendarDays: [
        {
          date: '2026-11-23',
          displayDate: 'Nov 23',
          weekdayLabel: 'Mon',
          isoWeekday: 1,
          isPast: true,
          isToday: false,
          isOrderingClosed: false,
          channelNames: [],
          items: [],
        },
        {
          date: '2026-11-24',
          displayDate: 'Nov 24',
          weekdayLabel: 'Tue',
          isoWeekday: 2,
          isPast: false,
          isToday: true,
          isOrderingClosed: false,
          channelNames: ['Farm Store'],
          items: [
            {
              trackedItemId: 1,
              itemName: 'Standard Eggs',
              unitLabel: 'dozens',
              status: 'Available',
              approxAvailable: 8,
              approxLabel: 'Available (~8 dozens)',
            },
          ],
        },
      ],
      html: '<section class="fw-cal">Snapshot</section>',
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
          if (typeof patch.githubPublishRepo === 'string' && ws.githubPublishStatus) {
            ws.githubPublishStatus = {
              ...ws.githubPublishStatus,
              repo: patch.githubPublishRepo,
              publicUrl: patch.githubPublishRepo
                ? 'https://myfarm.github.io/avail/availability.json'
                : null,
              mode: patch.githubPublishMode === 'auto' ? 'auto' : 'manual',
            };
          }
          return new Response(
            JSON.stringify({
              settings: ws.settings,
              odooStatus: ws.odooStatus,
              githubPublishStatus: ws.githubPublishStatus,
            }),
            { status: 200 }
          );
        }
        if (input === './api/snippet/github/publish' && init?.method === 'POST') {
          const body = JSON.parse(String(init.body ?? '{}')) as Record<string, unknown>;
          publishCalls.push(body);
          if (ws.githubPublishStatus) {
            ws.githubPublishStatus = {
              ...ws.githubPublishStatus,
              lastPublishedAt: '2026-11-24T21:30:00Z',
              lastPublishStatus: 'success',
              lastPublishError: null,
            };
          }
          return new Response(
            JSON.stringify({
              published: true,
              skipped: false,
              hash: 'abc123',
              publicUrl: 'https://myfarm.github.io/avail/availability.json',
              publishedAt: '2026-11-24T21:30:00Z',
              githubPublishStatus: ws.githubPublishStatus,
            }),
            { status: 200 }
          );
        }
        if (input.startsWith('./api/snippet')) {
          return new Response(JSON.stringify(buildSnippet()), { status: 200 });
        }
        return new Response(JSON.stringify({ ok: true }), { status: 200 });
      })
    );

    const writeText = vi.spyOn(navigator.clipboard, 'writeText').mockResolvedValue(undefined);
    const user = userEvent.setup();
    render(<App />);

    await user.click(await screen.findByTestId('nav-snippet'));
    expect(await screen.findByTestId('snippet-rules-panel')).toBeInTheDocument();

    // Past day is rendered visibly (dimmed, not hidden on mobile)
    const pastDay = await screen.findByTestId('snippet-past-day-2026-11-23');
    expect(pastDay).toBeInTheDocument();
    expect(pastDay.className).not.toContain('hidden');

    // Toggle Same-Day Availability off -> Today immediately previews "Ordering Closed"
    await user.click(screen.getByTestId('snippet-show-same-day-checkbox'));
    expect(screen.getByTestId('snippet-day-closed-2026-11-24')).toHaveTextContent('Ordering Closed');

    // Add a flexible Friday 4 PM cutoff rule
    await user.click(screen.getByTestId('add-cutoff-preset-fri'));
    expect(screen.getByTestId('cutoff-rule-0')).toBeInTheDocument();
    expect(screen.getByTestId('cutoff-rule-mode-0')).toHaveValue('weekly_day');

    // Switch to Paused / Off-Season and pick "Closed for Season" preset
    await user.click(screen.getByTestId('snippet-mode-paused'));
    await user.click(screen.getByTestId('snippet-paused-preset-off_season'));
    expect(screen.getByTestId('snippet-preview-paused')).toHaveTextContent(
      'closed for the season'
    );

    // Configure open-source GitHub repo, switch to Automatic Sync, and Publish Now
    await user.type(screen.getByTestId('github-repo-input'), 'myfarm/avail');
    await user.click(screen.getByTestId('github-mode-auto'));
    expect(screen.getByTestId('github-derived-public-url')).toHaveTextContent(
      'https://myfarm.github.io/avail/availability.json'
    );

    await user.click(screen.getByTestId('github-publish-now-btn'));

    await waitFor(() => {
      expect(settingsSaves.length).toBeGreaterThanOrEqual(1);
      expect(settingsSaves[0]).toMatchObject({
        publicSnippetEnabled: false,
        publicSnippetShowSameDay: false,
        githubPublishRepo: 'myfarm/avail',
        githubPublishMode: 'auto',
      });
      expect(publishCalls).toHaveLength(1);
    });

    // Copy Live Embed Code copies the live auto-updating embed snippet
    await user.click(screen.getByTestId('copy-live-embed-btn'));
    await waitFor(() => {
      expect(writeText).toHaveBeenCalledWith(
        expect.stringContaining('https://myfarm.github.io/avail/availability.json')
      );
    });
  });

  it('displays inline Morning, Harvest, and End-of-Day expected counts with live adjustments and submits actualEndOfDay', async () => {
    const ws = makeBaseWorkspace();
    ws.days[0].byItem[1].expectedStartingBalance = 14;
    ws.days[0].byItem[1].actualOnHand = null;
    ws.days[0].byItem[1].startingBalance = 14;
    ws.days[0].byItem[1].slottedQty = 4;
    ws.days[0].byItem[1].endingBalance = 10;
    ws.days[0].byItem[1].expectedProduced = 15;
    ws.days[0].byItem[1].estProduced = 15;
    ws.days[0].byItem[1].isManualProducedOverride = false;
    ws.days[0].byItem[1].expectedNextDayStarting = 25;
    ws.days[0].byItem[1].nextDayStarting = 25;
    ws.days[0].byItem[1].actualEndOfDay = null;

    const supplySaves: Array<Record<string, unknown>> = [];

    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: string, init?: RequestInit) => {
        if (input.startsWith('./api/workspace')) {
          return new Response(JSON.stringify(ws), { status: 200 });
        }
        if (input === './api/supply/1/2026-11-23' && init?.method === 'PUT') {
          supplySaves.push(JSON.parse(String(init.body ?? '{}')) as Record<string, unknown>);
          return new Response(JSON.stringify({ ok: true }), { status: 200 });
        }
        return new Response(JSON.stringify({ ok: true }), { status: 200 });
      })
    );

    const user = userEvent.setup();
    render(<App />);

    await user.click(await screen.findByTestId('day-header-2026-11-23'));
    expect(await screen.findByTestId('day-detail-drawer')).toBeInTheDocument();

    // Expected counts sit inline next to their adjustment inputs
    expect(screen.getByTestId('day-morning-expected')).toHaveTextContent('14');
    expect(screen.getByTestId('day-harvest-expected')).toHaveTextContent('+15');
    expect(screen.getByTestId('day-eod-expected')).toHaveTextContent('25');
    expect(screen.getByTestId('day-tomorrow-starting')).toHaveTextContent('25 dozens');

    // Adjusting Morning Count to 16 immediately updates expected End-of-Day to 16 - 4 + 15 = 27
    await user.type(screen.getByTestId('day-actual-on-hand-input'), '16');
    expect(screen.getByTestId('day-eod-expected')).toHaveTextContent('27');
    expect(screen.getByTestId('day-tomorrow-starting')).toHaveTextContent('27 dozens');

    // Adjusting End of Day (After Harvest) to 23 pins tomorrow's starting count to 23
    await user.type(screen.getByTestId('day-actual-end-of-day-input'), '23');
    expect(screen.getByTestId('day-tomorrow-starting')).toHaveTextContent('23 dozens');
    expect(screen.getByTestId('day-tomorrow-starting')).toHaveTextContent('(actual EOD)');

    await user.click(screen.getByTestId('day-save-btn'));

    await waitFor(() => {
      expect(supplySaves).toHaveLength(1);
      expect(supplySaves[0]).toMatchObject({
        actualOnHand: 16,
        estProduced: null,
        actualEndOfDay: 23,
        cascadeForward: false,
      });
    });
  });

  it('shows a non-blocking warning modal when overwriting Morning or End-of-Day count on a non-today date', async () => {
    const ws = makeBaseWorkspace();
    const supplySaves: Array<{ url: string; body: Record<string, unknown> }> = [];

    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: string, init?: RequestInit) => {
        if (input.startsWith('./api/workspace')) {
          return new Response(JSON.stringify(ws), { status: 200 });
        }
        if (input.startsWith('./api/supply/') && init?.method === 'PUT') {
          supplySaves.push({
            url: input,
            body: JSON.parse(String(init.body ?? '{}')) as Record<string, unknown>,
          });
          return new Response(JSON.stringify({ ok: true }), { status: 200 });
        }
        return new Response(JSON.stringify({ ok: true }), { status: 200 });
      })
    );

    const user = userEvent.setup();
    render(<App />);

    // Open Tomorrow (2026-11-24, not today 2026-11-23)
    await user.click(await screen.findByTestId('day-header-2026-11-24'));
    expect(await screen.findByTestId('day-detail-drawer')).toBeInTheDocument();

    // Overwrite End-of-Day count on a non-today date -> clicking Save Day pops up the warning modal
    await user.type(screen.getByTestId('day-actual-end-of-day-input'), '19');
    await user.click(screen.getByTestId('day-save-btn'));

    const modal = await screen.findByTestId('non-today-override-modal');
    expect(modal).toBeInTheDocument();
    expect(modal).toHaveTextContent(/Additional Safety Buffer/i);
    expect(modal).toHaveTextContent(/Afternoon Harvest/i);
    expect(supplySaves).toHaveLength(0);

    // Go Back & Adjust dismisses without saving
    await user.click(screen.getByTestId('cancel-non-today-override-btn'));
    expect(screen.queryByTestId('non-today-override-modal')).not.toBeInTheDocument();
    expect(supplySaves).toHaveLength(0);

    // Clicking Save Day again and choosing "Save Override Anyway" proceeds (not a hard stop)
    await user.click(screen.getByTestId('day-save-btn'));
    await user.click(await screen.findByTestId('confirm-non-today-override-btn'));

    await waitFor(() => {
      expect(supplySaves).toHaveLength(1);
      expect(supplySaves[0].url).toBe('./api/supply/1/2026-11-24');
      expect(supplySaves[0].body).toMatchObject({ actualEndOfDay: 19 });
    });

    // Editing only Afternoon Harvest / Extra Buffer on a non-today date saves directly with no warning
    await user.click(await screen.findByTestId('day-header-2026-11-24'));
    await user.type(screen.getByTestId('day-extra-buffer-input'), '5');
    await user.click(screen.getByTestId('day-save-btn'));
    expect(screen.queryByTestId('non-today-override-modal')).not.toBeInTheDocument();

    await waitFor(() => {
      expect(supplySaves).toHaveLength(2);
      expect(supplySaves[1].body).toMatchObject({ extraBuffer: 5 });
    });
  });

  it('shows arrival dates prominently on unslotted waitlist cards and supports drag-and-drop reordering', async () => {
    const ws = makeBaseWorkspace();
    ws.today = '2026-11-24';
    ws.orders = [
      {
        ...ws.orders[1],
        id: 201,
        customerName: 'Zoe Newest',
        status: 'waitlist',
        slottedDate: null,
        odooCreatedAtLocal: '2026-11-22 15:00:00',
        createdAt: '2026-11-22T20:00:00Z',
        waitlistSortOrder: null,
      },
      {
        ...ws.orders[1],
        id: 202,
        customerName: 'Alice First',
        status: 'waitlist',
        slottedDate: null,
        odooCreatedAtLocal: '2026-11-18 09:00:00',
        createdAt: '2026-11-18T14:00:00Z',
        waitlistSortOrder: null,
      },
      {
        ...ws.orders[1],
        id: 203,
        customerName: 'Ben Middle',
        status: 'waitlist',
        slottedDate: null,
        odooCreatedAtLocal: null,
        createdAt: '2026-11-20T16:00:00Z',
        waitlistSortOrder: null,
      },
    ];

    const reorderCalls: Array<Record<string, unknown>> = [];

    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: string, init?: RequestInit) => {
        if (input.startsWith('./api/workspace')) {
          return new Response(JSON.stringify(ws), { status: 200 });
        }
        if (input === './api/orders/waitlist-order' && init?.method === 'PUT') {
          const body = JSON.parse(String(init.body ?? '{}')) as Record<string, unknown>;
          reorderCalls.push(body);
          if (body.reset === true) {
            ws.orders = ws.orders.map((o) => ({ ...o, waitlistSortOrder: null }));
          } else if (Array.isArray(body.orderIds)) {
            const ids = body.orderIds as number[];
            ws.orders = ws.orders.map((o) => {
              const idx = ids.indexOf(o.id);
              return idx >= 0 ? { ...o, waitlistSortOrder: idx } : o;
            });
          }
          return new Response(JSON.stringify({ ok: true }), { status: 200 });
        }
        return new Response(JSON.stringify({ ok: true }), { status: 200 });
      })
    );

    const user = userEvent.setup();
    render(<App />);

    // Default sort is oldest arrival date first: Alice (Nov 18), Ben (Nov 20), Zoe (Nov 22)
    expect(await screen.findByTestId('queue-arrived-202')).toHaveTextContent('Arrived Nov 18');
    expect(screen.getByTestId('queue-arrived-202')).toHaveTextContent('6d ago');
    expect(screen.getByTestId('queue-arrived-203')).toHaveTextContent('Arrived Nov 20');
    expect(screen.getByTestId('queue-arrived-201')).toHaveTextContent('Arrived Nov 22');

    const getQueueIds = () =>
      Array.from(document.querySelectorAll('[data-testid^="queue-order-"]')).map((el) =>
        Number(el.getAttribute('data-testid')?.replace('queue-order-', ''))
      );
    expect(getQueueIds()).toEqual([202, 203, 201]);

    // Drag Zoe (201) onto Alice (202) to move Zoe to the top of the waitlist
    const dragCard = screen.getByTestId('queue-order-201');
    const targetCard = screen.getByTestId('queue-order-202');
    const dataTransfer = {
      data: {} as Record<string, string>,
      effectAllowed: 'move',
      setData(type: string, val: string) {
        this.data[type] = val;
      },
      getData(type: string) {
        return this.data[type] ?? '';
      },
    };

    fireEvent.dragStart(dragCard, { dataTransfer });
    fireEvent.dragOver(targetCard, { dataTransfer });
    fireEvent.drop(targetCard, { dataTransfer });

    await waitFor(() => {
      expect(reorderCalls).toHaveLength(1);
      expect(reorderCalls[0]).toEqual({ orderIds: [201, 202, 203] });
      expect(getQueueIds()).toEqual([201, 202, 203]);
    });

    // Reset to Arrival restores oldest-first order
    await user.click(await screen.findByTestId('reset-waitlist-order-btn'));
    await waitFor(() => {
      expect(reorderCalls).toHaveLength(2);
      expect(reorderCalls[1]).toEqual({ reset: true });
      expect(getQueueIds()).toEqual([202, 203, 201]);
    });
  });

  it('auto-scrolls the waitlist container and calendar viewport when dragging near edges', async () => {
    // 1. Pure velocity curve check
    expect(computeDragAutoScrollStep(300, 100, 500, 88)).toBe(0);
    expect(computeDragAutoScrollStep(120, 100, 500, 88)).toBeLessThan(0);
    expect(computeDragAutoScrollStep(102, 100, 500, 88)).toBeLessThan(
      computeDragAutoScrollStep(160, 100, 500, 88)
    );
    expect(computeDragAutoScrollStep(485, 100, 500, 88)).toBeGreaterThan(0);
    expect(computeDragAutoScrollStep(498, 100, 500, 88)).toBeGreaterThan(
      computeDragAutoScrollStep(430, 100, 500, 88)
    );

    const ws = makeBaseWorkspace();
    ws.orders = [
      ...ws.orders,
      {
        ...ws.orders[1],
        id: 301,
        customerName: 'Waitlist Extra',
        status: 'waitlist',
        slottedDate: null,
      },
    ];

    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: string) => {
        if (input.startsWith('./api/workspace')) {
          return new Response(JSON.stringify(ws), { status: 200 });
        }
        return new Response(JSON.stringify({ ok: true }), { status: 200 });
      })
    );

    // Control animation frames deterministically
    let nextRafId = 1;
    const rafQueue = new Map<number, FrameRequestCallback>();
    const rafSpy = vi.spyOn(window, 'requestAnimationFrame').mockImplementation((cb) => {
      const id = nextRafId++;
      rafQueue.set(id, cb);
      return id;
    });
    const cancelRafSpy = vi.spyOn(window, 'cancelAnimationFrame').mockImplementation((id) => {
      rafQueue.delete(id);
    });
    const scrollBySpy = vi.spyOn(window, 'scrollBy').mockImplementation(() => {});

    const flushRaf = () => {
      const entries = Array.from(rafQueue.entries());
      rafQueue.clear();
      for (const [, cb] of entries) cb(performance.now());
    };

    try {
      render(<App />);

      const queueScroll = await screen.findByTestId('unslotted-queue-scroll');
      const dragCard = screen.getByTestId('queue-order-11');

      // Mock a tall scrollable waitlist container on desktop (x: 900..1220, y: 100..500)
      Object.defineProperty(window, 'innerWidth', { configurable: true, value: 1280 });
      Object.defineProperty(window, 'innerHeight', { configurable: true, value: 800 });
      Object.defineProperty(queueScroll, 'scrollHeight', { configurable: true, value: 1400 });
      Object.defineProperty(queueScroll, 'clientHeight', { configurable: true, value: 400 });
      queueScroll.scrollTop = 200;
      vi.spyOn(queueScroll, 'getBoundingClientRect').mockReturnValue({
        top: 100,
        bottom: 500,
        left: 900,
        right: 1220,
        width: 320,
        height: 400,
        x: 900,
        y: 100,
        toJSON: () => ({}),
      });

      const dataTransfer = {
        data: {} as Record<string, string>,
        effectAllowed: 'move',
        setData(type: string, val: string) {
          this.data[type] = val;
        },
        getData(type: string) {
          return this.data[type] ?? '';
        },
      };

      const dispatchDragOver = (clientX: number, clientY: number) => {
        const ev = new MouseEvent('dragover', {
          bubbles: true,
          cancelable: true,
          clientX,
          clientY,
        });
        window.dispatchEvent(ev);
      };

      // Start dragging card and hover near bottom edge of waitlist -> waitlist scrollTop increases
      fireEvent.dragStart(dragCard, { dataTransfer });
      dispatchDragOver(1050, 490);
      flushRaf();
      expect(queueScroll.scrollTop).toBeGreaterThan(200);
      const afterDown = queueScroll.scrollTop;

      // Move pointer near top edge of waitlist -> waitlist scrollTop decreases
      dispatchDragOver(1050, 108);
      flushRaf();
      expect(queueScroll.scrollTop).toBeLessThan(afterDown);

      // Drag over calendar area near bottom of screen -> window.scrollBy scrolls viewport down
      scrollBySpy.mockClear();
      dispatchDragOver(300, 785);
      flushRaf();
      expect(scrollBySpy).toHaveBeenCalled();
      expect(scrollBySpy.mock.calls[0][0]).toBe(0);
      expect(scrollBySpy.mock.calls[0][1]).toBeGreaterThan(0);

      // End drag -> stops rAF loop and does not scroll further
      scrollBySpy.mockClear();
      fireEvent.dragEnd(dragCard);
      expect(cancelRafSpy).toHaveBeenCalled();
      flushRaf();
      expect(scrollBySpy).not.toHaveBeenCalled();
    } finally {
      rafSpy.mockRestore();
      cancelRafSpy.mockRestore();
      scrollBySpy.mockRestore();
    }
  });

  it('live-bumps waitlist cards while dragging and live-previews calendar quantities across dates when hovering before dropping', async () => {
    const ws = makeBaseWorkspace();
    ws.today = '2026-11-23';
    // Day 0 (Nov 23): start=20, slotted=2 (id 10), end=18, buf=4, open=14, prod=10 -> nextStart=28
    // Day 1 (Nov 24): start=28, slotted=0, end=28, buf=4, open=24, prod=10 -> nextStart=38
    ws.orders = [
      ws.orders[0], // id 10, slotted on 2026-11-23, qty 2
      {
        ...ws.orders[1],
        id: 401,
        customerName: 'First Waitlister',
        status: 'waitlist',
        slottedDate: null,
        odooCreatedAtLocal: '2026-11-18 09:00:00',
        items: [{ id: 1, trackedItemId: 1, quantity: 3 }],
      },
      {
        ...ws.orders[1],
        id: 402,
        customerName: 'Second Waitlister',
        status: 'waitlist',
        slottedDate: null,
        odooCreatedAtLocal: '2026-11-20 09:00:00',
        items: [{ id: 2, trackedItemId: 1, quantity: 5 }],
      },
    ];

    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: string) => {
        if (input.startsWith('./api/workspace')) {
          return new Response(JSON.stringify(ws), { status: 200 });
        }
        return new Response(JSON.stringify({ ok: true }), { status: 200 });
      })
    );

    render(<App />);

    expect(await screen.findByTestId('queue-order-401')).toBeInTheDocument();

    const getQueueIds = () =>
      Array.from(document.querySelectorAll('[data-testid^="queue-order-"]')).map((el) =>
        Number(el.getAttribute('data-testid')?.replace('queue-order-', ''))
      );
    expect(getQueueIds()).toEqual([401, 402]);

    const dataTransfer = {
      data: {} as Record<string, string>,
      effectAllowed: 'move',
      dropEffect: 'move',
      setData(type: string, val: string) {
        this.data[type] = val;
      },
      getData(type: string) {
        return this.data[type] ?? '';
      },
    };

    // 1. Live-bump waitlist cards during dragOver BEFORE dropping
    const secondCard = screen.getByTestId('queue-order-402');
    const firstCard = screen.getByTestId('queue-order-401');
    fireEvent.dragStart(secondCard, { dataTransfer });
    fireEvent.dragOver(firstCard, { dataTransfer });

    // List immediately bumps 402 ahead of 401 BEFORE drop!
    expect(getQueueIds()).toEqual([402, 401]);

    // 2. Drag the same 5-dozen order over Day 0 (2026-11-23) -> live preview updates Day 0 AND Day 1!
    // Base fixture: Day 0 start=15, slotted=2, buf=4 -> open=9, harv=+15 -> Day 1 start=28, open=24
    const day0 = screen.getByTestId('calendar-day-2026-11-23');
    expect(screen.getByTestId('day-metrics-2026-11-23')).toHaveTextContent('Can Sell9dozens');
    expect(screen.getByTestId('day-metrics-2026-11-24')).toHaveTextContent('Can Sell24dozens');

    fireEvent.dragOver(day0, { dataTransfer });

    // Preview chip renders on Day 0
    expect(screen.getByTestId('drag-preview-chip')).toHaveTextContent('Second Waitlister');
    // Day 0 drops from 9 -> 4 open (-5), slotted jumps from (-2) -> (-7)
    expect(screen.getByTestId('day-metrics-2026-11-23')).toHaveTextContent('Can Sell4dozens');
    expect(screen.getByTestId('day-metrics-2026-11-23')).toHaveTextContent('(-7)');
    expect(screen.getByTestId('day-preview-delta-2026-11-23')).toHaveTextContent('-5');
    // Day 1 forward carry-over also drops live from 28 on-hand / 24 open -> 23 on-hand / 19 open (-5)!
    expect(screen.getByTestId('day-metrics-2026-11-24')).toHaveTextContent('Can Sell19dozens');
    expect(screen.getByTestId('day-metrics-2026-11-24')).toHaveTextContent('On Hand23');
    expect(screen.getByTestId('day-preview-delta-2026-11-24')).toHaveTextContent('-5');

    // 3. Move hover to Day 1 (2026-11-24) -> Day 0 reverts to 9 open, Day 1 shows 28 (-5) & 19 open
    const day1 = screen.getByTestId('calendar-day-2026-11-24');
    fireEvent.dragOver(day1, { dataTransfer });
    expect(screen.getByTestId('day-metrics-2026-11-23')).toHaveTextContent('Can Sell9dozens');
    expect(screen.getByTestId('day-metrics-2026-11-24')).toHaveTextContent('Can Sell19dozens');
    expect(screen.getByTestId('day-metrics-2026-11-24')).toHaveTextContent('(-5)');

    // 4. Cancel drag (dragEnd without drop) -> all numbers & waitlist order snap cleanly back to baseline
    fireEvent.dragEnd(secondCard);
    expect(screen.queryByTestId('drag-preview-chip')).not.toBeInTheDocument();
    expect(screen.getByTestId('day-metrics-2026-11-23')).toHaveTextContent('Can Sell9dozens');
    expect(screen.getByTestId('day-metrics-2026-11-24')).toHaveTextContent('Can Sell24dozens');
    expect(getQueueIds()).toEqual([401, 402]);
  });

  it('never flags recurring standing orders as duplicates and lets users dismiss non-duplicate merge banners', async () => {
    const ws = makeBaseWorkspace();
    ws.orders = [
      // Two weekly recurring standing orders for the same customer
      {
        ...ws.orders[0],
        id: 501,
        source: 'standing',
        standingOrderId: 12,
        standingOccurrenceDate: '2026-11-23',
        slottedDate: '2026-11-23',
        customerName: 'Weekly Wanda',
        customerEmail: 'wanda@example.com',
        customerPhone: '555-1111',
        odooQuotationId: null,
        odooQuotationName: null,
        odooPartnerId: null,
        isLocked: true,
      },
      {
        ...ws.orders[0],
        id: 502,
        source: 'standing',
        standingOrderId: 12,
        standingOccurrenceDate: '2026-11-24',
        slottedDate: '2026-11-24',
        customerName: 'Weekly Wanda',
        customerEmail: 'wanda@example.com',
        customerPhone: '555-1111',
        odooQuotationId: null,
        odooQuotationName: null,
        odooPartnerId: null,
        isLocked: true,
      },
      // A one-off manual order for Weekly Wanda too — still must NOT flag standing orders as duplicates
      {
        ...ws.orders[0],
        id: 503,
        source: 'manual',
        standingOrderId: null,
        standingOccurrenceDate: null,
        slottedDate: '2026-11-24',
        customerName: 'Weekly Wanda',
        customerEmail: 'wanda@example.com',
        customerPhone: '555-1111',
        odooQuotationId: null,
        odooQuotationName: null,
        odooPartnerId: null,
        isLocked: false,
      },
      // Two regular non-standing orders for the same customer -> SHOULD show duplicate banner with Dismiss button
      {
        ...ws.orders[0],
        id: 504,
        source: 'manual',
        standingOrderId: null,
        standingOccurrenceDate: null,
        slottedDate: '2026-11-23',
        customerName: 'Separate Sam',
        customerEmail: 'sam@example.com',
        customerPhone: '555-2222',
        odooQuotationId: null,
        odooQuotationName: null,
        odooPartnerId: null,
        isLocked: false,
      },
      {
        ...ws.orders[0],
        id: 505,
        source: 'manual',
        standingOrderId: null,
        standingOccurrenceDate: null,
        slottedDate: '2026-11-24',
        customerName: 'Separate Sam',
        customerEmail: 'sam@example.com',
        customerPhone: '555-2222',
        odooQuotationId: null,
        odooQuotationName: null,
        odooPartnerId: null,
        isLocked: false,
      },
    ];

    const dismissCalls: Array<{ url: string; body: Record<string, unknown> }> = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: string, init?: RequestInit) => {
        if (input.startsWith('./api/workspace')) {
          return new Response(JSON.stringify(ws), { status: 200 });
        }
        if (input === './api/orders/504/dismiss-duplicate' && init?.method === 'POST') {
          const body = JSON.parse(String(init.body ?? '{}')) as Record<string, unknown>;
          dismissCalls.push({ url: input, body });
          const otherId = Number(body.otherOrderId);
          ws.orders = ws.orders.map((o) => {
            if (o.id === 504) {
              return { ...o, dismissedDuplicateOrderIds: [...(o.dismissedDuplicateOrderIds ?? []), otherId] };
            }
            if (o.id === otherId) {
              return { ...o, dismissedDuplicateOrderIds: [...(o.dismissedDuplicateOrderIds ?? []), 504] };
            }
            return o;
          });
          return new Response(JSON.stringify({ ok: true, orderIdA: 504, orderIdB: otherId }), {
            status: 200,
          });
        }
        return new Response(JSON.stringify({ ok: true }), { status: 200 });
      })
    );

    const user = userEvent.setup();
    render(<App />);

    // 1. Opening a recurring standing order (501) shows NO duplicate banner and NO Merge button
    await user.click(await screen.findByTestId('order-chip-501'));
    expect(await screen.findByTestId('order-detail-drawer')).toBeInTheDocument();
    expect(screen.queryByTestId('possible-duplicate-banner')).not.toBeInTheDocument();
    expect(screen.queryByTestId('toggle-merge-panel-btn')).not.toBeInTheDocument();
    await user.click(screen.getByTestId('close-order-drawer-btn'));

    // 2. Opening Wanda's one-off manual order (503) also does NOT flag her standing orders (501/502) as duplicates
    await user.click(screen.getByTestId('order-chip-503'));
    expect(await screen.findByTestId('order-detail-drawer')).toBeInTheDocument();
    expect(screen.queryByTestId('possible-duplicate-banner')).not.toBeInTheDocument();
    await user.click(screen.getByTestId('close-order-drawer-btn'));

    // 3. Opening Separate Sam (504) DOES show possible-duplicate-banner for 505, with Not a Duplicate button
    await user.click(screen.getByTestId('order-chip-504'));
    const banner = await screen.findByTestId('possible-duplicate-banner');
    expect(banner).toHaveTextContent('Separate Sam');

    // Click "Not a Duplicate" -> calls API and hides banner
    await user.click(screen.getByTestId('dismiss-duplicate-btn'));
    await waitFor(() => {
      expect(dismissCalls).toHaveLength(1);
      expect(dismissCalls[0].body).toEqual({ otherOrderId: 505 });
      expect(screen.queryByTestId('possible-duplicate-banner')).not.toBeInTheDocument();
    });

    // 4. Opening the other side (505) also does NOT show the dismissed duplicate banner
    await user.click(screen.getByTestId('close-order-drawer-btn'));
    await user.click(screen.getByTestId('order-chip-505'));
    expect(await screen.findByTestId('order-detail-drawer')).toBeInTheDocument();
    expect(screen.queryByTestId('possible-duplicate-banner')).not.toBeInTheDocument();
  });

  it('lets users click a potential duplicate to compare its full details and Odoo chatter before merging or dismissing', async () => {
    const ws = makeBaseWorkspace();
    ws.orders = [
      {
        ...ws.orders[0],
        id: 601,
        source: 'odoo',
        status: 'slotted',
        slottedDate: '2026-11-23',
        customerName: 'Clara Barton',
        customerEmail: 'clara@example.com',
        customerPhone: '555-3333',
        odooQuotationId: 901,
        odooQuotationName: 'S00901',
        odooPartnerId: 401,
        notes: 'Original farm pickup order',
        chatter: [
          {
            id: 1,
            orderId: 601,
            odooMessageId: 9901,
            authorName: 'Clara Barton',
            messageType: 'email',
            subtypeName: 'Discussions',
            bodyText: 'Looking forward to Monday pickup!',
            createdAtUtc: '2026-11-21 15:00:00',
            createdAtLocal: '2026-11-21 10:00:00',
          },
        ],
      },
      {
        ...ws.orders[0],
        id: 602,
        source: 'odoo',
        status: 'waitlist',
        slottedDate: null,
        customerName: 'Clara Barton',
        customerEmail: 'clara@example.com',
        customerPhone: '555-3333',
        odooQuotationId: 902,
        odooQuotationName: 'S00902',
        odooPartnerId: 401,
        notes: 'Second order for neighbor gift',
        odooRawLines: ['3 × Standard Eggs (Dozen)'],
        items: [{ id: 9, trackedItemId: 1, quantity: 3 }],
        chatter: [
          {
            id: 2,
            orderId: 602,
            odooMessageId: 9902,
            authorName: 'Clara Barton',
            messageType: 'comment',
            subtypeName: 'Discussions',
            bodyText: 'CRITICAL CHATTER: This is a separate order for my sister, please do NOT cancel!',
            createdAtUtc: '2026-11-22 18:30:00',
            createdAtLocal: '2026-11-22 13:30:00',
          },
        ],
      },
    ];

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

    // Open order 601 -> see possible duplicate banner mentioning chatter count
    await user.click(await screen.findByTestId('order-chip-601'));
    const banner = await screen.findByTestId('possible-duplicate-banner');
    expect(banner).toHaveTextContent('S00902');
    expect(banner).toHaveTextContent('1 chatter');

    // Click the potential duplicate to expand full details & chatter inline for comparison
    await user.click(screen.getByTestId('inspect-duplicate-btn'));
    const compareCard = await screen.findByTestId('duplicate-comparison-card');
    expect(compareCard).toHaveTextContent('Second order for neighbor gift');
    expect(compareCard).toHaveTextContent('3 × Standard Eggs (Dozen)');
    const chatterBox = screen.getByTestId('duplicate-compare-chatter');
    expect(chatterBox).toHaveTextContent(
      'CRITICAL CHATTER: This is a separate order for my sister, please do NOT cancel!'
    );

    // Also verify chatter is visible inside the Merge panel preview before confirming
    await user.click(screen.getByTestId('open-merge-duplicate-btn'));
    const mergeDetails = await screen.findByTestId('merge-source-details');
    expect(mergeDetails).toHaveTextContent(
      'CRITICAL CHATTER: This is a separate order for my sister, please do NOT cancel!'
    );

    // Clicking "Open" switches drawer directly to order 602
    await user.click(screen.getByTestId('merge-open-source-order-btn'));
    await waitFor(() => {
      expect(screen.getByTestId('order-detail-drawer')).toHaveTextContent('S00902');
    });
  });

  it('copies pre-approval rich HTML without dark-mode background or light text styles on fallback copy', async () => {
    // Simulate HTTP Ingress environment where navigator.clipboard.write throws
    const origClipboard = navigator.clipboard;
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: {
        write: vi.fn().mockRejectedValue(new Error('NotAllowedError')),
        writeText: vi.fn().mockResolvedValue(undefined),
      },
    });

    const writtenClipboard: Record<string, string> = {};
    const execCommandSpy = vi.fn(() => {
      const copyEvent = new Event('copy', { bubbles: true, cancelable: true }) as ClipboardEvent;
      Object.defineProperty(copyEvent, 'clipboardData', {
        value: {
          setData: (type: string, value: string) => {
            writtenClipboard[type] = value;
          },
        },
      });
      document.dispatchEvent(copyEvent);
      return true;
    });
    const origExecCommand = document.execCommand;
    document.execCommand = execCommandSpy;

    try {
      const ok = await copyRichMessageToClipboard(
        'Hey Jane, order at <a href="https://farmstore.example.com/pre">Online Farm Store</a>\nThanks!'
      );
      expect(ok).toBe(true);
      expect(writtenClipboard['text/html']).toBe(
        '<div>Hey Jane, order at <a href="https://farmstore.example.com/pre" target="_blank" rel="noopener noreferrer">Online Farm Store</a><br>Thanks!</div>'
      );
      expect(writtenClipboard['text/html']).not.toMatch(/background|rgb\(|#0f1419|#e6edf3|color:/i);
      expect(writtenClipboard['text/plain']).toBe(
        'Hey Jane, order at Online Farm Store (https://farmstore.example.com/pre)\nThanks!'
      );
    } finally {
      document.execCommand = origExecCommand;
      Object.defineProperty(navigator, 'clipboard', {
        configurable: true,
        value: origClipboard,
      });
    }
  });

  it('autocompletes customer names from synced Odoo contacts in Quick Add and auto-fills phone and email', async () => {
    resetCustomerAutocompleteSessionCache();
    const ws = makeBaseWorkspace({
      odooStatus: {
        configured: true,
        source: 'env',
        urlHost: 'farm.odoo.com',
        database: 'farm_db',
      },
      odooCustomersCount: 2,
    });

    const createdOrders: Array<Record<string, unknown>> = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: string, init?: RequestInit) => {
        if (input.startsWith('./api/workspace')) {
          return new Response(JSON.stringify(ws), { status: 200 });
        }
        if (input.startsWith('./api/customers')) {
          return new Response(
            JSON.stringify({
              customers: [
                {
                  key: 'odoo:1001',
                  name: 'Elena Vance',
                  email: 'elena@farm.test',
                  phone: '555-1001',
                  odooPartnerId: 1001,
                  source: 'odoo',
                },
                {
                  key: 'odoo:1002',
                  name: 'Marcus Reed',
                  email: 'marcus@farm.test',
                  phone: '555-1002',
                  odooPartnerId: 1002,
                  source: 'odoo',
                },
              ],
              odooCustomersCount: 2,
              odooConfigured: true,
            }),
            { status: 200 }
          );
        }
        if (input === './api/orders' && init?.method === 'POST') {
          createdOrders.push(JSON.parse(String(init.body ?? '{}')) as Record<string, unknown>);
          return new Response(JSON.stringify({ ...ws.orders[1], id: 999 }), { status: 201 });
        }
        return new Response(JSON.stringify({ ok: true }), { status: 200 });
      })
    );

    const user = userEvent.setup();
    render(<App />);

    await user.click(await screen.findByTestId('quick-add-order-btn'));
    const nameInput = await screen.findByTestId('quick-add-customer-input');
    await user.type(nameInput, 'Ele');

    // Autocomplete dropdown lists Elena Vance with Odoo badge
    const option = await screen.findByTestId('customer-option-0');
    expect(option).toHaveTextContent('Elena Vance');
    expect(option).toHaveTextContent('Odoo');

    // Selecting Elena auto-fills Name, Phone, and Email
    fireEvent.mouseDown(option);

    expect(nameInput).toHaveValue('Elena Vance');
    expect(screen.getByTestId('quick-add-phone-input')).toHaveValue('555-1001');
    expect(screen.getByTestId('quick-add-email-input')).toHaveValue('elena@farm.test');

    // Submit order verifies auto-filled contact fields are sent
    await user.click(screen.getByTestId('quick-add-submit-btn'));
    await waitFor(() => {
      expect(createdOrders).toHaveLength(1);
      expect(createdOrders[0]).toMatchObject({
        customerName: 'Elena Vance',
        customerPhone: '555-1001',
        customerEmail: 'elena@farm.test',
      });
    });
  });

  it('displays Requested Pickup Date prominently in the waitlist, allows setting it in Quick Add, and supports editing & 1-tap slotting in OrderDetailDrawer', async () => {
    const ws = makeBaseWorkspace();
    ws.orders = [
      ws.orders[0],
      {
        ...ws.orders[1],
        id: 11,
        status: 'waitlist',
        timingType: 'specific_date',
        requestedDate: '2026-11-28',
        slottedDate: null,
        customerName: 'Bob Request',
      },
    ];

    const createdPayloads: Array<Record<string, unknown>> = [];
    const updatedPayloads: Array<Record<string, unknown>> = [];
    const slotPayloads: Array<Record<string, unknown>> = [];

    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: string, init?: RequestInit) => {
        if (input.startsWith('./api/workspace')) {
          return new Response(JSON.stringify(ws), { status: 200 });
        }
        if (input.startsWith('./api/customers')) {
          return new Response(
            JSON.stringify({ customers: [], odooCustomersCount: 0, odooConfigured: false }),
            { status: 200 }
          );
        }
        if (input === './api/orders' && init?.method === 'POST') {
          createdPayloads.push(JSON.parse(String(init.body ?? '{}')) as Record<string, unknown>);
          return new Response(JSON.stringify({ ...ws.orders[1], id: 901 }), { status: 201 });
        }
        if (input === './api/orders/11' && init?.method === 'PUT') {
          updatedPayloads.push(JSON.parse(String(init.body ?? '{}')) as Record<string, unknown>);
          return new Response(JSON.stringify(ws.orders[1]), { status: 200 });
        }
        if (input === './api/orders/11/slot' && init?.method === 'POST') {
          slotPayloads.push(JSON.parse(String(init.body ?? '{}')) as Record<string, unknown>);
          return new Response(JSON.stringify({ ...ws.orders[1], slottedDate: '2026-11-28', status: 'slotted' }), {
            status: 200,
          });
        }
        return new Response(JSON.stringify({ ok: true }), { status: 200 });
      })
    );

    const user = userEvent.setup();
    render(<App />);

    // 1. Waitlist card prominently displays the customer's Requested Pickup Date
    const requestedBadge = await screen.findByTestId('queue-requested-pickup-11');
    expect(requestedBadge).toHaveTextContent('Requested Pickup: Sat, Nov 28');

    // 2. Quick Add modal lets user set an optional Requested Pickup Date while adding to Waitlist Queue
    await user.click(screen.getByTestId('quick-add-order-btn'));
    await user.type(await screen.findByTestId('quick-add-customer-input'), 'Wendy Waitlist');
    fireEvent.change(screen.getByTestId('quick-add-date-input'), {
      target: { value: '2026-11-27' },
    });
    await user.click(screen.getByTestId('quick-add-submit-btn'));

    await waitFor(() => {
      expect(createdPayloads).toHaveLength(1);
      expect(createdPayloads[0]).toMatchObject({
        customerName: 'Wendy Waitlist',
        timingType: 'asap',
        requestedDate: '2026-11-27',
      });
    });

    // 3. Opening Bob Request in OrderDetailDrawer shows prominent header pill, editable input, and 1-tap requested date slot button
    await user.click(screen.getByTestId('queue-order-11'));
    expect(await screen.findByTestId('order-header-requested-pickup')).toHaveTextContent(
      'Requested Pickup: Sat, Nov 28'
    );
    const reqInput = screen.getByTestId('order-requested-date-input');
    expect(reqInput).toHaveValue('2026-11-28');

    const slotReqBtn = screen.getByTestId('slot-requested-date-btn');
    expect(slotReqBtn).toHaveTextContent('Slot on Requested Date · Sat, Nov 28');

    // Edit Requested Pickup Date and save -> sends requestedDate to PUT /api/orders/11
    fireEvent.change(reqInput, { target: { value: '2026-11-29' } });
    expect(screen.getByTestId('order-header-requested-pickup')).toHaveTextContent(
      'Requested Pickup: Sun, Nov 29'
    );
    await user.click(screen.getByTestId('order-save-btn'));

    await waitFor(() => {
      expect(updatedPayloads).toHaveLength(1);
      expect(updatedPayloads[0]).toMatchObject({ requestedDate: '2026-11-29' });
    });
  });

  it('prevents hover flicker across calendar cells and keeps dropped orders settled optimistically while saving', async () => {
    const ws = makeBaseWorkspace();
    ws.today = '2026-11-23';

    const slotGate: { resolve?: () => void } = {};
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: string) => {
        if (input.startsWith('./api/workspace')) {
          return new Response(JSON.stringify(ws), { status: 200 });
        }
        if (input === './api/orders/11/slot') {
          await new Promise<void>((resolve) => {
            slotGate.resolve = resolve;
          });
          ws.orders = ws.orders.map((o) =>
            o.id === 11 ? { ...o, status: 'slotted', slottedDate: '2026-11-24' } : o
          );
          return new Response(JSON.stringify({ ok: true }), { status: 200 });
        }
        return new Response(JSON.stringify({ ok: true }), { status: 200 });
      })
    );

    render(<App />);

    const queueCard = await screen.findByTestId('queue-order-11');
    const day0 = screen.getByTestId('calendar-day-2026-11-23');
    const day1 = screen.getByTestId('calendar-day-2026-11-24');

    const dataTransfer = {
      data: {} as Record<string, string>,
      effectAllowed: 'move',
      dropEffect: 'move',
      setData(type: string, val: string) {
        this.data[type] = val;
      },
      getData(type: string) {
        return this.data[type] ?? '';
      },
    };

    fireEvent.dragStart(queueCard, { dataTransfer });
    fireEvent.dragOver(day0, { dataTransfer });
    expect(screen.getByTestId('drag-preview-chip')).toHaveTextContent('Waitlist Walt');

    // Leaving day0 does not instantaneously flash preview off before entering day1
    fireEvent.dragLeave(day0, { dataTransfer });
    expect(screen.getByTestId('drag-preview-chip')).toBeInTheDocument();

    fireEvent.dragOver(day1, { dataTransfer });
    expect(screen.getByTestId('drag-preview-chip')).toHaveTextContent('Waitlist Walt');
    expect(screen.getByTestId('day-metrics-2026-11-24')).toHaveTextContent('Can Sell21dozens');

    // Drop onto day1 while POST /api/orders/11/slot is still in flight -> no snap-back!
    fireEvent.drop(day1, { dataTransfer });
    expect(screen.queryByTestId('queue-order-11')).not.toBeInTheDocument();
    expect(screen.getByTestId('order-chip-11')).toHaveTextContent('Waitlist Walt');
    expect(screen.getByTestId('day-metrics-2026-11-24')).toHaveTextContent('Can Sell21dozens');

    // Resolve server request and ensure settled state stays clean
    slotGate.resolve?.();
    await waitFor(() => {
      expect(screen.getByTestId('order-chip-11')).toBeInTheDocument();
    });
  });

  it('shows Pull from Odoo and Publish to Website side by side on the calendar toolbar and publishes with force', async () => {
    const user = userEvent.setup();
    const ws = makeBaseWorkspace({
      githubPublishStatus: {
        tokenConfigured: true,
        tokenSource: 'env',
        mode: 'auto',
        repo: 'myfarm/public-availability',
        branch: 'main',
        filePath: 'availability.json',
        interval: '1h',
        idleMinutes: 15,
        publicUrl: 'https://myfarm.github.io/public-availability/availability.json',
        lastPublishedAt: '2026-11-23T08:00:00.000Z',
        lastEditedAt: '2026-11-23T10:15:00.000Z',
        hasUnpublishedEdits: true,
        lastPublishedHash: 'abc123',
        lastPublishStatus: 'success',
        lastPublishError: null,
      },
    });

    const publishBodies: Array<Record<string, unknown>> = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: string, init?: RequestInit) => {
        if (input.startsWith('./api/workspace')) {
          return new Response(JSON.stringify(ws), { status: 200 });
        }
        if (input === './api/snippet/github/publish') {
          publishBodies.push(JSON.parse(String(init?.body ?? '{}')));
          ws.githubPublishStatus = {
            ...ws.githubPublishStatus!,
            lastPublishedAt: '2026-11-23T10:20:00.000Z',
            hasUnpublishedEdits: false,
          };
          return new Response(
            JSON.stringify({
              ok: true,
              skipped: false,
              changed: true,
              message: 'Published live availability to GitHub Pages.',
              publicUrl: 'https://myfarm.github.io/public-availability/availability.json',
            }),
            { status: 200 }
          );
        }
        return new Response(JSON.stringify({ ok: true }), { status: 200 });
      })
    );

    render(<App />);

    const pullBtn = await screen.findByTestId('sync-now-btn');
    const publishBtn = screen.getByTestId('publish-availability-btn');

    expect(pullBtn).toHaveTextContent('Pull from Odoo');
    expect(publishBtn).toHaveTextContent('Publish to Website');
    expect(publishBtn).toHaveAttribute('data-pending-edits', 'true');
    expect(publishBtn).not.toBeDisabled();

    await user.click(publishBtn);

    await waitFor(() => {
      expect(publishBodies).toEqual([{ force: true }]);
    });
    await waitFor(() => {
      expect(screen.getByTestId('publish-availability-btn')).not.toHaveAttribute(
        'data-pending-edits'
      );
    });
  });

  it('matches a cancelled Odoo waitlist quotation to a newly arrived replacement quotation in the banner, replaces with 1 click, and shows the full Odoo chain in the drawer', async () => {
    const user = userEvent.setup();
    const cancelledWaitlistOrder = {
      id: 51,
      source: 'odoo' as const,
      status: 'pre_approved' as const,
      timingType: 'asap' as const,
      requestedDate: null,
      slottedDate: '2026-11-24',
      isLocked: false,
      customerName: 'Sarah Miller',
      customerNameOverridden: false,
      customerEmail: 'sarah@example.com',
      customerPhone: '555-3333',
      pickupChannelId: 1,
      freeTextPickup: null,
      notes: 'Waitlist request',
      preApprovedAt: '2026-11-23T15:00:00Z',
      standingOrderId: null,
      standingOccurrenceDate: null,
      odooQuotationId: 100,
      odooQuotationName: 'S00100',
      odooPartnerId: 801,
      odooCreatedAtLocal: '2026-11-23 09:00:00',
      odooRawNotes: 'Waitlist request',
      odooRawLines: ['2 × Standard Eggs'],
      odooUpdatedAfterSlot: false,
      odooMissingFlagged: true,
      odooSuggestedConfirmed: null,
      mergedOdooNames: [] as string[],
      dismissedDuplicateOrderIds: [] as number[],
      waitlistSortOrder: null,
      createdAt: '2026-11-23T14:00:00Z',
      updatedAt: '2026-11-23T15:00:00Z',
      items: [{ trackedItemId: 1, quantity: 2 }],
      chatter: [],
    };
    const newReplacementQuotation = {
      ...cancelledWaitlistOrder,
      id: 52,
      status: 'waitlist' as const,
      slottedDate: null,
      notes: 'Storefront Order #5542',
      preApprovedAt: null,
      odooQuotationId: 105,
      odooQuotationName: 'S00105',
      odooCreatedAtLocal: '2026-11-24 10:00:00',
      odooRawNotes: 'Storefront Order #5542',
      odooRawLines: ['3 × Standard Eggs'],
      odooMissingFlagged: false,
      items: [{ trackedItemId: 1, quantity: 3 }],
    };

    const ws = makeBaseWorkspace();
    ws.orders = [...ws.orders, cancelledWaitlistOrder, newReplacementQuotation];
    ws.reconciliationOrders = [cancelledWaitlistOrder];

    const mergePayloads: Array<{ url: string; body: Record<string, unknown> }> = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: string, init?: RequestInit) => {
        if (input.startsWith('./api/workspace')) {
          return new Response(JSON.stringify(ws), { status: 200 });
        }
        if (input === './api/orders/51/merge') {
          const parsed = JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown>;
          mergePayloads.push({ url: input, body: parsed });
          const chained = {
            ...cancelledWaitlistOrder,
            odooQuotationId: 105,
            odooQuotationName: 'S00105',
            mergedOdooNames: ['S00100'],
            odooMissingFlagged: false,
            items: [{ trackedItemId: 1, quantity: 3 }],
          };
          ws.orders = ws.orders
            .filter((o) => o.id !== 52)
            .map((o) => (o.id === 51 ? chained : o));
          ws.reconciliationOrders = [];
          return new Response(JSON.stringify({ order: chained, mergedOrderId: 52 }), {
            status: 200,
          });
        }
        return new Response(JSON.stringify({ ok: true }), { status: 200 });
      })
    );

    render(<App />);

    const banner = await screen.findByTestId('reconciliation-banner');
    expect(banner).toHaveTextContent('Cancelled / Removed in Odoo');
    expect(banner).not.toHaveTextContent('Confirm paid');
    expect(banner).toHaveTextContent('Matches S00105');

    const replaceBtn = screen.getByTestId('reconcile-replace-51');
    expect(replaceBtn).toHaveTextContent('Replace with S00105');

    await user.click(replaceBtn);

    await waitFor(() => {
      expect(mergePayloads).toEqual([
        {
          url: './api/orders/51/merge',
          body: {
            sourceOrderId: 52,
            itemStrategy: 'use_source',
            keepDate: '2026-11-24',
          },
        },
      ]);
    });

    await waitFor(() => {
      expect(screen.queryByTestId('reconciliation-banner')).not.toBeInTheDocument();
    });

    // Open the chained order on the calendar and verify full chain S00100 -> S00105 is displayed
    await user.click(screen.getByTestId('order-chip-51'));
    const chainBadge = await screen.findByTestId('order-merged-refs');
    expect(chainBadge).toHaveTextContent('Chain: S00100 → S00105');
  });

  it('places Items at the top of OrderDetailDrawer, keeps general Notes separate from Odoo Order Details, and expands availability inline without nested scroll', async () => {
    const user = userEvent.setup();
    const ws = makeBaseWorkspace();
    ws.orders = [
      {
        ...ws.orders[0],
        id: 77,
        source: 'odoo',
        status: 'slotted',
        slottedDate: '2026-11-23',
        customerName: 'Clara Hens',
        odooQuotationId: 770,
        odooQuotationName: 'S00770',
        notes: 'Odoo web form submission: 2 doz eggs for Farm Pickup',
        odooRawNotes: 'Odoo web form submission: 2 doz eggs for Farm Pickup',
        odooRawLines: ['Standard Chicken Eggs x 2'],
      },
    ];

    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: string) => {
        if (input.startsWith('./api/workspace')) {
          return new Response(JSON.stringify(ws), { status: 200 });
        }
        return new Response(JSON.stringify({ ok: true }), { status: 200 });
      })
    );

    render(<App />);

    await user.click(await screen.findByTestId('order-chip-77'));
    const itemsSection = await screen.findByTestId('order-items-section');
    const schedulerPanel = screen.getByTestId('order-scheduler-panel');

    // Items section appears BEFORE Pickup & Schedule in DOM order
    expect(
      itemsSection.compareDocumentPosition(schedulerPanel) & Node.DOCUMENT_POSITION_FOLLOWING
    ).toBeTruthy();

    // General Notes field stays empty (does NOT duplicate Odoo Order Details), while Odoo Order Details renders separately
    const notesInput = screen.getByTestId('order-notes-input') as HTMLTextAreaElement;
    expect(notesInput.value).toBe('');
    expect(screen.getByTestId('order-odoo-raw-section')).toHaveTextContent(
      'Odoo web form submission: 2 doz eggs for Farm Pickup'
    );

    // Date availability picker starts collapsed and expands inline without overflow-y-auto (no scroll-in-scroll)
    expect(screen.queryByTestId('slot-availability-list')).not.toBeInTheDocument();
    await user.click(screen.getByTestId('toggle-availability-picker-btn'));
    const slotList = screen.getByTestId('slot-availability-list');
    expect(slotList).toBeInTheDocument();
    expect(slotList.className).not.toContain('overflow-y-auto');
  });

  it('lets users set Ignored Off-Season Date Ranges to Ignore completely (clearing already-imported Odoo orders)', async () => {
    const user = userEvent.setup();
    const ws = makeBaseWorkspace();
    ws.settings.odooIgnoredDateRanges = [
      {
        id: 'existing-range-1',
        startDate: '2025-01-01',
        endDate: '2025-03-31',
        label: 'Winter 2025',
        ignoreExisting: false,
      },
    ];

    const savedSettingPatches: Array<Record<string, unknown>> = [];

    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: string, init?: RequestInit) => {
        if (input.startsWith('./api/workspace')) {
          return new Response(JSON.stringify(ws), { status: 200 });
        }
        if (input === './api/settings' && init?.method === 'PUT') {
          const parsed = JSON.parse(String(init.body ?? '{}')) as Record<string, unknown>;
          savedSettingPatches.push(parsed);
          if (Array.isArray(parsed.odooIgnoredDateRanges)) {
            ws.settings.odooIgnoredDateRanges = parsed.odooIgnoredDateRanges as typeof ws.settings.odooIgnoredDateRanges;
          }
          return new Response(
            JSON.stringify({
              settings: ws.settings,
              odooStatus: ws.odooStatus,
              removedIgnoredOrdersCount: 5,
            }),
            { status: 200 }
          );
        }
        return new Response(JSON.stringify({ ok: true }), { status: 200 });
      })
    );

    render(<App />);

    await user.click(await screen.findByTestId('nav-settings'));
    await user.click(await screen.findByTestId('settings-tab-odoo'));

    // Existing range starts as "New imports only" with 1-click "Ignore Existing Too" button
    const existingRow = await screen.findByTestId('ignored-range-row-existing-range-1');
    expect(existingRow).toHaveTextContent('New imports only');
    await user.click(screen.getByTestId('toggle-ignored-range-mode-existing-range-1'));

    await waitFor(() => {
      expect(savedSettingPatches).toHaveLength(1);
      const ranges = savedSettingPatches[0].odooIgnoredDateRanges as Array<{
        id: string;
        ignoreExisting?: boolean;
      }>;
      expect(ranges.find((r) => r.id === 'existing-range-1')?.ignoreExisting).toBe(true);
    });
    expect(screen.getByTestId('ignored-range-row-existing-range-1')).toHaveTextContent(
      'Ignore completely'
    );

    // Add a new range with the "Ignore completely" checkbox checked
    await user.type(screen.getByTestId('ignored-range-start-input'), '2025-07-01');
    await user.type(screen.getByTestId('ignored-range-end-input'), '2025-08-31');
    await user.type(screen.getByTestId('ignored-range-label-input'), 'Summer 2025');
    await user.click(screen.getByTestId('ignored-range-complete-checkbox'));
    await user.click(screen.getByTestId('add-ignored-range-btn'));

    await waitFor(() => {
      expect(savedSettingPatches).toHaveLength(2);
      const ranges = savedSettingPatches[1].odooIgnoredDateRanges as Array<{
        startDate: string;
        endDate: string;
        label?: string;
        ignoreExisting?: boolean;
      }>;
      expect(ranges).toContainEqual(
        expect.objectContaining({
          startDate: '2025-07-01',
          endDate: '2025-08-31',
          label: 'Summer 2025',
          ignoreExisting: true,
        })
      );
    });
  });
});





