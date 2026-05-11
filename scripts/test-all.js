#!/usr/bin/env node
/**
 * scripts/test-all.js
 * 全面的测试脚本 - 运行所有测试
 *
 * Usage: node scripts/test-all.js [--verbose] [--no-py] [--no-js]
 */

import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import fs from 'fs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = join(__dirname, '..');

// 命令行参数
const args = process.argv.slice(2);
const VERBOSE = args.includes('--verbose') || args.includes('-v');
const SKIP_PY = args.includes('--no-py');
const SKIP_JS = args.includes('--no-js');

// 颜色输出
const colors = {
  reset: '\x1b[0m',
  green: '\x1b[32m',
  red: '\x1b[31m',
  yellow: '\x1b[33m',
  blue: '\x1b[36m',
  bold: '\x1b[1m',
};

function color(c, text) {
  return `${colors[c]}${text}${colors.reset}`;
}

function log(msg, type = 'info') {
  const icons = { info: 'ℹ', pass: '✓', fail: '✗', warn: '⚠', skip: '⊘' };
  const c = { pass: 'green', fail: 'red', warn: 'yellow', skip: 'blue' };
  console.log(`${color('blue', icons[type])} ${msg}`);
}

function runCommand(cmd, args, cwd = PROJECT_ROOT) {
  return new Promise((resolve) => {
    const child = spawn(cmd, args, {
      cwd,
      stdio: VERBOSE ? 'inherit' : 'pipe',
      shell: true,
      windowsHide: true,
    });

    let stdout = '';
    let stderr = '';

    if (!VERBOSE) {
      child.stdout.on('data', (d) => { stdout += d.toString(); });
      child.stderr.on('data', (d) => { stderr += d.toString(); });
    }

    child.on('close', (code) => {
      resolve({ code, stdout, stderr });
    });

    child.on('error', (err) => {
      resolve({ code: 1, stdout: '', stderr: err.message });
    });
  });
}

async function runTest(name, cmd, args, cwd) {
  const start = Date.now();
  log(`Running: ${name}...`, 'info');

  const result = await runCommand(cmd, args, cwd);
  const duration = ((Date.now() - start) / 1000).toFixed(1);

  if (result.code === 0) {
    log(`✓ ${name} passed (${duration}s)`, 'pass');
    return { name, passed: true, duration, result };
  } else {
    log(`✗ ${name} failed (${duration}s)`, 'fail');
    if (!VERBOSE && result.stderr) {
      console.log(color('red', `  ${result.stderr.slice(0, 500)}`));
    }
    return { name, passed: false, duration, result };
  }
}

async function main() {
  console.log(color('bold', '\n═══════════════════════════════════════════════════════'));
  console.log(color('bold', '  AI Memory Bus - 全面测试套件'));
  console.log(color('bold', '═══════════════════════════════════════════════════════\n'));

  const results = [];
  const PYTHON = process.platform === 'win32' ? 'python' : 'python3';

  // 1. JS 单元测试
  if (!SKIP_JS) {
    results.push(await runTest(
      'JS Unit Tests',
      'node',
      ['--test', '--test-concurrency=1', '--experimental-test-isolation=none',
       'tests/unit/js/*.test.js', 'tests/unit/js/*.test.mjs'],
      PROJECT_ROOT
    ));
  }

  // 2. JS 集成测试
  if (!SKIP_JS) {
    results.push(await runTest(
      'JS Integration Tests',
      'node',
      ['--test', '--test-concurrency=1', '--experimental-test-isolation=none',
       'tests/integration/js/*.test.mjs'],
      PROJECT_ROOT
    ));
  }

  // 3. 跨语言测试
  if (!SKIP_JS) {
    results.push(await runTest(
      'JS Cross-Language Tests',
      'node',
      ['--test', 'tests/cross-language/*.test.js'],
      PROJECT_ROOT
    ));
  }

  // 4. Python 测试
  if (!SKIP_PY) {
    // Windows 上 Python 路径需要特殊处理
    const pythonCmd = process.platform === 'win32' ? 'python' : 'python3';
    const pythonArgs = ['-m', 'pytest', 'tests/unit/py/', '-v', '--tb=short'];

    // 尝试直接运行 python，如果失败则使用 python3 或 /d/python/python.exe
    const testCmd = process.platform === 'win32' ? 'python' : 'python3';
    let pythonResult = await runTest('Python Unit Tests', testCmd, pythonArgs, PROJECT_ROOT);

    // 如果 Windows 上 python 失败，尝试指定路径
    if (!pythonResult.passed && process.platform === 'win32') {
      log('Retrying with explicit Python path...', 'info');
      pythonResult = await runTest('Python Unit Tests', 'D:\\python\\python.exe', pythonArgs, PROJECT_ROOT);
    }

    results.push(pythonResult);
  }

  // 5. 跨平台测试
  results.push(await runTest(
    'Cross-Platform Adapter Tests',
    'node',
    ['scripts/cross-platform-test.js'],
    PROJECT_ROOT
  ));

  // 6. 环境检查
  results.push(await runTest(
    'Environment Check',
    'node',
    ['scripts/env-check.js'],
    PROJECT_ROOT
  ));

  // 7. 构建记忆层
  results.push(await runTest(
    'Build Memory Layers',
    'node',
    ['ops/build/build-memory-layers.js'],
    PROJECT_ROOT
  ));

  // 8. MCP 服务器检查 (检查端口)
  log('Checking MCP servers...', 'info');
  const mcpCheck = await runCommand('curl', ['-s', '-o', '/dev/null', '-w', '%{http_code}',
    'http://127.0.0.1:9338/mcp'], PROJECT_ROOT);
  if (mcpCheck.code === 0 && mcpCheck.stdout.trim() === '200') {
    log('✓ MCP servers running', 'pass');
    results.push({ name: 'MCP Servers', passed: true, duration: 0 });
  } else {
    log('⚠ MCP servers not responding (may need to start with npm start)', 'warn');
    results.push({ name: 'MCP Servers', passed: true, duration: 0, skipped: true });
  }

  // 总结
  console.log(color('bold', '\n═══════════════════════════════════════════════════════'));
  console.log(color('bold', '  测试结果汇总'));
  console.log(color('bold', '═══════════════════════════════════════════════════════\n'));

  const passed = results.filter(r => r.passed && !r.skipped).length;
  const failed = results.filter(r => !r.passed).length;
  const skipped = results.filter(r => r.skipped).length;
  const total = results.length;

  for (const r of results) {
    const icon = r.skipped ? '⊘' : (r.passed ? '✓' : '✗');
    const c = r.skipped ? 'blue' : (r.passed ? 'green' : 'red');
    const dur = r.duration ? `(${r.duration}s)` : '';
    console.log(`  ${color(c, icon)} ${r.name} ${dur}`);
  }

  console.log('');
  const failedStr = failed > 0 ? color('red', `Failed: ${failed}`) : color('green', 'Failed: 0');
  const skippedStr = skipped > 0 ? color('blue', `Skipped: ${skipped}`) : '';
  console.log(`  Total: ${total} | ${color('green', `Passed: ${passed}`)} | ${failedStr} | ${skippedStr}`);
  console.log(color('bold', '═══════════════════════════════════════════════════════\n'));

  process.exit(failed > 0 ? 1 : 0);
}

main().catch((err) => {
  console.error(color('red', `Fatal error: ${err.message}`));
  process.exit(1);
});
