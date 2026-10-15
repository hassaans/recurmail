import type { Metadata } from "next";
import { SiteFooter } from "../../../components/SiteFooter";
import { SiteHeader } from "../../../components/SiteHeader";

const siteUrl = "https://recurmail.com";
const pageUrl = `${siteUrl}/guides/gmail-recurring-email-extension-alternative`;
const description =
  "Compare a free Gmail recurring email extension alternative with browser add-ons, and learn what to check before connecting an account.";

export const metadata: Metadata = {
  metadataBase: new URL(siteUrl),
  title: "Free Gmail Recurring Email Extension Alternative | RecurMail",
  description,
  alternates: { canonical: pageUrl },
  openGraph: {
    type: "article",
    siteName: "RecurMail",
    title: "Free Gmail Recurring Email Extension Alternative | RecurMail",
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
    title: "Free Gmail Recurring Email Extension Alternative | RecurMail",
    description,
    images: [`${siteUrl}/opengraph-image`],
  },
};

const guideStyles = `
:root { --rm-bg: #F3FAF6; --rm-paper: #fff; --rm-line: #D5E8DD; --rm-ink: #1B1530; --rm-ink-2: #3F3856; --rm-muted: #6E6886; --rm-grape: #6D3BEF; --rm-grape-dark: #5326D1; --rm-radius: 18px; --rm-radius-sm: 12px; }
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
.nav-links { display: flex; align-items: center; justify-content: flex-end; gap: 24px; flex-wrap: wrap; margin: 0 0 0 auto; padding: 0; list-style: none; }
.nav-links a { color: var(--rm-ink-2); font-size: 15px; font-weight: 500; text-decoration: none; }
.nav-links a:hover, .text-link:hover { color: var(--rm-grape-dark); }
.nav a.nav-primary { flex: none; margin-left: 4px; text-decoration: none; padding: 11px 16px; border-radius: 999px; background: var(--rm-grape); color: #fff; font-weight: 600; white-space: nowrap; }
.nav a.nav-primary:hover { background: var(--rm-grape-dark); color: #fff; }
.nav-links a.nav-login { white-space: nowrap; }
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
@media (max-width: 860px) { .nav { display: grid; grid-template-columns: minmax(0, 1fr) auto; grid-template-areas: "logo cta" "links links"; align-items: center; gap: 14px 12px; } .logo { grid-area: logo; justify-self: start; } .nav a.nav-primary { grid-area: cta; margin-left: 0; } .nav-links { grid-area: links; justify-content: flex-start; gap: 10px 20px; margin: 0; } .nav-links li:last-child { margin-left: auto; } }
@media (max-width: 620px) { .wrap { width: min(100% - 40px, 1120px); } .logo { gap: 8px; font-size: 22px; } .logo svg { width: 30px; height: 30px; } .nav a.nav-primary { padding: 10px 12px; font-size: 14px; } .guide { padding-top: 44px; padding-bottom: 64px; } .guide-header p { font-size: 17px; } }
@media (max-width: 359px) { .nav { grid-template-columns: minmax(0, 1fr); grid-template-areas: "logo" "cta" "links"; } .nav a.nav-primary { justify-self: start; } }
`;

export default function GmailExtensionAlternativeGuide() {
  return (
    <>
      <style>{guideStyles}</style>
      <a className="skip-link" href="#main">
        Skip to content
      </a>
      <SiteHeader variant="guide" relatedGuide="extension" />
      <main id="main" className="guide wrap">
        <article>
          <header className="guide-header">
            <span className="eyebrow">Gmail guide</span>
            <h1>A free alternative to Gmail recurring email extensions</h1>
            <p>
              A browser extension can add repeat scheduling to the Gmail screen.
              A separate service can manage schedules outside the browser and
              send from your Gmail account.
            </p>
          </header>
          <div className="guide-content">
            <section aria-labelledby="compare-title">
              <h2 id="compare-title">What to compare before choosing</h2>
              <p>
                Check where schedules are stored, whether your computer must
                stay open, which Google permissions the tool requests, and how
                it handles time zones and failed sends. Those details affect how
                a schedule behaves after setup.
              </p>
              <p>
                An extension works in the browser where you installed it. A
                service such as RecurMail runs scheduled sends on its servers,
                so your browser and phone can be off when an email is due.
              </p>
            </section>
            <section aria-labelledby="permissions-title">
              <h2 id="permissions-title">Review Gmail permissions</h2>
              <p>
                Before connecting any tool, read the Google permissions screen.
                A service that only sends scheduled email should not need access
                to read your inbox, drafts, or contacts. You can remove an
                app&apos;s access later from your Google account settings.
              </p>
              <div className="guide-note">
                <p>
                  RecurMail requests permission to send email on your behalf. It
                  cannot read your inbox, sent mail, drafts, or contacts.
                  Scheduled messages appear in your Sent folder.
                </p>
              </div>
            </section>
            <section aria-labelledby="which-title">
              <h2 id="which-title">Which option fits your workflow?</h2>
              <ul>
                <li>
                  Choose an extension if you want scheduling controls inside
                  Gmail and are comfortable relying on a browser add-on.
                </li>
                <li>
                  Choose a separate service if schedules should keep running
                  when your devices are off, or if you want to manage them from
                  a web app or phone.
                </li>
                <li>
                  Use Gmail Schedule send for a single message that should go
                  out later once.
                </li>
              </ul>
            </section>
            <section aria-labelledby="learn-title">
              <h2 id="learn-title">Learn how recurring email works</h2>
              <p>
                <a className="text-link" href="/">
                  See RecurMail&apos;s features and privacy details
                </a>
                , or read{" "}
                <a className="text-link" href="/guides/recurring-email-gmail">
                  how to send recurring email in Gmail
                </a>
                .
              </p>
            </section>
          </div>
        </article>
      </main>
      <SiteFooter variant="marketing" />
    </>
  );
}
