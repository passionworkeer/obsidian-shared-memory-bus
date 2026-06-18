# Productization And Promotion Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Turn Local AI Memory Bus into a Chinese-first bilingual package that is easy to install, easy for AI tools to join, and easy to promote publicly.

**Architecture:** This is a documentation and asset packaging pass. It adds a canonical root skill, a copyable `.agents/skills` agent pack, bilingual promotion docs, and generated/static promotional assets without changing core runtime behavior.

**Tech Stack:** Markdown, SVG, existing PowerShell/Node install scripts, built-in image generation.

---

## File Structure

- Create: `SKILL.md` as the canonical universal skill entry point.
- Create: `.agents/skills/AGENT_BOOT.md` as the host-neutral bootstrap protocol.
- Create: `.agents/skills/codex.md`, `.agents/skills/claude-code.md`, `.agents/skills/copilot.md`, `.agents/skills/cursor.md`, `.agents/skills/opencode.md`, `.agents/skills/trae.md` for per-tool onboarding.
- Create: `docs/promotion/QUICKSTART.zh-CN.md` and `docs/promotion/QUICKSTART.en.md` for public onboarding.
- Create: `docs/promotion/POST.zh-CN.md`, `docs/promotion/POST.en.md`, `docs/promotion/VIDEO-STORYBOARD.zh-CN.md`, `docs/promotion/VIDEO-STORYBOARD.en.md`, and `docs/promotion/IMAGE-PROMPTS.md`.
- Create: `assets/promo/svg/*.svg` for exact bilingual text cards.
- Create: `assets/promo/*.png` from image generation for visually rich non-text promotional images.
- Modify: `README.md` to point at the new Chinese-first promotion and agent pack entry points.
- Modify: `docs/INDEX.md` to include the promotion and agent pack docs.
- Modify: `.gitignore` to ignore `.superpowers/` visual companion sessions.

### Task 1: Agent Pack

**Files:**
- Create: `SKILL.md`
- Create: `.agents/skills/AGENT_BOOT.md`
- Create: `.agents/skills/codex.md`
- Create: `.agents/skills/claude-code.md`
- Create: `.agents/skills/copilot.md`
- Create: `.agents/skills/cursor.md`
- Create: `.agents/skills/opencode.md`
- Create: `.agents/skills/trae.md`

- [x] **Step 1: Add the root universal skill**

Create `SKILL.md` with Chinese-first bilingual sections: what the project is, startup read order, store resolution, MCP usage, writeback rules, and safety rules.

- [x] **Step 2: Add host-neutral bootstrap**

Create `.agents/skills/AGENT_BOOT.md` with exact startup steps and fallback behavior for missing MCP.

- [x] **Step 3: Add per-tool files**

Create one concise file per supported tool, each pointing back to `AGENT_BOOT.md` and describing tool-specific behavior.

- [x] **Step 4: Verify agent pack links**

Run: `Get-ChildItem .agents/skills | Select-Object Name`

Expected: all seven agent-pack files are listed.

### Task 2: Bilingual Promotion Docs

**Files:**
- Create: `docs/promotion/QUICKSTART.zh-CN.md`
- Create: `docs/promotion/QUICKSTART.en.md`
- Create: `docs/promotion/POST.zh-CN.md`
- Create: `docs/promotion/POST.en.md`
- Create: `docs/promotion/VIDEO-STORYBOARD.zh-CN.md`
- Create: `docs/promotion/VIDEO-STORYBOARD.en.md`
- Create: `docs/promotion/IMAGE-PROMPTS.md`
- Modify: `README.md`
- Modify: `docs/INDEX.md`

- [x] **Step 1: Add quick starts**

Create Chinese-first and English-first quick starts that reuse existing install commands and status checks.

- [x] **Step 2: Add public post drafts**

Create forum/article drafts with headline, hook, problem, solution, architecture, demo, and call to action.

- [x] **Step 3: Add video storyboards**

Create 60-90 second short-video scripts for Chinese and English audiences.

- [x] **Step 4: Add image prompt catalog**

Create prompt specs for generated images and deterministic SVG cards.

- [x] **Step 5: Link from README and docs index**

Add compact links to the new materials without replacing existing technical docs.

### Task 3: Promotion Assets

**Files:**
- Create: `assets/promo/svg/hero-zh-en.svg`
- Create: `assets/promo/svg/problem-zh-en.svg`
- Create: `assets/promo/svg/architecture-zh-en.svg`
- Create: `assets/promo/svg/setup-zh-en.svg`
- Create: `assets/promo/*.png`

- [x] **Step 1: Add deterministic SVG cards**

Create exact bilingual SVGs for text-heavy graphics: hero, problem, architecture, and setup.

- [x] **Step 2: Generate bitmap promotional images**

Use the built-in image generation tool for visually rich no-exact-text images and save selected outputs under `assets/promo/`.

- [x] **Step 3: Verify assets exist**

Run: `Get-ChildItem assets/promo -Recurse | Select-Object FullName,Length`

Expected: SVG cards and generated PNG files are present.

### Task 4: Verification

**Files:**
- All created and modified files.

- [x] **Step 1: Validate layout**

Run: `npm run validate`

Expected: command exits 0.

- [x] **Step 2: Run focused docs/link checks**

Run: `Get-ChildItem SKILL.md,.agents/skills,docs/promotion,assets/promo -Recurse | Measure-Object`

Expected: command exits 0 and reports created files.

- [x] **Step 3: Check git diff**

Run: `git status --short`

Expected: only productization, promotion, docs, and asset files changed.

## Self-Review

Spec coverage:
- Agent Pack is covered by Task 1.
- Simple Adoption Surface is covered by Task 2.
- Promotion Kit is covered by Tasks 2 and 3.
- Verification is covered by Task 4.

Placeholder scan:
- No incomplete placeholder instructions remain.

Scope check:
- The plan avoids runtime behavior changes. A future package-distribution pass can add `npx` or release automation separately.
