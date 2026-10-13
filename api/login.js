// 편집 비밀번호 확인 → 편집 세션 발급
import { checkPassword, issueCookie, clearCookie, json, missing } from './_lib.js';

export const maxDuration = 10;   // 초과하면 매달리지 않고 끊는다

const tries = new Map();                   // 인스턴스 단위 연속 실패 제한
const MAX = 5, LOCK_MS = 10 * 60 * 1000;

export default async function handler(req, res) {
  if (req.method === 'DELETE') return json(res, 200, { ok: true }, clearCookie());
  if (req.method !== 'POST') return json(res, 405, { ok: false, error: 'method' });
  const need = missing();
  if (need.length) return json(res, 503, { ok: false, error: 'setup', need });

  const ip = (req.headers['x-forwarded-for'] || '').split(',')[0].trim() || 'unknown';
  const rec = tries.get(ip);
  if (rec && rec.n >= MAX && Date.now() - rec.at < LOCK_MS) {
    const left = Math.ceil((LOCK_MS - (Date.now() - rec.at)) / 60000);
    return json(res, 429, { ok: false, error: 'locked', minutes: left });
  }

  let body = req.body;
  if (typeof body === 'string') { try { body = JSON.parse(body); } catch { body = {}; } }

  if (!checkPassword(body?.password)) {
    const n = rec && Date.now() - rec.at < LOCK_MS ? rec.n + 1 : 1;
    tries.set(ip, { n, at: Date.now() });
    await new Promise((r) => setTimeout(r, 400));      // 무차별 대입 늦추기
    return json(res, 401, { ok: false, left: Math.max(0, MAX - n) });
  }

  tries.delete(ip);
  return json(res, 200, { ok: true }, issueCookie());
}
