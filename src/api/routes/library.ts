import logger from '@/lib/logger.ts';
import Request from '@/lib/request/Request.ts';
import Response from '@/lib/response/Response.ts';
import * as library from '@/api/library/service.ts';
import { CATEGORIES, MAX_UPLOAD_BYTES, MAX_REFERENCES, LibraryError } from '@/api/library/store.ts';

const handle = (fn: (ctx: library.Context, request: Request) => Promise<any>) => async (request: Request) => {
  try {
    const value = await fn(library.context(request.headers), request);
    return Response.isInstance(value) ? value : new Response(value, { statusCode: 200 });
  } catch (error) {
    const known = error instanceof LibraryError;
    if (!known) logger.warn("Material upstream failure", { code: error.errcode ?? error.code, message: error.errmsg ?? String(error.message).split(":")[0] });
    return new Response({ error: { code: known ? error.code : 'library.upstream_failed', message: known ? error.message : 'Dreamina material operation failed' } }, { statusCode: known ? error.status : 502 });
  }
};
export default {
  prefix: '/v1/videos/library',
  get: {
    '/metadata': handle(async () => ({ categories: CATEGORIES, maxUploadBytes: MAX_UPLOAD_BYTES, maxReferences: MAX_REFERENCES, maxElementImages: 9, maxElementAssets: 10 })),
    '/assets': handle(ctx => library.list(ctx, 'assets')),
    '/elements': handle(ctx => library.list(ctx, 'elements')),
    '/assets/:id/content': handle(async (ctx, req) => { const result = await library.content(ctx, req.params.id); return new Response(result.stream, { statusCode: 200, type: result.mime, size: result.size, headers: { 'Cache-Control': 'private, no-store', 'X-Content-Type-Options': 'nosniff' } }); }),
  },
  post: {
    '/assets': handle((ctx, req) => library.upload(ctx, req.body)),
    '/elements': handle((ctx, req) => library.saveElement(ctx, req.body)),
  },
  patch: {
    '/assets/:id': handle((ctx, req) => library.rename(ctx, req.params.id, req.body)),
    '/elements/:id': handle((ctx, req) => library.saveElement(ctx, req.body, req.params.id)),
  },
  delete: {
    '/assets/:id': handle((ctx, req) => library.removeAsset(ctx, req.params.id)),
    '/elements/:id': handle((ctx, req) => library.removeElement(ctx, req.params.id)),
  },
};
