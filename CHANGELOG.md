# Changelog

All notable changes to Farm Waitlist are documented in this file.

### Changed

- **Dimmer Past Calendar Days & Mobile Collapse**: past days on the main calendar are now clearly dimmed and labeled `· Past` (brightening smoothly on hover/focus so you can still review past orders or counts), and on mobile screens past days of the current week start collapsed into a 1-tap **Show / Hide** summary bar so mobile opens straight onto Today.
- **Side-by-Side Order Compare & Merge Review Modal**: matching a cancelled pre-order with a replacement order or merging duplicate orders now opens a spacious 2-column comparison modal showing both orders side by side (role, status, pickup date, pickup channel, items, notes, and Odoo chatter with differences highlighted), a pickup date & items picker that defaults to the actual/active order over a cancelled pre-order, and a live **What Will Change When You Approve** summary before any changes are applied.
- **Direct-in-Changelog Release Workflow**: removed `UNRELEASED.md` in favor of adding new changes directly at the top of `CHANGELOG.md` without a version heading; the CI release build stamps the new version number at the top after tests and Docker builds succeed and automatically skips any already-released duplicate bullets.

### Fixed

- **Live Drag-and-Drop Supply Preview Accuracy**: fixed the calendar's live drag-and-drop preview to subtract daily **Self Consumption** and **Walk-Up / Market** counts identically to the authoritative supply forecast, so dragging an order across days shows the exact post-drop numbers without shifting unrelated days.
- **Prevented Midnight Availability Snippet Timestamp Bumps**: routine non-availability edits (such as adding unslotted waitlist orders or updating order notes) no longer leave a pending-publish flag that waits until midnight to republish when yesterday rolls into the past, skipped no-op checks now clear any stale pending flag immediately, and background auto-publishes display the exact time availability was edited rather than when the background sync timer woke up.
- **Backup Restore Reliability & Clarity**: fixed empty-body JSON `POST` requests on restore endpoints (which reverse proxies and Home Assistant Ingress could reject), normalized created snapshots out of WAL mode and validated WAL backups in a temporary copy so no stray `-wal`/`-shm` sidecars are created in the backups folder, automatically reset focused item selection when a restored database uses different item IDs, labeled automatic `pre-restore` snapshots clearly as **Previous DB (before restore)**, and added a post-restore confirmation banner showing exact restored item/order counts with a 1-click **View Restored Calendar** button.

## [1.0.7] - 2026-11-25

### Added

