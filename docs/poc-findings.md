# nativecast PoC 검증 결과

spec의 "먼저 검증할 위험" 여섯 항목을 실제 앱과 호스트로 확인한 기록이에요. 다섯 항목은 확인했고, 전역 단축키는 실제 키 입력 하나가 남았어요. 처음에는 화면이 잠겨 있었고, 잠금이 풀린 뒤 포커스를 다시 시험했어요. 이 프로세스에는 Accessibility 권한이 없어서(`AXIsProcessTrusted` 0) 키 이벤트를 보낼 수 없어요.

UI 스택은 지금 Electrobun으로 바꾸지 않아요. 다만 이 판단은 실제 단축키와 실제 한글 입력을 사람이 확인할 때까지 잠정이에요.

환경: macOS 26.6.2, Apple silicon, Node 26.9.0, Bun 1.4.4, Zig 0.16.0, Native CLI 0.11.0(`16f2957`).

## 위험 항목별 결과

| 항목 | 결과 | 근거 |
| --- | --- | --- |
| 1. 앱과 호스트 연결 | 동작해요 | 실제 앱이 호스트를 띄우고 검색 결과를 스트리밍으로 받아요. e2e 12개가 5회 실행에서 모두 통과했어요 |
| 2. 입력마다 새 검색과 취소 | 동작해요, 설계를 바꿨어요 | 같은 key 방식은 실제로 요청을 잃어요. key 없는 fetch와 호스트 쪽 취소로 바꿨어요 |
| 3. 전역 단축키 | 일부 확인 | 헬퍼 컴파일과 등록, `HOTKEY` 이후 경로는 동작해요. 실제 키 입력은 확인하지 못했어요 |
| 4. 숨긴 창의 키보드 포커스 | 동작해요 | 다른 앱이 앞에 있을 때 창과 검색창이 포커스를 받아요. 숨기면 원래 앱으로 돌아가도록 고쳤어요 |
| 5. 배포 시 호스트 경로 | 동작해요 | `open`으로 띄운 `.app`이 번들 안 호스트를 찾아 실행해요 |
| 6. 패키지 크기 | 측정했어요 | `.app` 약 111MB, DMG 약 55MB예요 |

### 1. 앱과 호스트 연결

앱은 `Cmd.spawn`으로 호스트를 띄우고, 호스트의 첫 줄 `READY <port> <token>`을 받아 `Cmd.fetch` 주소를 만들어요. 결과는 한 줄씩 도착해서 목록에 바로 보여요.

- 느린 확장이 있어도 빠른 확장의 결과가 먼저 보여요.
- 앱 프로세스를 종료하면 호스트와 헬퍼도 함께 종료돼요. SIGTERM으로 확인했고, 메뉴의 Quit은 시험하지 않았어요.
- spec의 "호스트 단독 검색"과 달리 이번에는 앱까지 연결해서 실행했어요.

### 2. 입력할 때마다 새 검색

spec이 걱정한 대로 같은 key로 묶으면 요청이 사라져요. 800ms 걸리는 확장에 `a`, `ab`, `abc`를 100ms 간격으로 넣어 비교했어요.

| 방식 | 호스트가 받은 검색 | 앱이 받은 오류 |
| --- | --- | --- |
| `Cmd.cancel("search")` + 같은 key의 `Cmd.fetch` | `a`, `abc` | `ab`가 `rejected`, 이어서 `cancelled` |
| key 없는 `Cmd.fetch` + 호스트 쪽 취소 | `a`, `ab`, `abc` | 없음 |

첫 번째 방식에서 `ab`는 호스트에 도착하지도 않았어요. 오류 순서로 보면 `Cmd.cancel` 직후에는 key가 아직 비어 있지 않은 것 같아요. 엔진 코드까지 확인하지는 않았어요. 마지막 글자가 이 구간에 걸리면 마지막 검색어의 결과가 영영 나오지 않아요.

그래서 이렇게 정했어요.

- 앱은 검색마다 key 없이 `Cmd.fetch`를 보내고 `seq`를 붙여요.
- 호스트는 새 검색을 받으면 이전 검색의 `ctx.signal`을 abort하고 이전 스트림을 닫아요.
- 앱은 현재 `seq`가 아닌 줄을 버려요.

