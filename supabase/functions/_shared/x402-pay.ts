/// Paying another agent, over x402.
///
/// The mirror of `x402.ts`: that one charges, this one pays. A service answers
/// 402 with what it wants, we sign a USDC transfer authorisation for exactly
/// that, and retry. EIP-3009, so the facilitator submits and pays the gas and
/// this wallet needs no CELO.
///
/// Two rules, both because this spends real money without a human present:
///
///   1. A ceiling per call and a ceiling per day, checked against a ledger in
///      Postgres before anything is signed. An agent that can spend without a
///      bound is not autonomous, it is unattended.
///   2. Only what the caller asked for. The price comes from the 402 answer,
///      is compared against the caller's own maximum, and anything larger is
///      refused rather than negotiated.
///
/// The spend ledger is also the audit trail: every payment is a row before it
/// is a signature, so a loop that pays the same service a thousand times is
/// visible in the place that stopped it.
import { createWalletClient, http, parseAbi, createPublicClient } from "npm:viem@2";
import { privateKeyToAccount } from "npm:viem@2/accounts";
import { celo } from "npm:viem@2/chains";
import { createClient } from "npm:@supabase/supabase-js@2";
import { CELO } from "./config.ts";

const USDC: `0x${string}` = "0xcebA9300f2b948710d2653dD7B07f33A8B32118C";

/// What USDC verifies a gasless transfer against. Field order is part of the
/// hash: a reordering is a different signature, and an invalid one.
const authorizationTypes = {
  TransferWithAuthorization: [
    { name: "from", type: "address" },
    { name: "to", type: "address" },
    { name: "value", type: "uint256" },
    { name: "validAfter", type: "uint256" },
    { name: "validBefore", type: "uint256" },
    { name: "nonce", type: "bytes32" },
  ],
} as const;

export const SPEND = {
  /// The key that pays. Deliberately NOT the executor: that one signs runs for
  /// other people's mandates, and a key that both moves senders' money and
  /// spends our own is one compromise with two blast radii.
  get privateKey(): string {
    return Deno.env.get("AGENT_SPEND_PRIVATE_KEY") ?? "";
  },
  /// Most this may pay for one call, in USDC base units. 6dp.
  get maxPerCallUnits(): bigint {
    return BigInt(Deno.env.get("AGENT_MAX_PER_CALL_UNITS") ?? "50000"); // $0.05
  },
  /// Most this may pay in a rolling 24 hours.
  get maxPerDayUnits(): bigint {
    return BigInt(Deno.env.get("AGENT_MAX_PER_DAY_UNITS") ?? "1000000"); // $1.00
  },
  get isConfigured(): boolean {
    return /^0x[a-fA-F0-9]{64}$/.test(this.privateKey);
  },
};

const db = () =>
  createClient(
    Deno.env.get("SUPABASE_URL")!,
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
  );

export type PaidResult<T> =
  | { ok: true; data: T; paidUnits: bigint; payTo: string }
  | { ok: false; error: string; refusedPrice?: bigint };

