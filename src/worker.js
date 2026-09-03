/**
 * Shorts Deck — Cloudflare Worker
 *
 * 하는 일 다섯:
 *   1. public/ 정적 자산(앱) 서빙          → 앱과 API가 같은 출처 = CORS 문제 자체가 없음
 *   2. GET  /api/cards   완료도=0 70% + 복습 때 된 카드 30%로 한 묶음을 골라 반환
 *   3. GET  /api/index   모아보기용 가벼운 전체 목록(제목·차수만, 카드 본문 없음)
 *   4. GET  /api/card    id 하나의 전체 본문(원본 블록) 반환 — 모아보기에서 되짚어볼 때
 *   5. GET  /api/sync    Notion → 카드 변환을 "예산만큼만" 진행하고 커서를 남김
 *   6. POST /api/grade   채점을 KV(원본) + Notion 속성(미러) 양쪽에 기록. body.undo:true면 직전 1건 되돌리기
 *
 * ⚠ 왜 Worker가 반드시 필요한가 — api.notion.com은 Access-Control-Allow-Origin을
 *   보내지 않는다(2026-09-03 실측). 크롬 확장은 host_permissions로 CORS를 면제받아
 *   직접 호출하지만, 브라우저 페이지는 못 한다. 게다가 토큰을 프런트에 두면 털린다.
 *
 * ⚠ 왜 한 번에 다 못 가져오는가 — Cloudflare 무료 요금제는 **요청당 서브요청 50회**가
 *   상한이고, KV의 get/put/list/delete도 이 서브요청에 포함된다(공식 문서 확인,
 *   2026-09-03). 카드 하나를 만들려면 본문 블록 조회가 1~2회 필요해서 21장만 해도
 *   약 60회다. 그래서 진행 커서를 KV에 두고 여러 번에 나눠 처리하며, cron이 이어 돌린다.
 *
 * ⚠ 저장 구조(2026-09-03 개편) — 예전엔 sync:state에 "이미 처리한 카드 전량"을
 *   통째로 담았다. 1,101/1,323장을 넘기자 그 값이 약 1.7MB로 불어났고, 매 5분 cron
 *   틱마다 그걸 파싱·직렬화하다 무료 CPU 10ms를 넘겨 503이 연속으로 났다(실측: 148·
 *   823·1040장에서는 멀쩡했고 1,040을 넘긴 뒤부터 6/6 실패).
 *   그래서 지금은 인덱스(제목·차수·버킷번호만, 전량 ~100KB)와 버킷(본문 50장 단위)을
 *   분리해 저장한다. sync:state가 들고 있는 카드 본문은 "현재 채우는 중인 버킷"
 *   하나(최대 50장)뿐이라 크기가 항상 유계다.
 */

const NOTION = 'https://api.notion.com/v1';
const NOTION_VERSION = '2022-06-28'; // 크롬 확장(youtube_dual_subtitle)과 동일 — 검증된 조합

const K_STATE = 'sync:state';
const K_SCHEMA = 'schema:v1';
const K_GRADES = 'grades';
const K_INDEX = 'index:v2';
const K_BUCKET = 'bucket:v2:'; // + 번호
const K_CARDS_OLD = 'cards:v1'; // 옛 포맷 — done 시점에 정리

const BUCKET_SIZE = 50;             // ⚠ 카드별 개별 KV 저장은 불가 — 무료 쓰기 1,000회/일에 걸린다
const PARSER_VERSION = 2;           // 포맷을 바꾸면 올릴 것 — 증분 로직이 옛 포맷을 재사용하지 않게
const SUB_BUDGET = 40;              // 50 상한에서 여유 10회를 남긴다
const STALE_MS = 6 * 60 * 60 * 1000; // 캐시가 이보다 오래되면 cron이 새 동기화를 시작
const DUE_DAYS = { 1: 3, 2: 7, 3: 21 }; // "때가 됨" 경과일 — 강제 아님, 뽑기 가중치일 뿐

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

