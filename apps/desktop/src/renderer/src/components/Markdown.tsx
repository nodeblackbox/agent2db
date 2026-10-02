import ReactMarkdown, { type Components } from 'react-markdown';
import rehypeSanitize from 'rehype-sanitize';
import remarkGfm from 'remark-gfm';

/**
 * Renders model output as sanitised Markdown. Raw HTML is not parsed (react-markdown default),
 * rehype-sanitize strips anything unexpected, links open in the system browser (main process
 * intercepts window.open), and images are never loaded (shown as text) to avoid exfiltration.
 */
const components: Components = {
  a: ({ href, children }) => (
    <a href={href} target="_blank" rel="noopener noreferrer">
      {children}
    </a>
  ),
  img: ({ alt, src }) => <span className="md-img">[image: {alt || src || 'untitled'}]</span>,
};

export function Markdown({ text }: { text: string }) {
  return (
    <div className="markdown">
      <ReactMarkdown remarkPlugins={[remarkGfm]} rehypePlugins={[rehypeSanitize]} components={components}>
        {text}
      </ReactMarkdown>
    </div>
  );
}
