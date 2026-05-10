
export function resolveStoreRoot() { return process.env.AI_MEMORY_ROOT || "E:/desktop/.ai-memory"; }
export function getDefaultStoreCandidates() { return [process.env.AI_MEMORY_ROOT || "E:/desktop/.ai-memory"]; }
export default { resolveStoreRoot, getDefaultStoreCandidates };
