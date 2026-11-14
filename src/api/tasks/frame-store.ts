import { promises as fs, createReadStream } from 'node:fs';
import { randomBytes } from 'node:crypto';
import path from 'node:path';
import { libraryStore, LibraryError } from '@/api/library/store.ts';

const root = () => path.join(libraryStore().directory, 'last-frames');
const missing = () => { throw new LibraryError(404, 'task.frame_not_found', 'Last frame not found or expired'); };
export const isFrameRequest = (method: string, pathname: string) =>
  ['GET', 'HEAD'].includes(method) && /^\/last-frames\/[a-f0-9]{64}\.jpg$/.test(pathname);
export function frameBaseUrl() {
  const value = process.env.JIMENG_MEDIA_BASE_URL;
  const url = value ? new URL(value) : undefined;
  if (!url || url.protocol !== 'https:' || url.username || url.password || url.search || url.hash) throw new LibraryError(503, 'task.frame_not_configured', 'Last frame storage URL is not configured');
  return value.replace(/\/$/, '');
}
const file = (id: string, extension: string) => {
  if (!/^[a-f0-9]{64}$/.test(id)) return missing();
  return path.join(root(), `${id}.${extension}`);
};
export async function saveFrame(bytes: Buffer) {
  const base = frameBaseUrl(), id = randomBytes(32).toString('hex'), expiresAt = Date.now() + 86400_000;
  await fs.mkdir(root(), { recursive: true, mode: 0o700 });
  try {
    await fs.writeFile(file(id, 'jpg'), bytes, { mode: 0o600, flag: 'wx' });
    // Publish metadata last so readers never observe an incomplete image.
    await fs.writeFile(file(id, 'json'), JSON.stringify({ expiresAt }), { mode: 0o600, flag: 'wx' });
  } catch (error) { await removeFrame(id); throw error; }
  return { id, url: `${base}/last-frames/${id}.jpg`, expiresAt };
}
export async function readFrame(id: string) {
  const metadata = await fs.readFile(file(id, 'json'), 'utf8').then(JSON.parse).catch(() => missing());
  if (!Number.isFinite(metadata.expiresAt) || metadata.expiresAt <= Date.now()) { await removeFrame(id); return missing(); }
  const stat = await fs.stat(file(id, 'jpg')).catch(() => missing());
  return { stream: createReadStream(file(id, 'jpg')), size: stat.size };
}
export async function removeFrame(id: string) {
  await Promise.all(['jpg', 'json'].map(extension => fs.rm(file(id, extension), { force: true })));
}
export async function cleanFrames() {
  const entries = await fs.readdir(root()).catch((e) => { if (e.code === 'ENOENT') return []; throw e; });
  for (const name of entries) {
    if (!/^[a-f0-9]{64}\.(jpg|json)$/.test(name)) continue;
    const filename = path.join(root(), name);
    const stat = await fs.stat(filename).catch(() => undefined);
    if (stat && Date.now() - stat.mtimeMs > 86400_000) await fs.rm(filename, { force: true });
  }
  // Interrupted workers leave only scratch files; a live job is bounded to a few minutes.
  const work = path.join(libraryStore().directory, 'frame-work');
  for (const name of await fs.readdir(work).catch(() => [])) {
    if (!/^frame-[a-zA-Z0-9]+$/.test(name)) continue;
    const directory = path.join(work, name), stat = await fs.stat(directory).catch(() => undefined);
    if (stat && Date.now() - stat.mtimeMs > 3600_000) await fs.rm(directory, { recursive: true, force: true });
  }
}
