import Request from '@/lib/request/Request.ts';
import Response from '@/lib/response/Response.ts';
import { readFrame } from '@/api/tasks/frame-store.ts';

export default {
  prefix: '/last-frames',
  get: { '/:name': async (req: Request) => {
    try {
      if (!/^[a-f0-9]{64}\.jpg$/.test(req.params.name)) throw Error('Invalid frame');
      const { stream, size } = await readFrame(req.params.name.slice(0, -4));
      return new Response(stream, { statusCode: 200, type: 'image/jpeg', size,
        headers: { 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' } });
    } catch { return new Response({ error: { code: 'task.frame_not_found', message: 'Last frame not found or expired' } }, { statusCode: 404, headers: { 'Cache-Control': 'no-store' } }); }
  } },
};
