import { execSync } from 'child_process';
import { fstatSync, type Stats } from 'node:fs';
import { createInterface } from 'node:readline/promises';

import type { SimpleGit } from 'simple-git';

import type { CommentImport } from '../types/diff.js';
import { parseCommentImportValue } from '../utils/commentImports.js';
import { effectivePreferredPort } from '../utils/ports.js';

type StdinStat = Pick<Stats, 'isFIFO' | 'isFile' | 'isSocket'>;

type StdinSource = 'pipe' | 'file' | 'socket' | 'tty';

export function detectStdinSource(stdinStat: StdinStat = fstatSync(0)): StdinSource {
  if (stdinStat.isFIFO()) {
    return 'pipe';
  }

  if (stdinStat.isFile()) {
    return 'file';
  }

  if (stdinStat.isSocket()) {
    return 'socket';
  }

  return 'tty';
}

interface ShouldReadStdinOptions {
  commitish: string;
  hasPositionalArgs: boolean;
  hasPrOption: boolean;
  stdinSource?: StdinSource;
}

export function shouldReadStdin(options: ShouldReadStdinOptions): boolean {
  if (options.commitish === '-') {
    return true;
  }

  if (options.hasPositionalArgs || options.hasPrOption) {
    return false;
  }

  const stdinSource = options.stdinSource ?? detectStdinSource();
  return stdinSource === 'pipe' || stdinSource === 'file' || stdinSource === 'socket';
}

export function getGitRoot(): string {
  try {
    const result = execSync('git rev-parse --show-toplevel', {
      encoding: 'utf8',
      stdio: 'pipe',
    });
    return result.trim();
  } catch {
    throw new Error('Not a git repository (or any of the parent directories)');
  }
}

export function validateCommitish(commitish: string): boolean {
  if (!commitish || typeof commitish !== 'string') {
    return false;
  }

  const trimmed = commitish.trim();
  if (trimmed.length === 0) {
    return false;
  }

  if (trimmed === '.' || trimmed === 'working' || trimmed === 'staged') {
    return true; // Allow special keywords for working directory and staging area diff
  }

  const baseCommitish = stripRevisionSuffix(trimmed);

  if (baseCommitish.length === 0) {
    return false;
  }

  return isValidCommitishBase(baseCommitish);
}

function isValidCommitishBase(baseCommitish: string): boolean {
  const validBasePatterns = [
    /^[a-f0-9]{4,40}$/i, // SHA hashes
    /^HEAD$/, // HEAD
    /^@$/, // @ is Git alias for HEAD
  ];

  if (validBasePatterns.some((pattern) => pattern.test(baseCommitish))) {
    return true;
  }

  // For branch, tag, and remote refs, use git's ref naming rules.
  return isValidBranchName(baseCommitish);
}

function stripRevisionSuffix(commitish: string): string {
  let suffixStart = commitish.length;

  while (suffixStart > 0) {
    const current = commitish[suffixStart - 1];

    if (current === '^') {
      suffixStart--;
      continue;
    }

    if (current === '~') {
      suffixStart--;
      continue;
    }

    if (!isAsciiDigit(current)) {
      break;
    }

    let digitStart = suffixStart - 1;
    while (digitStart > 0 && isAsciiDigit(commitish[digitStart - 1])) {
      digitStart--;
    }

    const operator = commitish[digitStart - 1];
    if (operator !== '^' && operator !== '~') {
      break;
    }

    suffixStart = digitStart - 1;
  }

  return commitish.slice(0, suffixStart);
}

function isAsciiDigit(char: string): boolean {
  return char >= '0' && char <= '9';
}

