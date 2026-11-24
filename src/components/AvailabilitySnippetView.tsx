import {
  Check,
  ChevronDown,
  ChevronRight,
  Clock,
  CloudUpload,
  Code,
  Copy,
  PauseCircle,
  PlayCircle,
  Plus,
  RefreshCw,
  RotateCcw,
  Save,
  Trash2,
  Wifi,
} from 'lucide-react';
import { Fragment, useEffect, useMemo, useState } from 'react';
import { api, copyTextToClipboard } from '../lib/api';
import {
  DEFAULT_PAUSED_SNIPPET_MESSAGE,
  DEFAULT_PUBLIC_SNIPPET_FOOTER,
  PAUSED_SNIPPET_PRESETS,
  evaluateDateOrderingClosed,
  formatQty,
  generateLiveEmbedHtml,
  isSafeHttpUrl,
  normalizeCutoffRules,
  parseSafeRichMessageSegments,
} from '../shared/generators';
import { DEFAULT_TIMEZONE, formatLocalTimeHHMM, getTodayDateKey } from '../shared/timezone';
import type {
  AppSettings,
  GithubPublishInterval,
  GithubPublishMode,
  GithubPublishStatus,
  PublicAvailabilityCalendarDay,
  PublicAvailabilityResult,
  SnippetCutoffRule,
} from '../shared/types';

interface AvailabilitySnippetViewProps {
  defaultWeeks: number;
  settings?: AppSettings;
  githubPublishStatus?: GithubPublishStatus;
  onSettingsSaved?: () => Promise<void>;
  onToast?: (message: string, kind?: 'info' | 'error') => void;
}

const WEEKDAYS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
const FULL_WEEKDAYS: Array<{ iso: number; label: string; short: string }> = [
  { iso: 1, label: 'Monday', short: 'Mon' },
  { iso: 2, label: 'Tuesday', short: 'Tue' },
  { iso: 3, label: 'Wednesday', short: 'Wed' },
  { iso: 4, label: 'Thursday', short: 'Thu' },
  { iso: 5, label: 'Friday', short: 'Fri' },
  { iso: 6, label: 'Saturday', short: 'Sat' },
  { iso: 7, label: 'Sunday', short: 'Sun' },
];

function format12HourTime(hhmm: string): string {
  const parts = hhmm.split(':');
  if (parts.length !== 2) return hhmm;
  const h = Number(parts[0]);
  const m = parts[1];
  if (!Number.isFinite(h)) return hhmm;
  const suffix = h >= 12 ? 'PM' : 'AM';
  const hr12 = h % 12 === 0 ? 12 : h % 12;
  return `${hr12}:${m} ${suffix}`;
}

function describeCutoffRule(rule: SnippetCutoffRule): string {
  const timeLabel = format12HourTime(rule.cutoffTime);
  const pickupLabel =
    rule.pickupWeekdays.length === 0
      ? 'all pickup days'
      : rule.pickupWeekdays
          .map((d) => FULL_WEEKDAYS.find((w) => w.iso === d)?.short ?? '')
          .filter(Boolean)
          .join(', ') + ' pickups';

  if (rule.mode === 'weekly_day') {
    const dayName = FULL_WEEKDAYS.find((w) => w.iso === rule.cutoffWeekday)?.label ?? 'Friday';
    return `Closes ${pickupLabel} every ${dayName} at ${timeLabel}`;
  }
  if (rule.daysBefore === 0) {
    return `Closes ${pickupLabel} same day at ${timeLabel}`;
  }
  if (rule.daysBefore === 1) {
    return `Closes ${pickupLabel} 1 day before at ${timeLabel}`;
  }
  return `Closes ${pickupLabel} ${rule.daysBefore} days before at ${timeLabel}`;
}

