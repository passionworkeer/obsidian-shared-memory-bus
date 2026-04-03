# Release Notes: 2026-04-03

This release hardens the Windows runtime so shared MCP services behave like background infrastructure instead of foreground console apps.

## Highlights

- Windows shared MCP and watchdog launches now use a no-console background path instead of relying only on `WindowStyle Hidden`.
- Node child processes used by the shared runtime now opt into `windowsHide: true` so nested `node`, `cmd`, and `powershell` launches stay out of the foreground.
- Shared proxy launch no longer passes resolved environment payloads on the command line, which removes a real local process-list leakage path for sensitive runtime values.
- Shared MCP mutex handling now tolerates abandoned mutex recovery in `start`, `status`, and `stop` flows after interrupted runs.

## Operator Impact

- Existing installs should be re-applied with `scripts/install.ps1` or `scripts/install.sh` so the managed runtime under `~/.ai-memory` picks up the new launch behavior.
- If a cold Windows start needs extra time for `npx`-backed servers such as `context7` or `sequential-thinking`, let the first startup settle before judging the stack unhealthy.

## Packaging Improvements

- Added portable agent templates under `templates/agents/` for the two most reusable integration shapes:
  - `portable-skill`
  - `thin-plugin`
- README now points new adopters to a clearer start path: quick start, integration modes, template kits, validation, and release notes.
