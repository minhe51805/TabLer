import { Fragment, type ReactNode } from "react";

interface AIWorkspaceMarkdownProps {
  text?: string | null;
  className?: string;
  compact?: boolean;
}

type MarkdownBlock =
  | { type: "heading"; level: 1 | 2 | 3; text: string }
  | { type: "paragraph"; lines: string[] }
  | { type: "list"; ordered: boolean; items: string[] }
  | { type: "code"; language?: string; code: string }
  | { type: "table"; headers: string[]; rows: string[][] };

function isTableSeparator(line: string) {
  return /^\|?(?:\s*:?-{3,}:?\s*\|)+\s*:?-{3,}:?\s*\|?$/.test(line.trim());
}

function splitMarkdownTableRow(line: string) {
  return line
    .trim()
    .replace(/^\|/, "")
    .replace(/\|$/, "")
    .split("|")
    .map((cell) => cell.trim());
}

function renderInlineMarkdown(text: string, keyPrefix: string): ReactNode[] {
  const nodes: ReactNode[] = [];
  let buffer = "";
  let cursor = 0;

  const flushBuffer = () => {
    if (!buffer) return;
    nodes.push(<Fragment key={`${keyPrefix}-text-${nodes.length}`}>{buffer}</Fragment>);
    buffer = "";
  };

  while (cursor < text.length) {
    if (text.startsWith("**", cursor)) {
      const closingIndex = text.indexOf("**", cursor + 2);
      if (closingIndex !== -1) {
        flushBuffer();
        const content = text.slice(cursor + 2, closingIndex);
        nodes.push(
          <strong key={`${keyPrefix}-strong-${nodes.length}`}>
            {renderInlineMarkdown(content, `${keyPrefix}-strong-${nodes.length}`)}
          </strong>,
        );
        cursor = closingIndex + 2;
        continue;
      }
    }

    if (text[cursor] === "`") {
      const closingIndex = text.indexOf("`", cursor + 1);
      if (closingIndex !== -1) {
        flushBuffer();
        nodes.push(
          <code key={`${keyPrefix}-code-${nodes.length}`} className="ai-workspace-markdown-inline-code">
            {text.slice(cursor + 1, closingIndex)}
          </code>,
        );
        cursor = closingIndex + 1;
        continue;
      }
    }

    buffer += text[cursor];
    cursor += 1;
  }

  flushBuffer();
  return nodes;
}

function renderMultilineInlineMarkdown(lines: string[], keyPrefix: string) {
  return lines.map((line, index) => (
    <Fragment key={`${keyPrefix}-line-${index}`}>
      {renderInlineMarkdown(line, `${keyPrefix}-line-${index}`)}
      {index < lines.length - 1 ? <br /> : null}
    </Fragment>
  ));
}

