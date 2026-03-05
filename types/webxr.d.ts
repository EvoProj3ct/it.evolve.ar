// src/types/webxr.d.ts
export {};

declare global {
    interface XRHitTestSource {}

    interface XRHitTestResult {
        getPose(baseSpace: XRSpace): XRPose | null;
    }

    interface XRTransientInputHitTestResult {
        inputSource: XRInputSource;
        results: XRHitTestResult[];
    }

    interface XRTransientInputHitTestSource {
        // In pratica è un oggetto opaco, usato da getHitTestResultsForTransientInput()
    }

    interface XRSession {
        requestHitTestSourceForTransientInput?(options: {
            profile: string;
            offsetRay?: XRRigidTransform;
        }): Promise<XRTransientInputHitTestSource>;

        // spec: frame.getHitTestResultsForTransientInput(source)
        // è su XRFrame, ma qui non serve duplicare altro
    }

    interface XRFrame {
        getHitTestResultsForTransientInput?(
            source: XRTransientInputHitTestSource
        ): XRTransientInputHitTestResult[];
    }
}