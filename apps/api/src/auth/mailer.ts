import nodemailer, { type Transporter } from 'nodemailer';

/**
 * Magic-link mail transport — picks the best available channel.
 *
 *   1. SMTP via nodemailer if CTK_SENDER_EMAIL + CTK_SENDER_PASSWORD are set
 *      (Gmail App Password works). Used by Bruce's local dev.
 *   2. Resend (TODO) if RESEND_API_KEY is set — for prod.
 *   3. console.log fallback — keeps the magic link reachable even without
 *      any mail service configured.
 *
 * Credentials are read from process.env at send time. They are never
 * persisted, logged, or echoed. Replace with a brand "from" address before
 * deploying anywhere visible to users.
 */

interface MagicLinkMail {
  email: string;
  url: string;
  token: string;
}

let smtpTransport: Transporter | null = null;

function getSmtpTransport(): Transporter | null {
  const user = process.env.CTK_SENDER_EMAIL;
  const pass = process.env.CTK_SENDER_PASSWORD;
  if (!user || !pass) return null;

  if (!smtpTransport) {
    // Gmail's SMTP. App Passwords (16-char tokens) work with this transport.
    smtpTransport = nodemailer.createTransport({
      host: 'smtp.gmail.com',
      port: 465,
      secure: true,
      auth: { user, pass },
    });
  }
  return smtpTransport;
}

function renderEmail({ email, url }: MagicLinkMail): { html: string; text: string } {
  const text = [
    'Hi,',
    '',
    `Use the link below to sign in to aux as ${email}. It expires in 10 minutes.`,
    '',
    url,
    '',
    `If you didn't request this, you can ignore the message.`,
    '',
    '— aux',
  ].join('\n');

  const html = `<!doctype html>
<html>
  <body style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Helvetica, Arial, sans-serif; background: #EEF2F7; padding: 40px 16px; color: #16181D;">
    <div style="max-width: 480px; margin: 0 auto; background: #ffffff; border: 1px solid #D3DCE7; border-radius: 8px; padding: 32px;">
      <p style="margin: 0 0 16px; font-family: 'JetBrains Mono', monospace; font-size: 11px; letter-spacing: 0.12em; text-transform: uppercase; color: #626973;">aux</p>
      <h1 style="font-size: 24px; font-weight: 500; margin: 0 0 12px; color: #16181D;">Your sign-in link</h1>
      <p style="margin: 0 0 24px; color: #353A43; line-height: 1.6;">
        Use the link below to sign in as <strong>${email}</strong>. It expires in 10 minutes.
      </p>
      <p style="margin: 0 0 24px;">
        <a href="${url}" style="display: inline-block; background: #16181D; color: #EEF2F7; text-decoration: none; padding: 10px 18px; border-radius: 4px; font-size: 14px; font-weight: 500;">
          Sign in to aux
        </a>
      </p>
      <p style="margin: 0; color: #626973; font-size: 12px; line-height: 1.6;">
        If the button doesn't work, copy and paste this URL into your browser:<br/>
        <span style="font-family: 'JetBrains Mono', monospace; font-size: 11px; word-break: break-all;">${url}</span>
      </p>
      <hr style="border: 0; border-top: 1px solid #D3DCE7; margin: 24px 0 0;"/>
      <p style="margin: 16px 0 0; color: #939AA5; font-size: 11px;">
        If you didn't request this, you can ignore the message.
      </p>
    </div>
  </body>
</html>`;

  return { html, text };
}

export async function sendMagicLinkMail(opts: MagicLinkMail): Promise<void> {
  const { email, url, token } = opts;

  // SMTP path — Gmail App Password.
  const transport = getSmtpTransport();
  const from = process.env.CTK_SENDER_EMAIL;
  if (transport && from) {
    const { html, text } = renderEmail(opts);
    await transport.sendMail({
      from: `aux <${from}>`,
      to: email,
      subject: 'Your sign-in link',
      text,
      html,
    });
    console.log(`[auth] magic link emailed to ${email} via SMTP`);
    return;
  }

  // Resend (TODO when RESEND_API_KEY is wired).
  if (process.env.RESEND_API_KEY) {
    console.log(`[auth] (resend stub) magic link for ${email}: ${url}`);
    return;
  }

  // Last-resort dev: log it. Keeps the flow usable when no mail provider exists.
  console.log(`[auth] magic link for ${email}`);
  console.log(`[auth]   url:   ${url}`);
  console.log(`[auth]   token: ${token}`);
}
