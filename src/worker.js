/**
 * Shorts Deck — Cloudflare Worker
 *
 * 하는 일 넷:
 *   1. public/ 정적 자산(앱) 서빙          → 앱과 API가 같은 출처 = CORS 문제 자체가 없음
 *   2. GET  /api/cards   KV에 완성돼 있는 카드 묶음을 그대로 반환 (Notion을 여기서 부르지 않는다)
 *   3. GET  /api/sync    Notion → 카드 변환을 "예산만큼만" 진행하고 커서를 남김
 *   4. POST /api/grade   채점을 KV(원본) + Notion 속성(미러) 양쪽에 기록
 *
 * ⚠ 왜 Worker가 반드시 필요한가 — api.notion.com은 Access-Control-Allow-Origin을
 *   보내지 않는다(2026-09-03 실측). 크롬 확장은 host_permissions로 CORS를 면제받아
 *   직접 호출하지만, 브라우저 페이지는 못 한다. 게다가 토큰을 프런트에 두면 털린다.
 *
 * ⚠ 왜 한 번에 다 못 가져오는가 — Cloudflare 무료 요금제는 **요청당 서브요청 50회**가
 *   상한이다(공식 문서 확인). 카드 하나를 만들려면 본문 블록 조회가 1~2회 필요해서
 *   21장만 해도 약 60회다. 카드는 계속 쌓이므로 "표 조회를 빼서 아끼는" 식의 절약은
 *   시간을 벌 뿐 언젠가 반드시 다시 터진다. 그래서 진행 커서를 KV에 두고 여러 번에
 *   나눠 처리하며, cron이 알아서 이어 돌린다.
 */

const NOTION = 'https://api.notion.com/v1';
const NOTION_VERSION = '2022-06-28'; // 크롬 확장(youtube_dual_subtitle)과 동일 — 검증된 조합
const K_CARDS = 'cards:v1';
const K_STATE = 'sync:state';
const K_SCHEMA = 'schema:v1';
const K_GRADES = 'grades';

const SUB_BUDGET = 40;              // 50 상한에서 여유 10회를 남긴다
const STALE_MS = 6 * 60 * 60 * 1000; // 캐시가 이보다 오래되면 cron이 새 동기화를 시작

/* ── Notion 호출 (서브요청 예산 관리) ─────────────────────── */

class BudgetOut extends Error {}

const headers = (token) => ({
  Authorization: `Bearer ${token}`,
  'Notion-Version': NOTION_VERSION,
  'Content-Type': 'application/json',
});

const gap = (ms = 340) => new Promise((r) => setTimeout(r, ms)); // Notion 평균 3 req/s

async function notion(token, path, init = {}, budget = null) {
  if (budget) {
    if (budget.used >= budget.max) throw new BudgetOut('subrequest budget');
    budget.used++;
  }
  const res = await fetch(NOTION + path, { ...init, headers: headers(token) });
  if (res.status === 429) {
    await gap(1500);
    return notion(token, path, init, budget);
  }
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`Notion ${res.status} ${path}: ${body.slice(0, 200)}`);
  }
  return res.json();
}

/* ── 스키마 판별 ─────────────────────────────────────────── */

/**
 * ⚠ 이 DB엔 비슷해 보이는 두 컬럼이 있고 의미가 정반대다(2026-09-03 실측):
 *   완료도(status) = 시작 전 / 1차 완료 / 2차 완료 / 3차 완료 / 진행 중 / 완료  → 진도
 *   상태  (select) = 쉬움 / 적당함 / 어려움 / 완료                              → 체감 난이도
 * 채점(이해·애매·모름)이 가는 곳은 난이도다. 타입만 보고 status를 고르면 진도 컬럼을
 * 집어 채점이 조용히 유실된다 — 첫 구현이 실제로 그랬다. 그래서 타입이 아니라
 * **옵션 내용**으로 역할을 판별한다.
 */
