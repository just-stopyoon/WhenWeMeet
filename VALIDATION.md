# API·브라우저 자동 테스트 검증 기록

## 2026-11-22 wrangler 4.166.0 업그레이드

이슈 #16. 시작 커밋 `649a8fd`에서 만든 `chore/upgrade-wrangler` 브랜치의 `453156a`(의존성 업그레이드)와 `b68d9f3`(배포 설정 고정)을 macOS, Node 24.3.0, npm 11.4.2, Playwright 1.63.0에서 확인했습니다. 모두 로컬 결과이며 원격 CI·Vercel 게이트웨이·운영 Workers·실제 배포 검증이 아닙니다. 아래 "설정 변경 작업 트리"는 `453156a`에 `vite.config.ts` 변경(커밋 전, 뒤에 `b68d9f3`으로 커밋)을 얹은 상태입니다. 전체 검증만 `b68d9f3` 깨끗한 트리에서 돌렸습니다.

### 바꾼 것

| 패키지 | 전 | 후 |
| --- | --- | --- |
| `wrangler` | 4.92.0 | 4.166.0 |
| `@cloudflare/workers-types` | 4.20260515.1 | 5.20261121.1 |
| `@cloudflare/vite-plugin` | 1.37.1 | 1.70.1 |

- `wrangler` 4.166.0은 `@cloudflare/workers-types` ^5를 peer로 요구합니다. 4.x를 두면 npm이 설치를 거절합니다(ERESOLVE).
- 플러그인을 1.37.1로 두고 위 둘만 올리는 조합도 시험했습니다. 설치·타입 검사·빌드는 되고 빌드 산출물도 `649a8fd`와 같았습니다. 하지만 플러그인 1.37.1이 `dist/server/wrangler.json`에 쓰는 `legacy_env: true`를 `wrangler` 4.166.0이 `The "legacy_env" field is no longer supported` 오류로 거절해, 테스트 서버의 `wrangler d1 execute`와 `npm run start`가 뜨지 않았습니다. 공식 릴리스 기준으로 `legacy_env` 제거는 [`wrangler` 4.111.0](https://github.com/cloudflare/workers-sdk/releases/tag/wrangler@4.111.0), 끊긴 GET·HEAD 자동 재시도는 [4.129.1](https://github.com/cloudflare/workers-sdk/releases/tag/wrangler@4.129.1)입니다. [4.114.0](https://github.com/cloudflare/workers-sdk/releases/tag/wrangler@4.114.0)부터 자동 리다이렉트로 읽은 설정에는 예외가 있지만, 이 저장소는 `--config dist/server/wrangler.json`으로 설정을 명시하므로 이 경로에서는 둘을 같이 만족하는 버전이 없습니다. 패키지 문구 조사(npm 배포본 표본)로는 거절 문구가 4.110.0에 없고 4.115.0에 있었고, 재시도 코드는 4.125.0에 없고 4.130.0에 있었습니다. 실제로 실행한 버전은 4.92.0과 4.166.0뿐입니다.
- 플러그인 1.70.1은 지정이 없으면 `compatibility_date`를 자기 기본값(2026-11-17)으로, `upload_source_maps`를 true로 내보내고 서버 소스맵을 만듭니다. `vite.config.ts`의 `localBindingConfig`에 `compatibility_date: '2026-05-15'`와 `upload_source_maps: false`를 적어 이전 값을 고정했습니다. 앱 코드·테스트는 바꾸지 않았습니다.

### 실행한 검사

| 조건 | 명령 | 결과 |
| --- | --- | --- |
| 전체 검증 | `npm run typecheck` → `npm run lint:all` → `npm run test:all` (`b68d9f3`) | 셋 다 exit 0. 단위 50개 통과, Playwright 136개 통과(2.2분) |
| 빌드 산출물 비교 | `649a8fd` 임시 워크트리(`npm ci`)와 설정 변경 작업 트리에서 각각 `npm run build`, `dist/server/wrangler.json`·서버 `.map` 수 비교 | 아래 표의 차이만 있음. 변형(차이를 하나도 허용하지 않는 비교, 같은 작업 트리)은 exit 1 |
| 로컬 실행 | 설정 변경 작업 트리에서 `npm run build` → `npm run start` 뒤 `GET /`·`/api/meeting`·`/sw.js` | 2초 안에 응답. `/` 200, `/api/meeting` 200(`{"user":"","rooms":[]}`), `/sw.js` 404(`649a8fd`에 파일 없음). `.openai/hosting.json` `d1`은 `DB`, `vite.config.ts`의 `binding: d1`, 산출물 D1 바인딩 `DB` |
| 공백 | `git diff --check origin/main...HEAD` | 통과 |

빌드 산출물(`dist/server/wrangler.json`) 차이:

| 항목 | `649a8fd` 빌드 | 설정 변경 작업 트리 빌드 |
| --- | --- | --- |
| `compatibility_date` | 2026-05-15 | 2026-05-15 |
| `compatibility_flags`, `main`, `assets`, D1 `binding`·`database_name`·`database_id` | | 같음 |
| 서버 `.map` 파일 | 0개 | 0개 |
| `upload_source_maps` | 없음 | `false` |
| D1 `migrations_dir` | 없음 | `../../migrations` |
| `legacy_env` | `true` | 없음 |
| `agent_memory`, `connect`, `k2` / `exports` | 없음 | 빈 배열 / 빈 객체 |

### 업그레이드 전·후 재현

`scripts/test-server.mjs`(4317 포트, 임시 D1)를 띄우고, 다른 출처 POST(70000B, #13의 64KiB 상한을 넘김) 뒤 정적 청크(`layout-segment-context-*.js`)를 GET했습니다. 2.5초 안에 끝나지 않으면 "멈춤"으로 세고 다른 요청을 하나 보냈습니다. 같은 POST 뒤 같은 출처 POST(빈 닉네임 로그인, 정상이면 400)의 상태도 셌습니다. 각 20회입니다. 전은 `649a8fd` 임시 워크트리, 후는 설정 변경 작업 트리입니다.

| 측정 | 전 (4.92.0) | 후 (4.166.0) |
| --- | --- | --- |
| 청크 GET 멈춤 | 20/20 (2510–2523ms, 다른 요청 뒤에야 200) | 0/20 (2–5ms, 모두 200) |
| 다음 같은 출처 POST | 503 20/20 ("Your worker restarted mid-request…") | 400 20/20 |

판정 변형(멈춤 기준 1ms)은 더 이른 상태(`649a8fd`에 `package.json`·`package-lock.json` 업그레이드만 얹은 작업 트리, 4.166.0)에서 돌렸고 5/5를 멈춤으로 세어 exit 1이었습니다.

### npm audit

| lock | 결과 |
| --- | --- |
| `649a8fd` | 17건(낮음 1·중간 3·높음 10·치명 3) |
| 플러그인 1.37.1 유지 조합(쓰지 않음) | 17건(낮음 1·중간 5·높음 8·치명 3) |
| `b68d9f3` | 10건(중간 3·높음 4·치명 3) |

남은 10건은 vite, react-server-dom-webpack, tinypool 등 이번 범위 밖 패키지입니다.

### 미검증과 남은 위험

- 원격 PR CI(Linux)와 Linux에서의 재현율은 확인하지 않았습니다.
- 산출물에 새로 생긴 D1 `migrations_dir`, 명시된 `upload_source_maps: false`, 빈 필드가 Sites 배포에 영향이 없는지는 실제 배포로 확인하지 않았습니다. 운영·Vercel 게이트웨이도 보지 않았습니다.
- 업그레이드 후 재현에서 연결이 끊겼다가 재시도로 풀린 것인지, 처음부터 끊기지 않은 것인지는 계측하지 않아 구분하지 못했습니다.
- 4.92.0에서 관찰된 "연결이 끊긴 직후 `/` GET이면 wrangler 종료"는 다시 재지 않았습니다.
- 플러그인 안에 `wrangler` 4.164.0이 따로 설치됩니다. Vite 플러그인은 내부 4.164.0을 쓰고(빌드와 `npm run dev`의 Vite 개발 서버), `npm run start`·테스트 서버 CLI는 루트 4.166.0을 실행합니다.

## 2026-11-22 다른 출처 POST 거절 전 요청 본문 비우기

이슈 #13. 시작 커밋 `2643cce`에서 만든 `fix/cross-origin-body-drain` 브랜치에서 `6eee327`(첫 구현), `8ae779d`(검수 반영: 상한 스트림 읽기), `ec668ff`(재검수 반영: BYOB 정확 상한·reader 해제), `dc26cc5`(상한 테스트 보강)를 macOS, Node 24.3.0, Playwright 1.63.0에서 확인했습니다. 모두 로컬 결과이며 원격 CI·Vercel 게이트웨이·운영 Workers 검증이 아닙니다. 아래 "작업 트리"는 표시한 커밋에 커밋 전 변경을 얹은 상태입니다.

### 실행한 검사

| 조건 | 명령 | 결과 |
| --- | --- | --- |
| 전체 검증 | `npm run typecheck` → `npm run lint:all` → `npm run test:all` (`dc26cc5`, 이 문서 수정만 커밋 전) | 셋 다 exit 0. 단위 50개 통과, Playwright 136개 통과(2.2분). `ec668ff`에서도 같은 결과 |
| 회귀 테스트 수정 전 실패 | `npx playwright test --project=api tests/api/auth.spec.ts -g '본문이 큰 다른 출처'` (`2643cce` 작업 트리, 테스트만 추가) | exit 1. 첫 회차에서 `Expected: 413`, `Received: 503` |
| 상한 단위 테스트 수정 전 실패(1차) | `npm test` (`6eee327` 작업 트리, `discardBody`가 `arrayBuffer()` 동작) | 바이트 상한·시간 상한 테스트 2개가 5초 시간 초과로 실패 |
| 상한 단위 테스트 수정 전 실패(2차) | `npm test` (`f866de0` 작업 트리, 새 테스트와 `8ae779d`의 기본 reader 구현) | 7개 중 6개 실패: 이미 잠긴 본문에서 `TypeError: ReadableStream is locked`, 읽기 오류 뒤 `locked` true, 바이트 소스에 BYOB 요청이 오지 않아 읽은 바이트 0 |
| 공백 | `git diff --check origin/main...HEAD`, 새 파일은 stage 뒤 `git diff --cached --check` | 통과 |

새 테스트는 `tests/api/auth.spec.ts` "본문이 큰 다른 출처 요청을 거절한 뒤에도 다음 요청이 처리된다"(5000B 패딩을 넣은 5030B JSON 다른 출처 403 직후 20001자 POST가 413인지 20쌍)와 `tests/discard-body.test.ts` 8개(본문 없음, 상한 아래 EOF, 정확히 64KiB 뒤 멈춤, 1MiB 본문, 1B 뒤 멈춤, 읽기 오류, 이미 잠긴 본문, 바이트 스트림 아님)입니다. 단위 테스트는 각 경우에 읽은 바이트 수, 취소 여부, 끝난 뒤 `body.locked`를 단언합니다. 기존 테스트의 기대값·이름·fixture는 바꾸지 않았습니다.

### 비우는 방법 비교

진단 재현 루프(다른 출처 POST 바로 다음 같은 출처 POST, Node `fetch`, 본문은 지정 바이트의 JSON)로 다음 요청의 503 수를 셌습니다.

| 방법 (측정 상태) | 403 본문 0B·300B | 403 본문 5000B·20001B | 그 밖 |
| --- | --- | --- | --- |
| 수정 없음 (`2643cce` 작업 트리) | 0/200 | 199/200 | |
| `req.body?.cancel()` (`2643cce` 작업 트리) | 0/400 | 399/400 | |
| `req.arrayBuffer()` (`2643cce` 작업 트리, `6eee327`과 같은 코드) | 0/400 | 0/400 | |
| 청크 단위 상한 (`6eee327` 작업 트리, `8ae779d`와 같은 코드) | | 0/400 | 60000B·65536B 각 0/200, 70000B·131072B 각 200/200 |
| BYOB 정확 상한 (`f866de0` 작업 트리, `ec668ff`와 같은 코드) | | 0/400 | 60000B·65536B·65537B 각 0/200, 70000B 200/200 |
| 같은 코드, 403 응답도 셈 | | | 65535B·65536B·65537B 각 403 200/200, 다음 요청 503 0/200 |

`cancel()`은 효과가 없었습니다. 첫 검수에서 `arrayBuffer()`가 거절할 본문을 상한 없이 모으고 멈춘 요청의 403을 미룬다는 지적을 받아 64KiB(진단 크기 20001B와 20000자 본문 최대 60000B를 덮음)·1초 상한을 두었습니다. 재검수에서 상한 뒤에도 다음 청크를 통째로 읽고, 이미 잠긴 본문에서 400이 되고, reader를 해제하지 않는다는 지적을 받았습니다. 그래서 BYOB reader로 남은 예산만큼만 읽고, 획득 실패·바이트 스트림 아님은 건드리지 않고 403으로 돌아가며, 직접 잡은 reader는 항상 해제하도록 바꿨습니다. 로컬 workerd의 요청 본문도 BYOB 읽기를 지원합니다. 지원하지 않았다면 본문을 읽지 않고 돌아가 5000B에서 503이 났을 것입니다.

### 변형 실험

변형을 하나씩 적용했습니다. 변형 전과 되돌린 뒤 모두 `test -z "$(git status --porcelain --untracked-files=all)"`가 성공했습니다. 상한 변형은 `93cf835`(코드는 `ec668ff`와 같음)에서 돌렸고, 남은 예산 관련 두 변형은 `dc26cc5`의 테스트를 얹은 작업 트리에서 돌렸습니다.

| 변형 (`lib/discard-body.ts`) | `npm test` 결과 |
| --- | --- |
| 바이트 계산 제거(`left -=` 삭제) | exit 1. "상한보다 큰 본문" 1048576B 읽음, "정확히 상한만큼" 1002ms로 시간 초과까지 기다림 |
| 남은 예산 무시(항상 16KiB 버퍼 전체 읽기) | exit 1. "상한보다 큰 본문" 66000B 읽음 |
| 시간 상한 제거(타이머가 끝내지 않음) | exit 1. "멈춘 본문" 5초 시간 초과 |
| `releaseLock()` 제거 | exit 1. 잠금 단언 5개 실패 |
| `cancel()` 제거 | exit 1. 멈춤·상한 초과·정확히 상한 3개 실패 |
| `while (left > 0)`을 `while (true)` 또는 `while (left >= 0)`으로 | exit 0. 예산이 0이면 길이 0의 BYOB 읽기가 TypeError로 바로 거절되어 같은 취소 경로로 가는 등가 변형입니다 |
| (보강 전 테스트) 남은 예산 무시 | 1KiB 단위 테스트 소스에서는 통과해, 큰 본문 테스트를 1000B 조각으로 보내도록 고쳤습니다(`dc26cc5`) |

본문 비우기 제거(`await discardBody(req)` 삭제, `8ae779d` 작업 트리) 변형은 회귀 테스트가 항상 잡지는 못했습니다.

- 단독 실행(`-g`, 3회): 3/3 실패. 진단 재현 루프: 200/200 503.
- `auth.spec.ts` 파일 전체 실행: 첫 1회는 통과했고, 4회 반복에서는 4회 중 3회 실패했습니다.
- 커밋하지 않은 시험: 100쌍으로 늘리면 10회 중 9회, Node `fetch`로 바꾸면 6회 중 5회 실패했습니다.
- 서버 로그로 보면 회차 단위로 걸리거나 안 걸립니다. 실패 회차는 3–7쌍 만에 503이 났고, 통과 회차는 모든 쌍이 정상이었습니다. 반복 횟수를 늘려도 해결되지 않아 커밋한 20쌍을 유지했습니다. 원인은 진단하지 않았습니다.

### 미검증과 남은 위험

- 64KiB를 넘는 다른 출처 본문 뒤에는 로컬 `wrangler dev`에서 다음 요청이 여전히 503입니다(`8ae779d` 코드: 70000B·131072B 각 200/200, `ec668ff` 코드: 70000B 200/200, 65537B 이하 0). 운영 영향 근거는 없고(ProxyWorker는 `wrangler dev`에만 있음), 근본 수정은 #16(wrangler 업그레이드) 범위입니다.
- 상한 초과와 보내다 멈춘 본문은 실제 HTTP 테스트 대신 `tests/discard-body.test.ts` 단위 테스트로 확인했습니다. 상한 2배(128KiB) 본문을 API 테스트로 보내면 위 503 때문에 다음 테스트가 깨지고, 1바이트 뒤 멈춘 chunked 요청은 로컬 테스트 서버에서 5초 안에 응답이 오지 않았습니다(원인은 보지 않음).
- 라우트의 403은 `discardBody`가 어떤 경우에도 던지지 않는다는 단위 테스트에 기대며, 이미 잠긴 본문·읽기 오류를 실제 HTTP 요청으로 만들어 확인하지는 않았습니다.
- Vercel 게이트웨이(`api/gateway.js:84`)도 본문을 읽기 전에 403을 돌려줍니다. 이 PR 범위 밖이라 바꾸지 않았고 Vercel 런타임 동작은 확인하지 않았습니다.
- 운영 Workers·원격 CI는 확인하지 않았습니다.

## 2026-11-21 홈 화면 앱 정보·아이콘과 viewport-fit

이슈 #11. 시작 커밋 `0820b95`에서 만든 `feature/webapp-shape` 브랜치의 `c208fb8`(구현)·`6e7b438`(검수 반영)을 macOS, Node 24.3.0, Playwright 1.63.0, Chromium 153.0.8010.12에서 확인했습니다. 모두 로컬 결과이며 원격 CI·Vercel 게이트웨이·실제 배포 검증이 아닙니다.

### 실행한 검사

| 조건 | 명령 | 결과 |
| --- | --- | --- |
| 1. 전체 검증 | `npm run typecheck` → `npm run lint:all` → `npm run test:all` (`6e7b438`) | 셋 다 exit 0. 단위 42개 통과, Playwright 135개 통과(2.1분) |
| 1. 새 테스트 | 위 `test:all` 출력 | `tests/api/webapp.spec.ts` "홈 화면 앱 메타·앱 정보·아이콘이 HTML과 응답에서 일치한다", `tests/api/gateway.spec.ts`의 "vercel.json은 앱 정보·아이콘 경로를 정확한 게이트웨이 경로로 넘긴다"·"게이트웨이는 앱 정보·아이콘 경로를 고정 원본에 no-store로 넘기고 POST를 막는다"·"게이트웨이는 비슷하지만 허용하지 않은 경로를 404로 막는다" 모두 통과 |
| 2. 게이트웨이 | `node --check api/gateway.js && node scripts/build-vercel.mjs` (`6e7b438`) | exit 0 |
| 4. 공백 | `git diff --check 0820b95...HEAD` (`6e7b438`), 새 파일은 stage 뒤 `git diff --cached --check` | 모두 통과 |

기존 테스트의 기대값·이름·fixture는 바꾸지 않았고, 기존 테스트 실패는 없었습니다.

### 변형 실험

`6e7b438`을 기준으로 변형을 하나씩 적용하고 해당 새 spec만 `npx playwright test --project=api <spec>`로 돌렸습니다(테스트 서버는 실행마다 새로 빌드, 떠 있는 서버 재사용 없음). 변형 전과 되돌린 뒤 모두 `test -z "$(git status --porcelain --untracked-files=all)"`가 성공했고, 되돌린 뒤 같은 명령은 모두 exit 0이었습니다.

| 변형 | exit | 실패한 테스트와 메시지 |
| --- | --- | --- |
| manifest `display`를 "browser"로 | 1 | webapp.spec.ts: `toMatchObject`에서 `"display": "standalone"` 기대, `"browser"` 받음 |
| `public/icons/icon-512.png` 삭제 | 1 | webapp.spec.ts: `/icons/icon-512.png status` Expected 200, Received 404 |
| HTML manifest `href`만 `/manifest-other.webmanifest`로 | 1 | webapp.spec.ts: Expected `.../manifest.webmanifest`, Received `.../manifest-other.webmanifest` |
| `vercel.json` icon-512 rewrite의 destination 파일명을 `icon-512x.png`로 | 1 | gateway.spec.ts "vercel.json은…": destination 문자열 차이, "게이트웨이는…no-store…": `/icons/icon-512.png` Expected 200, Received 404 |
| 게이트웨이 허용 목록에서 `/manifest.webmanifest` 삭제 | 1 | gateway.spec.ts "게이트웨이는…no-store…": `/manifest.webmanifest` Expected 200, Received 404 |
| (검수) 받은 HTML의 manifest 링크를 주석으로 감쌈 | 1 | webapp.spec.ts: `Expected one tag with rel="manifest".` |
| (검수) 받은 HTML의 manifest 링크 속성을 작은따옴표로 | 0 | 브라우저와 같이 링크를 찾아 통과(기대대로) |
| (검수) manifest의 maskable `src`를 `/icons/icon-512.png`로 | 1 | webapp.spec.ts: `maskable 512x512` Expected `.../icon-maskable-512.png`, Received `.../icon-512.png` |
| (검수) 192 아이콘의 선언 `type`을 `text/plain`으로 | 1 | webapp.spec.ts: `any 192x192` Expected `image/png`, Received `text/plain` |

이슈의 변형 5개는 `c208fb8`에서도 같은 결과(모두 exit 1, 되돌린 뒤 exit 0)였습니다. 검수 반영 전 검사는 정규식으로 HTML을 읽어 주석 처리된 링크를 통과시키고, 같은 크기의 다른 아이콘 파일과 다른 선언 type도 통과시켰습니다. 반영 뒤 검사는 받은 HTML을 Chromium의 `DOMParser`로 해석하고, 아이콘 용도·크기별 고정 URL과 선언 type, apple-touch-icon 고정 URL을 대조합니다.

### 화면 확인

감독이 같은 Playwright 촬영 스크립트(커밋하지 않음)로 변경 전은 시작 커밋 `0820b95`의 임시 워크트리, 변경 후는 `6e7b438`(이후 커밋은 문서만)에서 찍었습니다.

- 조건: Chromium 153.0.8010.12·WebKit 26.6(Playwright webkit 2359), 폭 360·430 × 높이 900, isMobile·hasTouch. 이미지 로딩 완료를 기다린 뒤 찍었고, 전·후 각 4개 실행이 모두 통과했습니다.
- 상태: 로그인 화면(새 세션 `/`), 홈(API로 만든 테스트 계정 쿠키, 하단 "새 모임 만들기"), 바텀시트(홈 헤더 "설정"의 "내 계정" 시트).
- 측정(두 엔진·두 폭 모두 전·후 같음): 하단 고정 버튼 `padding-bottom` 22px, 바텀시트 `padding-bottom` 27px, 세 상태 모두 가로 넘침(`scrollWidth − innerWidth`) 0, 시트 아래 끝 간격 0. viewport 메타는 전 `width=device-width, initial-scale=1`, 후 `width=device-width, initial-scale=1, viewport-fit=cover`입니다.
- 픽셀 비교: 로그인 화면은 chromium-360·webkit-360·webkit-430에서 차이 0입니다. chromium-430만 상단 브랜드 로고 영역(33×34px)에서 채널 최대 13 차이가 있습니다. 같은 `app-logo.png`의 축소 렌더 차이이며 눈으로 보면 같습니다. 홈·시트의 차이는 실행마다 바뀌는 테스트 계정 이름 글자 영역뿐입니다.
- 첫 촬영에서 WebKit 360 로그인 화면이 로고 이미지 로딩 전에 찍혀, 이미지 로딩 대기를 더한 같은 스크립트로 전·후를 다시 찍었습니다.
- 이미지(커밋하지 않음): 폭별 전·후 비교 `.utmp/screens/compare-360.png`, `.utmp/screens/compare-430.png`(PR에는 이 두 장만 첨부). 상태별 `.utmp/screens/before/`, `.utmp/screens/after/`(`<엔진>-<폭>-{1-login,2-home,3-sheet}.png`, 측정 `<엔진>-<폭>-metrics.json`). 아이콘 미리보기 `.utmp/ticket-11/icon-preview/icon-preview.png`.
- 아이콘 미리보기는 2026-11-21 PR을 열기 전에 사용자가 승인했습니다.
- standalone의 실제 여백은 Playwright가 safe area·standalone을 재현하지 못해 사람 확인 4·5번으로 넘깁니다.

### 아이콘

- `public/icons/`의 PNG 네 개는 `public/app-logo.png`(1254×1254)의 흰 여백을 잘라 낸 1143px 정사각형에서 만들었습니다. 바깥 모서리는 로고 가장자리 안쪽 파란색의 평균 `#318afd`(49,138,253)로 채웠습니다. 생성 스크립트는 커밋하지 않았습니다.
- maskable 512는 시계 파란 테두리·그림자를 포함한 그림 경계(채움색과 RGB 거리가 10을 넘는 가장 큰 연결 영역)를 기준으로 0.7951배 줄였습니다. 같은 방식으로 잰 최대 반지름은 202.6px(거리 8 기준 204.3px)이고, 안전 원 반지름 204.8px 안에 있습니다. 반영 전 파일은 같은 기준으로 246.5px였습니다.
- 마스크 미리보기(iOS 둥근 사각형, Android 원, maskable을 지름 80% 원으로 실제 잘라 낸 모습)는 PR을 열기 전에 사용자가 승인했습니다.

### 미검증

- 검사 지점 3(Chromium 설치 가능 판정)은 테스트로 넣지 않았습니다. headless Chromium 153.0.8010.12에서 CDP `Page.getInstallabilityErrors`가 오류 없이 빈 목록을 돌려주지만, manifest가 없는 시작 커밋에서도 똑같이 빈 목록이라 판정할 수 없습니다.
  - 시작 커밋 상태: `{"installabilityErrors": []}`, `Page.getAppManifest`는 `{"url": "", "errors": [], "data": "", "manifest": {"display": "kUndefined", ...}}`
  - 구현 뒤: `{"installabilityErrors": []}`, `Page.getAppManifest`의 `url`은 `http://127.0.0.1:4317/manifest.webmanifest`, `errors`는 `[]`, `display`는 `kStandalone`
- iPhone 13 Safari 사람 확인 1–5(홈 화면에 추가 화면의 이름·아이콘, standalone 열림과 상태 표시줄, 첫 실행 로그인 상태, 하단 고정 버튼 아래 여백 `max(22px, inset)`, 바텀시트 아래 여백 `max(27px, inset)`)은 아직 하지 않았습니다.
- 배포 후 확인: 원본 Sites 재배포 뒤 실제 Vercel 주소의 새 다섯 경로(200, Content-Type, `Cache-Control: private, no-store`, `X-Content-Type-Options: nosniff`)와 같은 경로 POST 403, https에서의 iPhone 홈 화면 추가·standalone·첫 실행 로그인·하단 여백, Android Chrome "앱 설치" 표시는 이 PR 범위 밖이라 확인하지 않았습니다.
- 게이트웨이 검사는 전역 `fetch`를 가짜로 바꾼 함수 호출입니다. 실제 Vercel rewrite 동작과 원본 응답을 대신하지 않습니다.

### 문서 대조

| 항목 | 위치 |
| --- | --- |
| 설치 방법: Android Chrome "앱 설치" | `README.md` 38행 |
| 설치 방법: iPhone Safari 공유 → 홈 화면에 추가 | `README.md` 39행 |
| 제약: 기기·OS 버전에 따라 다시 로그인해야 할 수 있음 | `README.md` 43행 |
| 제약: 초대 링크는 브라우저로 열림 | `README.md` 44행 |
| 제약: 오프라인 불가 | `README.md` 45행 |
| 고친 `app-logo.png` 문장 | `README.md` 162행 |
| "코드 위치"의 새 파일 | `README.md` 95–96행 |
| 게이트웨이가 넘기는 새 다섯 경로 | `VERCEL.md` 44행 |
| 원본 재배포 뒤에야 응답 | `VERCEL.md` 45행 |

## 2026-11-20 에이전트 지침 AGENTS.md와 이슈 문서 추가

이슈 #9. `d4d9ec5`에서 만든 `docs/agent-guidelines` 브랜치의 문서 변경(`AGENTS.md`, `docs/agents/issue-tracker.md`, `docs/agents/triage-labels.md`, README 범위 표기 세 줄)을 macOS에서 확인했습니다. 앱 코드·테스트·설정은 바꾸지 않았습니다.

### 실행한 검사

이슈의 완료 조건 1–7을 리뷰 반영 커밋 `537892b`에서 다시 실행했고 모두 통과했습니다.

| 조건 | 결과 |
| --- | --- |
| 1. `AGENTS.md` 줄 수 60–80 | 77줄 |
| 2. 명령·경로 대조 | `npm run` 이름 5개가 `package.json` `scripts`에 있음. 백틱 안 경로 19개와 명령 안 경로 2개가 모두 존재. 나머지 백틱 항목은 식별자로 분류했고 미분류 0개 |
| 3. 초안 처리 표의 "남김" 항목 | 실행 도구·검증 명령·계약 세 절·UI 원칙·커밋·브랜치 규칙이 모두 있음 |
| 4. Clipback 원본과 비교 | 원본에서 저장소 이름만 바꾼 사본과 `issue-tracker.md`가 같음(바뀐 줄은 3·5행), `triage-labels.md`는 원본과 같음 |
| 5. 코드 블록 밖 `~` | 0건 |
| 6. GitHub 렌더(`gh api /markdown`, gfm)의 `<del>` | 네 파일 모두 렌더 성공, `<del>` 0개 |
| 7. 공백 검사 | `git diff --check d4d9ec5...HEAD`, `git diff --check`, `git diff --cached --check` 모두 통과 |

검사 2·4·6은 일부러 틀린 입력(없는 스크립트 이름과 파일, 저장소 이름을 바꾸지 않은 원본, 실패하는 GitHub 요청)을 넣으면 실패하는 것도 확인했습니다.

### 미검증

- 앱 검사(`npm run typecheck`, `npm run lint:all`, `npm run test:all`)는 로컬에서 실행하지 않았습니다. 문서만 바꾸는 변경이라 이슈의 검사 계획에 따라 PR CI(`Tests` workflow)로 확인합니다.
- 화면 확인은 하지 않았습니다. 앱 화면을 바꾸지 않습니다.

## 2026-10-21 초기 연결 재시도와 초대 코드 보존

최신 main `e290a52`에서 만든 `fix/initial-connection-retry` 브랜치의 로컬 변경을 macOS, Node 24.3.0, npm 11.4.2, Playwright 1.63.0 및 Chromium 360px·430px에서 검증했습니다.

- 초기 GET 실패 시 전용 오류 화면과 수동 재시도를 제공하고, 최초 조회와 각 재시도에 30초 제한을 적용했습니다. 중복 요청을 막고 취소·만료된 요청의 늦은 성공과 실패를 무시합니다.
- 최초 초대 코드를 재시도와 URL 변경 후에도 보관하며, 기존 세션·로그인·회원가입 성공 후 원래 코드로 참가할 수 있습니다. 참가 실패 시 코드·URL을 유지하고 성공 후 URL을 정리합니다.
- 초기 성공 전에는 폴링·POST를 차단합니다. 기존 4초 폴링과 저장의 동시성 보호는 유지하고, 일반 폴링 응답과 POST가 30초 이상 지연돼도 초기 조회의 제한을 적용하지 않는지 검사했습니다.
- 오류 화면 제목, 키보드 재시도 버튼과 복구 후 화면 제목의 포커스를 확인했습니다. 오류·재시도 화면의 가로 넘침 및 버튼의 화면 내 배치, 실제 참가와 새로고침 뒤 D1 저장도 확인했습니다.

### 최종 로컬 검사

`npm run typecheck`, `npm run lint`, `npm run lint:tests`, `npm run lint:all`, `npm run test:all`을 통과했습니다. 마지막 전체 검사는 검사 동안만 자동 절전을 일시 방지하도록 `caffeinate -di npm run test:all`로 실행했습니다. 제품 코드와 테스트 제한은 이 환경 조치 때문에 변경하지 않았습니다.

| 검사 | 결과 |
| --- | --- |
| Node 단위 테스트 | 42/42 |
| 실제 로컬 API·D1 | 21/21 |
| 실제 화면·D1 | 34/34 |
| 명시적 모의 응답 화면 | 76/76 |
| 합계 | **173/173** |

기존 145개에 실제 화면·D1 6개와 모의 응답 화면 22개를 추가했습니다. 기존 지연 POST 검사도 31초로 늘려 초기 조회의 시간 제한이 저장에 적용되지 않는지 확인했습니다. Playwright 131개는 빌드 포함 약 137.3초에 완료됐고 최종 실행의 실패·건너뜀·자동 재시도는 0입니다. 앱 빌드는 해당 전체 실행에서 한 번 수행했습니다. 실행기가 만든 임시 D1 삭제와 전용 서버 종료를 확인했습니다. `git diff --check` 및 신규 소스·테스트의 공백 검사도 통과했습니다.

### 중간 실패와 재검사

- 최초 집중 검사에서는 24/26이 통과했습니다. 참가 오류 문구가 본문과 토스트에 함께 있어 두 검사의 선택자가 중복됐으며, 본문의 오류 문구로 범위를 좁혔습니다.
- 첫 전체 실행은 단위 42개와 Playwright 126개가 통과하고 기존 화면 검사 5개가 시간 초과로 실패했습니다. 해당 시각의 Mac Sleep/DarkWake 기록과 45초 제한을 크게 넘긴 검사 실행 시간이 일치했습니다. 실패 자료와 전원 이벤트를 `outputs/verification/initial-connection-retry/first-full-run/`에 보관했습니다.
- 제품 코드나 테스트의 시간 제한을 바꾸지 않고 자동 절전을 일시 방지한 뒤, 실패한 흐름을 두 화면 크기에서 수동으로 다시 실행해 10/10 통과했습니다. 이어 같은 조건의 최종 전체 검사에서 위 173/173을 통과했습니다. 이 수동 재검사는 테스트 러너의 자동 재시도와 구분합니다.

### 캡처와 검증 범위

`outputs/verification/initial-connection-retry/`에 360px·430px 각각의 `error`, `retrying`, `invite-preserved` PNG 6개와 실제 Playwright 보고서 캡처 `test-report.png`, 결과 요약 `summary.json`을 보관합니다. 화면 PNG는 Playwright 보고서에도 첨부합니다. 보고서 화면의 131개는 API·브라우저 검사 수이며 Node 단위 42개는 별도입니다.

오류·재시도 화면은 명시적 모의 응답으로 촬영했습니다. 초대 참가 화면과 참가 저장은 첫 조회 실패만 주입한 뒤 실제 로컬 Workers/D1에서 확인했습니다. 운영 계정·운영 DB는 사용하지 않았고 미추적 `AGENTS.md`는 보존했습니다. 서버 API·DB 스키마·게이트웨이·의존성 변경은 없습니다. 원격 CI·배포·GA4·실제 iPhone/Safari 및 OS 백그라운드 타이머 제한은 이번 검증 범위에 포함하지 않습니다.

## 2026-10-06 미사용 UI 코드와 린트 범위 정리

PR #5가 병합된 최신 `origin/main`의 `e054cfd`에서 `chore/unused-ui-lint` 브랜치를 만들었습니다. macOS, Node 24.3.0, npm 11.4.2, Playwright 1.63.0 및 Chromium 360px·430px에서 확인했습니다.

- 참조를 재검사한 뒤 미사용 `components/ui/` 60개와 전용 훅·유틸·생성 설정을 합쳐 **63개 파일**, 전용 직접 의존성 **14개**를 제거했습니다. 남은 소스에 끊어진 import는 없습니다.
- npm으로 잠금 파일을 갱신했습니다. 루트를 포함한 package 항목은 **702→352**, 추가 경로는 0개이며 남은 패키지의 version·resolved·integrity·의존성 정의는 동일합니다. 개발/peer 분류 플래그 변경만 있으며 일괄 업그레이드는 하지 않았습니다.
- 앱·게이트웨이·컴포넌트·훅·공통 로직은 `lint`, 테스트는 `lint:tests`, 스크립트와 루트 설정까지 모두 포함하는 검사는 `lint:all`로 정리했습니다. CI도 `lint:all`을 실행합니다.
- 기존 전체 린트 오류 19개는 제거 대상에 있었으며 삭제 후 모두 해소됐습니다. 생성물 제외 경로만 보완하고 기존 규칙과 실사용 시트의 자동 포커스 예외는 유지했습니다.
- 원본 CSS·실사용 화면·API·DB·테스트·빌드 설정은 변경하지 않았습니다. 미추적 `AGENTS.md`와 원본 CSS의 SHA-256은 작업 전후 동일하며 AGENTS와 산출물은 커밋에서 제외합니다.

### 로컬 검사

`npm ci --no-audit --no-fund`는 잠금 파일로 351개 패키지를 설치하고 종료 코드 0으로 완료했습니다. `npm run typecheck`, `npm run lint`, `npm run lint:tests`, `npm run lint:all`, `npm run test:all`도 모두 통과했습니다. 타입 계약 검사와 기존 런타임 **140개를 그대로 유지**했으며 건너뜀·실패·자동 재시도는 없습니다.

| 검사 | 결과 |
| --- | --- |
| Node 단위 테스트 | 41/41 |
| 실제 API·D1 | 19/19 |
| 실제 화면·D1 | 28/28 |
| 명시적 모의 응답 화면 | 52/52 |
| 합계 | **140/140** |

Playwright 99개는 빌드를 포함해 약 128.2초였고 해당 실행에서 앱을 한 번 빌드했습니다. 자동 검사 서버의 4317 포트 해제와 생성한 임시 D1 삭제를 확인했습니다. 화면 비교용 변경 전 빌드는 이 자동 검사와 별도입니다.

### 화면 비교와 직접 조작 미리보기

별도 로컬 Workers/D1의 공개 API로 임시 계정 3개와 일정·지역·최종 단계의 모임 3개를 준비했습니다. 동일 DB·데이터·쿠키와 고정한 한국 시간으로 홈·일정·지역 투표·최종 링크·설정 시트를 360px·430px에서 각각 캡처했습니다.

**변경 전후 PNG 10쌍의 SHA-256이 모두 일치**했습니다. 문서 높이·가로 폭·dialog 개수도 동일하고 가로 넘침·페이지 오류·캡처 중 UI POST는 각각 0입니다. 캡처 직전 공개 API의 모임 스냅샷도 일치했습니다. 원본 CSS가 같다는 사실만으로 판단하지 않고 Tailwind가 생성한 CSS를 실제 화면으로 비교했습니다. 이 캡처 비교는 위 140개 테스트 수에 포함하지 않습니다.

`http://127.0.0.1:4318/`의 인앱 브라우저에는 임시 테스트 계정으로 로그인한 홈을 열어 직접 조작할 수 있게 했습니다. 이 미리보기만 사용자 확인용으로 유지하며, 별도 실행기는 SIGTERM 종료 시 자신이 만든 서버와 임시 D1을 정리합니다. 인증이나 요청 제한은 해제하지 않았고 기존 개발 서버·개발 DB를 정리하지 않았습니다. 화면을 제공한 사실과 사용자가 직접 검증했다는 사실은 구분합니다.

실행 로그·전후 캡처·비교 메타데이터·미리보기 실행 정보는 `outputs/verification/unused-ui-lint/`에 보관하고 Git에서 제외합니다. 임시 PIN·쿠키·토큰은 출력하지 않았습니다. diff 공백 검사도 통과했습니다.

이 문서는 해당 커밋의 로컬 검증 기록입니다. 원격 CI 결과는 PR Checks와 PR 본문에서 별도로 확인합니다. 실제 Safari/iOS·Firefox·휴대폰·운영 DB·게이트웨이 프록시 동작·GA4는 검증하지 않았으며 병합·수동 배포는 수행하지 않습니다. 초기 연결 실패 복구와 강퇴 직후 열린 시트의 포커스 문제는 기존 제한으로 남아 있습니다.

## 2026-10-05 모임 화면과 상태 동기화 분리

선행 PR #4 병합을 확인하고 최신 `origin/main`의 `6929f48`에서 `refactor/meeting-view-sync` 브랜치를 만들었습니다. macOS, Node 24.3.0, npm 11.4.2, Playwright 1.63.0 및 Chromium 360px·430px에서 검증했습니다.

- `lib/meeting-api.ts`에 공통 요청·응답 계약 기반 HTTP 통신을, `hooks/use-meeting-sync.ts`에 초기 조회·4초 폴링·저장과 `pending`/`generation` 검사를 옮겼습니다. 페이지는 입력 초안·화면 이동·명시적 액션·오류/토스트·시트 포커스를 유지합니다.
- `components/meeting/`에 진입 화면 4개, 공통 모임 영역과 단계별 화면 6개, 공통 표시 요소, 여섯 종류의 시트를 분리했습니다. 필요한 값과 동작 콜백으로 연결하며 서버 상태를 별도로 복제하지 않습니다.
- 기존 CSS·API·DB·공통 계약·의존성·기존 테스트는 변경하지 않았습니다. `AGENTS.md`와 `app/globals.css`의 작업 전후 SHA-256이 일치합니다. 미추적 `AGENTS.md`는 커밋에서 제외합니다.
- 기본 린트에 새 모듈·훅·컴포넌트를 포함했습니다. 시트 입력의 기존 `autoFocus`를 보존하기 위한 `no-autofocus` 예외는 해당 시트 파일에만 적용했습니다.

`npm run typecheck`, `npm run lint`, `npm run lint:tests`와 최종 `npm run test:all`이 모두 종료 코드 0으로 통과했습니다. 타입 계약 검사도 유지했으며 아래 런타임 검사 수에는 포함하지 않습니다.

| 검사 | 결과 | 검증 범위 |
| --- | --- | --- |
| Node 단위 테스트 | 41/41 | 기존 상태 전환·집계·화면 계산 |
| API·D1 | 19/19 | 기존 인증·권한·요청 검증·동시 저장 |
| 실제 화면·D1 | 28/28 | 기존 26개 + 생성 화면 왕복 후 작성값 유지·UI 생성·GET 재조회, 두 화면 크기 |
| 모의 응답 화면 | 52/52 | 기존 42개 + 동기화 회귀 5개, 두 화면 크기 |
| 합계 | **140/140** | 기존 128개 유지, 회귀 12개 추가 |

새 동기화 검사는 페이지 로딩 전에 고정한 시계와 명시적인 API 스냅샷으로 다음을 확인했습니다. 모의 서버는 제품 상태 전환 함수를 사용하지 않으며 D1 저장 검증과 구분합니다.

- 입력 재렌더 중 초기 GET은 한 번만 실행되고 4초 폴링 주기가 미뤄지지 않음.
- 지연 POST 중 추가 POST와 주기 GET이 억제되고, 저장 실패 후 다시 제출하고 폴링을 재개할 수 있음.
- 로그인·로그아웃 실패는 입력·세션·화면을 유지하며 성공한 응답에만 세션을 교체함.
- 인증된 초대 진입에서 초기 요청 시작 시 캡처한 코드를 사용함. 로그인 후 참가 화면 선택은 기존 실제 D1 흐름으로 확인함.
- 일정 결과 화면이 폴링으로 갱신된 후 수정에 진입하면 최신 서버 제출값을 가져오고, 수정 중인 초안은 다음 폴링에도 유지됨.

기존 지역 초안·회차/revision 변경·늦은 GET 방어·같은 참석 응답 재제출 검사도 통과했습니다. 시트 종료·내부 전환·제목 fallback·자동 포커스·Tab 범위·스크롤 복구·가로 넘침 검사를 유지했습니다. 원본 JSX와 분리한 모임 컴포넌트의 대표 상태 31개는 메모리에서 정적 렌더해 HTML 문자열이 같음을 별도로 대조했으며, 이 비교는 위 런타임 수치에 더하지 않았습니다.

첫 전체 실행은 138/138 통과했습니다. 이후 일정 초안 검사 2개와 시트 텍스트 공백 원복을 포함한 최종 실행은 **140/140 통과**, 건너뛴 검사·실패·자동 재시도 없이 완료했습니다. 최종 Playwright 99개는 빌드를 포함해 약 115.1초였으며, 앱 빌드 1회·전용 포트 4317 해제·생성한 임시 D1 삭제를 확인했습니다. 기존 개발 서버나 개발 DB를 정리하지 않았습니다.

`git diff --check`, 새 파일 공백·마지막 개행 검사와 변경 코드 포맷 검사를 통과했습니다. 최종 전체 로그는 `outputs/verification/meeting-view-sync-test-all.log`, 첫 실행 자료는 `outputs/verification/meeting-view-sync-first-pass/`, 마지막 JSON·서버 로그·HTML 보고서는 기존 테스트 산출물 경로에 있습니다. 모두 Git에서 제외합니다.

초기 연결 실패 복구와 강퇴 직후 열린 시트의 포커스 문제는 이번 구조 변경에서 수정하지 않았습니다. 기존 강퇴 검사는 저장·시트 유지와 이후 Tab 조작을 확인하며 즉시 포커스 복원이 해결된 것으로 해석하지 않습니다. 이번 결과는 로컬 검증이며 원격 GitHub CI·Safari/iOS·Firefox·실제 기기·운영 DB·Vercel 게이트웨이·GA4·배포는 검증하지 않았습니다. 이번 작업은 로컬 커밋까지이며 푸시·PR 생성·배포는 수행하지 않습니다.

## 2026-10-05 모임 API 요청·응답 타입과 명시적 액션 호출

macOS, Node 24.3.0, npm 11.4.2, Playwright 1.63.0 및 Chromium 360px·430px에서 검증했습니다. API 경로·JSON 형식·DB 스키마·권한·서버 검증 순서·의존성은 유지했습니다.

- 공유 `MeetingRequest`와 요청별 `MeetingResponse`를 화면·서버 응답·정상 테스트 fixture에 적용했습니다. 서버 입력은 검증 전 `UnvalidatedAction`으로 구분하며, 잘못된 요청 검사는 `postRawAction()`을 사용합니다.
- 화면의 `update()`와 객체 차이 비교를 제거하고 9곳을 명시적인 액션으로 전환했습니다. 임시 참석자·단계 계산, 클라이언트 추첨과 링크 ID 생성도 제거했습니다.
- `npm run typecheck`, `npm run lint`, `npm run lint:tests` 통과. 요청 필드 누락·잘못된 값·응답 형태·탈퇴 응답의 null 허용을 확인하는 타입 계약 검사는 `typecheck`에 포함되며 아래 런타임 테스트 수에는 포함하지 않습니다.
- `git diff --check`, 새 파일의 `git diff --no-index --check` 및 줄 끝 공백·마지막 개행 검사 통과. 기존 미추적 `AGENTS.md`는 수정하지 않았습니다.

최종 `npm run test:all`은 종료 코드 0, 자동 재시도·건너뛴 검사 없이 **128/128 통과**했습니다.

| 검사 | 결과 | 검증 범위 |
| --- | --- | --- |
| Node 단위 테스트 | 41/41 | 기존 상태 전환·집계·화면 계산 유지 |
| API·D1 | 19/19 | 기존 16개 + 잘못된 입력·revision 생략/null 호환성 3개 |
| 실제 화면·D1 | 26/26 | 기존 흐름 보강 + 서버 추첨·강퇴 각각 두 화면 크기 |
| 모의 응답 화면 | 42/42 | 기존 36개 + 날짜 저장·링크 추가·삭제 실패 각각 두 화면 크기 |

Playwright 87개는 빌드를 포함해 약 114.2초였습니다. 앱 빌드 1회, 전용 포트 4317 해제, 생성한 임시 D1 디렉터리 삭제를 확인했습니다. 기존 개발 서버를 종료하거나 개발 `.wrangler`를 초기화하지 않았습니다.

실제 HTTP에서는 잘못된 JSON·최상위 null/배열·알 수 없는 액션·필수 필드 누락·잘못된 필드 타입을 거절하고 저장 상태가 유지되는지 확인했습니다. 참석 확인·투표의 revision 생략/null은 0으로 처리하고 재선택 후에는 거절합니다. 로그아웃의 빈 객체, 본인 탈퇴의 `{ room: null }`, 링크 이름의 빈 문자열 허용·생략 거절도 확인했습니다.

화면에서는 일반·수동 날짜 선택의 `manual`, 추첨 요청, 링크 추가·삭제, 본인 탈퇴·타인 강퇴의 정확한 payload와 D1 재조회 결과를 검사했습니다. 명시적인 400 응답에서는 날짜·링크 입력과 포커스, 링크 추가 시트, 삭제 실패 시 기존 링크를 유지합니다. 기존 동일 참석 응답 재제출·늦은 GET 방어·폴링·바텀시트 종료 후 포커스 검사도 유지했습니다.

### 최초 실패와 비교 검사

- 첫 시도는 단위 41개 통과 후 샌드박스의 로컬 listen 제한 `EPERM`으로 서버 시작이 중단됐습니다. 4317 포트를 사용하는 프로세스는 없었으며 로컬 서버 실행 권한을 받아 재실행했습니다.
- 첫 전체 실행은 Playwright 81개 통과·6개 실패였습니다. 날짜·링크 삭제 오류를 `alert`에서 찾던 새 검사 4개는 기존 화면의 토스트 `status`를 확인하도록 수정했습니다.
- 나머지 2개는 **강퇴로 포커스된 멤버 행이 사라졌을 때 열린 관리 시트 안으로 즉시 포커스가 돌아오지 않는 문제**였습니다. 수정 전 커밋 `d7db190`을 별도 임시 폴더에서 빌드하고 동일 검사를 실행해 360px·430px 모두 같은 실패를 확인했습니다. 포커스 effect와 의존성도 이번 변경 전후 동일합니다.
- 이 기존 포커스 문제는 별도 수정 대상으로 남깁니다. 신규 강퇴 회귀 검사는 요청·저장 결과·시트 유지와 이후 Tab으로 시트 조작을 계속할 수 있는지를 확인합니다. 즉시 포커스 복원은 해결된 것으로 기록하지 않으며, 기존 포커스 테스트를 제외하거나 건너뛰지 않았습니다.

최종 실행 로그는 `outputs/verification/meeting-api-actions-test-all.log`, 첫 실패 자료는 `outputs/verification/meeting-api-actions-initial-failure/`, 수정 전 비교 자료는 `outputs/verification/meeting-api-actions-baseline-focus/`와 같은 이름의 `.log`에 보관했습니다. 비교용 임시 소스 폴더와 각 실행의 임시 D1은 정리했습니다. 자료는 모두 Git에서 제외됩니다.

위 구현·로컬 검증 단계에서는 원격 GitHub CI·Safari/iOS·Firefox·운영 DB·배포를 검증하지 않았습니다. 원격 CI 결과는 PR Checks에서 별도로 확인하며, 배포는 수행하지 않았습니다.

## 2026-10-04 바텀시트 포커스 복원

macOS, Node 24.3.0, npm 11.4.2, Playwright 1.63.0 및 Chromium 360px·430px에서 검증했습니다. 제품 API·DB 스키마·인증·요청 제한·의존성은 변경하지 않았습니다.

- 닫기·Escape·저장 성공·방장 이전 후 최초 호출 버튼으로 복원합니다. 참여 인원/설정에서 초대로 전환해도 최초 버튼을 유지합니다.
- 모임 종료·탈퇴·로그아웃·폴링 중 방 제거·세션 소실로 화면이 바뀌면 새 화면 제목으로 이동합니다. 같은 모임의 revision만 바뀌면 남아 있는 호출 버튼을 사용하며, 버튼이 사라졌거나 숨김·비활성이면 제목으로 이동합니다.
- 지역·링크 입력의 초기 포커스, 일반 폴링과 저장 실패 시 포커스 유지, 빠른 닫기/재열기, 스크롤 복구를 확인했습니다. 복원은 실제 닫힘 커밋에서 동기적으로 처리하며 타이머를 사용하지 않습니다.
- 기존 모바일 테스트의 닫기·Escape 후 설정 버튼 `toBeFocused()` 검증을 복원했습니다. 별도 집중 검사 명령 `npx playwright test tests/e2e/sheet-focus --project=chromium-360 --project=chromium-430`은 **36/36 통과**했습니다.
- 새 검사는 실제 Workers/D1 사용자 흐름 6개 × 두 화면 크기와 명시적 모의 응답 12개 × 두 화면 크기로 구성합니다. 실제 저장 검사는 GET 재조회까지 확인하며, 로그아웃은 별도 로그인 세션을 사용합니다.
- `npm run typecheck`, `npm run lint`, `npm run lint:tests` 통과. 재사용 인증 상태나 테스트 결과물은 커밋하지 않습니다.

전체 `npm run test:all`도 종료 코드 0으로 완료했습니다. 재시도·건너뛴 검사 없이 **115/115 통과**했습니다.

| 검사 | 결과 | 검증 범위 |
| --- | --- | --- |
| Node 단위 테스트 | 41/41 | 기존 상태 전환·집계·화면 상태 계산 |
| API·D1 | 16/16 | 실제 로컬 HTTP·Workers/D1 |
| 실제 화면·D1 | 22/22 | 기존 흐름 5개 + 포커스 흐름 6개 × 두 화면 크기 |
| 모의 응답 화면 | 36/36 | 기존 시계/응답 순서 6개 + 포커스 12개 × 두 화면 크기 |

Playwright 74개는 약 104.6초가 걸렸습니다. 실행별 앱 빌드 1회, 테스트 종료 후 전용 포트 4317 해제와 임시 D1 디렉터리 삭제를 확인했습니다. 전체 실행 로그는 `outputs/verification/bottom-sheet-focus-test-all.log`, JSON·서버 로그는 `test-artifacts/`에 있으며 Git에서 제외됩니다.

첫 집중 검사에서 입력 초기 포커스가 실패해, 숨겨진 dialog에서 실행되는 React `autoFocus`를 보완하도록 `showModal()` 직후 입력을 포커스했습니다. 실패 자료는 Git 제외 경로 `outputs/verification/bottom-sheet-focus-initial-failure/`에 보관했습니다.

Tab 경계 검사는 최소 네이티브 dialog HTML과 비교했습니다. Chromium은 마지막/첫 컨트롤에서 브라우저 툴바를 거칠 수 있어, `activeElement === body`이면서 `document.hasFocus() === false`인 경우만 한 번 더 같은 키를 누르게 했습니다. 배경 페이지 요소로의 이동은 허용하지 않고 다음 시트 내부 대상의 포커스를 반드시 확인합니다. 사용자 정의 Tab 트랩은 추가하지 않았습니다.

위 항목은 이 수정의 로컬 실행 결과입니다. 원격 CI 결과는 PR의 Checks와 별도로 기록하며, 실제 Safari·iOS·Firefox·운영 DB·배포 검증으로 간주하지 않습니다.

## 2026-10-02 자동 테스트 구축 기록

검증일: 2026-10-02 (Asia/Seoul). macOS, Node 24.3.0, npm 11.4.2, Playwright 1.63.0 및 Chromium에서 확인했습니다. 제품 API·DB 스키마·인증·요청 제한은 변경하지 않았습니다.

## 설치와 정적 검사

- 고정된 `package-lock.json`으로 `npm ci` 재설치 성공.
- `npx playwright install chromium` 성공.
- `npm run typecheck`, `npm run lint`, `npm run lint:tests` 통과.
- `git diff --check` 및 신규 파일 공백 검사 통과.
- 기존 단위 테스트 41개와 `scripts/test.mjs` 유지. 검사 중 `tsconfig.tsbuildinfo` 내용 변경 없음. 후속 Git 정리에서 `*.tsbuildinfo`·`.dev.vars*` 제외 규칙을 추가하고 빌드 캐시는 로컬 파일을 유지한 채 추적에서 제외했습니다.

## 전체 검사 연속 두 번 실행

`npm run test:all`을 연속 두 번 실행했습니다. 각 실행의 종료 코드는 0이며 자동 재시도·건너뛴 테스트는 없습니다.

| 검사 | 1회차 | 2회차 | 검증 범위 |
| --- | --- | --- | --- |
| Node 단위 테스트 | 41/41 통과 | 41/41 통과 | 순수 상태 전환·집계·화면 상태 계산 |
| API·D1 | 16/16 통과 | 16/16 통과 | 실제 로컬 HTTP와 Workers/D1 |
| 실제 화면·D1 | 10/10 통과 | 10/10 통과 | 사용자 흐름 5개 × Chromium 360px·430px |
| 시계·응답 순서 | 12/12 통과 | 12/12 통과 | 명시적 API 모의 응답 6개 × 두 화면 크기 |
| 합계 | **79/79 통과** | **79/79 통과** | 실제 저장 검사와 UI 모의 검사를 구분 |

Playwright 구간은 각각 약 78.5초, 75.0초였습니다. 서버 로그에서 실행별 `vinext build`가 정확히 한 번 수행됐음을 확인했습니다. 두 실행은 다른 임시 D1 디렉터리를 사용했고 재실행 시 로그인 제한·데이터 누적·잔여 서버로 인한 실패가 없었습니다.

실행 원본 로그·JSON·서버 로그는 Git 제외 경로 `outputs/verification/test-all-{1,2}*`에 보관했습니다. 마지막 HTML 보고서는 `playwright-report/index.html`이며 `npx playwright show-report`로 열 수 있습니다.

## 실제 API·D1에서 확인한 동작

- 로그인·잘못된 PIN·재접속·별도 세션 로그아웃·미인증·다른 방 접근 거절.
- 동일 출처·요청 크기·모임 입력 검증, 초대 참가·정원 제한.
- 동시 일정 제출 보존, 빈 일정 제출, 정원 전원 제출 후 단계 전환.
- 참석 0명·1명에서 방장 날짜 재선택, 비방장 거절, 기존 응답·후보 보존.
- 마지막 미응답자 제거·탈퇴 후 즉시 지역 투표 진입, 방장 위임·탈퇴 권한.
- 날짜 재선택 전 revision·이전 투표 회차·결선의 잘못된 선택 거절.
- 동시 `A+C / A+B / B` 투표 보존, A/B 동률·재투표·최종 확정.
- `constructor`·`__proto__`·`toString` 정상 확정, 특수 지역 동률과 방장 추첨.
- 비참석 방장 투표 거절, 링크 저장·중복·작성자/방장 삭제 권한.

## 브라우저에서 확인한 동작

실제 D1에 연결한 서로 다른 세션에서 다음을 두 화면 크기로 검사했습니다.

- UI 로그인·초대 참가·일정 제출·날짜/지역 확정·새로고침 후 저장 결과 유지.
- 참석 부족 안내, 날짜 재선택 확인창 취소 시 상태 유지·승인 시 날짜 선택으로 복귀.
- 후보 추가·다른 참여자 제출의 실제 폴링 중 A+C 선택 유지, 새로고침 없이 A/B 결선 선택·제출.
- 지난 후보 제외, 미래 7개 후보에서 더보기로 전체 표시, 과거 수동 날짜 버튼 비활성화.
- 가로 넘침 없음, 하단 제출 버튼 접근, 바텀시트 닫기·Escape 이후 모달 제거·스크롤 복원·버튼 사용 가능.

시계·응답 순서 검사는 실제 화면에 고정 API 응답을 연결했습니다. 생산 `applyAction()`을 모의 서버로 재사용하지 않았습니다.

- 로딩 전 시계 설치 후 한국 자정 경과에 후보·입력 최소값·지난 슬롯 비활성화 갱신, 작성 중 응답 보존.
- 타이머를 실행하지 않는 시각 변경 후 `focus`·`visibilitychange` 이벤트로 기준일 갱신.
- 저장 후 뒤늦게 도착한 이전 GET이 최신 화면을 덮어쓰지 않음.
- 같은 참석 응답 재제출에도 현재 `regionRevision`을 포함한 POST 전송.

## 서버 격리·종료와 실패 자료

- 테스트가 만든 점유 서버로 4317 포트 충돌을 재현: 빌드 전에 종료 코드 1로 실패하고 점유 서버 유지.
- 빌드 중 SIGINT: 종료 코드 130, 생성한 임시 디렉터리 정리.
- 준비 완료 후 SIGTERM: 종료 코드 0, 생성한 서버 종료·4317 포트 해제·임시 D1 정리.
- 전체 검사 두 번 모두 Wrangler PID 종료와 임시 디렉터리 삭제를 별도로 확인.
- 기존 3000 개발 서버 PID 65161 유지. 작업 전후 개발 D1 파일 4개(SQLite·메타데이터·WAL·SHM)의 SHA 체크섬 일치.
- 처음 브라우저 검증에서 포커스 복귀 assertion이 실패했을 때 종료 코드 1, 스크린샷·trace·HTML·서버 로그가 실제 생성됐습니다. 해당 자료는 `outputs/verification/automation-first-failure/`에 보관했습니다.

프로젝트별 테스트 계정 3개를 재사용하며 재사용용 `storageState` 파일은 생성하지 않습니다. 실패 trace에는 임시 PIN·쿠키가 포함될 수 있지만 해당 계정·세션은 테스트 D1 정리 시 함께 삭제됩니다. 보고서와 인증 관련 산출물은 Git에서 제외했습니다.

## 후속 수정과 미검증 범위

- 구축 당시 발견한 **Escape 후 설정 버튼 포커스 미복귀 문제는 2026-10-04 후속 수정에서 해결**했습니다. 위 포커스 복원 항목에 실제 통과한 검사와 범위를 기록했습니다. 2026-10-02의 79개 검사에는 포커스 복귀 검증이 포함되지 않았습니다.
- 합성한 복귀 이벤트는 실제 OS 백그라운드 제한이나 실제 기기 동작의 검증이 아닙니다. WebKit·Firefox·실제 휴대폰은 검사하지 않았습니다.
- 구축 당시에는 원격 CI를 실행하지 않았습니다. 이후 기존 `main` 커밋 `9d9e698`의 [GitHub Actions 실행](https://github.com/just-stopyoon/WhenWeMeet/actions/runs/36988155432)이 성공한 것을 2026-10-04에 조회했습니다. 이 결과는 바텀시트 후속 수정의 원격 CI 결과와 별개입니다.
- 운영 DB·Sites/Cloudflare 배포·Vercel 게이트웨이·GA4는 검증에서 제외했습니다. 위 2026-10-02 로컬 구축 단계에서는 푸시·배포를 실행하지 않았습니다.

## 이전 검증 기록과의 관계

진행 막힘 수정 직후의 기존 단위 테스트 41개와 수동 로컬 HTTP 검증 157개는 앞선 작업의 결과였습니다. 이번 수치는 그 결과를 재사용하지 않고 새 임시 D1에서 자동 테스트를 실행한 결과입니다. 당시 미검증이었던 기본 확인창 승인, 재투표 전환, 폴링 중 선택 유지, 430px 모임 상호작용, 자정·복귀 이벤트는 위 자동 검사로 확인했습니다.
