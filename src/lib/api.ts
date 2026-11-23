import {
  parseSafeRichMessageSegments,
  renderMessageToPlainText,
  renderMessageToSafeHtml,
} from '../shared/generators';
import type {
  AppSettings,
  BackupInfo,
  CheckpointSummary,
  OdooConnectionStatus,
  OrderItemLine,
  OrderMergeItemStrategy,
  OrderRecord,
  OrderTimingType,
  PickupChannel,
  PublicAvailabilityResult,
  StandingCadence,
  StandingOrder,
  SupplyMode,
  SyncLog,
  TrackedItem,
  WorkspacePayload,
} from '../shared/types';

export class ApiError extends Error {
  public readonly status: number;
  public readonly payload: Record<string, unknown>;

  constructor(status: number, message: string, payload: Record<string, unknown> = {}) {
    super(message);
    this.status = status;
    this.payload = payload;
  }
}

async function requestJson<T>(relativePath: string, init?: RequestInit): Promise<T> {
  // Always use relative ./api/... URLs for Home Assistant Ingress subpath compatibility
  const url = relativePath.startsWith('./') ? relativePath : `./${relativePath.replace(/^\/+/, '')}`;
  const response = await fetch(url, {
    ...init,
    headers: {
      ...(init?.body instanceof FormData ? {} : { 'Content-Type': 'application/json' }),
      ...(init?.headers ?? {}),
    },
  });

  const text = await response.text();
  let data: unknown = {};
  let parsedAsJson = !text;
  if (text) {
    try {
      data = JSON.parse(text);
      parsedAsJson = true;
    } catch {
      data = { error: text };
      parsedAsJson = false;
    }
  }

  if (!response.ok) {
    const obj = (data && typeof data === 'object' ? data : {}) as Record<string, unknown>;
    const msg =
      typeof obj.error === 'string'
        ? obj.error
        : typeof obj.message === 'string'
          ? obj.message
          : `Request failed (${response.status})`;
    throw new ApiError(response.status, msg, obj);
  }

  if (!parsedAsJson) {
    throw new ApiError(
      response.status,
      'Unexpected non-JSON response from server. Please reload and try again.'
    );
  }

  return data as T;
}

/**
 * Clipboard copy utility with legacy document.execCommand('copy') fallback
 * for non-HTTPS local Home Assistant Ingress iframes.
 */
export async function copyTextToClipboard(text: string): Promise<boolean> {
  if (typeof navigator !== 'undefined' && navigator.clipboard?.writeText) {
    try {
      await navigator.clipboard.writeText(text);
      return true;
    } catch {
      // Fall through to execCommand fallback
    }
  }

  if (typeof document === 'undefined') return false;
  const textarea = document.createElement('textarea');
  textarea.value = text;
  textarea.setAttribute('readonly', '');
  textarea.style.position = 'fixed';
  textarea.style.top = '-9999px';
  textarea.style.left = '-9999px';
  document.body.appendChild(textarea);
  textarea.focus();
  textarea.select();
  try {
    const ok = document.execCommand('copy');
    return Boolean(ok);
  } catch {
    return false;
  } finally {
    document.body.removeChild(textarea);
  }
}

/**
 * Copies a message with clickable HTML links (text/html + text/plain) for email composers,
 * with a safe DOM-node execCommand fallback for non-HTTPS local Home Assistant Ingress iframes.
 */
export async function copyRichMessageToClipboard(rawMessage: string): Promise<boolean> {
  const html = renderMessageToSafeHtml(rawMessage);
  const plainText = renderMessageToPlainText(rawMessage);
  const segments = parseSafeRichMessageSegments(rawMessage);
  const hasLinks = segments.some((s) => s.type === 'link');

  if (
    typeof navigator !== 'undefined' &&
    typeof ClipboardItem !== 'undefined' &&
    typeof navigator.clipboard?.write === 'function'
  ) {
    try {
      const item = new ClipboardItem({
        'text/html': new Blob([html], { type: 'text/html' }),
        'text/plain': new Blob([plainText], { type: 'text/plain' }),
      });
      await navigator.clipboard.write([item]);
      return true;
    } catch {
      // Fall through to safe DOM copy
    }
  }

  if (hasLinks && typeof document !== 'undefined' && typeof window !== 'undefined') {
    const container = document.createElement('div');
    container.setAttribute('contenteditable', 'true');
    container.style.position = 'fixed';
    container.style.top = '-9999px';
    container.style.left = '-9999px';
    container.style.whiteSpace = 'pre-wrap';

    for (const seg of segments) {
      if (seg.type === 'newline') {
        container.appendChild(document.createElement('br'));
      } else if (seg.type === 'link') {
        const anchor = document.createElement('a');
        anchor.href = seg.href;
        anchor.textContent = seg.label;
        container.appendChild(anchor);
      } else {
        container.appendChild(document.createTextNode(seg.text));
      }
    }

    document.body.appendChild(container);
    const selection = window.getSelection();
    const range = document.createRange();
    try {
      range.selectNodeContents(container);
      selection?.removeAllRanges();
      selection?.addRange(range);
      const ok = document.execCommand('copy');
      selection?.removeAllRanges();
      if (ok) return true;
    } catch {
      // Fall through to plain text copy
    } finally {
      document.body.removeChild(container);
    }
  }

  return copyTextToClipboard(plainText);
}

