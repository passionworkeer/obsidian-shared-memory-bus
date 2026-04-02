# Releasing

Use this checklist when publishing a new public revision of the bundle.

## Before You Publish
- update the docs that changed with the runtime behavior
- update `CHANGELOG.md`
- rescan for secrets and personal paths
- confirm installer and runtime paths are still dynamic

For public template safety, tracked overlay files must also stay free of workstation-specific absolute paths.

Recommended scan:
```powershell
git grep -n -I -e "C:\\Users\\" -e "E:\\" -- .
```

Expected result for a clean public branch:
- no hits in tracked files, or only clearly documented placeholder/examples that are not personal paths

## Minimum Validation
```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\scripts\validate-layout.ps1
powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\scripts\install.ps1
powershell.exe -NoProfile -ExecutionPolicy Bypass -File $env:AI_MEMORY_ROOT\shared-mcp\start-default-shared-mcp.ps1
powershell.exe -NoProfile -ExecutionPolicy Bypass -File $env:AI_MEMORY_ROOT\verify-client-integrations.ps1 -WorkspaceRoot <your-project-root> -RunCliChecks
```

```bash
./scripts/validate-layout.sh
./scripts/install.sh
~/.ai-memory/shared-mcp/start-default-shared-mcp.sh
pwsh -NoProfile -File ~/.ai-memory/verify-client-integrations.ps1 -WorkspaceRoot <your-project-root> -RunCliChecks
```

Run the pressure test if anything changed in shared MCP behavior, agent wiring, or memory indexing.

If the change touched tracked overlays or generator code, also replay the installed runtime against the repo and verify it does not reintroduce machine-specific paths:

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File $env:USERPROFILE\.ai-memory\memory-bus.ps1 -Action SyncAll -Project <repo-root> -Quiet
git grep -n -I -e "C:\\Users\\" -e "E:\\" -- .
```

If the change touched file layout or installer behavior, also confirm `.github/workflows/windows-validate.yml` still reflects the expected smoke-install story.

## Public Repo Hygiene
- `README.md` explains what changed and what the project is for
- `CONTRIBUTING.md`, `CODE_OF_CONDUCT.md`, `SECURITY.md`, and `SUPPORT.md` still make sense
- issue and PR templates are present
- repository description and topics still match the project

## Recommended Publish Steps
1. commit focused changes
2. push or update the public branch
3. confirm GitHub community health still looks good
4. open the README and a couple of key docs from the public repo
5. if needed, create a GitHub release note summarizing the change

If your machine has flaky HTTPS access to `github.com:443`, prefer an SSH-over-443 remote. Use API-based publishing only as a temporary bridge, then reconcile history so future `git fetch/push` works normally.

## After Publish
- record important release facts in the shared memory notes
- note any known non-blocking issues
- capture any follow-up cleanup or roadmap items