30번 연속 입력(3.2초)에서 호스트가 30번 시작하고 29번 취소했고, 마지막 결과만 남았어요. 오류는 없었어요. 엔진의 동시 효과 한도는 `max_effects = 16`인데, 호스트가 이전 스트림을 바로 닫아서 이 한도에 가까이 가지 않아요. 이 시험의 입력 간격은 약 100ms라서, 그보다 빠른 입력은 시험하지 않았어요.

### 3. 전역 단축키

`helpers/hotkey.c`가 Carbon `RegisterEventHotKey`로 Control+Option+Space를 등록해요. 이 머신에서 Raycast가 돌고 있어서 Option+Space를 피했어요.

- 확인했어요: 헬퍼가 컴파일되고, 등록이 성공해서 `READY`를 출력하고, 앱이 끝나면 함께 종료돼요.
- 확인했어요: 헬퍼 stdout의 `HOTKEY`가 호스트를 거쳐 앱까지 가고, 숨긴 창이 화면에 올라와요. 이때는 헬퍼 대신 같은 줄을 출력하는 임시 스크립트를 썼어요.
- 확인하지 못했어요: 실제 키를 눌렀을 때 Carbon이 헬퍼에 이벤트를 주는지예요. 잠금이 풀린 뒤에도 `CGEventPost`로 보낸 키에 반응이 없었어요. `AXIsProcessTrusted`가 0이라 키가 전달되지 않은 것으로 보여요. 권한 부여는 시도하지 않았어요.

헬퍼는 앱이 아니라 호스트가 띄워요. 앱의 고정 argv에는 호스트 하나만 두고, 호스트는 자기 옆의 헬퍼를 찾으면 되기 때문이에요. spec의 `channel_sources` 경로는 시도하지 않았어요.

`RunApplicationEventLoop`는 64비트 헤더에서 빠져 있지만 심볼은 남아 있어서 직접 선언했어요. 이 호출이 실제 이벤트를 받는지도 위 미확인 항목에 포함돼요.

### 4. 숨긴 창의 키보드 포커스

잠금을 푼 화면에서 Helium을 앞에 두고 시험했어요. 헬퍼 자리에 `HOTKEY`를 출력하는 임시 스크립트를 두어서 키 입력만 뺀 같은 경로를 탔어요.

- 동작해요: `HOTKEY` 뒤 앞 앱이 `nativecast`로 바뀌고, 창과 검색창이 모두 `focused=true`예요. 사용자 입력이 앱에 직접 들어오지 않아도 활성화됐어요.
- 동작해요: chromeless 창 크기는 640×420이에요. 잠금 화면에서 보인 576×379는 잠금 해제 상태에서 나오지 않았어요.
- 문제가 있어서 고쳤어요: `Cmd.hideWindow`는 창만 내리고 앱은 앞에 남아요. 3회 모두 앞 앱이 `nativecast`로 남아서, 키 입력이 사라지는 창으로 가요.
- 고친 방법: 호스트가 `HOTKEY` 때 앞 앱 경로를 기억하고, 앱이 숨을 때 `POST /restore-focus`를 받으면 `open -a`로 되돌려요. 3회 모두 0.3초 안에 Helium으로 돌아왔어요. `lsappinfo setfront`는 `permErr`로 거절돼서 쓰지 못해요.
- 남은 한계: `open -a`는 창이 없는 앱이면 새 창을 열 수 있어요. 메뉴 막대로 연 경우에는 기억한 앱이 없어서 되돌리지 않아요. Native SDK에 `[NSApp hide:]` 명령이 생기면 이 우회를 지울 수 있어요.
- 원인을 못 찾았어요: 시험 중 한 번 앞 앱이 `UserNotificationCenter`로 바뀌었고, 그 상태에서 창을 띄우자 `focused=false`였어요. 시스템 알림 창이 떠 있었던 것으로 보이지만 화면을 직접 보지 못했어요.
- 시험 안 했어요: 다른 Space, 전체 화면 앱 위에서 띄우는 경우예요.

### 5. 배포 시 호스트 경로

`Cmd.spawn`의 argv를 고정 문자열로 두고 `/bin/sh`가 경로를 찾아요.

```sh
exec "${NATIVECAST_HOST:-$(dirname "$(ps -o comm= -p $PPID)")/nativecast-host}"
```

- `open dist/nativecast.app`으로 띄우면 작업 폴더가 `/`이고 환경 변수가 없어도 `Contents/MacOS/nativecast-host`와 헬퍼가 떠요.
- `exec` 덕분에 호스트의 부모는 앱이에요.
- 번들 안 호스트를 `env -i`로 실행해도 외부 `.ts`를 번들링하고 검색까지 해요. Bun이 PATH에 없어도 돼요.
- 개발 빌드는 번들이 없어서 `NATIVECAST_HOST`로 경로를 줘요. 자식은 앱의 환경을 물려받아요.

