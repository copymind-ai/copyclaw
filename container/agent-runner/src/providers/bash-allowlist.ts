/**
 * Bash command allowlist for host-runtime agents (e.g. DevOps).
 *
 * The host runtime hands the agent a real shell on the machine that runs
 * nanoclaw, so this gate is the thing standing between it and the host. It is
 * deliberately strict and operates in two layers:
 *
 *   1. Reject any command containing shell-compound / metacharacters — chaining
 *      (`;`, `&&`, `||`), piping (`|`), redirection (`>`, `<`), command
 *      substitution (`` ` ``, `$(`), backgrounding (`&`), or newlines. This
 *      prevents an allowed prefix from smuggling a second, unvetted command
 *      (`dev wt up x; rm -rf /`).
 *   2. Allow only a command whose full text matches one allowed glob pattern,
 *      where `*` matches any run of characters (`dev *`, `git fetch*`).
 *
 * Gating is OFF by default — when `enabled` is false every command passes, so
 * Docker-runtime agents (which rely on container isolation) are unaffected.
 */

// Metacharacters that let a single vetted prefix do more than the one command
// it was matched against, or reach the filesystem/process table invisibly.
const FORBIDDEN = /[;&|<>`\n\r]|\$\(/;

export interface BashCheck {
  allowed: boolean;
  reason?: string;
}

/** Turn an allowlist glob (`*` = any chars) into an anchored RegExp. */
function patternToRegExp(pattern: string): RegExp {
  const escaped = pattern.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/\\\*/g, '.*');
  return new RegExp(`^${escaped}$`);
}

/**
 * Decide whether a Bash command may run. `enabled=false` short-circuits to
 * allowed (no gating). Otherwise the command must pass the metacharacter
 * screen AND match one allowed pattern.
 */
export function checkBashCommand(command: string, enabled: boolean, patterns: string[]): BashCheck {
  if (!enabled) return { allowed: true };

  const cmd = command.trim();
  if (!cmd) return { allowed: false, reason: 'empty command' };

  if (FORBIDDEN.test(cmd)) {
    return {
      allowed: false,
      reason:
        'command chaining, piping, redirection, substitution, and backgrounding are not permitted on this agent — run one simple command at a time',
    };
  }

  for (const p of patterns) {
    if (patternToRegExp(p).test(cmd)) return { allowed: true };
  }

  return {
    allowed: false,
    reason: `command is not on this agent's Bash allowlist. Allowed patterns: ${patterns.join(', ') || '(none)'}`,
  };
}
