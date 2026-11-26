import { Check, Eye, FlaskConical, RotateCcw } from 'lucide-react';
import { useCallback, useEffect, useState } from 'react';
import { AvailabilitySnippetView } from './components/AvailabilitySnippetView';
import { CalendarWorkspace } from './components/CalendarWorkspace';
import { DayDetailDrawer } from './components/DayDetailDrawer';
import { OrderDetailDrawer } from './components/OrderDetailDrawer';
import { OrderListView } from './components/OrderListView';
import { OrderMergeModal } from './components/OrderMergeModal';
import { PreApprovalModal } from './components/PreApprovalModal';
import { QuickAddOrderModal } from './components/QuickAddOrderModal';
import { SettingsView } from './components/SettingsView';
import { StandingOrdersView } from './components/StandingOrdersView';
import { TopBar, type ActiveTab } from './components/TopBar';
import { ApiError, api } from './lib/api';
import type { CalendarDayProjection, OrderRecord, WorkspacePayload } from './shared/types';

interface ToastState {
  id: number;
  message: string;
  kind: 'info' | 'error';
}

interface WeekdayConfirmPrompt {
  orderId: number;
  date: string;
  message: string;
}

export default function App() {
  const [activeTab, setActiveTab] = useState<ActiveTab>('calendar');
  const [weeks, setWeeks] = useState(6);
  const [workspace, setWorkspace] = useState<WorkspacePayload | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);

  const [focusedItemId, setFocusedItemId] = useState<number | 'all'>('all');
  const [hasChosenFocus, setHasChosenFocus] = useState(false);

  const [selectedDayDate, setSelectedDayDate] = useState<string | null>(null);
  const [selectedOrderId, setSelectedOrderId] = useState<number | null>(null);
  const [mergeModalState, setMergeModalState] = useState<{
    targetOrderId: number;
    initialSourceOrderId: number | null;
    mode: 'replace' | 'merge';
  } | null>(null);
  const [quickAddOpen, setQuickAddOpen] = useState(false);
  const [preApprovalState, setPreApprovalState] = useState<{
    open: boolean;
    order: OrderRecord | null;
    customerName: string;
    message: string;
    templateId: string | null;
  }>({ open: false, order: null, customerName: '', message: '', templateId: null });

  const [weekdayPrompt, setWeekdayPrompt] = useState<WeekdayConfirmPrompt | null>(null);
  const [syncing, setSyncing] = useState(false);
  const [publishingAvailability, setPublishingAvailability] = useState(false);
  const [autoSlotting, setAutoSlotting] = useState(false);
  const [sandboxBusy, setSandboxBusy] = useState(false);
  const [backupPreviewBusy, setBackupPreviewBusy] = useState(false);
  const [confirmRestorePreview, setConfirmRestorePreview] = useState(false);
  const [toast, setToast] = useState<ToastState | null>(null);

  const showToast = useCallback((message: string, kind: 'info' | 'error' = 'info') => {
    const id = Date.now();
    setToast({ id, message, kind });
    setTimeout(() => {
      setToast((curr) => (curr?.id === id ? null : curr));
    }, 4000);
  }, []);

  const refreshWorkspace = useCallback(
    async (targetWeeks: number = weeks) => {
      try {
        const data = await api.getWorkspace(targetWeeks);
        setWorkspace(data);
        setLoadError(null);
        // Default to first active item on initial load, and recover automatically if a restored/switched DB no longer has the previously focused item ID
        const activeItems = data.items.filter((i) => i.isActive);
        setFocusedItemId((prev) => {
          if (prev !== 'all' && activeItems.some((i) => i.id === prev)) {
            return prev;
          }
          if (!hasChosenFocus || prev !== 'all') {
            return activeItems[0]?.id ?? 'all';
          }
          return prev;
        });
      } catch (err) {
        setLoadError(err instanceof Error ? err.message : 'Failed to load Farm Waitlist');
      } finally {
        setLoading(false);
      }
    },
    [weeks, hasChosenFocus]
  );

  useEffect(() => {
    void refreshWorkspace(weeks);
  }, [weeks, refreshWorkspace]);

  const selectedDayIdx =
    selectedDayDate && workspace
      ? workspace.days.findIndex((d) => d.date === selectedDayDate)
      : -1;
  const selectedDay: CalendarDayProjection | null =
    selectedDayIdx >= 0 && workspace ? workspace.days[selectedDayIdx] : null;
  const nextDayAfterSelected: CalendarDayProjection | null =
    selectedDayIdx >= 0 && workspace && selectedDayIdx + 1 < workspace.days.length
      ? workspace.days[selectedDayIdx + 1]
      : null;

  const selectedOrder: OrderRecord | null =
    selectedOrderId && workspace
      ? workspace.orders.find((o) => o.id === selectedOrderId) ??
        workspace.ignoredOrders.find((o) => o.id === selectedOrderId) ??
        null
      : null;

  const mergeModalTargetOrder: OrderRecord | null =
    mergeModalState && workspace
      ? workspace.orders.find((o) => o.id === mergeModalState.targetOrderId) ?? null
      : null;

  const handleSlotOrder = async (
    orderId: number,
    date: string,
    forceWeekday = false
  ): Promise<boolean> => {
    if (workspace?.backupPreviewStatus?.active) {
      showToast('Read-only Backup Preview is active. Exit Backup Preview to make changes.', 'error');
      return false;
    }
    try {
      await api.slotOrder(orderId, { date, forceWeekday });
      setWeekdayPrompt(null);
      await refreshWorkspace();
      showToast(`Order slotted on ${date}`);
      return true;
    } catch (err) {
      if (err instanceof ApiError && err.payload?.weekdayWarning) {
        setWeekdayPrompt({
          orderId,
          date,
          message: err.message,
        });
      } else {
        showToast(err instanceof Error ? err.message : 'Unable to slot order', 'error');
      }
      return false;
    }
  };

  const handleSyncNow = async () => {
    if (workspace?.backupPreviewStatus?.active) return;
    setSyncing(true);
    try {
      const res = await api.syncOdoo();
      const syncLog = res?.syncLog;
      await refreshWorkspace();
      if (!syncLog) {
        showToast('Odoo sync completed, but no summary was returned.', 'error');
        return;
      }
      showToast(
        `Odoo sync complete: ${syncLog.importedCount} imported, ${syncLog.updatedCount} updated${
          syncLog.flaggedMissingCount > 0
            ? `, ${syncLog.flaggedMissingCount} cancelled/removed in Odoo`
            : ''
        }`
      );
    } catch (err) {
      showToast(err instanceof Error ? err.message : 'Odoo sync failed', 'error');
    } finally {
      setSyncing(false);
    }
  };

  const handlePublishAvailability = async () => {
    if (workspace?.backupPreviewStatus?.active) {
      showToast(
        'Publishing to your website is disabled while previewing a backup. Exit Backup Preview first.',
        'error'
      );
      return;
    }
    if (workspace?.sandboxStatus?.active) {
      showToast(
        'Live website publishing is disabled while in Sandbox Mode. Exit Sandbox Mode first.',
        'error'
      );
      return;
    }
    setPublishingAvailability(true);
    try {
      const res = await api.publishSnippetToGithub({ force: true });
      await refreshWorkspace();
      const isPaused = workspace?.settings.publicSnippetEnabled === false;
      showToast(
        res.published
          ? isPaused
            ? 'Published paused waitlist notice to your website'
            : 'Published live availability to your website'
          : res.reason || 'Website availability is already up to date'
      );
    } catch (err) {
      showToast(
        err instanceof Error ? err.message : 'Failed to publish availability to website',
        'error'
      );
    } finally {
      setPublishingAvailability(false);
    }
  };

  const handleEnterSandbox = async () => {
    setSandboxBusy(true);
    try {
      const { backup } = await api.enterSandbox();
      setSelectedDayDate(null);
      setSelectedOrderId(null);
      await refreshWorkspace();
      showToast(
        `Sandbox Mode active — snapshot ${backup.filename} saved. Changes here will not affect live data.`
      );
    } catch (err) {
      showToast(err instanceof Error ? err.message : 'Failed to start Sandbox Mode', 'error');
    } finally {
      setSandboxBusy(false);
    }
  };

  const handleExitSandbox = async () => {
    setSandboxBusy(true);
    try {
      await api.exitSandbox();
      setSelectedDayDate(null);
      setSelectedOrderId(null);
      await refreshWorkspace();
      showToast('Exited Sandbox Mode — live database restored');
    } catch (err) {
      showToast(err instanceof Error ? err.message : 'Failed to exit Sandbox Mode', 'error');
    } finally {
      setSandboxBusy(false);
    }
  };

  const handleEnterBackupPreview = async (filename: string) => {
    setBackupPreviewBusy(true);
    setConfirmRestorePreview(false);
    try {
      await api.enterBackupPreview(filename);
      setSelectedDayDate(null);
      setSelectedOrderId(null);
      setQuickAddOpen(false);
      await refreshWorkspace();
      setActiveTab('calendar');
      showToast(`Previewing ${filename} in read-only mode — no changes can be made.`);
    } catch (err) {
      showToast(err instanceof Error ? err.message : 'Failed to preview backup', 'error');
    } finally {
      setBackupPreviewBusy(false);
    }
  };

  const handleExitBackupPreview = async () => {
    setBackupPreviewBusy(true);
    setConfirmRestorePreview(false);
    try {
      await api.exitBackupPreview();
      setSelectedDayDate(null);
      setSelectedOrderId(null);
      await refreshWorkspace();
      showToast('Exited Backup Preview — returned to live database');
    } catch (err) {
      showToast(err instanceof Error ? err.message : 'Failed to exit Backup Preview', 'error');
    } finally {
      setBackupPreviewBusy(false);
    }
  };

  const handleRestorePreviewedBackup = async () => {
    setBackupPreviewBusy(true);
    try {
      const res = await api.restorePreviewedBackup();
      setConfirmRestorePreview(false);
      setSelectedDayDate(null);
      setSelectedOrderId(null);
      await refreshWorkspace();
      setActiveTab('calendar');
      const countSummary =
        typeof res.ordersCount === 'number' && typeof res.itemsCount === 'number'
          ? ` (${res.itemsCount} item${res.itemsCount === 1 ? '' : 's'}, ${res.ordersCount} order${res.ordersCount === 1 ? '' : 's'})`
          : '';
      showToast(
        `Restored ${res.restoredFrom} to live database${countSummary}. Previous DB saved as ${res.safetySnapshot.filename}.`
      );
    } catch (err) {
      showToast(err instanceof Error ? err.message : 'Failed to restore backup', 'error');
    } finally {
      setBackupPreviewBusy(false);
    }
  };

  const handleAutoSlotAsap = async () => {
    if (workspace?.backupPreviewStatus?.active) return;
    setAutoSlotting(true);
    try {
      const res = await api.autoSlotAsap(weeks);
      await refreshWorkspace();
      showToast(
        res.slottedCount > 0
          ? `Auto-slotted ${res.slottedCount} ASAP order(s)`
          : 'No ASAP orders could fit within current safety buffers'
      );
    } catch (err) {
      showToast(err instanceof Error ? err.message : 'Auto-slot failed', 'error');
    } finally {
      setAutoSlotting(false);
    }
  };

  const handlePreApprove = async (orderId: number) => {
    if (workspace?.backupPreviewStatus?.active) return;
    try {
      const { order, message, selectedTemplateId } = await api.preApproveOrder(orderId);
      await refreshWorkspace();
      setPreApprovalState({
        open: true,
        order,
        customerName: order.customerName,
        message,
        templateId: selectedTemplateId ?? null,
      });
    } catch (err) {
      showToast(err instanceof Error ? err.message : 'Failed to pre-approve', 'error');
    }
  };

  const handleUndo = async () => {
    if (workspace?.backupPreviewStatus?.active) return;
    try {
      const { restoredLabel } = await api.undoLastAction();
      await refreshWorkspace();
      showToast(`Reverted: ${restoredLabel}`);
    } catch (err) {
      showToast(err instanceof Error ? err.message : 'Nothing to undo', 'error');
    }
  };

  const isSandboxActive = Boolean(workspace?.sandboxStatus?.active);
  const isBackupPreviewActive = Boolean(workspace?.backupPreviewStatus?.active);

  return (
    <div className="min-h-screen bg-[#0F1419] text-[#E6EDF3]">
      <div className="sticky top-0 z-30">
        {isSandboxActive && (
          <div
            data-testid="sandbox-mode-banner"
            role="alert"
            className="border-b border-[#B45309] bg-[#D97706] px-4 py-2 text-[#0B1117] md:px-6"
          >
            <div className="flex flex-wrap items-center justify-between gap-2">
              <div className="flex items-center gap-2 text-xs font-medium md:text-sm">
                <FlaskConical className="h-4 w-4 shrink-0" aria-hidden="true" />
                <span className="font-['Plus_Jakarta_Sans'] font-bold uppercase tracking-wide">
                  Sandbox Mode
                </span>
                <span className="hidden text-[#0B1117]/70 sm:inline">—</span>
                <span>
                  Working on a temporary copy of your database. Changes are not permanent and will
                  not affect live data or your website.
                </span>
              </div>
              <button
                type="button"
                data-testid="exit-sandbox-btn"
                disabled={sandboxBusy}
                onClick={() => void handleExitSandbox()}
                className="inline-flex min-h-[32px] shrink-0 items-center gap-1.5 rounded-md bg-[#0B1117] px-3 py-1 text-xs font-semibold text-[#FEF3C7] transition-colors hover:bg-[#161D24] disabled:opacity-50"
              >
                <RotateCcw className="h-3.5 w-3.5" aria-hidden="true" />
                {sandboxBusy ? 'Returning to Live...' : 'Exit Sandbox & Return to Live'}
              </button>
            </div>
          </div>
        )}
        {isBackupPreviewActive && (
          <div
            data-testid="backup-preview-banner"
            role="alert"
            className="border-b border-[#0369A1] bg-[#0284C7] px-4 py-2 text-[#F0F9FF] md:px-6"
          >
            <div className="flex flex-wrap items-center justify-between gap-2">
              <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-xs font-medium md:text-sm">
                <Eye className="h-4 w-4 shrink-0" aria-hidden="true" />
                <span className="font-['Plus_Jakarta_Sans'] font-bold uppercase tracking-wide">
                  Read-Only Backup Preview
                </span>
                <span className="hidden text-[#E0F2FE]/80 sm:inline">—</span>
                <span>
                  Viewing{' '}
                  <strong className="font-mono font-semibold text-white">
                    {workspace?.backupPreviewStatus?.filename}
                  </strong>
                  . No changes can be made while previewing.
                </span>
              </div>
              <div className="flex flex-wrap items-center gap-2">
                {confirmRestorePreview ? (
                  <>
                    <button
                      type="button"
                      data-testid="preview-confirm-restore-btn"
                      disabled={backupPreviewBusy}
                      onClick={() => void handleRestorePreviewedBackup()}
                      className="inline-flex min-h-[32px] shrink-0 items-center gap-1.5 rounded-md bg-[#FBBF24] px-3 py-1 text-xs font-semibold text-[#0B1117] transition-colors hover:bg-[#FCD34D] disabled:opacity-50"
                    >
                      <Check className="h-3.5 w-3.5" aria-hidden="true" />
                      {backupPreviewBusy ? 'Restoring...' : 'Confirm Restore to Live'}
                    </button>
                    <button
                      type="button"
                      data-testid="preview-cancel-restore-btn"
                      disabled={backupPreviewBusy}
                      onClick={() => setConfirmRestorePreview(false)}
                      className="inline-flex min-h-[32px] shrink-0 items-center rounded-md border border-[#BAE6FD]/60 bg-[#0369A1] px-2.5 py-1 text-xs font-medium text-[#F0F9FF] transition-colors hover:bg-[#075985] disabled:opacity-50"
                    >
                      Cancel
                    </button>
                  </>
                ) : (
                  <button
                    type="button"
                    data-testid="preview-restore-backup-btn"
                    disabled={backupPreviewBusy}
                    onClick={() => setConfirmRestorePreview(true)}
                    className="inline-flex min-h-[32px] shrink-0 items-center gap-1.5 rounded-md border border-[#BAE6FD]/60 bg-[#0369A1] px-3 py-1 text-xs font-semibold text-[#F0F9FF] transition-colors hover:bg-[#075985] disabled:opacity-50"
                  >
                    <RotateCcw className="h-3.5 w-3.5" aria-hidden="true" />
                    Restore This Backup
                  </button>
                )}
                <button
                  type="button"
                  data-testid="exit-backup-preview-btn"
                  disabled={backupPreviewBusy}
                  onClick={() => void handleExitBackupPreview()}
                  className="inline-flex min-h-[32px] shrink-0 items-center gap-1.5 rounded-md bg-[#0B1117] px-3 py-1 text-xs font-semibold text-[#E0F2FE] transition-colors hover:bg-[#161D24] disabled:opacity-50"
                >
                  <RotateCcw className="h-3.5 w-3.5" aria-hidden="true" />
                  {backupPreviewBusy ? 'Returning to Live...' : 'Exit Preview & Return to Live'}
                </button>
              </div>
            </div>
          </div>
        )}
        <TopBar
          activeTab={activeTab}
          onSelectTab={setActiveTab}
          onQuickAdd={() => {
            if (!isBackupPreviewActive) setQuickAddOpen(true);
          }}
          readOnly={isBackupPreviewActive}
        />
      </div>

      {loading && !workspace ? (
        <div className="flex items-center justify-center py-24 text-sm text-[#8B949E]">
          Loading Farm Waitlist...
        </div>
      ) : loadError && !workspace ? (
        <div className="mx-auto max-w-lg px-6 py-16">
          <div className="rounded-lg border border-[#DC2626]/60 bg-[#DC2626]/10 p-5 text-sm text-[#F87171]">
            <p className="font-semibold">Unable to load Farm Waitlist</p>
            <p className="mt-1 text-xs">{loadError}</p>
            <button
              type="button"
              onClick={() => void refreshWorkspace()}
              className="mt-4 rounded-md bg-[#0EA5E9] px-4 py-2 text-xs font-semibold text-[#0B1117]"
            >
              Retry
            </button>
          </div>
        </div>
      ) : workspace ? (
        <>
          {activeTab === 'calendar' && (
            <CalendarWorkspace
              workspace={workspace}
              readOnly={isBackupPreviewActive}
              focusedItemId={focusedItemId}
              onChangeFocusedItem={(id) => {
                setHasChosenFocus(true);
                setFocusedItemId(id);
              }}
              onSelectDay={(day) => setSelectedDayDate(day.date)}
              onSelectOrder={(order) => setSelectedOrderId(order.id)}
              onDropOrderOnDate={async (orderId, date) => {
                await handleSlotOrder(orderId, date, false);
              }}
              onSyncNow={handleSyncNow}
              syncing={syncing}
              onPublishAvailability={handlePublishAvailability}
              publishingAvailability={publishingAvailability}
              onAutoSlotAsap={handleAutoSlotAsap}
              autoSlotting={autoSlotting}
              onUndo={handleUndo}
              onCreateCheckpoint={async () => {
                await api.createCheckpoint();
                await refreshWorkspace();
                showToast('Checkpoint snapshot saved');
              }}
              onRestoreCheckpoint={async (id) => {
                const res = await api.restoreCheckpoint(id);
                await refreshWorkspace();
                showToast(`Reverted to checkpoint: ${res.restoredLabel}`);
              }}
              onExtendWeeks={() => setWeeks((w) => Math.min(26, w + 2))}
              onOpenSettings={() => setActiveTab('settings')}
              onReconcile={async (orderId, action) => {
                await api.reconcileOrder(orderId, action);
                await refreshWorkspace();
                showToast(
                  action === 'confirm'
                    ? 'Order marked confirmed'
                    : action === 'ignore'
                      ? 'Cancelled quotation removed from schedule (Undo available)'
                      : 'Order kept active & missing flag cleared'
                );
              }}
              onOpenMergeReview={(targetOrderId, sourceOrderId, mode) =>
                setMergeModalState({ targetOrderId, initialSourceOrderId: sourceOrderId, mode })
              }
              onConfirmOrder={async (orderId) => {
                await api.updateOrder(orderId, { status: 'confirmed' });
                await refreshWorkspace();
                showToast('Order marked confirmed (Undo available)');
              }}
              onBumpOrder={async (orderId, targetDate) => {
                const res = await api.bumpOrder(orderId, targetDate);
                await refreshWorkspace();
                showToast(`Bumped order to ${res.bumpedToDate} (Undo available)`);
              }}
              onReleaseHold={async (orderId) => {
                await api.releaseHold(orderId);
                await refreshWorkspace();
                showToast('Hold released — order returned to Waitlist');
              }}
              onRestoreIgnored={async (orderId) => {
                await api.restoreIgnoredOrder(orderId);
                await refreshWorkspace();
                showToast('Quotation restored to Waitlist');
              }}
              onReorderWaitlist={async (orderIds) => {
                await api.reorderWaitlistOrders({ orderIds });
                await refreshWorkspace();
              }}
              onResetWaitlistOrder={async () => {
                await api.reorderWaitlistOrders({ reset: true });
                await refreshWorkspace();
                showToast('Waitlist sorted by arrival date (oldest first)');
              }}
            />
          )}

          {activeTab === 'orders' && (
            <OrderListView
              today={workspace.today}
              timezone={workspace.settings.timezone}
              orders={workspace.orders}
              items={workspace.items}
              channels={workspace.channels}
              onSelectOrder={(order) => setSelectedOrderId(order.id)}
              onToast={showToast}
            />
          )}

          {activeTab === 'standing' && (
            <StandingOrdersView
              today={workspace.today}
              items={workspace.items}
              channels={workspace.channels}
              standingOrders={workspace.standingOrders}
              odooConfigured={workspace.odooStatus.configured}
              readOnly={isBackupPreviewActive}
              onCreate={async (payload) => {
                await api.createStandingOrder(payload);
                await refreshWorkspace();
                showToast('Standing recurring order created');
              }}
              onToggleActive={async (rule) => {
                await api.updateStandingOrder(rule.id, { isActive: !rule.isActive });
                await refreshWorkspace();
                showToast(rule.isActive ? 'Standing order paused' : 'Standing order resumed');
              }}
              onDelete={async (id) => {
                await api.deleteStandingOrder(id);
                await refreshWorkspace();
                showToast('Standing order deleted');
              }}
            />
          )}

          {activeTab === 'snippet' && (
            <AvailabilitySnippetView
              defaultWeeks={workspace.settings.publicSnippetWeeks}
              settings={workspace.settings}
              githubPublishStatus={workspace.githubPublishStatus}
              isSandboxMode={isSandboxActive}
              readOnly={isBackupPreviewActive}
              onSettingsSaved={() => refreshWorkspace()}
              onToast={showToast}
            />
          )}

          {activeTab === 'settings' && (
            <SettingsView
              today={workspace.today}
              settings={workspace.settings}
              odooStatus={workspace.odooStatus}
              items={workspace.items}
              channels={workspace.channels}
              sandboxStatus={workspace.sandboxStatus}
              sandboxBusy={sandboxBusy}
              onEnterSandbox={handleEnterSandbox}
              onExitSandbox={handleExitSandbox}
              backupPreviewStatus={workspace.backupPreviewStatus}
              backupPreviewBusy={backupPreviewBusy}
              onEnterBackupPreview={handleEnterBackupPreview}
              onExitBackupPreview={handleExitBackupPreview}
              onNavigateToCalendar={() => setActiveTab('calendar')}
              onWorkspaceChanged={() => refreshWorkspace()}
              onToast={showToast}
            />
          )}

          {/* Day Supply Detail Drawer */}
          <DayDetailDrawer
            day={selectedDay}
            today={workspace.today}
            nextDay={nextDayAfterSelected}
            items={workspace.items}
            channels={workspace.channels}
            initialFocusedItemId={focusedItemId}
            readOnly={isBackupPreviewActive}
            onClose={() => setSelectedDayDate(null)}
            onSaveSupply={async (itemId, date, payload) => {
              await api.updateDailySupply(itemId, date, payload);
              await refreshWorkspace();
              showToast(
                payload.cascadeForward
                  ? `Saved & cascaded production forward from ${date}`
                  : `Saved supply update for ${date}`
              );
              setSelectedDayDate(null);
            }}
            onClearActualOverride={async (itemId, targetDate, scope = 'both') => {
              const targetDay = workspace.days.find((d) => d.date === targetDate);
              const existingProj = targetDay?.byItem[itemId];
              const existingBaseBuffer = existingProj?.hasBufferOverride
                ? Math.max(
                    0,
                    Number((existingProj.effectiveBuffer - existingProj.extraBuffer).toFixed(3))
                  )
                : null;
              await api.updateDailySupply(itemId, targetDate, {
                actualOnHand: null,
                estProduced: existingProj?.isManualProducedOverride ? existingProj.estProduced : null,
                actualEndOfDay: scope === 'morning' ? (existingProj?.actualEndOfDay ?? null) : null,
                cascadeForward: Boolean(existingProj?.isCascadeAnchor),
                bufferOverride: existingBaseBuffer,
                extraBuffer: existingProj?.extraBuffer ?? 0,
                selfConsumption: existingProj?.selfConsumption ?? 0,
                walkUpConsumption: existingProj?.walkUpConsumption ?? 0,
                notes: existingProj?.notes ?? null,
              });
              await refreshWorkspace();
              showToast(`Cleared manual count override on ${targetDate} — carry-over reconnected`);
            }}
            onToggleChannelDate={async (channel, date, attach) => {
              const currentDates = channel.specificDates ?? [];
              const nextDates = attach
                ? Array.from(new Set([...currentDates, date])).sort()
                : currentDates.filter((d) => d !== date);
              await api.updateChannel(channel.id, { specificDates: nextDates });
              await refreshWorkspace();
              showToast(
                attach
                  ? `Added ${channel.name} to ${date}`
                  : `Removed ${channel.name} from ${date}`
              );
            }}
          />

          {/* Order Detail Drawer */}
          <OrderDetailDrawer
            order={selectedOrder}
            allOrders={workspace.orders}
            items={workspace.items}
            channels={workspace.channels}
            days={workspace.days}
            today={workspace.today}
            weeks={workspace.weeks}
            holdThresholdHours={workspace.settings.holdThresholdHours}
            odooConfigured={workspace.odooStatus.configured}
            readOnly={isBackupPreviewActive}
            onClose={() => setSelectedOrderId(null)}
            onSelectOrder={(orderId) => setSelectedOrderId(orderId)}
            onSaveOrder={async (orderId, patch) => {
              await api.updateOrder(orderId, patch);
              await refreshWorkspace();
              showToast('Order updated');
              setSelectedOrderId(null);
            }}
            onQuickSlotOrder={async (orderId, date, draftPatch) => {
              if (draftPatch) {
                await api.updateOrder(orderId, draftPatch);
              }
              const ok = await handleSlotOrder(orderId, date, false);
              if (ok) {
                setSelectedOrderId(null);
              }
            }}
            onExtendWeeks={() => setWeeks((w) => Math.min(26, w + 2))}
            onPreApprove={handlePreApprove}
            onConfirmOrder={async (orderId) => {
              await api.updateOrder(orderId, { status: 'confirmed' });
              await refreshWorkspace();
              showToast('Order marked confirmed (Undo available)');
              setSelectedOrderId(null);
            }}
            onBumpOrder={async (orderId, targetDate) => {
              const res = await api.bumpOrder(orderId, targetDate);
              await refreshWorkspace();
              showToast(`Bumped order to ${res.bumpedToDate} (Undo available)`);
              setSelectedOrderId(null);
            }}
            onReleaseHold={async (orderId) => {
              await api.releaseHold(orderId);
              await refreshWorkspace();
              showToast('Hold released — order returned to Waitlist');
              setSelectedOrderId(null);
            }}
            onIgnore={async (orderId) => {
              await api.ignoreOrder(orderId);
              await refreshWorkspace();
              showToast('Quotation dismissed and ignored for future syncs');
              setSelectedOrderId(null);
            }}
            onRestoreIgnored={async (orderId) => {
              await api.restoreIgnoredOrder(orderId);
              await refreshWorkspace();
              showToast('Quotation restored to Waitlist');
            }}
            onReconcile={async (orderId, action) => {
              await api.reconcileOrder(orderId, action);
              await refreshWorkspace();
              if (action === 'ignore') {
                setSelectedOrderId(null);
              }
              showToast(
                action === 'confirm'
                  ? 'Order marked confirmed'
                  : action === 'ignore'
                    ? 'Cancelled quotation removed from schedule (Undo available)'
                    : 'Order kept active & missing flag cleared'
              );
            }}
            onOpenMergeReview={(targetOrderId, sourceOrderId, mode) =>
              setMergeModalState({ targetOrderId, initialSourceOrderId: sourceOrderId, mode })
            }
            onDismissDuplicate={async (orderId, otherOrderId) => {
              try {
                await api.dismissDuplicateOrder(orderId, otherOrderId);
                await refreshWorkspace();
                showToast('Dismissed — marked as not a duplicate');
              } catch (err) {
                showToast(
                  err instanceof Error ? err.message : 'Failed to dismiss duplicate notice',
                  'error'
                );
              }
            }}
            onDeleteOrder={async (orderId) => {
              await api.deleteOrder(orderId);
              await refreshWorkspace();
              showToast('Order deleted');
              setSelectedOrderId(null);
            }}
            onSkipStandingOccurrence={async (standingId, occDate) => {
              await api.skipStandingOccurrence(standingId, occDate);
              await refreshWorkspace();
              showToast(`Skipped standing occurrence on ${occDate}`);
              setSelectedOrderId(null);
            }}
          />

          {/* Side-by-Side Order Merge & Cancelled Pre-Order Match Modal */}
          <OrderMergeModal
            open={Boolean(mergeModalState && mergeModalTargetOrder)}
            targetOrder={mergeModalTargetOrder}
            initialSourceOrderId={mergeModalState?.initialSourceOrderId ?? null}
            mode={mergeModalState?.mode ?? 'merge'}
            allOrders={workspace.orders}
            items={workspace.items}
            channels={workspace.channels}
            readOnly={isBackupPreviewActive}
            onClose={() => setMergeModalState(null)}
            onSelectOrder={(orderId) => {
              setMergeModalState(null);
              setSelectedOrderId(orderId);
            }}
            onApproveMerge={async (targetOrderId, sourceOrderId, itemStrategy, keepDate) => {
              try {
                const result = await api.mergeOrders(
                  targetOrderId,
                  sourceOrderId,
                  itemStrategy,
                  keepDate
                );
                await refreshWorkspace();
                setMergeModalState(null);
                setSelectedOrderId(null);
                const activeRef = result.order?.odooQuotationName || result.order?.customerName;
                const keptDate = result.order?.slottedDate;
                showToast(
                  keptDate
                    ? `Approved: ${activeRef || '1 order'} on ${keptDate} — duplicate removed (Undo available)`
                    : `Approved: ${activeRef || '1 unslotted order'} — duplicate removed (Undo available)`
                );
              } catch (err) {
                showToast(err instanceof Error ? err.message : 'Failed to merge orders', 'error');
              }
            }}
            onDismissDuplicate={async (orderId, otherOrderId) => {
              try {
                await api.dismissDuplicateOrder(orderId, otherOrderId);
                await refreshWorkspace();
                showToast('Dismissed — marked as not a duplicate');
              } catch (err) {
                showToast(
                  err instanceof Error ? err.message : 'Failed to dismiss duplicate notice',
                  'error'
                );
              }
            }}
          />

          {/* Quick Add Order Modal */}
          <QuickAddOrderModal
            open={quickAddOpen}
            today={workspace.today}
            items={workspace.items}
            channels={workspace.channels}
            odooConfigured={workspace.odooStatus.configured}
            onClose={() => setQuickAddOpen(false)}
            onSubmit={async (payload) => {
              await api.createOrder(payload);
              await refreshWorkspace();
              showToast(
                payload.timingType === 'specific_date'
                  ? `Order added and slotted on ${payload.requestedDate}`
                  : 'Order added to Waitlist Queue'
              );
            }}
          />

          {/* Pre-Approval Ready-to-Copy Modal */}
          <PreApprovalModal
            open={preApprovalState.open}
            order={preApprovalState.order}
            customerName={preApprovalState.customerName}
            initialMessage={preApprovalState.message}
            initialTemplateId={preApprovalState.templateId}
            templates={workspace.settings.preApprovalTemplates ?? []}
            items={workspace.items}
            channels={workspace.channels}
            holdThresholdHours={workspace.settings.holdThresholdHours}
            timezone={workspace.settings.timezone}
            publicSnippetCutoffRules={workspace.settings.publicSnippetCutoffRules}
            publicSnippetShowSameDay={workspace.settings.publicSnippetShowSameDay}
            onClose={() =>
              setPreApprovalState({
                open: false,
                order: null,
                customerName: '',
                message: '',
                templateId: null,
              })
            }
          />

          {/* Weekday Channel Mismatch Confirmation Dialog */}
          {weekdayPrompt && (
            <div
              data-testid="weekday-warning-modal"
              className="fixed inset-0 z-[60] flex items-center justify-center bg-black/65 p-4"
              role="dialog"
              aria-modal="true"
            >
              <div className="w-full max-w-md rounded-lg border border-[#D97706]/60 bg-[#161D24] p-6">
                <h2 className="font-['Plus_Jakarta_Sans'] text-base font-bold text-[#FBBF24]">
                  Pickup Channel Day Mismatch
                </h2>
                <p className="mt-2 text-sm text-[#C9D1D9]">{weekdayPrompt.message}</p>
                <div className="mt-5 flex justify-end gap-2">
                  <button
                    type="button"
                    onClick={() => setWeekdayPrompt(null)}
                    className="min-h-[38px] rounded-md border border-[#283340] bg-[#0F1419] px-4 py-1.5 text-xs font-medium text-[#C9D1D9]"
                  >
                    Cancel
                  </button>
                  <button
                    type="button"
                    data-testid="confirm-force-weekday-btn"
                    onClick={async () => {
                      const ok = await handleSlotOrder(
                        weekdayPrompt.orderId,
                        weekdayPrompt.date,
                        true
                      );
                      if (ok) {
                        setSelectedOrderId(null);
                      }
                    }}
                    className="min-h-[38px] rounded-md bg-[#D97706] px-4 py-1.5 text-xs font-semibold text-[#0B1117]"
                  >
                    Slot Anyway
                  </button>
                </div>
              </div>
            </div>
          )}
        </>
      ) : null}

      {/* Non-intrusive Toast Notification */}
      {toast && (
        <div
          data-testid="toast-notification"
          role="status"
          className={`fixed right-5 bottom-5 z-50 max-w-sm rounded-md border px-4 py-3 text-xs font-medium shadow-lg ${
            toast.kind === 'error'
              ? 'border-[#DC2626] bg-[#1F1215] text-[#FCA5A5]'
              : 'border-[#38BDF8]/60 bg-[#161D24] text-[#F0F6FC]'
          }`}
        >
          {toast.message}
        </div>
      )}
    </div>
  );
}
