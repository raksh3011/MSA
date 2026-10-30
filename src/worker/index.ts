/**
 * Worker entry. Static frontend assets are served by the platform (see wrangler.toml);
 * everything under /api and /ws is routed to the single global Durable Object.
 */
import type { Env } from './hub-do';

export { OrvmsHub } from './hub-do';

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    if (!url.pathname.startsWith('/api/') && url.pathname !== '/ws') {
      return new Response('Not found', { status: 404 });
    }
    const stub = env.HUB.get(env.HUB.idFromName('global'));
    return stub.fetch(request);
  },
} satisfies ExportedHandler<Env>;
