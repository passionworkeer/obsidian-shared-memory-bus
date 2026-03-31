# Releasing

Use this checklist when publishing a new public revision of the bundle.

## Before You Publish
- update the docs that changed with the runtime behavior
- update `CHANGELOG.md`
- rescan for secrets and personal paths
- confirm installer and runtime paths are still dynamic

## Minimum Validation
```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\scripts\install.ps1
powershell.exe -NoProfile -ExecutionPolicy Bypass -File $env:USERPROFILE\.ai-memory\shared-mcp\start-default-shared-mcp.ps1
powershell.exe -NoProfile -ExecutionPolicy Bypass -File $env:USERPROFILE\.ai-memory\verify-client-integrations.ps1 -WorkspaceRoot <your-project-root> -RunCliChecks
```

Run the pressure test if anything changed in shared MCP behavior, agent wiring, or memory indexing.

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

## After Publish
- record important release facts in the shared memory notes
- note any known non-blocking issues
- capture any follow-up cleanup or roadmap items
