/// x402: charging for a call, over plain HTTP.
///
/// The protocol is three moves. A caller asks for something; we answer 402
/// with exactly what payment we would accept; they retry with a signed
/// authorisation in `X-PAYMENT`. We ask Celo's hosted facilitator to check the
/// signature (`/verify`), do the work, and only then ask it to move the money
/// (`/settle`). The facilitator submits the transfer and pays the gas, so the
/// caller needs no CELO and we run no payment infrastructure.
///
/// Hand-rolled rather than `@x402/hono`: the middleware assumes a Hono server,
/// this is one Deno handler, and the wire format is a 402 body and two
/// authenticated POSTs. Same reasoning as `cngn.ts` and `self.ts`.
///
/// Verify before the work, settle after it. A caller whose run reverts should
/// not be charged, and a caller who is charged should have had their run.

export const X402 = {
  get base(): string {
    return (Deno.env.get("X402_FACILITATOR") ?? "https://api.x402.celo.org").replace(/\/+$/, "");
  },
  /// `x402_…`, from the dashboard at x402.celo.org. Metering and settlement
  /// credits hang off it.
  get apiKey(): string {
    return Deno.env.get("X402_API_KEY") ?? "";
  },
  /// What one call costs, in USDC base units. 6dp, so 10_000 is one cent.
  get priceUnits(): string {
    return Deno.env.get("X402_PRICE_UNITS") ?? "10000";
  },
  /// Where the money goes. The treasury, not the hot executor key.
  get payTo(): string {
    return Deno.env.get("X402_PAY_TO") ?? "";
  },
  get isConfigured(): boolean {
    return Boolean(this.apiKey && /^0x[a-fA-F0-9]{40}$/.test(this.payTo));
  },
};

/// The assets this seller takes, each with the EIP-712 domain its token
/// actually signs under. All EIP-3009, so a payer signs an authorisation and
/// needs no native CELO whichever one they pick.
///
/// Two traps live in this table, both verified on-chain 2026-09-30:
///
///  1. **`name` is not the symbol.** USAT signs as "Tether America USD" and
///     USDT as "Tether USD". Using the symbol produces a signature that is
///     valid for a domain nobody uses, and the failure surfaces as an opaque
///     rejection rather than "wrong name".
///  2. **Each has an 18-decimal fee-currency adapter reporting the SAME
///     symbol.** USAT's is `0x0357EE22278c922e1D36cFe6b899269b161880C4`
///     (decimals 6 vs 18, symbol "USAT" on both). Quoting a price against an
///     adapter is a 10^12 error. These addresses are the tokens.
///
/// Neither token exposes `version()` and `eip712Domain()` reverts on all of
/// them, so these values cannot be read at runtime. They come from the
/// facilitator's own asset table.
export const ASSETS = [
  {
    symbol: "USDC",
    address: "0xcebA9300f2b948710d2653dD7B07f33A8B32118C" as `0x${string}`,
    name: "USDC",
    version: "2",
    decimals: 6,
  },
  {
    symbol: "USAT",
    address: "0xD2ab3C9A02DBBAB236BfEC45D1d755DF4267F771" as `0x${string}`,
    name: "Tether America USD",
    version: "1",
    decimals: 6,
  },
] as const;

/// Kept for the default and for anything still naming one asset.
const USDC: `0x${string}` = ASSETS[0].address;

/// How x402 v1 names this chain: the short name, not CAIP-2.
///
/// The facilitator advertises both — `{x402Version: 1, network: "celo"}` and
/// `{x402Version: 2, network: "eip155:42220"}` — and pairing a version with
/// the other version's name is rejected as `unsupported_scheme`, which reads
/// like a scheme problem and is really a naming one. Seen 2026-09-22.
const NETWORK = Deno.env.get("X402_NETWORK") ?? "celo";

export type PaymentRequirements = {
  scheme: "exact";
  network: string;
  resource: string;
  description: string;
  mimeType: string;
  payTo: string;
  maxAmountRequired: string;
  asset: string;
  maxTimeoutSeconds: number;
  outputSchema: Record<string, unknown>;
  extra: { name: string; version: string };
};

/// One entry per asset we accept, which is what the `accepts` array of a 402
/// is for: the payer picks the currency they already hold.
///
/// Every asset here is 6dp, so one `maxAmountRequired` is correct for all of
/// them. Adding an 18dp asset (Ripio's wARS and friends) means pricing per
/// asset at its own scale — and those settle through Permit2 rather than
/// EIP-3009, so they need `assetTransferMethod` too. Not a line to add
/// casually.
export function requirements(resource: string, description: string): PaymentRequirements[] {
  return ASSETS.map((a) => ({
    scheme: "exact" as const,
    network: NETWORK,
    resource,
    description,
    mimeType: "application/json",
    payTo: X402.payTo,
    maxAmountRequired: X402.priceUnits,
    asset: a.address,
    // Long enough for a signature round trip, short enough that a stale
    // authorisation cannot be replayed against a later price.
    maxTimeoutSeconds: 60,
    // Part of the V1 requirements shape. Empty is legal; absent is not, for
    // verifiers that validate the object before looking at the signature.
    outputSchema: {},
    // The EIP-712 domain the payer signs against. Getting this wrong makes
    // every signature invalid for reasons the payer cannot see.
    extra: { name: a.name, version: a.version },
  }));
}

