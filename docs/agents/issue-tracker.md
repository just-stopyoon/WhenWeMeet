# Issue tracker: GitHub

이 저장소의 이슈와 명세는 https://github.com/just-stopyoon/WhenWeMeet/issues 에서 관리한다.
`gh` CLI를 사용하며, 아래 명령은 저장소 루트에서 실행한다.
다른 디렉터리에서는 `--repo just-stopyoon/WhenWeMeet`을 지정한다.

## 기본 작업

- 생성: `gh issue create --title "제목" --body-file <본문파일>`
- 조회: `gh issue view <번호> --json number,title,body,labels,comments`
- 목록: `gh issue list --state open --limit 100 --json number,title,body,labels,comments`
- 번호·제목·라벨만 보는 목록: `gh issue list --state open --limit 100 --json number,title,labels --jq '.[] | "#\(.number) \(.title) [\([.labels[].name] | join(", "))]"'`
  (`labels`는 객체 배열이므로 `.labels[].name`으로 이름만 꺼낸다)
- 본문 수정: `gh issue edit <번호> --body-file <본문파일>`
- 댓글: `gh issue comment <번호> --body-file <댓글파일>`
- 라벨 추가·제거: `gh issue edit <번호> --add-label "<라벨>"` 또는 `--remove-label "<라벨>"`
- 종료: `gh issue close <번호>`

조회 목적에 따라 `--label`, `--state`, `--limit`을 조정한다.
전체 목록이 필요하면 페이지네이션으로 누락 없이 조회한다.
여러 줄 본문은 임시 파일에 작성하고 `--body-file`로 전달한다.
라벨 이름은 [라벨 매핑](triage-labels.md)을 따른다.

스킬이 “publish to the issue tracker”라고 하면 GitHub 이슈를 생성한다.
“fetch the relevant ticket”이라고 하면 해당 이슈의 본문·댓글·라벨을 조회한다.

## Pull requests as a triage surface

**PRs as a request surface: no.**

GitHub의 이슈와 PR은 번호 공간을 공유한다.
종류가 불명확한 번호는 `gh pr view <번호>`로 확인하고,
PR이 아닌 경우 `gh issue view <번호>`로 조회한다.

## 하위 이슈와 의존 관계

- 하위 이슈 생성: `gh issue create --parent <부모번호> --title "제목" --body-file <본문파일>`
- 기존 이슈 연결: `gh issue edit <부모번호> --add-sub-issue <자식번호>`
- 선행 작업 지정: `gh issue edit <자식번호> --add-blocked-by <선행번호>`
- 관계 조회: `gh issue view <번호> --json number,state,assignees,parent,subIssues,blockedBy`

설치된 CLI에서 옵션을 지원하지 않으면 GitHub API의 동등한 기능을 사용한다.
트래커 자체가 관계를 지원하지 않을 때만 다음 본문 규칙을 사용한다.

- 하위 이슈: 자식 본문 상단에 `Part of #<부모번호>`, 부모 본문에 자식 작업 목록
- 의존 관계: 자식 본문 상단에 `Blocked by: #<선행번호>`

모든 선행 이슈가 닫혀야 의존 관계가 해소된 것으로 판단한다.

## Wayfinding operations

`wayfinder`를 실행할 때 다음 규칙을 사용한다.

- Map: `wayfinder:map` 라벨의 단일 이슈에 Notes, Decisions-so-far, Fog를 기록한다.
- Child ticket: Map의 하위 이슈로 연결하고
  `wayfinder:research`, `wayfinder:prototype`, `wayfinder:grilling`,
  `wayfinder:task` 중 해당 유형을 사용한다.
- Blocking: 위의 GitHub 의존 관계로 선행 작업을 연결한다.
- Frontier query: Map의 열린 자식 중 열린 선행 작업과 담당자가 없는 이슈를
  Map에 기록된 순서대로 선택한다.
- Claim: `gh issue edit <번호> --add-assignee @me`로 담당자를 지정한다.
- Resolve: 결과 댓글을 남기고 이슈를 닫은 뒤,
  Map의 Decisions-so-far에 결정 요약과 결과 링크를 추가한다.

Wayfinding 라벨은 해당 워크플로를 실행할 때 필요한 것만 준비한다.
