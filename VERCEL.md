# Vercel 무료 주소 연결

이 저장소의 `vercel.json`은 Vercel에 Node.js 게이트웨이를 배포합니다. 앱과 D1 데이터는 기존 Sites/Cloudflare 배포에 남습니다. 전체 서버의 Vercel 이전이나 독립적인 Vercel DB 구성이 아닙니다. 기존 Sites 배포를 삭제하면 Vercel 주소도 작동하지 않습니다.

## 기존 Vercel 프로젝트

1. Git 저장소 `just-stopyoon/WhenWeMeet`, Production Branch `main`을 연결합니다.
2. Root Directory는 저장소 루트로 설정합니다.
3. 이 변경을 push하면 새 배포가 시작됩니다. 자동 실행되지 않으면 Deployments에서 최신 커밋으로 Redeploy합니다.
4. `vercel.json`에 Framework `null`, 설치 명령 `node --version`, 빌드 명령 `node scripts/build-vercel.mjs`, 출력 폴더 `.vercel-static`이 지정되어 있습니다. Cloudflare용 `npm run build`를 Vercel에서 실행하지 않습니다.
5. 배포가 Ready가 되면 기존 `when-we-meet-eight.vercel.app`에서 로그인하고 모임을 확인합니다.

`when-we-meet.vercel.app`은 Settings → Domains에서 사용 가능할 때만 추가할 수 있습니다. 사용 가능 여부는 확인되지 않았으며 현재 연결된 주소를 임의로 제거하지 않습니다. 친구가 접근할 Production 주소는 Vercel 로그인을 요구하지 않아야 합니다.

## 데이터와 보안

### GA4

Vercel HTML에 측정 ID `G-R553VVDCZ4`의 Google tag를 한 번 삽입합니다. Sites 원본 주소와 localhost에는 삽입하지 않습니다. 기본 방문 측정이며 투표 등의 별도 사용자 정의 이벤트는 아직 없습니다.

분석 주소는 현재 도메인의 `/`로 고정해 `join` 초대 코드를 제외합니다. 유입 주소도 도메인만 전달하고 제목은 고정합니다. 닉네임·PIN·방 이름·계정 ID를 분석 이벤트로 전송하지 않습니다. Google Signals와 광고 개인화 신호는 비활성화합니다.

배포 후 GA4 실시간 보고서에서 방문을 확인하세요. GA4 웹 스트림의 향상된 측정에서 불필요한 양식 상호작용 수집을 끄고, 데이터 수정에서 `join` 쿼리 매개변수 삭제도 설정하는 것을 권장합니다. 브라우저 추적 차단으로 방문이 수집되지 않을 수 있습니다.

- 초대 링크는 현재 접속한 Vercel 주소로 생성됩니다.
- Vercel 주소에서 최초 한 번 다시 로그인해야 합니다. 계정과 모임은 기존 DB를 그대로 사용합니다.
- API 쓰기 요청은 게이트웨이에서 같은 출처인지 먼저 검사한 후 기존 서버에 전달합니다.
- 앱의 로그인 쿠키만 전달하며 Vercel 인증 쿠키는 전달하지 않습니다.
- 사용자 응답은 공유 캐시에 저장하지 않습니다. 요청 대상은 지정된 기존 앱으로 고정합니다.
- 기존 앱의 4자리 PIN 및 패키지 보안 경고를 해결하는 변경은 아닙니다.

Vercel Hobby는 개인·비상업적 용도의 무료 요금제이며 사용량 제한이 있습니다. 이 구성은 기존 Sites/Cloudflare 사용 조건에도 의존합니다.

공식 문서: https://vercel.com/docs/functions/configuring-functions/runtime
https://vercel.com/docs/routing/rewrites
https://vercel.com/pricing
