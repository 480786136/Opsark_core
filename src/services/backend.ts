import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import type { FileEntry, Metrics, PlanStep, ServerInfo, StepReview } from "@/types";

export const isTauri = () => "__TAURI_INTERNALS__" in window;

export interface RuntimeConnection {
  host: string;
  port: number;
  username: string;
  password: string;
}

export interface RuntimeModel {
  apiKey: string;
  endpoint: string;
  model: string;
  context: string;
}

export interface SshProbe {
  info: ServerInfo;
  environment: string[];
  hostname: string;
}

export interface TerminalOutputEvent {
  terminalId: string;
  data: string;
  stream: "stdout" | "stderr" | "system" | "error";
}

export type CredentialKind = "server" | "model";

const pause = (ms = 450) => new Promise((resolve) => setTimeout(resolve, ms));

const demoInfo: ServerInfo = {
  os: "Ubuntu 24.04 LTS",
  kernel: "6.8.0-44-generic",
  cpu: "Intel Xeon Gold 6338N",
  cores: 8,
  memoryGb: 16,
  diskGb: 160,
  uptime: "16 天 4 小时",
};

function riskFrom(command: string): "low" | "medium" | "high" {
  if (/(rm\s+-rf|mkfs|fdisk|userdel|iptables\s+-F|DROP\s+TABLE)/i.test(command)) return "high";
  if (/(install|restart|systemctl|chmod|chown|docker\s+(run|stop|rm)|apt)/i.test(command)) return "medium";
  return "low";
}

function buildDemoPlan(requirement: string): PlanStep[] {
  const text = requirement.toLowerCase();
  let steps: Omit<PlanStep, "id" | "status" | "risk">[];

  if (/(nginx|网站|web|反向代理)/i.test(text)) {
    steps = [
      { title: "检查运行环境", description: "确认系统、端口和 Nginx 当前状态", command: "nginx -v && systemctl is-active nginx", expected: "识别已安装版本与服务状态", validation: "systemctl is-active nginx" },
      { title: "校验配置", description: "在变更前检查现有配置语法", command: "nginx -t", expected: "配置语法检查通过", validation: "nginx -t" },
      { title: "应用服务变更", description: "重新加载 Nginx 使配置生效", command: "sudo systemctl reload nginx", expected: "Nginx 完成无中断重载", validation: "systemctl is-active nginx" },
      { title: "复查服务", description: "检查本机 HTTP 响应与服务状态", command: "curl -I --max-time 5 http://127.0.0.1", expected: "HTTP 服务返回有效状态码", validation: "curl -fsS --max-time 5 http://127.0.0.1 >/dev/null" },
    ];
  } else if (/(磁盘|空间|清理)/i.test(text)) {
    steps = [
      { title: "分析磁盘使用", description: "读取各挂载点的容量使用情况", command: "df -h", expected: "定位高占用挂载点", validation: "df -P / >/dev/null" },
      { title: "定位大目录", description: "分析日志目录的一级空间占用", command: "du -xh /var/log --max-depth=1 | sort -h | tail", expected: "得到日志目录占用排序", validation: "test -d /var/log" },
      { title: "检查日志轮转", description: "检查日志轮转服务与配置", command: "systemctl status logrotate.timer --no-pager", expected: "确认日志轮转工作状态", validation: "systemctl is-enabled logrotate.timer >/dev/null 2>&1" },
    ];
  } else {
    steps = [
      { title: "采集当前状态", description: "获取系统负载、内存和磁盘概况", command: "uptime && free -h && df -h", expected: "建立执行前基线", validation: "test -r /proc/loadavg && test -r /proc/meminfo" },
      { title: "检查相关服务", description: "列出当前异常的系统服务", command: "systemctl --failed --no-pager", expected: "识别潜在服务异常", validation: "systemctl is-system-running >/dev/null 2>&1 || test $? -eq 1" },
      { title: "输出诊断结论", description: "复查资源与关键进程，形成处理建议", command: "ps aux --sort=-%cpu | head -8", expected: "得到高资源占用进程", validation: "ps -e >/dev/null" },
    ];
  }

  return steps.map((step, index) => ({
    ...step,
    id: `step-${Date.now()}-${index}`,
    risk: riskFrom(step.command),
    status: "pending",
  }));
}

