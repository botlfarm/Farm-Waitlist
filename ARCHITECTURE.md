# Farm Waitlist — Living Technical Architecture Reference

> **STRICT PROJECT RULE:** Every commit that changes database schema, migrations, supply/standing math, Odoo 19.3 API contracts, Ingress routing, backup/restore mechanics, REST routes, or UI `data-testid` workflows **MUST update `ARCHITECTURE.md` in the same commit**. Future AI sessions and contributors should be able to read this single document to understand the entire system accurately.

---

## 1. Runtime & Home Assistant Add-on Architecture

- **Runtime**: Single-process Node.js 22 + Express (`server.ts` / `src/server/app.ts`) serving both the REST API (`/api/*`) and the statically compiled React 19 + Tailwind CSS v4 frontend (`dist/`).
- **Home Assistant Add-on Layout**:
  - `repository.yaml` — HA Add-on Repository descriptor.
  - `farm-waitlist/config.yaml` — Slug `farm-waitlist`, `ingress: true`, `ingress_port: 3000`, `panel_icon: mdi:sprout`, `arch: [aarch64, amd64]`, exposing optional Odoo fields (`odoo_url`, `odoo_db`, `odoo_api_key` masked as `password?`) and optional open-source GitHub live publish fields (`github_publish_token` masked as `password?`, `github_publish_repo`).
  - `farm-waitlist/build.yaml` — `node:22-bookworm-slim` for both `aarch64` (Home Assistant Yellow) and `amd64`.
  - `farm-waitlist/Dockerfile` — Multi-stage build installing `python3`, `make`, `g++`, and `tzdata` in the builder stage so native `better-sqlite3` compiles cleanly on `linux/arm64` (`aarch64`) and `linux/amd64`, bundling `server.ts` via `esbuild` into `dist/server.mjs`, and pruning devDependencies before copying into the slim runtime stage (`TZ=America/New_York`).
  - `farm-waitlist/run.sh` — Sets default `TZ=America/New_York`, ensures `/data/backups` exists, and executes `node /app/dist/server.mjs`.
  - **Release Version & Changelog Pipeline (`UNRELEASED.md` → `scripts/release-changelog.mjs`)**: Ongoing feature/fix bullet points are staged in `UNRELEASED.md` under `Added`, `Changed`, and `Fixed`. On every push to `main` (`.github/workflows/ci-release.yml`), after the full test suite passes, CI first resolves the target version read-only (`--auto-bump --resolve-version`, auto-incrementing the patch version if already tagged or in `CHANGELOG.md`, while respecting manual minor/major bumps), builds and pushes both `aarch64` and `amd64` Docker images, and **only after both builds succeed** promotes `UNRELEASED.md` into `CHANGELOG.md` and `farm-waitlist/CHANGELOG.md`, updates `farm-waitlist/config.yaml` and `package.json`, commits/pushes, and creates the GitHub Release tag.
- **Secrets Boundary & Minimal Configuration**:
  - User-supplied environment variables (`.env` / `.env.example`) are `ODOO_BASE_URL` (also accepting `ODOO_URL` as an alias), `ODOO_DB`, `ODOO_API_KEY`, plus optional `GITHUB_PUBLISH_TOKEN` and `GITHUB_PUBLISH_REPO`; in Home Assistant, they come from `/data/options.json` (`odoo_url`, `odoo_db`, `odoo_api_key`, `github_publish_token`, `github_publish_repo`). All runtime paths (`/data/waitlist.db` vs `./data/waitlist.db`), port (`3000`), and timezone (`America/New_York`, editable in-app under Settings) configure automatically. Zero repositories are ever hardcoded—every self-hosted install configures its own GitHub repository.
  - Secrets are never written to SQLite, never committed to Git, and never returned in any API payload (`getRedactedOdooStatus` and `getRedactedGithubPublishStatus` expose only non-secret metadata/status).
- **Home Assistant Ingress Compatibility**:
  - `vite.config.ts` sets `base: './'`.
  - Frontend uses client-side view state (never root-relative browser URLs) and prefixes every API call with `./api/...` (`src/lib/api.ts`) so requests resolve identically at `/` and `/api/hassio_ingress/<token>/`.
  - Clipboard helpers (`copyTextToClipboard` and `copyRichMessageToClipboard`) try `navigator.clipboard.writeText()` / `ClipboardItem` (`text/html` + `text/plain`) and fall back to a copy-event-intercepted `document.execCommand('copy')` + style-isolated offscreen DOM container for non-HTTPS LAN Ingress iframes, guaranteeing clean email-safe HTML without inherited dark-mode background or light text colors (and `RichMessagePreview` also strips dark-theme styles on manual copy).

---

## 2. Persistent SQLite Schema & Migration History

Database location: `/data/waitlist.db` (when `/data` exists in Home Assistant) or `./data/waitlist.db` (local dev), overridable via `DB_PATH`. Backups live in `/data/backups` (or `./data/backups`, overridable via `BACKUP_DIR`). WAL mode and `PRAGMA foreign_keys = ON` are always enforced.

### Startup Migration Runner (`src/server/db.ts`)
1. Creates `schema_migrations (version, name, applied_at)`.
2. Detects pending migrations from `MIGRATIONS`.
3. If pending migrations exist **and** the database already contains application tables, automatically writes a `pre-migrate-<YYYYMMDD-HHmmss-SSS>.db` snapshot via SQLite's online `db.backup()` API before applying any DDL.
4. Applies each pending migration inside a transaction.
5. Populates default `app_settings` keys **only**—never seeds sample items, pickup channels, standing orders, or dummy customers (clean blank slate on first run).

