import { Hono } from 'hono';
import type { Deps } from '../contracts.ts';

// STUB: replaced by the mcp agent.
export function createMcpRoutes(_deps: Deps): Hono {
  return new Hono();
}
