// src/app/ar/page.tsx
"use client";

import { useEffect, useState } from "react";
import { isImmersiveArSupported } from "@/server-utils/lib/webxr/support";
import ARScene from "@/components/ARScene";

export default function ARPage() {
    const [supported, setSupported] = useState<boolean | null>(null);

    useEffect(() => {
        isImmersiveArSupported().then(setSupported);
    }, []);

    return (
        <div
            style={{
                position: "fixed",
                inset: 0,
                width: "100vw",
                height: "100vh",
                overflow: "hidden",
                background: "transparent", // ✅ NON black
                touchAction: "none",
            }}
        >
            {supported === null && (
                <div style={{ padding: 16, color: "white" }}>Verifico supporto WebXR…</div>
            )}

            {supported === false && (
                <div style={{ padding: 16, color: "white" }}>
                    <h1 style={{ fontSize: 18, fontWeight: 600 }}>WebXR AR non supportato</h1>
                    <p style={{ marginTop: 8 }}>
                        Questo MVP è pensato per <b>Android + Chrome</b>. Qui non risulta disponibile{" "}
                        <code>immersive-ar</code>.
                    </p>
                </div>
            )}

            {supported === true && <ARScene />}
        </div>
    );
}