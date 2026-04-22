@{
    FlatRuntimeFiles = @{
        bus = @(
            "embedding-provider-registry.js"
            "generate-embeddings.js"
            "lsh-hash.js"
            "memory-bus.ps1"
            "memory-bus-agents.ps1"
            "memory-bus-helpers.ps1"
            "memory-bus-sync.ps1"
            "memory-watchdog.ps1"
            "memory-watchdog-supervisor.ps1"
            "python-runtime.js"
            "register-agent.ps1"
            "runtime-platform.ps1"
            "runtime-config.js"
            "vault-root.js"
        )
        "ops/build" = @(
            "build-handoff-pack.js"
            "build-memory-layers.js"
        )
        "ops/check" = @(
            "check-memory-integrity.js"
            "check-vbs.js"
        )
        "ops/cleanup" = @(
            "cleanup-inbox.ps1"
        )
        "ops/daemon" = @(
            "obsidian-blackboard-daemon.js"
        )
        "ops/entity" = @(
            "entity-backfill.js"
            "entity-extractor.js"
        )
        "ops/generate" = @(
            "generate-context.js"
            "generate-memory-hygiene-report.js"
            "refresh-generated-artifacts.js"
        )
        "ops/inbox" = @(
            "inbox-atomic-write.js"
        )
        "ops/knowledge" = @(
            "knowledge-graph.js"
        )
        "ops/mcp" = @(
            "mcp-memory-tools.js"
            "mcp-memory-tools-handler.js"
        )
        "ops/memory" = @(
            "memory-archival.js"
            "memory-contract.js"
            "memory-layers-context.js"
            "memory-layers-dedup.js"
            "memory-layers-parse.js"
        )
        "ops/redact" = @(
            "redaction.py"
        )
        "ops/run" = @(
            "run-memory-dream.ps1"
            "run-minimax-mcp.ps1"
            "run-obsidian-mcp.ps1"
            "run-pressure-test.ps1"
        )
        "ops/setup" = @(
            "install-client-integrations.ps1"
            "migrate-to-store.js"
            "setup-wizard.ps1"
        )
        "ops/stress" = @(
            "stress-test-concurrent.js"
        )
        "ops/sync" = @(
            "sync-claudemem-to-obsidian.ps1"
            "sync-openclaw-to-obsidian.js"
            "sync-shared-skills.ps1"
        )
        "ops/util" = @(
            "jsonl-stream.js"
        )
        "ops/verify" = @(
            "verify-atomic-write.js"
            "verify-client-integrations.ps1"
            "verify-integrations.ps1"
        )
        retrieval = @(
            "benchmark-architecture.py"
            "benchmark-backends.py"
            "embedding_providers.py"
            "eval-routing.py"
            "lsh_utils.py"
            "platform.py"
            "probe-models.py"
            "runtime_support.py"
            "schema_validation.py"
            "search_cache.py"
            "search_index.py"
            "search_ranking.py"
            "search_server.py"
            "streaming_index.py"
            "semantic-search-cli.js"
            "semantic-search-cli.test.js"
            "semantic-search.js"
            "semantic_search.py"
        )
    }
    SharedMcpFiles = @(
        "manifest.json"
        "memory-bridge.js"
        "memory-embeddings.js"
        "memory-generation.js"
        "memory-retrieval.js"
        "memory-status.js"
        "memory-tools.js"
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
        "config/runtime.json"
    )
    LegacyCleanupFiles = @(
        "benchmark-embedding-backends.py"
        "export-bundle.ps1"
        "probe-embedding-models.py"
        "run-shared-stack-pressure-test.ps1"
    )
    LegacyCleanupDirectories = @(
        "bundle-template"
        "dist"
        "mcp-shared"
        "startup"
    )
    CliFiles = @(
        "cli/ai-memory.js"
        "cli/package.json"
    )
}
