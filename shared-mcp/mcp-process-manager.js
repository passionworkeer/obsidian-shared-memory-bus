/**
 * mcp-process-manager.js — I-HIGH-1 stage 3 (PR17 commit 6)
 *
 * 4 个独立 MCP server 进程的 spawn + 健康监控 + 按需重启工具。
 * 给 start.js / PowerShell launcher / 外部 admin 工具共用。
 *
 * 设计目标:
 *   - 单一真值:每个 server 的 spawn 规范来自 MCP_SERVERS + spawn-plan.js
 *   - 进程隔离:4 个 server 各自独立 PID,不会因单个 server 崩溃而拖累其余
 *   - 自动重启:基于 manifest.json isolatedSubprocess.restartPolicy 决策
 *   - 简单胜于完备:不引入第三方进程管理库,只用 node:child_process
 *
 * 与 singleton-stdio-mcp-proxy.mjs 的关系:
 *   proxy.js 把 stdio MCP 桥接到 HTTP /mcp 端点(用户侧协议转换)
 *   mcp-process-manager.js 负责 spawn + 监控 node 子进程(运维侧进程管理)
 *   两者职责正交,可独立使用
 *
 * 当前实现范围:
 *   - buildSpawnCommand(server): 拼出 spawn 命令(node + entry + args)
 *   - spawnServer(server, options): spawn 子进程,返回 child + 句柄
 *   - restartPolicyFor(server): 从 manifest.json 读 restartPolicy,缺省 "always"
 *   - probeServer(server, options): 用 health-check.js 探测 /mcp 端点
 *   - monitorServer(server, options): 定时 probe + 异常时按 restartPolicy 重启
 *
 * 不在范围(留给后续 wave):
 *   - 进程间 metrics endpoint 端口分配 (目前 metrics 与 mcp 同端口)
 *   - 进程组 / cgroup 资源限制
 *   - 跨 server 共享 SQLite 锁的事务协调
 */

import { spawn } from "node:child_process";
import { resolveProjectPath } from "./omni-store.js";
import { probeHttp } from "./health-check.js";

const DEFAULT_HEALTH_PATH = "/mcp";
const DEFAULT_PROBE_TIMEOUT_MS = 5000;
const DEFAULT_RESTART_BACKOFF_MS = 1000;
const DEFAULT_MAX_RESTARTS = 5;
const DEFAULT_CIRCUIT_WINDOW_MS = 300000; // 5 min — 与 manifest isolatedSubprocess 对齐

/**
 * @typedef {Object} SpawnOptions
 * @property {Object} [env]       - 注入到子进程的环境变量 (与 process.env 合并)
 * @property {string} [cwd]       - 子进程工作目录
 * @property {boolean} [inheritStdio] - 是否继承父进程 stdio (默认 true)
 */

/**
 * @typedef {Object} ManagedProcess
 * @property {Object} server        - MCP_SERVERS 条目
 * @property {import("node:child_process").ChildProcess|null} child
 * @property {number} restartCount  - 累计重启次数
 * @property {number} startedAt     - 上次启动时间戳 (ms)
 * @property {number} lastCrashAt   - 上次崩溃时间戳 (ms)
 */

/**
 * 拼出 spawn 子进程的命令行。
 * @param {Object} server - MCP_SERVERS 条目 (含 id/port/command/args)
 * @returns {{ file: string, args: string[] }}
 */
export function buildSpawnCommand(server) {
  if (!server || !server.command) {
    throw new Error(`mcp-process-manager: server has no command: ${server?.id}`);
  }
  return { file: server.command, args: [...(server.args || [])] };
}

/**
 * Spawn 一个 MCP server 子进程。
 * 不自动管理生命周期;返回 child + handle,调用方自行 kill / 重启。
 *
 * @param {Object} server - MCP_SERVERS 条目
 * @param {SpawnOptions} [options]
 * @returns {ManagedProcess}
 */
export function spawnServer(server, options = {}) {
  const { file, args } = buildSpawnCommand(server);
  const env = { ...process.env, ...(options.env || {}) };
  // 总是把 server.env 也合并(MCP_SERVERS 条目上的 env 字段,如
  // AI_MEMORY_SERVER_MODE / AI_MEMORY_METRICS_PORT)。
  if (server.env) {
    Object.assign(env, server.env);
  }
  const cwd = options.cwd || resolveProjectPath("");
  const stdio = options.inheritStdio === false ? "pipe" : "inherit";

  const child = spawn(file, args, {
    cwd,
    env,
    stdio,
    windowsHide: true,
  });

  child.on("error", (err) => {
    // spawn 失败 (例如 node 不在 PATH) 抛 EPIPE / ENOENT
    console.error(`[mcp-process-manager] spawn failed for ${server.id}:`, err.message);
  });

  return {
    server,
    child,
    restartCount: 0,
    startedAt: Date.now(),
    lastCrashAt: 0,
  };
}

/**
 * 从 manifest.json isolatedSubprocess 读 restartPolicy,缺省 "always"。
 * @param {Object} [server] - manifest.json 中的 server 条目
 * @returns {"always"|"on-failure"|"never"}
 */
