<div align="center">

<img src="assets/icons/app-256.png" width="128" height="128" alt="Relay のアプリアイコン">

# Relay

**すべての Claude アカウントを、1つのメニューバーアプリで。**<br>
Claude Desktop をアカウント間で切り替え、どのアカウントでも Claude Code の履歴を保ち、<br>
5時間と週間の上限をひと目で確認し、作業の振り分けはローカルのゲートウェイに任せられます。

[![最新リリース](https://img.shields.io/github/v/release/ahmetcankacar54/relay?style=flat-square&label=%E3%83%AA%E3%83%AA%E3%83%BC%E3%82%B9&color=ea580c)](https://github.com/ahmetcankacar54/relay/releases/latest)
[![ダウンロード](https://img.shields.io/github/downloads/ahmetcankacar54/relay/total?style=flat-square&label=%E3%83%80%E3%82%A6%E3%83%B3%E3%83%AD%E3%83%BC%E3%83%89&color=ea580c)](https://github.com/ahmetcankacar54/relay/releases)
[![CI](https://img.shields.io/github/actions/workflow/status/ahmetcankacar54/relay/check.yml?branch=main&style=flat-square&label=CI)](https://github.com/ahmetcankacar54/relay/actions/workflows/check.yml)
[![macOS](https://img.shields.io/badge/macOS-13%2B-000000?style=flat-square&logo=apple&logoColor=white)](#インストール)
[![Windows · Linux](https://img.shields.io/badge/Windows%20%C2%B7%20Linux-%E5%AF%BE%E5%BF%9C-2f6feb?style=flat-square)](#プラットフォーム)
[![15の言語](https://img.shields.io/badge/%E8%A8%80%E8%AA%9E-15-6b645e?style=flat-square)](#15の言語)
[![MIT](https://img.shields.io/badge/%E3%83%A9%E3%82%A4%E3%82%BB%E3%83%B3%E3%82%B9-MIT-6b645e?style=flat-square)](LICENSE)

[English](README.md) · [Türkçe](README.tr.md) · [简体中文](README.zh-CN.md) · **日本語** · [한국어](README.ko.md) · [Español](README.es.md)

*これは翻訳です。原文は英語の README で、こちらより新しい場合があります。*

[ダウンロード](#インストール) · [機能](#機能) · [プライバシー](#プライバシーとセキュリティ) · [規約とリスク](#規約とリスク) · [よくある質問](#よくある質問) · [CLI](cli/README.md)

<br>

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="docs/images/overview-dark.webp">
  <img src="docs/images/overview-light.webp" width="900" alt="Relay の概要画面: 使用中のアカウントとその5時間・週間・モデル別の上限、次に切り替えるアカウント、すべての Claude・Codex・Antigravity アカウントとその上限">
</picture>

</div>

## Relay を使う理由

Claude のプランを複数持っている場合（たとえば個人の Pro または Max と、会社の Team または Enterprise のシート）、Claude アプリは一度に1つのアカウントしか扱えません。サインアウトしてサインインし直すと数分かかり、Code タブの会話は失われ、どのアカウントにまだ余裕があるのかもわかりません。

Relay はこれをメニューバーから解決します。

- **ワンクリックで切り替え。** Relay は Claude アプリを終了し、もう一方のアカウントの保存済みサインインを戻してから、アプリを再び開きます。入力し直すものはなく、ブラウザを行き来する必要もありません。
- **Code の履歴がついてきます。** 選んだアカウントの間で Claude Code の会話とプロジェクトが統合されるので、どの切り替えの後も同じ会話が権限モードごと残っています。
- **すべてのアカウントのすべての上限。** Claude、OpenAI Codex、Google Antigravity の各アカウントについて、5時間・週間・モデル別（Opus、Fable）の上限をリセット時刻とともに表示し、バックグラウンドで更新します。
- **1日の計画。** Relay は各アカウントの5時間の期間を作業時間の中にずらして配置し、今のアカウントが尽きる前に次のアカウントを使えるようにします。
- **適切なアカウントを使うゲートウェイ。** Claude Code、Codex CLI、omp を1つのローカルアドレスに向けると、各リクエストは余裕のあるアカウントに送られ、セッションとキャッシュはそれぞれのアカウントに留まります。初期設定ではオフです。オンにする前に[規約とリスク](#規約とリスク)をお読みください。

Relay は無料のオープンソース（MIT）で、すべて Mac 上で動作し、すでに使っているサービス以外には何も送信しません。

## インストール

| プラットフォーム | ダウンロード | 備考 |
| --- | --- | --- |
| **macOS 13+**（Apple silicon） | [`Relay-<version>-arm64.dmg`](https://github.com/ahmetcankacar54/relay/releases/latest) | メインのプラットフォームです。メニューバーのパネル、ウィジェット、自動切り替え。 |
| **Windows 10/11**（x64） | [`Relay-Setup-<version>-x64.exe`](https://github.com/ahmetcankacar54/relay/releases/latest) | 手動での切り替え、上限、アカウント、ゲートウェイ。 |
| **Linux**（x64） | [`Relay-<version>-x86_64.AppImage`](https://github.com/ahmetcankacar54/relay/releases/latest) | Linux 版の公式 Claude Desktop で動作します。 |
| **CLI**（macOS） | `npm i -g @ahmetcankacar/relay` | `relay switch`、`relay usage`、`relay run` … 詳しくは [CLI ガイド](cli/README.md)（英語）をご覧ください。 |

すべてのリリースに `SHA256SUMS.txt` が含まれ、Relay は GitHub Releases から自動で更新されます。

> [!IMPORTANT]
> **Relay は作者自身の証明書で署名されていますが、Apple による公証（notarization）は受けていません。** 初めて開くとき、macOS が一度だけブロックします。
> 1. DMG から **Relay** を **アプリケーション** フォルダにドラッグし、そこから開きます。
> 2. macOS が Relay を検証できないと表示したら、**完了** をクリックします。
> 3. **システム設定 → プライバシーとセキュリティ** を開き、「Relay がブロックされました」という表示を見つけて **このまま開く** をクリックします。
>
> この操作はバージョンごとに一度必要です。macOS が繰り返し確認してくる場合は `xattr -dr com.apple.quarantine /Applications/Relay.app` を実行してください。詳しい手順は [INSTALL.txt](docs/share/install-notes.md)（英語）にあります。

## クイックスタート

| 状況 | 操作 |
| --- | --- |
| 1つのアカウントでサインイン済みの Claude アプリ | **アカウント → アカウントを追加**。Relay がそのサインインを保存し、この Mac にある Codex CLI のサインインも見つけます。 |
| 別の Claude アカウント | **アカウントを追加 → 別の Claude アカウントでサインイン**。Claude アプリがサインイン画面で開くので、サインインして Code を一度開くと、Relay が自動で保存します。 |
| 追加済みのアカウント | メニューバーまたは概要で、アカウントの横にある **切り替え** をクリックします。 |
| 複数のアカウントと1日の作業 | **計画** → アカウントと作業時間を選びます。 |
| ターミナルの Claude Code または Codex CLI | **プロキシとゲートウェイ → ツール → 接続** で、ワンクリックでゲートウェイに向けられます（元に戻すこともできます）。 |

## 機能

### アカウントを考えたとおりにグループ化

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="docs/images/accounts-dark.webp">
  <img src="docs/images/accounts-light.webp" width="900" alt="プロバイダと仕事グループでグループ化されたアカウントページ。各アカウントの状態、5時間と週間の使用量、次の操作を表示">
</picture>

- Claude、OpenAI Codex、Google Antigravity のアカウントを1つのリストにまとめ、プロバイダと仕事グループでグループ化し、名前・5時間の使用量・次のリセットのいずれかで並べ替えます。折りたたんだグループは記憶されます。
- アカウントごとに状態は1つ（準備完了、使用中、上限間近、使用量データが古くなっています…）、操作は多くても1つ（切り替え、更新、再接続）です。
- 各アカウントの接続を1か所で確認できます。Claude アプリのサインイン、使用量サインイン、Claude ブラウザ拡張機能、ターミナルの `claude` です。

### 作業を失わない切り替え

- **切り替え** はメニューバー、ウィンドウ、ウィジェット、CLI から行えます。切り替えは、変更するファイルを暗号化してバックアップした後に Claude アプリをクリーンに再起動するものです。中断された切り替えは復元できます。
- **共有の Code の履歴**: 選んだアカウント（会社をまたいでも可）の会話とローカルプロジェクトが、切り替えのたびに統合されます。削除した会話は削除されたままで、Bypass 権限モードが引き継がれることはありません。
- **自動切り替え**（任意）: Claude アプリを終了したとき、または（実験的機能、macOS）使用中のアカウントが上限に達したときに、Relay は使える余裕が最も大きいアカウントを選んで一度だけ切り替え、止まった各会話に続行メッセージを1通ずつ送ります。
- Claude アプリで送信しないまま残っていた下書きは切り替え時に保存され、コピーして戻せます（macOS では Relay が代わりに入力し直すこともできます。実験的機能です）。

### 上限と履歴と金額

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="docs/images/limits-dark.webp">
  <img src="docs/images/limits-light.webp" width="900" alt="上限の履歴: 使い切った期間、開始した期間、上限到達、最も忙しい時間帯、アカウントごとの日別の推移、アカウントの配分、最近の上限到達">
</picture>

- 5時間と週間の使用量とリセット時刻、モデル別の上限、プラン（Pro、Max 5×、Max 20×、Team、Enterprise、ChatGPT Plus、Google AI Pro）を表示し、すべてのバーにペースの目印を付けます。
- **上限の履歴**: 使い切った期間、上限到達、作業している時間帯、そしてアカウント間で負荷がどれだけ均等に分かれているか。
- **トークンと金額**: Claude Code のトークンを日別・モデル別・アカウント別に集計し、API の定価で金額を算出します。

### 5時間の期間の計画

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="docs/images/planning-dark.webp">
  <img src="docs/images/planning-light.webp" width="900" alt="計画: 今日の作業時間、使用量の予測、計画に含めた各アカウントの5時間の期間、先行開始の時刻、計画の状態">
</picture>

- Relay は学習したあなたのペースと各プランの大きさ（Max 20× は Pro の20倍として数えます）から1日をシミュレーションし、空きが最も少なく切り替えも最も少なくなるよう、1日に分散した開始時刻を選びます。
- **先行開始**（任意、macOS と Linux）は、各アカウントの期間を作業前に開始して必要なときにリセットされるようにし、作業時間中も期間が続くようにします。
- 計画は、いつもより速く、または遅く作業したときに日中に調整され、アカウントの週の上限がいつ尽きるかも把握しています。

### すべてのコーディングツールに1つのゲートウェイ

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="docs/images/proxy-dark.webp">
  <img src="docs/images/proxy-light.webp" width="900" alt="プロキシとゲートウェイ: ゲートウェイのアドレスとキー、各アカウントの余裕を示すアカウントプール、最近のリクエスト">
</picture>

- Claude Code、Codex CLI、omp のための、キーで保護されたローカルのエンドポイントです。リクエストは、週の期間が最も早く終わり、かつまだ余裕のあるアカウントに送られます。余裕は実際の容量で比較されます（85 % 使用した Max 20× でも、使い始めたばかりの Pro より余裕があります）。
- セッションはそれぞれのアカウントとそのプロンプトキャッシュに留まります。混み合ったアカウントからの移行は、プロンプトの途中ではなく開始時に行われます。
- 待ち受けるのはこの Mac 上だけ、または選択した場合は Tailscale ネットワーク上です。
- オンにするまではオフです。Relay の中で通常の使い方から最も離れた部分です。[規約とリスク](#規約とリスク)をご覧ください。

### メニューバーとウィジェットと CLI

<img src="docs/images/panel-dark.webp" width="300" align="right" alt="Relay のメニューバーパネル: 使用中のアカウントとその上限、上限に近いアカウントと切り替えの提案、自動化の状態">

- **メニューバーのパネル**: 使用中のアカウント、その上限、おすすめの次のアカウント、ワンクリックでの切り替え。メニューバーのタイトルに表示する内容を選べます（5時間の使用量、残り時間、今日のトークン、または API換算額）。
- **デスクトップウィジェット**（macOS）: 自分のアカウント、すべてのアカウント、今日、過去7日間。
- **`relay` CLI**: `relay status`、`relay switch work`、`relay usage`、`relay run work`（そのアカウントで Claude Code を実行）、`relay tokens`、`relay proxy start`。スクリプト向けに `--json` があります。
- すべてキーボードで操作できます。⌘1〜⌘8 でページ移動、⌘K でアカウント検索、矢印キーでリスト内を移動します。

<br clear="right">

### 15の言語

<img src="docs/images/languages.webp" width="900" alt="ドイツ語、日本語、簡体字中国語、ロシア語で表示した概要画面">

English、Türkçe、Deutsch、Français、Español、Português (Brasil)、Italiano、日本語、한국어、简体中文、繁體中文、Русский、Українська、Polski、Nederlands に対応し、アプリ、メニューバー、ウィジェット、CLI で使えます。Relay は、**設定 → 一般** で言語を選ぶまでシステムの言語に従います。

## プラットフォーム

| | macOS | Windows | Linux |
| --- | :---: | :---: | :---: |
| Claude アプリのアカウント切り替え | ✅ | ✅ | ✅ |
| 共有の Claude Code の履歴 | ✅ | ✅ | ✅ |
| 上限、履歴、トークンと金額 | ✅ | ✅ | ✅ |
| Claude Code / Codex CLI / omp 向けのゲートウェイ | ✅ | ✅ | ✅ |
| 計画 | ✅ | ✅ | ✅ |
| 5時間の期間の先行開始 | ✅ | — | ✅ |
| Claude アプリ終了時の自動切り替え | ✅ | — | ✅ |
| 上限到達時の切り替えと続行（実験的） | ✅ | — | — |
| メニューバーのパネル、ウィジェット、`relay` CLI | ✅ | — | — |

macOS がメインのプラットフォームです。Windows 版はまだ実機でテストされていません。報告を歓迎します。

## プライバシーとセキュリティ

- **ローカルのみ。** Relay にはアカウントもサーバーもなく、**テレメトリーや分析も一切ありません**。データは `~/Library/Application Support/Relay`（macOS）または `~/.config/Relay`（Linux）に保存されます。
- **通信先:** アカウントがすでに使っているサービス — `claude.ai`、`api.anthropic.com`（使用量とプロフィール）、`chatgpt.com` / `api.openai.com`（Codex）、`cloudcode-pa.googleapis.com`（Antigravity）— と、Relay 自身の更新のための `api.github.com` です。
- **認証情報** が UI に渡ることはありません。保存された Claude アプリのサインインは、macOS の Keychain（Linux では Secret Service または KWallet）に保管された鍵で暗号化されます。ゲートウェイのキーを含むファイルは、本人だけが読める権限で書き込まれます。
- **Claude アプリのファイル** は、アプリが閉じている間に、暗号化バックアップと書き込みジャーナルを取った後でのみ変更されます。
- **堅牢化されたアプリ:** レンダラーウィンドウはサンドボックス化され、リリース版には開発者ツールがなく、アプリを呼び出せるのは Relay 自身のページだけで、厳格なコンテンツセキュリティポリシーが適用されています。

問題を見つけた場合は、非公開で報告してください。詳しくは [SECURITY.md](SECURITY.md) をご覧ください。

## 規約とリスク

Relay は非公式のツールであり、その動作の一部は、Anthropic がサードパーティ製ツールに Claude のサインインを使わせたいと考えている方法とは異なります。Relay に頼る前に、以下をお読みください。

- **Anthropic の規約の内容。** [Claude Code の法務とコンプライアンスのページ](https://code.claude.com/docs/en/legal-and-compliance#authentication-and-credential-use)には、サブスクリプションのサインイン（Free、Pro、Max、Ultra）は Claude Code と Anthropic 自身のアプリを通常どおり使うためのものであること、サードパーティ製ツールはそれらのサインインを保存、ルーティング、仲介すべきではないこと、そして公表されている上限は通常の個人での使用を前提としていることが記載されています。Anthropic は、これを予告なく適用する場合があるとしています。
- **Relay が行うこと。** Relay は、Claude アプリを切り替えたり上限を読み取ったりするために、アカウントのサインインをお使いのコンピューター上に暗号化して保管します。ゲートウェイはさらに踏み込み、それらのサインインを使って Claude Code のリクエストをあなたのアカウントに送ります。また omp を接続している場合、omp のリクエストは Claude Code のリクエストと同じ形で Claude に届きます。
- **起こりうること。** Anthropic は、こうしたリクエストをブロックしたり、それを使うアカウントを制限または停止したりすることがあります。Relay はそれを防げません。ご利用は自己責任となります（[ライセンス](LICENSE)をご覧ください）。
- **リスクの所在。** Claude アプリの切り替えと上限の読み取りは、通常の使い方に最も近い部分です。ゲートウェイはそこから離れており、Claude アカウント経由で omp を使うことが最も離れています。ゲートウェイはオンにするまでオフのままです。このリスクを負いたくない場合は、オフのままにしてください。
- **仕事用アカウント。** Team または Enterprise のシートには、あなたの会社と Anthropic との契約も適用されます。追加する前に管理者に確認し、自分のアカウントだけを使ってください。

Codex と Antigravity のアカウントにも、同様に OpenAI と Google の規約が適用されます。

## よくある質問

<details>
<summary><b>Relay は上限を合算したり増やしたりしますか？</b></summary>

いいえ。各アカウントはそれぞれの上限を保ちます。Relay は、Claude アプリ（またはゲートウェイを通るリクエスト）が使うアカウントを切り替え、各アカウントの時間をうまく使えるよう手助けするだけです。使用を許可されているアカウントだけを使い、まず[規約とリスク](#規約とリスク)をお読みください。
</details>

<details>
<summary><b>Relay は Anthropic が作ったものですか？</b></summary>

いいえ。Relay は独立した非公式のツールです。Anthropic、OpenAI、Google と提携しておらず、これらの企業による承認や後援も受けていません。Claude は Anthropic の商標です。
</details>

<details>
<summary><b>切り替えると実行中の応答は中断されますか？</b></summary>

切り替えは Claude アプリを再起動するため、実行中の応答やサブエージェントは停止します。Relay は事前に確認し、自動切り替えは何も実行されていないときにだけ動作します。会話自体は保持され、切り替え後も続けられます。
</details>

<details>
<summary><b>macOS が Relay を検証できないと表示するのはなぜですか？</b></summary>

Relay はまだ Apple の公証を受けていません。バージョンごとに一度、[インストール](#インストール)の3つの手順に従ってください。更新は Relay 自身の証明書で検証されるため、改ざんされた更新は拒否されます。
</details>

<details>
<summary><b>Claude アプリの更新で Relay が動かなくなることはありますか？</b></summary>

あり得ます。Relay は Claude アプリのローカルファイルを読み取り、自動続行のためにそのアクセシビリティツリーも読み取ります。Relay は何かを変更する前に読み取った内容を確認してバックアップを取り、中断された切り替えはアプリから復元できます。
</details>

<details>
<summary><b>アンインストールするには？</b></summary>

メニューバーから Relay を終了し、`Relay.app` をゴミ箱に移動します。保存したサインインも消したい場合は、`~/Library/Application Support/Relay` も削除してください。Claude アプリは、最後に切り替えたアカウントのままになります。
</details>

## ソースからビルド

必要なもの: Node.js 22.12+、macOS では Xcode Command Line Tools。

```sh
npm ci
npm run dev        # Electron + Vite
npm run dev:ui     # browser preview with sample accounts (?demo=50 for fifty)
npm test           # 3,000+ tests
npm run dist:mac:local   # signed local build (see docs/macos-local-signing.md)
```

切り替え、履歴の統合、使用量の読み取りの仕組みや、署名、Linux 固有の事項は [docs/development.md](docs/development.md)（英語）にまとめています。バグ報告、翻訳、プルリクエストなど、貢献を歓迎します。文言は [docs/ux/glossary.md](docs/ux/glossary.md) に従い、UI の文字列はすべて [`shared/i18n/catalogs`](shared/i18n/catalogs) にあります。

## スター履歴

<a href="https://star-history.com/#ahmetcankacar54/relay&Date">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="https://api.star-history.com/svg?repos=ahmetcankacar54/relay&type=Date&theme=dark">
    <img src="https://api.star-history.com/svg?repos=ahmetcankacar54/relay&type=Date" width="600" alt="スター履歴のグラフ">
  </picture>
</a>

## ライセンス

[MIT](LICENSE) © Ahmet Can Kaçar。Relay は独立したプロジェクトであり、Anthropic、OpenAI、Google とは提携していません。
