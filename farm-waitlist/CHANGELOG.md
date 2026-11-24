# Changelog

All notable changes to Farm Waitlist are documented in this file.

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
- Automated release changelog workflow now promotes staged notes from `UNRELEASED.md` into both `CHANGELOG.md` and `farm-waitlist/CHANGELOG.md` when `farm-waitlist/config.yaml` is bumped.

### Fixed

- Fixed pre-approval rich copy pasting white text on a dark/black background into email clients.

## [1.0.0] - 2026-11-23

### Features

- Initial release of Farm Waitlist Home Assistant add-on with calendar supply forecasting, waitlist scheduling, standing recurring orders, Odoo 19.3 read-only sync, pre-approval templates, public availability snippet, and SQLite backups.
