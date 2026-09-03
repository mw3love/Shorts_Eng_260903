# CLAUDE.md — Shorts Deck

노션에 쌓인 영어 표현을 유튜브 쇼츠처럼 한손 스와이프로 복습하는 웹앱.
이 파일은 git으로 따라다니므로 어느 PC에서 작업하든 동일하게 적용된다.

## 무엇을 푸는 프로젝트인가

크롬 확장 `youtube_dual_subtitle`이 유튜브 자막에서 고른 영어 표현 + AI 해설을
Notion DB `3. 영어 DB`에 자동 저장한다. **저장은 되는데 복습이 안 된다** —
2026-09-03 실측 시점에 21행 전부 `복습 횟수 = 0`, `상태 = 비어 있음`이었다.
Notion 안에도 `0차 완료`·`1차 완료` 뷰가 이미 있지만 한 번도 안 돌았다.
도구가 없어서가 아니라 **Notion에서 복습하는 게 재미없어서** 멈춘 것으로 본다.

그래서 목표는 "복습 기능"이 아니라 **조작감**이다. 참고 대상: Slidebox(한손 스와이프),
유튜브 쇼츠(무마찰 진행), 클래시 로얄(가변 보상).

## 상류 데이터 — Notion DB 실측 (2026-09-03)

DB: `3. 영어 DB` (`277763872455804ebc00cb991e8e3247`, 워크스페이스 `mw2love`)

| 속성 | 타입 | 쓰임 |
|---|---|---|
| 이름 | title | 카드 앞면(영어 문장). 자막 문장 우선 |
| URL | url | 원본 유튜브 링크 — 카드에서 바로 점프 |
| 복습 횟수 | number | 채점 시 +1 |
| 상태 | status | 채점 결과 기록 |
| 날짜 / 생성 일시 | date | 저장 시각 |
| 복습 완료 | button | ⚠ API로 쓸 수 없음 |
| 완료도 / 적당함 | 미확인 | 이름과 값이 같아 정체 불명 — 확인 필요 |

⚠ **속성 이름을 하드코딩하지 말 것.** `src/worker.js`의 `discoverSchema()`가
타입 + 이름 힌트로 찾는다. 크롬 확장도 같은 전략을 쓴다(사용자가 컬럼 이름을 바꿔도 안 깨짐).

### 카드 뒷면은 DB 컬럼이 아니라 "페이지 본문"에 있다

```
페이지 본문
├── 자막 문맥 (21장 중 12장)
├── 「영어표현 + 한국어 뜻」 한 줄     ← 1단계 힌트. 21/21 모든 카드에 존재
├── 해설 문단 (구성·의미·관통하는 이미지)
└── 표 (어원/예시)                    ← 2단계 전체 해설
```

이 구조 덕에 `탭 1회 = 뜻만` / `탭 2회 = 전체 해설`이 성립한다. 파싱은
`src/worker.js`의 `splitBody()`. 그래서 카드 하나를 만들려면 **행 조회 + 본문 조회 2회**가
필요하고, Notion은 평균 3 req/s라 실시간 조회가 불가능 → KV 캐시가 선택이 아니라 필수.

## 아키텍처 — 왜 이 모양인가

**Cloudflare Worker 하나가 앱과 API를 같은 출처에서 서빙한다.**

⚠ **`api.notion.com`은 `Access-Control-Allow-Origin`을 보내지 않는다**(2026-09-03 curl 실측).
브라우저 페이지는 Notion API를 직접 못 부른다. 크롬 확장이 되는 건 `host_permissions`로
CORS를 면제받기 때문이지 Notion이 허용해서가 아니다. 게다가 토큰을 프런트에 두면 털린다.
→ 순수 정적 호스팅(GitHub Pages 등)만으로는 이 앱이 성립하지 않는다.

**기각한 대안:** GitHub Pages + Actions. 무료 개인 계정은 private repo로 Pages 호스팅이
아예 불가하고, 유료로 올려도 게시된 사이트는 기본 public이다. 게다가 grade 쓰기 경로가
없어 결국 Worker를 또 붙여야 한다 — 컴포넌트 2개보다 1개가 낫다.

**Artifact를 프로덕션으로 쓸 수 없는 이유:** Artifact의 CSP가 외부 fetch를 차단한다.
`prototype.html`(Artifact로 게시됨)은 데이터를 인라인한 **조작감 테스트용 스냅샷**일 뿐이고,
실제 앱은 `public/index.html`이다. 둘은 별개 파일이며 자동 동기화되지 않는다.

## ⚠ pageId는 안정적인 키가 아니다

