"use client";

import { useEffect, useState } from "react";
import { isImmersiveArSupported } from "@/server-utils/lib/webxr/support";
import ARScene from "@/components/ARScene";

export default function ARPage() {
  const [supported, setSupported] = useState<boolean | null>(null);

  useEffect(() => {
    isImmersiveArSupported().then(setSupported);
  }, []);

  if (supported === null) {
    return (
        <div style={{ padding: 16, color: "white" }}>
          Verifico supporto WebXR…
        </div>
    );
  }

  if (!supported) {
    return (
        <div style={{ padding: 16, color: "white" }}>
          <h1 style={{ fontSize: 18, fontWeight: 600 }}>WebXR AR non supportato</h1>
          <p style={{ marginTop: 8 }}>
            Questo MVP è pensato per <b>Android + Chrome</b>. Qui non risulta disponibile{" "}
            <code>immersive-ar</code>.
          </p>
        </div>
    );
  }

  // fullscreen: ARScene copre tutto lo schermo
  return <ARScene />;
}