async function kvGet(env, key, budget) {
  if (budget) { if (budget.used >= budget.max) throw new BudgetOut('subrequest budget'); budget.used++; }
  return env.KV.get(key);
}
async function kvPut(env, key, value, budget) {
  if (budget) { if (budget.used >= budget.max) throw new BudgetOut('subrequest budget'); budget.used++; }
  return env.KV.put(key, value);
}

/* ── 스키마 판별 ─────────────────────────────────────────── */

/**
 * ⚠ 이 DB엔 비슷해 보이는 두 컬럼이 있고 의미가 정반대다(2026-09-03 실측):
 *   완료도(select) = 0 / 1차 완료 / 2차 완료 / 3차 완료  → 진도
 *   상태  (select) = 쉬움 / 적당함 / 어려움 / 완료        → 체감 난이도
 * 채점(이해·애매·모름)이 가는 곳은 난이도다. 게다가 둘 다 select 타입이라 타입으로는
 * 구분이 불가능하다 — 그래서 타입이 아니라 **옵션 내용**으로 역할을 판별한다.
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

/* ── 블록 → 압축 표현 ─────────────────────────────────────
   Notion 원본 블록을 렌더 가능한 최소 형태로만 압축해 그대로 보관한다. 렌더링은
   클라이언트가 표시 시점에 한다 — 그래야 렌더 로직을 몇 번 바꿔도 재동기화가
   다시는 필요 없다. annotations 중 인라인 코드(백틱, code)는 사용자가 AI 답변에서
   직접 고른 형광펜이라 이 프로젝트에서 가장 중요한 정보 — 반드시 보존한다.       */

function richText(arr) {
  return (arr || []).map((t) => {
    const o = { t: t.plain_text || '' };
    const an = t.annotations || {};
    if (an.bold) o.bold = true;
    if (an.italic) o.italic = true;
    if (an.code) o.code = true;
    if (an.strikethrough) o.strike = true;
    if (an.underline) o.underline = true;
    const href = t.href || (t.text && t.text.link && t.text.link.url) || null;
    if (href) o.href = href;
    return o;
  });
}

function compactBlock(b) {
  const type = b.type;
  const v = b[type];
  if (!v) return null;
  if (type === 'divider') return { type: 'divider' };
  if (type === 'table') return { type: 'table', width: v.table_width || 0, headerRow: !!v.has_column_header, rows: [] };
  if (Array.isArray(v.rich_text)) {
    const rich = richText(v.rich_text);
    if (!rich.some((x) => x.t)) return null; // 빈 줄
    const out = { type, rich };
    if (type === 'to_do') out.checked = !!v.checked;
    if (type === 'code') out.language = v.language || null;
    return out;
  }
  return null;
}

function plainOf(blk) {
  if (!blk) return '';
  if (blk.type === 'table') return (blk.rows || []).map((row) => row.map((cell) => cell.map((x) => x.t).join('')).join(' ')).join(' ');
  if (blk.type === 'divider') return '';
  return (blk.rich || []).map((x) => x.t).join('');
}

async function pageBlocks(token, pageId, budget) {
  const blocks = [];
  const data = await notion(token, `/blocks/${pageId}/children?page_size=100`, {}, budget);
  for (const b of data.results || []) {
    const cb = compactBlock(b);
    if (!cb) continue;
    if (cb.type === 'table' && b.has_children) {
      await gap();
      const kids = await notion(token, `/blocks/${b.id}/children?page_size=100`, {}, budget);
      for (const k of kids.results || []) {
        if (k.type === 'table_row') cb.rows.push((k.table_row?.cells || []).map((cell) => richText(cell)));
      }
    }
    blocks.push(cb);
  }
  return blocks;
}

/* ── 카드 조립 ───────────────────────────────────────────── */

const HANGUL = /[가-힣]/;
const LATIN = /[A-Za-z]{2,}/;

/**
 * 실측(21/21)한 본문 구조: [자막 문맥] → 「영어 + 한국어 뜻」 한 줄 → 해설 → 표.
 * 그 "한 줄"이 1단계 힌트가 된다 — 탭하면 전문(힌트+해설)이 바로 열린다.
 */
