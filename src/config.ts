import visionAssets from './vision/model-assets.json';
export const APP = { name: 'BACKSTAGE', tagline: 'A MOMENT BEFORE THE MOMENT' };
export const CAPTURE = { preparationSeconds: 3, directionSeconds: 6, countdownSeconds: 3, frameCount: 4, burstMilliseconds: 750, maxImageDimension: 960 };
export const DETECTION = {
  contrastThreshold: 45, colorDifferenceThreshold: 38, maxComponentColorStep: 55, minFillRatio: 0.45,
  minArea: 18, maxArea: 2600, regionMargin: 0.025,
  minPlainCoverage: 0.7, minSurroundingFabric: 0.7, maxSurroundingVariation: 28,
  minExposure: 12, analysisWidth: 480, localWindowRadius: 12,
};
export type DetectionSettings = typeof DETECTION;
export const GUIDE = { x: 0.16, y: 0.28, width: 0.68, height: 0.48 };
export const DIRECTIONS = [
  { id: 'front', label: '正面', instruction: '正面を向いてください' },
  { id: 'side1', label: '側面①', instruction: '右に90度向いてください' },
  { id: 'back', label: '背面', instruction: '背中を向けてください' },
  { id: 'side2', label: '側面②', instruction: 'さらに右に90度向いてください' },
] as const;
export type Direction = typeof DIRECTIONS[number]['id'];

// Immutable official model version and npm runtime; served from our own origin.
export const PERSON_MODEL = {
  runtimeVersion: visionAssets.runtimeVersion, modelVersion: visionAssets.modelVersion, sha256: visionAssets.sha256, variant: 'selfie_multiclass_256x256', version: 'float32/1',
  modelPath: `/vision/${visionAssets.modelFile}`,
  wasmPath: '/vision/wasm-0.10.32',
  loadTimeoutMs: 30000,
};
export const PERSON = { maskThreshold: 0.55, minTorsoImageArea: 0.015, clothesThreshold: 0.45, skinThreshold: 0.45 };
export const TEMPORAL = { maxAnalyzedFrames: 2, minimumOverlap: 0.2, centerToleranceRatio: 0.035, maxAreaRatio: 3 };
