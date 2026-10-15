import BrandMark from "./BrandMark";
import { type HeaderLink, HeaderMenu } from "./HeaderMenu";
import styles from "./SiteHeader.module.css";

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

function sectionLinks(props: SiteHeaderProps): HeaderLink[] {
  if (props.variant === "legal") return [];
  const home = props.variant === "home" ? "" : "/";
  return [
    { href: `${home}#how-it-works`, label: "How it works" },
    { href: `${home}#faq`, label: "FAQ" },
    ...(props.variant === "guide" ? [guideLinks[props.relatedGuide]] : []),
  ];
}

const login: HeaderLink = { href: "/dashboard", label: "Log in" };

export function SiteHeader(props: SiteHeaderProps) {
  const links = sectionLinks(props);
  // With nothing but Log in to show, a menu would hold one item, so Log in
  // stays in the row at every width instead.
  const menu = links.length > 0;

  return (
    <header className={`${styles.header} wrap`}>
      <nav className={styles.nav} aria-label="Main navigation">
        <a className={styles.logo} href="/" aria-label="RecurMail home">
          <BrandMark />
          RecurMail
        </a>
        {/* Desktop: the links sit in the row. Up to 860px they move into the menu. */}
        <ul className={menu ? styles.links : `${styles.links} ${styles.inRow}`}>
          {[...links, login].map((link) => (
            <li key={link.href}>
              <a href={link.href}>{link.label}</a>
            </li>
          ))}
        </ul>
        <a className={styles.cta} href="/auth/signin">
          <span className={styles.ctaLong}>Create free account</span>
          <span className={styles.ctaShort}>Sign up free</span>
        </a>
        {menu ? <HeaderMenu links={[...links, login]} /> : null}
      </nav>
    </header>
  );
}
