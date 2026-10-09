/**
 * HelpDocsPage — the Help & documentation page from "Help Docs Redesign.dc.html".
 *
 * TOC rail with scroll-tracked active section (compares the container's
 * scrollTop to section offsets — never scrollIntoView, so the app shell does
 * not jump), a 680px article with dark code blocks, a purple info callout,
 * the trust-labels grid, troubleshooting cards, image placeholders awaiting
 * real captures, and a "Was this helpful?" footer.
 */
import React, { useRef, useState } from 'react';
import { Image, Info, MessageCircle } from 'lucide-react';
import { useNotebook } from '../../store/NotebookStore';
import { themes } from '../../themes/notebook-theme';

const SECTIONS = [
  { title: 'Installation', mins: '3 min' },
  { title: 'Run CLI commands', mins: '3 min' },
  { title: 'Connect your database', mins: '4 min' },
  { title: 'Sync your dbt project', mins: '2 min' },
  { title: 'Create your first block', mins: '5 min' },
  { title: 'Ask your first question', mins: '3 min' },
  { title: 'Share your work', mins: '3 min' },
  { title: 'Troubleshooting', mins: '—' },
];

const CLI_REFERENCE_URL = 'https://github.com/duckcode-ai/dql/blob/main/docs/reference/cli.md';

