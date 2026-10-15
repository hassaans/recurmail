import BrandMark from "./BrandMark";

type SiteHeaderProps =
  | { variant: "home" }
  | { variant: "guide"; relatedGuide: "gmail" | "extension" }
  | { variant: "legal" };

const guideLinks = {
  gmail: {
    href: "/guides/gmail-recurring-email-extension-alternative",
    label: "Extension alternative",
  },
  extension: { href: "/guides/recurring-email-gmail", label: "Gmail guide" },
};

export function SiteHeader(props: SiteHeaderProps) {
  const isLegal = props.variant === "legal";
  const isHome = props.variant === "home";

  return (
    <header className={`site-header wrap${isLegal ? " legal-header" : ""}`}>
      <nav className="nav" aria-label="Main navigation">
        <a className="logo" href="/" aria-label="RecurMail home">
          <BrandMark />
          RecurMail
        </a>
        <ul className="nav-links">
          {isLegal ? null : (
            <>
              <li>
                <a href={isHome ? "#how-it-works" : "/#how-it-works"}>
                  How it works
                </a>
              </li>
              <li>
                <a href={isHome ? "#faq" : "/#faq"}>FAQ</a>
              </li>
              {props.variant === "guide" ? (
                <li>
                  <a href={guideLinks[props.relatedGuide].href}>
                    {guideLinks[props.relatedGuide].label}
                  </a>
                </li>
              ) : null}
            </>
          )}
          <li>
            <a className="nav-login" href="/dashboard">
              Log in
            </a>
          </li>
          <li>
            <a className="nav-primary" href="/auth/signin">
              Create free account
            </a>
          </li>
        </ul>
      </nav>
    </header>
  );
}
