export type ReviewStatus = 'waiting' | 'reviewing' | 'idle';

export interface ReviewLifecycleState {
  status: ReviewStatus;
  terminal: boolean;
  clients: number;
  /** Times the review became unattended (the client count fell to zero). */
  disconnects: number;
  idleSince: Date | null;
}

/**
 * Decides whether a review is still being looked at, from browser presence alone.
 *
 * Pure and clock-injected on purpose: `stateAt` never reads the wall clock, so the
 * grace period can be tested without sleeping. Scheduling lives in the caller.
 */
export class ReviewLifecycle {
  private clientCount = 0;
  private disconnectCount = 0;
  private hasEverConnected = false;
  private idleSinceValue: Date | null = null;

  constructor(private readonly graceMs: number) {}

  onConnect(_now: Date): void {
    this.clientCount += 1;
    this.hasEverConnected = true;
    this.idleSinceValue = null;
  }

  onDisconnect(now: Date): void {
    if (this.clientCount === 0) {
      return;
    }

    this.clientCount -= 1;

    if (this.clientCount === 0) {
      this.disconnectCount += 1;
      this.idleSinceValue = now;
    }
  }

  stateAt(now: Date): ReviewLifecycleState {
    // One call, one status: `terminal` must describe the status being reported,
    // not a second evaluation that could in principle disagree.
    const status = this.statusAt(now);

    return {
      status,
      terminal: status === 'idle',
      clients: this.clientCount,
      disconnects: this.disconnectCount,
      idleSince: this.idleSinceValue,
    };
  }

  private statusAt(now: Date): ReviewStatus {
    if (!this.hasEverConnected) {
      return 'waiting';
    }

    const idleSince = this.idleSinceValue;
    if (idleSince === null) {
      return 'reviewing';
    }

    return now.getTime() - idleSince.getTime() >= this.graceMs ? 'idle' : 'reviewing';
  }
}
