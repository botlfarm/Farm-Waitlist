import { Check, Code, Copy, RefreshCw, RotateCcw, Save } from 'lucide-react';
import { Fragment, useEffect, useState } from 'react';
import { api, copyTextToClipboard } from '../lib/api';
import {
  DEFAULT_PUBLIC_SNIPPET_FOOTER,
  formatQty,
  parseSafeRichMessageSegments,
} from '../shared/generators';
import type {
  AppSettings,
  PublicAvailabilityCalendarDay,
  PublicAvailabilityResult,
} from '../shared/types';

interface AvailabilitySnippetViewProps {
  defaultWeeks: number;
  settings?: AppSettings;
  onSettingsSaved?: () => Promise<void>;
  onToast?: (message: string, kind?: 'info' | 'error') => void;
}

const WEEKDAYS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];

function InlineSafeRichText({ text }: { text: string }) {
  const segments = parseSafeRichMessageSegments(text);
  return (
    <>
      {segments.map((seg, idx) => {
        if (seg.type === 'newline') {
          return <br key={idx} />;
        }
        if (seg.type === 'link') {
          return (
            <a
              key={idx}
              href={seg.href}
              target="_blank"
              rel="noopener noreferrer"
              className="font-medium text-[#38BDF8] underline decoration-[#38BDF8]/60 underline-offset-2 hover:text-[#7DD3FC]"
            >
              {seg.label}
            </a>
          );
        }
        return <Fragment key={idx}>{seg.text}</Fragment>;
      })}
    </>
  );
}

