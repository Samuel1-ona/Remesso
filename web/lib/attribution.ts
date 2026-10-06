"use client";

import { toDataSuffix } from "@celo/attribution-tags";
import type { Hex } from "viem";

/// Celo attribution tag (ERC-8021) for transactions the sender signs.
///
/// Appended after the calldata, discarded by the EVM, invisible to the
/// contract — it only lets Celo trace a transaction back to the app that
/// caused it, which is what feeds ecosystem reward distribution. Untagged
/// transactions cannot be claimed later, so this belongs on every write.
///
/// The same fixed code the executor uses (`_shared/attribution.ts`), not the
/// SDK's hostname-derived one: one app should have one code, and a hostname
/// code would change when this moves off ngrok onto a real domain.
///
/// Comma-separated, like the backend's: `remesso` for the app's own history,
/// plus `celo_5cd35ca55baf`, the code Loops issued for Agents on Open Rails —
/// the hackathon credits only that one. The SDK writes a list as one Schema 0
/// suffix that `verifyTx` reads back as both codes.
const CODES = (process.env.NEXT_PUBLIC_ATTRIBUTION_CODE ?? "remesso,celo_5cd35ca55baf")
  .toLowerCase()
  .split(",")
  .map((c) => c.trim())
  .filter(Boolean);

let cached: Hex | null | undefined;

/// `undefined` if the code is unusable — an untagged transaction is a lost
/// attribution, a thrown error is a lost remittance.
export function attributionSuffix(): Hex | undefined {
  if (cached !== undefined) return cached ?? undefined;
  try {
    cached = toDataSuffix(CODES) as Hex;
  } catch (e) {
    console.error("attribution suffix unavailable:", (e as Error).message);
    cached = null;
  }
  return cached ?? undefined;
}
