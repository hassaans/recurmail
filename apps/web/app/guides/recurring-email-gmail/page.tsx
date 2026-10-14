import type { Metadata } from "next";

const siteUrl = "https://recurmail.com";
const pageUrl = `${siteUrl}/guides/recurring-email-gmail`;
const description =
  "Learn what Gmail's Schedule send can do, where it falls short for repeat messages, and how to send recurring email from your Gmail account.";

export const metadata: Metadata = {
  metadataBase: new URL(siteUrl),
  title: "How to Send Recurring Email in Gmail | RecurMail",
  description,
  alternates: { canonical: pageUrl },
  openGraph: {
    type: "article",
    siteName: "RecurMail",
    title: "How to Send Recurring Email in Gmail | RecurMail",
    description,
    url: pageUrl,
    images: [
      {
        url: `${siteUrl}/opengraph-image`,
        width: 1200,
        height: 630,
        alt: "RecurMail sends recurring email from Gmail",
      },
    ],
  },
  twitter: {
    card: "summary_large_image",
    title: "How to Send Recurring Email in Gmail | RecurMail",
    description,
    images: [`${siteUrl}/opengraph-image`],
  },
};

const guideStyles = `
:root { --rm-bg: #F3FAF6; --rm-paper: #fff; --rm-line: #D5E8DD; --rm-ink: #1B1530; --rm-ink-2: #3F3856; --rm-muted: #6E6886; --rm-grape: #6D3BEF; --rm-grape-dark: #5326D1; --rm-font-display: "Plus Jakarta Sans", "DM Sans", system-ui, sans-serif; --rm-font-body: "DM Sans", -apple-system, BlinkMacSystemFont, "Segoe UI", system-ui, sans-serif; --rm-radius: 18px; --rm-radius-sm: 12px; }
* { box-sizing: border-box; }
body { margin: 0; background: var(--rm-bg); color: var(--rm-ink); font: 17px/1.6 var(--rm-font-body); -webkit-font-smoothing: antialiased; }
a { color: inherit; }
:focus-visible { outline: 3px solid var(--rm-grape); outline-offset: 3px; border-radius: 6px; }
.wrap { width: min(100% - 56px, 1120px); margin-inline: auto; }
.skip-link { position: absolute; z-index: 2; top: 12px; left: -9999px; padding: 10px 14px; border-radius: var(--rm-radius-sm); background: var(--rm-paper); }
.skip-link:focus { left: 16px; }
.site-header { padding-top: 10px; }
.nav { display: flex; align-items: center; justify-content: space-between; gap: 20px; padding: 16px 0; }
.logo { display: inline-flex; align-items: center; gap: 10px; flex: none; font: 700 26px/1 var(--rm-font-display); letter-spacing: -0.03em; text-decoration: none; }
.logo svg { display: block; width: 34px; height: 34px; }
.nav-links { display: flex; align-items: center; justify-content: flex-end; gap: 24px; flex-wrap: wrap; margin: 0; padding: 0; list-style: none; }
.nav-links a { color: var(--rm-ink-2); font-size: 15px; font-weight: 500; text-decoration: none; }
.nav-links a:hover, .text-link:hover { color: var(--rm-grape-dark); }
.guide { min-height: calc(100vh - 180px); padding-top: 64px; padding-bottom: 88px; }
.guide-header { max-width: 760px; margin-bottom: 38px; }
.guide-header h1 { margin: 0; font: 800 clamp(38px, 5vw, 58px)/1.05 var(--rm-font-display); letter-spacing: -0.03em; }
.guide-header p { margin-top: 20px; color: var(--rm-ink-2); font-size: 19px; }
.eyebrow { display: inline-block; margin-bottom: 14px; color: var(--rm-grape-dark); font-size: 14px; font-weight: 600; letter-spacing: 0.02em; }
.guide-content { max-width: 760px; }
.guide-content section { padding-bottom: 32px; }
.guide-content h2 { margin: 0 0 14px; font: 800 clamp(25px, 3vw, 32px)/1.05 var(--rm-font-display); letter-spacing: -0.03em; }
.guide-content p { margin: 0; color: var(--rm-ink-2); }
.guide-content p + p { margin-top: 12px; }
.guide-content ol, .guide-content ul { display: grid; gap: 10px; margin: 16px 0 0; padding-left: 24px; color: var(--rm-ink-2); }
.guide-content li { padding-left: 4px; }
.guide-note { margin: 24px 0; padding: 20px 22px; border: 1px solid var(--rm-line); border-radius: var(--rm-radius); background: var(--rm-paper); }
.text-link { color: var(--rm-grape-dark); font-weight: 600; }
footer { padding: 32px 0 48px; border-top: 1px solid var(--rm-line); color: var(--rm-muted); font-size: 14px; }
.footer-content { display: flex; justify-content: space-between; gap: 24px; flex-wrap: wrap; }
footer p { margin: 0; color: var(--rm-muted); }
@media (max-width: 620px) { .wrap { width: min(100% - 40px, 1120px); } .nav { align-items: flex-start; flex-direction: column; gap: 14px; } .nav-links { justify-content: flex-start; gap: 10px 18px; } .guide { padding-top: 44px; padding-bottom: 64px; } .guide-header p { font-size: 17px; } }
`;

