type SiteFooterProps = { variant: "marketing" | "legal" };

export function SiteFooter({ variant }: SiteFooterProps) {
  if (variant === "legal") {
    return (
      <footer className="legal-footer">
        <div className="wrap footer-content">
          <nav aria-label="Legal">
            <a href="/privacy">Privacy</a>
            <a href="/terms">Terms</a>
          </nav>
          <p>
            Gmail is a trademark of Google LLC. RecurMail is not affiliated with
            Google.
          </p>
        </div>
      </footer>
    );
  }

  return (
    <footer>
      <div className="wrap footer-content">
        <p>© 2026 RecurMail · Recurring email for Gmail</p>
        <p>
          Gmail is a trademark of Google LLC. RecurMail is not affiliated with
          or endorsed by Google.
        </p>
        <nav aria-label="Legal">
          <a href="/privacy">Privacy</a>
          {" · "}
          <a href="/terms">Terms</a>
        </nav>
      </div>
    </footer>
  );
}
