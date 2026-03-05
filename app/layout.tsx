// src/app/ar/layout.tsx
import type { PropsWithChildren } from "react";

export default function ARLayout({ children }: PropsWithChildren) {
    return (
        <div
            style={{
                position: "fixed",
                inset: 0,
                width: "100vw",
                height: "100vh",
                overflow: "hidden",
                background: "black",
                touchAction: "none",
            }}
        >
            {children}
        </div>
    );
}