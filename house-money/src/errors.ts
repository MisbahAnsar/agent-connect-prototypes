/** Mirrors the stable `code` field of the real SDK's AgentApiError. */
export class AgentApiError extends Error {
  constructor(
    public readonly code: string,
    message?: string,
    public readonly status = 403,
  ) {
    super(message ?? code);
    this.name = "AgentApiError";
  }
}

export class PriceUnavailableError extends Error {
  readonly code = "spend_price_unavailable";
  constructor(public readonly assetId: string, reason: "missing" | "stale") {
    super(`price ${reason} for ${assetId}`);
    this.name = "PriceUnavailableError";
  }
}
