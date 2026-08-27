import sanitizeHtml, { type IOptions, type Attributes } from "sanitize-html";
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

function firstContentHeading(html: string): string | null {
  const heading = html.match(/<h1\b[^>]*>[\s\S]*?<\/h1>/i)?.[0];
  if (!heading) return null;
  const text = plainText(heading).replace(/\s+/g, " ").trim();
  return text || null;
}

function removeContentHeading(html: string): string {
  return html.replace(/<h1\b[^>]*>[\s\S]*?<\/h1>/i, "");
}

function addClassToOpeningTag(html: string, tagName: string, className: string): string {
  const pattern = new RegExp(`<${tagName}(?![^>]*\\bclass=)([^>]*)>`, "gi");
  return html.replace(pattern, `<${tagName} class="${className}"$1>`);
}

function decorateContent(html: string): string {
  let decorated = removeContentHeading(html);
  decorated = decorated.replace(/<h2([^>]*)>\s*概览\s*<\/h2>/gi, '<h2 class="overview-heading"$1>概览</h2>');
  decorated = addClassToOpeningTag(decorated, "h2", "section-heading");
  decorated = decorated.replace(/<h3([^>]*)>(\s*<a\b)/gi, '<h3 class="article-heading"$1>$2');
  decorated = addClassToOpeningTag(decorated, "h3", "summary-heading");
  decorated = addClassToOpeningTag(decorated, "h1", "content-title");
  return decorated;
}

function styleImages(html: string): string {
  let firstImage = true;
  return html.replace(/<img\b([^>]*)>/gi, (_match, rawAttributes: string) => {
    const attributes = rawAttributes
      .replace(/\s+(?:style|width|height)="[^"]*"/gi, "")
      .replace(/\s*\/\s*$/g, "");
    const margin = firstImage ? "0 auto 28px" : "22px auto";
    firstImage = false;
    return `<img width="100%"${attributes} style="display:block;width:100%;max-width:100%;height:auto;margin:${margin};border:0;border-radius:8px">`;
  });
}

const EMAIL_STYLES = `
<style>
  :root { color-scheme: light dark; }
  html, body { width:100% !important; min-width:100% !important; margin:0 !important; padding:0 !important; }
  body { -webkit-text-size-adjust:100%; -ms-text-size-adjust:100%; }
  table { border-collapse:collapse; border-spacing:0; }
  img { border:0; outline:none; text-decoration:none; -ms-interpolation-mode:bicubic; }
  a { overflow-wrap:anywhere; word-break:break-word; }
  .email-content { font-size:16px; line-height:1.8; color:#344054; overflow-wrap:anywhere; }
  .email-content p { margin:0 0 16px; }
  .email-content .content-title { margin:0 0 18px; color:#172033; font-size:24px; line-height:1.35; font-weight:700; }
  .email-content .section-heading { margin:38px 0 14px; padding:18px 0 0; border-top:1px solid #e5e7eb; color:#172033; font-size:20px; line-height:1.45; font-weight:700; letter-spacing:-.01em; }
  .email-content .overview-heading { margin:24px 0 8px; padding:0; border:0; color:#667085; font-size:14px; line-height:22px; font-weight:700; letter-spacing:.08em; }
  .email-content .summary-heading { margin:22px 0 8px; color:#344054; font-size:15px; line-height:1.55; font-weight:700; }
  .email-content .article-heading { margin:30px 0 12px; color:#172033; font-size:18px; line-height:1.55; font-weight:700; }
  .email-content h4, .email-content h5, .email-content h6 { margin:24px 0 10px; color:#172033; font-size:16px; line-height:1.55; }
  .email-content ul, .email-content ol { margin:0 0 22px; padding-left:22px; }
  .email-content li { margin:0 0 8px; padding-left:2px; }
  .email-content li:last-child { margin-bottom:0; }
  .email-content a { color:#175cd3; text-decoration:underline; text-underline-offset:2px; }
  .email-content blockquote { margin:0 0 20px; padding:12px 14px; border-left:3px solid #b2ccf7; background:#f7faff; color:#475467; font-size:14px; line-height:1.75; }
  .email-content code { padding:1px 4px; border-radius:4px; background:#f2f4f7; color:#475467; font-family:ui-monospace,SFMono-Regular,Menlo,monospace; font-size:.86em; }
  .email-content pre { max-width:100%; margin:18px 0; padding:12px; overflow-x:auto; white-space:pre-wrap; overflow-wrap:anywhere; border:1px solid #e5e7eb; border-radius:6px; background:#f8fafc; color:#344054; font-family:ui-monospace,SFMono-Regular,Menlo,monospace; font-size:13px; line-height:1.6; }
  .email-content hr { height:1px; margin:34px 0 22px; border:0; border-top:1px solid #e5e7eb; }
  .email-content img { display:block; width:100%; max-width:100%; height:auto; }
  .email-content figure { margin:20px 0; }
  .email-content figcaption { margin-top:8px; color:#667085; font-size:13px; line-height:1.55; }
  .email-content table { width:100%; max-width:100%; border-collapse:collapse; font-size:14px; line-height:1.6; }
  .email-content th, .email-content td { padding:8px 10px; border-bottom:1px solid #eaecf0; text-align:left; vertical-align:top; }
  @media screen and (max-width:600px) {
    .page-gutter { padding:12px 0 !important; }
    .email-shell { border-left:0 !important; border-right:0 !important; border-radius:0 !important; }
    .email-shell-cell { padding:24px 16px 28px !important; }
    .email-title { font-size:24px !important; line-height:1.3 !important; }
    .email-content { font-size:16px !important; line-height:1.82 !important; }
    .email-content .section-heading { margin-top:34px !important; padding-top:16px !important; font-size:19px !important; }
    .email-content .summary-heading { margin-top:18px !important; font-size:15px !important; }
    .email-content .article-heading { margin-top:26px !important; font-size:18px !important; line-height:1.6 !important; }
    .email-content blockquote { margin-bottom:18px !important; padding:11px 12px !important; }
    .email-content img { margin-top:18px !important; margin-bottom:22px !important; border-radius:6px !important; }
    .email-content > p:first-child > img { margin-top:0 !important; margin-bottom:24px !important; }
    .email-content table { display:block; overflow-x:auto; }
  }
  @media (prefers-color-scheme:dark) {
    body, .page-background { background:#111827 !important; color:#e5e7eb !important; }
    .email-shell { background:#1f2937 !important; border-color:#374151 !important; }
    .email-title, .email-content .content-title, .email-content .section-heading, .email-content .article-heading, .email-content h4, .email-content h5, .email-content h6 { color:#f3f4f6 !important; }
    .email-content { color:#d1d5db !important; }
    .email-content .summary-heading { color:#e5e7eb !important; }
    .email-content .overview-heading, .email-date, .email-footer, .email-footer a { color:#9ca3af !important; }
    .email-content a { color:#93c5fd !important; }
    .email-content blockquote { border-left-color:#60a5fa !important; background:#172554 !important; color:#dbeafe !important; }
    .email-content code, .email-content pre { border-color:#374151 !important; background:#111827 !important; color:#e5e7eb !important; }
    .email-content hr, .email-content th, .email-content td { border-color:#374151 !important; }
  }
</style>`;

