# Farm Waitlist

> **Disclosure:** This entire software application, test suite, CI/CD configuration, and documentation were written by AI. Review the code and verify backups before relying on it for critical farm operations.

**Farm Waitlist** is a local-first web application packaged as a Home Assistant Repository Add-on (`aarch64` / Home Assistant Yellow & `amd64`) for managing seasonal farm pre-orders, waitlists, standing recurring orders, daily supply forecasting, and Odoo 19.3 quotation synchronization with persistent SQLite storage.

---

## Install as a Home Assistant Add-on

1. In Home Assistant, navigate to **Settings -> Add-ons -> Add-on Store**.
2. Open the top-right **⋮** menu, select **Repositories**, and paste your public GitHub repository URL (replace `OWNER` in `repository.yaml` and `farm-waitlist/config.yaml` with your GitHub username/org before publishing).
3. Find **Farm Waitlist** in the store and click **Install**.
4. Open the **Configuration** tab *(optional—leave blank to run without Odoo sync)*:
   - Enter your **Odoo Base URL** (`odoo_url`), **Odoo Database** (`odoo_db`), and **Odoo API Key** (`odoo_api_key`, masked as a password field).
5. Enable **Show in sidebar** and click **Start**.
6. Click **Open Web UI** (accessible locally via Home Assistant Ingress—no external ports or login screen needed).

> On first launch, Farm Waitlist starts as a **clean blank slate** with zero sample products or dummy customers. Open **Settings** to configure your Tracked Items, Pickup Channels, Timezone (defaults to `America/New_York`), and Odoo Sync rules.

---

## Local Development

```bash
cp .env.example .env
# Optional: set ODOO_BASE_URL, ODOO_DB, and ODOO_API_KEY in .env (git-ignored)
npm install
npm run dev
```

The development server runs at `http://localhost:3000` using a local SQLite database at `./data/waitlist.db` automatically—no other environment variables are required.

### Running Tests

```bash
npm run lint           # TypeScript type-check
npm run test:backend   # Backend unit, SQLite migration, supply math & Odoo /json/2/ tests
npm run test:frontend  # Frontend DOM & interaction tests (data-testid verified)
npm run build          # Production bundle (Vite base: './')
npm run test:e2e       # Playwright headless E2E under simulated HA Ingress subpath
```

---

## Documentation

- [`ARCHITECTURE.md`](./ARCHITECTURE.md) — Complete living technical reference (schema, migrations, Odoo 19.3 `/json/2/` contracts, supply math, Ingress routing, backups, and UI test selectors).
- [`CHANGELOG.md`](./CHANGELOG.md) — Automated Conventional Commits release history.
