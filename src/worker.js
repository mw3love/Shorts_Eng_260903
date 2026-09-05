/**
 * Shorts Deck — Cloudflare Worker
 *
 * 2026-09-05 전면 재설계: "로그라이크식 챕터 클리어" 구조로 교체(deep-interview로 정리).
 *   기존 무한 스와이프 덱 + 0~3차 채점 + 되돌리기 + 캘린더 + 전역검색은 전부 폐기.
 *   새 모델: 카드 전체를 생성일자순으로 100장씩 대챕터 → 그 안을 10장씩 소챕터로 나눔.
 *   카드 상태는 앱 자체의 이진값(안다/모른다)뿐 — 노션 0~3차와의 연동은 끊었다(사용자 결정,
 *   이유: 압박이 문제가 아니라 노션 UI 자체의 마찰이 방치 원인이었다는 판단). 게이트(잠금)도
 *   없다 — 모든 챕터는 처음부터 자유 열람, 최고기록은 순수 진행 현황판.
 *
 * 하는 일:
 *   1. public/ 정적 자산(앱) 서빙
 *   2. GET  /api/chapters         대챕터 전체 개요(현재/최고 점수)
 *   3. GET  /api/chapter?id=cN    대챕터 하나의 소챕터 10개 상세(현재/최고 점수 + 카드 제목·known)
 *   4. GET  /api/subchapter?id=cNsM&mode=all|unknown   소챕터 하나의 카드 전체 본문(학습·시험 공용)
 *   5. GET  /api/chapterexam?id=cN  대챕터 전체(100장) 시험용 — 카드마다 원래 소속 subId를 붙여 반환
 *   6. POST /api/answer           시험 정답 기록(안다/모른다) + 소챕터·대챕터 점수 갱신(최고기록 포함)
 *   7. POST /api/retitle          본문에서 드래그 선택한 예문으로 카드 제목(Notion 이름 속성 원본)을 고침
 *   8. POST /api/highlight        본문 인라인 코드(형광펜) annotation 토글 — KV+Notion 블록 원본 동시 반영
 *   9. GET  /api/image?id=blockId  Notion 자체 호스팅 이미지의 프리사인드 URL을 매번 새로 받아 리다이렉트
 *  10. GET  /api/sync             Notion → 카드 변환을 "예산만큼만" 진행하고 커서를 남김
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
 * ⚠ 저장 구조(2026-09-03 개편) — 인덱스(제목·차수·버킷번호만, 전량 ~100KB)와 버킷(본문
 *   50장 단위)을 분리해 저장한다. sync:state가 들고 있는 카드 본문은 "현재 채우는 중인
 *   버킷" 하나(최대 50장)뿐이라 크기가 항상 유계다(예전엔 누적 전량을 통째로 들고 있다가
 *   1,101장을 넘긴 시점부터 CPU 10ms를 넘겨 503이 연속으로 났다).
 */

const NOTION = 'https://api.notion.com/v1';
const NOTION_VERSION = '2022-06-28'; // 크롬 확장(youtube_dual_subtitle)과 동일 — 검증된 조합

const K_STATE = 'sync:state';
const K_INDEX = 'index:v2';
const K_BUCKET = 'bucket:v2:'; // + 번호
const K_KNOWN = 'known:v1';    // { [cardKey]: true } — 안다로 판정된 카드만 기록(모른다=부재)
const K_BEST = 'best:v1';      // { sub:{ [subId]: n }, chap:{ [chapId]: n } } — 최고기록(단조증가)

const BUCKET_SIZE = 50;             // ⚠ 카드별 개별 KV 저장은 불가 — 무료 쓰기 1,000회/일에 걸린다
const PARSER_VERSION = 4;           // 포맷을 바꾸면 올릴 것 — 증분 로직이 옛 포맷을 재사용하지 않게
                                     // (v3, 2026-09-05: 블록에 원본 block.id 추가 — 형광펜 토글을
                                     //  Notion에 되쓰려면 필요 / v4, 같은 날: image 블록 지원 추가 —
                                     //  이전엔 이미지만 있는 카드가 조용히 빈 본문으로 캐시됐다)
const SUB_BUDGET = 40;              // 50 상한에서 여유 10회를 남긴다
const STALE_MS = 6 * 60 * 60 * 1000; // 캐시가 이보다 오래되면 cron이 새 동기화를 시작