/**
 * Wrap sanitized RSS content in conservative table/inline HTML that works in
 * common webmail clients. We intentionally do not embed remote images as MIME
 * attachments; clients can choose whether to load them.
 */
export function renderIssueContent(rawHtml: string, input: RenderIssueInput & { baseUrl?: string }): RenderedContent {
  const mode = input.mode ?? "full";
  let safe = sanitizeContent(rawHtml, input.baseUrl);
  const contentTitle = firstContentHeading(safe);
  if (mode === "compact") {
    // Compact mode keeps the article text but drops potentially very large
    // screenshot galleries, which are the common source of unwieldy emails.
    safe = safe.replace(/<figure\b[^>]*>.*?<\/figure>/gis, "").replace(/<img\b[^>]*>/gi, "");
  }
  safe = safe.replace(/<p>\s*<\/p>/gi, "");
  safe = styleImages(decorateContent(safe));
  const displayTitle = contentTitle ?? input.title;
  const title = escapeHtml(displayTitle);
  const link = escapeHtml(input.link);
  const date = formatDate(input.publishedAt);
  const dateHtml = date ? `<p class="email-date" style="color:#667085;font-size:13px;line-height:20px;margin:0 0 18px">${escapeHtml(date)}</p>` : "";
  const originalHtml = input.link
    ? `<p style="margin:30px 0 0;font-size:15px;line-height:24px"><a href="${link}" target="_blank" rel="noopener noreferrer" style="color:#175cd3;text-decoration:underline">阅读完整日报 <span aria-hidden="true">→</span></a></p>`
    : "";
  const html = `<!doctype html>
<html lang="zh-CN">
<head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${title}</title>${EMAIL_STYLES}</head>
<body class="page-background" style="margin:0;padding:0;background:#f4f6f8;color:#172033;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI','PingFang SC','Hiragino Sans GB','Microsoft YaHei',Arial,sans-serif;-webkit-text-size-adjust:100%">
<table role="presentation" class="page-background" width="100%" cellspacing="0" cellpadding="0" border="0" style="background:#f4f6f8;width:100%"><tr><td class="page-gutter" align="center" style="padding:24px 12px">
<table role="presentation" class="email-shell" width="100%" cellspacing="0" cellpadding="0" border="0" style="width:100%;max-width:680px;background:#fcfcfd;border:1px solid #e5e7eb;border-radius:10px"><tr><td class="email-shell-cell" style="padding:30px 32px 32px">
<h1 class="email-title" style="font-size:25px;line-height:33px;margin:0 0 8px;color:#172033;font-weight:700;letter-spacing:-.01em">${title}</h1>
${dateHtml}
<div class="email-content" style="font-size:16px;line-height:29px;color:#344054;overflow-wrap:anywhere">${safe}</div>
${originalHtml}
<hr style="border:0;border-top:1px solid #e5e7eb;margin:32px 0 16px">
<p class="email-footer" style="color:#98a2b3;font-size:12px;line-height:18px;margin:0">AI Morning Post · 内容来自 RSS：<a href="https://daily.juya.uk/rss.xml" style="color:#98a2b3;text-decoration:underline">daily.juya.uk</a></p>
</td></tr></table>
</td></tr></table>
</body></html>`;

  const bodyText = plainText(safe);
  const text = [displayTitle, date, "", bodyText, input.link ? `阅读完整日报：${input.link}` : "", "", "AI Morning Post · 内容来自 daily.juya.uk/rss.xml"]
    .filter((line, index, values) => line !== "" || (index > 0 && values[index - 1] !== ""))
    .join("\n")
    .trim();
  return { html, text };
}