async function discoverSchema(token, dbId, budget) {
  const db = await notion(token, `/databases/${dbId}`, {}, budget);
  const props = db.properties || {};
  const find = (pred) => Object.keys(props).find((n) => pred(n, props[n]));
  const opts = (n) => {
    const d = props[n];
    return (d?.status?.options || d?.select?.options || []).map((o) => o.name);
  };
  const byOptions = (re) => Object.keys(props).find(
    (n) => (props[n].type === 'select' || props[n].type === 'status') && opts(n).some((o) => re.test(o))
  );

  const difficulty = byOptions(/쉬움|어려|easy|hard/i);
  const progress = byOptions(/차 완료|진행 중|시작 전/i);

  return {
    dbTitle: (db.title || []).map((t) => t.plain_text).join(''),
    title: find((n, p) => p.type === 'title'),
    url: find((n, p) => p.type === 'url'),
    count: find((n, p) => p.type === 'number' && /횟수|count|review/i.test(n))
        || find((n, p) => p.type === 'number'),
    difficulty,
    difficultyType: difficulty ? props[difficulty].type : null,
    difficultyOptions: difficulty ? opts(difficulty) : [],
    progress,
    progressType: progress ? props[progress].type : null,
    progressOptions: progress ? opts(progress) : [],
  };
}

/* ── 블록 → 텍스트 ───────────────────────────────────────── */

const rt = (arr) => (arr || []).map((t) => t.plain_text || '').join('');

function blockText(b) {
  const v = b[b.type];
  if (!v) return null;
  if (b.type === 'table_row') return (v.cells || []).map(rt).filter(Boolean).join(' — ');
  if (Array.isArray(v.rich_text)) return rt(v.rich_text);
  return null;
}

async function pageLines(token, pageId, budget) {
  const lines = [];
  const data = await notion(token, `/blocks/${pageId}/children?page_size=100`, {}, budget);
  for (const b of data.results || []) {
    const txt = blockText(b);
    if (txt && txt.trim()) lines.push(txt.trim());
    // 표는 내용이 자식(table_row)에 있다 — 한 단계만 더 들어간다.
    if (b.has_children && b.type === 'table') {
      await gap();
      const kids = await notion(token, `/blocks/${b.id}/children?page_size=100`, {}, budget);
      for (const k of kids.results || []) {
        const kt = blockText(k);
        if (kt && kt.trim()) lines.push(kt.trim());
      }
    }
  }
  return lines;
}

/* ── 카드 조립 ───────────────────────────────────────────── */

const HANGUL = /[가-힣]/;
const LATIN = /[A-Za-z]{2,}/;

/**
 * 실측(21/21)한 본문 구조: [자막 문맥] → 「영어 + 한국어 뜻」 한 줄 → 해설 → 표.
 * 그 "한 줄"이 1단계 힌트가 된다 — 탭 1회에 뜻만, 2회에 전체.
 */
function splitBody(lines) {
  let body = lines.filter((l) => l && l !== '\t');
  let context = null;

  if (body[0]?.startsWith('질문:')) body = body.slice(1);   // AI에 던진 질문 — 카드엔 불필요
  else if (body[0] && !HANGUL.test(body[0])) { context = body[0]; body = body.slice(1); }

  // 힌트는 짧은 한 줄이어야 한다. 긴 해설 문단이 먼저 걸리는 카드가 있어 120자 이하 우선.
  const cand = [];
  for (let i = 0; i < Math.min(4, body.length); i++) {
    if (HANGUL.test(body[i]) && LATIN.test(body[i])) cand.push(i);
  }
  const hi = cand.find((i) => body[i].length <= 120) ?? cand[0] ?? null;
  return { context, hint: hi === null ? null : body[hi], detail: hi === null ? body : body.slice(hi + 1) };
}

// ⚠ pageId를 학습이력 키로 쓰지 말 것. 크롬 확장의 재저장이 "새 페이지 + 옛것 archive"라
// 재저장할 때마다 id가 바뀐다 — 제목이 유일하게 안정적인 키다.
export function cardKey(front) {
  return String(front || '').toLowerCase().replace(/[^a-z0-9가-힣]+/g, ' ').trim();
}

