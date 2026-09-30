/// Pay a Remesso service with USDC on Celo. Standalone by design: an agent's
/// operator should be able to try this without cloning anything, so this file
/// imports nothing from the repo around it and is meant to be pasted whole.
///
/// The three moves of x402: ask and be told the price, sign a transfer
/// authorisation for exactly that price, ask again with it attached. Nothing
/// here is Remesso-specific — the same file pays any x402 service on Celo.
///
/// EIP-3009 means the facilitator submits the transfer and pays the gas, so
/// the wallet needs USDC and no CELO at all.
///   deno run --allow-env --allow-net pay-remesso.ts
///
/// Needs PAYER_KEY (or PRIVATE_KEY) — a wallet holding a little USDC or USAT
/// on Celo, and no CELO. MAX_UNITS caps what it will pay; see below.
/// ASSET=USAT picks a currency when the service offers more than one.
///
/// On Node: `npm i viem`, change the imports to "viem", "viem/accounts" and
/// "viem/chains" (Node cannot resolve `npm:` or a version suffix), swap
/// `Deno.env.get(x)` for `process.env[x]` and `Deno.exit` for `process.exit`,
/// and save it as `.mts` — as `.ts` it is compiled to CommonJS and the
/// top-level await below fails. Then `node --experimental-strip-types
/// pay-remesso.mts` on Node 22.6 through 23.5, or plain `node pay-remesso.mts`
/// on 23.6+. No tsx, no build step.
import { createWalletClient, http } from "npm:viem@2";
import { privateKeyToAccount } from "npm:viem@2/accounts";
import { celo } from "npm:viem@2/chains";

const URL_ = Deno.env.get("SERVICE") ??
  "https://engaboljiqudghvzmebq.supabase.co/functions/v1/rate-service";

/// The most this script will pay for one call, in USDC base units (6dp), so
/// 10_000 is one cent.
///
/// Without a ceiling, the seller names the price and the buyer signs it —
/// which is fine until the price changes, the endpoint is swapped, or DNS is
/// pointed somewhere else. The 402 is a quote from a stranger, and a quote you
/// accept unread is not a quote. Raise it deliberately:
///   MAX_UNITS=50000 deno run --allow-env --allow-net pay-remesso.ts
const MAX_UNITS = BigInt(Deno.env.get("MAX_UNITS") ?? "10000");

// Both names, with or without the 0x. Wallets export private keys every one of
// these ways, and a key that is right but shaped differently should not read as
// a key that is wrong.
const key = (Deno.env.get("PAYER_KEY") ?? Deno.env.get("PRIVATE_KEY") ?? "").trim();
if (!/^(0x)?[0-9a-fA-F]{64}$/.test(key)) {
  console.error("set PAYER_KEY (or PRIVATE_KEY) to a 32-byte hex private key");
  Deno.exit(2);
}
const account = privateKeyToAccount(
  (key.startsWith("0x") ? key : `0x${key}`) as `0x${string}`,
);
console.log("paying as:", account.address);

// 1. Ask without paying. The 402 body is the quote.
const quote = await fetch(URL_, {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: "{}",
});
if (quote.status !== 402) {
  console.log("no payment required:", quote.status, await quote.text());
  Deno.exit(0);
}
/// A 402 can offer several currencies. Pick by token ADDRESS, never by
/// symbol: USAT and its 18-decimal fee adapter both report symbol "USAT", and
/// paying against the adapter is a 10^12 mistake.
const KNOWN: Record<string, string> = {
  USDC: "0xceba9300f2b948710d2653dd7b07f33a8b32118c",
  USAT: "0xd2ab3c9a02dbbab236bfec45d1d755df4267f771",
};
const accepts = (await quote.json()).accepts as Array<Record<string, any>>;
const want = (Deno.env.get("ASSET") ?? "").toUpperCase();
const r = want
  ? accepts.find((a) => String(a.asset).toLowerCase() === KNOWN[want])
  : accepts[0];
if (!r) {
  console.error(`this service does not take ${want}. it takes:`);
  for (const a of accepts) console.error(`  ${a.extra?.name ?? "?"}  ${a.asset}`);
  Deno.exit(1);
}
console.log(
  `price: ${Number(r.maxAmountRequired) / 1e6} ${r.extra?.name ?? "?"} -> ${r.payTo}`,
);

// Checked before the signature, not after: a signed authorisation is the
// payment, so there is no "cancel" once it exists.
if (BigInt(r.maxAmountRequired) > MAX_UNITS) {
  console.error(
    `refused: asked ${Number(r.maxAmountRequired) / 1e6} USDC, cap is ${Number(MAX_UNITS) / 1e6}.`,
  );
  console.error("raise it with MAX_UNITS=<base units> if that price is right.");
  Deno.exit(1);
}

// 2. Sign a USDC transfer authorisation for exactly that amount (EIP-3009).
const now = Math.floor(Date.now() / 1000);
const authorization = {
  from: account.address,
  to: r.payTo as `0x${string}`,
  value: BigInt(r.maxAmountRequired),
  validAfter: BigInt(now - 60),
  validBefore: BigInt(now + (r.maxTimeoutSeconds ?? 60)),
  nonce: `0x${[...crypto.getRandomValues(new Uint8Array(32))]
    .map((b) => b.toString(16).padStart(2, "0")).join("")}` as `0x${string}`,
};
const signature = await createWalletClient({
  account, chain: celo, transport: http("https://forno.celo.org"),
}).signTypedData({
  // From the 402, not hardcoded: the EIP-712 domain is the seller's to state,
  // and a wrong one makes every signature invalid for reasons a payer cannot
  // see. The fallbacks are what USDC on Celo happens to use today.
  domain: {
    name: r.extra?.name ?? "USDC",
    version: r.extra?.version ?? "2",
    chainId: 42220,
    verifyingContract: r.asset,
  },
  types: {
    TransferWithAuthorization: [
      { name: "from", type: "address" }, { name: "to", type: "address" },
      { name: "value", type: "uint256" }, { name: "validAfter", type: "uint256" },
      { name: "validBefore", type: "uint256" }, { name: "nonce", type: "bytes32" },
    ],
  },
  primaryType: "TransferWithAuthorization",
  message: authorization,
});

// 3. Retry with the payment attached.
const paid = await fetch(URL_, {
  method: "POST",
  headers: {
    "content-type": "application/json",
    "X-PAYMENT": btoa(JSON.stringify({
      x402Version: 1, scheme: r.scheme, network: r.network,
      payload: {
        signature,
        authorization: {
          ...authorization,
          value: String(authorization.value),
          validAfter: String(authorization.validAfter),
          validBefore: String(authorization.validBefore),
        },
      },
    })),
  },
  body: "{}",
});
console.log(`\nHTTP ${paid.status}`);
console.log(await paid.text());
const settled = paid.headers.get("x-payment-response");
if (settled) console.log("settlement:", JSON.parse(atob(settled)));
