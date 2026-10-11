import { cp, mkdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

// Assets come from the integrity-locked official npm package, never a runtime CDN.
const source = new URL('../node_modules/@mediapipe/pose/', import.meta.url);
const destination = new URL('../public/vision/', import.meta.url);
await mkdir(destination, { recursive: true });
for (const file of [
  'pose.js', 'pose_web.binarypb', 'pose_landmark_lite.tflite',
  'pose_solution_packed_assets.data', 'pose_solution_packed_assets_loader.js',
  'pose_solution_simd_wasm_bin.js', 'pose_solution_simd_wasm_bin.wasm',
  'pose_solution_simd_wasm_bin.data', 'pose_solution_wasm_bin.js', 'pose_solution_wasm_bin.wasm',
]) await cp(fileURLToPath(new URL(file, source)), fileURLToPath(new URL(file, destination)));
const face = new URL('../node_modules/@mediapipe/face_detection/', import.meta.url);
for (const file of [
  'face_detection.js', 'face_detection_full.binarypb', 'face_detection_full_range_sparse.tflite',
  'face_detection_full_range.tflite', 'face_detection_short.binarypb', 'face_detection_short_range.tflite',
  'face_detection_solution_simd_wasm_bin.data', 'face_detection_solution_simd_wasm_bin.js',
  'face_detection_solution_simd_wasm_bin.wasm', 'face_detection_solution_wasm_bin.js', 'face_detection_solution_wasm_bin.wasm',
]) await cp(fileURLToPath(new URL(file, face)), fileURLToPath(new URL(file, destination)));