function splitBody(blocks) {
  let body = blocks.filter((b) => b && plainOf(b).trim());
  let context = null;

  const first = body[0] ? plainOf(body[0]) : '';
  if (first.startsWith('질문:')) body = body.slice(1);            // AI에 던진 질문 — 카드엔 불필요
  else if (first && !HANGUL.test(first)) { context = body[0]; body = body.slice(1); }

  // 힌트는 짧은 한 줄이어야 한다. 긴 해설 문단이 먼저 걸리는 카드가 있어 120자 이하 우선.
  const cand = [];
  for (let i = 0; i < Math.min(4, body.length); i++) {
    const t = plainOf(body[i]);
    if (HANGUL.test(t) && LATIN.test(t)) cand.push(i);
  }
  const hi = cand.find((i) => plainOf(body[i]).length <= 120) ?? cand[0] ?? null;
  return { context, hint: hi === null ? null : body[hi], detail: hi === null ? body : body.slice(hi + 1) };
}

// ⚠ pageId를 학습이력 키로 쓰지 말 것. 크롬 확장의 재저장이 "새 페이지 + 옛것 archive"라
// 재저장할 때마다 id가 바뀐다 — 제목이 유일하게 안정적인 키다.
export function cardKey(front) {
  return String(front || '').toLowerCase().replace(/[^a-z0-9가-힣]+/g, ' ').trim();
}

/* ── 이전 인덱스 로드 (증분 재사용용) ──────────────────────── */

async function loadPrevIndex(env, budget) {
  const raw = await kvGet(env, K_INDEX, budget);
  if (!raw) return {};
  try {
    const idx = JSON.parse(raw);
    const map = {};
    for (const it of idx.items || []) map[it.id] = { edited: it.edited, bucket: it.bucket };
    return map;
  } catch (e) { return {}; }
}

/* ── 청크 동기화 ─────────────────────────────────────────── */

/**
 * 한 번 호출될 때마다 서브요청 예산만큼만 진행하고 커서를 KV에 남긴다.
 * sync:state가 들고 있는 것: 행 목록(가벼움) + 지금 채우는 중인 버킷 하나(최대 50장)
 * + 누적 인덱스(가벼움, ~100KB) + 이전 인덱스 맵(가벼움). "본문 전량"은 절대 안 들고 있는다.
 * 반환: { done, processed, total } — done이 false면 한 번 더 부르면 된다.
 */
