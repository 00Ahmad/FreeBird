import { memo } from "react";
import ReactMarkdown, { type Components } from "react-markdown";
import remarkGfm from "remark-gfm";

import { DataTable } from "./DataTable";
import { MarkdownImage } from "./MarkdownImage";

const PLUGINS = [remarkGfm];

/** Links open in the system browser (the desktop shell routes target=_blank there); images load on request. */
const COMPONENTS: Components = {
  a: ({ href, children }) => (
    <a href={href} target="_blank" rel="noreferrer noopener">
      {children}
    </a>
  ),
  img: ({ src, alt }) => <MarkdownImage src={typeof src === "string" ? src : undefined} alt={alt} />,
  table: ({ node, children }) => <DataTable node={node as never}>{children}</DataTable>,
};

/** Bot text as Markdown. Raw HTML is not rendered. */
export const Markdown = memo(function Markdown({ text }: { text: string }) {
  return (
    <div className="md">
      <ReactMarkdown remarkPlugins={PLUGINS} components={COMPONENTS}>
        {text}
      </ReactMarkdown>
    </div>
  );
});