/* ── 청크 동기화 ─────────────────────────────────────────── */

/**
 * 한 번 호출될 때마다 서브요청 예산만큼만 진행하고 커서를 KV에 남긴다.
 * 반환: { done, processed, total } — done이 false면 한 번 더 부르면 된다.
 */
async function syncStep(env, token, dbId) {
  const budget = { used: 0, max: SUB_BUDGET };
  let st = JSON.parse((await env.KV.get(K_STATE)) || 'null');

  // 새 동기화 시작 — 스키마 + 행 목록을 먼저 확보한다(카드 본문은 아직 안 읽음).
  // 행 목록 조회는 100행당 1회라 1300행이어도 14회면 끝난다. 비싼 건 본문 쪽.
  if (!st) {
    const schema = await discoverSchema(token, dbId, budget);
    await env.KV.put(K_SCHEMA, JSON.stringify(schema));
    const rows = [];
    let cursor;
    do {
      await gap();
      const data = await notion(token, `/databases/${dbId}/query`, {
        method: 'POST',
        body: JSON.stringify({ page_size: 100, ...(cursor ? { start_cursor: cursor } : {}) }),
      }, budget);
      for (const r of data.results || []) {
        const p = r.properties || {};
        const front = rt(p[schema.title]?.title);
        if (!front) continue;
        rows.push({
          id: r.id, front, edited: r.last_edited_time,
          url: schema.url ? (p[schema.url]?.url || null) : null,
        });
      }
      cursor = data.has_more ? data.next_cursor : null;
      if (cursor && budget.used + 2 > budget.max) {
        // 행 목록조차 한 번에 못 끝나는 규모 — 여기까지 저장하고 다음 호출에 이어받는다.
        st = { schema, rows, i: 0, cards: [], rowCursor: cursor };
        await env.KV.put(K_STATE, JSON.stringify(st));
        return { done: false, processed: 0, total: rows.length, listing: true, subrequests: budget.used };
      }
    } while (cursor);
    st = { schema, rows, i: 0, cards: [] };
  }

  // 행 목록을 이어서 받는 중이면 마저 받는다.
  if (st.rowCursor) {
    let cursor = st.rowCursor;
    do {
      await gap();
      const data = await notion(token, `/databases/${dbId}/query`, {
        method: 'POST', body: JSON.stringify({ page_size: 100, start_cursor: cursor }),
      }, budget);
      for (const r of data.results || []) {
        const p = r.properties || {};
        const front = rt(p[st.schema.title]?.title);
        if (!front) continue;
        st.rows.push({
          id: r.id, front, edited: r.last_edited_time,
          url: st.schema.url ? (p[st.schema.url]?.url || null) : null,
        });
      }
      cursor = data.has_more ? data.next_cursor : null;
      if (cursor && budget.used + 2 > budget.max) {
        st.rowCursor = cursor;
        await env.KV.put(K_STATE, JSON.stringify(st));
        return { done: false, processed: 0, total: st.rows.length, listing: true, subrequests: budget.used };
      }
    } while (cursor);
    delete st.rowCursor;
  }

  // 증분: 지난번에 만든 카드 중 그 뒤로 수정되지 않은 것은 본문을 다시 읽지 않는다.
  // ⚠ 없으면 6시간마다 1300장을 통째로 다시 긁게 되고, 그건 Notion 한도로도 KV 쓰기
  //   한도로도 감당이 안 된다. 재저장된 카드는 pageId가 바뀌므로 자연히 새 카드로 잡힌다.
  if (!st.prev) {
    const cached = await env.KV.get(K_CARDS);
    st.prev = cached
      ? Object.fromEntries(JSON.parse(cached).cards.map((c) => [c.id, c]))
      : {};
  }

  let reused = 0;
  try {
    while (st.i < st.rows.length) {
      const row = st.rows[st.i];
      const old = st.prev[row.id];
      if (old && old.fetchedAt && row.edited && old.fetchedAt >= row.edited) {
        st.cards.push({ ...old, front: row.front, url: row.url }); // 본문 재사용 — 서브요청 0
        st.i++; reused++;
        continue;
      }
      if (budget.used + 2 > budget.max) break; // 카드 하나에 최대 2회(본문+표)
      await gap();
      let lines = [];
      try { lines = await pageLines(token, row.id, budget); }
      catch (e) { if (e instanceof BudgetOut) break; /* 본문 없는 행은 앞면만 */ }
      const { context, hint, detail } = splitBody(lines);
      st.cards.push({
        id: row.id, key: cardKey(row.front), front: row.front,
        context, hint, detail, url: row.url, fetchedAt: new Date().toISOString(),
      });
      st.i++;
    }
  } catch (e) {
    if (!(e instanceof BudgetOut)) throw e;
  }

  const done = st.i >= st.rows.length;
  // ⚠ prev(이전 카드 맵)는 상태에 저장하지 않는다 — 1300장이면 수 MB라 단계마다 그걸
  //   쓰면 KV 쓰기 한도(무료 1000/일)와 용량을 둘 다 잡아먹는다. 매 단계 캐시에서 다시 읽는다.
  delete st.prev;

  if (done) {
    await env.KV.put(K_CARDS, JSON.stringify({
      schema: st.schema, cards: st.cards, builtAt: new Date().toISOString(),
    }));
    await env.KV.delete(K_STATE);
  } else {
    await env.KV.put(K_STATE, JSON.stringify(st));
  }
  return { done, processed: st.i, total: st.rows.length, reused, subrequests: budget.used };
}

