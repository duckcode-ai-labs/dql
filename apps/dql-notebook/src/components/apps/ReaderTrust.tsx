import { useEffect, useId, useRef, type ReactNode } from 'react';
import { AlertTriangle, Ban, Landmark, ShieldCheck, X } from 'lucide-react';
import type { ReaderTrust, ReaderTrustState, ReceiptRow } from './reader-trust';

const ICONS: Record<ReaderTrustState, typeof ShieldCheck> = {
  certified: ShieldCheck,
  governed: Landmark,
  review: AlertTriangle,
  blocked: Ban,
};

export function TrustStateIcon({ state, size = 12 }: { state: ReaderTrustState; size?: number }): JSX.Element {
  const Icon = ICONS[state];
  return <Icon size={size} strokeWidth={2.2} aria-hidden="true" />;
}

/**
 * The trust label on a reader tile. It is a button: it opens the tile's
 * receipt, the evidence behind its numbers.
 */
export function ReaderTrustBadge({
  trust,
  freshness,
  receipt,
  open,
  onOpenChange,
  onShowEvidence,
}: {
  trust: ReaderTrust;
  freshness: string | null;
  receipt: ReceiptRow[];
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Opens the full "how this was computed" panel with the query and SQL. */
  onShowEvidence?: () => void;
}): JSX.Element {
  const popoverId = useId();
  const anchorRef = useRef<HTMLSpanElement>(null);
  useEffect(() => {
    if (!open) return;
    const onKey = (event: KeyboardEvent) => { if (event.key === 'Escape') onOpenChange(false); };
    const onDown = (event: PointerEvent) => {
      if (anchorRef.current && !anchorRef.current.contains(event.target as Node)) onOpenChange(false);
    };
    window.addEventListener('keydown', onKey);
    window.addEventListener('pointerdown', onDown);
    return () => {
      window.removeEventListener('keydown', onKey);
      window.removeEventListener('pointerdown', onDown);
    };
  }, [open, onOpenChange]);
  return (
    <span ref={anchorRef} className="dql-trust-anchor" onClick={(event) => event.stopPropagation()}>
      <button
        type="button"
        className={`dql-trust-badge ${trust.state}`}
        aria-expanded={open}
        aria-controls={open ? popoverId : undefined}
        title={`${trust.label}: ${trust.detail} Click for the receipt.`}
        onClick={() => onOpenChange(!open)}
      >
        <TrustStateIcon state={trust.state} size={11} />
        <span>{trust.label}</span>
        {freshness ? <span className="dql-trust-age">· {freshness}</span> : null}
      </button>
      {open ? (
        <div id={popoverId} className="dql-receipt" role="dialog" aria-label="Receipt for this tile">
          <header>
            <span className={`dql-receipt-state ${trust.state}`}><TrustStateIcon state={trust.state} size={13} /> {trust.label}</span>
            <button type="button" className="dql-receipt-close" aria-label="Close receipt" onClick={() => onOpenChange(false)}><X size={13} /></button>
          </header>
          <p>{trust.detail}</p>
          <dl>
            {receipt.map((row) => (
              <div key={row.label}>
                <dt>{row.label}</dt>
                <dd className={row.code ? 'code' : undefined}>{row.value}</dd>
              </div>
            ))}
          </dl>
          {onShowEvidence ? (
            <button type="button" className="dql-receipt-more" onClick={() => { onOpenChange(false); onShowEvidence(); }}>
              Show the query and SQL
            </button>
          ) : null}
        </div>
      ) : null}
    </span>
  );
}

/**
 * Page-level trust summary for readers, with the Trust Lens switch. With the
 * lens on, every tile is outlined in its trust colour, so anything not
 * certified stands out at a glance.
 */
export function TrustLensBar({
  counts,
  summary,
  on,
  onToggle,
  actions,
}: {
  counts: Array<{ state: ReaderTrustState; label: string; count: number }>;
  /** The page's aggregate trust sentence (`appTrustSummary().text`); derived from counts when absent. */
  summary?: string;
  on: boolean;
  onToggle: () => void;
  /** Page actions shown at the end of the bar, such as Export. */
  actions?: ReactNode;
}): JSX.Element | null {
  if (!counts.length) return null;
  const total = counts.reduce((sum, entry) => sum + entry.count, 0);
  const certified = counts.find((entry) => entry.state === 'certified')?.count ?? 0;
  return (
    <div className="dql-trust-lens-bar" role="group" aria-label="Trust on this page">
      <span className="dql-trust-summary">
        {summary || (certified === total ? `All ${total} ${total === 1 ? 'tile' : 'tiles'} certified` : `${certified} of ${total} tiles certified`)}
      </span>
      {on ? counts.map((entry) => (
        <span key={entry.state} className={`dql-trust-count ${entry.state}`}>
          <TrustStateIcon state={entry.state} size={11} /> {entry.count} {entry.label.toLowerCase()}
        </span>
      )) : null}
      <button type="button" className={`dql-trust-lens-toggle ${on ? 'on' : ''}`} aria-pressed={on} onClick={onToggle}>
        Trust lens
      </button>
      {actions}
    </div>
  );
}

/** A tile description is short markdown; readers get it as plain text. */
export function plainDescription(markdown: string): string {
  return markdown
    .replace(/`([^`]*)`/g, '$1')
    .replace(/\*\*([^*]+)\*\*|__([^_]+)__/g, '$1$2')
    .replace(/\*([^*]+)\*|_([^_]+)_/g, '$1$2')
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
    .replace(/^#+\s*/gm, '')
    .replace(/\s+/g, ' ')
    .trim();
}
