import { randomUUID } from 'node:crypto';
import type { Context } from './service.ts';
import { Asset, Element, invalid, MAX_REFERENCES } from './store.ts';

const node = () => ({ type: '', id: randomUUID() });
function image(info: any) {
  const uri = info.image_uri ?? info.uri;
  return { ...node(), type: 'image', source_from: 'upload', platform_type: 1, name: '', image_uri: uri, uri, width: info.width, height: info.height, format: '' };
}
function media(info: any, kind: 'video' | 'audio') {
  return { ...node(), type: kind, source_from: 'upload', name: '', vid: info.vid, duration: Math.round((info.duration ?? 0) * 1000), ...(kind === 'video' ? { width: info.width ?? 0, height: info.height ?? 0, fps: info.fps ?? 0 } : {}) };
}
export function assetMaterial(asset: Asset) {
  const info = asset.kind === 'image' ? image(asset) : media(asset, asset.kind);
  return { ...node(), material_type: asset.kind, [`${asset.kind}_info`]: info };
}
export function elementMaterial(element: Element) {
  const c = element.content;
  const content: Record<string, any> = { ...node(), name: element.name, description: element.description, category: element.category };
  if (c.main_image) content.main_image = image(c.main_image);
  if (c.auxiliary_images?.length) content.auxiliary_images = c.auxiliary_images.map(image);
  if (c.video_info) content.video_info = media(c.video_info, 'video');
  if (c.audio_info) content.audio_info = media(c.audio_info, 'audio');
  const voice = (v: any) => ({ ...node(), source: v.source, audio_info: media(v.audio_info, 'audio') });
  if (c.voice_list?.length) content.voice_list = c.voice_list.map(voice);
  if (c.selected_voice) content.selected_voice = voice(c.selected_voice);
  return { ...node(), material_type: 'subject', subject_data: { ...node(), uid: element.uid, subject_id: element.subjectId, data_id: element.dataId, content, subject_control: { ...node(), status: 0, enabled: true, editable: true, deletable: true } } };
}
export function buildReferences(prompt: string, materials: any[]) {
  const meta: any[] = [];
  let offset = 0;
  const mentioned = new Set<number>();
  for (const match of prompt.matchAll(/@(\d+)/g)) {
    const index = Number(match[1]) - 1;
    if (index < 0 || index >= materials.length) invalid(`Unknown reference ${match[0]}`);
    if (match.index! > offset) meta.push({ ...node(), meta_type: 'text', text: prompt.slice(offset, match.index) });
    meta.push({ ...node(), meta_type: materials[index].material_type, text: '', material_ref: { ...node(), material_idx: index } });
    mentioned.add(index);
    offset = match.index! + match[0].length;
  }
  if (offset < prompt.length) meta.push({ ...node(), meta_type: 'text', text: prompt.slice(offset) });
  // Every selected material must be visible to the model, even when the prompt omits its placeholder.
  const implicit = materials.flatMap((m, index) => mentioned.has(index) ? [] : [{ ...node(), meta_type: m.material_type, text: '', material_ref: { ...node(), material_idx: index } }]);
  return { ...node(), material_list: materials, meta_list: [...implicit, ...meta] };
}
export async function resolveReferences(ctx: Context, body: any) {
  if (body.model !== 'jimeng-video-seedance-2.5' || typeof body.library_id !== 'string') invalid('Library references require Seedance 2.5 and library_id');
  if ((body.file_paths?.length || body.filePaths?.length)) invalid('Library references cannot be combined with frame images');
  if (!Array.isArray(body.references) || !body.references.length || body.references.length > MAX_REFERENCES || new Set(body.references).size !== body.references.length) invalid(`Select 1-${MAX_REFERENCES} distinct references`);
  if (typeof body.prompt !== 'string' || !body.prompt.trim()) invalid('Prompt is required');
  const registry = await ctx.store.read();
  const materials = body.references.map((id: string) => {
    if (typeof id !== 'string') invalid('Reference IDs must be strings');
    if (id.startsWith('asset_')) return assetMaterial(ctx.store.asset(registry, ctx.owner, id));
    return elementMaterial(ctx.store.element(registry, ctx.owner, id));
  });
  return buildReferences(body.prompt, materials);
}
