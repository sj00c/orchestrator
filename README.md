# Orchestrator

로컬 프로젝트와 태스크의 **planned**(사용자가 의도한 수명주기) 및 **observed**(외부 증거로 관측한 상태)를 SQLite에 보관하는 Bun CLI입니다. 현재 MVP에는 observed 상태를 쓰는 공개 명령이 없습니다. `start` 같은 planned 명령은 observed 상태를 바꾸거나 두 상태의 불일치를 자동 보정하지 않습니다.

## Requirements and installation

- Bun **1.4.x** (SQLite는 Bun 내장 `bun:sqlite` 사용)
- 별도 서버, Git 저장소, 패키지 설치가 필요하지 않습니다.

저장소에서 실행합니다.

```sh
bun src/cli/main.ts --help
bun src/cli/main.ts --version
```

## Commands

전역 옵션은 `--db <path>`, `--json`, `--verbose`입니다.

```sh
# --root는 존재하는 디렉터리여야 하며 realpath로 정규화됩니다.
bun src/cli/main.ts project add --name demo --root .
bun src/cli/main.ts project list
bun src/cli/main.ts project show demo

bun src/cli/main.ts task add --project demo --title "release" --planned-state ready
bun src/cli/main.ts task list --project demo --planned-state ready
bun src/cli/main.ts task start <task-id>
bun src/cli/main.ts task pause <task-id>
bun src/cli/main.ts task resume <task-id>
bun src/cli/main.ts task block <task-id> --reason "waiting for approval"
bun src/cli/main.ts task complete <task-id>
bun src/cli/main.ts task cancel <task-id>
bun src/cli/main.ts task show <task-id>

bun src/cli/main.ts status --project demo
bun src/cli/main.ts history --project demo --limit 100
bun src/cli/main.ts history --task <task-id> --since 2026-01-02T03:04:05Z
```

Planned transition은 다음만 허용합니다: `start` (`planned|ready`), `pause` (`active`), `resume` (`paused|blocked`), `block` (`planned|ready|active|paused`), `complete` (`active|paused|blocked`), `cancel` (모든 비종료 상태). `done`과 `canceled`은 종료 상태입니다.

기본 출력은 사람이 읽는 형식입니다. `--json` 성공 결과는 stdout에 JSON v1 envelope으로 출력합니다. 이벤트 history payload에는 프로젝트 root 경로, task 제목·설명, block reason 같은 로컬 텍스트가 포함될 수 있습니다.

## Database location

DB 경로는 첫 번째 non-empty 값으로 결정됩니다.

1. `--db <path>`
2. `ORCHESTRATOR_DB`
3. `XDG_STATE_HOME/orchestrator/orchestrator.db`
4. `HOME/.local/state/orchestrator/orchestrator.db`

상대 경로는 현재 작업 디렉터리를 기준으로 해석됩니다. 선택 가능한 경로가 없으면 `CONFIG_ERROR`로 종료합니다.

## Exit and error contract

성공은 exit `0`입니다. 오류는 stderr에 출력되며 `--json`에서는 인수 파싱·DB 위치 설정 실패를 포함한 모든 오류가 JSON v1 error envelope으로 출력되어 stdout을 오염시키지 않습니다. 인수/설정/검증 오류는 exit `2`, not-found는 `3`, duplicate project 또는 invalid transition은 `4`, SQLite·migration·storage 오류는 `5`입니다. `--verbose`는 stderr에 command, duration, result만 기록하며 raw SQL이나 stack trace를 출력하지 않습니다.

## Offline WAL backup and restore

온라인/실행 중 backup은 지원하지 않습니다. 모든 orchestrator process를 종료하고 다른 process가 DB를 열지 않는 quiesced 상태에서만 수행합니다.

1. 전용 SQLite connection으로 `PRAGMA wal_checkpoint(TRUNCATE)`를 실행하고 반환 `busy=0`을 확인합니다. 실패 또는 busy면 중단합니다.
2. connection을 닫습니다.
3. writer/reader를 다시 시작하지 않은 채 main DB와 존재하는 `-wal`, `-shm` sidecar를 하나의 frozen file set으로 복사합니다. sidecar가 없으면 main DB만 복사합니다.
4. 새 경로에 전체 file set을 복원한 뒤 SQLite `integrity_check`, schema version, project/task/event count, aggregate의 마지막 event version과 current version을 확인합니다.

실행 중 main DB만 복사하거나 checkpoint 실패를 무시하는 절차는 지원하지 않습니다.

## Out of scope

이 MVP는 daemon, dashboard, 실제 process 제어·감시, Git/agent integration, network API, multi-host/distributed writer, 인증·권한, DB 암호화·동기화, project/task 삭제, public observed mutation, full event sourcing/projection replay/current rebuild, online backup을 제공하지 않습니다.
