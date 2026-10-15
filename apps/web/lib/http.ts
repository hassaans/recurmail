import "server-only";

export function readCookie(request: Request, name: string): string | null {
  const cookie = request.headers
    .get("cookie")
    ?.split(";")
    .map((part) => part.trim())
    .find((part) => part.startsWith(`${name}=`));
  return cookie ? cookie.slice(name.length + 1) : null;
}

export function cookieHeader(
  name: string,
  value: string,
  origin: string,
  maxAge: number,
): string {
  return `${name}=${value}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAge}${new URL(origin).protocol === "https:" ? "; Secure" : ""}`;
}

export function redirectResponse(origin: string, path: string): Response {
  return new Response(null, {
    status: 303,
    headers: {
      Location: new URL(path, origin).toString(),
      "Cache-Control": "no-store",
      "Referrer-Policy": "no-referrer",
    },
  });
}

export function sameOrigin(request: Request, origin: string): boolean {
  return request.headers.get("origin") === origin;
}
