/**
 * Shorts Deck — Cloudflare Worker
 *
 * 하는 일 셋:
 *   1. public/ 정적 자산(앱) 서빙            → 앱과 API가 같은 출처 = CORS 문제 자체가 없음
 *   2. GET  /api/cards   Notion DB → 카드 배열 (KV 캐시)
 *   3. POST /api/grade   채점 결과를 Notion 속성 + KV 양쪽에 기록
 *
 * ⚠ 왜 Worker가 반드시 필요한가 — api.notion.com은 Access-Control-Allow-Origin을
 *   보내지 않는다(2026-09-03 실측). 크롬 확장은 host_permissions로 CORS를 면제받아
 *   직접 호출하지만, 브라우저 페이지는 못 한다. 게다가 integration 토큰을 프런트에
 *   두면 그대로 털린다. 그래서 토큰은 여기(Worker secret)에만 산다.
 */

const NOTION = 'https://api.notion.com/v1';
const NOTION_VERSION = '2022-06-28'; // 크롬 확장(youtube_dual_subtitle)과 동일 버전 — 검증된 조합
const CACHE_KEY = 'cards:v1';
const CACHE_TTL = 3600; // 초. Notion은 평균 3 req/s라 매 요청 재조회는 불가능.

/* ── Notion 호출 ─────────────────────────────────────────── */

const headers = (token) => ({
  'Authorization': `Bearer ${token}`,
  'Notion-Version': NOTION_VERSION,
  'Content-Type': 'application/json',
});

// Notion 한도(평균 3 req/s)를 넘지 않게 호출 간격을 벌린다.
const gap = (ms = 340) => new Promise((r) => setTimeout(r, ms));

async function notion(token, path, init = {}) {
  const res = await fetch(NOTION + path, { ...init, headers: headers(token) });
  if (res.status === 429) {
    await gap(1500);
    return notion(token, path, init);
  }
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`Notion ${res.status} ${path}: ${body.slice(0, 200)}`);
  }
  return res.json();
}

/**
 * DB 스키마에서 쓸 속성을 "이름이 아니라 타입+이름힌트"로 찾는다.
 * 사용자가 Notion에서 컬럼 이름을 바꿔도 안 깨지게 — 크롬 확장이 쓰는 것과 같은 전략.
 */
async function discoverSchema(token, dbId) {
  const db = await notion(token, `/databases/${dbId}`);
  const props = db.properties || {};
  const find = (pred) => Object.keys(props).find((n) => pred(n, props[n]));

  const status = find((n, p) => p.type === 'status')
              || find((n, p) => p.type === 'select' && /상태|status/i.test(n));
  const statusDef = status ? props[status] : null;

  return {
    dbTitle: (db.title || []).map((t) => t.plain_text).join(''),
    title: find((n, p) => p.type === 'title'),
    url: find((n, p) => p.type === 'url'),
    // "복습 횟수" 같은 카운터. 이름 힌트가 없으면 첫 번째 number로 퇴화.
    count: find((n, p) => p.type === 'number' && /횟수|count|review/i.test(n))
        || find((n, p) => p.type === 'number'),
    status,
    statusType: statusDef?.type || null,
    statusOptions: statusDef
      ? (statusDef.status?.options || statusDef.select?.options || []).map((o) => o.name)
      : [],
  };
}

/* ── 블록 → 텍스트 ───────────────────────────────────────── */

const rt = (arr) => (arr || []).map((t) => t.plain_text || '').join('');

function blockText(b) {
  const t = b.type;
  const v = b[t];
  if (!v) return null;
  if (t === 'table_row') return (v.cells || []).map(rt).filter(Boolean).join(' — ');
  if (t === 'code') return rt(v.rich_text);
  if (Array.isArray(v.rich_text)) return rt(v.rich_text);
  return null;
}

async function pageLines(token, pageId) {
  const lines = [];
  let cursor;
  do {
    const q = cursor ? `?start_cursor=${cursor}&page_size=100` : '?page_size=100';
    const data = await notion(token, `/blocks/${pageId}/children${q}`);
    for (const b of data.results || []) {
      const txt = blockText(b);
      if (txt && txt.trim()) lines.push(txt.trim());
      // 표는 자식(table_row)에 내용이 있다 — 한 단계만 더 들어간다.
      if (b.has_children && b.type === 'table') {
        await gap();
        const kids = await notion(token, `/blocks/${b.id}/children?page_size=100`);
        for (const k of kids.results || []) {
          const kt = blockText(k);
          if (kt && kt.trim()) lines.push(kt.trim());
        }
      }
    }
    cursor = data.has_more ? data.next_cursor : null;
    if (cursor) await gap();
  } while (cursor);
  return lines;
}

/* ── 카드 조립 ───────────────────────────────────────────── */

const HANGUL = /[가-힣]/;
const LATIN = /[A-Za-z]{2,}/;

/**
 * 본문 줄들을 앞면/힌트/해설로 가른다.
 * 실측(21/21)한 구조: [자막 문맥] → 「영어 + 한국어 뜻」 한 줄 → 해설 → 표.
 * 그 "한 줄"이 1단계 힌트가 된다 — 탭 1회에 뜻만, 2회에 전체.
 */