function derivePreviewPublicUrl(
  rawRepo: string,
  rawPath: string,
  customPublicUrl: string
): string | null {
  const custom = customPublicUrl.trim();
  if (custom) {
    return isSafeHttpUrl(custom) ? custom : null;
  }
  const cleanedRepo = rawRepo
    .trim()
    .replace(/^https?:\/\/(www\.)?github\.com\//i, '')
    .replace(/\.git$/i, '')
    .replace(/^\/+|\/+$/g, '');
  const match = /^([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+)$/.exec(cleanedRepo);
  if (!match) return null;
  const owner = match[1];
  const repoName = match[2];
  const cleanedPath = (rawPath.trim() || 'availability.json').replace(/^\/+|\/+$/g, '');
  if (!cleanedPath || cleanedPath.includes('..')) return null;
  const encodedPath = cleanedPath
    .split('/')
    .map((s) => encodeURIComponent(s))
    .join('/');
  if (repoName.toLowerCase() === `${owner.toLowerCase()}.github.io`) {
    return `https://${owner.toLowerCase()}.github.io/${encodedPath}`;
  }
  return `https://${owner.toLowerCase()}.github.io/${encodeURIComponent(repoName)}/${encodedPath}`;
}

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
  githubPublishStatus,
  onSettingsSaved,
  onToast,
}: AvailabilitySnippetViewProps) {
  const savedWeeks = settings?.publicSnippetWeeks ?? defaultWeeks ?? 3;
  const savedEnabled = settings?.publicSnippetEnabled !== false;
  const savedPausedPreset = settings?.publicSnippetPausedPreset ?? 'unknown';
  const savedPausedMessage =
    settings?.publicSnippetPausedMessage !== undefined
      ? settings.publicSnippetPausedMessage
      : DEFAULT_PAUSED_SNIPPET_MESSAGE;
  const savedShowSameDay = settings?.publicSnippetShowSameDay !== false;
  const savedCutoffRules = useMemo(
    () => normalizeCutoffRules(settings?.publicSnippetCutoffRules ?? []),
    [settings?.publicSnippetCutoffRules]
  );
  const savedHeaderTitle = settings?.publicSnippetHeaderTitle ?? '';
  const savedHeaderText = settings?.publicSnippetHeaderText ?? '';
  const savedFooterText =
    settings?.publicSnippetFooterText !== undefined
      ? settings.publicSnippetFooterText
      : DEFAULT_PUBLIC_SNIPPET_FOOTER;
  const savedAutoAdvance = settings?.publicSnippetAutoAdvanceToday ?? true;

  const savedGithubMode: GithubPublishMode =
    settings?.githubPublishMode === 'auto' ? 'auto' : 'manual';
  const savedGithubInterval: GithubPublishInterval = settings?.githubPublishInterval ?? '30m';
  const savedGithubIdleMinutes = settings?.githubPublishIdleMinutes ?? 15;
  const savedGithubRepo = settings?.githubPublishRepo ?? githubPublishStatus?.repo ?? '';
  const savedGithubBranch = settings?.githubPublishBranch ?? 'main';
  const savedGithubPath = settings?.githubPublishPath ?? 'availability.json';
  const savedGithubPublicUrl = settings?.githubPublishPublicUrl ?? '';

  const [data, setData] = useState<PublicAvailabilityResult | null>(null);
  const [loading, setLoading] = useState(true);
  const [showCodeDrawer, setShowCodeDrawer] = useState(false);
  const [codeViewMode, setCodeViewMode] = useState<'static' | 'live'>('static');
  const [copiedStatic, setCopiedStatic] = useState(false);
  const [copiedLive, setCopiedLive] = useState(false);

  // Snippet controls state
  const [weeks, setWeeks] = useState<number>(savedWeeks);
  const [snippetEnabled, setSnippetEnabled] = useState<boolean>(savedEnabled);
  const [pausedPreset, setPausedPreset] = useState<string>(savedPausedPreset);
  const [pausedMessage, setPausedMessage] = useState<string>(savedPausedMessage);
  const [showSameDay, setShowSameDay] = useState<boolean>(savedShowSameDay);
  const [cutoffRules, setCutoffRules] = useState<SnippetCutoffRule[]>(savedCutoffRules);
  const [headerTitle, setHeaderTitle] = useState<string>(savedHeaderTitle);
  const [headerText, setHeaderText] = useState<string>(savedHeaderText);
  const [footerText, setFooterText] = useState<string>(savedFooterText);
  const [autoAdvanceToday, setAutoAdvanceToday] = useState<boolean>(savedAutoAdvance);

  // GitHub Pages publish state
  const [githubMode, setGithubMode] = useState<GithubPublishMode>(savedGithubMode);
  const [githubInterval, setGithubInterval] = useState<GithubPublishInterval>(savedGithubInterval);
  const [githubIdleMinutes, setGithubIdleMinutes] = useState<number>(savedGithubIdleMinutes);
  const [githubRepo, setGithubRepo] = useState<string>(savedGithubRepo);
  const [githubBranch, setGithubBranch] = useState<string>(savedGithubBranch);
  const [githubPath, setGithubPath] = useState<string>(savedGithubPath);
  const [githubPublicUrl, setGithubPublicUrl] = useState<string>(savedGithubPublicUrl);
  const [liveStatus, setLiveStatus] = useState<GithubPublishStatus | undefined>(
    githubPublishStatus
  );
  const [showSetupGuide, setShowSetupGuide] = useState(false);

  const [saving, setSaving] = useState(false);
  const [testingGithub, setTestingGithub] = useState(false);
  const [publishingGithub, setPublishingGithub] = useState(false);
  const [githubTestResult, setGithubTestResult] = useState<{
    ok: boolean;
    message: string;
  } | null>(null);

  useEffect(() => {
    setWeeks(savedWeeks);
    setSnippetEnabled(savedEnabled);
    setPausedPreset(savedPausedPreset);
    setPausedMessage(savedPausedMessage);
    setShowSameDay(savedShowSameDay);
    setCutoffRules(savedCutoffRules);
    setHeaderTitle(savedHeaderTitle);
    setHeaderText(savedHeaderText);
    setFooterText(savedFooterText);
    setAutoAdvanceToday(savedAutoAdvance);
    setGithubMode(savedGithubMode);
    setGithubInterval(savedGithubInterval);
    setGithubIdleMinutes(savedGithubIdleMinutes);
    setGithubRepo(savedGithubRepo);
    setGithubBranch(savedGithubBranch);
    setGithubPath(savedGithubPath);
    setGithubPublicUrl(savedGithubPublicUrl);
  }, [
    savedWeeks,
    savedEnabled,
    savedPausedPreset,
    savedPausedMessage,
    savedShowSameDay,
    savedCutoffRules,
    savedHeaderTitle,
    savedHeaderText,
    savedFooterText,
    savedAutoAdvance,
    savedGithubMode,
    savedGithubInterval,
    savedGithubIdleMinutes,
    savedGithubRepo,
    savedGithubBranch,
    savedGithubPath,
    savedGithubPublicUrl,
  ]);

  useEffect(() => {
    if (githubPublishStatus) {
      setLiveStatus(githubPublishStatus);
    }
  }, [githubPublishStatus]);

  const isDirty =
    weeks !== savedWeeks ||
    snippetEnabled !== savedEnabled ||
    pausedPreset !== savedPausedPreset ||
    pausedMessage !== savedPausedMessage ||
    showSameDay !== savedShowSameDay ||
    JSON.stringify(cutoffRules) !== JSON.stringify(savedCutoffRules) ||
    headerTitle !== savedHeaderTitle ||
    headerText !== savedHeaderText ||
    footerText !== savedFooterText ||
    autoAdvanceToday !== savedAutoAdvance ||
    githubMode !== savedGithubMode ||
    githubInterval !== savedGithubInterval ||
    githubIdleMinutes !== savedGithubIdleMinutes ||
    githubRepo !== savedGithubRepo ||
    githubBranch !== savedGithubBranch ||
    githubPath !== savedGithubPath ||
    githubPublicUrl !== savedGithubPublicUrl;

  const loadSnippet = async (targetWeeks: number = weeks): Promise<PublicAvailabilityResult | null> => {
    setLoading(true);
    try {
      const res = await api.getSnippet(Math.max(1, Math.min(8, targetWeeks || 3)));
      setData(res);
      if (res.githubPublishStatus) {
        setLiveStatus(res.githubPublishStatus);
      }
      return res;
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    void loadSnippet(savedWeeks);
  }, [savedWeeks]);

  const saveAllSettings = async (
    overrides?: Partial<AppSettings>,
    quietToast = false
  ): Promise<PublicAvailabilityResult | null> => {
    const targetWeeks = overrides?.publicSnippetWeeks ?? weeks;
    const patch: Partial<AppSettings> = {
      publicSnippetWeeks: Math.max(1, Math.min(8, Number(targetWeeks) || 3)),
      publicSnippetEnabled: snippetEnabled,
      publicSnippetPausedPreset: pausedPreset,
      publicSnippetPausedMessage: pausedMessage,
      publicSnippetShowSameDay: showSameDay,
      publicSnippetCutoffRules: cutoffRules,
      publicSnippetHeaderTitle: headerTitle,
      publicSnippetHeaderText: headerText,
      publicSnippetFooterText: footerText,
      publicSnippetAutoAdvanceToday: autoAdvanceToday,
      githubPublishMode: githubMode,
      githubPublishInterval: githubInterval,
      githubPublishIdleMinutes: githubIdleMinutes,
      githubPublishRepo: githubRepo.trim(),
      githubPublishBranch: githubBranch.trim() || 'main',
      githubPublishPath: githubPath.trim() || 'availability.json',
      githubPublishPublicUrl: githubPublicUrl.trim(),
      ...overrides,
    };

    setSaving(true);
    try {
      const res = await api.updateSettings(patch);
      if (res.githubPublishStatus) {
        setLiveStatus(res.githubPublishStatus);
      }
      await onSettingsSaved?.();
      const fresh = await loadSnippet(patch.publicSnippetWeeks ?? weeks);
      if (!quietToast) {
        onToast?.('Availability snippet settings saved');
      }
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

  const handleResetTextDefaults = async () => {
    setHeaderTitle('');
    setHeaderText('');
    setFooterText(DEFAULT_PUBLIC_SNIPPET_FOOTER);
    setAutoAdvanceToday(true);
    await saveAllSettings({
      publicSnippetHeaderTitle: '',
      publicSnippetHeaderText: '',
      publicSnippetFooterText: DEFAULT_PUBLIC_SNIPPET_FOOTER,
      publicSnippetAutoAdvanceToday: true,
    });
  };

  const handleCopyStaticHtml = async () => {
    let targetData = data;
    if (isDirty) {
      const updated = await saveAllSettings(undefined, true);
      if (updated) targetData = updated;
    }
    if (!targetData) return;
    const ok = await copyTextToClipboard(targetData.html);
    if (ok) {
      setCopiedStatic(true);
      onToast?.('Copied static HTML snippet to clipboard');
      setTimeout(() => setCopiedStatic(false), 2500);
    }
  };

  const previewPublicUrl = useMemo(
    () =>
      derivePreviewPublicUrl(githubRepo, githubPath, githubPublicUrl) ??
      liveStatus?.publicUrl ??
      null,
    [githubRepo, githubPath, githubPublicUrl, liveStatus?.publicUrl]
  );

  const liveEmbedCode = useMemo(() => {
    if (previewPublicUrl) {
      return generateLiveEmbedHtml(previewPublicUrl);
    }
    return data?.liveEmbedHtml ?? '';
  }, [previewPublicUrl, data?.liveEmbedHtml]);

  const handleCopyLiveEmbed = async () => {
    let embed = liveEmbedCode;
    if (isDirty) {
      const updated = await saveAllSettings(undefined, true);
      if (updated?.liveEmbedHtml) {
        embed = updated.liveEmbedHtml;
      }
    }
    if (!embed) {
      onToast?.('Enter your GitHub repository (owner/repo) first to generate Live Embed Code.', 'error');
      return;
    }
    const ok = await copyTextToClipboard(embed);
    if (ok) {
      setCopiedLive(true);
      onToast?.('Copied Live Embed Code — paste once into your Odoo Website Embed Code block');
      setTimeout(() => setCopiedLive(false), 2500);
    }
  };

  const handleTestGithub = async () => {
    setTestingGithub(true);
    setGithubTestResult(null);
    try {
      const res = await api.testGithubPublish({
        repo: githubRepo.trim(),
        branch: githubBranch.trim() || 'main',
        filePath: githubPath.trim() || 'availability.json',
        publicUrl: githubPublicUrl.trim(),
      });
      setGithubTestResult({ ok: res.ok, message: res.message });
    } catch (err) {
      setGithubTestResult({
        ok: false,
        message: err instanceof Error ? err.message : 'GitHub connection test failed',
      });
    } finally {
      setTestingGithub(false);
    }
  };

  const handlePublishNow = async () => {
    setPublishingGithub(true);
    try {
      if (isDirty) {
        const saved = await saveAllSettings(undefined, true);
        if (!saved) {
          setPublishingGithub(false);
          return;
        }
      }
      const res = await api.publishSnippetToGithub({
        force: true,
        repo: githubRepo.trim(),
        branch: githubBranch.trim() || 'main',
        filePath: githubPath.trim() || 'availability.json',
        publicUrl: githubPublicUrl.trim(),
      });
      setLiveStatus(res.githubPublishStatus);
      await onSettingsSaved?.();
      await loadSnippet(weeks);
      if (res.published) {
        onToast?.(
          snippetEnabled
            ? 'Published live availability snapshot to GitHub Pages'
            : 'Published paused waitlist notice to GitHub Pages'
        );
      } else {
        onToast?.(res.reason || 'No changes to publish');
      }
    } catch (err) {
      onToast?.(
        err instanceof Error ? err.message : 'Failed to publish availability to GitHub',
        'error'
      );
      await onSettingsSaved?.();
    } finally {
      setPublishingGithub(false);
    }
  };

  const addCutoffRule = (preset: '1day' | '2days' | 'friday' | 'custom') => {
    const id = `cutoff-${Date.now()}-${Math.floor(Math.random() * 1000)}`;
    let nextRule: SnippetCutoffRule;
    if (preset === '1day') {
      nextRule = {
        id,
        enabled: true,
        mode: 'days_before',
        daysBefore: 1,
        cutoffWeekday: 5,
        cutoffTime: '16:00',
        pickupWeekdays: [],
      };
    } else if (preset === '2days') {
      nextRule = {
        id,
        enabled: true,
        mode: 'days_before',
        daysBefore: 2,
        cutoffWeekday: 5,
        cutoffTime: '16:00',
        pickupWeekdays: [],
      };
    } else if (preset === 'friday') {
      nextRule = {
        id,
        enabled: true,
        mode: 'weekly_day',
        daysBefore: 1,
        cutoffWeekday: 5, // Friday
        cutoffTime: '16:00',
        pickupWeekdays: [6, 7], // Sat, Sun
      };
    } else {
      nextRule = {
        id,
        enabled: true,
        mode: 'days_before',
        daysBefore: 1,
        cutoffWeekday: 5,
        cutoffTime: '16:00',
        pickupWeekdays: [],
      };
    }
    setCutoffRules((prev) => [...prev, nextRule]);
  };

  const updateCutoffRule = (id: string, patch: Partial<SnippetCutoffRule>) => {
    setCutoffRules((prev) =>
      prev.map((rule) => (rule.id === id ? { ...rule, ...patch } : rule))
    );
  };

  const toggleCutoffPickupWeekday = (id: string, isoDay: number) => {
    setCutoffRules((prev) =>
      prev.map((rule) => {
        if (rule.id !== id) return rule;
        const exists = rule.pickupWeekdays.includes(isoDay);
        const nextDays = exists
          ? rule.pickupWeekdays.filter((d) => d !== isoDay)
          : [...rule.pickupWeekdays, isoDay].sort((a, b) => a - b);
        return { ...rule, pickupWeekdays: nextDays };
      })
    );
  };

  const removeCutoffRule = (id: string) => {
    setCutoffRules((prev) => prev.filter((rule) => rule.id !== id));
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

  const timezone = settings?.timezone ?? data?.timezone ?? DEFAULT_TIMEZONE;
  const nowRef = useMemo(() => new Date(), [data?.generatedAtDisplay]);
  const previewToday = useMemo(
    () =>
      data?.calendarDays.find((d) => d.isToday)?.date ?? getTodayDateKey(timezone, nowRef),
    [data?.calendarDays, timezone, nowRef]
  );
  const previewTimeHHMM = useMemo(() => formatLocalTimeHHMM(nowRef, timezone), [nowRef, timezone]);

  const calendarDays: PublicAvailabilityCalendarDay[] = data?.calendarDays ?? [];
  const firstActiveDay = calendarDays.find((d) => !d.isPast) ?? data?.days[0];
  const publicItems = firstActiveDay?.items ?? [];
  const singleItem = publicItems.length === 1 ? publicItems[0] : null;

  const autoHeadingTitle = singleItem
    ? `Upcoming Pickup Availability — ${singleItem.itemName}`
    : `Upcoming Pickup Availability (Next ${weeks || 3} Weeks)`;
  const previewHeaderTitle = headerTitle.trim() || autoHeadingTitle;
  const previewHeaderText = headerText.trim();
  const previewFooterText = footerText.trim();
  const previewPausedMessage = pausedMessage.trim() || DEFAULT_PAUSED_SNIPPET_MESSAGE;
  const hasCutoffLegend = !showSameDay || cutoffRules.some((r) => r.enabled);

  const tokenSourceLabel = liveStatus?.tokenConfigured
    ? liveStatus.tokenSource === 'ha_options'
      ? 'Token configured via Home Assistant Add-on'
      : 'Token configured via .env'
    : 'Token not configured yet';

  return (
    <main
      className="mx-auto max-w-6xl px-4 py-6 sm:px-6 sm:py-8"
      data-testid="availability-snippet-view"
    >
      {/* Page Header & Primary Actions */}
      <div className="mb-6 flex flex-wrap items-start justify-between gap-4">
        <div>
          <h1 className="font-['Plus_Jakarta_Sans'] text-2xl font-bold text-[#F0F6FC]">
            Public Website Availability Snippet
          </h1>
          <p className="mt-1 max-w-2xl text-sm text-[#8B949E]">
            Publish a live, anonymized {weeks}-week pickup calendar (or paused off-season notice) to
            your website with zero customer names exposed.
          </p>
        </div>

        <div className="flex flex-wrap items-center gap-2">
          <button
            type="button"
            onClick={() => void loadSnippet(weeks)}
            className="inline-flex min-h-[40px] items-center gap-1.5 rounded-md border border-[#283340] bg-[#161D24] px-3.5 py-2 text-xs font-medium text-[#E6EDF3] hover:border-[#38BDF8]"
          >
            <RefreshCw className={`h-3.5 w-3.5 ${loading ? 'animate-spin' : ''}`} />
            Refresh
          </button>
          <button
            type="button"
            data-testid="toggle-raw-html-btn"
            onClick={() => setShowCodeDrawer((prev) => !prev)}
            className="inline-flex min-h-[40px] items-center gap-1.5 rounded-md border border-[#283340] bg-[#161D24] px-3.5 py-2 text-xs font-medium text-[#E6EDF3] hover:border-[#38BDF8]"
          >
            <Code className="h-3.5 w-3.5" />
            {showCodeDrawer ? 'Hide Code' : 'View Code'}
          </button>
          <button
            type="button"
            disabled={!data || saving}
            data-testid="copy-html-snippet-btn"
            onClick={() => void handleCopyStaticHtml()}
            className="inline-flex min-h-[40px] items-center gap-2 rounded-md border border-[#283340] bg-[#161D24] px-4 py-2 text-xs font-semibold text-[#F0F6FC] transition-colors hover:border-[#38BDF8] disabled:opacity-45"
          >
            {copiedStatic ? (
              <>
                <Check className="h-4 w-4 text-[#4ADE80]" />
                Copied Static HTML
              </>
            ) : (
              <>
                <Copy className="h-4 w-4" />
                {isDirty ? 'Save & Copy Static HTML' : 'Copy Static HTML'}
              </>
            )}
          </button>
          <button
            type="button"
            data-testid="snippet-save-settings-btn"
            disabled={saving || !isDirty}
            onClick={() => void saveAllSettings()}
            className="inline-flex min-h-[40px] items-center gap-2 rounded-md bg-[#0EA5E9] px-4 py-2 text-xs font-semibold text-[#0B1117] transition-colors hover:bg-[#38BDF8] disabled:opacity-45"
          >
            <Save className="h-4 w-4" />
            {saving ? 'Saving...' : isDirty ? 'Save Settings' : 'Saved'}
          </button>
        </div>
      </div>

      {/* SECTION 1: Snippet Status (Active vs Paused), Horizon & Flexible Ordering Cutoffs */}
      <section
        data-testid="snippet-rules-panel"
        className="mb-6 rounded-lg border border-[#283340] bg-[#161D24] p-4 sm:p-5"
      >
        <div className="flex flex-wrap items-center justify-between gap-3 border-b border-[#283340] pb-4">
          <div>
            <h2 className="font-['Plus_Jakarta_Sans'] text-sm font-bold text-[#F0F6FC]">
              Waitlist Display Mode &amp; Ordering Rules
            </h2>
            <p className="mt-0.5 text-xs text-[#8B949E]">
              Show the live availability calendar or pause it with a custom notice during off-season
              or breaks.
            </p>
          </div>

          <div
            role="group"
            aria-label="Waitlist snippet mode"
            className="inline-flex rounded-md border border-[#283340] bg-[#0F1419] p-1"
          >
            <button
              type="button"
              data-testid="snippet-mode-active"
              onClick={() => setSnippetEnabled(true)}
              className={`inline-flex min-h-[34px] items-center gap-1.5 rounded px-3 py-1.5 text-xs font-semibold transition-colors ${
                snippetEnabled
                  ? 'bg-[#0EA5E9] text-[#0B1117]'
                  : 'text-[#8B949E] hover:text-[#E6EDF3]'
              }`}
            >
              <PlayCircle className="h-3.5 w-3.5" />
              Active Calendar
            </button>
            <button
              type="button"
              data-testid="snippet-mode-paused"
              onClick={() => setSnippetEnabled(false)}
              className={`inline-flex min-h-[34px] items-center gap-1.5 rounded px-3 py-1.5 text-xs font-semibold transition-colors ${
                !snippetEnabled
                  ? 'bg-[#D97706] text-[#0B1117]'
                  : 'text-[#8B949E] hover:text-[#E6EDF3]'
              }`}
            >
              <PauseCircle className="h-3.5 w-3.5" />
              Paused / Off-Season
            </button>
          </div>
        </div>

        {!snippetEnabled ? (
          <div className="mt-4 space-y-3" data-testid="snippet-paused-controls">
            <div>
              <span className="mb-1.5 block text-xs font-medium text-[#C9D1D9]">
                Quick Paused Message Presets
              </span>
              <div className="flex flex-wrap gap-2">
                {PAUSED_SNIPPET_PRESETS.map((preset) => {
                  const selected = pausedPreset === preset.id;
                  return (
                    <button
                      key={preset.id}
                      type="button"
                      data-testid={`snippet-paused-preset-${preset.id}`}
                      onClick={() => {
                        setPausedPreset(preset.id);
                        if (preset.message) {
                          setPausedMessage(preset.message);
                        }
                      }}
                      className={`min-h-[36px] rounded-md border px-3 py-1.5 text-xs font-medium transition-colors ${
                        selected
                          ? 'border-[#D97706] bg-[#D97706]/15 text-[#FBBF24]'
                          : 'border-[#283340] bg-[#0F1419] text-[#C9D1D9] hover:border-[#38BDF8]'
                      }`}
                    >
                      {preset.label}
                    </button>
                  );
                })}
              </div>
            </div>

            <div>
              <label
                htmlFor="snippet-paused-message"
                className="mb-1 block text-xs font-medium text-[#C9D1D9]"
              >
                Message Shown on Website While Paused
              </label>
              <textarea
                id="snippet-paused-message"
                data-testid="snippet-paused-message-input"
                rows={3}
                value={pausedMessage}
                onChange={(e) => {
                  setPausedMessage(e.target.value);
                  const matchingPreset = PAUSED_SNIPPET_PRESETS.find(
                    (p) => p.message && p.message === e.target.value
                  );
                  setPausedPreset(matchingPreset ? matchingPreset.id : 'custom');
                }}
                placeholder="Availability is currently unknown — please check back soon."
                className="w-full rounded-md border border-[#283340] bg-[#0F1419] px-3 py-2 text-xs text-[#F0F6FC] placeholder:text-[#6E7681] focus:border-[#38BDF8] focus:outline-none"
              />
              <p className="mt-1 text-[11px] text-[#8B949E]">
                Replaces the calendar grid in both the Static HTML snippet and your live GitHub
                Pages feed until you switch back to Active Calendar. Supports safe{' '}
                <code className="font-mono text-[#38BDF8]">https://</code> links.
              </p>
            </div>
          </div>
        ) : (
          <div className="mt-4 space-y-5">
            {/* Horizon + Same-Day Availability */}
            <div className="grid grid-cols-1 gap-4 md:grid-cols-12">
              <div className="md:col-span-4">
                <label
                  htmlFor="snippet-weeks-ahead"
                  className="mb-1 block text-xs font-medium text-[#C9D1D9]"
                >
                  Weeks Shown on Widget
                </label>
                <div className="flex items-center gap-2">
                  <input
                    id="snippet-weeks-ahead"
                    data-testid="snippet-weeks-input"
                    type="number"
                    min={1}
                    max={8}
                    value={weeks}
                    onChange={(e) => {
                      const nextVal = Math.max(1, Math.min(8, Number(e.target.value) || 1));
                      setWeeks(nextVal);
                      void loadSnippet(nextVal);
                    }}
                    className="min-h-[40px] w-24 rounded-md border border-[#283340] bg-[#0F1419] px-3 py-2 font-mono text-sm tabular-nums text-[#F0F6FC] focus:border-[#38BDF8] focus:outline-none"
                  />
                  <span className="text-xs text-[#8B949E]">weeks ahead (1–8)</span>
                </div>
              </div>

              <div className="md:col-span-8">
                <span className="mb-1 block text-xs font-medium text-[#C9D1D9]">
                  Same-Day Pickup Visibility
                </span>
                <label className="flex min-h-[40px] cursor-pointer items-center gap-2.5 rounded-md border border-[#283340] bg-[#0F1419] px-3 py-2 text-xs">
                  <input
                    type="checkbox"
                    data-testid="snippet-show-same-day-checkbox"
                    checked={showSameDay}
                    onChange={(e) => setShowSameDay(e.target.checked)}
                    className="h-4 w-4 accent-[#0EA5E9]"
                  />
                  <span className="text-[#E6EDF3]">
                    Show same-day availability for Today{' '}
                    <span className="text-[#8B949E]">
                      (when unchecked, Today displays &ldquo;Ordering Closed&rdquo;)
                    </span>
                  </span>
                </label>
              </div>
            </div>

            {/* Flexible Ordering Cutoff Rules */}
            <div
              data-testid="snippet-cutoff-rules-section"
              className="rounded-md border border-[#283340] bg-[#0F1419] p-4"
            >
              <div className="flex flex-wrap items-start justify-between gap-3">
                <div>
                  <div className="flex items-center gap-1.5 text-xs font-semibold text-[#F0F6FC]">
                    <Clock className="h-3.5 w-3.5 text-[#38BDF8]" />
                    Flexible Ordering Cutoff Rules
                  </div>
                  <p className="mt-0.5 text-[11px] text-[#8B949E]">
                    Close ordering on any lead time (e.g., 4:00 PM the day before, 2 days ahead, or
                    every Friday at 4:00 PM for weekend pickups). Closed dates display{' '}
                    <span className="font-medium text-[#C9D1D9]">Ordering Closed</span>.
                  </p>
                </div>

                <div className="flex flex-wrap items-center gap-1.5">
                  <button
                    type="button"
                    data-testid="add-cutoff-preset-1day"
                    onClick={() => addCutoffRule('1day')}
                    className="inline-flex min-h-[32px] items-center gap-1 rounded border border-[#283340] bg-[#161D24] px-2.5 py-1 text-[11px] font-medium text-[#C9D1D9] hover:border-[#38BDF8] hover:text-[#F0F6FC]"
                  >
                    <Plus className="h-3 w-3" />
                    Day Before 4 PM
                  </button>
                  <button
                    type="button"
                    data-testid="add-cutoff-preset-2days"
                    onClick={() => addCutoffRule('2days')}
                    className="inline-flex min-h-[32px] items-center gap-1 rounded border border-[#283340] bg-[#161D24] px-2.5 py-1 text-[11px] font-medium text-[#C9D1D9] hover:border-[#38BDF8] hover:text-[#F0F6FC]"
                  >
                    <Plus className="h-3 w-3" />
                    2 Days Before 4 PM
                  </button>
                  <button
                    type="button"
                    data-testid="add-cutoff-preset-fri"
                    onClick={() => addCutoffRule('friday')}
                    className="inline-flex min-h-[32px] items-center gap-1 rounded border border-[#283340] bg-[#161D24] px-2.5 py-1 text-[11px] font-medium text-[#C9D1D9] hover:border-[#38BDF8] hover:text-[#F0F6FC]"
                  >
                    <Plus className="h-3 w-3" />
                    Every Friday 4 PM (Sat/Sun)
                  </button>
                </div>
              </div>

              {cutoffRules.length === 0 ? (
                <p className="mt-3 text-xs text-[#6E7681]">
                  No cutoff rules configured — all upcoming dates stay open until their pickup day
                  passes.
                </p>
              ) : (
                <div className="mt-3 space-y-3">
                  {cutoffRules.map((rule, idx) => (
                    <div
                      key={rule.id}
                      data-testid={`cutoff-rule-${idx}`}
                      className="rounded-md border border-[#283340] bg-[#161D24] p-3"
                    >
                      <div className="flex flex-wrap items-center gap-2.5">
                        <label className="inline-flex items-center gap-1.5 text-xs text-[#C9D1D9]">
                          <input
                            type="checkbox"
                            checked={rule.enabled}
                            onChange={(e) =>
                              updateCutoffRule(rule.id, { enabled: e.target.checked })
                            }
                            className="h-4 w-4 accent-[#0EA5E9]"
                          />
                          Active
                        </label>

                        <select
                          aria-label="Cutoff rule type"
                          data-testid={`cutoff-rule-mode-${idx}`}
                          value={rule.mode}
                          onChange={(e) =>
                            updateCutoffRule(rule.id, {
                              mode: e.target.value === 'weekly_day' ? 'weekly_day' : 'days_before',
                            })
                          }
                          className="min-h-[34px] rounded border border-[#283340] bg-[#0F1419] px-2.5 py-1 text-xs text-[#F0F6FC] focus:border-[#38BDF8] focus:outline-none"
                        >
                          <option value="days_before">Days Before Pickup</option>
                          <option value="weekly_day">Weekly Cutoff Day</option>
                        </select>

                        {rule.mode === 'days_before' ? (
                          <div className="inline-flex items-center gap-1.5">
                            <input
                              type="number"
                              min={0}
                              max={14}
                              aria-label="Days before pickup"
                              data-testid={`cutoff-rule-days-${idx}`}
                              value={rule.daysBefore}
                              onChange={(e) =>
                                updateCutoffRule(rule.id, {
                                  daysBefore: Math.max(
                                    0,
                                    Math.min(14, Number(e.target.value) || 0)
                                  ),
                                })
                              }
                              className="min-h-[34px] w-16 rounded border border-[#283340] bg-[#0F1419] px-2 py-1 font-mono text-xs tabular-nums text-[#F0F6FC] focus:border-[#38BDF8] focus:outline-none"
                            />
                            <span className="text-xs text-[#8B949E]">
                              {rule.daysBefore === 0
                                ? 'days (same day)'
                                : rule.daysBefore === 1
                                  ? 'day before'
                                  : 'days before'}
                            </span>
                          </div>
                        ) : (
                          <select
                            aria-label="Weekly cutoff day"
                            data-testid={`cutoff-rule-weekday-${idx}`}
                            value={rule.cutoffWeekday}
                            onChange={(e) =>
                              updateCutoffRule(rule.id, {
                                cutoffWeekday: Number(e.target.value) || 5,
                              })
                            }
                            className="min-h-[34px] rounded border border-[#283340] bg-[#0F1419] px-2.5 py-1 text-xs text-[#F0F6FC] focus:border-[#38BDF8] focus:outline-none"
                          >
                            {FULL_WEEKDAYS.map((w) => (
                              <option key={w.iso} value={w.iso}>
                                Every {w.label}
                              </option>
                            ))}
                          </select>
                        )}

                        <span className="text-xs text-[#8B949E]">at</span>

                        <input
                          type="time"
                          aria-label="Cutoff time"
                          data-testid={`cutoff-rule-time-${idx}`}
                          value={rule.cutoffTime}
                          onChange={(e) =>
                            updateCutoffRule(rule.id, { cutoffTime: e.target.value || '16:00' })
                          }
                          className="min-h-[34px] rounded border border-[#283340] bg-[#0F1419] px-2.5 py-1 font-mono text-xs tabular-nums text-[#F0F6FC] focus:border-[#38BDF8] focus:outline-none"
                        />

                        <button
                          type="button"
                          aria-label="Remove cutoff rule"
                          data-testid={`cutoff-rule-remove-${idx}`}
                          onClick={() => removeCutoffRule(rule.id)}
                          className="ml-auto inline-flex min-h-[32px] items-center gap-1 rounded border border-[#283340] px-2 py-1 text-xs text-[#8B949E] hover:border-[#DC2626] hover:text-[#F87171]"
                        >
                          <Trash2 className="h-3.5 w-3.5" />
                        </button>
                      </div>

                      <div className="mt-2.5 flex flex-wrap items-center gap-1.5 border-t border-[#283340]/60 pt-2.5">
                        <span className="mr-1 text-[11px] text-[#8B949E]">Applies to pickups:</span>
                        <button
                          type="button"
                          onClick={() => updateCutoffRule(rule.id, { pickupWeekdays: [] })}
                          className={`min-h-[28px] rounded border px-2 py-0.5 text-[11px] font-medium ${
                            rule.pickupWeekdays.length === 0
                              ? 'border-[#38BDF8] bg-[#0EA5E9]/15 text-[#38BDF8]'
                              : 'border-[#283340] bg-[#0F1419] text-[#8B949E] hover:text-[#E6EDF3]'
                          }`}
                        >
                          Every Day
                        </button>
                        {FULL_WEEKDAYS.map((w) => {
                          const active = rule.pickupWeekdays.includes(w.iso);
                          return (
                            <button
                              key={w.iso}
                              type="button"
                              onClick={() => toggleCutoffPickupWeekday(rule.id, w.iso)}
                              className={`min-h-[28px] rounded border px-2 py-0.5 text-[11px] font-medium ${
                                active
                                  ? 'border-[#38BDF8] bg-[#0EA5E9]/15 text-[#38BDF8]'
                                  : 'border-[#283340] bg-[#0F1419] text-[#8B949E] hover:text-[#E6EDF3]'
                              }`}
                            >
                              {w.short}
                            </button>
                          );
                        })}
                        <span className="ml-auto text-[11px] text-[#8B949E]">
                          {describeCutoffRule(rule)}
                        </span>
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </div>
          </div>
        )}
      </section>

      {/* SECTION 2: Header, Footer & Daily Behavior */}
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
              are supported.
            </p>
          </div>
          <button
            type="button"
            data-testid="snippet-reset-settings-btn"
            disabled={saving}
            onClick={() => void handleResetTextDefaults()}
            className="inline-flex min-h-[34px] items-center gap-1.5 rounded-md border border-[#283340] bg-[#0F1419] px-3 py-1.5 text-xs font-medium text-[#C9D1D9] hover:border-[#38BDF8] disabled:opacity-45"
          >
            <RotateCcw className="h-3.5 w-3.5" />
            Reset Text Defaults
          </button>
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
              placeholder='e.g., Request eggs on our waitlist or visit <a href="https://example.com/shop">our farm store</a>.'
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
                  Auto-advance &ldquo;Today&rdquo; &amp; enforce cutoffs live in visitor browsers
                </span>
                <span className="mt-0.5 block text-[11px] text-[#8B949E]">
                  Moves the &ldquo;Today&rdquo; highlight forward each morning, dims past dates on
                  both desktop and mobile, and flips dates to &ldquo;Ordering Closed&rdquo; the
                  moment a cutoff time passes in your farm&apos;s timezone ({timezone}).
                </span>
              </span>
            </label>
          </div>
        </div>
      </section>

      {/* SECTION 3: Open-Source Live Website Sync via GitHub Pages */}
      <section
        data-testid="snippet-github-panel"
        className="mb-6 rounded-lg border border-[#283340] bg-[#161D24] p-4 sm:p-5"
      >
        <div className="flex flex-wrap items-start justify-between gap-3 border-b border-[#283340] pb-4">
          <div>
            <h2 className="font-['Plus_Jakarta_Sans'] text-sm font-bold text-[#F0F6FC]">
              Live Website Sync (GitHub Pages — Push-Only)
            </h2>
            <p className="mt-0.5 text-xs text-[#8B949E]">
              Keep your Odoo order form calendar live-updated without exposing Home Assistant to the
              internet. Point this at your own public GitHub repository.
            </p>
            <div className="mt-2 flex flex-wrap items-center gap-x-2 gap-y-1 text-xs">
              <span
                className={
                  liveStatus?.tokenConfigured ? 'font-medium text-[#4ADE80]' : 'font-medium text-[#FBBF24]'
                }
              >
                {tokenSourceLabel}
              </span>
              <span className="text-[#6E7681]">·</span>
              <span className="font-mono tabular-nums text-[#8B949E]" data-testid="github-last-published">
                {liveStatus?.lastPublishedAt
                  ? `Last published ${new Date(liveStatus.lastPublishedAt).toLocaleString()}`
                  : 'Never published'}
              </span>
              {liveStatus?.hasUnpublishedEdits && (
                <>
                  <span className="text-[#6E7681]">·</span>
                  <span
                    data-testid="github-unpublished-edits-badge"
                    className="font-medium text-[#FBBF24]"
                  >
                    Unpublished edits pending
                  </span>
                </>
              )}
              {liveStatus?.lastPublishStatus === 'error' && liveStatus.lastPublishError && (
                <>
                  <span className="text-[#6E7681]">·</span>
                  <span className="text-[#F87171]">Last push failed</span>
                </>
              )}
            </div>
          </div>

          <div
            role="group"
            aria-label="GitHub publish mode"
            className="inline-flex rounded-md border border-[#283340] bg-[#0F1419] p-1"
          >
            <button
              type="button"
              data-testid="github-mode-manual"
              onClick={() => setGithubMode('manual')}
              className={`min-h-[34px] rounded px-3 py-1.5 text-xs font-semibold transition-colors ${
                githubMode === 'manual'
                  ? 'bg-[#0EA5E9] text-[#0B1117]'
                  : 'text-[#8B949E] hover:text-[#E6EDF3]'
              }`}
            >
              Manual Only
            </button>
            <button
              type="button"
              data-testid="github-mode-auto"
              onClick={() => setGithubMode('auto')}
              className={`min-h-[34px] rounded px-3 py-1.5 text-xs font-semibold transition-colors ${
                githubMode === 'auto'
                  ? 'bg-[#0EA5E9] text-[#0B1117]'
                  : 'text-[#8B949E] hover:text-[#E6EDF3]'
              }`}
            >
              Automatic Sync
            </button>
          </div>
        </div>

        {liveStatus?.lastPublishStatus === 'error' && liveStatus.lastPublishError && (
          <div className="mt-3 rounded-md border border-[#DC2626]/50 bg-[#DC2626]/10 px-3 py-2 text-xs text-[#FCA5A5]">
            {liveStatus.lastPublishError}
          </div>
        )}

        <div className="mt-4 grid grid-cols-1 gap-4 md:grid-cols-12">
          <div className="md:col-span-4">
            <label
              htmlFor="github-repo-input"
              className="mb-1 block text-xs font-medium text-[#C9D1D9]"
            >
              Your GitHub Repository (owner/repo)
            </label>
            <input
              id="github-repo-input"
              data-testid="github-repo-input"
              type="text"
              value={githubRepo}
              onChange={(e) => setGithubRepo(e.target.value)}
              placeholder="e.g., myfarm/farm-availability"
              className="min-h-[38px] w-full rounded-md border border-[#283340] bg-[#0F1419] px-3 py-1.5 font-mono text-xs text-[#F0F6FC] placeholder:text-[#6E7681] focus:border-[#38BDF8] focus:outline-none"
            />
          </div>

          <div className="md:col-span-2">
            <label
              htmlFor="github-branch-input"
              className="mb-1 block text-xs font-medium text-[#C9D1D9]"
            >
              Branch
            </label>
            <input
              id="github-branch-input"
              data-testid="github-branch-input"
              type="text"
              value={githubBranch}
              onChange={(e) => setGithubBranch(e.target.value)}
              placeholder="main"
              className="min-h-[38px] w-full rounded-md border border-[#283340] bg-[#0F1419] px-3 py-1.5 font-mono text-xs text-[#F0F6FC] placeholder:text-[#6E7681] focus:border-[#38BDF8] focus:outline-none"
            />
          </div>

          <div className="md:col-span-2">
            <label
              htmlFor="github-path-input"
              className="mb-1 block text-xs font-medium text-[#C9D1D9]"
            >
              JSON File Path
            </label>
            <input
              id="github-path-input"
              data-testid="github-path-input"
              type="text"
              value={githubPath}
              onChange={(e) => setGithubPath(e.target.value)}
              placeholder="availability.json"
              className="min-h-[38px] w-full rounded-md border border-[#283340] bg-[#0F1419] px-3 py-1.5 font-mono text-xs text-[#F0F6FC] placeholder:text-[#6E7681] focus:border-[#38BDF8] focus:outline-none"
            />
          </div>

          <div className="md:col-span-2">
            <label
              htmlFor="github-interval-select"
              className="mb-1 block text-xs font-medium text-[#C9D1D9]"
            >
              Auto Check
            </label>
            <select
              id="github-interval-select"
              data-testid="github-interval-select"
              disabled={githubMode !== 'auto'}
              value={githubInterval}
              onChange={(e) => setGithubInterval(e.target.value as GithubPublishInterval)}
              className="min-h-[38px] w-full rounded-md border border-[#283340] bg-[#0F1419] px-2.5 py-1.5 text-xs text-[#F0F6FC] focus:border-[#38BDF8] focus:outline-none disabled:opacity-45"
            >
              <option value="15m">Every 15 min</option>
              <option value="30m">Every 30 min</option>
              <option value="1h">Every 1 hour</option>
              <option value="6h">Every 6 hours</option>
            </select>
          </div>

          <div className="md:col-span-2">
            <label
              htmlFor="github-idle-select"
              className="mb-1 block text-xs font-medium text-[#C9D1D9]"
              title="Wait for this many minutes of no edits before auto-publishing so in-progress changes are never pushed"
            >
              Quiet Delay
            </label>
            <select
              id="github-idle-select"
              data-testid="github-idle-select"
              disabled={githubMode !== 'auto'}
              value={githubIdleMinutes}
              onChange={(e) => setGithubIdleMinutes(Number(e.target.value))}
              className="min-h-[38px] w-full rounded-md border border-[#283340] bg-[#0F1419] px-2.5 py-1.5 text-xs text-[#F0F6FC] focus:border-[#38BDF8] focus:outline-none disabled:opacity-45"
            >
              <option value={5}>5 min idle</option>
              <option value={10}>10 min idle</option>
              <option value={15}>15 min idle</option>
              <option value={30}>30 min idle</option>
              <option value={60}>60 min idle</option>
            </select>
          </div>

          <div className="md:col-span-12">
            <label
              htmlFor="github-public-url-input"
              className="mb-1 block text-xs font-medium text-[#C9D1D9]"
            >
              Custom Public JSON URL (Optional — leave blank for standard GitHub Pages URL)
            </label>
            <input
              id="github-public-url-input"
              data-testid="github-public-url-input"
              type="url"
              value={githubPublicUrl}
              onChange={(e) => setGithubPublicUrl(e.target.value)}
              placeholder={
                previewPublicUrl || 'https://your-username.github.io/farm-availability/availability.json'
              }
              className="min-h-[38px] w-full rounded-md border border-[#283340] bg-[#0F1419] px-3 py-1.5 font-mono text-xs text-[#F0F6FC] placeholder:text-[#6E7681] focus:border-[#38BDF8] focus:outline-none"
            />
            {previewPublicUrl && (
              <p className="mt-1 text-[11px] text-[#8B949E]">
                Live feed URL:{' '}
                <span className="font-mono text-[#38BDF8]" data-testid="github-derived-public-url">
                  {previewPublicUrl}
                </span>
                {githubMode === 'auto' && (
                  <span>
                    {' '}
                    · Auto-publishes only after your edits have been quiet for {githubIdleMinutes}{' '}
                    min (never on midnight rollovers or cutoff clock ticks).
                  </span>
                )}
              </p>
            )}
          </div>
        </div>

        {githubTestResult && (
          <div
            data-testid="github-test-result"
            className={`mt-3 rounded-md border px-3 py-2 text-xs ${
              githubTestResult.ok
                ? 'border-[#16A34A]/50 bg-[#16A34A]/10 text-[#4ADE80]'
                : 'border-[#DC2626]/50 bg-[#DC2626]/10 text-[#FCA5A5]'
            }`}
          >
            {githubTestResult.message}
          </div>
        )}

        <div className="mt-4 flex flex-wrap items-center justify-between gap-3 border-t border-[#283340] pt-4">
          <button
            type="button"
            onClick={() => setShowSetupGuide((prev) => !prev)}
            className="inline-flex items-center gap-1 text-xs font-medium text-[#8B949E] hover:text-[#38BDF8]"
          >
            {showSetupGuide ? (
              <ChevronDown className="h-3.5 w-3.5" />
            ) : (
              <ChevronRight className="h-3.5 w-3.5" />
            )}
            Open-Source 3-Step GitHub Pages Setup Guide
          </button>

          <div className="flex flex-wrap items-center gap-2">
            <button
              type="button"
              data-testid="github-test-btn"
              disabled={testingGithub || !githubRepo.trim()}
              onClick={() => void handleTestGithub()}
              className="inline-flex min-h-[40px] items-center gap-1.5 rounded-md border border-[#283340] bg-[#0F1419] px-3.5 py-2 text-xs font-medium text-[#E6EDF3] hover:border-[#38BDF8] disabled:opacity-45"
            >
              <Wifi className="h-3.5 w-3.5" />
              {testingGithub ? 'Testing...' : 'Test Connection'}
            </button>

            <button
              type="button"
              data-testid="github-publish-now-btn"
              disabled={publishingGithub || saving || !githubRepo.trim()}
              onClick={() => void handlePublishNow()}
              className="inline-flex min-h-[40px] items-center gap-1.5 rounded-md border border-[#38BDF8]/60 bg-[#0EA5E9]/15 px-4 py-2 text-xs font-semibold text-[#38BDF8] hover:bg-[#0EA5E9]/25 disabled:opacity-45"
            >
              <CloudUpload className="h-4 w-4" />
              {publishingGithub ? 'Publishing...' : 'Publish Now'}
            </button>

            <button
              type="button"
              data-testid="copy-live-embed-btn"
              disabled={!liveEmbedCode || saving}
              onClick={() => void handleCopyLiveEmbed()}
              className="inline-flex min-h-[40px] items-center gap-1.5 rounded-md bg-[#0EA5E9] px-4 py-2 text-xs font-semibold text-[#0B1117] hover:bg-[#38BDF8] disabled:opacity-45"
            >
              {copiedLive ? (
                <>
                  <Check className="h-4 w-4" />
                  Copied Live Embed!
                </>
              ) : (
                <>
                  <Copy className="h-4 w-4" />
                  Copy Live Embed Code
                </>
              )}
            </button>
          </div>
        </div>

        {showSetupGuide && (
          <ol className="mt-3 list-decimal space-y-1.5 rounded-md border border-[#283340] bg-[#0F1419] py-3 pr-4 pl-8 text-xs leading-relaxed text-[#C9D1D9]">
            <li>
              Create a dedicated <strong className="text-[#F0F6FC]">public</strong> GitHub
              repository (initialized with a README on <code className="font-mono">main</code>) and
              enable <strong className="text-[#F0F6FC]">Settings → Pages → Deploy from branch</strong>{' '}
              (<code className="font-mono">main</code> / <code className="font-mono">/ (root)</code>).
            </li>
            <li>
              Create a <strong className="text-[#F0F6FC]">Fine-grained Personal Access Token</strong>{' '}
              in GitHub scoped to <em>Only select repositories</em> (pick your new availability repo)
              with <code className="font-mono text-[#38BDF8]">Contents: Read and write</code>{' '}
              permission. Paste it into{' '}
              <code className="font-mono text-[#38BDF8]">github_publish_token</code> in Home
              Assistant Add-on Configuration (or{' '}
              <code className="font-mono text-[#38BDF8]">GITHUB_PUBLISH_TOKEN</code> in{' '}
              <code className="font-mono">.env</code>) and restart the add-on.
            </li>
            <li>
              Enter <code className="font-mono">owner/repo</code> above, click{' '}
              <strong className="text-[#F0F6FC]">Publish Now</strong>, then click{' '}
              <strong className="text-[#F0F6FC]">Copy Live Embed Code</strong> and paste it once into
              an Odoo Website <em>Embed Code</em> block. Your website will automatically show fresh
              availability whenever you publish or on your Auto Sync interval.
            </li>
          </ol>
        )}
      </section>

      {/* SECTION 4: Live Anonymized Calendar / Paused Preview */}
      {loading && !data ? (
        <div className="rounded-lg border border-[#283340] bg-[#161D24] p-8 text-sm text-[#8B949E]">
          Building availability calendar preview...
        </div>
      ) : data ? (
        <div className="space-y-6">
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

            {!snippetEnabled ? (
              <div
                data-testid="snippet-preview-paused"
                className="my-3 rounded-md border border-[#D97706]/40 bg-[#D97706]/10 px-4 py-4 text-sm leading-relaxed text-[#FDE68A]"
              >
                <InlineSafeRichText text={previewPausedMessage} />
              </div>
            ) : publicItems.length === 0 ? (
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
                  {hasCutoffLegend && (
                    <span className="inline-flex items-center gap-1.5">
                      <span className="h-2 w-2 rounded-full bg-[#94A3B8]" />
                      Ordering Closed
                    </span>
                  )}
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

                {/* Calendar Grid — Past days shown dimmed on BOTH mobile & desktop */}
                <div
                  data-testid="snippet-calendar-grid"
                  className="grid grid-cols-1 gap-2 md:grid-cols-7"
                >
                  {calendarDays.map((day) => {
                    if (day.isPast) {
                      return (
                        <div
                          key={day.date}
                          data-testid={`snippet-past-day-${day.date}`}
                          className="flex flex-row items-center justify-between gap-2 rounded-md border border-[#283340]/50 bg-[#0F1419]/50 px-3 py-2 opacity-45 md:min-h-[88px] md:flex-col md:items-stretch md:justify-start md:p-2.5"
                        >
                          <div className="flex items-center justify-between gap-1">
                            <span className="font-mono text-xs tabular-nums text-[#8B949E]">
                              <span className="md:hidden">{day.weekdayLabel}, </span>
                              {day.displayDate}
                            </span>
                            <span className="text-[10px] font-semibold uppercase tracking-wide text-[#6E7681]">
                              Past
                            </span>
                          </div>
                        </div>
                      );
                    }

                    const isClosedPreview = evaluateDateOrderingClosed({
                      pickupDate: day.date,
                      today: previewToday,
                      currentTimeHHMM: previewTimeHHMM,
                      showSameDay,
                      cutoffRules,
                    });

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
                          {isClosedPreview ? (
                            <div
                              data-testid={`snippet-day-closed-${day.date}`}
                              className="rounded border border-[#475569]/60 bg-[#1E293B] px-2 py-1 text-center text-[11px] font-semibold text-[#94A3B8]"
                            >
                              Ordering Closed
                            </div>
                          ) : (
                            day.items.map((item) => {
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
                            })
                          )}
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

          {/* SECTION 5: Raw HTML & Live Embed Code Viewer */}
          {showCodeDrawer && (
            <section className="rounded-lg border border-[#283340] bg-[#161D24] p-5">
              <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
                <div className="inline-flex rounded-md border border-[#283340] bg-[#0F1419] p-1">
                  <button
                    type="button"
                    data-testid="code-tab-static"
                    onClick={() => setCodeViewMode('static')}
                    className={`rounded px-3 py-1 text-xs font-semibold ${
                      codeViewMode === 'static'
                        ? 'bg-[#0EA5E9] text-[#0B1117]'
                        : 'text-[#8B949E] hover:text-[#E6EDF3]'
                    }`}
                  >
                    Static HTML Snapshot
                  </button>
                  <button
                    type="button"
                    data-testid="code-tab-live"
                    disabled={!liveEmbedCode}
                    onClick={() => setCodeViewMode('live')}
                    className={`rounded px-3 py-1 text-xs font-semibold disabled:opacity-40 ${
                      codeViewMode === 'live'
                        ? 'bg-[#0EA5E9] text-[#0B1117]'
                        : 'text-[#8B949E] hover:text-[#E6EDF3]'
                    }`}
                  >
                    Live Auto-Updating Embed
                  </button>
                </div>

                {isDirty && (
                  <span className="text-[11px] text-[#FBBF24]">
                    Save settings to regenerate the Static HTML snapshot.
                  </span>
                )}
              </div>

              {codeViewMode === 'live' && liveEmbedCode ? (
                <textarea
                  readOnly
                  data-testid="snippet-live-embed-textarea"
                  rows={12}
                  value={liveEmbedCode}
                  className="w-full rounded-md border border-[#283340] bg-[#0F1419] p-3 font-mono text-xs text-[#C9D1D9]"
                />
              ) : (
                <textarea
                  readOnly
                  data-testid="snippet-raw-html-textarea"
                  rows={12}
                  value={data.html}
                  className="w-full rounded-md border border-[#283340] bg-[#0F1419] p-3 font-mono text-xs text-[#C9D1D9]"
                />
              )}
            </section>
          )}
        </div>
      ) : null}
    </main>
  );
}
