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
//   deno run --allow-env --allow-net pay-remesso.ts
// Needs: PAYER_KEY=0x… a wallet holding a little USDC on Celo (no CELO needed).
import { createWalletClient, http } from "npm:viem@2";
import { privateKeyToAccount } from "npm:viem@2/accounts";
import { celo } from "npm:viem@2/chains";

const URL_ = Deno.env.get("SERVICE") ??
  "https://engaboljiqudghvzmebq.supabase.co/functions/v1/rate-service";
const account = privateKeyToAccount(Deno.env.get("PAYER_KEY") as `0x${string}`);
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
const r = (await quote.json()).accepts[0];
console.log(`price: ${Number(r.maxAmountRequired) / 1e6} USDC -> ${r.payTo}`);

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
  domain: { name: "USDC", version: "2", chainId: 42220, verifyingContract: r.asset },
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
