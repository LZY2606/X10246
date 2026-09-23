/** 从不可变帧内容 + 瓦片表重建栅格（派生层才做规范化）。 */
import type { Ledger } from '../db/ledger.ts';
import { tilesToRaster, maskRaster, BLOCK } from '../domain/frames.ts';
import type { FrameContent, FrameTile } from '../domain/types.ts';

export interface LoadedFrames {
  rows: number;
  cols: number;
  phase: Float64Array;
  amplitude: Float64Array;
  snr: Float64Array;
  mask: Uint8Array;
}

export function readFrameContent(ledger: Ledger, eventId: string): FrameContent {
  const ev = ledger.getEvent(eventId);
  if (!ev) throw new Error('MISSING_FRAME_EVENT:' + eventId);
  return ev.payload as FrameContent;
}

function loadTiles(ledger: Ledger, frame: FrameContent): FrameTile[] {
  const tiles: FrameTile[] = [];
  for (const p of frame.placements) {
    const tile = ledger.getTile(p.tileContentId);
    if (!tile) throw new Error('MISSING_TILE:' + p.tileContentId);
    const t = tile as FrameTile;
    tiles.push({ ...t, blockR: Math.round(p.originR / BLOCK), blockC: Math.round(p.originC / BLOCK) });
  }
  return tiles;
}

export function loadFrames(
  ledger: Ledger,
  ids: { phase: string; amplitude: string; snr: string; mask: string },
): LoadedFrames {
  const pf = readFrameContent(ledger, ids.phase);
  const af = readFrameContent(ledger, ids.amplitude);
  const sf = readFrameContent(ledger, ids.snr);
  const mf = readFrameContent(ledger, ids.mask);
  const rows = pf.rows;
  const cols = pf.cols;
  return {
    rows,
    cols,
    phase: tilesToRaster(loadTiles(ledger, pf), rows, cols),
    amplitude: tilesToRaster(loadTiles(ledger, af), rows, cols),
    snr: tilesToRaster(loadTiles(ledger, sf), rows, cols),
    mask: maskRaster(loadTiles(ledger, mf), rows, cols),
  };
}

export function loadSingleFrame(ledger: Ledger, eventId: string): Float64Array {
  const f = readFrameContent(ledger, eventId);
  return tilesToRaster(loadTiles(ledger, f), f.rows, f.cols);
}
