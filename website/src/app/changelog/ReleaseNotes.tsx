import type { ReactNode } from "react";

/**
 * Minimal, dependency-free renderer for GitHub release note bodies.
 * Supports the subset TableR notes actually use: #/##/### headings,
 * -/* bullets, **bold**, `code`, [links](url), blockquotes, and paragraphs.
 * Everything is rendered as plain React nodes — no HTML injection.
 */

function renderInline(text: string, keyPrefix: string): ReactNode[] {
  const nodes: ReactNode[] = [];
  let buffer = "";
  let index = 0;
  let nodeIndex = 0;

  const flush = () => {
    if (buffer) {
      nodes.push(<span key={`${keyPrefix}-t-${nodeIndex++}`}>{buffer}</span>);
      buffer = "";
    }
  };

  while (index < text.length) {
    if (text.startsWith("**", index)) {
      const end = text.indexOf("**", index + 2);
      if (end !== -1) {
        flush();
        nodes.push(
          <strong key={`${keyPrefix}-b-${nodeIndex++}`}>
            {renderInline(text.slice(index + 2, end), `${keyPrefix}-b-${nodeIndex}`)}
          </strong>,
        );
        index = end + 2;
        continue;
      }
    }

    if (text[index] === "`") {
      const end = text.indexOf("`", index + 1);
      if (end !== -1) {
        flush();
        nodes.push(<code key={`${keyPrefix}-c-${nodeIndex++}`}>{text.slice(index + 1, end)}</code>);
        index = end + 1;
        continue;
      }
    }

    if (text[index] === "[") {
      const close = text.indexOf("](", index + 1);
      if (close !== -1) {
        const urlEnd = text.indexOf(")", close + 2);
        if (urlEnd !== -1) {
          flush();
          const label = text.slice(index + 1, close);
          const url = text.slice(close + 2, urlEnd);
          nodes.push(
            <a
              href={url}
              key={`${keyPrefix}-a-${nodeIndex++}`}
              rel="noreferrer"
              target={url.startsWith("http") ? "_blank" : undefined}
            >
              {label}
            </a>,
          );
          index = urlEnd + 1;
          continue;
        }
      }
    }

    buffer += text[index];
    index += 1;
  }

  flush();
  return nodes;
}

export function ReleaseNotes({ body }: { body: string }) {
  const lines = body.replace(/\r\n?/g, "\n").split("\n");
  const blocks: ReactNode[] = [];
  let bullets: string[] = [];
  let paragraph: string[] = [];
  let blockIndex = 0;

  const flushBullets = () => {
    if (!bullets.length) return;
    blocks.push(
      <ul key={`ul-${blockIndex++}`}>
        {bullets.map((item, itemIndex) => (
          <li key={itemIndex}>{renderInline(item, `li-${blockIndex}-${itemIndex}`)}</li>
        ))}
      </ul>,
    );
    bullets = [];
  };

  const flushParagraph = () => {
    if (!paragraph.length) return;
    blocks.push(
      <p key={`p-${blockIndex++}`}>
        {renderInline(paragraph.join(" "), `p-${blockIndex}`)}
      </p>,
    );
    paragraph = [];
  };

  for (const rawLine of lines) {
    const line = rawLine.trim();

    if (!line) {
      flushBullets();
      flushParagraph();
      continue;
    }

    const heading = line.match(/^(#{1,4})\s+(.+)$/);
    if (heading) {
      flushBullets();
      flushParagraph();
      const level = Math.min(heading[1].length + 2, 6);
      const HeadingTag = `h${level}` as "h3" | "h4" | "h5" | "h6";
      blocks.push(
        <HeadingTag key={`h-${blockIndex++}`}>
          {renderInline(heading[2], `h-${blockIndex}`)}
        </HeadingTag>,
      );
      continue;
    }

    const bullet = line.match(/^[-*]\s+(.+)$/);
    if (bullet) {
      flushParagraph();
      bullets.push(bullet[1]);
      continue;
    }

    if (line.startsWith(">")) {
      flushBullets();
      flushParagraph();
      blocks.push(
        <blockquote key={`q-${blockIndex++}`}>
          {renderInline(line.replace(/^>\s?/, ""), `q-${blockIndex}`)}
        </blockquote>,
      );
      continue;
    }

    paragraph.push(line);
  }

  flushBullets();
  flushParagraph();

  return <div className="release-notes-body">{blocks}</div>;
}
