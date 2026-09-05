완료: 2026-09-05 17:20

# Shorts Deck 컨트롤 디자인 베이크오프 이어하기

생성: 2026-09-05 15:45
갱신: 2026-09-05 (같은 날, 후속 세션) — 아래 "진행 상황 갱신" 참고, 그 아래 원본은 그대로 둠

## 진행 상황 갱신 (여기부터 읽을 것)

"아직 안 한 것" 1~3번 완료함. 4번(피드백 받아 수렴)만 남음.

- Artifact 게시 완료: **https://claude.ai/code/artifact/99f20041-882b-4b15-a12e-5cc85a5e21e7**
  ("숏츠덱 컨트롤 시안") — 게이트웨이 이미지 2장(느낌 참고용) + 라이브 CSS 콘셉트 3개
  (라벨형/입체 아이콘형/초절제형) + 현재 기준안, 4가지 대상(필터·안다버튼·링칩·챕터행)
  전부 한 페이지에서 비교 가능하게 구성.
- 자체확인(전역 규칙 11-d) 과정에서 실제 버그 하나 발견·수정함 — 초절제형(콘셉트3) 하단
  바에서 필터+안다버튼+아이콘 2개 폭 합이 폰 프레임(296px)을 넘어 마지막 아이콘이
  잘리던 문제. `.know3`를 고정 폭(58%)에서 `flex:1`(남는 공간 채움)로 바꾸고 나머지
  요소 폭을 줄여 해결 — 코드에 반영된 최종 버전이 위 URL에 있음.
- 아이콘 재질 탐색 이미지 확인 중 발견: 두 게이트웨이(Gemini/GPT) 세트 모두 "전체"와
  "메뉴" 아이콘이 둘 다 가로선 뭉치라 구분이 잘 안 됨 — 아티팩트 00 섹션에 확인 요청
  문구로 남겨둠. 라이브 콘셉트에서는 이 둘을 형태로 확실히 갈라뒀음.
- **다음 세션이 할 일:** 사용자가 위 Artifact를 보고 준 피드백을 받아 4가지 요소를
  요소별로(콘셉트 섞어도 됨, 아티팩트에 그렇게 안내해둠) 하나씩 확정 → 최종 스펙을
  `~/.claude/design-system/projects/shorts-deck.md`에 기록 → `public/index.html`에
  실제 CSS/마크업 반영 → 커밋 + `npx wrangler deploy`(프로젝트 폴더 안에서 실행).
  사용자가 이미 피드백을 줬는데 세션이 끊겨 여기로 왔다면, 그 피드백부터 반영.

---

## 원본 (첫 작성 시점 — 배경 설명용, "아직 안 한 것" 1~3은 위에서 이미 완료됨)

## 지금까지 상황
아이폰 실기기 피드백을 몇 라운드 거치며 앱을 크게 재작업함(오늘 하루 동안 챕터/시험
구조 전면 재설계 → 홈=학습화면 직행 재구조 → 안다/보관/휴지통 퀵버튼 추가 → 이미지
블록 파싱 버그 수정까지 전부 커밋+배포 완료). 마지막으로 사용자가 UI 디테일 피드백을
줬고, 그중 아이콘/버튼크기/칩크기/챕터행레이아웃 4가지를 "개별로 고치지 말고 디자인
베이크오프로 한 번에" 하자고 명시적으로 요청함. deep-interview 없이 바로 스코프가
정해진 상태(사용자가 4가지 대상을 대화 중 하나씩 스스로 추가함).

## 베이크오프 대상 (4가지, 전부 같은 라운드에서 같이 다룸)
1. 하단 바 아이콘 3종 — 전체보기/모르는것만 필터(지금 ●/○라 헷갈린다는 피드백),
   형광펜 모드, 챕터목록(☰)
2. "안다" 퀵버튼 — 지금 하단 바의 절반 이상을 차지, 사용자가 "70% 정도로 줄여도
   될듯"이라 함