호스트는 `native package`의 asset으로 넣을 수 없어서 패키징 뒤에 `Contents/MacOS/`로 복사하고 다시 서명해요. 89MB 파일에서 `error: StreamTooLong`으로 실패하고, 들어간 파일의 실행 권한도 사라져요(`scripts/package.sh`).

서명된 배포본의 Gatekeeper 동작은 범위 밖이라 시험하지 않았어요. ad-hoc 서명만 확인했어요.

### 6. 패키지 크기

| 대상 | 크기 |
| --- | --- |
| 앱 바이너리 | 12MB |
| 호스트 | 89MB |
| Noto Sans KR | 10MB |
| 헬퍼 | 34KB |
| `.app` | 약 111MB (106MiB) |
| DMG(UDZO) | 약 55MB (53MiB) |

DMG 기준 55MB라서 Bun을 앱에 넣어도 감당할 만해요. spec의 미정 항목은 "앱에 넣는다" 쪽으로 제안해요. 첫 실행이 네트워크에 의존하지 않기 때문이에요.

## Electrobun 전환 판단

지금은 바꾸지 않아요. 확인한 다섯 항목에서 Native SDK를 포기할 이유가 나오지 않았어요. 전환 기준은 spec대로 위험 항목의 실패인데, 실패한 항목이 아직 없어요.

아래 중 하나가 나오고 앱 쪽에서 우회가 안 되면 전환해요.

1. 실제 단축키가 헬퍼에 도착하지 않아요.
2. 실제 한글 IME 입력이 깨져요. 자동화로는 `set_composition`과 `commit_composition` 경로만 확인했어요.

전환 비용은 작아요. `host/`는 Native SDK에 의존하지 않고, 호스트 단독으로 `curl` 검색이 돌아요. 앱 쪽의 `app/src/core.ts`와 `app/src/app.native`만 다시 쓰면 돼요.

Native 쪽에 쌓이는 비용도 적어 둘게요. 앱 코어의 컴파일 제약이 생각보다 까다로웠고(아래 참고), 호스트를 패키지에 넣는 공식 경로가 없어요. Electrobun은 이번에 시험하지 않았어요.

## Native SDK 문제

spec의 세 문제를 다시 확인했어요.

- 재현됐어요: `tests/ts-core/gpu-dashboard-reference/main.zig` 누락이에요. `scripts/setup-native.sh`가 v0.11.0 태그에서 받아 넣어요.
- 재현됐어요: Node 26의 `ERR_UNSUPPORTED_NODE_MODULES_TYPE_STRIPPING`이에요. CLI를 `node_modules` 밖으로 복사해서 실행해요.
- 재현되지 않았어요: 자동화 빌드 멈춤이에요. 10분 제한 안에 매번 끝났어요.

새로 만난 문제예요.

- 문서가 바이트 텍스트의 `split`, `startsWith`를 지원한다고 적고 있지만 컴파일러가 `SC0001`로 거절해요. 직접 구현했어요.
- 정수 증명이 리터럴 비교만 인정해요. `MAX_SEQ` 같은 상수로는 증명이 안 돼요. 모델 값을 `Row.id`에 넣는 코드는 범위 검사를 붙여도 `SC4022`로 거절돼서, 목록 번호를 `.map`의 index로 만들었어요.
- 기본 폰트에 한글이 없어서 모든 한글이 네모로 나와요. spec에 없던 문제예요. `assets.fonts`로 Noto Sans KR을 등록하고 `tokenOverrides`의 `font_id`로 지정해서 해결했어요. 폰트는 저장소에 넣지 않고 `scripts/setup-native.sh`가 내려받아요. 렌더링은 자동화 스크린샷으로 확인했는데, 이 스크린샷은 CPU 참조 렌더러라서 실제 Metal 화면 캡처는 아니에요. Screen Recording 권한이 없어서 실제 창 캡처는 실패했어요.
- `native package`가 큰 asset에서 `StreamTooLong`으로 실패하고 asset의 실행 권한을 없애요.
- `app.json`의 `allowed_urls`가 틀리면 어느 필드인지 없이 `manifest fields failed semantic validation`만 나와요.
- 앱 단축키는 `NSEvent` local monitor에서 먼저 처리되고 IME 조합 상태를 보지 않아요. 코드만 확인했어요. 조합 중에 방향키나 Esc를 누르면 조합이 아니라 앱 단축키로 갈 수 있어요.

