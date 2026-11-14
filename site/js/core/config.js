// Analysis settings, mirroring pipeline/config.toml (centipawns unless noted).
export const CONFIG = {
  depth: 12,
  thresholds: { inaccuracy: 50, mistake: 100, blunder: 200 },
  decidedCp: 600,
  altMarginCp: 50,
  cap: 1000,
  monthsBack: 12,
  analysisVersion: 1,
};