async function syncStep(env, token, dbId) {
  const budget = { used: 0, max: SUB_BUDGET };
  let st = JSON.parse((await env.KV.get(K_STATE)) || 'null');

  // 새 동기화 시작 — 스키마 + 행 목록을 먼저 확보한다(카드 본문은 아직 안 읽음).
  if (!st) {
    const schema = await discoverSchema(token, dbId, budget);
    // ⚠ 이 한 줄을 빼지 말 것 — writeGrade가 이 캐시를 그대로 믿는다. 2026-09-03 실측:
    //   사용자가 `완료도`를 status→select로 바꾼 뒤에도 KV엔 옛 status 스키마가 남아 있었고,
    //   채점 PATCH가 {status:{...}}로 나가 검증 실패 → 채점이 Notion에 조용히 유실됐다.
    await kvPut(env, K_SCHEMA, JSON.stringify(schema), budget);
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
        rows.push({ id: r.id, front, edited: r.last_edited_time, created: r.created_time, url: schema.url ? (p[schema.url]?.url || null) : null });
      }
      cursor = data.has_more ? data.next_cursor : null;
      if (cursor && budget.used + 2 > budget.max) {
        st = { schema, rows, rowCursor: cursor, i: 0, items: [], bucket: { num: 0, cards: [] } };
        await env.KV.put(K_STATE, JSON.stringify(st));
        return { done: false, processed: 0, total: rows.length, phase: 'listing', subrequests: budget.used };
      }
    } while (cursor);
    st = { schema, rows, i: 0, items: [], bucket: { num: 0, cards: [] } };
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
        st.rows.push({ id: r.id, front, edited: r.last_edited_time, created: r.created_time, url: st.schema.url ? (p[st.schema.url]?.url || null) : null });
      }
      cursor = data.has_more ? data.next_cursor : null;
      if (cursor && budget.used + 2 > budget.max) {
        st.rowCursor = cursor;
        await env.KV.put(K_STATE, JSON.stringify(st));
        return { done: false, processed: 0, total: st.rows.length, phase: 'listing', subrequests: budget.used };
      }
    } while (cursor);
    delete st.rowCursor;
  }

  // 증분 재사용을 위한 이전 인덱스(제목·수정시각·버킷번호만) — 가볍고(~100KB) 유계라
  // state에 계속 들고 있어도 안전하다(옛 설계가 문제였던 건 "본문 전량"을 들고 있던 것).
  if (!st.prevIndex) {
    st.prevIndex = await loadPrevIndex(env, budget);
  }

  // 증분: 수정되지 않은 행은 옛 버킷에서 그대로 복사해 Notion 본문을 다시 읽지 않는다.
  // ⚠ 없으면 캐시가 낡을 때마다(6시간) 1300장을 통째로 다시 긁게 된다. 재저장된 카드는
  //   pageId가 바뀌므로 옛 인덱스에 없어 자연히 새 카드로 잡힌다.
  let curOldBucket = null; // {num, byId} — 이 호출 안에서만 쓰는 임시 캐시(연속 행이 같은 옛 버킷에 몰려 있어 재사용됨)
  let reused = 0;

  try {
    while (st.i < st.rows.length) {
      const row = st.rows[st.i];
      const prevItem = st.prevIndex[row.id];
      let card = null;

      if (prevItem && prevItem.edited && row.edited && prevItem.edited >= row.edited) {
        if (!curOldBucket || curOldBucket.num !== prevItem.bucket) {
          const raw = await kvGet(env, K_BUCKET + prevItem.bucket, budget);
          const cards = raw ? JSON.parse(raw).cards : [];
          curOldBucket = { num: prevItem.bucket, byId: Object.fromEntries(cards.map((c) => [c.id, c])) };
        }
        const old = curOldBucket.byId[row.id];
        if (old && old.parserVersion === PARSER_VERSION) card = { ...old, front: row.front, url: row.url, created: row.created };
      }

      if (!card) {
        if (budget.used + 2 > budget.max) break; // 카드 하나에 최대 2회(본문+표)
        await gap();
        let blocks = [];
        try { blocks = await pageBlocks(token, row.id, budget); }
        catch (e) { if (e instanceof BudgetOut) break; /* 본문 없는 행은 앞면만 */ }
        const { context, hint, detail } = splitBody(blocks);
        card = {
          id: row.id, key: cardKey(row.front), front: row.front,
          context, hint, detail, url: row.url, created: row.created,
          fetchedAt: new Date().toISOString(), parserVersion: PARSER_VERSION,
        };
      } else {
        reused++;
      }

      st.bucket.cards.push(card);
      st.items.push({ id: row.id, key: card.key, front: row.front, url: row.url, edited: row.edited, bucket: st.bucket.num });
      st.i++;

      if (st.bucket.cards.length >= BUCKET_SIZE) {
        await kvPut(env, K_BUCKET + st.bucket.num, JSON.stringify({ cards: st.bucket.cards }), budget);
        st.bucket = { num: st.bucket.num + 1, cards: [] };
      }
    }
  } catch (e) {
    if (!(e instanceof BudgetOut)) throw e;
  }

  const done = st.i >= st.rows.length;

  if (done) {
    if (st.bucket.cards.length) {
      await env.KV.put(K_BUCKET + st.bucket.num, JSON.stringify({ cards: st.bucket.cards }));
    }
    await env.KV.put(K_INDEX, JSON.stringify({
      schema: st.schema, items: st.items, builtAt: new Date().toISOString(), parserVersion: PARSER_VERSION,
    }));
    await env.KV.delete(K_STATE);
    await env.KV.delete(K_CARDS_OLD); // 옛 포맷 정리(있었다면)
  } else {
    await env.KV.put(K_STATE, JSON.stringify(st));
  }
  return { done, processed: st.i, total: st.rows.length, reused, subrequests: budget.used };
}

