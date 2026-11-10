/**
 * Read-only check. Creates no order, signs nothing, moves no funds.
 *
 *   npm run check                 # store catalog + pay route + Ping discovery (+ MCP preflight if AGENT_CONNECT_KEY)
 *   npm run check -- <orderId>    # also decode the 402 of an existing payment_pending x402 order
 *
 * Without an orderId the pay route is probed with a zero UUID: 403 order_not_found means the
 * x402 route is mounted. The full accepts list needs a real order (only `pay --confirm` creates one).
 */
import { AgentConnectMcp, availableBalance, resolveAccount } from "../src/agent-connect";
import { BASE_NETWORK, BASE_USDC, configFromEnv, formatUsdc, loadDotEnv, missingShipping } from "../src/config";
import { NearmerchClient, pickItem } from "../src/nearmerch";
import { getSupported } from "../src/ping-x402";
import { isNearIntents } from "../src/x402";

loadDotEnv();
const cfg = configFromEnv();
const orderId = process.argv[2];
const merchant = new NearmerchClient({ baseUrl: cfg.nearmerchUrl });
const section = (t: string) => console.log(`\n== ${t}`);

console.log(`nearmerch   ${cfg.nearmerchUrl}\nping        ${cfg.pingUrl}\nmcp         ${cfg.mcpUrl}`);

section("store");
const site = await merchant.siteConfig().catch((e: Error) => ({ error: e.message }));
console.log(`site-config ${JSON.stringify(site)}`);
const products = await merchant.listProducts();
console.log(`${products.length} products`);
for (const p of products.slice(0, 10)) {
  const v = p.variants.find((x) => x.availableForSale !== false);
  console.log(`  $${String(p.price).padEnd(6)} ${p.title.slice(0, 40).padEnd(40)} ${p.id}  ${v?.id ?? "(no variant)"}${p.metadata?.purchaseGate ? "  [gated]" : ""}`);
}
try {
  const { product, variant } = pickItem(products, { productId: cfg.productId, variantId: cfg.variantId, query: cfg.productQuery });
  console.log(`would buy: ${product.title} — ${variant.title} ($${variant.price})`);
  if (missingShipping(cfg.shipping).length === 0) {
    const q = await merchant.quote([{ productId: product.id, variantId: variant.id, quantity: cfg.quantity }], cfg.shipping);
    console.log(`quote: $${q.subtotal} + $${q.shippingCost} shipping + $${q.tax + q.vat} tax = $${q.total} ${q.currency}`);
  } else {
    console.log(`(set ${missingShipping(cfg.shipping).join(", ")} to see a shipping quote)`);
  }
} catch (e) {
  console.log(`pick: ${(e as Error).message}`);
}

section("pay route (x402)");
const probe = await merchant.pay(orderId ?? "00000000-0000-0000-0000-000000000000");
console.log(`POST /orders/${orderId ?? "<zero-uuid>"}/pay -> ${probe.status} ${JSON.stringify(probe.body)}`);
if (probe.status === 404) console.log("route not mounted: X402 is disabled on this deployment (expected on nearmerch.com for now)");
if (probe.required) {
  for (const a of probe.required.accepts) {
    const tag = isNearIntents(a) ? "near-intents" : String(a.extra?.assetTransferMethod ?? "eip3009");
    const dest = a.extra?.destination as { network?: string; amount?: string } | undefined;
    console.log(`  ${a.scheme} ${tag.padEnd(12)} ${a.network.padEnd(16)} ${a.asset}  amount=${a.amount || "(quote)"}${dest ? `  dest=${dest.amount}@${dest.network}` : ""}`);
  }
  const ours = probe.required.accepts.find((a) => isNearIntents(a) && a.network === BASE_NETWORK && a.asset.toLowerCase() === BASE_USDC.toLowerCase());
  console.log(ours ? "OK: Base USDC near-intents entry present (what Agent Connect pays)" : "MISSING: no Base USDC near-intents entry");
}

section("ping facilitator (public discovery)");
try {
  const supported = await getSupported(cfg.pingUrl);
  const nets = supported.kinds.filter((k) => k.extra?.assetTransferMethod === "near-intents").map((k) => k.network);
  console.log(`${nets.length} near-intents origins; Base ${nets.includes(BASE_NETWORK) ? "yes" : "NO"}`);
} catch (e) {
  console.log(`supported: ${(e as Error).message}`);
}

section("agent connect (MCP)");
if (!cfg.agentConnectKey) {
  console.log("AGENT_CONNECT_KEY not set — skipping (issue a 30-day key in the Agent Connect dashboard)");
} else {
  const mcp = new AgentConnectMcp({ url: cfg.mcpUrl, bearer: cfg.agentConnectKey });
  try {
    await mcp.connect();
    const account = await resolveAccount(mcp, cfg.agentConnectAccount || undefined);
    console.log(`account "${account.name}"  intents=${account.intents_account_id ?? "?"}  near=${account.near_account_id ?? "?"}  evm=${account.evm_account_id ?? "?"}`);
    console.log(`USDC available: ${formatUsdc(await availableBalance(mcp, account.name, cfg.withdrawToken))}`);
    const policy = await mcp.callTool<Record<string, unknown>>("get_policy", { account: account.name });
    console.log(`policy: ${JSON.stringify(policy).slice(0, 600)}`);
    console.log("needs: withdraw allowed, destinations mode \"any\" (fresh deposit address per order), timelock 0 for unattended runs");
    const status = await mcp.callTool("get_network_status", {});
    console.log(`network: ${JSON.stringify(status).slice(0, 300)}`);
    const tools = await mcp.listTools();
    const signTool = tools.find((t) => t.name === "near_sign_message");
    console.log(`tools: ${tools.length}${signTool ? `; near_sign_message schema ${JSON.stringify(signTool.inputSchema)}` : "; near_sign_message not listed"}`);
  } catch (e) {
    console.log(`mcp: ${(e as Error).message}`);
  } finally {
    await mcp.disconnect();
  }
}

console.log("\ncheck complete — no order, no signature, no withdraw.");
