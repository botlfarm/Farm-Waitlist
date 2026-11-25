import {
  Check,
  Database,
  Download,
  Eye,
  FlaskConical,
  Link2,
  Mail,
  MessageSquare,
  Plus,
  RefreshCw,
  RotateCcw,
  Star,
  Trash2,
  Upload,
  X,
} from 'lucide-react';
import { useEffect, useState, type ChangeEvent } from 'react';
import { api } from '../lib/api';
import {
  PRE_APPROVAL_TEMPLATE_VARIABLES,
  isSafeHttpUrl,
  renderPreApprovalSamplePreview,
  resolveHoldCutoffValues,
  resolvePublicOrderCutoffValues,
} from '../shared/generators';
import {
  ISO_WEEKDAY_LABELS,
  formatLocalDateTime,
  formatShortCalendarDate,
} from '../shared/timezone';
import type {
  AppSettings,
  BackupInfo,
  BackupPreviewStatus,
  IgnoredDateRange,
  OdooConnectionStatus,
  PickupChannel,
  PreApprovalTemplate,
  SandboxStatus,
  SupplyMode,
  SyncInterval,
  TemplateFormat,
  TrackedItem,
} from '../shared/types';
import { RichMessagePreview } from './RichMessagePreview';

type SettingsSection = 'items' | 'channels' | 'odoo' | 'templates' | 'backups';