const SUB_SIZE = 10;  // 소챕터 카드 수
const CHAP_SIZE = 10; // 대챕터당 소챕터 수(= 대챕터 카드 수 100)

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
// 채점을 노션에 반영하지 않기로 했으므로(2026-09-05) 진도/난이도 컬럼은 더 이상 안 찾는다.
// title/url만 있으면 카드 조립에 충분하다.
async function discoverSchema(token, dbId, budget) {
  const db = await notion(token, `/databases/${dbId}`, {}, budget);
  const props = db.properties || {};
  const find = (pred) => Object.keys(props).find((n) => pred(n, props[n]));
  return {
    dbTitle: (db.title || []).map((t) => t.plain_text).join(''),
    title: find((n, p) => p.type === 'title'),
    url: find((n, p) => p.type === 'url'),
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
  if (type === 'image') {
    // 초창기(AI 도입 전) 메모는 텍스트가 아니라 스크린샷을 그대로 붙여넣은 경우가 있다
    // (2026-09-05 실기기 피드백 — 소챕터1 1번 카드가 빈 화면으로 보임, 원인이 이거였음).
    // ⚠ Notion이 자체 호스팅하는 file.url은 AWS 프리사인드 URL이라 약 1시간 뒤 만료된다 —
    // 이걸 그대로 캐시(버킷)에 저장하면 나중에 깨진 이미지가 된다. external.url(고정 링크)만
    // 영구 저장하고, file인 경우엔 id만 저장해 표시 시점에 /api/image로 매번 새로 발급받는다.
    const external = v.external?.url || null;
    if (!external && !v.file) return null;
    return { type: 'image', id: b.id, external, caption: richText(v.caption) };
  }
  if (type === 'table') return { type: 'table', width: v.table_width || 0, headerRow: !!v.has_column_header, rows: [] };
  if (Array.isArray(v.rich_text)) {
    const rich = richText(v.rich_text);
    if (!rich.some((x) => x.t)) return null; // 빈 줄
    const out = { type, id: b.id, rich }; // id — 형광펜 토글을 Notion 블록에 되쓸 때 필요(PARSER_VERSION 3)
    if (type === 'to_do') out.checked = !!v.checked;
    if (type === 'code') out.language = v.language || null;
    return out;
  }
  return null;
}

/* ── 형광펜(인라인 코드 annotation) 토글 ──────────────────────
   본문에서 드래그 선택한 구간의 code 여부를 뒤집는다. 이미 code인 부분과 아닌 부분이
   섞여 있으면(예: 절반만 형광펜) "새로 칠하기"로 본다 — 이미 칠해진 부분은 그대로 두고
   안 칠해진 부분만 칠한다(youtube_dual_subtitle 확장의 정책과 동일). 선택 전체가 이미
   code 하나로 덮여 있을 때만 "지우기"로 본다. */
function sliceRich(items, start, end) {
  const before = [], middle = [], after = [];
  let pos = 0;
  for (const it of items) {
    const runStart = pos, runEnd = pos + it.t.length;
    pos = runEnd;
    if (runEnd <= start) { before.push(it); continue; }
    if (runStart >= end) { after.push(it); continue; }
    const segs = [];
    if (runStart < start) segs.push([runStart, start, before]);
    const midS = Math.max(runStart, start), midE = Math.min(runEnd, end);
    if (midS < midE) segs.push([midS, midE, middle]);
    if (runEnd > end) segs.push([end, runEnd, after]);
    for (const [s, e, bucket] of segs) {
      const txt = it.t.slice(s - runStart, e - runStart);
      if (txt) bucket.push({ ...it, t: txt });
    }
  }
  return { before, middle, after };
}
function toggleCodeInRich(items, start, end) {
  const { before, middle, after } = sliceRich(items, start, end);
  if (!middle.length) return items;
  const allCode = middle.every((it) => it.code);
  const newMiddle = middle.map((it) => (allCode ? { ...it, code: false } : (it.code ? it : { ...it, code: true })));
  return [...before, ...newMiddle, ...after].filter((it) => it.t.length);
}
function toNotionRichText(rich) {
  return (rich || []).map((t) => ({
    type: 'text',
    text: { content: t.t, ...(t.href ? { link: { url: t.href } } : {}) },
    annotations: { bold: !!t.bold, italic: !!t.italic, strikethrough: !!t.strike, underline: !!t.underline, code: !!t.code, color: 'default' },
  }));
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
 * 그 "한 줄"이 1단계 힌트가 된다 — 화면엔 힌트+해설을 한 번에 이어 붙여 보여준다.
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
 * 반환: { done, processed, total } — done이 false면 한 번 더 부르면 된다.
 */
async function syncStep(env, token, dbId) {
  const budget = { used: 0, max: SUB_BUDGET };
  let st = JSON.parse((await env.KV.get(K_STATE)) || 'null');

  // 새 동기화 시작 — 스키마 + 행 목록을 먼저 확보한다(카드 본문은 아직 안 읽음).
  if (!st) {
    const schema = await discoverSchema(token, dbId, budget);
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
  // state에 계속 들고 있어도 안전하다.
  if (!st.prevIndex) {
    st.prevIndex = await loadPrevIndex(env, budget);
  }

  // 증분: 수정되지 않은 행은 옛 버킷에서 그대로 복사해 Notion 본문을 다시 읽지 않는다.
  let curOldBucket = null; // {num, byId} — 이 호출 안에서만 쓰는 임시 캐시
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
      st.items.push({ id: row.id, key: card.key, front: row.front, url: row.url, edited: row.edited, created: row.created, bucket: st.bucket.num });
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
  } else {
    await env.KV.put(K_STATE, JSON.stringify(st));
  }
  return { done, processed: st.i, total: st.rows.length, reused, subrequests: budget.used };
}

const rt = (arr) => (arr || []).map((t) => t.plain_text || '').join('');

/* ── 챕터 구조 ───────────────────────────────────────────────
   전체 카드를 생성일자 오름차순으로 정렬해 10장씩 소챕터, 10개 소챕터(=100장)씩
   대챕터로 나눈다. 마지막 챕터/소챕터는 100/10장이 안 채워질 수 있다(의도된 동작,
   나중에 처리 방식을 다시 볼 예정 — CLAUDE.md 참고). 게이트(잠금)는 없다 — 모든
   챕터/소챕터는 처음부터 자유 열람, 점수는 순수 진행 현황판이다. */

function sortedByCreated(items) {
  return [...items].sort((a, b) => new Date(a.created) - new Date(b.created));
}
function chunk(arr, size) {
  const out = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}
function buildChapters(items) {
  const subs = chunk(sortedByCreated(items), SUB_SIZE);
  return chunk(subs, CHAP_SIZE); // chaps[chapIdx][subIdxInChap] = 인덱스 항목 배열(최대 10)
}
function knownCountFor(items, known) {
  return items.filter((it) => known[it.key]).length;
}
function parseSubId(id) {
  const m = /^c(\d+)s(\d+)$/.exec(String(id || ''));
  return m ? { chap: Number(m[1]), sub: Number(m[2]) } : null;
}
function parseChapId(id) {
  const m = /^c(\d+)$/.exec(String(id || ''));
  return m ? Number(m[1]) : null;
}

async function loadKnownAndBest(env) {
  const known = JSON.parse((await env.KV.get(K_KNOWN)) || '{}');
  const best = JSON.parse((await env.KV.get(K_BEST)) || '{}');
  if (!best.sub) best.sub = {};
  if (!best.chap) best.chap = {};
  return { known, best };
}

/* ── 라우팅 ──────────────────────────────────────────────── */

const json = (o, status = 200) =>
  new Response(JSON.stringify(o), { status, headers: { 'Content-Type': 'application/json; charset=utf-8' } });

async function handleChapters(env) {
  const idxRaw = await env.KV.get(K_INDEX);
  const st = JSON.parse((await env.KV.get(K_STATE)) || 'null');
  if (!idxRaw) return json({ chapters: [], total: 0, syncing: true, progress: st ? { processed: st.i, total: st.rows.length } : null }, 202);

  const idx = JSON.parse(idxRaw);
  const { known, best } = await loadKnownAndBest(env);
  const chaps = buildChapters(idx.items);

  let pos = 0;
  const chapters = chaps.map((subs, ci) => {
    const items = subs.flat();
    const id = 'c' + ci;
    const start = pos + 1;
    pos += items.length;
    return { id, start, end: pos, total: items.length, current: knownCountFor(items, known), best: best.chap[id] || 0 };
  });

  return json({ chapters, total: idx.items.length, syncing: !!st, builtAt: idx.builtAt });
}

async function handleChapterDetail(env, chapId) {
  const ci = parseChapId(chapId);
  if (ci == null) return json({ error: 'bad id' }, 400);
  const idxRaw = await env.KV.get(K_INDEX);
  if (!idxRaw) return json({ error: '동기화 중' }, 202);

  const idx = JSON.parse(idxRaw);
  const { known, best } = await loadKnownAndBest(env);
  const chaps = buildChapters(idx.items);
  const subsInChap = chaps[ci];
  if (!subsInChap) return json({ error: 'not found' }, 404);

  let pos = 0;
  for (let k = 0; k < ci; k++) pos += chaps[k].flat().length; // 이 챕터 시작 위치

  const chapId2 = 'c' + ci;
  const chapItems = subsInChap.flat();
  const subchapters = [];
  for (let si = 0; si < subsInChap.length; si++) {
    const items = subsInChap[si];
    const subId = chapId2 + 's' + si;
    const start = pos + 1;
    pos += items.length;
    subchapters.push({
      id: subId, start, end: pos, total: items.length,
      current: knownCountFor(items, known), best: best.sub[subId] || 0,
      cards: items.map((it) => ({ key: it.key, front: it.front, known: !!known[it.key] })),
    });
  }

  return json({
    id: chapId2, total: chapItems.length,
    current: knownCountFor(chapItems, known), best: best.chap[chapId2] || 0,
    subchapters,
  });
}

// 학습·시험 공용 — 소챕터 카드의 전체 본문을 반환한다(카드 10장뿐이라 미리 다 실어 보내도
// 가볍다 — 시험 중 "안다" 리빌 때마다 다시 불러올 필요가 없다).
async function handleSubchapter(env, subId, mode) {
  const parsed = parseSubId(subId);
  if (!parsed) return json({ error: 'bad id' }, 400);
  const idxRaw = await env.KV.get(K_INDEX);
  if (!idxRaw) return json({ error: '동기화 중' }, 202);

  const idx = JSON.parse(idxRaw);
  const chaps = buildChapters(idx.items);
  const items = chaps[parsed.chap]?.[parsed.sub];
  if (!items) return json({ error: 'not found' }, 404);

  const { known } = await loadKnownAndBest(env);
  const byBucket = new Map();
  for (const it of items) {
    if (!byBucket.has(it.bucket)) byBucket.set(it.bucket, []);
    byBucket.get(it.bucket).push(it.id);
  }
  const byId = new Map();
  for (const [num, ids] of byBucket) {
    const raw = await env.KV.get(K_BUCKET + num);
    if (!raw) continue;
    for (const c of JSON.parse(raw).cards) if (ids.includes(c.id)) byId.set(c.id, c);
  }
  let cards = items.map((it) => ({ ...(byId.get(it.id) || {}), id: it.id, key: it.key, front: it.front, url: it.url, created: it.created, known: !!known[it.key] }));
  if (mode === 'unknown') cards = cards.filter((c) => !c.known);

  return json({ id: subId, cards });
}

// 대챕터 전체 시험(100문제) — 소챕터 시험과 같은 화면/로직을 재사용하되, 카드가 10개
// 소챕터에 걸쳐 섞이므로 각 카드에 원래 소속 subId를 붙여 보낸다. 클라이언트는 카드별로
// 그 subId로 POST /api/answer를 호출해야 소챕터별 최고기록도 같이 갱신된다.
async function handleChapterExam(env, chapId) {
  const ci = parseChapId(chapId);
  if (ci == null) return json({ error: 'bad id' }, 400);
  const idxRaw = await env.KV.get(K_INDEX);
  if (!idxRaw) return json({ error: '동기화 중' }, 202);
  const idx = JSON.parse(idxRaw);
  const chaps = buildChapters(idx.items);
  const subsInChap = chaps[ci];
  if (!subsInChap) return json({ error: 'not found' }, 404);

  const byBucket = new Map();
  const tagged = []; // { it, subId }
  subsInChap.forEach((items, si) => {
    const subId = chapId + 's' + si;
    for (const it of items) {
      tagged.push({ it, subId });
      if (!byBucket.has(it.bucket)) byBucket.set(it.bucket, []);
      byBucket.get(it.bucket).push(it.id);
    }
  });
  const byId = new Map();
  for (const [num, ids] of byBucket) {
    const raw = await env.KV.get(K_BUCKET + num);
    if (!raw) continue;
    for (const c of JSON.parse(raw).cards) if (ids.includes(c.id)) byId.set(c.id, c);
  }
  const cards = tagged.map(({ it, subId }) => ({ ...(byId.get(it.id) || {}), id: it.id, key: it.key, front: it.front, url: it.url, created: it.created, subId }));

  return json({ id: chapId, cards });
}

// 시험 정답 기록 — 소챕터·대챕터의 현재 점수를 다시 계산하고, 최고기록을 필요하면 올린다
// (단조증가 — 나중에 다시 도전해서 점수가 낮아져도 최고기록은 안 내려간다).
async function handleAnswer(env, body) {
  const { subId, key, know } = body || {};
  if (!subId || !key || typeof know !== 'boolean') return json({ error: 'subId/key/know 필요' }, 400);
  const parsed = parseSubId(subId);
  if (!parsed) return json({ error: 'bad subId' }, 400);

  const idxRaw = await env.KV.get(K_INDEX);
  if (!idxRaw) return json({ error: '동기화 중' }, 202);
  const idx = JSON.parse(idxRaw);
  const chaps = buildChapters(idx.items);
  const subItems = chaps[parsed.chap]?.[parsed.sub];
  if (!subItems) return json({ error: 'not found' }, 404);
  const chapItems = chaps[parsed.chap].flat();

  const { known, best } = await loadKnownAndBest(env);
  if (know) known[key] = true; else delete known[key];
  await env.KV.put(K_KNOWN, JSON.stringify(known));

  const chapId = 'c' + parsed.chap;
  const subScore = knownCountFor(subItems, known);
  const chapScore = knownCountFor(chapItems, known);
  best.sub[subId] = Math.max(best.sub[subId] || 0, subScore);
  best.chap[chapId] = Math.max(best.chap[chapId] || 0, chapScore);
  await env.KV.put(K_BEST, JSON.stringify(best));

  return json({
    ok: true,
    sub: { id: subId, current: subScore, best: best.sub[subId], total: subItems.length },
    chap: { id: chapId, current: chapScore, best: best.chap[chapId], total: chapItems.length },
  });
}

// 본문에서 드래그 선택한 예문을 카드 제목(=노션 이름 속성)으로 바꾼다. 원본 DB가
// AI 질의응답 기준으로 만들어져 있어(단어만 있거나, 한글 질문이 그대로 제목이 된 행이
// 섞여 있음) 노션에서 1,323건을 손으로 고치는 대신 앱 쓰다가 그때그때 고치자는 결정
// (2026-09-05). 미러가 아니라 원본 자체를 고치는 것 — 되돌리기 없음(오타 교정이라
// 신중하게 한 번에 하는 걸 전제, 잘못 고쳤으면 다시 드래그해서 고치면 됨).
async function handleRetitle(env, token, body) {
  const { pageId, oldKey, newTitle } = body || {};
  const title = String(newTitle || '').trim();
  if (!pageId || !oldKey || !title) return json({ error: 'pageId/oldKey/newTitle 필요' }, 400);

  const idxRaw = await env.KV.get(K_INDEX);
  if (!idxRaw) return json({ error: '동기화 중' }, 202);
  const idx = JSON.parse(idxRaw);
  const item = idx.items.find((it) => it.id === pageId);
  if (!item) return json({ error: 'not found' }, 404);

  const newKey = cardKey(title);

  // 1) Notion — 제목(이름) 속성 자체를 고친다. 실패해도 로컬은 진행(마찰 최소화 —
  //    화면엔 바로 반영돼야 함), notionOk로 정직하게 알린다.
  let notionOk = false;
  if (idx.schema?.title && token) {
    try {
      await notion(token, `/pages/${pageId}`, {
        method: 'PATCH',
        body: JSON.stringify({ properties: { [idx.schema.title]: { title: [{ text: { content: title } }] } } }),
      });
      notionOk = true;
    } catch (e) { /* 삼키고 notionOk:false로 정직하게 알린다 */ }
  }

  // 2) 인덱스 + 3) 해당 버킷의 카드 갱신
  item.front = title; item.key = newKey;
  await env.KV.put(K_INDEX, JSON.stringify(idx));
  const raw = await env.KV.get(K_BUCKET + item.bucket);
  if (raw) {
    const bucket = JSON.parse(raw);
    const card = bucket.cards.find((c) => c.id === pageId);
    if (card) { card.front = title; card.key = newKey; await env.KV.put(K_BUCKET + item.bucket, JSON.stringify(bucket)); }
  }

  // 4) 이미 "안다"로 판정돼 있었다면 새 키로 이어받는다(표기만 바뀐 같은 카드이므로).
  const { known } = await loadKnownAndBest(env);
  if (known[oldKey]) { delete known[oldKey]; known[newKey] = true; await env.KV.put(K_KNOWN, JSON.stringify(known)); }

  return json({ ok: true, key: newKey, front: title, notionOk });
}

// 형광펜 토글 — 본문 블록(hint 또는 detail[i])의 rich-text에서 [start,end) 구간의 code
// 여부를 뒤집고, KV(버킷)와 Notion 블록(진짜 원본, 미러 아님) 양쪽에 반영한다.
async function handleHighlight(env, token, body) {
  const { pageId, field, blockIndex, start, end } = body || {};
  if (!pageId || (field !== 'hint' && field !== 'detail') || typeof start !== 'number' || typeof end !== 'number' || start >= end) {
    return json({ error: 'pageId/field/start/end 필요' }, 400);
  }
  const idxRaw = await env.KV.get(K_INDEX);
  if (!idxRaw) return json({ error: '동기화 중' }, 202);
  const idx = JSON.parse(idxRaw);
  const item = idx.items.find((it) => it.id === pageId);
  if (!item) return json({ error: 'not found' }, 404);
  const raw = await env.KV.get(K_BUCKET + item.bucket);
  if (!raw) return json({ error: 'not found' }, 404);
  const bucket = JSON.parse(raw);
  const card = bucket.cards.find((c) => c.id === pageId);
  if (!card) return json({ error: 'not found' }, 404);

  const block = field === 'hint' ? card.hint : card.detail?.[blockIndex];
  if (!block || !Array.isArray(block.rich)) return json({ error: '이 블록은 형광펜을 지원 안 함' }, 400);

  block.rich = toggleCodeInRich(block.rich, start, end);
  await env.KV.put(K_BUCKET + item.bucket, JSON.stringify(bucket));

  let notionOk = false;
  if (block.id && token) {
    try {
      const payload = { [block.type]: { rich_text: toNotionRichText(block.rich) } };
      if (block.type === 'to_do') payload.to_do.checked = !!block.checked;
      await notion(token, `/blocks/${block.id}`, { method: 'PATCH', body: JSON.stringify(payload) });
      notionOk = true;
    } catch (e) { /* 삼키고 notionOk:false로 정직하게 알린다 */ }
  }

  return json({ ok: true, card, notionOk });
}

// Notion 자체 호스팅 이미지(file.url)는 프리사인드 URL이라 캐시해두면 만료된다 —
// 표시 시점에 그 블록을 다시 조회해 방금 발급된 URL로 302 리다이렉트한다.
async function handleImage(env, token, blockId) {
  if (!blockId || !token) return json({ error: 'id 필요' }, 400);
  try {
    const data = await notion(token, `/blocks/${blockId}`);
    const fresh = data.image?.file?.url || data.image?.external?.url;
    if (!fresh) return json({ error: '이미지 없음' }, 404);
    return Response.redirect(fresh, 302);
  } catch (e) {
    return json({ error: String(e.message || e) }, 502);
  }
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const { NOTION_TOKEN: token, NOTION_DB_ID: dbId } = env;

    if (url.pathname === '/api/chapters') return handleChapters(env);
    if (url.pathname === '/api/image') return handleImage(env, token, url.searchParams.get('id') || '');
    if (url.pathname === '/api/chapter') return handleChapterDetail(env, url.searchParams.get('id') || '');
    if (url.pathname === '/api/subchapter') return handleSubchapter(env, url.searchParams.get('id') || '', url.searchParams.get('mode') || 'all');
    if (url.pathname === '/api/chapterexam') return handleChapterExam(env, url.searchParams.get('id') || '');
    if (url.pathname === '/api/answer' && request.method === 'POST') {
      try { return await handleAnswer(env, await request.json()); }
      catch (e) { return json({ error: String(e.message || e) }, 500); }
    }
    if (url.pathname === '/api/retitle' && request.method === 'POST') {
      try { return await handleRetitle(env, token, await request.json()); }
      catch (e) { return json({ error: String(e.message || e) }, 500); }
    }
    if (url.pathname === '/api/highlight' && request.method === 'POST') {
      try { return await handleHighlight(env, token, await request.json()); }
      catch (e) { return json({ error: String(e.message || e) }, 500); }
    }

    if (url.pathname === '/api/sync') {
      if (!token || !dbId) return json({ error: 'NOTION_TOKEN / NOTION_DB_ID 미설정' }, 500);
      if (url.searchParams.get('restart') === '1') await env.KV.delete(K_STATE);
      try { return json(await syncStep(env, token, dbId)); }
      catch (e) { return json({ error: String(e.message || e) }, 502); }
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