export function restartPolicyFor(server) {
  const policy = server?.isolatedSubprocess?.restartPolicy;
  if (policy === "on-failure" || policy === "never") return policy;
  return "always";
}

/**
 * Probe 一个 server 的 /mcp 端点。
 * 当前只支持 HTTP /mcp;mcp-initialize probe 在 manifest.json 启动时已用,
 * 这里给运行时定期健康检查使用。
 *
 * @param {Object} server - MCP_SERVERS 条目 (含 port)
 * @param {Object} [options]
 * @param {string} [options.host]      - 默认 127.0.0.1
 * @param {string} [options.path]      - 默认 /mcp
 * @param {number} [options.timeoutMs] - 默认 5000
 * @returns {Promise<{ok: boolean, latencyMs?: number, status?: number, error?: string}>}
 */
export function probeServer(server, options = {}) {
  const host = options.host || "127.0.0.1";
  const path = options.path || DEFAULT_HEALTH_PATH;
  const timeoutMs = options.timeoutMs || DEFAULT_PROBE_TIMEOUT_MS;
  if (!server || typeof server.port !== "number") {
    return Promise.resolve({ ok: false, error: "missing-port" });
  }
  return probeHttp(host, server.port, path, timeoutMs);
}

/**
 * 定时 probe + 按 restartPolicy 决定是否重启的 monitor loop。
 * 返回一个 stop() 函数,调用即停。
 *
 * 注意: 这是 best-effort 自愈,与 start-shared-mcp.ps1 的 state.json
 * 互相独立(后者在重启周期内守护 zombie PID,本模块守护运行时崩溃)。
 * 两层守护互补,不互斥。
 *
 * @param {ManagedProcess} proc - spawnServer 返回的 handle
 * @param {Object} [options]
 * @param {number} [options.intervalMs=30000]  - probe 间隔
 * @param {number} [options.maxRestarts=5]     - circuitWindowMs 内最大重启次数
 * @param {number} [options.circuitWindowMs=300000] - circuit breaker 时间窗
 * @param {number} [options.backoffMs=1000]    - 重启退避 (ms)
 * @param {Function} [options.onRestart]       - 重启回调 (proc, reason) => void
 * @returns {{ stop: () => void }}
 */
export function monitorServer(proc, options = {}) {
  const intervalMs = options.intervalMs || 30000;
  const maxRestarts = options.maxRestarts ?? DEFAULT_MAX_RESTARTS;
  const circuitWindowMs = options.circuitWindowMs ?? DEFAULT_CIRCUIT_WINDOW_MS;
  const backoffMs = options.backoffMs ?? DEFAULT_RESTART_BACKOFF_MS;
  const onRestart = options.onRestart || (() => {});
  const policy = restartPolicyFor(proc.server);

  let stopped = false;
  let circuitOpen = false;

  const attemptRestart = (reason) => {
    if (stopped) return;
    const now = Date.now();
    // circuit breaker: circuitWindowMs 内累计重启次数 ≥ maxRestarts → 放弃
    if (proc.restartCount >= maxRestarts && (now - proc.startedAt) < circuitWindowMs) {
      if (!circuitOpen) {
        circuitOpen = true;
        console.error(
          `[mcp-process-manager] circuit OPEN for ${proc.server.id}: ${proc.restartCount} restarts within ${circuitWindowMs}ms; giving up.`,
        );
      }
      return;
    }
    proc.restartCount += 1;
    proc.lastCrashAt = now;
    setTimeout(() => {
      if (stopped) return;
      try {
        proc.child = spawnServer(proc.server).child;
        proc.startedAt = Date.now();
        onRestart(proc, reason);
      } catch (err) {
        console.error(`[mcp-process-manager] restart failed for ${proc.server.id}:`, err.message);
      }
    }, backoffMs);
  };

  // 监听 child 退出事件
  if (proc.child) {
    proc.child.on("exit", (code, signal) => {
      if (stopped) return;
      if (policy === "never") return;
      const expected = code === 0 || signal === "SIGTERM";
      if (policy === "always" || (policy === "on-failure" && !expected)) {
        attemptRestart(`exit code=${code} signal=${signal}`);
      }
    });
  }

  // 定时 probe
  const timer = setInterval(async () => {
    if (stopped) return;
    if (!proc.child || proc.child.exitCode !== null) {
      // 已退出但 exit handler 没触发(异常路径)
      attemptRestart("child-exited-without-handler");
      return;
    }
    const result = await probeServer(proc.server);
    if (!result.ok) {
      console.warn(`[mcp-process-manager] probe failed for ${proc.server.id}: ${result.error || result.status}`);
      // probe 失败不一定意味 child 死亡;不主动重启,留给 exit handler。
    }
  }, intervalMs);
  if (typeof timer.unref === "function") timer.unref();

  return {
    stop() {
      stopped = true;
      clearInterval(timer);
      try {
        if (proc.child && proc.child.exitCode === null) {
          proc.child.kill("SIGTERM");
        }
      } catch {
        // best-effort
      }
    },
  };
}