@{
    FlatRuntimeFiles = @{
        bus = @(
            "generate-embeddings.js"
            "memory-bus.ps1"
            "memory-watchdog.ps1"
            "python-runtime.js"
            "register-agent.ps1"
            "vault-root.js"
        )
        ops = @(
            "build-handoff-pack.js"
            "build-memory-layers.js"
            "cleanup-inbox.ps1"
            "obsidian-blackboard-daemon.js"
            "repair-codex-runtime.ps1"
            "run-memory-dream.ps1"
            "run-minimax-mcp.ps1"
            "run-obsidian-mcp.ps1"
            "run-pressure-test.ps1"
            "sync-claudemem-to-obsidian.ps1"
            "sync-openclaw-to-obsidian.js"
            "sync-shared-skills.ps1"
            "verify-client-integrations.ps1"
            "verify-integrations.ps1"
        )
        retrieval = @(
            "benchmark-architecture.py"
            "benchmark-backends.py"
            "probe-models.py"
            "semantic-search.js"
            "semantic-search.py"
        )
    }
    SharedMcpFiles = @(
        "manifest.json"
        "omni-memory-server.js"
        "package-lock.json"
        "package.json"
        "playwright-stdio-proxy.js"
        "singleton-stdio-mcp-proxy.mjs"
        "start-default-shared-mcp.ps1"
        "start-shared-mcp.ps1"
        "status-shared-mcp.ps1"
        "stop-shared-mcp.ps1"
        "write-config-snippets.ps1"
    )
    TemplateFiles = @(
        "agents.json"
    )
    LegacyCleanupFiles = @(
        "benchmark-embedding-backends.py"
        "export-bundle.ps1"
        "install-client-integrations.ps1"
        "probe-embedding-models.py"
        "run-shared-stack-pressure-test.ps1"
    )
}
