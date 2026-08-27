import sanitizeHtml, { type IOptions, type Tag, type Attributes } from "sanitize-html";
import { convert } from "html-to-text";

export interface RenderIssueInput {
  title: string;
  link: string;
  publishedAt: string | null;
  mode?: "full" | "compact";
}

export interface RenderedContent {
  html: string;
  text: string;
}

const SANITIZE_OPTIONS: IOptions = {
  allowedTags: [
    "a", "abbr", "b", "blockquote", "br", "code", "del", "div", "em", "figcaption", "figure",
    "h1", "h2", "h3", "h4", "h5", "h6", "hr", "i", "img", "li", "ol", "p", "pre", "small",
    "span", "strong", "sub", "sup", "table", "tbody", "td", "tfoot", "th", "thead", "tr", "u", "ul",
  ],
  allowedAttributes: {
    a: ["href", "title", "target", "rel"],
    img: ["src", "alt", "title", "width", "height"],
    "*": ["align"],
  },
  allowedSchemes: ["http", "https", "mailto"],
  allowProtocolRelative: false,
  disallowedTagsMode: "discard",
};

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (character) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&#39;",
  })[character] as string);
}

function formatDate(value: string | null): string {
  if (!value) return "";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return new Intl.DateTimeFormat("zh-CN", {
    timeZone: "Asia/Singapore",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(date);
}

function absoluteUrl(value: string, baseUrl: string | undefined): string {
  if (!baseUrl) return value;
  try {
    return new URL(value, baseUrl).toString();
  } catch {
    return value;
  }
}

function sanitizeContent(rawHtml: string, baseUrl?: string): string {
  const options: IOptions = {
    ...SANITIZE_OPTIONS,
    transformTags: {
      a: (_tagName: string, attribs: Attributes): { tagName: string; attribs: Attributes } => {
        if (attribs.href) attribs.href = absoluteUrl(attribs.href, baseUrl);
        attribs.target = "_blank";
        attribs.rel = "noopener noreferrer";
        return { tagName: "a", attribs };
      },
      img: (_tagName: string, attribs: Attributes): { tagName: string; attribs: Attributes } => {
        if (attribs.src) attribs.src = absoluteUrl(attribs.src, baseUrl);
        return { tagName: "img", attribs };
      },
    },
  };
  return sanitizeHtml(rawHtml || "", options);
}

function plainText(html: string): string {
  return convert(html, {
    wordwrap: 100,
    selectors: [
      { selector: "a", options: { hideLinkHrefIfSameAsText: true } },
      { selector: "img", format: "skip" },
    ],
  }).trim();
}

/**
 * Wrap sanitized RSS content in conservative table/inline HTML that works in
 * common webmail clients. We intentionally do not embed remote images as MIME
 * attachments; clients can choose whether to load them.
 */
export function renderIssueContent(rawHtml: string, input: RenderIssueInput & { baseUrl?: string }): RenderedContent {
  const mode = input.mode ?? "full";
  let safe = sanitizeContent(rawHtml, input.baseUrl);
  if (mode === "compact") {
    // Compact mode keeps the article text but drops potentially very large
    // screenshot galleries, which are the common source of unwieldy emails.
    safe = safe.replace(/<figure\b[^>]*>.*?<\/figure>/gis, "").replace(/<img\b[^>]*>/gi, "");
  }
  const title = escapeHtml(input.title);
  const link = escapeHtml(input.link);
  const date = formatDate(input.publishedAt);
  const dateHtml = date ? `<div style="color:#667085;font-size:13px;line-height:20px;margin:0 0 18px">${escapeHtml(date)}</div>` : "";
  const originalHtml = input.link
    ? `<p style="margin:28px 0 0"><a href="${link}" target="_blank" rel="noopener noreferrer" style="color:#175cd3;text-decoration:none">阅读完整日报 →</a></p>`
    : "";
  const html = `<!doctype html>
<html lang="zh-CN">
<head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${title}</title></head>
<body style="margin:0;padding:0;background:#f2f4f7;color:#101828;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI','PingFang SC','Microsoft YaHei',Arial,sans-serif">
<table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0" style="background:#f2f4f7;width:100%"><tr><td align="center" style="padding:24px 12px">
<table role="presentation" width="680" cellspacing="0" cellpadding="0" border="0" style="width:100%;max-width:680px;background:#fff;border:1px solid #eaecf0;border-radius:10px"><tr><td style="padding:32px 30px">
<h1 style="font-size:26px;line-height:34px;margin:0 0 8px;color:#101828;font-weight:700">${title}</h1>
${dateHtml}
<div style="font-size:16px;line-height:28px;color:#344054;overflow-wrap:anywhere">${safe}</div>
${originalHtml}
<hr style="border:0;border-top:1px solid #eaecf0;margin:30px 0 16px">
<p style="color:#98a2b3;font-size:12px;line-height:18px;margin:0">AI Morning Post · 内容来自 RSS：<a href="https://daily.juya.uk/rss.xml" style="color:#98a2b3">daily.juya.uk</a></p>
</td></tr></table>
</td></tr></table>
</body></html>`;

  const bodyText = plainText(safe);
  const text = [input.title, date, "", bodyText, input.link ? `阅读完整日报：${input.link}` : "", "", "AI Morning Post · 内容来自 daily.juya.uk/rss.xml"]
    .filter((line, index, values) => line !== "" || (index > 0 && values[index - 1] !== ""))
    .join("\n")
    .trim();
  return { html, text };
}
