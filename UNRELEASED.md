# Unreleased Changes

<!--
Add bullet points under the sections below as features, changes, and fixes are made.
When `farm-waitlist/config.yaml` is bumped to a new version and pushed to `main`,
GitHub Actions automatically moves these notes into `CHANGELOG.md` and
`farm-waitlist/CHANGELOG.md`, syncs `package.json`, and resets this file for the next release.
-->

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


