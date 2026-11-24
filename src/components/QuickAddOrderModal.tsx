import { Plus, Trash2, X } from 'lucide-react';
import { useEffect, useState } from 'react';
import type { OrderItemLine, OrderTimingType, PickupChannel, TrackedItem } from '../shared/types';
import { CustomerAutocompleteInput } from './CustomerAutocompleteInput';

interface QuickAddOrderModalProps {
  open: boolean;
  today: string;
  items: TrackedItem[];
  channels: PickupChannel[];
  odooConfigured?: boolean;
  onClose: () => void;
  onSubmit: (payload: {
    customerName: string;
    customerEmail?: string;
    customerPhone?: string;
    timingType: OrderTimingType;
    requestedDate?: string | null;
    pickupChannelId?: number | null;
    notes?: string;
    items: OrderItemLine[];
    forceWeekday?: boolean;
  }) => Promise<void>;
}

export function QuickAddOrderModal({
  open,
  today,
  items,
  channels,
  odooConfigured = false,
  onClose,
  onSubmit,
}: QuickAddOrderModalProps) {
  const activeItems = items.filter((i) => i.isActive);
  const [customerName, setCustomerName] = useState('');
  const [customerPhone, setCustomerPhone] = useState('');
  const [customerEmail, setCustomerEmail] = useState('');
  const [timingType, setTimingType] = useState<OrderTimingType>('asap');
  const [requestedDate, setRequestedDate] = useState('');
  const [pickupChannelId, setPickupChannelId] = useState<string>('');
  const [notes, setNotes] = useState('');
  const [lines, setLines] = useState<Array<{ trackedItemId: number; qtyText: string }>>([]);
  const [error, setError] = useState<string | null>(null);
  const [weekdayWarning, setWeekdayWarning] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  useEffect(() => {
    if (!open) return;
    setCustomerName('');
    setCustomerPhone('');
    setCustomerEmail('');
    setTimingType('asap');
    setRequestedDate('');
    setPickupChannelId(channels.find((c) => c.isActive)?.id ? String(channels.find((c) => c.isActive)!.id) : '');
    setNotes('');
    setError(null);
    setWeekdayWarning(null);
    setLines(activeItems[0] ? [{ trackedItemId: activeItems[0].id, qtyText: '1' }] : []);
  }, [open, today]);

  if (!open) return null;

  const addLine = () => {
    const unused = activeItems.find((i) => !lines.some((l) => l.trackedItemId === i.id)) ?? activeItems[0];
    if (!unused) return;
    setLines([...lines, { trackedItemId: unused.id, qtyText: '1' }]);
  };

  const handleSubmit = async (forceWeekday = false) => {
    setError(null);
    setWeekdayWarning(null);
    if (!customerName.trim()) {
      setError('Customer name is required.');
      return;
    }
    const validLines: OrderItemLine[] = lines
      .map((l) => ({ trackedItemId: l.trackedItemId, quantity: Number(l.qtyText) }))
      .filter((l) => Number.isFinite(l.quantity) && l.quantity > 0);
    if (validLines.length === 0) {
      setError('Add at least one Tracked Item with a quantity greater than 0.');
      return;
    }

    if (timingType === 'specific_date' && !requestedDate) {
      setError('Choose a pickup date to slot directly on the calendar.');
      return;
    }

    setSubmitting(true);
    try {
      await onSubmit({
        customerName: customerName.trim(),
        customerPhone: customerPhone.trim() || undefined,
        customerEmail: customerEmail.trim() || undefined,
        timingType,
        requestedDate: requestedDate || null,
        pickupChannelId: pickupChannelId ? Number(pickupChannelId) : null,
        notes: notes.trim() || undefined,
        items: validLines,
        forceWeekday,
      });
      onClose();
    } catch (err: unknown) {
      const apiErr = err as { message?: string; payload?: { weekdayWarning?: boolean } };
      if (apiErr?.payload?.weekdayWarning) {
        setWeekdayWarning(apiErr.message || 'Selected pickup channel is closed on that weekday.');
      } else {
        setError(apiErr?.message || 'Failed to add order.');
      }
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/65 p-4"
      data-testid="quick-add-modal"
      role="dialog"
      aria-modal="true"
      aria-label="Quick Add Manual Order"
    >
      <div className="w-full max-w-lg rounded-lg border border-[#283340] bg-[#161D24] text-[#E6EDF3]">
        <div className="flex items-center justify-between border-b border-[#283340] px-6 py-4">
          <h2 className="font-['Plus_Jakarta_Sans'] text-lg font-bold text-[#F0F6FC]">
            Quick Add Manual Order
          </h2>
          <button
            type="button"
            data-testid="close-quick-add-btn"
            onClick={onClose}
            className="flex h-9 w-9 items-center justify-center rounded-md text-[#8B949E] hover:bg-[#1E2730] hover:text-[#F0F6FC]"
            aria-label="Close quick add modal"
          >
            <X className="h-5 w-5" />
          </button>
        </div>

        <div className="max-h-[75vh] space-y-4 overflow-y-auto px-6 py-5">
          {activeItems.length === 0 && (
            <div className="rounded-md border border-[#D97706]/60 bg-[#D97706]/10 p-3 text-xs text-[#FBBF24]">
              Configure at least one Tracked Item in Settings before adding manual orders.
            </div>
          )}

          {error && (
            <div className="rounded-md border border-[#DC2626]/60 bg-[#DC2626]/10 p-3 text-xs text-[#F87171]">
              {error}
            </div>
          )}

          {weekdayWarning && (
            <div className="rounded-md border border-[#D97706]/60 bg-[#D97706]/10 p-3 text-xs text-[#FBBF24]">
              <p>{weekdayWarning}</p>
              <button
                type="button"
                data-testid="quick-add-force-weekday-btn"
                onClick={() => void handleSubmit(true)}
                className="mt-2 rounded-md bg-[#D97706] px-3 py-1.5 text-xs font-semibold text-[#0B1117]"
              >
                Slot Anyway on This Date
              </button>
            </div>
          )}

          <CustomerAutocompleteInput
            id="qa-customer"
            testId="quick-add-customer-input"
            label="Customer Name"
            value={customerName}
            placeholder="e.g., Sarah Miller"
            odooConfigured={odooConfigured}
            onChange={setCustomerName}
            onSelectCustomer={(cust) => {
              if (cust.phone) setCustomerPhone(cust.phone);
              if (cust.email) setCustomerEmail(cust.email);
            }}
          />

          <div className="grid grid-cols-2 gap-3">
            <div>
              <label htmlFor="qa-phone" className="mb-1.5 block text-xs font-medium text-[#C9D1D9]">
                Phone / Text
              </label>
              <input
                id="qa-phone"
                data-testid="quick-add-phone-input"
                type="text"
                value={customerPhone}
                onChange={(e) => setCustomerPhone(e.target.value)}
                placeholder="Optional"
                className="min-h-[40px] w-full rounded-md border border-[#283340] bg-[#0F1419] px-3 py-2 text-sm text-[#F0F6FC] placeholder:text-[#6E7681] focus:border-[#38BDF8] focus:outline-none"
              />
            </div>
            <div>
              <label htmlFor="qa-email" className="mb-1.5 block text-xs font-medium text-[#C9D1D9]">
                Email
              </label>
              <input
                id="qa-email"
                data-testid="quick-add-email-input"
                type="email"
                value={customerEmail}
                onChange={(e) => setCustomerEmail(e.target.value)}
                placeholder="Optional"
                className="min-h-[40px] w-full rounded-md border border-[#283340] bg-[#0F1419] px-3 py-2 text-sm text-[#F0F6FC] placeholder:text-[#6E7681] focus:border-[#38BDF8] focus:outline-none"
              />
            </div>
          </div>

          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="mb-1.5 block text-xs font-medium text-[#C9D1D9]">Timing</label>
              <div className="flex rounded-md border border-[#283340] bg-[#0F1419] p-1">
                <button
                  type="button"
                  data-testid="quick-add-timing-asap"
                  onClick={() => setTimingType('asap')}
                  className={`flex-1 rounded py-1.5 text-xs font-medium ${
                    timingType === 'asap'
                      ? 'bg-[#0EA5E9] text-[#0B1117]'
                      : 'text-[#8B949E] hover:text-[#E6EDF3]'
                  }`}
                >
                  ASAP Queue
                </button>
                <button
                  type="button"
                  data-testid="quick-add-timing-specific"
                  onClick={() => {
                    setTimingType('specific_date');
                    if (!requestedDate) setRequestedDate(today);
                  }}
                  className={`flex-1 rounded py-1.5 text-xs font-medium ${
                    timingType === 'specific_date'
                      ? 'bg-[#0EA5E9] text-[#0B1117]'
                      : 'text-[#8B949E] hover:text-[#E6EDF3]'
                  }`}
                >
                  Slot on Date
                </button>
              </div>
            </div>

            <div>
              <label htmlFor="qa-channel" className="mb-1.5 block text-xs font-medium text-[#C9D1D9]">
                Pickup Channel
              </label>
              <select
                id="qa-channel"
                data-testid="quick-add-channel-select"
                value={pickupChannelId}
                onChange={(e) => setPickupChannelId(e.target.value)}
                className="min-h-[40px] w-full rounded-md border border-[#283340] bg-[#0F1419] px-3 py-2 text-sm text-[#F0F6FC] focus:border-[#38BDF8] focus:outline-none"
              >
                <option value="">Any Channel / Unassigned</option>
                {channels
                  .filter((c) => c.isActive)
                  .map((c) => (
                    <option key={c.id} value={c.id}>
                      {c.name}
                    </option>
                  ))}
              </select>
            </div>
          </div>

          <div>
            <div className="mb-1.5 flex items-center justify-between gap-2">
              <label htmlFor="qa-date" className="block text-xs font-medium text-[#C9D1D9]">
                {timingType === 'specific_date'
                  ? 'Requested & Slotted Pickup Date'
                  : 'Requested Pickup Date (Optional)'}
              </label>
              {requestedDate && timingType === 'asap' && (
                <button
                  type="button"
                  data-testid="quick-add-clear-date-btn"
                  onClick={() => setRequestedDate('')}
                  className="text-[11px] font-medium text-[#8B949E] hover:text-[#F0F6FC]"
                >
                  Clear
                </button>
              )}
            </div>
            <input
              id="qa-date"
              data-testid="quick-add-date-input"
              type="date"
              value={requestedDate}
              onChange={(e) => setRequestedDate(e.target.value)}
              className="min-h-[40px] w-full rounded-md border border-[#283340] bg-[#0F1419] px-3 py-2 font-mono text-sm text-[#F0F6FC] focus:border-[#38BDF8] focus:outline-none"
            />
            {timingType === 'asap' && (
              <p className="mt-1 text-[11px] text-[#8B949E]">
                Customer’s preferred pickup date — shown prominently in the waitlist so you can fulfill it when stock allows.
              </p>
            )}
          </div>

          <div>
            <div className="mb-1.5 flex items-center justify-between">
              <label className="text-xs font-medium text-[#C9D1D9]">Items &amp; Quantities</label>
              <button
                type="button"
                data-testid="quick-add-add-line-btn"
                onClick={addLine}
                disabled={activeItems.length === 0}
                className="inline-flex items-center gap-1 text-xs font-medium text-[#38BDF8] hover:underline disabled:opacity-40"
              >
                <Plus className="h-3.5 w-3.5" />
                Add Another Item
              </button>
            </div>
            <div className="space-y-2">
              {lines.map((line, idx) => (
                <div key={idx} className="flex items-center gap-2">
                  <select
                    data-testid={`quick-add-item-select-${idx}`}
                    value={line.trackedItemId}
                    onChange={(e) => {
                      const next = [...lines];
                      next[idx] = { ...line, trackedItemId: Number(e.target.value) };
                      setLines(next);
                    }}
                    className="min-h-[40px] flex-1 rounded-md border border-[#283340] bg-[#0F1419] px-3 py-2 text-sm text-[#F0F6FC]"
                  >
                    {activeItems.map((item) => (
                      <option key={item.id} value={item.id}>
                        {item.name} ({item.unitLabel})
                      </option>
                    ))}
                  </select>
                  <input
                    data-testid={`quick-add-item-qty-${idx}`}
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
                    className="min-h-[40px] w-24 rounded-md border border-[#283340] bg-[#0F1419] px-2.5 py-2 font-mono text-sm tabular-nums text-[#F0F6FC] placeholder:text-[#6E7681]"
                  />
                  {lines.length > 1 && (
                    <button
                      type="button"
                      onClick={() => setLines(lines.filter((_, i) => i !== idx))}
                      className="flex h-10 w-10 items-center justify-center rounded-md text-[#8B949E] hover:bg-[#1E2730] hover:text-[#F87171]"
                      aria-label="Remove item row"
                    >
                      <Trash2 className="h-4 w-4" />
                    </button>
                  )}
                </div>
              ))}
            </div>
          </div>

          <div>
            <label htmlFor="qa-notes" className="mb-1.5 block text-xs font-medium text-[#C9D1D9]">
              Notes
            </label>
            <textarea
              id="qa-notes"
              data-testid="quick-add-notes-input"
              rows={2}
              value={notes}
              onChange={(e) => setNotes(e.target.value)}
              placeholder="Phone call details, preferred pickup window, etc."
              className="w-full rounded-md border border-[#283340] bg-[#0F1419] px-3 py-2 text-sm text-[#F0F6FC] placeholder:text-[#6E7681] focus:border-[#38BDF8] focus:outline-none"
            />
          </div>
        </div>

        <div className="flex items-center justify-end gap-2 border-t border-[#283340] px-6 py-4">
          <button
            type="button"
            onClick={onClose}
            className="min-h-[40px] rounded-md border border-[#283340] bg-[#1E2730] px-4 py-2 text-sm font-medium text-[#C9D1D9] hover:border-[#3B4958]"
          >
            Cancel
          </button>
          <button
            type="button"
            disabled={submitting || activeItems.length === 0}
            data-testid="quick-add-submit-btn"
            onClick={() => void handleSubmit(false)}
            className="min-h-[40px] rounded-md bg-[#0EA5E9] px-5 py-2 text-sm font-semibold text-[#0B1117] transition-colors hover:bg-[#38BDF8] disabled:opacity-50"
          >
            {submitting
              ? 'Adding...'
              : timingType === 'specific_date'
                ? 'Add & Slot on Date'
                : 'Add to Waitlist Queue'}
          </button>
        </div>
      </div>
    </div>
  );
}