function splitBody(lines) {
  let body = lines.filter((l) => l && l !== '\t');
  let context = null;

  if (body[0]?.startsWith('질문:')) body = body.slice(1);   // AI에 던진 질문 — 카드엔 불필요
  else if (body[0] && !HANGUL.test(body[0])) { context = body[0]; body = body.slice(1); }

  // 1단계 힌트는 "짧은 한 줄"이어야 한다. 영·한이 섞인 첫 줄을 잡되, 긴 해설 문단이
  // 먼저 걸리는 카드가 있어 짧은 줄(120자 이하)을 우선 고른다.
  const cand = [];
  for (let i = 0; i < Math.min(4, body.length); i++) {
    if (HANGUL.test(body[i]) && LATIN.test(body[i])) cand.push(i);
  }
  const hi = cand.find((i) => body[i].length <= 120) ?? cand[0] ?? null;
  const hint = hi === null ? null : body[hi];
  return { context, hint, detail: hi === null ? body : body.slice(hi + 1) };
}

// pageId는 재저장 때마다 바뀐다(크롬 확장이 "새 페이지 + 옛것 archive"로 덮어쓰기 때문).
// 그래서 학습 이력의 키는 pageId가 아니라 정규화된 제목이어야 한다.
export function cardKey(front) {
  return String(front || '').toLowerCase().replace(/[^a-z0-9가-힣]+/g, ' ').trim();
}

async function fetchCards(token, dbId) {
  const schema = await discoverSchema(token, dbId);
  const rows = [];
  let cursor;
  do {
    await gap();
    const data = await notion(token, `/databases/${dbId}/query`, {
      method: 'POST',
      body: JSON.stringify({ page_size: 100, ...(cursor ? { start_cursor: cursor } : {}) }),
    });
    rows.push(...(data.results || []));
    cursor = data.has_more ? data.next_cursor : null;
  } while (cursor);

  const cards = [];
  for (const row of rows) {
    const p = row.properties || {};
    const front = rt(p[schema.title]?.title);
    if (!front) continue;
    await gap();
    let lines = [];
    try { lines = await pageLines(token, row.id); } catch (e) { /* 본문 없는 행은 앞면만 */ }
    const { context, hint, detail } = splitBody(lines);
    cards.push({
      id: row.id,
      key: cardKey(front),
      front,
      context,
      hint,
      detail,
      url: schema.url ? (p[schema.url]?.url || null) : null,
      count: schema.count ? (p[schema.count]?.number ?? 0) : 0,
    });
  }
  return { schema, cards, builtAt: new Date().toISOString() };
}

/* ── 채점 기록 ───────────────────────────────────────────── */

const GRADE_HINT = { know: /이해|알|know|완료/i, fuzzy: /애매|보통|헷/i, dunno: /모름|모르|다시|어려/i };

async function writeGrade(env, token, dbId, { pageId, key, grade }) {
  // 1) KV — 진실의 원본. pageId가 churn해도 key(제목)로 살아남는다.
  const prev = JSON.parse((await env.KV.get('grades')) || '{}');
  const rec = prev[key] || { n: 0 };
  prev[key] = { grade, n: rec.n + 1, at: Date.now() };
  await env.KV.put('grades', JSON.stringify(prev));

  // 2) Notion — best effort. 실패해도 채점 자체는 이미 KV에 남았으므로 안전 퇴화.
  let notionOk = false;
  try {
    const schema = await discoverSchema(token, dbId);
    const props = {};
    if (schema.count) props[schema.count] = { number: prev[key].n };
    if (schema.status) {
      const opt = schema.statusOptions.find((o) => GRADE_HINT[grade]?.test(o));
      // status와 select는 페이로드 모양이 다르다 — 타입에 맞춰 보낸다.
      if (opt) props[schema.status] = schema.statusType === 'select'
        ? { select: { name: opt } }
        : { status: { name: opt } };
    }
    if (Object.keys(props).length) {
      await notion(token, `/pages/${pageId}`, { method: 'PATCH', body: JSON.stringify({ properties: props }) });
      notionOk = true;
    }
  } catch (e) { /* 삼킨다 — 아래 응답에 notionOk:false로 정직하게 알린다 */ }

  return { ok: true, n: prev[key].n, notionOk };
}

/* ── 라우팅 ──────────────────────────────────────────────── */

const json = (o, status = 200) =>
  new Response(JSON.stringify(o), { status, headers: { 'Content-Type': 'application/json; charset=utf-8' } });

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const { NOTION_TOKEN: token, NOTION_DB_ID: dbId } = env;

    if (url.pathname === '/api/cards') {
      if (!token || !dbId) return json({ error: 'NOTION_TOKEN / NOTION_DB_ID 미설정' }, 500);
      const refresh = url.searchParams.get('refresh') === '1';
      if (!refresh) {
        const hit = await env.KV.get(CACHE_KEY);
        if (hit) return new Response(hit, { headers: { 'Content-Type': 'application/json; charset=utf-8', 'X-Cache': 'hit' } });
      }
      try {
        const built = await fetchCards(token, dbId);
        const grades = JSON.parse((await env.KV.get('grades')) || '{}');
        const payload = JSON.stringify({ ...built, grades });
        await env.KV.put(CACHE_KEY, payload, { expirationTtl: CACHE_TTL });
        return new Response(payload, { headers: { 'Content-Type': 'application/json; charset=utf-8', 'X-Cache': 'miss' } });
      } catch (e) {
        return json({ error: String(e.message || e) }, 502);
      }
    }

    if (url.pathname === '/api/grade' && request.method === 'POST') {
      if (!token || !dbId) return json({ error: 'NOTION_TOKEN / NOTION_DB_ID 미설정' }, 500);
      try {
        const body = await request.json();
        if (!body.key || !body.grade) return json({ error: 'key·grade 필요' }, 400);
        return json(await writeGrade(env, token, dbId, body));
      } catch (e) {
        return json({ error: String(e.message || e) }, 500);
      }
    }

    return env.ASSETS.fetch(request);
  },
};