export function HelpDocsPage() {
  const { state, dispatch } = useNotebook();
  const t = themes[state.themeMode];
  const [active, setActive] = useState(0);
  const [helpful, setHelpful] = useState<'yes' | 'no' | null>(null);
  const scrollerRef = useRef<HTMLDivElement | null>(null);
  const sectionRefs = useRef<Array<HTMLDivElement | null>>([]);

  // Track the section nearest the top of the viewport while scrolling.
  const handleScroll = () => {
    const scroller = scrollerRef.current;
    if (!scroller) return;
    const top = scroller.scrollTop + 90;
    let current = 0;
    sectionRefs.current.forEach((el, index) => {
      if (el && el.offsetTop <= top) current = index;
    });
    setActive(current);
  };

  // Jump by setting the container scrollTop (per the handoff — not scrollIntoView).
  const goTo = (index: number) => {
    const scroller = scrollerRef.current;
    const el = sectionRefs.current[index];
    if (!scroller || !el) return;
    scroller.scrollTo({ top: Math.max(0, el.offsetTop - 24), behavior: 'smooth' });
  };

  const mono = t.fontMono;
  const codeBlock: React.CSSProperties = { margin: '12px 0 0', border: `1px solid ${t.cellBorder}`, background: '#1e1c26', borderRadius: 10, padding: '13px 16px', fontSize: 12.5, lineHeight: 1.7, fontFamily: mono, color: '#e8e6f0', overflowX: 'auto', whiteSpace: 'pre' };
  const comment: React.CSSProperties = { color: '#8a8d96' };
  const inlineCode: React.CSSProperties = { fontFamily: mono, fontSize: 12, background: 'var(--bg-0)', borderRadius: 4, padding: '1px 5px' };
  const h2 = (num: string, title: string) => (
    <h2 style={{ margin: 0, fontSize: 20, fontWeight: 700, letterSpacing: '-0.01em', color: t.textPrimary, display: 'flex', alignItems: 'center', gap: 9 }}>
      <span style={{ color: t.textMuted, fontFamily: mono, fontSize: 15 }}>{num}</span>{title}
    </h2>
  );
  const para: React.CSSProperties = { margin: '12px 0 0' };
  const shot = (caption: string, placeholder: string) => (
    <div style={{ margin: '16px 0 0' }}>
      <div style={{ width: '100%', height: 300, borderRadius: 10, border: `1.5px dashed ${t.cellBorder}`, background: t.appBg, display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', gap: 8, color: t.textMuted }}>
        <Image size={22} strokeWidth={1.5} />
        <span style={{ fontSize: 12, fontStyle: 'italic', maxWidth: 420, textAlign: 'center' }}>{placeholder}</span>
      </div>
      <div style={{ marginTop: 6, fontSize: 11.5, color: t.textMuted, textAlign: 'center' }}>{caption}</div>
    </div>
  );
  const troubleCard = (title: string, body: React.ReactNode) => (
    <div style={{ border: '1px solid var(--border-subtle)', borderRadius: 10, background: t.cellBg, padding: '12px 14px' }}>
      <div style={{ fontSize: 13, fontWeight: 650, color: t.textPrimary }}>{title}</div>
      <div style={{ fontSize: 12.5, color: t.textSecondary, marginTop: 4, lineHeight: 1.6 }}>{body}</div>
    </div>
  );
  const setSectionRef = (index: number) => (el: HTMLDivElement | null) => { sectionRefs.current[index] = el; };

  return (
    <div style={{ flex: 1, minWidth: 0, minHeight: 0, display: 'flex', overflow: 'hidden', background: 'var(--bg-canvas)', fontFamily: t.font }}>
      {/* TOC rail */}
      <div style={{ width: 'clamp(200px, 18vw, 252px)', flexShrink: 0, borderRight: `1px solid ${t.headerBorder}`, background: t.cellBg, display: 'flex', flexDirection: 'column', minHeight: 0, overflow: 'auto', padding: '16px 8px' }}>
        <div style={{ padding: '0 10px 8px', fontSize: 10, fontWeight: 700, letterSpacing: '0.05em', textTransform: 'uppercase', color: t.textMuted }}>Getting started</div>
        {SECTIONS.map((section, index) => {
          const isActive = active === index;
          return (
            <button
              key={section.title}
              type="button"
              onClick={() => goTo(index)}
              style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '6.5px 10px', borderRadius: 7, border: 'none', cursor: 'pointer', textAlign: 'left', fontSize: 12, fontWeight: 550, fontFamily: t.font, width: '100%', background: isActive ? 'var(--accent-dim)' : 'transparent', color: isActive ? t.accent : t.textSecondary }}
            >
              <span style={{ width: 18, height: 18, borderRadius: 5, background: isActive ? t.accent : 'var(--bg-0)', color: isActive ? '#fff' : t.textMuted, display: 'inline-flex', alignItems: 'center', justifyContent: 'center', fontSize: 9.5, fontWeight: 700, flexShrink: 0, fontFamily: mono }}>{String(index + 1).padStart(2, '0')}</span>
              <span style={{ flex: 1 }}>{section.title}</span>
              <span style={{ fontSize: 9.5, color: t.textMuted }}>{section.mins}</span>
            </button>
          );
        })}
        <div style={{ height: 1, background: 'var(--border-subtle)', margin: '12px 10px' }} />
        <div style={{ padding: '0 10px', display: 'flex', flexDirection: 'column', gap: 7, fontSize: 11.5 }}>
          <a href="https://github.com/duckcode-ai/dql#readme" target="_blank" rel="noreferrer" style={{ color: t.accent, textDecoration: 'none' }}>Keyboard shortcuts</a>
          <a href={CLI_REFERENCE_URL} target="_blank" rel="noreferrer" style={{ color: t.accent, textDecoration: 'none' }}>CLI reference</a>
          <a href="https://github.com/duckcode-ai/dql/discussions" target="_blank" rel="noreferrer" style={{ color: t.accent, textDecoration: 'none' }}>Community &amp; support</a>
        </div>
        <div style={{ flex: 1 }} />
        <div style={{ margin: '12px 10px 0', border: '1px solid var(--border-subtle)', borderRadius: 9, background: t.appBg, padding: '10px 11px', fontSize: 11, color: t.textMuted, lineHeight: 1.5 }}>
          Stuck? Ask the assistant — it reads these docs.
          <div>
            <button
              type="button"
              onClick={() => dispatch({ type: 'OPEN_GLOBAL_AI', autoRun: { text: 'Help me finish setting up DQL — what is left to configure in this workspace?' } })}
              style={{ marginTop: 7, display: 'inline-flex', alignItems: 'center', gap: 5, height: 26, padding: '0 10px', borderRadius: 6, border: `1px solid ${t.cellBorder}`, background: t.cellBg, color: t.accent, fontSize: 11, fontWeight: 650, cursor: 'pointer', fontFamily: t.font }}
            >
              <MessageCircle size={11} strokeWidth={1.75} /> Ask about setup
            </button>
          </div>
        </div>
      </div>

      {/* Article */}
      <div ref={scrollerRef} onScroll={handleScroll} style={{ flex: 1, minWidth: 0, overflow: 'auto' }}>
        <div style={{ width: 'min(680px, 100% - 56px)', margin: '0 auto', padding: '34px 0 80px', fontSize: 14, lineHeight: 1.7, color: t.textSecondary }}>
          <div style={{ fontSize: 11, fontWeight: 700, letterSpacing: '0.06em', textTransform: 'uppercase', color: t.accent }}>Guide</div>
          <h1 style={{ margin: '6px 0 0', fontSize: 28, fontWeight: 700, letterSpacing: '-0.02em', color: t.textPrimary, lineHeight: 1.25 }}>Getting started with DQL</h1>
          <div style={{ marginTop: 8, fontSize: 13.5, color: t.textMuted }}>From install to your first governed answer — about 20 minutes.</div>

          <div ref={setSectionRef(0)} style={{ marginTop: 36 }}>
            {h2('01', 'Installation')}
            <p style={para}>DQL runs locally next to your dbt project. The recommended setup creates a <span style={inlineCode}>dql/</span> workspace and installs the CLI inside it, so every repository keeps the version it was tested with.</p>
            <pre style={{ ...codeBlock, margin: '14px 0 0' }}>cd my-dbt-project{'\n'}dbt parse{'\n'}npx create-dql-app@latest dql{'\n'}cd dql{'\n'}npm install{'\n'}npm run doctor{'\n'}npm run notebook</pre>
            <div style={{ margin: '14px 0 0', display: 'flex', gap: 9, alignItems: 'flex-start', border: '1px solid var(--status-info-border)', background: 'var(--accent-dim)', borderRadius: 10, padding: '11px 13px' }}>
              <Info size={13} color={t.accent} style={{ flexShrink: 0, marginTop: 2 }} />
              <span style={{ fontSize: 12.5, lineHeight: 1.6, color: t.textSecondary }}><strong>Requirements:</strong> Node 20+, git, and a dbt project (dbt-core 1.6+ or dbt Cloud). DQL can install optional DuckDB and Snowflake drivers into the project when needed; Databricks uses the built-in HTTPS connector.</span>
            </div>
            {shot('The workbench opens on localhost with your project loaded.', 'Screenshot: terminal after `npm run notebook` opens the workbench')}
          </div>

          <div ref={setSectionRef(1)} style={{ marginTop: 44 }}>
            {h2('02', 'Run CLI commands')}
            <p style={para}>A project-local install puts the executable in <span style={inlineCode}>node_modules/.bin</span>. npm scripts can use it automatically; your normal shell cannot. Use a starter script for daily commands or <span style={inlineCode}>npm exec -- dql</span> for any other command.</p>
            <pre style={codeBlock}>npm run doctor       <span style={comment}># project setup and readiness</span>{'\n'}npm run notebook     <span style={comment}># local browser UI</span>{'\n'}npm run sync         <span style={comment}># refresh dbt state</span>{'\n'}npm run compile      <span style={comment}># write dql-manifest.json</span>{'\n'}npm exec -- dql model list{'\n'}npm exec -- dql --help</pre>
            <p style={para}>A bare <span style={inlineCode}>dql ...</span> command requires the optional global install: <span style={inlineCode}>npm install -g @duckcodeailabs/dql-cli</span>. See the <a href={CLI_REFERENCE_URL} target="_blank" rel="noreferrer" style={{ color: t.accent, textDecoration: 'none' }}>complete CLI reference</a> for all commands, subcommands, flags, examples, and exit codes.</p>
          </div>

          <div ref={setSectionRef(2)} style={{ marginTop: 44 }}>
            {h2('03', 'Connect your database')}
            <p style={para}>Open <strong>Settings → Database</strong>. Pick your warehouse and the form adjusts to what that warehouse needs — DuckDB uses a file path, while Snowflake supports password, key-pair, SSO, OAuth, and workload-identity authentication.</p>
            <ol style={{ margin: '12px 0 0', paddingLeft: 22, display: 'flex', flexDirection: 'column', gap: 8 }}>
              <li>Choose your warehouse from the dropdown.</li>
              <li>Fill the connection fields (credentials stay in <span style={inlineCode}>.dql/</span>, never leave your machine).</li>
              <li>Click <strong>Test connection</strong> — you should see model count and latency.</li>
              <li>Save. The status dot in the sidebar turns green.</li>
            </ol>
            {shot('A successful test shows models found and round-trip time.', 'Screenshot: Settings → Database with a passing test')}
          </div>

          <div ref={setSectionRef(3)} style={{ marginTop: 44 }}>
            {h2('04', 'Sync your dbt project')}
            <p style={para}>DQL reads your dbt manifest and keeps ownership where it belongs: models, columns, tests, and lineage stay in dbt. DQL layers governed context on top — domains, blocks, skills.</p>
            <pre style={codeBlock}>npm run sync      <span style={comment}># runs dql sync dbt with the local CLI</span></pre>
            <p style={para}>After a sync, the <strong>Domains</strong> page shows your models grouped by folder, ready to bind into business entities. Re-run after any dbt change.</p>
          </div>

          <div ref={setSectionRef(4)} style={{ marginTop: 44 }}>
            {h2('05', 'Create your first block')}
            <p style={para}>Blocks are reusable, governed questions — &quot;total revenue&quot;, &quot;churn by tier&quot;. Answers route through certified blocks before anything is generated, so every block you certify makes the whole workspace more trustworthy.</p>
            <ol style={{ margin: '12px 0 0', paddingLeft: 22, display: 'flex', flexDirection: 'column', gap: 8 }}>
              <li>Open <strong>Blocks</strong> and hit <strong>+</strong>, or start from an Ask AI answer with <em>Save as block</em>.</li>
              <li>In the Visual Builder, pick measures and dimensions from the semantic picker — or paste raw SQL and convert it.</li>
              <li>Add parameters (like <span style={inlineCode}>{'${region}'}</span>) so the block is reusable.</li>
              <li>Run it, check the result, and <strong>Save draft</strong>. Certification happens in review.</li>
            </ol>
            {shot('The semantic picker searches all certified measures — no SQL required.', 'Screenshot: Visual Builder with the semantic picker open')}
          </div>

          <div ref={setSectionRef(5)} style={{ marginTop: 44 }}>
            {h2('06', 'Ask your first question')}
            <p style={para}>Open <strong>Ask</strong> and type a business question. DQL answers in a strict order — certified blocks first, semantic metrics next, generated SQL last — and labels every answer with how it was produced.</p>
            <div style={{ margin: '14px 0 0', border: '1px solid var(--border-subtle)', borderRadius: 10, background: t.cellBg, overflow: 'hidden' }}>
              <div style={{ display: 'grid', gridTemplateColumns: '110px 1fr', fontSize: 12.5 }}>
                <div style={{ padding: '9px 13px', borderBottom: '1px solid var(--border-subtle)', background: 'var(--bg-1)', fontWeight: 650, color: 'var(--status-success)' }}>Certified</div>
                <div style={{ padding: '9px 13px', borderBottom: '1px solid var(--border-subtle)', color: t.textSecondary }}>Answered from a certified block — instant and trusted.</div>
                <div style={{ padding: '9px 13px', borderBottom: '1px solid var(--border-subtle)', background: 'var(--bg-1)', fontWeight: 650, color: t.accent }}>Governed</div>
                <div style={{ padding: '9px 13px', borderBottom: '1px solid var(--border-subtle)', color: t.textSecondary }}>Composed from semantic metrics and proven joins.</div>
                <div style={{ padding: '9px 13px', background: 'var(--bg-1)', fontWeight: 650, color: 'var(--status-warning)' }}>Needs review</div>
                <div style={{ padding: '9px 13px', color: t.textSecondary }}>Fresh SQL generated from your schema and not yet reviewed, so check it before you rely on it.</div>
              </div>
            </div>
            <p style={para}>Click any artifact chip in the chat to inspect the result, chart, DQL, SQL, and the full trust trail. Good answers deserve <em>Save as block</em> — that&apos;s how the certified layer grows.</p>
          </div>

          <div ref={setSectionRef(6)} style={{ marginTop: 44 }}>
            {h2('07', 'Share your work')}
            <p style={para}>Everything you author is a file in Git. The <strong>Source control</strong> page walks you through it without git commands: pick changes, describe them in plain words, share to your branch, and open a review request. Nothing reaches main without an approval.</p>
            {shot('Three steps: pick, describe, share — then ask for review.', 'Screenshot: Source control with the guided share flow')}
          </div>

          <div ref={setSectionRef(7)} style={{ marginTop: 44 }}>
            {h2('08', 'Troubleshooting')}
            <div style={{ margin: '14px 0 0', display: 'flex', flexDirection: 'column', gap: 10 }}>
              {troubleCard('“dbt manifest not found”', <>Run <span style={inlineCode}>dbt parse</span> in the dbt project, then <span style={inlineCode}>npm run sync</span> from its DQL workspace. DQL needs a compiled manifest to read lineage.</>)}
              {troubleCard('“dql: command not found”', <>A project-local install uses <span style={inlineCode}>npm run ...</span> or <span style={inlineCode}>npm exec -- dql ...</span>. Install the CLI globally only if you want bare <span style={inlineCode}>dql ...</span> commands.</>)}
              {troubleCard('Connection test fails', <>Check <span style={inlineCode}>npm run doctor</span> and <strong>Settings → Database</strong>. Test candidate credentials before saving them.</>)}
              {troubleCard('AI answers feel wrong', <>Add a skill with your definitions (&quot;revenue = recognized, not bookings&quot;) and certify more blocks. Trust labels tell you which route produced each answer.</>)}
            </div>
          </div>

          <div style={{ marginTop: 44, borderTop: '1px solid var(--border-subtle)', paddingTop: 18, display: 'flex', alignItems: 'center', gap: 10 }}>
            <span style={{ fontSize: 12, color: t.textMuted }}>Was this guide helpful?</span>
            <button type="button" onClick={() => setHelpful('yes')} style={{ height: 26, padding: '0 11px', borderRadius: 999, border: `1px solid ${helpful === 'yes' ? 'var(--status-success)' : t.cellBorder}`, background: helpful === 'yes' ? 'var(--status-success-bg)' : t.cellBg, color: helpful === 'yes' ? 'var(--status-success)' : t.textSecondary, fontSize: 11.5, fontWeight: 600, cursor: 'pointer', fontFamily: t.font }}>Yes</button>
            <button type="button" onClick={() => setHelpful('no')} style={{ height: 26, padding: '0 11px', borderRadius: 999, border: `1px solid ${helpful === 'no' ? 'var(--status-error)' : t.cellBorder}`, background: helpful === 'no' ? 'var(--status-error-bg)' : t.cellBg, color: helpful === 'no' ? 'var(--status-error)' : t.textSecondary, fontSize: 11.5, fontWeight: 600, cursor: 'pointer', fontFamily: t.font }}>Not quite</button>
            <div style={{ flex: 1 }} />
            {helpful ? <span style={{ fontSize: 12, color: t.textMuted }}>Thanks for the feedback.</span> : null}
          </div>
        </div>
      </div>
    </div>
  );
}
