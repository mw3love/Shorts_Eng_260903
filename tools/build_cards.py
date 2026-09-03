# -*- coding: utf-8 -*-
"""notion.site 공개 페이지에서 긁은 원문 → 앱이 먹는 cards.seed.json.

초기 1회용 기록물이다. 입력(cards-text.json·row-urls.json)은 repo에 없고,
평상시 카드 공급은 src/worker.js가 Notion API로 한다. 여기 남긴 이유는
splitBody 파싱 규칙의 출처를 보이기 위함 — 규칙을 바꾸면 worker.js와 함께 고칠 것."""
import json, re

HANGUL = re.compile(r'[\uac00-\ud7a3]')
LATIN_WORD = re.compile(r'[A-Za-z]{2,}')

texts = {c['id']: c['text'] for c in json.load(open('cards-text.json', encoding='utf-8'))['cards']}
rows = json.load(open('row-urls.json', encoding='utf-8'))

def parse(raw):
    lines = raw.split('\n')
    try:
        k = lines.index('상태')
    except ValueError:
        return None
    body = [l.strip() for l in lines[k + 2:]]
    body = [l for l in body if l and l != '\t']

    context = None
    if body and body[0].startswith('질문:'):
        body = body[1:]                      # AI에 던진 질문 — 카드엔 불필요
    elif body and not HANGUL.search(body[0]):
        context = body[0]                    # 자막 원문 문맥
        body = body[1:]

    # 1단계 힌트는 짧은 한 줄이어야 한다 — 긴 해설 문단이 먼저 걸리는 카드가 있어
    # 120자 이하를 우선 고른다(worker.js splitBody와 같은 규칙).
    cand = [i for i, l in enumerate(body[:4]) if HANGUL.search(l) and LATIN_WORD.search(l)]
    hi = next((i for i in cand if len(body[i]) <= 120), cand[0] if cand else None)
    hint = body[hi] if hi is not None else None
    detail = body[hi + 1:] if hi is not None else body
    return context, hint, detail

cards = []
for r in rows:
    raw = texts.get(r['id'])
    if not raw:
        continue
    p = parse(raw)
    if not p:
        continue
    context, hint, detail = p
    cards.append({
        'id': r['id'],
        'front': r['title'],
        'context': context,
        'hint': hint,
        'detail': detail,
        'url': r['url'],
    })

json.dump(cards, open('../public/cards.seed.json', 'w', encoding='utf-8'), ensure_ascii=False, indent=1)
print('cards:', len(cards))
print('hint 있음:', sum(1 for c in cards if c['hint']))
print('context 있음:', sum(1 for c in cards if c['context']))
print('detail 평균 줄수:', round(sum(len(c['detail']) for c in cards) / len(cards), 1))
