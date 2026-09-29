import { Check, Copy } from 'lucide-react';
import { useState } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { directionOf } from '../../lib/bidi.js';
import { copyText } from '../../lib/clipboard.js';
import { fenceLanguage, highlightToHtml } from '../projects/details/highlight.js';

/** A block's own text, without inline code (identifiers shouldn't turn a Hebrew sentence left-to-right). */
const textOf = (node) =>
  !node ? '' : node.type === 'text' ? node.value : node.tagName === 'code' ? '' : (node.children ?? []).map(textOf).join('');

const block = (Tag) =>
  function Block({ node, ...props }) {
    return <Tag dir={directionOf(textOf(node))} {...props} />;
  };

function CodeBlock({ children }) {
  const [copied, setCopied] = useState(false);
  const text = () => {
    const code = children?.props?.children;
    return String(Array.isArray(code) ? code.join('') : (code ?? '')).replace(/\n$/, '');
  };
  const copy = async () => {
    try {
      await copyText(text());
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      // the browser refused clipboard access
    }
  };
  return (
    <div dir="ltr" className="relative text-left">
      <button
        type="button"
        onClick={copy}
        aria-label="העתקת הקוד"
        title="העתקת הקוד"
        className="absolute end-2 top-2 inline-flex size-7 items-center justify-center rounded-md bg-surface/90 text-graphite shadow-[0_1px_2px_rgb(13_16_22/0.12)] hover:text-ink"
      >
        {copied ? <Check size={14} aria-hidden="true" /> : <Copy size={14} aria-hidden="true" />}
      </button>
      <pre dir="ltr" className="text-left">
        {children}
      </pre>
    </div>
  );
}

const COMPONENTS = {
  h1: block('h1'), h2: block('h2'), h3: block('h3'), h4: block('h4'), h5: block('h5'), h6: block('h6'),
  p: block('p'), li: block('li'), blockquote: block('blockquote'), th: block('th'), td: block('td'),
  a({ node, href, children, ...props }) {
    return (
      <a href={href} target="_blank" rel="noopener noreferrer" {...props}>
        {children}
      </a>
    );
  },
  pre({ node, children }) {
    return <CodeBlock>{children}</CodeBlock>;
  },
  code({ node, className, children, ...props }) {
    const value = String(children ?? '');
    const named = /language-([\w+#-]+)/.exec(className ?? '')?.[1];
    if (!named && !value.includes('\n')) {
      return (
        <code dir="ltr" {...props}>
          {children}
        </code>
      );
    }
    return <code className="hljs" dangerouslySetInnerHTML={{ __html: highlightToHtml(value.replace(/\n$/, ''), fenceLanguage(named)) }} />;
  },
};

/** An answer's Markdown: every block takes the direction of most of its letters; code is left-to-right, highlighted and copyable. */
export default function ChatMarkdown({ text }) {
  return (
    <div className="md md-chat">
      <ReactMarkdown remarkPlugins={[remarkGfm]} skipHtml components={COMPONENTS}>
        {text}
      </ReactMarkdown>
    </div>
  );
}
