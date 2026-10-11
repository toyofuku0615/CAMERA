# 外部ライブラリとテスト素材

- `@mediapipe/pose` 0.5.1675469404、`@mediapipe/face_detection` 0.4.1646425229：Google MediaPipe、Apache-2.0。モデル・WASM・ローダーは公式npmパッケージをpackage-lock.jsonのintegrityで検証して取得し、scripts/prepare-vision.mjsで同一オリジン用にコピーします。ライセンスは公開物の `public/mediapipe-LICENSE.txt` に含めます。
- `tests/fixtures/pose.jpg`：TensorFlow tfjs-modelsの公開テスト画像。取得元は https://raw.githubusercontent.com/tensorflow/tfjs-models/master/pose-detection/test_data/pose.jpg 。リポジトリのApache-2.0ライセンスを `tests/fixtures/LICENSE` に同梱しています。SHA-256: `c8a830ed683c0276d713dd5aeda28f415f10cd6291972084a40d0d8b934ed62b`。人物モデルの実行確認だけに使用し、本番公開物には含めません。実際の服の異物検出の精度データではありません。

参考にした公式資料：

- https://github.com/google-ai-edge/mediapipe/blob/master/docs/solutions/pose.md
- https://github.com/google-ai-edge/mediapipe/blob/master/docs/solutions/face_detection.md
- https://developer.apple.com/design/human-interface-guidelines/

画像や推定結果を生成するサービスは使用していません。モデルとコードの取得は開発時の依存導入であり、ユーザーの撮影データの外部送信ではありません。
