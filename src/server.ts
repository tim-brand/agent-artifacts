import { serve } from '@hono/node-server';
import { createApp } from './app.ts';
import { loadConfig } from './config.ts';
import { createCore } from './core/index.ts';

const config = loadConfig();
const core = createCore(config);
const app = createApp({ config, ...core });

const server = serve({ fetch: app.fetch, port: config.port, hostname: '0.0.0.0' }, (info) => {
  console.log(`agent-artifacts listening on :${info.port}`);
});

for (const signal of ['SIGTERM', 'SIGINT'] as const) {
  process.on(signal, () => {
    server.close();
    core.close();
    process.exit(0);
  });
}