interface SettingsViewProps {
  today: string;
  settings: AppSettings;
  odooStatus: OdooConnectionStatus;
  items: TrackedItem[];
  channels: PickupChannel[];
  sandboxStatus?: SandboxStatus;
  sandboxBusy?: boolean;
  onEnterSandbox?: () => Promise<void>;
  onExitSandbox?: () => Promise<void>;
  backupPreviewStatus?: BackupPreviewStatus;
  backupPreviewBusy?: boolean;
  onEnterBackupPreview?: (filename: string) => Promise<void>;
  onExitBackupPreview?: () => Promise<void>;
  onWorkspaceChanged: () => Promise<void>;
  onToast: (message: string, kind?: 'info' | 'error') => void;
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(2)} MB`;
}

export function SettingsView({
  today,
  settings,
  odooStatus,
  items,
  channels,
  sandboxStatus,
  sandboxBusy = false,
  onEnterSandbox,
  onExitSandbox,
  backupPreviewStatus,
  backupPreviewBusy = false,
  onEnterBackupPreview,
  onExitBackupPreview,
  onWorkspaceChanged,
  onToast,
}: SettingsViewProps) {
  const isBackupPreviewActive = Boolean(backupPreviewStatus?.active);
  const [section, setSection] = useState<SettingsSection>('items');

  // --- Tracked Item form state ---
  const [itemName, setItemName] = useState('');
  const [unitLabel, setUnitLabel] = useState('dozens');
  const [supplyMode, setSupplyMode] = useState<SupplyMode>('continuous');
  const [defaultProd, setDefaultProd] = useState('12');
  const [safetyBuffer, setSafetyBuffer] = useState('4');
  const [includePublic, setIncludePublic] = useState(true);
  const [keywordsText, setKeywordsText] = useState('');

  // --- Pickup Channel form state ---
  const [channelName, setChannelName] = useState('');
  const [channelScheduleMode, setChannelScheduleMode] = useState<'weekly' | 'specific' | 'any'>('weekly');
  const [channelWeekdays, setChannelWeekdays] = useState<number[]>([1, 2, 3, 4, 5, 6, 7]);
  const [channelSpecificDates, setChannelSpecificDates] = useState<string[]>([]);
  const [channelDateDraft, setChannelDateDraft] = useState<string>('');
  const [inlineDateDraftByChannel, setInlineDateDraftByChannel] = useState<Record<number, string>>({});

  // --- Settings form state ---
  const [draftSettings, setDraftSettings] = useState<AppSettings>(settings);
  const [holdHoursInput, setHoldHoursInput] = useState<string>(() =>
    String(settings.holdThresholdHours)
  );
  const [selectedTemplateId, setSelectedTemplateId] = useState<string>(
    () =>
      settings.preApprovalTemplates?.find((t) => t.isDefault)?.id ??
      settings.preApprovalTemplates?.[0]?.id ??
      'default-email'
  );
  const [linkLabelDraft, setLinkLabelDraft] = useState('');
  const [linkUrlDraft, setLinkUrlDraft] = useState('');
  const [rangeStart, setRangeStart] = useState('');
  const [rangeEnd, setRangeEnd] = useState('');
  const [rangeLabel, setRangeLabel] = useState('');
  const [rangeIgnoreExisting, setRangeIgnoreExisting] = useState(false);
  const [odooTestResult, setOdooTestResult] = useState<string | null>(null);
  const [testingOdoo, setTestingOdoo] = useState(false);

  // --- Backups state ---
  const [backups, setBackups] = useState<BackupInfo[]>([]);
  const [loadingBackups, setLoadingBackups] = useState(false);
  const [confirmRestoreFile, setConfirmRestoreFile] = useState<string | null>(null);

  useEffect(() => {
    setDraftSettings(settings);
    setHoldHoursInput(String(settings.holdThresholdHours));
    const list = settings.preApprovalTemplates ?? [];
    if (list.length > 0 && !list.some((t) => t.id === selectedTemplateId)) {
      setSelectedTemplateId(list.find((t) => t.isDefault)?.id ?? list[0].id);
    }
  }, [settings]);

  const draftTemplates: PreApprovalTemplate[] =
    draftSettings.preApprovalTemplates && draftSettings.preApprovalTemplates.length > 0
      ? draftSettings.preApprovalTemplates
      : [
          {
            id: 'default-email',
            name: 'Default Email',
            format: 'html',
            body: draftSettings.preApprovalTemplate,
            isDefault: true,
            channelIds: [],
            itemIds: [],
          },
        ];

  const activeTemplate: PreApprovalTemplate =
    draftTemplates.find((t) => t.id === selectedTemplateId) ?? draftTemplates[0];

  const updateTemplatesList = (nextList: PreApprovalTemplate[]) => {
    const defaultTmpl = nextList.find((t) => t.isDefault) ?? nextList[0];
    setDraftSettings({
      ...draftSettings,
      preApprovalTemplates: nextList,
      preApprovalTemplate: defaultTmpl?.body ?? draftSettings.preApprovalTemplate,
    });
  };

  const updateActiveTemplate = (patch: Partial<PreApprovalTemplate>) => {
    const nextList = draftTemplates.map((t) => {
      if (t.id !== activeTemplate.id) {
        return patch.isDefault ? { ...t, isDefault: false } : t;
      }
      return { ...t, ...patch };
    });
    updateTemplatesList(nextList);
  };

  const handleAddTemplate = () => {
    const newId = `tmpl-${Date.now()}`;
    const newTemplate: PreApprovalTemplate = {
      id: newId,
      name: `New Template ${draftTemplates.length + 1}`,
      format: 'html',
      body: "Hey {{name}}, you're pre-approved for {{items_summary}} on {{date}} ({{channel}}).",
      isDefault: false,
      channelIds: [],
      itemIds: [],
    };
    updateTemplatesList([...draftTemplates, newTemplate]);
    setSelectedTemplateId(newId);
  };

  const handleDeleteTemplate = (id: string) => {
    if (draftTemplates.length <= 1) return;
    const remaining = draftTemplates.filter((t) => t.id !== id);
    const hasDefault = remaining.some((t) => t.isDefault);
    const normalized = hasDefault
      ? remaining
      : remaining.map((t, idx) => ({ ...t, isDefault: idx === 0 }));
    updateTemplatesList(normalized);
    if (selectedTemplateId === id) {
      setSelectedTemplateId(normalized[0].id);
    }
  };

  const handleInsertStoreLink = () => {
    const rawUrl = linkUrlDraft.trim();
    if (!rawUrl) {
      onToast('Enter a store URL (starting with https://)', 'error');
      return;
    }
    const normalizedUrl = /^https?:\/\//i.test(rawUrl) ? rawUrl : `https://${rawUrl}`;
    if (!isSafeHttpUrl(normalizedUrl)) {
      onToast('Please enter a valid http:// or https:// URL', 'error');
      return;
    }
    const label = linkLabelDraft.trim() || 'Order Here';
    const snippet =
      activeTemplate.format === 'html'
        ? `<a href="${normalizedUrl}">${label}</a>`
        : `${label}: ${normalizedUrl}`;
    const separator = activeTemplate.body.trim().length > 0 && !activeTemplate.body.endsWith(' ') ? ' ' : '';
    updateActiveTemplate({ body: `${activeTemplate.body}${separator}${snippet}` });
    setLinkLabelDraft('');
    setLinkUrlDraft('');
  };

  const loadBackups = async () => {
    setLoadingBackups(true);
    try {
      const list = await api.listBackups();
      setBackups(list);
    } catch (err) {
      onToast(err instanceof Error ? err.message : 'Failed to load backups', 'error');
    } finally {
      setLoadingBackups(false);
    }
  };

  useEffect(() => {
    if (section === 'backups') {
      void loadBackups();
    }
  }, [section, sandboxStatus?.active]);

  const handleAddItem = async () => {
    if (!itemName.trim()) {
      onToast('Item name is required', 'error');
      return;
    }
    try {
      await api.createItem({
        name: itemName.trim(),
        unitLabel: unitLabel.trim() || 'units',
        isActive: true,
        supplyMode,
        defaultDailyProduction: Number(defaultProd) || 0,
        globalSafetyBuffer: Math.max(0, Number(safetyBuffer) || 0),
        includeInPublicSnippet: includePublic,
        keywordRules: keywordsText
          .split(',')
          .map((s) => s.trim())
          .filter(Boolean),
      });
      setItemName('');
      setKeywordsText('');
      await onWorkspaceChanged();
      onToast('Tracked item added');
    } catch (err) {
      onToast(err instanceof Error ? err.message : 'Failed to create item', 'error');
    }
  };

  const handleToggleItemField = async (
    item: TrackedItem,
    patch: Partial<TrackedItem>
  ) => {
    try {
      await api.updateItem(item.id, patch);
      await onWorkspaceChanged();
    } catch (err) {
      onToast(err instanceof Error ? err.message : 'Failed to update item', 'error');
    }
  };

  const handleDeleteItem = async (id: number) => {
    try {
      await api.deleteItem(id);
      await onWorkspaceChanged();
      onToast('Tracked item deleted');
    } catch (err) {
      onToast(err instanceof Error ? err.message : 'Failed to delete item', 'error');
    }
  };

  const toggleChannelDay = (iso: number) => {
    setChannelWeekdays((prev) =>
      prev.includes(iso) ? prev.filter((d) => d !== iso) : [...prev, iso].sort((a, b) => a - b)
    );
  };

  const handleAddChannelDateDraft = () => {
    if (!channelDateDraft) return;
    setChannelSpecificDates((prev) =>
      Array.from(new Set([...prev, channelDateDraft])).sort()
    );
    setChannelDateDraft('');
  };

  const handleAddChannel = async () => {
    if (!channelName.trim()) {
      onToast('Enter a channel name', 'error');
      return;
    }
    if (channelScheduleMode === 'weekly' && channelWeekdays.length === 0) {
      onToast(
        'Select at least one weekday or switch to Event Dates / Any Date (1-Off)',
        'error'
      );
      return;
    }
    const pendingSpecificDates =
      channelScheduleMode === 'specific'
        ? Array.from(
            new Set([
              ...channelSpecificDates,
              ...(channelDateDraft ? [channelDateDraft] : []),
            ])
          ).sort()
        : [];
    if (channelScheduleMode === 'specific' && pendingSpecificDates.length === 0) {
      onToast(
        'Add at least one event date (or choose Any Date for a flexible 1-off channel)',
        'error'
      );
      return;
    }
    try {
      await api.createChannel({
        name: channelName.trim(),
        allowedWeekdays: channelScheduleMode === 'weekly' ? channelWeekdays : [],
        specificDates: pendingSpecificDates,
      });
      setChannelName('');
      setChannelWeekdays([1, 2, 3, 4, 5, 6, 7]);
      setChannelSpecificDates([]);
      setChannelDateDraft('');
      await onWorkspaceChanged();
      onToast('Pickup channel added');
    } catch (err) {
      onToast(err instanceof Error ? err.message : 'Failed to add channel', 'error');
    }
  };

  const handleUpdateChannelSpecificDates = async (ch: PickupChannel, nextDates: string[]) => {
    try {
      await api.updateChannel(ch.id, { specificDates: nextDates });
      await onWorkspaceChanged();
      onToast(`Updated event dates for ${ch.name}`);
    } catch (err) {
      onToast(err instanceof Error ? err.message : 'Failed to update channel dates', 'error');
    }
  };

  const handleSaveSettings = async (
    overridePatch?: Partial<AppSettings>,
    customSuccessToast?: (removedIgnoredOrdersCount: number) => string
  ) => {
    const payload = overridePatch ? { ...draftSettings, ...overridePatch } : draftSettings;
    try {
      const res = await api.updateSettings(payload);
      await onWorkspaceChanged();
      const removedCount = res.removedIgnoredOrdersCount ?? 0;
      if (customSuccessToast) {
        onToast(customSuccessToast(removedCount));
      } else if (removedCount > 0) {
        onToast(
          `Settings saved — removed ${removedCount} existing Odoo ${
            removedCount === 1 ? 'order' : 'orders'
          } (Undo available)`
        );
      } else {
        onToast('Settings saved');
      }
    } catch (err) {
      onToast(err instanceof Error ? err.message : 'Failed to save settings', 'error');
    }
  };

  const handleAddIgnoredRange = async () => {
    if (!rangeStart || !rangeEnd || rangeEnd < rangeStart) {
      onToast('Enter a valid start and end date', 'error');
      return;
    }
    const nextRange: IgnoredDateRange = {
      id: `${Date.now()}`,
      startDate: rangeStart,
      endDate: rangeEnd,
      label: rangeLabel.trim() || undefined,
      ignoreExisting: rangeIgnoreExisting,
    };
    const nextRanges = [...draftSettings.odooIgnoredDateRanges, nextRange];
    setDraftSettings({ ...draftSettings, odooIgnoredDateRanges: nextRanges });
    setRangeStart('');
    setRangeEnd('');
    setRangeLabel('');
    setRangeIgnoreExisting(false);
    await handleSaveSettings({ odooIgnoredDateRanges: nextRanges }, (removedCount) =>
      removedCount > 0
        ? `Ignored range added — cleared ${removedCount} existing Odoo ${
            removedCount === 1 ? 'order' : 'orders'
          } (Undo available)`
        : 'Ignored date range added'
    );
  };

  const handleToggleIgnoredRangeMode = async (id: string) => {
    const nextRanges = draftSettings.odooIgnoredDateRanges.map((r) =>
      r.id === id ? { ...r, ignoreExisting: !r.ignoreExisting } : r
    );
    const updatedRange = nextRanges.find((r) => r.id === id);
    setDraftSettings({ ...draftSettings, odooIgnoredDateRanges: nextRanges });
    await handleSaveSettings({ odooIgnoredDateRanges: nextRanges }, (removedCount) =>
      removedCount > 0
        ? `Range set to ignore completely — cleared ${removedCount} existing Odoo ${
            removedCount === 1 ? 'order' : 'orders'
          } (Undo available)`
        : updatedRange?.ignoreExisting
          ? 'Range set to ignore completely (new + existing orders)'
          : 'Range set to skip new imports only'
    );
  };

  const handleRemoveIgnoredRange = async (id: string) => {
    const nextRanges = draftSettings.odooIgnoredDateRanges.filter((r) => r.id !== id);
    setDraftSettings({ ...draftSettings, odooIgnoredDateRanges: nextRanges });
    await handleSaveSettings({ odooIgnoredDateRanges: nextRanges });
  };

  const handleTestOdoo = async () => {
    setTestingOdoo(true);
    setOdooTestResult(null);
    try {
      const res = await api.testOdoo();
      setOdooTestResult(res.message);
    } catch (err) {
      setOdooTestResult(err instanceof Error ? err.message : 'Connection failed');
    } finally {
      setTestingOdoo(false);
    }
  };

  const handleCreateBackup = async () => {
    try {
      await api.createBackup();
      await loadBackups();
      onToast('SQLite snapshot created');
    } catch (err) {
      onToast(err instanceof Error ? err.message : 'Snapshot failed', 'error');
    }
  };

  const handleRestoreBackup = async (filename: string) => {
    try {
      const res = await api.restoreBackup(filename);
      setConfirmRestoreFile(null);
      await loadBackups();
      await onWorkspaceChanged();
      onToast(`Restored ${filename} (safety snapshot: ${res.safetySnapshot.filename})`);
    } catch (err) {
      onToast(err instanceof Error ? err.message : 'Restore failed', 'error');
    }
  };

  const handleUploadBackup = async (e: ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    e.target.value = '';
    if (!file) return;
    try {
      const res = await api.uploadBackup(file);
      await loadBackups();
      await onWorkspaceChanged();
      onToast(`Uploaded & restored ${file.name} (safety snapshot: ${res.safetySnapshot.filename})`);
    } catch (err) {
      onToast(err instanceof Error ? err.message : 'Invalid SQLite upload', 'error');
    }
  };

  const SECTIONS: Array<{ id: SettingsSection; label: string; testId: string }> = [
    { id: 'items', label: 'Tracked Items', testId: 'settings-tab-items' },
    { id: 'channels', label: 'Pickup Channels', testId: 'settings-tab-channels' },
    { id: 'odoo', label: 'Odoo 19.3 Sync', testId: 'settings-tab-odoo' },
    { id: 'templates', label: 'Templates & Holds', testId: 'settings-tab-templates' },
    { id: 'backups', label: 'Backup & Restore', testId: 'settings-tab-backups' },
  ];

  return (
    <main className="mx-auto max-w-6xl px-6 py-8" data-testid="settings-view">
      <div className="mb-6">
        <h1 className="font-['Plus_Jakarta_Sans'] text-2xl font-bold text-[#F0F6FC]">Settings</h1>
        <p className="mt-1 text-sm text-[#8B949E]">
          Configure tracked agricultural products, pickup days, Odoo 19.3 sync rules, copy
          templates, and local SQLite snapshots.
        </p>
      </div>

      {/* Section Tabs (clean horizontal scroll on mobile without wrapping clutter) */}
      <div className="mb-6 flex flex-nowrap gap-1.5 overflow-x-auto border-b border-[#283340] pb-3">
        {SECTIONS.map((tab) => (
          <button
            key={tab.id}
            type="button"
            data-testid={tab.testId}
            onClick={() => setSection(tab.id)}
            className={`min-h-[38px] shrink-0 whitespace-nowrap rounded-md px-3.5 py-2 text-xs font-semibold transition-colors ${
              section === tab.id
                ? 'bg-[#0EA5E9] text-[#0B1117]'
                : 'border border-[#283340] bg-[#161D24] text-[#C9D1D9] hover:border-[#38BDF8]'
            }`}
          >
            {tab.label}
          </button>
        ))}
      </div>

      {isBackupPreviewActive && section !== 'backups' && (
        <div
          data-testid="settings-readonly-notice"
          className="mb-6 flex items-center gap-2 rounded-md border border-[#0284C7]/60 bg-[#0284C7]/15 px-4 py-2.5 text-xs text-[#BAE6FD]"
        >
          <Eye className="h-4 w-4 shrink-0 text-[#38BDF8]" aria-hidden="true" />
          <span>
            Viewing settings from backup{' '}
            <strong className="font-mono text-white">{backupPreviewStatus?.filename}</strong> in
            read-only mode. Exit Backup Preview to make changes.
          </span>
        </div>
      )}

      <fieldset disabled={isBackupPreviewActive} className="contents">
      {/* 1. TRACKED ITEMS */}
      {section === 'items' && (
        <div className="grid grid-cols-1 gap-8 lg:grid-cols-12">
          <section className="rounded-lg border border-[#283340] bg-[#161D24] p-5 lg:col-span-5">
            <h2 className="font-['Plus_Jakarta_Sans'] text-base font-bold text-[#F0F6FC]">
              Add Tracked Item
            </h2>
            <div className="mt-4 space-y-4">
              <div>
                <label htmlFor="item-name" className="mb-1 block text-xs font-medium text-[#C9D1D9]">
                  Item Name
                </label>
                <input
                  id="item-name"
                  data-testid="settings-item-name-input"
                  type="text"
                  value={itemName}
                  onChange={(e) => setItemName(e.target.value)}
                  placeholder="e.g., Standard Eggs, Pullet Eggs, Holiday Turkeys"
                  className="min-h-[40px] w-full rounded-md border border-[#283340] bg-[#0F1419] px-3 py-2 text-sm text-[#F0F6FC] placeholder:text-[#6E7681]"
                />
              </div>

              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label htmlFor="item-unit" className="mb-1 block text-xs font-medium text-[#C9D1D9]">
                    Unit Label
                  </label>
                  <input
                    id="item-unit"
                    data-testid="settings-item-unit-input"
                    type="text"
                    value={unitLabel}
                    onChange={(e) => setUnitLabel(e.target.value)}
                    placeholder="dozens, birds, lbs"
                    className="min-h-[40px] w-full rounded-md border border-[#283340] bg-[#0F1419] px-3 py-2 text-sm text-[#F0F6FC]"
                  />
                </div>
                <div>
                  <label htmlFor="item-mode" className="mb-1 block text-xs font-medium text-[#C9D1D9]">
                    Supply Mode
                  </label>
                  <select
                    id="item-mode"
                    data-testid="settings-item-mode-select"
                    value={supplyMode}
                    onChange={(e) => setSupplyMode(e.target.value as SupplyMode)}
                    className="min-h-[40px] w-full rounded-md border border-[#283340] bg-[#0F1419] px-3 py-2 text-sm text-[#F0F6FC]"
                  >
                    <option value="continuous">Continuous Daily Production</option>
                    <option value="discrete">Discrete Batch / Harvest Drops</option>
                  </select>
                </div>
              </div>

              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label htmlFor="item-prod" className="mb-1 block text-xs font-medium text-[#C9D1D9]">
                    Default Daily Production
                  </label>
                  <input
                    id="item-prod"
                    data-testid="settings-item-prod-input"
                    type="number"
                    step="0.5"
                    min="0"
                    value={defaultProd}
                    onChange={(e) => setDefaultProd(e.target.value)}
                    className="min-h-[40px] w-full rounded-md border border-[#283340] bg-[#0F1419] px-3 py-2 font-mono text-sm tabular-nums text-[#F0F6FC]"
                  />
                </div>
                <div>
                  <label htmlFor="item-buffer" className="mb-1 block text-xs font-medium text-[#C9D1D9]">
                    Global Safety Buffer
                  </label>
                  <input
                    id="item-buffer"
                    data-testid="settings-item-buffer-input"
                    type="number"
                    step="0.5"
                    min="0"
                    value={safetyBuffer}
                    onChange={(e) => setSafetyBuffer(e.target.value)}
                    className="min-h-[40px] w-full rounded-md border border-[#283340] bg-[#0F1419] px-3 py-2 font-mono text-sm tabular-nums text-[#F0F6FC]"
                  />
                </div>
              </div>

              <div>
                <label htmlFor="item-keywords" className="mb-1 block text-xs font-medium text-[#C9D1D9]">
                  Odoo Auto-Match Keywords (comma-separated)
                </label>
                <input
                  id="item-keywords"
                  data-testid="settings-item-keywords-input"
                  type="text"
                  value={keywordsText}
                  onChange={(e) => setKeywordsText(e.target.value)}
                  placeholder="e.g., standard, large eggs, pasture eggs"
                  className="min-h-[40px] w-full rounded-md border border-[#283340] bg-[#0F1419] px-3 py-2 text-sm text-[#F0F6FC] placeholder:text-[#6E7681]"
                />
              </div>

              <label className="flex items-center gap-2.5 text-xs text-[#C9D1D9]">
                <input
                  type="checkbox"
                  data-testid="settings-item-public-checkbox"
                  checked={includePublic}
                  onChange={(e) => setIncludePublic(e.target.checked)}
                  className="h-4 w-4 accent-[#0EA5E9]"
                />
                Include in Public Website Availability Snippet
              </label>

              <button
                type="button"
                data-testid="settings-add-item-btn"
                onClick={() => void handleAddItem()}
                className="inline-flex min-h-[40px] w-full items-center justify-center gap-1.5 rounded-md bg-[#0EA5E9] px-4 py-2 text-sm font-semibold text-[#0B1117] hover:bg-[#38BDF8]"
              >
                <Plus className="h-4 w-4" />
                Add Tracked Item
              </button>
            </div>
          </section>

          <section className="rounded-lg border border-[#283340] bg-[#161D24] p-5 lg:col-span-7">
            <h2 className="font-['Plus_Jakarta_Sans'] text-base font-bold text-[#F0F6FC]">
              Configured Tracked Items ({items.length})
            </h2>
            {items.length === 0 ? (
              <p className="mt-6 text-sm text-[#8B949E]">
                No Tracked Items configured yet. Add your first product on the left.
              </p>
            ) : (
              <div className="mt-4 divide-y divide-[#283340]">
                {items.map((item) => (
                  <div
                    key={item.id}
                    data-testid={`settings-item-row-${item.id}`}
                    className="flex flex-wrap items-center justify-between gap-4 py-3.5"
                  >
                    <div>
                      <div className="flex items-center gap-2">
                        <span className="text-sm font-semibold text-[#F0F6FC]">{item.name}</span>
                        <span className="text-xs text-[#8B949E]">({item.unitLabel})</span>
                        <span
                          className={`text-xs font-medium ${
                            item.isActive ? 'text-[#4ADE80]' : 'text-[#8B949E]'
                          }`}
                        >
                          {item.isActive ? 'Active' : 'Hidden / Off-Season'}
                        </span>
                      </div>
                      <div className="mt-1 font-mono text-xs tabular-nums text-[#8B949E]">
                        {item.supplyMode === 'continuous'
                          ? `Continuous · ${item.defaultDailyProduction}/day`
                          : 'Discrete Batch Drops'}{' '}
                        · Buffer {item.globalSafetyBuffer} ·{' '}
                        {item.includeInPublicSnippet ? 'Public Snippet On' : 'Private'}
                      </div>
                      {item.keywordRules.length > 0 && (
                        <div className="mt-0.5 text-xs text-[#8B949E]">
                          Keywords: {item.keywordRules.join(', ')}
                        </div>
                      )}
                    </div>

                    <div className="flex items-center gap-2">
                      <button
                        type="button"
                        data-testid={`toggle-item-active-${item.id}`}
                        onClick={() =>
                          void handleToggleItemField(item, { isActive: !item.isActive })
                        }
                        className="min-h-[34px] rounded-md border border-[#283340] bg-[#0F1419] px-3 py-1 text-xs font-medium text-[#C9D1D9] hover:border-[#38BDF8]"
                      >
                        {item.isActive ? 'Hide Off-Season' : 'Activate'}
                      </button>
                      <button
                        type="button"
                        data-testid={`toggle-item-public-${item.id}`}
                        onClick={() =>
                          void handleToggleItemField(item, {
                            includeInPublicSnippet: !item.includeInPublicSnippet,
                          })
                        }
                        className="min-h-[34px] rounded-md border border-[#283340] bg-[#0F1419] px-3 py-1 text-xs font-medium text-[#C9D1D9] hover:border-[#38BDF8]"
                      >
                        {item.includeInPublicSnippet ? 'Public: On' : 'Public: Off'}
                      </button>
                      <button
                        type="button"
                        data-testid={`delete-item-${item.id}`}
                        onClick={() => void handleDeleteItem(item.id)}
                        className="flex h-9 w-9 items-center justify-center rounded-md border border-[#283340] bg-[#0F1419] text-[#8B949E] hover:border-[#F87171] hover:text-[#F87171]"
                        aria-label={`Delete ${item.name}`}
                      >
                        <Trash2 className="h-4 w-4" />
                      </button>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </section>
        </div>
      )}

      {/* 2. PICKUP CHANNELS */}
      {section === 'channels' && (
        <div className="grid grid-cols-1 gap-8 lg:grid-cols-12">
          <section className="rounded-lg border border-[#283340] bg-[#161D24] p-5 lg:col-span-5">
            <h2 className="font-['Plus_Jakarta_Sans'] text-base font-bold text-[#F0F6FC]">
              Add Pickup Channel
            </h2>
            <div className="mt-4 space-y-4">
              <div>
                <label htmlFor="ch-name" className="mb-1 block text-xs font-medium text-[#C9D1D9]">
                  Channel / Market Name
                </label>
                <input
                  id="ch-name"
                  data-testid="settings-channel-name-input"
                  type="text"
                  value={channelName}
                  onChange={(e) => setChannelName(e.target.value)}
                  placeholder="e.g., Self-Serve Farm Store, Wooster Square"
                  className="min-h-[40px] w-full rounded-md border border-[#283340] bg-[#0F1419] px-3 py-2 text-sm text-[#F0F6FC] placeholder:text-[#6E7681]"
                />
              </div>

              <div>
                <label className="mb-2 block text-xs font-medium text-[#C9D1D9]">
                  Schedule Type
                </label>
                <div className="grid grid-cols-3 gap-1.5">
                  {(
                    [
                      { id: 'weekly', label: 'Weekly Days' },
                      { id: 'specific', label: 'Event Dates' },
                      { id: 'any', label: 'Any Date (1-Off)' },
                    ] as const
                  ).map((mode) => (
                    <button
                      key={mode.id}
                      type="button"
                      data-testid={`channel-mode-${mode.id}`}
                      onClick={() => setChannelScheduleMode(mode.id)}
                      className={`min-h-[36px] rounded-md border px-2 py-1.5 text-[11px] font-semibold transition-colors ${
                        channelScheduleMode === mode.id
                          ? 'border-[#38BDF8] bg-[#0EA5E9] text-[#0B1117]'
                          : 'border-[#283340] bg-[#0F1419] text-[#C9D1D9] hover:border-[#38BDF8]'
                      }`}
                    >
                      {mode.label}
                    </button>
                  ))}
                </div>
              </div>

              {channelScheduleMode === 'weekly' && (
                <div>
                  <label className="mb-2 block text-xs font-medium text-[#C9D1D9]">
                    Allowed Pickup Days
                  </label>
                  <div className="grid grid-cols-7 gap-1.5">
                    {[1, 2, 3, 4, 5, 6, 7].map((iso) => {
                      const active = channelWeekdays.includes(iso);
                      return (
                        <button
                          key={iso}
                          type="button"
                          data-testid={`channel-day-${iso}`}
                          onClick={() => toggleChannelDay(iso)}
                          className={`min-h-[38px] rounded-md border text-xs font-semibold transition-colors ${
                            active
                              ? 'border-[#38BDF8] bg-[#0EA5E9] text-[#0B1117]'
                              : 'border-[#283340] bg-[#0F1419] text-[#8B949E]'
                          }`}
                        >
                          {ISO_WEEKDAY_LABELS[iso]}
                        </button>
                      );
                    })}
                  </div>
                </div>
              )}

              {channelScheduleMode === 'specific' && (
                <div>
                  <label
                    htmlFor="ch-specific-date"
                    className="mb-1.5 block text-xs font-medium text-[#C9D1D9]"
                  >
                    Specific / Monthly Event Dates
                  </label>
                  <div className="flex gap-2">
                    <input
                      id="ch-specific-date"
                      data-testid="channel-specific-date-input"
                      type="date"
                      value={channelDateDraft}
                      onChange={(e) => setChannelDateDraft(e.target.value)}
                      className="min-h-[38px] flex-1 rounded-md border border-[#283340] bg-[#0F1419] px-3 py-1.5 font-mono text-xs text-[#F0F6FC]"
                    />
                    <button
                      type="button"
                      data-testid="channel-add-date-btn"
                      onClick={handleAddChannelDateDraft}
                      className="min-h-[38px] rounded-md border border-[#38BDF8]/60 bg-[#1E2730] px-3 text-xs font-semibold text-[#38BDF8] hover:bg-[#25313D]"
                    >
                      + Date
                    </button>
                  </div>
                  <p className="mt-1 text-[11px] text-[#8B949E]">
                    Great for monthly pop-ups on varying dates or 1-off events. You can also toggle
                    dates directly from any calendar day drawer.
                  </p>
                  {channelSpecificDates.length > 0 && (
                    <div className="mt-2 flex flex-wrap gap-1.5">
                      {channelSpecificDates.map((d) => (
                        <span
                          key={d}
                          className="inline-flex items-center gap-1 rounded border border-[#38BDF8]/40 bg-[#0EA5E9]/15 px-2 py-0.5 font-mono text-[11px] text-[#38BDF8]"
                        >
                          {formatShortCalendarDate(d)}
                          <button
                            type="button"
                            aria-label={`Remove ${d}`}
                            onClick={() =>
                              setChannelSpecificDates((prev) => prev.filter((x) => x !== d))
                            }
                            className="hover:text-[#F0F6FC]"
                          >
                            <X className="h-3 w-3" />
                          </button>
                        </span>
                      ))}
                    </div>
                  )}
                </div>
              )}

              {channelScheduleMode === 'any' && (
                <p className="rounded-md border border-[#283340] bg-[#0F1419] p-3 text-xs text-[#8B949E]">
                  Flexible 1-off channel with no weekday restriction — orders can be slotted on any
                  date without triggering a day mismatch warning. You can still pin specific dates
                  to it from any calendar day drawer.
                </p>
              )}

              <button
                type="button"
                data-testid="settings-add-channel-btn"
                onClick={() => void handleAddChannel()}
                className="inline-flex min-h-[40px] w-full items-center justify-center gap-1.5 rounded-md bg-[#0EA5E9] px-4 py-2 text-sm font-semibold text-[#0B1117] hover:bg-[#38BDF8]"
              >
                <Plus className="h-4 w-4" />
                Add Pickup Channel
              </button>
            </div>
          </section>

          <section className="rounded-lg border border-[#283340] bg-[#161D24] p-5 lg:col-span-7">
            <h2 className="font-['Plus_Jakarta_Sans'] text-base font-bold text-[#F0F6FC]">
              Configured Pickup Channels ({channels.length})
            </h2>
            {channels.length === 0 ? (
              <p className="mt-6 text-sm text-[#8B949E]">
                No pickup channels configured yet. Add your farm store, market, or 1-off event
                channels on the left.
              </p>
            ) : (
              <div className="mt-4 divide-y divide-[#283340]">
                {channels.map((ch) => {
                  const specificDates = ch.specificDates ?? [];
                  const inlineDraft = inlineDateDraftByChannel[ch.id] ?? '';
                  const scheduleSummary =
                    ch.allowedWeekdays.length === 7
                      ? 'Every Day (Mon–Sun)'
                      : ch.allowedWeekdays.length > 0
                        ? `Weekly: ${ch.allowedWeekdays.map((d) => ISO_WEEKDAY_LABELS[d]).join(', ')}`
                        : specificDates.length > 0
                          ? `Event Dates Only (${specificDates.length})`
                          : 'Any Date (Flexible 1-Off)';

                  return (
                    <div
                      key={ch.id}
                      data-testid={`settings-channel-row-${ch.id}`}
                      className="space-y-2.5 py-3.5"
                    >
                      <div className="flex items-start justify-between gap-4">
                        <div>
                          <div className="text-sm font-semibold text-[#F0F6FC]">{ch.name}</div>
                          <div className="mt-0.5 text-xs text-[#8B949E]">{scheduleSummary}</div>
                        </div>
                        <button
                          type="button"
                          data-testid={`delete-channel-${ch.id}`}
                          onClick={async () => {
                            await api.deleteChannel(ch.id);
                            await onWorkspaceChanged();
                            onToast('Pickup channel removed');
                          }}
                          className="flex h-9 w-9 shrink-0 items-center justify-center rounded-md border border-[#283340] bg-[#0F1419] text-[#8B949E] hover:border-[#F87171] hover:text-[#F87171]"
                          aria-label={`Delete ${ch.name}`}
                        >
                          <Trash2 className="h-4 w-4" />
                        </button>
                      </div>

                      {/* Event / One-Off Specific Dates Management */}
                      {ch.allowedWeekdays.length < 7 && (
                        <div className="rounded border border-[#283340]/80 bg-[#0F1419]/60 p-2.5">
                          <div className="flex flex-wrap items-center gap-1.5">
                            {specificDates.map((d) => (
                              <span
                                key={d}
                                className="inline-flex items-center gap-1 rounded border border-[#38BDF8]/40 bg-[#0EA5E9]/15 px-2 py-0.5 font-mono text-[11px] text-[#38BDF8]"
                              >
                                {formatShortCalendarDate(d)}
                                <button
                                  type="button"
                                  aria-label={`Remove ${d} from ${ch.name}`}
                                  onClick={() =>
                                    void handleUpdateChannelSpecificDates(
                                      ch,
                                      specificDates.filter((x) => x !== d)
                                    )
                                  }
                                  className="hover:text-[#F0F6FC]"
                                >
                                  <X className="h-3 w-3" />
                                </button>
                              </span>
                            ))}
                            <div className="flex items-center gap-1.5">
                              <input
                                type="date"
                                aria-label={`Add event date for ${ch.name}`}
                                data-testid={`channel-inline-date-input-${ch.id}`}
                                value={inlineDraft}
                                onChange={(e) =>
                                  setInlineDateDraftByChannel((prev) => ({
                                    ...prev,
                                    [ch.id]: e.target.value,
                                  }))
                                }
                                className="h-7 rounded border border-[#283340] bg-[#0F1419] px-2 font-mono text-[11px] text-[#E6EDF3]"
                              />
                              <button
                                type="button"
                                disabled={!inlineDraft}
                                data-testid={`channel-inline-add-date-${ch.id}`}
                                onClick={() => {
                                  if (!inlineDraft) return;
                                  const next = Array.from(
                                    new Set([...specificDates, inlineDraft])
                                  ).sort();
                                  setInlineDateDraftByChannel((prev) => ({
                                    ...prev,
                                    [ch.id]: '',
                                  }));
                                  void handleUpdateChannelSpecificDates(ch, next);
                                }}
                                className="h-7 rounded border border-[#38BDF8]/50 bg-[#1E2730] px-2 text-[11px] font-semibold text-[#38BDF8] hover:bg-[#25313D] disabled:opacity-40"
                              >
                                + Event Date
                              </button>
                            </div>
                          </div>
                        </div>
                      )}
                    </div>
                  );
                })}
              </div>
            )}
          </section>
        </div>
      )}

      {/* 3. ODOO 19.3 SYNC */}
      {section === 'odoo' && (
        <div className="space-y-6">
          <section className="rounded-lg border border-[#283340] bg-[#161D24] p-5">
            <div className="flex flex-wrap items-center justify-between gap-4">
              <div>
                <h2 className="font-['Plus_Jakarta_Sans'] text-base font-bold text-[#F0F6FC]">
                  Odoo 19.3 External API Connection (/json/2/ · Read-Only)
                </h2>
                <p className="mt-1 text-xs text-[#8B949E]">
                  Strictly read-only (uses <code className="font-mono text-[#C9D1D9]">search_read</code>{' '}
                  only — never writes to Odoo). Imports both open Quotations (draft/sent) and
                  processed Sales Orders (sale/done). Credentials stay on the server via Home
                  Assistant Add-on Configuration or local .env.
                </p>
              </div>
              <button
                type="button"
                disabled={testingOdoo || !odooStatus.configured}
                data-testid="test-odoo-connection-btn"
                onClick={() => void handleTestOdoo()}
                className="inline-flex min-h-[38px] items-center gap-1.5 rounded-md border border-[#283340] bg-[#0F1419] px-4 py-2 text-xs font-semibold text-[#E6EDF3] hover:border-[#38BDF8] disabled:opacity-45"
              >
                <RefreshCw className={`h-3.5 w-3.5 ${testingOdoo ? 'animate-spin' : ''}`} />
                Test Connection
              </button>
            </div>

            <dl className="mt-4 grid grid-cols-1 gap-4 border-t border-[#283340] pt-4 text-xs sm:grid-cols-3">
              <div>
                <dt className="text-[#8B949E]">Status</dt>
                <dd
                  data-testid="odoo-status-label"
                  className={`mt-1 font-semibold ${
                    odooStatus.configured ? 'text-[#4ADE80]' : 'text-[#FBBF24]'
                  }`}
                >
                  {odooStatus.configured
                    ? `Configured (${odooStatus.source === 'ha_options' ? 'HA Options' : '.env'})`
                    : 'Not Configured'}
                </dd>
              </div>
              <div>
                <dt className="text-[#8B949E]">Instance Host</dt>
                <dd className="mt-1 font-mono text-[#E6EDF3]">{odooStatus.urlHost || '—'}</dd>
              </div>
              <div>
                <dt className="text-[#8B949E]">Database</dt>
                <dd className="mt-1 font-mono text-[#E6EDF3]">{odooStatus.database || '—'}</dd>
              </div>
            </dl>

            {odooTestResult && (
              <p className="mt-3 rounded-md border border-[#283340] bg-[#0F1419] px-3 py-2 text-xs text-[#C9D1D9]">
                {odooTestResult}
              </p>
            )}
          </section>

          <section className="rounded-lg border border-[#283340] bg-[#161D24] p-5">
            <h2 className="font-['Plus_Jakarta_Sans'] text-base font-bold text-[#F0F6FC]">
              Polling Schedule, Timezone &amp; Seasonal Cutoff
            </h2>

            <div className="mt-4 grid grid-cols-1 gap-4 md:grid-cols-3">
              <div>
                <label htmlFor="sync-interval" className="mb-1 block text-xs font-medium text-[#C9D1D9]">
                  Auto-Polling Interval
                </label>
                <select
                  id="sync-interval"
                  data-testid="settings-sync-interval-select"
                  value={draftSettings.odooSyncInterval}
                  onChange={(e) =>
                    setDraftSettings({
                      ...draftSettings,
                      odooSyncInterval: e.target.value as SyncInterval,
                    })
                  }
                  className="min-h-[40px] w-full rounded-md border border-[#283340] bg-[#0F1419] px-3 py-2 text-sm text-[#F0F6FC]"
                >
                  <option value="15m">Every 15 minutes</option>
                  <option value="30m">Every 30 minutes</option>
                  <option value="1h">Hourly</option>
                  <option value="6h">Every 6 hours</option>
                  <option value="manual">Manual / Paused</option>
                </select>
              </div>

              <div>
                <label htmlFor="sync-tz" className="mb-1 block text-xs font-medium text-[#C9D1D9]">
                  Local Timezone (Odoo UTC Normalization)
                </label>
                <input
                  id="sync-tz"
                  data-testid="settings-timezone-input"
                  type="text"
                  value={draftSettings.timezone}
                  onChange={(e) =>
                    setDraftSettings({ ...draftSettings, timezone: e.target.value })
                  }
                  className="min-h-[40px] w-full rounded-md border border-[#283340] bg-[#0F1419] px-3 py-2 font-mono text-sm text-[#F0F6FC]"
                />
              </div>

              <div>
                <label htmlFor="sync-cutoff" className="mb-1 block text-xs font-medium text-[#C9D1D9]">
                  Sync Cutoff Date (Import New On/After)
                </label>
                <div className="flex items-center gap-2">
                  <input
                    id="sync-cutoff"
                    data-testid="settings-cutoff-date-input"
                    type="date"
                    value={draftSettings.odooSyncCutoffDate ?? ''}
                    onChange={(e) =>
                      setDraftSettings({
                        ...draftSettings,
                        odooSyncCutoffDate: e.target.value || null,
                      })
                    }
                    className="min-h-[40px] flex-1 rounded-md border border-[#283340] bg-[#0F1419] px-3 py-2 font-mono text-sm text-[#F0F6FC]"
                  />
                  <button
                    type="button"
                    data-testid="set-cutoff-today-btn"
                    onClick={() => {
                      setDraftSettings({ ...draftSettings, odooSyncCutoffDate: today });
                      void handleSaveSettings({ odooSyncCutoffDate: today });
                    }}
                    className="min-h-[40px] shrink-0 whitespace-nowrap rounded-md border border-[#38BDF8]/60 bg-[#0F1419] px-3 py-2 text-xs font-semibold text-[#38BDF8] hover:bg-[#1E2730]"
                  >
                    Set Cutoff to Today
                  </button>
                </div>
              </div>
            </div>

            <div className="mt-4 flex justify-end">
              <button
                type="button"
                data-testid="save-odoo-settings-btn"
                onClick={() => void handleSaveSettings()}
                className="min-h-[40px] rounded-md bg-[#0EA5E9] px-5 py-2 text-sm font-semibold text-[#0B1117] hover:bg-[#38BDF8]"
              >
                Save Sync Settings
              </button>
            </div>
          </section>

          <section className="rounded-lg border border-[#283340] bg-[#161D24] p-5">
            <h2 className="font-['Plus_Jakarta_Sans'] text-base font-bold text-[#F0F6FC]">
              Ignored Off-Season Date Ranges
            </h2>
            <p className="mt-1 text-xs text-[#8B949E]">
              Skip Odoo orders inside these local date blocks. By default only brand-new imports are
              skipped — check <strong className="text-[#E6EDF3]">Ignore completely</strong> to also
              clear out already-imported Odoo orders in that range (undoable) and suppress future
              updates or reconciliation alerts.
            </p>

            <div className="mt-4 grid grid-cols-1 gap-3 sm:grid-cols-4 sm:items-end">
              <div>
                <label className="mb-1 block text-xs text-[#C9D1D9]">Start Date</label>
                <input
                  data-testid="ignored-range-start-input"
                  type="date"
                  value={rangeStart}
                  onChange={(e) => setRangeStart(e.target.value)}
                  className="min-h-[38px] w-full rounded-md border border-[#283340] bg-[#0F1419] px-3 py-1.5 font-mono text-sm text-[#F0F6FC]"
                />
              </div>
              <div>
                <label className="mb-1 block text-xs text-[#C9D1D9]">End Date</label>
                <input
                  data-testid="ignored-range-end-input"
                  type="date"
                  value={rangeEnd}
                  onChange={(e) => setRangeEnd(e.target.value)}
                  className="min-h-[38px] w-full rounded-md border border-[#283340] bg-[#0F1419] px-3 py-1.5 font-mono text-sm text-[#F0F6FC]"
                />
              </div>
              <div>
                <label className="mb-1 block text-xs text-[#C9D1D9]">Label (Optional)</label>
                <input
                  data-testid="ignored-range-label-input"
                  type="text"
                  value={rangeLabel}
                  onChange={(e) => setRangeLabel(e.target.value)}
                  placeholder="e.g., Off-Season 2025"
                  className="min-h-[38px] w-full rounded-md border border-[#283340] bg-[#0F1419] px-3 py-1.5 text-sm text-[#F0F6FC] placeholder:text-[#6E7681]"
                />
              </div>
              <button
                type="button"
                data-testid="add-ignored-range-btn"
                onClick={() => void handleAddIgnoredRange()}
                className="min-h-[38px] w-full rounded-md bg-[#0EA5E9] px-4 py-1.5 text-xs font-semibold text-[#0B1117] hover:bg-[#38BDF8]"
              >
                Add Range
              </button>
            </div>

            <label className="mt-3 flex cursor-pointer items-start gap-2.5 rounded-md border border-[#283340] bg-[#0F1419] px-3 py-2.5 text-xs text-[#C9D1D9]">
              <input
                type="checkbox"
                data-testid="ignored-range-complete-checkbox"
                checked={rangeIgnoreExisting}
                onChange={(e) => setRangeIgnoreExisting(e.target.checked)}
                className="mt-0.5 h-4 w-4 rounded border-[#283340] bg-[#161D24] accent-[#0EA5E9]"
              />
              <span>
                <span className="font-semibold text-[#F0F6FC]">
                  Ignore completely (including already-imported Odoo orders)
                </span>
                <span className="mt-0.5 block text-[11px] text-[#8B949E]">
                  Immediately clears existing Odoo orders from this range off your waitlist,
                  calendar, and alerts (1-click Undo available) and blocks future updates. Manual
                  and standing orders are untouched.
                </span>
              </span>
            </label>

            {draftSettings.odooIgnoredDateRanges.length > 0 && (
              <ul className="mt-4 divide-y divide-[#283340] text-xs">
                {draftSettings.odooIgnoredDateRanges.map((r) => (
                  <li
                    key={r.id}
                    data-testid={`ignored-range-row-${r.id}`}
                    className="flex flex-wrap items-center justify-between gap-2 py-2.5"
                  >
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="font-mono text-[#E6EDF3]">
                        {r.startDate} → {r.endDate}
                        {r.label ? ` · ${r.label}` : ''}
                      </span>
                      <span
                        className={`rounded border px-1.5 py-0.5 text-[11px] font-medium ${
                          r.ignoreExisting
                            ? 'border-[#D97706]/50 bg-[#D97706]/15 text-[#FBBF24]'
                            : 'border-[#283340] bg-[#0F1419] text-[#8B949E]'
                        }`}
                      >
                        {r.ignoreExisting ? 'Ignore completely' : 'New imports only'}
                      </span>
                    </div>
                    <div className="flex items-center gap-3">
                      <button
                        type="button"
                        data-testid={`toggle-ignored-range-mode-${r.id}`}
                        onClick={() => void handleToggleIgnoredRangeMode(r.id)}
                        className="text-[#38BDF8] hover:underline"
                      >
                        {r.ignoreExisting ? 'Switch to New Only' : 'Ignore Existing Too'}
                      </button>
                      <button
                        type="button"
                        data-testid={`remove-ignored-range-${r.id}`}
                        onClick={() => void handleRemoveIgnoredRange(r.id)}
                        className="text-[#F87171] hover:underline"
                      >
                        Remove
                      </button>
                    </div>
                  </li>
                ))}
              </ul>
            )}
          </section>
        </div>
      )}

      {/* 4. TEMPLATES & HOLDS */}
      {section === 'templates' && (
        <div className="space-y-6">
          <div className="grid grid-cols-1 gap-6 lg:grid-cols-12">
            {/* Template List Sidebar */}
            <section className="rounded-lg border border-[#283340] bg-[#161D24] p-5 lg:col-span-4">
              <div className="flex items-center justify-between gap-2">
                <h2 className="font-['Plus_Jakarta_Sans'] text-base font-bold text-[#F0F6FC]">
                  Message Templates ({draftTemplates.length})
                </h2>
                <button
                  type="button"
                  data-testid="add-template-btn"
                  onClick={handleAddTemplate}
                  className="inline-flex min-h-[34px] items-center gap-1 rounded-md border border-[#38BDF8]/60 bg-[#0EA5E9]/15 px-2.5 py-1 text-xs font-semibold text-[#38BDF8] hover:bg-[#0EA5E9]/25"
                >
                  <Plus className="h-3.5 w-3.5" />
                  New
                </button>
              </div>
              <p className="mt-1 text-xs text-[#8B949E]">
                Create separate Email (HTML link) and Text/SMS templates, or assign a template to
                specific pickup locations or items.
              </p>

              <div className="mt-4 space-y-2" data-testid="template-list">
                {draftTemplates.map((tmpl) => {
                  const selected = tmpl.id === activeTemplate.id;
                  const ruleLabels: string[] = [];
                  if (tmpl.channelIds.length > 0) {
                    const names = tmpl.channelIds
                      .map((id) => channels.find((c) => c.id === id)?.name)
                      .filter(Boolean);
                    if (names.length > 0) ruleLabels.push(names.join(', '));
                  }
                  if (tmpl.itemIds.length > 0) {
                    const names = tmpl.itemIds
                      .map((id) => items.find((i) => i.id === id)?.name)
                      .filter(Boolean);
                    if (names.length > 0) ruleLabels.push(names.join(', '));
                  }
                  return (
                    <button
                      key={tmpl.id}
                      type="button"
                      data-testid={`template-item-${tmpl.id}`}
                      onClick={() => setSelectedTemplateId(tmpl.id)}
                      className={`w-full rounded-md border p-3 text-left transition-colors ${
                        selected
                          ? 'border-[#38BDF8] bg-[#0EA5E9]/15'
                          : 'border-[#283340] bg-[#0F1419] hover:border-[#3B4958]'
                      }`}
                    >
                      <div className="flex items-center justify-between gap-2">
                        <span className="inline-flex min-w-0 items-center gap-1.5 text-sm font-semibold text-[#F0F6FC]">
                          {tmpl.format === 'html' ? (
                            <Mail className="h-3.5 w-3.5 shrink-0 text-[#38BDF8]" />
                          ) : (
                            <MessageSquare className="h-3.5 w-3.5 shrink-0 text-[#8B949E]" />
                          )}
                          <span className="truncate">{tmpl.name}</span>
                        </span>
                        {tmpl.isDefault && (
                          <span className="shrink-0 rounded bg-[#0EA5E9]/20 px-1.5 py-0.5 text-[10px] font-semibold text-[#38BDF8]">
                            Default
                          </span>
                        )}
                      </div>
                      <div className="mt-1 text-[11px] text-[#8B949E]">
                        {tmpl.format === 'html' ? 'Email · HTML Links' : 'Text / SMS · Plain'}
                        {ruleLabels.length > 0 ? ` · Auto: ${ruleLabels.join(' + ')}` : ''}
                      </div>
                    </button>
                  );
                })}
              </div>
            </section>

            {/* Active Template Editor */}
            <section className="rounded-lg border border-[#283340] bg-[#161D24] p-5 lg:col-span-8">
              <div className="flex flex-wrap items-center justify-between gap-3">
                <h3 className="font-['Plus_Jakarta_Sans'] text-base font-bold text-[#F0F6FC]">
                  Edit Template
                </h3>
                <div className="flex items-center gap-2">
                  <button
                    type="button"
                    data-testid="settings-template-default-btn"
                    disabled={activeTemplate.isDefault}
                    onClick={() => updateActiveTemplate({ isDefault: true })}
                    className={`inline-flex min-h-[34px] items-center gap-1.5 rounded-md border px-2.5 py-1 text-xs font-medium ${
                      activeTemplate.isDefault
                        ? 'border-[#38BDF8]/50 bg-[#0EA5E9]/15 text-[#38BDF8]'
                        : 'border-[#283340] bg-[#0F1419] text-[#C9D1D9] hover:border-[#38BDF8]'
                    }`}
                  >
                    <Star className="h-3.5 w-3.5" />
                    {activeTemplate.isDefault ? 'Default Template' : 'Set as Default'}
                  </button>
                  <button
                    type="button"
                    data-testid="settings-template-delete-btn"
                    disabled={draftTemplates.length <= 1}
                    onClick={() => handleDeleteTemplate(activeTemplate.id)}
                    className="inline-flex min-h-[34px] items-center gap-1 rounded-md border border-[#283340] bg-[#0F1419] px-2.5 py-1 text-xs font-medium text-[#8B949E] hover:border-[#F87171] hover:text-[#F87171] disabled:opacity-40"
                    aria-label={`Delete ${activeTemplate.name}`}
                  >
                    <Trash2 className="h-3.5 w-3.5" />
                    Delete
                  </button>
                </div>
              </div>

              <div className="mt-4 space-y-4">
                <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
                  <div>
                    <label
                      htmlFor="tmpl-name"
                      className="mb-1 block text-xs font-medium text-[#C9D1D9]"
                    >
                      Template Name
                    </label>
                    <input
                      id="tmpl-name"
                      data-testid="settings-template-name-input"
                      type="text"
                      value={activeTemplate.name}
                      onChange={(e) => updateActiveTemplate({ name: e.target.value })}
                      placeholder="e.g., Default Email, SMS / Text, Wooster Square"
                      className="min-h-[40px] w-full rounded-md border border-[#283340] bg-[#0F1419] px-3 py-2 text-sm text-[#F0F6FC]"
                    />
                  </div>

                  <div>
                    <span className="mb-1 block text-xs font-medium text-[#C9D1D9]">
                      Delivery Format
                    </span>
                    <div className="grid grid-cols-2 gap-1.5">
                      {(
                        [
                          { id: 'html', label: 'Email (HTML Links)' },
                          { id: 'plain', label: 'Text / SMS (Plain)' },
                        ] as Array<{ id: TemplateFormat; label: string }>
                      ).map((opt) => (
                        <button
                          key={opt.id}
                          type="button"
                          data-testid={`settings-template-format-${opt.id}`}
                          onClick={() => updateActiveTemplate({ format: opt.id })}
                          className={`min-h-[40px] rounded-md border px-2.5 py-1.5 text-xs font-semibold transition-colors ${
                            activeTemplate.format === opt.id
                              ? 'border-[#38BDF8] bg-[#0EA5E9] text-[#0B1117]'
                              : 'border-[#283340] bg-[#0F1419] text-[#C9D1D9] hover:border-[#38BDF8]'
                          }`}
                        >
                          {opt.label}
                        </button>
                      ))}
                    </div>
                  </div>
                </div>

                {/* Auto-Select Rules: Locations & Items */}
                <div className="rounded-md border border-[#283340] bg-[#0F1419]/70 p-3.5 space-y-3">
                  <div>
                    <span className="text-xs font-semibold text-[#F0F6FC]">
                      Auto-Select Rules (Optional)
                    </span>
                    <p className="mt-0.5 text-[11px] text-[#8B949E]">
                      Leave blank to select manually or use as default. Choose specific pickup
                      locations or items to auto-pick this template when pre-approving matching
                      orders.
                    </p>
                  </div>

                  {channels.length > 0 && (
                    <div>
                      <span className="mb-1.5 block text-[11px] font-medium text-[#C9D1D9]">
                        Pickup Locations / Channels
                      </span>
                      <div className="flex flex-wrap gap-1.5">
                        {channels.map((ch) => {
                          const active = activeTemplate.channelIds.includes(ch.id);
                          return (
                            <button
                              key={ch.id}
                              type="button"
                              data-testid={`settings-template-channel-${ch.id}`}
                              onClick={() => {
                                const next = active
                                  ? activeTemplate.channelIds.filter((id) => id !== ch.id)
                                  : [...activeTemplate.channelIds, ch.id];
                                updateActiveTemplate({ channelIds: next });
                              }}
                              className={`min-h-[30px] rounded-md border px-2.5 py-1 text-xs font-medium transition-colors ${
                                active
                                  ? 'border-[#38BDF8] bg-[#0EA5E9]/20 text-[#38BDF8]'
                                  : 'border-[#283340] bg-[#161D24] text-[#8B949E] hover:text-[#E6EDF3]'
                              }`}
                            >
                              {ch.name}
                            </button>
                          );
                        })}
                      </div>
                    </div>
                  )}

                  {items.length > 0 && (
                    <div>
                      <span className="mb-1.5 block text-[11px] font-medium text-[#C9D1D9]">
                        Tracked Items
                      </span>
                      <div className="flex flex-wrap gap-1.5">
                        {items.map((item) => {
                          const active = activeTemplate.itemIds.includes(item.id);
                          return (
                            <button
                              key={item.id}
                              type="button"
                              data-testid={`settings-template-item-${item.id}`}
                              onClick={() => {
                                const next = active
                                  ? activeTemplate.itemIds.filter((id) => id !== item.id)
                                  : [...activeTemplate.itemIds, item.id];
                                updateActiveTemplate({ itemIds: next });
                              }}
                              className={`min-h-[30px] rounded-md border px-2.5 py-1 text-xs font-medium transition-colors ${
                                active
                                  ? 'border-[#38BDF8] bg-[#0EA5E9]/20 text-[#38BDF8]'
                                  : 'border-[#283340] bg-[#161D24] text-[#8B949E] hover:text-[#E6EDF3]'
                              }`}
                            >
                              {item.name}
                            </button>
                          );
                        })}
                      </div>
                    </div>
                  )}
                </div>

                {/* Insert Store Link Helper */}
                <div className="rounded-md border border-[#283340] bg-[#0F1419]/70 p-3">
                  <div className="mb-2 flex items-center gap-1.5 text-xs font-medium text-[#C9D1D9]">
                    <Link2 className="h-3.5 w-3.5 text-[#38BDF8]" />
                    Insert Store Page Link
                  </div>
                  <div className="grid grid-cols-1 gap-2 sm:grid-cols-12">
                    <input
                      type="text"
                      data-testid="template-link-label-input"
                      value={linkLabelDraft}
                      onChange={(e) => setLinkLabelDraft(e.target.value)}
                      placeholder="Link text (e.g., Order Eggs Here)"
                      className="min-h-[36px] rounded-md border border-[#283340] bg-[#0F1419] px-2.5 py-1.5 text-xs text-[#F0F6FC] placeholder:text-[#6E7681] sm:col-span-4"
                    />
                    <input
                      type="url"
                      data-testid="template-link-url-input"
                      value={linkUrlDraft}
                      onChange={(e) => setLinkUrlDraft(e.target.value)}
                      placeholder="https://yourstore.com/product-page"
                      className="min-h-[36px] rounded-md border border-[#283340] bg-[#0F1419] px-2.5 py-1.5 font-mono text-xs text-[#F0F6FC] placeholder:text-[#6E7681] sm:col-span-5"
                    />
                    <button
                      type="button"
                      data-testid="template-insert-link-btn"
                      onClick={handleInsertStoreLink}
                      className="min-h-[36px] rounded-md border border-[#38BDF8]/60 bg-[#1E2730] px-3 py-1.5 text-xs font-semibold text-[#38BDF8] hover:bg-[#25313D] sm:col-span-3"
                    >
                      + Insert Link
                    </button>
                  </div>
                </div>

                {/* Template Body + Variable Chips */}
                <div>
                  <div className="mb-1.5 flex items-center justify-between gap-2">
                    <label
                      htmlFor="tmpl-text"
                      className="text-xs font-medium text-[#C9D1D9]"
                    >
                      Message Body
                    </label>
                    <span className="text-[11px] text-[#8B949E]">
                      Click a variable to insert
                    </span>
                  </div>
                  <div className="mb-2 space-y-1.5 rounded-md border border-[#283340] bg-[#0F1419]/60 p-2.5">
                    {(() => {
                      const sampleHold = resolveHoldCutoffValues({
                        holdThresholdHours: draftSettings.holdThresholdHours,
                        baseIso: '2026-11-25T19:00:00Z',
                        timezone: draftSettings.timezone,
                      });
                      const sampleOrderCutoff = resolvePublicOrderCutoffValues({
                        pickupDate: '2026-11-28',
                        cutoffRules: draftSettings.publicSnippetCutoffRules,
                        showSameDay: draftSettings.publicSnippetShowSameDay,
                      });
                      const dynamicExample = (key: string, fallback: string) => {
                        if (key === 'hold_cutoff') return sampleHold.holdCutoff;
                        if (key === 'hold_cutoff_by') return sampleHold.holdCutoffBy;
                        if (key === 'hold_cutoff_date') return sampleHold.holdCutoffDate;
                        if (key === 'order_cutoff') return sampleOrderCutoff.orderCutoff;
                        if (key === 'order_cutoff_date') return sampleOrderCutoff.orderCutoffDate;
                        if (key === 'order_cutoff_time') return sampleOrderCutoff.orderCutoffTime;
                        return fallback;
                      };

                      return (
                        [
                          { group: 'name', title: 'Name' },
                          { group: 'date', title: 'Date' },
                          { group: 'order', title: 'Order' },
                          { group: 'hold', title: 'Hold' },
                          { group: 'cutoff', title: 'Cutoff' },
                        ] as const
                      ).map(({ group, title }) => (
                        <div key={group} className="flex flex-wrap items-center gap-1.5">
                          <span className="w-11 shrink-0 text-[10px] font-semibold uppercase tracking-wide text-[#8B949E]">
                            {title}
                          </span>
                          {PRE_APPROVAL_TEMPLATE_VARIABLES.filter((v) => v.group === group).map(
                            (v) => {
                              const example = dynamicExample(v.key, v.example);
                              return (
                                <button
                                  key={v.key}
                                  type="button"
                                  data-testid={`template-var-${v.key}`}
                                  title={`${v.label} — e.g. ${example}`}
                                  onClick={() =>
                                    updateActiveTemplate({
                                      body: `${activeTemplate.body}${activeTemplate.body && !activeTemplate.body.endsWith(' ') && !activeTemplate.body.endsWith('\n') ? ' ' : ''}${v.token}`,
                                    })
                                  }
                                  className="inline-flex items-center gap-1 rounded border border-[#283340] bg-[#161D24] px-1.5 py-0.5 text-[10px] text-[#38BDF8] transition-colors hover:border-[#38BDF8] hover:bg-[#1E2730]"
                                >
                                  <span className="font-mono">+{v.token}</span>
                                  <span className="text-[#8B949E]">({example})</span>
                                </button>
                              );
                            }
                          )}
                        </div>
                      ));
                    })()}
                    <p className="pt-0.5 text-[10px] text-[#8B949E]">
                      <span className="font-medium text-[#C9D1D9]">Cutoff</span> variables use your
                      active Public Order Cutoff Rules from{' '}
                      <span className="text-[#C9D1D9]">Availability Snippet</span> for the
                      order&apos;s pickup date.
                    </p>
                  </div>
                  <textarea
                    id="tmpl-text"
                    data-testid="settings-template-textarea"
                    rows={5}
                    value={activeTemplate.body}
                    onChange={(e) => updateActiveTemplate({ body: e.target.value })}
                    className="w-full rounded-md border border-[#283340] bg-[#0F1419] p-3 text-sm leading-relaxed text-[#F0F6FC] focus:border-[#38BDF8] focus:outline-none"
                  />
                  <p className="mt-1 text-[11px] text-[#8B949E]">
                    Supports clickable links using{' '}
                    <code className="font-mono text-[#C9D1D9]">
                      &lt;a href=&quot;https://...&quot;&gt;Store Page&lt;/a&gt;
                    </code>{' '}
                    or <code className="font-mono text-[#C9D1D9]">[Store Page](https://...)</code>.
                  </p>
                </div>

                {/* Live Preview */}
                <div>
                  <span className="mb-1.5 block text-xs font-medium text-[#C9D1D9]">
                    Live Sample Preview
                  </span>
                  <RichMessagePreview
                    testId="settings-template-preview"
                    text={renderPreApprovalSamplePreview(
                      activeTemplate.body,
                      channels[0]?.name ?? 'Farm Store',
                      {
                        holdThresholdHours: draftSettings.holdThresholdHours,
                        timezone: draftSettings.timezone,
                        publicSnippetCutoffRules: draftSettings.publicSnippetCutoffRules,
                        publicSnippetShowSameDay: draftSettings.publicSnippetShowSameDay,
                      }
                    )}
                  />
                </div>
              </div>
            </section>
          </div>

          {/* Thresholds & Save Bar */}
          <section className="rounded-lg border border-[#283340] bg-[#161D24] p-5">
            <h2 className="font-['Plus_Jakarta_Sans'] text-base font-bold text-[#F0F6FC]">
              Hold Cutoff Threshold
            </h2>
            <p className="mt-1 text-xs text-[#8B949E]">
              Controls when unconfirmed Pre-Approved orders trigger the top{' '}
              <span className="text-[#C9D1D9]">Needs Attention</span> banner (to confirm, bump
              forward, or release) and populates{' '}
              <code className="font-mono text-[#38BDF8]">{'{{hold_cutoff}}'}</code>,{' '}
              <code className="font-mono text-[#38BDF8]">{'{{hold_cutoff_by}}'}</code>, and{' '}
              <code className="font-mono text-[#38BDF8]">{'{{hold_cutoff_date}}'}</code> in your
              templates.
            </p>
            <div className="mt-4 max-w-sm">
              <label htmlFor="hold-hours" className="mb-1 block text-xs font-medium text-[#C9D1D9]">
                Aging Hold Warning Threshold (Hours)
              </label>
              <input
                id="hold-hours"
                data-testid="settings-hold-hours-input"
                type="number"
                min="1"
                max="336"
                value={holdHoursInput}
                onChange={(e) => {
                  const raw = e.target.value;
                  setHoldHoursInput(raw);
                  const parsed = Number.parseInt(raw, 10);
                  if (Number.isFinite(parsed) && parsed >= 1) {
                    setDraftSettings({
                      ...draftSettings,
                      holdThresholdHours: Math.min(336, parsed),
                    });
                  }
                }}
                onBlur={() => {
                  const parsed = Number.parseInt(holdHoursInput, 10);
                  const clamped =
                    Number.isFinite(parsed) && parsed >= 1 ? Math.min(336, parsed) : 48;
                  setHoldHoursInput(String(clamped));
                  setDraftSettings({
                    ...draftSettings,
                    holdThresholdHours: clamped,
                  });
                }}
                className="min-h-[40px] w-full rounded-md border border-[#283340] bg-[#0F1419] px-3 py-2 font-mono text-sm tabular-nums text-[#F0F6FC]"
              />
            </div>

            <div className="mt-4 flex justify-end">
              <button
                type="button"
                data-testid="save-template-settings-btn"
                onClick={() =>
                  void handleSaveSettings({
                    preApprovalTemplates: draftTemplates,
                    preApprovalTemplate:
                      (draftTemplates.find((t) => t.isDefault) ?? draftTemplates[0]).body,
                  })
                }
                className="min-h-[40px] rounded-md bg-[#0EA5E9] px-5 py-2 text-sm font-semibold text-[#0B1117] hover:bg-[#38BDF8]"
              >
                Save Templates &amp; Thresholds
              </button>
            </div>
          </section>
        </div>
      )}
      </fieldset>

      {/* 5. BACKUP & RESTORE */}
      {section === 'backups' && (
        <div className="space-y-6">
          {/* Sandbox Mode Card */}
          <section
            data-testid="sandbox-mode-card"
            className={`rounded-lg border p-5 ${
              sandboxStatus?.active
                ? 'border-[#D97706]/80 bg-[#D97706]/10'
                : 'border-[#283340] bg-[#161D24]'
            }`}
          >
            <div className="flex flex-wrap items-start justify-between gap-4">
              <div className="max-w-2xl">
                <div className="flex items-center gap-2">
                  <FlaskConical
                    className={`h-4 w-4 ${sandboxStatus?.active ? 'text-[#FBBF24]' : 'text-[#38BDF8]'}`}
                    aria-hidden="true"
                  />
                  <h2 className="font-['Plus_Jakarta_Sans'] text-base font-bold text-[#F0F6FC]">
                    Sandbox Mode (Safe Testing Playground)
                  </h2>
                </div>
                <p className="mt-1.5 text-xs leading-relaxed text-[#C9D1D9]">
                  Takes an automatic backup snapshot of your live database right now, then opens a
                  separate duplicate copy so you can experiment freely with scheduling, supply
                  counts, or settings. While Sandbox Mode is active, live website publishing and
                  scheduled background tasks are paused. Exiting discards sandbox changes and loads
                  your untouched live database back.
                </p>
                {sandboxStatus?.active && (
                  <p className="mt-2 font-mono text-[11px] text-[#FBBF24]">
                    Active sandbox session
                    {sandboxStatus.snapshotFilename
                      ? ` • Pre-sandbox backup saved: ${sandboxStatus.snapshotFilename}`
                      : ''}
                  </p>
                )}
                {isBackupPreviewActive && !sandboxStatus?.active && (
                  <p className="mt-2 text-xs text-[#7DD3FC]">
                    Exit Backup Preview before starting a Sandbox session.
                  </p>
                )}
              </div>

              <div className="flex shrink-0 items-center gap-2">
                {sandboxStatus?.active ? (
                  <button
                    type="button"
                    data-testid="settings-exit-sandbox-btn"
                    disabled={sandboxBusy || !onExitSandbox}
                    onClick={() => void onExitSandbox?.().then(() => loadBackups())}
                    className="inline-flex min-h-[40px] items-center gap-2 rounded-md bg-[#D97706] px-4 py-2 text-xs font-semibold text-[#0B1117] hover:bg-[#F59E0B] disabled:opacity-50"
                  >
                    <RotateCcw className="h-4 w-4" aria-hidden="true" />
                    {sandboxBusy ? 'Returning to Live...' : 'Exit Sandbox & Return to Live'}
                  </button>
                ) : (
                  <button
                    type="button"
                    data-testid="enter-sandbox-btn"
                    disabled={sandboxBusy || isBackupPreviewActive || !onEnterSandbox}
                    onClick={() => void onEnterSandbox?.().then(() => loadBackups())}
                    className="inline-flex min-h-[40px] items-center gap-2 rounded-md border border-[#F59E0B]/70 bg-[#D97706]/15 px-4 py-2 text-xs font-semibold text-[#FBBF24] hover:bg-[#D97706]/25 disabled:cursor-not-allowed disabled:opacity-45"
                  >
                    <FlaskConical className="h-4 w-4" aria-hidden="true" />
                    {sandboxBusy ? 'Starting Sandbox...' : 'Enter Sandbox Mode'}
                  </button>
                )}
              </div>
            </div>
          </section>

          <section className="rounded-lg border border-[#283340] bg-[#161D24] p-5">
            <div className="flex flex-wrap items-center justify-between gap-4">
              <div>
                <h2 className="font-['Plus_Jakarta_Sans'] text-base font-bold text-[#F0F6FC]">
                  SQLite Backups &amp; Scheduled Snapshots
                </h2>
                <p className="mt-1 text-xs text-[#8B949E]">
                  Stored inside Home Assistant&apos;s persistent /data/backups/ volume using
                  SQLite&apos;s online backup API. Preview any snapshot in read-only mode before
                  deciding to restore it.
                </p>
                {sandboxStatus?.active && (
                  <p className="mt-1.5 text-xs text-[#FBBF24]">
                    Exit Sandbox Mode to create, preview, or restore live database snapshots.
                  </p>
                )}
                {isBackupPreviewActive && (
                  <p className="mt-1.5 text-xs text-[#7DD3FC]">
                    Read-only Backup Preview is active. You can preview another snapshot, restore
                    any snapshot to your live database, or exit preview to create new backups.
                  </p>
                )}
              </div>
              <div className="flex flex-wrap items-center gap-2">
                <label
                  className={`inline-flex min-h-[40px] items-center gap-2 rounded-md border border-[#283340] bg-[#0F1419] px-4 py-2 text-xs font-semibold text-[#E6EDF3] ${
                    sandboxStatus?.active || isBackupPreviewActive
                      ? 'cursor-not-allowed opacity-45'
                      : 'cursor-pointer hover:border-[#38BDF8]'
                  }`}
                >
                  <Upload className="h-4 w-4" />
                  Upload .db to Restore
                  <input
                    type="file"
                    accept=".db,.sqlite,.sqlite3"
                    data-testid="backup-upload-input"
                    disabled={Boolean(sandboxStatus?.active) || isBackupPreviewActive}
                    onChange={(e) => void handleUploadBackup(e)}
                    className="hidden"
                  />
                </label>
                <button
                  type="button"
                  data-testid="create-backup-now-btn"
                  disabled={Boolean(sandboxStatus?.active) || isBackupPreviewActive}
                  onClick={() => void handleCreateBackup()}
                  className="inline-flex min-h-[40px] items-center gap-2 rounded-md bg-[#0EA5E9] px-4 py-2 text-xs font-semibold text-[#0B1117] hover:bg-[#38BDF8] disabled:cursor-not-allowed disabled:opacity-45"
                >
                  <Database className="h-4 w-4" />
                  Create Snapshot Now
                </button>
              </div>
            </div>

            <div className="mt-4 flex flex-wrap items-center gap-6 border-t border-[#283340] pt-4 text-xs">
              <label className="flex items-center gap-2 text-[#C9D1D9]">
                <input
                  type="checkbox"
                  disabled={isBackupPreviewActive}
                  checked={draftSettings.backupScheduleEnabled}
                  onChange={(e) => {
                    const enabled = e.target.checked;
                    setDraftSettings({ ...draftSettings, backupScheduleEnabled: enabled });
                    void handleSaveSettings({ backupScheduleEnabled: enabled });
                  }}
                  className="h-4 w-4 accent-[#0EA5E9] disabled:cursor-not-allowed disabled:opacity-45"
                />
                Enable Daily Scheduled Backups
              </label>

              <div className="flex items-center gap-2">
                <span className="text-[#8B949E]">Retain last</span>
                <input
                  type="number"
                  min="1"
                  max="90"
                  disabled={isBackupPreviewActive}
                  value={draftSettings.backupRetentionDays}
                  onChange={(e) =>
                    setDraftSettings({
                      ...draftSettings,
                      backupRetentionDays: Math.max(1, Number(e.target.value) || 14),
                    })
                  }
                  onBlur={() => void handleSaveSettings()}
                  className="w-16 rounded border border-[#283340] bg-[#0F1419] px-2 py-1 font-mono text-xs tabular-nums text-[#F0F6FC] disabled:cursor-not-allowed disabled:opacity-45"
                />
                <span className="text-[#8B949E]">daily snapshots</span>
              </div>
            </div>
          </section>

          <section className="rounded-lg border border-[#283340] bg-[#161D24] p-5">
            <h3 className="font-['Plus_Jakarta_Sans'] text-sm font-bold text-[#F0F6FC]">
              Stored Snapshots ({backups.length})
            </h3>
            {loadingBackups ? (
              <p className="mt-4 text-xs text-[#8B949E]">Loading snapshots...</p>
            ) : backups.length === 0 ? (
              <p className="mt-4 text-xs text-[#8B949E]">
                No snapshots created yet. Click &quot;Create Snapshot Now&quot; to make your first
                backup.
              </p>
            ) : (
              <div className="mt-3 overflow-x-auto">
                <table className="w-full border-collapse text-left text-xs">
                  <thead>
                    <tr className="border-b border-[#283340] text-[#8B949E]">
                      <th className="py-2 pr-4 font-semibold">Snapshot File</th>
                      <th className="px-3 py-2 font-semibold">Trigger</th>
                      <th className="px-3 py-2 font-semibold">Size</th>
                      <th className="px-3 py-2 font-semibold">Created</th>
                      <th className="py-2 pl-3 text-right font-semibold">Actions</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-[#283340]">
                    {backups.map((b) => {
                      const isCurrentlyPreviewing =
                        isBackupPreviewActive && backupPreviewStatus?.filename === b.filename;
                      return (
                        <tr
                          key={b.filename}
                          data-testid={`backup-row-${b.filename}`}
                          className={isCurrentlyPreviewing ? 'bg-[#0284C7]/10' : undefined}
                        >
                          <td className="py-2.5 pr-4 font-mono text-[#F0F6FC]">
                            <div className="flex flex-wrap items-center gap-2">
                              <span>{b.filename}</span>
                              {isCurrentlyPreviewing && (
                                <span
                                  data-testid={`backup-previewing-badge-${b.filename}`}
                                  className="inline-flex items-center gap-1 rounded border border-[#38BDF8]/60 bg-[#0284C7]/25 px-1.5 py-0.5 font-sans text-[10px] font-semibold uppercase tracking-wide text-[#BAE6FD]"
                                >
                                  <Eye className="h-3 w-3" aria-hidden="true" />
                                  Previewing
                                </span>
                              )}
                            </div>
                          </td>
                          <td className="px-3 py-2.5 capitalize text-[#C9D1D9]">{b.trigger}</td>
                          <td className="px-3 py-2.5 font-mono tabular-nums text-[#8B949E]">
                            {formatBytes(b.sizeBytes)}
                          </td>
                          <td className="px-3 py-2.5 font-mono tabular-nums text-[#8B949E]">
                            {formatLocalDateTime(new Date(b.createdAt), settings.timezone)}
                          </td>
                          <td className="py-2.5 pl-3 text-right">
                            <div className="inline-flex flex-wrap items-center justify-end gap-2">
                              {isCurrentlyPreviewing ? (
                                <button
                                  type="button"
                                  data-testid={`backup-exit-preview-${b.filename}`}
                                  disabled={backupPreviewBusy || !onExitBackupPreview}
                                  onClick={() => void onExitBackupPreview?.()}
                                  className="inline-flex items-center gap-1 rounded border border-[#38BDF8]/70 bg-[#0284C7]/20 px-2.5 py-1 text-[11px] font-semibold text-[#BAE6FD] hover:bg-[#0284C7]/35 disabled:opacity-45"
                                >
                                  <RotateCcw className="h-3 w-3" />
                                  Exit Preview
                                </button>
                              ) : (
                                <button
                                  type="button"
                                  data-testid={`backup-preview-${b.filename}`}
                                  disabled={
                                    Boolean(sandboxStatus?.active) ||
                                    backupPreviewBusy ||
                                    !onEnterBackupPreview
                                  }
                                  onClick={() => void onEnterBackupPreview?.(b.filename)}
                                  className="inline-flex items-center gap-1 rounded border border-[#38BDF8]/50 bg-[#0F1419] px-2.5 py-1 text-[11px] font-medium text-[#38BDF8] hover:border-[#38BDF8] hover:bg-[#0EA5E9]/10 disabled:cursor-not-allowed disabled:opacity-45"
                                >
                                  <Eye className="h-3 w-3" />
                                  Preview
                                </button>
                              )}
                              <a
                                href={api.backupDownloadUrl(b.filename)}
                                download={b.filename}
                                data-testid={`backup-download-${b.filename}`}
                                className="inline-flex items-center gap-1 rounded border border-[#283340] bg-[#0F1419] px-2.5 py-1 text-[11px] font-medium text-[#E6EDF3] hover:border-[#38BDF8]"
                              >
                                <Download className="h-3 w-3" />
                                Download
                              </a>
                              {confirmRestoreFile === b.filename ? (
                                <button
                                  type="button"
                                  data-testid={`backup-confirm-restore-${b.filename}`}
                                  disabled={Boolean(sandboxStatus?.active)}
                                  onClick={() => void handleRestoreBackup(b.filename)}
                                  className="inline-flex items-center gap-1 rounded bg-[#D97706] px-2.5 py-1 text-[11px] font-semibold text-[#0B1117] disabled:opacity-45"
                                >
                                  <Check className="h-3 w-3" />
                                  Confirm Restore
                                </button>
                              ) : (
                                <button
                                  type="button"
                                  data-testid={`backup-restore-${b.filename}`}
                                  disabled={Boolean(sandboxStatus?.active)}
                                  onClick={() => setConfirmRestoreFile(b.filename)}
                                  className="inline-flex items-center gap-1 rounded border border-[#283340] bg-[#0F1419] px-2.5 py-1 text-[11px] font-medium text-[#FBBF24] hover:border-[#FBBF24] disabled:cursor-not-allowed disabled:opacity-45"
                                >
                                  <RotateCcw className="h-3 w-3" />
                                  Restore
                                </button>
                              )}
                            </div>
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            )}
          </section>
        </div>
      )}
    </main>
  );
}
