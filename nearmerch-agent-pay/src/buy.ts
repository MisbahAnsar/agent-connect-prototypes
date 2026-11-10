/**
 * The whole purchase, as one function the recipe and the tests both run:
 *
 *   nearmerch: pick item → quote → sign in (NEP-413) → checkout (x402) → 402
 *   ping x402: pick near-intents Base/USDC entry → quote (refundTo) → depositAddress + amountIn
 *   agent connect: gross-up withdraw_preview → withdraw (idempotent) → poll → Base tx hash
 *   ping x402: deposit payload → retry while settlement_pending / INCOMPLETE_DEPOSIT → 200
 */
import {
  agentConnectNep413Wallet,
  availableBalance,
  destinationTxHash,
  grossUpWithdraw,
  resolveAccount,
  submitWithdraw,
  waitForOperation,
  type AgentConnectMcp,
} from "./agent-connect";
import { BASE_NETWORK, BASE_USDC, formatUsdc, missingShipping, usdToUsdcAtomic, type Config } from "./config";
import { pickItem, type NearmerchClient, type NearSigner } from "./nearmerch";
import { getChallenge, requestQuote, selectIntentsAccept, settleDeposit, type SettleOptions } from "./ping-x402";

export type BuyDeps = {
  merchant: NearmerchClient;
  mcp: AgentConnectMcp;
  log?: (msg: string) => void;
  /** Called after each irreversible step so the CLI can journal what to resume from. */
  checkpoint?: (stage: string, data: Record<string, unknown>) => void;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
  settle?: Omit<SettleOptions, "sleep">;
  pollMs?: number;
};

export type BuyResult = {
  orderId: string;
  product: string;
  variant: string;
  totalUsd: number;
  depositAddress: string;
  amountIn: string;
  withdrawn: string;
  withdrawOperationId: string;
  originTxHash: string;
  settlementTx?: string;
  settlementNetwork?: string;
  orderStatus: string;
};

export class SpendGuardError extends Error {}

