import { createReadStream } from 'node:fs';
import Request from '@/lib/request/Request.ts';
import Response from '@/lib/response/Response.ts';
import { readVideo } from '@/api/tasks/frame-store.ts';

export default {
  prefix: '/silent-videos',
  get: { '/:name': async (req: Request) => {
    const headers: Record<string, string> = { 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', 'Accept-Ranges': 'bytes' };
    try {
      if (!/^[a-f0-9]{64}\.mp4$/.test(req.params.name)) throw Error('Invalid video');
      const { filename, size } = await readVideo(req.params.name.slice(0, -4));
      let start = 0, end = size - 1, statusCode = 200;
      const range = req.headers.range;
      if (range && req.method !== 'HEAD') {
        const match = /^bytes=(\d*)-(\d*)$/.exec(range);
        if (!match || (!match[1] && !match[2])) return new Response('', { statusCode: 416, headers: { ...headers, 'Content-Range': `bytes */${size}` } });
        start = match[1] ? Number(match[1]) : Math.max(0, size - Number(match[2]));
        end = match[1] && match[2] ? Math.min(Number(match[2]), size - 1) : size - 1;
        if (![start, end].every(Number.isSafeInteger) || start > end || start >= size) return new Response('', { statusCode: 416, headers: { ...headers, 'Content-Range': `bytes */${size}` } });
        statusCode = 206; headers['Content-Range'] = `bytes ${start}-${end}/${size}`;
      }
      return new Response(createReadStream(filename, { start, end }), { statusCode, type: 'video/mp4', size: end - start + 1, headers });
    } catch { return new Response({ error: { code: 'task.video_not_found', message: 'Video not found or expired' } }, { statusCode: 404, headers }); }
  } },
};
