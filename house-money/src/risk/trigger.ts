export type TriggerInput = {
  /** Current portfolio value, micro-USD. */
  equity: bigint;
  /** Original stake, micro-USD. */
  principal: bigint;
  /** Already banked (persisted by the runner). */
  banked: boolean;
  /** Gains-to-principal ratio needed: 2 means equity >= 2x principal (gains == principal). */
  multiple?: bigint;
  /**
   * The same ratio in basis points (20_000 = 2x), for fractional multiples such as 1.02x. Takes precedence
   * over `multiple`. A live run on mainnet cannot simulate gains, so it lowers the trigger to see the exit happen.
   */
  multipleBps?: bigint;
};

/** Bank the principal once gains cover it: equity >= principal * multiple, and never twice. */
export function shouldBankPrincipal({ equity, principal, banked, multiple = 2n, multipleBps }: TriggerInput): boolean {
  if (banked || principal <= 0n) return false;
  return equity * 10_000n >= principal * (multipleBps ?? multiple * 10_000n);
}

/** Fixed per-agent key: a second day cannot produce a second principal exit. */
export function principalKey(agentId: string): string {
  return `principal:${agentId}`;
}