export async function buyWithAgentConnect(deps: BuyDeps, cfg: Config, opts: { confirm: boolean }): Promise<BuyResult> {
  const log = deps.log ?? (() => {});
  const checkpoint = deps.checkpoint ?? (() => {});
  const { merchant, mcp } = deps;
  if (!opts.confirm) throw new SpendGuardError("refusing to spend without confirm (pay --confirm)");
  if (!cfg.refundAddress || !/^0x[0-9a-fA-F]{40}$/.test(cfg.refundAddress)) {
    throw new SpendGuardError("REFUND_ADDRESS must be a Base (EVM) address you control: Ping refunds failed or excess deposits there");
  }
  const missing = missingShipping(cfg.shipping);
  if (missing.length) throw new SpendGuardError(`shipping address incomplete: set ${missing.join(", ")}`);
  const maxAtomic = usdToUsdcAtomic(cfg.maxUsdc);

  const site = await merchant.siteConfig().catch(() => ({}) as { maintenance?: { enabled: boolean; message?: string } });
  if (site.maintenance?.enabled) throw new Error(`store is in maintenance: ${site.maintenance.message ?? "checkout disabled"}`);

  // 1. pick + quote (public)
  const products = await merchant.listProducts();
  const { product, variant } = pickItem(products, { productId: cfg.productId, variantId: cfg.variantId, query: cfg.productQuery });
  const items = [{ productId: product.id, variantId: variant.id, quantity: cfg.quantity }];
  const quote = await merchant.quote(items, cfg.shipping);
  log(`item     ${product.title} — ${variant.title} x${cfg.quantity}`);
  log(`quote    $${quote.subtotal} + $${quote.shippingCost} shipping + $${quote.tax + quote.vat} tax = $${quote.total} ${quote.currency}`);
  if (usdToUsdcAtomic(quote.total) > maxAtomic) throw new SpendGuardError(`quote $${quote.total} is above MAX_USDC=${cfg.maxUsdc}`);

  // 2. wallet preflight
  const account = await resolveAccount(mcp, cfg.agentConnectAccount || undefined);
  const balance = await availableBalance(mcp, account.name, cfg.withdrawToken);
  log(`wallet   Agent Connect "${account.name}" — ${formatUsdc(balance)} USDC available on NEAR Intents`);
  if (balance < usdToUsdcAtomic(quote.total)) {
    throw new SpendGuardError(`not enough USDC: have ${formatUsdc(balance)}, order is ~$${quote.total} before bridge cost`);
  }

  // 3. sign in + checkout (creates the order; payable for 15 minutes)
  const signer: NearSigner =
    cfg.signer === "agent-connect"
      ? { wallet: agentConnectNep413Wallet(mcp, account.name) }
      : { privateKey: cfg.nearPrivateKey, accountId: cfg.nearAccountId };
  if (!("wallet" in signer) && (!signer.privateKey || !signer.accountId)) {
    throw new SpendGuardError("NEAR_ACCOUNT_ID and NEAR_PRIVATE_KEY are required for NEARMERCH_SIGNER=key");
  }
  const { accountId } = await merchant.signIn(signer);
  log(`sign-in  ${accountId}`);
  const order = await merchant.checkout({ items, shippingAddress: cfg.shipping, quote });
  checkpoint("order_created", { orderId: order.orderId, totalAmount: order.totalAmount });
  log(`order    ${order.orderId} — $${order.totalAmount} ${order.currency} (${order.status})`);
  if (usdToUsdcAtomic(order.totalAmount) > maxAtomic) throw new SpendGuardError(`order total $${order.totalAmount} is above MAX_USDC`);

  // 4. 402 → near-intents entry → quote
  const challenge = await getChallenge(merchant, order.orderId);
  const accepted = selectIntentsAccept(challenge, { network: BASE_NETWORK, asset: BASE_USDC });
  const destination = accepted.extra?.destination as { network?: string; amount?: string; recipient?: string } | undefined;
  if (destination?.amount) log(`402      merchant receives ${formatUsdc(destination.amount)} on ${destination.network} (${destination.recipient ?? "?"})`);
  const quoted = await requestQuote(merchant, order.orderId, challenge, accepted, cfg.refundAddress);
  checkpoint("quoted", {
    orderId: order.orderId,
    depositAddress: quoted.depositAddress,
    amountIn: quoted.amountIn.toString(),
    refundDeadline: quoted.refundDeadline,
  });
  log(`quote    deposit ${formatUsdc(quoted.amountIn)} USDC on Base → ${quoted.depositAddress} (refund deadline ${quoted.refundDeadline})`);
  if (quoted.amountIn > maxAtomic) throw new SpendGuardError(`quoted amountIn ${formatUsdc(quoted.amountIn)} is above MAX_USDC`);
  const now = deps.now ?? Date.now;
  if (Date.parse(quoted.refundDeadline) - now() < 2 * 60_000) throw new Error("quote expires in under 2 minutes; re-run for a fresh quote");

  // 5. Agent Connect: gross-up, withdraw once, wait for the Base tx
  const gross = await grossUpWithdraw(mcp, {
    account: account.name,
    token: cfg.withdrawToken,
    chain: "base",
    to: quoted.depositAddress,
    requiredOut: quoted.amountIn,
    maxPreviews: cfg.maxPreviews,
  });
  log(`preview  send ${formatUsdc(gross.sourceAmount)} → delivers ${formatUsdc(gross.amountOut)} on Base (${gross.previewsUsed} preview(s))`);
  if (gross.sourceAmount > maxAtomic) throw new SpendGuardError(`gross-up needs ${formatUsdc(gross.sourceAmount)} USDC, above MAX_USDC`);
  if (gross.sourceAmount > balance) throw new SpendGuardError(`gross-up needs ${formatUsdc(gross.sourceAmount)} USDC, have ${formatUsdc(balance)}`);

  // Same order + deposit address → same key: a re-run replays instead of paying twice.
  const idempotencyKey = `nearmerch:${order.orderId}:${quoted.depositAddress}`;
  const submitted = await submitWithdraw(mcp, {
    account: account.name,
    token: cfg.withdrawToken,
    amount: gross.sourceAmount,
    chain: "base",
    to: quoted.depositAddress,
    idempotencyKey,
  });
  checkpoint("withdraw_submitted", { orderId: order.orderId, depositAddress: quoted.depositAddress, operationId: submitted.operation_id, idempotencyKey });
  log(`withdraw ${submitted.operation_id} (${submitted.status ?? "submitted"})`);
  const done = await waitForOperation(mcp, submitted.operation_id!, {
    ...(deps.sleep ? { sleep: deps.sleep } : {}),
    now,
    ...(deps.pollMs !== undefined ? { pollMs: deps.pollMs } : {}),
    timeoutMs: Math.max(60_000, Date.parse(quoted.refundDeadline) - now()),
  });
  const txHash = destinationTxHash(done);
  checkpoint("deposited", { orderId: order.orderId, depositAddress: quoted.depositAddress, txHash });
  log(`deposit  https://basescan.org/tx/${txHash}`);

  // 6. settle through the merchant (→ Ping /settle)
  const paid = await settleDeposit(merchant, order.orderId, quoted, txHash, {
    ...deps.settle,
    ...(deps.sleep ? { sleep: deps.sleep } : {}),
    onStep: (n, s) => {
      if (s.kind !== "paid") log(`settle   attempt ${n}: ${s.kind} (${s.reason})`);
      deps.settle?.onStep?.(n, s);
    },
  });
  const final = await merchant.getOrder(order.orderId).catch(() => null);
  const result: BuyResult = {
    orderId: order.orderId,
    product: product.title,
    variant: variant.title,
    totalUsd: order.totalAmount,
    depositAddress: quoted.depositAddress,
    amountIn: quoted.amountIn.toString(),
    withdrawn: gross.sourceAmount.toString(),
    withdrawOperationId: submitted.operation_id!,
    originTxHash: txHash,
    ...(paid.receipt?.transaction ? { settlementTx: paid.receipt.transaction } : {}),
    ...(paid.receipt?.network ? { settlementNetwork: paid.receipt.network } : {}),
    orderStatus: final?.order.status ?? String(paid.body.status ?? "unknown"),
  };
  checkpoint("paid", { ...result });
  log(`paid     order ${result.orderId} → ${result.orderStatus}${result.settlementTx ? ` (settled ${result.settlementNetwork} ${result.settlementTx})` : ""}`);
  return result;
}
