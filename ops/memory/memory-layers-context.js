// ---------------------------------------------------------------------------
// memory-layers-context.js — Global context and layer summary generation
// Extracted from ops/build-memory-layers.js (2019 lines)
// ---------------------------------------------------------------------------

const {
  normalizeSpaces,
  STRUCTURED_ROOT,
  MEMORY_LAYERS_MD: PARSE_MEMORY_LAYERS_MD,
  MEMORY_LAYERS_JSON: PARSE_MEMORY_LAYERS_JSON,
  GLOBAL_CONTEXT_MD: PARSE_GLOBAL_CONTEXT_MD,
  GLOBAL_CONTEXT_META_JSON: PARSE_GLOBAL_CONTEXT_META_JSON,
  GLOBAL_CONTEXT_BODY_MD: PARSE_GLOBAL_CONTEXT_BODY_MD,
  buildGeneratedArtifactMetadata,
  DURABLE_SCOPES,
  MIN_PROMOTION_CONFIDENCE,
  NON_PROMOTABLE_PROMOTION_TYPES,
} = await import("./memory-layers-parse.js");

// ---------------------------------------------------------------------------
// Re-export path constants from parse module (no duplication)
// ---------------------------------------------------------------------------

const MEMORY_LAYERS_MD = PARSE_MEMORY_LAYERS_MD;
const MEMORY_LAYERS_JSON = PARSE_MEMORY_LAYERS_JSON;
const GLOBAL_CONTEXT_MD = PARSE_GLOBAL_CONTEXT_MD;
const GLOBAL_CONTEXT_META_JSON = PARSE_GLOBAL_CONTEXT_META_JSON;
const GLOBAL_CONTEXT_BODY_MD = PARSE_GLOBAL_CONTEXT_BODY_MD;

// ---------------------------------------------------------------------------
// Token-budget and progressive-rendering config for GLOBAL-CONTEXT.md generation
// ---------------------------------------------------------------------------

const CONTEXT_LIMITS = {
  user: 5,          // max user records to display
  feedback: 5,
  project: 8,
  reference: 8,
  event_task: 8,    // combined event + task
  estimated_chars_per_token: 4,
  max_file_size_chars: 8000, // warn if exceeded
};

// ADR-002 v2: 5-tier budget limits (enforced by memory-archival.js)
const TIER_BUDGET_LIMITS = {
  1: 200,  // Event/Working
  2: 200,  // Session Durable
  3: 100,  // Project Durable (per project)
  4: 200,  // Shared Durable (per type)
  5: 500,  // Archive (soft limit)
};

// ---------------------------------------------------------------------------
// Freshness scoring
// ---------------------------------------------------------------------------

/**
 * Estimate token count for a record using char_count / chars_per_token.
 * Returns a new summary object — does not mutate the original record.
 */
function withTokenEstimate(record) {
  const charCount = String(record.content || "").length;
  const estimatedTokens = Math.ceil(charCount / CONTEXT_LIMITS.estimated_chars_per_token);
  // Return a new summary object with the extra field
  return {
    id: record.id,
    title: record.title,
    scope: record.scope,
    freshness: record.freshness,
    estimatedTokens,
    charCount,
  };
}

/**
 * Freshness score for sorting: higher = more important to show.
 * Returns a new value — does not mutate anything.
 */
function freshnessScore(record) {
  switch (record.freshness) {
    case "hot":   return 3;
    case "warm":  return 2;
    case "cold":  return 1;
    default:      return 0;
  }
}

/**
 * Sort records by freshness desc, then timestamp desc.
 * Returns a new sorted array — does not mutate the input.
 */
function sortByFreshnessDesc(records) {
  return [...records].sort((left, right) => {
    const scoreDiff = freshnessScore(right) - freshnessScore(left);
    if (scoreDiff !== 0) return scoreDiff;
    return String(right.t || "").localeCompare(String(left.t || ""));
  });
}

// ---------------------------------------------------------------------------
// Segment summarization
// ---------------------------------------------------------------------------

/**
 * Build per-segment summaries with token budgets from the memory layers.
 * Returns a new object — does not mutate the input layers.
 *
 * Segments:
 *   user       — durable records with scope === "user"
 *   feedback   — durable records with scope === "feedback"
 *   project    — durable records with scope === "project"
 *   reference  — durable records with scope === "reference"
 *   event_task — combined sharedEvents + taskMemory (scopes: event, task, run, job)
 */
