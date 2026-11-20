# AGENTS.md

친구들의 가능 일정 수집 → 날짜 선택 → 지역 투표 → 음식점·카페 링크 공유를 제공하는 한국어 모바일 웹이다. 파일별 책임은 `README.md` "코드 위치", 실행은 "실행"과 "실제 서비스와의 차이"를 본다. 설명이 코드와 어긋나면 코드를 기준으로 하고 문서를 함께 고친다.

## 실행 도구

- Node.js 22.13 이상(`package.json` `engines`)과 npm을 쓰고 `package-lock.json`을 유지한다. 모든 명령은 저장소 루트에서 실행한다.
- 실제 실행 도구는 Vinext + Vite + Cloudflare Workers + D1이다. `app/` 구조와 `next.config.ts`가 있어도 `next dev`·`next build`로 바꾸지 않는다.
- D1 바인딩 이름은 `DB`다. `.openai/hosting.json`, `vite.config.ts`, `app/api/meeting/route.ts`에서 같은 이름을 쓴다.
- `npm run build` 뒤 `npm run start`는 로컬 Wrangler 실행이지 배포가 아니다. 저장소에 `deploy` 스크립트는 없고, 원본 Sites 앱을 지우지 않는다.
- Vercel은 `api/gateway.js`를 실행하는 게이트웨이일 뿐이다. 역할과 설정은 `VERCEL.md`를 본다.

## 검증

CI(`.github/workflows/test.yml`)와 같은 순서로 돌린다. 준비 명령은 `README.md` "자동 테스트"를 본다.

```sh
npm run typecheck
npm run lint:all
npm run test:all
```

- 자동 테스트 서버는 127.0.0.1:4317 고정 포트와 실행별 임시 D1을 쓴다. 포트가 사용 중이어도 다른 프로세스를 끄지 않는다. 자세한 동작은 `README.md` "자동 테스트"를 본다.
- Vercel 게이트웨이를 바꾸면 `node --check api/gateway.js`와 `node scripts/build-vercel.mjs`를 더 돌린다. 프록시 동작은 따로 확인한다.
- 문서만 바꾸면 명령·경로를 실제 파일과 대조하고 `git diff --check`를 돌린다. 새 파일은 stage한 뒤 `git diff --cached --check`로 본다.
- 포맷은 `.oxfmtrc.json`을 따르고, `npx oxfmt <파일>`로 바꾼 파일만 포맷한다.
- 타입·린트·빌드 통과를 실제 브라우저·D1 저장·다중 사용자 동작의 검증이라고 말하지 않는다. 실행하지 못한 검사는 이유와 함께 적는다.
- 공유 상태·권한·상태 전환을 바꾸면 해당 흐름을 서로 다른 두 계정·세션으로 확인한다.
- D1 오류는 `DB` 바인딩과 로컬 실행 경로부터 본다. 로컬 API POST를 직접 보낼 때는 같은 `Origin`과 계정별 쿠키를 쓴다. 보안 검사를 지워서 통과시키지 않는다.
- 검사 결과와 미검증 범위는 PR마다 `VALIDATION.md` 맨 위에 새 절로 남긴다.

## 바뀌면 안 되는 계약

### 상태와 저장

- 서버 D1이 계정·모임의 원본이다. `seedRoom()` 같은 체험용 함수가 있어도 localStorage나 샘플 데이터로 대체하지 않는다.
- 클라이언트는 action을 보내고 서버가 `applyAction()`(`lib/room-actions.ts`)으로 적용한다. 클라이언트의 `Room` 전체를 그대로 저장하지 않는다.
- 모델을 바꾸면 기존 저장 데이터와 선택 필드의 기본값을 고려한다. `CREATE TABLE IF NOT EXISTS`만으로 기존 스키마는 바뀌지 않는다.
- 모임 수정의 `version` 조건부 UPDATE와 충돌 시 재조회·재적용을 유지한다. 최초 시도를 포함해 최대 8회 시도한다.
- 4초 폴링(`hooks/use-meeting-sync.ts`)의 `pending`·`generation` 검사를 유지한다. 늦은 조회 응답이 방금 저장한 결과를 덮지 않아야 한다.

### 일정과 투표

