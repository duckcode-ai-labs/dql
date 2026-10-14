import React, { useEffect, useState } from 'react';
import { cssVar, space, fontSize, fontWeight, radius } from '@zlens/ui';
import { useNotebook } from '../../store/NotebookStore';
import { api } from '../../api/client';
import { TYPE_TITLES } from '../lineage/lineage-constants';

/**
 * Right-rail inspector. A scaffold for v0.10 — surfaces context-sensitive
 * detail (cell output meta, lineage node peek, semantic metric doc). Each
 * kind gets its own view below; the panel is hidden when no context is set
 * and the user hasn't opened it explicitly.
 */
export function InspectorPanel() {
  const { state, dispatch } = useNotebook();
  const ctx = state.inspectorContext;

  return (
    <aside
      aria-label="Inspector"
      style={{
        width: 320,
        borderLeft: `1px solid ${cssVar('borderSubtle')}`,
        background: cssVar('surfaceBase'),
        color: cssVar('textPrimary'),
        display: 'flex',
        flexDirection: 'column',
        overflow: 'hidden',
        flexShrink: 0,
      }}
    >
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          padding: `${space[3]}px ${space[4]}px`,
          borderBottom: `1px solid ${cssVar('borderSubtle')}`,
        }}
      >
        <div style={{ fontSize: fontSize.sm, fontWeight: fontWeight.semibold }}>
          {ctx ? inspectorTitle(ctx) : 'Inspector'}
        </div>
        <button
          onClick={() => dispatch({ type: 'SET_INSPECTOR', open: false })}
          aria-label="Close inspector"
          style={{
            background: 'transparent',
            border: 'none',
            color: cssVar('textMuted'),
            cursor: 'pointer',
            fontSize: fontSize.md,
            padding: 2,
            borderRadius: radius.sm,
          }}
        >
          ×
        </button>
      </div>
      <div style={{ flex: 1, overflow: 'auto', padding: space[4] }}>
        {ctx ? <InspectorBody context={ctx} /> : <EmptyState />}
      </div>
    </aside>
  );
}

function inspectorTitle(ctx: NonNullable<ReturnType<typeof useContextSelector>>): string {
  switch (ctx.kind) {
    case 'cell':
      return 'Cell';
    case 'lineage-node':
      return 'Lineage node';
    case 'metric':
      return 'Metric';
  }
}

type Ctx = NonNullable<ReturnType<typeof useContextSelector>>;

function useContextSelector() {
  const { state } = useNotebook();
  return state.inspectorContext;
}

function InspectorBody({ context }: { context: Ctx }) {
  if (context.kind === 'cell') {
    return <CellInspector cellId={context.cellId} />;
  }
  if (context.kind === 'lineage-node') {
    return <LineageNodeInspector nodeId={context.nodeId} />;
  }
  return <MetricInspector name={context.name} />;
}

function CellInspector({ cellId }: { cellId: string }) {
  const { state } = useNotebook();
  const cell = state.cells.find((c) => c.id === cellId);
  if (!cell) return <Hint>No matching cell in the active notebook.</Hint>;
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: space[3], fontSize: fontSize.sm }}>
      <Field label="Type">{cell.type}</Field>
      <Field label="ID">
        <code style={{ fontFamily: 'var(--dql-font-mono, monospace)' }}>{cell.id}</code>
      </Field>
      <Field label="Length">{cell.content.length} chars</Field>
      {cell.status && <Field label="Status">{cell.status}</Field>}
    </div>
  );
}

function LineageNodeInspector({ nodeId }: { nodeId: string }) {
  const [data, setData] = useState<{ node: any; incoming: any[]; outgoing: any[] } | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    api
      .fetchLineageNode(nodeId)
      .then((result) => {
        if (!cancelled) {
          setData(result);
          setLoading(false);
        }
      })
      .catch(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [nodeId]);

  if (loading) return <Hint>Loading node…</Hint>;
  if (!data || !data.node) {
    return (
      <div style={{ display: 'flex', flexDirection: 'column', gap: space[3] }}>
        <Field label="Node ID">
          <code style={{ fontFamily: 'var(--dql-font-mono, monospace)' }}>{nodeId}</code>
        </Field>
        <Hint>No metadata available for this node.</Hint>
      </div>
    );
  }

  const n = data.node;
  const metadata = n.metadata ?? {};
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: space[3] }}>
      <Field label="Name">{n.name ?? nodeId}</Field>
      <Field label="Type">{TYPE_TITLES[n.type] ?? n.type}</Field>
      {n.domain && <Field label="Domain">{n.domain}</Field>}
      {n.owner && <Field label="Owner">{n.owner}</Field>}
      {n.status && <Field label="Status">{n.status}</Field>}
      {typeof metadata.termType === 'string' && <Field label="Term Type">{metadata.termType}</Field>}
      {typeof metadata.description === 'string' && <Field label="Description">{metadata.description}</Field>}
      {Array.isArray(metadata.identifiers) && metadata.identifiers.length > 0 && (
        <Field label="Identifiers">{metadata.identifiers.map(String).join(', ')}</Field>
      )}
      {Array.isArray(metadata.synonyms) && metadata.synonyms.length > 0 && (
        <Field label="Synonyms">{metadata.synonyms.map(String).join(', ')}</Field>
      )}
      {typeof metadata.businessOutcome === 'string' && <Field label="Business Outcome">{metadata.businessOutcome}</Field>}
      {n.layer && <Field label="Layer">{n.layer}</Field>}
      <Field label="Upstream">{data.incoming.length}</Field>
      <Field label="Downstream">{data.outgoing.length}</Field>
      {(n.path || metadata.filePath) && (
        <Field label="Path">
          <code style={{ fontFamily: 'var(--dql-font-mono, monospace)', fontSize: fontSize.xs }}>
            {n.path ?? metadata.filePath}
          </code>
        </Field>
      )}
    </div>
  );
}

function MetricInspector({ name }: { name: string }) {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: space[3] }}>
      <Field label="Metric">{name}</Field>
      <Hint>Definition, dimensions, and governance surface will render here.</Hint>
    </div>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
      <div
        style={{
          fontSize: fontSize.xs,
          color: cssVar('textMuted'),
          textTransform: 'uppercase',
          letterSpacing: 0.5,
          fontWeight: fontWeight.medium,
        }}
      >
        {label}
      </div>
      <div style={{ fontSize: fontSize.sm, color: cssVar('textPrimary') }}>{children}</div>
    </div>
  );
}

function Hint({ children }: { children: React.ReactNode }) {
  return (
    <div
      style={{
        fontSize: fontSize.sm,
        color: cssVar('textSecondary'),
        lineHeight: 1.5,
        background: cssVar('surfaceSunken'),
        border: `1px solid ${cssVar('borderSubtle')}`,
        borderRadius: radius.md,
        padding: space[3],
      }}
    >
      {children}
    </div>
  );
}

function EmptyState() {
  return (
    <div
      style={{
        fontSize: fontSize.sm,
        color: cssVar('textMuted'),
        lineHeight: 1.5,
      }}
    >
      Select a cell, lineage node, or metric to inspect its details here.
    </div>
  );
}
