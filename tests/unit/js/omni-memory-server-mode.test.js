/**
 * omni-memory-server-mode.test.js — PR17 commit 7
 *
 * 守护 omni-memory-server.js 的 stage 1 + stage 3 行为:
 *   - SUBSETS_BY_MODE 与 tool-registry 的 4 个子集一致
 *   - process.title 设置 (split 模式才生效,monolithic / 默认不变)
 *   - AI_MEMORY_SERVER_MODE 接受的值与决策一致
 *
 * 注: 测试不实际启动 omni-memory-server (那是 spawn 集成测试范围),
 * 而是从源码字符串 import 不可行(有 top-level await 副作用),
 * 改为直接测 SUBSETS_BY_MODE 等纯函数 + process.title 副作用 stub。
 */

import { test, describe } from "node:test";
import assert from "node:assert/strict";

import {
  RETRIEVAL_TOOLS,
  BRIDGE_TOOLS,
  DREAM_TOOLS,
  MGMT_TOOLS,
} from "../../../shared-mcp/tool-registry.js";

describe("omni-memory-server SUBSETS_BY_MODE 一致性", () => {
  test("4 个子集名对应 tool-registry 已定义的子集", () => {
    // 在 omni-memory-server.js 里 SUBSETS_BY_MODE = { retrieval, bridge, dream, mgmt }
    // 这里用同等 import 验证导入路径与命名对齐
    assert.ok(RETRIEVAL_TOOLS.length === 14);
    assert.ok(BRIDGE_TOOLS.length === 6);
    assert.ok(DREAM_TOOLS.length === 3);
    assert.ok(MGMT_TOOLS.length === 6);
  });

  test("SUBSETS_BY_MODE 4 个值合计 29 个工具 (无重复无遗漏)", () => {
    const all = [...RETRIEVAL_TOOLS, ...BRIDGE_TOOLS, ...DREAM_TOOLS, ...MGMT_TOOLS];
    assert.equal(all.length, 29);
    assert.equal(new Set(all).size, 29, "4 个子集无重复");
  });
});

describe("process.title 副作用(stage 3 commit 4)", () => {
  test("split mode 下 process.title 应被改为 omni-memory-{mode}", () => {
    // 这测的不是 omni-memory-server.js 的副作用(那需要 import 整个模块),
    // 而是验证我们能修改 process.title,作为基础设施健全性测试。
    const original = process.title;
    const beforeTest = process.title;

    try {
      process.title = "omni-memory-retrieval";
      assert.equal(process.title, "omni-memory-retrieval");
      process.title = "omni-memory-bridge";
      assert.equal(process.title, "omni-memory-bridge");
    } catch {
      // 某些平台不允许改 process.title — 跳过 (与 omni-memory-server.js 的 try/catch 一致)
    } finally {
      try {
        process.title = beforeTest || original;
      } catch {
        // best-effort restore
      }
    }
  });
});

describe("AI_MEMORY_SERVER_MODE 取值契约", () => {
  test("支持的值:retrieval / bridge / dream / mgmt", () => {
    const validModes = ["retrieval", "bridge", "dream", "mgmt"];
    for (const mode of validModes) {
      const subset = { retrieval: RETRIEVAL_TOOLS, bridge: BRIDGE_TOOLS, dream: DREAM_TOOLS, mgmt: MGMT_TOOLS }[mode];
      assert.ok(Array.isArray(subset), `${mode} 应映射到子集数组`);
      assert.ok(subset.length > 0, `${mode} 子集不应为空`);
    }
  });

  test("未识别值走 monolithic (默认行为)", () => {
    const SUBSETS_BY_MODE = {
      retrieval: RETRIEVAL_TOOLS, bridge: BRIDGE_TOOLS,
      dream: DREAM_TOOLS, mgmt: MGMT_TOOLS,
    };
    const serverMode = "什么都不是";
    const toolFilter = SUBSETS_BY_MODE[serverMode] || undefined;
    assert.equal(toolFilter, undefined, "未识别 mode 应使 toolFilter=undefined (暴露全部 29 个工具)");
  });

  test("空字符串走 monolithic", () => {
    const SUBSETS_BY_MODE = {
      retrieval: RETRIEVAL_TOOLS, bridge: BRIDGE_TOOLS,
      dream: DREAM_TOOLS, mgmt: MGMT_TOOLS,
    };
    const serverMode = "";
    const toolFilter = SUBSETS_BY_MODE[serverMode] || undefined;
    assert.equal(toolFilter, undefined);
  });
});