import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const pwsh = ['pwsh', 'powershell.exe'].find((candidate) => {
  const result = spawnSync(candidate, ['-NoProfile', '-Command', '$PSVersionTable.PSVersion.ToString()'], { encoding: 'utf8' });
  return result.status === 0;
});

function psQuote(value) {
  return `'${String(value).replaceAll("'", "''")}'`;
}

test('installer path guard rejects traversal and preserves external files', { skip: !pwsh }, () => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'install-path-safety-'));
  const target = path.join(temp, 'target');
  const victim = path.join(temp, 'victim.txt');
  fs.mkdirSync(target);
  fs.writeFileSync(victim, 'keep', 'utf8');
  const script = path.join(temp, 'test.ps1');
  const helper = path.join(repoRoot, 'scripts', 'install-path-safety.ps1');
  const runtime = path.join(repoRoot, 'bus', 'runtime-platform.ps1');
  fs.writeFileSync(script, `
Set-StrictMode -Version 3.0
. ${psQuote(runtime)}
. ${psQuote(helper)}
$unsafe = @('../victim.txt','..\\victim.txt','/tmp/x','C:\\x','C:relative','\\\\server\\share\\x','safe:stream','CON','a/../b',"bad``nname")
foreach ($candidate in $unsafe) {
  $threw = $false
  try { [void](ConvertTo-SafeRelativeInstallPath -Path $candidate) } catch { $threw = $true }
  if (-not $threw) { throw "accepted unsafe path: $candidate" }
}
$removeThrew = $false
try { Remove-SafeManagedFileIfPresent -TargetRoot ${psQuote(target)} -RelativePath '../victim.txt' } catch { $removeThrew = $true }
if (-not $removeThrew) { throw 'unsafe removal did not fail closed' }
if (-not (Test-Path -LiteralPath ${psQuote(victim)} -PathType Leaf)) { throw 'external victim was removed' }
$inside = Join-Path ${psQuote(target)} 'stale.txt'
Set-Content -LiteralPath $inside -Value 'keep'
Remove-SafeManagedFileIfPresent -TargetRoot ${psQuote(target)} -RelativePath 'stale.txt' -DryRun | Out-Null
if (-not (Test-Path -LiteralPath $inside -PathType Leaf)) { throw 'dry-run removed a file' }
`, 'utf8');
  execFileSync(pwsh, ['-NoProfile', '-File', script], { stdio: 'inherit' });
});

test('activation files preserve hostile-looking path text without execution', { skip: !pwsh || process.platform === 'win32' }, () => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'activation-literals-'));
  const marker = path.join(temp, 'should-not-exist');
  const value = `space ' quote $(touch ${marker}) \`touch ${marker}.two\`; 你好\nnext`;
  const helper = path.join(repoRoot, 'scripts', 'install-path-safety.ps1');
  const runtime = path.join(repoRoot, 'bus', 'runtime-platform.ps1');
  const shFile = path.join(temp, 'activate.sh');
  const psFile = path.join(temp, 'activate.ps1');
  const script = path.join(temp, 'generate.ps1');
  fs.writeFileSync(script, `
. ${psQuote(runtime)}
. ${psQuote(helper)}
$encoding = New-Object System.Text.UTF8Encoding($false)
$root = ${psQuote(value)}
Write-AtomicRestrictedTextFile -Path ${psQuote(shFile)} -Content (New-PosixActivationContent -ResolvedTargetRoot $root -ResolvedPython '/usr/bin/python3') -PosixMode '700' -Encoding $encoding
Write-AtomicRestrictedTextFile -Path ${psQuote(psFile)} -Content (New-PowerShellActivationContent -ResolvedTargetRoot $root -ResolvedPython '/usr/bin/python3') -PosixMode '600' -Encoding $encoding
. ${psQuote(psFile)}
if ($env:AI_MEMORY_ROOT -cne $root) { throw 'PowerShell activation value changed' }
`, 'utf8');
  execFileSync(pwsh, ['-NoProfile', '-File', script], { stdio: 'inherit' });

  const encoded = execFileSync('sh', ['-c', `. "$1"; node -e 'process.stdout.write(Buffer.from(process.env.AI_MEMORY_ROOT).toString("base64"))'`, 'sh', shFile], { encoding: 'utf8' });
  assert.equal(Buffer.from(encoded, 'base64').toString('utf8'), value);
  assert.equal(fs.existsSync(marker), false);
  assert.equal(fs.existsSync(`${marker}.two`), false);
  assert.equal(fs.statSync(shFile).mode & 0o777, 0o700);
  assert.equal(fs.statSync(psFile).mode & 0o777, 0o600);
});
