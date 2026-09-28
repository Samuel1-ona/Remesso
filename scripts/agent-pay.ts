/// Pay another agent's x402 service, from Remesso's own wallet.
///
/// The counterpart to `x402-buy.ts`, which pays as a caller with a key you
/// pass it. This one spends Remesso's agent wallet through the shared client,
/// so it obeys the same limits any Edge Function would: a per-call ceiling, a
/// rolling daily cap, and a row in `agent_spend` written before anything is
/// signed.
///
///   deno run --allow-env --allow-read --allow-net scripts/agent-pay.ts \
///     --url https://example.com/functions/v1/some-service \
///     --body '{"question":"..."}' --purpose "fx quote" [--max 20000]
///
/// `--max` is in USDC base units (6dp), and the lower of it and the configured
/// per-call cap wins. Nothing is signed before both are satisfied.
for (const line of (await Deno.readTextFile(".env")).split("\n")) {
  const m = line.match(/^([A-Z0-9_]+)=(.*)$/);
  if (m) Deno.env.set(m[1], m[2].replace(/\s+#.*$/, "").trim());
}

const { payAndCall, spendableBalance, SPEND } = await import(
  "../supabase/functions/_shared/x402-pay.ts"
);

const url = flag("url");
const purpose = flag("purpose") ?? "manual";
const max = flag("max");
if (!url) {
  console.error("usage: agent-pay.ts --url <x402 endpoint> [--body <json>] [--purpose <why>] [--max <units>]");
  Deno.exit(2);
}

if (!SPEND.isConfigured) {
  console.error("AGENT_SPEND_PRIVATE_KEY is not set — this wallet is deliberately separate");
  console.error("from the executor: one key that both moves senders' money and spends ours");
  console.error("is one compromise with two blast radii.");
  Deno.exit(1);
}

const balance = await spendableBalance();
console.log(`agent wallet holds : ${Number(balance ?? 0n) / 1e6} USDC`);
console.log(`per-call ceiling   : ${Number(SPEND.maxPerCallUnits) / 1e6} USDC`);
console.log(`daily ceiling      : ${Number(SPEND.maxPerDayUnits) / 1e6} USDC`);
console.log();

const body = flag("body") ? JSON.parse(flag("body")!) : {};
const out = await payAndCall<unknown>(url, body, {
  purpose,
  ...(max ? { maxUnits: BigInt(max) } : {}),
});

if (!out.ok) {
  console.error("refused:", out.error);
  if (out.refusedPrice !== undefined) {
    console.error(`  they asked ${Number(out.refusedPrice) / 1e6} USDC`);
  }
  Deno.exit(1);
}

console.log(
  out.paidUnits === 0n
    ? "no payment was required"
    : `paid ${Number(out.paidUnits) / 1e6} USDC to ${out.payTo}`,
);
console.log(JSON.stringify(out.data, null, 2).slice(0, 800));

function flag(name: string): string | undefined {
  const i = Deno.args.indexOf(`--${name}`);
  return i >= 0 ? Deno.args[i + 1] : undefined;
}
