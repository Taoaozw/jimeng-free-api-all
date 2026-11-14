import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { promises as fs, createWriteStream } from 'node:fs';
import path from 'node:path';
import { Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { Agent, request as fetch } from 'undici';
import { libraryStore } from '@/api/library/store.ts';
import { destination } from './callback.ts';
import { saveFrame } from './frame-store.ts';

const run = promisify(execFile);
const MAX_VIDEO_BYTES = 512 * 1024 * 1024;
const MAX_IMAGE_BYTES = 32 * 1024 * 1024;

export async function download(url: string, filename: string, limit: number) {
  const target = await destination(url);
  if (target.url.protocol !== 'https:') throw Error('HTTPS media is required');
  const agent = new Agent({ connect: { timeout: 5000, lookup: (_host, options, callback: any) => {
    callback(null, options.all ? [{ address: target.address, family: 4 }] : target.address, 4);
  } } });
  try {
    const response = await fetch(target.url, { dispatcher: agent, maxRedirections: 0, signal: AbortSignal.timeout(120_000) });
    if (response.statusCode !== 200 || Number(response.headers['content-length']) > limit) {
      response.body.destroy(); throw Error('Media download rejected');
    }
    let bytes = 0;
    await pipeline(response.body, new Transform({ transform(chunk, _encoding, callback) {
      bytes += chunk.length;
      callback(bytes > limit ? Error('Media exceeds size limit') : null, chunk);
    } }), createWriteStream(filename, { flags: 'wx', mode: 0o600 }));
    if (!bytes) throw Error('Empty media');
  } finally { await agent.destroy(); }
}

export function jpegDimensions(bytes: Buffer) {
  if (bytes[0] !== 0xff || bytes[1] !== 0xd8) throw Error('Expected JPEG');
  for (let offset = 2; offset + 8 < bytes.length;) {
    if (bytes[offset++] !== 0xff) break;
    const marker = bytes[offset++], length = bytes.readUInt16BE(offset);
    if (length < 2 || offset + length > bytes.length) break;
    if ([0xc0, 0xc1, 0xc2].includes(marker)) return { width: bytes.readUInt16BE(offset + 5), height: bytes.readUInt16BE(offset + 3) };
    offset += length;
  }
  throw Error('JPEG dimensions unavailable');
}

export async function extractLastFrame(video: string, image: string) {
  const options = { timeout: 60_000, killSignal: 'SIGKILL' as const, maxBuffer: 64 * 1024 };
  const probe = await run('ffprobe', ['-v', 'error', '-protocol_whitelist', 'file', '-format_whitelist', 'mov', '-select_streams', 'v:0', '-show_entries', 'stream=width,height,duration', '-of', 'json', video], options);
  const stream = JSON.parse(probe.stdout).streams?.[0];
  const width = Number(stream?.width), height = Number(stream?.height), duration = Number(stream?.duration);
  if (![width, height].every(n => Number.isInteger(n) && n > 0 && n <= 8192) || width * height > 4096 * 4096 || duration > 180) throw Error('Unsupported video dimensions or duration');
  const seek = Number.isFinite(duration) && duration > 1 ? ['-ss', String(duration - 1)] : [];
  const extract = async (position: string[]) => run('ffmpeg', [
    '-hide_banner', '-loglevel', 'error', '-nostdin', '-y', '-threads', '1',
    '-protocol_whitelist', 'file', '-format_whitelist', 'mov', ...position, '-i', video,
    '-map', '0:v:0', '-an', '-sn', '-dn', '-threads', '1', '-filter_threads', '1',
    '-fps_mode', 'passthrough', '-q:v', '2', '-update', '1', image,
  ], options);
  // Overwriting through EOF retains the actual final decoded frame, including variable frame rates.
  await extract(seek);
  if (!(await fs.stat(image).catch(() => undefined))?.size && seek.length) await extract([]);
  const stat = await fs.stat(image);
  if (!stat.size || stat.size > MAX_IMAGE_BYTES) throw Error('Invalid last frame size');
  const bytes = await fs.readFile(image), dimensions = jpegDimensions(bytes);
  if (dimensions.width !== width || dimensions.height !== height) throw Error('Last frame dimensions changed');
  return { bytes, width, height };
}

export async function lastFrame(sourceUrl: string) {
  const root = path.join(libraryStore().directory, 'frame-work');
  await fs.mkdir(root, { recursive: true, mode: 0o700 });
  const directory = await fs.mkdtemp(path.join(root, 'frame-'));
  try {
    const video = path.join(directory, 'source.mp4'), image = path.join(directory, 'last.jpg');
    await download(sourceUrl, video, MAX_VIDEO_BYTES);
    const { bytes } = await extractLastFrame(video, image);
    return await saveFrame(bytes);
  } finally { await fs.rm(directory, { recursive: true, force: true }); }
}
