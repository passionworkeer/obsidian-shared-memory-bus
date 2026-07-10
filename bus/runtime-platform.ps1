Set-StrictMode -Version 3.0
$ErrorActionPreference = "Stop"

# ---------------------------------------------------------------------------
# runtime-platform.ps1
# Orchestration shim: dot-sources all runtime-platform-*.ps1 modules so
# callers that load this file directly continue to see every exported
# function as if they were all defined here.
#
# Load order (each module uses . to import its own dependencies):
#   1. runtime-platform-paths.ps1     — platform detection, XDG dirs, Join-SharedPath
#   2. runtime-platform-env.ps1      — Get-SharedEnvValue
#   3. runtime-platform-runtimes.ps1 — Python / Node / PowerShell discovery
#   4. runtime-platform-store.ps1    — Store root resolution
#   5. runtime-platform-ai-roots.ps1 — AI tool roots + process utilities
#   6. runtime-platform-shell.ps1    — shell/process launching helpers
# ---------------------------------------------------------------------------

$moduleRoot = $PSScriptRoot

. "$moduleRoot\runtime-platform-paths.ps1"
. "$moduleRoot\runtime-platform-env.ps1"
. "$moduleRoot\runtime-platform-runtimes.ps1"
. "$moduleRoot\runtime-platform-store.ps1"
. "$moduleRoot\runtime-platform-ai-roots.ps1"
. "$moduleRoot\runtime-platform-shell.ps1"
