/**
 * Returns `value` when it is present and fails the test otherwise, naming the reason the test
 * expected it. Use this instead of a non-null assertion so a broken fixture or an unexpected
 * empty result reports what was assumed rather than a TypeError deeper in the test.
 */
export function must<T>(value: T, why: string): NonNullable<T> {
  if (value === undefined || value === null) {
    throw new Error(`Expected a value: ${why}`);
  }
  return value;
}