/* ── 채점 기록 ───────────────────────────────────────────── */

// ⚠ know에 /완료/를 넣지 말 것 — 난이도 컬럼에도 "완료" 옵션이 있어 "쉬움" 대신 그게 잡힌다.
const GRADE_HINT = { know: /쉬움|easy/i, fuzzy: /적당|보통|medium/i, dunno: /어려|hard|모름/i };

// 복습 횟수 → 진도 옵션("1차 완료" … "3차 완료"). 없으면 "진행 중"으로 퇴화.
const progressOptionFor = (options, n) =>
  options.find((o) => new RegExp('^' + Math.min(n, 3) + '차').test(o))
  || options.find((o) => /진행 중/.test(o))
  || null;

const optionPayload = (type, name) => (type === 'select' ? { select: { name } } : { status: { name } });

async function writeGrade(env, token, dbId, { pageId, key, grade }) {
  // 1) KV — 진실의 원본. pageId가 churn해도 제목 키로 살아남는다.
  const all = JSON.parse((await env.KV.get(K_GRADES)) || '{}');
  const n = (all[key]?.n || 0) + 1;
  all[key] = { grade, n, at: Date.now() };
  await env.KV.put(K_GRADES, JSON.stringify(all));

  // 2) Notion — best effort. 실패해도 채점은 이미 KV에 남았으므로 안전 퇴화.
  let notionOk = false;
  try {
    let schema = JSON.parse((await env.KV.get(K_SCHEMA)) || 'null');
    if (!schema) {
      schema = await discoverSchema(token, dbId);
      await env.KV.put(K_SCHEMA, JSON.stringify(schema));
    }
    const props = {};
    if (schema.count) props[schema.count] = { number: n };
    if (schema.difficulty) {
      const opt = schema.difficultyOptions.find((o) => GRADE_HINT[grade]?.test(o));
      if (opt) props[schema.difficulty] = optionPayload(schema.difficultyType, opt);
    }
    if (schema.progress) {
      const opt = progressOptionFor(schema.progressOptions, n);
      if (opt) props[schema.progress] = optionPayload(schema.progressType, opt);
    }
    if (Object.keys(props).length) {
      await notion(token, `/pages/${pageId}`, { method: 'PATCH', body: JSON.stringify({ properties: props }) });
      notionOk = true;
    }
  } catch (e) { /* 삼키고 notionOk:false로 정직하게 알린다 */ }

  return { ok: true, n, notionOk };
}

/* ── 라우팅 ──────────────────────────────────────────────── */

const json = (o, status = 200) =>
  new Response(JSON.stringify(o), { status, headers: { 'Content-Type': 'application/json; charset=utf-8' } });

