/**
 * The one Markdown renderer.
 *
 * Personal notes and documents both show Markdown a person typed, and both used
 * to call react-markdown directly with no plugins. That left two renderers with
 * the same two gaps: tables did not render, because they are a GitHub-flavoured
 * extension and not core Markdown, and a single Enter was folded into the line
 * above, which is correct CommonMark and wrong for notes typed at a table. It
 * also meant the settings that make user-written Markdown safe existed twice.
 *
 * Now there is one. What it deliberately does not do:
 *
 * - **Render raw HTML.** react-markdown ignores it unless rehype-raw is added,
 *   and it is not. A <script> in a note is shown as the text "<script>".
 * - **Pass through unsafe links.** react-markdown's default URL transform drops
 *   javascript:, data: and the like, leaving an empty href. remark-gfm's
 *   autolinks only ever produce http, https and mailto, so nothing new can
 *   arrive that way.
 * - **Load an image from another host.** A document is read by everyone it is
 *   shared with, and an image on an outside host makes each reader's browser
 *   fetch it, telling that host who opened the document and when. Only images
 *   served by this instance are shown; any other image is replaced by its alt
 *   text.
 *
 * Adding a plugin here changes every place Markdown is shown. That is the
 * point; check both when you do.
 */

import ReactMarkdown from 'react-markdown';
import type { Components } from 'react-markdown';
import remarkGfm from 'remark-gfm';
import remarkBreaks from 'remark-breaks';

const plugins = [remarkGfm, remarkBreaks];

/** True for a relative path or an absolute address on this instance. */
function isOwnImage(src: string): boolean {
  try {
    return new URL(src, window.location.origin).origin === window.location.origin;
  } catch {
    return false;
  }
}

const components: Components = {
  img: ({ src, alt }) =>
    src && isOwnImage(src) ? (
      <img src={src} alt={alt ?? ''} />
    ) : (
      <span className="italic text-warm-gray">{alt || 'image not shown'}</span>
    ),
};

interface MarkdownProps {
  children: string;
}

export default function Markdown({ children }: MarkdownProps) {
  return (
    <ReactMarkdown remarkPlugins={plugins} components={components}>
      {children}
    </ReactMarkdown>
  );
}
