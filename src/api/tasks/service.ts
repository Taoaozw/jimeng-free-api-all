import { promises as fs } from 'node:fs';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { request, tokenSplit } from '@/api/controllers/core.ts';
import { submitVideo, fetchHighQualityVideoUrl } from '@/api/controllers/videos.ts';
import { libraryStore, LibraryError, invalid } from '@/api/library/store.ts';
import { parseInput, generationOptions } from './input.ts';
import { destination, deliver } from './callback.ts';

type Task = {
  id: string; historyId: string; credential: string; model: string;
  deleted?: boolean; owner?: string; scope?: string; publicId?: string; publicModel?: string; itemId?: string;
  status: 'queued' | 'running' | 'succeeded' | 'failed' | 'cancelled'; created_at: number; updated_at: number;
  taskType?: string; resolution: string; ratio: string; duration: number; seed?: number; framespersecond: number; draft: boolean;
  content?: { video_url: string }; error?: { code: string; message: string };
  callback?: { url: string; pending: { body: any; attempts: number; next: number }[] };
};
const missing = () => { throw new LibraryError(404, 'task.not_found', 'Task not found'); };
const fingerprint = (token: string) => createHash('sha256').update(token).digest('hex');
const now = () => Math.floor(Date.now() / 1000);
const active = (task: Task) => task.status === 'queued' || task.status === 'running';
const locks = new Map<string, Promise<unknown>>();
async function locked<T>(id: string, action: () => Promise<T>): Promise<T> {
  const previous = locks.get(id) ?? Promise.resolve();
  const current = previous.catch(() => {}).then(action);
  locks.set(id, current);
  try { return await current; } finally { if (locks.get(id) === current) locks.delete(id); }
}
function environment(headers: Record<string, string>) {
  const tokens = tokenSplit(headers.authorization || '');
  if (tokens.length !== 1 || !tokens[0]) throw new LibraryError(400, 'task.invalid_account', 'Tasks require one upstream account');
  return { token: tokens[0], directory: path.join(libraryStore().directory, 'tasks') };
}
function filename(directory: string, id: string) {
  if (!/^dmt_[a-f0-9-]{36}$/.test(id)) return missing();
  return path.join(directory, `${id}.json`);
}
async function read(directory: string, token: string, id: string, headers?: Record<string, string>, reconcile = false): Promise<Task> {
  let task: Task;
  try { task = JSON.parse(await fs.readFile(filename(directory, id), 'utf8')); }
  catch (error) { if (error.code === 'ENOENT') return missing(); throw error; }
  if ((!reconcile && task.deleted) || task.credential !== fingerprint(token)) return missing();
  if (headers && task.owner && (task.owner !== headers['x-flowxy-library-owner'] || task.scope !== headers['x-flowxy-task-scope'])) return missing();
  return task;
}
async function save(directory: string, task: Task) {
  const temporary = path.join(directory, `.${randomUUID()}.tmp`);
  try {
    await fs.writeFile(temporary, JSON.stringify(task), { mode: 0o600 });
    await fs.rename(temporary, filename(directory, task.id));
  } finally { await fs.rm(temporary, { force: true }); }
}
function view(task: Task, publicId = false) {
  return {
    id: publicId ? task.publicId ?? task.id : task.id, model: task.publicModel ?? task.model,
    status: task.status, created_at: task.created_at, updated_at: task.updated_at,
    resolution: task.resolution, ratio: task.ratio, duration: task.duration, seed: task.seed,
    omni_reference_task_type: task.taskType ?? 'auto', framespersecond: task.framespersecond, draft: task.draft ?? false, service_tier: 'default',
    ...(task.content ? { content: task.content } : {}), ...(task.error ? { error: task.error } : {}),
  };
}
function notify(task: Task) {
  if (task.callback) task.callback.pending.push({ body: view(task, true), attempts: 0, next: now() });
}

