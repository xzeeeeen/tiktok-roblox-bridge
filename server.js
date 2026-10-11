import { createApp } from './src/app.js';
import { config } from './src/config.js';

const app = createApp();
const addr = await app.start();

const line = '='.repeat(62);
console.log(`\n${line}\n  TikTok -> Roblox Bridge berjalan di http://localhost:${addr.port}\n${line}`);
console.log(`  Dashboard      : http://localhost:${addr.port}`);
console.log(`  ADMIN_API_KEY  : ${config.ADMIN_API_KEY}   (untuk login dashboard)`);
console.log(`  ROBLOX_API_KEY : ${config.ROBLOX_API_KEY}   (untuk skrip Roblox)`);
console.log('  Catatan: Roblox TIDAK bisa akses localhost. Pakai tunnel (cloudflared/ngrok) atau VPS.\n');

if (config.TIKTOK_USERNAME) {
  app.bridge.connect(config.TIKTOK_USERNAME).catch((e) => console.error('[tiktok]', e.message));
}

const shutdown = async (sig) => {
  console.log(`\n${sig} diterima, menutup server…`);
  setTimeout(() => process.exit(1), 5000).unref();
  await app.stop();
  process.exit(0);
};
process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
