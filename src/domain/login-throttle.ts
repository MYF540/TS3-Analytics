/**
 * Throttles failed logins (pure, in memory). Per username: after `maxFailures` failures within
 * `windowS`, further attempts are refused for `lockS`. Globally: at most `maxGlobalPerMinute`
 * failures per minute across all usernames (guards against spraying many names).
 * Per-IP limits are pointless here: the web interface is only reachable via 127.0.0.1.
 */

export interface ThrottleOptions {
  maxFailures: number;
  windowS: number;
  lockS: number;
  maxGlobalPerMinute: number;
}

export const DEFAULT_THROTTLE: ThrottleOptions = {
  maxFailures: 5,
  windowS: 15 * 60,
  lockS: 15 * 60,
  maxGlobalPerMinute: 30,
};

export type ThrottleDecision = { allowed: true } | { allowed: false; retryAfterS: number };

export class LoginThrottle {
  private readonly failures = new Map<string, number[]>();
  private readonly lockedUntil = new Map<string, number>();
  private globalFailures: number[] = [];

  constructor(private readonly options: ThrottleOptions = DEFAULT_THROTTLE) {}

  check(username: string, now: number): ThrottleDecision {
    const locked = this.lockedUntil.get(username);
    if (locked !== undefined && locked > now) return { allowed: false, retryAfterS: locked - now };
    this.globalFailures = this.globalFailures.filter((t) => t > now - 60);
    if (this.globalFailures.length >= this.options.maxGlobalPerMinute) {
      const oldest = this.globalFailures[0] ?? now;
      return { allowed: false, retryAfterS: Math.max(1, oldest + 60 - now) };
    }
    return { allowed: true };
  }

  recordFailure(username: string, now: number): void {
    this.globalFailures.push(now);
    const recent = (this.failures.get(username) ?? []).filter(
      (t) => t > now - this.options.windowS,
    );
    recent.push(now);
    if (recent.length >= this.options.maxFailures) {
      this.lockedUntil.set(username, now + this.options.lockS);
      this.failures.delete(username);
    } else {
      this.failures.set(username, recent);
    }
  }

  recordSuccess(username: string): void {
    this.failures.delete(username);
    this.lockedUntil.delete(username);
  }
}
