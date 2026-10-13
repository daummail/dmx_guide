// 가이드 내용 조회 · 저장
import { isEditor, readContent, writeContent, json, missing, storeId, blobEnvNames } from './_lib.js';

export const maxDuration = 30;   // 초과하면 매달리지 않고 끊는다

export default async function handler(req, res) {
  const canEdit = isEditor(req);

  const need = missing();

  if (req.method === 'GET') {
    // 설정이 덜 됐어도 200 으로 답한다. 방문자는 문서에 담긴 내용을 그대로 보면 된다.
    // 편집자에게는 항상 최신을 준다. 열람자는 캐시(최대 1분)를 타도 된다.
    const { doc, storage, message } = await readContent({ fresh: canEdit });
    const gaps = need.slice();
    if (storage === 'unconfigured') gaps.push('BLOB_READ_WRITE_TOKEN');
    else if (storage === 'error') gaps.push('BLOB_ERROR:' + (message || '알 수 없음'));
    const base = doc || { version: 0, regions: null };
    return json(res, 200, {
      ...base, canEdit,
      setup: gaps.length ? gaps : undefined,
      // 문제 파악용. 어느 저장소에 물려 있는지, 관련 환경변수가 무엇이 있는지.
      diag: gaps.length ? { store: storeId(), env: blobEnvNames() } : undefined,
    });
  }

  if (req.method !== 'POST') return json(res, 405, { error: 'method' });
  if (need.length) return json(res, 503, { error: 'setup', need });
  if (!canEdit) return json(res, 401, { error: 'unauthorized' });

  let body = req.body;
  if (typeof body === 'string') { try { body = JSON.parse(body); } catch { body = null; } }
  if (!body || typeof body.regions !== 'object' || !body.regions)
    return json(res, 400, { error: 'regions 가 없습니다' });

  const read = await readContent({ fresh: true });   // 충돌 판정은 반드시 최신 기준으로
  if (read.storage !== 'ok')
    return json(res, 503, {
      error: 'storage',
      need: [read.storage === 'unconfigured' ? 'BLOB_READ_WRITE_TOKEN'
                                             : 'BLOB_ERROR:' + (read.message || '알 수 없음')],
      diag: { store: storeId(), env: blobEnvNames() },
    });
  const cur = read.doc;
  const curVer = cur?.version || 0;
  if (Number(body.baseVersion) !== curVer)
    return json(res, 409, { error: 'conflict', version: curVer, updatedAt: cur?.updatedAt });

  const doc = {
    version: curVer + 1,
    updatedAt: new Date().toISOString(),
    regions: sanitize(body.regions),
  };
  try {
    await writeContent(doc);
  } catch (e) {
    console.error('[guide] 저장 실패:', e && e.message);
    return json(res, 500, {
      error: '저장소에 쓰지 못했습니다: ' + (e && e.message),
      diag: { store: storeId(), env: blobEnvNames() },
    });
  }
  return json(res, 200, { version: doc.version, updatedAt: doc.updatedAt });
}

// 저장되는 값은 화면에 그대로 들어가는 HTML 조각이라, 실행 가능한 것은 걷어낸다
function sanitize(regions) {
  const out = {};
  for (const [k, v] of Object.entries(regions)) {
    if (typeof v !== 'string') continue;
    out[k] = v
      .replace(/<\s*script\b[\s\S]*?<\s*\/\s*script\s*>/gi, '')
      .replace(/<\s*(iframe|object|embed|form)\b[\s\S]*?<\s*\/\s*\1\s*>/gi, '')
      .replace(/\son[a-z]+\s*=\s*"[^"]*"/gi, '')
      .replace(/\son[a-z]+\s*=\s*'[^']*'/gi, '')
      .replace(/javascript:/gi, '');
  }
  return out;
}