function isValidBranchName(name: string): boolean {
  // Git branch name rules
  if (name.startsWith('-')) return false; // Cannot start with dash
  if (name.endsWith('.')) return false; // Cannot end with dot
  // @ is a valid Git alias for HEAD, so we should allow it
  if (name.includes('..')) return false; // No consecutive dots
  if (name.includes('@{')) return false; // No @{ sequence
  if (name.includes('//')) return false; // No consecutive slashes
  if (name.startsWith('/') || name.endsWith('/')) return false; // No leading/trailing slashes
  if (name.endsWith('.lock')) return false; // Cannot end with .lock

  // Check for forbidden characters
  const forbiddenChars = /[~^:?*[\\\x00-\x20\x7F]/;
  if (forbiddenChars.test(name)) return false;

  // Check path components
  const components = name.split('/');
  for (const component of components) {
    if (component === '') return false; // Empty component
    if (component.startsWith('.')) return false; // Component cannot start with dot
    if (component.endsWith('.lock')) return false; // Component cannot end with .lock
  }

  return true;
}

export function shortHash(hash: string): string {
  return hash.substring(0, 7);
}

export function createCommitRangeString(baseHash: string, targetHash: string): string {
  return `${baseHash}...${targetHash}`;
}

export function parseCommentOptions(commentValues: string[]): CommentImport[] {
  return commentValues.flatMap((value) => parseCommentImportValue(value));
}

/**
 * Largest `--idle-grace <seconds>` value whose millisecond form still fits
 * `setTimeout`'s 32-bit signed delay limit (2147483647 ms). Above this,
 * Node clamps the delay to 1 ms: the idle timer fires almost immediately,
 * `ReviewLifecycle.stateAt()` correctly reports the grace period as not yet
 * elapsed, and nothing ever reschedules the timer, so the server never
 * exits — the same failure mode the `NaN` check below guards against.
 */
export const MAX_IDLE_GRACE_SECONDS = 2_147_483;

const MAX_TCP_PORT = 65_535;

/**
 * Validates a parsed `<port>` value for a `--port`/`--max-port`-shaped flag:
 * an integer within the TCP port range. `parseInt` turns a typo like
 * `--port abc` into `NaN`, which `startServer` would silently treat as
 * "not given" instead of reporting -- reject it up front instead. Shared by
 * `validatePort` and `validateMaxPort`, which both need this same check
 * before applying any rule of their own.
 */
function validatePortNumber(
  flagName: string,
  port: number | undefined,
): { valid: boolean; error?: string } {
  if (port === undefined) {
    return { valid: true };
  }

  if (!Number.isInteger(port) || port < 1 || port > MAX_TCP_PORT) {
    return { valid: false, error: `${flagName} must be an integer between 1 and ${MAX_TCP_PORT}` };
  }

  return { valid: true };
}

export function validatePort(port: number | undefined): { valid: boolean; error?: string } {
  return validatePortNumber('--port', port);
}

/**
 * Validates a parsed `--max-port <port>` value against the port the search starts
 * from. A ceiling below the starting port cannot be met by a search that only
 * counts upwards, and it renders the exhaustion message as a backwards range
 * (`No free port in range 5000-4900`).
 */
export function validateMaxPort(
  maxPort: number | undefined,
  preferredPort: number | undefined,
): { valid: boolean; error?: string } {
  const rangeCheck = validatePortNumber('--max-port', maxPort);
  if (!rangeCheck.valid || maxPort === undefined) {
    return rangeCheck;
  }

  const startPort = effectivePreferredPort(preferredPort);
  if (maxPort < startPort) {
    return {
      valid: false,
      error: `--max-port (${maxPort}) must not be below --port (${startPort})`,
    };
  }

  return { valid: true };
}

/**
 * Validates a parsed `<seconds>` value for a `--idle-grace`/`--timeout`-shaped
 * flag: a non-negative integer, capped at `maxSeconds`.
 *
 * `parseInt` turns a typo like `--idle-grace abc` or `--timeout abc` into
 * `NaN`. Left unvalidated, that `NaN` reaches either a `>=` comparison in
 * `ReviewLifecycle` (always `false`, so the review can never be reported
 * terminal and the server never exits) or `setTimeout(fn, NaN)` (fires on
 * the very next tick, so the review would be declared finished at once --
 * indistinguishable from one that actually ran out of time). `maxSeconds` is
 * the other half of the same concern: both flags multiply their value by
 * 1000 for `setTimeout`, and above `MAX_IDLE_GRACE_SECONDS` /
 * `MAX_TIMEOUT_SECONDS` that product overflows `setTimeout`'s 32-bit signed
 * delay limit (2147483647 ms), so Node clamps the delay to 1 ms instead of
 * throwing -- the same "fires almost immediately" failure as the `NaN` case.
 * Reject both before they get that far.
 */
function validateDurationSeconds(
  flagName: string,
  value: number | undefined,
  maxSeconds: number,
): { valid: boolean; error?: string } {
  if (value !== undefined && (!Number.isInteger(value) || value < 0)) {
    return { valid: false, error: `${flagName} must be a non-negative integer` };
  }

  if (value !== undefined && value > maxSeconds) {
    return { valid: false, error: `${flagName} must be at most ${maxSeconds} seconds` };
  }

  return { valid: true };
}

export function validateIdleGraceSeconds(value: number | undefined): {
  valid: boolean;
  error?: string;
} {
  return validateDurationSeconds('--idle-grace', value, MAX_IDLE_GRACE_SECONDS);
}

/** The lifecycle half of `startServer`'s options, as the review flags describe it. */
export interface ReviewLifecycleOptions {
  backgroundReview: boolean;
  idleGraceMs?: number;
  reviewTimeoutMs?: number;
  cleanupGraceMs?: number;
}

/**
 * Translate the review's duration flags into server options.
 *
 * Kept out of the command action so it can be exercised directly: the action itself cannot be
 * imported, because `index.ts` exports nothing and parses at module scope, and a test that
 * re-declares an equivalent command proves only that the test agrees with itself.
 *
 * An absent flag is omitted rather than passed as undefined, so the server's own defaults apply.
 */
export function reviewLifecycleOptions(flags: {
  background: boolean;
  idleGrace?: number;
  timeout?: number;
  cleanupGrace?: number;
}): ReviewLifecycleOptions {
  return {
    backgroundReview: flags.background,
    ...(flags.idleGrace === undefined ? {} : { idleGraceMs: flags.idleGrace * 1000 }),
    ...(flags.timeout === undefined ? {} : { reviewTimeoutMs: flags.timeout * 1000 }),
    ...(flags.cleanupGrace === undefined ? {} : { cleanupGraceMs: flags.cleanupGrace * 1000 }),
  };
}

/**
 * Largest `--cleanup-grace <seconds>` value whose millisecond form still fits `setTimeout`'s
 * 32-bit signed delay limit -- see `validateDurationSeconds` for what happens above it.
 */
export const MAX_CLEANUP_GRACE_SECONDS = 2_147_483;

export function validateCleanupGraceSeconds(value: number | undefined): {
  valid: boolean;
  error?: string;
} {
  return validateDurationSeconds('--cleanup-grace', value, MAX_CLEANUP_GRACE_SECONDS);
}

/**
 * Largest `--timeout <seconds>` value whose millisecond form still fits `setTimeout`'s 32-bit
 * signed delay limit. The same number as its siblings, kept separate because each documents its
 * own flag's cap.
 */
export const MAX_TIMEOUT_SECONDS = 2_147_483;

export function validateTimeoutSeconds(value: number | undefined): {
  valid: boolean;
  error?: string;
} {
  return validateDurationSeconds('--timeout', value, MAX_TIMEOUT_SECONDS);
}

export function validateDiffArguments(
  targetCommitish: string,
  baseCommitish?: string,
): { valid: boolean; error?: string } {
  // Validate target commitish format
  if (!validateCommitish(targetCommitish)) {
    return { valid: false, error: 'Invalid target commit-ish format' };
  }

  // Validate base commitish format if provided
  if (baseCommitish !== undefined && !validateCommitish(baseCommitish)) {
    return { valid: false, error: 'Invalid base commit-ish format' };
  }

  // Special arguments are only allowed in target, not base (except staged with working)
  const specialArgs = ['working', 'staged', '.'];
  if (baseCommitish && specialArgs.includes(baseCommitish)) {
    // Allow 'staged' as base only when target is 'working'
    if (baseCommitish === 'staged' && targetCommitish === 'working') {
      // This is valid: working vs staged
    } else {
      return {
        valid: false,
        error: `Special arguments (working, staged, .) are only allowed as target, not base. Got base: ${baseCommitish}`,
      };
    }
  }

  // Cannot compare same values
  if (targetCommitish === baseCommitish) {
    return {
      valid: false,
      error: `Cannot compare ${targetCommitish} with itself`,
    };
  }

  // "working" shows unstaged changes and can only be compared with staging area
  if (targetCommitish === 'working' && baseCommitish && baseCommitish !== 'staged') {
    return {
      valid: false,
      error:
        '"working" shows unstaged changes and cannot be compared with another commit. Use "." instead to compare all uncommitted changes with a specific commit.',
    };
  }

  return { valid: true };
}

export async function findUntrackedFiles(git: SimpleGit): Promise<string[]> {
  const status = await git.status();
  return status.not_added;
}

// Add files with --intent-to-add to make them visible in `git diff` without staging content
export async function markFilesIntentToAdd(git: SimpleGit, files: string[]): Promise<void> {
  await git.add(['--intent-to-add', ...files]);
}

export async function promptUser(message: string): Promise<boolean> {
  const rl = createInterface({
    input: process.stdin,
    output: process.stdout,
  });

  const answer = await rl.question(message);
  rl.close();

  // Empty string (Enter) or 'y', 'yes' return true
  const trimmed = answer.trim().toLowerCase();
  return trimmed === '' || ['y', 'yes'].includes(trimmed);
}

export async function readStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) {
    chunks.push(chunk as Buffer);
  }
  return Buffer.concat(chunks).toString('utf8');
}
