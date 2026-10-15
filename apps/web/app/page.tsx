import type { Metadata } from "next";
import { SiteFooter } from "../components/SiteFooter";
import { SiteHeader } from "../components/SiteHeader";

const siteUrl = "https://recurmail.com";

const faqs = [
  {
    question: "Can Gmail send recurring emails on its own?",
    answer:
      "No. Gmail's Schedule send delivers one message at one chosen time. It does not repeat. RecurMail lets you write a message once, choose a schedule, and sends each message from your Gmail account.",
  },
  {
    question: "Is RecurMail free?",
    answer: "Yes. RecurMail is free and has no paid plans.",
  },
  {
    question: "Can RecurMail read my email?",
    answer:
      "No. RecurMail requests permission to send email for you. It cannot read your inbox, sent mail, drafts, or contacts.",
  },
  {
    question: "How many emails can I send each day from Gmail?",
    answer:
      "Personal Gmail accounts can send to about 500 recipients each day. Google Workspace accounts can send to about 2,000. To, Cc, and Bcc recipients count. RecurMail totals your schedules and warns you as you approach the limit.",
  },
  {
    question: "Does RecurMail work with Google Workspace?",
    answer:
      "Yes. RecurMail works with personal Gmail and Google Workspace accounts and uses the daily limit for each account type.",
  },
];

export const metadata: Metadata = {
  metadataBase: new URL(siteUrl),
  title: "Send recurring emails from Gmail for free | RecurMail",
  description:
    "Write an email once and choose a schedule. RecurMail sends it from your Gmail account each time, with a record in Sent. Free to use.",
  alternates: { canonical: siteUrl },
  openGraph: {
    type: "website",
    siteName: "RecurMail",
    title: "Send recurring emails from your own Gmail | RecurMail",
    description:
      "Send rent reminders, weekly updates, and other repeat emails from your Gmail address. RecurMail is free to use.",
    url: siteUrl,
    images: [
      {
        url: `${siteUrl}/opengraph-image`,
        width: 1200,
        height: 630,
        alt: "RecurMail sends scheduled emails from your Gmail account",
      },
    ],
  },
  twitter: {
    card: "summary_large_image",
    title: "Send recurring emails from Gmail for free | RecurMail",
    description:
      "Write an email once, choose a schedule, and send it from your Gmail account each time.",
    images: [`${siteUrl}/opengraph-image`],
  },
};

const structuredData = {
  "@context": "https://schema.org",
  "@graph": [
    {
      "@type": "WebSite",
      "@id": `${siteUrl}/#website`,
      url: siteUrl,
      name: "RecurMail",
    },
    {
      "@type": "SoftwareApplication",
      "@id": `${siteUrl}/#software`,
      name: "RecurMail",
      applicationCategory: "BusinessApplication",
      operatingSystem: "Web",
      description:
        "Send recurring emails from your own Gmail account on a schedule with the RecurMail web app.",
      url: siteUrl,
      offers: { "@type": "Offer", price: "0", priceCurrency: "USD" },
    },
    {
      "@type": "FAQPage",
      "@id": `${siteUrl}/#faq`,
      mainEntity: faqs.map(({ question, answer }) => ({
        "@type": "Question",
        name: question,
        acceptedAnswer: { "@type": "Answer", text: answer },
      })),
    },
  ],
};

