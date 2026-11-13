import { serve } from '@hono/node-server';
import { createApp } from './app.ts';
import { type Config, ConfigError, loadConfig } from './config.ts';
import { createCore } from './core/index.ts';
import { schedulePurge } from './core/purge.ts';

let config: Config;
try {
  config = loadConfig();
} catch (error) {
  if (!(error instanceof ConfigError)) throw error;
  console.error(`agent-artifacts: ${error.message}`);
  console.error('See .env.example and the README for the settings.');
  process.exit(1);
}

if (config.devUser) {
  console.warn(
    `agent-artifacts: WARNING: DEV_USER is set, so everyone who can reach port ${config.port} is signed in as ${config.devUser}. Use it for local development only.`,
  );
}

if (config.authMode === 'password') {
  // The number only: no emails, no hashes.
  console.log(
    `agent-artifacts: built-in sign-in, ${config.authUsers.length} account(s) configured`,
  );
}

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
