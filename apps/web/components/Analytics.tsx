"use client";

import { usePathname } from "next/navigation";
import { useEffect, useRef } from "react";
import {
  clickEvents,
  startVisit,
  track,
  watchScrollDepth,
} from "../lib/analytics-client";

// Pages where reading depth says something: the homepage and the guides.
const longPages = (pathname: string) =>
  pathname === "/" || pathname.startsWith("/guides/");

// The last page view, so React's development double-mount and a repeated
// render of the same path do not count twice.
let lastView = { pathname: "", at: 0 };

/**
 * Mounted once in the root layout. Renders nothing; reports a page view on
 * load and on every App Router navigation, and listens for clicks on the
 * whole document so server-rendered markup only needs data-track attributes.
 */
export default function Analytics() {
  const pathname = usePathname();
  const started = useRef(false);

  useEffect(() => {
    if (!started.current) {
      started.current = true;
      startVisit();
    }
    const now = Date.now();
    if (lastView.pathname !== pathname || now - lastView.at > 1000) {
      lastView = { pathname, at: now };
      track("page_view");
    }
    return longPages(pathname) ? watchScrollDepth() : undefined;
  }, [pathname]);

  useEffect(() => {
    function onClick(event: MouseEvent) {
      if (!(event.target instanceof Element)) return;
      for (const [name, properties] of clickEvents(
        event.target,
        location.origin,
      ))
        track(name, properties);
    }
    document.addEventListener("click", onClick);
    return () => document.removeEventListener("click", onClick);
  }, []);

  return null;
}
