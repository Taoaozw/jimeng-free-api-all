import { promises as fs } from 'node:fs';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { request, tokenSplit } from '@/api/controllers/core.ts';
import { submitVideo, fetchHighQualityVideoUrl } from '@/api/controllers/videos.ts';
import { libraryStore, LibraryError } from '@/api/library/store.ts';
import { parseInput, generationOptions } from './input.ts';

type Task = {
  id: string; historyId: string; credential: string; model: string;
  status: 'running' | 'succeeded' | 'failed'; created_at: number; updated_at: number;
  resolution: string; ratio: string; duration: number; seed?: number; framespersecond: number;
  content?: { video_url: string }; error?: { code: string; message: string };
};
const missing = () => { throw new LibraryError(404, 'task.not_found', 'Task not found'); };
const fingerprint = (token: string) => createHash('sha256').update(token).digest('hex');
const now = () => Math.floor(Date.now() / 1000);
function environment(headers: Record<string, string>) {
  const tokens = tokenSplit(headers.authorization || '');
  if (tokens.length !== 1 || !tokens[0]) throw new LibraryError(400, 'task.invalid_account', 'Tasks require one upstream account');
  return { token: tokens[0], directory: path.join(libraryStore().directory, 'tasks') };
}
function filename(directory: string, id: string) {
  if (!/^dmt_[a-f0-9-]{36}$/.test(id)) return missing();
  return path.join(directory, `${id}.json`);
}
async function read(directory: string, token: string, id: string): Promise<Task> {
  let task: Task;
  try { task = JSON.parse(await fs.readFile(filename(directory, id), 'utf8')); }
  catch (error) { if (error.code === 'ENOENT') return missing(); throw error; }
  if (task.credential !== fingerprint(token)) return missing();
  return task;
}
async function save(directory: string, task: Task) {
  const temporary = path.join(directory, `.${randomUUID()}.tmp`);
  try {
    await fs.writeFile(temporary, JSON.stringify(task), { mode: 0o600 });
    await fs.rename(temporary, filename(directory, task.id));
  } finally { await fs.rm(temporary, { force: true }); }
}
function view(task: Task) {
  const { historyId, credential, ...response } = task;
  return response;
}

export async function create(headers: Record<string, string>, body: any) {
  const input = parseInput(body);
  const { token, directory } = environment(headers);
  await fs.mkdir(directory, { recursive: true, mode: 0o700 });
  const options = await generationOptions(input, body, headers, token);
  // Await native acceptance so business errors cannot become successful task submissions.
  const historyId = await submitVideo(input.model, input.prompt, options, token);
  const timestamp = now();
  const task: Task = {
    id: `dmt_${randomUUID()}`, historyId, credential: fingerprint(token), model: input.model,
    status: 'running', created_at: timestamp, updated_at: timestamp,
    resolution: input.resolution, ratio: input.ratio, duration: input.duration, seed: input.seed, framespersecond: 24,
  };
  await save(directory, task);
  return { id: task.id };
}

export async function get(headers: Record<string, string>, id: string) {
  const { token, directory } = environment(headers);
  const task = await read(directory, token, id);
  if (task.status !== 'running') return view(task);
  const result = await request('post', '/mweb/v1/get_history_by_ids', token, { data: { history_ids: [task.historyId] } });
  const history = result[task.historyId] ?? result.history_list?.find((h: any) => String(h.history_record_id ?? h.id) === task.historyId);
  if (!history) throw new LibraryError(502, 'task.upstream_unavailable', 'Upstream task history is temporarily unavailable');
  if (history.status === 20) return view(task);
  if (history.status === 30) {
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
    task.status = 'succeeded';
    task.content = { video_url: url };
  }
  task.updated_at = now();
  await save(directory, task);
  // Dreamina reports credits, not Ark completion tokens; omit usage rather than invent it.
  return view(task);
}

export async function remove(headers: Record<string, string>, id: string) {
  const { token, directory } = environment(headers);
  const task = await read(directory, token, id);
  if (task.status === 'running') throw new LibraryError(409, 'task.cancellation_unsupported', 'Dreamina cancellation is not supported; the upstream task is still running');
  await fs.unlink(filename(directory, id));
  return {};
}
