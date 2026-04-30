
export function resolveStoreRoot() {
  return process.env.AI_MEMORY_STORE ||
    process.env.AI_MEMORY_STORE_ROOT ||
    "E:/desktop/.ai-memory";
}
export default { resolveStoreRoot };
