# Changelog

All notable changes to **Farm Waitlist** are documented in this file. This project follows [Conventional Commits](https://www.conventionalcommits.org/) and updates this changelog automatically via GitHub Actions on release.

## [1.0.0] - 2026-11-23

### Features
- Initial release of **Farm Waitlist** Home Assistant Repository Add-on (`farm-waitlist`, `aarch64` & `amd64`) with Ingress sidebar support and persistent SQLite storage (`/data/waitlist.db`).
- Clean blank-slate first-run onboarding with configurable Tracked Items (Continuous Daily Production & Discrete Batch Drops, decimal units, safety buffers, public snippet flags) and Pickup Channels with allowed weekday enforcement.
- Monday–Sunday running calendar (6+ weeks) with Focused Single-Item and All-Items views, drag-and-drop slotting, lock toggles, Auto-Slot ASAP packing, Undo Last Action, and Checkpoint snapshots.
- Odoo 19.3 External `/json/2/` REST API synchronization with `America/New_York` UTC normalization, Sync Cutoff Date, Ignored Date Ranges, `mail.message` chatter filtered strictly to `comment` and `email` types, live re-sync preservation, and 1-click manual reconciliation for deleted quotations.
- Standing recurring orders (`weekly`, `biweekly`, `monthly`) with per-week edit/skip/delete exceptions.
- Copy-paste Pre-Approval message modal (with non-HTTPS iframe clipboard fallback) and anonymized 3-week Public Website HTML Availability Snippet generator.
- Startup SQLite migration runner with automatic `pre-migrate` backups, daily scheduled snapshots, download/restore, and validated `.db` upload restoration.
- Full-stack automated test suite (Vitest backend & frontend DOM tests + Playwright Ingress subpath E2E tests) gated in GitHub Actions before multi-arch `ghcr.io` Docker builds.
