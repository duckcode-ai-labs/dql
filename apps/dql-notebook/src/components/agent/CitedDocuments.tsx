import type { CSSProperties } from 'react';
import { FileText } from 'lucide-react';
import type { AgentRun } from '../../api/client';
import type { Theme } from '../../themes/notebook-theme';

/**
 * Team documents an answer read (knowledge sources, RFC 0010 HH-15). They
 * explain the question's terms; the answer's figures come only from governed
 * queries and its trust label is unchanged by them.
 */
export function CitedDocuments({ run, t }: { run: Pick<AgentRun, 'knowledge'>; t: Theme }) {
  const knowledge = run.knowledge;
  const citations = (knowledge?.citations ?? []).filter((citation) => citation && typeof citation.title === 'string');
  if (!citations.length) return null;
  const safeHref = (url?: string) => (url && /^https?:\/\//i.test(url) ? url : undefined);
  return (
    <div style={appliedListStyle(t)} aria-label="Cited documents">
      <div style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 10.5, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.04em', color: t.textMuted }}>
        <FileText size={11} /> From team documents
      </div>
      {knowledge?.note ? <div style={{ fontSize: 12, color: t.textPrimary, lineHeight: 1.45 }}>{knowledge.note}</div> : null}
      {citations.map((citation) => {
        const href = safeHref(citation.url);
        return (
          <div key={`${citation.sourceId}:${citation.docId}`} style={{ display: 'flex', gap: 8, alignItems: 'flex-start', minWidth: 0 }}>
            <span style={appliedTagStyle(t, 'memory')}>{citation.sourceLabel || citation.sourceId}</span>
            {href ? (
              <a href={href} target="_blank" rel="noopener noreferrer" style={{ fontSize: 11.5, fontWeight: 650, color: t.accent, textDecoration: 'none', overflowWrap: 'anywhere' }}>{citation.title}</a>
            ) : (
              <span style={{ fontSize: 11.5, fontWeight: 650, color: t.textPrimary, overflowWrap: 'anywhere' }}>{citation.title}</span>
            )}
          </div>
        );
      })}
      <div style={{ fontSize: 10.5, color: t.textMuted }}>
        Context only — figures come from governed queries, and documents never change how far to trust this answer.
      </div>
    </div>
  );
}

/** The answer panel's advisory list (Applied learnings, cited documents). */
export function appliedListStyle(t: Theme): CSSProperties {
  return {
    display: 'grid',
    gap: 8,
    padding: 10,
    borderRadius: 8,
    background: t.cellBg,
    border: `1px solid ${t.headerBorder}`,
  };
}

/** A small uppercase tag in an advisory list. */
export function appliedTagStyle(t: Theme, kind: 'memory' | 'hint'): CSSProperties {
  const accent = kind === 'hint';
  return {
    flex: '0 0 auto',
    fontSize: 9,
    fontWeight: 700,
    textTransform: 'uppercase',
    letterSpacing: '0.04em',
    padding: '2px 6px',
    borderRadius: 4,
    marginTop: 1,
    background: accent ? `${t.accent}1f` : `${t.textMuted}1f`,
    color: accent ? t.accent : t.textMuted,
  };
}
