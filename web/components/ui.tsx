"use client";

import { useEffect, useState, type ReactNode } from "react";

/// Small shared pieces. Each is here because two screens needed it, not
/// because a design system was planned.

/// The primary action, pinned to the bottom of the phone where the thumb is.
/// Pages that use it add `pb-bar` so content can scroll out from under it.
export function ActionBar({ children, note }: { children: ReactNode; note?: ReactNode }) {
  return (
    <div className="fixed inset-x-0 bottom-0 z-20">
      <div className="mx-auto max-w-lg border-t border-line/60 bg-paper/90 px-4 pb-[max(1rem,env(safe-area-inset-bottom))] pt-3 shadow-bar backdrop-blur-md">
        {note && <div className="mb-2 text-center text-[13px] text-ink-2">{note}</div>}
        <div className="flex gap-2">{children}</div>
      </div>
    </div>
  );
}

/// A block of the page that has not arrived yet, in the shape it will take.
export function Skeleton({ className = "" }: { className?: string }) {
  return <div className={`skeleton ${className}`} aria-hidden />;
}

/// A bottom sheet for a decision that cannot be undone. Not a modal in the
/// desktop sense: it rises from where the thumb already is, and the page stays
/// visible behind it so the sender keeps their place.
export function Sheet({
  open,
  onClose,
  title,
  children,
}: {
  open: boolean;
  onClose: () => void;
  title: string;
  children: ReactNode;
}) {
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", onKey);
    document.body.style.overflow = "hidden";
    return () => {
      window.removeEventListener("keydown", onKey);
      document.body.style.overflow = "";
    };
  }, [open, onClose]);

  if (!open) return null;
  return (
    <div className="fixed inset-0 z-30 flex items-end justify-center" role="dialog" aria-modal aria-label={title}>
      <button
        type="button"
        className="absolute inset-0 animate-fade bg-ink/40"
        onClick={onClose}
        aria-label="Close"
      />
      <div className="relative w-full max-w-lg animate-slide-up rounded-t-3xl bg-surface px-5 pb-[max(1.25rem,env(safe-area-inset-bottom))] pt-3 shadow-lift">
        <div className="mx-auto mb-4 h-1 w-10 rounded-full bg-line" aria-hidden />
        <h2 className="font-display text-[22px] leading-tight text-ink">{title}</h2>
        <div className="mt-3">{children}</div>
      </div>
    </div>
  );
}

/// An amount with its unit set smaller and quieter. The number is the point.
export function Amount({
  value,
  unit,
  size = "md",
  tone = "ink",
  className = "",
}: {
  value: string;
  unit?: string;
  size?: "sm" | "md" | "lg" | "hero";
  tone?: "ink" | "naira" | "muted";
  className?: string;
}) {
  const sizes = {
    sm: "text-[15px]",
    md: "text-lg",
    lg: "text-2xl",
    hero: "font-display text-[44px] leading-none",
  };
  const unitSizes = { sm: "text-xs", md: "text-[13px]", lg: "text-sm", hero: "text-base" };
  const tones = { ink: "text-ink", naira: "text-naira", muted: "text-ink-2" };
  return (
    <span className={`inline-flex items-baseline gap-1 ${tones[tone]} ${className}`}>
      <span className={`${sizes[size]} font-medium`}>{value}</span>
      {unit && <span className={`${unitSizes[size]} font-medium text-ink-3`}>{unit}</span>}
    </span>
  );
}

/// One line of a definition list: label left, value right, hairline between.
export function Row({
  label,
  children,
  sub,
}: {
  label: string;
  children: ReactNode;
  sub?: ReactNode;
}) {
  return (
    <div className="flex items-start justify-between gap-4 py-3">
      <dt className="shrink-0 pt-px text-[14px] text-ink-2">{label}</dt>
      <dd className="min-w-0 text-right text-[15px] text-ink">
        {children}
        {sub && <span className="mt-0.5 block text-[13px] leading-snug text-ink-2">{sub}</span>}
      </dd>
    </div>
  );
}

/// The MiniPay deposit deeplink. Listing rules say a low balance should lead
/// here, not to a dead-end error — the sender's next action is always "add
/// money", so the button is that action.
export const MINIPAY_DEPOSIT_URL = "https://minipay.opera.com/add_cash";

/// A value the viewer is meant to take away with them — an address, a link.
///
/// Copy rather than select: on a phone, selecting 42 hex characters without
/// catching a neighbouring character is a fiddle, and a half-copied address is
/// a payment to nobody.
///
/// MiniPay's listing rules forbid showing the USER'S OWN wallet address, in
/// any form including truncated. This is for a counterparty's — a recipient
/// the sender typed in themselves. Callers must not point it at the connected
/// wallet; `app/schedules/[id]` checks before rendering one.
export function CopyValue({
  value,
  display,
  label = "Copy",
}: {
  value: string;
  display?: string;
  label?: string;
}) {
  const [done, setDone] = useState(false);

  async function copy() {
    try {
      await navigator.clipboard.writeText(value);
    } catch {
      // Insecure origins and older webviews have no clipboard API. Falling
      // back to a selection beats a button that silently does nothing.
      const sel = window.getSelection();
      const node = document.getElementById(`copy-${value}`);
      if (sel && node) {
        const range = document.createRange();
        range.selectNodeContents(node);
        sel.removeAllRanges();
        sel.addRange(range);
      }
      return;
    }
    setDone(true);
    setTimeout(() => setDone(false), 1600);
  }

  return (
    <span className="inline-flex max-w-full items-center gap-2">
      <span id={`copy-${value}`} className="mono truncate text-[13px]">
        {display ?? value}
      </span>
      <button
        type="button"
        onClick={copy}
        className="shrink-0 rounded-lg bg-sand px-2 py-1 text-[12px] font-medium text-ink-2 active:scale-95"
        aria-label={`${label} ${display ?? value}`}
      >
        {done ? "Copied" : label}
      </button>
    </span>
  );
}
