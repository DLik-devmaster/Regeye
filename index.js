import cron from 'node-cron';
import { initDb } from './db.js';
import { runScan } from './scanner/index.js';
import { state as scanState } from './scanState.js';
import app from './app.js';

const PORT = process.env.PORT || 3001;

async function start() {
  await initDb();

  // Weekly scan: every Monday at 08:00
  cron.schedule('0 8 * * 1', () => {
    console.log('[cron] weekly scan triggered');
    if (!scanState.running) {
      scanState.running = true;
      runScan(['mdcg', 'fda', 'iso', 'iec', 'custom', 'news']).finally(() => {
        scanState.running = false;
      });
    }
  });

  app.listen(PORT, () => {
    console.log(`[server] listening on http://localhost:${PORT}`);
    if (process.env.NODE_ENV === 'production') {
      const selfUrl = process.env.RENDER_EXTERNAL_URL || `http://localhost:${PORT}`;
      setInterval(() => {
        fetch(`${selfUrl}/api/health`).catch(() => {});
      }, 14 * 60 * 1000);
      console.log('[keep-alive] pinging', selfUrl, 'every 14 min');
    }
  });
}

start().catch(err => {
  console.error('[server] startup failed:', err);
  process.exit(1);
});
