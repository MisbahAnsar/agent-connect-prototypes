/** Shared fake "Base chain": what Agent Connect delivered to which deposit address. */
export class FakeBase {
  readonly deliveries = new Map<string, { amount: bigint; txHash: string }>();
  private n = 0;

  deliver(to: string, amount: bigint): string {
    const txHash = `0x${(++this.n).toString(16).padStart(64, "a")}`;
    const prev = this.deliveries.get(to.toLowerCase());
    this.deliveries.set(to.toLowerCase(), { amount: (prev?.amount ?? 0n) + amount, txHash });
    return txHash;
  }

  delivered(to: string): bigint {
    return this.deliveries.get(to.toLowerCase())?.amount ?? 0n;
  }
}

export type Handler = (req: Request) => Promise<Response>;

/** One fetch for every fake host: routes by URL origin. */
export function routerFetch(hosts: Record<string, Handler>, calls: string[] = []): typeof fetch {
  return (async (input: string | URL | Request, init?: RequestInit) => {
    const req = new Request(input, init);
    const origin = new URL(req.url).origin;
    calls.push(`${req.method} ${req.url}`);
    const h = hosts[origin];
    if (!h) throw new Error(`fake fetch: no host for ${origin}`);
    return h(req);
  }) as typeof fetch;
}

export const json = (status: number, body: unknown, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", ...headers } });
