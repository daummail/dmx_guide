// 가이드 API 공통 — 세션 발급·검증, 저장소 읽기·쓰기
import crypto from 'node:crypto';
import { put, list } from '@vercel/blob';

const CONTENT_PATH = 'guide/content.json';
const COOKIE = 'guide_session';
const TTL_SEC = 60 * 60 * 2;               // 편집 중 끊기지 않을 만큼만 (2시간)

// 설정이 덜 됐는지 알려준다. 열람은 설정과 무관하게 되어야 하므로 예외를 던지지 않는다.
export function hasStorage() {
  return !!(process.env.BLOB_READ_WRITE_TOKEN || process.env.BLOB_STORE_ID);
}

export function setupState() {
  return {
    password: !!process.env.GUIDE_PASSWORD,
    storage: hasStorage(),
  };
}

// 어느 Blob 저장소에 물려 있는지 확인용. 토큰은 vercel_blob_rw_<스토어ID>_<난수> 형태라
// 앞의 스토어 ID 만 떼어 보여준다 (대시보드에서도 보이는 값, 비밀이 아니다)
export function storeId() {
  if (process.env.BLOB_STORE_ID) return process.env.BLOB_STORE_ID;
  const t = process.env.BLOB_READ_WRITE_TOKEN || '';
  const m = /^vercel_blob_rw_([^_]+)_/.exec(t);
  return m ? m[1] : null;
}

export function blobEnvNames() {
  return Object.keys(process.env).filter((k) => /BLOB/i.test(k)).sort();
}

export function missing() {
  // 비밀번호만 환경변수로 확실히 판단할 수 있다.
  // 저장소는 이름만 보고 짐작하지 않고, 실제 호출 결과로 판단한다.
  return process.env.GUIDE_PASSWORD ? [] : ['GUIDE_PASSWORD'];
}

function secret() {
  // 별도 시크릿이 없으면 비밀번호에서 유도한다 (비밀번호를 바꾸면 세션도 무효)
  return process.env.GUIDE_SECRET || process.env.GUIDE_PASSWORD || null;
}

const sign = (v) =>
  crypto.createHmac('sha256', secret() || '').update(v).digest('base64url');

export function issueCookie() {
  const exp = String(Date.now() + TTL_SEC * 1000);
  const value = `${exp}.${sign(exp)}`;
  // Max-Age 를 두지 않아 브라우저를 닫으면 사라진다.
  // 화면 쪽에서도 편집에 들어갈 때마다 비밀번호를 다시 묻는다.
  return `${COOKIE}=${value}; Path=/; HttpOnly; Secure; SameSite=Lax`;
}

export const clearCookie = () =>
  `${COOKIE}=; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=0`;

export function isEditor(req) {
  if (!secret()) return false;                 // 비밀번호 미설정이면 아무도 편집자가 아니다
  const raw = req.headers.cookie || '';
  const hit = raw.split(';').map((c) => c.trim()).find((c) => c.startsWith(COOKIE + '='));
  if (!hit) return false;
  const [exp, sig] = hit.slice(COOKIE.length + 1).split('.');
  if (!exp || !sig) return false;
  if (Number(exp) < Date.now()) return false;
  const want = sign(exp);
  const a = Buffer.from(sig), b = Buffer.from(want);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

export function checkPassword(input) {
  const real = process.env.GUIDE_PASSWORD || '';
  if (!real || typeof input !== 'string') return false;
  const a = crypto.createHash('sha256').update(input).digest();
  const b = crypto.createHash('sha256').update(real).digest();
  return crypto.timingSafeEqual(a, b);
}

// ── 내용 저장소 (Vercel Blob) ──────────────────────────────
// 내용은 늘 같은 자리(CONTENT_PATH)에 덮어쓰므로 주소도 늘 같다.
// 예전에는 페이지를 열 때마다 list() 로 주소를 찾았는데, list() 는 '고급 작업' 이라
// 무료 한도(월 2,000회)를 페이지뷰 수만큼 깎아먹었다. 이제 주소를 직접 만들어 쓰고,
// 혹시 형식이 다르면 그때 한 번만 list() 로 찾아 기억해 둔다.
const CONTENT_TTL = 60;          // 내용 파일을 CDN 이 품고 있는 시간(초)
let knownUrl = null;             // 함수가 살아있는 동안 재사용하는 주소
let knownFor = null;             // 어느 저장소에 대한 주소인지 (설정이 바뀌면 다시 찾는다)

function publicUrl() {
  const id = storeId();
  return id ? `https://${id}.public.blob.vercel-storage.com/${CONTENT_PATH}` : null;
}

// fresh 면 CDN 을 거치지 않도록 주소를 매번 다르게 해서 확실히 최신을 받는다
async function getDoc(url, fresh) {
  const res = await fetch(fresh ? `${url}?t=${Date.now()}` : url,
                          fresh ? { cache: 'no-store' } : undefined);
  if (res.status === 404) return { missing: true };
  if (!res.ok) return { missing: true };
  return { doc: await res.json() };
}

// { doc, storage } 를 돌려준다. storage 는 'ok' | 'unconfigured' | 'error'
// opts.fresh 를 주면 캐시를 건너뛴다 (편집자·게시 직전 확인용)
export async function readContent(opts) {
  const fresh = !!(opts && opts.fresh);
  if (!hasStorage()) return { doc: null, storage: 'unconfigured' };

  try {
    const id = storeId();
    if (knownFor !== id) { knownUrl = null; knownFor = id; }

    // 1) 아는 주소로 바로 읽는다 — 저장소 '고급 작업' 을 쓰지 않는다
    const direct = knownUrl || publicUrl();
    if (direct) {
      const r = await getDoc(direct, fresh);
      if (!r.missing) { knownUrl = direct; return { doc: r.doc, storage: 'ok' }; }
    }

    // 2) 주소 형식이 다르거나 아직 아무것도 게시하지 않은 경우에만 목록에서 찾는다
    const { blobs } = await list({ prefix: CONTENT_PATH, limit: 1 });
    if (!blobs.length) return { doc: null, storage: 'ok' };
    const r2 = await getDoc(blobs[0].url, fresh);
    if (r2.missing) return { doc: null, storage: 'ok' };
    knownUrl = blobs[0].url;
    return { doc: r2.doc, storage: 'ok' };
  } catch (e) {
    console.error('[guide] 내용 읽기 실패:', e && e.message);
    return { doc: null, storage: 'error', message: e && e.message };
  }
}

export async function writeContent(doc) {
  const res = await put(CONTENT_PATH, JSON.stringify(doc), {
    access: 'public',
    contentType: 'application/json',
    addRandomSuffix: false,
    allowOverwrite: true,
    cacheControlMaxAge: CONTENT_TTL,
  });
  if (res && res.url) { knownUrl = res.url; knownFor = storeId(); }
  return doc;
}

export function json(res, status, body, cookie) {
  if (cookie) res.setHeader('Set-Cookie', cookie);
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Cache-Control', 'no-store');
  res.status(status).send(JSON.stringify(body));
}
