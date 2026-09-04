export type Logger = {
  debug?(...args: unknown[]): void;
  warn?(...args: unknown[]): void;
  error?(...args: unknown[]): void;
};

// No TokenProvider here, deliberately. Unlike a minted JWT, the CloudKit
// management token does not expire on a timer and cannot be reminted — a 401
// means the token is wrong or revoked, not stale — so an indirection whose only
// job is refreshing would be ceremony over a value that is just... a string.