- 날짜 기준은 한국 시간(Asia/Seoul)이다. 일정 슬롯은 `YYYY-MM-DD|점심` 또는 `YYYY-MM-DD|저녁`이다. UTC 날짜 절삭으로 바꾸지 않는다.
- 정원은 2–10명, 기간은 양 끝을 포함해 7–31일이다. 현재 멤버 수가 정원과 같고 모두 제출하면 마감된다. 빈 일정 제출도 제출로 센다.
- `members`는 모임 구성원, `attendees`는 선택된 일정의 참석자다. 지역 투표는 참석자만 하며 비참석 방장도 예외가 아니다. 후보 추가는 1차 투표 중 구성원 누구나 할 수 있다.
- 1차 지역 투표는 1–2개, 재투표는 동률 후보 중 1개를 고른다. 서버는 `round`와 `regionRevision`을 함께 확인해 지난 투표를 거절한다.
- 참석 확인 요청도 `regionRevision`을 담는다. 서버는 생략된 값을 0으로 보고 방의 값과 비교한다. 참석 확인 제출과 `confirm` 중 멤버 탈퇴·강퇴 뒤, 남은 멤버가 모두 응답했고 참석자가 2명 이상이면 지역 투표로 넘어간다.
- `reopenDate`는 `confirm`·`region`·`tie` 단계의 방장만 실행한다. 일정 응답과 지역 후보는 유지하고, 선택 날짜·참석 확인·지역 투표 결과를 초기화하며 `regionRevision`을 올린다.
- 방은 날짜 확정 시 약속일 +2일, 미확정 시 기간 종료일 +1일의 한국 시간 00:00에 만료되고, 이후 API 요청에서 지운다. GET도 `initialize()`를 부르므로 조회가 DB 읽기 전용이라고 가정하지 않는다.

### 인증과 게이트웨이

- 권한은 세션의 사용자와 서버의 멤버·방장 검사로 정한다. UI 버튼을 숨기는 것으로 대신하지 않는다.
- PIN의 솔트·PBKDF2 해시, 로그인 시도 제한, 해시로 저장하는 세션 토큰, HttpOnly 쿠키를 유지한다. PIN·쿠키·토큰을 로그나 분석에 남기지 않는다.
- API와 게이트웨이의 동일 출처 POST 검사, 요청 크기 제한(20000자), `no-store` 응답을 유지한다. 게이트웨이는 고정 원본의 허용 경로에만 요청을 전달하고 `wwm_session` 쿠키만 넘긴다.
- GA4 이벤트를 바꾸면 `VERCEL.md` "GA4"를 함께 고친다. 초대 코드·닉네임·PIN·방 이름은 분석에 보내지 않는다.

## UI 원칙

- 기존 한국어 문구와 `app/globals.css`의 색상 토큰을 따른다. 360px·430px 화면에서 가로 넘침, 하단 고정 버튼, dialog 바텀시트, 포커스·Escape 동작을 확인한다.
- 화면은 자체 React/CSS와 네이티브 `dialog`로 만든다. 공식 TDS 패키지를 추가하지 않는다.
- TypeScript strict 설정과 파일의 코드 스타일을 따른다. `any`, 타입 검사 무시 주석, 의존성 추가로 문제를 숨기지 않는다.
- 요청한 범위만 바꾼다. `.gitignore`가 빼는 파일(환경 변수 파일, 로컬 D1, 빌드 산출물)은 커밋하지 않는다.
- 실행 방식이나 정책이 바뀌면 `README.md`·`VERCEL.md`의 해당 절도 고친다.

## 이슈

- 이슈·라벨 사용법은 `docs/agents/issue-tracker.md`와 `docs/agents/triage-labels.md`를 따른다.

## 커밋·브랜치

- 커밋 메시지 전체(제목·본문·트레일러)와 브랜치명에 대소문자와 관계없이 `codex`를 쓰지 않는다.
- 브랜치명은 변경 목적을 나타낸다(예: fix/stale-vote).
- 커밋 제목은 `타입: 한국어 설명` 형식이다. 타입은 `feat`·`fix`·`refactor`·`docs`·`test`·`chore` 중 하나다.
- 제목에는 무엇을, 본문에는 왜 바꿨는지 쓴다. 한 커밋에는 한 목적만 담는다.
- 검증 결과에는 실제로 실행한 검사만 쓰고, 로컬 확인·원격 CI·실제 배포를 구분한다.
