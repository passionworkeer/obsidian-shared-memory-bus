// bus/time-constants.js
// Single source of truth for common duration constants expressed in
// milliseconds. Inline duplicates (e.g. `24 * 60 * 60 * 1000`,
// `7 * 24 * 60 * 60 * 1000`) used to drift across the freshness,
// archival, and promotion modules. Centralizing keeps "hot = 24h"
// and "warm = 7d" boundary semantics consistent.

export const MS_PER_SECOND = 1000;
export const MS_PER_MINUTE = 60 * MS_PER_SECOND;
export const MS_PER_HOUR   = 60 * MS_PER_MINUTE;
export const MS_PER_DAY    = 24 * MS_PER_HOUR;
export const MS_PER_WEEK   = 7 * MS_PER_DAY;