const rt = (arr) => (arr || []).map((t) => t.plain_text || '').join('');

/* ── 채점 기록 ───────────────────────────────────────────── */

// ⚠ know에 /완료/를 넣지 말 것 — 난이도 컬럼에도 "완료" 옵션이 있어 "쉬움" 대신 그게 잡힌다.
const GRADE_HINT = { know: /쉬움|easy/i, fuzzy: /적당|보통|medium/i, dunno: /어려|hard|모름/i };

// 진도(완료도) 옵션 — 실측: 첫 옵션은 "0차"가 아니라 그냥 "0". step 0은 그 옵션으로.
function progressOptionFor(options, step) {
  if (step <= 0) return options.find((o) => o === '0') || options.find((o) => /^0/.test(o)) || null;
  return options.find((o) => new RegExp('^' + Math.min(step, 3) + '차').test(o)) || null;
}

// name === null이면 속성을 비운다(되돌리기가 "한 번도 채점 안 한 상태"로 복구할 때 씀).
const optionPayload = (type, name) =>
  name == null
    ? (type === 'select' ? { select: null } : { status: null })
    : (type === 'select' ? { select: { name } } : { status: { name } });

/**
 * 채점 한 번 = 완료도(진도) 한 칸 승급/제자리/강등 + 상태(난이도) 갱신 + 복습 횟수 +1.
 * ⚠ 횟수(n)와 차수(step)는 별개 축 — 같이 올리면 세 번 봐도 계속 모르는 카드가 3차로
 *   올라간다(첫 구현의 실제 결함). 강등은 한 칸만 — 0으로 리셋하면 소거의 재미가 죽는다.
 */
async function writeGrade(env, token, dbId, { pageId, key, grade }) {
  // 1) KV — 진실의 원본. pageId가 churn해도 제목 키로 살아남는다.
  const all = JSON.parse((await env.KV.get(K_GRADES)) || '{}');
  const prev = all[key] || { n: 0, step: 0 };
  const n = prev.n + 1;
  const step = grade === 'know' ? Math.min((prev.step || 0) + 1, 3)
    : grade === 'dunno' ? Math.max((prev.step || 0) - 1, 0)
    : (prev.step || 0);
  all[key] = { grade, n, step, at: Date.now() };
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
      const opt = progressOptionFor(schema.progressOptions, step);
      if (opt) props[schema.progress] = optionPayload(schema.progressType, opt);
    }
    if (Object.keys(props).length) {
      await notion(token, `/pages/${pageId}`, { method: 'PATCH', body: JSON.stringify({ properties: props }) });
      notionOk = true;
    }
  } catch (e) { /* 삼키고 notionOk:false로 정직하게 알린다 */ }

  return { ok: true, n, step, notionOk };
}

/**
 * 되돌리기 — 직전 채점 한 건만 취소(단발성, 히스토리 없음). "잘못 매긴 채점 복구"가
 * 목적이라 복습 횟수(n)까지 되돌린다 — writeGrade의 "횟수는 단조증가" 원칙의 유일한
 * 예외(2026-09-03 사용자 결정). prev가 null이면 "한 번도 채점 안 한 상태"로 복구하는
 * 것이라 Notion 속성도 실제로 비운다(옵션 미설정).
 */
