import type { LaunchdInstallConfig, LaunchdLogPaths, LaunchdStatus } from "../adapters/launchd/agent.ts";

export type { LaunchdInstallConfig, LaunchdLogPaths, LaunchdStatus } from "../adapters/launchd/agent.ts";
export interface LaunchdAgent {
  install(config: LaunchdInstallConfig): Promise<LaunchdStatus>;
  uninstall(config: LaunchdInstallConfig): Promise<LaunchdStatus>;
  start(config: LaunchdInstallConfig): Promise<LaunchdStatus>;
  stop(config: LaunchdInstallConfig): Promise<LaunchdStatus>;
  status(config: LaunchdInstallConfig): Promise<LaunchdStatus>;
  logs(config: LaunchdInstallConfig): Promise<LaunchdLogPaths>;
}
export type DaemonAdminConfig = LaunchdInstallConfig;
export interface DaemonAdminResult { exitCode: number; status: LaunchdStatus; logs?: LaunchdLogPaths; }

/** launchd seam used by the thin CLI; it never opens the daemon database. */
export class DaemonAdmin {
  constructor(private readonly agent: LaunchdAgent, private readonly config: DaemonAdminConfig) {}

  async install(): Promise<DaemonAdminResult> {
    const status = await this.agent.install(this.config);
    return { exitCode: exitCode(status), status };
  }

  async uninstall(): Promise<DaemonAdminResult> {
    const status = await this.agent.uninstall(this.config);
    return { exitCode: exitCode(status), status };
  }

  async start(): Promise<DaemonAdminResult> {
    const status = await this.agent.start(this.config);
    return { exitCode: exitCode(status), status };
  }

  async stop(): Promise<DaemonAdminResult> {
    const status = await this.agent.stop(this.config);
    return { exitCode: exitCode(status), status };
  }

  async status(): Promise<DaemonAdminResult> { return this.result(); }

  async logs(): Promise<DaemonAdminResult> {
    const status = await this.agent.status(this.config);
    return { exitCode: exitCode(status), status, logs: await this.agent.logs(this.config) };
  }

  private async result(): Promise<DaemonAdminResult> {
    const status = await this.agent.status(this.config);
    return { exitCode: exitCode(status), status };
  }
}

function exitCode(status: LaunchdStatus): number {
  return status.state === "absent" ? 3 : status.state === "degraded" ? 5 : status.ready ? 0 : 1;
}