function parseMarkdownBlocks(text: string): MarkdownBlock[] {
  const normalized = text.replace(/\r\n?/g, "\n").trim();
  if (!normalized) return [];

  const lines = normalized.split("\n");
  const blocks: MarkdownBlock[] = [];
  let index = 0;

  while (index < lines.length) {
    const rawLine = lines[index];
    const trimmed = rawLine.trim();

    if (!trimmed) {
      index += 1;
      continue;
    }

    const headingMatch = trimmed.match(/^(#{1,3})\s+(.+)$/);
    if (headingMatch) {
      blocks.push({
        type: "heading",
        level: headingMatch[1].length as 1 | 2 | 3,
        text: headingMatch[2].trim(),
      });
      index += 1;
      continue;
    }

    if (trimmed.startsWith("```")) {
      const language = trimmed.slice(3).trim() || undefined;
      const codeLines: string[] = [];
      index += 1;
      while (index < lines.length && !lines[index].trim().startsWith("```")) {
        codeLines.push(lines[index]);
        index += 1;
      }
      if (index < lines.length) index += 1;
      blocks.push({ type: "code", language, code: codeLines.join("\n").trimEnd() });
      continue;
    }

    if (index + 1 < lines.length && trimmed.includes("|") && isTableSeparator(lines[index + 1])) {
      const headers = splitMarkdownTableRow(trimmed);
      const rows: string[][] = [];
      index += 2;

      while (index < lines.length) {
        const candidate = lines[index].trim();
        if (!candidate || !candidate.includes("|")) break;
        rows.push(splitMarkdownTableRow(candidate));
        index += 1;
      }

      blocks.push({ type: "table", headers, rows });
      continue;
    }

    const unorderedMatch = trimmed.match(/^[-*]\s+(.+)$/);
    if (unorderedMatch) {
      const items: string[] = [];
      while (index < lines.length) {
        const listLine = lines[index].trim();
        const match = listLine.match(/^[-*]\s+(.+)$/);
        if (!match) break;
        items.push(match[1].trim());
        index += 1;
      }
      blocks.push({ type: "list", ordered: false, items });
      continue;
    }

    const orderedMatch = trimmed.match(/^\d+\.\s+(.+)$/);
    if (orderedMatch) {
      const items: string[] = [];
      while (index < lines.length) {
        const listLine = lines[index].trim();
        const match = listLine.match(/^\d+\.\s+(.+)$/);
        if (!match) break;
        items.push(match[1].trim());
        index += 1;
      }
      blocks.push({ type: "list", ordered: true, items });
      continue;
    }

    const paragraphLines: string[] = [trimmed];
    index += 1;
    while (index < lines.length) {
      const candidate = lines[index].trim();
      if (
        !candidate ||
        candidate.startsWith("```") ||
        /^(#{1,3})\s+/.test(candidate) ||
        /^[-*]\s+/.test(candidate) ||
        /^\d+\.\s+/.test(candidate) ||
        (candidate.includes("|") && index + 1 < lines.length && isTableSeparator(lines[index + 1]))
      ) {
        break;
      }
      paragraphLines.push(candidate);
      index += 1;
    }
    blocks.push({ type: "paragraph", lines: paragraphLines });
  }

  return blocks;
}

export function AIWorkspaceMarkdown({ text, className, compact = false }: AIWorkspaceMarkdownProps) {
  const blocks = parseMarkdownBlocks(text ?? "");

  if (!blocks.length) return null;

  return (
    <div className={["ai-workspace-markdown", compact ? "is-compact" : "", className].filter(Boolean).join(" ")}>
      {blocks.map((block, index) => {
        const key = `block-${index}`;

        if (block.type === "heading") {
          return (
            <div key={key} className={`ai-workspace-markdown-heading ai-workspace-markdown-heading--h${block.level}`}>
              {renderInlineMarkdown(block.text, `${key}-heading`)}
            </div>
          );
        }

        if (block.type === "list") {
          const ListTag = block.ordered ? "ol" : "ul";
          return (
            <ListTag key={key} className="ai-workspace-markdown-list">
              {block.items.map((item, itemIndex) => (
                <li key={`${key}-item-${itemIndex}`}>{renderInlineMarkdown(item, `${key}-item-${itemIndex}`)}</li>
              ))}
            </ListTag>
          );
        }

        if (block.type === "code") {
          return (
            <pre key={key} className="ai-workspace-markdown-code" data-language={block.language ?? ""}>
              {block.code}
            </pre>
          );
        }

        if (block.type === "table") {
          return (
            <div key={key} className="ai-workspace-markdown-table-wrap">
              <table className="ai-workspace-markdown-table">
                <thead>
                  <tr>
                    {block.headers.map((header, headerIndex) => (
                      <th key={`${key}-header-${headerIndex}`}>
                        {renderInlineMarkdown(header, `${key}-header-${headerIndex}`)}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {block.rows.map((row, rowIndex) => (
                    <tr key={`${key}-row-${rowIndex}`}>
                      {row.map((cell, cellIndex) => (
                        <td key={`${key}-row-${rowIndex}-cell-${cellIndex}`}>
                          {renderInlineMarkdown(cell, `${key}-row-${rowIndex}-cell-${cellIndex}`)}
                        </td>
                      ))}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          );
        }

        return (
          <p key={key} className="ai-workspace-markdown-paragraph">
            {renderMultilineInlineMarkdown(block.lines, `${key}-paragraph`)}
          </p>
        );
      })}
    </div>
  );
}
