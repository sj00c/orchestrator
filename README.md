# Orchestrator

Orchestrator is a macOS user-session daemon for local project, task, schedule, and managed-process state. The daemon is the only product process that opens SQLite. The CLI is a client of the daemon's private HTTP/JSON v1 Unix-domain socket (UDS); it never falls back to a direct database connection.

## Requirements

- macOS and Bun 1.4.x
- A login user session (the service is a user `LaunchAgent`)

Run the CLI from this repository:

```sh
bun src/cli/main.ts --help
bun src/cli/main.ts --version
```

## Daemon lifecycle and diagnosis

```sh
bun src/cli/main.ts daemon install
# Install-only database override:
bun src/cli/main.ts daemon install --db /absolute/owner-only/orchestrator.db
bun src/cli/main.ts daemon start
bun src/cli/main.ts daemon status
bun src/cli/main.ts daemon logs
bun src/cli/main.ts daemon stop
bun src/cli/main.ts daemon uninstall
```

`install` installs `dev.gjc.orchestrator` as a per-user LaunchAgent. The database defaults to `~/.local/state/orchestrator/orchestrator.db`; only `daemon install` accepts `--db <absolute-path>` to select a different owner-only location. Ordinary commands reject `--db` and never open SQLite. `start` and `stop` operate on an installed job; `status` reports the job state; `logs` returns the stdout and stderr log paths. An absent job is a distinct state from an installed-but-stopped job.

The LaunchAgent uses `RunAtLoad` and `KeepAlive`: a clean daemon exit while it remains loaded is restarted. An intentional stop or uninstall must use `launchctl bootout`; killing the process alone is not a stop operation. If the job is loaded but health is unavailable, inspect `daemon logs`, then use `daemon stop` followed by `daemon start`. Do not delete a socket, lock, plist, database, or runtime directory to recover it.

## Canonical paths and endpoint selection

The default config is:

```text
~/Library/Application Support/Orchestrator/config.json
```

When no config provides `socketPath`, the socket is:

```text
/tmp/dev.gjc.orchestrator.<uid>/orchestrator.sock
```

The endpoint resolver uses this precedence: `--socket <absolute-path>`, then `socketPath` in `--config <absolute-path>` (or the default config), then the compiled default above. Socket paths must be absolute, contain no NUL byte, and fit the Unix socket path limit. Config files and their parent directories are owner-verified (`0600` and `0700` respectively); symlinks and insecure paths are rejected.

Use the same `--config` or `--socket` for daemon administration and ordinary CLI calls. A client rejects a daemon whose endpoint fingerprint does not match its resolved configuration.

## Projects and task state

```sh
bun src/cli/main.ts project add --name demo --root .
bun src/cli/main.ts project list
bun src/cli/main.ts task add --project demo --title "release" --planned-state ready
bun src/cli/main.ts task start <task-id>
bun src/cli/main.ts status --project demo
bun src/cli/main.ts history --task <task-id> --since 2026-01-02T03:04:05Z
```

`planned` is the user-requested lifecycle; `observed` is durable external evidence. A planned transition does not silently rewrite observed state. The normal planned transitions are `start`, `pause`, `resume`, `block`, `complete`, and `cancel`.

## Process definitions, schedules, and attempts

A process definition is an immutable, versioned structured command. It is not a shell command:

```sh
bun src/cli/main.ts process-definition add \
  --task <task-id> --executable /usr/bin/true
bun src/cli/main.ts process-definition version <definition-id> \
  --expected-version 1 --executable /bin/echo --arg hello
bun src/cli/main.ts schedule add \
  --task <task-id> --definition <definition-id> --definition-version 1 \
  --kind interval --run-at 2026-01-02T03:04:05Z --interval-seconds 3600
bun src/cli/main.ts process start \
  --task <task-id> --definition <definition-id> --definition-version 1
bun src/cli/main.ts process status <attempt-id>
bun src/cli/main.ts process stop <attempt-id> --grace-ms 5000
```

Definitions use an executable plus repeated `--arg` values. `--cwd` is an absolute working directory. Use `--env-inherit NAME` only for explicitly needed inherited names and `--env NAME=value` for explicit values; shell strings, ambient-environment capture, PTYs, and privilege escalation are not supported. Schedules bind to one definition version, and process controls are attempt-addressed. A runner records the child result and checks process identity before signaling; an unprovable runner/child state is reported as lost rather than restarted or signaled speculatively.

## Operations, recovery, and backup

Sleep/wake and a daemon restart are recovery events: the daemon reconciles durable attempts and coalesces missed interval work instead of replaying an unbounded backlog. If an attempt is marked lost or may still have a live child, investigate it before resuming or starting overlapping work.

For an offline backup, first stop the loaded service with `daemon stop` (which bootouts the job), verify `daemon status` is not running, then copy the database and its SQLite sidecars together. Never copy a live SQLite database by reading it directly from a second product process. Preserve the database and logs across `daemon uninstall` unless an operator intentionally removes them after an offline backup.

## Security and failure semantics

Runtime, config, attempt, and log directories are owner-only; sockets, lock files, config, plists, result files, and logs are owner-only. The daemon refuses unsafe stale sockets, symlinks, ownership mismatches, and broad permissions. It has no TCP listener. Logs, status, events, and errors must not expose raw argv values, environment values, request bodies, descriptions, or block reasons. The SQLite database can contain process specifications and must be protected accordingly.

A daemon-unavailable command returns `DAEMON_UNAVAILABLE`; a response lost after sending a mutation returns `UNKNOWN_OUTCOME`. Retry the latter with the same `--idempotency-key`, never by issuing a fresh mutation blindly. Oversized responses return `RESPONSE_TOO_LARGE`; pagination cannot split one public record that exceeds the response budget. `DB_BUSY` is a service failure, not a cue to open SQLite from the CLI.

## Boundaries and non-goals

The UDS HTTP/JSON v1 boundary is the seam for a future authenticated mobile gateway. The daemon does not expose that gateway, public TCP, a web UI, remote/multi-user execution, shell-string execution, containers, arbitrary plugins, cron syntax, or a direct-DB compatibility mode.