- **Overdue & Hold Cutoff Action Prompts**: unconfirmed **Pre-Approved** orders whose pickup day has passed or whose **Hold Cutoff** timer has expired now surface in the top **Needs Attention** banner (and inside the Order Detail Drawer) with 1-click **Mark Confirmed**, **Bump → Next Pickup Day** (respecting the pickup channel's active days and resetting the hold timer), and **Return to Waitlist** buttons—all with Undo support.
- **Hold & Public Order Cutoff Template Variables**: added `{{hold_cutoff}}` (e.g., `48 hours`), `{{hold_cutoff_by}}`, and `{{hold_cutoff_date}}` (tied to your Hold Cutoff Threshold) plus `{{order_cutoff}}` (e.g., `Fri, Nov 27 at 4:00 PM`), `{{order_cutoff_date}}`, and `{{order_cutoff_time}}` (automatically calculated from your active Public Order Cutoff Rules in **Availability Snippet** for the order's pickup date) to **Settings → Templates & Holds** with live sample previews.

## [1.0.6] - 2026-11-25

### Added

- **Walk-Up / Market** consumption line right below **Self Consumption** in daily supply numbers (Day Detail Drawer & calendar cells): record day-of walk-up and market sales not tracked elsewhere so they deduct from daily stock, carry-over, and future ATP reservations cleanly without creating separate orders.

## [1.0.5] - 2026-11-25

### Added

- **Read-Only Backup Preview Mode** in Settings → **Backup & Restore**: click **Preview** on any stored SQLite snapshot to browse its calendar, orders, supply counts, standing orders, and settings in strict read-only mode before deciding whether to restore it—complete with a persistent top banner showing the previewed filename, all edits and background jobs safely blocked, 1-click **Exit Preview & Return to Live**, and a 2-step **Restore This Backup** button.
- **Expanded Pre-Approval Message Template Variables & Quick Contact Actions**: added `{{first_name}}` and `{{last_name}}` (split on whitespace), year-free and alternate date formats (`{{date_short}}` e.g. `Sat, Nov 28`, `{{date_long}}`, `{{date_md}}`, `{{date_numeric}}`, `{{weekday}}`), and `{{order_ref}}` with live sample previews in Settings; the Pre-Approval modal now also displays the customer's **Email** and **Phone** with 1-click **Copy** buttons and a pre-filled **Open in Email (`mailto:`)** link.
- **Self Consumption** line in daily supply numbers (Day Detail Drawer & calendar cells): record eggs/items set aside for personal or farm use so they deduct from daily availability, carry-over, and future ATP reservations just like an order without cluttering your order list or needing to be moved around.
- **Sandbox Mode** in Settings → **Backup & Restore**: automatically saves a `pre-sandbox` backup snapshot of your live database and opens a separate duplicate copy for safe experimentation, with a persistent amber top banner across the entire app, live website publishing and scheduled jobs paused while active, and 1-click exit back to your untouched live database.

## [1.0.4] - 2026-11-25

### Added

- **Ignore completely** option for **Ignored Off-Season Date Ranges** in Settings: choose whether a date range skips new imports only or also immediately clears already-imported Odoo orders in that range off your waitlist, calendar, and alerts (with 1-click Undo support), plus a 1-click toggle on existing ranges.
- Quick **Publish to Website** button right next to **Pull from Odoo** on the main calendar toolbar, complete with an amber pending-edits indicator whenever unpublished availability changes exist.
- 1-click **Replace with New Quotation** matching for cancelled/removed Odoo waitlist quotations: automatically matches newly arrived quotations in the waitlist for the same customer, preserves the scheduled calendar slot and combined notes/chatter, and displays the full **Order Chain** (e.g., `S00100 → S00105`) in the Order Detail Drawer.

### Changed

- Cleaned up the **Order Detail Drawer**: moved **Items** to the top of the card, replaced the nested scrolling availability box with a condensed click-to-expand inline date availability picker, and stopped copying Odoo Order Details into the general **Notes** box so internal farm notes stay clean and duplicate-free.
- Redesigned the **Cancelled / Removed in Odoo** reconciliation banner and drawer prompt to match newly arrived replacement quotations (plus **Keep** and **Remove** actions) instead of assuming external payment.
- Merging a cancelled or older waitlist quotation with a newer active Odoo quotation now promotes the live replacement quotation as the primary tracked Odoo ID so future syncs keep updating chatter, quantities, and final confirmation automatically.
- Clicking **Keep** on a removed Odoo quotation now stays dismissed across future Odoo syncs.
- Renamed **Sync Now** to **Pull from Odoo** (and **Publish Now** to **Publish to Website**) across the calendar toolbar and Public Availability Snippet view so pulling orders from Odoo and publishing public availability are unmistakably distinct.
- Moved GitHub Actions changelog/version updates and commit/push to run **after** all tests and both `aarch64`/`amd64` Docker builds succeed so failed builds never update `CHANGELOG.md` or bump versions prematurely.

## [1.0.3] - 2026-11-24

### Changed

- Hardened GitHub Pages **Automatic Sync** with two guardrails: auto-publishing now only triggers after real user edits to inventory, orders, or snippet settings (never on midnight date rollovers or cutoff clock ticks, preserving an honest *"Availability accurate as of..."* timestamp), and waits for a configurable **Quiet Delay** (default 15 min idle) so mid-session changes are never pushed prematurely.

## [1.0.2] - 2026-11-24

### Changed

- Automated release workflow now automatically increments the add-on patch version in `farm-waitlist/config.yaml` (if not manually bumped) and publishes release notes into `CHANGELOG.md`, `farm-waitlist/CHANGELOG.md`, and the GitHub Release.

## [1.0.1] - 2026-11-24

### Added

- Prominent **Requested Pickup Date** on Waitlist cards, Order List, Quick Add (including unslotted waitlist orders), and Order Detail Drawer with 1-tap slotting onto the requested date.
- Read-only Odoo `"Requested Pickup"` quotation field auto-discovery (plus `"Requested Pickup: ..."` text parsing in notes and chatter).
- Read-only Odoo customer directory sync (`res.partner`) powering customer name autocomplete with phone/email auto-fill across Quick Add, Order Details, and Standing Orders.
- Clickable potential duplicate comparison in the Order Detail Drawer and merge panel showing full order details, notes, raw Odoo lines, and Odoo chatter before merging or dismissing.
- Persistent **"Not a Duplicate"** dismissal for duplicate order warnings, plus automatic exclusion of recurring standing orders from duplicate suggestions.
- Live drag-and-drop waitlist reordering with live list bumping, edge-triggered auto-scrolling, and live calendar inventory forecast preview while hovering over dates before dropping.
- Inline Morning, Harvest, and End-of-Day inventory count adjustments in the Day Detail Drawer with a non-blocking warning when editing non-today counts.
- Public Availability Snippet enhancements: configurable Weeks Ahead, Paused mode with quick presets, flexible ordering cutoff rules (showing "Ordering Closed"), dimmed past days on mobile, and fixed-interval change-only GitHub Pages publishing (automatically adding a friendly default `README.md` if the target repo does not already have one).

### Changed

- Waitlist queue now highlights arrival dates prominently and sorts oldest arrivals first by default until manually reordered.
- Smoothed waitlist and calendar drag-and-drop interactions with FLIP card glide transitions, anti-jitter swap guards, animated calendar preview slot expansion, zero-flicker cell hover transitions, optimistic drop settling, and frame-rate-normalized edge auto-scrolling.
- Automated release changelog workflow updates both `CHANGELOG.md` and `farm-waitlist/CHANGELOG.md` on release.

### Fixed

- Fixed pre-approval rich copy pasting white text on a dark/black background into email clients.

## [1.0.0] - 2026-11-23

### Features

- Initial release of Farm Waitlist Home Assistant add-on with calendar supply forecasting, waitlist scheduling, standing recurring orders, Odoo 19.3 read-only sync, pre-approval templates, public availability snippet, and SQLite backups.
