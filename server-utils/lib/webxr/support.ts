export async function isImmersiveArSupported(): Promise<boolean> {
  const xr = (navigator as any).xr;
  if (!xr?.isSessionSupported) return false;
  try {
    return await xr.isSessionSupported("immersive-ar");
  } catch {
    return false;
  }
}