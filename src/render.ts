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
  const innerHtml = heading.replace(/^<h1\b[^>]*>/i, "").replace(/<\/h1>$/i, "");
  const text = plainText(innerHtml).replace(/\s+/g, " ").trim();
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
  decorated = decorated.replace(/(<h3 class="article-heading"[^>]*>\s*<a\b)([^>]*)(>)/gi, (_match, prefix: string, attributes: string, close: string) => {
    const cleanAttributes = attributes.replace(/\s+style="[^"]*"/gi, "");
    return `${prefix}${cleanAttributes} style="color:#2c2926;text-decoration:none"${close}`;
  });
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
  :root { color-scheme: light; }
  html, body { width:100% !important; min-width:100% !important; margin:0 !important; padding:0 !important; }
  body { -webkit-text-size-adjust:100%; -ms-text-size-adjust:100%; }
  table { border-collapse:collapse; border-spacing:0; }
  img { border:0; outline:none; text-decoration:none; -ms-interpolation-mode:bicubic; }
  a { overflow-wrap:anywhere; word-break:break-word; }
  .email-content { font-size:16px; line-height:1.82; color:#2c2926; font-family:"Avenir Next","Segoe UI","PingFang SC","Hiragino Sans GB","Microsoft YaHei",ui-sans-serif,system-ui,sans-serif; overflow-wrap:anywhere; }
  .email-content p { margin:0 0 16px; }
  .email-content .content-title { margin:0 0 18px; color:#2c2926; font-family:"Iowan Old Style","Baskerville","STSong","Noto Serif CJK SC",Georgia,"Times New Roman",serif; font-size:24px; line-height:1.35; font-weight:600; letter-spacing:-.02em; }
  .email-content .section-heading { margin:38px 0 14px; padding:18px 0 0; border-top:1px solid #e5ded4; color:#2c2926; font-family:"Iowan Old Style","Baskerville","STSong","Noto Serif CJK SC",Georgia,"Times New Roman",serif; font-size:22px; line-height:1.4; font-weight:600; letter-spacing:-.02em; }
  .email-content .overview-heading { margin:24px 0 10px; padding:0 0 8px; border:0; border-bottom:1px solid #e5ded4; color:#968c81; font-size:14px; line-height:22px; font-weight:650; letter-spacing:.08em; }
  .email-content .summary-heading { margin:22px 0 8px; color:#2c2926; font-size:16px; line-height:1.55; font-weight:650; }
  .email-content .article-heading { margin:30px 0 12px; color:#2c2926; font-size:18px; line-height:1.55; font-weight:650; }
  .email-content .article-heading a { color:inherit !important; text-decoration:none !important; }
  .email-content h4, .email-content h5, .email-content h6 { margin:24px 0 10px; color:#2c2926; font-size:16px; line-height:1.55; }
  .email-content ul, .email-content ol { margin:0 0 22px; padding-left:22px; }
  .email-content li { margin:0 0 8px; padding-left:2px; }
  .email-content li:last-child { margin-bottom:0; }
  .email-content a { color:#a45d47; text-decoration:underline; text-decoration-color:#c4a197; text-underline-offset:.16em; }
  .email-content blockquote { margin:0 0 20px; padding:12px 14px; border-left:3px solid #d2c8bc; background:#f0ebe4; color:#6e665e; font-size:14px; line-height:1.75; }
  .email-content code { padding:1px 4px; border-radius:4px; background:#f0ebe4; color:#755342; font-family:"SFMono-Regular","Cascadia Code","Roboto Mono",Consolas,monospace; font-size:.86em; }
  .email-content pre { max-width:100%; margin:18px 0; padding:12px; overflow-x:auto; white-space:pre-wrap; overflow-wrap:anywhere; border:1px solid #e5ded4; border-radius:8px; background:#f0ebe4; color:#2c2926; font-family:"SFMono-Regular","Cascadia Code","Roboto Mono",Consolas,monospace; font-size:13px; line-height:1.6; }
  .email-content hr { height:1px; margin:34px 0 22px; border:0; border-top:1px solid #e5ded4; }
  .email-content img { display:block; width:100%; max-width:100%; height:auto; }
  .email-content figure { margin:20px 0; }
  .email-content figcaption { margin-top:8px; color:#968c81; font-size:13px; line-height:1.55; }
  .email-content table { width:100%; max-width:100%; border-collapse:collapse; font-size:14px; line-height:1.6; }
  .email-content th, .email-content td { padding:8px 10px; border-bottom:1px solid #e5ded4; text-align:left; vertical-align:top; }
  @media screen and (max-width:600px) {
    .page-gutter { padding:12px 0 !important; }
    .email-shell { border-left:0 !important; border-right:0 !important; border-radius:0 !important; }
    .email-shell-cell { padding:24px 16px 28px !important; }
    .email-title { font-size:24px !important; line-height:1.3 !important; }
    .email-content { font-size:16px !important; line-height:1.82 !important; }
    .email-content .section-heading { margin-top:34px !important; padding-top:16px !important; font-size:21px !important; }
    .email-content .summary-heading { margin-top:18px !important; font-size:16px !important; }
    .email-content .article-heading { margin-top:26px !important; font-size:18px !important; line-height:1.6 !important; }
    .email-content blockquote { margin-bottom:18px !important; padding:11px 12px !important; }
    .email-content img { margin-top:18px !important; margin-bottom:22px !important; border-radius:6px !important; }
    .email-content > p:first-child > img { margin-top:0 !important; margin-bottom:24px !important; }
    .email-content table { display:block; overflow-x:auto; }
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
  const dateHtml = date ? `<p class="email-date" style="color:#6e665e;font-size:13px;line-height:20px;margin:0 0 18px">${escapeHtml(date)}</p>` : "";
  const originalHtml = input.link
    ? `<p style="margin:30px 0 0;font-size:15px;line-height:24px"><a href="${link}" target="_blank" rel="noopener noreferrer" style="color:#a45d47;text-decoration:underline;text-decoration-color:#c4a197">阅读完整日报 <span aria-hidden="true">→</span></a></p>`
    : "";
  const html = `<!doctype html>
<html lang="zh-CN">
<head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="color-scheme" content="light"><title>${title}</title>${EMAIL_STYLES}</head>
<body class="page-background" style="margin:0;padding:0;background:#f0ebe4;color:#2c2926;font-family:'Avenir Next',-apple-system,BlinkMacSystemFont,'Segoe UI','PingFang SC','Hiragino Sans GB','Microsoft YaHei',Arial,sans-serif;-webkit-text-size-adjust:100%">
<table role="presentation" class="page-background" width="100%" cellspacing="0" cellpadding="0" border="0" style="background:#f0ebe4;width:100%"><tr><td class="page-gutter" align="center" style="padding:24px 12px">
<table role="presentation" class="email-shell" width="100%" cellspacing="0" cellpadding="0" border="0" style="width:100%;max-width:680px;background:#fdfdf7;border:1px solid #e5ded4;border-top:3px solid #a45d47;border-radius:10px;box-shadow:0 12px 30px rgba(72,58,47,.12)"><tr><td class="email-shell-cell" style="padding:30px 32px 32px">
<h1 class="email-title" style="font-size:27px;line-height:35px;margin:0 0 8px;color:#2c2926;font-family:'Iowan Old Style','Baskerville','STSong','Noto Serif CJK SC',Georgia,'Times New Roman',serif;font-weight:600;letter-spacing:-.02em">${title}</h1>
${dateHtml}
<div class="email-content" style="font-size:16px;line-height:29px;color:#2c2926;overflow-wrap:anywhere">${safe}</div>
${originalHtml}
<hr style="border:0;border-top:1px solid #e5ded4;margin:32px 0 16px">
<p class="email-footer" style="color:#968c81;font-size:12px;line-height:18px;margin:0">AI Morning Post · 内容来自 RSS：<a href="https://daily.juya.uk/rss.xml" style="color:#968c81;text-decoration:underline">daily.juya.uk</a></p>
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
