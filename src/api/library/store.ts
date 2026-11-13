import { promises as fs } from 'node:fs';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';

export type MediaKind = 'image' | 'video' | 'audio';
export type ElementCategory = 'character' | 'scene' | 'prop' | 'product' | 'style' | 'other';
export const CATEGORIES: ElementCategory[] = ['character', 'scene', 'prop', 'product', 'style', 'other'];
export const MAX_UPLOAD_BYTES = 50 * 1024 * 1024;
export const MAX_REFERENCES = 50;

export type Asset = {
  id: string; owner: string; name: string; kind: MediaKind; mime: string;
  bytes: number; width: number; height: number; duration: number; fps: number;
  uri?: string; vid?: string; createdAt: string;
};
export type Element = {
  id: string; owner: string; name: string; category: ElementCategory; description: string;
  assetIds: string[]; subjectId: string; dataId: string; uid: string; content: Record<string, any>;
  createdAt: string; updatedAt: string;
};
export type Registry = { assets: Asset[]; elements: Element[] };

export class LibraryError extends Error {
  constructor(public status: number, public code: string, message: string) { super(message); }
}
export function invalid(message: string): never { throw new LibraryError(400, 'library.invalid_input', message); }
export function notFound(): never { throw new LibraryError(404, 'library.not_found', 'Material not found'); }
export function identifier(value: unknown): string {
  if (typeof value !== 'string' || !/^[a-z]+_[a-f0-9-]{36}$/.test(value)) return notFound();
  return value;
}
export function nameOf(value: unknown, limit = 120): string {
  if (typeof value !== 'string' || !value.trim() || value.trim().length > limit) invalid(`Name must contain 1-${limit} characters`);
  return value.trim();
}

// One account runs in one proxy process. Atomic replacement keeps restarts from observing a partial registry.
export class LibraryStore {
  private queue: Promise<unknown> = Promise.resolve();
  readonly directory: string;
  constructor(root: string, account: string) {
    this.directory = path.join(root, createHash('sha256').update(account).digest('hex'));
  }
  async read(): Promise<Registry> {
    try { return JSON.parse(await fs.readFile(path.join(this.directory, 'registry.json'), 'utf8')); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { assets: [], elements: [] }; throw error; }
  }
  async change<T>(operation: (registry: Registry) => Promise<T> | T): Promise<T> {
    const pending = this.queue.then(async () => {
      await fs.mkdir(this.directory, { recursive: true, mode: 0o700 });
      const registry = await this.read();
      const result = await operation(registry);
      const temporary = path.join(this.directory, `.registry-${randomUUID()}.tmp`);
      try {
        await fs.writeFile(temporary, JSON.stringify(registry), { mode: 0o600 });
        await fs.rename(temporary, path.join(this.directory, 'registry.json'));
      } finally { await fs.rm(temporary, { force: true }); }
      return result;
    });
    this.queue = pending.catch(() => {});
    return pending;
  }
  file(id: string): string { return path.join(this.directory, identifier(id)); }
  asset(registry: Registry, owner: string, id: string): Asset {
    return registry.assets.find(a => a.id === identifier(id) && a.owner === owner) ?? notFound();
  }
  element(registry: Registry, owner: string, id: string): Element {
    return registry.elements.find(e => e.id === identifier(id) && e.owner === owner) ?? notFound();
  }
}

const stores = new Map<string, LibraryStore>();
export function libraryStore(): LibraryStore {
  const account = process.env.JIMENG_LIBRARY_ACCOUNT;
  if (!account || !process.env.JIMENG_ACCOUNT_TOKEN || !process.env.JIMENG_API_KEY) {
    throw new LibraryError(503, "library.not_configured", "An account-bound private proxy is required");
  }
  const key = createHash('sha256').update(account).digest('hex');
  let store = stores.get(key);
  if (!store) {
    const root = process.env.JIMENG_LIBRARY_DIR;
    if (!root) throw new LibraryError(503, 'library.not_configured', 'Persistent library storage is not configured');
    store = new LibraryStore(root, account);
    stores.set(key, store);
  }
  return store;
}

export function assetView(a: Asset) {
  const { owner, uri, vid, ...view } = a;
  return view;
}
export function elementView(e: Element) {
  const { owner, subjectId, dataId, uid, content, ...view } = e;
  return view;
}