크롬 확장은 재저장(형광펜 추가 후 다시 저장)을 **"새 페이지 생성 + 옛 페이지 archive"**로
구현한다(Notion API에 본문 통째 교체가 없어서 — 함정 상세: `~/.claude/wiki/notion-페이지-덮어쓰기-재저장.md`).
그래서 **재저장할 때마다 pageId와 URL이 바뀐다.** 확장 코드 주석은 이걸
"단어장 페이지엔 사실상 무해"라고 적어 뒀는데, **복습 앱이 생기는 순간 그 가정이 깨진다** —
pageId를 키로 학습 이력을 저장하면 재저장 한 번에 그 카드의 이력이 통째로 사라진다.

→ 학습 이력의 키는 **정규화된 제목**(`cardKey()`)이다. pageId는 Notion에 쓸 때만 쓴다.

## 저장 위치 — 무엇을 어디에 두는가

| 데이터 | 위치 | 이유 |
|---|---|---|
| 학습 이력(grades) | Worker KV | 진실의 원본. 제목 키라 pageId churn에 면역 |
| 복습 횟수 / 상태 | Notion 속성 | best-effort 미러 — 기존 `0차 완료` 뷰가 살아남음 |
| 카드 캐시 | Worker KV (TTL 1h) | Notion 3 req/s 한도 회피 |
| 오프라인 캐시 | localStorage | ⚠ 보조일 뿐 — iOS는 영구성을 보장하지 않는다 |

⚠ **iOS PWA의 localStorage/IndexedDB를 진실의 원본으로 삼지 말 것.** 홈 화면 앱은
7일 만료를 면제받지만 Safari 방문기록 삭제·저장공간 부족 시 함께 지워진다.

## UX 규약 — 자동 채점 1제스처

grade를 고르게 하지 않는다. **행동에서 채점한다.**

- 뜻을 **안 보고** 위로 스와이프 → `이해`
- **탭해서 뜻을 본 뒤** 위로 스와이프 → `모름`
- 오른쪽 → `애매` (봤지만 사실 알았을 때의 정정)
- 왼쪽 → 이전 카드 (실수 취소)

위로만 계속 넘기면 되므로 결정 마찰이 0이다. 4방향을 매번 고르게 하면 카드마다
판단이 끼어들어 쇼츠 감각이 죽는다. **이 원칙을 깨는 변경은 하지 말 것.**

세션은 10장 유한 + `한 판 더`. 무한 스크롤로 만들면 넘긴 장수는 늘고 기억은 안 는다.
이전에 `모름`이던 카드는 덱 앞쪽에 섞여 금테 + `다시 만남` 칩으로 재등장한다.

⚠ **iOS Safari에는 진동/햅틱 API가 없다**(iOS 26.5에서 `<input switch>` 우회도 막힘).
보상 피드백은 색·모션·소리로만 설계한다. 햅틱이 꼭 필요해지면 그때 Capacitor로 감싼다
(Apple Developer $99/년 — 그 전엔 낼 이유 없음).

## 배포

```
npx wrangler kv namespace create KV     # 나온 id를 wrangler.toml에 기입
npx wrangler secret put NOTION_TOKEN    # 크롬 확장이 쓰는 것과 같은 integration 토큰
npx wrangler deploy
```

로컬 개발은 `.dev.vars`에 `NOTION_TOKEN=...` (gitignore됨) 후 `npm run dev`.
카드 캐시를 즉시 갱신하려면 `/api/cards?refresh=1`.

⚠ 그 integration이 대상 DB에 **연결**돼 있어야 한다. 안 되어 있으면 404가 뜬다.

## 파일

```
src/worker.js            API + 정적 서빙. Notion 접근은 전부 여기
wrangler.toml            Worker 설정. KV id는 배포 시 채울 것
package.json             npm run dev / deploy / kv:create
public/index.html        앱 본체 (스와이프·채점·점진 공개)
public/manifest.json     홈 화면 웹앱 메타 (standalone·세로 고정)
public/cards.seed.json   폴백 씨앗 21장. ⚠ 사본을 만들지 말 것 — 여기가 유일
prototype.html           Artifact 게시용 스냅샷. 앱과 별개, 동기화 안 됨
tools/build_cards.py     초기 1회 스크래퍼. 입력 파일은 repo에 없어 재실행 불가
```

⚠ `public/cards.seed.json`을 다른 폴더에 복사해 두지 말 것 — 한때 `data/`에 같은
사본이 있었고, 둘을 맞춰 줄 장치가 없어 어느 쪽이 진짜인지 알 수 없는 상태가 됐다.
씨앗을 다시 만들 일이 생기면 `tools/build_cards.py`가 `public/`에 직접 쓴다.
