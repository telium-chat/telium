// 日本語.
//
// The non-Latin catalogue, and a complete one: every English key has a
// Japanese sentence here, so nothing falls back to English. The body was
// written by hand; the block near the end headed "added to reach 100%" is a
// machine-assisted draft no human has read, which is why this language carries
// no stamps in `catalog/stamps.json`. Its job in this build is still to be a
// *script* the layout was never designed around, and completeness does not
// change what it is testing.
//
// ------------------------------------------------- what this file is testing
//
// Four things break on Japanese and on nothing else in a Latin-only app, and
// all four arrive together the moment a single one of these strings is drawn:
//
//   1. **Glyphs are wider and taller.** A CJK glyph is square, and at the same
//      font-size it is close to twice the width of a Latin letter and needs
//      more leading. A `height` where a `min-height` belonged clips the
//      descender-free but tall kanji; a line-height tuned on Latin crowds.
//   2. **There are no spaces.** Japanese does not break lines on spaces, it
//      breaks between characters, and a container relying on a space to wrap
//      gets one very long unbreakable word instead. Anything with
//      `white-space: nowrap` and anything sized to "about twenty characters"
//      is wrong here.
//   3. **The font is a different font.** The browser falls back to a system
//      CJK face, whose metrics -- cap height, baseline, weight at the same
//      numeric weight -- are not the interface font's. A row that aligns two
//      pieces of text by eyeballing a magic pixel offset comes apart.
//   4. **There is one plural category.** `Intl.PluralRules('ja')` returns
//      `other` for every number including zero and one, so a `plural` with
//      only `one` and `other` arms silently loses its `one` arm. That is
//      correct -- Japanese does not inflect for number -- and it is why a
//      pattern must never be written as `{count} {count, plural, one {item}
//      other {items}}`: in Japanese the counter belongs *after* the noun with
//      a counter word between, and only a whole-sentence pattern can move it.
//
// ------------------------------------------------------------- conventions
//
//   * **です/ます**, politely but not honorifically. Telium is a tool speaking
//     to its user, not a shop speaking to a customer.
//   * **Full-width punctuation** (。、「」) throughout, and no space before it.
//     A translator copying English spacing produces text that reads as broken
//     to a Japanese eye in the same way `Hello ,world` does to an English one.
//   * **Loanwords in katakana** where the English term is the term of art
//     (サーバー, アカウント), translated where a Japanese word exists and is
//     the one people use.

export const messages = {
  'format.justNow': 'たった今',
  'format.bytes.b': '{value} B',
  'format.bytes.kb': '{value} KB',
  'format.bytes.mb': '{value} MB',
  'format.bytes.gb': '{value} GB',
  'format.bytes.tb': '{value} TB',

  'common.cancel': 'キャンセル',
  'common.close': '閉じる',
  'common.back': '戻る',
  'common.next': '次へ',
  'common.done': '完了',
  'common.save': '保存',
  'common.saving': '保存しています…',
  'common.saved': '保存しました',
  'common.confirm': '確認',
  'common.continue': '続ける',
  'common.copy': 'コピー',
  'common.copied': 'コピーしました',
  // The verb goes last and the object is marked with を. Nothing about this
  // sentence can be produced by gluing a noun to a translated "copied".
  'common.copiedThing': '{what}をコピーしました。',
  'common.clipboardFailed': 'クリップボードを利用できませんでした。',
  'common.delete': '削除',
  'common.remove': '取り除く',
  'common.retry': 'もう一度試す',
  'common.refresh': '更新',
  'common.edit': '編集',
  'common.download': 'ダウンロード',
  'common.dismiss': '閉じる',
  'common.learnMore': '詳しく見る',
  'common.showMore': 'もっと見る',
  'common.showLess': '表示を減らす',
  'common.search': '検索',
  'common.loading': '読み込んでいます…',
  'common.enable': '有効にする',
  'common.disable': '無効にする',
  'common.on': 'オン',
  'common.off': 'オフ',
  'common.yes': 'はい',
  'common.no': 'いいえ',
  'common.none': 'なし',
  'common.never': '一度もありません',
  'common.unknown': '不明',
  'common.optional': '任意',
  'common.required': '必須',
  // The full-width dash, not the Latin one: at this font size the Latin em
  // dash sits at a different height from the surrounding kanji.
  'common.empty': '—',

  'common.a11y.close': '閉じる',
  'common.a11y.back': '前に戻る',
  'common.a11y.menu': 'その他の操作',
  'common.a11y.dismissNotice': 'この通知を閉じる',
  'common.a11y.copyToClipboard': 'クリップボードにコピー',
  'common.a11y.showPassword': 'パスワードを表示',
  'common.a11y.hidePassword': 'パスワードを隠す',
  'common.a11y.loading': '読み込み中',
  'common.a11y.stepDone': '{step} — 完了',

  'common.homeserver': 'ホームサーバー',
  'common.username': 'ユーザー名',
  'common.password': 'パスワード',
  'common.email': 'メールアドレス',
  'common.account': 'アカウント',
  'common.device': '端末',
  'common.settings': '設定',

  // One arm, because `Intl.PluralRules('ja')` has one category. The counter
  // word 人 goes between the number and nothing at all -- there is no noun
  // after it to pluralise -- which is the shape the English pattern could not
  // have produced by itself.
  'common.convo.group': '{count, plural, other {グループ - #人}}',

  // Japanese puts the verb after its object, so the "verb" here is the
  // particle-plus-verb tail and `common.activity.line` puts the name first.
  // This is the case the two-part rendering in `lib/util.js` cannot express,
  // and the reason that surface is documented as approximate.
  'common.activity.playing': 'プレイ中',
  'common.activity.streaming': '配信中',
  'common.activity.listening': '再生中',
  'common.activity.watching': '視聴中',
  'common.activity.competing': '参加中',
  'common.activity.line': '{name}を{verb}',

  'errors.invalid_credentials': 'そのユーザー名とパスワードに一致するアカウントはここにありません。',
  'errors.account_deactivated': 'このアカウントは停止されています。サインインすると再び有効になります。',
  'errors.mfa_required': '認証アプリのコードを入力してください。',
  'errors.invalid_mfa_code': 'そのコードは一致しません。コードは約1分ごとに変わります — 次のコードをお試しください。',
  'errors.reauth_required': '念のため、もう一度パスワードを入力してください。',
  'errors.registration_closed': 'このホームサーバーは現在、新しいアカウントを受け付けていません。',
  'errors.username_taken': 'そのユーザー名はこのホームサーバーで既に使われています。',
  'errors.invite_invalid': 'この招待はもう使えません。期限切れ、使い切り、または取り消しの可能性があります。',
  'errors.missing_permission': 'それには「{permission}」の権限が必要です。',
  'errors.not_a_member': 'あなたはここのメンバーではありません。',
  // 英語と同じく `{attempted}` は選択であって差し込みではない。日本語では
  // 動詞が文末に来るため、共通の枠に動詞だけを差し込む書き方では文が成立
  // しない。`other` は、このクライアントより新しいサーバーが五つめの退出
  // 手段を見つけたときの受け皿。
  //
  // `{user_id}` が出るのは `revoke` の場合だけ。ほかの三つは読み手自身の
  // アカウントの話で、そこで名前を呼ぶのは面と向かって妙な物言いになる。
  'errors.last_admin':
    '{attempted, select, ' +
    'deactivate {あなたはこのサーバーにサインインできる唯一の管理者です。アカウントを無効化すると、サーバーを運用できる人がいなくなります。} ' +
    'delete {あなたはこのサーバーにサインインできる唯一の管理者です。アカウントを削除すると、サーバーを運用できる人がいなくなります。} ' +
    'move {あなたはこのサーバーにサインインできる唯一の管理者です。アカウントを別のホームサーバーに移すと、サーバーを運用できる人がいなくなります。} ' +
    'revoke {{user_id} はこのサーバーにサインインできる唯一の管理者です。アクセス権を取り消すと、サーバーを運用できる人がいなくなります。} ' +
    'other {それを行うと、このサーバーにサインインできる管理者がいなくなります。}} ' +
    'サインインできる別のアカウントにサーバー管理者権限を与えてから、もう一度お試しください。',
  'errors.rate_limited': '{retry_after, plural, =0 {少し待ってからもう一度お試しください。} other {少し待ってください — #秒後にもう一度お試しください。}}',
  // 上限を文に含める。「大きすぎます」だけでは次に何をすればよいか分からない。
  'errors.too_large': 'このファイルは大きすぎます。ここでの上限は {limit, bytes} です。',
  'errors.quota_exceeded': '空き容量がありません — {limit, bytes}のうち{used, bytes}を使用中です。',
  // No space around the colon, and the full-width one: the English spacing
  // looks like a typesetting error in Japanese.
  'errors.context': '{context}：{message}',
  'errors.generic': '問題が発生しました。',
  // 「あなたの操作が原因ではありません」では足りない。500 はサーバーが実際に
  // 処理を始めてから失敗した状態で、どこまで進んだかは誰にも分からない。最も
  // よく 500 になるのは書き込み操作なので、そこを曖昧なままにしておくほうが
  // 誠実になる。
  'errors.serverFault': 'サーバー側で問題が起きました。処理された可能性もあります。',
  // `navigator.onLine` で二つに分ける。前者はサーバーのせいだと断定しない
  // ——キャプティブポータルも同じに見えるため。後者は端末を名指しする。
  // 読んだ人が自分で直せるのはそちらだけだから。
  'errors.offline': 'サーバーに接続できませんでした。何も送信されていません。少ししてからもう一度お試しください。',
  'errors.offlineDevice': 'この端末はオフラインです。何も送信されていません。',

  // ------------------------------------------------ 本文のないステータス

  'errors.status.401': 'セッションの有効期限が切れました。もう一度サインインしてください。',
  'errors.status.403': 'ここでその操作を行う権限がありません。',
  'errors.status.404': 'それはもうありません。',
  'errors.status.409': '先に別の誰かが変更しました。もう一度確認してからお試しください。',
  'errors.status.413': 'このサーバーが受け取るには大きすぎます。',
  'errors.status.429': 'このサーバーには操作が速すぎます。少し待ってからお試しください。',
  'errors.status.gateway': 'サーバーが応答していません。少ししてからもう一度お試しください。',

  // ---------------------------------------------------- ゲートウェイの切断

  'errors.gateway.4001': 'Telium はこのサーバーとセッションを開始できませんでした。',
  'errors.gateway.4002': 'Telium とこのサーバーの通信方法が一致していません。',
  'errors.gateway.4004': 'このサーバーはセッションを受け付けませんでした。もう一度サインインしてください。',
  'errors.gateway.4005': 'このサーバーは再起動中です。再接続しています。',
  'errors.gateway.4008': 'このサーバーへのサインインに時間がかかりすぎました。再接続しています。',
  'errors.gateway.4009': 'この接続はタイムアウトしました。再接続しています。',
  'errors.gateway.4010': 'この接続は遅れが大きくなったため再設定されました。追いついています。',
  'errors.gateway.4011': 'このアカウントで開いている Telium の接続が多すぎます。一つ閉じてからお試しください。',
  'errors.gateway.4013': 'このサーバーは接続の受け付けが混み合っています。待機しています。',
  'errors.gateway.4015': 'Telium とこのサーバーのバージョンに互換性がありません。',
  'errors.gateway.unknown': '接続が予期せず切断されました（コード {code}）。',

  'perms.group.general': '一般',
  'perms.group.membership': 'メンバー',
  'perms.group.text': 'テキストチャンネル',
  'perms.group.voice': 'ボイスチャンネル',
  'perms.group.advanced': '詳細',

  'settings.theme.title': 'テーマ',
  'settings.theme.description': 'ほかの端末にも引き継がれます。',
  'settings.theme.preset.graphite.name': 'グラファイト',
  'settings.theme.preset.graphite.description': '深みのあるニュートラルグレー。初期設定です。',
  'settings.theme.preset.obsidian.name': '黒曜石',
  'settings.theme.preset.obsidian.description': '画素まで真っ黒で、有機EL画面ならその画素は光りません。',
  'settings.theme.preset.ash.name': '灰',
  'settings.theme.preset.ash.description': '明かりのある部屋向けの、暖かく明るいグレー。',
  'settings.theme.preset.midnight.name': '真夜中',
  'settings.theme.preset.midnight.description': 'グレーに紫を含んだ、かつての Telium の色。',
  'settings.theme.preset.evergreen.name': '常緑',
  'settings.theme.preset.evergreen.description': '長い夜を室内で過ごすような、暗い緑。',
  'settings.theme.preset.paper.name': '紙',
  'settings.theme.preset.paper.description': '明るい部屋のための、紙のような白。',
  'settings.theme.custom.label': '自分で作る',
  'settings.theme.custom.description': 'いくつかのスライダーを動かすと、アプリがその場で変わります。',

  'settings.language.title': '言語',
  'settings.language.label': '表示言語',
  'settings.language.auto': 'システムの言語を使う',
  'settings.language.hint': '{state, select, none {今のところ英語のみです。Telium は翻訳できるように作られています — 手伝っていただける場合は翻訳者向けガイドをご覧ください。} partial {{languages}は一部のみ翻訳されています。未翻訳の部分は英語で表示されます。} other {Telium は{languages}でご利用いただけます。}}',

  'settings.messages.title': 'メッセージ',
  'settings.messages.compact.label': 'コンパクト表示',
  'settings.messages.compact.hint': 'メッセージの間隔を詰めて、画面に多く表示します。',
  'settings.messages.members.label': 'メンバーリストを表示',
  'settings.messages.members.hint': 'メンバーリストは範囲購読なので、隠すと更新も止まります。',
  'settings.messages.typing.label': '入力中であることを知らせる',
  'settings.messages.typing.hint': 'オフにすると、入力を始めたことがギルドサーバーに伝わることはありません。',

  // ---------------------------------------------------------- profile lookups
  //
  // The three answers to "when may this account ask a dozen servers what you
  // have in common with somebody". Labels name what the reader does, not what
  // the client does, and none of them calls an option safe -- the middle one
  // makes the same disclosure as the loose one whenever it fires. See
  // `catalog/en/settings.js`.
  'settings.lookups.title': '共通点を調べるタイミング',
  'settings.lookups.hover.label': '名前にポインターを重ねたとき',
  'settings.lookups.hover.description': 'カードが開いた瞬間に共通の友だちが表示されます。メンバーリストをポインターでなぞると、止まった名前のぶんだけ問い合わせが出ます。開くつもりのなかった名前も含めてです。',
  'settings.lookups.open.label': 'プロフィールを開いたとき',
  'settings.lookups.open.description': '名前を眺めているあいだは何も問い合わせません。プロフィールを開いたときにその人についてだけ問い合わせ、答えはカードの少しあとに埋まります。',
  'settings.lookups.never.label': '調べない',
  'settings.lookups.never.description': 'どのサーバーにも問い合わせません。プロフィールに共通の友だちや共通のスペースが出なくなります。何年も知っている相手でも同じです。',
  // 「共通の友だちはいません」とは書けない。調べていないだけで、いないと
  // 言い切るのは相手についての嘘になる。
  'settings.lookups.off.friendsTitle': '問い合わせていません',
  'settings.lookups.off.guildsTitle': '問い合わせていません',
  'settings.lookups.off.body': 'プロフィールの問い合わせが「調べない」に設定されているため、ここは確認していません。共通点がないという意味ではありません。',

  // ---------------------------------------------------------------- privacy
  //
  // Who else is on the wire. Translated in full ahead of the rest of the
  // migration for the reason the German file gives at the same heading: an
  // untranslated settings label is a gap, an untranslated privacy warning is a
  // line that gets skipped, and being skipped is the failure this namespace
  // exists to prevent. Sources are in `catalog/en/privacy.js`, each key above
  // the sentence of `docs/privacy.md` it carries.
  //
  // 「Invisible」 is left in English because the status row above it is still
  // English -- `PRESENCE` in `components/Presence.jsx` is not on the catalogue
  // yet, and naming a word the reader cannot find on their screen would be
  // worse than naming one they can.
  'privacy.presence.invisible': '「Invisible」は、ほかの人たちに見える姿にすぎません。ホームサーバーはこの接続を変わらず把握していて、サインイン中の端末の数も数えています。',
  'privacy.block.body': '相手には友だち関係が終わったことが見え、それ以降あなたに届くものはありません — 申請もメッセージも通知も。どれが止められたのかが相手に伝わることもありません。ただし、送信そのものは止まりません。相手のメッセージはあなたのホームサーバーが受け取って保存し続け、相手の画面では会話はごく普通に見えます。',
  'privacy.gif.head': 'この会話は暗号化されています。GIF はされていません。',
  'privacy.gif.body': 'この検索結果はあなたの端末が {host} に問い合わせ、送信するものも直接そこから取得します。つまり {host} には、あなたのアドレスと、選んだ GIF が見えます。どれもホームサーバーを経由せず、これを止める設定もありません。',
  'privacy.typing.inEncrypted': '入力中の表示だけは例外です。暗号化されずに送られるため、あなたのサーバー、ほかの人たちのサーバー、会話にいる全員が、その場で見ることになります。会話シグナルから止められます。',
  // The fan-out behind the mutual-friends chips, drawn under all three options
  // on the Profile lookups pane. 「それぞれに一通ずつ」 is load-bearing: one
  // peer per *domain*, all of them, including the ones with nothing to say.
  // What travels is the question, never the friend list.
  'privacy.lookups.head': '誰かとの共通点を調べることは、このアカウントが声に出して尋ねる行為です。',
  'privacy.lookups.party.home': 'あなたのホームサーバー',
  'privacy.lookups.sees.home': 'あなたが誰を見たか。友だちリストはもともと持っているので、増えるのは時刻だけです。',
  'privacy.lookups.party.friendHosts': 'あなたの友だちがいるすべてのサーバー',
  'privacy.lookups.sees.friendHosts': 'あなたと相手の名前が入った署名付きの問い合わせが、それぞれに一通ずつ。答えるものが何もないサーバーにも送られるので、そのすべてが、あなたがその時刻に見ていたことを知ります。',
  'privacy.lookups.party.guildHosts': '同じスペースにいるすべてのサーバー',
  'privacy.lookups.sees.guildHosts': 'その人がメンバーかどうかを尋ねる、この端末からの要求。尋ねた事実に加えて、あなたのアドレスも見えます。',
  'privacy.lookups.note': '問い合わせが起きるたびに、これだけの相手が知ることになります。上の設定で変わるのは頻度と、意図して開く以外のことで始まるかどうかであって、問い合わせ自体が静かになるわけではありません。',

  'privacy.push.head': 'プッシュの配信元はブラウザー提供元のサービスで、ここで唯一あなたのものではない部分です。',
  'privacy.push.provider': 'このブラウザーを指す固定のアドレスと、通知ごとの時刻とサイズが渡ります。中身はこのブラウザー宛てに暗号化されているので読めませんが、一つひとつに付く署名にはあなたのホームサーバーの名前が入ります。そのため、あなたのホームサーバーがあなたに知らせることがあった時刻の記録が、少しずつ積み上がっていきます。',

  // -------------------------------------------------------------- updates
  //
  // 「インストール」と言えるのは Electron 版だけで、ほかの環境では自分自身を
  // 置き換えられない。押しても何も起きない言葉を避けるため、動詞は配布経路
  // ごとに分けてある（`catalog/en/updates.js` を参照）。

  'updates.available': 'Telium {version} が利用できます。',
  'updates.security': '見逃したリリースのいずれかにセキュリティ上の修正が含まれています。',
  'updates.incompatible': 'この Telium は古すぎて接続できません。更新すれば解決します。',

  'updates.action.install': 'インストールして再起動',
  'updates.action.reload': '再読み込み',
  'updates.action.store': 'ストアを開く',
  'updates.action.page': '変更点',
  // 「閉じる」ではなく「あとで」。通知はまた出てくるので、消えたと約束する
  // 言葉はコードがしないことを約束することになる。
  'updates.action.later': 'あとで',
  'updates.action.restart': '再起動',

  'updates.blocked.package': 'このビルドはシステムによってインストールされています。インストールしたのと同じ方法で更新してください。',
  'updates.blocked.artifact': 'このリリースには、このプラットフォーム向けのダウンロードがありません。',

  'updates.state.downloading': 'Telium {version} をダウンロードしています…',
  'updates.state.verifying': '署名を確認しています…',
  'updates.state.ready': 'Telium {version} の準備ができました。再起動すると使えます。',
  'updates.state.failed': 'この更新はインストールできませんでした。代わりに手動でダウンロードしてください。',

  'updates.footer.unkeyed': 'このビルドには更新の配布元が設定されていないため、更新を確認しません。',
  'updates.footer.current': '最新です。',
  'updates.footer.unreachable': '更新の配布元に接続できませんでした。',
  'updates.footer.forged': '更新情報に有効な署名がなかったため、拒否しました。',
  'updates.footer.checking': '更新を確認しています…',

// ================================================================ guild (ja)
  //
  // ------------------------------------------------------------ the glossary
  //
  // The ten words this namespace turns on, decided once here so the next
  // translator does not have to re-decide them halfway down: **guild** is
  // ギルド (already the word `settings.messages.typing.hint` uses in this
  // file, so it is settled rather than chosen), **channel** is チャンネル and
  // **member** is メンバー (both settled the same way, by `perms.group.text`
  // and `settings.messages.members.label`), **role** is ロール rather than
  // 役職 because 役職 means a job title in a company and this thing is a
  // permission bundle, **gate** is ゲート because the server's own
  // documentation calls it that and a moderator cross-reading the two needs
  // one token, **invite** is 招待 and **audit log** is 監査ログ because both
  // are ordinary Japanese words that mean exactly the right thing, **queue**
  // is キュー, **purge** is 一括削除 (a native compound; パージ exists but
  // reads as a machine word rather than as an act somebody performs), and
  // **ban** is the Latin `BAN` for the reasons set out over the bans section
  // below. **Webhook** does not appear in this namespace, but the pane that
  // will eventually carry it should say ウェブフック, for consistency with
  // every other katakana term of art here.
  //
  // Three rules that apply to all 243 entries and are therefore not repeated
  // on each one:
  //
  //   1. **One plural arm.** `Intl.PluralRules('ja')` returns `other` for
  //      every number, so every `plural` below has exactly `other` (plus an
  //      `=0` where English had one, which is an exact match and not a
  //      category). Where English's `one` arm carried meaning beyond number,
  //      the comment on that entry says what became of it. There are only two
  //      plurals in this namespace and both are commented at length.
  //   2. **Counters.** 人 counts people, 件 counts messages and list rows, 回
  //      counts repetitions, 日/時間/週間 count spans. Japanese has no bare
  //      count of a noun -- the number goes *after* the noun with a counter
  //      word welded to it -- which is why none of these sentences could have
  //      been produced by interpolating a number into an English shape.
  //   3. **Full-width punctuation** (。、（）：「」), no space before it, and a
  //      single ASCII space on each side of a run of Latin letters or of a
  //      placeholder that will hold one. That spacing is the convention
  //      `errors.too_large` already established at the top of this file.

  // ------------------------------------------------------------------ the shell
  //
  // The rail. Japanese is the best case for this column and the worst: a CJK
  // glyph is about twice the width of a Latin letter, so 概要 is no narrower
  // than "Overview", but Japanese also breaks between characters rather than
  // at spaces, so nothing here can produce the one-very-long-word failure the
  // header of this file warns about. Every label below is four glyphs or
  // fewer except the two that genuinely name two things.

  'guild.nav.overview': '概要',
  // ロール, not 役職. 役職 is a rank in an organisation -- 課長, 部長 -- and a
  // reader who meets it here will look for a hierarchy of people rather than a
  // bundle of permissions. ロール is the word the Japanese-speaking half of
  // this kind of software has used for fifteen years, and `roles.js` and
  // `perms.js` must use it too when they are translated.
  'guild.nav.roles': 'ロール',
  // 「チャンネルの権限」 with the の would be more natural prose, but this is a
  // rail label and 体言止め compounds drop the particle: チャンネル権限 is how
  // a Japanese menu writes it, the way 監査ログ is not 監査のログ.
  'guild.nav.channels': 'チャンネル権限',
  // ボット is the ordinary Japanese word and is translated.
  'guild.nav.bots': 'ボット',
  // ゲート, katakana, and it must be this same ゲート in all of
  // `guild.gates.*`. 関門 and 審査 were both considered and both rejected for
  // the same reason: the server's own documentation says "gates", a moderator
  // reads that documentation in another window, and a native compound here
  // would silently break the mapping between the two. 配信元 for "origins",
  // on the other hand, IS native and deliberately so -- オリジン would import
  // precisely the browser-security sense the English comment says to avoid,
  // because オリジン in Japanese web writing means nothing else.
  'guild.nav.gates': 'ゲートと配信元',
  'guild.nav.queue': 'モデレーションキュー',
  // 一括削除, not パージ. The pane is named for what it does to the guild, and
  // a Japanese moderator asked to find "the spam cleanup pane" will look for
  // 削除. パージ reads as jargon borrowed from a database manual.
  'guild.nav.purge': 'スパムの一括削除',
  // BAN in Latin capitals, and this is the one deliberate anglicism in the
  // namespace. Three candidates: バン is unusable because it collides head-on
  // with バン (van) and with the onomatopoeic バン, and a one-word rail label
  // has no context to disambiguate it; 追放 is the right dictionary word but
  // carries the weight of banishment from a country and reads as melodrama
  // over a chat guild; アクセス禁止 is accurate and four glyphs too long for
  // this column. BAN is what Japanese-speaking moderators actually type and
  // say, it is unambiguous in Latin capitals next to katakana, and it inflects
  // into the compounds this pane needs -- BANする, BAN解除 -- which 追放 does
  // only awkwardly.
  'guild.nav.bans': 'BAN',
  'guild.nav.invites': '招待',
  // 絵文字 is native, ordinary, and the only word anybody uses; カスタム絵文字
  // in the pane heading below, bare 絵文字 here because the rail is tight.
  'guild.nav.expressions': '絵文字',
  // SFU stays Latin, as the English comment requires. ボイス rather than 音声
  // to match `perms.group.voice` (ボイスチャンネル) already in this file. The
  // slash keeps ASCII spaces around it because it separates two Latin runs.
  'guild.nav.voice': 'ボイス / SFU',
  'guild.nav.audit': '監査ログ',

  'guild.title.fallback': 'ギルド',
  // 体言止め: a label sitting directly above the value it names, so it is a
  // noun phrase with no particle, no です and no colon -- exactly as the
  // English takes no full stop. ホスト元 rather than ホスト because bare
  // ホスト would read as the hostname itself, which is the thing underneath.
  'guild.hostedBy': 'ホスト元',
  // 今は carries English's "right now": the connection is not up at this
  // moment, nothing is lost. Placed early, where Japanese puts a temporal
  // qualifier, rather than at the tail where English puts it.
  'guild.unreachable': 'そのギルドのサーバーには今は接続できません。',

  // ------------------------------------------------------------ shared durations
  //
  // Japanese counts spans with dedicated counters -- 時間 for hours, 日 for
  // days, 週間 for weeks -- and they are written with the numeral, so these
  // are the shortest entries in the file. The English comment's worry about
  // being handed a number and a noun and asked to make them agree does not
  // arise here at all: Japanese would not have agreed them anyway.

  'guild.duration.hour': '1時間',
  'guild.duration.sixHours': '6時間',
  'guild.duration.day': '1日',
  'guild.duration.threeDays': '3日',
  // 週間, not 週. 1週 is a point in a sequence (week one); 1週間 is a span of
  // seven days, which is what an expiry is.
  'guild.duration.week': '1週間',
  'guild.duration.thirtyDays': '30日',
  // 上限なし ("no ceiling"), deliberately a different word from `common.never`
  // in this file, which is 一度もありません ("has not happened once"). The
  // English comment asks for two distinct phrases and Japanese has two that
  // are further apart than English's.
  'guild.duration.unlimited': '上限なし',

  // ------------------------------------------------------------------- overview

  'guild.overview.name': '名前',
  'guild.overview.description': '説明',
  'guild.overview.chooseIcon': 'アイコンを選ぶ',
  // Matches `common.saving` (保存しています…) already in this file, including
  // the three-dot ellipsis character rather than three periods.
  'guild.overview.savingIcon': 'アイコンを保存しています…',
  // A complete sentence with 。, because the English is one and because it is
  // read on its own under the picker. Past tense ました: the upload landed,
  // which is the whole point of the line.
  'guild.overview.iconSet': 'カスタムアイコンを設定しました。',
  'guild.overview.iconNone': 'アイコンはありません。',
  // No 。 here and none on any of the other `*Failed` keys below: they are
  // toast titles rather than sentences, and English gives them no full stop
  // either. The pattern is consistent across all fifteen of them.
  'guild.overview.iconFailed': 'アイコンを保存できませんでした',

  // The plural dissolves completely. English needed two arms because "member"
  // and "members" are different words; Japanese needs one because メンバー is
  // メンバー at any count, and the number attaches to the counter 人 rather
  // than to the noun. 人 and not 名: 名 is the counter a registry or an
  // invitation list uses and is faintly formal, 人 is what a count of people
  // in a room is. Nothing of English's singular is lost, because English's
  // singular carried nothing here but agreement.
  'guild.overview.memberCount': '{count, plural, other {メンバー#人です。}}',
  'guild.overview.memberCountUnknown': 'メンバー数は不明です。',
  // The date moves to the head of the sentence. Japanese puts the time
  // adverbial before the verb and the verb last, so English's "Created {at}"
  // becomes "{at} に作成されました" -- the placeholder is now first and the
  // verb it belonged to is now last. This reversal is the reason a component
  // may never assemble this line out of a prefix and a value.
  'guild.overview.created': '{at, date, medium}に作成されました。',
  // かなり前 keeps English's deliberate vagueness. Not 不明な日時 ("at an
  // unknown time"), which the English comment specifically rules out: the
  // guild predates the field, and the honest statement is about how long it
  // has been here, not about a missing record.
  'guild.overview.createdUnknown': 'かなり前に作成されました。',

  // -------------------------------------------------------- attachment lifetime

  'guild.overview.expiry.title': 'ファイルの保存期限',
  // ここ becomes このギルド, spelled out. English can lean on "here" because
  // the pane is visibly the guild's; Japanese ここ in a settings pane reads as
  // "this screen" and a moderator would not know whether the cap follows the
  // guild or the dialog. The second sentence keeps English's correction in
  // full: this is a ceiling and a channel may go tighter.
  'guild.overview.expiry.hint': 'このギルドで添付ファイルを保持できる最長期間です。チャンネルごとに、さらに短くすることもできます。',
  // 体言止め, and this is the case the English comment anticipated. English's
  // label is the opening of a sentence the select finishes ("Files may be kept
  // for at most" / "30 days"); Japanese cannot do that, because the select
  // sits to the *right* of the label and Japanese would need the noun phrase
  // to come first and the verb after the value, which no label-plus-menu
  // layout can express. So it becomes the noun phrase the comment offers as
  // the fallback: "the longest period an attachment is kept for".
  'guild.overview.expiry.label': '添付ファイルを保持する最長期間',
  'guild.overview.fileSize.title': '添付ファイルのサイズ上限',
  'guild.overview.fileSize.hint': 'このギルドでメンバーが添付できる最大のファイルです。チャンネルごとに、さらに厳しくすることもできます。',
  'guild.overview.fileSize.label': '添付ファイルの最大サイズ（バイト）',
  'guild.overview.fileSize.placeholder': 'このギルドでは上限なし',

  // ------------------------------------------------------- moving and ownership

  // 体言止め section heading: この〜の移転, a noun, matching English's gerund
  // "Moving this guild" which is also functioning as a noun.
  'guild.overview.move.title': 'このギルドの移転',
  // The order is preserved and reinforced with まず / 次に, which Japanese
  // uses where English relies on "then". A reader who takes the two parties in
  // the wrong order goes looking for a button that is not there yet, and
  // Japanese sentence order alone would not have made the sequence as loud as
  // English's "then" did.
  'guild.overview.move.hint': 'まず移転先のサーバーで新しい所有者が承諾し、次にここで現在の所有者が移転を承認します。これまでのリンクはそのまま使えます。',
  'guild.overview.move.ownerOnly': 'ギルドを移転できるのは所有者だけです。',
  'guild.overview.move.button': '別のサーバーへ移転する',
  // ASCII spaces around {domain} because it holds a hostname in Latin letters,
  // which is the spacing `errors.too_large` already uses in this file. The
  // hostname itself is never touched: no full-width letters, no quotation
  // marks English did not have, no localised digits.
  'guild.overview.move.elsewhere': 'このギルドは {domain} がホストしているため、移転はそのサーバー上のアカウントから開始する必要があります。',

  // The English comment asks for a noun for the heading and an imperative for
  // the two buttons, and Japanese distinguishes them cleanly: 所有権の譲渡 is
  // a noun phrase, 所有権を譲渡する is a verb phrase. So the three keys that
  // are one string in English are two strings here.
  'guild.overview.transfer.title': '所有権の譲渡',
  'guild.overview.transfer.button': '所有権を譲渡する',
  // The commit button in the dialog. Same wording as the button that opened
  // it, as in English -- by the time a reader is here the question has already
  // been asked above and a different verb would read as a different act.
  'guild.overview.transfer.confirm': '所有権を譲渡する',
  // すでに〜である必要があります is the precondition, stated as a requirement
  // rather than as advice, because the server genuinely refuses otherwise.
  // その人だけが rather than 新しい所有者だけが in the second sentence: the
  // referent is two clauses back and Japanese resolves it with a pronoun far
  // more comfortably than it repeats the noun.
  'guild.overview.transfer.hint': '新しい所有者は、すでにこのギルドのメンバーである必要があります。譲渡後は、その人だけがギルドを譲渡または削除できます。',
  // Dialog title: {name} is a guild name the owner typed and may be in any
  // script, so it keeps its ASCII spaces. を譲渡 rather than を譲渡する --
  // a dialog title is 体言止め-adjacent and the bare stem reads as a heading
  // where the full verb would read as a button.
  'guild.overview.transfer.dialogTitle': '{name} を譲渡',
  // ID in Latin capitals, not アイディー and not 識別子. Japanese interfaces
  // write ID in Latin letters universally, and 識別子 is a term from a
  // specification rather than from a form field. No space between ID and the
  // kanji before it: the run is short enough that Japanese typesetting closes
  // it up.
  'guild.overview.transfer.label': '新しい所有者のアカウントID',
  'guild.overview.transfer.dialogHint': '現在のメンバーの完全なアカウントIDを入力してください。',
  // Left in English on purpose, and this one is not laziness. The English
  // comment invites a translator to make the local part a name their readers
  // would recognise -- but the local part of a federated id in this client is
  // ASCII by protocol, so a Japanese-language local part would be an example
  // the field itself rejects, which is worse than an opaque one. `example.org`
  // is reserved by RFC 2606 and stays. The `@` and `:` are syntax.
  'guild.overview.transfer.placeholder': '@member:example.org',
  'guild.overview.transfer.done': '所有権を譲渡しました。',
  'guild.overview.transfer.failed': '所有権を譲渡できませんでした',

  'guild.overview.delete.title': 'このギルドの削除',
  // The flattest sentence in the file, on purpose. すべて同時に消えます, with
  // 消えます and not 削除されます: 削除される is what a system does to a
  // record, 消える is what happens to the thing itself, and the reader is
  // about to lose the thing. The second sentence refuses to hedge -- どこにも
  // 残りません, "nowhere", not 残らない可能性があります. No reassurance is
  // added, no ご安心ください, and the politeness stops at ます: a destructive
  // warning that reaches for 〜いただけます or any honorific would be a shop
  // being gracious about an irreversible act, which is the register this
  // sentence must not be in.
  'guild.overview.delete.hint': 'チャンネル、メッセージ、ロール、メンバーがすべて同時に消えます。復元できる控えはどこにも残りません。',
  'guild.overview.delete.button': 'ギルドを削除する',
  'guild.overview.delete.confirm': 'ギルドを削除する',
  'guild.overview.delete.dialogTitle': '{name} を削除',
  // 確認のため goes first. English trails the purpose ("to confirm"); Japanese
  // puts a purpose adverbial at the head, so the placeholder-free sentence
  // reverses end for end. 名前 alone, because the dialog title directly above
  // is the guild's name and repeating ギルドの名前 in a field label under it
  // is noise.
  'guild.overview.delete.label': '確認のため名前を入力してください',
  // 取り消せません, flat present. Not 取り消せない場合があります.
  'guild.overview.delete.dialogHint': 'この操作は取り消せません。',
  'guild.overview.delete.failed': 'ギルドを削除できませんでした',

  // Matches `common.save` (保存) in register, negated and in the past.
  'guild.overview.saveFailed': '保存できませんでした',

  // ---------------------------------------------------------------------- gates

  // ゲート, as decided in the glossary. The second sentence is a rule and is
  // written as one: 〜できますが、〜できません, the Japanese shape for a
  // permitted/forbidden pair, which states both halves in one breath where
  // English needed a comma and an elision ("stricter than its host, never
  // looser"). Japanese cannot elide the verb like that, so both verbs appear.
  'guild.gates.hint': 'ゲートは誰かが参加するときに実行されます。このギルドはホストのサーバーより厳しくできますが、緩くすることはできません。',

  // The English parenthetical "(days)" is gone, and its disappearance is
  // deliberate rather than an omission: 日数 already means "number of days",
  // so 最低経過日数（日）would read the way "minimum age in days (days)" does
  // in English. The unit is inside the noun, which is a thing Japanese does
  // routinely and English cannot.
  'guild.gates.minAge.label': 'アカウント作成からの最低経過日数',
  // ホームサーバー is the spelling `common.homeserver` already uses.
  'guild.gates.minAge.hint': 'アカウントのホームサーバー上での作成日から数えます。',

  // The three policy labels. The wire values (`open`, `allowlist`,
  // `blocklist`) are untouched by any of this -- these are menu labels only.
  //
  // 制限なし for "Open" rather than オープン, and this follows the English
  // comment's own advice: prefer a phrase that states the default over a
  // transliteration. オープン in a Japanese select reads as a brand of policy
  // rather than as a description of one, whereas 制限なし says outright that
  // no rule is applied. 許可リスト and ブロックリスト are then left as the
  // established pair -- Japanese security writing has settled on 許可リスト
  // for allowlist (replacing ホワイトリスト) and ブロックリスト for blocklist,
  // and the comment's fallback ("only the listed domains") is for languages
  // that have no pair, which Japanese does.
  'guild.gates.policy.open': '制限なし',
  'guild.gates.policy.allowlist': '許可リスト',
  'guild.gates.policy.blocklist': 'ブロックリスト',

  'guild.gates.domainPolicy.label': 'ホームドメインのポリシー',
  'guild.gates.domainRules.label': 'ホームドメインのルール',
  // The quoted runs are syntax and stay in English letter for letter: `allow`
  // and `deny` are keywords the server matches, and the hostnames are reserved
  // examples. They keep ASCII double quotes rather than becoming 「」, because
  // 「」 marks a quotation of language and these are not language -- a reader
  // who sees 「allow example.org」 may reasonably think the brackets are part
  // of what to type, and straight quotes read as a code span.
  //
  // 「制限なし」 in the last sentence is a reference to
  // `guild.gates.policy.open` above and must move with it if that label ever
  // changes. Corner brackets here, unlike around the syntax, because this one
  // IS a quotation -- of a label the reader can see in the menu beside them --
  // and that is the convention `errors.missing_permission` already uses.
  'guild.gates.domainRules.hint': '1行に1つ、"allow example.org" または "deny spam.example" の形式で書きます。「制限なし」ポリシーではこれらは無視されます。',

  'guild.gates.screening.label': '参加審査の質問',
  // 申請者キュー names the same thing `guild.queue.applicants.title` names
  // (申請者), as the English comment requires. スクリーニング was rejected for
  // 参加審査: the katakana is a direct borrowing that Japanese readers mostly
  // meet in a medical context, whereas 参加審査 says what the questions are
  // for and is the phrase a Japanese community uses for exactly this.
  'guild.gates.screening.hint': '1行に1つ。空のままにすると審査なしで参加できます。質問がある場合、参加しようとした人は申請者キューに入ります。',

  // N stays a Latin capital in both strings, which is what a Japanese reader
  // expects of an algebraic variable -- Japanese mathematics and Japanese
  // documentation both use Latin letters for this, and there is no kana that
  // would read as "some number you typed". It takes the counter 件 after it,
  // because a bare N would leave the noun uncounted: 最初のN件 is "the first N
  // of them" and is the shape Japanese needs.
  'guild.gates.hold.label': '最初のN件のメッセージを保留',
  // 0 にすると rather than ゼロにすると: the field holds a numeral and the
  // sentence should name what is typed into it.
  'guild.gates.hold.hint': '新しいメンバーの最初のN件のメッセージは、すぐには表示されず承認を待ちます。0 にすると保留しません。',

  // 配信元, not オリジン -- see the note on `guild.nav.gates`. The second
  // sentence keeps English's correction about *when* the check runs, which is
  // the half a reader who knows the browser sense will get wrong.
  'guild.gates.origins.hint': 'このギルドがどの配信元からの添付ファイルを受け入れるかを決めます。確認はメッセージが投稿された時点で行われます。',
  'guild.gates.originPolicy.label': 'メディア配信元のポリシー',
  'guild.gates.originRules.label': 'メディア配信元のルール',
  // Every quoted run is syntax and survives untranslated: `allow`, `block`,
  // `feed:`, `key:` and the angle brackets around `<curator key>`, which mark
  // the one part the reader substitutes. The words inside the angle brackets
  // are left in English too -- they are inside a code fragment the reader is
  // copying the shape of, and a Japanese phrase there would read as text to
  // type rather than as a slot.
  //
  // The precedence rule is the last sentence in both languages, but Japanese
  // states it as 〜より優先されます with the winner first, where English put
  // the winner first as a subject. Same order, different machinery.
  'guild.gates.originRules.hint': '1行に1つ、"allow files.example" または "block sketchy.example" の形式で書きます。キュレーターフィードは "allow feed:https://… key:<curator key>" と書きます。ホスト名を直接指定したルールは、フィードより優先されます。',

  'guild.gates.save': 'ゲートを保存',
  'guild.gates.saved': 'ゲートを保存しました。',
  'guild.gates.saveFailed': 'ゲートを保存できませんでした',
  'guild.gates.refreshFailed': 'フィードを更新できませんでした',
  // The second sentence is the one that matters and it is an instruction, so
  // it takes てください -- the only imperative register this file uses. Note
  // that ゲートを保存 inside it is the literal label of the button in
  // `guild.gates.save`, and must follow it.
  'guild.gates.pinned': '上のルールに追加しました。購読するには、ゲートを保存してください。',

  // ------------------------------------------------------- the curator directory

  // キュレーター, katakana, because this is a role the protocol defines and
  // the server publishes under that name; 監修者 and 管理者 both exist in
  // Japanese and both mean something else. 鍵 rather than キー for the
  // cryptographic key: Japanese cryptography writes 公開鍵/秘密鍵 with the
  // kanji, universally, and キー in a Japanese interface means a keyboard key.
  'guild.gates.curators.hint': 'このサーバーが把握しているキュレーターです。フィードは、ここで鍵をピン留めするまで何も決定しません。',
  'guild.gates.curators.tableLabel': 'キュレーター',
  'guild.gates.curators.colCurator': 'キュレーター',
  'guild.gates.curators.colFeed': 'フィード',
  // "Listed by" -- where this client heard about the curator. 掲載元 is the
  // noun for the party that published a listing, which is exactly the cell's
  // contents (this server, or a hostname). 体言止め, as every column header
  // here is.
  'guild.gates.curators.colSource': '掲載元',
  'guild.gates.curators.thisServer': 'このサーバー',
  // ピン留め, which is the verb Japanese uses for pinning a message or a tab,
  // and which Japanese security writing extends to key pinning (the noun in
  // the literature is ピンニング, as in 証明書ピンニング, but the noun is not
  // what a button says). The English comment asks for the language's existing
  // term and this is it.
  'guild.gates.curators.pin': '鍵をピン留め',
  'guild.gates.curators.subscribed': '購読中',

  // ------------------------------------------------------------ subscribed feeds

  // The fail-closed half is spelled out with a contrastive が, which is how
  // Japanese carries English's "but keeps": 許可しなくなりますが、ブロックは
  // 続けます. Both halves have to appear because Japanese cannot elide the
  // second verb the way English elides "keeps refusing" into a participle.
  'guild.gates.feeds.hint': 'フィードは最初に保存したときに取得され、その後は1時間ごとに取得されます。期限切れのフィードは、許可していたホストを許可しなくなりますが、ブロックしているホストはブロックし続けます。',
  'guild.gates.feeds.tableLabel': '購読中のフィード',
  'guild.gates.feeds.colFeed': 'フィード',
  'guild.gates.feeds.colHosts': 'ホスト',
  // シリアル, katakana, and deliberately not 通し番号 or バージョン: the
  // English comment says it is a serial in the sense a DNS zone has one, and
  // シリアル is the word a Japanese DNS operator reads in their own zone file.
  'guild.gates.feeds.colSerial': 'シリアル',
  // 最終取得, a compact 体言止め compound, because the column is about eight
  // characters wide and 最後に取得した日時 would wrap it.
  'guild.gates.feeds.colFetched': '最終取得',
  'guild.gates.feeds.colKey': 'キュレーターの鍵',
  // 状態 for "Status" here, and 稼働状態 for "Health" in the voice table
  // below. English distinguishes them with two words that are near-synonyms in
  // Japanese, so the distinction is kept by making the voice one explicitly
  // about being up (稼働) and leaving this one general.
  'guild.gates.feeds.colState': '状態',
  // 更新 is `common.refresh` in this file; フィードを更新 keeps the object in
  // front of it as every other button in this namespace does.
  'guild.gates.feeds.refresh': 'フィードを更新',

  // The separator becomes the full-width ・, which the English comment
  // explicitly permits and Japanese typography requires -- the Latin `·` sits
  // at the wrong height next to kanji, the same complaint `common.empty` makes
  // about the Latin em dash. {action} arrives holding the literal English
  // `allow` or `block` the moderator typed and is shown back unchanged; it is
  // the token they will read in the rules box above, so translating it would
  // break the one match they are making. The sentence then reverses: English
  // put the act first and the agent last ("curated by X"), Japanese puts the
  // agent first and the act last ({curator} によるキュレーション).
  'guild.gates.feeds.curatedBy': '{action}・{curator} によるキュレーション',
  'guild.gates.feeds.hosts': '{hosts, number}',
  // Full-width parentheses, no surrounding spaces, per this file's convention.
  // 件 counts the blocked hosts: a host is a row in a list here rather than a
  // machine standing somewhere, and 件 is the counter for entries. 台 (the
  // counter for machines) would be wrong and faintly comic. うち carries
  // English's implicit "of those", which Japanese needs stated because the
  // parenthetical is otherwise a free-floating second number.
  'guild.gates.feeds.hostsWithBlocks': '{hosts, number}（うち {blocks, number} 件をブロック）',
  'guild.gates.feeds.fetchedAt': '{at, dateTime}',

  'guild.gates.feeds.keyPinned': 'ピン留め済み',
  // 回, the counter for repetitions, after the number -- exactly where English's
  // old "x" suffix sat, which is one of the few places English and Japanese
  // agree on position.
  //
  // 英語がここを `plural` にしたので、日本語も `plural` にしてある。日本語には
  // `other` しか腕がなく、見た目の結果は `{count, number}` のときと同じだが、
  // 構文をそろえておくほうがよい: `i18n-coverage` の複数形チェックは英語の
  // 構文を基準に走り、英語が数える場所で日本語が数えないままだと、次に誰かが
  // この行を触ったとき「日本語は数えなくてよい」ではなく「日本語は数え忘れて
  // いる」に見える。
  'guild.gates.feeds.keyRotated': '{count, plural, other {#回ローテーション}}',
  // Full-width colon and no space before it, which is the convention
  // `errors.context` set. {key} is base64 and keeps its ASCII space in front
  // so the Latin run does not collide with the colon.
  'guild.gates.feeds.keyInForce': '現在有効： {key}',
  // 予告 rather than 発表: the curator has announced a rotation that has not
  // taken effect, and 予告 is specifically an announcement of something still
  // to come.
  'guild.gates.feeds.keyRotationAnnounced': 'ローテーション予告あり',
  'guild.gates.feeds.keyNext': '次の鍵： {key}',

  // The five pill states. All 体言止め -- a pill is a label, not a sentence,
  // and none of them takes です.
  'guild.gates.feeds.state.active': '有効',
  'guild.gates.feeds.state.expired': '期限切れ',
  // 未取得, the negative-prefix compound, which is how Japanese says "has not
  // happened yet" in two glyphs. Not 保留中 and not 待機中: both would suggest
  // something is waiting on the reader, which the English comment says it is
  // not -- the hourly fetch simply has not come round.
  'guild.gates.feeds.state.pending': '未取得',
  'guild.gates.feeds.state.failed': '失敗',
  // "No key pinned". 体言止め with なし, which keeps it to a pill's width.
  // The state is that the rule trusts nobody, so the noun that is absent is
  // specifically a *pinned* key, not a key in general.
  'guild.gates.feeds.state.unpinned': 'ピン留めした鍵なし',

  // ------------------------------------------------------------ moderation queue

  'guild.queue.held.title': '保留中のメッセージ',
  // 通知されずに is where English's "silently" went, and it is more explicit
  // than the English: Japanese has no adverb that carries "without the author
  // being told" as compactly as "silently" does, and 静かに would mean quietly
  // in the acoustic sense. So the thing that does not happen is named.
  'guild.queue.held.description': '承認するとメッセージがすぐに送信されます。却下すると、通知されずに破棄されます。',
  // English's lowercase cue is unavailable -- Japanese has no case -- so the
  // register is carried by 体言止め instead: a bare noun, no です, no 。,
  // sitting where a reason like 新規アカウント or リンク would sit, and those
  // are bare nouns too. Same effect by different means.
  'guild.queue.held.reason': '保留',
  // Full-width parentheses. They do the same work English's do: mark this as
  // the interface speaking where everything around it is what somebody wrote.
  // 本文 rather than テキスト because 本文 is specifically the body of a
  // message as against its attachments, which is exactly the distinction.
  'guild.queue.held.noText': '（本文なし）',
  'guild.queue.held.emptyTitle': '待っているものはありません',
  'guild.queue.held.emptyBody': '保留キューは空です。',
  'guild.queue.approve': '承認',
  'guild.queue.reject': '却下',
  // 処理できませんでした, not 失敗しました: English deliberately says what
  // could not be done rather than guessing why, because the usual cause is
  // another moderator having got there first.
  'guild.queue.heldFailed': 'そのメッセージを処理できませんでした',

  'guild.queue.applicants.title': '申請者',
  'guild.queue.applicants.description': '参加審査の質問に答えて、判断を待っている人たちです。',
  // 参加を許可 for "Admit", against 承認 for "Approve" above. The English
  // comment asks for two words where a language has two, and Japanese has a
  // clean pair: 承認する is what you do to a submission, 参加を許可する is
  // what you do to a person. Using 承認 for both would lose the distinction
  // the queue is built on.
  'guild.queue.admit': '参加を許可',
  'guild.queue.applicants.emptyTitle': '待っている人はいません',
  // Keeps English's explanation of *where applicants come from* rather than
  // just reporting the empty list. The conditional 〜場合にのみ goes at the
  // head in Japanese, so the sentence is inverted against the English: the
  // condition first, the consequence last.
  'guild.queue.applicants.emptyBody': 'このギルドが参加審査の質問をしている場合にのみ、申請者がここに現れます。',
  'guild.queue.applicantFailed': 'その申請者を処理できませんでした',

  // ----------------------------------------------------------------------- bans
  //
  // BAN in Latin capitals throughout, for the reasons argued at
  // `guild.nav.bans`. The compounds it forms -- BANする, BAN解除, BANされて
  // いる -- are all ordinary Japanese and are what a moderator would write in
  // their own notes. The politeness here stays at plain です/ます: a ban is
  // something the reader is doing to somebody else, and softening it would be
  // the shop register this file's header rules out.

  // The scope, and it is the whole point of the line: a guild ban is not a
  // server ban. このギルドにのみ, with のみ rather than だけ, because のみ is
  // the restrictive that a statement of policy takes.
  'guild.bans.hint': 'BANはこのギルドにのみ適用されます。',
  'guild.bans.tableLabel': 'BAN',
  'guild.bans.empty': 'BANされているアカウントはありません。',
  'guild.bans.colAccount': 'アカウント',
  'guild.bans.colReason': '理由',
  // 日時, not いつ. A column header is 体言止め and Japanese does not put an
  // interrogative in one; 日時 ("date and time") is what the cell holds.
  'guild.bans.colWhen': '日時',
  // 体言止め, unemphatic, and it reports a gap in the record rather than a
  // fact about the person -- 理由の記録なし, "no record of a reason", not
  // 理由なし, which would say the ban had no reason. English's lowercase did
  // that work; Japanese does it by naming 記録.
  'guild.bans.noReason': '理由の記録なし',
  'guild.bans.unban': 'BAN解除',
  // The accessible name. A full verb phrase here, unlike the 体言止め button
  // above, because a screen reader reads it as a sentence. {account} holds a
  // full federated id in Latin letters and keeps its ASCII space.
  'guild.bans.unbanAccount': '{account} のBANを解除する',
  'guild.bans.unbanFailed': 'BANを解除できませんでした',
  'guild.bans.add': 'アカウントIDでBANする',
  'guild.bans.dialogTitle': 'アカウントをBANする',
  // The example is part of the label, as in English, because the field takes a
  // federated id and not a display name and that is the mistake people make.
  // Full-width parentheses and 例： introduce it, which is how a Japanese form
  // label carries an example; English's "like" has no direct equivalent that
  // is not wordier. The id itself is untouched -- see the note on
  // `guild.overview.transfer.placeholder`.
  'guild.bans.dialogLabel': '完全なアカウントID（例：@someone:example.org）',
  'guild.bans.confirm': 'BANする',
  'guild.bans.banFailed': 'BANできませんでした',

  // -------------------------------------------------------------- spam cleanup

  'guild.purge.title': 'スパムの一括削除',
  // 指定したアカウント is English's "named account": the tool needs an id
  // typed in and is not a sweep of the channel. 最近送った rather than
  // 最近の, so that the messages are attached to the account that sent them
  // and not merely recent.
  'guild.purge.hint': '指定したアカウントがこのギルドで最近送ったメッセージを削除します。',
  'guild.purge.accountLabel': 'アカウントID',
  // Left in English on purpose. Same reason as
  // `guild.overview.transfer.placeholder`: the local part is ASCII by
  // protocol, so スパム業者 or any Japanese stand-in would be an example the
  // field rejects. English's joke in "spammer" does not survive, and nothing
  // is lost -- what the placeholder has to communicate is the *shape*
  // `@localpart:domain`, which it still does.
  'guild.purge.accountPlaceholder': '@spammer:example.org',
  // 件 counts messages, here and in `guild.purge.deleted` below. Japanese
  // counts messages, notifications and records with 件; 通 exists and is for
  // letters and postal mail; 個 would be for objects and is wrong for a
  // message. 最大件数 puts the unit inside the noun the way 最低経過日数 did.
  'guild.purge.limitLabel': '削除する最大件数',
  'guild.purge.button': '最近のメッセージを削除する',
  // Two arms, where English had three, and the arithmetic is worth stating.
  // English needed `=0` plus `one` plus `other`; Japanese needs `=0` plus
  // `other`, because `one` is not a category `Intl.PluralRules('ja')` returns
  // and supplying it would be an arm nothing can ever select. The `=0` arm
  // survives translation intact, because it is not a plural category at all --
  // it is an exact match on zero, and the outcome it names (a purge that
  // matched nothing) is a different event in Japanese exactly as it is in
  // English. The bug English's comment describes -- "Deleted 1 messages" --
  // could not have happened here: 1件 and 12件 are the same sentence.
  'guild.purge.deleted': '{count, plural, =0 {削除されたメッセージはありません。} other {メッセージを#件削除しました。}}',
  'guild.purge.failed': 'メッセージを削除できませんでした',

  // ------------------------------------------------------------------- invites

  'guild.invites.create.title': '招待を作成',
  // 認証情報 is the word, and it is not softened. English's argument is that
  // an invite link is a credential and should be handed out like one; 認証情報
  // is what a Japanese security document calls a credential, and リンク or
  // URL here would throw the whole sentence away. できるかぎり carries
  // "where you can" without turning the instruction into a suggestion.
  'guild.invites.create.hint': '招待は認証情報です。できるかぎり、有効期限か使用回数の上限を設定してください。',
  'guild.invites.maxUses': '最大使用回数',
  // 無制限, a noun -- the *value* the empty field stands for, as the English
  // comment requires, not an instruction. 制限しない would be the instruction.
  'guild.invites.maxUsesPlaceholder': '無制限',
  'guild.invites.expires': '有効期限',
  'guild.invites.create.button': '招待を作成する',
  'guild.invites.created': '招待を作成しました。下の一覧からコピーしてください。',
  'guild.invites.createFailed': '招待を作成できませんでした',
  // This is the `{what}` of `common.copiedThing`, which in this file reads
  // '{what}をコピーしました。'. So it has to be a noun that takes を and
  // names a thing you can copy: 招待リンク, not bare 招待. 招待をコピーしま
  // した would say the invitation itself was copied rather than its link,
  // which is the kind of small wrongness a reader notices and cannot explain.
  // Japanese has no case system, so "whatever case that sentence needs it" is
  // answered by choosing a noun that fits を, and this is it.
  'guild.invites.clipboardName': '招待リンク',

  'guild.invites.list.title': '招待リンク',
  'guild.invites.tableLabel': '招待リンク',
  'guild.invites.empty': '作成された招待はありません。',
  'guild.invites.colCode': 'コード',
  'guild.invites.colUses': '使用回数',
  'guild.invites.colExpires': '有効期限',
  'guild.invites.colCreator': '作成者',
  'guild.invites.uses': '{used, number}',
  // The slash keeps its ASCII spaces: it separates two Latin numerals and is
  // punctuation the formatter does not own. Both numbers go through
  // `{n, number}`, which is the fix English's comment describes -- a guild
  // with 1,200 uses gets 1,200 here too, in whatever grouping `ja` uses.
  'guild.invites.usesOf': '{used, number} / {max, number}',
  // 期限切れ, which is already a completed state in Japanese -- the compound
  // means "the limit has been passed" -- so English's insistence on the past
  // tense comes for free.
  'guild.invites.expired': '期限切れ',
  // 体言止め for the row button, matching BAN解除 in the bans table: a dense
  // table of row actions reads better as nouns, and the full verb is saved for
  // the accessible name below.
  'guild.invites.revoke': '取り消し',
  // The accessible name, a full verb phrase. {code} holds the invite code and
  // is read out as itself, so it keeps ASCII spaces on both sides.
  'guild.invites.revokeInvite': '招待 {code} を取り消す',
  'guild.invites.revokeFailed': '招待を取り消せませんでした',

  // ----------------------------------------------------------------- audit log

  'guild.audit.tableLabel': '監査ログ',
  // まだ何も記録されていません -- a statement about time, as the English
  // comment insists, not about the table. 空です would be the table statement
  // and is what this key deliberately is not.
  'guild.audit.empty': 'まだ何も記録されていません。',
  'guild.audit.colWhen': '日時',
  // 実行者, "the one who carried it out". Not 実行者アカウント and not
  // ユーザー: the cell always holds an account, including for automatic
  // actions, and 実行者 is neutral about whether a person pressed anything.
  'guild.audit.colActor': '実行者',
  // 操作 for "Action". The cell under it holds the server's own code --
  // `member.ban`, `role.update` -- drawn in a <code> element and NOT
  // translated anywhere in this catalogue, per the long note at the top of
  // the English file. Nothing in this fragment gives any audit code a
  // Japanese name, deliberately.
  'guild.audit.colAction': '操作',
  'guild.audit.colTarget': '対象',

  // ---------------------------------------------------------- emoji and stickers

  'guild.expressions.emoji.title': 'カスタム絵文字',
  'guild.expressions.emoji.add': '絵文字を追加',
  'guild.expressions.emoji.emptyTitle': 'カスタム絵文字はまだありません',
  // The format names stay in Latin capitals -- they are format names, and
  // Japanese writes them that way. ショートコード is the term of art for the
  // `:name:` form and must match whatever the composer's own picker says; it
  // is katakana because there is no native Japanese word for it and コード
  // alone would collide with the invite code in the table above.
  'guild.expressions.emoji.emptyBody': 'PNG、GIF、WebP、JPEG のいずれかをアップロードしてください。ファイル名がショートコードになります。サーバー側で再エンコードし、収まるように縮小します。',
  // The colons around {name} are the shortcode syntax and must stay; they are
  // ASCII colons, not the full-width ：this file uses as punctuation
  // elsewhere, and the difference matters because one is syntax and one is
  // typography. {name} moves to the head of the sentence because Japanese puts
  // the object before the verb, so English's "Remove :x:" becomes ":x: を削除".
  'guild.expressions.emoji.remove': ':{name}: を削除',
  'guild.expressions.emoji.addFailed': '絵文字を追加できませんでした',
  'guild.expressions.removeFailed': '削除できませんでした',

  // スタンプ, not ステッカー, and this is the largest vocabulary decision in
  // the namespace. Japanese chat users have called this thing a スタンプ since
  // LINE shipped it in 2011 and every Japanese messaging client since has
  // followed; ステッカー in Japanese means an adhesive label you stick on a
  // laptop, and a Japanese reader meeting it in a chat client would not
  // connect it to the picker. This is exactly the case the file header
  // describes as "translated where a Japanese word exists and is the one
  // people use" -- the loanword is the wrong loanword.
  'guild.expressions.stickers.title': 'スタンプ',
  'guild.expressions.stickers.add': 'スタンプを追加',
  'guild.expressions.stickers.emptyTitle': 'スタンプはまだありません',
  // Answers the complaint the English comment names: where do they turn up.
  // 単独で送信します keeps "sent on their own", which is the second fact.
  'guild.expressions.stickers.emptyBody': 'スタンプは絵文字ピッカーから選んで、単独で送信します。',
  'guild.expressions.stickers.addFailed': 'スタンプを追加できませんでした',

  // ------------------------------------------------------------- voice regions
  //
  // リージョン, katakana, and NOT 地域. A "region" here is one relay named by
  // its address, which is the cloud-infrastructure sense of the word, and
  // Japanese cloud documentation is unanimous on リージョン for it. 地域 means
  // a geographical area and would send a moderator looking for a map. リレー
  // is likewise katakana because the SFU documentation the reader has open in
  // another window says "relay"; SFU and TURN stay in Latin letters, as the
  // English comment requires.

  'guild.voice.regions.title': 'ボイスリージョン',
  'guild.voice.regions.description': '自分のリレーを追加すると、このギルド全体や個々のボイスチャンネルでそれを使えます。',
  // 既定 rather than デフォルト. Both are used in Japanese software; 既定 is
  // the term Japanese-localised interfaces settled on and is two glyphs
  // against five, which matters in a line that also carries a hostname. The
  // <code> tag and the {name} inside it are untouched -- the tag is required
  // and what it wraps is an address.
  'guild.voice.serverDefault': 'サーバーの既定：<code>{name}</code>',
  'guild.voice.serverDefaultNone': 'サーバーの既定はありません。',
  'guild.voice.guildDefault': 'ギルドの既定：<code>{name}</code>',

  'guild.voice.tableLabel': 'ボイスリージョン',
  'guild.voice.empty': 'リージョンは設定されていません。',
  'guild.voice.colName': '名前',
  'guild.voice.colSfu': 'SFU',
  // 種別 rather than タイプ: a table column naming a kind is 種別 in Japanese
  // administrative interfaces, and it is two glyphs.
  'guild.voice.colType': '種別',
  // 稼働状態, against the plain 状態 used for the feed table's Status column.
  // English distinguishes "Health" from "Status" with two words that would
  // both come out 状態; adding 稼働 keeps the distinction and says what is
  // being measured, which is whether the relay is up.
  'guild.voice.colHealth': '稼働状態',
  // English's lowercase is unavailable in Japanese, and the register is
  // carried the same way `guild.queue.held.reason` carries it: bare nouns, no
  // です, in a column of one-word statuses.
  'guild.voice.typeCustom': 'カスタム',
  'guild.voice.typeServer': 'サーバー',
  // 正常 / 停止, the pair a Japanese monitoring dashboard uses. Not OK/NG, and
  // not 稼働中/ダウン: ダウン is understood but reads as an incident report,
  // and this is the server's own routine opinion about a probe.
  'guild.voice.healthOk': '正常',
  'guild.voice.healthDown': '停止',
  'guild.voice.defaultMarker': 'ギルドの既定',
  'guild.voice.makeDefault': '既定にする',
  // The accessible names. {name} is the region's own name and goes first, with
  // を marking it as the object; the English word order ("Make X the default")
  // has the object in the middle and cannot be followed here.
  'guild.voice.makeDefaultRegion': '{name} をギルドの既定にする',
  'guild.voice.removeRegion': '{name} を削除する',
  'guild.voice.loadFailed': 'ボイスリージョンを読み込めませんでした',
  'guild.voice.addFailed': 'ボイスリージョンを追加できませんでした',
  'guild.voice.defaultFailed': '既定のリージョンを設定できませんでした',
  // The parenthetical earns its words in Japanese too: it names the usual
  // cause, and the fix is to move the channel rather than to retry. Full-width
  // parentheses, no space before them.
  'guild.voice.removeFailed': 'リージョンを削除できませんでした（チャンネルがまだ使用している可能性があります）',

  // ------------------------------------------------------- adding a region

  'guild.voice.add.title': 'リージョンを追加',
  // A question, and it stays one. Japanese UI headings take the full-width ？
  // where a question is really being asked of the reader -- the alternative,
  // ending in か。, reads as a rhetorical question in a manual. The step asks
  // one thing and the heading should sound like it.
  'guild.voice.add.step1Title': 'リレーはどこにありますか？',
  'guild.voice.add.step1Body': 'このギルドが接続できる SFU のアドレスです。',
  'guild.voice.add.sfuLabel': 'SFU のアドレス',
  // Left in English on purpose: `example.com` is reserved by RFC 2606, the
  // `https://` is required syntax, and the host label `sfu` is the same three
  // letters the reader is about to type. Nothing here is language.
  'guild.voice.add.sfuPlaceholder': 'https://sfu.example.com',

  // The three address corrections. All are corrections rather than refusals,
  // so all three end in てください or in a statement of fact, and none of them
  // says できません about the reader's action -- the field still holds what
  // was typed.
  'guild.voice.address.needsHost': 'その後ろにホスト名を続けてください（例：https://sfu.example.com）。',
  // The placeholder moves to a clause of its own, and it has to. English tails
  // the offending scheme onto the end with a bare "not {scheme}"; Japanese has
  // no construction that hangs a negated noun off the end of a finished
  // sentence, so the sentence splits in two and {scheme} becomes the subject
  // of the second half. This is the clearest example in the namespace of a
  // placeholder that could not stay where English put it.
  'guild.voice.address.wrongScheme': 'リージョンへの接続は http か https で行います。{scheme} は使えません。',
  // The explanation is the important half and is kept whole: a bare host is
  // not rejected, it is *resolved* against this page, which produces a region
  // pointing back at the client. 読み取られ carries "is read as", and
  // このページのアドレスの一部 is the literal claim -- part of this page's
  // address -- because vagueness here would leave the reader thinking the
  // browser simply disliked their input.
  'guild.voice.address.bareHost': 'https:// から始めてください — ホスト名だけだと、このページのアドレスの一部として読み取られ、サーバーとしては扱われません。',

  'guild.voice.add.crumb': 'アドレス',
  // 名前を付ける, the imperative-ish stem form a step heading takes. The
  // English "Name it" is a verb and this stays a verb; 名前 alone would turn
  // the step heading into a field label.
  'guild.voice.add.step2Title': '名前を付ける',
  'guild.voice.add.nameLabel': 'リージョン名',
  'guild.voice.add.nameHint': 'チャンネルのリージョン選択で、このリレーが表示される名前です。',
  // Left as-is, deliberately. The English comment permits translating it to
  // something equally placeholder-shaped, but region names in this client are
  // lowercase-and-hyphenated by convention and a Japanese name here would
  // teach the reader a shape the rest of the system does not use. The value
  // of this placeholder is its *shape*, not its words.
  'guild.voice.add.namePlaceholder': 'my-relay',
  // TURN stays Latin (RFC 8656). 任意 is `common.optional` in this file, in
  // full-width parentheses, which is how a Japanese form marks an optional
  // field -- オプション would be a second loanword doing a job a native word
  // already does.
  'guild.voice.add.turnLabel': 'TURN（任意）',
  // Left in English: reserved domain, and `:3478` is the IANA port for TURN.
  'guild.voice.add.turnPlaceholder': 'turn.example.com:3478',
  'guild.voice.add.makeDefault': 'これをギルドの既定にする',
  'guild.voice.add.submit': 'リージョンを追加する',

  // ------------------------------------------------------------- the probe
  //
  // Every verdict here is written against one misreading -- that a failed
  // probe means a wrong address -- and the Japanese has to be at least as
  // indecisive as the English. The trap in this language is that Japanese
  // technical writing likes 〜できません, which sounds final; all three
  // negative verdicts below therefore stay in the past tense of a single
  // attempt (できませんでした, ありませんでした) rather than in the present
  // tense of a standing incapacity, and each one ends somewhere the reader can
  // act. ブラウザー with the long vowel, matching サーバー and ユーザー名
  // already in this file.

  'guild.voice.probe.checking': 'ブラウザーから接続できるか確認しています…',
  'guild.voice.probe.recheck': '接続できるか確認する',
  // ブラウザーから, not 「確認しました」: the measurement was made from this
  // machine on this network and the sentence names the thing that made it,
  // exactly as English refuses "we".
  'guild.voice.probe.reachable.title': 'ブラウザーから接続できました。',
  // The trust prerequisite, attached to the good verdict on purpose. The final
  // clause keeps English's structure -- two things are different, said as two
  // things -- because a Japanese reader who takes a green tick as 完了 will
  // not discover otherwise until a call fails. The spaced em dash follows
  // `errors.quota_exceeded` in this file.
  'guild.voice.probe.reachable.body': 'プライベートな SFU の場合、通話がつながるには、その SFU 側でこのギルドを信頼するよう設定されている必要があります — 稼働していることと、このギルドを受け入れることは別です。',
  'guild.voice.probe.unreachable.title': '応答がありませんでした。',
  // 〜場合もあれば、〜場合もあります is the Japanese construction for English's
  // "can mean X, or that Y": two equally live possibilities, neither asserted.
  // The last sentence is the escape hatch and keeps できます -- the reader may
  // add it either way, which is the part that stops them debugging a working
  // relay.
  'guild.voice.probe.unreachable.body': 'リレーが停止している場合もあれば、単にブラウザーからの要求には応答しない設定になっているだけの場合もあります。プライベートな SFU なら、このギルドを信頼するよう設定されているか確認してください。どちらの場合でも、追加して通話を試すことはできます。',
  'guild.voice.probe.unverified.title': 'ここからは確認できませんでした。',
  // 普通のことです is where English's "normal" went, and it is the load-bearing
  // phrase in the whole probe section: this verdict fires for most correctly
  // configured private relays, and a Japanese reader who takes it as a fault
  // will go and debug something that is not broken. まったく問題なく states
  // outright that the SFU is fine. 判定ではなく参考情報です keeps English's
  // "a hint, not a verdict", and 参考情報 is the word a Japanese dashboard
  // uses for a reading you should not act on alone.
  'guild.voice.probe.unverified.body': '応答が届く前にブラウザーが要求を止めました。これは普通のことです。CORS ヘッダーを返さない SFU はまったく問題なく、ただウェブページからは確認できないというだけです。これは判定ではなく参考情報です — 追加して通話を試してみてください。',

  // Heard, never drawn. Each names the state rather than the glyph: a screen
  // reader announces neither a tick nor a colour, and 緑 or チェック here
  // would describe something the listener cannot perceive.
  'guild.voice.probe.a11yChecking': 'アドレスを確認しています',
  'guild.voice.probe.a11yReached': '接続できました',
  'guild.voice.probe.a11yFailed': 'このブラウザーからは接続できませんでした',

// `DataTable` の既定値ふたつ。呼び出し側が何も渡さなかったときだけ出るので、
  // 英語と同じく意図的に内容を特定しない言葉にしてある。レコードは「件」で数える
  // ものなので一覧の名前としては「レコード」を採り、「記録」は避けた――「記録」は
  // 監査ログの意味に寄り過ぎて、汎用の既定値が特定の画面の名前に聞こえてしまう。
  'common.table.empty': 'ここには何もありません。',
  'common.table.label': 'レコード',

// ============================================== roles / channel / bots (ja)
  //
  // ------------------------------------------------------------ the glossary
  //
  // The sibling fragment for `guild` settled sixteen words an hour before this
  // one was written, and every one of them is used here unchanged: **guild**
  // ギルド, **channel** チャンネル, **member** メンバー, **role** ロール (not
  // 役職, which is a job title in a company), **gate** ゲート, **ban** the
  // Latin `BAN`, **invite** 招待, **audit log** 監査ログ, **queue** キュー,
  // **purge** 一括削除, **sticker** スタンプ (not ステッカー, which in
  // Japanese is the thing you stick on a laptop), **region** リージョン (not
  // 地域), **relay** リレー, **key** 鍵 (not キー, which is a keyboard key),
  // **pin** ピン留め, **default** 既定 (not デフォルト), **allowlist**
  // 許可リスト / **blocklist** ブロックリスト, **origin** 配信元, and **bot**
  // ボット. Its counters are used too: 人 for people, 件 for messages and for
  // rows in a list, 回 for repetitions, 秒/分/時間/日/週間 for spans.
  //
  // Twelve more words had to be settled here, because these three namespaces
  // are the first to use them. Each is argued at the entry where it first
  // appears; this is the index, so that the next translator can find the
  // argument rather than re-open the question:
  //
  //   * **permission** 権限. Not a choice: `errors.missing_permission`, already
  //     in this file, reads 「{permission}」の権限が必要です, so 権限 is the
  //     category word and a permission's own label is the bare noun phrase that
  //     goes inside the corner brackets. That fixes the shape of every
  //     `perms.<bit>.label` before `perms` is translated at all -- see the note
  //     over `roles.permissions.adminNotice`.
  //   * **category** カテゴリ (channel category) -- `channel.field.category`.
  //   * **tag** タグ -- `channel.tab.tags`.
  //   * **slowmode** 低速モード -- `channel.edit.slowmodeLabel`.
  //   * **thread** スレッド -- `roles.overwrite.hint`.
  //   * **post** 投稿 -- `channel.type.forum.description`.
  //   * **overwrite** 上書き -- `roles.delete.body`.
  //   * **intent** イベント購読 -- `bots.install.intentsTitle`. The one word in
  //     this fragment translated away from its cognate on purpose.
  //   * **capability** ケーパビリティ -- `bots.capability.unknown.hint`.
  //   * **grant** 付与 -- `bots.list.notice`.
  //
  // Four rules that hold across all 260 entries and are therefore not repeated
  // on every one of them:
  //
  //   1. **One plural arm, and the `=0` exception.** `Intl.PluralRules('ja')`
  //      returns `other` for every number there is, zero and one included, so
  //      every `plural` below supplies `other` and nothing else. Writing a
  //      `one` arm would not be harmless padding: it is an arm the runtime can
  //      never select and the coverage test rejects it. An `=0` arm is a
  //      different animal entirely and survives translation untouched, because
  //      `=0` is an *exact match on the value zero* rather than a grammatical
  //      category -- `pluralBranch` in `format.js` tests it before it ever asks
  //      `Intl.PluralRules` anything. Zero is an outcome; "one" is a fact about
  //      English grammar. The outcome crosses languages and the grammar does
  //      not, which is the whole distinction in one line. (No English pattern
  //      in these three namespaces happens to carry an `=0`, so nothing below
  //      exercises it; the rule is written down anyway, because the next
  //      namespace along will.)
  //   2. **Counters.** Japanese has no bare count of a noun. The number goes
  //      after the noun with a counter word welded to it, which is why not one
  //      of these sentences could have been produced by dropping a number into
  //      the English shape, and why the `one`/`other` split dissolves without
  //      losing anything: English's singular was carrying agreement and nothing
  //      else. Where it was carrying something else, the entry says so.
  //   3. **Full-width punctuation** (。、（）：「」？), with no space before it,
  //      and a single ASCII space on each side of a run of Latin letters or of
  //      a placeholder that will hold one. That is the spacing `errors.too_large`
  //      established at the top of this file. Numerals are the exception and
  //      close up against the kanji beside them, the way Japanese typesetting
  //      does it.
  //   4. **Politeness.** Plain です/ます everywhere. Destructive and
  //      irreversible sentences stop there: no 〜いただけます, no honorific, no
  //      added reassurance. `bots.capability.withdrawnRemoved` and
  //      `channel.tags.moderatedNote` are the two that would be most tempting
  //      to soften and are the two that must not be.

  // ==== roles

  // ------------------------------------------------------------------- the list
  //
  // The rank vocabulary first, because four entries share it. English's ladder
  // -- "above", "below", "outranks", "stands at or above your own" -- survives
  // into Japanese intact, because Japanese uses the same vertical metaphor for
  // authority and has a ready pair in 上位/下位. So this is one of the rare
  // cases where the English comment's escape hatch ("a language whose natural
  // metaphor is not vertical should pick its own") is not needed: 上位 is used
  // in `roles.list.hint`, `roles.list.description` and `roles.editor.notEditable`
  // and nowhere is a second metaphor introduced.

  // 編集・移動・付与 with the full-width ・ joining the three verbs, which is
  // how Japanese lists verbal nouns without repeating を three times. The
  // agent moves to the end (〜できるのは…だけです), which is the Japanese
  // shape for "only X may do this" and the reverse of English's order.
  'roles.list.hint': 'ロールを編集・移動・付与できるのは、そのロールより上位の人だけです。',

  // 既定, not デフォルト -- the glossary word, and two glyphs instead of five
  // in a section heading. 権限 is the category word fixed by
  // `errors.missing_permission` above.
  'roles.everyone.title': '既定の権限',
  // The time clause goes first. English trails "before any role is handed
  // out"; Japanese puts a temporal subordinate ahead of what it qualifies, so
  // the sentence turns end for end and the noun phrase it describes lands
  // last. There is no way to assemble this from a translated "what every
  // member can do" plus a translated tail.
  'roles.everyone.description': 'ロールが付与される前の、このギルドの全メンバーができることです。',

  // The plural dissolves and nothing is lost. メンバー is メンバー at any
  // count; the number attaches to 人, the counter for people, not to the noun.
  // 人 rather than 名: 名 is the faintly formal counter of a register or a
  // guest list, 人 is a count of people in a room, and this is a room.
  //
  // No 。 and no です, unlike the sibling's `guild.overview.memberCount` which
  // is a sentence read on its own. This string is drawn as a bare count under
  // @everyone *and* read aloud as the accessible name of a number beside a
  // row, and both of those are labels rather than statements -- 体言止め, a
  // noun phrase that stops.
  'roles.memberCount': '{count, plural, other {メンバー#人}}',

  // Both English arms were identical and the comment explains why: English
  // does not inflect a heading, but a language that agrees one with its number
  // had nowhere else to say so. Japanese does not agree headings either, so
  // the two arms collapse into the one arm Japanese has, and the distinction
  // English was preserving for somebody else's benefit simply never comes up.
  // 件 counts the rows of a list, per the sibling's counter rules. The spaced
  // hyphen is copied from `common.convo.group` already in this file rather
  // than invented here.
  'roles.list.title': '{count, plural, other {ロール - #件}}',
  // どのロールがどのロールより上位か -- the interrogative pair is spelled out
  // where English can lean on "who outranks whom", because Japanese has no
  // relative-pronoun pair and a bare 順序 would say "order" without saying
  // order of what.
  'roles.list.description': 'ロールをドラッグすると、どのロールがどのロールより上位かを変えられます。',

  // The imperative on the button. Japanese marks the imperative/noun contrast
  // the English comment asks about by the particle rather than by case: を作成
  // is an act, の作成 is a heading. This is the act; `roles.create.title` five
  // entries down is the heading, and in English they are the same two words.
  'roles.list.create': 'ロールを作成',
  // Placeholder and accessible name at once, so a verb phrase rather than a
  // noun: it has to survive being read aloud when the placeholder text is gone.
  'roles.list.search': 'ロールを検索',

  'roles.list.empty.title': 'ロールはまだありません',
  // だけ carries "and nothing else", which English puts in a separate clause.
  'roles.list.empty.body': 'ここにいる全員が既定の権限だけを持っています。',

  // 「」 rather than English's curly double quotes, which is exactly what the
  // English comment invites: Japanese has its own pair and uses it for quoting
  // language. It also solves the problem the comment raises -- a query of two
  // spaces is visibly two spaces between corner brackets, where curly quotes
  // next to kanji sit at the wrong height (the complaint `common.empty`
  // already makes about the Latin em dash).
  'roles.list.noMatch': '「{query}」に一致するロールはありません。',

  // {role} moves to the head with を after it, because Japanese puts the
  // object before the verb. English's "Edit {role}" reads left to right as
  // verb-then-object and Japanese reads object-then-verb, so these two keys
  // are the simplest demonstration in the namespace that a component may not
  // build a row label out of a verb string and a name.
  'roles.row.edit': '{role} を編集',
  'roles.row.delete': '{role} を削除',

  // の作成, the noun phrase, against を作成 on the button above. The English
  // comment over `roles.delete.title` makes this exact request -- a heading
  // names a thing about to happen, a tooltip names an action -- and Japanese
  // has the distinction available for free in the particle.
  'roles.create.title': 'ロールの作成',
  'roles.create.nameLabel': 'ロール名',
  'roles.create.confirm': '作成',
  'roles.create.failed': 'ロールを作成できませんでした',

  // の削除 for the heading, against を削除 on the row tooltip above. Same
  // particle contrast, and this is the pair the English comment singles out.
  'roles.delete.title': '{role} の削除',
  // 一緒に消えます, not 一緒に削除されます. 削除される is what a system does
  // to a record; 消える is what happens to the thing itself, and the sentence
  // is warning somebody that something of theirs disappears. The sibling made
  // the same call in `guild.overview.delete.hint` and the two must agree.
  'roles.delete.body': 'このロールを指定しているチャンネルの上書きも一緒に消えます。',
  'roles.delete.failed': 'ロールを削除できませんでした',

  // 順序を変更できませんでした rather than 並べ替えられませんでした: the list
  // has already snapped back, so the sentence reports the state that was not
  // reached rather than the gesture that failed.
  'roles.reorder.failed': 'ロールの順序を変更できませんでした',

  // --------------------------------------------------------------- the editor

  'roles.editor.back': 'ロール一覧に戻る',

  // @everyone stays exactly those nine Latin characters, per the English
  // header: it is what somebody types into the composer, and a translated form
  // would be a word that pings nobody. The ASCII space after it is this file's
  // convention for a Latin run inside Japanese text. The three verbs are
  // joined with ・ the way `roles.list.hint` joins its three.
  'roles.everyone.locked': '@everyone は移動・名前の変更・削除ができません。',

  // 「ボット」ページ -- the corner brackets quote the literal rail label, which
  // the sibling fragment set to ボット in `guild.nav.bots`. If that label ever
  // changes these two sentences move with it, which is the whole reason the
  // brackets are here rather than a bare ボットページ.
  'roles.managed.canManageGuild': 'このロールはインストール済みのボットのものです。インストール時に作成されたため、ここでは編集できません。ボットにできることは、この設定の「ボット」ページで変更します。',
  // The second of the pair, ending in the permission rather than in a place to
  // go. 「{permission}」が必要です matches `errors.missing_permission` already
  // in this file word for word, so a reader who meets the refusal and then
  // this notice sees one sentence pattern rather than two.
  'roles.managed.needsManageGuild': 'このロールはインストール済みのボットのものです。インストール時に作成されたため、ここでは編集できません。ボットにできることは「ボット」ページで変更しますが、それには「{permission}」が必要です。',

  // Split into two sentences, where English joined them with "so". Japanese
  // can chain with ため, but the second half is the server's refusal and it
  // reads as a fact of its own -- and このサーバーは変更を認めません keeps
  // English's insistence that the refusal is the guild's own server's and not
  // this client's. 認めません, not できません: できません would say the button
  // is broken, 認めません says somebody decided.
  'roles.editor.notEditable': 'このロールはあなた自身のロールと同じか、それより上位です。そのため、このサーバーは変更を認めません。',

  // 表示 / 権限 / メンバーの管理. The third is a noun phrase with の rather
  // than the compound メンバー管理, and deliberately: English made it two
  // words to mark it as a tab you act from, and the particle is where Japanese
  // carries that -- メンバー管理 would read as the name of a subsystem.
  'roles.tab.display': '表示',
  'roles.tab.permissions': '権限',
  'roles.tab.members': 'メンバーの管理',

  'roles.editor.saveFailed': 'ロールを保存できませんでした',

  // 注意： with the full-width colon, which is how a Japanese interface opens a
  // warning; English's "Careful," with a comma has no direct equivalent that
  // is not either wordier or milder. The sharpness the English comment asks
  // for is in 注意 itself -- it is the word on a hazard sign -- and the
  // politeness stops at ます with nothing added after it.
  'roles.editor.unsaved': '注意：保存していない変更があります。',
  // 元に戻す, four glyphs, against リセット which is also four. The native
  // phrase wins because it says what the button does -- put it back the way it
  // was -- where リセット in a Japanese interface is ambiguous between
  // "revert" and "clear to nothing", and clearing is precisely what this
  // button does not do.
  'roles.editor.reset': '元に戻す',
  // Not `common.save` (保存): this names the set of edits collected across
  // three tabs. 変更を保存 puts the object in front of the verb, as every
  // other button in this fragment does.
  'roles.editor.save': '変更を保存',

  // ----------------------------------------------------------- the display tab

  'roles.display.colour': 'ロールの色',
  // The relative clause has to be rebuilt from the inside out. English reads
  // "the colour of the highest role they hold that has one" left to right,
  // stacking two modifiers after the noun; Japanese stacks them before it, so
  // the sentence is assembled in the opposite order and 色 appears twice --
  // once inside the clause that selects the role, once as the thing the member
  // wears. That duplication is not redundancy, it is what Japanese requires
  // where English could use "one" as a pro-form.
  'roles.display.colourHint': 'メンバーには、持っているロールのうち、色が設定された最上位のロールの色が付きます。',
  // 色なし, 体言止め. Not 黒 and not 透明, per the English comment -- the
  // absence of a colour, which the theme then fills in.
  'roles.display.noColour': '色なし',

  // 分けて表示する, "display separately". Japanese has no equivalent of the
  // jargon "hoist", and the hint below has to name this same behaviour again,
  // so the phrase is chosen to survive being repeated: 分けて表示するロール in
  // `roles.display.hoistHint` refers back to this switch and would not work
  // if this label were a coined noun.
  'roles.display.hoist': 'このロールのメンバーを分けて表示する',
  // Two sentences where English had one with a trailing "under" clause.
  // Japanese cannot hang a locative modifier off the end of a finished
  // sentence, and the alternative -- one enormous pre-nominal clause -- would
  // put four modifiers in front of 見出し and be unreadable. This is a split
  // *inside* one key, not a second key: the component still receives one
  // sentence and could not reassemble these two in any other order.
  'roles.display.hoistHint': 'このロールを持つメンバーは、メンバーリストで独自の見出しにまとめられます。見出しは、その人が持つ分けて表示するロールのうち最上位のものになります。',
  // @mention stays in Latin script, like @everyone: it names a gesture with a
  // literal spelling, and メンションする in this one place would stop naming
  // the thing you type. ASCII spaces on both sides of the Latin run.
  'roles.display.mentionable': '誰でもこのロールを @mention できるようにする',
  // メンション for "ping", which is the verb Japanese chat users use and which
  // ties this hint to the @mention above. 「{permission}」 arrives already
  // translated from `perms.mention_everyone.label`, bracketed the way
  // `errors.missing_permission` brackets it.
  'roles.display.mentionableHint': 'これがない場合、「{permission}」を持つメンバーだけがメンションできます。',

  // -------------------------------------------------------------- the palette
  //
  // Twelve swatch names, read aloud and never drawn. They are colour names in
  // the ordinary sense, so they are translated the way a Japanese paint chart
  // writes them, which mixes native words and loanwords without embarrassment:
  // 赤, 青, 紫 and 黄色 are native because nobody says レッド; ピンク,
  // オレンジ and グレー are loanwords because nobody says 桃色, 橙色 or 鼠色
  // in an interface; 藍色, 青緑 and 金色 are native because the native word is
  // the everyday one; エメラルドグリーン is a loanword because the native
  // 翠 is literary and would not be recognised as a swatch.
  //
  // The two pairs the English comment insists on telling apart survive: 緑 and
  // エメラルドグリーン are distinct accessible names, as are 黄色 and 金色. So
  // is 青緑 against both greens and against 青. No two of these twelve can be
  // confused by somebody choosing a swatch by voice.
  'roles.colour.indigo': '藍色',
  'roles.colour.green': '緑',
  'roles.colour.yellow': '黄色',
  'roles.colour.pink': 'ピンク',
  'roles.colour.red': '赤',
  // 青緑, the everyday Japanese word for the colour between blue and green.
  // ティール exists in Japanese design tooling and is opaque to everybody
  // else; the swatch is read aloud to somebody who cannot see it, so the
  // recognisable word wins over the fashionable one.
  'roles.colour.teal': '青緑',
  'roles.colour.orange': 'オレンジ',
  'roles.colour.purple': '紫',
  'roles.colour.blue': '青',
  'roles.colour.grey': 'グレー',
  'roles.colour.emerald': 'エメラルドグリーン',
  'roles.colour.gold': '金色',

  // ------------------------------------------------------- the permissions tab

  'roles.permissions.search': '権限を検索',

  // This entry is where `perms` gets its shape decided for it. 「{permission}」
  // は…を含み: the label arrives inside corner brackets and is treated as a
  // quoted noun, so every `perms.<bit>.label` must be a bare noun phrase --
  // メッセージの管理, サーバーの管理, 管理者 -- and must NOT itself end in
  // 権限, or this sentence and `errors.missing_permission` both read
  // 「…権限」の権限. That is a decision this fragment is making on `perms`
  // behalf and it should be honoured when `perms` is translated.
  //
  // Both halves of the English are kept and neither is softened: すべての権限
  // を含み is the grant, チャンネルの上書きを無視します is the part that walks
  // past the exceptions somebody carefully set up.
  'roles.permissions.adminNotice': '「{permission}」はすべての権限を含み、チャンネルの上書きを無視します。',
  'roles.permissions.noMatch': '「{query}」に一致する権限はありません。',

  // ---------------------------------------------------------- the members tab

  // The accessible name: a purpose clause (追加する) in front of the object,
  // because Japanese has no way to trail "to add" after the noun.
  'roles.members.search': '追加するメンバーを検索',
  // The placeholder, which says what to type rather than what the box is for.
  // 名前で goes first: Japanese puts the instrumental adverbial ahead of the
  // verb, so English's tail clause becomes the head of the phrase.
  'roles.members.searchPlaceholder': '名前でメンバーを検索',

  // 体言止め: a heading over results, so 一致 with no です and no 。 -- the
  // same register `roles.list.title` is in.
  'roles.members.matching': '「{query}」に一致',
  // About the guild, not about the search, exactly as the English comment
  // requires: このギルドに…いません says the whole membership was checked and
  // came back empty. 該当する結果がありません would be the sentence this key
  // is deliberately not.
  'roles.members.noMatch': 'このギルドに、その名前の人はいません。',

  // {role} moves to the head and takes を, because 持つ is a verb and its
  // object precedes it; English's "Holding {role}" has the participle first
  // and Japanese cannot follow that order at all. 人 counts the holders. The
  // plural collapses to one arm, and the English comment's worry -- that a
  // language agreeing a heading with its number has nowhere to say so -- does
  // not apply to Japanese, which agrees nothing with anything.
  //
  // The count is one page of holders and the sentence does not promise it is
  // the total, so no 全 and no すべて anywhere in it.
  'roles.members.holding': '{count, plural, other {{role} を持つメンバー - #人}}',

  'roles.members.empty.title': 'このロールを持つ人はいません',
  // てください, the instruction register. This file uses it sparingly and only
  // where the reader is genuinely being told to do something next.
  'roles.members.empty.body': '上で検索して、誰かに付与してください。',

  'roles.members.add': '追加',
  // そのメンバー rather than the name, per the English comment: the row is
  // still on screen. 追加できませんでした names the outcome, not the cause.
  'roles.members.addFailed': 'そのメンバーを追加できませんでした',
  // 取り除く, matching `common.remove` already in this file, rather than 削除
  // which is `common.delete`. The member is not deleted; the role comes off
  // them.
  'roles.members.removeFailed': 'そのメンバーから取り除けませんでした',

  // ------------------------------------------------------- channel overwrites

  // 上書き for "overwrite", and this is the term-of-art decision of the
  // namespace. It is the word the Japanese-language side of this kind of
  // software uses for a per-channel exception (チャンネルごとの権限の上書き),
  // it is a native compound so a reader meets it already knowing what it does,
  // and it is short enough to repeat in a grid heading. オーバーライト was
  // rejected: in Japanese it means overwriting a file and carries the sense of
  // destroying what was there, which is the opposite of what an overwrite does
  // to a role's guild-wide permissions.
  //
  // 狭めたり広げたり keeps both directions, which the English comment insists
  // on -- an overwrite is an exception mechanism and not a restriction
  // mechanism. スレッド for thread; 引き継ぎます for inherit, the same verb as
  // `roles.overwrite.inherit` below, so the hint and the control agree.
  'roles.overwrite.hint': '上書きは、1つのチャンネルの中で1つのロールの権限を狭めたり広げたりします。スレッドは親チャンネルの設定を引き継ぎます。',

  'roles.overwrite.channel': 'チャンネル',
  'roles.overwrite.role': 'ロール',

  // The three states, each a whole phrase that survives being heard alone and
  // that names no permission at all. 引き継ぐ, not 既定 and not 継承なし:
  // English chose "inherit from the role" over "default" because the
  // permission falls through to whatever the role grants, which may be on or
  // off, and 既定 in Japanese would suggest off exactly as "default" does in
  // English.
  //
  // このチャンネルでは on the other two, with は rather than で alone: the
  // contrastive topic marker is how Japanese says "here, as against
  // elsewhere", which is the entire content of an overwrite.
  'roles.overwrite.inherit': 'ロールの設定を引き継ぐ',
  'roles.overwrite.allow': 'このチャンネルでは許可',
  'roles.overwrite.deny': 'このチャンネルでは拒否',

  // このチャンネルでの「{permission}」-- the locative goes in front of the
  // noun it modifies, so English's "{permission} in this channel" reverses
  // completely and the placeholder lands at the tail. Read together with the
  // state phrases above, a screen reader says 「メッセージの管理」…
  // このチャンネルでは許可 -- two whole things, in either order.
  'roles.overwrite.control': 'このチャンネルでの「{permission}」',

  'roles.overwrite.save': '上書きを保存',
  'roles.overwrite.saved': '上書きを保存しました。',
  'roles.overwrite.saveFailed': '上書きを保存できませんでした',

  // ==== channel

  // ------------------------------------------------- the shared field labels
  //
  // Form labels, all 体言止め. Japanese has no case to put a label in, so the
  // English comment's request ("whatever case a form label takes") is answered
  // by dropping the particle entirely -- which is what a Japanese form label
  // does and what makes these read as labels rather than as sentence
  // fragments.

  'channel.field.name': '名前',
  'channel.field.topic': 'トピック',
  // カテゴリ, without the long-vowel mark. Both カテゴリ and カテゴリー are
  // written in Japanese software; カテゴリ is what interfaces of this kind use
  // and is one glyph shorter, which matters in a picker. 分類 was rejected: it
  // means classification as an activity, and this is a shelf with a name on it.
  'channel.field.category': 'カテゴリ',
  // A choice, not a description of a state, per the English comment -- so
  // 体言止め with なし, which reads as the option "none of them" rather than as
  // a report that the channel has no category.
  'channel.field.noCategory': 'カテゴリなし',
  'channel.field.region': 'リージョン',
  // 非公開, native, against プライベート. The loanword in Japanese carries the
  // sense of "personal" and would read as "this is my own channel"; 非公開 says
  // outright that it is not open to everybody, which is what the switch does.
  'channel.field.private': '非公開',

  // ----------------------------------------------------- the kinds of room

  'channel.type.text.name': 'テキスト',
  // The list is joined with 、 and ends in 。even though it is a fragment,
  // because Japanese does not have English's convention of a full stop after a
  // noun list standing alone -- it either takes the full stop or it is a
  // 体言止め with none, and the parallel descriptions below are all sentences.
  'channel.type.text.description': 'メッセージ、スレッド、ファイル。',
  'channel.type.voice.name': 'ボイス',
  // 〜たり〜たり, the Japanese construction for a non-exhaustive pair of
  // activities, which is exactly what English's "Talk, and share a screen"
  // means and what a bare 話す。画面を共有する。would not.
  'channel.type.voice.description': '話したり、画面を共有したりします。',
  'channel.type.forum.name': 'フォーラム',
  // 投稿 for "post", settled here: it is the ordinary Japanese noun for a
  // thing somebody writes into a board, it doubles as the verb, and ポスト in
  // Japanese is a mailbox.
  'channel.type.forum.description': '投稿がそれぞれスレッドになります。',
  // アナウンス, katakana. 告知 exists and is the native word, but the channel
  // kind is a term of art the reader will also meet in the wire's own
  // `announcement` and in every other client of this shape; 告知チャンネル
  // would be a private coinage.
  'channel.type.announcement.name': 'アナウンス',
  // 投稿できる人が限られます, not 投稿が制限されます: English's "Restricted
  // posting" is about *who* may post, and the passive with no agent would let
  // a reader think the messages themselves are restricted.
  'channel.type.announcement.description': '投稿できる人が限られます。ほかのギルドからフォローできます。',

  // ----------------------------------------------------- creating a channel

  // の作成, the noun heading, against を作成 on the submit button below --
  // the same particle contrast `roles.create.title` uses, and the answer to
  // the English comment's "an imperative on a button, not a description".
  'channel.create.title': 'チャンネルの作成',

  // Four whole sentences, and Japanese is the language the English comment
  // names as the one where the old `` `New ${kind} channel` `` had no case to
  // change -- which is true and is not the reason these are four keys. The
  // reason is that 新しい is an adjective that must sit in front of the whole
  // compound, and the compound is テキストチャンネル rather than チャンネル
  // with テキスト dropped into it. There is no seam here for a template to use.
  'channel.create.newText': '新しいテキストチャンネル',
  'channel.create.newVoice': '新しいボイスチャンネル',
  'channel.create.newForum': '新しいフォーラムチャンネル',
  'channel.create.newAnnouncement': '新しいアナウンスチャンネル',

  // Translated, and this is the one placeholder in the fragment that is
  // translated rather than left alone -- so it is worth being explicit about
  // why it is not in the same class as `bots.install.referencePlaceholder` or
  // the sibling's `@spammer:example.org`. Those are shapes a machine parses,
  // and a Japanese local part or hostname would teach somebody to type
  // something the field rejects. A channel name is free-form Unicode that a
  // person types for other people to read, Japanese guilds name their channels
  // in Japanese as a matter of course, and 雑談 is precisely the channel a
  // Japanese guild has where an English one has "general". Leaving "general"
  // here would be an example of somebody else's convention.
  'channel.create.namePlaceholder': '雑談',

  // @everyone left exactly as it stands, per the English header. から is the
  // ablative -- hidden *from* them -- and the consequence-then-undo order of
  // the English is kept, because somebody reaching for this switch wants the
  // second sentence before they touch it.
  'channel.create.privateHint': '@everyone からは見えません。チャンネルの権限で許可すれば戻せます。',

  'channel.create.submit': 'チャンネルを作成',
  // 作成できませんでした -- the thing that did not happen, not an apology, so
  // that `errors.context` can put the server's own sentence after it. No 。,
  // matching every other `*Failed` key in this fragment and in the sibling's.
  'channel.create.failed': 'チャンネルを作成できませんでした',

  // ---------------------------------------------------- creating a category

  'channel.createCategory.title': 'カテゴリの作成',
  // English told its two example names apart by capitalisation -- "general"
  // the slug against "General" the heading -- and Japanese has no case at all,
  // so that signal is simply unavailable. Rather than lose the distinction the
  // English comment cares about, it is carried by word choice instead: 雑談 is
  // the name of a room people chat in, 一般 is the name of a heading that rooms
  // sit under. A Japanese reader sees two examples that look like two
  // different kinds of thing, which is what the capitalisation was for.
  'channel.createCategory.namePlaceholder': '一般',
  // Two sentences where English used one with a trailing "and so is". Japanese
  // cannot gap the verb across a conjunction like that -- 〜も、という形 would
  // need the verb repeated anyway -- so the second fact gets its own sentence
  // and is if anything louder for it, which suits a hint the English comment
  // calls deliberately stronger than the channel version.
  'channel.createCategory.privateHint': '@everyone からは見えません。その下にあるものもすべて見えなくなります。',
  'channel.createCategory.submit': 'カテゴリを作成',
  'channel.createCategory.failed': 'カテゴリを作成できませんでした',

  // --------------------------------------------------- the settings shell

  'channel.edit.title': 'チャンネルの編集',
  'channel.edit.titleCategory': 'カテゴリの編集',

  // The tabs. Japanese is the awkward case the English comment warns about
  // from the other direction: a CJK glyph is about twice the width of a Latin
  // letter, so 概要 at two glyphs is no narrower than "Overview" at eight. All
  // three are therefore kept to the shortest true word, and 概要 in particular
  // matches the sibling's `guild.nav.overview` rather than being re-chosen.
  'channel.tab.overview': '概要',
  // タグ, settled here. There is no native Japanese word for this -- 札 is a
  // physical tag on a parcel -- and タグ is what every Japanese board and
  // photo app calls it.
  'channel.tab.tags': 'タグ',
  'channel.tab.permissions': '権限',

  // Not `common.save` (保存), which alone would read as committing the field
  // the cursor is in. 変更を保存 names the lot, as `roles.editor.save` does.
  'channel.edit.save': '変更を保存',
  'channel.edit.saveFailed': 'チャンネルを更新できませんでした',
  // Two keys rather than one with the noun interpolated. Japanese needs no
  // gender and no article, so the English comment's reason does not apply
  // here -- but the keys still must not be merged, because a sentence built
  // from a noun plus a translated frame is the concatenation this catalogue
  // exists to forbid, and because the next language along does need it.
  'channel.edit.saveFailedCategory': 'カテゴリを更新できませんでした',

  // --------------------------------------------------------- the overview

  'channel.edit.topicHint': 'ヘッダーに表示されます。',
  // A real question with a full-width ？, because the box is asking the reader
  // something. 何のためのものですか keeps English's "for", which is the part
  // that tells somebody to write a purpose rather than a description.
  'channel.edit.topicPlaceholder': 'このチャンネルは何のためのものですか？',
  // 部屋 for "room", and the distinction the English comment asks to keep is
  // available in Japanese: チャンネル is the thing in the sidebar, 部屋 is a
  // place people are in rather than something they read. A voice channel is
  // the second.
  'channel.edit.topicPlaceholderVoice': 'この部屋は何のためのものですか？',

  // 低速モード, which is the settled Japanese term for this feature and is what
  // a Japanese moderator says out loud. The English comment's warning against
  // paraphrase is the live risk here: メッセージ送信の間隔制限 would be accurate
  // and would not survive being said in a moderation channel.
  'channel.edit.slowmodeLabel': '低速モード',
  // Full-width parentheses with no space before them, per this file's
  // convention. The parenthetical is doing real work -- a voice channel's
  // slowmode governs its chat, not its talking -- and is kept.
  'channel.edit.slowmodeChatLabel': '低速モード（チャット）',
  // メッセージを管理できる人 -- the permission described rather than named, so
  // no corner brackets and no 「」. English marked the difference with lower
  // case, which Japanese does not have; the particle does it instead, because
  // 〜できる人 is a description of people and 「メッセージの管理」 would be the
  // name of a switch. That also fixes `perms.manage_messages.label` as
  // メッセージの管理 -- see the report.
  'channel.edit.slowmodeHint': 'メッセージを管理できる人は対象外です。',

  'channel.edit.previewsLabel': 'リンクのプレビューを表示する',
  // どちらの場合でも goes first. English trails "either way"; Japanese puts a
  // concessive adverbial at the head, so the reassurance-that-is-not-a-
  // reassurance arrives before the fact it qualifies -- which is the right way
  // round here, because the reader is about to switch something off believing
  // it stops the fetch.
  'channel.edit.previewsHint': 'どちらの場合でも、取得はギルド自身のプロキシを通して行われます。',

  // Identical to the sibling's `guild.overview.expiry.title`, deliberately:
  // this is the channel's half of the same setting and a second wording would
  // tell the reader they are two features.
  'channel.edit.expiryLabel': 'ファイルの保存期限',
  // 単位は秒です rather than a bare 秒。 English can use the bare unit as a
  // one-word sentence; Japanese cannot, and 秒 alone under a number field
  // would read as a label for the field rather than as a statement about what
  // goes in it. The unit stays first, as the English comment requires.
  'channel.edit.expiryHint': '単位は秒です。空のままにすると、ギルドの上限に従います。',
  // チャンネルごとの上限なし. "Channel" is load-bearing in the English and
  // ごとの is where it lands: the guild's cap still applies and this says only
  // that the channel adds none of its own. A bare 上限なし would claim the
  // opposite.
  'channel.edit.expiryPlaceholder': 'チャンネルごとの上限なし',
  'channel.edit.fileSizeLabel': 'ファイルサイズの上限',
  'channel.edit.fileSizeHint': '単位はバイトです。空のままにすると、ギルドまたはサーバーの上限に従います。添付ファイルのみです。',
  'channel.edit.fileSizePlaceholder': 'このチャンネルでは上限なし',

  // ------------------------------------------------------------- durations
  //
  // The slowmode ladder. Japanese is the language the English comment names as
  // taking `other` alone, and these four entries are what that looks like: one
  // arm each, the counter welded to `#`, and no seam anywhere that a component
  // could have used to glue a number to a word.

  // なし, not オフ. `common.off` in this file is オフ and is the state of a
  // toggle; this is an option in a list of durations where it means no wait at
  // all. The English comment predicts exactly this split for German and
  // Japanese has it for the same reason.
  'channel.slowmode.off': 'なし',
  // 秒 / 分 / 時間, the counters, with no space before them -- a numeral and
  // its counter close up in Japanese typesetting. `#` goes through the
  // formatter, so the digits and any grouping are the locale's own.
  'channel.duration.seconds': '{count, plural, other {#秒}}',
  'channel.duration.minutes': '{count, plural, other {#分}}',
  'channel.duration.hours': '{count, plural, other {#時間}}',

  // -------------------------------------------------------- forum defaults
  //
  // 既定の〜 on both labels, which is the glossary word and which keeps these
  // reading as starting points rather than as rules. 並び順 and レイアウト
  // without 既定 would say the board may only be read this way, which is the
  // misreading the English comment is written against.

  'channel.forum.sortLabel': '既定の並び順',
  // 開いたとき -- "when you open it" -- for English's "where the board
  // starts". Japanese has no locative idiom for a starting state, and 最初の
  // 状態 would be ambiguous between the board's and the reader's.
  'channel.forum.sortHint': 'フォーラムを開いたときの並びです。',
  // 最新の書き込み順, and Japanese gets to be more exact than English here.
  // "Recent activity" leaves it to the comment to say that a reply counts and
  // that an old thread answered this morning comes to the top; 書き込み covers
  // a post and a reply alike and 最新の〜順 says the ordering is by the latest
  // of them. Nothing is added that the feature does not do.
  'channel.forum.sort.activity': '最新の書き込み順',
  // 投稿日時順 -- the thread's own creation time, against the sort above.
  // Not 作成日時順: a forum thread is created by being posted, and 投稿日時 is
  // the word the post itself carries, so the two sort options read as two
  // facts about a post rather than as one about a post and one about a record.
  'channel.forum.sort.creation': '投稿日時順',
  'channel.forum.layoutLabel': '既定のレイアウト',
  // 先頭に出ます for "leads with": the image is what the card opens with.
  'channel.forum.layoutHint': 'ギャラリーでは、各投稿の最初の画像が先頭に出ます。',
  // リスト rather than 一覧. 一覧 is the right word for a listing page, but
  // these two are the names of two layouts sitting beside each other and リスト
  // pairs with ギャラリー as one vocabulary.
  'channel.forum.layout.list': 'リスト',
  'channel.forum.layout.gallery': 'ギャラリー',

  // -------------------------------------------------------- voice settings

  // Matches the sibling's `guild.voice.regions.title`. リージョン, not 地域 --
  // a region here is one relay named by its address, which is the
  // cloud-infrastructure sense, and 地域 would send somebody looking for a map.
  'channel.voice.regionLabel': 'ボイスリージョン',
  // SFU stays in Latin capitals, per the English comment: it names a category
  // of server software, the people who change this setting know the word, and
  // no language has a translation. ASCII spaces around it. 中継する is the
  // verb for relaying and matches リレー in the sibling's voice pane.
  // 「自動」 quotes the option directly below so the sentence and the list
  // agree, which is what the English comment asks for.
  'channel.voice.regionHint': 'このチャンネルを中継する SFU です。「自動」を選ぶとギルドの既定に従います。',
  'channel.voice.regionAuto': '自動',
  // English's slash means guild-or-server and Japanese has no punctuation that
  // reads that way inside a parenthetical -- a full-width ／ between two nouns
  // would read as a compound. または spells it out. Full-width parentheses.
  'channel.voice.regionAutoDefault': '自動（ギルドまたはサーバーの既定）',
  // {region} holds an identifier the server minted (`eu-west`, `sfu-3`) and is
  // never translated, transliterated or re-spaced. Only カスタム is ours.
  // Full-width parentheses with no space before them, so the Latin identifier
  // and the katakana do not collide.
  'channel.voice.regionCustom': '{region}（カスタム）',
  'channel.voice.bitrateLabel': 'ビットレート',
  // 話す人ひとりあたり -- "per speaker" -- kept as the measure, because the
  // cost being linear in speakers is the fact the English comment refuses to
  // soften. 帯域が増えます, flat, with no 〜可能性があります anywhere near it.
  'channel.voice.bitrateHint': '高くするほど、話す人ひとりあたりにホストが使う帯域が増えます。',
  // kbps is a unit symbol and is left exactly as it stands, per the English
  // header. The number goes through `{kbps, number}` so its digits and
  // grouping are the locale's; the ASCII space in front of the symbol is the
  // one thing here that is a translator's decision, and it is kept, because
  // Japanese spaces a Latin run away from what precedes it.
  'channel.voice.bitrateValue': '{kbps, number} kbps',
  // 人数制限, a compound. ユーザー制限 would be a calque and would suggest a
  // restriction on *which* users rather than on how many.
  'channel.voice.limitLabel': '人数制限',
  // 0 written as the digit, because it is what somebody types into the control
  // beside this. The ASCII space after it separates the numeral from the kana,
  // matching the sibling's `guild.gates.hold.hint`.
  'channel.voice.limitHint': '0 にすると制限しません。',
  'channel.voice.limitNone': '制限なし',
  // The English comment says the `one` arm is not hypothetical here, because
  // the picker really does contain a rung of 2 and English needs "1 person"
  // against "2 people". In Japanese the distinction has nowhere to land: 1人
  // and 2人 are the same construction, and 人 is the counter for people
  // whatever the number. One arm, and nothing of English's is lost -- its
  // singular was carrying agreement, not meaning.
  'channel.voice.limitPeople': '{count, plural, other {#人}}',

  // ------------------------------------------------------------ forum tags

  // Two plural arguments in one pattern, both kept, and this is the entry the
  // coverage test is watching. Each block keeps its own `#`, which inside that
  // block is that block's own count -- `{max}` in the first, `{perPost}` in
  // the second -- and each supplies `other` alone.
  //
  // The ASCII space English put between the two sentences is gone, and its
  // removal is deliberate rather than an accident of editing: Japanese does
  // not space after 。, and a space there reads as a typesetting error in
  // exactly the way `Hello ,world` does in English. The two blocks therefore
  // sit flush against each other.
  //
  // 件 counts the tags, per the sibling's rule that 件 counts rows in a list;
  // a forum tag is a row in the tag editor above. 個 would be the counter for
  // small objects and would read as though the tags were things in a box.
  // ひとつの投稿 rather than 1つの投稿 in the second half, because the numeral
  // there is not a count the reader is comparing against anything -- it means
  // "any one post" -- and spelling it in kana keeps the two real numbers in
  // the sentence unambiguous.
  'channel.tags.limit': '{max, plural, other {タグは最大#件です。}}{perPost, plural, other {ひとつの投稿には#件まで付けられます。}}',

  // Never drawn, only heard. The index sits between タグ and の with no
  // spaces, because a numeral closes up against the kanji beside it; the
  // Latin-run spacing rule this file uses is for letters, not digits.
  // `{n, number}` rather than `{n}` so the digits are the locale's own, as the
  // English comment requires. No 入力欄 and no フィールド: the screen reader
  // announces the role by itself.
  'channel.tags.emojiLabel': 'タグ{n, number}の絵文字',
  'channel.tags.nameLabel': 'タグ{n, number}の名前',
  // 絵文字 is three glyphs and 名前 two, which at this font size is about the
  // width of six and four Latin letters -- inside the eighty-four pixels the
  // English comment gives the emoji box. Both are the everyday words; 絵文字 in
  // particular matches the sibling's `guild.expressions.emoji.*`.
  'channel.tags.emojiPlaceholder': '絵文字',
  'channel.tags.namePlaceholder': '名前',
  // モデレーターのみ付けられる, and the verb is not optional. A bare
  // モデレーターのみ next to a switch would be read as "visible to moderators
  // only", which the English comment says outright is a feature this does not
  // have -- and Japanese is more exposed to that misreading than English,
  // because のみ attaches to the noun and leaves the verb to be guessed. 付ける
  // is the verb for putting a tag on something, so the label says who may
  // apply it and nothing about who may see it.
  'channel.tags.moderated': 'モデレーターのみ付けられる',
  // {name} to the head with を, verb last. 取り除く matches `common.remove`
  // already in this file rather than 削除 (`common.delete`): the tag comes off
  // the row, and the row may never have been saved.
  'channel.tags.removeNamed': '{name} を取り除く',
  'channel.tags.removeUnnamed': 'このタグを取り除く',
  // The same word as `channel.tab.tags`, and two keys on purpose. Japanese
  // does not distinguish a section heading from a field label by form, so
  // these two are identical strings today -- which is fine, and is not a
  // reason to merge the keys: the distinction the English comment protects is
  // for a language that has it, and merging would remove the option for
  // everybody.
  'channel.tags.fieldLabel': 'タグ',
  'channel.tags.empty': 'このフォーラムにはまだタグがありません。',
  'channel.tags.add': 'タグを追加',
  // Not `common.save`: the tags tab has its own save and the overview tab has
  // another, and the object in front of the verb is what tells them apart.
  'channel.tags.save': 'タグを保存',
  // Not hedged, and the order is reversed from the English to put the weight
  // in the right place. English leads with the server and appends "not just by
  // this screen"; Japanese leads with この画面だけでなく and lands on
  // サーバーが拒否します as the main clause, so the sentence ends on the
  // server's refusal. 拒否します, flat present -- not 拒否される場合があります,
  // which is the hedge the English comment forbids and which Japanese
  // technical writing reaches for by reflex.
  'channel.tags.moderatedNote': 'モデレーターのみのタグは、この画面だけでなくサーバーが拒否します。',
  'channel.tags.saveFailed': 'タグを保存できませんでした',

  // ------------------------------------------------------- who is allowed in

  // Longer than `channel.field.private` on the create dialogs, as the English
  // comment requires: here the switch sits at the top of a tab full of role
  // rows and 非公開 alone could be read as being about a role.
  'channel.perms.privateLabel': '非公開チャンネル',
  // 「{permission}」 arrives already translated from `perms.view_channel.label`
  // and is bracketed so the reader can match it against the switch in the list
  // below, which is the entire purpose of the sentence. そのロールからは in
  // the second half rather than a bare また見えるようになります: English's "let
  // it back in" has an antecedent Japanese would otherwise lose, and a reader
  // who thinks the channel becomes visible to everybody again has been told
  // the opposite of what the control does.
  'channel.perms.privateHintOn': '@everyone からは見えません。下のロールに「{permission}」を許可すると、そのロールからは見えるようになります。',
  // The reassurance half, and it is not weakened. 移動も削除も行われません, a
  // double negative-scope も…も, which is Japanese's flattest way of saying
  // neither of two things happens. Not 移動や削除は行われないはずです, which
  // would be the "should not" the English comment rules out.
  'channel.perms.privateHintOff': '@everyone から閲覧を取り上げます。移動も削除も行われません。',
  // 鍵のアイコン. 鍵 is the glossary word for key and does duty for a padlock
  // too, which is convenient rather than confusing -- the icon is a padlock
  // and Japanese calls both 鍵. アイコン is added because 鍵が付きます alone
  // would suggest the channel is locked rather than marked.
  'channel.perms.lockNote': 'チャンネル一覧では鍵のアイコンが付きます。',

  'channel.perms.roleLabel': 'ロール',
  // ごとに carries "per", and 設定します is added because the English noun
  // sentence ("Overwrites are per role") has no Japanese equivalent that is
  // not a fragment. The fact being asserted -- the switches below apply to the
  // role in the picker above and to no other -- is unchanged.
  'channel.perms.roleHint': '上書きはロールごとに設定します。',
  // ここでの twice, because "here" is doing the work in both halves and
  // Japanese cannot elide it the second time the way English elides it the
  // third. The glyphs are named as glyphs -- チェック, バツ, 横線 -- because
  // the glyphs are what is on screen, which is the English comment's point.
  'channel.perms.triStateHint': 'チェックはここでの許可、バツはここでの拒否、横線はロール自身の設定のままを表します。',

  // Deliberately not `perms.group.*`, which this file already translates as
  // 一般 / メンバー / テキストチャンネル / ボイスチャンネル / 詳細 for the role
  // editor. Those are a whole guild's worth of permissions and say so; here
  // the reader is already inside one channel and the heading only has to name
  // which half of it is being configured. テキスト against テキストチャンネル
  // is the difference, and it is visible at a glance, which is what a narrow
  // column needs.
  'channel.perms.group.general': '一般',
  'channel.perms.group.text': 'テキスト',
  // チャット against テキスト, and Japanese has the two words the English
  // comment hopes for. A voice channel carries a text channel under its own
  // id, and チャット is what the typing in a voice room is called -- テキスト
  // there would send the reader looking for a separate text channel.
  'channel.perms.group.chat': 'チャット',
  'channel.perms.group.voice': 'ボイス',

  // One word each, and each chosen so it can follow を in `choiceLabel` below.
  // 継承 rather than 引き継ぐ, which is the verb `roles.overwrite.inherit`
  // uses: that one is a whole phrase read aloud on its own, this one is a
  // tooltip that also has to compose into a sentence, and the verbal noun is
  // what composes. Both mean the role's own setting is left alone, and neither
  // is 既定, which would suggest off.
  'channel.perms.deny': '拒否',
  'channel.perms.inherit': '継承',
  'channel.perms.allow': '許可',
  // The order reverses completely. Japanese puts the object before the verb, so
  // the permission comes first, takes を, and the state lands at the tail:
  // 「メッセージの送信」を拒否. The corner brackets are what keep a multi-word
  // permission name from dissolving into the sentence, and they match
  // `errors.missing_permission`.
  //
  // 以前は {choice} に訳し終わった語（拒否・継承・許可）がそのまま入ってきて、
  // この行は「{permission} を {choice}」と並べ替えるだけだった。日本語は
  // 運がよかった: 三語とも を に続く形だったので、そのまま使えた。英語のほうは
  // そうはいかず（大文字の "Deny" が文中に落ちる）、ドイツ語はコロンで逃げていた。
  // いまは {choice} が機械トークンになり、腕ごとに文を書ける。日本語の出力は
  // 以前と一字も変わらないが、変わらないことがこちらの選択になった点が違う。
  // `other` は `CHOICES` が三つ固定のため到達しない。
  'channel.perms.choiceLabel': '{choice, select, deny {「{permission}」を拒否} inherit {「{permission}」を継承} allow {「{permission}」を許可} other {「{permission}」}}',

  'channel.perms.saveFailed': 'その上書きを保存できませんでした',
  // About the private switch rather than about an overwrite, because that is
  // the gesture the reader made. 見られる人 -- who can see this -- rather than
  // naming the mechanism, which the English comment calls correct and
  // unhelpful.
  'channel.perms.privateFailed': 'これを見られる人を変更できませんでした',

  // ==== bots

  // ------------------------------------------------------------- installing
  //
  // Consent copy, read in the ten seconds before somebody hands a program from
  // another domain the ability to read every message in their guild. Japanese
  // technical writing has two reflexes that would each quietly soften it, and
  // neither is indulged anywhere in this section: 〜する場合があります for
  // anything that will certainly happen, and 〜いただく for anything the reader
  // is asked to do. Every statement of fact below is in the flat present, and
  // the politeness stops at ます.

  'bots.install.title': 'ボットのインストール',
  // Telium stays in Latin letters, as it does in `errors.gateway.4001` already
  // in this file. 署名付き is the load-bearing adjective -- what the card shows
  // is what the origin published -- and 何もインストールしないうちに is the
  // other half: reading the card costs nothing. Both survive, and the second
  // moves to the front of its clause because Japanese puts a temporal
  // subordinate first.
  'bots.install.intro': 'アプリケーション参照を貼り付けてください。Telium はそのボットの署名付きアプリケーション記述子を取得し、何もインストールしないうちに、何を求めているかをそのまま表示します。',
  // 参照 for "reference", native. リファレンス in Japanese means a reference
  // work or documentation, which is the wrong sense entirely; 参照 is the
  // pointer sense and is what the field holds.
  'bots.install.referenceLabel': 'アプリケーション参照',
  // LEFT IN ENGLISH, entirely. `bots.example` is the reserved documentation
  // domain, the slash is syntax, and `01…` is the first two digits of a ULID.
  // None of it is language and all of it is a shape the reader is about to
  // copy: a localised host or a full-width digit here would teach somebody to
  // type a reference that cannot resolve.
  'bots.install.referencePlaceholder': 'bots.example/01…',
  'bots.install.referenceHint': 'ボットの開発者からコピーした参照を貼り付けてください。',
  // Matches `common.loading` (読み込んでいます…) in this file, including the
  // single ellipsis character rather than three periods.
  'bots.install.loading': 'アプリケーションを読み込んでいます…',

  // サードパーティ, katakana, and it is the word Japanese uses for exactly this
  // -- somebody else's software. 第三者 is the legal term for a third party to
  // a contract and would read as boilerplate; 他社 would claim the publisher is
  // a company. The eyebrow has to frame the address below it as the thing to
  // read, and サードパーティ does that because it is faintly untrusting in
  // Japanese too.
  'bots.install.thirdParty': 'サードパーティのアプリケーション',
  // 名乗っています, and the distancing is the whole point of the key. 名乗る is
  // "to give one's name as" -- it asserts a claim by the subject and nothing
  // about whether the claim is true, which is precisely what English's "calls
  // itself" does and what 名前： would destroy. The `<name>` tag is kept and
  // {name} inside it is a remote string, never touched; the placeholder moves
  // to the head because the verb goes last.
  'bots.install.callsItself': '<name>{name}</name> と名乗っています',
  // The bare common noun, dropped into the sentences around it. ボット, per
  // the glossary -- and note that this deliberately does NOT match
  // `bots.list.badge`, which is the one place the English comment says to
  // think twice; the argument is there.
  'bots.install.unnamed': 'ボット',
  // 受け付けていません matches `errors.registration_closed` already in this
  // file, which says the same thing about a homeserver and new accounts. Not a
  // refusal of this reader and nothing about permission: 現在 carries
  // English's "currently", so the sentence does not read as final.
  'bots.install.closed': 'このアプリケーションは現在、新しいインストールを受け付けていません。',

  // イベント購読 for "intent", and this is the largest vocabulary decision in
  // the fragment. The English file is explicit that the protocol meaning is
  // what gets translated and the ordinary English word is not: an intent is
  // one feed of events a bot asks to be sent, and something closer to
  // "subscription" is a better translation than the cognate. インテント is
  // available and is what a Japanese developer would read in the protocol
  // documentation -- but インテント in Japanese carries no meaning at all
  // outside Android, where it means something else, and the reader of this
  // screen is an administrator deciding what to expose rather than a developer
  // reading a spec. 購読 is already this file's word for a subscription
  // (`settings.messages.members.hint` says 範囲購読), so イベント購読 is
  // assembled out of vocabulary the catalogue has already settled. The machine
  // spelling is beside it on screen in every case, which is what makes moving
  // away from the cognate costless.
  'bots.install.intentsTitle': 'イベント購読',
  // Three sentences where English had two, because English's semicolon-free
  // "They start enabled; uncheck anything" is a coordination Japanese cannot
  // make without either a heavy conjunction or a full stop. 渡すべきでない --
  // "should not hand over" -- for "should not expose", because 公開 would be
  // about publishing and this is about what is sent to one program.
  'bots.install.intentsHint': 'ボットが要求しているイベントの種類です。最初から有効になっています。このサーバーが渡すべきでないものはチェックを外してください。',
  // ゲートウェイ stays katakana, matching this file's ゲートウェイの切断
  // section heading.
  'bots.install.intentsEmpty': 'このボットはゲートウェイのイベント購読を要求していません。',
  'bots.install.permissionsTitle': '権限',
  // 強力な for "powerful", and it is the word with weight -- 強力 is what
  // Japanese puts on a warning, where 高度な (advanced) or 特別な (special)
  // would both be the softening the English comment forbids. This also settles
  // 強力 for `bots.capability.powerful` below, and the English comment asks
  // that it be whatever word `perms.js` marks those bits with; `perms.js` in
  // fact marks them with no such word today, which is noted in the report.
  //
  // 無効になっています, flat: the dangerous ones start switched off, so
  // granting one is something the reader did. The last clause is an
  // instruction and takes てください.
  'bots.install.permissionsHint': '開発者が要求している権限です。強力なものは最初から無効になっています。このボットが役目を果たすのに必要なものだけをチェックしてください。',
  'bots.install.permissionsEmpty': 'このボットはギルドの権限を要求していません。',
  // Both halves, as the English comment insists: you do not hold this, and
  // therefore the server refuses. 認めません rather than できません, the same
  // call as `roles.editor.notEditable` -- できません would read as a broken
  // control and send the reader looking for a setting to change. 渡す for
  // "give away", which is the everyday verb and keeps the sentence about a
  // person handing something over rather than about a system state.
  'bots.install.cannotGrant': 'あなたはここでこの権限を持っていないため、このサーバーはそれを渡すことを認めません。',

  // Two keys, not one with a fallback. In Japanese the difference is smaller
  // than in a language that inflects after the verb -- {name} を and ボット を
  // take the same particle -- but the keys stay separate because the component
  // must not be the thing that decides, and because {name} is a remote string
  // that arrives with its own script and needs the ASCII spacing a bare noun
  // does not.
  'bots.install.submit': '{name} をインストール',
  'bots.install.submitUnnamed': 'ボットをインストール',
  'bots.install.installing': 'インストールしています…',

  'bots.install.previewFailed': 'ボットを読み込めませんでした',
  'bots.install.failed': 'ボットをインストールできませんでした',

  // ------------------------------------------------------- what is installed

  'bots.list.title': 'インストール済みのボット',
  // The standing notice, and the entry where 付与 is settled as the noun for a
  // grant. 許可 was the obvious candidate and is taken: this catalogue already
  // uses 許可 for the allow half of a tri-state (`channel.perms.allow`) and
  // 許可リスト for an allowlist, and a third sense on the bots screens would
  // make three unrelated things one word. 付与 is the verbal noun for handing
  // a power over, it is what Japanese access-control writing uses, and it
  // forms the compounds the rest of this section needs (付与内容, 付与した権限).
  //
  // 直ちに, not すぐに: the English comment says "immediately" is load-bearing
  // and 直ちに is the register of a specification rather than of an
  // advertisement. The causal clause moves to the end as its own sentence --
  // English trails "because every dispatch re-checks", Japanese would have to
  // front the whole reason inside the sentence it explains, which would bury
  // the reassuring half the administrator is reading for.
  'bots.list.notice': 'ボットを取り除くと、そのギルドのメンバーシップと稼働中のボットセッションが直ちに失効します。付与を減らした場合も、すでに開いているソケットに反映されます。ディスパッチのたびに現在のギルドの付与を確認し直すためです。',
  'bots.list.empty': 'このギルドにインストールされているボットはありません。',
  // The accessible name of the table. Without it the table primitive announces
  // its own English default to every screen reader in every language.
  'bots.list.tableLabel': 'インストール済みのボット',
  'bots.list.colBot': 'ボット',
  'bots.list.colPermissions': '権限',
  // Six glyphs over a narrow column, which is wide. 購読 alone was considered
  // and rejected: the column beneath holds `GUILD_MESSAGES` and friends, the
  // heading is the only translated word there, and 購読 with no イベント in
  // front of it would leave a reader guessing what is being subscribed to.
  'bots.list.colIntents': 'イベント購読',
  // LEFT IN LATIN CAPITALS, and this is the one entry in the fragment where a
  // deliberate mismatch with the English instructions needs arguing rather
  // than asserting. The English comment says most languages keep "BOT" and
  // also says to match whatever word `bots.install.unnamed` uses -- and in
  // Japanese those two instructions point in opposite directions, because
  // `unnamed` has to be the bare noun ボット (it is dropped into sentences)
  // while the badge is not a word being read at all. `BOT` in Latin capitals
  // is what every Japanese chat client draws in this pill; Japanese readers
  // recognise the three-letter shape before they parse it, exactly as the
  // comment describes; and ボット in katakana is four glyphs, about eight
  // Latin widths, which is not a pill any more. The two are the same concept
  // spelled two ways for two jobs, and a reader meeting both is in no danger
  // of thinking they are two kinds of thing -- the badge sits beside a display
  // name and the noun sits inside a sentence.
  'bots.list.badge': 'BOT',
  'bots.list.removeFailed': 'ボットを取り除けませんでした',

  // ---------------------------------------- narrowing one that is already here

  'bots.edit.heading': '{name} を編集',
  // ホームサーバー, the spelling `common.homeserver` already uses, rather than
  // a literal 開発者の拠点 for "the bot's home". Which half still works is the
  // point of the sentence and both halves are kept as separate sentences:
  // 減らすことは今でも安全に行えます, then the widening. 安全に is not hedged
  // -- a translation that came out 減らすことはできます would leave an
  // administrator unsure whether disarming a misbehaving bot is safe, which is
  // the failure the English comment names.
  'bots.edit.offline': 'ボットのホームサーバーに接続できなかったため、現在付与されているものだけを表示しています。減らすことは今でも安全に行えます。広げるには、アプリケーション記述子を確認し直す必要があります。',
  'bots.edit.intentsTitle': '付与したイベント購読',
  'bots.edit.permissionsTitle': '付与した権限',
  // 上限 for "ceiling", the same word the sibling uses in
  // `guild.duration.unlimited` (上限なし) and in `channel.edit.expiryHint`.
  // 天井 is the literal ceiling and means nothing here; 上限 is the declared
  // most a developer has said this application may ever be given, and it is
  // used again in `bots.edit.permissionsHint` below as the English comment
  // requires.
  'bots.edit.ceilingLoading': 'アプリケーションの上限を読み込んでいます…',
  // 本文 for "content", matching the sibling's `guild.queue.held.noText`
  // (（本文なし）): 本文 is specifically the body of a message as against the
  // fact of it, which is the distinction this whole intent is about. 直ちに
  // again, and 反映されます -- the next dispatch is already filtered, which is
  // exact rather than approximate.
  'bots.edit.intentsHint': 'メッセージ本文はプライバシーに関わります。外すと直ちに反映されます。',
  // Two clauses, neither optional, and Japanese joins them with the negative
  // 〜こともできず…こともできません, which is the construction for two
  // impossibilities of the same kind. That is closer to the English than a
  // simple 〜ません、また〜ません would be: the pair is one rule seen from two
  // sides, and the server and the reader are both bound by it.
  'bots.edit.permissionsHint': 'サーバーは開発者が宣言した範囲を超えて付与することはできず、あなたも自分が持っている以上を付与することはできません。',
  // 付与内容 -- "what has been granted" -- and not 変更を保存, which is what
  // `channel.edit.save` and `roles.editor.save` say. The English comment is
  // explicit that the noun is "grants" rather than "changes": the reader is
  // saving a set of powers, and 内容 is what turns the verbal noun 付与 into
  // the set of them.
  'bots.edit.save': '付与内容を保存',
  'bots.edit.failed': 'ボットを更新できませんでした',

  // ------------------------------------------------- the capability checklist
  //
  // Every row here is a box somebody is about to tick on a stranger's behalf,
  // so every row is consent copy and every sentence says plainly what the bot
  // will be able to do.
  //
  // The eight intent labels are the place where a mistranslation would be
  // invisible and serious. An intent names *a category of events the bot will
  // be sent* and not a thing the bot may do: メッセージ below must not be read
  // as "may send messages", which is a permission and lives in `perms`. Three
  // things hold that line, and they have to hold it together because the label
  // itself is one bare noun in both languages. The heading above the column is
  // イベント購読 rather than 権限; every hint below is in 受信します, the verb
  // for receiving rather than for doing; and the group headings are questions
  // about what the bot is let in on. A reader who takes メッセージ for a
  // sending permission has to have ignored all three.
  //
  // The wire constants printed under each box -- `GUILD_MESSAGES`,
  // `MESSAGE_CONTENT`, `MANAGE_ROLES` -- are not in this fragment at all;
  // they are drawn from the data and are never translated, which is what lets
  // an administrator reading this screen in Japanese and a developer reading a
  // log in English demonstrably talk about the same bit.

  // The bare noun, as in English. See the block above for what stops it being
  // read as a permission.
  'bots.intent.guild_messages.label': 'メッセージ',
  // 作成・更新・削除 joined with the full-width ・, the same device
  // `roles.list.hint` uses for three verbal nouns. 受信します, not 受け取れます
  // -- the events are pushed to the bot, and the potential form would suggest
  // the bot may go and fetch them.
  'bots.intent.guild_messages.hint': 'メッセージの作成・更新・削除のイベントを受信します。',
  'bots.intent.guild_members.label': 'メンバー',
  // The colon becomes a second sentence, which is what the English comment
  // asks for where a language does not use a colon this way -- and Japanese
  // does not: a full-width ： in Japanese introduces a value or a definition,
  // so 変化を受信します：参加した人… would read as an equals sign and claim the
  // three examples were the complete list. The second sentence is a list of
  // examples and reads as one.
  'bots.intent.guild_members.hint': 'ギルドメンバーの変化を受信します。参加した人、退出した人、名前が変わった人です。',
  // プレゼンス, katakana. 在席状況 is the native compound and is what an office
  // system would say; プレゼンス is the term of art in this kind of software
  // and is the word beside `GUILD_PRESENCES` in the reader's own documentation.
  // The hint below then uses オンライン状態 for the everyday half of it, so a
  // reader who does not know プレゼンス still learns what the box does.
  'bots.intent.guild_presences.label': 'プレゼンス',
  // ここにいる全員の goes first and is not shortened away. This is the intent
  // that tells a bot whether each individual member is at their computer,
  // continuously, and the scope is the whole guild rather than the bot's own
  // conversations -- putting 全員 at the head of the sentence is where Japanese
  // makes that unmissable, since a Japanese reader takes the first noun phrase
  // as the topic.
  'bots.intent.guild_presences.hint': 'ここにいる全員のオンライン状態とプレゼンスの変化を受信します。',
  // 入力中, which is already this file's word for it -- `settings.messages.typing.label`
  // reads 入力中であることを知らせる -- so the intent and the privacy setting
  // that turns it off say the same thing.
  'bots.intent.guild_typing.label': '入力中',
  'bots.intent.guild_typing.hint': '入力中の表示を受信します。',
  // スタンプ, not ステッカー, per the sibling's ruling and for its reasons:
  // Japanese chat users have called this thing a スタンプ since 2011 and
  // ステッカー is the adhesive label on a laptop.
  'bots.intent.guild_expressions.label': '絵文字とスタンプ',
  'bots.intent.guild_expressions.hint': 'ギルドの絵文字とスタンプの変化を受信します。',
  // 構成, not 構造. The English comment says "structure" is the part to get
  // right: the shape of the place -- its channels, its roles, their order and
  // their settings -- as against the people in it or what they are saying.
  // 構造 in Japanese is the structure of a building or of an argument and is
  // static; 構成 is how a set of parts is arranged and is what a configuration
  // has. ギルド is the sibling's word and is used unchanged.
  'bots.intent.guild_structure.label': 'ギルドの構成',
  // 見ます for English's "See", against 受信します on the other seven. English
  // varies the verb here and the variation is kept: this intent is about
  // visibility of a structure rather than delivery of a stream of events, and
  // Japanese would flatten a real distinction by making all eight identical.
  'bots.intent.guild_structure.hint': 'チャンネルとロール、そして構成の変化を見ます。',
  'bots.intent.guild_voice_states.label': 'ボイスの状態',
  'bots.intent.guild_voice_states.hint': 'ボイスチャンネルの参加状況と状態の変化を受信します。',
  'bots.intent.message_content.label': 'メッセージ本文',
  // The most consequential box on the screen, and both halves survive. 見える
  // すべてのメッセージ is English's "every message it can see" at full
  // strength -- not メッセージ, which the English comment forbids as a
  // softening. The second sentence keeps the contrast that is the only place a
  // reader learns what unchecking the box buys them, and Japanese carries it
  // with a paired 〜だけが伝わり…は伝わりません, which is flatter and more
  // absolute than English's "gets the fact and not its words".
  'bots.intent.message_content.hint': '見えるすべてのメッセージの本文を読み取ります。これがない場合、ボットにはメッセージがあったことだけが伝わり、その言葉は伝わりません。',

  // The group headings. They are phrases rather than nouns on purpose --
  // answers to "what is this bot being let in on?" -- and Japanese keeps them
  // as embedded questions with か, which is the construction for a headed
  // question that is not being asked of the reader. 何が起きるか, 誰がいるか,
  // どう構成されているか: three questions, three grammars, none of them a noun.
  'bots.intent.group.activity': 'ここで何が起きるか',
  'bots.intent.group.people': '誰がここにいるか',
  'bots.intent.group.structure': 'このギルドがどう構成されているか',
  // Short, because it sits above a row that already says at length what the
  // risk is and is paired with the 強力 pill on that row. 特権, the native
  // compound, which in Japanese means a privilege somebody has been granted
  // above the ordinary -- exactly the sense. 権限 is deliberately not reused
  // here: this is a heading over a privacy decision, not over a permission.
  'bots.intent.group.privileged': '特権',

  // A statement about this client's ignorance and not about the capability.
  // このクライアントに説明がないもの -- "the ones this client has no
  // description for" -- rather than 不明 (unknown) or 未対応 (unsupported),
  // both of which would tell the reader something is wrong with their bot
  // when the truth is that their software is out of date.
  'bots.capability.unknownGroup': 'このクライアントに説明がないもの',
  // ケーパビリティ for "capability", settled here, and it is a heavy word
  // chosen on purpose. A capability in this namespace is the umbrella over
  // both an intent and a permission -- the checklist is one control drawn
  // twice -- so it must not be either 権限 or イベント購読, and it must not be
  // 機能, which means a feature of the software and would tell the reader this
  // row is about something the bot can do for them rather than something it
  // has been given. ケーパビリティ is the word Japanese security writing uses
  // for a unit of authority of exactly this kind.
  //
  // {capability} holds a machine identifier and is never translated,
  // transliterated, re-spaced or broken across a line: it is the only handle
  // the reader has for searching their server's documentation. It keeps its
  // ASCII spaces. The second sentence is a promise and stays one --
  // そのまま変わりません, flat, so that a reader knows editing other boxes will
  // not quietly delete this grant.
  'bots.capability.unknown.hint': 'このサーバーは {capability} というケーパビリティを知っていますが、このクライアントは知りません。設定はそのまま変わりません。',
  // The fallback that has to work for both intents and permissions, so it
  // names nothing -- もの, the bare pro-form, where English says "None
  // requested".
  'bots.capability.emptyDefault': '要求されているものはありません。',
  // 強力, matching `bots.install.permissionsHint` above. English's lower case
  // marks it as a tag inside a line of a form rather than a heading, and
  // Japanese has no case -- so the register is carried by 体言止め instead: two
  // glyphs, no な, no です, which is how a Japanese pill is written. It is a
  // warning and the word has weight; 高度 (advanced) and 特殊 (special) were
  // both rejected as the softening the English comment names.
  'bots.capability.powerful': '強力',
  // 提供終了 -- the offering has ended. About the developer's offer having been
  // withdrawn, not about the grant having lapsed or been revoked: nothing has
  // been taken away from anybody yet, so 失効 (lapsed) and 取消済み (revoked)
  // are both wrong, and both would be read as a statement about the bot rather
  // than about the developer. Four glyphs, which fits a pill.
  'bots.capability.withdrawnBadge': '提供終了',
  // Every clause load-bearing and all four kept in English's order: the
  // developer did this, the bot has it now, you can take it away, and taking
  // it away is one-way. 戻すことはありません, flat and absolute -- not
  // 戻せない場合があります, which is the hedge the English comment forbids and
  // which is the reflex phrasing in Japanese. The spaced em dash follows
  // `errors.quota_exceeded` already in this file.
  'bots.capability.withdrawnHeld': '開発者がこれをアプリケーションから取り下げました。ボットは今も持っていて、あなたが取り上げることもできます — ただし、このサーバーがそれを戻すことはありません。',
  // Two short sentences, because this is the confirmation of a decision that
  // cannot be undone and a reader skimming one long sentence misses the second
  // half. 二度と付与できません is a statement about this server's rule and not
  // a prediction: no 〜と思われます, no 可能性, nothing after ません.
  'bots.capability.withdrawnRemoved': '開発者が取り下げ、今このボットから外れました。二度と付与できません。',

// ================================================================= chat (ja)
  //
  // ------------------------------------------------------------ the glossary
  //
  // The twenty words this namespace turns on, settled once here. Where the
  // guild, roles, channel and bots sections above already decided a word, it is
  // repeated rather than re-argued -- **guild** ギルド, **channel** チャンネル,
  // **member** メンバー, **role** ロール, **ban** `BAN`, **invite** 招待,
  // **sticker** スタンプ, **emoji** 絵文字, **key** 鍵 (never キー, which in a
  // Japanese interface means a keyboard key), **pin** ピン留め, **default**
  // 既定, **bot** ボット, **permission** 権限, **category** カテゴリ, **tag**
  // タグ, **thread** スレッド, **post** 投稿, **flow** フロー, **grant** 付与.
  //
  // The new ones this namespace has to decide, with the reasoning kept short
  // here because the entry that first uses each carries the long version:
  //
  //   * **reply** 返信 and **quote** 引用. Both native, both the only word
  //     anybody uses, and both are サ変 nouns so they serve as a tooltip, a
  //     menu row and a verb without changing shape.
  //   * **forward** 転送. Native, and importantly *not* 共有 -- `chat.forward.*`
  //     has both acts in it and English distinguishes them, so Japanese must
  //     too: 転送 moves a message you are reading, 共有 is the operating system
  //     handing this app something from outside.
  //   * **reaction** リアクション, katakana. 反応 is the dictionary word and it
  //     means a physical or emotional response; the thing on the message is a
  //     product feature with a name, and every Japanese chat client calls it
  //     リアクション.
  //   * **attachment** 添付ファイル, which `guild.overview.expiry.hint` already
  //     established above. Never アタッチメント, which in Japanese means a
  //     fitting on a machine.
  //   * **upload** アップロード, katakana, because 転送 is already spoken for by
  //     forwarding and 送信 by sending a message -- the one namespace where all
  //     three acts appear in adjacent strings is this one, and they have to
  //     stay three distinguishable words.
  //   * **spoiler** 伏せ字, native. See `chat.format.spoiler`: スポイラー in
  //     Japanese has been captured by ネタバレ (a plot revealed) and names the
  //     offence rather than the mark, whereas 伏せ字 is the established
  //     typographic term for a run of text deliberately covered over, which is
  //     exactly what the mark does.
  //   * **mention** メンション, which `roles.display.mentionableHint` above
  //     already settled.
  //   * **ephemeral** is not translated as a word at all. See
  //     `chat.ephemeral.mark`: エフェメラル is protocol jargon no reader knows
  //     and 一時的 understates it, so the two facts behind the word are said
  //     outright instead, which is what the English does too.
  //   * **receipt** 開封確認, the phrase Japanese messaging has used for a read
  //     receipt since email. The bare acknowledgement a server reports is 確認.
  //   * **embed** / **link card** does not need a noun here: the only two
  //     entries in the section are about the video inside one, so the word
  //     never has to be said. If a later key needs it, 埋め込み.
  //   * **composer** 入力欄 where it must be named, though in practice every
  //     string in that section names the act rather than the box.
  //   * **DM**: the encryption paragraphs say `DM` in Latin capitals and
  //     `chat.forward.directMessage` says ダイレクトメッセージ in full. Not an
  //     inconsistency -- they are the same word to a Japanese reader, DM is
  //     what one types, and the choice per entry is width: the custody
  //     paragraphs say it three times in four lines and the pill has room for
  //     the full noun exactly once.
  //
  // Three conventions that apply to all 269 entries and are therefore not
  // repeated on each one:
  //
  //   1. **One plural arm, and the `=0` exception.** `Intl.PluralRules('ja')`
  //      answers `other` for every number, so every `plural` below supplies
  //      `other` and nothing else; adding `one` writes an arm nothing can ever
  //      select. An `=0` arm is a different animal and survives: `pluralBranch`
  //      in `format.js` tests exact matches *before* it asks for a category, so
  //      zero is an outcome rather than a grammatical number and Japanese can
  //      still say a separate sentence for it. That contrast is the whole
  //      reason `chat.delivery.devices` keeps two arms where English had three.
  //   2. **Counters.** 人 counts people, 件 counts messages and list rows, 台
  //      counts devices, 回 counts repetitions, 分/時間/日/週間 count spans. The
  //      number goes after the noun with the counter welded to it, which is why
  //      no sentence here could have been built by dropping a numeral into an
  //      English shape -- and why a counter never takes a space before it even
  //      when the numeral arrives through a placeholder.
  //   3. **Full-width punctuation** (。、（）：「」), no space before it, and a
  //      single ASCII space on each side of a standalone run of Latin letters
  //      or of a placeholder that may hold one. A short Latin acronym fused
  //      into a Japanese compound closes up instead (DM復旧, 公開URL), which is
  //      the rule `guild.overview.transfer.label` (アカウントID) set above.

  // ------------------------------------------------------------- the timeline
  //
  // The room reporting on itself. Japanese has a register for this and it is
  // the flattest one the language has: plain ます, no 申し訳, no ご, nothing
  // that would make a paging hiccup sound like an apology from a shop.

  // 何も rather than メッセージ in the title, so the body is not saying the same
  // noun twice at two type sizes. まだ carries English's "yet" in both, and it
  // goes early -- Japanese puts the temporal qualifier before what it qualifies,
  // where English trails it.
  'chat.timeline.empty.title': 'まだ何もありません',
  // 話しかけてみてください, not 送信してください. The てみる auxiliary is exactly
  // English's "Say something": it invites an attempt rather than assigning a
  // task, and it is the softest thing this catalogue ever says to anybody. A
  // Japanese imperative here (最初のメッセージを送ってください) would read as
  // the software handing a new member a chore on their first screen.
  'chat.timeline.empty.body': 'メッセージはまだありません。何か話しかけてみてください。',

  // 読み込んでいます…, matching `common.loading` already in this file, including
  // the single ellipsis character.
  'chat.timeline.loadingOlder': '以前のメッセージを読み込んでいます…',
  // Phrased as what happens when the reader scrolls, which is what English
  // does. The と conditional makes the gesture the subject of the sentence and
  // the result its consequence -- there is no button named anywhere, so nobody
  // goes hunting for one.
  'chat.timeline.scrollForOlder': '上にスクロールすると以前のメッセージが表示されます。',

  // 最新, "the newest", and deliberately not 下 or 一番下. English's "bottom" is
  // the end of the stream and the comment above it says so; Japanese has a word
  // for the newest end that carries no direction at all, which makes this the
  // one case where the translation is less ambiguous than the source.
  'chat.timeline.jumpToBottom': '最新まで移動',

  // 新着, two glyphs, which is the width a pill has. 未読 was the alternative and
  // is rejected: 未読 describes the state of the messages below the rule, and
  // this string names the rule itself -- the boundary where new arrivals start.
  // Japanese clients have used 新着 for that boundary for twenty years. Casing
  // does not arise; Japanese has none, which is the reason the English string is
  // not upper-cased either.
  'chat.timeline.unreadMarker': '新着',

  // The three context phrases. No 。 on any of them: they are wrapped around a
  // sentence the server or the ladder supplies, through `errors.context`
  // (`{context}：{message}`) above, and a full stop in the middle of that would
  // read as two sentences collided. できませんでした throughout, which is the
  // shape every `*Failed` key in this file already uses.
  'chat.timeline.loadOlderFailed': '以前のメッセージを読み込めませんでした',
  'chat.timeline.loadHistoryFailed': '履歴を読み込めませんでした',
  'chat.timeline.jumpFailed': 'そのメッセージを読み込めませんでした',

  // もう carries English's "any more" exactly -- it says the link was once good
  // and is not now -- and it is one glyph, so the half most likely to be cut for
  // width in English is the half that costs nothing here. 利用できません rather
  // than ありません: the message may well still exist somewhere this account
  // cannot reach, and ありません would claim it is gone from the world.
  'chat.timeline.messageGone': 'そのメッセージはもう利用できません。',

  // -------------------------------------------------------------- the message
  //
  // Drawn hundreds of times on one screen. Japanese pays for that twice over --
  // a CJK glyph is about twice the width of a Latin letter -- so everything here
  // is 体言止め or a short verb phrase, and nothing is a sentence unless the row
  // genuinely speaks one.

  // {name} leads, because the possessor precedes the possessed in Japanese and
  // there is no way to put it anywhere else. ASCII spaces around it: it holds
  // either a display name or a full `@user:host`, and the second is Latin.
  'chat.message.openProfile': '{name} のプロフィールを開く',

  // 体言止め, and the only reason is width: this sits in the slot that will hold
  // a time of day. 送信しています… is the sentence form and is three glyphs
  // longer, which is a wrapped timestamp on a phone. 送信中 is what a Japanese
  // status caption says -- see `chat.forward.sending` below, which is the same
  // act in a place with room for the full verb, and deliberately spelled the
  // other way.
  'chat.message.sending': '送信中…',

  // 受身 with no agent, which Japanese does cleanly and which is the whole point:
  // the row does not know who deleted it, and Japanese passive does not oblige
  // anybody to say. 削除されました, not 削除済み: 済み is a badge and this is the
  // row standing in for the message it no longer has.
  'chat.message.deleted': 'メッセージは削除されました',

  // Security copy, so it names the fact and stops. 鍵 in kanji per the glossary.
  // Not 権限がありません -- that would be a claim about a policy, and the fact is
  // about a key this device was never handed. No 。 because it is a marker in the
  // row rather than a sentence addressed to anybody.
  'chat.message.unreadable': 'この端末にない鍵で暗号化されています',

  // Full-width parentheses, which close up against the text on both sides with
  // no space -- the ASCII pair would leave Latin-width gaps in the middle of a
  // Japanese line. 編集済み rather than 編集されました: English's lower case marks
  // this as an aside inside somebody else's sentence, Japanese has no case, and
  // 済み is how the language marks the same thing.
  'chat.message.edited': '（編集済み）',

  // Three サ変 nouns, matched as a set. A Japanese tooltip on a glyph button is a
  // noun, not an imperative -- リアクションする on a hover card reads as a caption
  // explaining the feature rather than as the name of the control.
  //
  // 編集 is the same word as `common.edit` in this file, and the separate key is
  // still right: Japanese happens to use one verb for correcting your own words
  // and for changing a setting, but that is a fact about Japanese and not a
  // reason to make the two surfaces share a string the next language cannot.
  'chat.message.actions.react': 'リアクション',
  'chat.message.actions.reply': '返信',
  'chat.message.actions.edit': '編集',

  // Context phrases again, no 。. リアクション and 編集 are both サ変, so the
  // negative potential attaches directly and the two lines stay parallel the way
  // English's two do.
  'chat.message.reactionFailed': 'リアクションできませんでした',
  'chat.message.editFailed': '編集できませんでした',

  // 体言止め and no 。: this stands where a name and a snatch of text would
  // stand, inside the reply's own muted header line. English signals that with
  // lower case; Japanese has no case, so the noun-ending is what carries it --
  // 以前のメッセージに返信しています would read as the system narrating.
  'chat.message.quotedOlder': '以前のメッセージへの返信',

  // 返信先, one word, which is precisely "the message this replies to" and
  // carries no suggestion of an original three steps up the chain -- 元の
  // メッセージ would, which is the reading the English comment rules out.
  'chat.message.jumpToQuoted': '返信先のメッセージへ移動',

  // The relationship is named and the word 返信 is said once rather than twice:
  // この返信の返信先の… is grammatical and unreadable. 返信先 alone already means
  // "the one this replies to", so the relationship English needs a clause for is
  // inside the noun here. Same もう利用できません as the timeline's version, which
  // is what makes the two read as one client speaking.
  'chat.message.replyGone': '返信先のメッセージはもう利用できません。',

  'chat.message.editBox.label': 'メッセージを編集',
  // Enter and Esc stay in Latin, and this is the keycap rule rather than an
  // oversight: these are legends printed on a physical keyboard, Japanese
  // keyboards print them in Latin, and エンター would name a key the reader then
  // hunts for. English lower-cases them because it is quoting keycaps casually;
  // Japanese has no case, so the marker is that they are Latin islands with
  // ASCII spaces around them, exactly as the file spaces every other Latin run.
  // 、 between the two halves, full width. Both keys are named, and the escape
  // half comes second for the same reason it does in English -- it is the half
  // somebody who opened this box by accident is looking for, and putting it last
  // in Japanese puts it closest to the box.
  'chat.message.editBox.hint': 'Enter で<save>保存</save>、Esc で<cancel>キャンセル</cancel>',

  // The plural dissolves entirely. English needed two arms because "message" and
  // "messages" are different words; Japanese needs one because メッセージ is
  // メッセージ at any count and the number attaches to the counter 件, not to the
  // noun. 件 and not 通: 通 counts letters and sealed correspondence and is what
  // a Japanese mail client uses, whereas these are rows in a thread and 件 is the
  // counter for an item in a list -- which is also the counter `roles.list.title`
  // above already chose for exactly this shape. Noun first, number second, which
  // is the order the concatenated English version could never have produced.
  'chat.message.thread.count': '{count, plural, other {メッセージ#件}}',

  // ----------------------------------------------------------------- delivery
  //
  // Nothing in here says anybody has *not* got something, in Japanese any more
  // than in English. Japanese makes that easier to get wrong, because 未読 and
  // 未受信 are one glyph away from the words that are allowed, and either would
  // turn somebody's receipts setting into an announcement about them.

  // 済み on the first two and 既読 for the third, which is the pair Japanese
  // messaging settled on long before this app. They are all 体言止め because a
  // dialog title in Japanese is a noun; the participle/noun split the English
  // comment worries about does not arise here, which is why the duplicate keys
  // at `chat.surface.delivery.*` end up with the same three strings and are
  // still right to be separate.
  'chat.delivery.title.sent': '送信済み',
  'chat.delivery.title.delivered': '配信済み',
  'chat.delivery.title.read': '既読',
  // Names the subject and guesses at no state, as the English comment requires.
  // 配信状況, "the delivery situation" -- a heading over whatever the newer
  // server turns out to mean.
  'chat.delivery.title.fallback': '配信状況',

  // 他の全員 is "everybody else": 他の does the excluding that English does with
  // "else", and the exclusion is load-bearing -- a reader counting heads against
  // the list below is one out without it. The two verbs stay parallel
  // (受け取りました / 読みました) so that the difference between the two states is
  // the only difference between the two lines.
  'chat.delivery.subtitle.delivered': '他の全員が受け取りました。',
  'chat.delivery.subtitle.read': '他の全員が読みました。',
  // グループの一部, not 一部の人: the sentence is about this conversation's
  // membership and 一部の人 would leave open who those people are. 受け取って
  // います, the resultative, because it describes a state that holds now rather
  // than an event that happened.
  'chat.delivery.subtitle.some': 'グループの一部が受け取っています。',
  // 確認 alone for a bare acknowledgement, reserving 開封確認 for the receipts
  // *setting* two entries down. まだ…ありません, which claims only that nothing
  // has arrived -- not that anybody has withheld anything.
  'chat.delivery.subtitle.none': 'まだ確認はありません。',

  // The one `=0` in the namespace, and the entry worth reading the header note
  // over: zero survives into Japanese where `one` cannot. `one` is a grammatical
  // category and `Intl.PluralRules('ja')` has none, so an arm written for it can
  // never be selected; `=0` is an exact match that `pluralBranch` tests before it
  // ever asks for a category, so it fires in every language including this one.
  // That is not a technicality here -- the zero arm is a different sentence about
  // a different thing. It describes the *record* (an old client's account-level
  // watermark, which never said which device), where the other arm describes
  // devices, and collapsing the two would have invented a fact.
  //
  // 台 counts machines and is the counter for 端末 throughout Japanese; 件 would
  // count the acknowledgements rather than the devices and 個 would make a phone
  // an object on a shelf. 端末#台, noun then number -- and no space before 台,
  // because a counter welds to its numeral even when the numeral arrives through
  // `#`. Both arms are 体言止め: this sits after a person's name on one row and is
  // read as part of it, which is what English signals with lower case.
  'chat.delivery.devices': '{count, plural, =0 {端末の記録なし} other {端末#台}}',

  // The one-word mark on a row for somebody who opened it rather than merely
  // received it. Same 既読 as the dialog title, which is correct here where it
  // would not be in a language that cases its badges differently from its
  // headings -- Japanese has one form and it is this one.
  'chat.delivery.read': '既読',

  // A state of the list, not a claim about people. Deliberately the same phrase
  // as `chat.timeline.empty.title` above, because it is the same statement about
  // a different container and two spellings would read as two different kinds of
  // emptiness.
  'chat.delivery.empty': 'まだ何もありません。',

  // 開封確認 is the Japanese term for a read receipt, and オフ matches
  // `common.off` already in this file so that the sentence names the setting the
  // way the switch that sets it is labelled. This is the sentence that stops the
  // list being read as a census, so it says plainly that people are missing from
  // it and does not soften that into 表示されない場合があります.
  'chat.delivery.receiptsHint': '開封確認をオフにしている人はここに表示されません。',

  // ---------------------------------------------------------------- the quote
  //
  // `<quoted/>` is an element, not a value: it holds rendered markdown with real
  // custom emoji in it. Both patterns keep it at the tail, which is where
  // Japanese puts the thing being introduced -- move nothing into it, rename
  // nothing.

  // Full-width colon and no space on either side, which is the convention
  // `errors.context` set at the top of this file. The ASCII colon-plus-space of
  // the English reads as a typesetting error in Japanese in the same way
  // `Hello ,world` does in English.
  'chat.quote.line': '{name}：<quoted/>',
  // English's participial lead becomes a noun phrase: 「{name} への返信」, "a
  // reply to {name}", with the same colon and the same tag position. A prefix
  // glued in front of `chat.quote.line` could not have produced this -- Japanese
  // marks the addressee with への *before* the noun, so the lead and the name
  // interleave rather than stack.
  'chat.quote.replyingTo': '{name} への返信：<quoted/>',
  // A noun standing where the words would have been, so 体言止め and no verb: the
  // line is already attributed and 添付ファイルを送信しました would attribute it
  // twice. 添付ファイル per the glossary.
  'chat.quote.attachment': '添付ファイル',

  // -------------------------------------------------------- the ephemeral reply
  //
  // A message delivered to one person and written to no history anywhere.

  // The word "ephemeral" does not appear, in Japanese or in transliteration, and
  // that is the same decision English made when it refused to draw a badge
  // reading EPHEMERAL. エフェメラル is protocol jargon a reader has never met;
  // 一時的 is a real word and understates it to "temporary", which is what a
  // draft is. So the two facts behind the term are said outright instead, in two
  // short sentences rather than across an em dash -- English's dash joins two
  // independent clauses, and Japanese joins those with a full stop. Both halves
  // are load-bearing, neither may be dropped for width, and the card wraps.
  'chat.ephemeral.mark': 'あなたにしか見えません。保存もされません。',

  // 消す, and pointedly not 閉じる, which is what `common.dismiss` says in this
  // file. 閉じる means the thing goes away and can be opened again; this button
  // destroys the only copy of a message that exists anywhere, because no server
  // holds it. The English comment notes that English has only one word for both
  // and asks a language with a stronger one to use it -- Japanese has exactly
  // that pair, and this is the entry that spends it.
  'chat.ephemeral.dismiss': '消す',

  // ------------------------------------------------------------- the encryption
  //
  // The rule from `en/security.js` that overrides house style applies to every
  // string below: never soften a warning and never invent one. Several of these
  // say that somebody other than the intended reader can read the messages, and
  // Japanese offers a dozen ways to make that hypothetical (〜可能性があります,
  // 〜場合があります, 〜こともあります). None of them are used. Where the English
  // says the operator *can* read these messages, the Japanese says 読むことが
  // できます and stops.
  //
  // What stays in Latin here, and why, since rule 4 wants the list:
  //
  //   * **MLS** and **OPAQUE**. Published protocol names. Somebody checking what
  //     this client claims searches for those letters; エムエルエス finds
  //     nothing and 多層暗号 would be a different protocol.
  //   * **Telium**. Product name, left Latin everywhere in this catalogue
  //     already -- see `errors.gateway.4001` above.
  //   * **Encryption key** — gone from these four strings. The pane's title is
  //     `settings.nav.recovery` in the catalogue now and the sentences take it
  //     as `{pane}`, which is the move the old version of this bullet asked for
  //     and could not have. What it said still holds: the pane is *labelled*
  //     "Encryption key" on a Japanese screen, so that is what 「{pane}」
  //     renders as today, because `settings.nav.recovery` is left untranslated
  //     on purpose — the other sixteen rows of that settings list are still
  //     English literals and one Japanese row among them would be worse than
  //     none. Translate that one entry and all four of these follow it with
  //     nothing to edit here. Do not write 暗号鍵 in place of `{pane}`.
  //
  //     The corner brackets stay around the placeholder, because it is still a
  //     quotation of a label the reader can go and look at — the convention
  //     `guild.gates.domainRules.hint` uses for 「制限なし」 — and they now do
  //     a second job: whatever the pane ends up being called, the brackets mark
  //     where the name starts and stops, which a Japanese line with no spaces
  //     in it otherwise leaves to the reader.
  //   * **DM**. See the glossary note: Latin in these paragraphs on width
  //     grounds, spelled out at `chat.forward.directMessage`.

  // The relay sentence, written out identically in all five custody modes so
  // that a reader who switches conversations does not read two accounts of one
  // arrangement. It compresses English's "Your home server relays them, and
  // always sees …" into a relative clause -- これを中継するホームサーバーには --
  // which names the server once instead of twice and puts the consequence in the
  // main clause where Japanese wants it. 誰が誰といつ話しているか keeps all three
  // of English's facts (who, with whom, when) in the order Japanese asks them.
  //
  // `unknown` is the mode a newer server named and this build has not met. It
  // says the weaker true thing and stops.
  'chat.encryption.custody.unknown': 'ここでのメッセージは MLS フレームです。これを中継するホームサーバーには、誰が誰といつ話しているかが常に見えています。',
  // English's colon after "recovery:" becomes a full stop and a new sentence.
  // Japanese uses ： to introduce a value or a label, not to introduce an
  // explanation of the clause before it, and a reader meeting it in that job
  // reads the rest of the line as a quoted string. ため, not ので: ため states a
  // cause as a fact about the arrangement, where ので leans toward excusing it.
  // The instruction at the end takes てください, the only imperative register this
  // file uses, and adds nothing after it -- no ご安心ください, no 推奨します.
  'chat.encryption.custody.escrowed': 'ここでのメッセージは MLS フレームです。これを中継するホームサーバーには、誰が誰といつ話しているかが常に見えています。このアカウントは、従来のサーバー補助によるDM復旧を使っています。復旧用の保管庫と履歴のミラーを開く鍵をホームサーバーが持っているため、運営者はこれらのメッセージを読むことができます。設定 →「{pane}」で、復旧を信頼済みの端末に移してください。',
  // 送られることはありません, the absolute negative, for "is never sent". 送られ
  // ません alone would be a statement about this occasion; ことはありません says
  // it does not happen at all, which is the claim OPAQUE actually supports.
  // 受け取るのは〜だけです puts the exclusivity at the end of the sentence, which
  // is where Japanese puts the part that carries the weight.
  'chat.encryption.custody.opaque': 'ここでのメッセージは MLS フレームです。これを中継するホームサーバーには、誰が誰といつ話しているかが常に見えています。Telium のパスワードがあれば、暗号化されたDMを OPAQUE で復元できます。パスワードがホームサーバーに送られることはなく、保管庫と履歴のミラーを開く鍵を受け取るのはあなたのクライアントだけです。',
  // 〜ますが、〜ていません, the Japanese shape for a has/has-not pair, which says
  // both halves in one breath where English needed "but holds no key". The
  // second half is the one that matters and it goes last.
  'chat.encryption.custody.device': 'ここでのメッセージは MLS フレームです。これを中継するホームサーバーには、誰が誰といつ話しているかが常に見えています。DMの復旧鍵は、あなたが承認した端末にあります。ホームサーバーは暗号化された履歴のミラーを保管しますが、それを開く鍵は持っていません。',
  // どちらも covers English's "Neither", and it has to come first in Japanese --
  // the quantifier binds at the head of the clause, so the sentence that ends in
  // English with the negation begins with it here.
  'chat.encryption.custody.self': 'ここでのメッセージは MLS フレームです。これを中継するホームサーバーには、誰が誰といつ話しているかが常に見えています。信頼済みの端末があなたのDM鍵を保持し、すべての端末を失った場合は別の復旧パスフレーズから復元できます。どちらもホームサーバーに送られることはありません。',

  // Byte-for-byte the tail of `custody.escrowed`, as English requires: the reader
  // may see both, and two wordings of one arrangement read as two arrangements.
  // If either is ever edited, both are.
  'chat.encryption.escrowedNote': 'このアカウントは、従来のサーバー補助によるDM復旧を使っています。復旧用の保管庫と履歴のミラーを開く鍵をホームサーバーが持っているため、運営者はこれらのメッセージを読むことができます。設定 →「{pane}」で、復旧を信頼済みの端末に移してください。',

  // 鍵束 for "keyring", built on the glossary's 鍵 rather than borrowing
  // キーリング: the rest of this catalogue writes 鍵 in kanji everywhere
  // (`guild.gates.curators.hint`), and a reader who has met 復旧鍵 in the
  // settings pane recognises 復旧用の鍵束 as the whole set of them. The last
  // sentence is the one that stops this reading as a fault -- MLS は…渡しません
  // is flat present tense, a statement of how the protocol works, with nothing
  // apologetic in it. A translation that reached for 申し訳ありませんが here
  // would tell the reader the opposite of the truth.
  'chat.encryption.notYetReadable': 'これより前の履歴は、この端末では読めません。ミラーされた履歴は復旧用の鍵束とともに戻ります。MLS は古いメッセージを新しい端末に渡しません。',

  // -------------------------------------------------------------- the header chip
  //
  // One pill beside a channel name on a phone. A CJK glyph is about twice the
  // width of a Latin letter, so English's "two words at the very most" becomes
  // "five glyphs at the very most" here, and every entry below is four or five.

  // 体言止め, a noun phrase: 鍵の変更, "a key change". 鍵が変わりました is the
  // sentence and is eight glyphs, which is a pill that pushes the channel name
  // off a phone. Named for the meaning rather than the mechanism, as English
  // requires -- 鍵エスクロー中 would be accurate and would tell a reader nothing.
  'chat.encryption.chip.keyChanged': '鍵の変更',
  // A relative clause used as a label, with no です. This is the one thing a
  // reader needs off a glance and it says it in six glyphs: the server can read.
  'chat.encryption.chip.serverCanRead': 'サーバーが読める',
  // Katakana, because this is the term of art and Japanese security writing
  // borrows it whole. 端末間暗号化 is the native compound, is accurate, and is
  // six kanji -- wider than the katakana and less recognisable to the person who
  // has read about it anywhere else.
  'chat.encryption.chip.endToEnd': 'エンドツーエンド',
  'chat.encryption.chip.encrypted': '暗号化済み',

  // English gets away with a bare adjective ("# unverified") because the noun is
  // understood; Japanese cannot, because the number has nowhere to attach
  // without a counter. So the devices English left implicit are named by 台,
  // which is what the number is actually counting. 未確認 rather than 未検証:
  // 検証 is what a test suite does to a build, 確認 is what a person does to
  // another person's device, and `security.js` will need the same word.
  'chat.encryption.chip.unverified': '{count, plural, other {未確認#台}}',

  // The accessible name, which is neither the visible word nor the paragraph in
  // the tooltip: it is what pressing the thing does. 体言止め, because that is
  // how a Japanese control announces itself.
  'chat.encryption.chip.open': '暗号化の詳細',

  // Identical to `changedIdentity.title` plus `.body` run together, because a
  // `title` attribute is one string and the banner and the tooltip must not tell
  // two stories. こう見えます twice, once for each reading, which is how Japanese
  // says "looks like this; so does" -- the language has no elliptical "so does",
  // so both halves state the verb and the parallelism carries the refusal to
  // choose between them.
  'chat.encryption.chip.keyChangedTooltip': 'ここにいる誰かが別のアカウント鍵を使っています。鍵をリセットしたときもこう見えますし、なりすましでもこう見えます。信頼する前に、もう一度確認してください。',

  // ------------------------------------------------------------------ the banners
  //
  // A headline that has to be read and a line that only has to be there. Each
  // title is a complete claim on its own and ends in 。, exactly as the English
  // ones end in a full stop -- these are not one sentence cut across two type
  // sizes, and a translator rebalancing which fact sits in which must keep both
  // halves whole.

  'chat.encryption.unavailable.title': 'この端末では暗号化を利用できません。',
  // プライベートブラウジング is the katakana every browser's Japanese UI uses for
  // this mode; シークレットモード is Chrome's name for it specifically and would
  // be wrong on Safari. 通常のウィンドウなら動作します names the fix, which is
  // the whole reason the body exists.
  'chat.encryption.unavailable.body': 'プライベートブラウジングではローカルの鍵ストアを使えません。通常のウィンドウなら動作します。',

  'chat.encryption.awaiting.title': 'この端末からはまだここに送信できません。',
  // Split into three sentences where English used two clauses and a comma. The
  // middle fact -- that your own other devices count -- is a sentence of its own
  // (あなた自身の別の端末でもかまいません) rather than a trailing "including
  // another of your own", because a Japanese trailing 〜も含みます attaches to
  // whatever noun it follows and would have read as a qualification of 会話
  // rather than of 端末. A reader who thinks only other people can help waits
  // instead of opening their laptop, which is the failure this clause prevents.
  'chat.encryption.awaiting.body': 'この端末は参加を要求しました。すでにこの会話に参加している端末がそれを開くと承認されます。あなた自身の別の端末でもかまいません。上に表示されているメッセージは、あなた自身の履歴から表示しています。',

  // まだ誰にも届いていません, "has not yet reached anybody". The title has to be
  // the complete claim, and the complete claim is about the *request* not having
  // arrived, not about nobody having answered -- telling somebody to wait for a
  // peer who was never told is the failure this banner exists to prevent.
  'chat.encryption.rejoinUndeliverable.title': 'この端末を参加させる要求は、まだ誰にも届いていません。',
  // ため puts the cause first, which is the order Japanese takes a cause and a
  // consequence in, and is the reverse of English's "…, so the request never
  // left". 送り出されていません, the resultative: the request is not in flight,
  // now, which is a state rather than a past event.
  'chat.encryption.rejoinUndeliverable.body': 'この会話の順序を決めるサーバーに接続できないため、要求は送り出されていません。やり直すと、まだ接続できる全員に新しいグループができます。',

  'chat.encryption.changedIdentity.title': 'ここにいる誰かが別のアカウント鍵を使っています。',
  // なりすまし, the native noun for impersonation, and it is not softened into
  // 第三者の可能性 or anything hedged. The English refuses to choose between the
  // two readings and so does this: both are stated, in the same shape, in the
  // order of likelihood.
  'chat.encryption.changedIdentity.body': '鍵をリセットしたときもこう見えますし、なりすましでもこう見えます。信頼する前に、もう一度確認してください。',

  'chat.encryption.vaultLocked.title': '以前のメッセージは、この端末ではロックされています。',
  // 設定 →「{pane}」 -- see the section note on why the pane name is a
  // placeholder. 元に戻せます at the tail, where Japanese puts the outcome; English
  // leads with the instruction and trails "to get them back".
  'chat.encryption.vaultLocked.body': '設定 →「{pane}」で復旧パスフレーズを入力すると、元に戻せます。',

  'chat.encryption.deviceApproval.title': 'この端末にはまだあなたの鍵がありません。',
  // 端末どうしの間を直接 is the claim about *where the keys go*, and it is the
  // reason approving from another device is safe. It is not decoration and is not
  // reduced to 鍵がコピーされます, which would say nothing about the path.
  'chat.encryption.deviceApproval.body': 'すでに使っている端末から承認してください。鍵はあなたの端末どうしの間を直接やり取りされます。',

  // The state that most looks like a failure and is not one. 〜ませんでした, flat
  // past: sign-in happened, the unlock did not.
  'chat.encryption.recoveryFallback.title': 'サインインしても、以前のメッセージのロックは解除されませんでした。',
  // Two ways out, in the order of what they cost, joined with 〜するか which is
  // the Japanese alternative-conjunction and keeps both options in one sentence
  // the way English's "or" does.
  'chat.encryption.recoveryFallback.body': '設定 →「{pane}」で復旧パスフレーズを入力するか、すでに使っている端末からこの端末を承認してください。',

  'chat.encryption.syncFailed.title': 'この端末では暗号化の同期がずれています。',
  // 保留されます, "are being held back", which is deliberately not 届いていません
  // -- the fear this banner answers is that messages are being lost, and 保留
  // says they are waiting somewhere on purpose. 鍵スケジュール is the MLS term,
  // half kanji and half katakana because that is how the Japanese cryptography
  // literature writes it.
  'chat.encryption.syncFailed.body': 'Telium が MLS の鍵スケジュールを再試行する間、新しいメッセージは保留されます。',

  // Not `common.retry` (もう一度試す), which is a generic offer; this one names
  // what will be retried, and 同期 has to be in the label because the button sits
  // under a banner about several things at once.
  'chat.encryption.retrySync': '同期をやり直す',

  // ------------------------------------------------------------- starting over
  //
  // The last resort, offered as what it is. Two presses: the first arms it, the
  // second does it.

  'chat.encryption.startOver.arm': '会話をやり直す',
  // The verb is repeated inside the confirmation rather than reduced to はい,
  // which is exactly English's rule and matters more in Japanese, where はい on
  // its own is the most reflexive word in the language. Politeness stops at ます
  // and goes no further: this destroys history, and 〜いたします or 〜いただけます
  // here would be a shop being gracious about an irreversible act.
  'chat.encryption.startOver.confirm': 'はい、やり直します',

  // 二度と開けません, flat and absolute. Not 開けなくなる場合があります, which is
  // the reflex hedge in Japanese and is the softening the English comment
  // forbids: the history in this conversation stays closed forever, on every
  // device, and the sentence says so. No reassurance is added after it.
  'chat.encryption.startOver.warning': '全員に新しいグループができます。それより前に話した内容は二度と開けません。',

  'chat.encryption.startOver.done': 'やり直しました。ここでの新しいメッセージはまた読めます。',

  // One arm. English's two arms are identical to each other, which is what the
  // English comment says they are for -- a language that inflects for one versus
  // several has somewhere to put it. Japanese does not inflect for number at all,
  // so `other` carries every case and `{names}`, already joined by
  // `Intl.ListFormat` in the reader's own language, is dropped in with ASCII
  // spaces because it may hold Latin identifiers. No 、 or と is added around it:
  // the list already has its own separators and adding more would double them.
  'chat.encryption.startOver.partial': '{count, plural, other {やり直しましたが、{names} をまだ追加できていません。}}',

  'chat.encryption.startOver.failed': '会話をやり直せませんでした',

  // -------------------------------------------------------------- invite cards

  // Identical to `roles.memberCount` already in this file, deliberately: one
  // count of members should read the same everywhere in the client. 人 and not
  // 名 -- 名 is the counter a registry or a guest list uses and is faintly
  // formal, 人 is what a count of people in a room is.
  'chat.invite.members': '{count, plural, other {メンバー#人}}',
  // The placeholder moves to the head, and this is the entry where English
  // reading order stops applying hardest. English trails the host in a
  // prepositional phrase ("… on {domain}"); Japanese has no postposed modifier
  // of that shape, so the host becomes a prenominal の-phrase and ends up before
  // the count it qualifies. The count-and-a-dash-and-the-domain version this
  // entry replaced could not have been rearranged at all.
  'chat.invite.membersOnHost': '{count, plural, other {{domain} のメンバー#人}}',

  // {guild} is a name somebody chose, in any script: moved, never translated,
  // ASCII-spaced.
  'chat.invite.join': '{guild} に参加',
  'chat.invite.joinUnnamed': '参加',

  // --------------------------------------------------------------- the surface

  // {target} arrives already decorated -- `#general` for a text channel, the bare
  // name for a thread -- so the `#` sigil is inside the value and never inside
  // this pattern. The verb goes last, which is why the placeholder that English
  // puts at the end sits at the head here: this is the reversal that made the
  // old `'Message ' + name` unreachable, and the regex in `Composer.jsx` that
  // used to strip `/^Message\s*/` off this very string would have matched
  // nothing at all in Japanese and named the drop target after a fragment.
  'chat.surface.placeholder': '{target} にメッセージを送信',
  // The same imperative with nothing to address it to. Not the pattern with an
  // empty slot: Japanese would leave a stranded に at the head of the line.
  'chat.surface.placeholderPlain': 'メッセージを送信',

  // Both machines are named, as English requires. 複製 for "a copy" rather than
  // コピー, which in this catalogue is the clipboard verb (`common.copy`) and
  // would read as something the reader did. The consequence goes last where
  // Japanese wants it, and the two hostnames keep ASCII spaces because they are
  // Latin runs.
  'chat.surface.standby': '{home} が応答していません。今読んでいるのは {standby} が保持している複製で、新しいメッセージは受け付けられません。',
  // Three refusals, three speakers, three registers -- a room's rule, a
  // moderator's decision about you, and the permission system -- and each names
  // the cause rather than only the effect. モデレーター, katakana, which is what
  // `guild.*` above uses throughout.
  'chat.surface.threadLocked': 'このスレッドはロックされています。ここに投稿できるのはモデレーターだけです。',
  // タイムアウト中, the katakana, because it names this product's mechanism and a
  // moderator reading the guild pane meets the same word there. 読むことはできま
  // すが、投稿はできません is the Japanese permitted/forbidden pair, which states
  // both verbs -- English elides the second one and Japanese cannot.
  'chat.surface.timedOut': 'あなたはこのギルドでタイムアウト中です。読むことはできますが、投稿はできません。',
  'chat.surface.noPermission': 'ここにメッセージを送信する権限がありません。',

  // The same three words as `chat.delivery.title.*`, and the duplication is
  // still right. English keeps them apart because several languages set a menu
  // row as a noun and a dialog title as a participle; Japanese sets both as
  // 体言止め, so the two happen to coincide here -- which is a fact about
  // Japanese and not a licence to collapse the keys. If either surface is ever
  // reworded, only one of them should move.
  'chat.surface.delivery.sent': '送信済み',
  'chat.surface.delivery.delivered': '配信済み',
  'chat.surface.delivery.read': '既読',

  // -------------------------------------------------------------- the composer

  // Every one of these is a `title` on a glyph button and is read aloud as well
  // as hovered, so each names the act and nothing else -- no ボタン, which is
  // the Japanese equivalent of the "button" the a11y note forbids.
  'chat.composer.attach': 'ファイルを添付',
  // その他の〜, matching `common.a11y.menu` (その他の操作) above, with メッセージ
  // added because this cluster is about the message rather than about the app.
  'chat.composer.moreActions': 'その他のメッセージ操作',
  // The sheet covers the screen and takes its context with it, so the title says
  // what the actions are about. の here where the label above compounds without
  // it: a sheet title is prose, a button tooltip is a compound.
  'chat.composer.actionSheet': 'メッセージの操作',
  // Left in English on purpose: GIF is the name of a file format, it is the face
  // drawn inside this button, and every GIF service on earth spells it this way.
  // ジフ would be a transliteration of an argument about pronunciation; 動画 is a
  // different thing. The English comment gives a translator the room to disagree
  // and this one does not take it.
  'chat.composer.gif': 'GIF',
  'chat.composer.emoji': '絵文字',
  'chat.composer.send': '送信',
  // キャンセル, matching `common.cancel` in this file, because this abandons a
  // state the reader entered rather than destroying anything -- the reply target
  // is dropped and the typed text stays.
  'chat.composer.cancelReply': '返信をキャンセル',

  // コピー is the same word as `common.copy` above and the duplicate key is kept
  // for the reason English gives: cut and copy are a matched set on a text box
  // and Japanese translates them as one (コピー / 切り取り), so a translator who
  // found one in `common` and the other here would be deciding half a pair in
  // each of two files. 切り取り, the noun form, because コピー is a noun and a
  // menu row of mismatched parts of speech reads as a mistake.
  'chat.composer.copy': 'コピー',
  'chat.composer.cut': '切り取り',

  // No 。 on either: these are the words the disabled button itself says, not
  // sentences addressed to anybody.
  'chat.composer.attachBlocked': 'ここにファイルを添付することはできません',
  // Names the server rather than a setting, because the reader can change
  // neither and アップロードが無効です would send them hunting through their own
  // preferences for a switch that is not there. アップロード先 for "upload host"
  // -- 先 is the Japanese suffix for the destination of an act, and it says
  // "where files go" in one glyph where ホスト would say "a machine".
  'chat.composer.noUploadHosts': 'ホームサーバーで外部のアップロード先が有効になっていません',
  // ：introduces the explanation, which is the one job Japanese ：genuinely has.
  // Stated as a fact about the guild and not about the reader -- 保留します with
  // the guild as the subject, not あなたのメッセージは保留されました, which would
  // read as a judgement passed on them. No ICU quoting worry here: the English
  // needed a typographic apostrophe for `members’`, and Japanese has no
  // apostrophe to escape.
  'chat.composer.heldForReview': 'モデレーターの確認待ちです：このギルドでは新しいメンバーの最初のメッセージを保留します。',

  // ------------------------------------------------------------- the formatting
  //
  // The names of marks, translated rather than left in English, because every
  // writing system has its own words for emphasis and this menu is the only
  // place the client ever teaches somebody these marks exist. The chord beside
  // each row (⌘B, Ctrl+E) is built by `chordHint` and has no catalogue entry, so
  // there is nothing here to get wrong about keycaps.

  'chat.format.bold': '太字',
  'chat.format.italic': '斜体',
  'chat.format.strike': '打ち消し線',
  // インラインコード, katakana for both halves, because they are both terms of
  // art from typesetting and programming and the native alternatives (行内, 符号)
  // name other things entirely.
  'chat.format.code': 'インラインコード',
  // 伏せ字 and not スポイラー, and this is the largest vocabulary decision in the
  // namespace. スポイラー exists in Japanese but has been fully captured by the
  // ネタバレ sense -- it names the *offence* of revealing a plot, so a menu row
  // reading スポイラー tells a reader what not to do rather than what the mark
  // does. 伏せ字 is the established typographic term for a run of text
  // deliberately covered over, which is exactly this mark, and it is three
  // glyphs on a menu where the katakana is five.
  'chat.format.spoiler': '伏せ字',
  'chat.format.block': 'コードブロック',
  // 引用, the glossary word, and the same 引用 the quote section uses for a
  // quoted message -- they are the same act and Japanese does not distinguish
  // the block mark from the thing it produces.
  'chat.format.quote': '引用',

  // --------------------------------------------------------- staged attachments

  // The bare verbs, for the tooltip a reader can already see the card behind.
  // 取り除く matches `common.remove` in this file rather than 削除: nothing is
  // deleted anywhere, the file is taken back out of the tray before it is sent.
  'chat.staged.preview': 'プレビュー',
  'chat.staged.rename': '名前を変更',
  'chat.staged.remove': '取り除く',
  // And the named forms, for the reader who cannot see which card is which. The
  // object comes first with を or の, so the filename leads every one of these --
  // the exact opposite end of the string from English, which is why a single key
  // with an optional suffix could never have served both.
  'chat.staged.previewOf': '{name} をプレビュー',
  'chat.staged.renameOf': '{name} の名前を変更',
  'chat.staged.removeOf': '{name} を取り除く',
  // 体言止め, ending in 中, because this is a progress bar's label and is
  // announced repeatedly while the bar moves. アップロードしています is the
  // sentence form and is four glyphs longer to hear every time the percentage
  // changes; 〜中 is what a Japanese progress indicator says.
  'chat.staged.uploadingOf': '{name} をアップロード中',
  // The sticker has no name to put in a label, so the bare verb is also the
  // accessible name. スタンプ per the glossary.
  'chat.staged.removeSticker': 'スタンプを取り除く',
  'chat.staged.closePreview': 'プレビューを閉じる',

  // ファイル名を変更 as the dialog title and 名前を変更 as its button: the title
  // names the field, the button names the act, and neither repeats the other --
  // which is the distinction English draws with "Rename file" / "Rename" and
  // which Japanese keeps by dropping ファイル rather than by shortening the verb.
  'chat.staged.renameTitle': 'ファイル名を変更',
  'chat.staged.renameLabel': 'ファイル名',
  'chat.staged.renameConfirm': '名前を変更',

  // 体言止め label over a select, in the shape `guild.overview.expiry.label`
  // above already settled: English's label opens a sentence the menu finishes
  // ("Keep files for" / "30 days"), and Japanese cannot do that because the
  // select sits to the right and the verb would have to come after the value.
  // So it becomes the noun phrase instead -- "the period files are kept for".
  'chat.staged.keepFor': 'ファイルを保持する期間',
  // The placeholder leads, because English's preposition "in" becomes the
  // postposition 後に and postpositions follow what they govern. {duration}
  // arrives already formatted by `chat.upload.limit*` below, so it is a phrase
  // like 30日 and nothing here may assume it is a bare numeral.
  'chat.staged.expiresIn': '{duration}後に期限切れ',
  // 体言止め again, because the chip holds an answer and not a sentence. Note it
  // is deliberately a different phrase from `chat.upload.expiryNever` (期限なし)
  // five entries down, even though both describe the same setting: this one is
  // the chip reporting a state and takes the verb-ish 保持, that one is the last
  // option in a menu of durations and takes the noun. `common.never`
  // (一度もありません) fits neither and is not used.
  'chat.staged.keepsForever': 'ずっと保持',
  // 遅くとも carries English's "at most": the rule is a ceiling and a file may go
  // sooner. Policy stated rather than inferred from a shorter menu, because
  // policy nobody knows about is policy that surprises somebody when a file
  // disappears.
  'chat.staged.cappedNote': 'ここに送信したファイルは、遅くとも{duration}後に削除されます。',

  // The article forms, and this is the case the English comment predicted for us
  // by name. English's `one` arm exists only to say "a day" instead of "1 day" --
  // the indefinite article is what makes the sentence read as a rule rather than
  // as a count. Japanese has no article, so that distinction has nowhere to live
  // and nothing is lost by its absence: 1日 in 遅くとも1日後に削除されます already
  // reads as a rule because 遅くとも made it one. One arm, numbered, and the
  // spans use the counters Japanese welds to a numeral -- these come out
  // character-for-character identical to `channel.duration.*` above, which is
  // the right kind of coincidence.
  'chat.staged.capDays': '{count, plural, other {#日}}',
  'chat.staged.capHours': '{count, plural, other {#時間}}',
  'chat.staged.capMinutes': '{count, plural, other {#分}}',

  'chat.staged.uploadHost': 'アップロード先',
  'chat.staged.noHosts': '外部のアップロード先が有効になっていません',
  // Both values are identifiers and neither is touched. What this entry is *for*
  // is the punctuation around them, and Japanese parentheses are full-width and
  // close up with no space on either side -- the ASCII pair with ASCII spacing
  // would open two Latin-width gaps in the middle of a Japanese row.
  'chat.staged.hostOption': '{name}（{domain}）',
  // The provider's policies, stated as the provider's. このホストが保存し puts
  // the host in the subject position, which is the fact the sentence exists to
  // establish: these bytes are not ours.
  'chat.staged.hostPolicy': 'ファイルはこのホストが保存し、そのホスト自身の保持ポリシーと不正利用ポリシーに従います。',
  // Ours, and always said. 公開URL with no space, per the acronym rule in the
  // glossary: URL is fused into the compound the way ID is in
  // `guild.overview.transfer.label`, where Telium stands alone and keeps its
  // spaces. 保護されません, flat -- not 保護されない場合があります, which is the
  // hedge that would let a sender think it is usually fine.
  'chat.staged.hostPublic': '外部へのアップロードは公開URLで、Telium のアクセス制御では保護されません。',

  // The drop overlay's two lines, which were never one sentence. この会話 stands
  // where a room's name would stand; English marks that with lower case and an
  // article, Japanese with the demonstrative この and no particle.
  'chat.staged.dropTargetFallback': 'この会話',
  // ドロップしてアップロード -- the て-form chains the gesture to its result, which
  // is how Japanese writes an instruction of this shape. 体言止め at the end,
  // because this is an overlay caption and not a sentence.
  'chat.staged.dropLine': 'ドロップしてアップロード',

  'chat.staged.uploadFailed': '{name} をアップロードできませんでした',
  'chat.staged.tooLarge': '大きすぎます — ここでは添付ファイルは {limit} までです。',

  // ---------------------------------------------------------------- expiry units

  // Fixed strings. Japanese counts spans with dedicated counters welded to the
  // numeral, so these are among the shortest entries in the catalogue -- and
  // 週間 rather than 週, because 1週 is a point in a sequence (week one) and
  // 1週間 is a span of seven days, which is what an expiry is. Identical to
  // `guild.duration.*` above, which is correct: the same durations offered in two
  // panes should read the same in both.
  //
  // `chat.upload.expiryMonth`（30日）は削除された。あの 30 は日本語の事実では
  // なく `lib/upload.js` の `30 * 24 * 60 * 60` を四つのカタログに手で写した
  // ものだった。プリセットは自分の秒数から `chat.upload.limitDays` 経由で
  // 書き出されるようになり、画面には従来どおり 30日 と出る。
  'chat.upload.expiryHour': '1時間',
  'chat.upload.expiryDay': '1日',
  'chat.upload.expiryWeek': '1週間',
  // 期限なし, the last of five durations, and deliberately not `common.never`
  // (一度もありません) which is an adverb about frequency and would be nonsense in
  // a list of spans. Nor `guild.duration.unlimited` (上限なし), which is about a
  // ceiling on a number rather than about an expiry -- the English comment asks
  // for a word that ends a list of durations, and 期限なし is exactly that.
  'chat.upload.expiryNever': '期限なし',

  // The derived cap, in human units. Character-for-character identical to
  // `chat.staged.cap*` above, because in Japanese they genuinely are the same
  // string: English keeps two sets because one of them needs indefinite articles
  // and the other needs numerals, and Japanese has neither distinction. The keys
  // stay separate anyway -- the English can diverge again, and when it does only
  // one of these should move.
  'chat.upload.limitDays': '{count, plural, other {#日}}',
  'chat.upload.limitHours': '{count, plural, other {#時間}}',
  'chat.upload.limitMinutes': '{count, plural, other {#分}}',

  // 取得 for "fetch", which is the word Japanese uses for pulling bytes off a
  // network and is distinct from 受け取る (to receive) and ダウンロード (a file
  // the reader asked for). The unnamed form is a whole sentence of its own rather
  // than the named one with the slot emptied, for the reason the English comment
  // gives: 添付ファイル is a common noun that needs を in front of the verb, and
  // there is no spelling of this that works with and without a name.
  'chat.upload.fetchFailedNamed': '{name} を取得できませんでした',
  'chat.upload.fetchFailed': '添付ファイルを取得できませんでした',

  // ------------------------------------------------------------ the autocomplete

  // What pressing Enter will set off, not what the row already says. 全体 is the
  // word that makes it the whole channel rather than the people currently
  // looking at it. `@everyone` and `@here` are the literal text that goes into
  // the message and the server matches on -- they never appear in this string and
  // must never be translated where they do.
  'chat.autocomplete.notifyChannel': 'チャンネル全体に通知',
  'chat.autocomplete.role': 'ロール',
  // カスタム, katakana, matching `guild.expressions.*` above (カスタムアイコン,
  // カスタム絵文字). The guild is not named in the local case because naming it
  // would be telling the reader where they already are.
  'chat.autocomplete.emojiCustom': 'カスタム',
  'chat.autocomplete.emojiFrom': '{guild} の絵文字',
  // Fills a slot where a proper name goes, so it is a noun phrase and not a
  // description. English marks that with a capital; Japanese has no case, so the
  // marker is that it reads as a name: 別のギルド rather than ほかのギルドから
  // ("from some other guild"), which would read as prose.
  //
  // サーバー ではなく ギルド。英語が "Other server" と書いていたのをそのまま
  // 写していたが、この断片が埋めるのは一つ上の `emojiFrom` と同じ穴で、そこに
  // 入るのはギルド名である。Telium ではギルドは部屋、サーバーはそれを載せて
  // いるホームサーバーで、一台が多くのギルドを載せる。英語の鍵名も値も直った。
  'chat.autocomplete.otherGuild': '別のギルド',
  // A whole statement, because it replaces the rows rather than sitting above
  // them. 読み込んでいます… would be wrong -- this is a query going out, not a
  // fetch of something already identified.
  //
  // ここも サーバー ではなく ギルド。裏で走るのは `api.members(guildId, …)` で、
  // 検索しているのは一つのギルドの参加者一覧である。ホームサーバーに尋ねては
  // いるが、尋ねる先と探している場所は別のものだ。
  'chat.autocomplete.searching': 'このギルドを検索しています…',

  // The slash form is notation and survives intact; both numerals are already
  // bidi-isolated by `stringify`, so nothing here needs marks of its own. 人
  // welds to {limit} with no space, because a counter always does -- the ASCII
  // space this file puts around Latin runs is suspended exactly here, and that is
  // the rule rather than an exception: a counter is part of the number.
  //
  // The reversal is total. English trails "in voice" after the figures; Japanese
  // takes ボイスに at the head and leaves the figures at the tail, so the two
  // halves of this line swap ends. 体言止め, because it is the second line of a
  // row and not a sentence.
  'chat.autocomplete.voiceHereOfLimit': 'ボイスに {count}/{limit}人',
  // One arm. English's two exist only because "person" and "people" differ;
  // メンバー-less 人 is the counter at any count, so the distinction dissolves
  // with nothing lost -- English's singular carried no information here beyond
  // agreement.
  'chat.autocomplete.voiceHere': '{count, plural, other {ボイスに#人}}',
  // 最大, "at most", leading -- where English's "Up to" also leads, which is the
  // one place in this section the two languages agree on position.
  'chat.autocomplete.voiceLimit': '{limit, plural, other {最大#人}}',

  // ------------------------------------------------------------------ forwarding

  // Two acts, two words, and Japanese is one of the languages the English comment
  // says cannot get away with one: 転送 moves a message you are reading onward,
  // 共有 is the operating system handing this app something from outside. Using
  // 共有 for both would make the share sheet look like it was forwarding
  // something the reader had not seen.
  'chat.forward.title': 'メッセージを転送',
  // Telium in Latin, per the catalogue's rule for product names, with ASCII
  // spaces around it.
  'chat.forward.shareTitle': 'Telium に共有',
  'chat.forward.search': 'チャンネルと会話を検索',
  // The two pills for destinations that have no name to show. ダイレクトメッセージ
  // spelled out here rather than DM, which the encryption paragraphs use: a pill
  // naming a *kind* of destination should name the kind, and it has room to once,
  // where a paragraph saying it three times does not. Same word either way to a
  // Japanese reader.
  'chat.forward.groupChat': 'グループチャット',
  'chat.forward.directMessage': 'ダイレクトメッセージ',
  // 送信, not 保存: this dispatches a copy somewhere. Same word as
  // `chat.composer.send`, which is right -- it is the same act from a different
  // box.
  'chat.forward.send': '送信',
  // The sentence form here where `chat.message.sending` uses 送信中…, and the
  // difference is the slot: that one squeezes into the gutter where a timestamp
  // goes, this one is a button label with a button's worth of room. Matches
  // `common.saving` (保存しています…) in shape, including the single ellipsis
  // character.
  'chat.forward.sending': '送信しています…',
  'chat.forward.failed': '転送できませんでした',
  'chat.forward.shareFailed': '共有できませんでした',
  // The corner brackets are why this entry has quotation marks inside the
  // pattern at all: 「」 is the Japanese quotation pair, the English curly quotes
  // are neither these nor the German pair, and a component that drew them would
  // have chosen somebody else's typography for every language at once. No space
  // between the closing bracket and に -- full-width punctuation never takes one.
  'chat.forward.noMatches': '「{query}」に一致するものはありません。',

  // ------------------------------------------------------------- the media card
  //
  // Almost everything here is read by somebody who cannot see the picture. The
  // filename is never glued to a word: every entry takes it as a placeholder and
  // hands the surrounding sentence to the translator, because the code that used
  // to assemble these read them back apart with `label.endsWith(' audio')`, and
  // in Japanese there is not even a space for that test to find.

  // Bare noun phrases, with no trailing punctuation, because both are
  // interpolated into the seven patterns below as `{label}` -- a full stop here
  // would land in the middle of 「… を再生」. の rather than a space, which is how
  // Japanese attaches a name to the kind of thing it names.
  //
  // 音声 and 動画, both native. オーディオ and ビデオ exist as loanwords and both
  // name equipment rather than content to a Japanese reader: ビデオ is a tape or a
  // camera, 動画 is the moving picture itself, and a screen reader saying
  // 「holiday.mp4 の動画」 is saying the right one.
  'chat.player.audioOf': '{name} の音声',
  'chat.player.videoOf': '{name} の動画',

  // A verb and its object, seven times, with the object marked by を or の. This
  // is exactly why they are seven patterns rather than one verb concatenated onto
  // `{label}` at seven call sites: Japanese needs a case particle between the two
  // and which particle it is depends on the verb -- を for the four that act on
  // the thing, の for the two that name a property of it.
  'chat.player.play': '{label} を再生',
  'chat.player.pause': '{label} を一時停止',
  // 再生位置, "playback position", rather than シーク. シーク is the katakana
  // borrowing and names nothing to anybody who has not used a video editor; the
  // control is a scrubber, and 再生位置 is what a Japanese player labels it. A
  // screen-reader user hearing 「{label} の再生位置」 knows what the slider under
  // their cursor does, which is the entire job of this string.
  'chat.player.seek': '{label} の再生位置',
  'chat.player.mute': '{label} をミュート',
  // Japanese has no un- prefix: the opposite of ミュートする is ミュートを解除する,
  // which restructures the phrase rather than prefixing it. の, not を, because
  // what is being undone is the mute and not the video.
  'chat.player.unmute': '{label} のミュートを解除',
  'chat.player.volume': '{label} の音量',
  'chat.player.fullscreen': '{label} を全画面表示',

  // The spaced em dash is kept rather than converted to 。, and that is a
  // deliberate reversal of what `chat.ephemeral.mark` did: there the dash joined
  // two independent statements, here it introduces the one thing left to do
  // about the first clause, and this catalogue already writes that relationship
  // with a spaced em dash (`errors.quota_exceeded` above). てください on both,
  // because both halves are offers of an action.
  'chat.player.failedSave': '再生できませんでした — 元のファイルを保存してください',
  'chat.player.failedOpen': '再生できませんでした — 元のファイルを開いてください',

  // 保存 matches `common.save`. The bare form and the named forms are three
  // entries rather than one with an optional object, because Japanese needs を
  // between the filename and the verb and the bare imperative has nothing for it
  // to attach to.
  'chat.attachment.save': '保存',
  'chat.attachment.saveNamed': '{name} を保存',
  'chat.attachment.openNamed': '{name} を開く',

  // The placeholder sits in the middle of the sentence rather than at either
  // edge, which is what the English comment asks for and which Japanese can
  // actually deliver: the copula follows the noun, so ホスト元は {host} です puts
  // a Latin hostname between two Japanese runs with a full ASCII space on each
  // side. English could not do this -- "Hosted on {host}" has nowhere to put
  // anything after the host. ホスト元 rather than bare ホスト, matching
  // `guild.hostedBy` above, because bare ホスト reads as the hostname itself.
  'chat.attachment.hostedOn': 'ホスト元は {host} です',

  // Four descriptions of an absence, standing where a filename or a domain would
  // have gone. English marks them as descriptions with lower case; Japanese has
  // no case, so 体言止め and the demonstrative-free bare noun do the same work.
  // 不明な〜 matches `common.unknown` (不明) already in this file.
  'chat.attachment.unnamed': '添付ファイル',
  'chat.attachment.externalMedia': '外部のメディア',
  'chat.attachment.externalHost': '外部のホスト',
  'chat.attachment.unknownHost': '不明なホスト',

  // The named and unnamed forms are separate sentences, for the reason the
  // English comment sets out and which it names Japanese in: English can put a
  // capitalised noun where an interpolated filename goes because casing does the
  // work, and Japanese has no casing and would rather mark the topic. を保存しま
  // した for the named one, を with the object; 添付ファイルを保存しました for the
  // unnamed one, which is the same shape but with a common noun in the slot.
  'chat.attachment.saved': '{name} を保存しました。',
  'chat.attachment.savedUnnamed': '添付ファイルを保存しました。',
  // A context phrase, so no 。, matching every other `*Failed` in the file.
  'chat.attachment.saveFailed': '添付ファイルを保存できませんでした',

  // The entry the English comment cites as its own example, and it is right: the
  // verb goes last in Japanese, so 「{provider} で開く」 is unreachable from a
  // sentence that ends where English ends. で and not を -- the provider is where
  // the file opens, not the thing being opened.
  'chat.attachment.openOnProvider': '{provider} で開く',
  // を here, because the thing that could not be opened *is* the provider's page.
  'chat.attachment.openProviderFailed': '{provider} を開けませんでした',

  // Two spinner captions in the corner where a file size sits. 〜中 with the
  // single U+2026 ellipsis, which is the shortest form Japanese has and the one a
  // progress caption uses; 準備しています… is the sentence and is twice the width
  // in a slot that has none. English signals the same thing with lower case.
  'chat.attachment.preparing': '準備中…',
  // 復号, the cryptographic term, not 解読 (which is what a codebreaker does to
  // somebody else's message) and not 復号化 (a malformation common in Japanese
  // software writing: 復号 is already the verb).
  'chat.attachment.decrypting': '復号中…',

  // Split for the same reason `saved` is split, and 復号 again for the same reason
  // as above.
  'chat.attachment.decryptFailed': '{name} を復号できませんでした',
  'chat.attachment.decryptFailedUnnamed': 'この添付ファイルは復号できませんでした',

  // ------------------------------------------------------------------ the picture

  // The noun that stands in for a picture nobody named. It stands alone in `alt`,
  // so English writes it as a caption is written -- capitalised -- and that
  // capital is the whole reason the zoom control below is two entries rather
  // than one.
  'chat.image.untitled': '画像',
  // The unnamed form has the noun written into it rather than interpolating
  // `untitled`, because a pattern cannot recase what it interpolates: English
  // needs Image capitalised in `alt` and lower-cased mid-sentence, and a caller
  // that lowercased it first would corrupt German to flatter English. The
  // English comment says what a language with no letter case should do about
  // that, and this is it -- Japanese writes the same word twice and loses
  // nothing, because 画像 is 画像 in both slots and the duplication costs three
  // glyphs and no meaning.
  'chat.image.viewLarger': '画像を拡大表示',
  // The named form takes a real caption instead. It leads, because を marks the
  // object and the verb closes the sentence -- English wraps its placeholder
  // between "View" and "larger", and there is no arrangement of Japanese that
  // puts anything at all after 拡大表示.
  'chat.image.viewLargerNamed': '{label} を拡大表示',
  'chat.image.preview': '画像プレビュー',
  'chat.image.close': '画像プレビューを閉じる',
  'chat.image.save': '保存',
  // 元の画像, "the original image", where English says only "Open original". The
  // noun is supplied because Japanese has no bare nominalised adjective of that
  // shape -- 元を開く would be a sentence about a source or an origin.
  'chat.image.openOriginal': '元の画像を開く',

  // -------------------------------------------------------------- the GIF picker
  //
  // GIF stays GIF in this catalogue, in every string below. It is the name of the
  // format, it is the face drawn on the composer's button, and Japanese writes
  // file formats in Latin capitals universally -- ジフ is a transliteration of an
  // argument about how to pronounce it and 動画 is a different thing. ASCII
  // spaces on both sides wherever it stands alone in a Japanese sentence, which
  // is the Latin-run rule from the glossary.

  'chat.gif.search': 'GIF を検索',
  'chat.gif.results': 'GIF の検索結果',
  // ピッカー, katakana, matching `chat.emoji.picker` below. 選択ツール is the
  // native compound and names a tool rather than a panel.
  'chat.gif.picker': 'GIF ピッカー',
  // Left in English on purpose: format name, and a dialog title with nothing to
  // add to it. English's plural "-s" disappears, which costs nothing -- Japanese
  // does not mark number and the dialog holds the same thing whether it shows one
  // or a thousand.
  'chat.gif.dialogTitle': 'GIF',
  // Left in English on purpose: format name. This one fills the `{title}` slot in
  // `chat.gif.send` when the provider gave the GIF no title of its own, so it has
  // to read as a noun inside 「… を送信」, and GIF does.
  'chat.gif.untitled': 'GIF',

  // トレンド, katakana, which is the word a Japanese picker's chip uses for this.
  // 急上昇 was the alternative -- it is what YouTube's Japanese interface calls
  // its trending tab -- and it names a *rate of change*, which is a stronger and
  // narrower claim than the provider is making. 人気 would claim popularity
  // outright and drop English's "right now".
  'chat.gif.trending': 'トレンド',
  // お気に入り on all three, so the chip and the star describe the reader's list
  // by one name. Japanese has no un- prefix, so 外す ("take off") does the work of
  // "unfavorite" -- the same restructuring as ミュートを解除 above.
  'chat.gif.favorites': 'お気に入り',
  'chat.gif.favorite': 'GIF をお気に入りに追加',
  'chat.gif.unfavorite': 'GIF をお気に入りから外す',

  // {title} is whatever the provider called it, usually English, occasionally
  // `chat.gif.untitled`. を送信 at the tail either way.
  'chat.gif.send': '{title} を送信',

  // The first two are about this server's configuration and are stated as facts,
  // because there is nothing to do about either from inside the picker. このサー
  // バーでは leads, where English trails "by this server": Japanese puts the
  // frame of reference at the head of the sentence.
  'chat.gif.disabled': 'このサーバーでは GIF 検索が無効になっています。',
  'chat.gif.notConfigured': 'GIF 検索はまだ設定されていません。',
  'chat.gif.loadFailed': 'GIF を読み込めませんでした。',
  'chat.gif.loading': 'GIF を読み込んでいます…',
  // 星を付ける, the verb Japanese uses for starring something, which is not the
  // same word as お気に入り and should not be -- the star is the gesture and the
  // favourites list is the place, exactly as in English.
  'chat.gif.favoritesEmpty': 'GIF に星を付けると、ここに残ります。',
  'chat.gif.noMatches': '一致するものはありませんでした。',

  // {provider} is Tenor, Giphy or Klipy: company names, never translated, always
  // interpolated with ASCII spaces. The GIF comes second because Japanese puts
  // the location adverbial before the object.
  'chat.gif.openOn': '{provider} で GIF を開く',
  // The spaced em dash again, in the `chat.player.failed*` shape and for the same
  // reason: a statement and the one thing left to do about it.
  'chat.gif.unavailable': 'GIF を表示できません — 直接開いてください',

  // The category chips.
  //
  // Only the caption is translated: the query actually sent to the provider lives
  // in `CATEGORIES` in `GifPicker.jsx` and stays English, because Klipy, Tenor
  // and Giphy index against English tags and a translated query would return an
  // empty grid. That frees these entirely -- they do not have to be translations
  // of the English word, only the right caption for a chip that returns those
  // GIFs, and the English comment says so explicitly for the gesture ones.
  //
  // Which matters most for the three gestures. A thumbs-up in Japan is the Like,
  // and いいね is both the gesture and the button; 親指を立てる is an anatomical
  // description nobody would tap. A facepalm and a shrug are Western gestures
  // that Japanese readers recognise on sight and have no native name for, so both
  // chips name the *feeling* instead -- 呆れる for the exasperation a facepalm
  // performs, やれやれ for the resigned "oh, well" a shrug performs, which is an
  // interjection rather than a noun and is precisely what the English comment
  // invites ("a loanword or even an emoticon").
  'chat.gif.category.reactions': 'リアクション',
  'chat.gif.category.happy': 'うれしい',
  'chat.gif.category.cry': '泣く',
  'chat.gif.category.love': '好き',
  'chat.gif.category.dance': 'ダンス',
  'chat.gif.category.cats': '猫',
  'chat.gif.category.dogs': '犬',
  'chat.gif.category.thumbsUp': 'いいね',
  'chat.gif.category.facepalm': '呆れる',
  'chat.gif.category.applause': '拍手',
  'chat.gif.category.shrug': 'やれやれ',
  'chat.gif.category.excited': 'わくわく',

  // ------------------------------------------------------------ the emoji picker
  //
  // The names of the emoji themselves are not here: they come out of the Unicode
  // dataset the picker lazy-loads, they are English, and they stay English until
  // that dataset ships a localised build. The shortcode beside each name
  // (`:grinning:`) is input syntax rather than a word, is matched literally by
  // the composer, and never moves in any language.

  'chat.emoji.search': '絵文字を検索',
  'chat.emoji.grid': '絵文字',
  'chat.emoji.picker': '絵文字ピッカー',
  'chat.emoji.dialogTitle': '絵文字',
  // カテゴリ per the glossary, with の because this is prose naming a thing rather
  // than a compound label.
  'chat.emoji.categories': '絵文字のカテゴリ',

  // 選んでください, てください, because it is an instruction to the reader and is
  // written back into the same element on every pointer move. The only imperative
  // in the section.
  'chat.emoji.hint': '絵文字を選んでください。',

  // Two genuinely different waits, and the second says what is being waited on --
  // somebody watching it for a while is waiting on their guilds' servers, not on
  // this client. スタンプ per the glossary.
  'chat.emoji.loading': '絵文字を読み込んでいます…',
  'chat.emoji.loadingCustom': 'カスタム絵文字とスタンプを読み込んでいます…',

  'chat.emoji.noMatches': '一致する絵文字はありません。',
  // 「最近使用」 in corner brackets, quoting the rail tab by its exact label --
  // which means this string and `chat.emoji.group.recent` below must move
  // together or the sentence sends a reader looking for a tab that is no longer
  // called that. The brackets are what makes it read as a label rather than as
  // prose, which is the job English does with a capital R it does not otherwise
  // need.
  'chat.emoji.empty': 'まだ何もありません。選んだ絵文字は「最近使用」に表示されます。',

  // The quotation marks are inside the pattern, and 「」 is why: English curly
  // quotes are neither the Japanese corner brackets nor the Arabic pair, and a
  // translator who cannot move them is stuck with somebody else's typography
  // around their own words. The の attaches directly to the closing bracket with
  // no space.
  'chat.emoji.results': '「{query}」の検索結果',
  'chat.emoji.stickerResults': 'スタンプ',
  'chat.emoji.savedStickers': '保存したスタンプ',

  // {guild} is a server name in any script, so it is never concatenated and the
  // の that attaches it is the translator's.
  'chat.emoji.guildEmoji': '{guild} の絵文字',
  'chat.emoji.guildStickers': '{guild} のスタンプ',
  'chat.emoji.saveSticker': 'スタンプを保存',
  // Again no un- prefix available: 保存を解除, "release the saving", which is the
  // same restructuring as ミュートを解除 and お気に入りから外す above. Three
  // different Japanese shapes for three English un- words, which is why none of
  // them could have been produced by a rule.
  'chat.emoji.unsaveSticker': 'スタンプの保存を解除',

  // Skin tone, and the entry where the English shape had to be abandoned.
  //
  // English composes an adjective with a noun: "Medium light skin tone". Japanese
  // cannot do that here with one glue, and the reason is grammatical rather than
  // stylistic: an い-adjective attaches to a noun bare (明るい肌の色) while a noun
  // attaches with の (既定の肌の色), and `{tone}` is sometimes one and sometimes
  // the other. Writing `{tone}の肌の色` breaks the five adjectives; writing
  // `{tone}肌の色` breaks 既定. There is no third glue.
  //
  // So `skinToneOf` becomes a label, a full-width colon and a value -- the shape
  // `errors.context` already uses at the top of this file -- which works with
  // every one of the six and reads correctly to a screen reader announcing a
  // swatch: 「肌の色：やや明るい」. The six below stay the plain adjectives a
  // Japanese reader meets in their own operating system's picker, which is what
  // the English comment asks for.
  'chat.emoji.skinTone': '肌の色',
  'chat.emoji.skinToneOf': '肌の色：{tone}',

  // 既定 per the glossary, and not a colour word: this is the yellow, tone-less
  // glyph, and 標準 would have suggested a standard skin colour, which is exactly
  // what English avoids by not naming one.
  'chat.emoji.tone.default': '既定',
  'chat.emoji.tone.light': '明るい',
  'chat.emoji.tone.mediumLight': 'やや明るい',
  'chat.emoji.tone.medium': '中間',
  'chat.emoji.tone.mediumDark': 'やや暗い',
  'chat.emoji.tone.dark': '暗い',

  // The category rail, shortened the way English shortens it -- the dataset calls
  // group 1 "Smileys & Emotion" and group 3 "Animals & Nature", and a rail of
  // ampersands is noise in any script.
  //
  // These follow the Japanese emoji picker the reader already has on their phone
  // (スマイリー, 人々, 自然, 食べ物, アクティビティ, 旅行, オブジェクト, 記号, 旗),
  // because the English comment says to match the local platform and because
  // somebody who has used the system picker will find the same rail here.
  // 顔文字 was rejected for スマイリー and it is the trap in this list: 顔文字 in
  // Japanese means the ASCII kaomoji tradition -- (・∀・) -- which is a different
  // thing entirely from the Unicode group, and a reader who tapped it would
  // expect text faces.
  //
  // 最近使用 is not a Unicode group: it is this reader's own history, and it is
  // the tab `chat.emoji.empty` above points at by name.
  'chat.emoji.group.recent': '最近使用',
  'chat.emoji.group.smileys': 'スマイリー',
  'chat.emoji.group.people': '人々',
  'chat.emoji.group.nature': '自然',
  'chat.emoji.group.food': '食べ物',
  'chat.emoji.group.travel': '旅行',
  'chat.emoji.group.activities': 'アクティビティ',
  'chat.emoji.group.objects': 'オブジェクト',
  'chat.emoji.group.symbols': '記号',
  'chat.emoji.group.flags': '旗',

  // ------------------------------------------------------------------- link cards

  'chat.embed.playVideo': '動画を再生',
  // The title leads and the separator disappears, which is what the English
  // comment says a language that would sooner lead with the title should do.
  // Japanese has the の-modifier to hang an arbitrary title off the noun it
  // qualifies, so 「{title} の動画を再生」 needs no colon at all -- and the colon
  // English used is English punctuation for introducing a stranger's Open Graph
  // title, not a fact about the sentence.
  'chat.embed.playVideoTitled': '{title} の動画を再生',

// ================================================================ voice (ja)
  //
  // ------------------------------------------------------------- the glossary
  //
  // The `guild` / `roles` / `channel` / `bots` fragments settled twenty-eight
  // words before this one was written and every one of them is used here
  // unchanged: **guild** ギルド, **channel** チャンネル, **member** メンバー,
  // **role** ロール, **invite** 招待, **emoji** 絵文字, **pin** ピン留め,
  // **default** 既定 (not デフォルト), **bot** ボット, **permission** 権限,
  // **category** カテゴリ, **thread** スレッド, **region** リージョン (not 地域,
  // which is a place on a map), **relay** リレー, **key** 鍵 (not キー, which is
  // a thing on a keyboard), **bitrate** ビットレート, **server** サーバー and
  // **browser** ブラウザー with the long vowel. Their counters are used too: 人
  // for people, 件 for rows in a list, 回 for repetitions, 秒/分/時間/日/週間
  // for spans. Their politeness is used too: plain です/ます, and a sentence
  // that disconnects something or refuses something stops there — no
  // 〜いただけます, no honorific, no softening clause bolted onto the end.
  //
  // Twenty-two more words had to be settled here, because this is the first
  // namespace in the Japanese catalogue that draws a call. Each is argued at the
  // entry where it first appears; this block is the index, so that the next
  // translator finds the argument instead of re-opening the question.
  //
  //   * **mute** ミュート and **deafen** スピーカーミュート. The hardest pair in
  //     the file and the one every other decision below has to live with. The
  //     argument is over `voice.bar.deafen` and it is long, because it has to be.
  //   * **call** 通話 — `voice.bar.disconnect`. Already in this file at
  //     `guild.voice.probe.reachable.body` (通話がつながる), so it was decided
  //     before this fragment existed and is simply honoured.
  //   * **voice** (the subsystem, not the sound) ボイス — `voice.bar.channel`,
  //     matching `perms.group.voice` (ボイスチャンネル) and `guild.nav.voice`.
  //   * **audio / sound** 音声 — `voice.stage.audioBlocked`. The distinction
  //     against ボイス is real and is kept everywhere: ボイス is the feature you
  //     join, 音声 is the sound that comes out of it.
  //   * **screen share** 画面共有 — `voice.bar.shareStart`. Native compound, not
  //     スクリーンシェア; `channel.type.voice.description` in this file already
  //     says 画面を共有する, so the verb was settled and the noun follows it.
  //   * **camera** カメラ, **microphone** マイク, **volume** 音量 — loanword,
  //     loanword, native word, and each one is simply the word Japanese uses.
  //   * **stage** — never appears. English names the surface in its key segments
  //     (`voice.stage.*`) and never once on screen, so Japanese needs no word for
  //     it and ステージ is deliberately not coined here.
  //   * **watch together** 一緒に見る — `voice.dock.watch`, and the feature's
  //     name wherever it is said.
  //   * **watch / view somebody's share** 視聴 — `voice.tile.watchGate`. A
  //     different act from 一緒に見る and kept lexically apart from it throughout.
  //   * **stream quality** 映像の画質 — `voice.quality.label`.
  //   * **frames a second** コマ数 — `voice.share.frameRate`.
  //   * **player** プレーヤー — `voice.watch.thePlayer`, with the JIS long vowel.
  //   * **position** (in a video) 再生位置 — `voice.watch.position`.
  //   * **noise suppression** ノイズ抑制 — `voice.devices.noise`。機能の名前。
  //     かつてはモデルを ノイズ除去モデル と呼び、英語の "suppression" と
  //     "cancellation" の揺れに 抑制／除去 で対応していたが、その揺れは英語側の
  //     誤りだった。区別すべきなのは機能とモデルで、モデルは **neural model**
  //     ニューラルモデル（下記）である。
  //   * **neural** ニューラル — `voice.devices.noiseNeural`.
  //   * **output** (audio sink) 出力 / 出力先 — `voice.devices.output`.
  //   * **audio hardware** オーディオ機器, against **this computer** 端末 —
  //     `voice.devices.title`.
  //   * **end to end** エンドツーエンド — `voice.stage.sealedNotice`.
  //   * **incoming call** 着信 — `voice.incoming.title`.
  //   * **pop out** 切り離す — `voice.tile.pip`, 四か所すべて。かつては
  //     `voice.screen.noPip` だけ ピクチャーインピクチャー としていたが、それは
  //     英語がそこだけ "picture in picture" と呼んでいたのを写したものだった。
  //     英語が一つの名前に統一されたので、この語彙も一つになった。
  //   * **fullscreen** 全画面表示 — `voice.screen.fullscreen`.
  //   * **grid** グリッド — `voice.tile.collapse`.
  //
  // Four pieces of voice jargon the rest of the client will eventually need are
  // settled here too even though no key below uses them, because the argument is
  // cheaper now than it will be when somebody is halfway through a settings pane:
  // **push-to-talk** プッシュ・トゥ・トーク (the term Japanese radio and Japanese
  // chat clients both use; 押して話す is a description, not a name),
  // **voice activity** 音声検出, **echo cancellation** エコー除去 (matching
  // ノイズ除去 rather than 抑制, since both are the DSP that removes a thing
  // rather than the setting that dampens it), **gain** 入力音量 (not ゲイン: a
  // slider a person drags is a volume, and ゲイン is what the engineer who built
  // it calls the same number). **jitter** ジッター, **packet loss** パケット損失
  // and **bandwidth** 帯域 likewise do not appear in these 226 keys —
  // `channel.voice.bitrateHint` above already uses 帯域 and settles the last one.
  //
  // Five rules hold across all 226 entries and are therefore not repeated on
  // each of them:
  //
  //   1. **One plural arm.** `Intl.PluralRules('ja')` returns `other` for every
  //      number there is, so the four counting keys below (`voice.incoming.groupSize`,
  //      `voice.room.inVoice`, `voice.room.watching`, `voice.watch.waitingForMany`)
  //      supply `other` and nothing else. A `one` arm is not harmless padding: it
  //      is an arm the runtime can never select and the coverage test rejects it.
  //      An `=0` arm would be a different animal entirely — `pluralBranch` in
  //      `format.js` tests exact values before it asks `Intl.PluralRules`
  //      anything, so `=0` is an outcome rather than a grammatical category and
  //      survives translation untouched. No English pattern in this namespace
  //      carries one; the contrast is written down anyway, because the moment one
  //      appears here somebody will delete it along with the `one` arm.
  //   2. **Counters.** 人 for people, in all four counting keys, because every
  //      one of them counts people. Japanese has no bare count of a noun: the
  //      number goes after the noun with a counter welded to it, which is why not
  //      one of these sentences could have been made by dropping a number into
  //      the English shape, and why losing English's singular loses nothing —
  //      its `one` arm was carrying agreement and nothing else.
  //   3. **Full-width punctuation** (。、（）：「」・), no space before it, and a
  //      single ASCII space on each side of a run of Latin letters or of a
  //      placeholder that will hold one. Numerals are the exception and close up
  //      against the kanji beside them, the way Japanese typesetting does it.
  //      That is the spacing `errors.too_large` established at the top of this
  //      file and the sibling fragments kept.
  //   4. **Angle brackets are markup.** Two entries carry `<b>` and both keep it
  //      exactly (`voice.watch.connects`, `voice.watch.consentHost`). Nothing
  //      below invents a tag, and nothing below puts a word between `<` and `>`:
  //      `<` plus an ASCII letter plus ASCII letters, digits or hyphens plus `>`
  //      is a tag to `matchTag()` in `format.js`, the tag is not supplied, and
  //      the words inside it vanish from the sentence with no error anywhere.
  //      Japanese is the one language where this trap cannot spring by accident —
  //      a kana or kanji after the `<` fails the ASCII test — which is exactly
  //      why it is worth writing down before somebody transliterates something.
  //   5. **Most of this file is heard, not read.** The dock, the tiles, the mini
  //      view and the ringing card are icons; their words exist as tooltips and
  //      accessible names. Every such entry is marked below, because the rule for
  //      them is different: a visible label may lean on the icon beside it and a
  //      spoken one may not, so the spoken ones name the medium and the person
  //      even where the English looks redundant.

  // ----------------------------------------------- the sidebar connection bar

  // ボイス, matching `perms.group.voice` and `guild.nav.voice` already in this
  // file: the subsystem you join, as against 音声 which is the sound it carries.
  // One word, because it shares a 2.5rem card with an elapsed timer and a kana
  // run has no space in it to break at.
  'voice.bar.channel': 'ボイス',
  // ダイレクトメッセージ in full rather than DM. The two Latin letters would be
  // the only Latin on the card and would read as an abbreviation the reader has
  // to expand; the katakana is longer and is the phrase Japanese chat clients
  // use out loud.
  'voice.bar.directMessage': 'ダイレクトメッセージ',

  // 接続しています… follows `common.loading` (読み込んでいます…) and
  // `common.saving` (保存しています…): the progressive in this file is
  // 〜しています, never 〜中, except where the surface is a badge with no room
  // for a verb.
  'voice.bar.connecting': '接続しています…',
  // 接続済み and deliberately not 接続しました. English's "Voice connected" is a
  // state that persists for the whole call beside a live signal meter, and
  // 〜しました announces a completed event — it belongs on a toast that appears
  // once and goes away, which is what `common.saved` is. A line that sits there
  // for an hour saying 「接続しました」reads as a notification nobody dismissed.
  // ボイス is kept for exactly the reason the English comment gives: this bar
  // sits in a sidebar beside several other things that could be connected, and
  // 接続済み alone would be ambiguous in the one moment it is read.
  'voice.bar.connected': 'ボイス接続済み',

  // The meter's tooltip, and two genuinely different answers: a round trip that
  // has not been measured yet is not a bad one. 測定中 rather than
  // 測定しています… because this one replaces a number inside a tooltip rather
  // than heading a screen, and `common.a11y.loading` (読み込み中) is the
  // precedent for the badge form.
  'voice.bar.measuring': '測定中',
  // **Left in English: `ms`.** A unit symbol, not a word — SI writes it `ms` in
  // every language including Japanese, and ミリ秒 in a tooltip that is three
  // glyphs wide would push the number out of the meter. The ASCII space before
  // it is the SI convention and is also this file's rule for a Latin run.
  'voice.bar.ping': '{ms} ms',

  // 切断, the noun, 体言止め. A button label in Japanese is a noun phrase, not a
  // sentence: 切断します would be the app narrating its own click. 切断 is also
  // what Japanese networking has called this since dial-up, and 退出 — which is
  // the honest description of what happens — was rejected because the person
  // pressing it wants the connection gone, not the room.
  'voice.bar.disconnect': '切断',
  // Heard, never seen: the accessible name of the 2x2 grid of squares. 操作
  // follows `common.a11y.menu` (その他の操作), which is where this file settled
  // on 操作 for "controls".
  'voice.bar.toolbar': 'ボイスの操作',

  // ---- mute and deafen, which is the decision this whole file turns on
  //
  // ミュート is taken. It is the word every Japanese chat client, every video
  // call and every phone uses for shutting your own microphone, and there is no
  // argument for spending it on anything else. So "deafen" needs its own term,
  // and three were on the table:
  //
  //   * **音声オフ.** Shortest (4 glyphs) and the most dangerous. 音声 in this
  //     file is *the sound a call carries*, in both directions, and オフ next to
  //     it says the call has no sound any more — which a reader one square away
  //     from a disconnect button will read as "leave the audio". It also fails
  //     the thing the pair has to do, which is tell you *which* direction is cut:
  //     a person who cannot be heard and a person who cannot hear have opposite
  //     problems and this label describes neither.
  //   * **全員ミュート.** Actively wrong, and wrong in the direction that gets
  //     somebody thrown out of a room. It reads as "mute everyone" — a
  //     moderator's action on other people — and the square next to it really is
  //     a moderator-adjacent control, so there is nothing in the context to
  //     correct the misreading. Deafening is a thing you do to yourself.
  //   * **スピーカーミュート.** Chosen. It borrows the word that is already
  //     right (ミュート) and names the end of the audio path it applies to, so
  //     the pair on screen reads マイク側のミュート / スピーカー側のミュート —
  //     which is precisely the relationship the two icons draw, a microphone and
  //     a headphone. It is also the term a Japanese reader has already met in
  //     this exact context, so it costs no learning.
  //
  // The price is length, and it is a real price: サーバースピーカーミュート中 is
  // thirteen glyphs where English's longest arm is fifteen *characters*, and a
  // CJK glyph is close to twice a Latin letter's width, so the longest arm here
  // is roughly twice what the square was measured for. It truncates, and it is
  // allowed to, because Japanese truncates from the tail and the head of this
  // string is サーバー — which is the load-bearing half. Somebody who sees
  // サーバー… and nothing else has already learned the only thing this arm
  // exists to tell them: the mute is not theirs to lift.
  //
  // 中 on the two state arms (and on `muted` below) is not decoration. A bare
  // noun phrase in a square that is otherwise full of buttons reads as an offer
  // in Japanese — サーバーミュート would be parsed as "mute the server" — and 中
  // is what turns it into a description of a condition. It is the same work
  // English does by switching from an imperative to a past participle, and
  // Japanese has to do it with a suffix because it has no participle to switch
  // to.
  //
  // `muted` is the state where the microphone square is shut *because* the
  // headphone square is, and it stays the bare state word with no explanation,
  // exactly as English does, because the square beside it is already saying why.
  'voice.bar.mic': '{state, select, serverMuted {サーバーミュート中} muted {ミュート中} unmute {ミュート解除} other {ミュート}}',
  'voice.bar.deafen': '{state, select, serverDeafened {サーバースピーカーミュート中} undeafen {スピーカーミュート解除} other {スピーカーミュート}}',

  // Deliberately the same words as the dock's equivalents below, because they
  // are the same two buttons in two places and a person can see both at once.
  // 体言止め throughout: オンにする / オフにする is the verb phrase a Japanese
  // control label uses, built on `common.on` / `common.off` (オン / オフ) which
  // this file already settled.
  'voice.bar.videoStart': 'カメラをオンにする',
  'voice.bar.videoStop': 'カメラをオフにする',
  // 画面共有 as a noun elsewhere, 画面を共有 as the action here — Japanese marks
  // the object with を and the verb goes last, so an imperative cannot be made
  // by putting the noun compound in front of a verb. 共有を停止 rather than
  // 画面共有を停止 because the button only exists while a share is running and
  // the shorter form fits the same square as its opposite.
  'voice.bar.shareStart': '画面を共有',
  'voice.bar.shareStop': '共有を停止',

  // ------------------------------------------------------------- the dock

  // Every one of these is a tooltip and an accessible name at once, so none of
  // them is ever read by somebody who can also see the state — which is why they
  // say what the press will do rather than what is currently true, and why
  // length is free here in a way it is not in the bar above. All 体言止め.
  'voice.dock.camera': '{on, select, yes {カメラをオフにする} other {カメラをオンにする}}',
  // The same two words as `voice.bar.mic`'s offer arms, and they have to be: the
  // bar and the dock are on screen together and a reader comparing them must not
  // find two words for one button.
  'voice.dock.mic': '{muted, select, yes {ミュート解除} other {ミュート}}',
  'voice.dock.deafen': '{deafened, select, yes {スピーカーミュート解除} other {スピーカーミュート}}',
  'voice.dock.share': '{on, select, yes {共有を停止} other {画面を共有}}',
  'voice.dock.disconnect': '切断',
  // The arm is named after the `facingMode` currently in force, so `environment`
  // means the back camera is live and the press goes to the *front* one — the
  // arm name is vocabulary and is not translated, and getting the two arms the
  // wrong way round is the one mistake here that nothing would catch.
  // 前面 / 背面 are the words Japanese phone interfaces use for the two cameras;
  // 内側 / 外側 also exist and are the ones people say out loud, but 前面/背面 is
  // what the camera app the reader is comparing against prints.
  'voice.dock.flip': '{facing, select, environment {前面カメラに切り替える} other {背面カメラに切り替える}}',
  // 一緒に見る, the feature's name, in plain words — which is the choice English
  // made too, and the reason 同時視聴 was rejected: it is a broadcast-industry
  // noun that reads like the name of a paid service, and this is two friends and
  // a video. The name is used verbatim in `voice.watch.title`, so if either is
  // ever reworded both move. 終了 rather than 停止 for ending it, because
  // stopping is what you do to your own playback and ending is what happens to
  // everybody's session.
  //
  // この行は、英語の `yes` 側がまだ "End watch party" と書いていたころから
  // 一緒に見る で通していた。英語がようやく "End watching together" に
  // そろったので、値は変えず、スタンプだけを押し直している。
  'voice.dock.watch': '{on, select, yes {一緒に見るのを終了} other {一緒に見る}}',

  // ----------------------------------------------------------- the stage

  // まだ誰もいません, with まだ carrying English's "yet" — the room is empty now
  // and is not broken, which is the whole difference between this heading and an
  // error. A caller that knows better passes its own words in; these are the
  // defaults.
  'voice.stage.emptyTitle': 'まだ誰もいません',
  'voice.stage.join': 'ボイスに参加',
  // 再参加, 体言止め, against 参加し直す which is the verb. The button gets the
  // noun; `voice.room.staleHint` below gets the verb, because a sentence needs
  // one. Both are the same word and the reader will not notice the difference,
  // which is the point.
  'voice.stage.rejoin': '再参加',
  // Heard, never seen: the accessible name of the control group. 通話 for the
  // call itself, settled at `guild.voice.probe.reachable.body`.
  'voice.stage.controls': '通話の操作',

  // Autoplay. The browser is holding the audio and the person cannot tell that
  // from a call that has gone silent, so it is said. The cause moves to the head
  // of the sentence and the browser to the middle: Japanese puts the condition
  // first (〜まで) and the verb last, so English's order — actor, verb, object,
  // condition — inverts completely here. Nothing of it could have been kept.
  'voice.stage.audioBlocked': 'ページを操作するまで、ブラウザーがこの通話の音声を止めています。',
  'voice.stage.resumeAudio': '音声を再生',

  // The name under a picture and the name on the button that puts a share on the
  // stage, branching on whose it is rather than interpolating a name — 自分 is
  // the word that goes where your own name would go in a Japanese interface, and
  // it is used for the first person consistently from here to the end of the
  // file (`voice.tile.*`, `voice.screen.label`, `voice.media.*`, `voice.watch.you`).
  // あなた was rejected for this position: it is the second person, so it is what
  // the app calls you when it is *talking to* you, and a name plate is not
  // talking to anybody. The bare forms, used where an icon has already said
  // which medium it is; the full forms are `voice.screen.label` and
  // `voice.tile.cameraLabel` below.
  'voice.stage.shareName': '{mine, select, yes {自分の画面} other {{who}}}',
  'voice.stage.cameraName': '{mine, select, yes {自分のカメラ} other {{who}}}',
  // Screen-reader-only, beside a dot. The dot means the share started while you
  // were looking at something else, and a shape is not a word. 新着 rather than
  // 新規: 新規 is a thing you created, 新着 is a thing that arrived while you
  // were away, and the second is exactly what happened.
  'voice.stage.newShare': '新着',

  // Said once, above a call the relay cannot listen to, and worth a sentence
  // rather than a padlock because it is the claim the whole media path exists to
  // make. エンドツーエンド is the term Japanese messaging has settled on for
  // this and no native compound competes with it. The second half keeps
  // English's shape — the server carries it *and* cannot hear it, two facts,
  // said as two — because a Japanese reader who stops after 暗号化されています
  // has not yet learned the part that distinguishes this from every other
  // service that also says 暗号化.
  'voice.stage.sealedNotice': 'この通話はエンドツーエンドで暗号化されています。サーバーは通話を中継しますが、その内容を聞くことはできません。',

  // ------------------------------------------------------------- the tiles

  // Heard, never seen: the accessible name on the video element itself, which is
  // the only thing a screen reader has to go on. It names the medium as well as
  // the person for that reason, where `voice.stage.cameraName` beside a camera
  // icon does not have to.
  'voice.tile.cameraLabel': '{mine, select, yes {自分のカメラ} other {{who} のカメラ}}',
  // The placeholder moves to the head of the sentence and takes を with it,
  // which is the case the English comment predicted: English builds both of
  // these from a name plus a possessive suffix, and the moment the name has to
  // sit in front of the object rather than behind it, the join stops being
  // something a component can do. 拡大 for expanding a *video*; グリッドに戻す
  // for returning a *person* to the mosaic — two different sentences, as English
  // says, and Japanese keeps them different. グリッド rather than 一覧: 一覧 is
  // a list and would lose the spatial fact that the tile goes back into a
  // rectangle of other tiles, which is the thing the reader is about to watch
  // happen.
  'voice.tile.expand': '{mine, select, yes {自分の映像を拡大} other {{who} の映像を拡大}}',
  'voice.tile.collapse': '{mine, select, yes {自分の映像をグリッドに戻す} other {{who} をグリッドに戻す}}',

  // Two states drawn as a coloured glyph on the name plate, with the word
  // repeated for anything that cannot see the glyph. 中 again, and here it does
  // the work English's participle does: these describe the person, they are not
  // buttons, and without 中 a screen reader would read out what sounds like an
  // offer to mute somebody.
  'voice.tile.muted': 'ミュート中',
  'voice.tile.deafened': 'スピーカーミュート中',

  // Pills in the corner of a tile, dropped entirely on a compact tile rather
  // than truncated, so length is taste here and not breakage. なし follows
  // `common.none`; オン follows `common.on`.
  'voice.tile.noMic': 'マイクなし',
  'voice.tile.camera': 'カメラオン',
  // The possessive is the whole point — this is the tile *you* expanded, still
  // chosen, while a screen share has temporarily taken the stage — so 自分の
  // carries it and a bare 選択中 would not. 自分 for the first person, as above.
  'voice.tile.yourPick': '自分の選択',

  // その他 follows `common.a11y.menu` (その他の操作), shortened because this one
  // is a visible label on a button rather than a spoken name.
  'voice.tile.more': 'その他',
  // 切り離す rather than ポップアウト. The katakana would be a transliteration of
  // an English idiom that Japanese never borrowed, and the native verb says what
  // actually happens: the video leaves the page and floats on its own.
  //
  // かつては `voice.screen.noPip` だけ ピクチャーインピクチャー という正式名称に
  // していた。英語がそこだけ "picture in picture" と呼び、ほかの三か所を
  // "pop out" と呼んでいたからで、二つの名前があるのは意図的だと読めた。
  // 英語はいま四か所とも "pop out" に統一されたので、日本語も 切り離す 一本に
  // そろえてある。検索語としての正式名称を失うが、同じボタンの話が二つの
  // 名前で書かれているほうが実際には迷う。
  'voice.tile.pip': '切り離す',
  // Two sliders in the tile's menu, told apart at a glance because a person
  // turning down somebody's screen share almost always wants to keep hearing
  // them talk. 音量 is the person; 画面の音声 is the share. The two share no
  // glyph, which is a stronger distinction than English's, where both begin with
  // a word about sound.
  'voice.tile.volume': '音量',
  'voice.tile.screenAudio': '画面の音声',

  // The consent button on somebody's share in an SFU room, where watching is
  // what asks the server to forward the picture at all. 視聴 — the act of
  // watching somebody else's stream — and it is kept lexically apart from
  // 一緒に見る (`voice.dock.watch`) for the whole file: they are two features,
  // they can both be on screen at once, and a reader who found the same word on
  // both would reasonably assume one of them turns the other on. Three arms,
  // because a tile too narrow for a labelled button and a quality picker drops
  // to the bare verb — and in Japanese the bare arm is 停止 alone, which is the
  // same shortening English makes.
  'voice.tile.watchGate': '{state, select, stop {停止} stopWatching {視聴を停止} other {視聴}}',

  // ------------------------------------------------------- the screen share

  // The full form, used as an accessible name where nothing else says what the
  // rectangle is. 自分 again for the first person.
  'voice.screen.label': '{mine, select, yes {自分の画面} other {{who} の画面}}',
  // 全画面表示 rather than フルスクリーン: the native compound is what Japanese
  // browsers and Japanese video players print on this exact control, and the
  // katakana would be a second name for a thing the reader already has a name
  // for. 表示 is kept even on the bare label so that the word matches
  // `voice.screen.noFullscreen` and `voice.error.fullscreen` below.
  'voice.screen.fullscreen': '全画面表示',
  // 拡大率 rather than ズーム for the thing being reset: ズームをリセット is
  // understood, but 拡大率 names the number that changes, and リセット is kept
  // because 初期化 in Japanese software means wiping something to factory state
  // and is a frightening word to put on a zoom control.
  'voice.screen.resetZoom': '拡大率をリセット',
  'voice.screen.stopSharing': '共有を停止',

  // The four ways fullscreen and picture-in-picture can refuse. These are thrown
  // as `Error`s and land in a toast, so they are sentences and end in 。 — the
  // distinction that decides whether something got translated at all. All four
  // are facts about this browser or this moment rather than instructions, so
  // none of them ends in てください.
  'voice.screen.noScreen': '表示できる画面がありません。',
  'voice.screen.noFullscreen': 'このブラウザーは全画面表示になりません。',
  // 切り離す, matching `voice.tile.pip`, because this is the sentence that
  // appears when that button was pressed and the two must be recognisably the
  // same word.
  'voice.screen.noVideo': '切り離せる映像がありません。',
  // 切り離す, matching `voice.tile.pip` and `voice.screen.noVideo`. 対応して
  // いません would say the browser does not implement a named feature, which is
  // what this said while it named ピクチャーインピクチャー; now that the
  // sentence names the gesture instead, 切り離せません is the plainer and more
  // accurate form — this browser cannot do the thing that button does.
  'voice.screen.noPip': 'このブラウザーは映像を切り離せません。',

  // The four rungs of `WATCH_QUALITIES`. 映像の画質 rather than ストリーム品質:
  // 品質 is the word for the quality of a product or a service, 画質 is the word
  // every Japanese video player uses for exactly this slider, and 映像の says
  // *which* stream — the tile has a separate 画面の音声 control and the two must
  // not compete.
  'voice.quality.label': '映像の画質',
  // 自動 matches `channel.voice.regionAuto` and `voice.region.auto` below, so
  // the three automatic settings in the client say one word.
  'voice.quality.auto': '自動',
  // One glyph each, and that is deliberate rather than terse: the group label
  // directly above already supplies 画質, so 低画質 / 中画質 / 高画質 would
  // repeat it three times inside a segmented control that is three squares wide.
  // Japanese pickers do it this way for the same reason.
  'voice.quality.low': '低',
  'voice.quality.medium': '中',
  'voice.quality.high': '高',

  // The pill on a tile that is sharing, naming which encoder bet is in force.
  // 精細 and 動き are the two things being traded against each other and are
  // short enough for a pill; 鮮明 was rejected for 精細 because 鮮明 is about
  // contrast and 精細 is about how much detail survives, which is the actual
  // bet. ライブ is the fallback for a share that started before presets existed
  // and stays katakana because it is a mode name rather than a description.
  'voice.preset.detail': '精細',
  'voice.preset.motion': '動き',
  'voice.preset.live': 'ライブ',

  // --------------------------------------------------------- the chat toggle

  // The visible word is the noun and the accessible name is the action, which is
  // why English has two keys and Japanese keeps two. 開く / 閉じる follow
  // `common.close` (閉じる) already in this file.
  'voice.chat.label': 'チャット',
  'voice.chat.toggle': '{open, select, yes {チャットを閉じる} other {チャットを開く}}',
  // 「、」で区切り、件数は助数詞「件」を付ける。未読は状態なので「未読あり」。
  'voice.chat.toggleMentions': '{open, select, yes {チャットを閉じる} other {チャットを開く}}、メンション{count, plural, other {#件}}',
  'voice.chat.toggleUnread': '{open, select, yes {チャットを閉じる} other {チャットを開く}}、未読あり',

  // ------------------------------------------------- Android's output picker

  // Phones only, and Android owns this list: it decides what an output is called
  // and hands over a label already in the system language. 音声の出力先 rather
  // than オーディオ出力 — 出力先 says *where the sound goes*, which is what this
  // sheet chooses, and it is the phrasing Android's own Japanese uses.
  'voice.route.title': '音声の出力先',
  'voice.route.finding': '出力先を探しています…',
  // **Left untranslated: `{label}` and `✓`.** The label is Android's own string,
  // already localised by the platform, and it travels through this sentence as a
  // value precisely so that nothing concatenates a prefix onto it. The tick is a
  // glyph rather than a word; it is a prefix rather than a checkmark column
  // because the sheet is a plain menu, and the two arms exist — rather than a
  // boolean — so that a language marking the current choice some other way can.
  // Japanese does not need to: the tick reads here exactly as it does in English.
  'voice.route.option': '{state, select, selected {✓ {label}} other {{label}}}',
  // Only ever shown before the bridge answers; once it has, its own
  // `automatic_label` replaces this. 自動 for the third time, same word.
  'voice.route.automatic': '自動',
  // 端末 for the phone, as `errors.offlineDevice` already has it in this file,
  // and deliberately not the オーディオ機器 used in the desktop panel below —
  // the thing that lacks a picker is the handset, not a microphone.
  'voice.route.unsupported': 'この端末には出力先を選ぶ機能がありません。',

  // -------------------------------------------- the desktop device panel

  // オーディオ機器 rather than オーディオデバイス, and the reason is a collision
  // this file created for itself: `common.device` is already 端末, meaning the
  // computer or phone you signed in on, and a second word ending in デバイス
  // would invite the reader to think this panel is about that. 機器 is the
  // Japanese word for a piece of equipment you plug in, which is what a
  // microphone and a pair of speakers are. The distinction is held for the rest
  // of the file: 端末 is the machine, 機器 is what is attached to it.
  'voice.devices.title': 'オーディオ機器',
  // The two halves stay two halves. English's "listens to" and "plays" become
  // 拾う and 出す, because a call does not 聞く (which is a person listening) and
  // does not 再生する (which is playback of a recording) — it picks sound up at
  // one end and puts it out at the other, and the pair of verbs has to make that
  // mechanical.
  'voice.devices.subtitle': 'この通話が音を拾う場所と、音を出す場所です。',
  // The tooltip on the trigger, saying what the panel is *for* rather than
  // repeating its name. 体言止め with 選ぶ.
  'voice.devices.open': 'マイクと出力を選ぶ',
  'voice.devices.refreshing': '更新しています…',

  // English labels the input side "Microphone" rather than "Input", and the
  // asymmetry is deliberate there and kept here: マイク is the object a person
  // can point at, 入力 would be the abstraction. 出力 stays the abstraction on
  // the other side because what comes out might be speakers, headphones, a
  // headset or a television, and naming any one of them would be wrong three
  // times out of four. 出力 native, never アウトプット.
  'voice.devices.input': 'マイク',
  'voice.devices.output': '出力',
  // システムの既定 rather than bare 既定: the default is not Telium's, it is the
  // one the operating system is currently pointing at, and saying so is what
  // makes the other entries in the list worth reading. 既定 is the glossary word
  // and not デフォルト.
  'voice.devices.defaultMic': 'システムの既定',
  'voice.devices.defaultSpeakers': 'システムの既定',

  // **Left untranslated: `{id}`.** The first six characters of a hardware
  // identifier, which is a string the browser minted and not a word. `{n}` is
  // this entry's position in the list and closes up against the kana in front of
  // it, because numerals do in Japanese typesetting; the id goes inside
  // full-width parentheses, which supply their own visual gap and so need no
  // ASCII space even though what they hold is Latin. Both are values in a
  // sentence rather than pieces glued together, exactly as the English comment
  // asks — and Japanese is the language that proves why, since the counter and
  // the noun could not have been assembled from the English shape.
  'voice.devices.unnamedMic': 'マイク{n}（{id}）',
  'voice.devices.unnamedOutput': '出力{n}（{id}）',

  // ノイズ抑制 for the setting — the term Japanese voice clients print on this
  // exact control, and 抑制 (damping a thing down) is the honest verb for what a
  // suppressor does, against 除去 (removing it) which is reserved below for the
  // model. オフ follows `common.off`.
  'voice.devices.noise': 'ノイズ抑制',
  'voice.devices.noiseOff': 'オフ',
  // ブラウザー with the long vowel, matching サーバー and ユーザー名 already in
  // this file. It names the *browser* on purpose: this is WebRTC's own
  // suppressor, which costs nothing and is already there, and that is exactly
  // the distinction the middle option is drawing.
  'voice.devices.noiseBrowser': 'ブラウザー',
  // One option, two states, one message — and the parenthesis is where Japanese
  // gains most from that decision. English appends an aside; Japanese would
  // rather say 測定中 inside the same breath, and full-width parentheses with no
  // space before them are how it does that. The ellipsis is kept because it is
  // the same ellipsis as `voice.bar.connecting`: something is still happening.
  'voice.devices.noiseNeural': '{state, select, measuring {ニューラル（測定中…）} other {ニューラル}}',

  // English's semicolon becomes two sentences, because Japanese has no semicolon
  // and a 、 in its place would make the second clause sound like a consequence
  // the browser chose. It follows the system; that is a fact, not a fallback.
  'voice.devices.noSinkId': 'このブラウザーは出力を選べません。システムの設定に従います。',

  // Two failures from the microphone-switching path, both thrown, both reaching
  // a toast, and both about a running call rather than a setting — which is why
  // neither is phrased as advice and neither ends in てください. 反映されません
  // でした rather than 送信しませんでした: English's "did not publish" is a
  // statement about what the call ended up carrying, not an accusation against a
  // function, and 反映 is the Japanese word for a change that failed to take.
  'voice.devices.micPublishFailed': 'この通話に新しいマイクは反映されませんでした。',
  'voice.devices.micSwitchUnsupported': 'この通話では、接続中にマイクを変更できません。',

  // --------------------------------------------- why the neural model cannot

  // The nine refusals from `neuralCapability()` and `probeNeural()`, keyed by the
  // machine reason the probe returns. The hyphens in the key segments are the
  // probe's own vocabulary spelled exactly as it spells it, and the keys are
  // copied character for character — grep either half and it finds the other.
  //
  // All nine are facts about this browser or this machine, so all nine are flat
  // statements in the present tense with no てください anywhere: there is nothing
  // the reader can do about any of them, and a sentence that implied otherwise
  // would send somebody hunting through settings for half an hour.
  //
  // **Left in English across this block: `Web Audio API`, `WebAssembly`, `https`,
  // `48 kHz`, `CPU`.** An API name, a language runtime's name, a URL scheme, a
  // frequency with its SI unit, and the three letters every Japanese
  // specification sheet also prints. ウェブオーディオ API would be a name that no
  // longer matches the documentation the reader would go and read, and 48 キロ
  // ヘルツ would be a number nobody could match against their audio settings.
  'voice.noise.reason.no-audio-worklet': 'このブラウザーは、音声処理をメインスレッド以外で実行できません。',
  'voice.noise.reason.no-audio-context': 'このブラウザーは Web Audio API を提供していません。',
  'voice.noise.reason.insecure-context': '音声処理には、安全な接続（https）が必要です。',
  'voice.noise.reason.no-wasm': 'このブラウザーは、このページで WebAssembly を実行しません。',
  // 端末 for the machine, as established above, and 回せる — "cores to spare one
  // for the model" becomes "not enough cores to give the model one", which puts
  // the model at the tail where Japanese wants its object of comparison.
  'voice.noise.reason.one-core': 'この端末は CPU のコア数が少なく、モデルに回せる分がありません。',
  'voice.noise.reason.no-48k': 'この端末のオーディオ機器は 48 kHz で動作しません。',
  // リアルタイム, katakana, because 実時間 is a physics term and リアルタイム is
  // what a person means when they say the model cannot keep up.
  'voice.noise.reason.too-slow': 'この端末は、モデルをリアルタイムで実行できるほど速くありません。',
  // ここは ノイズ除去モデル と書いていた。英語が "noise suppression"（設定）と
  // "noise-cancellation model"（モデル）を書き分けていたので、日本語も 抑制 と
  // 除去 という二つの熟語で同じ線を引いた——英語より大きな声で、しかし忠実に。
  //
  // その線は英語側の間違いだった。抑制 と 除去 は同じ subsystem の二つの呼び名
  // にすぎず、区別すべきなのは「機能」と「読み込みに失敗しうる任意のモデル」の
  // ほうだった。英語はいま後者を "the neural model" と呼ぶ。日本語には
  // `voice.noise.cannot` と `voice.noise.fellBack` に ニューラルモデル が
  // すでにあり、それが利用者の押したカード（`voice.devices.noiseNeural`:
  // ニューラル）の言葉でもある。この二行もそれに合わせた。
  'voice.noise.reason.load-failed': 'ニューラルモデルを読み込めませんでした。',
  'voice.noise.reason.no-measurement': 'ニューラルモデルを測定できませんでした。',
  // The fallthrough for a reason this build has never heard of — the same shape
  // as `errors.mfa_required`, and for the same reason: a machine token must never
  // reach the screen.
  'voice.noise.cannot': 'この端末はニューラルモデルを実行できません。',
  // Said once, when a call gives up mid-flight and writes the preference back to
  // `browser`. The second half is the part worth saying, and in Japanese it is
  // also the part that has to come last: 〜ため、〜に切り替えました puts the
  // cause first and the outcome at the tail, which is the opposite of English's
  // order and the only order a Japanese reader can follow. Something is still
  // suppressing noise, so the person does not go looking for a setting that is
  // already correct.
  'voice.noise.fellBack': 'ニューラルモデルが処理に追いつかなかったため、この通話はブラウザーのノイズ抑制に切り替えました。',

  // ---------------------------------------------------- joining and leaving

  // The microphone refusal, and the single most important sentence in this file:
  // it is what somebody reads when a call has connected and they cannot be heard.
  //
  // The consequence is repeated in full in every arm, exactly as English repeats
  // it, and Japanese is the language that vindicates the decision — 通話は
  // 聞こえますが、話すことはできません is a single clause pair joined by が, and
  // が has to attach to whatever came before it. There is no way to hold that
  // half constant and swap the other; the whole sentence moves or none of it
  // does. Repetition here is the cost of the sentence being translatable at all.
  //
  // `androidDenied` is a separate arm because the remedy is somewhere else
  // entirely: a browser permission lives in site settings, an Android one lives
  // in the system's app settings, and pointing at the wrong one wastes the only
  // sentence anybody gets. 権限 is the glossary word for permission, fixed by
  // `errors.missing_permission` at the top of this file.
  //
  // **Left in English: `Android`, `Telium`.** A platform name and a product name.
  // The first is what the settings app the reader is about to open calls itself
  // in Japanese too; the second is the wordmark, and a Telium that had been
  // transliterated would be a different product to search for.
  'voice.call.noMic': '{reason, select, androidDenied {マイクの使用が拒否されました。Android のアプリ設定で Telium にマイクを許可してください。通話は聞こえますが、話すことはできません。} denied {マイクの使用が拒否されました。ブラウザーのサイトの権限設定で許可してください。通話は聞こえますが、話すことはできません。} missing {この端末にマイクが見つかりませんでした。通話は聞こえますが、話すことはできません。} other {マイクを開けませんでした。通話は聞こえますが、話すことはできません。}}',

  // The camera's version of the same three refusals, shorter because a camera
  // that will not open is not the emergency a microphone that will not open is:
  // the call still works, and Japanese says so by simply not adding a second
  // clause — there is no reassurance to strip, because none was offered.
  'voice.call.cameraRefused': '{reason, select, androidDenied {カメラの使用が拒否されました。Android のアプリ設定で Telium にカメラを許可してください。} denied {カメラの使用が拒否されました。ブラウザーのサイトの権限設定で許可してください。} missing {この端末にカメラが見つかりませんでした。} other {カメラを開けませんでした。}}',

  // Four things a call's transport simply cannot do. Phrased as facts about this
  // call rather than as errors, because there is nothing to retry and nothing to
  // fix: この通話は〜できません, present tense, no past-tense of a single failed
  // attempt anywhere. That is the opposite of the tense rule the probe section
  // of this file uses, and deliberately so — the probe describes one attempt,
  // these describe a standing incapacity.
  'voice.call.noCameraSupport': 'この通話は映像を扱えません。',
  'voice.call.noScreenShareSupport': 'この通話は画面共有を扱えません。',
  'voice.call.noFlipSupport': 'この通話ではカメラを切り替えられません。',
  'voice.call.noAlternateCamera': 'この端末には、切り替えられるカメラがほかにありません。',

  // Sealing a conversation's call. Both are thrown before a single packet moves,
  // so both mean the call is not going to happen rather than that something went
  // wrong during it — 〜ため、〜できません, cause then outcome, present tense.
  // 鍵 is the glossary word and not キー. 暗号化できません for "cannot be
  // sealed": Japanese has no everyday verb that distinguishes English's "sealed"
  // from "encrypted", and 封印 — the literal one — is a word from fantasy, not
  // from cryptography. The distinction English draws here is one Japanese
  // readers do not have, and inventing a word to carry it would teach them a
  // term the rest of the interface never uses.
  'voice.call.noKeys': 'この会話にはまだ通話用の鍵がないため、通話を暗号化できません。',
  // **Left in English: `SFU`.** A category of server software, named in RFCs and
  // in every deployment guide the reader has open; no language translates it,
  // and the sibling fragment settled it at `guild.voice.colSfu`.
  'voice.call.sfuAddressUnknown': 'この会話には、どの SFU に接続するかが書かれていません。',
  // A guild's server offered an SFU without end-to-end encryption. Refused
  // outright: the alternative is a call the server can listen to.
  'voice.call.sfuNotEncrypted': 'このサーバーはエンドツーエンドで暗号化された通話を提供しなかったため、接続されませんでした。',

  // The call moved while you were in it. Three separate things can move and they
  // are three messages, because a person who sees the same sentence twice assumes
  // the second one is a repaint. `mode` is a token the component narrowed, not
  // the server's own string, so a third transport arriving later cannot render
  // as itself.
  'voice.call.moved': '{mode, select, sfu {通話は SFU 経由に切り替わりました。} other {通話は直接接続に切り替わりました。}}',
  // **Left untranslated: `{region}`.** A deployment's own identifier —
  // `eu-west`, `staging` — and it is drawn raw here for the same reason the
  // region picker draws it raw. リージョン, the glossary word, and not 地域.
  'voice.call.movedRegion': 'ボイスは {region} リージョンに移りました。',
  'voice.call.movedTo': '{channel} に移動しました。',
  // English keeps this lower case because it is dropped into the middle of
  // `movedTo` and never used anywhere else. Japanese has no case to lower, so the
  // instruction does not apply — what does apply is that it must be a bare noun
  // phrase with no particle of its own, because the particle belongs to the
  // sentence it lands in.
  'voice.call.someVoiceChannel': '別のボイスチャンネル',
  'voice.call.shareStoppedOnMove': '通話が移動したため、画面共有は停止しました。',

  // ------------------------------------------------- refusing to dial at all

  // The three codes from `refusalCode()`. These are about the *posture* the
  // person chose in their privacy settings, not about a failure, so each one
  // names the requirement and then says what was on offer instead. A call is
  // never quietly downgraded to get it through — that is the whole point of the
  // check — and the が in each sentence is what makes the refusal read as
  // deliberate rather than as a breakdown. Politeness stops at ます: nothing here
  // apologises, because nothing here went wrong.
  'voice.refusal.nothing': '通話できるボイスサーバーがありません。',
  'voice.refusal.sfu': '通話のプライバシー設定は SFU を必要としますが、この通話に SFU はありません。',
  'voice.refusal.relay': '通話のプライバシー設定は少なくともリレーを必要としますが、この通話にはリレーも SFU もありません。',

  // ----------------------------------------------------- the ringing card

  // 着信, the word Japanese telephony has used for an arriving call since before
  // anybody had a mobile. 受信 would be about data and 呼び出し would be about the
  // ringing itself; 着信 is the event, which is what the card announces.
  'voice.incoming.title': '着信',
  // One plural arm. 人 is the counter for people and is the same construction at
  // one as at nine, so English's singular has nowhere to land and loses nothing —
  // it was carrying agreement. The numeral closes up against 人 with no space;
  // the separator is the full-width ・, which is the Japanese middle dot, rather
  // than the ASCII one English uses with spaces around it. An ASCII · between two
  // kana runs leaves two Latin-width gaps in the middle of a line that has none
  // anywhere else.
  'voice.incoming.groupSize': '{count, plural, other {グループ通話・#人}}',
  // Heard, never seen: the card's accessible name and its two icon buttons. The
  // caller goes at the head with から attached, which is where Japanese puts it —
  // English put it at the tail, and the English comment's own reasoning (that two
  // icon buttons must be told apart by their first word in some languages and
  // their last in others) is what licenses the move. Here the two are told apart
  // by their *last* word, 応答する against 拒否する, which is the opposite of
  // English and is the correct answer for Japanese.
  //
  // `other` の腕は新しい。以前は名前が取れないとき `voice.incoming.someone`
  // （誰か）が {caller} に入り、「誰かからの通話」になっていた。日本語として
  // 不自然ではないが、名札の位置に 誰か とだけ出るのは、名前を取り損ねた
  // ように見える。名前がないのなら、日本語は名前の話をしない: 着信 とだけ言い、
  // ボタンは 通話に応答する と 通話を拒否する になる。
  'voice.incoming.fromWho': '{named, select, yes {{caller} からの通話} other {着信}}',
  'voice.incoming.answer': '{named, select, yes {{caller} からの通話に応答する} other {通話に応答する}}',
  'voice.incoming.decline': '{named, select, yes {{caller} からの通話を拒否する} other {通話を拒否する}}',
  // A `reportError` context: a noun phrase for the attempt, no full stop, because
  // `errors.context` joins it to whatever went wrong with a full-width colon.
  'voice.incoming.joinFailed': '通話に応答できませんでした',

  // ------------------------------------------------- the floating mini view

  'voice.mini.call': '通話',
  // Heard, never seen: the landmark name for the floating picture. ミニ表示
  // rather than ミニビュー — ビュー is not a word Japanese interfaces put in front
  // of a user, and 表示 is what they say for a view of something.
  'voice.mini.region': '通話のミニ表示',
  // 次へ, exactly as `common.next` already has it in this file, so the arrow in
  // the mini view and the arrow in every wizard say one word.
  'voice.mini.next': '次へ',
  'voice.mini.expand': '通話を拡大',
  // 隠す, the verb, matching `common.a11y.hidePassword` (パスワードを隠す).
  // 非表示にする is the settings-pane form and would be two glyphs longer on a
  // control that is already floating over somebody's screen.
  'voice.mini.hide': '隠す',

  // Four keys rather than two with a `select`, because the mini view builds a
  // list of rows and reads each row's label from the row itself. 自分 for the
  // first person throughout, matching the stage and the tiles; {who} takes の and
  // an ASCII space in front of it, because a display name may be Latin.
  'voice.media.screenMine': '自分の画面',
  'voice.media.screenOther': '{who} の画面',
  'voice.media.cameraMine': '自分のカメラ',
  'voice.media.cameraOther': '{who} のカメラ',

  // ------------------------------------------------- the voice channel page

  // A channel that has gone while somebody was looking at it. もうありません
  // rather than 削除されました, because the second claims to know which of the two
  // things happened and the next line is the one that says it might be either.
  'voice.room.goneTitle': 'このボイスチャンネルはもうありません',
  'voice.room.goneBody': '削除されたか、見えなくなっています。',

  // 参加すると始まります — joining is what opens the room, and the conditional と
  // is Japanese's way of saying that one follows from the other without promising
  // anybody anything.
  'voice.room.emptyBody': '参加すると始まります。',
  // The one warning anybody gets that pressing the button opens a microphone, and
  // it must not be softened. オンになります, flat, present tense, no 〜ことが
  // あります and no 〜ので安心してください. It sits under the join button and its
  // whole job is to be read in the half second before somebody presses it.
  'voice.room.joinHint': 'マイクがオンになります。',
  // The verb form of 再参加, for the reason given at `voice.stage.rejoin`: the
  // button is a noun and the sentence needs a verb. 解消 for "clear it" — the
  // stale state is a thing to be cleared away, and 削除 would sound like the
  // channel gets deleted.
  'voice.room.staleHint': 'このタブでは何も接続されていません。再参加するか、切断して解消してください。',

  // The mobile header's subtitle, and the accessible name of the row of faces on
  // the desktop header — the number lives in the name of the row because the
  // faces *are* the count for anyone who can see them and are nothing at all for
  // anyone who cannot. One arm; 人 for people; the numeral closes up.
  'voice.room.inVoice': '{count, plural, other {ボイスに#人}}',
  'voice.room.empty': '誰もいません',
  // **Left as arithmetic: `+`.** The overflow chip at the end of a stack of
  // faces, drawn inside a circle the size of an avatar. It is a sign and a
  // numeral, not a sentence, and ほか{count}人 — which is what the sentence would
  // be — does not fit in a circle.
  'voice.room.more': '+{count}',
  // Heard, never seen: the accessible name of a stack of watcher faces. 視聴中,
  // matching `voice.tile.watchGate` and `common.activity.watching` (視聴中)
  // already in this file. The count and the counter cannot be separated, which is
  // why this is one message and not a number beside a word.
  'voice.room.watching': '{count, plural, other {#人が視聴中}}',

  'voice.room.chatTitle': 'チャンネルのチャット',
  'voice.room.minimize': '最小化',

  // Four `reportError` contexts. They are noun phrases describing the attempt,
  // never complete sentences, and never end in punctuation, because
  // `errors.context` appends 「：」 and a second clause. 〜できませんでした
  // throughout: the past tense of one attempt, not the present tense of a
  // standing incapacity, which is the distinction the probe section of this file
  // established and which these have to honour or the reader will think the
  // feature is gone.
  'voice.room.readFailed': '視聴者を読み取れませんでした',
  'voice.room.watchFailed': '視聴を開始できませんでした',
  'voice.room.unwatchFailed': '視聴を停止できませんでした',
  'voice.room.qualityFailed': '映像の画質を変更できませんでした',

  // ------------------------------------------------------- the region picker

  // ボイスリージョン, matching `guild.voice.regions.title` and
  // `channel.voice.regionLabel` exactly. リージョン and not 地域: a region here is
  // one relay named by its address, which is the cloud-infrastructure sense, and
  // 地域 would send somebody looking for a map. The region names themselves are
  // identifiers the deployment published and are drawn exactly as they arrive.
  'voice.region.title': 'ボイスリージョン',
  // English's "quieter" is a metaphor about the line and not about loudness, and
  // 静か would say the call is less loud — which is the opposite of the promise.
  // 音が安定します is what the sentence is actually claiming: fewer dropouts,
  // fewer artefacts, a link that holds. たいてい keeps English's "usually", which
  // is the word that stops this being a guarantee.
  'voice.region.subtitle': 'この通話がどこを経由するかです。近いほど、たいてい音が安定します。',
  'voice.region.loading': 'リージョンを読み込んでいます',
  'voice.region.none': 'このサーバーはボイスリージョンを公開していません。',
  'voice.region.auto': '自動',
  // 正常 is the word `guild.voice.healthOk` already uses for a relay that is up,
  // so the hint and the health column agree. サーバーに選ばせます puts the actor
  // at the head and the verb at the tail, which is the inversion English's "let
  // the server pick" needs in Japanese.
  'voice.region.autoHint': '最も近い正常なリージョンをサーバーに選ばせます。',
  // 現在 rather than 今: this is a status line in a picker and 今 would read as
  // conversational. 受け付けていません, present progressive negative, because the
  // relay may well be accepting calls again in a minute.
  'voice.region.unhealthy': '現在、通話を受け付けていません。',

  // --------------------------------------------------- the share dialog

  'voice.share.title': '画面を共有する',
  'voice.share.choose': '共有するものを選ぶ',
  // Heard, never seen: the accessible name of the radio group. 内容 rather than
  // もの, because a group name is a category and もの is what the visible heading
  // above it says.
  'voice.share.contentLabel': '共有する内容',

  // The two encoder bets, keyed by the `value` of the presets in
  // `lib/screenShare.js`. Each pair is a promise and its price, in that order,
  // because the price is what makes the choice a choice — and in Japanese the
  // order survives intact, which is unusual for this file.
  'voice.share.content.detail.label': '文書やコード',
  // くっきり for sharp text: it is the word Japanese uses for text that has not
  // been smeared, where 鮮明 would be about a photograph. コマ数 for frames a
  // second, settled here and used again at `voice.share.frameRate` below. 画素は
  // すべて保たれます is the price stated as a gain, exactly as English does.
  'voice.share.content.detail.description': '文字がくっきりします。1秒あたりのコマ数は減り、画素はすべて保たれます。',
  'voice.share.content.motion.label': 'ゲームや動画',
  // カクつく is the Japanese word for a video that stutters and there is no
  // formal synonym worth using — 途切れる would mean it stopped. 回線が細くなる
  // for "when the link tightens", which is the metaphor Japanese uses for the
  // same thing. The order of the two halves is English's: what it does first,
  // what it gives up second.
  'voice.share.content.motion.description': '動きがなめらかです。回線が細くなると、カクつく前に画質を落とします。',

  // Audio, which is the thing people discover is missing halfway through playing
  // somebody a video. も carries English's "too" and is doing real work: without
  // it the switch would read as though the share were sound only.
  'voice.share.audio': '音声も共有する',
  // Two hints under that switch, chosen from what the engine can actually do, and
  // they are different facts: one browser can capture a tab's audio but not a
  // whole screen's, another cannot capture any at all, and telling somebody the
  // second when the first is true costs them a working feature. 取り込む for
  // capture — 取得 would be about fetching data and キャプチャ would be a
  // screenshot.
  'voice.share.audioUnlikely': 'このブラウザーはタブの音声は取り込めますが、画面全体やウィンドウの音声は取り込めません。',
  'voice.share.noCapture': 'このブラウザーは、共有するものの音声を取り込めません。',
  // **Partly the browser's words, not ours: 「タブの音声を共有する」.** The quoted
  // phrase is the browser's own wording in its picker, and the English comment
  // asks a translator to use whatever that picker says in their language — which
  // for Chrome in Japanese is「タブの音声を共有する」, with the する. Corner
  // brackets 「」rather than English's curly quotes, because those are the
  // quotation marks Japanese uses and `guild.gates.feeds` already uses them in
  // this file. If the browser's wording changes, this changes with it; it is not
  // ours to keep stable.
  'voice.share.pickTabAudio': '音声は含まれていませんでした。タブを選び、「タブの音声を共有する」にチェックを入れると一緒に送られます。',
  // **Left untranslated: `{reason}`.** Whatever the native Linux desktop-audio
  // bridge said — a PipeWire or venmic diagnostic this client did not compose and
  // cannot translate, carried in the one slot the sentence has for it. The
  // full-width colon follows `errors.context`, which is the pattern that settled
  // how this catalogue joins a context to a machine's own words.
  'voice.share.desktopAudioFailed': 'デスクトップの音声を共有できませんでした：{reason}',

  // The collapsed advanced row and the two strips inside it. 画質 here is the
  // resolution-and-frame-rate pair taken together, which is what the row summarises.
  'voice.share.quality': '画質',
  // **Left in English: `fps`.** A unit symbol. The separator is the full-width ・
  // rather than English's spaced middle dot, for the reason given at
  // `voice.incoming.groupSize`: an ASCII · needs Latin-width spaces around it and
  // a kana line has none. `{quality}` holds a Latin label ("1080p (Full HD)") and
  // `{fps}` holds a numeral, so the ASCII space before the unit is the only one
  // this pattern needs.
  'voice.share.summary': '{quality}・{fps} fps',
  'voice.share.resolution': '解像度',
  // English chose "Frames a second" over "Frame rate" — plain words over the term
  // of art — and Japanese keeps that choice with コマ数 rather than フレーム
  // レート. It also matches the description above it, which already says
  // 1秒あたりのコマ数, so the label and the explanation use one word.
  'voice.share.frameRate': '1秒あたりのコマ数',

  // ------------------------------------------------------- watch together

  // The feature's name, identical to `voice.dock.watch`'s off-state, because the
  // English comment requires the two to move together and because a dialog whose
  // title differs from the button that opened it is a dialog somebody thinks they
  // opened by mistake.
  'voice.watch.title': '一緒に見る',
  // The whole feature in one line: everyone plays it themselves and Telium
  // carries only the position and the play button. それぞれが自分で再生し is the
  // first half; 再生位置だけをそろえます is the second, and 位置だけ — position
  // *only* — is where English's "in time with each other" becomes a claim about
  // what does and does not travel. That is the more useful sentence, and it is
  // the one the rest of this section spends nine keys defending.
  'voice.watch.subtitle': 'それぞれが自分で再生し、再生位置だけをそろえます。',
  'voice.watch.url': 'リンク',
  'voice.watch.urlPlaceholder': 'リンクを貼り付け',
  // The last alternative in a list of provider names built with `Intl.ListFormat`,
  // so it is only ever the final item and must carry no comma and no conjunction
  // of its own — `Intl.ListFormat('ja')` supplies 「、」and「または」itself, and a
  // or a や written in here would double them. A bare noun phrase, which is what
  // そのもの makes it: the file itself rather than a service that hosts one.
  'voice.watch.orFile': '動画ファイルそのもの',
  'voice.watch.noEmbeds': 'このビルドには対応する再生サービスがなく、ファイルの直接再生も無効になっています。',
  'voice.watch.start': '開始',

  // The consent sentence, in the dialog and again on the card. One sentence with
  // the host emphasised inside it, not three nodes glued together.
  //
  // **The two `<b>` tags are kept exactly and nothing else in this file grows
  // one.** `<b>` is markup the calling code resolves; what it wraps here is a
  // provider's brand and a DNS name, neither of which is language. The ASCII
  // spaces sit outside the tags, between `</b>` and the kana, because the Latin
  // run inside needs separating from what follows it and the tag itself is
  // invisible at render time. If a tag were ever dropped the words inside would
  // still render — but if somebody were to write a Japanese word inside angle
  // brackets it would be read as a tag name, not supplied, and vanish silently.
  // Japanese is safe from that by construction, since `matchTag()` requires an
  // ASCII letter after the `<`; it is written down because the next person may be
  // transliterating something.
  'voice.watch.connects': '<b>{provider}</b> から再生すると、このブラウザーが <b>{host}</b> に接続します。',
  'voice.watch.consentHost': 'これにより、ブラウザーが <b>{host}</b> に接続します。',
  // Chosen from `connectsTo().kind`. The two cases are genuinely different: a
  // file is fetched by each person from wherever it lives, and an embed runs a
  // player the provider serves.
  'voice.watch.noteFile': 'それぞれが、そのファイルの置かれている場所から自分で取得します。',
  // **`{provider}` appears twice, and that is the translation.** English hangs
  // "which sees this browser…" off the provider with a relative pronoun. Japanese
  // relative clauses go in *front* of the noun they modify, so keeping one
  // sentence would produce 「タブで開いたときとほぼ同じようにこのブラウザーが
  // 見える {provider} のフレーム…」— a reader cannot tell until the very end which
  // noun the long clause belongs to, and by then they have lost the sentence. Two
  // sentences with the name repeated is what Japanese does instead, and the
  // coverage test compares the *set* of placeholders rather than their count, so
  // repeating one is allowed by design.
  'voice.watch.noteFrame': 'プレーヤーは {provider} から配信されるフレームの中で動作します。{provider} からは、タブで開いた場合とほぼ同じようにこのブラウザーが見えます。',
  // **Left in English: `Telium`.** The wordmark. 中継しません is the flat denial;
  // 接続するのはあなたのブラウザーです is where English's "The connection is
  // yours" goes, because 接続はあなたのものです — the literal rendering — would
  // sound like a statement about ownership of property rather than about which
  // machine is doing the connecting.
  'voice.watch.proxyNote': 'Telium は中継しません。接続するのはあなたのブラウザーです。',
  'voice.watch.connectTo': '{host} に接続する',
  // 今はしない, not いいえ. This is the decline button on a consent dialog and it
  // has to say that the offer stays open — which is precisely what English's "Not
  // now" says and what `common.no` (いいえ) would not.
  'voice.watch.notNow': '今はしない',

  // What happens to the two bytes Telium *does* carry, said in both places,
  // because consenting to a connection and consenting to a relay seeing your
  // scrubbing are two different consents.
  //
  // 再生・一時停止の操作 for English's "the play button". English is using the
  // button as a shorthand for the transport state that travels; Japanese has no
  // equivalent shorthand, and 再生ボタン would be a claim about a piece of UI
  // rather than about what goes over the wire. The full-width ・ joins the two
  // nouns, which is what it is for.
  //
  // **Left in English: `Telium`** in all three.
  'voice.watch.sealed': 'Telium を通るのは再生位置と再生・一時停止の操作だけで、どちらもエンドツーエンドで暗号化されています。',
  'voice.watch.relayed': '再生位置と再生・一時停止の操作は Telium のリレーを通り、リレーはその内容を読み取れます。',
  'voice.watch.relayedConsent': '再生位置と再生・一時停止の操作は Telium が中継し、Telium はその内容を読み取れます。',
  // A badge, and the place where English's distinction between "sealed" and
  // "encrypted" finally has to be given up — see `voice.call.noKeys`. Japanese
  // has one idea here and エンドツーエンド暗号化 is its name; the badge is long
  // for a badge and every shorter option (E2EE, 封印済み, 保護) either puts Latin
  // initials in front of a reader who has never seen them or invents a register
  // the rest of the interface does not use.
  'voice.watch.sealedLabel': 'エンドツーエンド暗号化',

  // A link no adapter can drive. Three lines, in the order somebody needs them:
  // what is wrong, why, and what to do instead. Only the third ends in
  // てください, because only the third is something the reader can act on.
  'voice.watch.unsyncable': 'そのリンクは再生位置をそろえられません。',
  // やり取りの方法を知っている — "knows how to talk to" — kept as a relative
  // clause in front of プレーヤー, which is where Japanese puts it, so the whole
  // qualification arrives before the noun and the reader never has to hold it.
  'voice.watch.unsyncableWhy': 'Telium が操作できるのは、やり取りの方法を知っているプレーヤーだけです。これはその一つではありません。',
  'voice.watch.unsyncableInstead': '代わりに画面を共有して、自分で再生してください。',
  'voice.watch.unplayable': 'そのリンクはここでは再生できません。',

  // The line above the player. 自分 for the first person, matching every other
  // first person in this file — あなた was rejected at `voice.stage.shareName` and
  // is rejected here for the same reason: this string goes in the position a
  // display name occupies.
  'voice.watch.you': '自分',
  'voice.watch.aVideo': '動画',
  // `{what}` is a provider's own name or 動画, and 「YouTube を開始しました」reads
  // as though somebody launched an application. の再生を開始しました fixes it for
  // both values at once and adds nothing English did not mean: 開始 in English is
  // already about playback and not about the service. The two placeholders end up
  // adjacent with が between them, which is Japanese's subject marker and is the
  // one piece of grammar this sentence cannot do without.
  'voice.watch.started': '{who} が {what} の再生を開始しました',
  'voice.watch.opening': '{provider} を開いています…',
  // プレーヤー with the JIS long vowel, not プレイヤー. Both are current in
  // Japanese; プレイヤー is overwhelmingly the person playing a game and プレーヤー
  // is the device or the software that plays something back, which is what this
  // is. The English comment notes the registry calls a bare file "Direct video
  // file" and nobody says that out loud — the same is true of 直接動画ファイル,
  // and this is the phrase that replaces it.
  'voice.watch.thePlayer': 'プレーヤー',

  // Somebody is still buffering. One name is worth saying; several are worth
  // counting. 人 for people, one arm, numeral closed up against the counter.
  'voice.watch.waitingFor': '{who} を待っています',
  'voice.watch.waitingForMany': '{count, plural, other {#人を待っています}}',
  // Said once, when the wait has gone on long enough that carrying on is kinder
  // than stopping. Deliberately not an apology and deliberately not an error: it
  // is a decision the room made, so it is in the past tense of something that has
  // already happened (続けました) rather than a suggestion about what might. No
  // 申し訳ありません anywhere near it.
  'voice.watch.gaveUpWaiting': 'まだ読み込み中の人がいますが、その人を待たずに再生を続けました。',

  // The control bar. Both transport buttons name the *room* rather than the
  // player, because that is the surprising half: pressing pause here pauses it
  // for everybody. 全員で leads in both, so the surprising word is the first one
  // read — which in Japanese is also the one that survives truncation.
  'voice.watch.playAll': '全員で再生',
  'voice.watch.pauseAll': '全員で一時停止',
  'voice.watch.position': '再生位置',
  // **Left untranslated: `{at}` and `{duration}`, and the slash between them.**
  // Two timecodes and the separator every media player on earth draws between
  // them. There is no language in this string.
  'voice.watch.elapsedOf': '{at} / {duration}',
  'voice.watch.speed': '再生速度',
  // **Left untranslated: `×`.** The multiplication sign, not the letter x, and
  // Japanese writes a playback rate the same way — 倍 after the number would also
  // be idiomatic (1.5倍) but the sign is what the control beside it draws and
  // changing one without the other would be worse than either.
  'voice.watch.rate': '{rate}×',
  // Two words for one button, chosen by whether this is your session. Ending it
  // takes it away from everybody; leaving it does not — and 終了 against 退出 is
  // exactly that difference in Japanese, which is why 終了 gets 全員の and 退出
  // gets nothing.
  'voice.watch.end': '全員の視聴を終了',
  'voice.watch.leave': '退出',
  'voice.watch.startFailed': '一緒に見るのを開始できませんでした',

  // ------------------------------------------------------------- failures

  // Everything in this section is a `reportError` context: the first half of
  // `errors.context`, joined to whatever actually went wrong by the full-width
  // colon that key owns. They are noun phrases in the past-attempt sense and none
  // of them ends in 。, because a colon and a second clause follow.
  //
  // They are worded from the person's side of the call, not the code's:
  // ボイスの状態を更新できませんでした is what a failed `voiceState` request means
  // to somebody who pressed ミュート and watched it spring back.
  'voice.error.join': '通話に参加できませんでした',
  // 正常に for "cleanly" — the call ended, but not in the way it should have, and
  // きれいに would describe tidiness rather than protocol.
  'voice.error.leave': '通話から正常に退出できませんでした',
  // The one entry in this block that is not a 〜できませんでした, because English
  // is not one either: nothing was attempted and refused, something went wrong
  // while it was running.
  'voice.error.trouble': '通話で問題が発生しました',
  // ボイスの状態, matching `bots.intent.guild_voice_states.label` already in this
  // file, so the thing a bot subscribes to and the thing that failed to update
  // are named identically.
  'voice.error.voiceState': 'ボイスの状態を更新できませんでした',
  'voice.error.cameraOn': 'カメラをオンにできませんでした',
  'voice.error.cameraOff': 'カメラをオフにできませんでした',
  'voice.error.flipCamera': 'カメラを切り替えられませんでした',
  'voice.error.shareScreen': '画面を共有できませんでした',
  'voice.error.stopStream': '画面共有を停止できませんでした',
  'voice.error.streamState': '画面共有を更新できませんでした',
  'voice.error.resumeAudio': '通話の音声を開始できませんでした',
  'voice.error.fullscreen': '全画面表示にできませんでした',
  // 切り離す, matching `voice.tile.pip` and `voice.screen.noVideo`.
  'voice.error.pip': '映像を切り離せませんでした',
  // The two halves of following a call that moved underneath you, kept separate
  // because one is a new server and the other is a new region, and knowing which
  // failed is the difference between waiting and rejoining.
  'voice.error.followServer': '通話の新しいサーバーに追随できませんでした',
  'voice.error.followRegion': '通話の新しいリージョンに追随できませんでした',
  // 鍵 for key, per the glossary, and 更新 rather than 再生成: the reader does not
  // need to know that a new key was derived, only that the call failed to move
  // onto one.
  'voice.error.rekey': '通話の鍵を更新できませんでした',
  // Rejoining kept failing, so the seat is given up; `errors.context` names
  // what the last attempt hit.
  'voice.error.rejoin': '通話に再参加できませんでした',
  // The server says this device is no longer in the channel it was calling from.
  'voice.call.removed': 'ボイスチャンネルから外されました',
  // The device panel's four. `readRoutes` and `switchOutput` are shared with
  // Android's output sheet, which asks the same two questions of a different
  // implementation — so 出力先 here is the same 出力先 as `voice.route.title`,
  // and オーディオ機器 is the same word as `voice.devices.title`.
  'voice.error.listDevices': 'オーディオ機器の一覧を取得できませんでした',
  'voice.error.switchMic': 'マイクを切り替えられませんでした',
  'voice.error.switchOutput': '出力を切り替えられませんでした',
  'voice.error.readRoutes': '音声の出力先を読み取れませんでした',
  // ノイズ抑制 が機能、ニューラルモデル がモデル。`voice.noise.reason.load-failed`
  // で引き直した線を、この断片の最後の二行まで持ち込んでいる。二つは同じトースト
  // の列に並ぶので、別々の失敗が同じ名前で出てはいけない。
  'voice.error.noiseChange': 'ノイズ抑制を変更できませんでした',
  'voice.error.noiseModel': 'ニューラルモデルを確認できませんでした',

  // ================================================== added to reach 100%
  //
  // Everything below was added in one pass to complete this catalogue. The
  // sentences were produced with machine assistance and have not been read by
  // a human, which is why none of them carries a stamp in `stamps.json` --
  // `node scripts/i18n-status.mjs --stale` reports them as *unknown*, not as
  // accepted. Treat this block as a first draft to review, not as finished copy.
  // ---- app
  'app.boot.connecting': '「{domain}」に接続しています…',
  'app.boot.offline': 'この端末はオフラインです。接続が戻り次第、Telium がサインインします。',
  'app.boot.signOut': 'サインアウト',
  'app.boot.switching': '「{name}」に切り替えています…',
  'app.boot.unreachable': '「{domain}」に接続できませんでした：{reason}',
  'app.boot.unreachableNotice': 'サーバーのセッションは期限が切れるまで動き続けますが、ホームサーバーが停止している間は新しいセッションを作れません。',
  'app.crash.recover': '再読み込みしても直りませんか？',
  'app.crash.reload': '再読み込み',
  'app.crash.report': 'これを報告する',
  'app.crash.title': 'この画面の描画中に問題が発生しました。',

  // ---- auth
  'auth.advanced.identityMismatch': 'このアカウントの識別情報の履歴を確認できませんでした。',
  'auth.advanced.identityName': 'アカウントの識別情報',
  'auth.advanced.legacyPassphraseBody': 'このアカウントは、古いバージョンの Telium のパスフレーズをまだ持ち続けています。パスワードが同じ役割をすでに果たしています。',
  'auth.advanced.legacyPassphraseName': '古い復旧パスフレーズ',
  'auth.advanced.modeName': 'このアカウントの復旧方法',
  'auth.advanced.passphraseRemoved': '古いパスフレーズを削除しました。パスワードで引き続きメッセージを取り戻せます。',
  'auth.advanced.removeFailed': '古い復旧パスフレーズを削除できませんでした：{detail}',
  'auth.advanced.removePassphrase': '古いパスフレーズを削除',
  'auth.advanced.rootSequence': ' · ルートシーケンス {sequence}',
  'auth.backup.delete': 'バックアップを削除',
  'auth.backup.deleteBody': 'この端末にすでにあるメッセージは残ります。新しい端末では以前のメッセージを取り戻せなくなります。',
  'auth.backup.deleteConfirm': '削除する',
  'auth.backup.deleted': 'バックアップを削除しました。',
  'auth.backup.deleteFailed': 'バックアップを削除できませんでした：{detail}',
  'auth.backup.deleteTitle': 'バックアップの削除',
  'auth.backup.detail': '{count, plural, one {#件の項目を密封。} other {#件の項目を密封。}} {readable, select, yes {ホームサーバーが開けます。} other {ホームサーバーは開けません。}}',
  'auth.backup.detailName': 'バックアップ',
  'auth.backup.empty': 'まだ何も保存されていません。新しい端末は今日から始まります。',
  'auth.backup.explain': '新しい端末が追いつけるように、暗号化された写しを保管しています。最後に書き込まれたのは {at, relative} です。',
  'auth.backup.title': '以前のメッセージのバックアップ',
  'auth.crumb.address': 'Telium アドレス',
  'auth.crumb.password': 'パスワード',
  'auth.crumb.recoveryKey': '復旧鍵',
  'auth.crumb.username': 'ユーザー名',
  'auth.crumb.welcome': 'ようこそ',
  'auth.custody.device.name': '信頼済み端末による復旧',
  'auth.custody.device.note': '鍵は、あなたが承認した端末だけにあります。',
  'auth.custody.escrowed.name': 'サーバー補助による復旧（従来）',
  'auth.custody.escrowed.note': 'ホームサーバーが、これらのメッセージを開く鍵を持っています。',
  'auth.custody.line': '{name}。{note}',
  'auth.custody.opaque.name': 'パスワードによる復旧（OPAQUE エクスポート鍵）',
  'auth.custody.opaque.note': 'パスワードでサインインするだけでメッセージを取り戻せます。',
  'auth.custody.self.name': '独立したパスフレーズ（従来）',
  'auth.custody.self.note': '鍵はあなたの端末にあり、パスフレーズが復旧の道です。',
  'auth.custody.unknown': 'まだ確立していません',
  'auth.encryption.backupEmpty': '保存されたものはありません',
  'auth.encryption.backupFact': '以前のメッセージのバックアップ',
  'auth.encryption.backupItems': '{count, plural, one {#件のメッセージ} other {#件のメッセージ}}',
  'auth.encryption.devicesCounting': '数えています',
  'auth.encryption.devicesFact': '端末',
  'auth.encryption.devicesHint': '端末は、端末を確認したりサインアウトさせたりする場所です。',
  'auth.encryption.devicesSignedIn': '{count, plural, one {# 台がサインイン中} other {# 台がサインイン中}}',
  'auth.encryption.devicesVerified': '{total, plural, one {{verified} / # 確認済み} other {{verified} / # 確認済み}}',
  'auth.encryption.escrowed.note': 'このアカウントはまだ古い復旧設定を使っています。オフにするのは1回押すだけで、2つ目のパスワードは不要です。',
  'auth.encryption.escrowed.title': 'ホームサーバーがあなたのプライベートメッセージを読めます。',
  'auth.encryption.keyFact': '復旧鍵',
  'auth.encryption.keyLegacy': '古いパスフレーズ',
  'auth.encryption.keyMissing': '未作成',
  'auth.encryption.keySaved': '保存済み',
  'auth.encryption.locked.note': '新しいメッセージは利用できます。以前のメッセージを取り戻すには、下の復旧鍵を使うか、すでに使っている端末からこの端末を承認してください。',
  'auth.encryption.locked.title': '以前のメッセージは、この端末ではロックされています。',
  'auth.encryption.ok.noteFallback': '開けるのはあなたの端末だけです。',
  'auth.encryption.ok.title': 'あなたのプライベートメッセージは保護されています。',
  'auth.encryption.settingUp.note': 'サインイン後、少し時間がかかります。',
  'auth.encryption.settingUp.title': 'この端末で暗号化を設定しています。',
  'auth.escrow.button': 'オフにする',
  'auth.escrow.doneDevices': '完了しました。鍵はあなたの端末にあります。',
  'auth.escrow.doneRefresh': '完了しました。ただし、いくつかの会話ではまだ鍵の更新が必要です。',
  'auth.escrow.doneServer': '完了しました。サーバーは新しいメッセージを開けなくなりました。',
  'auth.escrow.explain': 'これをオフにすると、サーバーは以後に送られたものを開けなくなります。すでに見たものは、すでに見られています。',
  'auth.escrow.failed': 'サーバー補助による復旧をオフにできませんでした：{detail}',
  'auth.escrow.title': 'サーバー補助による復旧をオフにする',
  'auth.find.afterColon': 'または、@{user}:your.server のようにコロンの後に入力してください',
  'auth.find.busy': '照会しています…',
  'auth.find.changeAddress': '別のアドレスを使う',
  'auth.find.changeHome': '別のホームを選ぶ',
  'auth.find.create': 'アカウントを作成',
  'auth.find.deactivated': 'このアカウントは無効化されています。パスワードでサインインすると復元されます。',
  'auth.find.elsewhere': '別のサーバーですか？',
  'auth.find.forget': 'この端末から {user} を削除',
  'auth.find.found': '見つかりました：{user}＠{host}',
  'auth.find.foundLabel': 'アカウント：{user}',
  'auth.find.hint': '@ada:telium.chat のような、あなたのユーザー名とサーバーです。サーバーを忘れた場合は、ユーザー名だけを入力してください。',
  'auth.find.homeExplainer': 'アカウントのホームは、プロフィール、サインイン、友だち、メッセージを保管します。ほかの場所でホストされているコミュニティにも参加できます。',
  'auth.find.invalid': 'これは Telium アドレスではないようです。@name:server の形式で試してください。',
  'auth.find.label': 'Telium アドレス',
  'auth.find.lookingUp': '照会しています：{host}…',
  'auth.find.moved': 'あなたのアカウントは {host} に移転しました。',
  'auth.find.newTitle': 'Telium は初めてですか？',
  'auth.find.noAccount': 'アカウント {user} は {host} にありません。綴りを確認するか、<create>アカウントを作成</create>してください。',
  'auth.find.noSuchAccount': 'アカウント {user} は {host} にありません。',
  'auth.find.placeholder': '@you:telium.chat',
  'auth.find.recentLabel': 'この端末のアカウント',
  'auth.find.searching': '探しています：{user}…',
  'auth.find.title': 'Telium にサインイン',
  'auth.find.unreachable': '「{host}」に接続できませんでした。綴りか接続を確認してください。',
  'auth.find.whichServer': 'どのサーバーの {user} ですか？',
  'auth.guardians.cannotSign': 'この端末は今、あなたのアカウントに署名できません。',
  'auth.guardians.duplicate': '3人は別々の人にしてください。同じ ID を2回数えることはできません。',
  'auth.guardians.incomplete': '保存する前に3人全員を指定してください。',
  'auth.guardians.name': '復旧連絡先（3人中2人）',
  'auth.guardians.needThree': '別々の3人を選んでください。',
  'auth.guardians.person': '人物 {index}',
  'auth.guardians.placeholder': '@friend:home.example',
  'auth.guardians.replace': 'この3人を変更',
  'auth.guardians.save': 'この3人を保存',
  'auth.guardians.saved': '3人の復旧連絡先を保存しました。',
  'auth.guardians.saveFailed': '復旧連絡先を保存できませんでした：{detail}',
  'auth.guardians.set': '設定済み、バージョン {version}。新しい人を選ぶと古い設定は無効になります。',
  'auth.guardians.unset': '未設定。3人のうち2人があなたを復帰させられますが、1人だけではできません。',
  'auth.guardians.unsupported': 'このサーバーは対応していません。',
  'auth.guardians.unsupportedName': '復旧連絡先',
  'auth.guardians.verifiedList': '確認済みの人：{people}',
  'auth.guardians.verifyFirst': 'まず絵文字の照合で相手を確認し、その後でその人の完全な ID をここに入力してください。',
  'auth.handoff.account': '<b>アカウント {account} を {destination} へ移転します。</b>移転先になるアカウントにサインインするか、新しいアカウントを登録してください。{source} に何かが送信される前に確認を求められます。',
  'auth.handoff.guild': '<b>ギルド {name} を {destination} へ移転します。</b>そこで所有者になるアカウントにサインインするか、新しいアカウントを登録してください。{source} に何かが送信される前に確認を求められます。',
  'auth.identity.placeholder': 'ada または @ada:{host}',
  'auth.identity.placeholderNew': 'ada',
  'auth.identity.titleLogin': '誰がサインインしますか？',
  'auth.identity.titleRegister': 'ユーザー名を選ぶ',
  'auth.key.acceptFailed': '復旧鍵を受け入れられませんでした：{detail}',
  'auth.key.copy': '復旧鍵をコピー',
  'auth.key.saved': '復旧鍵を保存しました',
  'auth.key.sub': 'すべての端末を失ったときに、パスワードのリセットとアカウントの復旧ができます。',
  'auth.key.title': '復旧鍵を保存',
  'auth.key.warning': '<b>パスワードとは別の安全な場所に保管してください。</b>Telium を含め、誰もあなたのために作り直すことはできません。',
  'auth.legacy.register.action': '従来の登録を使う',
  'auth.legacy.register.body': '従来の登録では、パスワードがホームサーバーに送られます。サーバーを信頼していて、現行の Telium リリースに更新できない場合にのみ使ってください。',
  'auth.legacy.register.title': 'このホームサーバーはパスワードを秘匿する登録に対応していません。',
  'auth.legacy.server.action': '従来のサインインを使う',
  'auth.legacy.server.actionReactivate': '従来の再有効化を使う',
  'auth.legacy.server.body': '従来のサインインでは、パスワードがホームサーバーに送られます。サーバーを信頼していて、現行の Telium リリースに更新できない場合にのみ使ってください。',
  'auth.legacy.server.title': 'このホームサーバーはパスワードを秘匿するサインインに対応していません。',
  'auth.legacy.upgrade.action': 'このアカウントを更新',
  'auth.legacy.upgrade.body': 'このアカウントは OPAQUE より前のものです。今回の更新のときだけ、ホームサーバーは従来のログイン経路を通じてあなたのパスワードを受け取ります。その後 Telium が古い検証情報を OPAQUE に置き換えるため、以後のサインインではパスワードはこの端末にとどまります。',
  'auth.legacy.upgrade.title': 'この古いアカウントには一度だけのセキュリティ更新が必要です。',
  'auth.localData.cache.body': '安全です。ここにあるものはすべて、サーバーがまだ持っているものの写しで、次に接続したときに戻ります。サインイン状態は続き、暗号化された会話もそのままです。',
  'auth.localData.cache.button': 'キャッシュデータを消去',
  'auth.localData.cache.cost1': 'ギルド、チャンネル、最近のメッセージのオフライン用の写しです。',
  'auth.localData.cache.cost2': '端末内に複製された設定です。次回の同期で戻ります。',
  'auth.localData.cache.cost3': 'サービスワーカーがオフライン用にキャッシュしていたものです。',
  'auth.localData.cache.done': '消去しました。再読み込みすると、きれいなキャッシュから始まります。',
  'auth.localData.cache.reload': '再読み込み',
  'auth.localData.cache.title': 'キャッシュデータを消去',
  'auth.localData.healed': 'アプリが2回続けて起動に失敗したため、Telium はオフラインキャッシュを自動的に消去しました。アカウントの内容は変わっておらず、暗号化された会話もそのままです。',
  'auth.localData.identity.body': 'キャッシュの消去で解決しなかった場合にのみ行ってください。この端末が保持する暗号鍵を破壊します。それらが開くものの一部は、ほかのどこにも存在しません。',
  'auth.localData.identity.confirm': '消去してサインアウト',
  'auth.localData.identity.confirmTitle': 'これは取り消せません。失うもの：',
  'auth.localData.identity.cost1': 'この端末の MLS 署名用の識別情報。話している全員にとって新しい端末となり、もう一度確認するまで未確認として見えます。',
  'auth.localData.identity.cost2': '暗号化されたすべての会話の保存済みグループ状態。この端末にすでにあるメッセージは、アカウントの復旧鍵で再び開ける場合にのみ読めます。この端末が最後の保持者であるものは失われます。',
  'auth.localData.identity.cost3': 'キャッシュされた DM 復旧鍵束。次にサインインするときに、鍵の保管庫をもう一度開く必要があります。そのとき復旧鍵かパスフレーズが必要なので、用意しておいてください。',
  'auth.localData.identity.cost4': 'あなたのセッション。この端末からサインアウトされます。',
  'auth.localData.identity.open': '端末の識別情報を消去…',
  'auth.localData.identity.title': 'この端末の識別情報を消去',
  'auth.parts.advanced': '詳細',
  'auth.parts.download.account': 'アカウント：{user}',
  'auth.parts.download.body1': 'この鍵はパスワードをリセットし、暗号化されたメッセージを再び開きます。',
  'auth.parts.download.body2': 'これを持つ人は誰でもその両方ができます。あなただけがたどり着ける場所に保管してください。',
  'auth.parts.download.server': 'サーバー：{host}（どの端末でも上のアカウントでサインインしてください）',
  'auth.parts.download.title': 'Telium 復旧鍵',
  'auth.parts.keyGroups': '{label}、{count, plural, one {#組の文字} other {#組の文字}}',
  'auth.parts.needsAttention': '要確認：',
  'auth.parts.recoveryKeyLabel': '復旧鍵',
  'auth.password.confirmLabel': 'パスワードの確認',
  'auth.password.deactivated': 'このアカウントは無効化されています。同じパスワードで復元されます。',
  'auth.password.forgot': '忘れましたか？<recover>復旧鍵を使う</recover>',
  'auth.password.mfaLabel': '認証コード',
  'auth.password.mfaPlaceholder': '123456、または復旧コード',
  'auth.password.mfaPrompt': '認証アプリの6桁のコード、または復旧コードのいずれかを入力してください。',
  'auth.password.mismatch': 'まだ一致していません。',
  'auth.password.reactivateFailed': '再有効化に失敗しました：{detail}',
  'auth.password.registerFailed': '登録に失敗しました：{detail}',
  'auth.password.signInFailed': 'サインインに失敗しました：{detail}',
  'auth.password.signingInAs': 'サインインしています：<b>{user}</b> として。',
  'auth.password.submitLogin': 'サインイン',
  'auth.password.submitReactivate': 'アカウントを再有効化',
  'auth.password.submitRegister': 'アカウントを作成',
  'auth.password.titleLogin': 'パスワードを入力',
  'auth.password.titleReactivate': 'アカウントを再有効化',
  'auth.password.titleRegister': 'パスワードを設定',
  'auth.recover.malformed': 'その復旧鍵は形式が正しくありません。',
  'auth.recover.notAKey': 'それは Telium の復旧鍵ではありません。',
  'auth.recover.reachFailed': 'ホームサーバーに接続できませんでした：{detail}',
  'auth.recover.rejected': 'その復旧鍵はこのアカウントでは受け入れられませんでした。',
  'auth.recover.title': 'パスワードをリセット',
  'auth.recover.unsupported': 'このホームサーバーは復旧鍵によるリセットに対応していません。',
  'auth.recoveryKey.clipboardName': '復旧鍵',
  'auth.recoveryKey.copy': 'コピーする',
  'auth.recoveryKey.createFailed': '復旧鍵を作成できませんでした：{detail}',
  'auth.recoveryKey.download': 'ファイルとしてダウンロード',
  'auth.recoveryKey.enterPassword': 'パスワードを入力してください。',
  'auth.recoveryKey.fieldLabel': '復旧鍵',
  'auth.recoveryKey.finishFailed': '復旧鍵の保存を完了できませんでした：{detail}',
  'auth.recoveryKey.haveExplain': '復旧鍵は、パスワードを忘れたときやすべての端末を失ったときに戻るための道です。あなただけがたどり着ける場所に保管してください。再表示はできず、新しい鍵を作ると古い鍵は使えなくなります。',
  'auth.recoveryKey.lockedFirst': '上のメッセージのロックを解除すると、復旧鍵を作成できます。',
  'auth.recoveryKey.makeButton': '復旧鍵を作成',
  'auth.recoveryKey.makeNew': '新しい鍵を作成',
  'auth.recoveryKey.noneExplain': 'このアカウントには復旧鍵がありません。復旧鍵がないと、パスワードを忘れたときに以前のメッセージを失います。作成には数秒かかります。',
  'auth.recoveryKey.onceWarning': '<b>先に進む前に書き留めてください。</b>表示されるのは一度だけで、私たちも含め誰も再表示できません。',
  'auth.recoveryKey.passwordHint': 'この端末で確認されます。サーバーが受け取ることはありません。',
  'auth.recoveryKey.passwordLabel': 'パスワード',
  'auth.recoveryKey.placeholder': 'telium-recovery-v1-…',
  'auth.recoveryKey.replaceBody': '新しい鍵を作った瞬間に、現在の復旧鍵は使えなくなります。どこかに書き留めていた場合、その控えは無意味になります。',
  'auth.recoveryKey.replaceButton': '新しい復旧鍵を作成',
  'auth.recoveryKey.replaceConfirm': '新しい鍵を作成',
  'auth.recoveryKey.replaceExplain': '新しい鍵を作るにはパスワードを入力してください。古い鍵は使えなくなります。',
  'auth.recoveryKey.replaceTitle': '新しい復旧鍵を作成',
  'auth.recoveryKey.saved': '保存しました',
  'auth.recoveryKey.savedToast': '復旧鍵を保存しました。パスワードとは別に保管してください。',
  'auth.recoveryKey.title': '復旧鍵',
  'auth.recoveryKey.unsupported': 'このサーバーは復旧鍵に対応していません。鍵はあなたが承認した端末にとどまります。',
  'auth.reset.confirmLabel': '新しいパスワードの確認',
  'auth.reset.failed': 'パスワードのリセットに失敗しました：{detail}',
  'auth.reset.minLength': '{count, plural, one {少なくとも # 文字。} other {少なくとも # 文字。}}',
  'auth.reset.mismatch': '新しいパスワードが一致しません。',
  'auth.reset.newLabel': '新しいパスワード',
  'auth.reset.submit': 'パスワードをリセット',
  'auth.reset.title': '新しいパスワードを選ぶ',
  'auth.server.label': 'ホームサーバー',
  'auth.server.noServer': '持っていませんか？<a>ホームサーバーを探す</a>',
  'auth.server.placeholder': 'home.example',
  'auth.server.probeChecking': 'サーバーを確認しています',
  'auth.server.probeFound': 'サーバーが見つかりました',
  'auth.server.probeUnreachable': 'サーバーに接続できません',
  'auth.server.sub': 'すべての Telium アカウントは一つのホームサーバーに属します。',
  'auth.server.title': 'アカウントはどこにありますか？',
  'auth.server.unreachableBody': 'そのアドレスでは何も応答しなかったため、綴りが違うか、非公開か、停止している可能性があります。そのまま進めてもかまいませんが、応答するまではサインインとアカウント作成はできません。稼働していることが分かっている<a>ホームサーバーを探す</a>こともできます。',
  'auth.server.unreachableTitle': '{host} が応答しませんでした',
  'auth.server.use': 'このサーバーを使う',
  'auth.server.useAnyway': 'そのまま使う',
  'auth.start.lostPassword': 'パスワードをお忘れですか？<recover>アカウントを復旧する</recover>',
  'auth.start.register': 'はじめる',
  'auth.start.signIn': 'サインイン',
  'auth.start.title': 'Telium へようこそ',
  'auth.unlock.button': 'ロック解除',
  'auth.unlock.done': '解除しました。これ以降はパスワードだけで十分です。',
  'auth.unlock.doneDevice': 'この端末で解除しました。',
  'auth.unlock.enterKey': '復旧鍵を入力してください。',
  'auth.unlock.enterPassphrase': '復旧パスフレーズを入力してください。',
  'auth.unlock.failed': 'メッセージのロックを解除できませんでした：{detail}',
  'auth.unlock.keyHint': 'このアカウントを作成したときに渡された鍵です。',
  'auth.unlock.otherDevice': 'すでに使っている端末で Telium を開き、そこからこの端末を承認することもできます。何も入力する必要はなく、サーバーが鍵を見ることもありません。',
  'auth.unlock.passphraseHint': 'あなた自身がこのアカウントに追加したパスフレーズです。',
  'auth.unlock.passphraseLabel': '復旧パスフレーズ',
  'auth.unlock.title': '以前のメッセージのロックを解除',

  // ---- chat
  'chat.format.bar': 'テキストの書式',
  'chat.gif.exitFullscreen': '全画面を終了',
  'chat.gif.fullscreen': '全画面',
  'chat.gif.resize': 'GIF ピッカーのサイズを変更',
  'chat.message.actions.delete': '削除',
  'chat.message.actions.pin': 'ピン留め',
  'chat.message.actions.quickReact': 'リアクション：{emoji}',
  'chat.message.actions.unpin': 'ピン留め解除',
  'chat.message.deleteFailed': '削除できませんでした',
  'chat.message.pinFailed': 'ピン留めできませんでした',
  'chat.message.pinned': 'ピン留めしました。',
  'chat.message.pinnedMark': 'ピン留め',
  'chat.message.quotedDeleted': '元のメッセージは削除されました',
  'chat.message.unpinned': 'ピン留めを解除しました。',
  'chat.quote.body': '<quoted/>',
  'chat.timeline.pinNotice.anonymous': 'メッセージがピン留めされました',
  'chat.timeline.pinNotice.named': '{name} がメッセージをピン留めしました',
  'chat.timeline.pinNotice.seeAll': 'すべてのピン留めを見る',

  // ---- errors
  'errors.account_already_active': 'このアカウントはすでに有効です。',
  'errors.account_deleted': 'このアカウントは削除されており、サインインできません。',
  'errors.assertion_rejected': 'そのギルドサーバーはこのボットの認証情報を受け入れませんでした。',
  'errors.bot_not_installed': 'このボットはそのギルドサーバーにインストールされていません。',
  'errors.demoted': 'このサーバーは別のノードに引き継ぎました。再接続しています。',
  'errors.invalid_recovery_proof': 'その復旧フレーズはこのアカウントには合いません。語の抜けや入れ替わりがないか確認してください。',
  'errors.legacy_auth_required': 'このホームサーバーは古すぎて、このバージョンの Telium ではサインインできません。',
  'errors.mfa_not_configured': 'このアカウントには第二要素が設定されていません。',
  'errors.mfa_setup_not_started': 'コードを確認する前に、二要素認証の設定を開始してください。',
  'errors.migration_handoff_invalid': 'この移転リンクはもう有効ではありません。離れる側のアカウントから移転をやり直してください。',
  'errors.migration_in_progress': 'このアカウントは {destination} へ移転中です。移転が終わるまで、ここでは変更できません。',
  'errors.migration_refused': '{destination} は移転を拒否しました。',
  'errors.not_a_guild_server': 'そのアドレスはギルドをホストしていません。',
  'errors.opaque_downgrade': 'このサーバーは、あなたのアカウントが使う方式より古く弱いサインイン方式を提示しました。Telium はパスワードを送信していません。公衆ネットワークを使っている場合は、別の場所からもう一度お試しください。',
  'errors.opaque_required': 'このアカウントは、このバージョンの Telium が扱えない新しい方式でサインインします。Telium を更新してからもう一度お試しください。',
  'errors.owner_only': 'それはこのギルドの所有者だけが行えます。',
  'errors.reauth_expired': '時間がかかったため、もう一度パスワードが必要です。',
  'errors.recovery_attempt_expired': 'この復旧の試みは期限が切れました。最初からやり直してください。',
  'errors.role_hierarchy': '最高位のロールが自分より上位の人に対しては、その操作はできません。',
  'errors.shut_down': 'このホームサーバーは運営者によって停止されました。',
  'errors.standby_read_only': 'このサーバーは待機中で、今は読み取りしかできません。あなたのメッセージは送信されていません。',
  'errors.timed_out': 'ここでは {expires_at, time, short} までタイムアウト中です。',
  'errors.try_again': 'ほかの何かが今それを使っています。少ししてからもう一度お試しください。',
  'errors.unsupported_media_type': '次の形式のファイルはここでは受け付けられません：{media_type}。',
  'errors.username_invalid': '{reason, select, too_short {そのユーザー名は短すぎます。} too_long {そのユーザー名は長すぎます。} charset {ユーザー名には英字、数字、ドット、ハイフン、アンダースコアを使えます。} reserved {そのユーザー名は予約されています。} other {そのユーザー名はここでは使えません。}}',

  // ---- guild
  'guild.overview.vanity.address': 'ギルドのアドレス：{address}',
  'guild.overview.vanity.hint': '既定ではオフです。有効にすると、そのアドレスを持つ人は誰でもこのギルドをプレビューして参加できます。招待リンクも引き続き使えます。',
  'guild.overview.vanity.label': 'アドレス名',
  'guild.overview.vanity.linkClipboard': 'バニティリンク',
  'guild.overview.vanity.linkLabel': 'ブラウザー用リンク',
  'guild.overview.vanity.placeholder': 'linuxcommunity',
  'guild.overview.vanity.saveFailed': 'バニティリンクを保存できませんでした',
  'guild.overview.vanity.title': 'バニティリンク',
  'guild.overview.vanity.toggle': 'バニティリンクを有効にする',

  // ---- migration
  'migration.banner.alert': '{subject, select, guild {ギルド {subjectId}} other {あなたのアカウント}}は {destination} へ移転するよう設定されています{when, select, soon {（受け取られ次第すぐ）} other {（{at, date, short} {at, time, withSeconds}}}）。心当たりがない場合は、取り消してパスワードを変更してください。{mailed, select, sent { 復旧用メールアドレスにも警告を送信しました。} other {}}',
  'migration.banner.cancel': '移転を取り消す',
  'migration.banner.cancelFailed': '移転を取り消せませんでした：{reason}',
  'migration.banner.more': '{count, plural, one {あと#件の予定された移転が待っています。設定を開いて確認してください。} other {あと#件の予定された移転が待っています。設定を開いて確認してください。}}',
  'migration.confirm.account': '<b>次のアカウント {subjectId} を {me} へ移転しますか？</b>移転は、そのアカウントのパスワードを使って {source} で承認する必要があります。',
  'migration.confirm.anotherServer': '別のサーバー',
  'migration.confirm.confirming': '確認しています…',
  'migration.confirm.done': '<b>{source} に、この{subject, select, guild {ギルド} other {アカウント}}の準備ができたことが伝えられました。</b>まだ何も移転していません。移転を始めたウィンドウに戻ってください。{source} が {target} を{subject, select, guild {ギルドの新しい所有者} other {移転先}}として表示し、クーリングオフ期間が始まる前にそこでパスワードを求めます。',
  'migration.confirm.failed': 'この移転を確認できませんでした：{reason}',
  'migration.confirm.guild': '<b>ギルド {guild} を {source} から受け取りますか？</b>ここでは {me} が所有することになります。移転は、ギルドの所有者が {source} で承認する必要があります。',
  'migration.confirm.guildNamed': '「{name}」（{id}）',
  'migration.confirm.notNow': '今はしない',
  'migration.confirm.notYou': 'もし、{subject, select, guild {ギルド} other {アカウント}}を {source} から移転し始めた覚えがない場合は、「今はしない」を選んでください。確認しない限り何も送信されません。',
  'migration.confirm.receive': '{subject, select, guild {このギルドを受け取る} other {このアカウントを受け取る}}',
  'migration.confirm.sending': '確認を送信しています：{source} へ…',
  'migration.confirm.thisAccount': 'このアカウント',
  'migration.confirm.wrongServer': '<b>このリンクは、{subject, select, guild {あるギルド} other {あるアカウント}}を {destination} へ移転するためのものです。</b>あなたは {here} にサインインしています。サインアウトしてから、{destination} にサインインするか登録し、リンクをもう一度開いてください。何も送信されていません。',
  'migration.field.destination': '移転先のサーバー',
  'migration.field.destinationPlaceholder': 'newhome.example.org',
  'migration.field.oldAccountId': '元のアカウント ID',
  'migration.field.oldGuildId': '元のギルド ID',
  'migration.field.oldServer': '元のサーバー',
  'migration.field.password': 'このサーバーでのパスワード',
  'migration.field.passwordHint': 'これは元の（現在の）サーバーのパスワードで、移転先のものではありません。',
  'migration.guided.authorize': '承認するにはパスワードをもう一度入力してください。予約するとクーリングオフ期間が始まり、その間はあなたのどの端末からでも取り消せます。',
  'migration.guided.continue': '新しいサーバーで続ける',
  'migration.guided.finishThere': '<b>まず {destination} で完了してください。</b> 次に {destination} 自身のページでウィンドウが開きました。サインインするか、{subject, select, guild {そこでギルドを所有するアカウントを作成} other {移転先となるアカウントを作成}}し、そこで確認してください。',
  'migration.guided.intro': '{subject, select, guild {このギルドを移転するサーバーを入力してください。} other {移転先のサーバーを入力してください。}}そのページで確認し、ここに戻ってパスワードで承認してください。',
  'migration.guided.linkExpired': 'そのリンクは失効しました。やり直すと新しいリンクを取得できます。',
  'migration.guided.lookingUp': '照会しています：{destination}…',
  'migration.guided.noClient': '{destination} は移転を受け取るためのウェブページを公開していません。そのサーバーで作成したインポートコードを使えば、そこへ移転できます。',
  'migration.guided.noWindow': 'ウィンドウが開かなかった場合：<a>{url}</a>',
  'migration.guided.openAgain': 'もう一度開く',
  'migration.guided.opening': '開いています…',
  'migration.guided.ready': '<b>{destination} の準備ができました。</b> {subject, select, guild {このギルド {name} は {destination} へ移転し、そこでは <id>{target}</id> が所有します。} other {このアカウント {name} は <id>{target}</id> へ移転します。}}確認したアカウントがこれと違う場合は、ここで取り消してください。',
  'migration.guided.startFailed': '移転を開始できませんでした：{reason}',
  'migration.guided.step': 'ステップ {current, number} / {total, number}',
  'migration.guided.useCode': 'インポートコードを使う',
  'migration.guided.waiting': '待っています：{destination} が確認するのを…このリンクは一度だけ使え、{expiresAt, relative}に失効します。',
  'migration.importCode.hint': '一度だけ使え、有効期間も短いコードです。元のサーバーの移転ダイアログにのみ貼り付けてください。',
  'migration.importCode.label': 'インポートコード',
  'migration.importCode.placeholder': '移転先で発行された一度だけのコード',
  'migration.importCode.sourceHint': '移転先の 設定 → アカウント → 移転を受け取る で作成します。7日後に失効します。',
  'migration.manual.destinationHint': 'インポートコードを今作成したサーバーです。',
  'migration.manual.step1': '{step, number}. 移転先のサーバーを準備します。',
  'migration.manual.step1Where': '移転先にしたいサーバーでサインインし、設定 → アカウント → 移転を受け取る を開きます。これにより、この元の場所専用の一度だけのインポートコードが作成されます。',
  'migration.manual.step1Which': 'アカウントの場合は、そこで作成した移転先のアカウントを使います。ギルドの場合は、そこで所有するアカウントを使います。',
  'migration.manual.step2': '{step, number}. このサーバーで移転を承認します。',
  'migration.manual.step2Cooling': '予約するとクーリングオフ期間が始まります。移転が実行される前に、有効な端末から取り消せます。',
  'migration.manual.step2Password': '下に現在のパスワードをもう一度入力してください。',
  'migration.manual.useGuided': 'ガイド付きの移転を使う',
  'migration.receive.accountIdHint': '元のサーバーでのあなたの完全な ID（例：@you:old.example）です。',
  'migration.receive.accountIdPlaceholder': '@you:old.example',
  'migration.receive.another': '別のコードを作成',
  'migration.receive.approvalFor': 'この承認は {subjectId} に対する、{source} からのものです。',
  'migration.receive.create': 'インポートコードを作成',
  'migration.receive.creating': '準備しています…',
  'migration.receive.expires': '失効します：{expiresAt, date, medium}（{expiresAt, relative}）。',
  'migration.receive.guildIdHint': '元のサーバーに表示されているとおりに、ギルド ID を正確にコピーしてください。',
  'migration.receive.guildIdPlaceholder': '元のサーバーのギルド ID',
  'migration.receive.guildOwner': '移転されたギルドは、ここではあなたがサインインしているアカウントが所有します。',
  'migration.receive.intro': '<b>移転先として {destination} を準備しています。</b>この手順で何かが移転したり削除されたりすることはありません。',
  'migration.receive.nextTitle': '次に元のサーバーに戻ります。',
  'migration.receive.nextUse': 'その移転ダイアログで、移転先のサーバーとして {destination} を指定し、上のインポートコードを貼り付けてください。',
  'migration.receive.prepareFailed': 'このサーバーを準備できませんでした：{reason}',
  'migration.receive.preparing': '元のサーバーを確認し、一度だけのインポートコードを作成しています…',
  'migration.receive.ready': '<b>{destination} はこの移転を受け取る準備ができました。</b>まだ何も移転していません。',
  'migration.receive.sourceFromId': '上のアカウント ID から読み取ります。',
  'migration.receive.sourceGuildHint': '現在ギルドをホストしているサーバーです。',
  'migration.receive.sourcePlaceholder': 'old.example',
  'migration.receive.subject': '何を受け取りますか？',
  'migration.receive.subjectAccount': 'アカウント',
  'migration.receive.subjectGuild': 'ギルド',
  'migration.receive.thisServer': 'このサーバー',
  'migration.receive.title': '移転を受け取る',
  'migration.schedule.action': '移転を予約',
  'migration.schedule.busy': '予約しています…',
  'migration.schedule.failed': '移転を開始できませんでした：{reason}',
  'migration.schedule.noDeviceKey': 'この端末には保存された署名鍵がありません。移転は、すでにこのアカウントに属している端末から開始する必要があります。',
  'migration.schedule.scheduling': '移転を予約しています…',
  'migration.schedule.signFailed': 'この端末は移転の承認に署名できませんでした。',
  'migration.schedule.signing': 'この端末で移転に署名しています…',
  'migration.scheduled.cancelHint': 'クーリングオフ期間中は、設定 → アカウントから取り消せます。',
  'migration.scheduled.headline': '<b>移転は予約されただけで、まだ完了していません。</b>「予約」を押しても何も削除されていません。有効な端末が先に取り消さない限り、{destination} へ {at, relative}に移転します。',
  'migration.title.account': 'このアカウントを移転',
  'migration.title.guild': 'このギルドを移転',

  // ---- notifications
  'notifications.alerts.callRing.hint': '会話で誰かがあなたを呼んでいる間、繰り返し鳴る着信音です。応答するか、断るか、相手が諦めると止まります。',
  'notifications.alerts.callRing.label': '着信時に鳴らす',
  'notifications.alerts.dms.hint': 'DM のメッセージはすべてあなた宛てなので、メンションではカバーされません。',
  'notifications.alerts.dms.hintAndroid': 'Telium がバックグラウンドまたは完全に閉じている間に、暗号化された DM やグループチャットの通知を表示します。強制終了されたアプリの通知は、MLS が再び動作するまで一般的な内容にとどまります。',
  'notifications.alerts.dms.label': 'ダイレクトメッセージ時に通知',
  'notifications.alerts.mentions.hint': 'Telium がバックグラウンドにある間にメンションされると通知を表示します。',
  'notifications.alerts.mentions.label': 'メンション時に通知',
  'notifications.alerts.preview.full': '全文プレビュー',
  'notifications.alerts.preview.hidden': '送信者と内容を隠す',
  'notifications.alerts.preview.hint': 'この端末でシステム通知が何を表示するかを決めます。設定はアカウントと同期されますが、メッセージの内容は引き続き Telium の暗号化された通知経路の中にとどまります。',
  'notifications.alerts.preview.label': '通知のプレビュー',
  'notifications.alerts.preview.sender': '送信者・タイトルのみ',
  'notifications.alerts.sound.hint': 'クライアントが動作している間、前面にあるかどうかに関わらず鳴ります。',
  'notifications.alerts.sound.label': 'メンションと DM で音を鳴らす',
  'notifications.alerts.soundMessages.hint': '読んでいるチャンネルのすべてのメッセージで、あなた宛てのものだけではありません。',
  'notifications.alerts.soundMessages.label': '通常のメッセージでも鳴らす',
  'notifications.alerts.title': '通知',
  'notifications.local.blockedBrowser': 'ブラウザーの設定でこのサイトの通知がブロックされています。まずそこで再度許可してください。',
  'notifications.local.blockedSystem': 'オペレーティングシステムの設定で通知がブロックされています。まずそこで Telium を再有効化してください。',
  'notifications.local.browserPermission': 'ブラウザーの許可',
  'notifications.local.description': 'Telium がバックグラウンドで動作している間の、このブラウザーまたはデスクトップアプリからの通知です。',
  'notifications.local.enable': '有効にする',
  'notifications.local.enabled': 'この端末で通知を有効にしました。',
  'notifications.local.enableFailed': '通知を有効にできませんでした：{reason}',
  'notifications.local.enabling': '有効にしています…',
  'notifications.local.permissionState': '{state, select, loading {確認しています…} granted {許可済み} denied {ブロック中} unsupported {利用不可} other {まだ確認していません}}',
  'notifications.local.reload': '再読み込み',
  'notifications.local.systemPermission': 'システムの許可',
  'notifications.local.title': 'ローカル通知',
  'notifications.local.unsupported': 'このブラウザーではローカル通知を利用できません。',
  'notifications.local.updateReady': '新しいビルドがインストールされました',
  'notifications.push.android.action': '{stage, select, unverified {呼び出しを試す} inbox {設定を完了} other {設定}}',
  'notifications.push.android.enrolled': '{outcome, select, verified {Android のバックグラウンド通知はテスト呼び出しに合格しました。} endpoint {Android はプッシュのエンドポイントを登録しましたが、呼び出しの配信は確認されていません。} other {Android のプッシュは設定済みで、呼び出しエンドポイントを登録しています。}}',
  'notifications.push.android.enrollFailed': 'Android の通知を登録できませんでした：{reason}',
  'notifications.push.android.label': 'Android のバックグラウンド通知',
  'notifications.push.android.notice': '{stage, select, ready {バックグラウンドでの呼び出しの準備ができました。Telium は設定済みのプッシュ配信元を通じて、内容を含まない実際のテスト呼び出しを送信し、Android がそれがネイティブのプッシュサービスに届いたことを確認しました。} unverified {暗号化された受信箱とプッシュのエンドポイントは登録されていますが、確認済みの呼び出しはまだこの電話に届いていません。Telium を閉じている間の通知に頼る前に、呼び出しを試してください。} inbox {暗号化された受信箱は準備できていますが、この端末にはまだ確認済みの呼び出しエンドポイントがありません。設定を完了して、Android のプッシュ配布元を選ぶか更新してください。} none {バックグラウンド配信のために、暗号化された Android の受信箱とプッシュ配布元を設定してください。} other {まずシステムの通知を有効にすると、Telium がこの Android 端末を暗号化されたバックグラウンド配信に登録できます。}}',
  'notifications.push.android.state': '{stage, select, checking {確認しています…} ready {準備完了} unverified {呼び出しは未確認} inbox {受信箱のみ} other {未設定}}',
  'notifications.push.android.testing': '試しています…',
  'notifications.push.description': 'プッシュ配信元は Telium を起こすだけです。通知の内容は Telium の暗号化された受信箱の中にとどまります。',
  'notifications.push.desktopOnly': 'デスクトップ通知は Telium が動作している間は機能します。完全に閉じたデスクトップアプリを起こす機能はまだ実装されていません。',
  'notifications.push.privacyHint': '配信元からの呼び出しにメッセージの内容は含まれません。Android と対応ブラウザーは、中身の分からない受信箱の行を取得し、端末上で復号し、正常に処理できた行だけを確認応答します。',
  'notifications.push.title': 'バックグラウンドプッシュ',
  'notifications.push.unsupported': 'このブラウザーはこの端末でバックグラウンドプッシュを登録できません。',
  'notifications.push.web.hint': '暗号化された Web Push の購読をホームサーバーに登録します。',
  'notifications.push.web.label': '閉じているときにこのブラウザーを起こす',
  'notifications.push.web.off': 'このブラウザーではバックグラウンドプッシュが無効です。',
  'notifications.push.web.offFailed': 'プッシュを無効にできませんでした：{reason}',
  'notifications.push.web.on': 'このブラウザーは通知のために起動できます。',
  'notifications.push.web.onFailed': 'プッシュを有効にできませんでした：{reason}',
  'notifications.system.appName': 'Telium',
  'notifications.system.attachmentFrom': '{sender} が添付ファイルを送信しました',
  'notifications.system.calling': '呼び出しています：{name}',
  'notifications.system.channelTitle': '#{channel}',
  'notifications.system.encryptedFrom': '{sender} が暗号化されたメッセージを送信しました',
  'notifications.system.generic': '新しい通知',
  'notifications.system.incomingCall': '着信',
  'notifications.system.messageFrom': '{sender}：{message}',
  'notifications.system.newDm': '新しいダイレクトメッセージ',
  'notifications.system.newMention': '新しいメンション',
  'notifications.system.newReply': '新しい返信',
  'notifications.system.showFailed': '通知を表示できませんでした',
  'notifications.system.unknownChannel': 'チャンネル',
  'notifications.wake.activity': 'フォローしているチャンネルに新しい動きがあります。',
  'notifications.wake.migration': 'あなたのアカウントの移転が要求されました。Telium を開いて確認または取り消してください。',
  'notifications.wake.updateToast': '新しいバージョンの準備ができました。再読み込みすると使えます。',

  // ---- onboarding
  'onboarding.address.clipboardLabel': 'アドレス',
  'onboarding.address.copy': 'アドレスをコピー',
  'onboarding.address.yours': 'あなたの Telium アドレスは <b>{user}</b> です。別の端末でサインインするときに必要になります。',
  'onboarding.home.advancedHint': '詳細：登録を許可している Telium ホームサーバーの HTTPS アドレスを入力してください。',
  'onboarding.home.advancedPlaceholder': 'https://home.example',
  'onboarding.home.browseAll': 'すべてのサーバーを見る',
  'onboarding.home.chipAction': '{host} — アカウントの置き場所を変更',
  'onboarding.home.chooseOther': '別のものを選ぶ',
  'onboarding.home.communityBadge': 'コミュニティ',
  'onboarding.home.detailSeparator': ' · ',
  'onboarding.home.explainer': 'このサーバーはアカウントとサインインを保管します。コミュニティはどこにでも置けます。',
  'onboarding.home.finding': '健全なコミュニティサーバーを探しています…',
  'onboarding.home.label': 'ホームサーバー',
  'onboarding.home.noPinnedKey': 'このクライアントビルドは、推薦の署名鍵をまだ固定していません。',
  'onboarding.home.operatedBy': '運営：<a>{operator}</a>',
  'onboarding.home.otherChoices': 'ほかの推奨アカウントホーム',
  'onboarding.home.picked': 'あなたのために <b>{name}</b> を選びました',
  'onboarding.home.title': 'アカウントのホーム',
  'onboarding.home.unavailable': '今は確認済みのコミュニティ推薦がありません。代わりに、信頼できるホームサーバーを選んでください。',
  'onboarding.home.uptime': '{rate, number}% の最近の稼働率',
  'onboarding.home.useAnother': '別のサーバーを使う',
  'onboarding.home.useDomain': 'サーバーのドメインを使う',
  'onboarding.home.why': 'ここがあなたのアカウントの居場所で、メールプロバイダーを選ぶのに少し似ています。どのサーバーを使っていても、誰とでも話せて、どんなコミュニティにも参加できます。Telium が一つの会社に依存しないよう、新しい人たちを信頼できるサーバーに分けています。',
  'onboarding.invite.accountIdLabel': 'ユーザー名またはアカウント ID',
  'onboarding.invite.accountIdPlaceholder': 'yourname または @you:home.example',
  'onboarding.invite.accountReady': 'アカウントの準備ができました。',
  'onboarding.invite.backToSignIn': 'サインインに戻る',
  'onboarding.invite.createAndJoin': 'アカウントを作成して参加：{guild}',
  'onboarding.invite.createFailed': 'アカウントを作成できませんでした。',
  'onboarding.invite.creating': 'アカウントを作成しています…',
  'onboarding.invite.displayNameHint': 'あとで変更できます。',
  'onboarding.invite.displayNameLabel': '表示名',
  'onboarding.invite.displayNamePlaceholder': 'みんなに何と呼ばれたいですか？',
  'onboarding.invite.existingHomeHint': '既存の Telium アカウントがあるサーバーです。',
  'onboarding.invite.expiredBody': '期限切れか、使用回数の上限に達したか、取り消された可能性があります。',
  'onboarding.invite.expiredTitle': 'この招待はもう有効ではありません',
  'onboarding.invite.goToTelium': 'Telium へ移動',
  'onboarding.invite.haveAccount': 'すでに Telium アカウントをお持ちですか？<a>サインイン</a>',
  'onboarding.invite.homeHint': '新しいアカウントが置かれる場所です。変更しても招待は変わりません。',
  'onboarding.invite.homePlaceholder': 'home.example',
  'onboarding.invite.hostNote': '<b>{domain}</b> がこのギルドをホストしています。アカウントは別の Telium サーバーに置くこともできます。',
  'onboarding.invite.invited': '参加に招待されました',
  'onboarding.invite.invitedBy': '{name} が参加に招待しました',
  'onboarding.invite.join': '参加先：{guild}',
  'onboarding.invite.joinFailed': 'このギルドに参加できませんでした。',
  'onboarding.invite.joining': '参加しています…',
  'onboarding.invite.joiningAs': '次の名前で参加します：{name}。',
  'onboarding.invite.legacyRegisterAction': '従来の登録を使う',
  'onboarding.invite.legacyServer': '<b>このホームサーバーは従来のパスワード認証を使っています。</b>続けるとパスワードがこのサーバーに送られます。信頼できる場合にのみ行ってください。',
  'onboarding.invite.legacySignInAction': '従来のサインインを使う',
  'onboarding.invite.legacyUpgrade': '<b>この古いアカウントには一度だけのセキュリティ更新が必要です。</b>今回の試行のときだけ、サーバーがパスワードを受け取ります。以後のサインインでは受け取りません。',
  'onboarding.invite.legacyUpgradeAction': 'このアカウントを更新',
  'onboarding.invite.members': '{count, plural, one {#人のメンバー} other {#人のメンバー}}',
  'onboarding.invite.mfaLabel': '認証コード',
  'onboarding.invite.mfaPlaceholder': '123456 または復旧コード',
  'onboarding.invite.mfaPrompt': '認証アプリの6桁のコード、または復旧コードのいずれかを入力してください。',
  'onboarding.invite.needAccount': 'Telium アカウントが必要ですか？<a>作成する</a>',
  'onboarding.invite.needCredentials': 'ユーザー名とパスワードを入力してください。',
  'onboarding.invite.needDisplayName': 'ギルドの人たちに見える表示名を選んでください。',
  'onboarding.invite.needHome': 'アカウントのホームサーバーを選んでください。',
  'onboarding.invite.newHomeHint': '新しい Telium アカウントが属するサーバーです。',
  'onboarding.invite.noIdentityRole': '{name} はユーザーアカウントをホストしていません。',
  'onboarding.invite.online': '{count, plural, one {#人オンライン} other {#人オンライン}}',
  'onboarding.invite.opening': '招待を開いています…',
  'onboarding.invite.openingHint': 'このリンクが何を開くのか、ギルドのサーバーに問い合わせています。',
  'onboarding.invite.registrationClosed': '{name} は新しいアカウントを受け付けていません。',
  'onboarding.invite.screeningPending': 'アカウントの準備ができました。このギルドでは、メンバーになる前に審査があります。',
  'onboarding.invite.signInAndJoin': 'サインインして参加：{guild}',
  'onboarding.invite.signInFailed': 'サインインできませんでした。',
  'onboarding.invite.signingIn': 'サインインしています…',
  'onboarding.invite.unopenableTitle': 'この招待を開けませんでした',
  'onboarding.invite.unreachable': 'ギルドのサーバーに接続できませんでした。',
  'onboarding.invite.useAnotherAccount': '別のアカウントを使う',
  'onboarding.invite.usernameHint': 'これは Telium アカウント ID の最初の部分になります。',
  'onboarding.invite.usernamePlaceholder': 'yourname',
  'onboarding.recoveryKey.body': 'パスワードのリセットと、暗号化されたアカウントの復旧ができます。',
  'onboarding.recoveryKey.clipboardLabel': '復旧鍵',
  'onboarding.recoveryKey.confirm': '復旧鍵を保存しました',
  'onboarding.recoveryKey.copy': '復旧鍵をコピー',
  'onboarding.recoveryKey.download': 'ファイルとしてダウンロード',
  'onboarding.recoveryKey.finishing': '完了しています…',
  'onboarding.recoveryKey.title': '復旧鍵を保存',
  'onboarding.recoveryKey.warning': '<b>パスワードとは別に保管してください。</b>作り直すことはできません。',

  // ---- perms
  'perms.add_reactions.hint': 'メッセージに新しいリアクションを付けられます。既存のリアクションに加わるのに権限は要りません。',
  'perms.add_reactions.label': 'リアクションの追加',
  'perms.administrator.hint': 'このサーバーのすべての権限を持ち、すべてのチャンネル上書きが無視されます。ギルドそのものを任せられる相手にだけ与えてください。',
  'perms.administrator.label': '管理者',
  'perms.attach_files.hint': '画像やファイルをこのギルド専用のメディアストアにアップロードできます。',
  'perms.attach_files.label': 'ファイルの添付',
  'perms.ban_members.hint': 'ユーザーIDで、あらゆるホームサーバーをまたいでアカウントの再参加を禁止できます。',
  'perms.ban_members.label': 'メンバーの BAN',
  'perms.connect.hint': '自分が見られるボイスチャンネルに参加できます。',
  'perms.connect.label': '接続',
  'perms.create_invite.hint': 'どのホームサーバーのアカウントでも参加できる招待コードを発行できます。',
  'perms.create_invite.label': '招待の作成',
  'perms.deafen_members.hint': 'ほかの人がボイスチャンネルを聞こえないようにできます。',
  'perms.deafen_members.label': 'メンバーのスピーカーミュート',
  'perms.embed_links.hint': '投稿したリンクをプレビューに展開できます。',
  'perms.embed_links.label': 'リンクの埋め込み',
  'perms.kick_members.hint': '自分より下位のメンバーを追い出せます。キックは BAN ではありません。新しい招待で戻ってこられます。',
  'perms.kick_members.label': 'メンバーのキック',
  'perms.manage_channels.hint': 'このギルドのチャンネルを作成・名前変更・並べ替え・削除できます。',
  'perms.manage_channels.label': 'チャンネルの管理',
  'perms.manage_expressions.hint': 'このギルドが配信する絵文字とスタンプをアップロード・削除できます。',
  'perms.manage_expressions.label': '絵文字とスタンプの管理',
  'perms.manage_guild.hint': 'ギルドの名前、アイコン、参加ゲート、ボイスリージョンを変更できます。',
  'perms.manage_guild.label': 'サーバーの管理',
  'perms.manage_messages.hint': '誰のメッセージでも削除・ピン留めできます。',
  'perms.manage_messages.label': 'メッセージの管理',
  'perms.manage_roles.hint': '自分より下位のロールを編集し、そのロールを誰にでも付与できます。ただし、自分が持っていない権限を付与することはできません。',
  'perms.manage_roles.label': 'ロールの管理',
  'perms.mention_everyone.hint': 'ギルド全体、または任意のロールに通知できます。そのロールがメンション可能かどうかは関係ありません。',
  'perms.mention_everyone.label': '@everyone とロールへのメンション',
  'perms.moderate_members.hint': 'メンバーをしばらく発言停止にできます。タイムアウト中のメンバーは読むことだけができます。',
  'perms.moderate_members.label': 'メンバーのタイムアウト',
  'perms.move_members.hint': '人をボイスチャンネル間で、またはチャンネルの外へドラッグできます。',
  'perms.move_members.label': 'メンバーの移動',
  'perms.mute_members.hint': 'ボイスチャンネルでほかの人をミュートにできます。',
  'perms.mute_members.label': 'メンバーのミュート',
  'perms.priority_speaker.hint': '話している間、ほかの誰よりも大きく聞こえるようにできます。',
  'perms.priority_speaker.label': '優先スピーカー',
  'perms.read_message_history.hint': '自分が来る前に交わされた内容を見られます。これがないとチャンネルは空の状態から始まります。',
  'perms.read_message_history.label': 'メッセージ履歴の閲覧',
  'perms.send_messages.hint': '自分が見られるテキストチャンネルに投稿できます。',
  'perms.send_messages.label': 'メッセージの送信',
  'perms.speak.hint': 'ボイスで声が届きます。これがないと聞くことしかできません。',
  'perms.speak.label': '発言',
  'perms.stream.hint': 'ボイスで画面を共有できます。',
  'perms.stream.label': '配信',
  'perms.use_external_emoji.hint': 'ほかのギルドやほかのホームサーバーが配信する絵文字を使えます。',
  'perms.use_external_emoji.label': '外部絵文字の使用',
  'perms.video.hint': 'ボイスでカメラをオンにできます。',
  'perms.video.label': 'ビデオ',
  'perms.view_audit_log.hint': 'このサーバーで誰が何を変更したかの記録を読めます。',
  'perms.view_audit_log.label': '監査ログの表示',
  'perms.view_channel.hint': '上書きで締め出されていないチャンネルを見られます。',
  'perms.view_channel.label': 'チャンネルの表示',

  // ---- security
  'security.codes.clipboardName': '復旧コード',
  'security.codes.copy': 'コピーする',
  'security.codes.download': 'ファイルとしてダウンロード',
  'security.codes.fileHeading': 'Telium 二要素認証の復旧コード',
  'security.codes.listLabel': '{count, plural, one {#件の復旧コード} other {#件の復旧コード}}',
  'security.codes.title': '復旧コード',
  'security.codes.warning': '<b>先に進む前にこれらを書き留めてください。</b>それぞれ一度だけ使え、再表示されることはありません。',
  'security.devices.addedAt': '{at, date, medium}',
  'security.devices.allVerified': '{count, plural, one {あなたの端末は確認済みです。} other {あなたの端末 # 台すべてが確認済みです。}}',
  'security.devices.cannotSign': 'この端末はまだあなたのアカウントに署名できません。すでに使っている端末からこの端末を確認するか、「{pane}」でメッセージのロックを解除してください。',
  'security.devices.checking': '端末を確認しています。',
  'security.devices.colAdded': '追加日',
  'security.devices.colDevice': '端末',
  'security.devices.colLastSeen': '最終確認',
  'security.devices.empty': '記録された端末はありません。',
  'security.devices.lastSeenAt': '{at, relative}',
  'security.devices.noneVerified': '{count, plural, one {あなたの端末はまだ確認されていません。} other {あなたの端末 # 台はどれもまだ確認されていません。}}',
  'security.devices.recogniseNote': '見覚えのないものはサインアウトさせてください。',
  'security.devices.revocationBody': '端末をサインアウトさせると、ホームサーバーでその端末の認証情報が取り消されます。すでにその端末に届いたものは、届いたままです。',
  'security.devices.revocationTitle': '取り消し',
  'security.devices.revokeHint': '端末のサインアウトが反映されるまでには、数秒ではなく数分かかります。',
  'security.devices.signedOut': 'サインアウト済み',
  'security.devices.signOut': 'サインアウト',
  'security.devices.signOutDevice': 'サインアウトさせる：{device}',
  'security.devices.signOutFailed': 'その端末をサインアウトさせられませんでした。{reason}',
  'security.devices.someUnverified': '{count, plural, one {# / {total, plural, one {#台} other {#台}} の端末がまだ確認されていません。} other {# / {total, plural, one {#台} other {#台}} の端末がまだ確認されていません。}}',
  'security.devices.tableLabel': 'あなたのアカウントにサインインしている端末',
  'security.devices.thisDevice': 'この端末',
  'security.devices.unverifiedBadge': '未確認',
  'security.devices.unverifiedNote': '未確認の端末でも、あなたが送るものを読むことはできます。確認するのは、それがあなたの端末であり、あなたを名乗る誰かではないと確かめるためです。',
  'security.devices.verifiedBadge': '確認済み',
  'security.devices.verify': '確認',
  'security.devices.verifyDevice': '確認する：{device}',
  'security.devices.whatVerifiedBody': '確認済みの端末とは、あなた自身のアカウント鍵が署名した端末です。この一覧はサーバーが保管しますが、その署名を偽造することはできません。したがってこの印は、運営者が下したものではなく、あなたのアカウントが下した主張です。',
  'security.devices.whatVerifiedTitle': 'ここで「確認済み」が意味するもの',
  'security.mfa.appHint': '標準的な6桁の TOTP 認証アプリならどれでも使えます。',
  'security.mfa.codeFieldLabel': '6桁のコード',
  'security.mfa.codeLabel': '認証アプリまたは復旧コード',
  'security.mfa.disable': '二要素認証をオフにする',
  'security.mfa.disabledToast': '二要素認証をオフにしました。',
  'security.mfa.disableFailed': '二要素認証をオフにできませんでした。{reason}',
  'security.mfa.enabled': '{remaining, plural, =0 {二要素認証はオンで、復旧コードは残っていません。認証アプリを失うとサインインできなくなります — 二要素認証をオフにして設定し直すと、新しいコードの組を取得できます。} one {二要素認証はオンです。復旧コードは残り#件です。} other {二要素認証はオンです。復旧コードは残り#件です。}}',
  'security.mfa.enabledNoCount': '二要素認証はオンです。',
  'security.mfa.enabledToast': '二要素認証をオンにしました。',
  'security.mfa.enableFailed': '二要素認証をオンにできませんでした。{reason}',
  'security.mfa.manualHint': '認証アプリが QR コードを読み取れない場合にのみ使ってください。',
  'security.mfa.manualLabel': '手動設定用の鍵',
  'security.mfa.qrLabel': '認証アプリを設定するための QR コード',
  'security.mfa.reauthHint': 'パスワードをもう一度入力してください。この端末で確認され、送信されません。',
  'security.mfa.scanWarning': 'この QR コードを読み取り、表示されたコードを入力してください。それが成功するまで二要素認証はオンになりません。',
  'security.mfa.setUp': '認証アプリを設定',
  'security.mfa.setupFailed': '二要素認証の設定を開始できませんでした。{reason}',
  'security.mfa.title': '二要素認証',
  'security.mfa.verifyEnable': '確認してオンにする',
  'security.mfa.whyPasswordBody': 'OPAQUE のホームサーバーでは、パスワードがこの端末から出ることはありません。ここで入力すると、あなたがアカウントの持ち主であることを示す一度だけ使える証明が作られ、それがこの変更を承認します。',
  'security.mfa.whyPasswordTitle': 'パスワードをもう一度求める理由',
  'security.trustedLinks.description': 'これらのドメインへのリンクは確認なしで開きます。サーバーの外にあるそれ以外のものは、先に確認を求められます。',
  'security.trustedLinks.empty': 'まだどのドメインも信頼していません。',
  'security.trustedLinks.forget': '再確認する：{domain}',
  'security.trustedLinks.title': '信頼済みリンク',
  'security.verify.comparePeer': 'これらを {name} と直接会って、または通話で照合してください。',
  'security.verify.compareSelf': '{count, plural, one {両方の端末にこの絵が表示されるはずです。} other {両方の端末に、この順で # 個が表示されるはずです。}}',
  'security.verify.confirmingPeer': '待っています：{name} が確認するのを…',
  'security.verify.confirmingSelf': 'もう一方の端末が確認するのを待っています…',
  'security.verify.donePeer': '{name} はあなたのすべての端末で確認済みです。相手が後から追加する端末も含みます。',
  'security.verify.doneSelf': 'その端末は確認済みです。あなたを確認済みにしている人にも同じように見えます。',
  'security.verify.finishFailed': '確認を完了できませんでした。{reason}',
  'security.verify.match': '一致します',
  'security.verify.mismatchHint': 'もし違っていれば、その間に何かが割り込んでいます。',
  'security.verify.noMatch': '一致しません',
  'security.verify.pendingHintPeer': 'どの端末が応答しても、これは相手のアカウント全体を対象にします。',
  'security.verify.pendingHintSelf': 'そちらで Telium を開いてください。両方が同時にオンラインである必要があります。',
  'security.verify.startFailed': '確認を開始できませんでした。{reason}',
  'security.verify.starting': '開始しています…',
  'security.verify.stopped': '確認を中止しました：{reason}。',
  'security.verify.stoppedByYou': '絵が一致しなかったため、確認を中止しました。その端末はまだ未確認です。',
  'security.verify.titlePeer': '確認する：{name}',
  'security.verify.titleSelf': 'もう一方の端末を確認',
  'security.verify.waitingButton': '待機中',
  'security.verify.waitingPeer': '待っています：{name} が Telium を開くのを…',
  'security.verify.waitingSelf': 'もう一方の端末を待っています…',

  // ---- settings
  'settings.messages.dateFormat.dmy': 'DD/MM/YY',
  'settings.messages.dateFormat.hint': '今日以外の日のメッセージは、時刻の横に日付を表示します。月と日のどちらを先にするかを選びます。',
  'settings.messages.dateFormat.label': '日付の形式',
  'settings.messages.dateFormat.mdy': 'MM/DD/YY',
  'settings.nav.recovery': '暗号化鍵',
  'settings.scheme.accentHue.hint': 'リンク、フォーカスリング、カーソル、未読の状態です。これしかありません。',
  'settings.scheme.accentHue.label': 'アクセントの色相',
  'settings.scheme.accentStrength.label': 'アクセントの強さ',
  'settings.scheme.depth.hintDark': '一番下まで下げると真っ黒になり、有機EL画面ではその画素が消灯します。',
  'settings.scheme.depth.hintLight': 'ページが白からどれだけ下にあるかです。',
  'settings.scheme.depth.label': '深さ',
  'settings.scheme.description': 'すべてのスライダーのどの位置でも読みやすさは保たれます。両端がそのためにあります。',
  'settings.scheme.greyHue.hint': '色味がどちらに傾くかです。色味がオフの間は何も起きません。',
  'settings.scheme.greyHue.label': 'グレーの色相',
  'settings.scheme.mode.dark': 'ダーク',
  'settings.scheme.mode.hint': '残りの項目が調整するのは、二つのパレットのどちらかです。',
  'settings.scheme.mode.label': 'ページ',
  'settings.scheme.mode.light': 'ライト',
  'settings.scheme.reading.amount': '{value, number, fixed3}',
  'settings.scheme.reading.degrees': '{value, number, integer}°',
  'settings.scheme.reading.percent': '{value, number, fixed1}%',
  'settings.scheme.separation.hint': 'カードがページからどれだけ浮き上がり、サイドバーがその背後にどれだけ沈むかです。',
  'settings.scheme.separation.label': '分離',
  'settings.scheme.tint.hint': 'グレーにどれだけ色が含まれるかです。どれも名前を付けるような色ではありません。',
  'settings.scheme.tint.label': '色味',
  'settings.scheme.tint.none': 'なし',
  'settings.scheme.title': 'あなたの配色',

  // ---- shell
  'shell.a11y.closeMembers': 'メンバーを閉じる',
  'shell.a11y.closeMenu': 'メニューを閉じる',
  'shell.a11y.openChannels': 'チャンネルを開く',
  'shell.banner.cached': '最後の状態を表示しています（{when} 時点）。再接続しています…',
  'shell.banner.reload': 'Telium を再読み込み',
  'shell.banner.retryHome': '再試行：{domain} へ',
  'shell.banner.signIn': 'もう一度サインイン',
  'shell.banner.wake': '今すぐもう一度試す',
  'shell.empty.body': '始めるにはチャンネルを選んでください。',
  'shell.empty.title': '開いているチャンネルがありません',
  'shell.fallback.lagHours': '{count, plural, one {#時間遅れ} other {#時間遅れ}}',
  'shell.fallback.lagMinutes': '{count, plural, one {#分遅れ} other {#分遅れ}}',
  'shell.fallback.lagSeconds': '{count, plural, one {#秒遅れ} other {#秒遅れ}}',
  'shell.fallback.lagUnknown': '不明な遅れ',
  'shell.fallback.promoted': '{home} は現在 {standby} が提供しています。すべて正常に動きます。',
  'shell.fallback.readOnly': '{home} が応答していません。{standby} からの読み取り専用の写しを、{lag}で表示しています。',
  'shell.members.search': 'メンバーを検索',
  'shell.socket.guildDown': '{name} が応答していません。Telium の残りの部分は正常に動きます。Telium は繰り返し試みます。これが長引く場合は、そのサーバーの運営者が尋ねるべき相手です。',
  'shell.socket.homeDown': '{name} はあなたのアカウントのサーバーで、応答していません。戻るまで、あなたが送るメッセージはどこにも届きません。Telium は繰り返し試みます。これが長引く場合は、{name} の運営者が尋ねるべき相手です。',
  'shell.socket.incompatible': '{name} は、このクライアントが扱えないバージョンの Telium を使っています。Telium を更新してからもう一度お試しください。',
  'shell.socket.malformed': '{name} は、このクライアントが送った内容を理解できませんでした。Telium を再読み込みしてください。それが続く場合、このクライアントとそのサーバーは噛み合っていません。',
  'shell.socket.offline': 'この端末はオフラインです。接続が戻り次第、Telium は続きから再開します。',
  'shell.socket.reconnecting': '{role, select, home {再接続しています：{name} へ。} other {再接続しています：{name} へ。ほかのサーバーには影響しません。}}',
  'shell.socket.restarting': '{name} は再起動中です。これは自然に復旧します。',
  'shell.socket.sessionRefused': '{role, select, home {{name} はこのセッションを認識しなくなりました。続けるにはもう一度サインインしてください。} other {{name} はこのセッションを認識しなくなりました。そこへ再接続してください。Telium の残りの部分には影響しません。}}',
  'shell.socket.unnamedServer': 'そのサーバー',
  'shell.tabs.forum': 'フォーラムの投稿',
  'shell.tabs.pinned': 'ピン留めしたメッセージ',
  'shell.title.guild': 'ギルド',

  // ---- voice
  'voice.bar.pingAvg': '平均',
  'voice.bar.pingHistory': 'Ping の履歴',
  'voice.bar.pingLast': '最後の Ping',
  'voice.log.cancel': 'キャンセル',
  'voice.log.ended': '通話終了',
  'voice.log.endedDuration': '通話終了・{duration}',
  'voice.log.incoming': '着信',
  'voice.log.missed': '不在着信',
  'voice.log.outgoing': '発信',
  'voice.log.ringing': '呼び出し中…',
  'voice.log.ringingHint': '相手が出るのを待っています。',
  'voice.status.clear': '消去',
  'voice.status.clearFailed': 'ボイスステータスを消去できませんでした',
  'voice.status.edit': 'ボイスステータスを編集',
  'voice.status.hint': '{count} / {max} 文字',
  'voice.status.label': 'ボイスステータス',
  'voice.status.placeholder': 'このルームは今何をしていますか？',
  'voice.status.save': 'ステータスを保存',
  'voice.status.saveFailed': 'ボイスステータスを設定できませんでした',
  'voice.status.set': 'ボイスステータスを設定',
  'voice.status.tooLong': '文字数を {max} 未満にしてください。',
  'voice.tile.screenAudioVolume': '画面の音声の音量',
  'voice.tile.screenAudioVolumeFor': '{name} の画面の音声の音量',

};