const shuffle = (a) => a.map((v) => [Math.random(), v]).sort((x, y) => x[0] - y[0]).map((p) => p[1]);

/**
 * 한 판(기본 10장)을 서버에서 고른다.
 * ⚠ 카드가 1300장이 넘으므로 전량을 폰에 내려보내면 안 된다 — 약 2MB라 셀룰러
 *   첫 로딩이 느리고 Safari localStorage 한도(~5MB)에도 부딪힌다.
 * 우선순위: 예전에 "모름"이던 것 → 한 번도 안 본 것 → 나머지.
 */
function pickSession(cards, grades, n) {
  const g = (c) => grades[c.key];
  const weak = cards.filter((c) => g(c)?.grade === 'dunno');
  const unseen = cards.filter((c) => !g(c));
  const rest = cards.filter((c) => g(c) && g(c).grade !== 'dunno');
  const picked = [
    ...shuffle(weak).slice(0, Math.ceil(n * 0.4)),
    ...shuffle(unseen),
    ...shuffle(rest),
  ].slice(0, n);
  return shuffle(picked).map((c) => ({ ...c, prevGrade: g(c)?.grade || null }));
}

async function handleCards(env, url) {
  const n = Math.min(Math.max(parseInt(url.searchParams.get('session') || '10', 10) || 10, 1), 50);
  const cached = await env.KV.get(K_CARDS);
  const grades = JSON.parse((await env.KV.get(K_GRADES)) || '{}');
  const st = JSON.parse((await env.KV.get(K_STATE)) || 'null');
  const syncing = !!st;

  if (cached) {
    const d = JSON.parse(cached);
    return json({
      cards: pickSession(d.cards, grades, n),
      total: d.cards.length,
      graded: Object.keys(grades).length,
      builtAt: d.builtAt,
      syncing,
      progress: st ? { processed: st.i, total: st.rows.length } : null,
    });
  }
  // 아직 한 번도 동기화가 안 끝났다 — 앱은 씨앗으로 퇴화하면 된다.
  return json({
    cards: [], total: 0, graded: Object.keys(grades).length, syncing: true,
    progress: st ? { processed: st.i, total: st.rows.length } : null,
  }, 202);
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const { NOTION_TOKEN: token, NOTION_DB_ID: dbId } = env;

    if (url.pathname === '/api/cards') return handleCards(env, url);

    if (url.pathname === '/api/sync') {
      if (!token || !dbId) return json({ error: 'NOTION_TOKEN / NOTION_DB_ID 미설정' }, 500);
      if (url.searchParams.get('restart') === '1') await env.KV.delete(K_STATE);
      try { return json(await syncStep(env, token, dbId)); }
      catch (e) { return json({ error: String(e.message || e) }, 502); }
    }

    if (url.pathname === '/api/grade' && request.method === 'POST') {
      if (!token || !dbId) return json({ error: 'NOTION_TOKEN / NOTION_DB_ID 미설정' }, 500);
      try {
        const body = await request.json();
        if (!body.key || !body.grade) return json({ error: 'key·grade 필요' }, 400);
        return json(await writeGrade(env, token, dbId, body));
      } catch (e) { return json({ error: String(e.message || e) }, 500); }
    }

    return env.ASSETS.fetch(request);
  },

  // cron이 동기화를 이어 돌린다. 진행 중이면 계속, 끝났고 캐시가 낡았으면 새로 시작.
  async scheduled(event, env, ctx) {
    const { NOTION_TOKEN: token, NOTION_DB_ID: dbId } = env;
    if (!token || !dbId) return;
    ctx.waitUntil((async () => {
      const inProgress = await env.KV.get(K_STATE);
      if (!inProgress) {
        const cached = await env.KV.get(K_CARDS);
        if (cached) {
          const { builtAt } = JSON.parse(cached);
          if (Date.now() - new Date(builtAt).getTime() < STALE_MS) return; // 아직 신선함
        }
      }
      await syncStep(env, token, dbId);
    })());
  },
};