async function undoGrade(env, token, dbId, { pageId, key, prev }) {
  const all = JSON.parse((await env.KV.get(K_GRADES)) || '{}');
  if (prev) all[key] = { grade: prev.grade, n: prev.n, step: prev.step, at: Date.now() };
  else delete all[key];
  await env.KV.put(K_GRADES, JSON.stringify(all));

  let notionOk = false;
  try {
    let schema = JSON.parse((await env.KV.get(K_SCHEMA)) || 'null');
    if (!schema) {
      schema = await discoverSchema(token, dbId);
      await env.KV.put(K_SCHEMA, JSON.stringify(schema));
    }
    const n = prev ? prev.n : 0;
    const step = prev ? prev.step : 0;
    const props = {};
    if (schema.count) props[schema.count] = { number: n };
    if (schema.difficulty) {
      if (prev) {
        // 옵션을 못 찾으면(스키마 드리프트) writeGrade처럼 건드리지 않고 넘어간다 —
        // "한 번도 채점 안 한 상태"가 아닌 한 함부로 비우지 않는다.
        const opt = schema.difficultyOptions.find((o) => GRADE_HINT[prev.grade]?.test(o));
        if (opt) props[schema.difficulty] = optionPayload(schema.difficultyType, opt);
      } else {
        props[schema.difficulty] = optionPayload(schema.difficultyType, null);
      }
    }
    if (schema.progress) {
      const opt = progressOptionFor(schema.progressOptions, step);
      if (opt) props[schema.progress] = optionPayload(schema.progressType, opt);
    }
    if (Object.keys(props).length) {
      await notion(token, `/pages/${pageId}`, { method: 'PATCH', body: JSON.stringify({ properties: props }) });
      notionOk = true;
    }
  } catch (e) { /* 삼키고 notionOk:false로 정직하게 알린다 */ }

  return { ok: true, n, step, notionOk };
}

/* ── 라우팅 ──────────────────────────────────────────────── */

const json = (o, status = 200) =>
  new Response(JSON.stringify(o), { status, headers: { 'Content-Type': 'application/json; charset=utf-8' } });

const shuffle = (a) => a.map((v) => [Math.random(), v]).sort((x, y) => x[0] - y[0]).map((p) => p[1]);

/**
 * 뽑기: 완료도 0(빈 값 포함) 70% + 복습 때가 된 상위 차수 30%.
 * "때가 됨" = 마지막 채점 이후 경과일이 차수별 기준(1차 3일·2차 7일·3차 21일)을 넘김.
 * ⚠ 정통 간격반복(SM-2/FSRS)이 아니다 — 경과일은 강제가 아니라 뽑기 가중치일 뿐이라
 *   "오늘 밀린 47장" 같은 부채감이 생기지 않는다.
 */
function pickCandidates(items, grades, n) {
  const now = Date.now();
  const zero = [], due = [];
  for (const it of items) {
    const g = grades[it.key];
    const step = g?.step || 0;
    if (step === 0) { zero.push(it); continue; }
    const days = DUE_DAYS[Math.min(step, 3)] || 999;
    if (!g?.at || now - g.at >= days * 86400000) due.push(it);
  }
  const nZero = Math.max(1, Math.round(n * 0.7));
  const picked = [...shuffle(zero).slice(0, nZero), ...shuffle(due).slice(0, n - nZero)];
  if (picked.length < n) {
    const have = new Set(picked.map((c) => c.id));
    const rest = items.filter((it) => !have.has(it.id));
    picked.push(...shuffle(rest).slice(0, n - picked.length));
  }
  return shuffle(picked).slice(0, n);
}

function remainingCount(items, grades) {
  return items.filter((it) => !(grades[it.key]?.step > 0)).length;
}

async function handleCards(env, url) {
  const n = Math.min(Math.max(parseInt(url.searchParams.get('n') || '8', 10) || 8, 1), 30);
  const idxRaw = await env.KV.get(K_INDEX);
  const grades = JSON.parse((await env.KV.get(K_GRADES)) || '{}');
  const st = JSON.parse((await env.KV.get(K_STATE)) || 'null');
  const syncing = !!st;

  if (!idxRaw) {
    return json({
      cards: [], total: 0, remaining: 0, graded: Object.keys(grades).length, syncing: true,
      progress: st ? { processed: st.i, total: st.rows.length } : null,
    }, 202);
  }

  const idx = JSON.parse(idxRaw);
  const candidates = pickCandidates(idx.items, grades, n);
  const byBucket = new Map();
  for (const it of candidates) {
    if (!byBucket.has(it.bucket)) byBucket.set(it.bucket, []);
    byBucket.get(it.bucket).push(it.id);
  }
  const cards = [];
  for (const [num, ids] of byBucket) {
    const raw = await env.KV.get(K_BUCKET + num);
    if (!raw) continue;
    const byId = Object.fromEntries(JSON.parse(raw).cards.map((c) => [c.id, c]));
    for (const id of ids) {
      const c = byId[id];
      if (c) cards.push({ ...c, prevGrade: grades[c.key]?.grade || null, step: grades[c.key]?.step || 0, n: grades[c.key]?.n || 0 });
    }
  }

  return json({
    cards: shuffle(cards),
    total: idx.items.length,
    remaining: remainingCount(idx.items, grades),
    graded: Object.keys(grades).length,
    builtAt: idx.builtAt,
    syncing,
    progress: st ? { processed: st.i, total: st.rows.length } : null,
  });
}

