import React from 'react';
import type { DiffReport, DiffChange, FieldChange } from '@zlens/core/format';

// Renders either a semantic DiffReport (for .dql/.dqlnb) or a raw unified
// git diff (everything else). The two paths share one component so panels
// can pass whichever the server returned without branching per file type.

interface Props {
  diff: string;
  diffReport: DiffReport | null;
  activeFilePath: string | null;
  diffPath: string | null;
  onScopeToFile: () => void;
  onClearScope: () => void;
  t: any;
}

export function GitDiffView({
  diff, diffReport, activeFilePath, diffPath, onScopeToFile, onClearScope, t,
}: Props) {
  const hasSemantic = diffReport !== null && !diffReport.identical;
  const hasRaw = diff.trim() !== '';

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
      <div style={{ display: 'flex', gap: 6, fontSize: 11 }}>
        <button onClick={onClearScope} style={scopeBtn(diffPath == null, t)}>All</button>
        {activeFilePath && (
          <button onClick={onScopeToFile} style={scopeBtn(diffPath === activeFilePath, t)}>
            Active file
          </button>
        )}
        {diffPath && (
          <span style={{ color: t.textMuted, fontSize: 10, alignSelf: 'center', fontFamily: t.fontMono }}>
            {diffPath}
          </span>
        )}
      </div>

      {hasSemantic && <SemanticDiff report={diffReport!} t={t} />}

      {!hasSemantic && hasRaw && <RawDiff diff={diff} t={t} />}

      {!hasSemantic && !hasRaw && (
        <div style={{ color: t.textMuted }}>
          {diffReport && diffReport.identical ? 'No semantic changes.' : 'No unstaged changes.'}
        </div>
      )}
    </div>
  );
}

function SemanticDiff({ report, t }: { report: DiffReport; t: any }) {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
      {report.changes.map((change, i) => (
        <ChangeRow key={i} change={change} t={t} />
      ))}
    </div>
  );
}

function ChangeRow({ change, t }: { change: DiffChange; t: any }) {
  const { marker, color, label } = formatChange(change);
  const fields = 'fields' in change ? change.fields : null;
  return (
    <div
      style={{
        border: `1px solid ${t.editorBorder}`,
        borderRadius: 6,
        padding: '6px 10px',
        background: t.editorBg,
      }}
    >
      <div style={{ display: 'flex', gap: 8, alignItems: 'baseline' }}>
        <span style={{ color, fontFamily: t.fontMono, fontWeight: 700, width: 14 }}>{marker}</span>
        <span style={{ color: t.textPrimary, fontSize: 12, fontFamily: t.fontMono }}>{label}</span>
      </div>
      {fields && fields.length > 0 && (
        <div style={{ marginTop: 4, display: 'flex', flexDirection: 'column', gap: 2 }}>
          {fields.map((f, i) => (
            <FieldRow key={i} field={f} t={t} />
          ))}
        </div>
      )}
    </div>
  );
}

function FieldRow({ field, t }: { field: FieldChange; t: any }) {
  return (
    <div style={{ fontSize: 11, fontFamily: t.fontMono, color: t.textPrimary, paddingLeft: 22 }}>
      <span style={{ color: t.accent }}>{field.path}</span>
      <span style={{ color: t.textMuted }}>: </span>
      <span style={{ color: t.error, textDecoration: 'line-through' }}>{truncate(field.before)}</span>
      <span style={{ color: t.textMuted }}> → </span>
      <span style={{ color: t.success }}>{truncate(field.after)}</span>
    </div>
  );
}

function RawDiff({ diff, t }: { diff: string; t: any }) {
  return (
    <pre
      style={{
        fontFamily: t.fontMono,
        fontSize: 11,
        margin: 0,
        padding: 8,
        background: t.editorBg,
        border: `1px solid ${t.editorBorder}`,
        borderRadius: 6,
        overflow: 'auto',
        whiteSpace: 'pre',
        color: t.textPrimary,
      }}
    >
      {diff.split('\n').map((line, i) => (
        <div key={i} style={{ color: diffLineColor(line, t) }}>{line || ' '}</div>
      ))}
    </pre>
  );
}

function formatChange(change: DiffChange): { marker: string; color: string; label: string } {
  const added = { marker: '+', color: '#3cb371' };
  const removed = { marker: '-', color: '#e06060' };
  const changed = { marker: '~', color: '#d4a24c' };
  switch (change.kind) {
    case 'block-added':      return { ...added,   label: `block "${change.name}"` };
    case 'block-removed':    return { ...removed, label: `block "${change.name}"` };
    case 'block-changed':    return { ...changed, label: `block "${change.name}"` };
    case 'dashboard-added':  return { ...added,   label: `dashboard "${change.title}"` };
    case 'dashboard-removed':return { ...removed, label: `dashboard "${change.title}"` };
    case 'dashboard-changed':return { ...changed, label: `dashboard "${change.title}"` };
    case 'workbook-added':   return { ...added,   label: `workbook "${change.title}"` };
    case 'workbook-removed': return { ...removed, label: `workbook "${change.title}"` };
    case 'workbook-changed': return { ...changed, label: `workbook "${change.title}"` };
    case 'cell-added':       return { ...added,   label: `cell ${cellRef(change.id, change.name)} [${change.cellType}]` };
    case 'cell-removed':     return { ...removed, label: `cell ${cellRef(change.id, change.name)} [${change.cellType}]` };
    case 'cell-changed':     return { ...changed, label: `cell ${cellRef(change.id, change.name)}` };
    case 'notebook-changed': return { ...changed, label: 'notebook' };
  }
}

function cellRef(id: string, name?: string): string {
  return name ? `"${name}" (${id.slice(0, 8)})` : id.slice(0, 8);
}

function truncate(v: string | null, max = 60): string {
  if (v == null) return '∅';
  const one = v.replace(/\s+/g, ' ').trim();
  return one.length > max ? `${one.slice(0, max)}…` : one;
}

function scopeBtn(active: boolean, t: any): React.CSSProperties {
  return {
    background: active ? t.btnHover : 'transparent',
    color: active ? t.textPrimary : t.textMuted,
    border: `1px solid ${t.headerBorder}`,
    padding: '2px 8px',
    borderRadius: 4,
    fontSize: 11,
    cursor: 'pointer',
  };
}

function diffLineColor(line: string, t: any): string {
  if (line.startsWith('+++') || line.startsWith('---')) return t.textMuted;
  if (line.startsWith('+')) return t.success;
  if (line.startsWith('-')) return t.error;
  if (line.startsWith('@@')) return t.accent;
  return t.textPrimary;
}
