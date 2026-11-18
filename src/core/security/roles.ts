/** SPEC-014: API roles, ordered by privilege. */
export const ROLES = ['viewer', 'operator', 'admin'] as const;
export type Role = (typeof ROLES)[number];

export function isRole(v: unknown): v is Role { return (ROLES as readonly unknown[]).includes(v); }

/** True when `role` has at least the privileges of `min`. */
export function roleAtLeast(role: Role, min: Role): boolean { return ROLES.indexOf(role) >= ROLES.indexOf(min); }

/** Job options an operator may set freely (run-time knobs); every other option is a setting and needs admin to change. */
export const OPERATOR_JOB_OPTIONS: ReadonlySet<string> = new Set([
  'screenshots', 'fullPage', 'headless', 'healAttempts', 'include', 'exclude', 'testTimeoutMs', 'timeoutMs', 'auth', 'authUser',
  // SPEC-011/012 run-time knobs (which browsers/devices/environment/tests, parallelism, retries, artifacts). Report paths stay admin.
  'browsers', 'devices', 'workers', 'shard', 'env', 'grep', 'tag', 'globalTimeoutMs', 'trace', 'video', 'retries',
]);

export const OPERATOR_ACTIONS: ReadonlySet<string> = new Set(['run', 'heal']);