// 모아보기 — 가벼운 전체 목록(본문 없음, 제목·차수만). 1,323장이 약 100KB라 통째로 내려도 된다.
async function handleIndex(env) {
  const idxRaw = await env.KV.get(K_INDEX);
  const st = JSON.parse((await env.KV.get(K_STATE)) || 'null');
  if (!idxRaw) {
    return json({ items: [], total: 0, syncing: true, progress: st ? { processed: st.i, total: st.rows.length } : null }, 202);
  }
  const idx = JSON.parse(idxRaw);
  const grades = JSON.parse((await env.KV.get(K_GRADES)) || '{}');
  const items = idx.items.map((it) => {
    const g = grades[it.key];
    return { id: it.id, key: it.key, front: it.front, step: g?.step || 0, n: g?.n || 0, lastAt: g?.at || null };
  });
  return json({
    items, total: items.length, builtAt: idx.builtAt, syncing: !!st,
    progress: st ? { processed: st.i, total: st.rows.length } : null,
  });
}

// 모아보기에서 카드 하나를 되짚어볼 때만 쓰는 단건 조회(id로 버킷을 찾아 그 카드만 반환).
async function handleCard(env, id) {
  const idxRaw = await env.KV.get(K_INDEX);
  if (!idxRaw) return json({ error: '아직 동기화 안 됨' }, 404);
  const idx = JSON.parse(idxRaw);
  const item = idx.items.find((it) => it.id === id);
  if (!item) return json({ error: 'not found' }, 404);
  const raw = await env.KV.get(K_BUCKET + item.bucket);
  const card = raw ? JSON.parse(raw).cards.find((c) => c.id === id) : null;
  if (!card) return json({ error: 'not found' }, 404);
  const grades = JSON.parse((await env.KV.get(K_GRADES)) || '{}');
  const g = grades[card.key];
  return json({ ...card, prevGrade: g?.grade || null, step: g?.step || 0 });
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const { NOTION_TOKEN: token, NOTION_DB_ID: dbId } = env;

    if (url.pathname === '/api/cards') return handleCards(env, url);
    if (url.pathname === '/api/index') return handleIndex(env);
    if (url.pathname === '/api/card') return handleCard(env, url.searchParams.get('id') || '');

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
        if (!body.key) return json({ error: 'key 필요' }, 400);
        if (body.undo) return json(await undoGrade(env, token, dbId, body));
        if (!body.grade) return json({ error: 'grade 필요' }, 400);
        return json(await writeGrade(env, token, dbId, body));
      } catch (e) { return json({ error: String(e.message || e) }, 500); }
    }

    return env.ASSETS.fetch(request);
  },

  // cron이 동기화를 이어 돌린다. 진행 중이면 계속, 끝났고 인덱스가 낡았으면 새로 시작.
  async scheduled(event, env, ctx) {
    const { NOTION_TOKEN: token, NOTION_DB_ID: dbId } = env;
    if (!token || !dbId) return;
    ctx.waitUntil((async () => {
      const inProgress = await env.KV.get(K_STATE);
      if (!inProgress) {
        const idxRaw = await env.KV.get(K_INDEX);
        if (idxRaw) {
          const { builtAt } = JSON.parse(idxRaw);
          if (Date.now() - new Date(builtAt).getTime() < STALE_MS) return; // 아직 신선함
        }
      }
      await syncStep(env, token, dbId);
    })());
  },
};
