import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { WebStandardStreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { Hono } from 'hono';
import { z } from 'zod';
import { AppError, type Deps, LIMITS } from '../contracts.ts';

const MB = 1024 * 1024;
/** Inline the entry file in get_artifact up to this size. */
const INLINE_BYTES = MB;
/** Room for a full publish as base64 (4/3) or escaped JSON text (up to ~2x). */
const MAX_BODY_BYTES = LIMITS.publishBytes * 2 + MB;

const INSTRUCTIONS = `agent-artifacts stores and shares artifacts you make: HTML pages, Markdown documents, code, PDFs and images.
Publish with publish_artifact and give the returned url to the user; they open it in the web app.
Every publish of an existing id makes a new version; old versions stay readable.
Use search_artifacts (by text) or list_artifacts (newest first) to find earlier work, and get_artifact to read it before you publish a new version of it.`;

const formatSchema = z.enum(['html', 'markdown', 'code', 'pdf', 'image']);

const PUBLISH_DESCRIPTION = `Publish an artifact, or a new version of one. Returns {id, version, title, url}; share the url with the user.

Content, choose one:
- One file: \`content\` + \`format\` (html, markdown, code, pdf or image). For pdf, \`content\` is base64. For code, set \`language\` (e.g. "ts", "python"). The file is stored as index.html, README.md, main.<ext> or document.pdf.
- An image (png, jpg, gif, webp or svg; a diagram, chart or screenshot): \`content\` is base64 (an SVG may also be its text), with \`format\` "image" and either \`entry\` as the file name (e.g. "chart.png") or \`language\` as the extension (e.g. "png"). The bytes must match the extension. An image artifact has one file; for a page with several images, publish html with files.
- Several files: \`files\` maps a relative path to its text, or to {"base64": "..."} for binary files (images, fonts, pdf); \`entry\` names the file to open (e.g. "index.html"), and \`format\` says what it is. Relative links between files in an HTML artifact work.

New artifact: omit \`id\`; \`title\` is required.
New version: pass the artifact's \`id\` with new content/files. Pass \`expectedVersion\` (the version you last saw) to fail with version_conflict instead of overwriting someone else's newer version.
Settings only: pass \`id\` with only \`title\` and/or \`description\` (no content or files) to change them without making a version.

Limits: ${LIMITS.publishBytes / MB} MB decoded per publish, ${LIMITS.fileBytes / MB} MB per file, ${LIMITS.files} files. Base64 is a third larger than the bytes and all of it goes inline in this call, so a big image (several MB) makes a very large request: prefer a compact PNG, JPEG or WebP, or an SVG.`;

const fileInputSchema = z.union([
  z.string(),
  z.object({ base64: z.string().describe('File bytes as base64') }),
]);

const publishSchema = {
  id: z
    .string()
    .optional()
    .describe('Existing artifact id, for a new version or a settings change'),
  title: z.string().optional().describe('Required for a new artifact'),
  description: z.string().optional().describe('Short summary shown in lists'),
  content: z
    .string()
    .optional()
    .describe('Single-file content; base64 when format is pdf or image (an SVG may be its text)'),
  format: formatSchema.optional(),
  files: z
    .record(z.string(), fileInputSchema)
    .optional()
    .describe('Relative path -> text, or {"base64": "..."} for binary'),
  entry: z
    .string()
    .optional()
    .describe(
      'With files: the path of the file to open. For an image: its file name, e.g. "chart.png"',
    ),
  language: z
    .string()
    .optional()
    .describe(
      'For code: the language, e.g. "ts", "python". For an image: its extension, e.g. "png"',
    ),
  expectedVersion: z
    .number()
    .int()
    .positive()
    .optional()
    .describe('Fail with version_conflict unless this is still the latest version'),
};

function ok(value: Record<string, unknown>): CallToolResult {
  return {
    content: [{ type: 'text', text: JSON.stringify(value, null, 2) }],
    structuredContent: value,
  };
}

function fail(error: string, message: string, details?: Record<string, unknown>): CallToolResult {
  return {
    content: [{ type: 'text', text: JSON.stringify({ error, message, details }, null, 2) }],
    isError: true,
  };
}

/** Wraps a tool handler: AppError becomes a tool error, anything else a generic one. */
function tool<A>(fn: (args: A) => Promise<Record<string, unknown>>) {
  return async (args: A): Promise<CallToolResult> => {
    try {
      return ok(await fn(args));
    } catch (error) {
      if (error instanceof AppError) return fail(error.code, error.message, error.details);
      console.error('mcp tool failed', error);
      return fail('internal_error', 'Something went wrong on the server. Try again later.');
    }
  };
}

function notFound(id: string, version?: number): AppError {
  const what = version === undefined ? `Artifact ${id}` : `Version ${version} of artifact ${id}`;
  return new AppError('not_found', `${what} not found`, { id, version });
}

function createServer(deps: Deps, publishedBy: string): McpServer {
  const { artifacts, config } = deps;
  const pageUrl = (id: string, version?: number) =>
    version === undefined
      ? `${config.appOrigin}/a/${id}`
      : `${config.appOrigin}/a/${id}/v/${version}`;

  const server = new McpServer(
    { name: 'agent-artifacts', version: '1.0.0' },
    { instructions: INSTRUCTIONS },
  );

  server.registerTool(
    'publish_artifact',
    { description: PUBLISH_DESCRIPTION, inputSchema: publishSchema },
    tool(async (input) => artifacts.publish(input, publishedBy)),
  );

  server.registerTool(
    'get_artifact',
    {
      description:
        'Get an artifact: its metadata, one version with its file list, and the entry file text inline (for text formats and SVG, up to 1 MB). Latest version when `version` is omitted. `url` is the page for this version in the web app.',
      inputSchema: {
        id: z.string(),
        version: z.number().int().positive().optional().describe('Defaults to the latest'),
      },
      annotations: { readOnlyHint: true },
    },
    tool(async ({ id, version }) => {
      const found = await artifacts.get(id, version);
      if (!found) throw notFound(id, version);
      const v = found.version;
      const entry = v.files.find((f) => f.path === v.entry);
      const result: Record<string, unknown> = {
        artifact: found.artifact,
        version: v,
        url: pageUrl(id, v.version),
      };
      if (v.format === 'pdf') {
        result.entryContentOmitted = 'The entry file is a PDF; open the url to view it.';
      } else if (v.format === 'image' && !entry?.contentType.startsWith('image/svg+xml')) {
        result.entryContentOmitted = 'The entry file is an image; open the url to view it.';
      } else if (!entry || entry.size > INLINE_BYTES) {
        result.entryContentOmitted = `The entry file is larger than 1 MB; open the url to view it.`;
      } else {
        const file = await artifacts.readFile(id, v.version, v.entry);
        if (file) result.entryContent = new TextDecoder().decode(file.bytes);
      }
      return result;
    }),
  );

  server.registerTool(
    'list_artifacts',
    {
      description:
        'List artifacts, most recently updated first. Pass `nextCursor` from a previous page as `cursor` to get the next page; it is null on the last page.',
      inputSchema: {
        format: formatSchema.optional(),
        limit: z.number().int().min(1).max(100).optional().describe('Default 20, max 100'),
        cursor: z.string().optional(),
      },
      annotations: { readOnlyHint: true },
    },
    tool(async (query) => {
      const page = await artifacts.list(query);
      return {
        items: page.items.map((a) => ({ ...a, url: pageUrl(a.id) })),
        nextCursor: page.nextCursor,
      };
    }),
  );

  server.registerTool(
    'search_artifacts',
    {
      description:
        'Search artifacts by text in their title, description and latest version (the entry file; not PDFs), best match first. Give plain words: all of them must match, and the last one also matches as a prefix. Each item has a `snippet` with the matched words between « and ». Pass `nextCursor` as `cursor` for the next page.',
      inputSchema: {
        query: z.string().describe('Words to find, e.g. "quarterly report"'),
        limit: z.number().int().min(1).max(100).optional().describe('Default 20, max 100'),
        cursor: z.string().optional(),
      },
      annotations: { readOnlyHint: true },
    },
    tool(async (query) => {
      const page = await artifacts.search(query);
      return {
        items: page.items.map((hit) => ({
          ...hit.artifact,
          url: pageUrl(hit.artifact.id),
          snippet: hit.snippet,
        })),
        nextCursor: page.nextCursor,
      };
    }),
  );

  server.registerTool(
    'list_versions',
    {
      description: 'List the versions of an artifact, newest first, with their files.',
      inputSchema: { id: z.string() },
      annotations: { readOnlyHint: true },
    },
    tool(async ({ id }) => {
      const versions = await artifacts.listVersions(id);
      if (!versions) throw notFound(id);
      return { versions: versions.map((v) => ({ ...v, url: pageUrl(id, v.version) })) };
    }),
  );

  server.registerTool(
    'delete_artifact',
    {
      description:
        'Delete an artifact with all its versions. This is a soft delete: it disappears from the app and from these tools, but the files are kept on the server, so an admin can restore it.',
      inputSchema: { id: z.string() },
      annotations: { destructiveHint: true, idempotentHint: true },
    },
    tool(async ({ id }) => {
      if (!(await artifacts.delete(id))) throw notFound(id);
      return { deleted: true };
    }),
  );

  return server;
}

function bearer(header: string | undefined): string | null {
  const match = header?.match(/^Bearer\s+(\S+)\s*$/i);
  return match?.[1] ?? null;
}

/**
 * MCP over Streamable HTTP, stateless: a fresh server and transport per request.
 * The ingress puts no forward auth in front of /mcp, so only the bearer token counts here;
 * X-authentik-* headers are never read.
 */
export function createMcpRoutes(deps: Deps): Hono {
  const app = new Hono();

  app.all('/', async (c) => {
    const token = bearer(c.req.header('authorization'));
    const info = token ? await deps.tokens.verify(token) : null;
    if (!info) {
      c.header('WWW-Authenticate', 'Bearer realm="agent-artifacts"');
      return c.json({ error: 'unauthorized', message: 'A valid bearer token is required' }, 401);
    }

    if (c.req.method !== 'POST') {
      c.header('Allow', 'POST');
      return c.json(
        {
          jsonrpc: '2.0',
          error: {
            code: -32000,
            message: 'Method not allowed: this server is stateless, use POST',
          },
          id: null,
        },
        405,
      );
    }

    const server = createServer(deps, info.name);
    const transport = new WebStandardStreamableHTTPServerTransport({
      sessionIdGenerator: undefined,
      enableJsonResponse: true,
      maxRequestBodySize: MAX_BODY_BYTES,
    });
    try {
      await server.connect(transport);
      return await transport.handleRequest(c.req.raw);
    } finally {
      await server.close();
    }
  });

  return app;
}