function buildScopedSummaries(layers) {
  const allRecords = [
    ...(layers.sharedInbox || []),
    ...(layers.sessionMemory || []),
    ...(layers.sharedEvents || []),
    ...(layers.taskMemory || []),
  ];

  const segments = {
    user: {
      name: "用户偏好（user）",
      scope: ["user"],
      budget: CONTEXT_LIMITS.user,
      records: sortByFreshnessDesc(
        allRecords.filter((r) => (r.scope || "") === "user")
      ),
    },
    feedback: {
      name: "反馈与规则（feedback）",
      scope: ["feedback"],
      budget: CONTEXT_LIMITS.feedback,
      records: sortByFreshnessDesc(
        allRecords.filter((r) => (r.scope || "") === "feedback")
      ),
    },
    project: {
      name: "项目上下文（project）",
      scope: ["project"],
      budget: CONTEXT_LIMITS.project,
      records: sortByFreshnessDesc(
        allRecords.filter((r) => (r.scope || "") === "project")
      ),
    },
    reference: {
      name: "参考与链接（reference）",
      scope: ["reference"],
      budget: CONTEXT_LIMITS.reference,
      records: sortByFreshnessDesc(
        allRecords.filter((r) => (r.scope || "") === "reference")
      ),
    },
    event_task: {
      name: "事件与任务（event/task）",
      scope: ["event", "task", "run", "job", "journal"],
      budget: CONTEXT_LIMITS.event_task,
      records: sortByFreshnessDesc(
        allRecords.filter((r) =>
          ["event", "task", "run", "job", "journal"].includes(r.scope || "")
        )
      ),
    },
  };

  // Compute token estimates for all records and detect truncation per segment
  let totalRecords = 0;
  let estimatedTotalTokens = 0;
  let anyTruncated = false;

  for (const segment of Object.values(segments)) {
    const estimated = segment.records.map(withTokenEstimate);
    estimatedTotalTokens += estimated.reduce((sum, r) => sum + r.estimatedTokens, 0);
    totalRecords += segment.records.length;

    if (estimated.length > segment.budget) {
      anyTruncated = true;
      segment.displayedRecords = estimated.slice(0, segment.budget);
      segment.truncatedCount = estimated.length - segment.budget;
    } else {
      segment.displayedRecords = estimated;
      segment.truncatedCount = 0;
    }
  }

  return { segments, totalRecords, estimatedTotalTokens, anyTruncated };
}

/**
 * Render one markdown segment section.
 * Pure function — returns new strings, mutates nothing.
 */
