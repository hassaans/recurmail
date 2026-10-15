import { ImageResponse } from "next/og";

export const alt = "RecurMail sends recurring emails from your Gmail account";
export const size = { width: 1200, height: 630 };
export const contentType = "image/png";

export default function OpenGraphImage() {
  return new ImageResponse(
    <div
      style={{
        display: "flex",
        width: "100%",
        height: "100%",
        flexDirection: "column",
        justifyContent: "space-between",
        padding: "68px 76px",
        background: "#F3FAF6",
        color: "#1B1530",
        fontFamily: "Arial, sans-serif",
      }}
    >
      <div style={{ display: "flex", alignItems: "center", gap: 16 }}>
        <div
          style={{
            display: "flex",
            width: 56,
            height: 56,
            alignItems: "center",
            justifyContent: "center",
            borderRadius: 16,
            background: "#6D3BEF",
            color: "white",
            fontSize: 36,
            fontWeight: 700,
          }}
        >
          RM
        </div>
        <span style={{ fontSize: 30, fontWeight: 700, letterSpacing: -1 }}>
          RecurMail
        </span>
      </div>
      <div style={{ display: "flex", flexDirection: "column", gap: 20 }}>
        <div
          style={{
            maxWidth: 960,
            fontSize: 66,
            fontWeight: 700,
            lineHeight: 1.08,
            letterSpacing: -2,
          }}
        >
          Send recurring emails from your own Gmail.
        </div>
        <div style={{ color: "#3F3856", fontSize: 28 }}>
          Write once. Choose a schedule. RecurMail sends it each time.
        </div>
      </div>
      <div
        style={{
          display: "flex",
          alignSelf: "flex-start",
          padding: "12px 20px",
          borderRadius: 999,
          background: "#ECE4FF",
          color: "#5326D1",
          fontSize: 20,
          fontWeight: 600,
        }}
      >
        Free to use · Sends from your Gmail account
      </div>
    </div>,
    { ...size },
  );
}
