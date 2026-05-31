# Tatie Preview

Tatie Preview は、TyranoScript / TyranoBuilder プロジェクト内の `[tatie]` タグを VS Code から確認しやすくするための拡張機能です。

`data/others/plugin/tatie/settings.js` を読み込み、キャラクター・立ち絵セット・差分・表示位置に応じた画像プレビュー、補完、診断を提供します。

## インストール

GitHub Releases から `.vsix` をダウンロードし、VS Code の Extensions ビューで `Install from VSIX...` を選んでインストールしてください。

ローカルで `.vsix` を作成する場合:

```sh
npm run package
```

生成先:

```text
dist/skyt-a.tatie-preview-0.1.3.vsix
```

## 主な機能

- `.ks` ファイル内の `[tatie ...]` タグにホバーして立ち絵画像を確認
- CodeLens から該当タグのプレビューを表示
- `name` / `appearance` / `variant` の補完
- 存在しないキャラクター、立ち絵セット、差分指定の診断
- プレビュー画面から `[tatie ...]` タグをコピー、または現在のカーソル位置へ挿入
- `.ks` の現在行から Tyrano / NW.js プレビューを起動

## 使い方

Tatie を導入した Tyrano プロジェクトを VS Code で開くと有効になります。

対象の設定ファイル:

```text
data/others/plugin/tatie/settings.js
```

対象タグ:

```ks
[tatie name="Alice" appearance="default" variant="normal" position="center"]
```

## 設定

| 設定 | 説明 |
| --- | --- |
| `tatiePreview.settingsPath` | `settings.js` の場所 |
| `tatiePreview.imageRoot` | `storage` の基準になる画像フォルダ |
| `tatiePreview.enableCodeLens` | `.ks` 上のプレビュー CodeLens 表示 |
| `tatiePreview.enableCompletion` | `.ks` 上の補完候補表示 |
| `tatiePreview.enableDiagnostics` | `.ks` 上の診断表示 |
| `tatiePreview.previewCommand` | プレビュー起動コマンド。標準は `npx` |
| `tatiePreview.previewArgs` | プレビュー起動引数。標準は `["nw", "."]` |

## ライセンス

MIT
