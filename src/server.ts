import { serve } from '@hono/node-server';
import { createApp } from './app.ts';
import { loadConfig } from './config.ts';
import { createCore } from './core/index.ts';
import { schedulePurge } from './core/purge.ts';

const config = loadConfig();
const core = createCore(config);
const app = createApp({ config, ...core });
const stopPurge = schedulePurge(() => core.purge());

const server = serve({ fetch: app.fetch, port: config.port, hostname: '0.0.0.0' }, (info) => {
  console.log(`agent-artifacts listening on :${info.port}`);
});

for (const signal of ['SIGTERM', 'SIGINT'] as const) {
  process.on(signal, () => {
    stopPurge();
    server.close();
    core.close();
    process.exit(0);
  });
}
