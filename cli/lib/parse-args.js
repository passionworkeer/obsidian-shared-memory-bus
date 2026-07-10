/**
 * Argument parsing for the ai-memory CLI.
 *
 * Splits a raw argv tail into a flat list of flags (preserving order) and
 * a list of positional arguments. Supports both `--flag value` and
 * `--flag=value` forms, and recognises a small set of value-bearing flags
 * (currently only `--workspace`).
 *
 * @param {string[]} raw
 * @returns {{ flags: string[], positional: string[] }}
 */
export function parseArgs(raw) {
  const flags = [];
  const positional = [];
  const valueFlags = new Set(["--workspace"]);

  for (let index = 0; index < raw.length; index += 1) {
    const arg = raw[index];
    if (!arg.startsWith("--")) {
      positional.push(arg);
      continue;
    }

    const equalsIndex = arg.indexOf("=");
    if (equalsIndex > 0) {
      flags.push(arg.slice(0, equalsIndex));
      flags.push(arg.slice(equalsIndex + 1));
      continue;
    }

    flags.push(arg);
    if (valueFlags.has(arg) && index + 1 < raw.length && !raw[index + 1].startsWith("-")) {
      flags.push(raw[index + 1]);
      index += 1;
    }
  }

  return { flags, positional };
}
