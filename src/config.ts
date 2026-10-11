export const CAPTURE = { preparationSeconds: 3, directionSeconds: 6, countdownSeconds: 3, frameCount: 4, burstMilliseconds: 750, maxImageDimension: 960 };
export const DETECTION = {
  brightnessThreshold: 170, contrastThreshold: 90, darkThreshold: 85,
  minArea: 18, maxArea: 2600, regionMargin: 0.025,
  minDarkCoverage: 0.18, minSurroundingDark: 0.75, minSharpness: 5,
  analysisWidth: 480,
};
export type DetectionSettings = typeof DETECTION;
export const GUIDE = { x: 0.16, y: 0.28, width: 0.68, height: 0.48 };
export const DIRECTIONS = [
  { id: 'front', label: '正面', instruction: '正面を向いてください' },
  { id: 'side1', label: '右側面', instruction: '左へ、ゆっくり回ってください' },
  { id: 'back', label: '背面', instruction: '背中を向けてください' },
  { id: 'side2', label: '左側面', instruction: 'もう一度、左へ回ってください' },
] as const;
export type Direction = typeof DIRECTIONS[number]['id'];