3. 상단 "1-1"(챕터-소챕터 주소) 원형 진행률 링 칩 — "지금의 절반 정도로 줄여도 될듯"
4. 하단 시트(모달)의 챕터 목록 행 — 지금 [챕터N 범위]---[현재/최고점수] 줄 아래에
   [여기로 이동][전체시험] 버튼이 별도 줄로 있어 세로로 김. 사용자 요청: "챕터N"과
   "현재/최고점수" 사이 빈 공간에 그 두 버튼을 우겨넣어 한 줄로 합치고 싶어함(그러면
   시트에 더 많은 챕터가 한 번에 보임)

## 사용자가 명시한 디자인 원칙
- "일단은 사전제약 두지 말고 최대한 많은 시안을 보여줘"
- "최대한 핵심 기능에 집중하여 디자인해줘" (장식보다 기능 인지성)
- GPT 이미지가 과거 라운드에서 다른 엔진 시안과 스타일이 너무 동떨어지게 나온 적
  있다는 피드백 — 이번엔 편차를 줄이도록 신경써달라 요청

## 이미 진행한 것 (재사용할 것)
- `~/.claude/design-system/projects/shorts-deck.md` 확인함 — **중요 발견**: 이 프로젝트의
  정밀 UI(격자·숫자·레이아웃)에서 AI 게이트웨이 이미지가 이미 두 번 다 탈락한 이력
  있음(레이아웃 결함·공간낭비). 그래서 이번엔 레이아웃 정밀도가 중요한 3번(링 크기)·
  4번(챕터 행)은 Claude 라이브 CSS로, 아이콘 "느낌" 탐색만(1번) 게이트웨이 이미지로
  좁혀서 진행하기로 판단·사용자에게 고지함(반박 없이 진행 승인된 상태로 봐도 됨 —
  다음 세션에서 재확인은 필요 없음, 이미 설명하고 진행 중이었음).
- `~/.claude/design-system/preferences.md` 확인함 — 관련 시사점:
  - "아이콘은 평면 라인아트보다 음영이 들어간 입체(3D-ish) 스타일 선호"(가설, 1개 프로젝트)
  - "버튼은 아이콘 단독보다 아이콘+텍스트 결합 선호" — 필터 아이콘 헷갈림 문제에 직접 적용 가능
  - "토글/스위치는 점 하나보다 텍스트 라벨+체크마크 선호" — ●/○ 대신 라벨형 토글 방향 시사
  - "강조색은 의미있는 상태에만"(확인됨), "화려함보다 절제"(확인됨) — 기존 코랄 단일 강조 유지
