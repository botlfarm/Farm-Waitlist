import { RefreshCw, User } from 'lucide-react';
import { useEffect, useMemo, useRef, useState } from 'react';
import { api } from '../lib/api';
import type { CustomerSuggestion } from '../shared/types';

interface CustomerAutocompleteInputProps {
  id: string;
  testId: string;
  label?: string;
  labelRight?: React.ReactNode;
  value: string;
  placeholder?: string;
  odooConfigured?: boolean;
  onChange: (value: string) => void;
  onSelectCustomer: (customer: CustomerSuggestion) => void;
  className?: string;
}

// Track whether we already auto-pulled Odoo customers once in this browser session
let didAutoPullOdooCustomers = false;

export function resetCustomerAutocompleteSessionCache() {
  didAutoPullOdooCustomers = false;
}

export function CustomerAutocompleteInput({
  id,
  testId,
  label = 'Customer Name',
  labelRight,
  value,
  placeholder,
  odooConfigured = false,
  onChange,
  onSelectCustomer,
  className = 'min-h-[40px] w-full rounded-md border border-[#283340] bg-[#0F1419] px-3 py-2 text-sm text-[#F0F6FC] placeholder:text-[#6E7681] focus:border-[#38BDF8] focus:outline-none',
}: CustomerAutocompleteInputProps) {
  const [directory, setDirectory] = useState<CustomerSuggestion[]>([]);
  const [odooCount, setOdooCount] = useState<number>(0);
  const [serverOdooConfigured, setServerOdooConfigured] = useState<boolean>(odooConfigured);
  const [open, setOpen] = useState(false);
  const [highlightedIdx, setHighlightedIdx] = useState(0);
  const [syncingOdoo, setSyncingOdoo] = useState(false);
  const [syncFeedback, setSyncFeedback] = useState<string | null>(null);
  const containerRef = useRef<HTMLDivElement | null>(null);
  const requestSeq = useRef(0);

  const isOdooEnabled = odooConfigured || serverOdooConfigured;

  const fetchCustomers = async (query: string) => {
    const seq = ++requestSeq.current;
    try {
      const res = await api.listCustomers(query, 25);
      if (seq !== requestSeq.current) return;
      setDirectory(res.customers ?? []);
      setOdooCount(res.odooCustomersCount ?? 0);
      if (typeof res.odooConfigured === 'boolean') {
        setServerOdooConfigured(res.odooConfigured);
      }

      // If Odoo is configured and no Odoo contacts are cached yet, auto-pull once in the background
      if (
        (odooConfigured || res.odooConfigured) &&
        (res.odooCustomersCount ?? 0) === 0 &&
        !didAutoPullOdooCustomers
      ) {
        didAutoPullOdooCustomers = true;
        setSyncingOdoo(true);
        try {
          const syncRes = await api.syncOdooCustomers();
          setOdooCount(syncRes.odooCustomersCount ?? syncRes.syncedCount);
          const refreshed = await api.listCustomers(query, 25);
          if (seq === requestSeq.current) {
            setDirectory(refreshed.customers ?? []);
          }
        } catch {
          // Non-fatal; user can still type freely or click manual sync
        } finally {
          setSyncingOdoo(false);
        }
      }
    } catch {
      // Silently tolerate offline/test environments without /api/customers
    }
  };

  // Query directory whenever dropdown is open or search value changes
  useEffect(() => {
    if (!open) return;
    const timer = window.setTimeout(() => {
      void fetchCustomers(value);
    }, 100);
    return () => window.clearTimeout(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, value]);

  // Close dropdown on outside click
  useEffect(() => {
    if (!open) return;
    const handleOutside = (e: MouseEvent) => {
      if (containerRef.current && !containerRef.current.contains(e.target as Node)) {
        setOpen(false);
      }
    };
    document.addEventListener('mousedown', handleOutside);
    return () => document.removeEventListener('mousedown', handleOutside);
  }, [open]);

  const suggestions = useMemo(() => {
    const q = value.trim().toLowerCase();
    if (!q) return directory.slice(0, 12);
    return directory
      .filter((c) => {
        return (
          c.name.toLowerCase().includes(q) ||
          (c.email ?? '').toLowerCase().includes(q) ||
          (c.phone ?? '').toLowerCase().includes(q)
        );
      })
      .slice(0, 12);
  }, [directory, value]);

  useEffect(() => {
    setHighlightedIdx(0);
  }, [suggestions.length, value]);

  const handleManualSyncOdoo = async () => {
    if (syncingOdoo) return;
    setSyncingOdoo(true);
    setSyncFeedback(null);
    try {
      const res = await api.syncOdooCustomers();
      setOdooCount(res.odooCustomersCount ?? res.syncedCount);
      setSyncFeedback(`Synced ${res.syncedCount} Odoo contact${res.syncedCount === 1 ? '' : 's'}`);
      didAutoPullOdooCustomers = true;
      await fetchCustomers(value);
      setOpen(true);
      window.setTimeout(() => setSyncFeedback(null), 3500);
    } catch (err) {
      setSyncFeedback(err instanceof Error ? err.message : 'Odoo contact sync failed');
      window.setTimeout(() => setSyncFeedback(null), 4500);
    } finally {
      setSyncingOdoo(false);
    }
  };

  const handleSelect = (customer: CustomerSuggestion) => {
    onChange(customer.name);
    onSelectCustomer(customer);
    setOpen(false);
  };

  return (
    <div ref={containerRef} className="relative">
      <div className="mb-1.5 flex flex-wrap items-center justify-between gap-2">
        <label htmlFor={id} className="block text-xs font-medium text-[#C9D1D9]">
          {label}
        </label>
        <div className="flex items-center gap-2">
          {labelRight}
          {isOdooEnabled && (
            <button
              type="button"
              data-testid="sync-odoo-customers-btn"
              disabled={syncingOdoo}
              onClick={() => void handleManualSyncOdoo()}
              className="inline-flex items-center gap-1 text-[11px] font-medium text-[#38BDF8] hover:underline disabled:opacity-50"
              title="Pull active customer list from Odoo for autocomplete"
            >
              <RefreshCw className={`h-3 w-3 ${syncingOdoo ? 'animate-spin' : ''}`} />
              {syncingOdoo
                ? 'Syncing Odoo...'
                : odooCount > 0
                  ? `Odoo Contacts (${odooCount})`
                  : 'Pull Odoo Contacts'}
            </button>
          )}
        </div>
      </div>

      <input
        id={id}
        data-testid={testId}
        type="text"
        role="combobox"
        aria-autocomplete="list"
        aria-expanded={open && suggestions.length > 0}
        aria-controls={`${id}-suggestions`}
        autoComplete="off"
        value={value}
        placeholder={placeholder}
        onFocus={() => {
          setOpen(true);
          void fetchCustomers(value);
        }}
        onChange={(e) => {
          onChange(e.target.value);
          setOpen(true);
        }}
        onKeyDown={(e) => {
          if (!open || suggestions.length === 0) {
            if (e.key === 'ArrowDown') {
              setOpen(true);
            }
            return;
          }
          if (e.key === 'ArrowDown') {
            e.preventDefault();
            setHighlightedIdx((prev) => (prev + 1) % suggestions.length);
          } else if (e.key === 'ArrowUp') {
            e.preventDefault();
            setHighlightedIdx((prev) => (prev - 1 + suggestions.length) % suggestions.length);
          } else if (e.key === 'Enter') {
            const chosen = suggestions[highlightedIdx];
            if (chosen) {
              e.preventDefault();
              handleSelect(chosen);
            }
          } else if (e.key === 'Escape') {
            setOpen(false);
          }
        }}
        className={className}
      />

      {syncFeedback && (
        <p className="mt-1 text-[11px] text-[#38BDF8]" data-testid="odoo-customer-sync-status">
          {syncFeedback}
        </p>
      )}

      {open && suggestions.length > 0 && (
        <div
          id={`${id}-suggestions`}
          role="listbox"
          data-testid="customer-autocomplete-list"
          className="absolute right-0 left-0 z-50 mt-1 max-h-56 overflow-y-auto rounded-md border border-[#283340] bg-[#161D24] py-1 shadow-xl"
        >
          {suggestions.map((cust, idx) => {
            const isActive = idx === highlightedIdx;
            const contactLine = [cust.phone, cust.email].filter(Boolean).join(' · ');
            return (
              <button
                key={cust.key}
                type="button"
                role="option"
                aria-selected={isActive}
                data-testid={`customer-option-${idx}`}
                onMouseDown={(e) => {
                  // Prevent input blur before selection fires
                  e.preventDefault();
                  handleSelect(cust);
                }}
                onMouseEnter={() => setHighlightedIdx(idx)}
                className={`flex w-full items-start justify-between gap-2 px-3 py-2 text-left transition-colors ${
                  isActive ? 'bg-[#0EA5E9]/20 text-[#F0F6FC]' : 'text-[#E6EDF3] hover:bg-[#1E2730]'
                }`}
              >
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-1.5 text-xs font-semibold text-[#F0F6FC]">
                    <User className="h-3.5 w-3.5 shrink-0 text-[#8B949E]" aria-hidden="true" />
                    <span className="truncate">{cust.name}</span>
                  </div>
                  {contactLine && (
                    <div className="mt-0.5 truncate pl-5 text-[11px] text-[#8B949E]">
                      {contactLine}
                    </div>
                  )}
                </div>
                <span
                  className={`shrink-0 text-[10px] font-medium uppercase tracking-wide ${
                    cust.source === 'odoo' ? 'text-[#38BDF8]' : 'text-[#8B949E]'
                  }`}
                >
                  {cust.source === 'odoo' ? 'Odoo' : 'Local'}
                </span>
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}
