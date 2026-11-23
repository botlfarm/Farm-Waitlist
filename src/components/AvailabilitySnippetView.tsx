import { Check, Code, Copy, RefreshCw } from 'lucide-react';
import { useEffect, useState } from 'react';
import { api, copyTextToClipboard } from '../lib/api';
import { formatQty } from '../shared/generators';
import type { PublicAvailabilityCalendarDay, PublicAvailabilityResult } from '../shared/types';

interface AvailabilitySnippetViewProps {
  defaultWeeks: number;
}

const WEEKDAYS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];

export function AvailabilitySnippetView({ defaultWeeks }: AvailabilitySnippetViewProps) {
  const [data, setData] = useState<PublicAvailabilityResult | null>(null);
  const [loading, setLoading] = useState(true);
  const [showRawHtml, setShowRawHtml] = useState(false);
  const [copied, setCopied] = useState(false);

  const loadSnippet = async () => {
    setLoading(true);
    try {
      const res = await api.getSnippet(defaultWeeks || 3);
      setData(res);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    void loadSnippet();
  }, [defaultWeeks]);

  const handleCopyHtml = async () => {
    if (!data) return;
    const ok = await copyTextToClipboard(data.html);
    if (ok) {
      setCopied(true);
      setTimeout(() => setCopied(false), 2500);
    }
  };

  const badgeClasses = (status: 'Available' | 'Limited' | 'Waitlist Full') => {
    if (status === 'Available') {
      return 'border border-[#16A34A]/35 bg-[#16A34A]/12 text-[#4ADE80]';
    }
    if (status === 'Limited') {
      return 'border border-[#D97706]/35 bg-[#D97706]/12 text-[#FBBF24]';
    }
    return 'border border-[#DC2626]/35 bg-[#DC2626]/12 text-[#F87171]';
  };

  const calendarDays: PublicAvailabilityCalendarDay[] = data?.calendarDays ?? [];
  const firstActiveDay = calendarDays.find((d) => !d.isPast) ?? data?.days[0];
  const publicItems = firstActiveDay?.items ?? [];
  const singleItem = publicItems.length === 1 ? publicItems[0] : null;

  return (
    <main className="mx-auto max-w-6xl px-4 py-6 sm:px-6 sm:py-8" data-testid="availability-snippet-view">
      <div className="mb-6 flex flex-wrap items-start justify-between gap-4">
        <div>
          <h1 className="font-['Plus_Jakarta_Sans'] text-2xl font-bold text-[#F0F6FC]">
            Public Website Availability Snippet
          </h1>
          <p className="mt-1 text-sm text-[#8B949E]">
            Generates a clean, self-contained HTML calendar for your Odoo waitlist page showing the
            next {defaultWeeks || 3} weeks of approximate post-buffer availability with zero
            customer names exposed.
          </p>
        </div>

        <div className="flex flex-wrap items-center gap-2">
          <button
            type="button"
            onClick={() => void loadSnippet()}
            className="inline-flex min-h-[40px] items-center gap-1.5 rounded-md border border-[#283340] bg-[#161D24] px-3.5 py-2 text-xs font-medium text-[#E6EDF3] hover:border-[#38BDF8]"
          >
            <RefreshCw className={`h-3.5 w-3.5 ${loading ? 'animate-spin' : ''}`} />
            Refresh
          </button>
          <button
            type="button"
            data-testid="toggle-raw-html-btn"
            onClick={() => setShowRawHtml((prev) => !prev)}
            className="inline-flex min-h-[40px] items-center gap-1.5 rounded-md border border-[#283340] bg-[#161D24] px-3.5 py-2 text-xs font-medium text-[#E6EDF3] hover:border-[#38BDF8]"
          >
            <Code className="h-3.5 w-3.5" />
            {showRawHtml ? 'Hide HTML' : 'View HTML'}
          </button>
          <button
            type="button"
            disabled={!data}
            data-testid="copy-html-snippet-btn"
            onClick={() => void handleCopyHtml()}
            className="inline-flex min-h-[40px] items-center gap-2 rounded-md bg-[#0EA5E9] px-5 py-2 text-sm font-semibold text-[#0B1117] transition-colors hover:bg-[#38BDF8] disabled:opacity-45"
          >
            {copied ? (
              <>
                <Check className="h-4 w-4" />
                Copied HTML!
              </>
            ) : (
              <>
                <Copy className="h-4 w-4" />
                Copy HTML Snippet
              </>
            )}
          </button>
        </div>
      </div>

      {loading && !data ? (
        <div className="rounded-lg border border-[#283340] bg-[#161D24] p-8 text-sm text-[#8B949E]">
          Building availability calendar preview...
        </div>
      ) : data ? (
        <div className="space-y-6">
          {/* Live Anonymized Calendar Preview */}
          <section
            data-testid="snippet-live-preview"
            className="rounded-lg border border-[#283340] bg-[#161D24] p-4 sm:p-6"
          >
            <div className="mb-3 flex flex-wrap items-baseline justify-between gap-2 border-b border-[#283340] pb-3">
              <h2 className="font-['Plus_Jakarta_Sans'] text-base font-bold text-[#F0F6FC]">
                {singleItem
                  ? `Upcoming Pickup Availability — ${singleItem.itemName}`
                  : `Upcoming Pickup Availability (Next ${data.weeks} Weeks)`}
              </h2>
              <span
                data-testid="snippet-timestamp"
                className="font-mono text-xs tabular-nums text-[#8B949E]"
              >
                Availability accurate as of {data.generatedAtDisplay}
              </span>
            </div>

            {publicItems.length === 0 ? (
              <p className="py-6 text-sm text-[#8B949E]">
                No Tracked Items are flagged &quot;Include in Public Website Availability
                Snippet&quot; yet. Enable this toggle on items in Settings.
              </p>
            ) : (
              <div>
                <div className="mb-3 flex flex-wrap items-center gap-4 text-xs text-[#8B949E]">
                  <span className="inline-flex items-center gap-1.5">
                    <span className="h-2 w-2 rounded-full bg-[#4ADE80]" />
                    Available
                  </span>
                  <span className="inline-flex items-center gap-1.5">
                    <span className="h-2 w-2 rounded-full bg-[#FBBF24]" />
                    Limited
                  </span>
                  <span className="inline-flex items-center gap-1.5">
                    <span className="h-2 w-2 rounded-full bg-[#F87171]" />
                    Waitlist Full
                  </span>
                </div>

                {/* Desktop Mon-Sun weekday headers */}
                <div className="mb-1.5 hidden grid-cols-7 gap-2 md:grid">
                  {WEEKDAYS.map((dayName) => (
                    <div
                      key={dayName}
                      className="px-1 text-[11px] font-semibold uppercase tracking-wider text-[#8B949E]"
                    >
                      {dayName}
                    </div>
                  ))}
                </div>

                {/* Calendar Grid */}
                <div
                  data-testid="snippet-calendar-grid"
                  className="grid grid-cols-1 gap-2 md:grid-cols-7"
                >
                  {calendarDays.map((day) => {
                    if (day.isPast) {
                      return (
                        <div
                          key={day.date}
                          aria-hidden="true"
                          className="hidden min-h-[88px] flex-col rounded-md border border-[#283340]/50 bg-[#0F1419]/50 p-2.5 opacity-40 md:flex"
                        >
                          <span className="font-mono text-xs tabular-nums text-[#8B949E]">
                            {day.displayDate}
                          </span>
                        </div>
                      );
                    }

                    return (
                      <div
                        key={day.date}
                        data-testid={`snippet-day-${day.date}`}
                        className={`flex flex-row flex-wrap items-center justify-between gap-2 rounded-md border p-3 md:min-h-[96px] md:flex-col md:items-stretch md:justify-start md:p-2.5 ${
                          day.isToday
                            ? 'border-[#38BDF8] bg-[#0EA5E9]/10'
                            : 'border-[#283340] bg-[#131920]'
                        }`}
                      >
                        <div>
                          <div className="flex items-center justify-between gap-1">
                            <span className="font-mono text-xs font-semibold tabular-nums text-[#F0F6FC]">
                              <span className="md:hidden">{day.weekdayLabel}, </span>
                              {day.displayDate}
                            </span>
                            {day.isToday && (
                              <span className="text-[10px] font-semibold uppercase tracking-wide text-[#38BDF8]">
                                Today
                              </span>
                            )}
                          </div>
                          {day.channelNames.length > 0 && (
                            <div className="mt-0.5 text-[11px] leading-tight text-[#8B949E]">
                              {day.channelNames.join(' · ')}
                            </div>
                          )}
                        </div>

                        <div className="flex flex-wrap gap-1 md:mt-auto md:flex-col">
                          {day.items.map((item) => {
                            const compactQty =
                              item.approxAvailable <= 0
                                ? 'Waitlist Full'
                                : `~${formatQty(item.approxAvailable)} ${item.unitLabel}`;
                            return singleItem ? (
                              <div
                                key={item.trackedItemId}
                                title={item.approxLabel}
                                className={`rounded px-2 py-1 text-center font-mono text-[11px] font-semibold tabular-nums ${badgeClasses(item.status)}`}
                              >
                                {compactQty}
                              </div>
                            ) : (
                              <div
                                key={item.trackedItemId}
                                title={`${item.itemName}: ${item.approxLabel}`}
                                className={`flex items-center justify-between gap-1.5 rounded px-2 py-1 text-[11px] font-semibold ${badgeClasses(item.status)}`}
                              >
                                <span className="truncate font-sans font-medium">
                                  {item.itemName}
                                </span>
                                <span className="shrink-0 font-mono tabular-nums">
                                  {compactQty}
                                </span>
                              </div>
                            );
                          })}
                        </div>
                      </div>
                    );
                  })}
                </div>

                <p className="mt-3 text-xs text-[#8B949E]">
                  Quantities are approximate post-buffer estimates subject to daily farm harvest.
                </p>
              </div>
            )}
          </section>

          {showRawHtml && (
            <section className="rounded-lg border border-[#283340] bg-[#161D24] p-5">
              <h3 className="mb-2 text-xs font-semibold text-[#C9D1D9]">
                Self-Contained HTML Output
              </h3>
              <textarea
                readOnly
                data-testid="snippet-raw-html-textarea"
                rows={12}
                value={data.html}
                className="w-full rounded-md border border-[#283340] bg-[#0F1419] p-3 font-mono text-xs text-[#C9D1D9]"
              />
            </section>
          )}
        </div>
      ) : null}
    </main>
  );
}
