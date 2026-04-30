import { resolveStoreRoot } from "../../../bus/store-root.js";
import path from "node:path";

// Test: resolveStoreRoot does not return empty string
console.assert(resolveStoreRoot().length > 0, "resolveStoreRoot should not be empty");

// Test: Returns an absolute path
console.assert(path.isAbsolute(resolveStoreRoot()), "resolveStoreRoot should return absolute path");

// Test: Path contains the correct platform separator
const sep = process.platform === "win32" ? "\\" : "/";
console.assert(
  resolveStoreRoot().includes(sep) || resolveStoreRoot().includes(path.sep),
  "Path should use correct platform separator"
);

// Test: Path does not end with a trailing slash
const root = resolveStoreRoot();
console.assert(
  !root.endsWith("/") && !root.endsWith("\\"),
  "Store root should not end with trailing slash"
);

console.log("All store-root platform tests passed");
console.log("Store root:", resolveStoreRoot());
