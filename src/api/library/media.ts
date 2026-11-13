import { Asset, invalid, MAX_UPLOAD_BYTES } from './store.ts';

const MIME: Record<string, Asset['kind']> = {
  'image/png': 'image', 'image/jpeg': 'image', 'image/webp': 'image',
  'video/mp4': 'video', 'video/quicktime': 'video',
  'audio/mpeg': 'audio', 'audio/mp3': 'audio', 'audio/wav': 'audio', 'audio/x-wav': 'audio',
};

export function decodeUpload(value: unknown): { buffer: Buffer; mime: string; kind: Asset['kind'] } {
  if (typeof value !== 'string') invalid('A base64 data URL is required');
  const match = /^data:([^;,]+);base64,([A-Za-z0-9+/]+={0,2})$/.exec(value);
  if (!match || !MIME[match[1]]) invalid('Supported uploads: PNG, JPEG, WebP, MP4, MOV, MP3 and WAV');
  if (match[2].length > Math.ceil(MAX_UPLOAD_BYTES / 3) * 4) invalid('Upload exceeds 50 MB');
  const buffer = Buffer.from(match[2], 'base64');
  if (!buffer.length || buffer.length > MAX_UPLOAD_BYTES) invalid('Invalid upload size');
  const mime = match[1], kind = MIME[mime];
  const valid = mime === 'image/png' ? buffer.subarray(0, 8).equals(Buffer.from([137,80,78,71,13,10,26,10]))
    : mime === 'image/jpeg' ? buffer[0] === 0xff && buffer[1] === 0xd8
    : mime === 'image/webp' ? buffer.toString('ascii', 0, 4) === 'RIFF' && buffer.toString('ascii', 8, 12) === 'WEBP'
    : kind === 'video' ? buffer.toString('ascii', 4, 8) === 'ftyp'
    : mime.includes('wav') ? buffer.toString('ascii', 0, 4) === 'RIFF' && buffer.toString('ascii', 8, 12) === 'WAVE'
    : buffer.toString('ascii', 0, 3) === 'ID3' || (buffer[0] === 0xff && (buffer[1] & 0xe0) === 0xe0);
  if (!valid) invalid('File contents do not match the declared media type');
  return { buffer, mime, kind };
}

export function dimension(value: unknown): number {
  if (!Number.isInteger(value) || Number(value) < 1 || Number(value) > 16384) invalid('Invalid image dimensions');
  return Number(value);
}
