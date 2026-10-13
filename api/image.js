// 본문에 넣을 이미지 업로드 → 공개 URL 반환
// 화면에서 이미 축소·압축한 파일을 그대로 보낸다 (multipart 대신 원본 바이트)
import crypto from 'node:crypto';
import { put } from '@vercel/blob';
import { isEditor, json, missing } from './_lib.js';

export const maxDuration = 30;   // 초과하면 매달리지 않고 끊는다

export const config = { api: { bodyParser: false } };

const TYPES = { webp: 'image/webp', png: 'image/png', jpg: 'image/jpeg', gif: 'image/gif' };
const MAX_BYTES = 8 * 1024 * 1024;

export default async function handler(req, res) {
  if (req.method !== 'POST') return json(res, 405, { error: 'method' });
  const need = missing();
  if (need.length) return json(res, 503, { error: 'setup', need });
  if (!isEditor(req)) return json(res, 401, { error: 'unauthorized' });

  const ext = String(req.query.ext || 'webp').toLowerCase();
  if (!TYPES[ext]) return json(res, 400, { error: '지원하지 않는 형식입니다' });

  // 런타임이 본문을 미리 읽어둔 경우와 스트림으로 오는 경우를 모두 받는다
  let buf;
  if (Buffer.isBuffer(req.body)) {
    buf = req.body;
  } else if (req.body instanceof Uint8Array) {
    buf = Buffer.from(req.body);
  } else {
    const chunks = [];
    let size = 0;
    for await (const c of req) {
      size += c.length;
      if (size > MAX_BYTES) return json(res, 413, { error: '이미지가 너무 큽니다 (최대 8MB)' });
      chunks.push(c);
    }
    buf = Buffer.concat(chunks);
  }
  if (buf.length > MAX_BYTES) return json(res, 413, { error: '이미지가 너무 큽니다 (최대 8MB)' });
  if (!buf.length) return json(res, 400, { error: '빈 파일입니다' });

  const name = 'guide/img-' + crypto.createHash('sha1').update(buf).digest('hex').slice(0, 12) + '.' + ext;
  try {
    const blob = await put(name, buf, {
      access: 'public',
      contentType: TYPES[ext],
      addRandomSuffix: false,
      allowOverwrite: true,
    });
    return json(res, 200, { url: blob.url });
  } catch (e) {
    console.error('[guide] 이미지 업로드 실패:', e && e.message);
    return json(res, 503, { error: 'storage', need: ['BLOB_ERROR:' + (e && e.message)] });
  }
}