export function normalizePlanPreconditions(steps: PlanStep[]) {
  const normalized = steps.map((step) => ({ ...step }));
  for (let index = 0; index < normalized.length - 1; index += 1) {
    const probe = normalized[index];
    const remediation = normalized[index + 1];
    const createDatabase = remediation.command.match(
      /CREATE\s+DATABASE(?:\s+IF\s+NOT\s+EXISTS)?\s+[`'"]?([A-Za-z0-9_$-]+)/i,
    );
    if (!createDatabase) continue;

    const database = createDatabase[1];
    const checksDatabaseList = /SHOW\s+DATABASES/i.test(probe.command);
    const checksDatabaseCount =
      /information_schema\.(?:schemata|SCHEMATA)/i.test(probe.command) &&
      /count\s*\(\s*\*\s*\)/i.test(probe.command);
    const targetsDatabase = `${probe.command}\n${probe.validation}`
      .toLowerCase()
      .includes(database.toLowerCase());
    if ((!checksDatabaseList && !checksDatabaseCount) || !targetsDatabase) continue;

    const mysqlPrefix = probe.command.match(/^(mysql\b.*?)\s+-(?:[A-Za-z]*e[A-Za-z]*)\s/i)?.[1]?.trim();
    if (!mysqlPrefix) continue;
    const statusQuery = `SELECT COUNT(*) FROM information_schema.schemata WHERE schema_name='${database}';`;
    probe.title = `检查数据库 ${database} 当前状态`;
    probe.description = `连接 MySQL 并读取数据库 ${database} 的存在状态；返回 0 表示不存在，返回 1 表示已存在。`;
    probe.command = `${mysqlPrefix} -Nse "${statusQuery}"`;
    probe.expected = `成功读取数据库 ${database} 的存在状态（0 为不存在，1 为已存在）`;
    probe.validation = `${mysqlPrefix} -Nse "${statusQuery}" 2>/dev/null | grep -Eq '^[01]$'`;
  }
  return normalized;
}

function resultLines(step: PlanStep) {
  const mainOutput = (step.output ?? "").split("\n--- 独立校验 ---")[0];
  return mainOutput
    .split("\n")
    .map((line) => line.trim())
    .filter((line) =>
      line &&
      !line.startsWith("$ ") &&
      !line.startsWith("[exit:") &&
      !line.startsWith("mysql: [Warning]") &&
      !line.includes("未发现匹配项"),
    );
}

export function buildExecutionSummary(requirement: string, steps: PlanStep[]) {
  const completed = steps.filter((step) => step.status === "completed");
  const dataStep = [...completed].reverse().find((step) =>
    /show\s+(databases|tables)/i.test(step.command) ||
    /查询.*(数据库|数据表)|数据库.*列表|哪些表/i.test(step.title),
  );
  if (dataStep) {
    const isTableQuery = /show\s+tables|哪些表|数据表/i.test(`${requirement} ${dataStep.title} ${dataStep.command}`);
    const headers = isTableQuery ? /^tables_in_/i : /^database$/i;
    const values = [...new Set(resultLines(dataStep).filter((line) => !headers.test(line)))];
    if (values.length) {
      const subject = isTableQuery ? "数据表" : "数据库";
      return `查询完成，共找到 ${values.length} 个${subject}：${values.join("、")}。`;
    }
    return `查询完成，当前没有返回可识别的${isTableQuery ? "数据表" : "数据库"}名称。`;
  }

  const emptySteps = completed.filter((step) => step.output?.includes("未发现匹配项"));
  if (emptySteps.length) {
    return `本轮处理完成，共执行 ${completed.length} 个步骤。其中 ${emptySteps.length} 个查询没有匹配数据，其余步骤均已通过校验。`;
  }
  const finalResult = completed.length ? resultLines(completed[completed.length - 1]).slice(0, 5) : [];
  return finalResult.length
    ? `本轮处理完成，共执行 ${completed.length} 个步骤，所有校验均通过。最终结果：${finalResult.join("；")}。`
    : `本轮处理完成，共执行 ${completed.length} 个步骤，所有校验均通过。`;
}

export const backend = {
  async saveCredential(kind: CredentialKind, id: string, value: string) {
    if (!isTauri()) return;
    await invoke("save_credential", { kind, id, value });
  },

  async loadCredential(kind: CredentialKind, id: string): Promise<string | null> {
    if (!isTauri()) return null;
    return invoke<string | null>("load_credential", { kind, id });
  },

  async deleteCredential(kind: CredentialKind, id: string) {
    if (!isTauri()) return;
    await invoke("delete_credential", { kind, id });
  },

  async collectServerInfo(): Promise<ServerInfo> {
    if (isTauri()) return invoke("collect_server_info");
    await pause();
    return demoInfo;
  },

  async probeSsh(connection: RuntimeConnection): Promise<SshProbe> {
    if (!isTauri()) {
      await pause();
      return { info: demoInfo, environment: ["Docker 26.1", "Nginx 1.24"], hostname: connection.host };
    }
    return invoke("probe_ssh_server", {
      host: connection.host,
      port: connection.port,
      username: connection.username,
      password: connection.password,
    });
  },

  async startTerminal(terminalId: string, connection: RuntimeConnection) {
    if (!isTauri()) return;
    await invoke("start_ssh_terminal", { terminalId, ...connection });
  },

  async writeTerminal(terminalId: string, data: string) {
    if (!isTauri()) return;
    await invoke("write_ssh_terminal", { terminalId, data });
  },

  async resizeTerminal(terminalId: string, cols: number, rows: number) {
    if (!isTauri()) return;
    await invoke("resize_ssh_terminal", { terminalId, cols, rows });
  },

  async closeTerminal(terminalId: string) {
    if (!isTauri()) return;
    await invoke("close_ssh_terminal", { terminalId });
  },

  async onTerminalOutput(callback: (event: TerminalOutputEvent) => void) {
    if (!isTauri()) return () => {};
    return listen<TerminalOutputEvent>("terminal-output", (event) => callback(event.payload));
  },

  async getMetrics(): Promise<Metrics> {
    if (isTauri()) {
      const metrics = await invoke<Metrics>("get_realtime_metrics");
      return { ...metrics, sampledAt: new Date().toISOString() };
    }
    await pause(100);
    const tick = Date.now() / 3000;
    return {
      cpu: Math.round(20 + Math.abs(Math.sin(tick)) * 28),
      memory: Math.round(48 + Math.abs(Math.cos(tick / 2)) * 12),
      disk: 68,
      networkIn: Math.round(2.4 + Math.abs(Math.sin(tick / 3)) * 8.2),
      networkOut: Math.round(0.8 + Math.abs(Math.cos(tick / 4)) * 3.6),
      sampledAt: new Date().toISOString(),
    };
  },

  async getSshMetrics(connection: RuntimeConnection): Promise<Metrics> {
    if (!isTauri()) return this.getMetrics();
    const metrics = await invoke<Metrics>("get_ssh_metrics", {
      host: connection.host,
      port: connection.port,
      username: connection.username,
      password: connection.password,
    });
    return { ...metrics, sampledAt: new Date().toISOString() };
  },

  async listSftp(connection: RuntimeConnection, path: string): Promise<FileEntry[]> {
    if (!isTauri()) {
      await pause(250);
      return [];
    }
    const entries = await invoke<FileEntry[]>("list_sftp_directory", {
      host: connection.host,
      port: connection.port,
      username: connection.username,
      password: connection.password,
      path,
    });
    return entries.map((entry) => ({
      ...entry,
      modified: /^\d+$/.test(entry.modified)
        ? new Date(Number(entry.modified) * 1000).toLocaleString("zh-CN", { month: "numeric", day: "numeric" })
        : entry.modified,
    }));
  },

  async createSftpDirectory(connection: RuntimeConnection, path: string) {
    if (!isTauri()) return;
    await invoke("create_sftp_directory", { ...connection, path });
  },

  async renameSftpEntry(connection: RuntimeConnection, fromPath: string, toPath: string) {
    if (!isTauri()) return;
    await invoke("rename_sftp_entry", { ...connection, fromPath, toPath });
  },

  async deleteSftpEntry(connection: RuntimeConnection, path: string, kind: FileEntry["kind"]) {
    if (!isTauri()) return;
    await invoke("delete_sftp_entry", { ...connection, path, kind });
  },

  async readSftpFile(connection: RuntimeConnection, path: string) {
    if (!isTauri()) return new Uint8Array();
    const bytes = await invoke<number[]>("read_sftp_file", { ...connection, path });
    return new Uint8Array(bytes);
  },

  async writeSftpFile(connection: RuntimeConnection, path: string, data: Uint8Array) {
    if (!isTauri()) return;
    await invoke("write_sftp_file", { ...connection, path, data: Array.from(data) });
  },

  async generatePlan(requirement: string, runtimeModel?: RuntimeModel): Promise<PlanStep[]> {
    if (isTauri() && runtimeModel?.apiKey) {
      const steps = await invoke<PlanStep[]>("generate_ai_plan", {
        apiKey: runtimeModel.apiKey,
        endpoint: runtimeModel.endpoint,
        model: runtimeModel.model,
        requirement,
        context: runtimeModel.context,
      });
      return normalizePlanPreconditions(steps);
    }
    if (isTauri()) return normalizePlanPreconditions(await invoke<PlanStep[]>("generate_plan", { requirement }));
    await pause(900);
    return normalizePlanPreconditions(buildDemoPlan(requirement));
  },

  async checkModel(runtimeModel: Omit<RuntimeModel, "context">): Promise<{ available: boolean; reason: string }> {
    if (!runtimeModel.apiKey) return { available: false, reason: "未配置 API Key" };
    if (!runtimeModel.endpoint.trim()) return { available: false, reason: "未配置接口地址" };
    if (!runtimeModel.model.trim()) return { available: false, reason: "未配置模型名称" };
    if (!isTauri()) return { available: true, reason: "模型配置完整" };
    return invoke("check_ai_model", {
      apiKey: runtimeModel.apiKey,
      endpoint: runtimeModel.endpoint,
      model: runtimeModel.model,
    });
  },

  async generateSummary(requirement: string, steps: PlanStep[], runtimeModel?: RuntimeModel) {
    const fallback = buildExecutionSummary(requirement, steps);
    if (isTauri() && runtimeModel?.apiKey) {
      try {
        return await invoke<string>("generate_ai_summary", {
          apiKey: runtimeModel.apiKey,
          endpoint: runtimeModel.endpoint,
          model: runtimeModel.model,
          requirement,
          executionContext: JSON.stringify(
            steps.map(({ title, command, expected, status, output }) => ({ title, command, expected, status, output })),
          ),
        });
      } catch {
        return fallback;
      }
    }
    return fallback;
  },

  async reviewStep(
    requirement: string,
    reviewContext: string,
    hasRemainingSteps: boolean,
    runtimeModel?: RuntimeModel,
  ): Promise<StepReview> {
    const fallback: StepReview = {
      decision: hasRemainingSteps ? "continue" : "complete",
      reason: runtimeModel?.apiKey
        ? "模型复核暂不可用，已按程序校验结果继续"
        : "未配置远程模型，已按程序校验结果处理",
      summary: hasRemainingSteps ? "程序校验通过，继续执行后续步骤。" : "程序校验通过，已完成全部步骤。",
      source: "rules",
    };
    if (!isTauri() || !runtimeModel?.apiKey) return fallback;
    try {
      const review = await invoke<Omit<StepReview, "source">>("review_ai_step", {
        apiKey: runtimeModel.apiKey,
        endpoint: runtimeModel.endpoint,
        model: runtimeModel.model,
        requirement,
        reviewContext,
      });
      return { ...review, source: "model" };
    } catch {
      return fallback;
    }
  },

  async executeCommand(command: string, connection?: RuntimeConnection, approvedHighRisk = false): Promise<{
    output: string;
    success: boolean;
    simulated: boolean;
    exitCode?: number;
    emptyResult?: boolean;
  }> {
    if (isTauri() && connection?.password) {
      return invoke("execute_ssh_command", { ...connection, command, approvedHighRisk });
    }
    if (isTauri()) return invoke("execute_command", { command, approvedHighRisk });
    await pause(700);
    return {
      output: `$ ${command}\n[演示执行器] 命令已安全执行\n状态: success\n耗时: 0.42s`,
      success: true,
      simulated: true,
    };
  },

  async validateStep(
    step: PlanStep,
    connection?: RuntimeConnection,
  ): Promise<{ passed: boolean; detail: string; output?: string }> {
    if (isTauri() && connection) {
      const result = await this.executeCommand(step.validation, connection);
      const passed = result.exitCode === undefined ? result.success : result.exitCode === 0;
      return {
        passed,
        detail: passed ? `独立校验通过：${step.expected}` : "独立校验命令未达到预期",
        output: result.output,
      };
    }
    if (isTauri()) return invoke("validate_step", { expected: step.expected, output: step.output ?? "" });
    await pause(500);
    return { passed: true, detail: `校验通过：${step.expected}` };
  },
};