### Migration History
- **v1 (`initial_schema`)**:
  - `app_settings` (`key`, `value_json`, `updated_at`) — Non-secret configuration (`timezone`, `odooSyncInterval`, `odooSyncCutoffDate`, `odooIgnoredDateRanges`, `preApprovalTemplate`, `preApprovalTemplates` [multiple named HTML/plain templates with optional pickup channel & tracked item auto-match rules], `holdThresholdHours`, `backupScheduleEnabled`, `backupRetentionDays`, `publicSnippetWeeks` [1–8, edited on Availability Snippet page], `publicSnippetEnabled`, `publicSnippetPausedPreset`, `publicSnippetPausedMessage`, `publicSnippetShowSameDay`, `publicSnippetCutoffRules` [flexible `days_before` / `weekly_day` ordering cutoffs], `publicSnippetHeaderTitle`, `publicSnippetHeaderText`, `publicSnippetFooterText`, `publicSnippetAutoAdvanceToday`, `githubPublishMode` [`manual` | `auto`], `githubPublishInterval` [`15m` | `30m` | `1h` | `6h`], `githubPublishIdleMinutes` [quiet cooldown in minutes before auto-publishing after edits, default `15`], `githubPublishRepo`, `githubPublishBranch`, `githubPublishPath`, `githubPublishPublicUrl`, `githubLastPublishedAt`, `githubLastPublishedHash`, `githubLastPublishStatus`, `githubLastPublishError`, `availabilityLastEditedAt`).
  - `tracked_items` — Configurable products (`name`, `unit_label`, `is_active`, `supply_mode` [`continuous` | `discrete`], `default_daily_production`, `global_safety_buffer`, `include_in_public_snippet`, `keyword_rules_json`, `sort_order`).
  - `pickup_channels` — Channels/markets (`name`, `allowed_weekdays_json` [ISO `1`=Mon..`7`=Sun], `color_token`, `is_active`, `sort_order`).
  - `daily_supply_entries` — Sparse per-day overrides unique on `(tracked_item_id, date)`: `actual_on_hand`, `est_produced`, `is_cascade_anchor`, `buffer_override`, `notes`.
  - `standing_orders` — Recurring rules (`customer_name`, `customer_contact`, `pickup_channel_id`, `cadence` [`weekly` | `biweekly` | `monthly`], `weekday` `1..7`, `start_date`, `is_active`, `notes`, `items_json`).
  - `standing_order_exceptions` — Per-occurrence overrides unique on `(standing_order_id, occurrence_date)` (`action`: `skipped` | `modified` | `deleted`, `override_order_id`).
  - `orders` — Unified order record (`source`: `odoo` | `manual` | `standing`; `status`: `waitlist` | `slotted` | `pre_approved` | `confirmed` | `ignored`; `timing_type`: `asap` | `specific_date`; `requested_date`, `slotted_date`, `is_locked`, `customer_name`, `customer_name_overridden`, contact fields, `pickup_channel_id`, `free_text_pickup`, `notes`, `pre_approved_at`, standing linkage, Odoo linkage: `odoo_quotation_id` UNIQUE, `odoo_quotation_name`, `odoo_partner_id`, `odoo_created_at_local`, `odoo_raw_notes`, `odoo_raw_lines_json`, `odoo_updated_after_slot`, `odoo_missing_flagged`, `odoo_suggested_confirmed_json`).
  - `order_items` — Multi-item quantities (`order_id`, `tracked_item_id`, `quantity` REAL supporting decimals like `0.5`).
  - `order_chatter` — Synced Odoo `mail.message` entries unique on `(order_id, odoo_message_id)` (`author_name`, `message_type` [`comment` | `email`], `subtype_name`, `body_text`, `created_at_utc`, `created_at_local`).
  - `sync_logs` — Audit log of Odoo sync runs (`started_at`, `finished_at`, `status`, counts, `error_message`).
  - `action_checkpoints` — Lightweight JSON snapshots (`orders`, `order_items`, `order_chatter`, `merged_odoo_links`, `daily_supply_entries`, `standing_order_exceptions`) powering 1-click Undo Last Action and manual Checkpoint rollback.
- **v2 (`add_extra_buffer_and_channel_specific_dates`)**:
  - Adds `daily_supply_entries.extra_buffer REAL NOT NULL DEFAULT 0` (additive single-day walk-up / event holdback).
  - Adds `pickup_channels.specific_dates_json TEXT NOT NULL DEFAULT '[]'` (explicit event / monthly varying dates).
- **v3 (`add_merged_odoo_links`)**:
  - Adds `merged_odoo_links (odoo_quotation_id PRIMARY KEY, target_order_id REFERENCES orders(id) ON DELETE CASCADE, odoo_quotation_name, merged_at)` so merging duplicate quotations/sales orders suppresses absorbed Odoo IDs on all future syncs and displays merged references on the kept order.
- **v4 (`add_actual_end_of_day`)**:
  - Adds `daily_supply_entries.actual_end_of_day REAL` (nullable physical count recorded at the end of the day after afternoon harvest, setting `nextDayStarting` directly for `D + 1` and acting as an inventory anchor across week boundaries and Undo checkpoints).
- **v5 (`add_waitlist_sort_order`)**:
  - Adds `orders.waitlist_sort_order INTEGER` (nullable manual priority rank for unslotted waitlist orders; when `NULL`, orders default to oldest arrival date first via `odoo_created_at_local` or `created_at` in farm timezone).
- **v6 (`add_dismissed_duplicate_pairs`)**:
  - Adds `dismissed_duplicate_pairs (order_id_a, order_id_b, dismissed_at)` (canonical ordered pair with `ON DELETE CASCADE`, included in Undo checkpoints) so operators can permanently dismiss false-positive duplicate suggestions symmetrically from either order. Recurring standing orders (`source = 'standing'` / `standing_order_id IS NOT NULL`) are automatically excluded from duplicate detection and merge prompts.
- **v7 (`add_odoo_customers`)**:
  - Adds `odoo_customers (odoo_partner_id PRIMARY KEY, name, email, phone, updated_at)` with case-insensitive name index (`idx_odoo_customers_name`) to cache active Odoo `res.partner` contacts locally for fast customer name autocomplete and contact auto-fill across Quick Add, Standing Orders, and Order Detail forms.
- **v8 (`add_odoo_missing_dismissed`)**:
  - Adds `orders.odoo_missing_dismissed INTEGER NOT NULL DEFAULT 0` so clicking **Keep** on a removed Odoo quotation stays dismissed across future syncs.
- **v9 (`add_daily_self_consumption`)**:
  - Adds `daily_supply_entries.self_consumption REAL NOT NULL DEFAULT 0` to record daily personal/farm self-consumption directly in daily supply numbers without creating a movable order.
- **v10 (`add_daily_walk_up_consumption`)**:
  - Adds `daily_supply_entries.walk_up_consumption REAL NOT NULL DEFAULT 0` to record day-of walk-up / market sales not tracked elsewhere directly in daily supply numbers right below self-consumption.

---

## 3. Daily Supply Forecasting, Safety Buffers & Rollover Math (`src/shared/supplyEngine.ts`)

For every active `TrackedItem` across every calendar date in the horizon (Monday of current week through 6+ weeks out):

