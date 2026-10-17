# VeriScope オフライン・ゲートリプレイ · DSH プラグイン

[中文](https://github.com/4444wjt/dsh-plugin-veriscope/blob/main/README.md) · [English](https://github.com/4444wjt/dsh-plugin-veriscope/blob/main/README.en.md) · **日本語** · [한국어](https://github.com/4444wjt/dsh-plugin-veriscope/blob/main/README.ko.md)

> 本ページは中国語原文の翻訳です。解釈が異なる場合は中国語原文を優先します。要約ではなく全節を訳していますが、詳細な条件は原文も併せて確認してください。

> **0.6.0 ローカル候補版へのアップグレード**：既存の受領書の現在の有効性は REVIEW となりますが、過去の PASS／FAIL は書き換えません。更新前に状態ディレクトリ全体と元のアーカイブをバックアップし、永続状態はプラグインの外に保存してください。パッケージ内の `.local` は再インストールで失われる場合があり、受領書だけのエクスポートは完全なバックアップではありません。ReceiptV1 は replay、ReceiptV2 は check を再実行してください。

既存スコアは Node 単独の閾値ゲートで確認でき、VeriScope アーカイブは元の Python Quality Gate で再実行できます。両経路とも **PASS／FAIL／REVIEW** と確認可能なローカル受領書を返します。

[GitHub](https://github.com/4444wjt/dsh-plugin-veriscope) · [Gitee 手動同期ミラー](https://gitee.com/kkbushishou/dsh-plugin-veriscope) · VeriScope 本体：[メイン](https://github.com/4444wjt/RAG_Evaluation_Demo)／[ミラー](https://gitee.com/kkbushishou/rag-hallucination-evaluator)。Issue と PR は GitHub へ。

元の replay の数値判定者は Python のままです。B2 は方針に応じて別の `builtin-threshold-v1` または `builtin-threshold-v2` を使います。REVIEW が PASS に変わることはなく、確定した FAIL が付随する異常で覆われることもありません。PASS はアーカイブ指標が紐付いたゲートを通過したことだけを示し、回答の事実正確性を証明しません。本プラグインは再評価せず、アーカイブを変更せず、公開や Git 操作も行いません。

---

以下の従来の VeriScope 手順は replay 向けです。B2 の入力・判定・受領書は上の専用説明に従います。

元の VeriScope アーカイブに加え、B2 の GateArchiveV1 と指定した Ragas records 形式を受け付けます。未対応形式は拒否し、推測や換算はしません。

## 既存スコアを直接確認：B2（0.6.0 ローカル候補版）

Ragas のスコアが既にある場合は JSON に出力し、確認する指標と閾値を指定してゲート判定と受領書の保存を行えます。**VeriScope のインストールも、新たなモデル採点も不要です。**

必要なのは Node ≥22.19 のみです。ホスト起動前に、書き込み可能な永続ディレクトリを `VERISCOPE_STATE_DIR` で明示してください。settings UI はなく、`.env` は読みません。B2 は VeriScope／Python のパスを使用しません。

> `veriscope_gate_check` で `D:\data\scores.json` を確認してください。方針は `D:\data\policy.json`、形式は `ragas-records-v1` とし、判定理由を説明してください。

```powershell
$env:VERISCOPE_STATE_DIR = 'D:\your-data\veriscope-state'
node scripts/check.mjs --archive examples/builtin/ragas-records.json --policy examples/builtin/policy.json --format ragas-records-v1 --json
```

- `GateArchiveV1` と Ragas の `result.to_pandas().to_json(orient="records")` 形式に対応し、`GatePolicyV1` または `GatePolicyV2` を明示します。列名や閾値は推測しません。
- 入力された全行の等重み平均です。欠損をゼロにせず、除外もしません。完全な平均の不合格、または明示した行別閾値に有効な行が違反すれば FAIL。それ以外の情報不足は REVIEW、全データが完全で全条件を満たす場合だけ PASS です。
- `faithfulness` を `pos_faithfulness` に変更しません。B2 の PASS は元のゲートと同一ではなく、採点の真正性や回答の事実正確性を証明せず、出力前に削除された行も検出できません。
- DSH／MCP に check、インストール後の CLI に `veriscope-check` を提供します。`doctor({engine:"builtin"})` は Python を調べません。status／list は両版の受領書を扱います。
- B2 は ReceiptV2 とテキスト表示を使い、bind／complete には使えません。DSH の JSON／Markdown 出力には対応しますが、B2 の share は未対応です。記録は無期限保持で自動削除しません。

**平均が合格でも、最も弱い行を確認できます。** 指標ごとに最も悪い有効行と平均閾値を満たさない行数を表示します。診断だけでは判定を変えません。行ごとに制限するには `GatePolicyV2` の `row_threshold` を指定し、同じ方向・単位を使います。構成例では平均 0.81 に 0.41 の行が含まれ、平均だけなら PASS、各行 ≥0.5 を要求すれば FAIL です。V2 は元の JSON 数値トークンを正確な十進数として比較し、V1 の浮動小数点判定は変更しません。

同梱の `docs/B2.md`、`schemas/`、`examples/builtin/` を参照してください。例は構成例であり、実評価ではありません。0.6.0 は npm に公開済みです。Windows と Ubuntu のリモート CI（固定上流の実リプレイを含む）は通過し、Claude の完全な構造化エラー受け渡しのみ未検証です。0.5.0 の過去の証拠は `docs/acceptance-b2-v0.5.0.json` に残します。

## 元の VeriScope 経路：設定後に始める

環境を設定した後（次節）、DSH で順に入力します。

1. 「`veriscope_doctor` で本機の環境を確認し、修正点を教えて」
2. 「VeriScope で `D:\データ\評価結果.json` を確認し、通過したか理由を説明して」
3. 「`veriscope_gate_list` で最近の受領書と現在の有効性を一覧して」

さらに次も使えます。

> 前回のゲート結果が今も有効か確認して。

診断の「環境準備完了」は環境が使えるという意味だけで、ゲート通過には実際のリプレイが必要です。チャットがツールを自動選択するかは DSH のモデル設定に依存します。必要ならツール名を明示してください。

よくある三つの場面：

- **保守担当者へ送る**：「今回の失敗を共有できる要約にして」→ `format: "share"` でローカル Markdown を生成。まず自分で確認し、その後に共有。受領書ではありません。
- **アーカイブが開けない**：判明する範囲で異常な行・列やフィールド位置を示します。ファイルは変更しません。
- **昨日は通過、今日は要再確認**：確認済みの閾値・バージョン・入力ダイジェストの変化を列挙し、確認できない範囲は未確認のまま残します。

タスクの完了条件としてゲート判定を必須にする場合は、今回の確認をタスクに紐付けます。紐付いた受領書が現在有効かつ PASS のときだけ完了を登録できます。

**使用前に VeriScope と Python のパスを設定してください。評価モデルを新たに呼び出すことはありません。**

## インストールと設定

本文は **0.6.0 ローカル候補版** に対応し、DSH プラグインと独立した `veriscope-mcp` エントリを提供します。利用可能な公開版は [npm パッケージページ](https://www.npmjs.com/package/dsh-plugin-veriscope)で確認してください。MCP 設定と未検証の範囲は以下に記載します。検証済みの DSH CLI ではプロファイルを明示します。以下は専用の `veriscope-demo` を使います。

```powershell
# インストール
dsh plugin --profile veriscope-demo add dsh-plugin-veriscope
# インストール済みバージョン
dsh plugin --profile veriscope-demo list dsh-plugin-veriscope --depth 0
# アンインストール
dsh plugin --profile veriscope-demo remove dsh-plugin-veriscope
```

ローカルでの開発やカスタマイズには、代わりにローカルディレクトリからインストールできます。

```powershell
dsh plugin --profile veriscope-demo add 'D:\your-workspace\dsh-plugin-veriscope'
```

パスは実際のソース位置に置き換えてください。ディレクトリ／link でのインストールを registry インストールの証明にしないでください。**インストール成功はゲート通過ではありません。**従来の replay は初回に `VERISCOPE_ROOT` と `VERISCOPE_PYTHON` の設定と診断が必要です。B2 だけなら状態ルートのみ設定します。npm パッケージにテストは含みません。`docs/B2.md`、Schema と B2 例は同梱し、その他の文書はリポジトリにあります。`npm test` はソース開発専用、`node scripts/verify-replay.mjs` も完全なソースリポジトリと検証素材がある場合のみ動作し、インストール後の機能ではありません。詳細はリポジトリを参照してください。

0.3.x の過去の検証：Windows、DSH NEXT 2.0.18-next、内部 DSH／tools／skill **0.2.1-alpha.2**。Node ≥22.19。他のホスト版は未検証。上流および Python／pandas との互換も必要で、固定依存は[上流の説明](https://github.com/4444wjt/dsh-plugin-veriscope/blob/main/docs/UPSTREAM.md)にあります。本プラグインは上流全体や業務アーカイブを同梱しません。

DSH エントリは `@deepseek-ai/dsh-tools` の `0.2.1-alpha.2` を要求し、SDK コードの読み込み前にバージョンを、読み込み後に `defineTool` を確認します。未導入、非互換、読み込み失敗はそれぞれ `SDK_MISSING`、`SDK_INCOMPATIBLE`、`SDK_LOAD_FAILED` として報告し、SDK の自動インストールや切り替えは行いません。この確認はホスト受入を代替しません。MCP は DSH SDK を読み込みません。

### 設定項目

**設定 UI はなく、`.env` も自動では読みません。** パスはホストプロセスの環境変数のみを参照し、cordis patch は `completionMode` だけを受け付けます。ホスト側の環境読み込み方針はホストの責任です。

| 設定 | 入口 | 既定値と要件 |
|---|---|---|
| `veriscopeRoot` | `VERISCOPE_ROOT` | Windows 既定値は `D:\RAG_Evaluation_Demo`。POSIX は明示設定が必須 |
| `pythonPath` | `VERISCOPE_PYTHON` | `.venv`／`venv` を順に探索。Windows は `Scripts/python.exe`、POSIX は `bin/python`。PATH にはフォールバックしません |
| 状態ルート | `VERISCOPE_STATE_DIR` | 従来の DSH replay は `<プラグイン>/.local` が既定。B2 と全 MCP ツールは永続ディレクトリの明示が必須 |
| リマインダ | cordis patch `completionMode` | `off`。`off` か `remind` のみ、他はエラー |

三つの環境変数の明示値は空でない絶対パスである必要があります。無効な値を指定しても、既定値には自動で切り替わりません。**DSH を起動するのと同じターミナル**で設定し、起動または完全再起動します。次の最終行は、先ほどの npm インストールに代えて GitHub からインストールする場合のコマンドです。インストール済みなら実行は不要です。

```powershell
$env:VERISCOPE_ROOT = 'D:\your-workspace\VeriScope'
$env:VERISCOPE_PYTHON = 'D:\your-workspace\VeriScope\venv\Scripts\python.exe'
$env:VERISCOPE_STATE_DIR = 'D:\your-data\veriscope-state'
dsh plugin --profile veriscope-demo add github:4444wjt/dsh-plugin-veriscope
```

専用プロファイルと対応するホスト CLI を先に用意してください。インストールコマンドは完全なホスト設定を作りません。プラグイン bundle は既定エントリを挿入済みなので、`<DSH_HOME>/profiles/<名前>/cordis.patch.yml` で既存 `id` を上書きし、再度 `insert` しないでください。

```yaml
- id: dsh-plugin-veriscope
  config:
    completionMode: "remind"
```

`off` はターン停止時のリマインダを無効化し、全ツールは利用可能なままです。`remind` は未完了の紐付きタスクだけを通知し、通常チャットの全般的な遮断は約束しません。パスはこの config に書けません。

## 複数ホスト向け MCP

MCP は引き続き 5 ツールです。V2 方針も既存の check／status／list を使います。0.5.0 の過去の証拠と未検証項目は `docs/acceptance-b2-v0.5.0.json` を参照し、本候補版の検証とは分けます。以下は 0.4.0 の過去の検証です。

0.4.0 では分離した Claude Code／Codex のホスト制御インターフェースで実際のツール呼び出しを検証しました。モデルとの対話は行っていません。Windows と Ubuntu の実リプレイは確認済みです。Claude のエラー経路は制御 API からテキストのみが返り、構造化エラー全体の受け渡しは未検証です。Node の絶対パスでソースの `mcp.js` を起動します。設定と分離環境の例は [MCP 接続手順](https://github.com/4444wjt/dsh-plugin-veriscope/blob/main/docs/MCP.md)を参照してください。DSH SDK は読み込みません。初版は `veriscope_doctor`、`veriscope_gate_replay`、`veriscope_gate_status`、`veriscope_gate_list` の 4 ツールのみで、ネイティブカードはありません。batch／export と bind／complete は DSH 専用です。セッションの紐付けは移植せず、MCP レポートの `execution.session_id` は `null` です。

現在の MCP の 5 ツールはすべて有効な `VERISCOPE_STATE_DIR` の明示が必要です。未設定なら要確認を返し、パッケージ内にはフォールバックしません。doctor は一時プローブを作成・削除し、replay はレポートと受領書を書き込むため、どちらも読み取り専用ではなく、新しい check も記録を書き込みます。status／list は読み取り専用です。業務上の FAIL はツール実行エラーとは異なります。ホストでのツール呼び出し、Linux の実リプレイ、本バージョンの検証状況は[受入記録](https://github.com/4444wjt/dsh-plugin-veriscope/blob/main/docs/acceptance-mcp-v0.4.0.json)に分けて記録します。登録成功や独自クライアントの成功だけではホスト受入を証明しません。

## 9 つのツール

| ツール | 用途 |
|---|---|
| `veriscope_gate_check({archive_path, policy_path, format?})` | 既存の逐行スコアに対する Node 単独の閾値判定。Python 不要で ReceiptV2 を生成 |
| `veriscope_doctor({engine?})` | 既定は従来の replay 環境を診断。`engine:"builtin"` は Node と明示的状態ルートのみ確認し、修正提案を返す |
| `veriscope_gate_replay({result_path, baseline?, faith?, ctx?})` | 既存アーカイブで実際にゲートを実行し、独立記録を保存、条件を満たす場合に ReceiptV1 を生成 |
| `veriscope_gate_status({run_id, faith?, ctx?, baseline_run_id?})` | 受領書の現在有効性を読み取り専用で確認。リプレイ・採点・新規受領書は行わない |
| `veriscope_gate_list({limit?})` | 既定で直近 50 件（1–200）。各件で status を再利用し、破損記録は別掲 |
| `veriscope_gate_batch({paths?, dir?, baseline?, faith?, ctx?})` | パス配列かディレクトリの二択。順次リプレイ、最大 200 件、キャンセル可、各件記録 |
| `veriscope_gate_export({run_id?, run_ids?, format})` | 1–50 件を状態ルートの `exports/` へ出力。`share` は許可リストに含まれる項目だけを使った問い合わせ用要約、`md` は完全レポート、`json` は原本受領書。既存は上書きしない |
| `veriscope_gate_bind({task_id, run_id, faith?, ctx?, baseline_run_id?})` | ホストが提供する本セッション内で管理タスクと現在の受領書を紐付け |
| `veriscope_gate_complete({task_id, run_id})` | セッションの紐付けを再確認し、現在有効な PASS のときだけ完了を登録 |

### パラメータと規則

- 従来の replay の閾値は既定 0.8、0–1 の有限値である必要があり、PASS を得るために自動で下げることはありません。
- アーカイブの相対パスは `VERISCOPE_ROOT` を基準にします。
- `baseline_run_id` は省略で元のベースライン維持、`null` でベースラインなし、UUID は現在の状態ルート内の有効な受領書を参照します。
- `task_id` は英数字・下線・ドット・ハイフン 1–80 文字。セッション識別子はツール引数で偽装できません。紐付けはメモリ上のみで、再起動後は再紐付けが必要です。ディスク上の完了記録が権限を復元することはありません。

「有効性の確認」は status、「ゲートの再実行」は replay です。ReceiptV1 は実際の replay、ReceiptV2 は実際の B2 check のみが生成します。入力・ベースライン・方針・上流・プラグイン・環境が変わると、旧受領書は要再確認になり、過去の失敗は保持されます。詳細は[受領書プロトコル](https://github.com/4444wjt/dsh-plugin-veriscope/blob/main/docs/RECEIPTS.md)。

0.4.0 は従来の監査済み契約、または公開コミット `1b89bcabb83e1b123039799516596fdcfd393d42` から監査した LF 契約のどちらかを受け付けます。契約一式の元バイトが一致する必要があり、ファイル単位の混在や実行時の正規化は行いません。MCP 入口、共有ツール一覧、契約選択コードも受領書のハッシュ対象です。更新により旧受領書の現在の有効性は REVIEW になりますが、過去の記録は保持します。

### 入出力の例

```text
veriscope_doctor({})
-> {status:"READY", ready:true, summary:"环境就绪", items:[…]}
veriscope_gate_list({limit:10})
-> {items:[{run_id:…, historical_verdict:"PASS", current_verdict:"REVIEW", …}], damaged:[…]}
veriscope_gate_batch({paths:["a.json","b.json","broken.json"]})
-> {status:"FAIL", counts:{pass:1, fail:1, review:0, error:1}, …}
veriscope_gate_export({run_id:"実際の実行 UUID", format:"md"})
-> {exported:true, path:"<状態ルート>/exports/<一意名>.md", …}
veriscope_gate_export({run_id:"実際の実行 UUID", format:"share"})
-> {exported:true, share_summary:{schema_version:"GateShareSummaryV1", is_receipt:false, …}, …}
```

これらはフィールド例であり、実測の業務結果ではありません。バッチは**FAIL が一つでもあれば FAIL に集約**し、FAIL がなくても要再確認・エラー・キャンセル・未処理があれば REVIEW です。ディレクトリは直下の JSON のみを対象とし、再帰しません。エラーが確定した失敗を覆うことはなく、失敗が次のリプレイを止めることもありません。

### 一覧・バッチ・エクスポート

一覧は最大 10,000 件のディレクトリ項目を走査し、超過時は要再確認を明示します。`limit` 範囲外の受領書は現在環境での再確認を行いません。破損受領書の時刻が信頼できない場合、ディレクトリ更新時刻で並べ、その旨を明示します。単一 JSON 出力は原本受領書とバイト一致、複数件は原本受領書オブジェクトの配列です。JSON 内の過去 PASS は現在有効を意味せず、現在状態は返却値の `current` を参照してください。Markdown は過去と現在の状態、アーカイブ指標、閾値、根拠件数、制限を併記します。診断は自身の一時プローブのみ作成・削除し、設定変更や依存導入は行いません。

`share` は別途 Markdown を生成し、固定状態、既知の理由、限られた指標と閾値、件数、厳格なバージョン番号のみを含みます。パス、原文、ログ、モデル名、時刻、ハッシュ、未知フィールドは除外し、実行番号は「記録1」等の別名に置き換えます。共有するのは**ファイル本文か `share_summary`** です。ツール戻り値全体にはローカルパスが含まれます。数値やバージョンも機密になり得るため、先に確認してください。要約は status／bind／complete には使えず、事実正確性を証明せず、あらゆる秘密の検出も保証しません。

### 異常位置と変化の説明

JSON 拒否時、`execution.errors[].diagnostic` が確認可能な発見点を示します。行・列は 1 始まりで、デコード後の UTF-16 単位で数え、CRLF は 1 改行とみなします。制限されたフィールドパスが安全に特定できない場合は `null` で、原文は返しません。位置は唯一の変更点とは限らず、自動修正や追加再試行は行いません。

status の `changes` は、元の受領書と今回取得した固定紐付け項目の差だけを説明し、最大 20 項目で打ち切りを明示します。`COMPLETE` は列挙範囲を確認したという意味のみで、変化がないことは事実正確性を意味しません。`UNVERIFIED` は一部または全部が未確認という意味で、確認済みの変化は表示されます。契約検査の失敗は元の拒否経路を維持し、それ以外は未確認のままです。検査を迂回して比較を捏造することはせず、そこからスコア変化を帰属させることもありません。

## ネイティブ結果カード（従来の DSH replay）

B2 status は同じ領域に中国語テキストを表示し、従来の Python 項目や更新ボタンは使いません。

`tool.call.toolview` 対応ホストでは、暗色に金色の中国語結果カードを表示します。現在の三状態、次の手順、「再確認」ボタン、折りたたみ根拠です。ボタンは状態を読むだけで、リプレイや完了登録はできません。カード非対応の場合は中国語テキストを保持します。

折りたたみ根拠には中国語の理由、受領書の閾値、Node／Python／pandas のバージョン、入力パス、バイト数、SHA-256 の先頭 12 文字が入ります。欠損値は不明のままです。これらは受領書が紐付けた過去の環境記述であり、現在の有効性は今回の確認によります。

この領域には紐付け項目の変化と未確認の注意も表示されます。元のリプレイに確認可能なアーカイブ異常位置があれば併記し、過去の診断と明示します。バージョン情報はゲート実行環境であり、元のモデル評価環境の代用ではありません。

カードは開くたびに同じ明示的閾値／ベースライン方針で再確認し、過去の PASS をそのまま表示しません。読み込み失敗、方針無効、本セッション紐付けの欠如、プロトコル不完全はいずれも要再確認です。表示はその確認時刻のみを表し、ファイルを継続監視しません。使用前に再確認できます。ネイティブカードにパス設定パネルはありません。

## 従来の replay：三つの状態と判定規則

本プラグインは既存の評価結果を読み、ゲートを実行し、通過（PASS）・失敗（FAIL）・要再確認（REVIEW）のいずれかを返します。

| 現在状態 | `gate_passed` | 意味 |
|---|---|---|
| PASS | `true` | Python 通過、受領書完全、今回確認した紐付けは不変 |
| FAIL | `false` | Python が明示的に遮断、受領書完全、現在の紐付けは不変 |
| REVIEW | `null` | 入力・依存・受領書・実行が不完全、紐付け変化、またはプロトコル衝突 |

replay が FAIL を確定した後、受領書の書き込みに失敗しても中核の FAIL は保持されます。後続の status は完全な受領書がないため要再確認となります。元 report の FAIL 記録は読める状態で残り、検証できない過去項目は unknown のままです。Python が 1 で終了しても traceback のみなら REVIEW です。

## 出力とデータ境界

従来の replay の記録は `<状態ルート>/runs/<run_id>/` に `report.json`、stdout、stderr、条件を満たす場合の `receipt.json` として保存されます。完了登録は `completions/` に別保存します。B2 は report、原入力、方針、正規化データと ReceiptV2 を保存し、stdout／stderr は偽造しません。追記は失敗を上書きしません。ログにはアーカイブ断片やローカルパスが含まれ得るため、共有前に秘匿化してください。本プラグインはアーカイブを送信せず、環境全体を表示しません。

全記録は既定で無期限保存され、自動削除はありません。`VERISCOPE_STATE_DIR` を明示して `node scripts/prune.mjs --dry-run --json` を実行すると、ファイル一覧、論理バイト数、記録上の関連を読み取り専用で表示します。関連の正しさは検証せず、削除入口もありません。再インストールや削除に備え、状態はプラグイン外に保存してください。

入力は 10MiB、stdout／stderr は各 2MiB、リプレイは 120 秒、環境診断は各 10 秒が上限です。ReceiptV1 の status はファイルを読みハッシュし、Python を起動してバージョンと pandas メタデータを取得しますが、評価モデルやゲートスクリプトは実行しません。ハッシュは意味的正しさを証明せず、状態ルート全体を書き換えられる利用者は対象外です。確認後の変化は再確認でしか見つかりません。

過去の Trace は逐字の出所のみを照合し `historical_ai` と表示します。新しい意味的検査ではありません。中核は新たな評価モデル呼び出しをゼロに保ちますが、ホストの会話にはトークン費用が生じ得ます。アルゴリズムの独自性やエンドツーエンドのコスト削減は主張しません。

## 検証と保守

```powershell
node --test
node scripts/replay.mjs --result 'D:\your-data\evaluation.json' --json
dsh plugin --profile veriscope-demo remove dsh-plugin-veriscope
```

単体テストは構築したアーカイブとプロトコルスタブを使い、モデルも Python も必要としません。実際の Python とホスト検証は[検証ノート](https://github.com/4444wjt/dsh-plugin-veriscope/blob/main/docs/verification.md)を参照してください。アンインストールは登録を削除します。外部の状態ルートはプラグインから削除しませんが、パッケージ内の既定状態は削除や再インストールで失われる可能性があるため、先にバックアップしてください。ソースからの公開には `VERISCOPE_RELEASE=1` の明示とバージョン／tag ガードの通過が必要です。詳細は貢献ガイドへ。

## 貢献とライセンス

[貢献ガイド](https://github.com/4444wjt/dsh-plugin-veriscope/blob/main/CONTRIBUTING.md) · [ガバナンス](https://github.com/4444wjt/dsh-plugin-veriscope/blob/main/GOVERNANCE.md) · [変更履歴](https://github.com/4444wjt/dsh-plugin-veriscope/blob/main/CHANGELOG.md) · [ロードマップ](https://github.com/4444wjt/dsh-plugin-veriscope/blob/main/ROADMAP.md) · [セキュリティ](https://github.com/4444wjt/dsh-plugin-veriscope/blob/main/SECURITY.md) · [リリースチェック](https://github.com/4444wjt/dsh-plugin-veriscope/blob/main/docs/RELEASE_CHECKLIST.md)。マーケットの PR がマージされるまで掲載済みとは称しません。

MIT。スキャフォールドの原著作者表記を保持します。出所は[第三者表記](https://github.com/4444wjt/dsh-plugin-veriscope/blob/main/THIRD_PARTY_NOTICES.md)と[出所ハッシュ](https://github.com/4444wjt/dsh-plugin-veriscope/blob/main/docs/provenance.json)を参照。上流コンポーネントは別途配布され、そのライセンスに従う必要があります。
