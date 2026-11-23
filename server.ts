import 'dotenv/config';
import express from 'express';
import fs from 'fs';
import path from 'path';
import { createExpressApp } from './src/server/app';
import { loadRuntimeConfig } from './src/server/config';
import { DatabaseManager } from './src/server/db';
import { BackgroundScheduler } from './src/server/scheduler';

async function startServer() {
  const config = loadRuntimeConfig();
  const dbManager = new DatabaseManager(config.dbPath, config.backupDir);
  await dbManager.init(config.timezone);

  const scheduler = new BackgroundScheduler(dbManager, config);
  const app = createExpressApp({
    dbManager,
    config,
    onSettingsUpdated: (settings) => scheduler.configure(settings),
  });

  const isProd = process.env.NODE_ENV === 'production';
  const distDir = path.resolve(process.cwd(), 'dist');

  if (!isProd && !process.env.SERVE_STATIC_DIST) {
    const { createServer: createViteServer } = await import('vite');
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: 'spa',
    });
    app.use(vite.middlewares);
  } else {
    if (fs.existsSync(distDir)) {
      app.use(express.static(distDir));
      app.get('*', (_req, res) => {
        res.sendFile(path.join(distDir, 'index.html'));
      });
    }
  }

  scheduler.start();

  const server = app.listen(config.port, '0.0.0.0', () => {
    console.log(
      `[Farm Waitlist] Listening on http://0.0.0.0:${config.port} (DB: ${config.dbPath}, TZ: ${config.timezone})`
    );
  });

  const shutdown = () => {
    scheduler.stop();
    server.close(() => {
      dbManager.close();
      process.exit(0);
    });
  };

  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);
}

startServer().catch((err) => {
  console.error('[Farm Waitlist] Fatal startup error:', err);
  process.exit(1);
});