- **Afternoon Harvest → Next-Day Availability Rule**:
  - Whatever is harvested/produced in the afternoon of date `D` (`EstProduced`) is **not** available for date `D`'s orders. Instead, it rolls into date `D + 1`'s starting inventory (`NextDayStarting(D)`).
  - **Starting Balance**:
    - Tracks both `expectedStartingBalance` (carried over from `D - 1`) and `startingBalance`.
    - If `daily_supply_entries.actual_on_hand` is set on date `D` (morning physical count), `Starting(D) = actual_on_hand` (immediately recalculates all subsequent days forward).
    - If the latest physical anchor (`actual_on_hand` or `actual_end_of_day`) precedes `startDate`, the engine rolls forward day-by-day across the intervening dates (applying harvest, slotted orders, and any intervening `actual_end_of_day` counts) so week boundaries carry stock seamlessly.
    - Otherwise `Starting(D) = NextDayStarting(D - 1)`.
  - **Est. Produced (Afternoon Harvest)**:
    - Tracks both `expectedProduced` (active cascade/default rate) and `estProduced`.
    - **`continuous` mode**: Uses `est_produced` on date `D` if manually set; if `is_cascade_anchor = 1`, updates the active cascade rate for all subsequent dates until the next `is_cascade_anchor` or manual `est_produced` override; falls back to `default_daily_production`.
    - **`discrete` mode**: Uses explicit `est_produced` batch/harvest drop on date `D`, otherwise `0` (becomes available to sell starting on `D + 1`).
  - **Slotted Demand**: Sum of `order_items.quantity` across all orders slotted on date `D` with `status in ('slotted', 'pre_approved', 'confirmed')`.
  - **Balances, Available-to-Promise (ATP) & Status Tiers**:
    - **Forward Pass** (physical inventory flow):
      - `EndingBalance = StartingBalance - SlottedQty - SelfConsumption - WalkUpConsumption` *(same-day customer orders, personal/farm self-consumption, and walk-up/market sales draw solely from morning stock on hand)*
      - `BaseBuffer = buffer_override ?? global_safety_buffer`
      - `EffectiveBuffer = BaseBuffer + extra_buffer` *(`extra_buffer` adds single-day walk-up / event holdback on top of the base buffer; SQLite Migration v2)*
      - `RawSellableOpen = EndingBalance - EffectiveBuffer` *(same-day surplus before accounting for future orders)*
      - `ExpectedNextDayStarting = EndingBalance + EstProduced` *(expected end-of-day count after harvest)*
      - `NextDayStarting = actual_end_of_day ?? ExpectedNextDayStarting` *(if an end-of-day physical count after harvest is entered via `actual_end_of_day`, tomorrow's morning stock starts from that exact physical count)*
    - **Pickup Channel Schedules (`isChannelActiveOnDate`)**:
      - Supports recurring weekly weekdays (`allowed_weekdays_json`), explicit one-off / monthly varying event dates (`specific_dates_json`, Migration v2), or flexible any-date 1-off channels (both arrays empty). Specific event dates can be managed in Settings or toggled in 1 click from `DayDetailDrawer`.
    - **Backward ATP Reservation Pass** (walks backward from horizon end, resetting before evaluating Day `D` if Day `D` has `actual_end_of_day`, and resetting before Day `D - 1` if Day `D` has `actual_on_hand`):
      - `SellableOpen(D) = min_{k >= D until next physical count boundary} RawSellableOpen(k)` *(true quantity you can safely sell on day `D` without causing a buffer dip or shortfall for future slotted/pre-approved/confirmed orders)*
      - `AvailablePhysical(D) = min_{k >= D until next physical count boundary} EndingBalance(k)`
      - `ReservedForFuture(D) = min(max(0, EndingBalance(D)), max(0, RawSellableOpen(D) - SellableOpen(D)))` *(capped at remaining physical stock on hand so days with 0 left never report holding positive stock)*
      - `ConstrainedByDate(D)` records the future date `k > D` whose committed orders tighten day `D`'s sellable amount (displayed on calendar cells as `Held X → <date>` or `Short X → <date>` and in `DayDetailDrawer` as `Reserved for Future`).
    - **Status Tiers**:
      - **Green (`Open` / `Full` when `SellableOpen === 0`)**: `SellableOpen >= 0` and `AvailablePhysical >= 0`
      - **Amber (`In Buffer`)**: `AvailablePhysical >= 0` and `SellableOpen < 0`
      - **Red (`Deficit`)**: `AvailablePhysical < 0`
- **Past-Date Rollover, Hold Cutoff & Needs Attention Banner**:
  - Past-date `confirmed` orders are assumed fulfilled when reconciling `Actual On-Hand Today`.
  - Any order with `slotted_date < today` still in `slotted` or `pre_approved` status surfaces in `overdueOrders`, and any `pre_approved` order on today/future whose `pre_approved_at` has reached `settings.holdThresholdHours` surfaces in `expiredHoldOrders`. Both appear in the top **Needs Attention** banner (and in `OrderDetailDrawer`'s hold card) with 1-click **Mark Confirmed**, **Bump → <Next Valid Pickup Day>** (`POST /api/orders/:id/bump`, respecting the order's active pickup channel schedule and resetting `pre_approved_at`), and **Return to Waitlist** actions (all undoable).
- **Auto-Slot ASAP (`findEarliestValidSlotDate`)**:
  - Runs after standing orders are materialized, sorting ASAP waitlist orders via `compareWaitlistOrders` (manual drag-and-drop `waitlist_sort_order` first, then oldest arrival date first).
  - Packs `waitlist` + `asap` orders into the earliest date `>= today` that satisfies the order's `PickupChannel.allowedWeekdays` AND satisfies `SellableOpen(D) - orderQty >= 0` (which algebraically guarantees no downstream buffer dip or deficit through the next physical count reset).
- **Per-Order Candidate Slot Evaluation (`evaluateCandidateSlotDates`)**:
  - Evaluates every upcoming date `>= today` for a specific order (handling both unslotted waitlist items and already-slotted orders being rescheduled by restoring the order's current slot onto `RawSellableOpen` before simulating candidate dates).
  - Computes ATP `currentOpen → afterOpen` / `afterEnding`, flags downstream constraint dates (`dips <date>`), classifies each date as `fits` (`green`), `buffer` (`amber`), or `deficit` (`red`), and identifies `isFirstAvailable` for 1-tap scheduling inside `OrderDetailDrawer` and earliest-open hints on Waitlist Queue cards.
- **Live Drag-Hover Calendar Forecast Preview (`previewOrderMoveProjections`)**:
  - Simulates slotting an unslotted waitlist order or moving a slotted order chip onto the currently hovered calendar date, recomputing forward running balances and backward ATP reservations across all affected days in real time before dropping.

---

## 4. Standing Recurring Orders Engine (`src/server/standingEngine.ts`)

- Supports `weekly`, `biweekly` (every 2 weeks anchored to first matching weekday `>= start_date`), and `monthly` (same weekday-of-month ordinal as anchor, e.g., 2nd Saturday).
- `materializeStandingOrders(db, today, horizonEnd)` runs automatically on workspace loads, standing-order changes, and auto-slotting.
- Materialized occurrences are inserted as locked orders (`source = 'standing'`, `status = 'slotted'`, `is_locked = 1`).
- Editing, moving, skipping, or deleting an individual occurrence writes to `standing_order_exceptions` (`modified` / `skipped` / `deleted`), ensuring future materializations never overwrite single-week changes or mutate the parent recurring rule.
- Pausing or deleting a standing rule cleans up untouched future `slotted` instances (`occurrence_date >= today`).

---

## 5. Odoo 19.3 External `/json/2/` API Integration (`src/server/odooService.ts`)

### Transport & Authentication (Strictly Read-Only)
- Endpoint: `POST <odoo_url>/json/2/<model>/search_read` — **100% read-only** (`search_read` is the only method ever invoked; Farm Waitlist never writes, creates, updates, or deletes anything in Odoo).
- URL Normalization & Redirect Safety (`normalizeOdooBaseUrl` & `callOdooJson2`):
  - Automatically strips accidentally pasted Odoo UI/API path suffixes (`/odoo`, `/odoo/...`, `/web`, `/web/...`, `/json/2`, `/jsonrpc`, `/xmlrpc`) while preserving legitimate reverse-proxy base paths.
  - Sends requests with `redirect: 'manual'` and explicitly follows up to 3 HTTP `301`/`302`/`303`/`307`/`308` redirects while **preserving `POST`, headers, and JSON body** (preventing Fetch's default `301`/`302` `POST -> GET` downgrade that triggers Odoo's `404: Did you mean POST /json/2/<model>/<method>?`).
  - Refuses `https:` -> `http:` downgrades, refuses forwarding bearer credentials to unrelated hosts (allowing only exact host or `www.` apex toggle), and rejects redirects off `/json/2/<model>/<method>` with clear diagnostics.
- Headers:
  - `Authorization: bearer <odoo_api_key>`
  - `X-Odoo-Database: <odoo_db>` (when provided)
  - `Content-Type: application/json; charset=utf-8`
  - `User-Agent: FarmWaitlist-HA-Addon/1.0`

### Timezone Normalization (`src/shared/timezone.ts`)
- Odoo returns UTC timestamps without a `Z` offset (e.g., `"2026-11-23 02:30:00"`).
- `parseOdooUtcToDate()` parses all Odoo strings strictly as UTC and converts them to `settings.timezone` (default **`America/New_York`**) via `Intl.DateTimeFormat` for:
  - Evaluating `odooIgnoredDateRanges`
  - Storing `odoo_created_at_local` and `order_chatter.created_at_local`
- `localDateStartToOdooUtc(cutoffDate, timezone)` converts `YYYY-MM-DD 00:00:00` in `America/New_York` (accurately handling EST `-05:00` and EDT `-04:00`) to an Odoo UTC timestamp string for `['|', ['create_date', '>=', cutoffUtc], ['date_order', '>=', cutoffUtc]]`.

### Sync Pipeline
1. Auto-discovers any custom/Studio `sale.order` field labeled **"Requested Pickup"** via read-only `ir.model.fields/search_read` (falling back safely if restricted or absent), then queries `sale.order` for **both open Quotations (`draft`, `sent`) and processed Sales Orders (`sale`, `done`)** matching the cutoff date (on `create_date` OR `date_order`), **plus** an explicit `['id', 'in', syncedLocalOdooIds]` query so already-imported non-ignored orders continue syncing even if the cutoff date moves forward. Requests `commitment_date` (Odoo Delivery Date) and discovered `"Requested Pickup"` field(s) with automatic fallback to base fields if absent.
2. Filters records against `merged_odoo_links` (so merged duplicate quotations/orders never re-import), `odooIgnoredDateRanges` (in local timezone; ranges with `ignoreExisting: true` also immediately purge already-imported local Odoo orders with an Undo checkpoint and suppress future updates/reconciliation alerts, while leaving manual and standing orders untouched), and local `status = 'ignored'` records.
3. Batch-fetches `sale.order.line`, `res.partner` (`fields: ['id', 'name', 'email', 'phone']` — excludes deprecated `mobile` removed in Odoo 19), and `mail.message` with strict domain:
   `[['model', '=', 'sale.order'], ['res_id', 'in', eligibleIds], ['message_type', 'in', ['comment', 'email']]]`
4. Sanitizes HTML from notes and chatter bodies into clean plain text (`stripHtmlToPlainText`)—never injects raw HTML into the DOM.
5. Extracts Tracked Item quantities via keyword rules across `sale.order.line` descriptions, `note`, and filtered chatter logs, plus pickup channel and customer **Requested Pickup Date** (`parseRequestedPickupDateValue`: prioritizes the discovered Odoo `"Requested Pickup"` field, then labeled `"Requested Pickup: ..."` text in notes/chatter supporting ISO, `MM/DD/YYYY`, and `Mon DD` formats, then `YYYY-MM-DD` / `commitment_date`).
6. **Quotation vs. Sales Order Placement**:
   - Open Quotations (`draft`, `sent`) always land in `status = 'waitlist'` (`slotted_date = NULL`).
   - Brand-new processed Sales Orders (`sale`, `done`) import directly as `status = 'confirmed'`: if an explicit pickup/delivery date (`requested_date` or `commitment_date`) is present, they auto-slot onto that calendar day immediately; otherwise they land pinned to the top of the Unslotted Queue labeled `Confirmed · Needs Date` so you can 1-tap assign a pickup day (which preserves `confirmed` status).
   - Existing local quotations confirmed in-place in Odoo (`state` transitions to `sale`/`done`) automatically promote to `status = 'confirmed'` while preserving any existing `slotted_date`.
7. **Live Re-Sync Preservation**: Refreshes partner info, raw notes/lines, and chatter messages while preserving local `slotted_date`, `is_locked`, and `customer_name` (when `customer_name_overridden = 1`). Sets `odoo_updated_after_slot = 1` if matched item quantities changed after slotting.
8. **Deleted / Cancelled Quotation Reconciliation**: For any active non-confirmed local Odoo order missing from Odoo's `draft`/`sent`/`sale`/`done` results, queries `sale.order` (`state in ['sale', 'done']`) for a suggested confirmed match hint and **always sets `odoo_missing_flagged = 1`** for explicit 1-click manual confirmation (`POST /api/orders/:id/reconcile` with `action: 'confirm' | 'keep'`). Never auto-confirms deleted drafts silently.
9. **Customer Directory Sync (`syncOdooCustomers`)**: Strictly read-only `res.partner/search_read` (`active = true`, `fields: ['id', 'name', 'email', 'phone']`, never requesting deprecated `mobile`) caches active Odoo contacts into `odoo_customers` during quotation syncs (non-fatal) and on demand via `POST /api/odoo/customers/sync`.

---

## 6. Backup, Restore, Sandbox Mode & Upload Safety (`src/server/db.ts`)

- **Online Snapshots**: Uses `better-sqlite3`'s native `await db.backup(destPath)` for `manual`, `scheduled`, `pre-migrate`, `pre-restore`, and `pre-sandbox` snapshots in `BACKUP_DIR`.
- **Sandbox Mode (Safe Testing Playground)**:
  - `enterSandbox()` automatically saves a live `pre-sandbox-<timestamp>.db` backup snapshot in `BACKUP_DIR`, duplicates the live database into a separate temporary sibling file (`<dbName>.sandbox.db`), and switches `DatabaseManager._db` to the duplicate while leaving the live database file untouched on disk.
  - While Sandbox Mode is active, `BackgroundScheduler` pauses all automated Odoo polling, scheduled backups, and GitHub Pages publishing, and API routes return HTTP `409` for live GitHub publishing (`POST /api/snippet/github/publish`) and live backup/restore mutations (`POST /api/backups*`).
  - `exitSandbox()` closes and deletes `<dbName>.sandbox.db` (plus `-wal`/`-shm` sidecars) and reconnects cleanly to the untouched live database. Server startup also cleans up any orphaned sandbox files so restarts always boot into the live database.
- **Read-Only Backup Preview Mode**:
  - `enterBackupPreview(filename)` validates the stored backup in `BACKUP_DIR`, copies it to a temporary sibling file (`<dbName>.preview.db`), applies any pending read-compatibility migrations to the temporary copy only (leaving both the original snapshot and the live database untouched), switches its journal mode to `DELETE`, and opens it with `{ readonly: true, fileMustExist: true }`.
  - While Backup Preview is active, a centralized Express middleware guard rejects every `POST`/`PUT`/`PATCH`/`DELETE` write endpoint with HTTP `409` (`{ readOnlyPreview: true }`) except `/api/backups/preview/enter`, `/api/backups/preview/exit`, `/api/backups/preview/restore`, and `/api/backups/:filename/restore`. `buildWorkspace()` skips `materializeStandingOrders`, `BackgroundScheduler` pauses all timers via `isNonLiveMode()`, and the frontend renders a persistent sky-blue top banner (`backup-preview-banner`) while disabling all mutation controls across every view and drawer.
  - Restoring from preview (`POST /api/backups/preview/restore` or `POST /api/backups/:filename/restore`) cleanly exits preview first so the automatic `pre-restore` safety snapshot captures the live database before replacing it. `exitBackupPreview()`, `close()`, and server startup delete any leftover `.preview.db` files so restarts always boot into the live database.
  - Sandbox Mode and Read-Only Backup Preview Mode are mutually exclusive (`409` if attempting one while the other is active).
- **Scheduled Retention**: `BackgroundScheduler` runs daily snapshots when enabled and prunes older `scheduled-*` files beyond `backupRetentionDays`.
- **Path Confinement**: `resolveSafeBackupPath()` restricts filenames to `/^[a-zA-Z0-9._-]+\.db$/` and verifies `resolved.startsWith(baseDir + path.sep)`.
- **Restore & `.db` Upload Validation**:
  1. Verifies file size `>= 100` bytes and exact 16-byte SQLite header `"SQLite format 3\0"`.
  2. Opens read-only and verifies `PRAGMA integrity_check === 'ok'`.
  3. Automatically writes `pre-restore-<timestamp>.db` of the active database before replacing it.
  4. Removes stale `-wal`/`-shm` sidecars, replaces the database atomically, reopens connection, and runs `init()` to apply any pending migrations.

---

## 7. REST API Endpoints (`src/server/app.ts`)

All endpoints are mounted under `/api` and called via relative `./api/...` paths from the frontend:

- `GET /api/health` — Health & active timezone.
- `GET /api/workspace?weeks=6` — Full hydrated calendar, projections, queues, overdue/reconciliation banners, standing orders, checkpoints, settings, redacted Odoo status, and redacted GitHub publish status.
- `POST /api/items`, `PUT /api/items/:id`, `DELETE /api/items/:id` — Tracked Items CRUD.
- `POST /api/channels`, `PUT /api/channels/:id`, `DELETE /api/channels/:id` — Pickup Channels CRUD.
- `PUT /api/supply/:itemId/:date` — Save `actualOnHand`, `estProduced`, `actualEndOfDay`, `cascadeForward`, `bufferOverride`, `extraBuffer`, `selfConsumption`, `walkUpConsumption`, `notes`.
- `GET /api/orders`, `POST /api/orders`, `PUT /api/orders/:id`, `DELETE /api/orders/:id` — Orders CRUD.
- `POST /api/orders/:id/slot` — Move/slot order onto date (validates lock & channel allowed weekdays unless `forceWeekday: true`).
- `POST /api/orders/:id/pre-approve` — Transition to `pre_approved`, stamp `pre_approved_at`, auto-select the best matching template (`selectBestPreApprovalTemplate`: channel+item > item > channel > default), and return `{ order, message, selectedTemplateId }`. Supports expanded template variables (`{{first_name}}`, `{{last_name}}`, `{{name}}`, `{{date_short}}`, `{{date_long}}`, `{{date_md}}`, `{{date_numeric}}`, `{{weekday}}`, `{{date}}`, `{{items_summary}}`, `{{channel}}`, `{{order_ref}}`, `{{hold_cutoff}}`, `{{hold_cutoff_by}}`, `{{hold_cutoff_date}}`, `{{order_cutoff}}`, `{{order_cutoff_date}}`, `{{order_cutoff_time}}` resolved from active Public Order Cutoff Rules for the order's pickup date), safe `http:`/`https:` HTML links (`<a href="...">Label</a>`, markdown links, bare URLs) rendered with pure React elements (`RichMessagePreview`, zero `dangerouslySetInnerHTML`), rich HTML clipboard copy, direct Email/Phone copy buttons, and a pre-filled `mailto:` link.
- `POST /api/orders/:id/bump` — Move an overdue or expired-hold order forward to the next valid pickup day (`computeNextBumpDate`, or optional explicit `date`), reset `pre_approved_at` for `pre_approved` orders, record standing exceptions if applicable, and capture an Undo checkpoint.
- `POST /api/orders/:id/release-hold` — Return aging hold to `waitlist`.
- `POST /api/orders/:id/ignore`, `POST /api/orders/:id/restore-ignored` — Dismiss/restore Odoo quotations.
- `POST /api/orders/:id/reconcile` — Manual 1-click `confirm` or `keep` for deleted Odoo quotations.
- `POST /api/orders/:id/merge` — Merge a duplicate or add-on order/quotation (`sourceOrderId`, `itemStrategy`: `'keep_target' | 'use_source' | 'combine'`, optional `keepDate`: `YYYY-MM-DD | null`) into a single order on one chosen date, deleting the absorbed order from its old date, promoting status, combining notes/chatter, linking absorbed Odoo IDs in `merged_odoo_links` so future syncs never re-import duplicates, and capturing an Undo checkpoint.
- `POST /api/orders/:id/dismiss-duplicate` — Permanently dismiss a suggested possible-duplicate pair (`{ otherOrderId: number }`) in `dismissed_duplicate_pairs` so neither order flags the other as a duplicate.
- `PUT /api/orders/waitlist-order` — Persist custom drag-and-drop waitlist priority (`{ orderIds: number[] }`) or reset back to arrival-date order (`{ reset: true }`).
- `POST /api/orders/auto-slot` — Greedy earliest-valid-date ASAP slotting respecting custom waitlist priority and arrival date (oldest first).
- `GET|POST|PUT|DELETE /api/standing-orders`, `POST /api/standing-orders/:id/skip` — Standing order CRUD & single-week skip.
- `GET|PUT /api/settings` — Non-secret app settings (returns redacted `odooStatus` & `githubPublishStatus`, reconfigures `BackgroundScheduler` including fixed-interval change-only GitHub auto-publishing).
- `POST /api/odoo/test`, `POST /api/odoo/sync` — Odoo 19.3 connection test & manual sync trigger.
- `GET /api/customers?q=&limit=50`, `POST /api/odoo/customers/sync` — Deduplicated customer autocomplete directory (combining cached Odoo `res.partner` contacts and local order/standing customer history) and on-demand read-only Odoo customer list pull.
- `GET /api/snippet?weeks=3` — Live anonymized public availability data (`days`, Mon–Sun aligned `calendarDays` with `isOrderingClosed` flags, `paused`/`pausedMessage`, `showSameDay`, `cutoffRules`, custom `headerTitle`/`headerText`/`footerText`, `liveEmbedHtml`, and `githubPublishStatus`) + self-contained responsive Mon–Sun calendar HTML string (`.fw-cal-grid`, zero customer names, dimmed past days visible on BOTH desktop and mobile, flexible ordering cutoffs showing `"Ordering Closed"`, safe `http:`/`https:` links, and optional progressive-enhancement `<script>` built with zero `innerHTML`).
- `POST /api/snippet/github/test` — Verifies the server-only fine-grained GitHub PAT against `https://api.github.com` for the user-configured `owner/repo` and `branch`, returning `{ ok, message, publicUrl }`.
- `POST /api/snippet/github/publish` — Builds the anonymized `availability.json` payload (never containing customer names/emails/phones/order IDs) and pushes via GitHub Contents API (`src/server/githubPublisher.ts` & `src/server/snippetService.ts`). If the target repository has no README on that branch (`GET /readme` returns `404`), automatically creates a simple default `README.md` explaining the public feed (leaving any user-created README untouched). Automatic scheduler ticks (`force: false, requireUserEdit: true`) enforce three guardrails: (1) require an explicit user availability edit (`availabilityLastEditedAt > githubLastPublishedAt`, skipping midnight rollovers and cutoff clock ticks), (2) wait for the configurable quiet cooldown (`githubPublishIdleMinutes`, scheduling a one-shot retry when deferred mid-edit), and (3) compare a SHA-256 hash of semantic availability (excluding timestamps and clock-derived `isPast`/`isToday`/`isOrderingClosed` flags) to skip no-op commits. Manual Publish Now (`force: true`) pushes immediately.
- `GET|POST /api/checkpoints`, `POST /api/checkpoints/undo`, `POST /api/checkpoints/:id/restore` — Undo & checkpoint snapshots.
- `GET|POST /api/backups`, `GET /api/backups/:filename/download`, `POST /api/backups/:filename/restore`, `POST /api/backups/upload` — SQLite snapshots & `.db` restore (live writes guarded with `409` while Sandbox Mode is active).
- `GET /api/backups/preview`, `POST /api/backups/preview/enter`, `POST /api/backups/preview/exit`, `POST /api/backups/preview/restore` — Read-Only Backup Preview status, read-only snapshot inspection, clean return to live DB, and 1-step restore of the currently previewed snapshot.
- `GET /api/sandbox`, `POST /api/sandbox/enter`, `POST /api/sandbox/exit` — Sandbox Mode status, automatic pre-sandbox backup + isolated DB duplication, and clean exit back to the live database.

---

## 8. Responsive Layout & Stable UI `data-testid` Contract

- **Responsive Breakpoints**:
  - `< md` (Mobile): Single-row sticky top bar (`mobile-nav-toggle` opens a non-overlapping slide-down `mobile-nav-drawer`); calendar renders stacked full-width day cards grouped under week headers (`grid-cols-1 md:grid-cols-7`); horizontal-scroll single-line tabs in the item focus strip and Settings.
  - `< lg` (Mobile/Tablet): Waitlist Queue defaults to closed and opens as a full-height slide-over drawer (`close-mobile-queue-btn`) so the calendar is never squished; Checkpoints opens as a viewport-safe modal sheet.
  - `md+` / `lg+` (Desktop): Full 3-zone top bar, continuous 7-column Mon–Sun calendar grid, and side-by-side sticky viewport-height collapsible `w-80` Waitlist sidebar with edge-triggered drag auto-scrolling for both the waitlist scroll container and calendar viewport.

Tests in `tests/frontend/` and `tests/e2e/` bind to these stable selectors—keep this table synchronized whenever modifying UI elements:

| Area | `data-testid` | Purpose |
| --- | --- | --- |
| Top Bar | `sandbox-mode-banner`, `exit-sandbox-btn`, `backup-preview-banner`, `preview-restore-backup-btn`, `preview-confirm-restore-btn`, `preview-cancel-restore-btn`, `exit-backup-preview-btn`, `brand-title`, `nav-calendar`, `nav-orders`, `nav-standing`, `nav-snippet`, `nav-settings`, `quick-add-order-btn`, `mobile-nav-toggle`, `mobile-nav-drawer`, `mobile-nav-calendar`, `mobile-nav-orders`, `mobile-nav-standing`, `mobile-nav-snippet`, `mobile-nav-settings` | Global Sandbox Mode & Read-Only Backup Preview top banners, desktop/mobile top navigation & manual order trigger |
| Blank Slate | `blank-slate-onboarding`, `blank-slate-open-settings-btn` | Fresh DB onboarding shortcut |
| Calendar Strip | `focus-item-<id>`, `focus-item-all`, `last-synced-label`, `sync-now-btn`, `publish-availability-btn`, `auto-slot-asap-btn`, `undo-action-btn`, `checkpoint-menu-btn`, `create-checkpoint-btn`, `toggle-queue-btn` | Item focus switcher, Odoo pull, website publish & scheduling actions |
| Banners | `overdue-banner`, `overdue-order-<id>`, `overdue-confirm-<id>`, `overdue-bump-<id>`, `overdue-release-<id>`, `reconciliation-banner`, `reconcile-replace-<id>`, `reconcile-match-select-<id>`, `reconcile-confirm-<id>`, `reconcile-keep-<id>`, `reconcile-remove-<id>` | Overdue & expired-hold Confirm/Bump/Release actions + cancelled/removed Odoo quotation replacement & reconciliation actions |
| Calendar Grid | `calendar-grid`, `calendar-day-<YYYY-MM-DD>`, `day-header-<YYYY-MM-DD>`, `day-event-channels-<YYYY-MM-DD>`, `day-tier-<YYYY-MM-DD>`, `day-metrics-<YYYY-MM-DD>`, `day-self-consumption-<YYYY-MM-DD>`, `day-walk-up-consumption-<YYYY-MM-DD>`, `day-preview-delta-<YYYY-MM-DD>`, `day-future-override-<YYYY-MM-DD>`, `day-extra-buf-<YYYY-MM-DD>`, `day-held-<YYYY-MM-DD>`, `day-future-short-<YYYY-MM-DD>`, `day-all-metrics-<YYYY-MM-DD>`, `drag-preview-chip`, `order-chip-<id>`, `extend-weeks-btn` | Mon–Sun cells (stacked on mobile, 7-col on desktop), On Hand / Self & Walk-Up consumption / Buffer / Can Sell ATP metrics, live drag-hover forecast preview & deltas, future override warning badge, extra walk-up buffer, event tags & slotted chips |
| Order List | `order-list-view`, `order-list-scope-<upcoming\|week\|unslotted\|all>`, `order-list-search-input`, `order-list-status-filter`, `order-list-channel-filter`, `order-list-totals`, `order-list-total-item-<id>`, `order-list-copy-btn`, `order-list-row-<id>`, `order-list-card-<id>`, `order-list-table-totals`, `order-list-empty` | Chronological order summary table/cards with per-item quantities, column totals, search/filters & plain-text copy |
| Waitlist Sidebar | `unslotted-queue-sidebar`, `unslotted-queue-scroll`, `close-mobile-queue-btn`, `reset-waitlist-order-btn`, `queue-order-<id>`, `queue-arrived-<id>`, `queue-requested-pickup-<id>`, `queue-move-up-<id>`, `queue-move-down-<id>`, `queue-earliest-<id>`, `toggle-ignored-orders-btn`, `restore-ignored-<id>`, `empty-waitlist-queue` | Arrival-date-sorted & live-bump drag-and-drop reorderable unslotted queue with edge-triggered drag auto-scrolling, prominent arrival date/age badges, amber **Requested Pickup Date** badges, touch up/down reorder buttons, earliest-open hints (slide-over on mobile, sticky sidebar on desktop) & ignored toggle |
| Day Drawer | `day-detail-drawer`, `day-morning-expected`, `day-actual-on-hand-input`, `day-self-consumption-input`, `day-walk-up-consumption-input`, `day-remaining-before-harvest`, `day-harvest-expected`, `day-est-produced-input`, `day-eod-expected`, `day-actual-end-of-day-input`, `day-tomorrow-starting`, `non-today-override-modal`, `cancel-non-today-override-btn`, `confirm-non-today-override-btn`, `day-next-override-warning`, `clear-next-day-override-btn`, `day-future-override-warning`, `day-clear-actual-btn`, `day-extra-buffer-input`, `day-buffer-override-input`, `day-toggle-channel-<id>`, `day-save-btn`, `day-cascade-forward-btn`, `close-day-drawer-btn` | Inline Expected + Actual/Adjustment daily inventory ledger (Morning Count, Self Consumption, Walk-Up / Market, Afternoon Harvest, End of Day after harvest), live tomorrow carry-over preview, non-blocking warning modal when overwriting Morning/EOD counts on non-today dates, future-override reconnect warnings, single-day extra walk-up buffer, event channel toggles & cascade editing |
| Order Drawer | `order-detail-drawer`, `order-header-requested-pickup`, `order-merged-refs`, `order-reconcile-box`, `drawer-reconcile-replace-btn`, `drawer-reconcile-compare-btn`, `drawer-reconcile-keep-btn`, `drawer-reconcile-remove-btn`, `drawer-reconcile-confirm-btn`, `possible-duplicate-banner`, `inspect-duplicate-btn`, `toggle-extra-duplicates-btn`, `duplicate-comparison-card`, `duplicate-compare-chatter`, `switch-to-duplicate-btn`, `dismiss-duplicate-btn`, `panel-dismiss-duplicate-btn`, `open-merge-duplicate-btn`, `order-merge-panel`, `merge-source-select`, `toggle-merge-source-details-btn`, `merge-source-details`, `merge-date-target`, `merge-date-source`, `merge-strategy-<keep_target\|use_source\|combine>`, `merge-result-summary`, `confirm-merge-orders-btn`, `footer-confirm-merge-btn`, `toggle-merge-panel-btn`, `order-items-section`, `order-scheduler-panel`, `order-requested-date-input`, `clear-requested-date-btn`, `slot-requested-date-btn`, `order-channel-select`, `schedule-first-available-btn`, `no-open-slot-notice`, `drawer-extend-weeks-btn`, `toggle-availability-picker-btn`, `show-all-availability-dates-btn`, `filter-open-dates-btn`, `toggle-off-channel-dates-btn`, `slot-availability-list`, `slot-candidate-<YYYY-MM-DD>`, `order-slotted-date-input`, `clear-slotted-date-btn`, `order-customer-name-input`, `order-status-<status>`, `order-lock-toggle-btn`, `order-pre-approve-btn`, `order-confirm-hold-btn`, `order-bump-hold-btn`, `order-release-hold-btn`, `order-ignore-btn`, `order-notes-input`, `order-odoo-raw-section`, `order-chatter-section`, `chatter-msg-<odooMsgId>`, `order-save-btn`, `close-order-drawer-btn` | Cleaned-up order drawer with Items at the top, click-to-expand inline date availability (no nested scroll), general Notes kept separate from Odoo Order Details, full Odoo Order Chain display, 1-click cancelled quotation replacement, editable **Requested Pickup Date**, ranked duplicate detection & single-date merge, customer autocomplete, 1-tap first-available scheduling, Confirm/Bump/Release hold actions, chatter inspection & status transitions |
| Modals | `quick-add-modal`, `quick-add-customer-input`, `customer-autocomplete-list`, `customer-option-<idx>`, `sync-odoo-customers-btn`, `quick-add-timing-asap`, `quick-add-timing-specific`, `quick-add-date-input`, `quick-add-clear-date-btn`, `quick-add-submit-btn`, `pre-approval-modal`, `pre-approval-contact-card`, `pre-approval-customer-email`, `pre-approval-copy-email-btn`, `pre-approval-customer-phone`, `pre-approval-copy-phone-btn`, `pre-approval-mailto-link`, `pre-approval-template-btn-<id>`, `pre-approval-preview`, `pre-approval-message-textarea`, `copy-pre-approval-btn`, `copy-pre-approval-plain-btn`, `weekday-warning-modal`, `confirm-force-weekday-btn` | Quick add with Odoo/local customer autocomplete & auto-fill, optional Requested Pickup Date on Waitlist orders, multi-template email-safe pre-approval HTML/plain copy, direct Email/Phone copy, pre-filled `mailto:` link & weekday mismatch guard |
| Standing Orders | `standing-orders-view`, `standing-customer-input`, `standing-cadence-select`, `standing-weekday-select`, `standing-submit-btn`, `standing-rule-<id>`, `standing-toggle-<id>` | Recurring rule CRUD |
| Public Snippet | `availability-snippet-view`, `snippet-rules-panel`, `snippet-mode-active`, `snippet-mode-paused`, `snippet-paused-controls`, `snippet-paused-preset-<id>`, `snippet-paused-message-input`, `snippet-weeks-input`, `snippet-show-same-day-checkbox`, `snippet-cutoff-rules-section`, `add-cutoff-preset-1day`, `add-cutoff-preset-2days`, `add-cutoff-preset-fri`, `cutoff-rule-<idx>`, `cutoff-rule-mode-<idx>`, `cutoff-rule-days-<idx>`, `cutoff-rule-weekday-<idx>`, `cutoff-rule-time-<idx>`, `cutoff-rule-remove-<idx>`, `snippet-customize-panel`, `snippet-header-title-input`, `snippet-header-text-input`, `snippet-footer-text-input`, `snippet-auto-advance-checkbox`, `snippet-save-settings-btn`, `snippet-reset-settings-btn`, `snippet-github-panel`, `github-mode-manual`, `github-mode-auto`, `github-repo-input`, `github-branch-input`, `github-path-input`, `github-interval-select`, `github-idle-select`, `github-public-url-input`, `github-derived-public-url`, `github-last-published`, `github-unpublished-edits-badge`, `github-test-btn`, `github-test-result`, `github-publish-now-btn`, `copy-live-embed-btn`, `snippet-live-preview`, `snippet-preview-paused`, `snippet-preview-title`, `snippet-preview-header-text`, `snippet-preview-footer-text`, `snippet-calendar-grid`, `snippet-past-day-<YYYY-MM-DD>`, `snippet-day-<YYYY-MM-DD>`, `snippet-day-closed-<YYYY-MM-DD>`, `snippet-timestamp`, `toggle-raw-html-btn`, `code-tab-static`, `code-tab-live`, `snippet-raw-html-textarea`, `snippet-live-embed-textarea`, `copy-html-snippet-btn` | Live Mon–Sun availability preview (with dimmed mobile past days), Active/Paused mode, Weeks Ahead horizon, Same-Day & flexible cutoff rules, customizable header/footer text, Open-Source GitHub Pages live push & embed code |
| Settings | `settings-view`, `settings-readonly-notice`, `settings-tab-items`, `settings-tab-channels`, `settings-tab-odoo`, `settings-tab-templates`, `settings-tab-backups`, `settings-item-name-input`, `settings-add-item-btn`, `settings-channel-name-input`, `channel-mode-<weekly\|specific\|any>`, `channel-specific-date-input`, `channel-add-date-btn`, `settings-add-channel-btn`, `set-cutoff-today-btn`, `ignored-range-start-input`, `ignored-range-end-input`, `ignored-range-label-input`, `ignored-range-complete-checkbox`, `add-ignored-range-btn`, `ignored-range-row-<id>`, `toggle-ignored-range-mode-<id>`, `remove-ignored-range-<id>`, `template-list`, `add-template-btn`, `template-item-<id>`, `settings-template-name-input`, `settings-template-format-html`, `settings-template-format-plain`, `settings-template-default-btn`, `settings-template-delete-btn`, `settings-template-channel-<id>`, `settings-template-item-<id>`, `template-link-label-input`, `template-link-url-input`, `template-insert-link-btn`, `template-var-<key>`, `settings-template-textarea`, `settings-template-preview`, `sandbox-mode-card`, `enter-sandbox-btn`, `settings-exit-sandbox-btn`, `create-backup-now-btn`, `backup-upload-input`, `backup-row-<filename>`, `backup-preview-<filename>`, `backup-previewing-badge-<filename>`, `backup-exit-preview-<filename>`, `backup-restore-<filename>`, `backup-confirm-restore-<filename>` | Configuration, Odoo sync & full-ignore off-season date ranges, multi-template manager with grouped variable chips, Sandbox Mode & SQLite backup preview/restore |
