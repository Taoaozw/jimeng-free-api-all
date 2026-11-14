import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { libraryStore } from '@/api/library/store.ts';
import { download } from './last-frame.ts';
import { saveVideo } from './frame-store.ts';

const run = promisify(execFile);
const options = { timeout: 60_000, killSignal: 'SIGKILL' as const, maxBuffer: 64 * 1024 };
const MAX_BYTES = 512 * 1024 * 1024;
async function probe(filename: string) {
  const result = await run('ffprobe', ['-v', 'error', '-protocol_whitelist', 'file', '-format_whitelist', 'mov', '-show_entries', 'stream=codec_type,codec_name,width,height,duration,nb_frames', '-of', 'json', filename], options);
  return JSON.parse(result.stdout).streams as any[];
}
export async function removeAudio(source: string, output: string) {
  const before = (await probe(source)).find(stream => stream.codec_type === 'video');
  if (!before || !(before.width > 0 && before.height > 0) || before.width * before.height > 4096 * 4096 || Number(before.duration) > 180) throw Error('Unsupported video');
  // Stream copy preserves the selected watermark variant and avoids generation loss.
  await run('ffmpeg', ['-v', 'error', '-nostdin', '-y', '-protocol_whitelist', 'file', '-format_whitelist', 'mov', '-i', source,
    '-map', '0:v:0', '-c:v', 'copy', '-an', '-sn', '-dn', '-map_metadata', '-1', '-movflags', '+faststart', output], options);
  const streams = await probe(output), after = streams[0], size = (await fs.stat(output)).size;
  if (!size || size > MAX_BYTES || streams.length !== 1 || after.codec_type !== 'video' ||
    ['codec_name', 'width', 'height', 'nb_frames'].some(key => before[key] !== after[key]) ||
    Math.abs(Number(before.duration) - Number(after.duration)) > 0.05) throw Error('Silent video validation failed');
}
export async function muteVideo(sourceUrl: string) {
  const root = path.join(libraryStore().directory, 'frame-work');
  await fs.mkdir(root, { recursive: true, mode: 0o700 });
  const directory = await fs.mkdtemp(path.join(root, 'frame-'));
  try {
    const source = path.join(directory, 'source.mp4'), output = path.join(directory, 'silent.mp4');
    await download(sourceUrl, source, MAX_BYTES);
    await removeAudio(source, output);
    return await saveVideo(output);
  } finally { await fs.rm(directory, { recursive: true, force: true }); }
}
