
import os from "node:os";
import path from "node:path";

export function resolveStoreRoot() {
  return process.env.AI_MEMORY_STORE ||
    process.env.AI_MEMORY_STORE_ROOT ||
    path.join(os.homedir(), ".ai-memory");
}
export default { resolveStoreRoot };