function BrandMark() {
  return (
    <svg viewBox="0 0 64 64" aria-hidden="true">
      <rect width="64" height="64" rx="16" fill="#6D3BEF" />
      <path
        d="M44 22a15 15 0 1 0 4 12"
        fill="none"
        stroke="#FFFFFF"
        strokeWidth="6"
        strokeLinecap="round"
      />
      <path
        d="M38 14l8 8-9 5"
        fill="none"
        stroke="#FFFFFF"
        strokeWidth="6"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

export default function RecurringEmailGmailGuide() {
  return (
    <>
      <link rel="preconnect" href="https://fonts.googleapis.com" />
      <link
        rel="preconnect"
        href="https://fonts.gstatic.com"
        crossOrigin="anonymous"
      />
      <link
        href="https://fonts.googleapis.com/css2?family=Plus+Jakarta+Sans:wght@500;600;700;800&family=DM+Sans:opsz,wght@9..40,400;9..40,500;9..40,600&display=swap"
        rel="stylesheet"
      />
      <style>{guideStyles}</style>
      <a className="skip-link" href="#main">
        Skip to content
      </a>
      <header className="site-header wrap">
        <nav className="nav" aria-label="Main navigation">
          <a className="logo" href="/" aria-label="RecurMail home">
            <BrandMark />
            RecurMail
          </a>
          <ul className="nav-links">
            <li>
              <a href="/#how-it-works">How it works</a>
            </li>
            <li>
              <a href="/#faq">FAQ</a>
            </li>
            <li>
              <a href="/guides/gmail-recurring-email-extension-alternative">
                Extension alternative
              </a>
            </li>
          </ul>
        </nav>
      </header>
      <main id="main" className="guide wrap">
        <article>
          <header className="guide-header">
            <span className="eyebrow">Gmail guide</span>
            <h1>How to send recurring email in Gmail</h1>
            <p>
              Gmail can send a message later once. To repeat the same email
              weekly or monthly, use a recurring email tool that sends through
              your Gmail account.
            </p>
          </header>
          <div className="guide-content">
            <section aria-labelledby="schedule-send-title">
              <h2 id="schedule-send-title">What Gmail Schedule send does</h2>
              <p>
                Gmail&apos;s Schedule send lets you choose a future date and
                time for one message. After it sends, that scheduled message is
                done. Gmail does not add a weekly or monthly repeat to it.
              </p>
              <p>
                You can copy the message and schedule it again by hand, but that
                means setting every send separately. A recurring email service
                keeps one message and schedule together.
              </p>
            </section>
            <section aria-labelledby="set-up-title">
              <h2 id="set-up-title">Set up an email that repeats</h2>
              <ol>
                <li>Connect the Gmail account the email should come from.</li>
                <li>
                  Add the recipients, subject, and message you want to send.
                </li>
                <li>Choose a repeat pattern, time, and time zone.</li>
                <li>Review the next send date and save the schedule.</li>
              </ol>
              <div className="guide-note">
                <p>
                  RecurMail sends each message from your Gmail address, so it
                  appears in Sent and replies come back to you. It requests
                  permission to send email and cannot read your inbox.
                </p>
              </div>
            </section>
            <section aria-labelledby="patterns-title">
              <h2 id="patterns-title">
                Choose a schedule that fits the message
              </h2>
              <p>
                Use a monthly schedule for rent reminders or invoices, weekdays
                for a regular team update, or every other Friday for a
                timesheet. Set the time zone where the email should arrive.
              </p>
              <p>
                You can review or pause a schedule when plans change. RecurMail
                keeps a send history so you can check when each message went
                out.
              </p>
            </section>
            <section aria-labelledby="next-title">
              <h2 id="next-title">See the recurring email options</h2>
              <p>
                <a className="text-link" href="/">
                  Read how RecurMail works
                </a>{" "}
                or compare it with a{" "}
                <a
                  className="text-link"
                  href="/guides/gmail-recurring-email-extension-alternative"
                >
                  Gmail recurring email extension alternative
                </a>
                .
              </p>
            </section>
          </div>
        </article>
      </main>
      <footer>
        <div className="wrap footer-content">
          <p>© 2026 RecurMail · Recurring email for Gmail</p>
          <p>
            Gmail is a trademark of Google LLC. RecurMail is not affiliated with
            or endorsed by Google.
          </p>
        </div>
      </footer>
    </>
  );
}
