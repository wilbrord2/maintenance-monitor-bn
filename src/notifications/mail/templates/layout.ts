const HTML_ESCAPES: Readonly<Record<string, string>> = {
  '&': '&amp;',
  '<': '&lt;',
  '>': '&gt;',
  '"': '&quot;',
  "'": '&#39;',
};

export function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (char) => HTML_ESCAPES[char] ?? char);
}

export interface RenderedEmail {
  readonly subject: string;
  readonly text: string;
  readonly html: string;
}

/** Wraps pre-escaped HTML body content in the shared email layout. */
export function htmlLayout(title: string, bodyHtml: string): string {
  return `<!doctype html>
<html lang="en">
  <head><meta charset="utf-8"><title>${escapeHtml(title)}</title></head>
  <body style="margin:0;padding:24px;background:#f3f2ed;font-family:Arial,Helvetica,sans-serif;color:#1b2430;">
    <table role="presentation" width="100%" style="max-width:560px;margin:0 auto;background:#ffffff;border:1px solid #ddd9ce;">
      <tr><td style="padding:16px 24px;border-bottom:2px solid #1b2430;font-size:18px;font-weight:bold;">Maintenance Monitor</td></tr>
      <tr><td style="padding:24px;font-size:14px;line-height:1.6;">${bodyHtml}</td></tr>
      <tr><td style="padding:12px 24px;border-top:1px solid #ddd9ce;font-size:12px;color:#75736a;">
        This is an automated message. If you did not expect it, contact your system administrator.
      </td></tr>
    </table>
  </body>
</html>`;
}
