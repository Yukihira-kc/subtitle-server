# 手入力版Azureの本番更新

対象は `subtitle-standby-jp.azurewebsites.net`。手入力版のGitHubリポジトリ `Yukihira-kc/subtitle-server` の `azure-standby-deploy` ブランチで実行する。

## 初回の接続

Azureで既存App Serviceのリソースグループを選び、`authorize.json` を適用する。出力 `githubConfig` をリポジトリの Actions シークレット `AZURE_STANDBY_CONFIG` に登録する。GitHub Actionsはフェデレーションで一時的なAzureトークンを取得する。このAzureの権限は対象App Serviceの配備権限に限定する。

## 更新の手順

1. 公開する手入力版の画面とサーバーのコミットを決める。Azure版の既存の起動方法と公開ファイル配置を確認し、必要な差分と期待する公開ファイルのハッシュを `run-release.py` と `patch_standby.py` に記録する。
2. `operation.json` の `mode` を `inspect` にして専用ブランチに反映する。稼働中のパッケージの読み取りとパッチ作成が成功することを確認する。
3. `mode` を `deploy` に変え、同じ専用ブランチに反映する。GitHub Actionsの実行結果と公開ファイルを確認し、PIN付きの検証用ルームで対象の操作を試す。

`identity` はGitHub側のフェデレーション識別子を確認するモード。パッケージはActionsランナーの一時領域で処理する。
