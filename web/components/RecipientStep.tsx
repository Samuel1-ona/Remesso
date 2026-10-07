"use client";

import { useEffect, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { isAddress } from "viem";
import { fetchBanks, verifyAccount, type AccountDetails } from "@/lib/api";
import { BANK_PAYOUTS_ENABLED, CNGN_RAILS_ENABLED, DIRECT_TOKENS, type TokenInfo } from "@/lib/config";
import { isMiniPay } from "@/lib/wagmi";
import { useAllowedDirectTokens } from "@/lib/hooks";
import { ripioRampUrl } from "@/lib/ripio";
import { useAccount } from "wagmi";
import type { PayoutKind } from "@/lib/types";

export type RecipientDraft = {
  displayName: string;
  payoutType: PayoutKind;
  walletAddress: string;
  bankCode: string;
  accountNumber: string;
  accountName: string;
  /// Direct rail only: which stablecoin the recipient actually receives.
  token: TokenInfo;
};

export const emptyRecipient: RecipientDraft = {
  displayName: "",
  payoutType: "direct",
  walletAddress: "",
  bankCode: "",
  accountNumber: "",
  accountName: "",
  token: DIRECT_TOKENS[0], // USDT — the one every MiniPay user already holds
};

export function recipientIsComplete(r: RecipientDraft): boolean {
  if (!r.displayName.trim()) return false;
  if (r.payoutType === "ngn_bank") {
    return Boolean(r.bankCode && /^[0-9]{10}$/.test(r.accountNumber) && r.accountName);
  }
  return isAddress(r.walletAddress);
}

export function RecipientStep({
  value,
  onChange,
}: {
  value: RecipientDraft;
  onChange: (r: RecipientDraft) => void;
}) {
  const allowed = useAllowedDirectTokens();
  const { address: sender } = useAccount();
  const set = (patch: Partial<RecipientDraft>) => onChange({ ...value, ...patch });
  const addressInvalid = Boolean(value.walletAddress) && !isAddress(value.walletAddress);

  return (
    <div className="space-y-6">
      <div>
        <label className="label" htmlFor="recipient-name">
          Who is this for?
        </label>
        <input
          id="recipient-name"
          className="field"
          placeholder="Mum"
          autoComplete="off"
          value={value.displayName}
          onChange={(e) => set({ displayName: e.target.value })}
        />
      </div>

      <div>
        {/* With the naira rails off there is one way to be paid, and a picker
            with a single option is a question that answers itself. The token
            tiles below are the only choice left, so they carry the heading. */}
        {CNGN_RAILS_ENABLED && (
          <>
            <p className="label">How should they receive it?</p>
            <div className="grid grid-cols-3 gap-2">
              <Choice
                active={value.payoutType === "direct"}
                onClick={() => set({ payoutType: "direct" })}
                title="Stablecoin"
                subtitle="Shows in MiniPay"
              />
              <Choice
                active={value.payoutType === "wallet"}
                onClick={() => set({ payoutType: "wallet" })}
                title="cNGN"
                subtitle="Other wallets"
              />
              <Choice
                active={value.payoutType === "ngn_bank"}
                onClick={() => BANK_PAYOUTS_ENABLED && set({ payoutType: "ngn_bank" })}
                disabled={!BANK_PAYOUTS_ENABLED}
                title="Bank"
                subtitle={BANK_PAYOUTS_ENABLED ? "Naira account" : "Coming soon"}
              />
            </div>
          </>
        )}

        {value.payoutType === "direct" && (
          <div className={CNGN_RAILS_ENABLED ? "mt-4" : ""}>
            <p className="label">What should they receive?</p>
            <div className="grid grid-cols-3 gap-2">
              {allowed.map((t) => (
                <button
                  key={t.symbol}
                  type="button"
                  onClick={() => set({ token: t })}
                  className={`tile min-h-11 text-center text-[15px] font-medium ${
                    value.token.symbol === t.symbol ? "tile-on" : ""
                  }`}
                  aria-pressed={value.token.symbol === t.symbol}
                >
                  {t.symbol}
                </button>
              ))}
            </div>
            {value.token.miniPayVisible ? (
              <p className="hint">
                You send {value.token.symbol}, they receive {value.token.symbol}. No conversion,
                and it appears in their MiniPay balance straight away.
              </p>
            ) : (
              // Same honesty as the cNGN warning below: MiniPay shows none of
              // the wFIAT, and has no way to add a token.
              <>
                <p className="notice-warn mt-3">
                  You send {value.token.symbol}, they receive {value.token.symbol}, with no
                  conversion. MiniPay does not show {value.token.symbol}, so they need a wallet
                  that does.
                </p>
                <RipioLinks token={value.token} sender={sender} />
              </>
            )}
          </div>
        )}

        {/* The honest reason the cNGN option is second, not first. */}
        {value.payoutType === "wallet" && (
          <p className="notice-warn mt-3">
            MiniPay only shows USDT, USDC and cUSD. Someone paid in cNGN will see nothing
            in MiniPay, and it has no way to add a token. Choose Stablecoin unless they use
            a different wallet.
          </p>
        )}
        {/* The reason is in the README; the sender only needs to know it is
            not them. */}
        {!BANK_PAYOUTS_ENABLED && value.payoutType !== "wallet" && (
          <p className="hint">Paying straight into a naira bank account is coming soon.</p>
        )}
      </div>

      {value.payoutType !== "ngn_bank" ? (
        <div>
          <label className="label" htmlFor="recipient-address">
            Their wallet address
          </label>
          <div className="relative">
            <input
              id="recipient-address"
              className={`field mono pr-20 ${addressInvalid ? "field-invalid" : ""}`}
              placeholder="0x…"
              spellCheck={false}
              autoComplete="off"
              autoCapitalize="none"
              inputMode="text"
              value={value.walletAddress}
              onChange={(e) => set({ walletAddress: e.target.value.trim() })}
              aria-invalid={addressInvalid}
            />
            <PasteButton onPaste={(t) => set({ walletAddress: t })} />
          </div>
          {addressInvalid ? (
            <p className="hint text-danger">That doesn&rsquo;t look like a complete address.</p>
          ) : isAddress(value.walletAddress) ? (
            <p className="hint text-naira">Looks right.</p>
          ) : (
            <p className="hint">
              Ask them to share it from their wallet. Once you sign, this address is fixed —
              changing it later means a new schedule, which is the point.
            </p>
          )}
        </div>
      ) : (
        <BankFields value={value} set={set} />
      )}
    </div>
  );
}

/// Typing 42 hex characters on a phone is the worst moment in this flow, so
/// the clipboard is offered first. Clipboard read needs a user gesture and
/// permission; if either is missing the button just does nothing visible and
/// the field is still there to type into.
function PasteButton({ onPaste }: { onPaste: (text: string) => void }) {
  const [done, setDone] = useState(false);
  if (typeof navigator === "undefined" || !navigator.clipboard?.readText) return null;
  return (
    <button
      type="button"
      className="absolute right-1.5 top-1/2 -translate-y-1/2 rounded-lg bg-sand px-3 py-1.5 text-[13px] font-medium text-ink-2 transition hover:bg-line/70 active:scale-95"
      onClick={async () => {
        try {
          const t = (await navigator.clipboard.readText()).trim();
          if (t) {
            onPaste(t);
            setDone(true);
            setTimeout(() => setDone(false), 1200);
          }
        } catch {
          /* permission denied — the field still accepts typing */
        }
      }}
    >
      {done ? "Pasted" : "Paste"}
    </button>
  );
}

function BankFields({
  value,
  set,
}: {
  value: RecipientDraft;
  set: (p: Partial<RecipientDraft>) => void;
}) {
  const banks = useQuery({
    queryKey: ["banks"],
    queryFn: fetchBanks,
    // The list changes a few times a year and the API allows 20 calls a minute.
    staleTime: 24 * 60 * 60 * 1000,
    retry: 1,
  });

  const [checking, setChecking] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Any edit invalidates a previous verification: the name on file belongs to
  // the exact bank-and-number pair that was checked, not to the form.
  useEffect(() => {
    if (value.accountName) set({ accountName: "" });
    setError(null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [value.bankCode, value.accountNumber]);

  const canCheck = Boolean(value.bankCode) && /^[0-9]{10}$/.test(value.accountNumber);

  async function check() {
    setChecking(true);
    setError(null);
    try {
      const details: AccountDetails = await verifyAccount(value.bankCode, value.accountNumber);
      set({ accountName: details.accountName });
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setChecking(false);
    }
  }

  return (
    <div className="space-y-5">
      <div>
        <label className="label" htmlFor="bank">Bank</label>
        <select
          id="bank"
          className="field appearance-none"
          value={value.bankCode}
          disabled={banks.isLoading || banks.isError}
          onChange={(e) => set({ bankCode: e.target.value })}
        >
          <option value="">
            {banks.isLoading ? "Loading banks…" : banks.isError ? "Could not load banks" : "Choose a bank"}
          </option>
          {banks.data?.map((b) => (
            <option key={b.code} value={b.code}>
              {b.name}
            </option>
          ))}
        </select>
        {banks.isError && <p className="hint text-danger">{(banks.error as Error).message}</p>}
      </div>

      <div>
        <label className="label" htmlFor="account-number">Account number</label>
        <input
          id="account-number"
          className="field mono text-lg"
          inputMode="numeric"
          maxLength={10}
          placeholder="0123456789"
          value={value.accountNumber}
          onChange={(e) => set({ accountNumber: e.target.value.replace(/\D/g, "").slice(0, 10) })}
        />
      </div>

      {/* The verified-name card is the moment Opay and Moniepoint users look
          for before sending anything. It gets the naira green. */}
      {value.accountName ? (
        <div className="animate-rise rounded-xl bg-naira-soft px-4 py-3.5">
          <p className="eyebrow text-naira">Account name</p>
          <p className="mt-1 font-display text-[22px] leading-tight text-ink">{value.accountName}</p>
          <p className="mt-1.5 text-[13px] leading-relaxed text-ink-2">
            Make sure this is the right person. Naira sent to a bank account cannot be
            recalled.
          </p>
        </div>
      ) : (
        <button className="btn-ink w-full" disabled={!canCheck || checking} onClick={check}>
          {checking ? "Checking with the bank…" : "Verify account"}
        </button>
      )}

      {error && <p className="notice-danger">{error}</p>}
    </div>
  );
}

function Choice({
  active,
  disabled,
  onClick,
  title,
  subtitle,
}: {
  active: boolean;
  disabled?: boolean;
  onClick: () => void;
  title: string;
  subtitle: string;
}) {
  return (
    <button
      type="button"
      disabled={disabled}
      onClick={onClick}
      aria-pressed={active}
      className={`tile h-full ${active ? "tile-on" : ""}`}
    >
      <span className="block text-[15px] font-medium text-ink">{title}</span>
      <span className={`mt-0.5 block text-[12px] leading-snug ${active ? "text-clay-deep" : "text-ink-3"}`}>
        {subtitle}
      </span>
    </button>
  );
}

/// Where the pesos come from and where they go: Ripio's hosted ramp, in and
/// out of a local bank account. Absent for any token Ripio does not ramp.
function RipioLinks({ token, sender }: { token: TokenInfo; sender?: string }) {
  const buy = ripioRampUrl("on", token, { address: sender });
  const cashOut = ripioRampUrl("off", token);
  if (!buy || !cashOut) return null;
  return (
    <p className="hint">
      No {token.symbol} yet?{" "}
      <a href={buy} target="_blank" rel="noopener noreferrer" className="underline">
        Buy it with Ripio
      </a>{" "}
      from a local bank account. They can{" "}
      <a href={cashOut} target="_blank" rel="noopener noreferrer" className="underline">
        cash out at Ripio
      </a>{" "}
      the same way.
    </p>
  );
}
