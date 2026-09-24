export type Clock = () => string;

export const systemClock: Clock = () => new Date().toISOString();

export function fixedClock(startIso = '2026-01-01T00:00:00.000Z', stepMs = 1000): Clock {
  let t = Date.parse(startIso);
  return () => {
    const iso = new Date(t).toISOString();
    t += stepMs;
    return iso;
  };
}
