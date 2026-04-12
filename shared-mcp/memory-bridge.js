/**
 * memory-bridge.js
 *
 * Handles all external-bridge / interoperability tools:
 *   query_claude_mem
 *   insert_claude_mem
 *   get_blackboard_tasks
 *   write_blackboard_task
 *
 * Exposes a factory: createMemoryBridge(params) => { tools, handlers }
 */

import fs from "node:fs";
import { spawn } from "node:child_process";

function jsonResult(payload) {
  return {
    content: [{ type: "text", text: JSON.stringify(payload, null, 2) }],
  };
}

function jsonErrorResult(payload) {
  return {
    content: [{ type: "text", text: JSON.stringify(payload, null, 2) }],
    isError: true,
  };
}

function errorResult(message) {
  return {
    content: [{ type: "text", text: JSON.stringify({ ok: false, error: String(message) }, null, 2) }],
    isError: true,
  };
}

function spawnProcess(executable, args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(executable, args, {
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
      ...options,
    });

    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => {
      stdout += chunk.toString();
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString();
    });
    child.on("error", reject);
    child.on("close", (code) => {
      resolve({ code: code || 0, stdout, stderr });
    });

    if (options.input !== undefined) {
      child.stdin.end(options.input);
    } else {
      child.stdin.end();
    }
  });
}

function truncateText(value, maxLength = 400) {
  const text = String(value || "");
  if (text.length <= maxLength) {
    return text;
  }
  return `${text.slice(0, maxLength)}...`;
}

function firstNonEmpty(values) {
  for (const value of values) {
    const normalized = String(value || "").trim();
    if (normalized) {
      return normalized;
    }
  }
  return "";
}

async function readResponseEnvelope(response) {
  const contentType = String(response.headers.get("content-type") || "").trim();
  const text = await response.text();
  const trimmedText = text.trim();
  let json = null;

  if (trimmedText) {
    try {
      json = JSON.parse(trimmedText);
    } catch {
      json = null;
    }
  }

  return {
    ok: response.ok,
    status: response.status,
    statusText: response.statusText,
    contentType,
    text: trimmedText,
    json,
  };
}

function describeClaudeMemFailure({ route, envelope }) {
  const summary = {
    route,
    status: envelope.status,
    statusText: envelope.statusText,
    contentType: envelope.contentType,
  };

  if (envelope.json !== null) {
    summary.response = envelope.json;
  } else if (envelope.text) {
    summary.responseText = truncateText(envelope.text);
  }

  return summary;
}

/**
 * @param {Object} params
 * @param {string} params.CLAUDE_MEM_BASE  - Base URL for claude-mem API (e.g. "http://127.0.0.1:37778")
 * @param {Object} params.PYTHON           - Python runtime descriptor {command, available, error, version, argsPrefix}
 * @param {Object} params.PYTHON_SPAWN_ENV  - Merged env object for spawning Python
 * @param {Function} params.withPythonArgs  - Helper: [pythonExe, ...pythonArgs, ...scriptArgs]
 * @param {string} params.BLACKBOARD_DB_PATH
 */