- 게이트웨이 이미지 2장 이미 생성 완료(아이콘 세트만, gemini + gpt-image-2, 동일
  프롬프트로 스타일 편차 최소화 시도):
  - `C:\Users\7make\AppData\Local\Temp\claude\bakeoff\icons-gemini.png`
  - `C:\Users\7make\AppData\Local\Temp\claude\bakeoff\icons-gpt.png`
  - ⚠ 둘 다 **아직 Read 도구로 직접 열어서 확인 안 함**(전역 규칙 11-d 자체검증 — 다음
    세션에서 반드시 먼저 확인할 것, 라벨 깨짐이나 요청과 다르게 나온 게 있으면 재생성
    검토). 두 파일 다 임시 폴더라 세션이 오래 지나면 사라질 수 있음(OS 임시폴더 정리
    대상) — 다음 세션 시작 직후 먼저 존재 확인할 것. 없어졌으면 위 프롬프트 그대로
    재생성(같은 프롬프트 문구가 이 파일에 그대로 남아 있음).
  - 프롬프트 원문(재생성 시 그대로 재사용):
    "A minimal dark-mode icon set for a mobile app, arranged in a clean horizontal row
    on a dark navy background (#0B0D10). Exactly 5 icons, each with a small text label
    below in a clean sans-serif font: 1) 'All' - a simple stack or list glyph,
    2) 'Unfamiliar' - a flag or question-mark glyph, 3) 'Know' - a checkmark inside a
    rounded pill/badge shape, 4) 'Highlight' - a highlighter marker pen glyph,
    5) 'Menu' - a hamburger list glyph. Single accent color coral (#FF8F6B) used only
    on icon #3 'Know' to show it as the primary action, the rest in muted blue-gray
    (#8B95A3). Subtle flat-with-soft-shadow icon style with slight dimensional depth
    (not flat line-art, not glossy skeuomorphic). Consistent stroke weight across all
    icons. Clean icon design reference sheet on solid dark background, not a phone
    screenshot, no extra UI chrome."
  - 생성 명령(재생성 시): `python C:\Users\7make\.claude\skills\jbnu-gateway\scripts\image.py
    --prompt "<위 프롬프트>" --model gemini-2.5-flash-image --aspect 16:9 --out <경로>`
    (gpt-image-2는 `--size 1536x1024`로 교체)

## 아직 안 한 것 (다음 세션이 할 일)
1. 위 두 게이트웨이 이미지 Read로 열어 확인(자체검증, 없어졌으면 재생성)
2. **Claude 라이브 CSS 콘셉트 3~4개** 작성 — 4가지 대상을 하나로 묶어서(전체 스타일
   일관성 보여주기 위해) 각 콘셉트가 실제 폰 프레임 안에서 상단 링칩+하단 바+시트
   챕터행을 전부 같이 보여주는 형태로. 예시 방향(자유롭게 더 늘려도 됨 — "최대한 많은
   시안" 요청):
   - 라벨형: 필터를 아이콘 없이 짧은 텍스트("전체"/"미완료")로, 안다버튼은 체크+텍스트
   - 입체 아이콘형: preferences.md 가설 반영, 은은한 그림자/그라디언트 아이콘
   - 초절제형: 배경 없는 텍스트/밑줄 위주, 링 칩도 아예 다른 형태(막대바 등)로 파격 시도
   - 실제 코드(`public/index.html`)의 현재 CSS 변수(`--ink`~`--ink4`, `--coral`,
     `--know`, 폰트 변수)를 그대로 재사용해서 만들 것 — 색은 이미 확정된 팔레트 안에서만
3. 게이트웨이 이미지 2장(리사이즈+JPEG압축, PIL로 폭~800px) + 라이브 CSS 콘셉트를
   `artifact-design` 스킬 로드 후 Artifact로 조립. 각 후보에 A1/B1 같은 ID 붙이고
   "요소별로 섞어 골라도 된다" 안내 포함.
4. 사용자 피드백 받아 6단계(한 축씩 좁히기)로 수렴 → 최종 스펙을
   `~/.claude/design-system/projects/shorts-deck.md`에 추가 기록 → 코드(`public/index.html`)
   반영 → 커밋 + `npx wrangler deploy`(프로젝트 폴더 안에서 실행할 것 — 다른 데서 돌리면
   EPERM 에러).

## 그 외 이 세션에서 이미 끝낸 것(참고만, 다시 손댈 필요 없음)
- 챕터/시험 구조 전면 재설계, 홈=학습화면 직행 재구조, 안다/보관/휴지통 기능,
  이미지 블록 파싱 버그, 시트 핸들 touch-action 버그 — 전부 커밋+배포 완료.
  `CLAUDE.md` 최상단 "현재 상태" 섹션에 상세 기록됨(다음 세션이 프로젝트 배경
  파악하려면 그것부터 읽을 것 — 이 인계 파일은 "디자인 베이크오프 이어하기" 전용).
- 프로덕션 재동기화(이미지 지원용)는 완료 확인함.
- 배포 URL: https://shorts-deck.shorts-deck.workers.dev (Cloudflare 계정 7maker@gmail.com)
