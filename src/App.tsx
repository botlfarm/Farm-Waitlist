import { useCallback, useEffect, useState } from 'react';
import { AvailabilitySnippetView } from './components/AvailabilitySnippetView';
import { CalendarWorkspace } from './components/CalendarWorkspace';
import { DayDetailDrawer } from './components/DayDetailDrawer';
import { OrderDetailDrawer } from './components/OrderDetailDrawer';
import { OrderListView } from './components/OrderListView';
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
  const [autoSlotting, setAutoSlotting] = useState(false);
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
        // Default to first active item on initial load (Focus on one selected item with All view toggle)
        if (!hasChosenFocus) {
          const firstActive = data.items.find((i) => i.isActive);
          if (firstActive) {
            setFocusedItemId(firstActive.id);
          }
        }
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

  const handleSlotOrder = async (
    orderId: number,
    date: string,
    forceWeekday = false
  ): Promise<boolean> => {
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
            ? `, ${syncLog.flaggedMissingCount} flagged for confirmation`
            : ''
        }`
      );
    } catch (err) {
      showToast(err instanceof Error ? err.message : 'Odoo sync failed', 'error');
    } finally {
      setSyncing(false);
    }
  };

  const handleAutoSlotAsap = async () => {
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
    try {
      const { restoredLabel } = await api.undoLastAction();
      await refreshWorkspace();
      showToast(`Reverted: ${restoredLabel}`);
    } catch (err) {
      showToast(err instanceof Error ? err.message : 'Nothing to undo', 'error');
    }
  };

  return (
    <div className="min-h-screen bg-[#0F1419] text-[#E6EDF3]">
      <TopBar
        activeTab={activeTab}
        onSelectTab={setActiveTab}
        onQuickAdd={() => setQuickAddOpen(true)}
      />

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
                    ? 'Order confirmed'
                    : 'Cleared missing quotation flag'
                );
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
            />
          )}

          {activeTab === 'orders' && (
            <OrderListView
              today={workspace.today}
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
            onClearActualOverride={async (itemId, targetDate) => {
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
                cascadeForward: Boolean(existingProj?.isCascadeAnchor),
                bufferOverride: existingBaseBuffer,
                extraBuffer: existingProj?.extraBuffer ?? 0,
                notes: existingProj?.notes ?? null,
              });
              await refreshWorkspace();
              showToast(`Cleared manual On-Hand override on ${targetDate} — carry-over reconnected`);
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
            onClose={() => setSelectedOrderId(null)}
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
              showToast(action === 'confirm' ? 'Order confirmed' : 'Reconciliation flag cleared');
            }}
            onMergeOrders={async (targetOrderId, sourceOrderId, itemStrategy, keepDate) => {
              try {
                const result = await api.mergeOrders(
                  targetOrderId,
                  sourceOrderId,
                  itemStrategy,
                  keepDate
                );
                await refreshWorkspace();
                setSelectedOrderId(null);
                const keptDate = result.order?.slottedDate;
                showToast(
                  keptDate
                    ? `Merged into 1 order on ${keptDate} — duplicate removed (Undo available)`
                    : 'Merged into 1 unslotted order — duplicate removed (Undo available)'
                );
              } catch (err) {
                showToast(err instanceof Error ? err.message : 'Failed to merge orders', 'error');
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

          {/* Quick Add Order Modal */}
          <QuickAddOrderModal
            open={quickAddOpen}
            today={workspace.today}
            items={workspace.items}
            channels={workspace.channels}
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
