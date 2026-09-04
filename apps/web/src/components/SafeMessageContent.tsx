import { Fragment, type ReactNode } from "react";

const INLINE_PATTERN = /(\[[^\]\n]{1,160}\]\(https?:\/\/[^\s)]+\)|https?:\/\/[^\s<]+|\*\*[^*\n]+\*\*|`[^`\n]+`|@\[[^\]\n]{2,80}\]|@[\p{L}\p{N}_-]{2,80})/gu;

export function SafeMessageContent({ content }: { content: string }) {
  const urls = extractSafeUrls(content).slice(0, 3);
  return <>
    <p className="chat-message-content">{renderInline(content)}</p>
    {urls.length > 0 && <div className="safe-link-previews">
      {urls.map((url) => <a
        key={url}
        href={url}
        target="_blank"
        rel="noopener noreferrer"
        onClick={(event) => {
          if (!window.desktop?.openExternal) return;
          event.preventDefault();
          void window.desktop.openExternal(url);
        }}
      ><strong>{safeHostname(url)}</strong><span>{url}</span></a>)}
    </div>}
  </>;
}

function renderInline(content: string): ReactNode[] {
  const parts: ReactNode[] = [];
  let cursor = 0;
  for (const match of content.matchAll(INLINE_PATTERN)) {
    const index = match.index ?? 0;
    if (index > cursor) parts.push(withLineBreaks(content.slice(cursor, index), `text-${cursor}`));
    const token = match[0];
    const markdownLink = /^\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)$/.exec(token);
    if (markdownLink && safeUrl(markdownLink[2])) {
      parts.push(<SafeLink key={`link-${index}`} href={markdownLink[2]!}>{markdownLink[1]}</SafeLink>);
    } else if (token.startsWith("http") && safeUrl(trimUrlPunctuation(token))) {
      const url = trimUrlPunctuation(token);
      parts.push(<SafeLink key={`url-${index}`} href={url}>{url}</SafeLink>);
      const suffix = token.slice(url.length);
      if (suffix) parts.push(suffix);
    } else if (token.startsWith("**") && token.endsWith("**")) {
      parts.push(<strong key={`bold-${index}`}>{token.slice(2, -2)}</strong>);
    } else if (token.startsWith("`") && token.endsWith("`")) {
      parts.push(<code key={`code-${index}`}>{token.slice(1, -1)}</code>);
    } else if (token.startsWith("@")) {
      parts.push(<mark className="chat-mention" key={`mention-${index}`}>{token}</mark>);
    } else parts.push(token);
    cursor = index + token.length;
  }
  if (cursor < content.length) parts.push(withLineBreaks(content.slice(cursor), `text-${cursor}`));
  return parts;
}

function SafeLink({ href, children }: { href: string; children: ReactNode }) {
  return <a
    href={href}
    target="_blank"
    rel="noopener noreferrer"
    onClick={(event) => {
      if (!window.desktop?.openExternal) return;
      event.preventDefault();
      void window.desktop.openExternal(href);
    }}
  >{children}</a>;
}

function withLineBreaks(value: string, key: string): ReactNode {
  return value.split("\n").map((line, index, lines) => <Fragment key={`${key}-${index}`}>{line}{index < lines.length - 1 && <br/>}</Fragment>);
}

function extractSafeUrls(content: string): string[] {
  const urls = new Set<string>();
  for (const match of content.matchAll(/https?:\/\/[^\s<)]+/g)) {
    const url = trimUrlPunctuation(match[0]);
    if (safeUrl(url)) urls.add(url);
  }
  for (const match of content.matchAll(/\[[^\]]+\]\((https?:\/\/[^\s)]+)\)/g)) {
    if (safeUrl(match[1]!)) urls.add(match[1]!);
  }
  return [...urls];
}

function safeUrl(value: string | undefined): boolean {
  if (!value || value.length > 2_048) return false;
  try {
    const parsed = new URL(value);
    return parsed.protocol === "https:" || parsed.protocol === "http:";
  } catch { return false; }
}

function safeHostname(value: string): string {
  try { return new URL(value).hostname; }
  catch { return "Link externo"; }
}

function trimUrlPunctuation(value: string): string {
  return value.replace(/[.,!?;:]+$/g, "");
}
