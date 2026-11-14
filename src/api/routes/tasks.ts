import Request from '@/lib/request/Request.ts';
import Response from '@/lib/response/Response.ts';
import { LibraryError } from '@/api/library/store.ts';
import * as tasks from '@/api/tasks/service.ts';

const handle = (fn: (req: Request) => Promise<any>) => async (req: Request) => {
  try { return new Response(await fn(req), { statusCode: 200 }); }
  catch (error) {
    const known = error instanceof LibraryError;
    return new Response({ error: {
      code: known ? error.code.replace(/^library\./, 'task.') : String(error.errcode ?? 'task.upstream_failed'),
      message: known ? error.message : String(error.errmsg ?? 'Dreamina upstream operation failed'),
    } }, { statusCode: known ? error.status : 502 });
  }
};

export default {
  prefix: '/v1/contents/generations/tasks',
  post: { '': handle(req => tasks.create(req.headers, req.body)) },
  get: { '/:id': handle(req => tasks.get(req.headers, req.params.id)) },
  delete: { '/:id': handle(req => tasks.remove(req.headers, req.params.id)) },
};
