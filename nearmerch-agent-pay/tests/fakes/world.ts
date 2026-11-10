import { AgentConnectMcp } from "../../src/agent-connect";
import { configFromEnv, type Config } from "../../src/config";
import { NearmerchClient } from "../../src/nearmerch";
import { AC_KEY, FakeAgentConnect, MCP, type AgentConnectScenario } from "./fake-agent-connect";
import { FakeNearmerch, STORE, type StoreOptions } from "./fake-nearmerch";
import { FakePing, type PingScenario } from "./fake-ping";
import { throwawayNearKey } from "./keys";
import { FakeBase, routerFetch } from "./ledger";

export const REFUND = "0x2222222222222222222222222222222222222222";

/** Everything wired offline: fake store → fake Ping, fake Agent Connect → fake Base. */
export function world(opts: { ping?: PingScenario; ac?: AgentConnectScenario; store?: StoreOptions; env?: Record<string, string> } = {}) {
  const base = new FakeBase();
  const ping = new FakePing(base, opts.ping);
  const store = new FakeNearmerch(ping, opts.store);
  const ac = new FakeAgentConnect(base, opts.ac);
  const calls: string[] = [];
  const fetchImpl = routerFetch({ [STORE]: store.handle, [MCP]: ac.handle }, calls);
  const key = throwawayNearKey();
  const cfg: Config = configFromEnv({
    NEARMERCH_URL: STORE,
    AGENT_CONNECT_MCP_URL: MCP,
    AGENT_CONNECT_KEY: AC_KEY,
    NEAR_ACCOUNT_ID: "buyer.near",
    NEAR_PRIVATE_KEY: key.secret,
    REFUND_ADDRESS: REFUND,
    PRODUCT_QUERY: "t-shirt",
    SHIP_FIRST_NAME: "Ada",
    SHIP_LAST_NAME: "Lovelace",
    SHIP_EMAIL: "ada@example.com",
    SHIP_LINE1: "123 Main St",
    SHIP_CITY: "Los Angeles",
    SHIP_STATE: "CA",
    SHIP_POSTCODE: "90001",
    SHIP_COUNTRY: "US",
    MAX_USDC: "40",
    ...opts.env,
  });
  const merchant = new NearmerchClient({ baseUrl: STORE, fetchImpl });
  const mcp = new AgentConnectMcp({ url: MCP, bearer: AC_KEY, fetchImpl });
  const noSleep = async () => {};
  return { base, ping, store, ac, calls, fetchImpl, key, cfg, merchant, mcp, noSleep };
}