const globalStyles = `
:root {
  --rm-bg: #F3FAF6; --rm-bg-2: #E4F3EB; --rm-paper: #FFFFFF; --rm-line: #D5E8DD;
  --rm-ink: #1B1530; --rm-ink-2: #3F3856; --rm-muted: #6E6886;
  --rm-grape: #6D3BEF; --rm-grape-dark: #5326D1; --rm-grape-soft: #ECE4FF;
  --rm-teal: #0E9F87; --rm-teal-dark: #0B7564; --rm-teal-soft: #D3F2EA; --rm-sun: #FFD84D;
  --rm-sun-soft: #FFF3BF; --rm-sky-soft: #E3EBFF; --rm-warn-bg: #FFF4E5;
  --rm-warn-line: #F6D7A8; --rm-warn-ink: #6B4A12; --rm-danger: #E5484D;
  --rm-font-mono: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
  --rm-radius: 18px; --rm-radius-sm: 12px; --rm-radius-pill: 999px;
  --rm-shadow: 0 1px 0 rgb(27 21 48 / 4%), 0 10px 30px -12px rgb(27 21 48 / 18%);
}
* { box-sizing: border-box; }
html { scroll-behavior: smooth; }
body { margin: 0; background: var(--rm-bg); color: var(--rm-ink); font: 17px/1.6 var(--rm-font-body); -webkit-font-smoothing: antialiased; }
img, svg { display: block; max-width: 100%; }
a { color: inherit; }
:focus-visible { outline: 3px solid var(--rm-grape); outline-offset: 3px; border-radius: 6px; }
.wrap { width: min(100% - 56px, 1120px); margin-inline: auto; }
h1, h2, h3 { margin: 0; font-family: var(--rm-font-display); font-weight: 800; letter-spacing: -0.03em; line-height: 1.05; }
h1 { font-size: clamp(40px, 6vw, 68px); }
h2 { font-size: clamp(30px, 4vw, 44px); }
h3 { font-size: 22px; letter-spacing: -0.01em; line-height: 1.2; }
p { margin: 0; color: var(--rm-ink-2); }
section { padding: 88px 0; }
.band { border-block: 1px solid var(--rm-line); background: var(--rm-bg-2); }
.skip-link { position: absolute; z-index: 20; top: 12px; left: -9999px; padding: 10px 14px; border-radius: var(--rm-radius-sm); background: var(--rm-paper); }
.skip-link:focus { left: 16px; }
.site-header { padding-top: 10px; }
.nav { display: flex; align-items: center; justify-content: space-between; gap: 20px; padding: 16px 0; }
.logo { display: inline-flex; align-items: center; gap: 10px; flex: none; font: 700 26px/1 var(--rm-font-display); letter-spacing: -0.03em; text-decoration: none; }
.logo svg { width: 34px; height: 34px; }
.nav-links { display: flex; align-items: center; justify-content: flex-end; gap: 24px; flex-wrap: wrap; margin: 0; padding: 0; list-style: none; }
.nav-links a { color: var(--rm-ink-2); font-size: 15px; font-weight: 500; text-decoration: none; }
.nav-links a:hover, .guide-link:hover { color: var(--rm-grape-dark); }
.nav-links a.nav-primary { padding: 11px 16px; border-radius: var(--rm-radius-pill); background: var(--rm-grape); color: #fff; font-weight: 600; white-space: nowrap; }
.nav-links a.nav-primary:hover { background: var(--rm-grape-dark); color: #fff; }
.nav-links a.nav-login { white-space: nowrap; }
.pill { display: inline-flex; align-items: center; gap: 8px; padding: 7px 14px; border: 1px solid var(--rm-line); border-radius: var(--rm-radius-pill); background: var(--rm-paper); color: var(--rm-ink-2); font-size: 14px; font-weight: 500; }
.hero { display: grid; grid-template-columns: minmax(0, 1.05fr) minmax(0, 0.95fr); align-items: center; gap: 56px; padding: 48px 0 72px; }
.hero h1 em { padding: 0 4px; margin: 0 -4px; background: linear-gradient(transparent 64%, var(--rm-sun) 64%, var(--rm-sun) 92%, transparent 92%); color: var(--rm-grape); font-style: normal; box-decoration-break: clone; -webkit-box-decoration-break: clone; }
.eyebrow { display: inline-block; margin-bottom: 14px; color: var(--rm-grape-dark); font-size: 14px; font-weight: 600; letter-spacing: 0.02em; }
.lede { max-width: 560px; margin: 22px 0 32px; color: var(--rm-ink-2); font-size: 20px; line-height: 1.55; }
.hero-cta { display: flex; align-items: center; flex-wrap: wrap; gap: 8px 16px; }
.btn { display: inline-flex; align-items: center; justify-content: center; gap: 10px; padding: 16px 24px; border: 0; border-radius: var(--rm-radius-pill); font: 600 16px/1 var(--rm-font-body); text-decoration: none; transition: transform 150ms ease, background-color 150ms ease; }
.btn-primary { background: var(--rm-grape); color: #fff; }
.btn-primary:hover { transform: translateY(-1px); background: var(--rm-grape-dark); }
.btn-ghost { padding-inline: 8px; color: var(--rm-ink); }
.btn-ghost:hover { color: var(--rm-grape-dark); }
.hero-note { display: flex; flex-wrap: wrap; gap: 10px; margin-top: 22px; }
.hero-art { min-width: 0; position: relative; padding: 0 14px 22px 0; }
.compose { position: relative; overflow: hidden; border: 1px solid var(--rm-line); border-radius: var(--rm-radius); background: var(--rm-paper); box-shadow: var(--rm-shadow); }
.compose-top { display: flex; align-items: center; justify-content: space-between; padding: 14px 20px; border-bottom: 1px solid var(--rm-line); font-size: 14px; font-weight: 600; }
.dots { display: flex; gap: 6px; }
.dots i { width: 10px; height: 10px; border-radius: 50%; background: var(--rm-line); }
.field { display: grid; grid-template-columns: 72px minmax(0, 1fr); gap: 12px; padding: 12px 20px; border-bottom: 1px solid var(--rm-line); font-size: 15px; overflow-wrap: anywhere; }
.field span:first-child { color: var(--rm-muted); }
.compose-body { padding: 16px 20px 20px; color: var(--rm-ink-2); font-size: 15px; }
.repeat { display: flex; align-items: flex-start; gap: 12px; margin: 0 20px 20px; padding: 14px 16px; border-radius: var(--rm-radius-sm); background: var(--rm-grape-soft); }
.repeat svg { flex: none; width: 22px; height: 22px; margin-top: 2px; color: var(--rm-grape-dark); }
.repeat strong, .repeat small { display: block; }
.repeat strong { font-size: 15px; line-height: 1.4; }
.repeat small { color: var(--rm-ink-2); font-size: 14px; }
.sent-toast { position: absolute; right: 0; bottom: 0; display: inline-flex; align-items: center; gap: 8px; padding: 10px 16px; border-radius: var(--rm-radius-pill); background: var(--rm-ink); box-shadow: var(--rm-shadow); color: var(--rm-bg); font-size: 14px; font-weight: 500; }
.sent-toast b { color: var(--rm-sun); font-weight: 600; }
.section-head { max-width: 680px; margin-bottom: 44px; }
.section-head p { margin-top: 14px; font-size: 18px; }
.steps { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 22px; margin: 0; padding: 0; list-style: none; counter-reset: step; }
.steps li { min-width: 0; padding: 28px 26px 30px; border: 1px solid var(--rm-line); border-radius: var(--rm-radius); background: var(--rm-paper); counter-increment: step; }
.steps li::before { display: grid; width: 44px; height: 44px; margin-bottom: 18px; place-items: center; border-radius: 50%; background: var(--rm-grape); color: #fff; content: counter(step); font: 700 22px/1 var(--rm-font-display); }
.steps h3 { margin-bottom: 8px; }
.steps p, .way p { font-size: 16px; }
.cal-grid { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 20px; }
.cal { display: flex; min-width: 0; flex-direction: column; overflow: hidden; border: 1px solid var(--rm-line); border-radius: var(--rm-radius); background: var(--rm-paper); }
.cal-head { padding: 10px 18px; background: var(--rm-grape); color: #fff; font-size: 13px; font-weight: 600; letter-spacing: 0.06em; text-transform: uppercase; }
.cal:nth-child(3n + 2) .cal-head { background: var(--rm-teal-dark); }
.cal:nth-child(3n + 3) .cal-head { background: var(--rm-ink); }
.cal-body { display: flex; flex: 1; flex-direction: column; gap: 6px; padding: 18px 18px 20px; }
.cal-when { font: 600 24px/1.15 var(--rm-font-display); letter-spacing: -0.01em; }
.cal-time { color: var(--rm-muted); font-size: 15px; }
.cal-what { margin-top: 10px; padding-top: 12px; border-top: 1px dashed var(--rm-line); color: var(--rm-ink-2); font-size: 15px; }
.ways, .privacy { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 22px; }
.way { display: flex; min-width: 0; flex-direction: column; gap: 10px; padding: 28px; border: 1px solid var(--rm-line); border-radius: var(--rm-radius); background: var(--rm-paper); }
.way .tag { align-self: flex-start; padding: 5px 12px; border-radius: var(--rm-radius-pill); background: var(--rm-sky-soft); color: #234a86; font-size: 13px; font-weight: 600; }
.way.ai .tag { background: var(--rm-grape-soft); color: var(--rm-grape-dark); }
.way.cli .tag { background: var(--rm-sun-soft); color: #7a5a00; }
.way.phone .tag { background: var(--rm-teal-soft); color: var(--rm-teal); }
.chat { display: flex; flex-direction: column; gap: 10px; margin-top: 8px; }
.bubble { max-width: 88%; padding: 12px 16px; border-radius: 18px; font-size: 15px; line-height: 1.45; }
.bubble-me { align-self: flex-end; border-bottom-right-radius: 6px; background: var(--rm-ink); color: var(--rm-bg); }
.bubble-bot { align-self: flex-start; border-bottom-left-radius: 6px; background: var(--rm-bg-2); color: var(--rm-ink); }
.term { min-width: 0; overflow-x: auto; margin-top: 8px; padding: 16px 18px; border-radius: var(--rm-radius-sm); background: var(--rm-ink); color: #ece8f7; font: 13.5px/1.7 var(--rm-font-mono); white-space: pre; }
.term-p { color: #c9b8ff; }
.term-ok { color: var(--rm-sun); }
.limit { display: grid; grid-template-columns: minmax(0, 1fr) minmax(0, 1fr); align-items: center; gap: 48px; }
.limit-copy p { margin-top: 16px; font-size: 18px; }
.meter-card { padding: 26px; border: 1px solid var(--rm-line); border-radius: var(--rm-radius); background: var(--rm-paper); box-shadow: var(--rm-shadow); }
.meter-card h3 { margin-bottom: 14px; font: 600 18px/1.3 var(--rm-font-body); }
.meter { height: 14px; overflow: hidden; border: 1px solid var(--rm-line); border-radius: var(--rm-radius-pill); background: var(--rm-bg-2); }
.meter i { display: block; width: 100%; height: 100%; background: linear-gradient(90deg, var(--rm-teal) 0 66%, #f2b705 66% 80%, var(--rm-danger) 80%); }
.meter-legend { display: flex; justify-content: space-between; margin-top: 8px; color: var(--rm-muted); font-size: 13px; }
.warn { margin-top: 18px; padding: 14px 16px; border: 1px solid var(--rm-warn-line); border-radius: var(--rm-radius-sm); background: var(--rm-warn-bg); color: var(--rm-warn-ink); font-size: 15px; }
.warn strong { color: #4f360b; }
.priv { padding: 28px; border: 1px solid var(--rm-line); border-radius: var(--rm-radius); background: var(--rm-paper); }
.priv h3 { margin-bottom: 14px; font-size: 20px; }
.priv ul { display: flex; flex-direction: column; gap: 10px; margin: 0; padding: 0; list-style: none; }
.priv li { display: flex; align-items: flex-start; gap: 12px; color: var(--rm-ink-2); font-size: 16px; }
.priv li::before { flex: none; width: 22px; height: 22px; margin-top: 2px; border-radius: 50%; background: var(--rm-teal-soft) url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 24 24' fill='none' stroke='%230E9F87' stroke-width='3' stroke-linecap='round' stroke-linejoin='round'%3E%3Cpath d='M6 12l4 4 8-8'/%3E%3C/svg%3E") center/14px no-repeat; content: ""; }
.priv.no li::before { background: #fde4e5 url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 24 24' fill='none' stroke='%23D93A45' stroke-width='3' stroke-linecap='round'%3E%3Cpath d='M7 7l10 10M17 7L7 17'/%3E%3C/svg%3E") center/12px no-repeat; }
.fine { max-width: 760px; margin-top: 18px; color: var(--rm-muted); font-size: 15px; }
.faq { display: flex; max-width: 820px; flex-direction: column; gap: 12px; }
.faq details { padding: 0 22px; border: 1px solid var(--rm-line); border-radius: var(--rm-radius-sm); background: var(--rm-paper); }
.faq summary { display: flex; align-items: center; justify-content: space-between; gap: 16px; padding: 20px 0; cursor: pointer; font-size: 18px; font-weight: 600; list-style: none; }
.faq summary::-webkit-details-marker { display: none; }
.faq summary::after { color: var(--rm-grape); content: "+"; font: 28px/1 var(--rm-font-display); }
.faq details[open] summary::after { transform: rotate(45deg); }
.faq details p { padding: 0 0 20px; font-size: 16px; }
.guide-links { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 16px; }
.guide-link { display: block; min-width: 0; padding: 22px; border: 1px solid var(--rm-line); border-radius: var(--rm-radius); background: var(--rm-paper); text-decoration: none; }
.guide-link h3 { margin-bottom: 8px; font-size: 19px; }
.guide-link p { font-size: 15px; }
.closing { margin: 0 0 88px; padding: 64px 48px; border-radius: 28px; background: var(--rm-grape); color: #fff; text-align: center; }
.closing h2 { color: #fff; }
.closing p { max-width: 560px; margin: 16px auto 28px; color: #e7deff; font-size: 19px; }
.closing .btn { background: var(--rm-sun); color: var(--rm-ink); }
.closing .btn:hover { background: #ffe27a; }
footer { padding: 32px 0 48px; border-top: 1px solid var(--rm-line); color: var(--rm-muted); font-size: 14px; }
.footer-content { display: flex; justify-content: space-between; gap: 24px; flex-wrap: wrap; }
footer p { color: var(--rm-muted); }
@media (prefers-reduced-motion: no-preference) { .float { animation: float 6s ease-in-out infinite; } @keyframes float { 0%, 100% { transform: translateY(0); } 50% { transform: translateY(-6px); } } }
@media (prefers-reduced-motion: reduce) { *, *::before, *::after { scroll-behavior: auto !important; animation: none !important; transition: none !important; } }
@media (max-width: 900px) { .hero, .limit { grid-template-columns: minmax(0, 1fr); gap: 40px; } .steps, .cal-grid { grid-template-columns: repeat(2, minmax(0, 1fr)); } .hero-art { max-width: 650px; } }
@media (max-width: 620px) { body { font-size: 16px; } .wrap { width: min(100% - 40px, 1120px); } .nav { align-items: flex-start; flex-direction: column; gap: 14px; } .nav-links { justify-content: flex-start; gap: 10px 18px; } .steps, .cal-grid, .ways, .privacy, .guide-links { grid-template-columns: minmax(0, 1fr); } section { padding: 64px 0; } .hero { gap: 34px; padding: 34px 0 56px; } .hero-art { padding-right: 0; } .repeat { margin-inline: 12px; padding: 12px; } .compose-top, .field { padding-inline: 14px; } .compose-body { padding-inline: 14px; } .closing { margin-bottom: 64px; padding: 48px 24px; border-radius: 22px; } }
`;

