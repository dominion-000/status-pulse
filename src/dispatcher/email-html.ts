/** Shared HTML shell for transactional mail (in-code templates). */

export function emailShell(bodyHtml: string): string {
  return `<!DOCTYPE html>
<html lang="en">
<head><meta charset="utf-8"/><meta name="viewport" content="width=device-width,initial-scale=1"/></head>
<body style="margin:0;padding:0;background:#0b0f14;font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;">
<table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="background:#0b0f14;padding:32px 16px;">
<tr><td align="center">
<table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="max-width:520px;background:#121820;border:1px solid #243041;border-radius:12px;">
<tr><td style="padding:20px 24px;border-bottom:1px solid #243041;">
<span style="font-size:15px;font-weight:700;color:#e8eef6;">Status</span><span style="font-size:15px;font-weight:700;color:#3dd68c;">Grep</span>
</td></tr>
<tr><td style="padding:24px;">${bodyHtml}</td></tr>
<tr><td style="padding:16px 24px;border-top:1px solid #243041;">
<p style="margin:0;font-size:11px;line-height:1.5;color:#8b9bb0;">Automated message from StatusGrep / Status Pulse.</p>
</td></tr>
</table>
</td></tr>
</table>
</body></html>`;
}

export function outageAlertHtml(opts: {
  projectName: string;
  serviceName: string;
}): string {
  return emailShell(`
<p style="margin:0 0 8px;font-size:11px;font-weight:700;letter-spacing:0.06em;text-transform:uppercase;color:#f07178;">Outage</p>
<h1 style="margin:0 0 16px;font-size:18px;font-weight:600;color:#e8eef6;">${escapeHtml(opts.serviceName)} is down</h1>
<p style="margin:0 0 16px;font-size:13px;line-height:1.55;color:#c5d0dc;">
Service <strong style="color:#e8eef6;">${escapeHtml(opts.serviceName)}</strong>
in project <strong style="color:#e8eef6;">${escapeHtml(opts.projectName)}</strong>
is in <strong style="color:#f07178;">Outage</strong>. An incident was opened automatically.
</p>
<p style="margin:0;font-size:13px;line-height:1.55;color:#8b9bb0;">Sign in to acknowledge this alert and coordinate recovery.</p>`);
}

export function subscribeVerifyHtml(opts: {
  projectName: string;
  token: string;
}): string {
  return emailShell(`
<p style="margin:0 0 8px;font-size:11px;font-weight:700;letter-spacing:0.06em;text-transform:uppercase;color:#4da3ff;">Subscription</p>
<h1 style="margin:0 0 16px;font-size:18px;font-weight:600;color:#e8eef6;">Confirm your email</h1>
<p style="margin:0 0 16px;font-size:13px;line-height:1.55;color:#c5d0dc;">
Please confirm your subscription to status updates for
<strong style="color:#e8eef6;">${escapeHtml(opts.projectName)}</strong>.
</p>
<p style="margin:0 0 8px;font-size:12px;color:#8b9bb0;">Verification token</p>
<p style="margin:0;font-size:14px;font-weight:700;color:#3dd68c;word-break:break-all;">${escapeHtml(opts.token)}</p>`);
}

export function memberInviteHtml(opts: {
  projectName: string;
  role: string;
}): string {
  return emailShell(`
<p style="margin:0 0 8px;font-size:11px;font-weight:700;letter-spacing:0.06em;text-transform:uppercase;color:#4da3ff;">Invitation</p>
<h1 style="margin:0 0 16px;font-size:18px;font-weight:600;color:#e8eef6;">You were added to a project</h1>
<p style="margin:0;font-size:13px;line-height:1.55;color:#c5d0dc;">
You now have the role <strong style="color:#e8eef6;">${escapeHtml(opts.role)}</strong>
on <strong style="color:#e8eef6;">${escapeHtml(opts.projectName)}</strong>.
Sign in to StatusGrep to open the project.
</p>`);
}

export function plainFromHtmlRough(html: string): string {
  return html
    .replace(/<style[\s\S]*?<\/style>/gi, "")
    .replace(/<[^>]+>/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}
