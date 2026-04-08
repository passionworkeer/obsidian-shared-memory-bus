// Shared memory bus type definitions

declare module 'bus/python-runtime' {
  export interface PythonRuntime {
    command: string;
    argsPrefix: string[];
    source: string;
    available: boolean;
    version: string;
    error: string;
  }
  export function resolvePythonRuntime(): PythonRuntime;
  export function withPythonArgs(runtime: PythonRuntime, args: string[]): string[];
}

declare module 'bus/embedding-provider-registry' {
  export interface EmbeddingResult {
    backendName: string;
    modelName: string;
    vectors: number[][];
    providerHost: string;
  }
  export interface EmbeddingRuntime {
    model: string;
    baseUrl?: string;
    apiKey?: string;
    timeoutMs?: number;
    requestDelayMs?: number;
    maxRetries?: number;
  }
  export function createEmbeddingProviderRegistry(options: {
    pythonRuntime: import('bus/python-runtime').PythonRuntime;
    withPythonArgs?: Function;
    fetchImpl?: typeof fetch;
    sleep?: () => Promise<void>;
    buildHashEmbedding?: (text: string) => number[];
    hashModel?: string;
  }): {
    get(name?: string): {
      name: string;
      defaultModel: string;
      defaultBatchSize(): number;
      embedBatch(opts: { texts: string[]; runtime?: EmbeddingRuntime }): Promise<EmbeddingResult>;
    };
    list(): string[];
  };
  export function buildEmbeddingConfigHash(opts: { backend: string; modelName: string; baseUrl?: string }): string;
  export function normalizeEmbeddingAdapter(value: string, fallback?: string): string;
}

declare module 'ops/memory-contract' {
  export interface MemoryRecord {
    id: string;
    type: string;
    content: string;
    source: string;
    timestamp: string;
    metadata?: Record<string, unknown>;
  }
  export interface ContractValidationResult {
    valid: boolean;
    errors: string[];
    warnings: string[];
  }
  export function validateMemoryRecord(record: unknown): ContractValidationResult;
  export function validateStructuredMemory(dir: string): ContractValidationResult;
}

declare module 'bus/vault-root' {
  export function resolveVaultRoot(): string;
}