export function AvailabilitySnippetView({
  defaultWeeks,
  settings,
  onSettingsSaved,
  onToast,
}: AvailabilitySnippetViewProps) {
  const savedHeaderTitle = settings?.publicSnippetHeaderTitle ?? '';
  const savedHeaderText = settings?.publicSnippetHeaderText ?? '';
  const savedFooterText =
    settings?.publicSnippetFooterText !== undefined
      ? settings.publicSnippetFooterText
      : DEFAULT_PUBLIC_SNIPPET_FOOTER;
  const savedAutoAdvance = settings?.publicSnippetAutoAdvanceToday ?? true;

  const [data, setData] = useState<PublicAvailabilityResult | null>(null);
  const [loading, setLoading] = useState(true);
  const [showRawHtml, setShowRawHtml] = useState(false);
  const [copied, setCopied] = useState(false);

  const [headerTitle, setHeaderTitle] = useState(savedHeaderTitle);
  const [headerText, setHeaderText] = useState(savedHeaderText);
  const [footerText, setFooterText] = useState(savedFooterText);
  const [autoAdvanceToday, setAutoAdvanceToday] = useState(savedAutoAdvance);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    setHeaderTitle(savedHeaderTitle);
    setHeaderText(savedHeaderText);
    setFooterText(savedFooterText);
    setAutoAdvanceToday(savedAutoAdvance);
  }, [savedHeaderTitle, savedHeaderText, savedFooterText, savedAutoAdvance]);

  const isDirty =
    headerTitle !== savedHeaderTitle ||
    headerText !== savedHeaderText ||
    footerText !== savedFooterText ||
    autoAdvanceToday !== savedAutoAdvance;

  const loadSnippet = async (): Promise<PublicAvailabilityResult | null> => {
    setLoading(true);
    try {
      const res = await api.getSnippet(defaultWeeks || 3);
      setData(res);
      return res;
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    void loadSnippet();
  }, [defaultWeeks]);

  const saveCustomization = async (overrides?: {
    headerTitle: string;
    headerText: string;
    footerText: string;
    autoAdvanceToday: boolean;
  }): Promise<PublicAvailabilityResult | null> => {
    const payload = overrides ?? {
      headerTitle,
      headerText,
      footerText,
      autoAdvanceToday,
    };
    setSaving(true);
    try {
      await api.updateSettings({
        publicSnippetHeaderTitle: payload.headerTitle,
        publicSnippetHeaderText: payload.headerText,
        publicSnippetFooterText: payload.footerText,
        publicSnippetAutoAdvanceToday: payload.autoAdvanceToday,
      });
      await onSettingsSaved?.();
      const fresh = await loadSnippet();
      onToast?.('Snippet header & footer saved');
      return fresh;
    } catch (err) {
      onToast?.(
        err instanceof Error ? err.message : 'Failed to save snippet settings',
        'error'
      );
      return null;
    } finally {
      setSaving(false);
    }
  };

  const handleResetDefaults = async () => {
    const defaults = {
      headerTitle: '',
      headerText: '',
      footerText: DEFAULT_PUBLIC_SNIPPET_FOOTER,
      autoAdvanceToday: true,
    };
    setHeaderTitle(defaults.headerTitle);
    setHeaderText(defaults.headerText);
    setFooterText(defaults.footerText);
    setAutoAdvanceToday(defaults.autoAdvanceToday);
    await saveCustomization(defaults);
  };

  const handleCopyHtml = async () => {
    let targetData = data;
    if (isDirty) {
      const updated = await saveCustomization();
      if (updated) {
        targetData = updated;
      }
    }
    if (!targetData) return;
    const ok = await copyTextToClipboard(targetData.html);
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

  const autoHeadingTitle = singleItem
    ? `Upcoming Pickup Availability — ${singleItem.itemName}`
    : `Upcoming Pickup Availability (Next ${data?.weeks ?? (defaultWeeks || 3)} Weeks)`;
  const previewHeaderTitle = headerTitle.trim() || autoHeadingTitle;
  const previewHeaderText = headerText.trim();
  const previewFooterText = footerText.trim();

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
            disabled={!data || saving}
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
                {isDirty ? 'Save & Copy HTML' : 'Copy HTML Snippet'}
              </>
            )}
          </button>
        </div>
      </div>

      {/* Customize Header, Footer & Daily Today Behavior */}
      <section
        data-testid="snippet-customize-panel"
        className="mb-6 rounded-lg border border-[#283340] bg-[#161D24] p-4 sm:p-5"
      >
        <div className="flex flex-wrap items-center justify-between gap-2 border-b border-[#283340] pb-3">
          <div>
            <h2 className="font-['Plus_Jakarta_Sans'] text-sm font-bold text-[#F0F6FC]">
              Customize Header &amp; Footer Text
            </h2>
            <p className="mt-0.5 text-xs text-[#8B949E]">
              Personalize the heading, optional intro note, and footer disclaimer. Plain URLs or{' '}
              <code className="font-mono text-[11px] text-[#38BDF8]">
                &lt;a href=&quot;https://...&quot;&gt;links&lt;/a&gt;
              </code>{' '}
              are supported in header &amp; footer text.
            </p>
          </div>
          <div className="flex items-center gap-2">
            <button
              type="button"
              data-testid="snippet-reset-settings-btn"
              disabled={saving}
              onClick={() => void handleResetDefaults()}
              className="inline-flex min-h-[34px] items-center gap-1.5 rounded-md border border-[#283340] bg-[#0F1419] px-3 py-1.5 text-xs font-medium text-[#C9D1D9] hover:border-[#38BDF8] disabled:opacity-45"
            >
              <RotateCcw className="h-3.5 w-3.5" />
              Reset Defaults
            </button>
            <button
              type="button"
              data-testid="snippet-save-settings-btn"
              disabled={saving || !isDirty}
              onClick={() => void saveCustomization()}
              className="inline-flex min-h-[34px] items-center gap-1.5 rounded-md bg-[#0EA5E9] px-3.5 py-1.5 text-xs font-semibold text-[#0B1117] hover:bg-[#38BDF8] disabled:opacity-45"
            >
              <Save className="h-3.5 w-3.5" />
              {saving ? 'Saving...' : 'Save Changes'}
            </button>
          </div>
        </div>

        <div className="mt-4 grid grid-cols-1 gap-4 md:grid-cols-2">
          <div>
            <label
              htmlFor="snippet-header-title"
              className="mb-1 block text-xs font-medium text-[#C9D1D9]"
            >
              Header Title
            </label>
            <input
              id="snippet-header-title"
              data-testid="snippet-header-title-input"
              type="text"
              value={headerTitle}
              onChange={(e) => setHeaderTitle(e.target.value)}
              placeholder={autoHeadingTitle}
              className="min-h-[38px] w-full rounded-md border border-[#283340] bg-[#0F1419] px-3 py-1.5 text-xs text-[#F0F6FC] placeholder:text-[#6E7681] focus:border-[#38BDF8] focus:outline-none"
            />
            <p className="mt-1 text-[11px] text-[#8B949E]">
              Leave blank to use the automatic title.
            </p>
          </div>

          <div>
            <label
              htmlFor="snippet-footer-text"
              className="mb-1 block text-xs font-medium text-[#C9D1D9]"
            >
              Footer Text
            </label>
            <textarea
              id="snippet-footer-text"
              data-testid="snippet-footer-text-input"
              rows={2}
              value={footerText}
              onChange={(e) => setFooterText(e.target.value)}
              placeholder="Leave blank to hide footer"
              className="w-full rounded-md border border-[#283340] bg-[#0F1419] px-3 py-2 text-xs text-[#F0F6FC] placeholder:text-[#6E7681] focus:border-[#38BDF8] focus:outline-none"
            />
          </div>

          <div className="md:col-span-2">
            <label
              htmlFor="snippet-header-text"
              className="mb-1 block text-xs font-medium text-[#C9D1D9]"
            >
              Header Intro Text (Optional — shown above calendar)
            </label>
            <textarea
              id="snippet-header-text"
              data-testid="snippet-header-text-input"
              rows={2}
              value={headerText}
              onChange={(e) => setHeaderText(e.target.value)}
              placeholder='e.g., Request eggs on our waitlist or visit <a href="https://botlfarm.com/shop">our farm store</a>.'
              className="w-full rounded-md border border-[#283340] bg-[#0F1419] px-3 py-2 text-xs text-[#F0F6FC] placeholder:text-[#6E7681] focus:border-[#38BDF8] focus:outline-none"
            />
          </div>

          <div className="md:col-span-2">
            <label className="flex cursor-pointer items-start gap-2.5 rounded-md border border-[#283340]/80 bg-[#0F1419] px-3 py-2.5 text-xs">
              <input
                type="checkbox"
                data-testid="snippet-auto-advance-checkbox"
                checked={autoAdvanceToday}
                onChange={(e) => setAutoAdvanceToday(e.target.checked)}
                className="mt-0.5 h-4 w-4 accent-[#0EA5E9]"
              />
              <span>
                <span className="font-semibold text-[#F0F6FC]">
                  Auto-advance &ldquo;Today&rdquo; each day on your website
                </span>
                <span className="mt-0.5 block text-[11px] text-[#8B949E]">
                  Includes a tiny script so the &ldquo;Today&rdquo; highlight moves forward and past
                  days fade/hide automatically each morning in your farm&apos;s timezone (works in
                  Odoo Embed Code blocks; safely degrades if a CMS strips scripts). Note:
                  availability quantities remain a snapshot from the timestamp below until you copy
                  and paste a fresh snippet.
                </span>
              </span>
            </label>
          </div>
        </div>
      </section>

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
              <h2
                data-testid="snippet-preview-title"
                className="font-['Plus_Jakarta_Sans'] text-base font-bold text-[#F0F6FC]"
              >
                {previewHeaderTitle}
              </h2>
              <span
                data-testid="snippet-timestamp"
                className="font-mono text-xs tabular-nums text-[#8B949E]"
              >
                Availability accurate as of {data.generatedAtDisplay}
              </span>
            </div>

            {previewHeaderText && (
              <p
                data-testid="snippet-preview-header-text"
                className="mb-3 text-sm leading-relaxed text-[#C9D1D9]"
              >
                <InlineSafeRichText text={previewHeaderText} />
              </p>
            )}

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
              </div>
            )}

            {previewFooterText && (
              <p
                data-testid="snippet-preview-footer-text"
                className="mt-3 text-xs leading-relaxed text-[#8B949E]"
              >
                <InlineSafeRichText text={previewFooterText} />
              </p>
            )}
          </section>

          {showRawHtml && (
            <section className="rounded-lg border border-[#283340] bg-[#161D24] p-5">
              <div className="mb-2 flex items-center justify-between gap-2">
                <h3 className="text-xs font-semibold text-[#C9D1D9]">
                  Self-Contained HTML Output
                </h3>
                {isDirty && (
                  <span className="text-[11px] text-[#FBBF24]">
                    Save changes (or click &ldquo;Save &amp; Copy HTML&rdquo;) to refresh the raw
                    HTML output.
                  </span>
                )}
              </div>
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
