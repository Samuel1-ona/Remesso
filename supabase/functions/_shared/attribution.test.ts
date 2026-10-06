/// Pins our ERC-8021 encoder to the output of Celo's own SDK.
///
/// The expected values below were produced by `@celo/attribution-tags` 0.5.0
/// (`toDataSuffix(code)`), which the frontend imports directly. The backend
/// encodes the suffix itself — see attribution.ts — so this is what keeps the
/// two identical: one wrong byte and Celo's indexer sees no tag at all, which
/// fails silently and forever.
///
///   deno test --allow-env supabase/functions/_shared/attribution.test.ts
import { assertEquals } from "jsr:@std/assert@1";
import { suffixFor } from "./attribution.ts";

Deno.test("matches the SDK byte for byte", () => {
  assertEquals(suffixFor("remesso"), "0x72656d6573736f070080218021802180218021802180218021");
  assertEquals(
    suffixFor("celo_test1234"),
    "0x63656c6f5f74657374313233340d0080218021802180218021802180218021",
  );
  // The code Loops issued for Agents on Open Rails, alone — equal to the
  // `celo.dataSuffix` that `loops project get` returns for the entry.
  assertEquals(
    suffixFor("celo_5cd35ca55baf"),
    "0x63656c6f5f356364333563613535626166110080218021802180218021802180218021",
  );
});

Deno.test("carries several codes the way the SDK does", () => {
  // `toDataSuffix(["remesso", "celo_5cd35ca55baf"])` from 0.5.0, which
  // `fromDataSuffix` decodes back to both codes. This is what every Remesso
  // transaction carries during the hackathon.
  assertEquals(
    suffixFor(["remesso", "celo_5cd35ca55baf"]),
    "0x72656d6573736f2c63656c6f5f356364333563613535626166190080218021802180218021802180218021",
  );
  assertEquals(suffixFor([]), undefined);
  assertEquals(
    suffixFor(["remesso", "Bad"]),
    suffixFor("remesso"),
    "a bad code is dropped, not allowed to untag the rest",
  );
});

Deno.test("carries the marker and schema the indexer looks for", () => {
  const s = suffixFor("remesso")!;
  assertEquals(s.slice(-32), "80218021802180218021802180218021", "16-byte ERC-8021 marker");
  assertEquals(s.slice(-34, -32), "00", "schema 0");
  assertEquals(s.slice(-36, -34), "07", "length of 'remesso'");
});

Deno.test("refuses a code the encoder cannot represent", () => {
  // Uppercase, punctuation, spaces and over-long codes are all rejected by the
  // spec's charset. Returning undefined leaves the transaction untagged rather
  // than writing bytes an indexer would discard anyway.
  for (const bad of ["Remesso", "remesso pay", "remesso,app", "", "x".repeat(33)]) {
    assertEquals(suffixFor(bad), undefined, `should reject ${JSON.stringify(bad)}`);
  }
});
