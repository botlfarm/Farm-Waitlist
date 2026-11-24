# Unreleased Changes

<!--
Add bullet points under the sections below as features, changes, and fixes are made.
When `farm-waitlist/config.yaml` is bumped to a new version and pushed to `main`,
GitHub Actions automatically moves these notes into `CHANGELOG.md` and
`farm-waitlist/CHANGELOG.md`, syncs `package.json`, and resets this file for the next release.
-->

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
- Automated release workflow now automatically increments the add-on patch version in `farm-waitlist/config.yaml` (if not manually bumped) and promotes staged notes from `UNRELEASED.md` into `CHANGELOG.md`, `farm-waitlist/CHANGELOG.md`, and the GitHub Release.

### Fixed

- Fixed pre-approval rich copy pasting white text on a dark/black background into email clients.
