'use client';
import { memo } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';

/**
 * Diagnosis report renderer (v1-parity). The chat Markdown component is tuned for short conversational
 * turns; a Well-Architected deep-dive report is dense (15 sections, many wide GFM tables), so this is a
 * DEDICATED renderer with report-grade hierarchy — bordered section headers, accent-barred subsections,
 * and zebra/hover data tables — mapped onto the app's light paper/ink + brand tokens. react-markdown +
 * remark-gfm (GFM tables/strikethrough/task-lists), XSS-safe (no rehype-raw).
 */
// The section LLM sometimes prefixes a prescribed `### X` subsection with its own `## `, producing
// `## ### X` — which CommonMark parses as an h2 whose TEXT is literally "### X" (so "###" shows on
// screen). Collapse any doubled heading prefix to the inner one (`## ### X` → `### X`). Applied at
// render so EXISTING stored reports are fixed too, not only freshly generated ones.
function normalizeHeadings(md: string): string {
  return md.replace(/^(#{1,6})[ \t]+(#{1,6}[ \t])/gm, '$2');
}

function ReportMarkdownImpl({ markdown }: { markdown: string }) {
  return (
    <article className="report-markdown max-w-none text-[13.5px] leading-relaxed text-ink-700 [overflow-wrap:anywhere]">
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        components={{
          // Document title.
          h1: ({ children }) => (
            <h1 className="mt-6 mb-3 border-b border-ink-200 pb-2 text-[19px] font-bold text-ink-800 first:mt-0">{children}</h1>
          ),
          // Section headers (## per diagnosis section) — bordered for scannability across 15 sections.
          h2: ({ children }) => (
            <h2 className="mt-6 mb-2.5 border-b border-ink-200 pb-1.5 text-[16px] font-bold text-ink-800 first:mt-0">{children}</h2>
          ),
          // Subsections (### tables/blocks inside a section) — accent bar like v1.
          h3: ({ children }) => (
            <h3 className="mt-4 mb-2 flex items-center gap-2 text-[14px] font-semibold text-ink-800">
              <span className="inline-block h-3.5 w-1 shrink-0 rounded-full bg-brand-500" />
              <span>{children}</span>
            </h3>
          ),
          h4: ({ children }) => <h4 className="mt-3 mb-1 text-[13px] font-semibold text-ink-700">{children}</h4>,
          p: ({ children }) => <p className="my-2.5 first:mt-0 last:mb-0">{children}</p>,
          strong: ({ children }) => <strong className="font-semibold text-ink-800">{children}</strong>,
          em: ({ children }) => <em className="italic text-ink-600">{children}</em>,
          a: ({ children, href }) => (
            <a href={href} target="_blank" rel="noopener noreferrer" className="font-medium text-brand-700 underline decoration-brand-200 underline-offset-2 hover:text-brand-600">{children}</a>
          ),
          ul: ({ children }) => <ul className="my-2.5 list-disc space-y-1 pl-5 marker:text-brand-400 first:mt-0 last:mb-0">{children}</ul>,
          ol: ({ children }) => <ol className="my-2.5 list-decimal space-y-1 pl-5 marker:text-ink-400 first:mt-0 last:mb-0">{children}</ol>,
          li: ({ children }) => <li className="pl-0.5">{children}</li>,
          code: ({ children }) => (
            <code className="rounded-[4px] border border-ink-100 bg-paper-muted px-1 py-px font-mono text-[12px] text-brand-700">{children}</code>
          ),
          pre: ({ children }) => (
            <pre className="my-2.5 overflow-x-auto rounded-md border border-ink-100 bg-paper-muted p-3 font-mono text-[12px] leading-relaxed text-ink-700 [&_code]:border-0 [&_code]:bg-transparent [&_code]:p-0 [&_code]:text-ink-700">{children}</pre>
          ),
          table: ({ children }) => (
            <div className="my-3 overflow-x-auto rounded-md border border-ink-200">
              <table className="w-full border-collapse text-[12.5px]">{children}</table>
            </div>
          ),
          thead: ({ children }) => <thead className="bg-paper-muted">{children}</thead>,
          // Pass `style` through: remark-gfm sets style.textAlign for column alignment (`|:--:|`, `|--:|`);
          // the inline style overrides the default `text-left` class (e.g. right-aligned cost numbers).
          th: ({ children, style }) => (
            <th style={style} className="whitespace-nowrap border-b border-ink-200 px-3 py-2 text-left font-semibold text-ink-800">{children}</th>
          ),
          tr: ({ children }) => <tr className="transition-colors even:bg-paper-muted/40 hover:bg-brand-50/50">{children}</tr>,
          td: ({ children, style }) => <td style={style} className="border-b border-ink-100 px-3 py-1.5 align-top text-ink-700">{children}</td>,
          blockquote: ({ children }) => (
            <blockquote className="my-3 rounded-r border-l-[3px] border-brand-300 bg-brand-50/40 py-1.5 pl-3 text-ink-600">{children}</blockquote>
          ),
          hr: () => <hr className="my-5 border-ink-200" />,
          // eslint-disable-next-line @next/next/no-img-element -- arbitrary external URLs; next/image can't optimize
          img: ({ src, alt }) => <img src={typeof src === 'string' ? src : undefined} alt={alt ?? ''} className="my-2 max-w-full rounded-md border border-ink-100" />,
        }}
      >
        {normalizeHeadings(markdown)}
      </ReactMarkdown>
    </article>
  );
}

const ReportMarkdown = memo(ReportMarkdownImpl);
export default ReportMarkdown;
