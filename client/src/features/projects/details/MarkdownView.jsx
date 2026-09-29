import { useMemo } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { fenceLanguage, highlightToHtml } from './highlight.js';

const EXTERNAL = /^(?:[a-z][a-z\d+.-]*:|\/\/)/i;

function decodeSafe(part) {
  try {
    return decodeURIComponent(part);
  } catch {
    return part;
  }
}

/** Archive path of a link or image in a Markdown file: relative to the file, or from the root for "/…". */
function resolveInArchive(fromFile, target) {
  const parts = target.startsWith('/') ? [] : fromFile.split('/').slice(0, -1);
  for (const part of target.split('/')) {
    if (!part || part === '.') continue;
    if (part === '..') parts.pop();
    else parts.push(decodeSafe(part));
  }
  return parts.join('/');
}

/**
 * Renders a README or any Markdown file from a project or repository. Raw HTML inside the
 * Markdown is not rendered (react-markdown escapes it), relative images and
 * links load from the archive, every block picks its own direction (Hebrew or
 * English), and code fences are highlighted.
 */
export default function MarkdownView({ text, source, filePath }) {
  const components = useMemo(() => {
    const resolve = (url) => {
      if (!url || url.startsWith('#') || EXTERNAL.test(url)) return url;
      return source.raw(resolveInArchive(filePath, url.split(/[?#]/)[0]));
    };
    const block = (Tag) =>
      function Block({ node, ...props }) {
        return <Tag dir="auto" {...props} />;
      };
    return {
      h1: block('h1'), h2: block('h2'), h3: block('h3'), h4: block('h4'), h5: block('h5'), h6: block('h6'),
      p: block('p'), li: block('li'), blockquote: block('blockquote'), th: block('th'), td: block('td'),
      a({ node, href, children, ...props }) {
        const inPage = href?.startsWith('#');
        return (
          <a href={resolve(href)} {...props} {...(inPage ? {} : { target: '_blank', rel: 'noopener noreferrer' })}>
            {children}
          </a>
        );
      },
      img({ node, src, alt, ...props }) {
        return <img src={resolve(src)} alt={alt ?? ''} loading="lazy" {...props} />;
      },
      pre({ node, children, ...props }) {
        return (
          <pre dir="ltr" {...props} className={['text-left', props.className].filter(Boolean).join(' ')}>
            {children}
          </pre>
        );
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
    // `source` is identified by its key.
  }, [source.key, filePath]);

  return (
    <div className="md">
      <ReactMarkdown remarkPlugins={[remarkGfm]} components={components}>
        {text}
      </ReactMarkdown>
    </div>
  );
}
