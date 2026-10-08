import { readFileSync } from 'node:fs';
import { buildApp } from './app.ts';
import { loadConfig } from './config.ts';
import { startReleaseSync } from './services/releases.ts';

const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as { version: string };
const cfg = loadConfig();
const { app, ctx } = await buildApp(cfg, pkg.version);

ctx.provisioning.housekeeping();
const housekeeping = setInterval(() => ctx.provisioning.housekeeping(), 6 * 3600_000);
housekeeping.unref();

const stopSync = cfg.releases.githubRepo
  ? startReleaseSync({
      dir: cfg.releases.dir,
      repo: cfg.releases.githubRepo,
      token: cfg.releases.githubToken,
      minutes: cfg.releases.syncMinutes,
      log: app.log,
    })
  : () => {};

ctx.notify.start();

const shutdown = async (signal: string) => {
  app.log.info({ signal }, 'shutting down');
  ctx.notify.stop();
  stopSync();
  clearInterval(housekeeping);
  await app.close();
  ctx.db.close();
  process.exit(0);
};
process.on('SIGTERM', () => void shutdown('SIGTERM'));
process.on('SIGINT', () => void shutdown('SIGINT'));

await app.listen({ port: cfg.port, host: cfg.host });
app.log.info({ version: pkg.version }, 'CDA Net CPE server ready');