export default function HomePage() {
  return (
    <>
      <style>{globalStyles}</style>
      <a className="skip-link" href="#main">
        Skip to content
      </a>
      <SiteHeader variant="home" />
      <main id="main">
        <div className="wrap">
          <div className="hero">
            <div>
              <span className="eyebrow">Recurring email for Gmail</span>
              <h1>
                Send recurring emails from <em>your own Gmail.</em>
              </h1>
              <p className="lede">
                Write the email once and pick a schedule. RecurMail sends it
                from your Gmail address each time, so it appears in Sent and
                replies come back to you. It is free to use.
              </p>
              <div className="hero-cta">
                <a className="btn btn-primary" href="/auth/signin">
                  Create free account
                  <svg
                    width="18"
                    height="18"
                    viewBox="0 0 24 24"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="2.5"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    aria-hidden="true"
                  >
                    <path d="M5 12h14M13 6l6 6-6 6" />
                  </svg>
                </a>
                <a className="btn btn-ghost" href="#how-it-works">
                  See how it works
                </a>
              </div>
              <div className="hero-note">
                <span className="pill">Free with no paid plans</span>
                <span className="pill">Never reads your inbox</span>
                <span className="pill">Works in your browser</span>
              </div>
            </div>
            <div
              className="hero-art"
              role="img"
              aria-label="An example of a recurring email in RecurMail"
            >
              <div className="compose float">
                <div className="compose-top">
                  <span>Rent reminder</span>
                  <span className="dots" aria-hidden="true">
                    <i />
                    <i />
                    <i />
                  </span>
                </div>
                <div className="field">
                  <span>To</span>
                  <span>landlord@example.com</span>
                </div>
                <div className="field">
                  <span>Subject</span>
                  <span>Rent for this month</span>
                </div>
                <div className="compose-body">
                  Hi Sam, just a reminder that this month&apos;s rent is on its
                  way today. Thanks!
                </div>
                <div className="repeat">
                  <svg
                    viewBox="0 0 24 24"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="2.2"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    aria-hidden="true"
                  >
                    <path d="M17 2l4 4-4 4" />
                    <path d="M3 11V9a3 3 0 0 1 3-3h15" />
                    <path d="M7 22l-4-4 4-4" />
                    <path d="M21 13v2a3 3 0 0 1-3 3H3" />
                  </svg>
                  <div>
                    <strong>Repeats on the 1st of every month at 9:00</strong>
                    <small>Next · Nov 1 · Dec 1 · Jan 1</small>
                  </div>
                </div>
              </div>
              <div className="sent-toast" aria-hidden="true">
                <b>✓ Sent</b> Rent reminder · 9:00
              </div>
            </div>
          </div>
        </div>

        <section id="how-it-works" className="band" aria-labelledby="how-title">
          <div className="wrap">
            <div className="section-head">
              <span className="eyebrow">How it works</span>
              <h2 id="how-title">How to send a recurring email from Gmail</h2>
              <p>
                Gmail&apos;s Schedule send only sends one message once.
                RecurMail adds a repeat schedule in three steps.
              </p>
            </div>
            <ol className="steps">
              <li>
                <h3>Connect your Gmail</h3>
                <p>
                  Sign in with Google and allow RecurMail to send email for you.
                  That is the only permission it requests.
                </p>
              </li>
              <li>
                <h3>Write the email</h3>
                <p>
                  Add recipients, Cc and Bcc, a subject, and your message. The
                  form works like the one you already know in Gmail.
                </p>
              </li>
              <li>
                <h3>Pick a schedule</h3>
                <p>
                  Choose when it repeats and which time zone to use. RecurMail
                  sends each message on time and keeps a history.
                </p>
              </li>
            </ol>
          </div>
        </section>

        <section aria-labelledby="schedule-title">
          <div className="wrap">
            <div className="section-head">
              <span className="eyebrow">Any schedule</span>
              <h2 id="schedule-title">Schedule an email for any pattern</h2>
              <p>
                Weekly is easy. RecurMail also handles less common schedules and
                adjusts for daylight saving time.
              </p>
            </div>
            <div className="cal-grid">
              <article className="cal">
                <div className="cal-head">Monthly</div>
                <div className="cal-body">
                  <div className="cal-when">1st of every month</div>
                  <div className="cal-time">9:00 am</div>
                  <div className="cal-what">Rent reminder to your landlord</div>
                </div>
              </article>
              <article className="cal">
                <div className="cal-head">Weekdays</div>
                <div className="cal-body">
                  <div className="cal-when">Every weekday</div>
                  <div className="cal-time">5:30 pm</div>
                  <div className="cal-what">End-of-day update to your team</div>
                </div>
              </article>
              <article className="cal">
                <div className="cal-head">Every 2 weeks</div>
                <div className="cal-body">
                  <div className="cal-when">Every other Friday</div>
                  <div className="cal-time">4:00 pm</div>
                  <div className="cal-what">Timesheet to your manager</div>
                </div>
              </article>
              <article className="cal">
                <div className="cal-head">Quarterly</div>
                <div className="cal-body">
                  <div className="cal-when">Last day of each quarter</div>
                  <div className="cal-time">10:00 am</div>
                  <div className="cal-what">Invoice to a client</div>
                </div>
              </article>
              <article className="cal">
                <div className="cal-head">Weekly</div>
                <div className="cal-body">
                  <div className="cal-when">Every Sunday</div>
                  <div className="cal-time">11:00 am</div>
                  <div className="cal-what">Check-in with your parents</div>
                </div>
              </article>
              <article className="cal">
                <div className="cal-head">Yearly</div>
                <div className="cal-body">
                  <div className="cal-when">Every March 14</div>
                  <div className="cal-time">8:00 am</div>
                  <div className="cal-what">Birthday note to a friend</div>
                </div>
              </article>
            </div>
          </div>
        </section>

        <section id="web-app" className="band" aria-labelledby="ways-title">
          <div className="wrap">
            <div className="section-head">
              <span className="eyebrow">In your browser</span>
              <h2 id="ways-title">Manage recurring emails in one place</h2>
              <p>
                Connect Gmail, write the message, choose a schedule, and review
                your sent email from the RecurMail web app.
              </p>
            </div>
            <div className="ways">
              <article className="way">
                <span className="tag">Web</span>
                <h3>Keep your schedules together</h3>
                <p>
                  Review upcoming sends, update a message, or pause a schedule
                  when your plans change.
                </p>
              </article>
              <article className="way">
                <span className="tag">Send history</span>
                <h3>Check what has gone out</h3>
                <p>
                  RecurMail keeps a history of messages it sends so you can
                  confirm the date and destination.
                </p>
              </article>
            </div>
          </div>
        </section>

        <section aria-labelledby="limit-title">
          <div className="wrap limit">
            <div className="limit-copy">
              <span className="eyebrow">
                Gmail&apos;s daily recipient limits
              </span>
              <h2 id="limit-title">
                Stay under Gmail&apos;s daily sending limit
              </h2>
              <p>
                Personal Gmail can send to about 500 recipients a day. Google
                Workspace can send to about 2,000. Recipients in To, Cc, and Bcc
                all count.
              </p>
              <p>
                RecurMail totals the recipients in your schedules, finds your
                busiest 24 hours, and warns you as you approach the limit. If
                Gmail turns a send away, RecurMail holds it and retries when
                there is room.
              </p>
            </div>
            <div className="meter-card">
              <h3>Your busiest 24 hours</h3>
              <div
                className="meter"
                role="img"
                aria-label="Daily limit meter showing a schedule above the limit"
              >
                <i />
              </div>
              <div className="meter-legend">
                <span>0</span>
                <span>400</span>
                <span>500</span>
              </div>
              <div className="warn">
                <strong>Heads up.</strong> Your schedules send to 620 people
                between Monday at 8:00 and Tuesday at 8:00. Personal Gmail
                accounts can send to about 500 recipients a day.
              </div>
            </div>
          </div>
        </section>

        <section className="band" aria-labelledby="privacy-title">
          <div className="wrap">
            <div className="section-head">
              <span className="eyebrow">Google permissions</span>
              <h2 id="privacy-title">RecurMail only asks to send email</h2>
              <p>
                RecurMail asks Google for permission to send email on your
                behalf. It does not request access to your mailbox.
              </p>
            </div>
            <div className="privacy">
              <div className="priv">
                <h3>What RecurMail can do</h3>
                <ul>
                  <li>Send the emails you schedule from your address</li>
                  <li>
                    Store the schedules and messages you write in RecurMail
                  </li>
                  <li>Keep a history of what it sent and when</li>
                </ul>
              </div>
              <div className="priv no">
                <h3>What RecurMail cannot do</h3>
                <ul>
                  <li>Read your inbox, sent mail, or drafts</li>
                  <li>See your contacts or labels</li>
                  <li>Change or delete anything in Gmail</li>
                </ul>
              </div>
            </div>
            <p className="fine">
              Gmail refresh tokens are encrypted at rest. You can disconnect
              RecurMail from your Google account settings, and your schedules
              will pause.
            </p>
          </div>
        </section>

        <section id="faq" aria-labelledby="faq-title">
          <div className="wrap">
            <div className="section-head">
              <span className="eyebrow">FAQ</span>
              <h2 id="faq-title">Questions about recurring emails in Gmail</h2>
            </div>
            <div className="faq">
              {faqs.map(({ question, answer }, index) => (
                <details key={question} open={index === 0}>
                  <summary>{question}</summary>
                  <p>{answer}</p>
                </details>
              ))}
            </div>
          </div>
        </section>

        <section id="guides" className="band" aria-labelledby="guides-title">
          <div className="wrap">
            <div className="section-head">
              <span className="eyebrow">Gmail guides</span>
              <h2 id="guides-title">More on recurring email</h2>
              <p>
                Learn what Gmail can schedule and how recurring email tools
                work.
              </p>
            </div>
            <div className="guide-links">
              <a className="guide-link" href="/guides/recurring-email-gmail">
                <h3>How to send recurring email in Gmail</h3>
                <p>
                  See the options in Gmail and how to repeat a message on a
                  schedule.
                </p>
              </a>
              <a
                className="guide-link"
                href="/guides/gmail-recurring-email-extension-alternative"
              >
                <h3>A recurring email extension alternative</h3>
                <p>
                  Compare browser extensions with a service that sends from your
                  Gmail account.
                </p>
              </a>
            </div>
          </div>
        </section>

        <div className="wrap">
          <div className="closing">
            <h2>Set up a message to repeat</h2>
            <p>Choose the recipients, write the email, and set its schedule.</p>
            <a className="btn" href="/auth/signin">
              Create free account
            </a>
          </div>
        </div>
        <script type="application/ld+json">
          {JSON.stringify(structuredData).replace(/</g, "\\u003c")}
        </script>
      </main>
      <SiteFooter variant="marketing" />
    </>
  );
}
