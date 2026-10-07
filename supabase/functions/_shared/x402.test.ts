/// Pins our x402 builder-code declaration to the reference implementation.
///
/// `declareBuilderCodeExtension` from `@x402/extensions` is what the reference
/// middleware puts in a 402; the facilitator reads the client's echo of it to
/// write our ERC-8021 tag on settlements it submits. A shape it does not
/// recognise is silently untagged — the same failure as no declaration.
///
///   deno test --allow-env --allow-read --allow-net supabase/functions/_shared/x402.test.ts
import { assertEquals } from "jsr:@std/assert@1";
import { declareBuilderCodeExtension } from "npm:@x402/extensions@2.28.0/builder-code";
import { builderCodeExtension, paymentRequired } from "./x402.ts";

Deno.test("matches declareBuilderCodeExtension exactly", () => {
  // Compared as JSON: what matters is the document on the wire, not the
  // package's TypeScript types.
  const json = (x: unknown) => JSON.parse(JSON.stringify(x));
  assertEquals(
    json(builderCodeExtension(["remesso", "celo_5cd35ca55baf"])!["builder-code"]),
    json(declareBuilderCodeExtension("remesso", ["celo_5cd35ca55baf"])),
  );
  assertEquals(
    json(builderCodeExtension(["remesso"])!["builder-code"]),
    json(declareBuilderCodeExtension("remesso")),
  );
});

Deno.test("drops unusable codes rather than declaring them", () => {
  assertEquals(builderCodeExtension(["Bad Code"]), undefined);
  assertEquals(
    builderCodeExtension(["Bad", "remesso"])!["builder-code"].info,
    { a: "remesso" },
  );
});

Deno.test("rides in the v2 header and stays out of the v1 body", () => {
  const { body, headers } = paymentRequired([], { url: "https://x", description: "", mimeType: "" } as never);
  const v2 = JSON.parse(atob(headers["PAYMENT-REQUIRED"]));
  assertEquals(typeof v2.extensions["builder-code"].info.a, "string");
  // v1 has no extensions field; adding one would be a field a strict v1
  // client has never seen.
  assertEquals("extensions" in (body as Record<string, unknown>), false);
});
