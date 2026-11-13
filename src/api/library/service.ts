import { promises as fs, createReadStream } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { request, tokenSplit, parseRegionFromToken } from '@/api/controllers/core.ts';
import { uploadImageBufferForVideo, uploadMediaForVideo } from '@/api/controllers/videos.ts';
import { decodeUpload, dimension } from './media.ts';
import { Asset, Element, Registry, CATEGORIES, libraryStore, assetView, elementView, invalid, nameOf, LibraryError } from './store.ts';

export function context(headers: Record<string, string>) {
  const owner = headers['x-flowxy-library-owner'];
  if (!owner || !/^[a-zA-Z0-9-]{1,80}$/.test(owner)) throw new LibraryError(403, 'library.owner_required', 'Trusted organization identity is required');
  const tokens = tokenSplit(headers.authorization || '');
  if (tokens.length !== 1) invalid('A library must use one upstream account');
  return { owner, token: tokens[0], store: libraryStore() };
}
export type Context = ReturnType<typeof context>;

export async function list(ctx: Context, kind: 'assets' | 'elements') {
  const registry = await ctx.store.read();
  return { data: kind === 'assets' ? registry.assets.filter(a => a.owner === ctx.owner).map(assetView) : registry.elements.filter(e => e.owner === ctx.owner).map(elementView) };
}
export async function upload(ctx: Context, body: any) {
  const name = nameOf(body.name);
  const { buffer, mime, kind } = decodeUpload(body.data);
  const width = kind === 'image' ? dimension(body.width) : 0;
  const height = kind === 'image' ? dimension(body.height) : 0;
  return ctx.store.change(async registry => {
    if (registry.assets.filter(a => a.owner === ctx.owner).length >= 500) invalid('Library asset limit reached');
    const asset: Asset = { id: `asset_${randomUUID()}`, owner: ctx.owner, name, kind, mime, bytes: buffer.length, width, height, duration: 0, fps: 0, createdAt: new Date().toISOString() };
    if (kind === 'image') asset.uri = await uploadImageBufferForVideo(buffer, ctx.token, parseRegionFromToken(ctx.token));
    else {
      const uploaded = await uploadMediaForVideo(buffer, kind, ctx.token, name);
      Object.assign(asset, uploaded, { duration: (uploaded.duration ?? 0) / 1000 });
    }
    await fs.writeFile(ctx.store.file(asset.id), buffer, { mode: 0o600, flag: 'wx' });
    registry.assets.push(asset);
    return assetView(asset);
  });
}
export async function rename(ctx: Context, id: string, body: any) {
  const name = nameOf(body.name);
  return ctx.store.change(registry => { const asset = ctx.store.asset(registry, ctx.owner, id); asset.name = name; return assetView(asset); });
}
export async function removeAsset(ctx: Context, id: string) {
  await ctx.store.change(registry => {
    ctx.store.asset(registry, ctx.owner, id);
    if (registry.elements.some(e => e.owner === ctx.owner && e.assetIds.includes(id))) throw new LibraryError(409, 'library.asset_in_use', 'Remove this asset from its elements first');
    registry.assets = registry.assets.filter(a => a.id !== id);
  });
  await fs.rm(ctx.store.file(id), { force: true });
  return { deleted: true };
}
export async function content(ctx: Context, id: string) {
  const asset = ctx.store.asset(await ctx.store.read(), ctx.owner, id);
  await fs.access(ctx.store.file(id));
  return { stream: createReadStream(ctx.store.file(id)), mime: asset.mime, size: asset.bytes };
}

function elementContent(ctx: Context, registry: Registry, body: any) {
  const name = nameOf(body.name, 20);
  if (!CATEGORIES.includes(body.category)) invalid('Invalid element category');
  if (typeof body.description !== 'string' || body.description.length > 2000) invalid('Description must be a string with at most 2000 characters');
  if (!Array.isArray(body.assetIds) || !body.assetIds.length || body.assetIds.length > 10 || new Set(body.assetIds).size !== body.assetIds.length) invalid('Select 1-10 distinct assets');
  const assets: Asset[] = body.assetIds.map((id: string) => ctx.store.asset(registry, ctx.owner, id));
  const images = assets.filter(a => a.kind === 'image');
  const videos = assets.filter(a => a.kind === 'video');
  const audios = assets.filter(a => a.kind === 'audio');
  if (videos.length > 1 || audios.length > 1 || (videos.length && assets.length !== 1) || images.length > 9 || (!videos.length && !images.length)) invalid('Use up to 9 images with optional audio, or one video alone');
  const image = (a: Asset) => ({ image_uri: a.uri, width: a.width, height: a.height });
  const content: Record<string, any> = { name, description: body.description, category: body.category };
  if (images.length) { content.main_image = image(images[0]); if (images.length > 1) content.auxiliary_images = images.slice(1).map(image); }
  if (videos.length) content.video_info = { vid: videos[0].vid, duration: videos[0].duration };
  if (audios.length) {
    const voice = { source: 'upload', audio_info: { vid: audios[0].vid, duration: audios[0].duration, title: audios[0].name } };
    content.voice_list = [voice];
    content.selected_voice = voice;
  }
  return content;
}
export async function saveElement(ctx: Context, body: any, id?: string) {
  return ctx.store.change(async registry => {
    const previous = id ? ctx.store.element(registry, ctx.owner, id) : undefined;
    if (!previous && registry.elements.filter(e => e.owner === ctx.owner).length >= 500) invalid('Library element limit reached');
    const content = elementContent(ctx, registry, body);
    const subject = await request('post', `/mweb/v1/dreamina_subject/${previous ? 'update' : 'create'}`, ctx.token, { data: { content, ...(previous ? { subject_id: previous.subjectId } : {}) } });
    if (!subject?.subject_id || !subject?.data_id || !subject?.uid || !subject?.content) throw new LibraryError(502, 'library.upstream_failed', 'Upstream returned an incomplete element');
    const now = new Date().toISOString();
    const element: Element = { id: previous?.id ?? `element_${randomUUID()}`, owner: ctx.owner, name: content.name, category: body.category, description: body.description, assetIds: body.assetIds, subjectId: String(subject.subject_id), dataId: String(subject.data_id), uid: String(subject.uid), content: subject.content, createdAt: previous?.createdAt ?? now, updatedAt: now };
    if (previous) registry.elements = registry.elements.map(e => e.id === id ? element : e);
    else registry.elements.push(element);
    return elementView(element);
  });
}
export async function removeElement(ctx: Context, id: string) {
  return ctx.store.change(async registry => {
    const element = ctx.store.element(registry, ctx.owner, id);
    await request('post', '/mweb/v1/dreamina_subject/delete', ctx.token, { data: { subject_id_list: [element.subjectId] } });
    registry.elements = registry.elements.filter(e => e.id !== id);
    return { deleted: true };
  });
}
