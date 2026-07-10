#!/usr/bin/env python3
"""Blackboard query/insert helper for shared-mcp/memory-bridge.js.

Reads a JSON payload from stdin with shape:
    {"op": "query"|"insert", "db": "<sqlite path>", ...op-specific fields}

Contract preserved verbatim from the former inline `python -c "..."` script in
memory-bridge.js. Do NOT change SQL semantics or output format.

Output: a single JSON line on stdout, identical to the prior inline script.
"""

import json
import sqlite3
import sys


def _run_query(db, payload):
    states = [
        str(item).strip().upper()
        for item in payload.get("states", [])
        if str(item).strip()
    ]
    where = ""
    params = []
    if states:
        where = " WHERE state IN ({})".format(",".join("?" for _ in states))
        params.extend(states)
    params.append(max(1, int(payload.get("limit", 10))))
    sql = (
        "SELECT id, repo, issue_number, issue_title, state, assigned_agent, "
        "processor, updated_at FROM tasks{} "
        "ORDER BY updated_at DESC LIMIT ?".format(where)
    )
    rows = [dict(row) for row in db.execute(sql, params)]
    print(json.dumps({"ok": True, "rows": rows}, ensure_ascii=False))


def _run_insert(db, payload):
    repo = str(payload["repo"]).strip()
    issue_number = int(payload["issue_number"])
    assigned_agent = (
        str(payload.get("assigned_agent") or "intel").strip() or "intel"
    )
    issue_title = str(
        payload.get("issue_title") or "{}#{}".format(repo, issue_number)
    ).strip()
    cursor = db.execute(
        "INSERT INTO tasks (repo, issue_number, assigned_agent, issue_title, state) "
        "VALUES (?, ?, ?, ?, ?)",
        (repo, issue_number, assigned_agent, issue_title, "PENDING"),
    )
    db.commit()
    print(json.dumps({"ok": True, "insertedId": cursor.lastrowid}, ensure_ascii=False))


def main():
    payload = json.load(sys.stdin)
    db = sqlite3.connect(payload["db"], timeout=5)
    db.row_factory = sqlite3.Row
    try:
        op = payload.get("op")
        if op == "query":
            _run_query(db, payload)
        elif op == "insert":
            _run_insert(db, payload)
        else:
            print(json.dumps({"ok": False, "error": "unsupported-op"}, ensure_ascii=False))
    finally:
        db.close()


if __name__ == "__main__":
    main()
