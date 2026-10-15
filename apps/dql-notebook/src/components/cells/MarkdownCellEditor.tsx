import type { Theme, ThemeMode } from '../../themes/notebook-theme';
import React, { useState, useRef, useEffect } from 'react';
import { themes } from '../../themes/notebook-theme';

interface MarkdownCellEditorProps {
  value: string;
  onChange: (value: string) => void;
  onRun?: () => void;
  themeMode: ThemeMode;
}

/**
 * Simple inline markdown renderer — no external dependencies.
 * Handles headings, bold, italic, code spans, horizontal rules, and line breaks.
 */
export function renderMarkdown(text: string, t: Theme): React.ReactNode[] {
  const lines = text.split('\n');
  const nodes: React.ReactNode[] = [];
  let i = 0;

  while (i < lines.length) {
    const line = lines[i];

    // Headings
    const headingMatch = line.match(/^(#{1,6})\s+(.+)$/);
    if (headingMatch) {
      const level = headingMatch[1].length;
      const content = headingMatch[2];
      const sizes = [28, 22, 18, 16, 14, 13];
      const size = sizes[level - 1];
      nodes.push(
        <div
          key={i}
          style={{
            fontSize: size,
            fontWeight: level <= 2 ? 700 : 600,
            color: t.textPrimary,
            fontFamily: t.font,
            lineHeight: 1.3,
            marginBottom: level === 1 ? 12 : 8,
            marginTop: i > 0 ? (level === 1 ? 16 : 10) : 0,
            borderBottom: level === 1 ? `1px solid ${t.cellBorder}` : undefined,
            paddingBottom: level === 1 ? 8 : undefined,
          }}
        >
          {inlineMarkdown(content, t)}
        </div>
      );
      i++;
      continue;
    }

    // Horizontal rule
    if (/^[-*_]{3,}$/.test(line.trim())) {
      nodes.push(
        <hr key={i} style={{ border: 'none', borderTop: `1px solid ${t.cellBorder}`, margin: '12px 0' }} />
      );
      i++;
      continue;
    }

    // Blockquote
    if (line.startsWith('> ')) {
      nodes.push(
        <div
          key={i}
          style={{
            borderLeft: `3px solid ${t.textMuted}`,
            paddingLeft: 12,
            marginLeft: 4,
            color: t.textSecondary,
            fontStyle: 'italic',
            fontFamily: t.fontSerif,
            fontSize: 14,
          }}
        >
          {inlineMarkdown(line.slice(2), t)}
        </div>
      );
      i++;
      continue;
    }

    // Code block
    if (line.startsWith('```')) {
      const codeLines: string[] = [];
      i++;
      while (i < lines.length && !lines[i].startsWith('```')) {
        codeLines.push(lines[i]);
        i++;
      }
      nodes.push(
        <pre
          key={i}
          style={{
            background: 'var(--color-bg-surface)',
            border: '1px solid var(--color-border-subtle)',
            borderRadius: 6,
            padding: '10px 12px',
            fontSize: 12,
            fontFamily: 'var(--font-mono)',
            color: 'var(--color-text-primary)',
            overflow: 'auto',
            margin: '8px 0',
            lineHeight: 1.6,
          }}
        >
          {codeLines.join('\n')}
        </pre>
      );
      i++;
      continue;
    }

    // Unordered list
    if (/^[-*+]\s/.test(line)) {
      const startI = i;
      const items: string[] = [];
      while (i < lines.length && /^[-*+]\s/.test(lines[i])) {
        items.push(lines[i].replace(/^[-*+]\s/, ''));
        i++;
      }
      nodes.push(
        <ul key={`ul-${startI}`} style={{ paddingLeft: 20, marginBottom: 8, color: t.textSecondary }}>
          {items.map((item, j) => (
            <li key={j} style={{ fontSize: 14, fontFamily: t.font, lineHeight: 1.6, marginBottom: 2 }}>
              {inlineMarkdown(item, t)}
            </li>
          ))}
        </ul>
      );
      continue;
    }

    // Ordered list
    if (/^\d+\.\s/.test(line)) {
      const startI = i;
      const items: string[] = [];
      while (i < lines.length && /^\d+\.\s/.test(lines[i])) {
        items.push(lines[i].replace(/^\d+\.\s/, ''));
        i++;
      }
      nodes.push(
        <ol key={`ol-${startI}`} style={{ paddingLeft: 20, marginBottom: 8, color: t.textSecondary }}>
          {items.map((item, j) => (
            <li key={j} style={{ fontSize: 14, fontFamily: t.font, lineHeight: 1.6, marginBottom: 2 }}>
              {inlineMarkdown(item, t)}
            </li>
          ))}
        </ol>
      );
      continue;
    }

    // Empty line
    if (!line.trim()) {
      nodes.push(<div key={i} style={{ height: 8 }} />);
      i++;
      continue;
    }

    // Paragraph
    nodes.push(
      <p
        key={i}
        style={{
          fontSize: 14,
          lineHeight: 1.7,
          fontFamily: t.fontSerif,
          color: t.textSecondary,
          marginBottom: 6,
        }}
      >
        {inlineMarkdown(line, t)}
      </p>
    );
    i++;
  }

  return nodes;
}

/** Apply inline markdown: bold, italic, inline code, links */
function inlineMarkdown(text: string, t: Theme): React.ReactNode {
  const parts: React.ReactNode[] = [];
  let remaining = text;
  let key = 0;

  while (remaining.length > 0) {
    // Bold+italic ***text***
    const boldItalic = remaining.match(/\*{3}(.+?)\*{3}/);
    // Bold **text**
    const bold = remaining.match(/\*{2}(.+?)\*{2}/);
    // Italic *text*
    const italic = remaining.match(/\*(.+?)\*/);
    // Inline code `text`
    const code = remaining.match(/`(.+?)`/);
    // Link [text](url)
    const link = remaining.match(/\[(.+?)\]\((.+?)\)/);

    const candidates = [
      boldItalic ? { match: boldItalic, type: 'boldItalic' as const } : null,
      bold ? { match: bold, type: 'bold' as const } : null,
      italic ? { match: italic, type: 'italic' as const } : null,
      code ? { match: code, type: 'code' as const } : null,
      link ? { match: link, type: 'link' as const } : null,
    ].filter(Boolean) as Array<{ match: RegExpMatchArray; type: string }>;

    if (candidates.length === 0) {
      parts.push(<React.Fragment key={key++}>{remaining}</React.Fragment>);
      break;
    }

    // Pick the earliest match. On a tie the earlier, more specific pattern
    // wins: "**bold**" also matches the italic pattern at the same index, and
    // letting italic win rendered "*bold*" in italics with stray asterisks.
    const first = candidates.reduce((a, b) =>
      (a.match.index ?? 0) <= (b.match.index ?? 0) ? a : b
    );

    const idx = first.match.index ?? 0;

    // Text before the match
    if (idx > 0) {
      parts.push(<React.Fragment key={key++}>{remaining.slice(0, idx)}</React.Fragment>);
    }

    switch (first.type) {
      case 'boldItalic':
        parts.push(<strong key={key++} style={{ fontStyle: 'italic' }}>{first.match[1]}</strong>);
        break;
      case 'bold':
        parts.push(<strong key={key++}>{first.match[1]}</strong>);
        break;
      case 'italic':
        parts.push(<em key={key++}>{first.match[1]}</em>);
        break;
      case 'code':
        parts.push(
          <code
            key={key++}
            style={{
              background: 'var(--color-bg-surface)',
              border: '1px solid var(--color-border-subtle)',
              borderRadius: 4,
              padding: '1px 5px',
              fontSize: '0.9em',
              fontFamily: 'var(--font-mono)',
              color: 'var(--color-accent-blue)',
            }}
          >
            {first.match[1]}
          </code>
        );
        break;
      case 'link':
        parts.push(
          <a
            key={key++}
            href={first.match[2]}
            target="_blank"
            rel="noopener noreferrer"
            style={{ color: t.accent, textDecoration: 'underline' }}
          >
            {first.match[1]}
          </a>
        );
        break;
    }

    remaining = remaining.slice(idx + first.match[0].length);
  }

  return <>{parts}</>;
}

export function MarkdownCellEditor({ value, onChange, onRun, themeMode }: MarkdownCellEditorProps) {
  const t = themes[themeMode];
  const [editing, setEditing] = useState(false);
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    if (editing && textareaRef.current) {
      textareaRef.current.focus();
      // Auto-resize
      const ta = textareaRef.current;
      ta.style.height = 'auto';
      ta.style.height = `${Math.max(ta.scrollHeight, 80)}px`;
    }
  }, [editing]);

  const handleBlur = () => {
    setEditing(false);
  };

  const handleKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Escape') {
      setEditing(false);
    }
    if (e.key === 'Enter' && e.shiftKey) {
      e.preventDefault();
      setEditing(false);
      onRun?.();
    }
    if (e.key === 'Tab') {
      e.preventDefault();
      const ta = e.currentTarget;
      const start = ta.selectionStart;
      const end = ta.selectionEnd;
      const newValue = value.slice(0, start) + '  ' + value.slice(end);
      onChange(newValue);
      requestAnimationFrame(() => {
        ta.selectionStart = ta.selectionEnd = start + 2;
      });
    }
  };

  const handleTextareaChange = (e: React.ChangeEvent<HTMLTextAreaElement>) => {
    onChange(e.target.value);
    const ta = e.target;
    ta.style.height = 'auto';
    ta.style.height = `${Math.max(ta.scrollHeight, 80)}px`;
  };

  if (editing) {
    return (
      <textarea
        ref={textareaRef}
        value={value}
        onChange={handleTextareaChange}
        onBlur={handleBlur}
        onKeyDown={handleKeyDown}
        placeholder="Write markdown here..."
        spellCheck={false}
        style={{
          display: 'block',
          width: '100%',
          minHeight: 80,
          padding: '12px 16px',
          background: t.editorBg,
          color: t.textPrimary,
          border: 'none',
          outline: 'none',
          resize: 'none' as const,
          fontFamily: t.fontMono,
          fontSize: 13,
          lineHeight: '20px',
          borderRadius: 0,
          caretColor: t.accent,
        }}
      />
    );
  }

  if (!value.trim()) {
    return (
      <div
        onDoubleClick={() => setEditing(true)}
        style={{
          padding: '12px 16px',
          color: t.textMuted,
          fontFamily: t.font,
          fontSize: 13,
          fontStyle: 'italic',
          cursor: 'text',
          minHeight: 48,
          display: 'flex',
          alignItems: 'center',
        }}
      >
        Double-click to add markdown...
      </div>
    );
  }

  return (
    <div
      onDoubleClick={() => setEditing(true)}
      title="Double-click to edit"
      style={{
        padding: '12px 16px',
        cursor: 'text',
        minHeight: 48,
      }}
    >
      {renderMarkdown(value, t)}
    </div>
  );
}
