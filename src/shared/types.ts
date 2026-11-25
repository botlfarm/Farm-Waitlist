export type SupplyMode = 'continuous' | 'discrete';
export type OrderSource = 'odoo' | 'manual' | 'standing';
export type OrderStatus = 'waitlist' | 'slotted' | 'pre_approved' | 'confirmed' | 'ignored';
export type OrderTimingType = 'asap' | 'specific_date';
export type StandingCadence = 'weekly' | 'biweekly' | 'monthly';
export type AvailabilityTier = 'green' | 'amber' | 'red';
export type SyncInterval = '15m' | '30m' | '1h' | '6h' | 'manual';
export type BackupTrigger = 'manual' | 'scheduled' | 'pre-migrate' | 'pre-restore' | 'pre-sandbox';
export type OrderMergeItemStrategy = 'keep_target' | 'use_source' | 'combine';
export type TemplateFormat = 'html' | 'plain';
export type SnippetCutoffMode = 'days_before' | 'weekly_day';
export type GithubPublishMode = 'manual' | 'auto';
export type GithubPublishInterval = '15m' | '30m' | '1h' | '6h';

export interface SnippetCutoffRule {
  id: string;
  enabled: boolean;
  mode: SnippetCutoffMode;
  /** Used when mode === 'days_before': 0 = same day, 1 = day before, 2 = 2 days before, etc. */
  daysBefore: number;
  /** Used when mode === 'weekly_day': ISO weekday 1 (Mon) .. 7 (Sun) when ordering closes. */
  cutoffWeekday: number;
  /** 24-hour local farm time "HH:MM" (e.g., "16:00"). */
  cutoffTime: string;
  /** ISO weekdays 1..7 of pickup dates this rule applies to. Empty = every pickup day. */
  pickupWeekdays: number[];
}

export interface PreApprovalTemplate {
  id: string;
  name: string;
  format: TemplateFormat;
  body: string;
  isDefault: boolean;
  channelIds: number[];
  itemIds: number[];
}

export interface IgnoredDateRange {
  id: string;
  startDate: string; // YYYY-MM-DD (local timezone)
  endDate: string;   // YYYY-MM-DD (local timezone)
  label?: string;
  /** When true, ignores ALL Odoo orders in this range (skips new imports AND removes already-imported orders). */
  ignoreExisting?: boolean;
}

export interface AppSettings {
  timezone: string;
  odooSyncInterval: SyncInterval;
  odooSyncCutoffDate: string | null; // YYYY-MM-DD in local timezone
  odooIgnoredDateRanges: IgnoredDateRange[];
  preApprovalTemplate: string;
  preApprovalTemplates?: PreApprovalTemplate[];
  holdThresholdHours: number;
  backupScheduleEnabled: boolean;
  backupRetentionDays: number;
  publicSnippetWeeks: number;
  publicSnippetEnabled?: boolean;
  publicSnippetPausedPreset?: string;
  publicSnippetPausedMessage?: string;
  publicSnippetShowSameDay?: boolean;
  publicSnippetCutoffRules?: SnippetCutoffRule[];
  publicSnippetHeaderTitle?: string;
  publicSnippetHeaderText?: string;
  publicSnippetFooterText?: string;
  publicSnippetAutoAdvanceToday?: boolean;
  githubPublishMode?: GithubPublishMode;
  githubPublishInterval?: GithubPublishInterval;
  githubPublishIdleMinutes?: number;
  githubPublishRepo?: string;
  githubPublishBranch?: string;
  githubPublishPath?: string;
  githubPublishPublicUrl?: string;
  githubLastPublishedAt?: string | null;
  githubLastPublishedHash?: string | null;
  githubLastPublishStatus?: 'never' | 'success' | 'error';
  githubLastPublishError?: string | null;
  availabilityLastEditedAt?: string | null;
}

export interface TrackedItem {
  id: number;
  name: string;
  unitLabel: string;
  isActive: boolean;
  supplyMode: SupplyMode;
  defaultDailyProduction: number;
  globalSafetyBuffer: number;
  includeInPublicSnippet: boolean;
  keywordRules: string[];
  sortOrder: number;
  createdAt: string;
  updatedAt: string;
}

