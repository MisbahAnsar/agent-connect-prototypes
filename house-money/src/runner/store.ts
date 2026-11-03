export type RunnerState = {
  /**
   * Latched the first time equity reaches the trigger. From then on the principal is owed to the safe
   * account even if equity dips again (a timelocked swap that raises the cash can take minutes to fill).
   */
  triggered?: boolean;
  /** True once the principal withdrawal was accepted by the API. Never reset. */
  banked: boolean;
  withdrawalId?: string;
  bankedAt?: string;
  /** True once the withdrawal's settlement event was emitted. */
  settledReported?: boolean;
  /** True once the exit actually settled (not failed or cancelled). */
  exitSettled?: boolean;
  /** True once the post-bank policy update removed `withdraw`. */
  sealed?: boolean;
};

export interface StateStore {
  load(): Promise<RunnerState>;
  save(state: RunnerState): Promise<void>;
}

export class MemoryStateStore implements StateStore {
  constructor(private state: RunnerState = { banked: false }) {}
  async load() {
    return { ...this.state };
  }
  async save(state: RunnerState) {
    this.state = { ...state };
  }
}
