# Threads → X 자동 게시

내 Threads 계정의 새 글을 읽어 X에 올리는 Windows용 프로그램입니다. 본문과 사진·영상을 옮기고, 내가 작성한 쿠팡 링크 댓글은 해당 X 게시물에 직접 답글로 붙입니다. 댓글의 안내 문구와 링크의 제휴 파라미터도 함께 복사합니다.

## 화면에서 설정하기

**`Open-Relay.cmd`**를 더블클릭하면 브라우저에서 `http://127.0.0.1:53683`이 열립니다. Node.js 24 이상이 필요합니다. 터미널에서는 `npm.cmd run ui -- --open`으로도 열 수 있습니다.

1. **계정 연결**에서 Threads 토큰을 검증하고 저장합니다. X의 콜백 주소는 연결 화면에서 복사할 수 있습니다. OAuth 2.0 Client ID를 입력하고 X의 승인 탭을 엽니다.
2. **미리보기**로 최근 Threads 게시물과 쿠팡 답글 구성을 확인합니다. **설정 → 자동화 시작**을 누르면 Windows 로그인 시 백그라운드 실행도 설정합니다.
3. **게시 활동**의 상세 화면에서 실패한 답글의 대상 게시물을 열거나 본문을 복사할 수 있습니다. 수동으로 게시했다면 X 주소를 붙여넣어 완료 처리합니다.

화면을 닫아도 시작한 자동화는 Windows에서 계속 실행됩니다. **설정 → 자동화 중지**를 선택하면 로그인 시 자동 실행도 함께 중지됩니다. 토큰과 게시 기록은 PC에 저장됩니다.

### 계정 다섯 쌍 연결하기

1. **계정 연결**에서 1~5번 중 하나를 선택하고 연결 이름을 주제에 맞게 바꿉니다. 예를 들어 `생활용품` 연결에는 생활용품 Threads 계정과 생활용품 X 계정을 설정합니다.
2. 각 연결에 해당 Threads 계정의 사용자 토큰을 입력하고 해당 X 계정으로 승인합니다. X 승인 탭에서 로그인 중인 계정을 확인하세요. 1번에서 사용한 X 개발자 앱은 다른 연결에서도 선택할 수 있습니다. Threads 토큰과 X 사용자 승인은 계정마다 필요합니다.
3. 각 연결에서 미리보기로 내용과 계정명을 확인한 뒤 **설정 → 자동화 시작**을 누릅니다. 새 글 확인 주기와 게시 활동은 상단에서 선택한 연결의 정보를 보여줍니다.

기존 단일 계정 설정과 기록은 1번에 이어집니다. 2~5번은 `data/pairs/` 아래 별도 설정·기록 파일에 저장됩니다. 연결마다 Windows 작업을 따로 실행하므로, 한 연결을 중지해도 다른 연결의 작업은 계속됩니다. 터미널에서는 `node sync.mjs status --profile 2`처럼 끝에 번호를 지정할 수 있습니다.

### X 계정 분석