export interface PickupChannel {
  id: number;
  name: string;
  allowedWeekdays: number[]; // ISO weekdays: 1 = Mon .. 7 = Sun (empty for date-only / any-date 1-off channels)
  specificDates?: string[];  // Optional explicit YYYY-MM-DD event dates (e.g., monthly varying dates or 1-off pop-ups)
  colorToken: string;
  isActive: boolean;
  sortOrder: number;
}

export interface DailySupplyEntry {
  id: number;
  trackedItemId: number;
  date: string; // YYYY-MM-DD
  actualOnHand: number | null;
  estProduced: number | null;
  actualEndOfDay?: number | null;
  isCascadeAnchor: boolean;
  bufferOverride: number | null;
  extraBuffer?: number; // Additional single-day safety buffer / walk-up event holdback added on top of base buffer
  selfConsumption?: number; // Personal / farm self-consumption deducted like an order without creating a draggable order
  notes: string | null;
}

export interface OrderItemLine {
  id?: number;
  orderId?: number;
  trackedItemId: number;
  quantity: number;
}

export interface OrderChatterMessage {
  id: number;
  orderId: number;
  odooMessageId: number;
  authorName: string;
  messageType: 'comment' | 'email';
  subtypeName: string | null;
  bodyText: string;
  createdAtUtc: string;
  createdAtLocal: string;
}

export interface SuggestedConfirmedOrder {
  odooOrderId: number;
  odooOrderName: string;
  partnerName: string;
  dateOrderLocal: string;
  state: string;
  amountTotal?: number;
}

export interface OrderRecord {
  id: number;
  source: OrderSource;
  status: OrderStatus;
  timingType: OrderTimingType;
  requestedDate: string | null;
  slottedDate: string | null;
  isLocked: boolean;
  customerName: string;
  customerNameOverridden: boolean;
  customerEmail: string | null;
  customerPhone: string | null;
  pickupChannelId: number | null;
  freeTextPickup: string | null;
  notes: string | null;
  preApprovedAt: string | null;
  standingOrderId: number | null;
  standingOccurrenceDate: string | null;
  odooQuotationId: number | null;
  odooQuotationName: string | null;
  odooPartnerId: number | null;
  odooCreatedAtLocal: string | null;
  odooRawNotes: string | null;
  odooRawLines: string[];
  odooUpdatedAfterSlot: boolean;
  odooMissingFlagged: boolean;
  odooSuggestedConfirmed: SuggestedConfirmedOrder | null;
  mergedOdooNames?: string[];
  dismissedDuplicateOrderIds?: number[];
  waitlistSortOrder?: number | null;
  items: OrderItemLine[];
  chatter: OrderChatterMessage[];
  createdAt: string;
  updatedAt: string;
}

export interface StandingOrderItemLine {
  trackedItemId: number;
  quantity: number;
}

export interface StandingOrder {
  id: number;
  customerName: string;
  customerContact: string | null;
  pickupChannelId: number | null;
  cadence: StandingCadence;
  weekday: number; // 1 = Mon .. 7 = Sun
  startDate: string; // YYYY-MM-DD
  isActive: boolean;
  notes: string | null;
  items: StandingOrderItemLine[];
  createdAt: string;
  updatedAt: string;
}

export interface StandingOrderException {
  id: number;
  standingOrderId: number;
  occurrenceDate: string;
  action: 'skipped' | 'modified' | 'deleted';
  overrideOrderId: number | null;
}

export interface DailyItemProjection {
  trackedItemId: number;
  date: string;
  expectedStartingBalance?: number;
  startingBalance: number;
  expectedProduced?: number;
  estProduced: number;
  actualOnHand: number | null;
  actualEndOfDay?: number | null;
  slottedQty: number;
  selfConsumption?: number;
  endingBalance: number;
  expectedNextDayStarting?: number;
  nextDayStarting: number;
  effectiveBuffer: number;
  extraBuffer: number;
  hasBufferOverride: boolean;
  isCascadeAnchor: boolean;
  isManualProducedOverride: boolean;
  rawSellableOpen: number;
  availablePhysical: number;
  reservedForFuture: number;
  constrainedByDate: string | null;
  sellableOpen: number;
  tier: AvailabilityTier;
  notes: string | null;
}

export interface CalendarDayProjection {
  date: string;
  isoWeekday: number; // 1..7
  isToday: boolean;
  isPast: boolean;
  byItem: Record<number, DailyItemProjection>;
}

