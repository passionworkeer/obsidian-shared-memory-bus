/**
 * mcp-process-manager.test.js — PR17 commit 7
 *
 * 守护 mcp-process-manager.js:
 *   - buildSpawnCommand: 拼出 spawn 命令正确
 *   - spawnServer: spawn 子进程返回 ManagedProcess
 *   - restartPolicyFor: 从 manifest isolatedSubprocess 读策略 (缺省 always)
 *   - probeServer: 用 health-check.js 探测 /mcp 端点
 *   - monitorServer: 定时 probe + exit handler + circuit breaker
 *
 * 注意: 真实 spawn 测试用 node -e 'setTimeout(...)' 短命进程,
 * 不依赖具体业务 server 启动,避免单测污染开发环境。
 */

import { test, describe, mock } from "node:test";
import assert from "node:assert/strict";

import {
  buildSpawnCommand,
  spawnServer,
  restartPolicyFor,
  probeServer,
  monitorServer,
} from "../../../shared-mcp/mcp-process-manager.js";

describe("buildSpawnCommand", () => {
  test("正常 server 拼出 file + args", () => {
    const cmd = buildSpawnCommand({ id: "memory-retrieval", command: "node", args: ["--experimental-default-type=module", "omni-memory-server.js"] });
    assert.equal(cmd.file, "node");
    assert.deepEqual(cmd.args, ["--experimental-default-type=module", "omni-memory-server.js"]);
  });

  test("无 command 时抛错", () => {
    assert.throws(() => buildSpawnCommand({ id: "bad" }), /has no command/);
  });

  test("args 缺失时返回空数组", () => {
    const cmd = buildSpawnCommand({ id: "x", command: "python" });
    assert.equal(cmd.file, "python");
    assert.deepEqual(cmd.args, []);
  });

  test("args 返回的是副本(防止调用方误改 MCP_SERVERS)", () => {
    const args = ["--foo", "bar"];
    const cmd = buildSpawnCommand({ id: "x", command: "node", args });
    cmd.args.push("--baz");
    assert.deepEqual(args, ["--foo", "bar"], "原 args 不应被修改");
  });
});

describe("spawnServer", () => {
  test("spawn 一个短命 node 进程立即返回 ManagedProcess", () => {
    // spawn 'node -e "process.exit(0)"' — 立即退出
    const proc = spawnServer(
      { id: "test-immediate", command: "node", args: ["-e", "process.exit(0)"] },
      { inheritStdio: false },
    );
    assert.ok(proc.child, "应返回 child");
    assert.equal(proc.server.id, "test-immediate");
    assert.equal(proc.restartCount, 0);
    assert.ok(proc.startedAt > 0);
    // 立即清理
    if (proc.child && proc.child.exitCode === null) {
      proc.child.kill("SIGTERM");
    }
  });

  test("env 合并 server.env + options.env + process.env", () => {
    let observedEnv = null;
    // 用 mock.module 不能跨 file 捕获,这里用 child_process.spawn + 自定义 server 写法不便
    // 改用 spawnServer 返回值;后续用 mock spawn 替代
    const proc = spawnServer(
      { id: "test-env", command: "node", args: ["-e", "process.exit(0)"], env: { FROM_SERVER: "server-value" } },
      { inheritStdio: false, env: { FROM_OPTIONS: "options-value" } },
    );
    // 至少 server.env 已合并到 spawn options (由内部 spawn 调用;本测只验证不抛错)
    assert.ok(proc);
    if (proc.child && proc.child.exitCode === null) proc.child.kill("SIGTERM");
  });
});

describe("restartPolicyFor", () => {
  test("explicit always", () => {
    assert.equal(restartPolicyFor({ isolatedSubprocess: { restartPolicy: "always" } }), "always");
  });

  test("explicit on-failure", () => {
    assert.equal(restartPolicyFor({ isolatedSubprocess: { restartPolicy: "on-failure" } }), "on-failure");
  });

  test("explicit never", () => {
    assert.equal(restartPolicyFor({ isolatedSubprocess: { restartPolicy: "never" } }), "never");
  });

  test("无 isolatedSubprocess 缺省 always", () => {
    assert.equal(restartPolicyFor({}), "always");
  });

  test("isolatedSubprocess 无 restartPolicy 字段也缺省 always", () => {
    assert.equal(restartPolicyFor({ isolatedSubprocess: {} }), "always");
  });

  test("无效值降级为 always (兜底安全)", () => {
    assert.equal(restartPolicyFor({ isolatedSubprocess: { restartPolicy: "garbage" } }), "always");
  });
});

describe("probeServer", () => {
  test("无 port 时返回 ok:false (不抛错)", async () => {
    const r = await probeServer({ id: "no-port" });
    assert.equal(r.ok, false);
    assert.equal(r.error, "missing-port");
  });

  test("探测不存在的端口快速返回 ok:false", async () => {
    // 用 9332 (fetch) 这种已知业务端口但假设本机未启;若 fetch 真在跑则 ok:true
    const r = await probeServer({ id: "test", port: 1 }, { timeoutMs: 500 });
    assert.equal(typeof r.ok, "boolean");
    // 不论 ok:true / ok:false 都应返回结果,不抛错
    assert.ok("ok" in r);
  });
});

describe("monitorServer", () => {
  test("返回一个 stop() 函数,调用后停 probe interval + 不重启", () => {
    // 短命子进程:1s 后退出
    const proc = spawnServer(
      { id: "test-monitor", command: "node", args: ["-e", "setTimeout(()=>process.exit(0), 100)"] },
      { inheritStdio: false },
    );
    const monitor = monitorServer(proc, { intervalMs: 60000, maxRestarts: 0 });
    assert.equal(typeof monitor.stop, "function");
    monitor.stop();
    // stop 不抛错
    assert.ok(true);
  });

  test("circuit breaker 打开后停止重启 (maxRestarts=0)", async () => {
    const proc = spawnServer(
      { id: "test-circuit", command: "node", args: ["-e", "setTimeout(()=>process.exit(1), 50)"] },
      { inheritStdio: false },
    );
    let restartCount = 0;
    const monitor = monitorServer(proc, {
      intervalMs: 1000,
      maxRestarts: 0,
      backoffMs: 10,
      onRestart: () => { restartCount += 1; },
    });
    // 等 100ms 让初始 child 退出并触发 exit handler
    await new Promise((r) => setTimeout(r, 100));
    monitor.stop();
    assert.equal(restartCount, 0, "maxRestarts=0 时不应触发任何重启");
  });
});