/// Override the price on every accepted asset at once.
///
/// A helper rather than a `map` at each call site, because forgetting one
/// entry publishes two different prices for the same call and the cheaper one
/// is the one a payer picks.
export function priced(reqs: PaymentRequirements[], units: string): PaymentRequirements[] {
  return reqs.map((r) => ({ ...r, maxAmountRequired: units }));
}

/// The body of a 402. It is the price list, in the shape x402 clients parse.
export function paymentRequiredBody(
  accepts: PaymentRequirements | PaymentRequirements[],
  error = "payment required",
) {
  return { x402Version: 1, error, accepts: Array.isArray(accepts) ? accepts : [accepts] };
}

async function facilitator(path: string, body: unknown): Promise<Record<string, unknown> | null> {
  try {
    const res = await fetch(`${X402.base}${path}`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        // The dashboard key meters settlement credits; without it the
        // facilitator answers 401 and nothing settles.
        "X-API-Key": X402.apiKey,
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(15_000),
    });
    const json = await res.json().catch(() => ({}));
    if (!res.ok) {
      console.error("x402", path, res.status, JSON.stringify(json).slice(0, 300));
      // A rejected payment is a 400 carrying `invalidReason` — the useful
      // half of the answer. Discarding it as "unavailable" tells a payer
      // nothing, when the facilitator just told them their balance is short.
      const judged = json as { isValid?: unknown; invalidReason?: unknown; success?: unknown };
      if (judged.isValid !== undefined || judged.success !== undefined) {
        return judged as Record<string, unknown>;
      }
      return null;
    }
    return json as Record<string, unknown>;
  } catch (e) {
    console.error("x402 facilitator unreachable:", (e as Error).message);
    return null;
  }
}

/// Is this signed authorisation good for this price? Nothing has moved yet.
export async function verify(
  paymentPayload: unknown,
  paymentRequirements: PaymentRequirements,
): Promise<{ ok: boolean; reason?: string; payer?: string }> {
  const out = await facilitator("/verify", { x402Version: 1, paymentPayload, paymentRequirements });
  if (!out) return { ok: false, reason: "payment verification unavailable" };
  return {
    ok: out.isValid === true,
    reason: typeof out.invalidReason === "string" ? out.invalidReason : undefined,
    payer: typeof out.payer === "string" ? out.payer : undefined,
  };
}

/// Which of the advertised assets did the payer actually sign for?
///
/// x402 v1's `X-PAYMENT` carries scheme, network, the signature and the
/// EIP-3009 authorization — and no asset. The token is only implied by the
/// EIP-712 domain the signature was made against, which a resource server
/// cannot read off the payload. (v2's payload does echo the accepted object;
/// v1's does not, and we are on v1 because that is the version the
/// facilitator pairs with `network: "celo"`.)
///
/// So we ask. Candidates are tried in order and the first that verifies is
/// the one the payer meant — a wrong-asset signature simply fails to verify,
/// which is the same answer a forged one gets. Verification moves no money,
/// so a rejected candidate costs a round trip and nothing else.
///
/// The common case is one call: USDC is first because it is what most payers
/// hold today. If that ordering ever stops being true, reorder `ASSETS`.
export async function verifyAny(
  paymentPayload: unknown,
  accepts: PaymentRequirements[],
): Promise<{ ok: boolean; reason?: string; payer?: string; matched?: PaymentRequirements }> {
  let lastReason: string | undefined;
  for (const candidate of accepts) {
    const out = await verify(paymentPayload, candidate);
    if (out.ok) return { ...out, matched: candidate };
    // Keep the most specific complaint. "insufficient_funds" against the
    // asset they actually signed for is the useful message; the generic
    // mismatch from the other candidates is not.
    lastReason = out.reason ?? lastReason;
  }
  return { ok: false, reason: lastReason };
}

/// Move the money. Called only after the work succeeded.
export async function settle(
  paymentPayload: unknown,
  paymentRequirements: PaymentRequirements,
): Promise<{ ok: boolean; txHash?: string }> {
  const out = await facilitator("/settle", { x402Version: 1, paymentPayload, paymentRequirements });
  if (!out) return { ok: false };
  return {
    ok: out.success === true,
    txHash: typeof out.transaction === "string" ? out.transaction : undefined,
  };
}

/// `X-PAYMENT` carries base64 JSON.
export function decodePayment(header: string | null): unknown | null {
  if (!header) return null;
  try {
    return JSON.parse(atob(header));
  } catch {
    console.error("x402: X-PAYMENT is not base64 JSON");
    return null;
  }
}

/// What the caller gets back so they can find the settlement on-chain.
export function encodeSettlement(txHash: string | undefined): string {
  return btoa(JSON.stringify({ success: true, transaction: txHash ?? null, network: NETWORK }));
}