export async function create(headers: Record<string, string>, body: any) {
  const input = parseInput(body);
  const { token, directory } = environment(headers);
  if (body.callback_url !== undefined) await destination(body.callback_url);
  const id = headers['x-flowxy-task-upstream-id'] ?? `dmt_${randomUUID()}`;
  filename(directory, id);
  return locked(id, async () => {
    await fs.mkdir(directory, { recursive: true, mode: 0o700 });
    try { await read(directory, token, id, headers); return { id }; }
    catch (error) {
      if (error.code !== 'task.not_found') throw error;
      if (await fs.stat(filename(directory, id)).then(() => true, e => { if (e.code === 'ENOENT') return false; throw e; })) return missing();
    }
    let options: any;
    if (input.draftTaskId) {
      const source = await read(directory, token, input.draftTaskId, headers);
      if (!source.draft || source.status !== 'succeeded' || !source.itemId || source.model !== input.model) invalid('draft_task must reference a completed draft from the same account and model');
      if (now() - source.created_at >= 14 * 86400) invalid('Draft expired after 14 days');
      input.duration = source.duration; input.ratio = source.ratio; input.seed = source.seed;
      const historyResult = await request('post', '/mweb/v1/get_history_by_ids', token, { data: { history_ids: [source.historyId] } });
      const history = historyResult[source.historyId] ?? historyResult.history_list?.find((h: any) => String(h.history_record_id ?? h.id) === source.historyId);
      const draftContent = history?.draft_content ?? history?.task?.draft_content;
      if (typeof draftContent !== 'string') throw new LibraryError(502, 'task.upstream_unavailable', 'Native draft content is unavailable');
      options = { ...input, draftSource: { historyId: source.historyId, itemId: source.itemId, draftContent } };
    } else options = await generationOptions(input, body, headers, token);
    // Acceptance must precede a successful response, including HTTP 200 business errors.
    const historyId = await submitVideo(input.model, input.prompt, options, token);
    const timestamp = now();
    const task: Task = {
      id, historyId, credential: fingerprint(token), model: input.model,
      owner: headers['x-flowxy-library-owner'], scope: headers['x-flowxy-task-scope'],
      publicId: headers['x-flowxy-task-public-id'], publicModel: headers['x-flowxy-task-model'],
      status: 'queued', created_at: timestamp, updated_at: timestamp,
      taskType: input.taskType, resolution: input.resolution, ratio: input.ratio, duration: input.duration, seed: input.seed, framespersecond: 24, draft: input.draft,
      ...(body.callback_url ? { callback: { url: body.callback_url, pending: [] } } : {}),
    };
    notify(task);
    await save(directory, task);
    return { id: task.id };
  });
}

async function refresh(task: Task, token: string) {
  if (!active(task)) return;
  const result = await request('post', '/mweb/v1/get_history_by_ids', token, { data: { history_ids: [task.historyId] } });
  const history = result[task.historyId] ?? result.history_list?.find((h: any) => String(h.history_record_id ?? h.id) === task.historyId);
  if (!history) throw new LibraryError(502, 'task.upstream_unavailable', 'Upstream task history is temporarily unavailable');
  const before = task.status;
  if (history.status === 20) {
    const queue = await request('post', '/mweb/v1/get_history_queue_info', token, { data: { history_ids: [task.historyId] } });
    const status = queue[task.historyId]?.queue_info?.queue_status;
    // An absent queue record is not proof that cancellation is safe.
    task.status = status === 0 || status === 1 ? 'queued' : 'running';
  } else if (history.status === 30) {
    task.status = 'failed';
    task.error = { code: String(history.fail_code ?? 'generation_failed'), message: history.fail_code === 2038 ? 'Content filtered by Dreamina' : `Dreamina generation failed (${history.fail_code ?? 'unknown'})` };
  } else {
    const item = history.item_list?.[0];
    const itemId = item?.item_id ?? item?.id ?? item?.local_item_id ?? item?.common_attr?.id;
    let url: string | null = null;
    if (itemId) {
      try { url = await fetchHighQualityVideoUrl(String(itemId), token); }
      catch { /* Preview URLs remain usable when the download endpoint is temporarily unavailable. */ }
    }
    url ??= item?.video?.transcoded_video?.origin?.video_url ?? item?.video?.play_url ?? item?.video?.download_url ?? item?.video?.url;
    if (!url) throw new LibraryError(502, 'task.upstream_unavailable', 'Upstream task has no result yet');
    const video = item?.video;
    const duration = Number(video?.duration_ms) / 1000 || Number(video?.duration);
    if (Number.isFinite(duration) && duration > 0) task.duration = Math.ceil(duration);
    // Adaptive requests must settle against the generated duration, never the -1 sentinel.
    if (task.duration <= 0) throw new LibraryError(502, 'task.upstream_unavailable', 'Upstream result duration is unavailable');
    const origin = video?.transcoded_video?.origin ?? video;
    const width = Number(origin?.width), height = Number(origin?.height);
    if (width > 0 && height > 0) {
      const gcd = (a: number, b: number): number => b ? gcd(b, a % b) : a;
      const divisor = gcd(width, height);
      const ratio = width / height;
      const standard = ['16:9', '9:16', '1:1', '4:3', '3:4', '21:9'].find(value => {
        const [w, h] = value.split(':').map(Number);
        return Math.abs(ratio / (w / h) - 1) < 0.01;
      });
      // Encoders round dimensions (for example 854x480), but downstream generation expects nominal ratios.
      task.ratio = standard ?? `${width / divisor}:${height / divisor}`;
    }
    task.status = 'succeeded'; task.itemId = itemId ? String(itemId) : undefined;
    task.content = { video_url: url };
  }
  if (before !== task.status) { task.updated_at = now(); notify(task); }
}

