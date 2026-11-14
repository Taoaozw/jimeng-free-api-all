import { request } from '@/api/controllers/core.ts';
import { LibraryError } from '@/api/library/store.ts';

export async function videoOutput(item: any, watermark: boolean, token: string): Promise<string> {
  const itemId = item?.item_id ?? item?.id ?? item?.local_item_id ?? item?.common_attr?.id;
  const vid = item?.video?.video_id;
  let videos: any[] = [];
  if (watermark && itemId) {
    const result = await request('post', '/mweb/v1/get_local_item_list', token, {
      data: { item_id_list: [String(itemId)], pack_item_opt: { scene: 1, need_data_integrity: true }, is_for_video_download: true },
    });
    const video = result?.item_list?.[0]?.video;
    videos = [video?.origin_video, ...Object.values(video?.transcoded_video ?? {})];
  } else if (!watermark && vid) {
    const result = await request('post', '/mweb/v1/get_video_by_vid', token, { data: { vids: [vid] } });
    const video = result?.vid2video?.[vid];
    videos = [video?.origin_video, ...Object.values(video?.transcoded_video ?? {})];
  }
  // A preview fallback can silently violate the requested output variant.
  const selected = videos.find(video => typeof video?.logo_type === 'string' &&
    (watermark ? video.logo_type === 'display_watermark_aigc' : video.logo_type === '') &&
    typeof video.video_url === 'string' && /^https:\/\//.test(video.video_url));
  if (!selected) throw new LibraryError(502, 'task.output_unavailable', `Dreamina has no ${watermark ? 'AI-watermarked' : 'watermark-free'} video available`);
  return selected.video_url;
}