/// Call an x402 service, paying if it asks and the price is within bounds.
///
/// `maxUnits` is the caller's own ceiling for this call; the configured
/// per-call cap applies on top, and the lower of the two wins. Nothing is
/// signed before both are satisfied.
export async function payAndCall<T>(
  url: string,
  body: unknown,
  opts: { maxUnits?: bigint; purpose: string } = { purpose: "unspecified" },
): Promise<PaidResult<T>> {
  if (!SPEND.isConfigured) return { ok: false, error: "agent spending is not configured" };

  const account = privateKeyToAccount(SPEND.privateKey as `0x${string}`);
  const post = (headers: Record<string, string> = {}) =>
    fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json", ...headers },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(20_000),
    });

  let first: Response;
  try {
    first = await post();
  } catch (e) {
    return { ok: false, error: `unreachable: ${(e as Error).message}` };
  }

  // Free, or an ordinary failure. Either way there is nothing to pay.
  if (first.status !== 402) {
    if (!first.ok) return { ok: false, error: `upstream ${first.status}` };
    return { ok: true, data: await first.json() as T, paidUnits: 0n, payTo: "" };
  }

  const quote = await first.json().catch(() => ({})) as { accepts?: Requirements[] };
  const reqs = quote.accepts?.[0];
  if (!reqs) return { ok: false, error: "402 without payment requirements" };
  if (reqs.asset?.toLowerCase() !== USDC.toLowerCase()) {
    return { ok: false, error: `will only pay in USDC, not ${reqs.asset}` };
  }

  const price = BigInt(reqs.maxAmountRequired);
  const ceiling = opts.maxUnits && opts.maxUnits < SPEND.maxPerCallUnits
    ? opts.maxUnits
    : SPEND.maxPerCallUnits;
  if (price > ceiling) {
    return { ok: false, error: "price above the limit for this call", refusedPrice: price };
  }

  const spentToday = await spentInLastDay();
  if (spentToday + price > SPEND.maxPerDayUnits) {
    return { ok: false, error: "daily spending limit reached", refusedPrice: price };
  }

  // Recorded before it is signed. A row without a signature is a question to
  // answer later; a signature without a row is money nobody can account for.
  const { data: row } = await db()
    .from("agent_spend")
    .insert({
      url,
      purpose: opts.purpose,
      amount_units: price.toString(),
      pay_to: reqs.payTo,
      status: "authorising",
    })
    .select("id")
    .single();

  const now = Math.floor(Date.now() / 1000);
  const authorization = {
    from: account.address,
    to: reqs.payTo as `0x${string}`,
    value: price,
    validAfter: BigInt(now - 60),
    validBefore: BigInt(now + (reqs.maxTimeoutSeconds ?? 60)),
    nonce: `0x${[...crypto.getRandomValues(new Uint8Array(32))]
      .map((b) => b.toString(16).padStart(2, "0")).join("")}` as `0x${string}`,
  };

  const wallet = createWalletClient({ account, chain: celo, transport: http(CELO.rpcUrl) });
  const signature = await wallet.signTypedData({
    domain: {
      name: (reqs.extra?.name as string) ?? "USDC",
      version: (reqs.extra?.version as string) ?? "2",
      chainId: CELO.chainId,
      verifyingContract: USDC,
    },
    types: authorizationTypes,
    primaryType: "TransferWithAuthorization",
    message: authorization,
  });

  const payment = {
    x402Version: 1,
    scheme: reqs.scheme,
    network: reqs.network,
    payload: {
      signature,
      authorization: {
        ...authorization,
        value: price.toString(),
        validAfter: authorization.validAfter.toString(),
        validBefore: authorization.validBefore.toString(),
      },
    },
  };

  let paid: Response;
  try {
    paid = await post({ "X-PAYMENT": btoa(JSON.stringify(payment)) });
  } catch (e) {
    await settleRow(row?.id, "failed", (e as Error).message);
    return { ok: false, error: `unreachable after paying: ${(e as Error).message}` };
  }

  if (!paid.ok) {
    await settleRow(row?.id, "failed", `upstream ${paid.status}`);
    return { ok: false, error: `upstream ${paid.status} after payment` };
  }

  await settleRow(row?.id, "paid", paid.headers.get("x-payment-response") ?? null);
  return {
    ok: true,
    data: await paid.json() as T,
    paidUnits: price,
    payTo: reqs.payTo,
  };
}

/// What this wallet holds, so a caller can see it running dry before a payment
/// fails for it.
export async function spendableBalance(): Promise<bigint | null> {
  if (!SPEND.isConfigured) return null;
  const account = privateKeyToAccount(SPEND.privateKey as `0x${string}`);
  const pub = createPublicClient({ chain: celo, transport: http(CELO.rpcUrl) });
  return await pub.readContract({
    address: USDC,
    abi: parseAbi(["function balanceOf(address) view returns (uint256)"]),
    functionName: "balanceOf",
    args: [account.address],
  });
}

async function spentInLastDay(): Promise<bigint> {
  const since = new Date(Date.now() - 86_400_000).toISOString();
  const { data } = await db()
    .from("agent_spend")
    .select("amount_units")
    .gte("created_at", since)
    .in("status", ["authorising", "paid"]);
  return (data ?? []).reduce((sum, r) => sum + BigInt(r.amount_units as string), 0n);
}

async function settleRow(id: string | undefined, status: string, note: string | null) {
  if (!id) return;
  await db().from("agent_spend").update({
    status,
    note,
    settled_at: new Date().toISOString(),
  }).eq("id", id);
}

type Requirements = {
  scheme: string;
  network: string;
  payTo: string;
  asset: string;
  maxAmountRequired: string;
  maxTimeoutSeconds?: number;
  extra?: Record<string, unknown>;
};
