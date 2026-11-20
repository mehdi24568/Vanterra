import { useEffect, useRef } from 'react';
import { SpatialEngine } from '../spatial/SpatialEngine';
import { useRuntime } from './context';

/** Hosts the Spatial Engine. React mounts and unmounts it; it never renders the scene. */
export function SceneViewport() {
  const runtime = useRuntime();
  const hostRef = useRef<HTMLDivElement>(null);
  const labelRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const host = hostRef.current;
    const labels = labelRef.current;
    if (!host || !labels) return;
    let engine: SpatialEngine | null = null;
    try {
      engine = new SpatialEngine(host, labels, runtime, {
        onSelect: (assetId, signalId) => runtime.selectAsset(assetId, signalId ?? null),
        onGroundPing: (x, z) => runtime.ping({ x, z }),
        onError: (message) => runtime.reportError(message),
      });
      runtime.attachSpatial(engine);
    } catch (err) {
      console.error('[atlas] spatial engine failed to start', err);
      runtime.reportError(`The 3D view could not start: ${err instanceof Error ? err.message : String(err)}`);
    }
    return () => {
      runtime.attachSpatial(null);
      engine?.dispose();
    };
  }, [runtime]);

  return (
    <div className="viewport">
      <div className="viewport__canvas" ref={hostRef} />
      <div className="viewport__labels" ref={labelRef} />
    </div>
  );
}