상단에서 X 계정을 연결한 프로필을 선택하고 **X 분석**에 비교할 공개 X 계정을 최대 5개 입력합니다. `@계정`이나 X 프로필 주소를 사용할 수 있습니다. 최근 14·30·60일과 계정별 최대 25·50·100개 조회 범위를 선택합니다. **분석 시작**을 눌렀을 때만 공개 계정과 타임라인을 조회합니다. 같은 조회 조건의 결과는 15분간 메모리에 재사용합니다. [X 사용자 게시물 API](https://docs.x.com/x-api/users/get-posts) · [X API 조회 비용](https://docs.x.com/x-api/getting-started/pricing)

- 요일과 한국 시간 4시간 구간별 게시량과 반응 점수를 비교합니다. 비교 표본이 3건 이상이고 점수가 해당 계정의 평소 수준을 웃도는 구간은 실험할 시간 후보로 표시합니다.
- 계정별 주간 게시 빈도, 게시물당 중앙값, 콘텐츠 형식, 본문 길이, 쿠팡 링크 위치와 상위 반응 게시물의 주소를 보여줍니다. **쿠팡 링크 감지 글**로 전환하면 해당 원글만 비교할 수 있습니다. 본문 또는 조회 범위의 본인 답글에서 X가 제공한 확장 링크를 사용합니다.
- 게시 후 48시간이 지난 글의 `좋아요 + 답글 + 리포스트 + 인용`을 집계합니다. 노출이 충분한 계정은 노출 대비 반응률을 사용하고, 다른 계정은 반응 수를 사용합니다. 점수를 계정 내 백분위로 바꿔 집계하고 계정별 중앙값에 같은 비중을 줍니다. 링크 클릭, 전환, 매출은 공개 지표에 포함되지 않습니다. [Buffer 시간대 연구](https://buffer.com/resources/best-time-to-post-on-twitter-x/) · [Socialinsider 계정 비교 지표](https://www.socialinsider.io/twitter-analytics) · [X 공개 지표](https://docs.x.com/x-api/fundamentals/metrics)

**설정 → 확인 및 게시 주기**에서 다음 항목을 조절할 수 있습니다. 저장한 주기는 실행 중인 자동화에 적용됩니다. 이전 버전에서 실행 중이던 자동화는 프로그램을 업데이트한 후 한 번 다시 시작해야 새 설정을 읽습니다.

- **새 글 확인** `POLL_SECONDS` · 기본 60초
- **쿠팡 댓글 확인** `REPLY_POLL_SECONDS` · 새 글을 처음 가져올 때 댓글도 확인합니다. 이후에는 기본 300초마다 다시 확인합니다.
- **X 게시** `X_PUBLISH_SECONDS` · 확인된 순서대로 게시합니다. 간격을 지정하면 한 번에 글 한 건과 그 글의 대기 중인 답글을 게시합니다. 이미 게시된 글의 늦은 댓글은 대기열에 추가됩니다. 기본 0초는 별도의 대기 시간 없이 순서대로 게시합니다.
- **댓글 확인 기간** `REPLY_LOOKBACK_DAYS` · 기본 7일이며 Threads 원글 게시일부터 계산합니다.

아래는 터미널로 연결하거나 실행할 때 사용하는 절차입니다.

## 1. 계정 준비

1. Meta 개발자 콘솔에서 Threads 사용 사례가 포함된 앱을 만듭니다. 개발 모드에서 사용할 Threads 계정을 앱 역할 또는 Threads Tester로 등록하고, 테스터 초대가 표시되면 Threads 계정에서 수락합니다. Meta의 Threads 토큰 생성 화면이나 공식 OAuth 절차로 `threads_basic`, `threads_read_replies` 권한을 가진 **Threads 사용자 토큰**을 발급합니다. [Meta Threads API 시작 가이드](https://www.postman.com/meta/threads/documentation/dht3nzz/threads-api)
2. X 개발자 콘솔에서 앱을 만들고 사용자 인증 설정에서 읽기 및 쓰기 권한과 OAuth 2.0 Native App을 설정합니다. 콜백 URL에 `http://127.0.0.1:53682/callback`을 등록합니다. OAuth 2.0 **Client ID**를 복사합니다. 이미 비밀 키가 있는 Web App을 사용한다면 Client Secret도 복사합니다. X API 사용에는 크레딧이 필요할 수 있습니다. [X 개발자 콘솔](https://developer.x.com/en/portal/dashboard) · [X OAuth 설정](https://docs.x.com/fundamentals/authentication/oauth-2-0/authorization-code)

**X 답글 제한** · X 공식 문서는 셀프서비스 API에서 원글 작성자가 답글 계정을 멘션하거나 인용한 경우에만 API 답글을 허용한다고 명시합니다. 계정에서 자기 게시물에 대한 API 답글까지 거절되면 쿠팡 댓글과 대상 주소가 `manual`로 남습니다. 이 경우 X에서 직접 답글을 작성해야 합니다. X Enterprise API에는 이 셀프서비스 제한이 적용되지 않습니다. [X 답글 제한](https://docs.x.com/x-api/posts/manage-tweets/integrate#post-creation-restrictions-self-serve)

## 2. 설치와 미리보기

Windows PowerShell과 Node.js 24 이상이 필요합니다. 프로젝트 폴더에서 실행합니다.

```powershell
$env:NODE_USE_SYSTEM_CA = '1'
npm.cmd ci --ignore-scripts
if (-not (Test-Path -LiteralPath .env)) { Copy-Item .env.example .env }
notepad .env
```

`.env`에 `THREADS_ACCESS_TOKEN`과 `X_CLIENT_ID`를 입력합니다. Threads 단기 토큰을 받았다면 `THREADS_APP_SECRET`도 입력해 첫 연결 시 장기 토큰으로 교환합니다. 이미 장기 토큰이면 이 값은 비웁니다. Native App이면 `X_CLIENT_SECRET`도 비웁니다. 토큰과 동기화 상태는 로컬 `.env` 및 `data` 아래에 저장됩니다.

```powershell
node sync.mjs auth-x
node sync.mjs check
node sync.mjs preview --limit 3
```

`auth-x`가 출력하는 주소를 브라우저에서 열고 게시할 X 계정으로 승인합니다. `check`는 연결된 계정과 Threads 댓글 조회를 확인합니다. `preview`는 최근 글 세 개의 게시 예정 본문과 쿠팡 댓글을 보여줍니다. 두 명령은 X에 글을 쓰지 않으며, 게시 권한과 답글 제한은 실제 X 게시 요청 때 확정됩니다.

## 3. 자동 실행

처음 실제 동기화를 실행한 시점 이후의 글부터 감지합니다. 기존 글도 옮기려면 **첫 실제 실행 전에** `.env`의 `SYNC_FROM`을 원하는 한국 시각으로 설정합니다. 예를 들어 `SYNC_FROM=2026-11-23T09:00:00+09:00`이면 해당 시점 이후를 가져옵니다. 최초 시작 시각은 SQLite에 저장됩니다.

```powershell
# 한 차례 확인하고, 게시할 시간이 되면 대기열을 처리한 뒤 종료
node sync.mjs once

# 현재 창에서 계속 실행
node sync.mjs run
```

Windows 로그인 때 자동으로 시작하려면 아래 명령으로 작업을 등록합니다. 등록 직후에도 실행됩니다. 이 방식은 해당 Windows 계정으로 로그인한 동안 PC가 켜져 있어야 동작합니다. 다시 켜면 SQLite 상태를 기준으로 이어서 처리합니다.

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File .\windows-task.ps1 -Action Install
powershell -NoProfile -ExecutionPolicy Bypass -File .\windows-task.ps1 -Action Status
powershell -NoProfile -ExecutionPolicy Bypass -File .\windows-task.ps1 -Action Stop
```

## 4. 상태와 게시 실패

```powershell
node sync.mjs status
Get-Content .\data\worker.log -Tail 40
```

- `manual`이면 표시된 X 게시물 주소를 열어 답글을 작성합니다. 게시한 답글 주소를 `node sync.mjs posted 123456:0 <X_답글_주소>`에 전달하면 작성자와 답글 대상을 확인한 뒤 완료로 기록합니다. `123456:0`은 `status`의 실제 항목 ID로 바꿉니다.
- `review`는 전송 처리 중 연결이 끊겼거나 X의 응답이 불분명한 상태입니다. X에서 실제 게시 여부를 확인한 뒤 게시되었으면 `posted`, 게시되지 않았으면 `node sync.mjs retry 123456:0`을 사용합니다. 프로그램은 `review` 항목을 자동 재전송하지 않습니다.
- `blocked`는 X가 본문 게시를 거절한 상태입니다. 오류 원인을 해결한 뒤 `retry`로 다시 시도합니다.

긴 본문은 X의 가중 글자 수에 맞춰 이어지는 답글로 올립니다. 사진 4장을 초과하거나 사진과 영상이 섞인 앨범에도 이어지는 답글을 사용합니다. 인용·리포스트·투표·오디오처럼 Threads 형식으로 제공되는 콘텐츠에는 Threads 원문 링크를 포함합니다. 미디어는 X가 허용하는 파일 형식과 용량을 따릅니다. 이미 복제한 글의 수정이나 삭제는 이 자동화의 범위 밖입니다. [X 문자 계산](https://docs.x.com/fundamentals/counting-characters) · [X 게시와 미디어 규격](https://docs.x.com/x-api/posts/create-post)

로컬 테스트는 `npm.cmd test`로 실행합니다.
