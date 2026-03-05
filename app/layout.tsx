// src/app/layout.tsx
import type { ReactNode } from "react";

export default function RootLayout({ children }: { children: ReactNode }) {
    return (
        <html lang="it" style={{ background: "transparent" }}>
        <head>
            <style>{`
          html, body {
            margin: 0;
            padding: 0;
            width: 100%;
            height: 100%;
            background: transparent;
          }
          body {
            overscroll-behavior: none;
          }
        `}</style>
        </head>
        <body style={{ background: "transparent" }}>{children}</body>
        </html>
    );
}