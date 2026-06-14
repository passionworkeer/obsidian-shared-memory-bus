/**
 * Diagnostic check helper used by the `doctor` command.
 *
 * Each call records a pass/fail/warn result. The returned object exposes
 * `add(...)` to push results and a `summary()` formatter for printing.
 *
 * @returns {{
 *   pass: (label: string) => void,
 *   fail: (label: string, suggestion?: string) => void,
 *   warn: (label: string, suggestion?: string) => void,
 *   add: (pass: boolean | null, label: string, suggestion?: string) => void,
 *   totals: () => { passed: number, failed: number, warnings: number },
 *   print: () => void,
 *   exitCode: () => number,
 * }}
 */
export function createCheckCollector() {
  const checks = [];
  let passed = 0;
  let failed = 0;
  let warnings = 0;

  function add(pass, label, suggestion) {
    if (pass === true) {
      checks.push({ type: "pass", label });
      passed++;
    } else if (pass === false) {
      checks.push({ type: "fail", label, suggestion });
      failed++;
    } else {
      checks.push({ type: "warn", label, suggestion });
      warnings++;
    }
  }

  function print() {
    process.stdout.write("\n");
    for (const c of checks) {
      if (c.type === "pass") {
        process.stdout.write(`✅ PASS: ${c.label}\n`);
      } else if (c.type === "fail") {
        process.stdout.write(`❌ FAIL: ${c.label}\n`);
        if (c.suggestion) {
          process.stdout.write(`   Fix: ${c.suggestion}\n`);
        }
      } else {
        process.stdout.write(`⚠  WARN: ${c.label}\n`);
        if (c.suggestion) {
          process.stdout.write(`   Suggestion: ${c.suggestion}\n`);
        }
      }
    }
  }

  return {
    add,
    pass: (label) => add(true, label),
    fail: (label, suggestion) => add(false, label, suggestion),
    warn: (label, suggestion) => add(null, label, suggestion),
    totals: () => ({ passed, failed, warnings }),
    print,
    exitCode: () => (failed === 0 ? 0 : 1),
  };
}
