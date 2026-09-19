import { describe, expect, it } from 'vitest';
import { LoginThrottle } from './login-throttle.js';

const options = { maxFailures: 3, windowS: 600, lockS: 900, maxGlobalPerMinute: 10 };

describe('LoginThrottle', () => {
  it('locks a username after too many failures within the window', () => {
    const throttle = new LoginThrottle(options);
    for (let i = 0; i < 2; i++) throttle.recordFailure('alice', 1000 + i);
    expect(throttle.check('alice', 1002)).toEqual({ allowed: true });
    throttle.recordFailure('alice', 1002);
    expect(throttle.check('alice', 1003)).toEqual({ allowed: false, retryAfterS: 899 });
    expect(throttle.check('bob', 1003)).toEqual({ allowed: true });
    expect(throttle.check('alice', 1002 + 900)).toEqual({ allowed: true });
  });

  it('forgets failures outside the window', () => {
    const throttle = new LoginThrottle(options);
    throttle.recordFailure('alice', 0);
    throttle.recordFailure('alice', 1);
    throttle.recordFailure('alice', 700); // the first two are older than 600 s
    expect(throttle.check('alice', 701)).toEqual({ allowed: true });
  });

  it('resets after a successful login', () => {
    const throttle = new LoginThrottle(options);
    throttle.recordFailure('alice', 0);
    throttle.recordFailure('alice', 1);
    throttle.recordSuccess('alice');
    throttle.recordFailure('alice', 2);
    expect(throttle.check('alice', 3)).toEqual({ allowed: true });
  });

  it('limits failures across all usernames per minute', () => {
    const throttle = new LoginThrottle(options);
    for (let i = 0; i < 10; i++) throttle.recordFailure(`user${String(i)}`, 100);
    expect(throttle.check('someone-else', 110)).toEqual({ allowed: false, retryAfterS: 50 });
    expect(throttle.check('someone-else', 161)).toEqual({ allowed: true });
  });
});
