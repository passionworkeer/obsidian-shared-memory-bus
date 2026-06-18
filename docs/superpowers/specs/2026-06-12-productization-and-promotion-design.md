# Productization And Promotion Design

## Goal

Make Local AI Memory Bus easy to adopt and easy to explain for both Chinese and English audiences, with Chinese as the default first-read experience.

## Recommended Shape

Use a three-part product surface:

1. Agent Pack: a real, copyable universal agent entry point plus per-tool instructions.
2. One-Command Onboarding: a short happy path that points to existing install and verification scripts.
3. Demo Story Kit: reusable bilingual materials and generated visuals for forums, videos, articles, and README promotion.

This shape is stronger than packaging the project only as a skill. The skill solves agent onboarding, while the onboarding guide solves human setup and the story kit solves public explanation.

## Audience

Primary audience:
- Chinese technical users who use multiple AI coding tools and want shared local memory.
- Power users who already understand Claude Code, Codex, Cursor, Copilot, OpenCode, or MCP.

Secondary audience:
- English-speaking developers evaluating local-first AI memory tooling.
- Open-source readers who need quick architecture confidence before installing.

## Bilingual Policy

Chinese is the default language for headings, README-style quick starts, and promotion copy. English appears directly beside or below the Chinese copy, not in a separate hidden document only.

Long-form materials may have parallel files:
- `*.zh-CN.md` for Chinese-first publication.
- `*.en.md` for English-first publication.

Reusable agent instructions should be bilingual in the same file so an AI host can consume one source without selecting a language first.

## Deliverables

### Agent Pack

Create a root `SKILL.md` that is the canonical universal entry point. Create `.agents/skills/AGENT_BOOT.md` and per-tool files for Codex, Claude Code, Copilot, Cursor, OpenCode, and Trae.

Each agent file must cover:
- what to read at startup;
- how to resolve the memory store;
- how to use MCP when available;
- where to write durable fallback notes;
- what not to store, especially secrets;
- how to handle missing store or missing MCP.

### Simple Adoption Surface

Add a bilingual quick-start page under `docs/promotion/` that says, in plain language:
- what problem the project solves;
- what command to run first;
- how to verify success;
- what files and endpoints matter;
- how to explain the value in one sentence.

The quick start should favor the existing install scripts instead of inventing a new runtime path in this pass.

### Promotion Kit

Create a promotion folder with:
- Chinese and English post drafts;
- video storyboard;
- image prompt catalog;
- saved generated bitmap images under `assets/promo/`;
- deterministic bilingual SVG cards under `assets/promo/svg/` for text-heavy graphics where generated text would be unreliable.

The visual story should cover:
- the problem: every AI tool forgets separately;
- the solution: one local memory bus;
- the architecture: clients, MCP, retrieval, local store;
- the privacy angle: local-first, no SaaS dependency;
- the demo: Codex to Claude Code to Copilot handoff;
- the setup: install, join, remember.

## Architecture

The implementation is documentation- and asset-first. It should not alter core runtime behavior unless a setup gap forces it.

The project already has core runtime pieces:
- `scripts/install.ps1` and `scripts/install.sh` for installation;
- `shared-mcp/` for shared MCP endpoints;
- `.ai-memory` as the canonical local store;
- `docs/SKILL.md` and `templates/agents/portable-skill/SKILL.md` as earlier universal-skill drafts.

This work promotes those existing capabilities into a cleaner public surface.

## Testing And Verification

Verify documentation links and repository layout with:
- `npm run validate`;
- `npm test` when feasible;
- `git status --short` to confirm the changed surface.

For generated assets:
- confirm files exist in `assets/promo/`;
- avoid relying on generated images for exact text;
- use SVG or Markdown for exact bilingual copy.

## Non-Goals

This pass does not:
- rewrite the core MCP server;
- change retrieval ranking behavior;
- add a new package manager distribution flow;
- promise zero-dependency install beyond the existing Node, Python, and PowerShell requirements.

## Approval

The user approved the recommended direction on 2026-06-12: Agent Pack + One-Command Installer + Demo Story Kit, with Chinese-first bilingual support.
