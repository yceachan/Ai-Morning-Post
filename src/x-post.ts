import type { RenderedContent } from "./render.js";

export interface XPost {
  name: string;
  handle: string;
  avatarUrl?: string;
  verified: boolean;
  text: string;
  publishedAt: string;
  url: string;
}

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[char]!);
}

function postTextHtml(text: string): string {
  return text.split(/(https?:\/\/[^\s<>]+)/g).map((part) => {
    const escaped = escapeHtml(part);
    return /^https?:\/\//.test(part)
      ? `<a href="${escaped}" style="color:#1d9bf0;text-decoration:none;overflow-wrap:anywhere;word-break:break-word">${escaped}</a>`
      : escaped.replace(/\r\n|\r|\n/g, "<br>");
  }).join("");
}

/** Render the supplied API message as an email-safe, static X post card. */
export function renderXPost(post: XPost): RenderedContent {
  const url = escapeHtml(post.url);
  const name = escapeHtml(post.name);
  const handle = escapeHtml(post.handle);
  const time = `${new Intl.DateTimeFormat("en-US", {
    timeZone: "Asia/Singapore", year: "numeric", month: "short", day: "numeric", hour: "numeric", minute: "2-digit",
  }).format(new Date(post.publishedAt))} · UTC+8`;
  const check = post.verified
    ? ` <span aria-label="Verified" style="display:inline-block;width:16px;height:16px;border-radius:50%;background:#1d9bf0;color:#ffffff;font:700 11px/16px Arial,sans-serif;text-align:center;vertical-align:middle">✓</span>`
    : "";
  const avatar = post.avatarUrl
    ? `<td width="44" valign="top" style="width:44px;padding:0 12px 0 0;border:0;vertical-align:top"><a href="${url}" style="color:#0f1419;text-decoration:none"><img src="${escapeHtml(post.avatarUrl)}" alt="${name}" width="44" height="44" style="display:block;width:44px;max-width:44px;height:44px;margin:0!important;border:0;border-radius:50%"></a></td>`
    : "";
  const html = `<table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0" style="display:table;width:100%;table-layout:fixed;border-collapse:separate;border-spacing:0;border:1px solid #cfd9de;border-radius:12px;background:#ffffff;overflow:visible"><tr><td style="padding:20px;border:0;text-align:left;vertical-align:top">
<table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0" style="display:table;width:100%;border:0;overflow:visible"><tr>
${avatar}<td valign="top" style="padding:0;border:0;vertical-align:top;font-family:Arial,'Segoe UI',sans-serif;line-height:22px"><a href="${url}" style="color:#0f1419;font-size:16px;font-weight:700;text-decoration:none">${name}</a>${check}<br><a href="https://x.com/${handle}" style="color:#536471;font-size:14px;text-decoration:none">@${handle}</a></td>
</tr></table>
<p lang="en" style="margin:16px 0 14px;color:#0f1419;font-family:Arial,'Segoe UI',sans-serif;font-size:19px;line-height:28px;overflow-wrap:anywhere;word-break:break-word">${postTextHtml(post.text)}</p>
<p style="margin:14px 0 0;color:#536471;font-family:Arial,'Segoe UI',sans-serif;font-size:12px;line-height:20px"><a href="${url}" style="color:#536471;text-decoration:none">${escapeHtml(time)}</a></p>
</td></tr></table>`;
  return { html, text: `${post.name}${post.verified ? " ✓" : ""} (@${post.handle})\n${post.text}\n\n${time}\n${post.url}` };
}
