import { promises as fs, createReadStream } from 'node:fs';
import { randomBytes } from 'node:crypto';
import path from 'node:path';
import { libraryStore, LibraryError } from '@/api/library/store.ts';

type Kind = 'frame' | 'video';
const formats = { frame: { directory: 'last-frames', extension: 'jpg' }, video: { directory: 'silent-videos', extension: 'mp4' } };
const root = (kind: Kind = 'frame') => path.join(libraryStore().directory, formats[kind].directory);
const missing = () => { throw new LibraryError(404, 'task.frame_not_found', 'Last frame not found or expired'); };
export const isMediaRequest = (method: string, pathname: string) =>
  ['GET', 'HEAD'].includes(method) && (/^\/last-frames\/[a-f0-9]{64}\.jpg$/.test(pathname) || /^\/silent-videos\/[a-f0-9]{64}\.mp4$/.test(pathname));
export function frameBaseUrl() {
  const value = process.env.JIMENG_MEDIA_BASE_URL;
  const url = value ? new URL(value) : undefined;
  if (!url || url.protocol !== 'https:' || url.username || url.password || url.search || url.hash) throw new LibraryError(503, 'task.frame_not_configured', 'Last frame storage URL is not configured');
  return value.replace(/\/$/, '');
}
const file = (id: string, extension: string, kind: Kind = 'frame') => {
  if (!/^[a-f0-9]{64}$/.test(id)) return missing();
  return path.join(root(kind), `${id}.${extension}`);
};
export const saveFrame = (bytes: Buffer) => saveArtifact('frame', bytes);
export const saveVideo = (filename: string) => saveArtifact('video', filename);
async function saveArtifact(kind: Kind, source: Buffer | string) {
  const base = frameBaseUrl(), id = randomBytes(32).toString('hex'), expiresAt = Date.now() + 86400_000;
  const { directory, extension } = formats[kind];
  await fs.mkdir(root(kind), { recursive: true, mode: 0o700 });
  try {
    if (typeof source === 'string') {
      await fs.chmod(source, 0o600);
      await fs.rename(source, file(id, extension, kind));
    } else await fs.writeFile(file(id, extension, kind), source, { mode: 0o600, flag: 'wx' });
    // Publish metadata last so readers never observe an incomplete file.
    await fs.writeFile(file(id, 'json', kind), JSON.stringify({ expiresAt }), { mode: 0o600, flag: 'wx' });
  } catch (error) { await removeArtifact(id, kind); throw error; }
  return { id, url: `${base}/${directory}/${id}.${extension}`, expiresAt };
}
async function readArtifact(id: string, kind: Kind) {
  const metadata = await fs.readFile(file(id, 'json', kind), 'utf8').then(JSON.parse).catch(() => missing());
  if (!Number.isFinite(metadata.expiresAt) || metadata.expiresAt <= Date.now()) { await removeArtifact(id, kind); return missing(); }
  const filename = file(id, formats[kind].extension, kind);
  const stat = await fs.stat(filename).catch(() => missing());
  return { filename, size: stat.size };
}
export async function readFrame(id: string) {
  const { filename, size } = await readArtifact(id, 'frame');
  return { stream: createReadStream(filename), size };
}
export const readVideo = (id: string) => readArtifact(id, 'video');
export const removeFrame = (id: string) => removeArtifact(id, 'frame');
export const removeVideo = (id: string) => removeArtifact(id, 'video');
async function removeArtifact(id: string, kind: Kind) {
  await Promise.all([formats[kind].extension, 'json'].map(extension => fs.rm(file(id, extension, kind), { force: true })));
}
export async function cleanFrames() {
  for (const kind of ['frame', 'video'] as const) {
    const entries = await fs.readdir(root(kind)).catch((e) => { if (e.code === 'ENOENT') return []; throw e; });
    for (const name of entries) {
      if (!/^[a-f0-9]{64}\.(jpg|mp4|json)$/.test(name)) continue;
      const filename = path.join(root(kind), name);
      const stat = await fs.stat(filename).catch(() => undefined);
      if (stat && Date.now() - stat.mtimeMs > 86400_000) await fs.rm(filename, { force: true });
    }
  }
  // Interrupted workers leave only scratch files; a live job is bounded to a few minutes.
  const work = path.join(libraryStore().directory, 'frame-work');
  for (const name of await fs.readdir(work).catch(() => [])) {
    if (!/^frame-[a-zA-Z0-9]+$/.test(name)) continue;
    const directory = path.join(work, name), stat = await fs.stat(directory).catch(() => undefined);
    if (stat && Date.now() - stat.mtimeMs > 3600_000) await fs.rm(directory, { recursive: true, force: true });
  }
}
