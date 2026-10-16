"use client";

import { useEffect, useId, useRef, useState } from "react";
import styles from "./SiteHeader.module.css";

export type HeaderLink = {
  href: string;
  label: string;
  /** The analytics event a click on the link reports. */
  track?: string;
};

/**
 * The phone and tablet menu: a disclosure button and the panel it controls
 * (W3C APG disclosure navigation). The panel follows the button in the DOM so
 * Tab moves from the button into the open menu. Escape closes it and returns
 * focus to the button; choosing a link or pressing outside closes it too.
 */
export function HeaderMenu({ links }: { links: HeaderLink[] }) {
  const [open, setOpen] = useState(false);
  const panelId = useId();
  const button = useRef<HTMLButtonElement>(null);
  const panel = useRef<HTMLUListElement>(null);

  useEffect(() => {
    if (!open) return;
    function onKeyDown(event: KeyboardEvent) {
      if (event.key !== "Escape") return;
      setOpen(false);
      button.current?.focus();
    }
    function onPointerDown(event: PointerEvent) {
      const target = event.target as Node;
      if (button.current?.contains(target) || panel.current?.contains(target))
        return;
      setOpen(false);
    }
    document.addEventListener("keydown", onKeyDown);
    document.addEventListener("pointerdown", onPointerDown);
    return () => {
      document.removeEventListener("keydown", onKeyDown);
      document.removeEventListener("pointerdown", onPointerDown);
    };
  }, [open]);

  return (
    <>
      <button
        ref={button}
        type="button"
        className={styles.menuButton}
        aria-expanded={open}
        aria-controls={panelId}
        aria-label="Menu"
        data-track={open ? undefined : "nav_menu_opened"}
        onClick={() => setOpen((value) => !value)}
      >
        <svg
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
          strokeLinecap="round"
          aria-hidden="true"
        >
          {open ? (
            <path d="M6 6l12 12M18 6L6 18" />
          ) : (
            <path d="M4 7h16M4 12h16M4 17h16" />
          )}
        </svg>
      </button>
      <ul ref={panel} id={panelId} className={styles.panel} hidden={!open}>
        {links.map((link) => (
          <li key={link.href}>
            <a
              href={link.href}
              data-track={link.track}
              data-track-location="menu"
              onClick={() => setOpen(false)}
            >
              {link.label}
            </a>
          </li>
        ))}
      </ul>
    </>
  );
}
