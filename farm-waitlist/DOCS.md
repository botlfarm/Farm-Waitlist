# Farm Waitlist — Home Assistant Add-on

Local-first seasonal pre-order, waitlist, standing recurring order, and daily supply forecasting tool for farms.

## Configuration

Configure the add-on from the Home Assistant **Configuration** tab (all fields are optional if you run without Odoo sync):

- `odoo_url`: Base URL of your Odoo 19.3 instance (e.g., `https://yourfarm.odoo.com`).
- `odoo_db`: Odoo database name sent via `X-Odoo-Database`.
- `odoo_api_key` (masked): Odoo 19.3 API key sent via `Authorization: bearer <key>` to `/json/2/` endpoints.

All data persists automatically inside `/data/waitlist.db` with backups stored in `/data/backups/`. Timezone defaults to `America/New_York` and can be changed in-app under **Settings**.
