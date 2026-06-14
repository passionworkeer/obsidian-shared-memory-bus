/**
 * Exit helper utilities.
 *
 * The CLI's main() function calls process.exit() once it has a result.
 * These helpers centralise the two patterns we use: printing a version
 * and printing the help text.
 */

export function exitWithCode(code) {
  process.exit(code);
}

export function exitWithError(message, code = 1) {
  process.stderr.write(`${message}\n`);
  process.exit(code);
}
