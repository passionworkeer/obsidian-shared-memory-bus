@{
    FlatRuntimeFiles = @{
        bus = @(
            "embedding-provider-registry.js"
            "generate-embeddings.js"
            "memory-bus.ps1"
            "memory-watchdog.ps1"
            "python-runtime.js"
            "register-agent.ps1"
            "runtime-platform.ps1"
            "runtime-config.js"
            "vault-root.js"
        )
        ops = @(
            "build-handoff-pack.js"
            "build-memory-layers.js"
            "check-memory-integrity.js"
            "cleanup-inbox.ps1"
            "install-client-integrations.ps1"
            "memory-contract.js"
            "obsidian-blackboard-daemon.js"
            "refresh-generated-artifacts.js"
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
            "embedding_providers.py"
            "probe-models.py"
            "runtime_support.py"
            "semantic-search-cli.js"
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
        "start-default-shared-mcp.sh"
        "start-shared-mcp.ps1"
        "start-shared-mcp.sh"
        "status-shared-mcp.ps1"
        "status-shared-mcp.sh"
        "stop-shared-mcp.ps1"
        "stop-shared-mcp.sh"
        "write-config-snippets.ps1"
    )
    TemplateFiles = @(
        "agents.json"
        "config/runtime.json"
    )
    LegacyCleanupFiles = @(
        "benchmark-embedding-backends.py"
        "export-bundle.ps1"
        "probe-embedding-models.py"
        "run-shared-stack-pressure-test.ps1"
    )
}
