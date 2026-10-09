import visionAssets from './vision/model-assets.json';
export const APP = { name: 'BACKSTAGE', tagline: 'A MOMENT BEFORE THE MOMENT' };
export const CAPTURE = { preparationSeconds: 3, directionSeconds: 6, countdownSeconds: 3, frameCount: 4, burstMilliseconds: 750, maxImageDimension: 960 };
export const DETECTION = {
  brightnessThreshold: 170, contrastThreshold: 90, darkThreshold: 85,
  minArea: 18, maxArea: 2600, regionMargin: 0.025,
  minDarkCoverage: 0.18, minSurroundingDark: 0.75, minSharpness: 5,
  analysisWidth: 480, minLocalBrightness: 110, localWindowRadius: 12, maxSaturation: 0.38,
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
  runtimeVersion: visionAssets.runtimeVersion, modelVersion: visionAssets.modelVersion, sha256: visionAssets.sha256, variant: 'pose_landmarker_lite', version: 'float16/1',
  modelPath: '/vision/pose_landmarker_lite-float16-1.task',
  wasmPath: '/vision/wasm-0.10.32',
  loadTimeoutMs: 30000,
};
export const PERSON = { maskThreshold: 0.55, minLandmarkPresence: 0.5, minLandmarkVisibility: 0.2, minTorsoMaskCoverage: 0.6, minTorsoImageArea: 0.015, handRadiusRatio: 0.11 };
export const TEMPORAL = { maxAnalyzedFrames: 2, minimumOverlap: 0.2, centerToleranceRatio: 0.035, maxAreaRatio: 3 };
