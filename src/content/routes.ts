import { Hono } from 'hono';
import type { Deps } from '../contracts.ts';

// STUB: replaced by the content agent.
export function createContentRoutes(_deps: Deps): Hono {
  return new Hono();
}
