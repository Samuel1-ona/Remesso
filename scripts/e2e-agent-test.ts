/// End-to-end test of the executor agent against Celo mainnet.
///
/// The happy path was proven by the first live run. This exercises the other
/// half — every branch that fires when something is wrong — because for an
/// unattended agent a remittance that silently does not happen is worse than
/// one that fails loudly.
///
/// Schedules are created from the test wallet, mirrored into the database the
/// way the frontend does, then execute-due-runs is invoked directly (which is
/// exactly what pg_cron does) so the suite is fast and deterministic rather
/// than waiting on the minute hand.
///
/// Every schedule it creates pays back to the test wallet itself, so value
/// changes form (USDT -> cNGN) instead of leaving. Every schedule is capped
/// with maxRuns and cancelled in teardown, so nothing it creates can fire
/// later.
///
///   deno run --allow-env --allow-read --allow-net scripts/e2e-agent-test.ts
import {
  createPublicClient, createWalletClient, http, parseEventLogs, type Address,
} from "npm:viem@2";
import { privateKeyToAccount } from "npm:viem@2/accounts";
import { celo } from "npm:viem@2/chains";
import { attributionSuffix } from "../supabase/functions/_shared/attribution.ts";

// ---------------------------------------------------------------------------
const env: Record<string, string> = {};
for (const line of (await Deno.readTextFile(".env")).split("\n")) {
  const m = line.match(/^([A-Z0-9_]+)=(.*)$/);
  // Strip trailing ` # comment`, which .env.example uses to annotate addresses.
  // Only " #" (space-hash) counts, so a value that legitimately contains a hash
  // — a URL fragment, a hex secret — survives intact.
  if (m) env[m[1]] = m[2].replace(/\s+#.*$/, "").trim();
}
const need = (k: string) => { const v = env[k]; if (!v) throw new Error(`${k} missing from .env`); return v; };

const RPC = need("CELO_RPC_URL");
const EXECUTOR = need("REMESSO_EXECUTOR_ADDRESS") as Address;
const USDT = need("USDT_ADDRESS") as Address;
const CNGN = need("CNGN_ADDRESS") as Address;
const SB_URL = need("SUPABASE_URL");
const SB_KEY = need("SUPABASE_SERVICE_ROLE_KEY");
const rawKey = need("TESTING_KEY_AGENT_WORKFLOW").replace(/\s/g, "");
const PK = (rawKey.startsWith("0x") ? rawKey : `0x${rawKey}`) as `0x${string}`;

const account = privateKeyToAccount(PK);
const pub = createPublicClient({ chain: celo, transport: http(RPC) });
// Tagged like every other Remesso transaction: an untagged mainnet write can
// never be attributed afterwards, and this suite sends real ones.
const wallet = createWalletClient({
  account, chain: celo, transport: http(RPC),
  ...(attributionSuffix ? { dataSuffix: attributionSuffix } : {}),
});

/// Schedules that existed before the suite started. Never touched — the live
/// schedule #1 belongs to the operator, not to this test.
let PREEXISTING: Set<string>;

const execAbi = [
  { type: "function", name: "createSchedule", stateMutability: "nonpayable",
    inputs: [{name:"destination",type:"address"},{name:"amountIn",type:"uint128"},{name:"interval",type:"uint64"},
             {name:"minRateE6",type:"uint96"},{name:"maxRuns",type:"uint32"},{name:"expiresAt",type:"uint64"},
             {name:"firstRunAt",type:"uint64"},{name:"payoutType",type:"uint8"},
             {name:"token",type:"address"}],
    outputs: [{name:"id",type:"uint256"}] },
  { type: "function", name: "setScheduleActive", stateMutability: "nonpayable",
    inputs: [{name:"id",type:"uint256"},{name:"active",type:"bool"}], outputs: [] },
  { type: "function", name: "cancelSchedule", stateMutability: "nonpayable",
    inputs: [{name:"id",type:"uint256"}], outputs: [] },
  { type: "function", name: "schedulesOf", stateMutability: "view",
    inputs: [{name:"s",type:"address"}], outputs: [{type:"uint256[]"}] },
  { type: "function", name: "getSchedule", stateMutability: "view", inputs: [{name:"id",type:"uint256"}],
    outputs: [{type:"tuple",components:[
      {name:"sender",type:"address"},{name:"interval",type:"uint64"},{name:"maxRuns",type:"uint32"},
      {name:"destination",type:"address"},{name:"nextRunAt",type:"uint64"},{name:"runsExecuted",type:"uint32"},
      {name:"amountIn",type:"uint128"},{name:"minRateE6",type:"uint96"},{name:"poolFee",type:"uint24"},
      {name:"expiresAt",type:"uint64"},{name:"payoutType",type:"uint8"},{name:"active",type:"bool"},
      {name:"cancelled",type:"bool"},{name:"token",type:"address"}]}] },
  { type: "event", name: "ScheduleCreated",
    inputs: [{name:"id",type:"uint256",indexed:true},{name:"sender",type:"address",indexed:true},
             {name:"destination",type:"address",indexed:true},{name:"amountIn",type:"uint128"},
             {name:"interval",type:"uint64"},{name:"minRateE6",type:"uint96"},{name:"maxRuns",type:"uint32"},
             {name:"expiresAt",type:"uint64"},{name:"payoutType",type:"uint8"}] },
] as const;

const erc20 = [
  { type:"function", name:"approve", stateMutability:"nonpayable",
    inputs:[{name:"s",type:"address"},{name:"a",type:"uint256"}], outputs:[{type:"bool"}] },
  { type:"function", name:"allowance", stateMutability:"view",
    inputs:[{name:"o",type:"address"},{name:"s",type:"address"}], outputs:[{type:"uint256"}] },
  { type:"function", name:"balanceOf", stateMutability:"view",
    inputs:[{name:"a",type:"address"}], outputs:[{type:"uint256"}] },
] as const;

// --- supabase helpers ------------------------------------------------------
const sb = async (path: string, init: RequestInit = {}) => {
  const r = await fetch(`${SB_URL}/rest/v1/${path}`, {
    ...init,
    headers: { apikey: SB_KEY, Authorization: `Bearer ${SB_KEY}`,
               "Content-Type": "application/json", Prefer: "return=representation", ...init.headers },
  });
  const t = await r.text();
  if (!r.ok) throw new Error(`supabase ${r.status}: ${t.slice(0, 200)}`);
  return t ? JSON.parse(t) : null;
};

/// Invoke the executor once, the way pg_cron does.
///
/// Retries on a non-JSON body: a cold start or a gateway hiccup returns an HTML
/// error page, and letting that abort the run means a transient blip reads as a
/// failed test.
async function tick(): Promise<{ processed?: number }> {
  for (let i = 0; i < 4; i++) {
    const r = await fetch(`${SB_URL}/functions/v1/execute-due-runs`, {
      method: "POST", headers: { Authorization: `Bearer ${SB_KEY}` },
    });
    const body = await r.text();
    try {
      return JSON.parse(body);
    } catch {
      if (i === 3) throw new Error(`executor returned non-JSON: ${body.slice(0, 120)}`);
      await sleep(2000 * (i + 1));
    }
  }
  return {};
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const u6 = (v: bigint | number | string) => (Number(v) / 1e6).toFixed(6);

// --- results ---------------------------------------------------------------
type Result = { name: string; ok: boolean; detail: string };
const results: Result[] = [];
const check = (name: string, ok: boolean, detail = "") => {
  results.push({ name, ok, detail });
  console.log(`  ${ok ? "PASS" : "FAIL"}  ${name}${detail ? ` — ${detail}` : ""}`);
};

// --- fixtures --------------------------------------------------------------
let senderId: string, recipientId: string, directRecipientId: string;

async function fixtures() {
  const addr = account.address.toLowerCase();
  const existing = await sb(`senders?wallet_address=eq.${addr}&select=id`);
  if (existing?.length) senderId = existing[0].id;
  else {
    // The executor joins schedules -> recipients, so the mirror rows have to
    // exist even though the money path is entirely on chain.
    const u = crypto.randomUUID();
    await sb("rpc/", {}).catch(() => {});
    const s = await sb("senders", { method: "POST", body: JSON.stringify({ auth_user_id: u, wallet_address: addr }) })
      .catch(async () => {
        // auth_user_id has an FK to auth.users; create one via the admin API.
        const au = await fetch(`${SB_URL}/auth/v1/admin/users`, {
          method: "POST",
          headers: { apikey: SB_KEY, Authorization: `Bearer ${SB_KEY}`, "Content-Type": "application/json" },
          body: JSON.stringify({ email: `e2e-${Date.now()}@example.invalid`, email_confirm: true }),
        }).then((r) => r.json());
        return await sb("senders", { method: "POST", body: JSON.stringify({ auth_user_id: au.id, wallet_address: addr }) });
      });
    senderId = s[0].id;
  }
  const r = await sb("recipients", { method: "POST", body: JSON.stringify({
    sender_id: senderId, display_name: "e2e self", payout_type: "wallet", wallet_address: addr }) });
  recipientId = r[0].id;
  const d = await sb("recipients", { method: "POST", body: JSON.stringify({
    sender_id: senderId, display_name: "e2e direct", payout_type: "direct", wallet_address: addr }) });
  directRecipientId = d[0].id;
}

/// Create a schedule on chain and mirror it, the way the frontend does.
async function makeSchedule(opts: {
  amountIn: bigint; minRateE6: bigint; maxRuns: number; label: string;
  active?: boolean; direct?: boolean;
}) {
  const hash = await wallet.writeContract({
    address: EXECUTOR, abi: execAbi, functionName: "createSchedule",
    // V2 rejects expiresAt == 0: a floor that never has to be re-consented is
    // the stale-floor defect the security review found. 30 days is inside
    // MAX_LIFETIME and long enough for the suite.
    args: [
      account.address,
      opts.amountIn,
      3600n,
      opts.minRateE6,
      opts.maxRuns,
      BigInt(Math.floor(Date.now() / 1000) + 30 * 24 * 3600),
      0n,
      opts.direct ? 2 : 0, // 2 = Direct (no swap), 0 = Wallet (swap to cNGN)
      USDT,
    ],
  });
  const receipt = await pub.waitForTransactionReceipt({ hash });
  const [ev] = parseEventLogs({ abi: execAbi, eventName: "ScheduleCreated", logs: receipt.logs });
  const onchainId = ev.args.id.toString();
  const row = await sb("schedules", { method: "POST", body: JSON.stringify({
    sender_id: senderId,
    recipient_id: opts.direct ? directRecipientId : recipientId,
    onchain_id: onchainId,
    executor_address: EXECUTOR, token_address: USDT,
    amount_in: opts.amountIn.toString(), interval_seconds: 3600,
    min_rate_e6: opts.minRateE6.toString(), max_runs: opts.maxRuns,
    status: "active", label: opts.label, next_run_at: new Date().toISOString() }) });
  return { onchainId, rowId: row[0].id as string };
}

async function runsFor(rowId: string) {
  return await sb(`runs?schedule_id=eq.${rowId}&select=status,failure_reason,amount_out,tx_hash,attempt&order=attempt.desc`);
}

// ---------------------------------------------------------------------------
// The suite
// ---------------------------------------------------------------------------
const created: string[] = [];          // on-chain ids this run created
const rows: string[] = [];             // db row ids this run created
let startAllowance = 0n;   // what the wallet had before the suite; restored in teardown
let workingAllowance = 0n; // what the suite needs while it runs

async function main() {
  console.log("\nRemesso executor — end-to-end agent test\n");
  console.log(`wallet   ${account.address}`);

  const before = {
    usdt: await pub.readContract({ address: USDT, abi: erc20, functionName: "balanceOf", args: [account.address] }),
    cngn: await pub.readContract({ address: CNGN, abi: erc20, functionName: "balanceOf", args: [account.address] }),
    celo: await pub.getBalance({ address: account.address }),
  };
  startAllowance = await pub.readContract({ address: USDT, abi: erc20, functionName: "allowance", args: [account.address, EXECUTOR] });
  console.log(`before   USDT ${u6(before.usdt)}  cNGN ${u6(before.cngn)}  CELO ${(Number(before.celo)/1e18).toFixed(4)}  allowance ${u6(startAllowance)}`);

  // Provision the allowance the suite needs rather than depending on an
  // approve run beforehand — a just-mined approve can still read as 0 from a
  // node that has not caught up, which silently turns every execution test into
  // a skip. Teardown restores whatever was here first.
  const NEEDED = 1_000_000n; // 10 runs x 0.1 USDT, with room to spare
  if (startAllowance < NEEDED) {
    const h = await wallet.writeContract({
      address: USDT, abi: erc20, functionName: "approve", args: [EXECUTOR, NEEDED],
    });
    await pub.waitForTransactionReceipt({ hash: h });
    let seen = 0n;
    for (let i = 0; i < 10 && seen < NEEDED; i++) {
      seen = await pub.readContract({
        address: USDT, abi: erc20, functionName: "allowance", args: [account.address, EXECUTOR],
      });
      if (seen < NEEDED) await sleep(1000);
    }
    if (seen < NEEDED) throw new Error(`allowance did not settle: ${u6(seen)}`);
    workingAllowance = seen;
    console.log(`         provisioned allowance ${u6(seen)} for the suite`);
  } else {
    workingAllowance = startAllowance;
  }

  PREEXISTING = new Set((await pub.readContract({
    address: EXECUTOR, abi: execAbi, functionName: "schedulesOf", args: [account.address],
  }) as readonly bigint[]).map(String));
  console.log(`protected: pre-existing schedules ${[...PREEXISTING].join(", ") || "(none)"} — never touched\n`);

  await fixtures();

  // -- 1. underfunded ------------------------------------------------------
  // amountIn far above balance, so runnability().funded is false. The agent
  // must decline without spending gas rather than reverting on chain.
  {
    const s = await makeSchedule({ amountIn: 100_000_000n, minRateE6: 1_000_000_000n, maxRuns: 1, label: "e2e underfunded" });
    created.push(s.onchainId); rows.push(s.rowId);
    await tick(); await sleep(1500);
    const [r] = await runsFor(s.rowId);
    check("1 underfunded sender is skipped, no tx",
      r?.status === "skipped" && /funding wallet is short/.test(r.failure_reason ?? "") && !r.tx_hash,
      r ? `${r.status}: ${r.failure_reason}` : "no run row");
  }

  // -- 2. backoff ----------------------------------------------------------
  // The same schedule must not be retried on the very next tick. Without
  // backoff a permanently-failing schedule burns a run row every minute.
  {
    const rowId = rows[rows.length - 1];
    const n1 = (await runsFor(rowId)).length;
    await tick(); await sleep(1500);
    const n2 = (await runsFor(rowId)).length;
    check("2 backoff suppresses an immediate retry", n2 === n1, `runs ${n1} -> ${n2} across two ticks`);
  }

  // -- 3. floor rate -------------------------------------------------------
  // A floor above market must make the agent decline. This is the guard that
  // stops a compromised backend handing the trade away cheaply.
  {
    const s = await makeSchedule({ amountIn: 100_000n, minRateE6: 3_000_000_000n, maxRuns: 1, label: "e2e floor" });
    created.push(s.onchainId); rows.push(s.rowId);
    await tick(); await sleep(2500);
    const [r] = await runsFor(s.rowId);
    check("3 rate floor above market blocks the run",
      r && r.status !== "delivered" && !r.tx_hash,
      r ? `${r.status}: ${(r.failure_reason ?? "").slice(0, 90)}` : "no run row");
  }

  // -- 4. revoked allowance ------------------------------------------------
  {
    const h = await wallet.writeContract({ address: USDT, abi: erc20, functionName: "approve", args: [EXECUTOR, 0n] });
    await pub.waitForTransactionReceipt({ hash: h });
    const s = await makeSchedule({ amountIn: 100_000n, minRateE6: 1_000_000_000n, maxRuns: 1, label: "e2e revoked" });
    created.push(s.onchainId); rows.push(s.rowId);
    await tick(); await sleep(1500);
    const [r] = await runsFor(s.rowId);
    check("4 revoked allowance is skipped",
      r?.status === "skipped" && /allowance revoked/.test(r.failure_reason ?? ""),
      r ? `${r.status}: ${r.failure_reason}` : "no run row");
    const h2 = await wallet.writeContract({
      address: USDT, abi: erc20, functionName: "approve", args: [EXECUTOR, workingAllowance],
    });
    await pub.waitForTransactionReceipt({ hash: h2 });
  }

  // -- 5. pause ------------------------------------------------------------
  {
    const s = await makeSchedule({ amountIn: 100_000n, minRateE6: 1_000_000_000n, maxRuns: 1, label: "e2e paused" });
    created.push(s.onchainId); rows.push(s.rowId);
    const h = await wallet.writeContract({ address: EXECUTOR, abi: execAbi, functionName: "setScheduleActive", args: [BigInt(s.onchainId), false] });
    await pub.waitForTransactionReceipt({ hash: h });
    await tick(); await sleep(1500);
    const [r] = await runsFor(s.rowId);
    check("5 sender's pause is honoured",
      r?.status === "skipped" && /not due on-chain/.test(r.failure_reason ?? ""),
      r ? `${r.status}: ${r.failure_reason}` : "no run row");
  }

  // -- 6 & 7. maxRuns + parallel -------------------------------------------
  // Four schedules due at once. This is the first time concurrency has been
  // above one: the prepare phase runs them in parallel while settle must stay
  // sequential, because all four are signed by the same executor EOA and
  // parallel broadcasts would collide on the nonce.
  {
    const batch = [];
    for (let i = 0; i < 4; i++) {
      const s = await makeSchedule({ amountIn: 100_000n, minRateE6: 1_200_000_000n, maxRuns: 1, label: `e2e parallel ${i + 1}` });
      created.push(s.onchainId); rows.push(s.rowId); batch.push(s);
    }
    const res = await tick();
    await sleep(4000);
    const all = await Promise.all(batch.map((b) => runsFor(b.rowId)));
    const delivered = all.filter((rs) => rs[0]?.status === "delivered");
    const hashes = new Set(delivered.map((rs) => rs[0].tx_hash));
    const why = all.map((rs) => rs[0] ? `${rs[0].status}:${(rs[0].failure_reason ?? "").slice(0, 40)}` : "no row");
    check("6 four concurrent schedules all execute",
      delivered.length === 4,
      `${delivered.length}/4 delivered (processed ${res.processed})${delivered.length < 4 ? " — " + why.join(" | ") : ""}`);
    check("7 each run is a distinct transaction — no nonce collision",
      hashes.size === delivered.length && delivered.length > 0, `${hashes.size} distinct tx hashes`);

    const caps = await Promise.all(batch.map((b) => pub.readContract({
      address: EXECUTOR, abi: execAbi, functionName: "getSchedule", args: [BigInt(b.onchainId)] }) as Promise<any>));
    check("8 maxRuns=1 retires each schedule on chain",
      caps.every((c) => c.runsExecuted === 1 && c.active === false),
      caps.map((c) => `${c.runsExecuted}run/active=${c.active}`).join(" "));
  }

  // -- 8b. the Direct rail -------------------------------------------------
  // No swap: the recipient receives the funding asset itself. This is the rail
  // that works in MiniPay, where cNGN is invisible.
  {
    const before = await pub.readContract({
      address: USDT, abi: erc20, functionName: "balanceOf", args: [account.address],
    });
    const s2 = await makeSchedule({
      amountIn: 100_000n, minRateE6: 0n, maxRuns: 1, label: "e2e direct", direct: true,
    });
    created.push(s2.onchainId); rows.push(s2.rowId);
    await tick(); await sleep(4000);
    const [r] = await runsFor(s2.rowId);
    const after = await pub.readContract({
      address: USDT, abi: erc20, functionName: "balanceOf", args: [account.address],
    });
    // Destination is the test wallet itself, so a Direct run is a self-transfer:
    // the balance must be unchanged, and no cNGN can have been produced.
    check("8b Direct rail delivers the funding asset, no swap",
      r?.status === "delivered" && after === before,
      r ? `${r.status} ${r.failure_reason ?? ""} | USDT ${u6(before)} -> ${u6(after)}` : "no run row");
  }

  // -- 9. idempotency ------------------------------------------------------
  // Two ticks in the same window must not double-spend a schedule.
  {
    const s = await makeSchedule({ amountIn: 100_000n, minRateE6: 1_200_000_000n, maxRuns: 1, label: "e2e idempotent" });
    created.push(s.onchainId); rows.push(s.rowId);
    await Promise.all([tick(), tick()]);
    await sleep(5000);
    const rs = await runsFor(s.rowId);
    const delivered = rs.filter((r: any) => r.status === "delivered");
    check("9 concurrent ticks cannot double-run a schedule",
      delivered.length <= 1, `${rs.length} run row(s), ${delivered.length} delivered`);
  }

  await teardown(before);
}

async function teardown(before: { usdt: bigint; cngn: bigint; celo: bigint }) {
  console.log("\n  teardown");
  for (const id of created) {
    if (PREEXISTING.has(id)) { console.log(`    skip ${id} — pre-existing, not ours`); continue; }
    try {
      const h = await wallet.writeContract({ address: EXECUTOR, abi: execAbi, functionName: "cancelSchedule", args: [BigInt(id)] });
      await pub.waitForTransactionReceipt({ hash: h });
    } catch (e) { console.log(`    could not cancel ${id}: ${(e as Error).message.split("\n")[0]}`); }
  }
  await sb(`schedules?id=in.(${rows.join(",")})`, { method: "DELETE", headers: { Prefer: "return=minimal" } }).catch(() => {});
  await sb(`recipients?id=eq.${recipientId}`, { method: "DELETE", headers: { Prefer: "return=minimal" } }).catch(() => {});

  const now = await pub.readContract({ address: USDT, abi: erc20, functionName: "allowance", args: [account.address, EXECUTOR] });
  if (now !== startAllowance) {
    const h = await wallet.writeContract({ address: USDT, abi: erc20, functionName: "approve", args: [EXECUTOR, startAllowance] });
    await pub.waitForTransactionReceipt({ hash: h });
  }

  const after = {
    usdt: await pub.readContract({ address: USDT, abi: erc20, functionName: "balanceOf", args: [account.address] }),
    cngn: await pub.readContract({ address: CNGN, abi: erc20, functionName: "balanceOf", args: [account.address] }),
    celo: await pub.getBalance({ address: account.address }),
    allowance: await pub.readContract({ address: USDT, abi: erc20, functionName: "allowance", args: [account.address, EXECUTOR] }),
  };
  console.log(`\n  balances   USDT ${u6(before.usdt)} -> ${u6(after.usdt)}`);
  console.log(`             cNGN ${u6(before.cngn)} -> ${u6(after.cngn)}`);
  console.log(`             CELO ${(Number(before.celo)/1e18).toFixed(4)} -> ${(Number(after.celo)/1e18).toFixed(4)}  (gas)`);
  console.log(`             allowance restored to ${u6(after.allowance)} (was ${u6(startAllowance)})`);

  const live = (await pub.readContract({ address: EXECUTOR, abi: execAbi, functionName: "schedulesOf", args: [account.address] }) as readonly bigint[]).map(String);
  const leaked = live.filter((id) => created.includes(id) && !PREEXISTING.has(id));
  const stillActive: string[] = [];
  for (const id of leaked) {
    const s = await pub.readContract({ address: EXECUTOR, abi: execAbi, functionName: "getSchedule", args: [BigInt(id)] }) as any;
    if (s.active && !s.cancelled) stillActive.push(id);
  }
  check("10 no test schedule left able to fire", stillActive.length === 0,
    stillActive.length ? `STILL ACTIVE: ${stillActive.join(", ")}` : "all cancelled or retired");

  const pass = results.filter((r) => r.ok).length;
  console.log(`\n  ${pass}/${results.length} passed\n`);
  Deno.exit(pass === results.length ? 0 : 1);
}

await main();