## 구현 결정

- 호스트 요청은 `POST /`이고 본문은 `<seq>\t<query>`예요. URL 인코딩을 앱 코어에서 구현하지 않기 위해서예요.
- 응답은 탭 구분 줄이에요. `S <seq>`, `R <seq> <source> <title> <subtitle> <url|copy> <value>`, `D <seq>`예요. 호스트가 탭과 줄바꿈을 공백으로 바꾸고 필드를 1,500바이트로 잘라서 한 줄이 `maxLineBytes` 8192 안에 들어와요.
- 호스트 이벤트는 stdout의 `READY`, `HOTKEY`, `LOADED`, `ERROR`, `REMOVED`예요.
- loopback 포트는 임의 포트이고, 호스트가 시작할 때 만든 토큰을 `Authorization: Bearer`로 확인해요. spec의 미정 항목이지만 다른 프로세스가 확장을 실행할 수 있어서 넣었어요. 토큰 없는 요청은 401이에요.
- `stock 삼성`처럼 첫 단어가 등록된 keyword이면 그 source만 실행해요. 그 밖의 검색은 keyword가 있는 source까지 모든 source에 가요.
- 시간 제한은 검색 5초, 훅 1초예요. 측정값이 아니라 임시값이에요.
- 재로드는 측정에서 5~29ms가 걸렸어요. 번들링을 포함한 값이고, 작은 확장 기준이에요.
- 교체되는 Worker에 걸린 검색은 빈 결과로 끝나요.
- 단축키 기본값은 Control+Option+Space예요. 설정 기능은 없어요.

## 시험

`tests/e2e.test.ts`는 실제 앱, 실제 호스트, 실제 확장 파일로 돌아가고 mock이 없어요. 네트워크도 쓰지 않아요.

다루는 동작이에요: 파일 추가, 수정, 깨진 확장과 복구, 삭제, `query` 훅, keyword, `node_modules` 패키지 확장, 느린 검색, 취소, 조합 입력, 방향키 선택과 Enter 복사, 앱 종료 시 프로세스 정리.

- spec과 달리 시험마다 앱을 띄우지 않고 파일당 하나를 써요. 전체 약 15초예요.
- `set_text`와 `set_composition`은 앱의 입력 경로를 타지만 macOS 입력기를 거치지 않아요.
- 방향키는 `automate shortcut`으로 보냈어요. 실제 키 입력은 시험하지 않았어요.
- URL 열기는 브라우저를 띄우기 때문에 시험하지 않았어요. 복사만 확인했어요.
- 복사 시험은 시스템 클립보드를 쓰고 텍스트만 되돌려요. 이미지 같은 내용은 복구하지 않아요.

`scripts/verify-hotkey-focus.sh`는 사람이 돌리는 확인이에요. 실제 단축키, 포커스, 실제 IME, Esc 뒤 복귀를 봐요. 사람이 누른 결과는 아직 없어요. 포커스와 복귀는 앞의 임시 스크립트 시험으로 따로 확인했어요.

## 생략한 범위

- 훅 `results`, `action`, `show`, `hide`예요. `query`만 있어요.
- `ctx`는 `signal`만 있어요. 대화상자, `actions`, `prefs`, `secrets`는 없어요. 실행 동작은 결과의 `url`과 `copy` 필드로 대신해요.
- Effect 어댑터, 내장 에이전트(pi SDK), `ext test`, 타입 선언 배포, `AGENTS.md`, skill이에요.
- 확장별 오류 목록이에요. 상태 표시줄은 마지막 이벤트 하나만 보여 줘요.
- 호스트가 죽었을 때 다시 띄우는 처리예요. 상태 표시줄에 표시만 해요.
- 단축키 설정, 결과 아이콘, 창 디자인, 코드 서명과 공증이에요.

## 다음 단계

1. `scripts/verify-hotkey-focus.sh`를 사람이 돌려서 실제 단축키와 한글 입력을 확인해요. 전환 판단은 여기서 끝나요.
2. 단축키가 오지 않으면 `RunApplicationEventLoop` 대신 `NSApplication` 이벤트 루프로 헬퍼를 바꿔 봐요.
3. Native SDK 문제 중 패키징과 문서 불일치를 upstream issue로 올려요.
