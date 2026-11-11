import { Hono } from 'hono';
import type { Deps } from '../contracts.ts';

// STUB: replaced by the ui agent.
export function createUiRoutes(_deps: Deps): Hono {
  return new Hono();
}