export async function get(headers: Record<string, string>, id: string) {
  return locked(id, async () => {
    const { token, directory } = environment(headers);
    const task = await read(directory, token, id, undefined, headers['x-flowxy-task-reconcile'] === 'true');
    await refresh(task, token);
    await save(directory, task);
    return view(task);
  });
}

export async function remove(headers: Record<string, string>, id: string) {
  return locked(id, async () => {
    const { token, directory } = environment(headers);
    const task = await read(directory, token, id);
    if (!active(task)) {
      // Keep the terminal state for the existing settlement worker after public deletion.
      task.deleted = true; await save(directory, task);
      return {};
    }
    await refresh(task, token);
    await save(directory, task);
    if (task.status !== 'queued') throw new LibraryError(409, 'task.not_cancellable', 'Only queued tasks can be cancelled; refresh the task before deleting a completed record');
    await request('post', '/mweb/v1/aigc_draft/cancel_generate', token, { data: { history_id: task.historyId } });
    task.status = 'cancelled'; task.updated_at = now(); notify(task);
    await save(directory, task);
    return {};
  });
}

export async function list(headers: Record<string, string>, query: Record<string, any>) {
  const { token, directory } = environment(headers);
  if (!headers['x-flowxy-library-owner'] || !headers['x-flowxy-task-scope']) invalid('Task listing requires a trusted owner and account scope');
  const page = Number(query.page_num ?? 1), size = Number(query.page_size ?? 20);
  if (![page, size].every(n => Number.isInteger(n) && n >= 1 && n <= 500)) invalid('page_num and page_size must be integers between 1 and 500');
  const allowed = ['page_num', 'page_size', 'filter.model', 'filter.status', 'filter.service_tier', 'filter.task_ids'];
  if (Object.keys(query).some(k => !allowed.includes(k))) invalid('Unsupported list filter');
  if (query['filter.status'] && !['queued', 'running', 'succeeded', 'failed', 'cancelled', 'expired'].includes(query['filter.status'])) invalid('Invalid task status');
  const ids = query['filter.task_ids'] === undefined ? undefined : [query['filter.task_ids']].flat();
  const items = [];
  for (const file of await fs.readdir(directory).catch((e) => { if (e.code === 'ENOENT') return []; throw e; })) {
    if (!file.startsWith('dmt_') || !file.endsWith('.json')) continue;
    let task: Task;
    try { task = await read(directory, token, file.slice(0, -5), headers); }
    catch (e) { if (e.code === 'task.not_found') continue; throw e; }
    if (!task.publicId || !task.owner || task.owner !== headers['x-flowxy-library-owner'] || task.scope !== headers['x-flowxy-task-scope']) continue;
    if (now() - task.created_at >= (task.draft ? 14 : 7) * 86400) continue;
    const item = view(task, true);
    if (query['filter.model'] && query['filter.model'] !== item.model) continue;
    if (query['filter.status'] && query['filter.status'] !== item.status) continue;
    if (query['filter.service_tier'] && query['filter.service_tier'] !== 'default') continue;
    if (ids && !ids.includes(item.id)) continue;
    items.push(item);
  }
  items.sort((a, b) => b.created_at - a.created_at || a.id.localeCompare(b.id));
  return { total: items.length, items: items.slice((page - 1) * size, page * size) };
}

export async function flushCallbacks() {
  const directory = path.join(libraryStore().directory, 'tasks');
  for (const file of await fs.readdir(directory).catch(() => [])) {
    if (!file.startsWith('dmt_') || !file.endsWith('.json')) continue;
    await locked(file.slice(0, -5), async () => {
      let task: Task;
      try { task = JSON.parse(await fs.readFile(path.join(directory, file), 'utf8')); } catch { return; }
      const pending = task.callback?.pending[0];
      if (!pending || pending.next > now()) return;
      let done = false;
      try { await deliver(task.callback.url, pending.body); done = true; } catch { /* Delivery failures cannot change generation or billing state. */ }
      if (done || ++pending.attempts >= 3) task.callback.pending.shift();
      else pending.next = now() + 10 * pending.attempts;
      await save(directory, task);
    });
  }
}

export function startCallbacks() {
  let busy = false;
  const timer = setInterval(async () => {
    if (busy) return;
    busy = true;
    try { await flushCallbacks(); } catch { /* Private account storage may not be enabled on this deployment. */ }
    finally { busy = false; }
  }, 1000);
  timer.unref();
}
