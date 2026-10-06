/// Celo attribution tag (ERC-8021) for every transaction Remesso sends.
///
/// A short suffix appended after the calldata. The EVM discards trailing bytes,
/// so the contract sees exactly the arguments it always saw and execution is
/// unchanged — the suffix only lets Celo trace a transaction back to the app
/// that produced it. That data feeds ecosystem reward distribution and cannot
/// be claimed retroactively: an untagged transaction is unattributed forever.
///
/// Encoded here rather than via `@celo/attribution-tags`, which the frontend
/// does use. Schema 0 is four concatenated pieces and nothing more, and this
/// module sits in the path of every remittance — a dependency there earns its
/// place or stays out. `attribution.test.ts` pins the output to the SDK's own.
///
/// One fixed code, not the SDK's hostname-derived one: the executor has no
/// hostname, and a hostname code would change the moment the frontend moves
/// off ngrok onto a real domain, splitting one app's history in two.
/// `remesso` is a custom code — it tags immediately, and having it credited on
/// the attribution dashboard is a registry step with the Celo team.

/// Several codes, one suffix. `remesso` is the app's own history; a hackathon
/// credits only the code it issued (Agents on Open Rails: `celo_5cd35ca55baf`,
/// assigned by Loops at enrolment). ERC-8021 Schema 0 carries a list as one
/// comma-joined code field, which the SDK's `withAttribution([...])` writes
/// and `verifyTx` splits — so each code is credited, neither displaces the
/// other, and dropping the event code later is an env change, not a redeploy
/// of anything on-chain.

/// `[code:N][length:1][schema:1][marker:16]`
const MARKER = "80218021802180218021802180218021";
const SCHEMA_0 = "00";

/// Comma-separated in `ATTRIBUTION_CODE`. The default carries both, so a
/// deploy that forgets the variable still tags for the event.
export const ATTRIBUTION_CODES = (Deno.env.get("ATTRIBUTION_CODE") ?? "remesso,celo_5cd35ca55baf")
  .toLowerCase()
  .split(",")
  .map((c) => c.trim())
  .filter(Boolean);

/// The app's own code, first by convention — what `/agent` advertises.
export const ATTRIBUTION_CODE = ATTRIBUTION_CODES[0] ?? "remesso";

/// The suffix for one code or several, or `undefined` if none is usable.
///
/// Never throws: a malformed tag must not be the reason a remittance fails to
/// go out. A bad code is dropped and the rest still tag — a typo in one must
/// not cost the other its credit, since an untagged transaction stays
/// untagged forever. A comma inside a single code is refused rather than read
/// as a list; a list is passed as an array.
export function suffixFor(codes: string | readonly string[]): `0x${string}` | undefined {
  const list = (typeof codes === "string" ? [codes] : codes).filter((code) => {
    if (/^[a-z0-9_]{1,32}$/.test(code)) return true;
    console.error("attribution code must be 1-32 of [a-z0-9_]:", code);
    return false;
  });
  if (list.length === 0) return undefined;
  const field = list.join(",");
  // The length is one byte.
  if (field.length > 255) return undefined;
  const hex = [...new TextEncoder().encode(field)]
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
  const length = field.length.toString(16).padStart(2, "0");
  return `0x${hex}${length}${SCHEMA_0}${MARKER}`;
}

export const attributionSuffix = suffixFor(ATTRIBUTION_CODES);