export function createMemoryBridge(params) {

  async function fetchClaudeMem(route, options = {}) {
    const response = await fetch(`${params.CLAUDE_MEM_BASE}${route}`, options);
    return readResponseEnvelope(response);
  }

  async function verifyClaudeMemObservationInserted({ content, title, project }) {
    try {
      const query = new URLSearchParams({
        limit: "25",
      });

      if (project) {
        query.set("project", project);
      }

      const envelope = await fetchClaudeMem(`/api/observations?${query.toString()}`);
      if (!envelope.ok || envelope.json === null || !Array.isArray(envelope.json.items)) {
        return {
          verified: false,
          reason: "observations-unavailable",
        };
      }

      const exactMatch = envelope.json.items.find((item) => {
        const narrative = String(item?.narrative || "").trim();
        const text = String(item?.text || "").trim();
        const itemTitle = String(item?.title || "").trim();
        const itemProject = String(item?.project || "").trim();

        return (
          (narrative === content || text === content)
          && (!title || itemTitle === title)
          && (!project || itemProject === project)
        );
      });

      if (!exactMatch) {
        return {
          verified: false,
          reason: "observation-not-found",
        };
      }

      return {
        verified: true,
        source: "observations",
        observation: {
          id: exactMatch.id,
          title: exactMatch.title,
          project: exactMatch.project,
          created_at_epoch: exactMatch.created_at_epoch,
        },
      };
    } catch (error) {
      return {
        verified: false,
        reason: `verification-failed: ${error.message}`,
      };
    }
  }

  async function runBlackboardPython(payload) {
    const { PYTHON, BLACKBOARD_DB_PATH, PYTHON_SPAWN_ENV, withPythonArgs } = params;

    if (!fs.existsSync(BLACKBOARD_DB_PATH)) {
      return { ok: false, error: `blackboard-db-missing: ${BLACKBOARD_DB_PATH}` };
    }
    if (!PYTHON.available) {
      return { ok: false, error: `python-runtime-unavailable: ${PYTHON.error || "unknown-error"}` };
    }

    // NOTE: Inline -c string is intentional — avoids a temp file on disk.
    // Debug tip: to inspect, add `print("DEBUG:", payload)` before json.load().
    const script = `
import json
import sqlite3
import sys

payload = json.load(sys.stdin)
db = sqlite3.connect(payload["db"], timeout=5)
db.row_factory = sqlite3.Row

try:
    if payload["op"] == "query":
        states = [str(item).strip().upper() for item in payload.get("states", []) if str(item).strip()]
        where = ""
        params = []
        if states:
            where = " WHERE state IN ({})".format(",".join("?" for _ in states))
            params.extend(states)
        params.append(max(1, int(payload.get("limit", 10))))
        sql = "SELECT id, repo, issue_number, issue_title, state, assigned_agent, processor, updated_at FROM tasks{} ORDER BY updated_at DESC LIMIT ?".format(where)
        rows = [dict(row) for row in db.execute(sql, params)]
        print(json.dumps({"ok": True, "rows": rows}, ensure_ascii=False))
    elif payload["op"] == "insert":
        repo = str(payload["repo"]).strip()
        issue_number = int(payload["issue_number"])
        assigned_agent = str(payload.get("assigned_agent") or "intel").strip() or "intel"
        issue_title = str(payload.get("issue_title") or "{}#{}".format(repo, issue_number)).strip()
        cursor = db.execute(
            "INSERT INTO tasks (repo, issue_number, assigned_agent, issue_title, state) VALUES (?, ?, ?, ?, ?)",
            (repo, issue_number, assigned_agent, issue_title, 'PENDING'),
        )
        db.commit()
        print(json.dumps({"ok": True, "insertedId": cursor.lastrowid}, ensure_ascii=False))
    else:
        print(json.dumps({"ok": False, "error": "unsupported-op"}, ensure_ascii=False))
finally:
    db.close()
`;

    const result = await spawnProcess(PYTHON.command, withPythonArgs(PYTHON, ["-c", script]), {
      env: PYTHON_SPAWN_ENV,
      input: JSON.stringify({
        ...payload,
        db: BLACKBOARD_DB_PATH,
      }),
    });

    if (result.code !== 0) {
      return {
        ok: false,
        error: result.stderr.trim() || result.stdout.trim() || `blackboard-exit-${result.code}`,
      };
    }

    try {
      return JSON.parse(result.stdout || "{}");
    } catch (error) {
      return { ok: false, error: `blackboard-json-parse-failed: ${error.message}` };
    }
  }

  async function handleQueryClaudeMem(args) {
    const query = String(args.query || "").trim();
    if (!query) {
      return errorResult("query is required");
    }
    const limit = Math.max(1, Number(args.limit) || 5);
    const route = `/api/search?query=${encodeURIComponent(query)}&limit=${limit}`;
    const response = await fetchClaudeMem(route);

    if (!response.ok) {
      return jsonErrorResult({
        ok: false,
        query,
        error: "claude-mem query failed",
        ...describeClaudeMemFailure({ route, envelope: response }),
      });
    }

    return jsonResult({
      ok: true,
      query,
      response: response.json ?? response.text,
    });
  }

  async function handleInsertClaudeMem(args) {
    const content = String(args.content || "").trim();
    if (!content) {
      return errorResult("content is required");
    }

    const metadata = args.metadata && typeof args.metadata === "object" ? args.metadata : {};
    const title = firstNonEmpty([
      metadata.title,
      metadata.summary,
      metadata.subject,
      metadata.label,
    ]);
    const project = firstNonEmpty([
      metadata.project,
      metadata.workspace,
      metadata.repo,
      metadata.repository,
      metadata.sourceProject,
    ]);

    const attempts = [
      {
        route: "/api/memory/save",
        buildBody: () => ({
          text: content,
          ...(title ? { title } : {}),
          ...(project ? { project } : {}),
        }),
      },
      {
        route: "/api/memories",
        buildBody: () => ({
          content,
          metadata,
        }),
      },
    ];

    const failures = [];

    for (const attempt of attempts) {
      const envelope = await fetchClaudeMem(attempt.route, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(attempt.buildBody()),
      });

      if (envelope.ok) {
        return jsonResult({
          ok: true,
          route: attempt.route,
          verifiedPersistence: false,
          response: envelope.json ?? envelope.text ?? null,
        });
      }

      failures.push(describeClaudeMemFailure({ route: attempt.route, envelope }));

      if (attempt.route === "/api/memory/save") {
        const verification = await verifyClaudeMemObservationInserted({ content, title, project });
        if (verification.verified) {
          return jsonResult({
            ok: true,
            route: attempt.route,
            verifiedPersistence: true,
            warning:
              "claude-mem returned a non-success status after persisting the observation; treating as success after verification",
            verification,
            response: envelope.json ?? envelope.text ?? null,
          });
        }
      }

      if (envelope.status !== 404) {
        break;
      }
    }

    return jsonErrorResult({
      ok: false,
      error: "claude-mem insert failed",
      failures,
    });
  }

  async function handleGetBlackboardTasks(args) {
    const normalizedStates = Array.isArray(args.states)
      ? args.states.map((value) => String(value || "").trim().toUpperCase()).filter(Boolean)
      : [];
    if (normalizedStates.length === 0 && String(args.state || "").trim()) {
      normalizedStates.push(String(args.state).trim().toUpperCase());
    }

    const result = await runBlackboardPython({
      op: "query",
      limit: Math.max(1, Number(args.limit) || 10),
      states: normalizedStates,
    });
    return jsonResult(result);
  }

  async function handleWriteBlackboardTask(args) {
    const repo = String(args.repo || "").trim();
    const issueNumber = Number(args.issue_number);
    if (!repo || !Number.isFinite(issueNumber)) {
      return errorResult("repo and issue_number are required");
    }
    const result = await runBlackboardPython({
      op: "insert",
      repo,
      issue_number: issueNumber,
      assigned_agent: String(args.assigned_agent || "intel"),
      issue_title: String(args.issue_title || ""),
    });
    return jsonResult(result);
  }

  return {
    handlers: {
      query_claude_mem: handleQueryClaudeMem,
      insert_claude_mem: handleInsertClaudeMem,
      get_blackboard_tasks: handleGetBlackboardTasks,
      write_blackboard_task: handleWriteBlackboardTask,
    },
  };
}
