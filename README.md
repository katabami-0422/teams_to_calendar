# Teams チャネル投稿ファイル → Google Calendar 同期

Microsoft Teams の**チャネルに投稿されたファイル（写真・PDF など）**を、自分の Teams ログイン（ブラウザ）経由で取得し、
ファイルの中身を **Windows 標準 OCR で読み取って締切日を抽出**、Google Calendar に予定として自動で書き出す CLI ツールです。
毎日決まった時刻に自動実行できます。

## 仕組み

```
Teams にログインしたブラウザ（Playwright）
        │
        │  画面が呼ぶ SharePoint 通信からトークンとサイト/ドライブを捕捉
        │  ドキュメントライブラリ → チャネルフォルダ → ファイル を列挙
        ▼
  写真/PDF をダウンロード
        │  Windows.Media.Ocr（日本語・ローカル・追加インストール不要）
        │  PDF は埋め込みテキスト層の日付もヒントに併用
        ▼
  「提出期限：11月14日(金)」等を抽出 ──▶  Google Calendar に締切の予定を作成/更新/削除
```

- **学校管理者の承認（admin consent）が不要**です。Graph の教育系権限は管理者承認が必須ですが、
  この方式は「あなた自身が Teams にログインした状態のブラウザ」が持つ SharePoint トークンをそのまま利用します。
  （新 Teams は Graph を直接呼ばないため、ファイルの実体である SharePoint を読みます。）
- 2回目以降は保存済みのログイン状態（`profile/`）を再利用して自動実行します。
- 同じファイルは同じ予定に更新され、締切が過ぎた予定は削除されます（冪等）。実行ごとに差分（新規/変更/削除）を表示します。
- ダウンロードした元ファイルは `files/` に保存されます（確認用）。
- 対象はログイン時に観測したチームサイトのドキュメントライブラリ（＝チャネルの「ファイル」タブ）。
  プライベート/共有チャネルは別サイトになるため対象外です。

## 前提

- Windows + Node.js 20.12 以上、**Microsoft Edge**（標準搭載）を使用。
- OCR に **Windows の日本語言語パック**が必要です（設定 → 時刻と言語 → 言語 → 日本語）。
- PDF の画像化に Python 3 と **PyMuPDF**（`pip install pymupdf`）を使用します。
- Google カレンダー側のセットアップに **Google Cloud のプロジェクト作成**が必要（18歳以上のGoogleアカウントで行ってください）。

---

## セットアップ

### 1. 依存関係の導入

リポジトリをクローンしたフォルダに移動して、依存関係を導入します。

```bash
cd teams-assignments-to-gcal
npm install
pip install pymupdf
```

標準の Edge を使うため、Playwright のブラウザ本体のダウンロードは不要です（`TEAMS_BROWSER=msedge`）。

### 2. 環境設定ファイル

```bash
cp .env.example .env
```

- `TEAMS_BROWSER` / `TEAMS_HEADLESS` はそのままでOK。
- 特定のチーム／チャネルだけ対象にしたい場合は `TEAMS_ONLY` / `CHANNEL_ONLY` を記入。
- `GOOGLE_CLIENT_ID` / `GOOGLE_CLIENT_SECRET` は次のステップで取得して記入します。

### 3. Teams へのログイン（初回のみ・対話的）

```bash
npm run teams:login
```

1. ブラウザが開くので、**学校のアカウントで Teams にサインイン**（多要素認証含む）します。
2. ホームが表示されたら、ファイルが投稿されている**チャネルを1つ開きます**（トークン取得のため）。
3. ターミナルに戻って **Enter** を押します。

> ここで「SharePoint トークン: 取得OK」と出れば成功です。

### 4. Google カレンダーへの許可（初回のみ）

1. [Google Cloud Console](https://console.cloud.google.com) でプロジェクトを作成。
2. 「API とサービス」→「ライブラリ」→ **Google Calendar API** を有効化。
3. 「OAuth 同意画面」: External。アプリ名などを入力し、**公開ステータスを「本番環境」に**（テストのままだと7日でトークンが切れます。スコープは非機微のため審査は不要）。
4. 「認証情報」→「OAuth クライアント ID」→ **デスクトップアプリ** で作成。
5. クライアントID／シークレットを `.env` の `GOOGLE_CLIENT_ID` / `GOOGLE_CLIENT_SECRET` に記入。
6. 認証を実行:

```bash
npm run auth:google
```

表示された URL を開いて許可し、飛んだ先の `code=` の値を貼り付けます。

### 5. 同期

```bash
npm run sync:dry-run   # カレンダーを変更せず、ファイルと締切の抽出結果だけ確認
npm run sync           # 実際に Google Calendar へ反映
```

- 締切が見つかったファイルは、その日時に予定が作られます。
- 時刻が書かれていない場合は `DEFAULT_DEADLINE_TIME`（既定 23:59）が使われます。
- 24時間前と1時間前にリマインダーが付きます（`.env` で変更可）。

### 6. 毎日の自動実行

```powershell
powershell -ExecutionPolicy Bypass -File .\schedule.ps1 -Hour 7 -Minute 30
```

- タスク名 `TeamsAssignmentsToGCal` で、毎日 07:30 に実行されます。
- 解除: `Unregister-ScheduledTask -TaskName TeamsAssignmentsToGCal`
- 既定ではヘッドレス（画面なし）で実行します。ログイン切れが頻発する場合は `.env` の `TEAMS_HEADLESS=0` に変更してください。

---

## トラブルシューティング

| 症状 | 対処 |
|---|---|
| `Teams にログインしていません` | `npm run teams:login` で再ログイン（学校側のポリシーでセッションが切れた可能性） |
| `SharePoint トークンを取得できませんでした` | `npm run teams:login` を実行し、チャネルを1つ開いてから Enter |
| `ドキュメントライブラリを取得できませんでした` | チャネルの「ファイル」タブを一度開いてから再試行。トークンの権限が足りない可能性もあるので `npm run teams:login` で再ログイン |
| OCR が日本語を読めない | Windows 設定で日本語の言語パック（OCR）を追加 |
| PDF が読めない | `pip install pymupdf` が入っているか確認 |
| Google で毎週再認証を求められる | OAuth 同意画面の公開ステータスが「テスト」のまま。「本番環境」に変更して `npm run auth:google` を再実行 |
| 予定が重複する | 既存の対象予定を手動削除 → `state.json` を削除 → `npm run sync` |

## ファイル構成

- `src/teams-login.js` — 初回の対話ログイン＋トークン確認
- `src/teams-browser.js` — Teams ブラウザ操作・SharePoint トークン取得・ドキュメントライブラリの列挙/ダウンロード
- `src/sync.js` — 同期本体（ファイル取得→OCR→締切抽出→カレンダー反映）
- `src/ocr.js` / `src/ocr.ps1` / `src/pdf2img.py` — OCR（画像・PDF）
- `src/deadline.js` — 日本語テキストからの締切抽出
- `src/google-auth.js` — Google OAuth 認証
- `test/deadline.test.mjs` — 締切抽出のテスト
- `schedule.ps1` — タスクスケジューラ登録
- `profile/` — Teams のログイン状態（自動生成・コミット禁止）
- `tokens/` — Google トークン（自動生成）
- `state.json` — ファイル⇔予定ID の対応（自動生成）
- `files/` — ダウンロードした元ファイル（自動生成）