export interface SyncLog {
  id: number;
  startedAt: string;
  finishedAt: string | null;
  status: 'running' | 'success' | 'error';
  fetchedCount: number;
  importedCount: number;
  updatedCount: number;
  flaggedMissingCount: number;
  errorMessage: string | null;
}

export interface OdooConnectionStatus {
  configured: boolean;
  source: 'ha_options' | 'env' | 'none';
  urlHost: string | null;
  database: string | null;
}

export interface GithubPublishStatus {
  tokenConfigured: boolean;
  tokenSource: 'ha_options' | 'env' | 'none';
  repo: string;
  branch: string;
  filePath: string;
  publicUrl: string | null;
  mode: GithubPublishMode;
  interval: GithubPublishInterval;
  idleMinutes?: number;
  lastPublishedAt: string | null;
  lastPublishStatus: 'never' | 'success' | 'error';
  lastPublishError: string | null;
  lastPublishedHash: string | null;
  lastEditedAt?: string | null;
  hasUnpublishedEdits?: boolean;
}

export interface CheckpointSummary {
  id: number;
  label: string;
  isManual: boolean;
  createdAt: string;
}

export interface BackupInfo {
  filename: string;
  trigger: BackupTrigger;
  sizeBytes: number;
  createdAt: string;
}

export interface SandboxStatus {
  active: boolean;
  startedAt: string | null;
  snapshotFilename: string | null;
}

export interface BackupPreviewStatus {
  active: boolean;
  filename: string | null;
  startedAt: string | null;
  backupCreatedAt: string | null;
}

export interface CustomerSuggestion {
  key: string;
  name: string;
  email: string | null;
  phone: string | null;
  odooPartnerId: number | null;
  source: 'odoo' | 'local';
}

export interface WorkspacePayload {
  today: string;
  startDate: string;
  endDate: string;
  weeks: number;
  settings: AppSettings;
  odooStatus: OdooConnectionStatus;
  odooCustomersCount?: number;
  githubPublishStatus?: GithubPublishStatus;
  lastSync: SyncLog | null;
  items: TrackedItem[];
  channels: PickupChannel[];
  days: CalendarDayProjection[];
  orders: OrderRecord[];
  overdueOrders: OrderRecord[];
  reconciliationOrders: OrderRecord[];
  ignoredOrders: OrderRecord[];
  standingOrders: StandingOrder[];
  checkpoints: CheckpointSummary[];
  sandboxStatus?: SandboxStatus;
  backupPreviewStatus?: BackupPreviewStatus;
}

export interface PublicAvailabilityDay {
  date: string;
  displayDate: string;
  weekdayLabel: string;
  channelNames: string[];
  items: Array<{
    trackedItemId: number;
    itemName: string;
    unitLabel: string;
    status: 'Available' | 'Limited' | 'Waitlist Full';
    approxAvailable: number;
    approxLabel: string;
  }>;
}

export interface PublicAvailabilityCalendarDay extends PublicAvailabilityDay {
  isoWeekday: number;
  isPast: boolean;
  isToday: boolean;
  isOrderingClosed?: boolean;
}

export interface PublicAvailabilityJsonPayload {
  version: 1;
  generatedAtIso: string;
  generatedAtDisplay: string;
  timezone: string;
  weeks: number;
  paused: boolean;
  pausedMessage: string;
  headerTitle: string;
  headerText: string;
  footerText: string;
  showSameDay: boolean;
  cutoffRules: SnippetCutoffRule[];
  autoAdvanceToday: boolean;
  singleItemName: string | null;
  calendarDays: PublicAvailabilityCalendarDay[];
}

export interface PublicAvailabilityResult {
  generatedAtDisplay: string;
  timezone: string;
  weeks: number;
  paused?: boolean;
  pausedMessage?: string;
  showSameDay?: boolean;
  cutoffRules?: SnippetCutoffRule[];
  headerTitle?: string;
  headerText?: string;
  footerText?: string;
  autoAdvanceToday?: boolean;
  days: PublicAvailabilityDay[];
  calendarDays: PublicAvailabilityCalendarDay[];
  html: string;
  liveEmbedHtml?: string | null;
  githubPublishStatus?: GithubPublishStatus;
}
