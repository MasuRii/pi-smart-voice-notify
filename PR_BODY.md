## Summary

- **Fix SSRF bypass**: `isPrivateOrReservedIPv6()` only detected IPv4-mapped IPv6 addresses in dotted-decimal form (`::ffff:127.0.0.1`). Node.js's URL parser normalizes these to hex form (`::ffff:7f00:1`), bypassing the private address check. This allowed webhook URLs like `https://[::ffff:127.0.0.1]/webhook` to reach internal services.
- **Add 50 webhook tests**: Comprehensive test coverage for retry/backoff, rate limiting, queue overflow, Discord/generic payload building, event filtering, config updates, and URL validation edge cases.

## Type of Change

- [x] Bug fix (security: SSRF bypass)
- [x] Test coverage improvement

## Test Results

```
tests 89 (39 existing + 50 new)
pass 89
fail 0
```

`tsc --noEmit` passes with no errors.

## Files Changed

- `src/webhook.ts` — Fix `isPrivateOrReservedIPv6()` to handle hex-form IPv4-mapped addresses
- `test/webhook-coverage.test.ts` — New file: 50 tests
- `package.json` — Register new test file in test script