export const api = {
  getWorkspace: (weeks = 6) => requestJson<WorkspacePayload>(`./api/workspace?weeks=${weeks}`),

  // Tracked Items
  createItem: (body: {
    name: string;
    unitLabel: string;
    isActive: boolean;
    supplyMode: SupplyMode;
    defaultDailyProduction: number;
    globalSafetyBuffer: number;
    includeInPublicSnippet: boolean;
    keywordRules: string[];
  }) =>
    requestJson<TrackedItem>('./api/items', {
      method: 'POST',
      body: JSON.stringify(body),
    }),

  updateItem: (id: number, body: Partial<TrackedItem>) =>
    requestJson<TrackedItem>(`./api/items/${id}`, {
      method: 'PUT',
      body: JSON.stringify(body),
    }),

  deleteItem: (id: number) =>
    requestJson<{ deleted: boolean }>(`./api/items/${id}`, { method: 'DELETE' }),

  // Pickup Channels
  createChannel: (body: {
    name: string;
    allowedWeekdays: number[];
    specificDates?: string[];
    colorToken?: string;
    isActive?: boolean;
  }) =>
    requestJson<PickupChannel>('./api/channels', {
      method: 'POST',
      body: JSON.stringify(body),
    }),

  updateChannel: (id: number, body: Partial<PickupChannel>) =>
    requestJson<PickupChannel>(`./api/channels/${id}`, {
      method: 'PUT',
      body: JSON.stringify(body),
    }),

  deleteChannel: (id: number) =>
    requestJson<{ deleted: boolean }>(`./api/channels/${id}`, { method: 'DELETE' }),

  // Daily Supply
  updateDailySupply: (
    itemId: number,
    date: string,
    body: {
      actualOnHand: number | null;
      estProduced: number | null;
      cascadeForward: boolean;
      bufferOverride: number | null;
      extraBuffer?: number;
      notes?: string | null;
    }
  ) =>
    requestJson<{ ok: boolean }>(`./api/supply/${itemId}/${date}`, {
      method: 'PUT',
      body: JSON.stringify(body),
    }),

  // Orders
  createOrder: (body: {
    customerName: string;
    customerEmail?: string;
    customerPhone?: string;
    timingType: OrderTimingType;
    requestedDate?: string | null;
    pickupChannelId?: number | null;
    freeTextPickup?: string;
    notes?: string;
    isLocked?: boolean;
    forceWeekday?: boolean;
    items: OrderItemLine[];
  }) =>
    requestJson<OrderRecord>('./api/orders', {
      method: 'POST',
      body: JSON.stringify(body),
    }),

  updateOrder: (
    id: number,
    body: Partial<{
      customerName: string;
      customerEmail: string | null;
      customerPhone: string | null;
      pickupChannelId: number | null;
      status: OrderRecord['status'];
      slottedDate: string | null;
      isLocked: boolean;
      notes: string | null;
      items: OrderItemLine[];
      clearOdooUpdatedFlag: boolean;
    }>
  ) =>
    requestJson<OrderRecord>(`./api/orders/${id}`, {
      method: 'PUT',
      body: JSON.stringify(body),
    }),

  deleteOrder: (id: number) =>
    requestJson<{ deleted: boolean }>(`./api/orders/${id}`, { method: 'DELETE' }),

  slotOrder: (
    id: number,
    body: { date: string | null; forceWeekday?: boolean; overrideLock?: boolean }
  ) =>
    requestJson<OrderRecord>(`./api/orders/${id}/slot`, {
      method: 'POST',
      body: JSON.stringify(body),
    }),

  preApproveOrder: (id: number) =>
    requestJson<{ order: OrderRecord; message: string; selectedTemplateId?: string | null }>(
      `./api/orders/${id}/pre-approve`,
      {
        method: 'POST',
      }
    ),

  releaseHold: (id: number) =>
    requestJson<OrderRecord>(`./api/orders/${id}/release-hold`, { method: 'POST' }),

  ignoreOrder: (id: number) =>
    requestJson<OrderRecord>(`./api/orders/${id}/ignore`, { method: 'POST' }),

  restoreIgnoredOrder: (id: number) =>
    requestJson<OrderRecord>(`./api/orders/${id}/restore-ignored`, { method: 'POST' }),

  reconcileOrder: (id: number, action: 'confirm' | 'keep') =>
    requestJson<OrderRecord>(`./api/orders/${id}/reconcile`, {
      method: 'POST',
      body: JSON.stringify({ action }),
    }),

  mergeOrders: (
    targetOrderId: number,
    sourceOrderId: number,
    itemStrategy: OrderMergeItemStrategy = 'keep_target',
    keepDate?: string | null
  ) =>
    requestJson<{ order: OrderRecord; mergedOrderId: number }>(
      `./api/orders/${targetOrderId}/merge`,
      {
        method: 'POST',
        body: JSON.stringify({
          sourceOrderId,
          itemStrategy,
          ...(keepDate !== undefined ? { keepDate } : {}),
        }),
      }
    ),

  autoSlotAsap: (weeks = 6) =>
    requestJson<{
      slottedCount: number;
      skippedCount: number;
      placements: Array<{ orderId: number; customerName: string; date: string }>;
    }>('./api/orders/auto-slot', {
      method: 'POST',
      body: JSON.stringify({ weeks }),
    }),

  // Standing Orders
  createStandingOrder: (body: {
    customerName: string;
    customerContact?: string;
    pickupChannelId?: number | null;
    cadence: StandingCadence;
    weekday: number;
    startDate: string;
    isActive: boolean;
    notes?: string;
    items: OrderItemLine[];
  }) =>
    requestJson<StandingOrder>('./api/standing-orders', {
      method: 'POST',
      body: JSON.stringify(body),
    }),

  updateStandingOrder: (id: number, body: Partial<StandingOrder>) =>
    requestJson<StandingOrder>(`./api/standing-orders/${id}`, {
      method: 'PUT',
      body: JSON.stringify(body),
    }),

  deleteStandingOrder: (id: number) =>
    requestJson<{ deleted: boolean }>(`./api/standing-orders/${id}`, { method: 'DELETE' }),

  skipStandingOccurrence: (id: number, occurrenceDate: string) =>
    requestJson<{ skipped: boolean }>(`./api/standing-orders/${id}/skip`, {
      method: 'POST',
      body: JSON.stringify({ occurrenceDate }),
    }),

  // Settings & Odoo
  updateSettings: (patch: Partial<AppSettings>) =>
    requestJson<{ settings: AppSettings; odooStatus: OdooConnectionStatus }>('./api/settings', {
      method: 'PUT',
      body: JSON.stringify(patch),
    }),

  testOdoo: () =>
    requestJson<{ ok: boolean; message: string }>('./api/odoo/test', { method: 'POST' }),

  syncOdoo: () =>
    requestJson<{ syncLog: SyncLog }>('./api/odoo/sync', { method: 'POST' }),

  // Public Availability Snippet
  getSnippet: (weeks = 3) =>
    requestJson<PublicAvailabilityResult>(`./api/snippet?weeks=${weeks}`),

  // Checkpoints & Undo
  createCheckpoint: (label?: string) =>
    requestJson<CheckpointSummary>('./api/checkpoints', {
      method: 'POST',
      body: JSON.stringify({ label }),
    }),

  undoLastAction: () =>
    requestJson<{ restoredLabel: string }>('./api/checkpoints/undo', { method: 'POST' }),

  restoreCheckpoint: (id: number) =>
    requestJson<{ restoredLabel: string }>(`./api/checkpoints/${id}/restore`, { method: 'POST' }),

  // Backups
  listBackups: () => requestJson<BackupInfo[]>('./api/backups'),

  createBackup: () => requestJson<BackupInfo>('./api/backups', { method: 'POST' }),

  restoreBackup: (filename: string) =>
    requestJson<{ restored: boolean; safetySnapshot: BackupInfo }>(
      `./api/backups/${encodeURIComponent(filename)}/restore`,
      { method: 'POST' }
    ),

  uploadBackup: (file: File) => {
    const fd = new FormData();
    fd.append('database', file);
    return requestJson<{ restored: boolean; safetySnapshot: BackupInfo }>('./api/backups/upload', {
      method: 'POST',
      body: fd,
    });
  },

  backupDownloadUrl: (filename: string) =>
    `./api/backups/${encodeURIComponent(filename)}/download`,
};
