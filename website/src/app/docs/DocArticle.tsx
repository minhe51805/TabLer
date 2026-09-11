import Image from "next/image";
import { AlertTriangle, Info, Lightbulb } from "lucide-react";
import type { DocBlock } from "@/lib/docs";

const calloutIcon = {
  info: Info,
  tip: Lightbulb,
  warn: AlertTriangle,
};

export function DocArticle({
  blocks,
  headingIds,
}: {
  blocks: DocBlock[];
  headingIds?: Record<number, string>;
}) {
  return (
    <div className="doc-article">
      {blocks.map((block, index) =>
        renderBlock(block, index, headingIds?.[index]),
      )}
    </div>
  );
}

function renderBlock(block: DocBlock, key: number, id?: string) {
  switch (block.type) {
    case "p":
      return <p key={key}>{block.text}</p>;
    case "h2":
      return (
        <h2 key={key} id={id}>
          {block.text}
        </h2>
      );
    case "h3":
      return (
        <h3 key={key} id={id}>
          {block.text}
        </h3>
      );
    case "ul":
      return (
        <ul key={key} className="doc-list">
          {block.items.map((item, i) => (
            <li key={i}>{item}</li>
          ))}
        </ul>
      );
    case "ol":
      return (
        <ol key={key} className="doc-list doc-list-ordered">
          {block.items.map((item, i) => (
            <li key={i}>{item}</li>
          ))}
        </ol>
      );
    case "code":
      return (
        <pre key={key} className="doc-code" data-lang={block.lang}>
          <code>{block.code}</code>
        </pre>
      );
    case "table":
      return (
        <div key={key} className="doc-table-wrap">
          <table className="doc-table">
            <thead>
              <tr>
                {block.head.map((cell, i) => (
                  <th key={i}>{cell}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {block.rows.map((row, r) => (
                <tr key={r}>
                  {row.map((cell, c) => (
                    <td key={c}>{cell}</td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      );
    case "callout": {
      const Icon = calloutIcon[block.tone];
      return (
        <div key={key} className={`doc-callout doc-callout-${block.tone}`}>
          <Icon size={18} aria-hidden="true" />
          <div>
            {block.title ? <strong>{block.title}</strong> : null}
            <p>{block.text}</p>
          </div>
        </div>
      );
    }
    case "steps":
      return (
        <ol key={key} className="doc-steps">
          {block.items.map((item, i) => (
            <li key={i}>
              <span className="doc-step-index">{i + 1}</span>
              <div>
                <strong>{item.title}</strong>
                <p>{item.text}</p>
              </div>
            </li>
          ))}
        </ol>
      );
    case "cards":
      return (
        <div key={key} className="doc-cards">
          {block.items.map((item, i) => (
            <article key={i} className="doc-card">
              <h3>{item.title}</h3>
              <p>{item.text}</p>
            </article>
          ))}
        </div>
      );
    case "image":
      return (
        <div key={key} className="doc-figure">
          <div className="frame-bar" aria-hidden="true">
            <span />
            <span />
            <span />
            <strong>TableR</strong>
          </div>
          <Image
            className="product-image"
            src={block.src}
            width={block.width}
            height={block.height}
            alt={block.alt}
            sizes="(max-width: 900px) 94vw, 820px"
          />
        </div>
      );
    default:
      return null;
  }
}
