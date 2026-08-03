@{
    InstallFileGraph = "install-files.json"
    TemplateFiles = @(
        "config/runtime.json"
    )
    LegacyCleanupFiles = @(
        "benchmark-embedding-backends.py"
        "export-bundle.ps1"
        "ops/daemon/obsidian-blackboard-daemon.js"
        "ops/generate/refresh-generated-artifacts.js"
        "ops/run/run-obsidian-mcp.ps1"
        "ops/sync/sync-claudemem-to-obsidian.ps1"
        "ops/sync/sync-openclaw-to-obsidian.js"
        "probe-embedding-models.py"
        "run-shared-stack-pressure-test.ps1"
    )
    LegacyCleanupDirectories = @(
        "bundle-template"
        "dist"
        "mcp-shared"
        "startup"
    )
}
