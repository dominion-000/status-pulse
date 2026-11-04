/** Shared HTML shell for transactional mail (in-code templates). */

export function emailShell(bodyHtml: string): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8"/>
  <meta name="viewport" content="width=device-width,initial-scale=1"/>
  <title>StatusGrep</title>
</head>
<body style="margin:0;padding:0;background:#0b0f14;">
  <table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="background:#0b0f14;background-image:radial-gradient(ellipse 80% 50% at 15% -10%,rgba(61,214,140,0.18),transparent 55%),radial-gradient(ellipse 70% 45% at 95% 0%,rgba(77,163,255,0.16),transparent 50%);padding:48px 20px;">
    <tr>
      <td align="center">
        <table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="max-width:560px;background:#121820;border:1px solid #2a3544;border-radius:16px;box-shadow:0 0 40px rgba(61,214,140,0.12),0 0 80px rgba(77,163,255,0.08),0 24px 48px rgba(0,0,0,0.45);">
          <tr>
            <td style="padding:28px 32px 20px;border-bottom:1px solid #243041;">
              <span style="font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;font-size:16px;font-weight:700;color:#e8eef6;letter-spacing:0.02em;">Status</span><span style="font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;font-size:16px;font-weight:700;color:#3dd68c;">Grep</span>
            </td>
          </tr>
          <tr>
            <td style="padding:36px 32px 40px;font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;">
              ${bodyHtml}
            </td>
          </tr>
          <tr>
            <td style="padding:20px 32px 28px;border-top:1px solid #243041;">
              <p style="margin:0;font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;font-size:11px;line-height:1.6;color:#8b9bb0;">
                Automated message from StatusGrep / Status Pulse.
              </p>
            </td>
          </tr>
        </table>
        <p style="margin:24px 0 0;font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;font-size:11px;color:#5a6a7a;">&nbsp;</p>
      </td>
    </tr>
  </table>
</body>
</html>`;
}

export function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}
