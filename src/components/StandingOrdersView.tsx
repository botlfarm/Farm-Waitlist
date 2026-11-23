import { Pause, Play, Plus, Trash2 } from 'lucide-react';
import { useState } from 'react';
import { formatQty } from '../shared/generators';
import { ISO_WEEKDAY_LABELS } from '../shared/timezone';
import type {
  OrderItemLine,
  PickupChannel,
  StandingCadence,
  StandingOrder,
  TrackedItem,
} from '../shared/types';

interface StandingOrdersViewProps {
  today: string;
  items: TrackedItem[];
  channels: PickupChannel[];
  standingOrders: StandingOrder[];
  onCreate: (payload: {
    customerName: string;
    customerContact?: string;
    pickupChannelId?: number | null;
    cadence: StandingCadence;
    weekday: number;
    startDate: string;
    isActive: boolean;
    notes?: string;
    items: OrderItemLine[];
  }) => Promise<void>;
  onToggleActive: (standing: StandingOrder) => Promise<void>;
  onDelete: (id: number) => Promise<void>;
}

export function StandingOrdersView({
  today,
  items,
  channels,
  standingOrders,
  onCreate,
  onToggleActive,
  onDelete,
}: StandingOrdersViewProps) {
  const activeItems = items.filter((i) => i.isActive);
  const itemsById = new Map(items.map((i) => [i.id, i]));
  const channelsById = new Map(channels.map((c) => [c.id, c]));

  const [customerName, setCustomerName] = useState('');
  const [customerContact, setCustomerContact] = useState('');
  const [pickupChannelId, setPickupChannelId] = useState('');
  const [cadence, setCadence] = useState<StandingCadence>('weekly');
  const [weekday, setWeekday] = useState<number>(6); // Default Saturday
  const [startDate, setStartDate] = useState(today);
  const [notes, setNotes] = useState('');
  const [lines, setLines] = useState<Array<{ trackedItemId: number; qtyText: string }>>(
    activeItems[0] ? [{ trackedItemId: activeItems[0].id, qtyText: '1' }] : []
  );
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  const addLine = () => {
    const nextItem =
      activeItems.find((i) => !lines.some((l) => l.trackedItemId === i.id)) ?? activeItems[0];
    if (!nextItem) return;
    setLines([...lines, { trackedItemId: nextItem.id, qtyText: '1' }]);
  };

  const handleSubmit = async () => {
    setError(null);
    if (!customerName.trim()) {
      setError('Customer name is required.');
      return;
    }
    const validLines: OrderItemLine[] = lines
      .map((l) => ({ trackedItemId: l.trackedItemId, quantity: Number(l.qtyText) }))
      .filter((l) => Number.isFinite(l.quantity) && l.quantity > 0);
    if (validLines.length === 0) {
      setError('Add at least one Tracked Item.');
      return;
    }
    setSaving(true);
    try {
      await onCreate({
        customerName: customerName.trim(),
        customerContact: customerContact.trim() || undefined,
        pickupChannelId: pickupChannelId ? Number(pickupChannelId) : null,
        cadence,
        weekday,
        startDate,
        isActive: true,
        notes: notes.trim() || undefined,
        items: validLines,
      });
      setCustomerName('');
      setCustomerContact('');
      setNotes('');
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to create standing order');
    } finally {
      setSaving(false);
    }
  };

  return (
    <main className="mx-auto max-w-6xl px-6 py-8" data-testid="standing-orders-view">
      <div className="mb-6">
        <h1 className="font-['Plus_Jakarta_Sans'] text-2xl font-bold text-[#F0F6FC]">
          Standing Recurring Orders
        </h1>
        <p className="mt-1 text-sm text-[#8B949E]">
          Active standing rules materialize automatically onto the calendar as locked slots before
          ASAP waitlist orders are scheduled. Individual weeks can still be edited or skipped on the
          calendar without altering the recurring rule.
        </p>
      </div>

      <div className="grid grid-cols-1 gap-8 lg:grid-cols-12">
        {/* Create Standing Rule Form */}
        <section className="rounded-lg border border-[#283340] bg-[#161D24] p-5 lg:col-span-5">
          <h2 className="font-['Plus_Jakarta_Sans'] text-base font-bold text-[#F0F6FC]">
            Add Standing Order Rule
          </h2>

          {error && (
            <div className="mt-3 rounded-md border border-[#DC2626]/60 bg-[#DC2626]/10 p-3 text-xs text-[#F87171]">
              {error}
            </div>
          )}

          <div className="mt-4 space-y-4">
            <div>
              <label htmlFor="so-name" className="mb-1 block text-xs font-medium text-[#C9D1D9]">
                Customer Name
              </label>
              <input
                id="so-name"
                data-testid="standing-customer-input"
                type="text"
                value={customerName}
                onChange={(e) => setCustomerName(e.target.value)}
                placeholder="e.g., Oak Street Bakery"
                className="min-h-[40px] w-full rounded-md border border-[#283340] bg-[#0F1419] px-3 py-2 text-sm text-[#F0F6FC] placeholder:text-[#6E7681]"
              />
            </div>

            <div>
              <label htmlFor="so-contact" className="mb-1 block text-xs font-medium text-[#C9D1D9]">
                Phone / Email
              </label>
              <input
                id="so-contact"
                data-testid="standing-contact-input"
                type="text"
                value={customerContact}
                onChange={(e) => setCustomerContact(e.target.value)}
                placeholder="Optional contact info"
                className="min-h-[40px] w-full rounded-md border border-[#283340] bg-[#0F1419] px-3 py-2 text-sm text-[#F0F6FC] placeholder:text-[#6E7681]"
              />
            </div>

            <div className="grid grid-cols-2 gap-3">
              <div>
                <label htmlFor="so-cadence" className="mb-1 block text-xs font-medium text-[#C9D1D9]">
                  Cadence
                </label>
                <select
                  id="so-cadence"
                  data-testid="standing-cadence-select"
                  value={cadence}
                  onChange={(e) => setCadence(e.target.value as StandingCadence)}
                  className="min-h-[40px] w-full rounded-md border border-[#283340] bg-[#0F1419] px-3 py-2 text-sm text-[#F0F6FC]"
                >
                  <option value="weekly">Weekly</option>
                  <option value="biweekly">Bi-Weekly</option>
                  <option value="monthly">Monthly</option>
                </select>
              </div>
              <div>
                <label htmlFor="so-weekday" className="mb-1 block text-xs font-medium text-[#C9D1D9]">
                  Pickup Day
                </label>
                <select
                  id="so-weekday"
                  data-testid="standing-weekday-select"
                  value={weekday}
                  onChange={(e) => setWeekday(Number(e.target.value))}
                  className="min-h-[40px] w-full rounded-md border border-[#283340] bg-[#0F1419] px-3 py-2 text-sm text-[#F0F6FC]"
                >
                  {[1, 2, 3, 4, 5, 6, 7].map((d) => (
                    <option key={d} value={d}>
                      {ISO_WEEKDAY_LABELS[d]}
                    </option>
                  ))}
                </select>
              </div>
            </div>

            <div className="grid grid-cols-2 gap-3">
              <div>
                <label htmlFor="so-channel" className="mb-1 block text-xs font-medium text-[#C9D1D9]">
                  Pickup Channel
                </label>
                <select
                  id="so-channel"
                  data-testid="standing-channel-select"
                  value={pickupChannelId}
                  onChange={(e) => setPickupChannelId(e.target.value)}
                  className="min-h-[40px] w-full rounded-md border border-[#283340] bg-[#0F1419] px-3 py-2 text-sm text-[#F0F6FC]"
                >
                  <option value="">Any / Unassigned</option>
                  {channels.map((c) => (
                    <option key={c.id} value={c.id}>
                      {c.name}
                    </option>
                  ))}
                </select>
              </div>
              <div>
                <label htmlFor="so-start" className="mb-1 block text-xs font-medium text-[#C9D1D9]">
                  Start Date
                </label>
                <input
                  id="so-start"
                  data-testid="standing-start-date-input"
                  type="date"
                  value={startDate}
                  onChange={(e) => setStartDate(e.target.value)}
                  className="min-h-[40px] w-full rounded-md border border-[#283340] bg-[#0F1419] px-3 py-2 font-mono text-sm text-[#F0F6FC]"
                />
              </div>
            </div>

            <div>
              <div className="mb-1.5 flex items-center justify-between">
                <label className="text-xs font-medium text-[#C9D1D9]">Recurring Items</label>
                <button
                  type="button"
                  onClick={addLine}
                  disabled={activeItems.length === 0}
                  className="inline-flex items-center gap-1 text-xs font-medium text-[#38BDF8] hover:underline disabled:opacity-40"
                >
                  <Plus className="h-3.5 w-3.5" />
                  Add Item
                </button>
              </div>
              {activeItems.length === 0 ? (
                <p className="text-xs text-[#8B949E]">Add Tracked Items in Settings first.</p>
              ) : (
                <div className="space-y-2">
                  {lines.map((line, idx) => (
                    <div key={idx} className="flex items-center gap-2">
                      <select
                        data-testid={`standing-item-select-${idx}`}
                        value={line.trackedItemId}
                        onChange={(e) => {
                          const next = [...lines];
                          next[idx] = { ...line, trackedItemId: Number(e.target.value) };
                          setLines(next);
                        }}
                        className="min-h-[38px] flex-1 rounded-md border border-[#283340] bg-[#0F1419] px-2.5 py-1.5 text-sm text-[#F0F6FC]"
                      >
                        {activeItems.map((i) => (
                          <option key={i.id} value={i.id}>
                            {i.name} ({i.unitLabel})
                          </option>
                        ))}
                      </select>
                      <input
                        data-testid={`standing-item-qty-${idx}`}
                        type="text"
                        inputMode="decimal"
                        placeholder="Qty"
                        value={line.qtyText}
                        onChange={(e) => {
                          const raw = e.target.value;
                          if (raw !== '' && !/^\d*\.?\d*$/.test(raw)) return;
                          const next = [...lines];
                          next[idx] = { ...line, qtyText: raw };
                          setLines(next);
                        }}
                        className="min-h-[38px] w-20 rounded-md border border-[#283340] bg-[#0F1419] px-2 py-1.5 font-mono text-sm tabular-nums text-[#F0F6FC] placeholder:text-[#6E7681]"
                      />
                    </div>
                  ))}
                </div>
              )}
            </div>

            <div>
              <label htmlFor="so-notes" className="mb-1 block text-xs font-medium text-[#C9D1D9]">
                Notes
              </label>
              <input
                id="so-notes"
                type="text"
                value={notes}
                onChange={(e) => setNotes(e.target.value)}
                placeholder="Optional recurring note"
                className="min-h-[40px] w-full rounded-md border border-[#283340] bg-[#0F1419] px-3 py-2 text-sm text-[#F0F6FC] placeholder:text-[#6E7681]"
              />
            </div>

            <button
              type="button"
              disabled={saving || activeItems.length === 0}
              data-testid="standing-submit-btn"
              onClick={() => void handleSubmit()}
              className="min-h-[40px] w-full rounded-md bg-[#0EA5E9] px-4 py-2 text-sm font-semibold text-[#0B1117] transition-colors hover:bg-[#38BDF8] disabled:opacity-45"
            >
              {saving ? 'Creating...' : 'Create Standing Order'}
            </button>
          </div>
        </section>

        {/* Standing Orders Table */}
        <section className="rounded-lg border border-[#283340] bg-[#161D24] p-5 lg:col-span-7">
          <h2 className="font-['Plus_Jakarta_Sans'] text-base font-bold text-[#F0F6FC]">
            Configured Rules ({standingOrders.length})
          </h2>

          {standingOrders.length === 0 ? (
            <p className="mt-6 text-sm text-[#8B949E]">
              No standing recurring orders configured yet.
            </p>
          ) : (
            <div className="mt-4 divide-y divide-[#283340]">
              {standingOrders.map((rule) => {
                const ch = rule.pickupChannelId ? channelsById.get(rule.pickupChannelId) : null;
                return (
                  <div
                    key={rule.id}
                    data-testid={`standing-rule-${rule.id}`}
                    className="flex flex-wrap items-center justify-between gap-4 py-3.5"
                  >
                    <div className="min-w-0">
                      <div className="flex items-center gap-2">
                        <span className="text-sm font-semibold text-[#F0F6FC]">
                          {rule.customerName}
                        </span>
                        <span
                          className={`text-xs font-medium ${
                            rule.isActive ? 'text-[#4ADE80]' : 'text-[#8B949E]'
                          }`}
                        >
                          {rule.isActive ? 'Active' : 'Paused'}
                        </span>
                      </div>
                      <div className="mt-0.5 text-xs text-[#8B949E]">
                        <span className="capitalize">{rule.cadence}</span> on{' '}
                        {ISO_WEEKDAY_LABELS[rule.weekday]}
                        {ch ? ` · ${ch.name}` : ''}
                        {rule.customerContact ? ` · ${rule.customerContact}` : ''}
                      </div>
                      <div className="mt-1 font-mono text-xs tabular-nums text-[#C9D1D9]">
                        {rule.items
                          .map((l) => {
                            const item = itemsById.get(l.trackedItemId);
                            return `${formatQty(l.quantity)} ${item?.unitLabel ?? ''} ${item?.name ?? ''}`;
                          })
                          .join(' + ')}
                      </div>
                    </div>

                    <div className="flex items-center gap-2">
                      <button
                        type="button"
                        data-testid={`standing-toggle-${rule.id}`}
                        onClick={() => void onToggleActive(rule)}
                        className="inline-flex min-h-[36px] items-center gap-1.5 rounded-md border border-[#283340] bg-[#0F1419] px-3 py-1.5 text-xs font-medium text-[#E6EDF3] hover:border-[#38BDF8]"
                      >
                        {rule.isActive ? (
                          <>
                            <Pause className="h-3.5 w-3.5" />
                            Pause
                          </>
                        ) : (
                          <>
                            <Play className="h-3.5 w-3.5" />
                            Resume
                          </>
                        )}
                      </button>
                      <button
                        type="button"
                        data-testid={`standing-delete-${rule.id}`}
                        onClick={() => void onDelete(rule.id)}
                        className="flex h-9 w-9 items-center justify-center rounded-md border border-[#283340] bg-[#0F1419] text-[#8B949E] hover:border-[#F87171] hover:text-[#F87171]"
                        aria-label={`Delete standing order for ${rule.customerName}`}
                      >
                        <Trash2 className="h-4 w-4" />
                      </button>
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </section>
      </div>
    </main>
  );
}
