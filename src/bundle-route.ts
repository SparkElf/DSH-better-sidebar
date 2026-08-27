/**
 * Lazy chunk route: serves the client bundle's chunk scripts
 * (/sidebar/bundle/<name>.js). The official /plugins/<id>/client.js route
 * cannot serve arbitrary file names, so the plugin serves its own split
 * bundles (lib/client-<name>.js) here; the client injects the script on
 * first use of the feature that needs it (see src/client/chunk-loader.ts).
 *
 * Caching contract: every response carries `cache-control: no-cache` plus an
 * ETag computed from the exact response bytes and honors If-None-Match — the
 * browser revalidates each fetch, but a 304 avoids
 * re-downloading multi-MB chunks that did not change (page refresh, HMR
 * re-activation). Same browser-trust fence as every other /sidebar route;
 * only allowlisted chunk names are servable (no path traversal).
 */
import { createHash } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { Context, SidebarHttpRequest, SidebarHttpResponse } from './context-types.ts'

/** The chunk names the client may request (mirror of src/client/chunk-loader.ts). */
export const CHUNK_NAMES = ['terminal', 'editor', 'mermaid'] as const
export type ChunkName = (typeof CHUNK_NAMES)[number]

/** Directory of this host-half module (lib/ — the chunk scripts live next to it). */
const LIB_DIR = dirname(fileURLToPath(import.meta.url))

/** sha1 content hash shortened to 12 hex chars (same shape as the client-modules rev). */
function shortHash(input: string | Buffer): string {
  return createHash('sha1').update(input).digest('hex').slice(0, 12)
}

interface ChunkBundle {
  body: Buffer
  etag: string
}

/** Read one chunk and derive its ETag from the exact bytes served. */
async function readBundle(name: ChunkName, chunkDir: string): Promise<ChunkBundle | undefined> {
  try {
    const body = await readFile(join(chunkDir, `client-${name}.js`))
    return { body, etag: `"${shortHash(body)}"` }
  } catch {
    return undefined
  }
}

/**
 * Build the /sidebar/bundle route handler. `fence` is the shared browser-
 * trust check every /sidebar route applies; `chunkDir` is the directory the
 * chunk scripts live in (overridable for tests).
 */
export function createBundleRouteHandler(
  fence: (req: SidebarHttpRequest) => boolean,
  chunkDir: string = LIB_DIR,
): (req: SidebarHttpRequest, res: SidebarHttpResponse) => Promise<void> {
  return async (req, res): Promise<void> => {
    if (!fence(req)) {
      res.writeHead(403)
      res.end('forbidden')
      return
    }
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      res.writeHead(405)
      res.end()
      return
    }
    const pathname = new URL(req.url ?? '/', 'http://dsh.internal').pathname
    const match = /^\/sidebar\/bundle\/([a-z0-9-]+)\.js$/.exec(pathname)
    const name = match?.[1] as ChunkName | undefined
    if (name === undefined || !(CHUNK_NAMES as readonly string[]).includes(name)) {
      res.writeHead(404)
      res.end('not found')
      return
    }
    const bundle = await readBundle(name, chunkDir)
    if (bundle === undefined) {
      // Registered name but unreadable (bundle not built yet): loud 404.
      res.writeHead(404)
      res.end('not found')
      return
    }
    if (req.headers['if-none-match'] === bundle.etag) {
      // Revalidation hit: unchanged chunk, no body — avoids re-downloading
      // multi-MB scripts on page refresh / HMR re-activation.
      res.writeHead(304, { 'cache-control': 'no-cache', etag: bundle.etag })
      res.end()
      return
    }
    res.writeHead(200, {
      'content-type': 'text/javascript; charset=utf-8',
      'cache-control': 'no-cache',
      etag: bundle.etag,
    })
    res.end(bundle.body)
  }
}

/** Register the /sidebar/bundle route (disposed with the fiber). */
export function registerBundleRoute(ctx: Context, fence: (req: SidebarHttpRequest) => boolean): () => void {
  return ctx.webServer.register({
    kind: 'prefix',
    path: '/sidebar/bundle',
    handler: createBundleRouteHandler(fence),
  })
}
