
import path from "node:path";
import os from "node:os";
export function resolveStoreRoot() {
  return (
    process.env.AI_MEMORY_STORE ||
    process.env.AI_MEMORY_STORE_ROOT ||
    process.env.AI_MEMORY_ROOT ||
    path.join(os.homedir(), ".ai-memory")
  );
}
export function getProjectsRoot(storeRoot) {
  return path.join(storeRoot, "projects");
}
export function getContextPath(storeRoot) {
  return path.join(storeRoot, "CONTEXT.md");
}
export function getDefaultStoreCandidates() {
  return [path.join(os.homedir(), ".ai-memory")];
}
export default { resolveStoreRoot, getProjectsRoot, getContextPath, getDefaultStoreCandidates };