function renderSegmentMarkdown(segment) {
  const lines = [`## ${segment.name}`, ""];

  if (segment.displayedRecords.length === 0) {
    lines.push("（暂无记录）", "");
    return lines.join("\n");
  }

  for (const record of segment.displayedRecords) {
    lines.push(`- **${record.title}** _[~${record.estimatedTokens} tokens]_`);
  }

  if (segment.truncatedCount > 0) {
    const totalTokens = segment.displayedRecords.reduce((s, r) => s + r.estimatedTokens, 0);
    lines.push(`- _... 还有 ${segment.truncatedCount} 条记录，估算 ${totalTokens} tokens，超出显示预算_`);
  }

  lines.push("");
  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// GLOBAL-CONTEXT generation
// ---------------------------------------------------------------------------

/**
 * Build GLOBAL-CONTEXT.md and GLOBAL-CONTEXT.meta.json from memory layers.
 * Returns a new object { markdown, meta } — does not mutate layers.
 */
function buildGlobalContext(layers) {
  const generatedAt = new Date().toISOString();
  const { segments, totalRecords, estimatedTotalTokens, anyTruncated } =
    buildScopedSummaries(layers);

  // Accumulate markdown sections
  const headerComment = [
    `<!-- GLOBAL-CONTEXT: generated at ${generatedAt} -->`,
    `<!-- total_records: ${totalRecords} | estimated_total_tokens: ${estimatedTotalTokens} | budgeted_display_tokens: ${CONTEXT_LIMITS.max_file_size_chars / CONTEXT_LIMITS.estimated_chars_per_token} -->`,
    "",
  ].join("\n");

  const lines = [
    "# Shared AI Memory — Global Context",
    "",
    `> Generated at: ${generatedAt}`,
    `> Token budget: ${CONTEXT_LIMITS.max_file_size_chars} chars / ~${Math.round(CONTEXT_LIMITS.max_file_size_chars / CONTEXT_LIMITS.estimated_chars_per_token)} tokens  ·  ${totalRecords} records in store · ~${estimatedTotalTokens} estimated tokens`,
    "",
  ];

  lines.push(renderSegmentMarkdown(segments.user));
  lines.push(renderSegmentMarkdown(segments.feedback));
  lines.push(renderSegmentMarkdown(segments.project));
  lines.push(renderSegmentMarkdown(segments.reference));
  lines.push(renderSegmentMarkdown(segments.event_task));

  // Long-term accumulation footer
  lines.push("## 长期积累", "");
  const remainingByScope = {};
  for (const [key, seg] of Object.entries(segments)) {
    if (seg.truncatedCount > 0) {
      remainingByScope[key] = seg.truncatedCount;
    }
  }
  const remainingTotal = Object.values(remainingByScope).reduce((s, n) => s + n, 0);
  if (remainingTotal > 0) {
    lines.push(
      `> 还有 ${remainingTotal} 条记录超出显示预算，保存在结构化存储中：`,
      Object.entries(remainingByScope)
        .map(([k, n]) => `- ${k}: ${n} 条`)
        .join("\n"),
      "",
      "完整记录请查看 store root 下的 `structured/` JSONL 文件。",
      ""
    );
  } else {
    lines.push("（所有记录均已在上面展示）", "");
  }

  const markdown = headerComment + lines.join("\n");

  // Size warning
  if (markdown.length > CONTEXT_LIMITS.max_file_size_chars) {
    process.stderr.write(
      `[build-global-context] WARNING: GLOBAL-CONTEXT.md (${markdown.length} chars) exceeds ` +
        `soft limit of ${CONTEXT_LIMITS.max_file_size_chars} chars.\n`
    );
  }

  // Build meta JSON (immutable — constructed from scratch)
  const metaSegments = Object.entries(segments).map(([, seg]) => ({
    name: seg.name,
    scope: seg.scope,
    budget: seg.budget,
    totalCount: seg.records.length,
    displayedRecords: seg.displayedRecords.map((r) => ({
      id: r.id,
      title: r.title,
      scope: r.scope,
      freshness: r.freshness,
      estimatedTokens: r.estimatedTokens,
    })),
    truncated: seg.truncatedCount > 0,
    truncatedCount: seg.truncatedCount,
  }));

  const meta = {
    generatedAt,
    totalRecords,
    estimatedTotalTokens,
    budgetedDisplayTokens: Math.round(CONTEXT_LIMITS.max_file_size_chars / CONTEXT_LIMITS.estimated_chars_per_token),
    fileSizeChars: markdown.length,
    truncated: anyTruncated,
    segments: metaSegments,
  };

  return { markdown, meta, bodyMarkdown: markdown };
}

// ---------------------------------------------------------------------------
// Scope analysis helpers
// ---------------------------------------------------------------------------

function buildScopeCounts(records) {
  const counts = {};
  for (const record of records) {
    const scope = normalizeSpaces(record.scope || "summary") || "summary";
    counts[scope] = (counts[scope] || 0) + 1;
  }

  return Object.fromEntries(
    Object.entries(counts).sort((left, right) => {
      if (right[1] !== left[1]) {
        return right[1] - left[1];
      }
      return left[0].localeCompare(right[0]);
    })
  );
}

function buildScopedHighlights(records, limitPerScope = 3) {
  const grouped = {};
  const ordered = [...records].sort((left, right) => String(right.t || "").localeCompare(String(left.t || "")));

  for (const record of ordered) {
    const scope = normalizeSpaces(record.scope || "summary") || "summary";
    if (!grouped[scope]) {
      grouped[scope] = [];
    }
    if (grouped[scope].length >= limitPerScope) {
      continue;
    }
    grouped[scope].push({
      tool: record.tool,
      scope: record.scope,
      title: record.title,
      t: record.t,
    });
  }

  return Object.fromEntries(
    Object.entries(grouped).sort((left, right) => {
      if (right[1].length !== left[1].length) {
        return right[1].length - left[1].length;
      }
      return left[0].localeCompare(right[0]);
    })
  );
}

// ---------------------------------------------------------------------------
// MEMORY-INDEX.md — rich navigation index
// ---------------------------------------------------------------------------

/**
 * Build MEMORY-INDEX.md — a human-navigable table of all durable memory files.
 * Inspired by restored-cli's MEMORY.md index format.
 *
 * @param {object} layers - the memory layers object
 * @returns {string} markdown content for MEMORY-INDEX.md
 */
function buildMemoryIndex(layers) {
  const durableRecords = [
    ...(layers.sharedInbox || []),
    ...(layers.sessionMemory || []),
    ...(layers.sharedEvents || []),
    ...(layers.taskMemory || []),
  ].filter((r) => r.scope !== "task" && r.scope !== "event");

  // Group by scope
  const byScope = {};
  for (const rec of durableRecords) {
    const scope = normalizeSpaces(rec.scope || "summary") || "summary";
    if (!byScope[scope]) byScope[scope] = [];
    byScope[scope].push(rec);
  }

  const lines = [
    "# Memory Index",
    "",
    `> Auto-generated at ${new Date().toISOString()}`,
    `> ${durableRecords.length} durable records across ${Object.keys(byScope).length} scopes`,
    "",
  ];

  const scopeLabels = {
    user: "用户偏好",
    feedback: "反馈与规则",
    project: "项目上下文",
    reference: "外部引用",
    summary: "会话摘要",
    run: "运行记录",
    job: "任务作业",
    journal: "日志记录",
  };

  for (const [scope, records] of Object.entries(byScope)) {
    const label = scopeLabels[scope] || scope;
    lines.push(`## ${label} (${scope})`);
    lines.push("");

    for (const rec of records.slice(0, 20)) {
      const title = normalizeSpaces(rec.title || rec.id || "(untitled)") || "(untitled)";
      const desc = normalizeSpaces(
        (rec.description || String(rec.content || "").substring(0, 60)).replace(/[#*`_~[\]]/g, "")
      );
      const id = normalizeSpaces(rec.id || "") || "";
      const slug = id.replace(/[^a-zA-Z0-9]/g, "-").substring(0, 20);
      lines.push(`- [${title}](#${slug}) — ${desc}...`);
    }

    if (records.length > 20) {
      lines.push(`- _... 还有 ${records.length - 20} 条记录_`);
    }
    lines.push("");
  }

  lines.push("---");
  lines.push("");
  lines.push("## 生成文件导航");
  lines.push("");
  lines.push("- [GLOBAL-CONTEXT.body.md](./GLOBAL-CONTEXT.body.md) — 全局上下文主体");
  lines.push("- [AUTO-DREAM.md](./AUTO-DREAM.md) — 梦境整合摘要");
  lines.push("- [HANDOFF.md](./HANDOFF.md) — 交接包");
  lines.push("- [MEMORY-LAYERS.md](./MEMORY-LAYERS.md) — 层级概览");
  lines.push("");
  lines.push("> Memory hygiene stats: see `generated/memory_hygiene_report.json` under the store root if present");

  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// Layer summary
// ---------------------------------------------------------------------------

function buildLayerSummary(layers) {
  const generatedAt = new Date().toISOString();
  const artifactMetadata = buildGeneratedArtifactMetadata({
    structuredRoot: STRUCTURED_ROOT,
    generatedAt,
  });
  const durableByScope = buildScopeCounts(layers.sharedInbox);
  const durableHighlightsByScope = buildScopedHighlights(layers.sharedInbox, 3);
  const lines = [
    "# Memory Layers",
    "",
    `Generated at: ${generatedAt}`,
    "",
    "## Layer Counts",
    "",
    `- shared-inbox: ${layers.sharedInbox.length}`,
    `- session-memory: ${layers.sessionMemory.length}`,
    `- shared-events: ${layers.sharedEvents.length}`,
    `- task-memory: ${layers.taskMemory.length}`,
    "",
    "## Durable By Scope",
    "",
  ];

  const durableScopeEntries = Object.entries(durableByScope);
  if (durableScopeEntries.length === 0) {
    lines.push("- No durable scope coverage yet.");
  } else {
    for (const [scope, count] of durableScopeEntries) {
      lines.push(`- ${scope}: ${count}`);
    }
  }

  lines.push(
    "",
    "## Durable Highlights",
    ""
  );

  const durableHighlights = layers.sharedInbox.slice(-8).reverse();
  if (durableHighlights.length === 0) {
    lines.push("- No durable shared inbox signals yet.");
  } else {
    for (const record of durableHighlights) {
      lines.push(`- [${record.tool}] [${record.scope}] ${record.title}`);
    }
  }

  lines.push("", "## Durable Highlights By Scope", "");
  if (durableScopeEntries.length === 0) {
    lines.push("- No typed durable scope highlights yet.");
  } else {
    for (const [scope, items] of Object.entries(durableHighlightsByScope)) {
      lines.push(`- ${scope}: ${items.length} recent durable highlights`);
      for (const item of items) {
        lines.push(`- [${item.tool}] [${scope}] ${item.title}`);
      }
    }
  }

  lines.push("", "## Session Highlights", "");
  const sessionHighlights = layers.sessionMemory.slice(-6).reverse();
  if (sessionHighlights.length === 0) {
    lines.push("- No session-layer records yet.");
  } else {
    for (const record of sessionHighlights) {
      lines.push(`- [${record.tool}] ${record.title}`);
    }
  }

  lines.push("", "## Event Highlights", "");
  const eventHighlights = layers.sharedEvents.slice(-6).reverse();
  if (eventHighlights.length === 0) {
    lines.push("- No recent shared bus events yet.");
  } else {
    for (const record of eventHighlights) {
      lines.push(`- [${record.tool}] ${record.title}`);
    }
  }

  lines.push("", "## Task Highlights", "");
  const taskHighlights = layers.taskMemory.slice(-8).reverse();
  if (taskHighlights.length === 0) {
    lines.push("- No task-layer records yet.");
  } else {
    for (const record of taskHighlights) {
      const taskState = record.task_state ? ` {${record.task_state}}` : "";
      lines.push(`- [${record.tool}]${taskState} ${record.title}`);
    }
  }

  return {
    markdown: `${lines.join("\n").trim()}\n`,
    json: {
      ...artifactMetadata,
      counts: {
        sharedInbox: layers.sharedInbox.length,
        sessionMemory: layers.sessionMemory.length,
        sharedEvents: layers.sharedEvents.length,
        taskMemory: layers.taskMemory.length,
        durableByScope,
      },
      latest: {
        sharedInbox: durableHighlights.map((record) => ({
          tool: record.tool,
          scope: record.scope,
          title: record.title,
          t: record.t,
        })),
        sessionMemory: sessionHighlights.map((record) => ({
          tool: record.tool,
          title: record.title,
          t: record.t,
        })),
        sharedEvents: eventHighlights.map((record) => ({
          tool: record.tool,
          title: record.title,
          t: record.t,
        })),
        taskMemory: taskHighlights.map((record) => ({
          tool: record.tool,
          taskState: record.task_state,
          title: record.title,
          t: record.t,
        })),
        durableByScope: durableHighlightsByScope,
      },
    },
  };
}

// ---------------------------------------------------------------------------
// @include directive resolver (shared)
// ---------------------------------------------------------------------------

import { resolveIncludes as resolveIncludesParse } from "./memory-layers-parse.js";

function resolveIncludes(content, baseDir, maxDepth = 5, currentDepth = 0) {
  return resolveIncludesParse(content, baseDir, maxDepth, currentDepth);
}

export {
  // Config constants
  CONTEXT_LIMITS,
  TIER_BUDGET_LIMITS,
  NON_PROMOTABLE_PROMOTION_TYPES,
  MIN_PROMOTION_CONFIDENCE,
  DURABLE_SCOPES,
  // Token budget helpers
  withTokenEstimate,
  freshnessScore,
  sortByFreshnessDesc,
  // Summarization
  buildScopedSummaries,
  renderSegmentMarkdown,
  // Global context
  buildGlobalContext,
  buildScopeCounts,
  buildScopedHighlights,
  // Memory index
  buildMemoryIndex,
  // Layer summary
  buildLayerSummary,
  // Path constants
  MEMORY_LAYERS_MD,
  MEMORY_LAYERS_JSON,
  GLOBAL_CONTEXT_MD,
  GLOBAL_CONTEXT_META_JSON,
  GLOBAL_CONTEXT_BODY_MD,
  // Shared utilities
  resolveIncludes,
};
