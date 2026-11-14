import axios from 'axios';
import { randomUUID } from 'node:crypto';
import { uploadImageForVideo, uploadMediaForVideo } from '@/api/controllers/videos.ts';
import { assetMaterial, buildReferences, resolveReferences } from '@/api/library/references.ts';
import { context } from '@/api/library/service.ts';
import { invalid, MAX_UPLOAD_BYTES } from '@/api/library/store.ts';
import { decodeUpload } from '@/api/library/media.ts';

export function parseInput(body: any) {
  if (!body || body.model !== 'jimeng-video-seedance-2.5') invalid('This adapter supports jimeng-video-seedance-2.5');
  const allowed = new Set(['model', 'content', 'ratio', 'resolution', 'duration', 'seed', 'library_id', 'references', 'draft', 'callback_url']);
  for (const key of Object.keys(body)) if (!allowed.has(key)) invalid(`Unsupported parameter: ${key}`);
  if (body.draft !== undefined && typeof body.draft !== 'boolean') invalid('draft must be boolean');
  const draftTask = (Array.isArray(body.content) ? body.content : []).find((item: any) => item?.type === 'draft_task');
  if (draftTask) {
    if (body.content.length !== 1 || typeof draftTask.draft_task?.id !== 'string') invalid('draft_task must be the only content item');
    if (body.draft === true || (body.resolution !== undefined && body.resolution !== '1080p')) invalid('Final video requires draft=false and resolution=1080p');
    for (const key of ['ratio', 'duration', 'seed', 'library_id', 'references']) if (body[key] !== undefined) invalid(`Draft finalization inherits ${key}`);
    return { model: body.model as string, prompt: '', ratio: '16:9', resolution: '1080p', duration: 5, seed: undefined, filePaths: [], references: [], draft: false, draftTaskId: draftTask.draft_task.id as string };
  }
  const ratio = body.ratio ?? '16:9', resolution = body.resolution ?? (body.draft ? '480p' : '720p'), duration = body.duration ?? 5;
  if (!['16:9', '9:16', '1:1', '4:3', '3:4', '21:9'].includes(ratio)) invalid('Unsupported ratio');
  if (body.draft && resolution !== '480p') invalid('Draft requires resolution=480p');
  if (!['480p', '720p', '1080p', '4k'].includes(resolution)) invalid('Unsupported resolution');
  if (!Number.isInteger(duration) || duration < 4 || duration > 30) invalid('Duration must be an integer between 4 and 30');
  if (body.seed !== undefined && (!Number.isInteger(body.seed) || body.seed < -1 || body.seed > 4294967295)) invalid('Invalid seed');
  if (!Array.isArray(body.content) || !body.content.length || body.content.length > 100) invalid('content must contain 1-100 items');
  const text: string[] = [], frames: Record<string, string> = {}, references: { kind: 'image' | 'video' | 'audio'; url: string }[] = [];
  for (const item of body.content) {
    if (!item || typeof item !== 'object') invalid('Invalid content item');
    if (item.type === 'text') {
      if (typeof item.text !== 'string') invalid('text must be a string');
      text.push(item.text);
      continue;
    }
    const kind = ({ image_url: 'image', video_url: 'video', audio_url: 'audio' } as const)[item.type];
    const url = item[item.type]?.url;
    if (!kind || typeof url !== 'string' || !/^(https?:\/\/|data:)/.test(url)) invalid('Unsupported content URL');
    const role = item.role ?? (kind === 'image' ? 'first_frame' : undefined);
    if (kind === 'image' && ['first_frame', 'last_frame'].includes(role)) {
      if (frames[role]) invalid('Duplicate frame role');
      frames[role] = url;
    } else {
      if (item.role !== `reference_${kind}`) invalid(`Expected reference_${kind} role`);
      references.push({ kind, url });
    }
  }
  const prompt = text.join('\n');
  if (!prompt.trim()) invalid('A text prompt is required by this adapter');
  if (frames.last_frame && !frames.first_frame) invalid('last_frame requires first_frame');
  const filePaths = [frames.first_frame, frames.last_frame].filter(Boolean);
  if (filePaths.length && (references.length || body.library_id !== undefined || body.references !== undefined)) invalid('Frame and reference modes cannot be combined');
  if (references.length && (body.library_id !== undefined || body.references !== undefined)) invalid('URL references and library references cannot be combined');
  for (const [kind, limit] of [['image', 30], ['video', 10], ['audio', 10]] as const) {
    if (references.filter(r => r.kind === kind).length > limit) invalid(`Too many ${kind} references`);
  }
  return { model: body.model as string, prompt, ratio, resolution, duration, seed: body.seed === -1 ? undefined : body.seed, filePaths, references, draft: body.draft === true, draftTaskId: undefined as string | undefined };
}

export async function generationOptions(input: ReturnType<typeof parseInput>, body: any, headers: Record<string, string>, token: string) {
  const { references, model, prompt, ...options } = input;
  let unifiedEditInput;
  if (body.library_id !== undefined || body.references !== undefined) {
    unifiedEditInput = await resolveReferences(context(headers), { ...body, prompt });
  } else if (references.length) {
    const materials = [];
    for (const { kind, url } of references) {
      const asset: any = { id: randomUUID(), kind, name: '', width: 0, height: 0, duration: 0, fps: 0 };
      if (kind === 'image') asset.uri = await uploadImageForVideo(url, token);
      else {
        const buffer = url.startsWith('data:') ? decodeUpload(url).buffer : Buffer.from((await axios.get(url, {
          responseType: 'arraybuffer', timeout: 60_000, maxContentLength: MAX_UPLOAD_BYTES, maxBodyLength: MAX_UPLOAD_BYTES,
        })).data);
        if (!buffer.length || buffer.length > MAX_UPLOAD_BYTES) invalid('Invalid reference size');
        const uploaded = await uploadMediaForVideo(buffer, kind, token, kind === 'video' ? 'reference.mp4' : 'reference.mp3');
        Object.assign(asset, uploaded, { duration: (uploaded.duration ?? 0) / 1000 });
      }
      materials.push(assetMaterial(asset));
    }
    unifiedEditInput = buildReferences(prompt, materials);
  }
  return { ...options, unifiedEditInput };
}
