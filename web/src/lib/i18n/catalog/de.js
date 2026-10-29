// Deutsch.
//
// A complete translation: every key in the English catalogue has a German
// sentence here, so nothing on a German screen falls back to English. It got
// there in two passes -- the body of this file was written by hand, and the
// block near the end headed "added to reach 100%" is a machine-assisted draft
// no human has read. That second pass is why this language carries no stamps
// in `catalog/stamps.json`: a stamp is a claim that a person read the English
// and wrote the German, and for the added block no such claim has been made.
// Everything below the header describes the hand-written body and still holds;
// treat the appending block as a draft to review, not as finished copy.
//
// -------------------------------------------------- why German ships first
//
// Not because of the number of speakers. German is the length test. It runs
// 30-40% longer than English over a screen and far worse over a button --
// "Save" is "Speichern", "Settings" is "Einstellungen", "Two-factor
// authentication" is one word with twenty-eight letters in it -- and it
// compounds rather than spacing, so a word cannot wrap in the middle the way
// an English phrase can. A layout that survives this file survives essentially
// every European language, and `src/test/i18n-layout.test.jsx` asserts that in
// the two places most likely to lose.
//
// Which is also why nothing here has been shortened to fit. The temptation is
// real -- "2FA" fits where "Zwei-Faktor-Authentifizierung" does not -- and
// giving in to it hides the bug in the layout instead of fixing it, and does
// it in a language the people who wrote the layout cannot read.
//
// ------------------------------------------------------------- conventions
//
//   * **Du, not Sie.** Telium talks to one person the way a friend does, and
//     the English copy is emphatically informal ("Slow down a moment"). `Sie`
//     would be a different product in German. Consistency matters more than
//     the choice: mixing them reads as two people wrote the app.
//   * **Nouns are capitalised**, including inside a sentence, which is not a
//     style choice.
//   * **Quantities keep their `plural`**, even where German's two categories
//     make one arm feel redundant. The arms are what the language asks for,
//     not what this sentence happens to need.

export const messages = {
  // -------------------------------------------------------------- format

  'format.justNow': 'gerade eben',
  // The unit stays untranslated -- KB is KB in German -- but the space before
  // it does not: German uses a non-breaking one in careful typography. Left as
  // a plain space to match English, because `lib/util.js` compares these
  // strings in two tests and a difference nobody can see is the worst kind.
  'format.bytes.b': '{value} B',
  'format.bytes.kb': '{value} KB',
  'format.bytes.mb': '{value} MB',
  'format.bytes.gb': '{value} GB',
  'format.bytes.tb': '{value} TB',

  // --------------------------------------------------------------- common

  'common.cancel': 'Abbrechen',
  'common.close': 'Schließen',
  'common.back': 'Zurück',
  'common.next': 'Weiter',
  'common.done': 'Fertig',
  'common.save': 'Speichern',
  'common.saving': 'Wird gespeichert…',
  'common.saved': 'Gespeichert',
  'common.confirm': 'Bestätigen',
  'common.continue': 'Fortfahren',
  'common.copy': 'Kopieren',
  'common.copied': 'Kopiert',
  // German puts the participle at the end, which is exactly why this is one
  // pattern and not `${what} copied.` assembled in JavaScript.
  'common.copiedThing': '{what} kopiert.',
  'common.clipboardFailed': 'Die Zwischenablage war nicht erreichbar.',
  'common.delete': 'Löschen',
  'common.remove': 'Entfernen',
  'common.retry': 'Erneut versuchen',
  'common.refresh': 'Aktualisieren',
  'common.edit': 'Bearbeiten',
  'common.download': 'Herunterladen',
  'common.dismiss': 'Ausblenden',
  'common.learnMore': 'Mehr erfahren',
  'common.showMore': 'Mehr anzeigen',
  'common.showLess': 'Weniger anzeigen',
  'common.search': 'Suchen',
  'common.loading': 'Wird geladen…',
  'common.enable': 'Aktivieren',
  'common.disable': 'Deaktivieren',
  'common.on': 'An',
  'common.off': 'Aus',
  'common.yes': 'Ja',
  'common.no': 'Nein',
  'common.none': 'Keine',
  'common.never': 'Nie',
  'common.unknown': 'Unbekannt',
  'common.optional': 'Optional',
  'common.required': 'Erforderlich',
  'common.empty': '—',

  'common.a11y.close': 'Schließen',
  'common.a11y.back': 'Zurückgehen',
  'common.a11y.menu': 'Weitere Aktionen',
  'common.a11y.dismissNotice': 'Diesen Hinweis ausblenden',
  'common.a11y.copyToClipboard': 'In die Zwischenablage kopieren',
  'common.a11y.showPassword': 'Passwort anzeigen',
  'common.a11y.hidePassword': 'Passwort verbergen',
  'common.a11y.loading': 'Wird geladen',
  'common.a11y.stepDone': '{step} — erledigt',

  'common.homeserver': 'Heimserver',
  'common.username': 'Benutzername',
  'common.password': 'Passwort',
  'common.email': 'E-Mail',
  'common.account': 'Konto',
  'common.device': 'Gerät',
  'common.settings': 'Einstellungen',

  'common.convo.group': '{count, plural, one {Gruppe - # Person} other {Gruppe - # Personen}}',

  // "Listening to" is a verb plus a preposition in English. German attaches
  // the preposition to the other end of the phrase and inflects the noun after
  // it, which the two-part rendering cannot express -- so the verb alone is
  // what goes here, and `common.activity.line` is where the order is fixed.
  'common.activity.playing': 'Spielt',
  'common.activity.streaming': 'Streamt',
  'common.activity.listening': 'Hört',
  'common.activity.watching': 'Schaut',
  'common.activity.competing': 'Tritt an in',
  'common.activity.line': '{verb} {name}',

  // --------------------------------------------------------------- errors

  'errors.invalid_credentials': 'Benutzername und Passwort passen zu keinem Konto auf diesem Server.',
  'errors.account_deactivated': 'Dieses Konto ist deaktiviert. Beim Anmelden wird es wieder aktiviert.',
  'errors.mfa_required': 'Gib den Code aus deiner Authentifizierungs-App ein.',
  'errors.invalid_mfa_code': 'Dieser Code stimmt nicht. Codes gelten jeweils etwa eine Minute — versuch den nächsten.',
  'errors.reauth_required': 'Bitte gib zur Sicherheit noch einmal dein Passwort ein.',
  'errors.reauth_expired': 'Das hat zu lange gedauert. Bitte gib dein Passwort noch einmal ein.',
  'errors.registration_closed': 'Dieser Heimserver nimmt derzeit keine neuen Konten an.',
  'errors.username_taken': 'Diesen Benutzernamen hat auf diesem Heimserver schon jemand.',
  'errors.invite_invalid': 'Diese Einladung gilt nicht mehr. Vielleicht ist sie abgelaufen, aufgebraucht oder zurückgezogen worden.',
  // `{permission}` is the human name from `perms.*.label`, so it is a noun
  // phrase and takes the article. German needs the article to agree with a
  // gender this sentence cannot know, so it is written to avoid one entirely.
  'errors.missing_permission': 'Dafür brauchst du die Berechtigung „{permission}“.',
  'errors.role_hierarchy': 'Das geht nicht bei jemandem, dessen höchste Rolle über deiner steht.',
  'errors.owner_only': 'Das kann nur die Inhaberin oder der Inhaber dieses Servers.',
  'errors.not_a_member': 'Du bist hier kein Mitglied.',
  // Vier Sätze statt eines Satzes mit eingesetztem Verb: `{attempted}` wird
  // ausgewählt, nicht interpoliert. Im Deutschen steht das Verb am Satzende
  // und die Nominalisierung ("das Deaktivieren") verlangt einen anderen
  // Satzbau als das englische Gerundium -- ein gemeinsames Gerüst mit
  // ausgetauschtem Verb würde hier auseinanderfallen. Der `other`-Arm ist die
  // Auffanglinie für einen Server, der neuer ist als dieser Client und einen
  // fünften Weg hinaus gefunden hat.
  //
  // `{user_id}` steht nur im `revoke`-Arm: in den anderen drei Fällen geht es
  // um das eigene Konto der Leserin oder des Lesers, und es beim Namen zu
  // nennen wäre eine seltsame Art, mit jemandem zu sprechen.
  'errors.last_admin':
    '{attempted, select, ' +
    'deactivate {Du bist das einzige Konto mit Administrationsrechten auf diesem Server, das sich anmelden kann; dein Konto zu deaktivieren würde niemanden übrig lassen, der den Server verwalten kann.} ' +
    'delete {Du bist das einzige Konto mit Administrationsrechten auf diesem Server, das sich anmelden kann; dein Konto zu löschen würde niemanden übrig lassen, der den Server verwalten kann.} ' +
    'move {Du bist das einzige Konto mit Administrationsrechten auf diesem Server, das sich anmelden kann; dein Konto auf einen anderen Heimserver umzuziehen würde niemanden übrig lassen, der den Server verwalten kann.} ' +
    'revoke {{user_id} ist das einzige Konto mit Administrationsrechten auf diesem Server, das sich anmelden kann; diesen Zugang zu entziehen würde niemanden übrig lassen, der den Server verwalten kann.} ' +
    'other {Dann bliebe diesem Server niemand mehr, der ihn verwalten und sich anmelden kann.}} ' +
    'Gib einem anderen Konto, das sich anmelden kann, Administrationsrechte und versuch es dann noch einmal.',
  'errors.timed_out': 'Du bist hier bis {expires_at, time, short} stummgeschaltet.',
  'errors.rate_limited': '{retry_after, plural, =0 {Einen Moment, dann noch einmal versuchen.} one {Einen Moment — in # Sekunde noch einmal versuchen.} other {Einen Moment — in # Sekunden noch einmal versuchen.}}',
  'errors.standby_read_only': 'Dieser Server läuft gerade nur lesend. Lesen geht, Schreiben noch nicht. Deine Nachricht wurde nicht gesendet.',
  'errors.shut_down': 'Dieser Server ist abgeschaltet.',
  'errors.try_again': 'Etwas anderes hält das gerade. Versuch es gleich noch einmal.',
  // Die Obergrenze gehört in den Satz: „zu groß“ ohne Zahl sagt niemandem, was
  // jetzt zu tun ist. `{limit, bytes}` kommt vom Server und wird von `Intl`
  // formatiert, also steht dort „8,0 MB“ mit Komma.
  'errors.too_large': 'Diese Datei ist zu groß. Das Limit liegt hier bei {limit, bytes}.',
  'errors.unsupported_media_type': 'Dateien vom Typ {media_type} werden hier nicht angenommen.',
  'errors.quota_exceeded': 'Kein Platz mehr — {used, bytes} von {limit, bytes} belegt.',
  // French puts a space before the colon; German does not. The pattern owns
  // the punctuation either way.
  'errors.context': '{context}: {message}',
  'errors.generic': 'Da ist etwas schiefgegangen.',
  // „Es liegt nicht an dir“ stand hier früher und war die falsche Hälfte der
  // Nachricht. Bei einem 500 hat der Server die Anfrage tatsächlich
  // ausgeführt und ist mittendrin gescheitert -- niemand auf dieser Seite
  // weiß, wie weit er gekommen ist. Das ist die Information, die der Satz
  // tragen muss, denn was am häufigsten 500 wirft, ist ein Schreibvorgang.
  'errors.serverFault': 'Der Server hatte ein Problem damit. Es kann sein, dass es trotzdem ausgeführt wurde.',
  // Zwei Sätze, getrennt nach `navigator.onLine`. Der erste beschuldigt den
  // Server nicht, weil ein Captive Portal genauso aussieht; der zweite nennt
  // das Gerät, weil das die eine Sache ist, die die lesende Person selbst
  // beheben kann.
  'errors.offline': 'Der Server war nicht erreichbar. Es wurde nichts gesendet; versuche es gleich noch einmal.',
  'errors.offlineDevice': 'Dieses Gerät ist offline. Es wurde nichts gesendet.',

  // ------------------------------------------------- Statuscodes ohne Text

  'errors.status.401': 'Deine Sitzung ist abgelaufen. Melde dich neu an, um weiterzumachen.',
  'errors.status.403': 'Dazu hast du hier keine Berechtigung.',
  'errors.status.404': 'Das gibt es nicht mehr.',
  'errors.status.409': 'Jemand anderes war schneller. Sieh es dir noch einmal an und versuche es erneut.',
  'errors.status.413': 'Das ist zu groß für diesen Server.',
  'errors.status.429': 'Das geht diesem Server zu schnell. Warte einen Moment und versuche es erneut.',
  'errors.status.gateway': 'Der Server antwortet gerade nicht. Versuche es gleich noch einmal.',

  // ---------------------------------------------------- Gateway-Schließung

  // Vier dieser Einträge waren vorher falsch, und zwar dieselben vier wie im
  // Englischen: sie wurden aus der Spezifikation abgeschrieben statt aus
  // `server/src/gateway/mod.rs`, und die beiden Dokumente waren
  // auseinandergelaufen. 4005 versprach eine zweite Anmeldung, wo der Server
  // einen Neustart meint -- also schickte Telium Leute zum Anmeldebildschirm,
  // während ihre Sitzung völlig in Ordnung war.
  'errors.gateway.4001': 'Telium konnte auf diesem Server keine Sitzung beginnen.',
  'errors.gateway.4002': 'Telium und dieser Server sind sich uneinig darüber, wie sie miteinander sprechen.',
  'errors.gateway.4004': 'Dieser Server hat deine Sitzung nicht angenommen. Melde dich bitte neu an.',
  'errors.gateway.4005': 'Dieser Server startet neu. Verbindung wird wiederhergestellt.',
  'errors.gateway.4008': 'Die Anmeldung an diesem Server hat zu lange gedauert. Verbindung wird wiederhergestellt.',
  'errors.gateway.4009': 'Diese Verbindung ist abgelaufen. Verbindung wird wiederhergestellt.',
  'errors.gateway.4010': 'Diese Verbindung ist zurückgefallen und wurde zurückgesetzt. Wird aufgeholt.',
  'errors.gateway.4011': 'Zu viele Telium-Verbindungen für dein Konto. Schließe eine und versuche es erneut.',
  'errors.gateway.4013': 'Dieser Server nimmt gerade sehr viele Verbindungen an. Es wird gewartet.',
  'errors.gateway.4015': 'Telium und dieser Server laufen in nicht zueinander passenden Versionen.',
  'errors.gateway.unknown': 'Die Verbindung wurde unerwartet geschlossen (Code {code}).',

  // ------------------------------------------------------ permission groups

  'perms.group.general': 'Allgemein',
  'perms.group.membership': 'Mitgliedschaft',
  'perms.group.text': 'Textkanäle',
  'perms.group.voice': 'Sprachkanäle',
  'perms.group.advanced': 'Erweitert',

  // ------------------------------------------------------------- settings

  'settings.theme.title': 'Erscheinungsbild',
  'settings.theme.description': 'Gilt auch auf deinen anderen Geräten.',
  'settings.theme.preset.graphite.name': 'Graphit',
  'settings.theme.preset.graphite.description': 'Tiefes, neutrales Grau. Die Voreinstellung.',
  'settings.theme.preset.obsidian.name': 'Obsidian',
  'settings.theme.preset.obsidian.description': 'Schwarz bis ins Pixel, das ein OLED-Bildschirm gar nicht erst anschaltet.',
  'settings.theme.preset.ash.name': 'Asche',
  'settings.theme.preset.ash.description': 'Ein wärmeres, helleres Grau für einen Raum mit Lampe.',
  'settings.theme.preset.midnight.name': 'Mitternacht',
  'settings.theme.preset.midnight.description': 'Violett im Grau, so wie Telium früher aussah.',
  'settings.theme.preset.evergreen.name': 'Immergrün',
  'settings.theme.preset.evergreen.description': 'Dunkel, mit dem Grün eines langen Abends drinnen.',
  'settings.theme.preset.paper.name': 'Papier',
  'settings.theme.preset.paper.description': 'Papierweiß, für einen hellen Raum.',
  'settings.theme.custom.label': 'Selbst zusammenstellen',
  'settings.theme.custom.description': 'Ein paar Regler, und die App verändert sich darunter mit.',

  'settings.scheme.title': 'Dein Farbschema',
  'settings.scheme.description': 'Jede Reglerstellung bleibt lesbar; dafür sind die Endpunkte da.',
  'settings.scheme.mode.label': 'Seite',
  'settings.scheme.mode.hint': 'Welche der beiden Paletten die übrigen Regler verändern.',
  'settings.scheme.mode.dark': 'Dunkel',
  'settings.scheme.mode.light': 'Hell',
  'settings.scheme.depth.label': 'Tiefe',
  'settings.scheme.depth.hintDark': 'Ganz unten ist echtes Schwarz, das ein OLED-Bildschirm gar nicht erst anschaltet.',
  'settings.scheme.depth.hintLight': 'Wie weit die Seite unter Weiß liegt.',
  'settings.scheme.separation.label': 'Abhebung',
  'settings.scheme.separation.hint': 'Wie weit sich eine Karte von der Seite abhebt und die Seitenleiste dahinter zurücktritt.',
  'settings.scheme.tint.label': 'Farbstich',
  'settings.scheme.tint.hint': 'Wie viel Farbe in den Grautönen steckt. Nichts davon ist eine Farbe, die du benennen würdest.',
  'settings.scheme.tint.none': 'keiner',
  'settings.scheme.greyHue.label': 'Grauton',
  'settings.scheme.greyHue.hint': 'Wohin der Farbstich tendiert. Ohne Farbstich bewirkt er nichts.',
  'settings.scheme.accentHue.label': 'Akzentfarbton',
  'settings.scheme.accentHue.hint': 'Links, Fokusrahmen, Schreibmarke und Ungelesenes. Es gibt nur diesen einen.',
  'settings.scheme.accentStrength.label': 'Akzentstärke',
  // `95,2 %` -- comma as the decimal separator and a space before the sign,
  // both of which `Intl.NumberFormat` already produces for `de`. The space is
  // in the pattern because the *symbol* placement is the pattern's business
  // and the digits are `Intl`'s.
  'settings.scheme.reading.percent': '{value, number, fixed1} %',
  'settings.scheme.reading.degrees': '{value, number, integer}°',
  'settings.scheme.reading.amount': '{value, number, fixed3}',

  'settings.language.title': 'Sprache',
  'settings.language.label': 'Sprache der Oberfläche',
  'settings.language.auto': 'Sprache des Systems verwenden',
  'settings.language.hint': '{state, select, none {Vorerst nur Englisch. Telium ist zum Übersetzen gebaut — im Handbuch für Übersetzerinnen und Übersetzer steht, wie du mithelfen kannst.} partial {{languages} sind teilweise übersetzt; alles noch nicht Übersetzte erscheint auf Englisch.} other {Telium gibt es auf {languages}.}}',

  'settings.messages.title': 'Nachrichten',
  'settings.messages.compact.label': 'Kompakte Nachrichten',
  'settings.messages.compact.hint': 'Tauscht den Abstand zwischen Nachrichten gegen mehr Nachrichten auf dem Bildschirm.',
  'settings.messages.members.label': 'Mitgliederliste anzeigen',
  'settings.messages.members.hint': 'Die Mitgliederliste wird bereichsweise abonniert; sie auszublenden beendet also auch die Aktualisierungen.',
  'settings.messages.typing.label': 'Anzeigen, dass du schreibst',
  'settings.messages.typing.hint': 'Aus bedeutet, dass Gildenservern nie mitgeteilt wird, dass du angefangen hast zu schreiben.',

  // ---------------------------------------------------------- profile lookups
  //
  // The three answers to "when may this account ask a dozen servers what you
  // have in common with somebody". The labels name the act from the reader's
  // side rather than the mechanism -- "Sobald ich auf einen Namen zeige", not
  // a word for prefetching -- and none of them says which option is the safe
  // one, because the middle option makes exactly the same disclosure as the
  // loose one every time it fires. See `catalog/en/settings.js`.
  'settings.lookups.title': 'Wann nach Gemeinsamkeiten gesucht wird',
  'settings.lookups.hover.label': 'Sobald ich auf einen Namen zeige',
  'settings.lookups.hover.description': 'Gemeinsame Freunde stehen in dem Moment bereit, in dem eine Karte aufgeht. Fährst du mit dem Zeiger eine Mitgliederliste hinunter, wird zu jedem Namen gefragt, auf dem er stehen bleibt — auch zu denen, die du nie öffnen wolltest.',
  'settings.lookups.open.label': 'Wenn ich ein Profil öffne',
  'settings.lookups.open.description': 'Solange du nur Namen liest, wird nichts gefragt. Beim Öffnen eines Profils wird zu dieser einen Person gefragt, und die Antwort trägt sich einen Moment nach der Karte ein.',
  'settings.lookups.never.label': 'Nie',
  'settings.lookups.never.description': 'Es wird nie ein Server gefragt. Profile zeigen dann keine gemeinsamen Freunde und keine gemeinsamen Räume mehr — auch nicht bei Leuten, die du seit Jahren kennst.',
  // Not "Keine gemeinsamen Freunde": the client did not check, and saying
  // there are none would be a falsehood about a stranger.
  'settings.lookups.off.friendsTitle': 'Nicht nachgefragt',
  'settings.lookups.off.guildsTitle': 'Nicht nachgefragt',
  'settings.lookups.off.body': 'Profilabfragen stehen auf „nie fragen“, deshalb wurde hier nichts geprüft. Das ist keine Aussage darüber, dass es nichts Gemeinsames gibt.',

  // ---------------------------------------------------------------- privacy
  //
  // The sentences the client says about who else is on the wire. These are the
  // keys that matter most in a partial translation: an untranslated line in a
  // settings pane is a known gap, but an untranslated *privacy warning* is a
  // line the reader skips, and skipping it is the one outcome the whole
  // namespace exists to prevent. So they are translated first and in full,
  // never shortened to fit, and the English original is in
  // `catalog/en/privacy.js` with the sentence of `docs/privacy.md` each one
  // carries written above it.
  //
  // "Invisible" stays in English because the status row it sits under still
  // says Invisible -- `PRESENCE` in `components/Presence.jsx` is not on the
  // catalogue yet. Quoting the label the reader can actually see beats
  // translating a word that appears nowhere on their screen; when that row is
  // migrated, this quotation is what has to move with it.
  'privacy.presence.invisible': '„Invisible“ ist das, was allen anderen gesagt wird. Dein Heimserver sieht diese Verbindung weiterhin und zählt die Geräte, auf denen du angemeldet bist.',
  'privacy.block.body': 'Sie sehen, dass die Freundschaft endet, und nichts von ihnen erreicht dich wieder — keine Anfrage, keine Nachricht, keine Benachrichtigung, und sie erfahren nie, welche davon. Es hindert sie nicht am Senden: Dein Heimserver nimmt ihre Nachrichten weiterhin an und speichert sie, und auf ihrer Seite sieht das Gespräch ganz gewöhnlich aus.',
  'privacy.gif.head': 'Dieses Gespräch ist verschlüsselt. Das GIF nicht.',
  'privacy.gif.body': 'Dein Gerät fragt {host} nach diesen Ergebnissen und lädt alles, was du sendest, direkt von dort. Damit sehen sie deine Adresse und welches GIF du ausgewählt hast. Nichts davon läuft über deinen Heimserver, und es gibt keine Einstellung, die das abschaltet.',
  'privacy.typing.inEncrypted': 'Schreibhinweise sind die Ausnahme: Sie gehen unverschlüsselt hinaus, also sehen dein Server, die Server aller anderen und alle im Gespräch sie in dem Moment, in dem sie entstehen. Unter „Gesprächssignale“ lassen sie sich abschalten.',
  // The fan-out behind the mutual-friends chips, drawn under all three options
  // on the Profile lookups pane. "je eine signierte Frage" is load-bearing:
  // one peer per *domain*, and every such domain, including the ones that turn
  // out to have nothing to say. What travels is the question, never the
  // friend list -- the stronger claim would be wrong.
  'privacy.lookups.head': 'Herauszufinden, was du mit jemandem gemeinsam hast, ist eine Frage, die dieses Konto laut stellt.',
  'privacy.lookups.party.home': 'Dein Heimserver',
  'privacy.lookups.sees.home': 'dass du nachgesehen hast und bei wem. Deine Freundesliste hat er ohnehin, die Abfrage fügt also nur den Zeitpunkt hinzu.',
  'privacy.lookups.party.friendHosts': 'Jeder Server, auf dem jemand aus deiner Freundesliste liegt',
  'privacy.lookups.sees.friendHosts': 'je eine signierte Frage, die dich und die Person nennt, die du dir ansiehst. Gefragt werden alle, auch die, die nichts dazu zu sagen haben — jeder von ihnen erfährt also, dass du in diesem Moment gelesen hast.',
  'privacy.lookups.party.guildHosts': 'Jeder Server, auf dem du einen Raum mit ihnen teilst',
  'privacy.lookups.sees.guildHosts': 'eine Anfrage von diesem Gerät, ob die Person dort Mitglied ist — sie sehen also deine Adresse und dazu, dass du gefragt hast.',
  'privacy.lookups.note': 'Das sind die Beteiligten, die bei jeder Abfrage davon erfahren. Die Einstellung darüber ändert, wie oft das passiert und ob etwas anderes als ein bewusstes Öffnen sie auslösen kann — leiser wird eine Abfrage dadurch nicht.',

  'privacy.push.head': 'Dein Push-Dienst ist der Dienst deines Browser-Herstellers, und er ist der eine Teil davon, der nicht dir gehört.',
  'privacy.push.provider': 'Er bekommt eine feste Adresse für diesen Browser sowie Zeitpunkt und Größe jeder Weckmeldung. Die Inhalte sind für diesen Browser verschlüsselt, er kann sie also nicht lesen — aber die Signatur auf jeder einzelnen nennt deinen Heimserver, und so entsteht mit der Zeit ein Protokoll darüber, wann dein Heimserver dir etwas mitzuteilen hatte.',

  // -------------------------------------------------------------- updates
  //
  // Die Verben bleiben getrennt: "Installieren" heißt, dass Telium die Datei
  // selbst ersetzt, und das kann nur die Electron-Version. Überall sonst steht
  // hier bewusst kein Wort, das nach Installieren klingt -- siehe
  // `catalog/en/updates.js`.

  'updates.available': 'Telium {version} ist verfügbar.',
  'updates.security': 'Eine der Versionen, die du übersprungen hast, behebt ein Sicherheitsproblem.',
  'updates.incompatible': 'Diese Telium-Version ist zu alt für eine Verbindung. Ein Update behebt das.',

  'updates.action.install': 'Installieren und neu starten',
  'updates.action.reload': 'Neu laden',
  'updates.action.store': 'Store öffnen',
  'updates.action.page': 'Was sich geändert hat',
  // "Später", nicht "Schließen": die Meldung kommt wieder, und ein Wort, das
  // etwas anderes verspricht, würde etwas versprechen, was der Code nicht tut.
  'updates.action.later': 'Später',
  'updates.action.restart': 'Neu starten',

  'updates.blocked.package': 'Diese Version wird von deinem System installiert — aktualisiere sie so, wie du sie installiert hast.',
  'updates.blocked.artifact': 'Für diese Plattform gibt es in dieser Version keinen Download.',

  'updates.state.downloading': 'Telium {version} wird heruntergeladen…',
  'updates.state.verifying': 'Signatur wird geprüft…',
  'updates.state.ready': 'Telium {version} ist bereit. Starte neu, um es zu verwenden.',
  'updates.state.failed': 'Dieses Update konnte nicht installiert werden. Lade es stattdessen selbst herunter.',

  'updates.footer.unkeyed': 'Für diese Version ist keine Update-Quelle eingerichtet, daher wird nicht nach Updates gesucht.',
  'updates.footer.current': 'Auf dem neuesten Stand.',
  'updates.footer.unreachable': 'Die Update-Quelle war nicht erreichbar.',
  'updates.footer.forged': 'Die Update-Informationen trugen keine gültige Signatur und wurden abgelehnt.',
  'updates.footer.checking': 'Es wird nach Updates gesucht…',

// ============================================================== guild settings
  //
  // Das Vokabular dieses Namensraums, einmal festgelegt und ab hier
  // durchgehalten: eine `guild` ist eine **Gilde** (nicht "Server" -- dieses
  // Wort ist in Telium schon durch `common.homeserver` belegt und eine
  // Oberfläche, in der "Server" zwei verschiedene Dinge meint, ist in genau
  // diesem Namensraum unbrauchbar, weil hier ständig beide im selben Satz
  // stehen); `role` ist **Rolle**, `permission` **Berechtigung**, `channel`
  // **Kanal**, `member` **Mitglied**, `invite` **Einladung**, `ban` **Sperre**
  // (sperren / entsperren), `audit log` **Prüfprotokoll**, `gate`
  // **Einlasskontrolle**, `origin` **Medienherkunft** (und im Plural, wo
  // Englisch "origins" zählt, schlicht **Hosts**), `queue` **Warteschlange**,
  // `applicant` **Aufnahmeantrag**, `screening` **Aufnahmefrage**, `purge`
  // **Bereinigung** mit dem Verb "löschen", `pin` **verankern**.
  //
  // Englisch bleiben: Produktnamen (Telium), Protokoll- und
  // Formatnamen (SFU, TURN, CORS, PNG, GIF, WebP, JPEG), die Lehnwörter, die
  // im deutschen Netzjargon längst Standard sind (Feed, Relay, Host, Sticker,
  // Emoji, Shortcode, Code) und jeder Zeichenkette, die der Server selbst
  // parst (`allow`, `deny`, `block`, `feed:`, `key:`). Jede dieser Stellen ist
  // unten einzeln begründet, damit niemand sie versehentlich "fertig"
  // übersetzt. `webhook` kommt in diesem Namensraum nicht vor; wer ihn später
  // hier einführt, sollte "Webhook" schreiben, weil der Begriff auch in
  // deutscher Serverdokumentation so heißt.
  //
  // Eine Entscheidung gilt für rund zwanzig Schlüssel auf einmal und steht
  // deshalb hier statt zwanzigmal unten: Englisch sagt "Could not X" ohne
  // Punkt, als Titel eines Fehler-Toasts. Deutsch kann das nicht wörtlich --
  // "Konnte nicht X" hat kein Subjekt und klingt nach Maschinenprotokoll. Die
  // Familie heißt hier durchgehend "… ließ sich nicht …" bzw. "… ließen sich
  // nicht …": das ist umgangssprachlich genug für das Du dieser App, nennt das
  // Ding beim Namen, das nicht geklappt hat, und behauptet nicht, warum.

  // ------------------------------------------------------------------ the shell

  'guild.nav.overview': 'Übersicht',
  'guild.nav.roles': 'Rollen',
  'guild.nav.channels': 'Kanalberechtigungen',
  // "Bots" ist im Deutschen längst das gewöhnliche Wort und bleibt deshalb so,
  // wie es ist.
  'guild.nav.bots': 'Bots',
  // Hier fällt die schwerste Entscheidung des Namensraums. "Gate" ist der
  // Fachbegriff für die Prüfungen, die ein Beitritt durchläuft, und er muss in
  // allen `guild.gates.*` dasselbe Wort sein. "Tor" wäre die wörtliche und
  // damit sinnloseste Übersetzung, "Schranke" ist im deutschen
  // Informatik-Sprachgebrauch durch "obere Schranke" schon anders besetzt, und
  // "Gate" stehen zu lassen hieße, ein Wort zu behalten, das im Deutschen
  // nichts bedeutet. **Einlasskontrolle** sagt exakt, was das Ding tut, ist ein
  // gewöhnliches deutsches Wort und lässt sich in jedem Satz unten beugen.
  //
  // Dass die Beschriftung damit doppelt so lang wird wie das englische "Gates
  // and origins" und in einer schmalen Spalte umbricht, ist Absicht und keine
  // Nachlässigkeit: der Kopfkommentar von `de.js` sagt, dass hier nichts
  // gekürzt wird, um zu passen, weil genau dieses Umbrechen der Layoutfehler
  // ist, den diese Sprache finden soll. Eine Abkürzung würde ihn verstecken.
  'guild.nav.gates': 'Einlasskontrollen und Medienherkunft',
  // Ein Kompositum aus 24 Buchstaben, und trotzdem richtiger als
  // "Moderation: Warteschlange": Deutsch setzt so etwas zusammen, statt es zu
  // spationieren, und ein Wort kann nicht in der Mitte umbrechen. Auch das ist
  // ein Längentest und kein Versehen.
  'guild.nav.queue': 'Moderationswarteschlange',
  // "Purge" hat im Deutschen keine harmlose Entsprechung -- "Säuberung" trägt
  // eine Geschichte, die in einer Chat-App nichts zu suchen hat. "Bereinigung"
  // ist nüchtern, und was tatsächlich passiert, sagen die Sätze im Bereich
  // selbst mit dem Verb "löschen".
  'guild.nav.purge': 'Spam-Bereinigung',
  // "Sperren" statt "Bann": "bannen" ist im deutschen Spielejargon üblich,
  // aber "sperren / entsperren / Sperre" ist das Wort, das jede und jeder
  // versteht, und es bildet sauber alle drei Formen, die dieser Namensraum
  // braucht. Dass "Sperren" hier ein Substantiv im Plural ist und nicht der
  // Infinitiv, ergibt sich aus der Nachbarschaft in der Leiste.
  'guild.nav.bans': 'Sperren',
  'guild.nav.invites': 'Einladungen',
  // "Emoji" ist im Deutschen unverändert das Wort dafür. Die Leiste bleibt bei
  // der Einzahlform als Bereichsname, so wie Englisch auch, und wird nicht zu
  // "Ausdrücke" verallgemeinert -- das englische Experiment mit "Expressions"
  // las sich als Fachjargon und würde es auf Deutsch erst recht.
  'guild.nav.expressions': 'Emoji',
  // "Voice" wird übersetzt, "SFU" nicht: das erste ist ein gewöhnliches Wort,
  // das zweite ein Protokollbegriff (selective forwarding unit), den die
  // lesende Person gerade in der Dokumentation ihres eigenen Relays gelesen
  // hat. In lateinischen Buchstaben, wie er dort steht.
  'guild.nav.voice': 'Sprache / SFU',
  // "Audit-Log" wäre die halbe Anleihe, die viele deutsche Oberflächen nehmen;
  // "Protokoll" allein sagt nicht, dass es um Nachvollziehbarkeit geht und
  // könnte jedes Log sein. "Prüfprotokoll" ist der Begriff, den deutsche
  // Revisions- und Sicherheitsdokumentation benutzt, und er ist in beide
  // Richtungen eindeutig.
  'guild.nav.audit': 'Prüfprotokoll',

  'guild.title.fallback': 'Gilde',
  // Beschriftung über einem Wert, kein Satz: kein Punkt, kein Doppelpunkt.
  // "Gehostet von" wäre das Naheliegende und ist ein Anglizismus, den Deutsch
  // nicht braucht; "Betrieben von" sagt dasselbe und ist genauso kurz.
  'guild.hostedBy': 'Betrieben von',
  // "gerade" trägt hier dieselbe Last wie "right now" im Englischen: nichts
  // ist kaputt und nichts ist verloren, die Verbindung steht nur nicht. Ohne
  // dieses eine Wort liest sich der Satz wie eine Todesmeldung, und wer das so
  // versteht, fängt an, Leute zu alarmieren.
  'guild.unreachable': 'Der Server dieser Gilde ist gerade nicht erreichbar.',

  // ------------------------------------------------------------ shared durations
  //
  // Feste Menüeinträge, keine Zähler -- deshalb eine Zeichenkette pro Eintrag
  // und kein `plural`. Im Deutschen stehen dieselben arabischen Ziffern wie im
  // Englischen; nur das Nomen dahinter wird gebeugt, und "1 Stunde" gegen
  // "6 Stunden" ist genau der Grund, warum diese Zeilen einzeln übersetzt
  // werden und nicht aus Zahl und Wort zusammengesetzt.

  'guild.duration.hour': '1 Stunde',
  'guild.duration.sixHours': '6 Stunden',
  'guild.duration.day': '1 Tag',
  'guild.duration.threeDays': '3 Tage',
  'guild.duration.week': '1 Woche',
  'guild.duration.thirtyDays': '30 Tage',
  // Deutsch hat für die beiden englischen Verneinungen dieselbe Trennung, und
  // sie ist hier wichtig: "Ohne Obergrenze" heißt, es gibt keine Decke (die
  // Lebensdauer einer Datei), "Nie" aus `common.never` heißt, es gibt keine
  // Frist (die Einladung läuft nicht ab). Wer beides "Unbegrenzt" nennt,
  // verliert die Unterscheidung, die die beiden Menüs voneinander trennt.
  'guild.duration.unlimited': 'Ohne Obergrenze',

  // ------------------------------------------------------------------- overview

  'guild.overview.name': 'Name',
  'guild.overview.description': 'Beschreibung',
  // "Icon" wird im Deutschen auch gesagt, aber "Symbol" ist das Wort, das in
  // deutschen Oberflächen seit Jahrzehnten dafür steht, und es lässt sich
  // beugen und zusammensetzen, was "Icon" nur halb tut.
  'guild.overview.chooseIcon': 'Symbol wählen',
  // Ein Zustand, kein Versprechen -- die Datei liegt schon beim Server. Die
  // Wortstellung folgt `common.saving` ("Wird gespeichert…"), damit die beiden
  // Zeilen auf demselben Bildschirm als eine Stimme gelesen werden.
  'guild.overview.savingIcon': 'Symbol wird gespeichert…',
  // "Custom icon set." ist im Englischen zweideutig (Partizip oder
  // Substantiv), im Deutschen muss man sich entscheiden. Es ist das Partizip:
  // der Bereich meldet, dass etwas hinterlegt *ist*. "Hinterlegt" statt
  // "gesetzt", weil "gesetzt" nach einer Aktion klingt, die gerade eben lief,
  // und diese Zeile auch beim nächsten Öffnen noch dasteht.
  'guild.overview.iconSet': 'Es ist ein eigenes Symbol hinterlegt.',
  'guild.overview.iconNone': 'Kein Symbol.',
  'guild.overview.iconFailed': 'Das Symbol ließ sich nicht speichern',

  'guild.overview.memberCount': '{count, plural, one {# Mitglied} other {# Mitglieder}}.',
  // Nicht "? Mitglieder": die Zahl fehlt, sie ist nicht null. Ein föderierter
  // Server, der sie nicht veröffentlicht, bekommt einen Satz statt eines
  // Fragezeichens.
  'guild.overview.memberCountUnknown': 'Mitgliederzahl unbekannt.',
  // Deutsch braucht die Präposition, die Englisch weglässt: "Erstellt
  // {at, date, medium}" wäre kein Satz. `{at, date, medium}` liefert über
  // `Intl` ein Datum in deutscher Schreibweise; das "am" davor gehört dem
  // Muster, das Datum selbst nicht.
  'guild.overview.created': 'Erstellt am {at, date, medium}.',
  // Bewusst vage, und bewusst nicht "An einem unbekannten Datum erstellt":
  // diese Gilde ist älter als das Feld, und das Ehrliche daran ist, dass sie
  // schon eine Weile hier ist.
  'guild.overview.createdUnknown': 'Vor einiger Zeit erstellt.',

  // -------------------------------------------------------- attachment lifetime

  'guild.overview.expiry.title': 'Ablauf von Dateien',
  // "hier" ist diese Gilde. Der zweite Satz ist der, den Moderierende falsch
  // lesen: das ist eine Decke, kein fester Wert, und ein Kanal darf darunter
  // bleiben.
  'guild.overview.expiry.hint': 'Die längste Lebensdauer, die ein Anhang in dieser Gilde haben darf. Kanäle dürfen eine kürzere Obergrenze setzen.',
  // Englisch lässt die Beschriftung den Satz anfangen und das Menü ihn
  // beenden: "Files may be kept for at most" / "30 days". Deutsch kann das
  // nicht, und zwar aus einem grammatischen und nicht aus einem
  // geschmacklichen Grund: "Dateien werden höchstens … aufbewahrt" schiebt das
  // Partizip hinter die Dauer, und das Menü steht hinter der Beschriftung.
  // Der Kommentar im Englischen sieht genau das kommen und erlaubt eine
  // Nominalphrase -- also eine Nominalphrase, die für sich allein steht und
  // nichts erwartet, was hinter ihr kommt.
  'guild.overview.expiry.label': 'Längste Lebensdauer einer Datei',
  'guild.overview.fileSize.title': 'Maximale Größe für Anhänge',
  'guild.overview.fileSize.hint': 'Die größte Datei, die ein Mitglied in dieser Gilde anhängen darf. Kanäle dürfen eine engere Obergrenze setzen.',
  'guild.overview.fileSize.label': 'Anhänge dürfen höchstens wiegen (Bytes)',
  'guild.overview.fileSize.placeholder': 'Keine Grenze in dieser Gilde',

  // ------------------------------------------------------- moving and ownership

  'guild.overview.move.title': 'Umzug dieser Gilde',
  // Die Reihenfolge ist die ganze Aussage, deshalb stehen hier beide Parteien
  // ausgeschrieben, samt der Doppelnennung, die `de.js` schon in
  // `errors.owner_only` benutzt. Sie kostet Länge -- der Satz wird knapp
  // doppelt so lang wie der englische -- und sie ist es hier wert: wer die
  // Sätze in der falschen Reihenfolge liest, sucht auf dem Zielserver nach
  // einer Schaltfläche, die dort noch gar nicht sein kann. Der letzte Satz ist
  // die Beruhigung, die verhindert, dass vorher jemand alle Einladungslinks
  // herauskopiert.
  'guild.overview.move.hint': 'Zuerst bestätigt die neue Inhaberin oder der neue Inhaber auf dem Zielserver, danach gibt die derzeitige Inhaberin oder der derzeitige Inhaber den Umzug hier frei. Alte Links funktionieren weiter.',
  'guild.overview.move.ownerOnly': 'Nur die Inhaberin oder der Inhaber der Gilde kann sie umziehen.',
  'guild.overview.move.button': 'Auf einen anderen Server umziehen',
  // `{domain}` ist ein Hostname und wird nie übersetzt. Das Semikolon statt
  // des englischen ", so" hält die beiden Aussagen auseinander: wo die Gilde
  // liegt, und was daraus folgt.
  'guild.overview.move.elsewhere': 'Diese Gilde liegt auf {domain}; der Umzug muss deshalb von einem Konto dort aus begonnen werden.',

  // Dreimal "Transfer ownership" im Englischen, dreimal etwas anderes auf
  // Deutsch -- der englische Kommentar bittet ausdrücklich darum. Deutsch
  // unterscheidet die Nominalphrase (Überschrift) sauber vom Infinitiv, der in
  // deutschen Oberflächen die Befehlsform einer Schaltfläche ist. "Eigentum"
  // statt "Besitz", weil hier wirklich das Recht übergeht und nicht die
  // tatsächliche Verfügung.
  'guild.overview.transfer.title': 'Übertragung des Eigentums',
  'guild.overview.transfer.button': 'Eigentum übertragen',
  'guild.overview.transfer.confirm': 'Eigentum übertragen',
  // Zwei Sätze, in denen die Doppelnennung viermal vorkäme. Deshalb hier der
  // freie Relativsatz "Wer … , muss …" und danach "diese Person": beides ist
  // geschlechtsneutral, ohne dass der Satz zur Aufzählung wird, und das
  // Deutsche macht das eleganter als das Englische. Die Vorbedingung im ersten
  // Satz ist die Stelle, an der Leute scheitern -- der Server weist ein Konto
  // ab, das nie beigetreten ist, und zwar erst nachdem die ID getippt wurde.
  'guild.overview.transfer.hint': 'Wer die Gilde übernimmt, muss schon Mitglied sein. Nach der Übertragung kann nur noch diese Person die Gilde übertragen oder löschen.',
  'guild.overview.transfer.dialogTitle': '{name} übertragen',
  // "Konto-ID der übernehmenden Person" statt "Konto-ID der neuen Inhaberin
  // oder des neuen Inhabers": eine Feldbeschriftung ist kein Ort für eine
  // Doppelnennung, und das Partizip nimmt ihr das Geschlecht, ohne etwas zu
  // verschweigen.
  'guild.overview.transfer.label': 'Konto-ID der übernehmenden Person',
  'guild.overview.transfer.dialogHint': 'Gib die vollständige Konto-ID eines aktuellen Mitglieds ein.',
  // Der lokale Teil ist übersetzt, weil ein englisches Beispiel für deutsche
  // Lesende genauso undurchsichtig ist wie ein englischer Satz. Nicht
  // angetastet: das `@` und der `:`, weil das die Syntax ist, die das Feld
  // prüft, und `example.org`, das nach RFC 2606 reserviert ist, damit eine
  // Dokumentation nie versehentlich den echten Server von jemandem nennt.
  'guild.overview.transfer.placeholder': '@mitglied:example.org',
  'guild.overview.transfer.done': 'Das Eigentum wurde übertragen.',
  'guild.overview.transfer.failed': 'Das Eigentum ließ sich nicht übertragen',

  'guild.overview.delete.title': 'Löschen dieser Gilde',
  // Der letzte Satz vor der Schaltfläche, und die einzige Stelle, an der das
  // Modell dieses Clients ausgesprochen wird: eine Gilde liegt auf einem Host
  // und wird nirgends repliziert. Kein "möglicherweise", kein "unter
  // Umständen", keine Beruhigung, die das Englische nicht gibt. "Verschwinden
  // alle auf einmal" ist genauso flach wie "all go at once" und soll es sein.
  'guild.overview.delete.hint': 'Kanäle, Nachrichten, Rollen und Mitglieder verschwinden alle auf einmal. Nirgends liegt eine Kopie, aus der sich das wiederherstellen ließe.',
  'guild.overview.delete.button': 'Gilde löschen',
  'guild.overview.delete.confirm': 'Gilde löschen',
  'guild.overview.delete.dialogTitle': '{name} löschen',
  // Das Feld ist ein Riegel und keine Frage -- der Dialog kennt den Namen
  // längst. "Den Namen" meint den Namen der Gilde, der in der Überschrift
  // darüber steht.
  'guild.overview.delete.label': 'Zur Bestätigung den Namen eingeben',
  'guild.overview.delete.dialogHint': 'Das lässt sich nicht rückgängig machen.',
  'guild.overview.delete.failed': 'Die Gilde ließ sich nicht löschen',

  'guild.overview.saveFailed': 'Das ließ sich nicht speichern',

  // ---------------------------------------------------------------------- gates

  // "greifen" statt "laufen": eine Kontrolle greift, ein Programm läuft, und
  // im Deutschen ist das der Unterschied zwischen einer Regel und einem
  // Prozess. Der zweite Satz ist eine Feststellung über Föderation und kein
  // Ratschlag -- die Einlasskontrollen des Servers gelten immer zusätzlich,
  // eine Gilde kann also nur hinzufügen und nie etwas wegnehmen.
  'guild.gates.hint': 'Einlasskontrollen greifen, wenn jemand beitritt. Diese Gilde kann strenger sein als der Server, auf dem sie liegt, nie lockerer.',

  'guild.gates.minAge.label': 'Mindestalter des Kontos (Tage)',
  // Ein Nebensatz mit Verb am Ende, und das verschiebt den Satzbau gegenüber
  // dem Englischen deutlich: "Measured from the account's creation date on its
  // home server" wird zu "Gemessen ab dem Tag, an dem das Konto … erstellt
  // wurde". Die Alternative wäre "Gemessen ab dem Erstellungsdatum des Kontos
  // auf seinem Heimserver" -- kürzer, aber ein Nominalstil, der gegen die
  // Stimme von `de.js` steht, und genau diese Frage stellen Moderierende sich
  // als Frage nach einem Tag und nicht nach einem Feld.
  'guild.gates.minAge.hint': 'Gemessen ab dem Tag, an dem das Konto auf seinem Heimserver erstellt wurde.',

  // Die drei Richtlinien. Auf der Leitung heißen sie `open`, `allowlist` und
  // `blocklist`, und das sind nicht diese Zeichenketten -- hier stehen nur die
  // Beschriftungen im Menü.
  //
  // Für das Paar allowlist/blocklist gibt es im Deutschen mehrere Kandidaten,
  // und die Wahl ist nicht offensichtlich. Verworfen: "Erlaubnisliste /
  // Sperrliste", weil "Sperrliste" in genau diesem Namensraum als die
  // Sperrliste der gesperrten Konten gelesen würde -- der Bereich dafür ist
  // zwei Einträge weiter oben in derselben Leiste. Verworfen auch
  // "Whitelist / Blacklist", das im Deutschen zwar verbreitet ist, aber weder
  // übersetzt noch treffend. **Positivliste / Negativliste** ist ein
  // eingeführtes deutsches Paar, das sich nur in der Polarität unterscheidet,
  // also genau in dem, worin sich die beiden Einstellungen unterscheiden, und
  // das mit keinem anderen Begriff hier kollidiert.
  'guild.gates.policy.open': 'Offen',
  'guild.gates.policy.allowlist': 'Positivliste',
  'guild.gates.policy.blocklist': 'Negativliste',

  // "policy" ist durchgehend "Richtlinie", "rules" durchgehend "Regeln" -- in
  // beiden Hälften des Bereichs, damit die vier Beschriftungen als zwei Paare
  // lesbar bleiben. "Home domain" folgt `common.homeserver`: Heimserver,
  // Heimdomain.
  'guild.gates.domainPolicy.label': 'Richtlinie für Heimdomains',
  'guild.gates.domainRules.label': 'Regeln für Heimdomains',
  // In den geraden Anführungszeichen steht Syntax: `allow` und `deny` sind
  // Schlüsselwörter, die der Server wörtlich vergleicht, und sie bleiben
  // Englisch, während der Satz um sie herum übersetzt wird. Deshalb stehen
  // hier absichtlich die geraden "…" des Englischen und nicht die deutschen
  // „…“, die `de.js` sonst für Zitate benutzt (siehe `errors.missing_permission`):
  // gerade Anführungszeichen markieren hier Maschinentext, typografische
  // markieren Zitate aus der Oberfläche -- und die Richtlinie „Offen“ im
  // letzten Satz ist so ein Zitat, nämlich von `guild.gates.policy.open`.
  // Wer dieses Etikett ändert, muss den Verweis hier mitziehen.
  'guild.gates.domainRules.hint': 'Eine pro Zeile, als "allow example.org" oder "deny spam.example". Unter der Richtlinie „Offen“ werden sie ignoriert.',

  // "Screening questions" wird zu "Aufnahmefragen" und nicht zu "Prüffragen"
  // oder "Fragen zur Überprüfung": das Wort teilt seinen Stamm mit
  // "Aufnahmeantrag" und "aufnehmen" unten, und damit hängen die drei Stellen,
  // die im Englischen über dasselbe sprechen (screening, applicants, admit),
  // im Deutschen sichtbar zusammen.
  'guild.gates.screening.label': 'Aufnahmefragen',
  // "wer beitreten will" statt "eine beitretende Person": ein freier
  // Relativsatz ist geschlechtsneutral, ohne dass der Satz schwerfällig wird,
  // und er verschiebt das Subjekt hinter das Verb, was Deutsch hier ohnehin
  // tut. Der Name des Ziels muss derselbe sein wie in
  // `guild.queue.applicants.title` -- "Aufnahmeanträge".
  'guild.gates.screening.hint': 'Eine pro Zeile. Leer lassen, um ohne Prüfung aufzunehmen; sonst landet, wer beitreten will, in den Aufnahmeanträgen.',

  // "N" bleibt ein lateinisches N. Deutsch benutzt in der Algebra dieselben
  // Buchstaben wie Englisch, und weil es keine interpolierte Zahl ist, sondern
  // eine Variable, die auf das Feld daneben zeigt, muss es in beiden
  // Zeichenketten dasselbe Zeichen sein.
  'guild.gates.hold.label': 'Die ersten N Nachrichten zurückhalten',
  // "Zero disables the hold" wird zu "Bei null wird nichts zurückgehalten":
  // "null deaktiviert die Zurückhaltung" wäre Nominalstil und dazu ein Wort
  // ("Zurückhaltung"), das auf Deutsch eine Charaktereigenschaft ist. Die
  // Passivkonstruktion sagt dasselbe mit dem Verb, das oben schon steht.
  'guild.gates.hold.hint': 'Die ersten N Nachrichten eines neuen Mitglieds warten auf Freigabe, statt zu erscheinen. Bei null wird nichts zurückgehalten.',

  // Die zweite Hälfte des Bereichs. "Origin" ist hier der Host, auf den ein
  // Anhang hochgeladen wurde -- nicht ein Ort und nicht die Origin aus der
  // Browsersicherheit, die viele Lesende kennen. Deutsch hat dafür
  // "Medienherkunft", und das ist als Begriff richtig, aber im Plural
  // unbrauchbar ("Von welchen Medienherkünften …" ist kein Satz, den jemand
  // schreiben würde). Deshalb: **Medienherkunft** als Begriff in den
  // Beschriftungen, und überall dort, wo Englisch "origins" zählt, das
  // konkrete **Hosts** -- was der englische Kommentar selbst als Definition
  // anbietet. "Geprüft wird, sobald …" statt "Geprüft beim Absenden", weil der
  // Zeitpunkt die eigentliche Aussage ist.
  'guild.gates.origins.hint': 'Von welchen Hosts diese Gilde Anhänge annimmt. Geprüft wird, sobald eine Nachricht abgeschickt wird.',
  'guild.gates.originPolicy.label': 'Richtlinie für Medienherkunft',
  'guild.gates.originRules.label': 'Regeln für Medienherkunft',
  // Jede Zeichenfolge in geraden Anführungszeichen ist Syntax: `allow`,
  // `block`, `feed:` und `key:` werden wörtlich geparst.
  //
  // Eine Falle, die beim Übersetzen fast zuschlägt: der Inhalt der spitzen
  // Klammern darf übersetzt werden, aber **nicht zu einem einzigen Wort aus
  // reinen ASCII-Buchstaben**. `format.js` liest `<Kuratorschluessel>` als
  // Tag, findet keine Komponente dafür und löscht es aus dem Satz -- geprüft,
  // nicht vermutet. `<Schlüssel des Kurators>` enthält Leerzeichen und kann
  // deshalb nie als Tag gelesen werden; auf diese Eigenschaft und nicht auf
  // den Umlaut ist Verlass. Der letzte Satz ist die Vorrangregel und trägt
  // Gewicht: wer einen Host namentlich blockiert, erwartet, dass das auch
  // gegen einen abonnierten Feed hält, und so ist es.
  'guild.gates.originRules.hint': 'Eine pro Zeile, als "allow files.example" oder "block sketchy.example". Ein kuratierter Feed ist "allow feed:https://… key:<Schlüssel des Kurators>". Ein namentlich genannter Host gewinnt gegen einen Feed.',

  'guild.gates.save': 'Einlasskontrollen speichern',
  'guild.gates.saved': 'Einlasskontrollen gespeichert.',
  'guild.gates.saveFailed': 'Die Einlasskontrollen ließen sich nicht speichern',
  'guild.gates.refreshFailed': 'Die Feeds ließen sich nicht aktualisieren',
  // Zwei Sätze, weil es zwei Tatsachen sind, und die zweite ist die, auf die
  // es ankommt: abonniert ist noch nichts, es wurde nur eine Zeile in das Feld
  // oben geschrieben. "Um das Abo abzuschließen" statt "um zu abonnieren",
  // weil das Abonnement damit fertig wird und nicht anfängt.
  'guild.gates.pinned': 'Zu den Regeln oben hinzugefügt. Speichere die Einlasskontrollen, um das Abo abzuschließen.',

  // ------------------------------------------------------- the curator directory

  // `de.js` nennt Personen doppelt ("die Inhaberin oder der Inhaber"), und
  // hier wird das bewusst nicht getan. Eine Kuratorin ist in dieser Tabelle
  // fast nie ein Mensch, sondern ein Projekt oder eine Organisation -- der
  // Wert in `{curator}` ist buchstäblich ein Hostname --, und die
  // Doppelnennung würde zwei Tabellenspalten sprengen, um ein Geschlecht zu
  // vermeiden, das hier gar niemand hat. "Kurator" steht also für die Rolle,
  // nicht für eine Person.
  //
  // Der Satz sagt die Stelle, die alle falsch verstehen: das Verzeichnis zu
  // lesen ändert gar nichts, solange kein Schlüssel verankert ist.
  'guild.gates.curators.hint': 'Kuratoren, die dieser Server kennt. Ein Feed entscheidet nichts, solange du seinen Schlüssel hier nicht verankerst.',
  'guild.gates.curators.tableLabel': 'Kuratoren',
  'guild.gates.curators.colCurator': 'Kurator',
  // "Feed" bleibt. Im deutschen Netzjargon ist das seit RSS das Wort dafür,
  // und "Bezugsquelle" oder "Datenstrom" würde niemand mit dem in Verbindung
  // bringen, was in der Dokumentation der Kuratoren steht.
  'guild.gates.curators.colFeed': 'Feed',
  // "Listed by" ist eine Herkunftsangabe, kein Besitz: die Spalte sagt, von wo
  // dieser Client von der Kuratorin erfahren hat. "Geführt von" trifft das im
  // Sinne von "in einer Liste geführt".
  'guild.gates.curators.colSource': 'Geführt von',
  'guild.gates.curators.thisServer': 'Dieser Server',
  // "Pin" ist der Fachbegriff aus dem Certificate Pinning: eine Verbindung an
  // genau einen öffentlichen Schlüssel binden, damit kein späterer Schlüssel
  // stillschweigend an seine Stelle tritt. "Anheften" wäre die naheliegende
  // Übersetzung und ist im Deutschen durch angeheftete Nachrichten besetzt --
  // in derselben App. "Verankern" sagt dasselbe (etwas ist festgemacht und
  // bewegt sich nicht mehr), kollidiert mit nichts, und wird unten in
  // `state.unpinned` und `keyPinned` konsequent durchgehalten.
  'guild.gates.curators.pin': 'Schlüssel verankern',
  'guild.gates.curators.subscribed': 'Abonniert',

  // ------------------------------------------------------------ subscribed feeds

  // Beide Hälften zählen. "blockiert" statt "gesperrt" für `block`, weil
  // "sperren" in diesem Namensraum den Kontosperren gehört und ein Feed keine
  // Konten sperrt, sondern Hosts blockiert. Die Richtung ist das
  // Überraschende: ein abgelaufener Feed hört auf zu erlauben und hört nicht
  // auf zu blockieren -- das ist die sichere Richtung und nicht die, die man
  // unter "abgelaufen" erwartet.
  'guild.gates.feeds.hint': 'Feeds werden beim ersten Speichern abgerufen und danach stündlich. Ein abgelaufener Feed lässt seine Hosts nicht mehr durch, weist die von ihm blockierten aber weiterhin ab.',
  'guild.gates.feeds.tableLabel': 'Abonnierte Feeds',
  'guild.gates.feeds.colFeed': 'Feed',
  // "Hosts" bleibt Englisch und ist zugleich Deutsch: "Host" steht so im
  // Duden und in jeder deutschen Netzdokumentation, und "Rechner" wäre hier
  // falsch, weil ein Host ein Name ist und keine Maschine.
  'guild.gates.feeds.colHosts': 'Hosts',
  // Eine Seriennummer im Sinne einer DNS-Zone: die Versionsnummer, die die
  // Kuratorin selbst vergeben hat. Nichts, was gezählt wird, und keine Prosa.
  // Nicht abgekürzt zu "Serien-Nr.", obwohl die Spalte schmal ist -- das ist
  // genau die Abkürzung, die der Kopfkommentar von `de.js` verbietet.
  'guild.gates.feeds.colSerial': 'Seriennummer',
  'guild.gates.feeds.colFetched': 'Zuletzt abgerufen',
  'guild.gates.feeds.colKey': 'Kuratorenschlüssel',
  'guild.gates.feeds.colState': 'Status',
  'guild.gates.feeds.refresh': 'Feeds aktualisieren',

  // `{action}` ist das `allow` oder `block`, das die moderierende Person
  // selbst in das Regelfeld getippt hat. Es kommt unübersetzt an und bleibt
  // es: es ist dasselbe Token, das sie oben im Feld wieder liest, und ein
  // deutsches Wort an dieser Stelle wäre ein Wort, das sie dort nie findet.
  // `{curator}` ist ein Hostname. Der `·` ist ein Trennzeichen und keine
  // Interpunktion.
  'guild.gates.feeds.curatedBy': '{action} · kuratiert von {curator}',
  'guild.gates.feeds.hosts': '{hosts, number}',
  'guild.gates.feeds.hostsWithBlocks': '{hosts, number} ({blocks, number} blockiert)',
  'guild.gates.feeds.fetchedAt': '{at, dateTime}',

  // "Verankert" -- der ruhige Fall: der Schlüssel in der Regel ist der
  // Schlüssel, der gilt, und nichts hat sich bewegt.
  'guild.gates.feeds.keyPinned': 'Verankert',
  // Englisch hängte früher ein "x" an die Zahl und dieser Eintrag schrieb
  // dafür "3×" mit dem Multiplikationszeichen -- die übliche deutsche
  // Schreibweise für eine Anzahl von Wiederholungen. Englisch ist jetzt ein
  // Plural, und das ist für Deutsch ein echter Gewinn: bei genau einer
  // Rotation schreibt Deutsch nicht "1×", sondern "einmal", und dafür gab es
  // in einem `{count, number}`-Muster keine Stelle.
  //
  // Die Zahl steht weiterhin vorn, weil Deutsch das Partizip ans Ende stellt.
  // Im `other`-Arm bleibt die Bindestrichform "3-mal" statt "3× rotiert": das
  // Multiplikationszeichen liest sich vor einem Verb wie eine Rechnung,
  // während "-mal" die Wiederholung benennt. "rotiert" statt "gewechselt",
  // damit dieser Eintrag, `keyRotationAnnounced` und die Kuratorendokumentation
  // dasselbe Wort benutzen. Beide Arme bleiben kurz -- die Pille steht in
  // einer schmalen Spalte.
  'guild.gates.feeds.keyRotated': '{count, plural, one {Einmal rotiert} other {#-mal rotiert}}',
  // "In Kraft" ist juristisch gefärbt und genau deshalb richtig: es sagt, dass
  // dieser Schlüssel jetzt gilt, im Gegensatz zu dem, den die Regel noch
  // nennt. "Gültig" wäre hier mit dem Ablaufdatum des Feeds verwechselbar.
  // `{key}` ist Base64 und wird nie übersetzt, nie umbrochen und nie mit
  // lokalisierten Ziffern versehen.
  'guild.gates.feeds.keyInForce': 'In Kraft: {key}',
  'guild.gates.feeds.keyRotationAnnounced': 'Rotation angekündigt',
  // "Nächster" und nicht "Nächstes" oder "Als Nächstes": es geht um den
  // Schlüssel, und der ist männlich. Die Endung ist hier Grammatik und keine
  // Stilfrage.
  'guild.gates.feeds.keyNext': 'Nächster: {key}',

  'guild.gates.feeds.state.active': 'Aktiv',
  'guild.gates.feeds.state.expired': 'Abgelaufen',
  // Nicht "Ausstehend": der Feed ist gespeichert, der stündliche Abruf war nur
  // noch nicht dran. Nichts ist kaputt und nichts wartet auf die lesende
  // Person -- und genau das sagt "Noch nicht abgerufen", während "Ausstehend"
  // nach einer offenen Aufgabe klingt.
  'guild.gates.feeds.state.pending': 'Noch nicht abgerufen',
  'guild.gates.feeds.state.failed': 'Fehlgeschlagen',
  'guild.gates.feeds.state.unpinned': 'Kein Schlüssel verankert',

  // ------------------------------------------------------------ moderation queue

  'guild.queue.held.title': 'Zurückgehaltene Nachrichten',
  // "Approve" wird zu "Freigeben" und nicht zu "Genehmigen": eine Nachricht
  // wird freigegeben, ein Antrag wird genehmigt, und weiter unten wird eine
  // Person aufgenommen -- drei Handlungen, drei Verben, so wie Englisch auch
  // drei hat.
  //
  // "silently" ist die Hälfte, die gesagt werden muss, und "stillschweigend"
  // sagt sie auf Deutsch nicht deutlich genug: es klingt nach der Haltung der
  // moderierenden Person statt nach der Tatsache, dass die andere Seite nichts
  // erfährt. Also ausgeschrieben, auch wenn der Satz dadurch länger wird als
  // der englische.
  'guild.queue.held.description': 'Freigeben schickt die Nachricht sofort ab. Ablehnen verwirft sie, ohne dass die Person, die sie geschrieben hat, davon erfährt.',
  // Klein geschrieben, weil daneben Gründe wie "neues Konto" oder "Link"
  // stehen, die auch klein sind. Ein deutsches Partizip darf das; ein
  // Substantiv an dieser Stelle müsste groß und wäre die falsche Wortart.
  'guild.queue.held.reason': 'zurückgehalten',
  // Die Klammern markieren, dass hier die Oberfläche spricht und nicht die
  // Nachricht -- was in diesem Kasten wichtiger ist als anderswo, weil alles
  // andere darin von einem Menschen geschrieben wurde.
  'guild.queue.held.noText': '(kein Text)',
  'guild.queue.held.emptyTitle': 'Nichts wartet',
  'guild.queue.held.emptyBody': 'Die Warteschlange für zurückgehaltene Nachrichten ist leer.',
  'guild.queue.approve': 'Freigeben',
  'guild.queue.reject': 'Ablehnen',
  // Sagt, was nicht ging, und rät nicht, warum -- meistens ist es kein
  // Ausfall, sondern jemand anderes, der schneller war.
  'guild.queue.heldFailed': 'Diese Nachricht ließ sich nicht bearbeiten',

  // "Applicants" sind im Englischen die Menschen. Auf Deutsch hieße das
  // "Bewerberinnen und Bewerber", und das ist als Überschrift eines Bereichs
  // zu lang und in einer Leiste unbrauchbar. **Aufnahmeanträge** verschiebt
  // den Blick vom Menschen auf das, was tatsächlich in der Warteschlange
  // liegt -- ein Antrag mit Antworten daran --, vermeidet die Doppelnennung
  // und passt zu "Aufnahmefragen" und "Aufnehmen". Der Preis ist, dass der
  // Bereich nicht mehr nach Personen benannt ist; deshalb holt die
  // Beschreibung darunter die Menschen ausdrücklich zurück.
  'guild.queue.applicants.title': 'Aufnahmeanträge',
  'guild.queue.applicants.description': 'Menschen, deren Antworten auf die Aufnahmefragen noch auf eine Entscheidung warten.',
  // "Admit" und nicht "Approve", und der Unterschied ist beabsichtigt: eine
  // Nachricht wird freigegeben, eine Person wird aufgenommen. Deutsch hat
  // beide Wörter, also benutzt es beide.
  'guild.queue.admit': 'Aufnehmen',
  'guild.queue.applicants.emptyTitle': 'Niemand wartet',
  // Nicht "Es gibt keine Aufnahmeanträge": der übliche Grund für die leere
  // Liste ist, dass diese Gilde gar keine Aufnahmefragen stellt, und wer eine
  // Warteschlange sucht, die nie eingeschaltet wurde, soll erfahren, woher sie
  // käme.
  'guild.queue.applicants.emptyBody': 'Aufnahmeanträge erscheinen hier nur, wenn diese Gilde Aufnahmefragen stellt.',
  'guild.queue.applicantFailed': 'Dieser Aufnahmeantrag ließ sich nicht bearbeiten',

  // ----------------------------------------------------------------------- bans

  // Die Reichweite, einmal oben gesagt. Eine Gildensperre ist keine
  // Serversperre und keine Kontosperrung, und der zweite Halbsatz sagt das mit
  // "ausgeschlossen" -- ein Wort, das den Umfang der Sache benennt, während
  // "gesperrt" nur den Zustand benennt. Beide Wörter stehen bewusst im selben
  // Satz: so ist klar, dass "Sperre" im Rest des Bereichs genau das meint.
  'guild.bans.hint': 'Eine Sperre schließt nur aus dieser Gilde aus.',
  'guild.bans.tableLabel': 'Sperren',
  'guild.bans.empty': 'Niemand ist gesperrt.',
  'guild.bans.colAccount': 'Konto',
  'guild.bans.colReason': 'Grund',
  // Eine Frage als Spaltenkopf, wie im Prüfprotokoll weiter unten. Das ist im
  // Deutschen kürzer und natürlicher als "Zeitpunkt" und passt zur
  // gesprochenen Stimme von `de.js`.
  'guild.bans.colWhen': 'Wann',
  // Klein und unaufgeregt, weil es eine Lücke im Protokoll meldet und keine
  // Tatsache über den Menschen. Es ersetzt einen blanken Bindestrich, der
  // sehenden Lesenden dasselbe sagte und einem Screenreader gar nichts.
  'guild.bans.noReason': 'kein Grund vermerkt',
  'guild.bans.unban': 'Entsperren',
  // Der zugängliche Name derselben Schaltfläche. Sechsmal "Entsperren"
  // untereinander sagt einem Screenreader nicht, in welcher Zeile er steht.
  // `{account}` ist eine vollständige Konto-ID und wird als sie selbst
  // vorgelesen. Deutsch stellt den Infinitiv hinter das Objekt, also wandert
  // der Platzhalter nach vorn.
  'guild.bans.unbanAccount': '{account} entsperren',
  'guild.bans.unbanFailed': 'Die Sperre ließ sich nicht aufheben',
  // "ID" groß, wie im Deutschen üblich, und mit Bindestrich an "Konto"
  // gekoppelt, weil deutsche Komposita zusammengeschrieben werden und ein
  // Kürzel darin den Bindestrich verlangt. Diese Schreibweise gilt hier
  // überall: Konto-ID.
  'guild.bans.add': 'Nach Konto-ID sperren',
  'guild.bans.dialogTitle': 'Ein Konto sperren',
  // Das Beispiel gehört zur Beschriftung, weil das Feld eine vollständige
  // föderierte ID will und keinen Anzeigenamen -- der eine Fehler, den hier
  // alle machen. Zum Beispiel selbst siehe
  // `guild.overview.transfer.placeholder`: der lokale Teil ist übersetzt,
  // `example.org` bleibt.
  'guild.bans.dialogLabel': 'Vollständige Konto-ID, etwa @jemand:example.org',
  'guild.bans.confirm': 'Sperren',
  'guild.bans.banFailed': 'Das Konto ließ sich nicht sperren',

  // -------------------------------------------------------------- spam cleanup

  'guild.purge.title': 'Spam-Bereinigung',
  // "a named account" heißt: hier muss eine ID eingetippt werden. Das ist kein
  // Rundumschlag durch den Kanal, sondern alles, was ein bestimmtes Konto hier
  // zuletzt gesagt hat. "genannt" trägt das im Deutschen genauso.
  'guild.purge.hint': 'Entfernt die neuesten Nachrichten eines genannten Kontos in dieser Gilde.',
  'guild.purge.accountLabel': 'Konto-ID',
  // Der lokale Teil bleibt "spammer", weil das Wort im Deutschen genauso
  // gebraucht wird und als Platzhalter sofort erkennbar ist -- hier ist die
  // Nicht-Übersetzung ausnahmsweise die bessere Übersetzung.
  'guild.purge.accountPlaceholder': '@spammer:example.org',
  'guild.purge.limitLabel': 'Höchstzahl der Nachrichten',
  'guild.purge.button': 'Neueste Nachrichten löschen',
  // Der `=0`-Arm ist kein Plural von nichts: eine Bereinigung, die nichts
  // getroffen hat, ist ein anderes Ergebnis als eine, die gewirkt hat, und
  // "0 Nachrichten gelöscht" läse sich wie eine Fehlermeldung mit einer Zahl
  // darin. Deutsch braucht dafür `one` und `other`, mehr nicht -- `zero`,
  // `few` und `many` gibt es in dieser Sprache nicht, und der Test weist sie
  // ab. Das Partizip steht am Satzende, also hinter dem `#`.
  'guild.purge.deleted': '{count, plural, =0 {Es wurde nichts gelöscht.} one {# Nachricht gelöscht.} other {# Nachrichten gelöscht.}}',
  'guild.purge.failed': 'Die Nachrichten ließen sich nicht löschen',

  // ------------------------------------------------------------------- invites
  //
  // Englisch benutzt "invite" für zwei Dinge: für die Einladung als Sache und
  // für den Link, mit dem man sie weitergibt. Deutsch hält beides auseinander,
  // und das ist hier ein Gewinn: **Einladung** ist das, was erstellt,
  // begrenzt und zurückgezogen wird, **Einladungslink** ist das, was in der
  // Zwischenablage landet und in einem Kanal auftaucht. Welche der beiden
  // gemeint ist, steht unten an jedem Schlüssel, an dem es nicht offensichtlich
  // ist.

  'guild.invites.create.title': 'Einladung erstellen',
  // Das erste Wort ist das Argument: ein Einladungslink ist ein Zugangsmittel
  // und wird wie eines weitergegeben. "Zugangsdaten" ist im Deutschen das
  // etablierte Wort für credentials und darf nicht zu "Links" verharmlost
  // werden -- der ganze Satz steht da, damit jemand eine Grenze setzt, bevor
  // er den Link in einen öffentlichen Kanal kopiert.
  'guild.invites.create.hint': 'Einladungen sind Zugangsdaten. Gib ihnen nach Möglichkeit eine Frist oder eine Höchstzahl an Nutzungen.',
  'guild.invites.maxUses': 'Höchstzahl der Nutzungen',
  // Der Wert, für den das leere Feld steht, also ein Wort und keine
  // Aufforderung. "Unbegrenzt" und nicht "Ohne Obergrenze" wie bei
  // `guild.duration.unlimited`: dort ist es eine Decke für eine Dauer, hier
  // eine Anzahl, die nicht begrenzt ist.
  'guild.invites.maxUsesPlaceholder': 'Unbegrenzt',
  // Englisch beschriftet das Feld mit dem Verb "Expires" und lässt das Menü
  // ("24 hours", "Never") den Satz beenden. Auf Deutsch geht das schief:
  // "Läuft ab" + "24 Stunden" liest sich als "läuft ab 24 Stunden", weil "ab"
  // als Präposition verstanden wird. "Gültigkeit" ist eine Nominalphrase, die
  // beide Menüwerte trägt -- Gültigkeit: 24 Stunden, Gültigkeit: Nie.
  'guild.invites.expires': 'Gültigkeit',
  'guild.invites.create.button': 'Einladung erstellen',
  // Nur zu sehen, wenn die Zwischenablage sich geweigert hat; der normale Weg
  // meldet sich über `common.copiedThing`. Der zweite Satz ist das, was diese
  // Meldung brauchbar macht.
  'guild.invites.created': 'Einladung erstellt. Kopiere sie aus der Liste unten.',
  'guild.invites.createFailed': 'Die Einladung ließ sich nicht erstellen',
  // Das `{what}` in `common.copiedThing` ("{what} kopiert."). Kopiert wurde
  // der Link und nicht die Einladung -- Englisch verwischt das mit "Invite",
  // Deutsch muss sich entscheiden, und "Einladungslink kopiert." ist die
  // wahre Aussage. Nominativ, weil das Muster in `de.js` das Wort an den
  // Satzanfang stellt.
  'guild.invites.clipboardName': 'Einladungslink',

  'guild.invites.list.title': 'Einladungslinks',
  'guild.invites.tableLabel': 'Einladungslinks',
  'guild.invites.empty': 'Es wurden noch keine Einladungen erstellt.',
  // Der kurze Code am Ende des Links. "Code" bleibt, weil er im Deutschen so
  // heißt und weil die moderierende Person ihn Zeichen für Zeichen gegen einen
  // Link hält, den ihr jemand geschickt hat.
  'guild.invites.colCode': 'Code',
  'guild.invites.colUses': 'Nutzungen',
  // Die Spalte zeigt ein Datum oder "Abgelaufen", nicht eine Dauer -- deshalb
  // hier "Gültig bis" und nicht "Gültigkeit" wie beim Feld oben. Zwei
  // englische "Expires", zwei verschiedene deutsche Wörter, und das ist
  // richtig so.
  'guild.invites.colExpires': 'Gültig bis',
  'guild.invites.colCreator': 'Erstellt von',
  'guild.invites.uses': '{used, number}',
  // Der Schrägstrich bleibt ein Schrägstrich, und beide Zahlen gehen durch
  // `Intl`: in deutscher Schreibweise steht dort "1.200" mit Punkt, was genau
  // der Grund ist, warum diese Zelle ein Muster ist und keine in JavaScript
  // zusammengeklebte Zeichenkette.
  'guild.invites.usesOf': '{used, number} / {max, number}',
  // Vergangenheit, wie im Englischen: die Einladung läuft nicht ab, sie ist
  // abgelaufen.
  'guild.invites.expired': 'Abgelaufen',
  // "Zurückziehen" statt "Widerrufen": beides ist richtig, aber "widerrufen"
  // ist Amtsdeutsch und passt nicht zu einer App, die "du" sagt. Man zieht
  // eine Einladung zurück.
  'guild.invites.revoke': 'Zurückziehen',
  // Zugänglicher Name derselben Schaltfläche, aus demselben Grund wie bei
  // `guild.bans.unbanAccount`. `{code}` wird als er selbst vorgelesen, und das
  // Verb steht auf Deutsch am Ende.
  'guild.invites.revokeInvite': 'Einladung {code} zurückziehen',
  'guild.invites.revokeFailed': 'Die Einladung ließ sich nicht zurückziehen',

  // ----------------------------------------------------------------- audit log

  'guild.audit.tableLabel': 'Prüfprotokoll',
  // Nicht "leer": ein Prüfprotokoll ohne Einträge heißt, dass seit Beginn der
  // Aufzeichnung nichts Protokollierbares passiert ist -- eine Aussage über
  // die Zeit und nicht über die Tabelle. "Bisher" trägt das.
  'guild.audit.empty': 'Bisher wurde nichts protokolliert.',
  'guild.audit.colWhen': 'Wann',
  // "Actor" hat auf Deutsch nur schlechte Entsprechungen: "Akteur" ist
  // Theater- oder Soziologiesprache und bräuchte obendrein eine weibliche
  // Form, "Urheber" ebenso und klingt nach Urheberrecht, "Handelndes Konto"
  // ist für eine Spalte zu lang. **"Wer"** ist kurz, geschlechtslos, für einen
  // Screenreader eindeutig und bildet mit "Wann" daneben ein Paar, das man als
  // Tabellenkopf sofort liest. Die Fragewortform passt zur Stimme von `de.js`.
  'guild.audit.colActor': 'Wer',
  // Darunter steht der Code des Servers selbst (`member.ban`, `role.update`)
  // in einem `<code>`-Element, unübersetzt -- siehe den langen Kommentar am
  // Kopf der englischen Datei. Übersetzt wird nur der Spaltenkopf.
  'guild.audit.colAction': 'Aktion',
  'guild.audit.colTarget': 'Ziel',

  // ---------------------------------------------------------- emoji and stickers

  'guild.expressions.emoji.title': 'Eigene Emojis',
  'guild.expressions.emoji.add': 'Emoji hinzufügen',
  'guild.expressions.emoji.emptyTitle': 'Noch keine eigenen Emojis',
  // Die Formatnamen bleiben in lateinischen Buchstaben; Deutsch hängt sie mit
  // Bindestrich an das Wort, auf das sie sich beziehen, und die Aufzählung
  // bekommt deshalb die Ergänzungsstriche ("PNG-, GIF-, WebP- oder
  // JPEG-Datei"), die Englisch nicht braucht. "Shortcode" bleibt ebenfalls:
  // es ist der Fachbegriff für die `:name:`-Form im Eingabefeld und muss
  // dasselbe Wort sein, das die Emoji-Auswahl im Eingabefeld benutzt.
  'guild.expressions.emoji.emptyBody': 'Lade eine PNG-, GIF-, WebP- oder JPEG-Datei hoch; der Dateiname wird zum Shortcode. Der Server kodiert sie neu und verkleinert sie passend.',
  // Die Doppelpunkte um `{name}` sind die Syntax, die daraus einen Shortcode
  // macht -- keine Anführungszeichen, und sie müssen bleiben. Das Verb steht
  // auf Deutsch hinter dem Objekt, der Platzhalter wandert also an den Anfang.
  'guild.expressions.emoji.remove': ':{name}: entfernen',
  'guild.expressions.emoji.addFailed': 'Das Emoji ließ sich nicht hinzufügen',
  'guild.expressions.removeFailed': 'Das ließ sich nicht entfernen',

  // "Sticker" ist im Deutschen dasselbe Wort, mit demselben Plural. Keine
  // Übersetzung zu "Aufkleber": das wäre das Papierding und nicht das, was
  // hier verschickt wird.
  'guild.expressions.stickers.title': 'Sticker',
  'guild.expressions.stickers.add': 'Sticker hinzufügen',
  'guild.expressions.stickers.emptyTitle': 'Noch keine Sticker',
  // Sagt, wo sie wieder auftauchen -- die Beschwerde, die diese Zeile
  // beantwortet, ist der hochgeladene Sticker, den danach nie wieder jemand
  // gesehen hat.
  'guild.expressions.stickers.emptyBody': 'Sticker wählst du in der Emoji-Auswahl aus; sie werden für sich allein verschickt.',
  'guild.expressions.stickers.addFailed': 'Der Sticker ließ sich nicht hinzufügen',

  // ------------------------------------------------------------- voice regions
  //
  // Eine "Region" ist hier ein Relay, über das diese Gilde ein Gespräch leiten
  // darf, benannt nach seiner Adresse. SFU, TURN und Relay bleiben in
  // lateinischen Buchstaben, weil die Person, die hier eine Region einträgt,
  // gerade die Dokumentation ihres Relays im anderen Fenster liest. "Relay"
  // ist im deutschen Netzjargon ohnehin das Wort dafür; "Weiterleitung" oder
  // "Vermittler" würde niemand damit in Verbindung bringen.

  'guild.voice.regions.title': 'Sprachregionen',
  'guild.voice.regions.description': 'Trag ein eigenes Relay ein, damit diese Gilde oder einzelne Sprachkanäle es nutzen.',
  // `<code>` markiert den Wert als Adresse und nicht als Wort. Das Tag ist
  // Pflicht, der Name darin wird nicht übersetzt. Deutsch stellt den Genitiv
  // hinter das Nomen, also "Standard des Servers" statt "Server-Standard" --
  // Letzteres läse sich als eine Art von Standard und nicht als der Standard
  // eines bestimmten Servers.
  'guild.voice.serverDefault': 'Standard des Servers: <code>{name}</code>',
  'guild.voice.serverDefaultNone': 'Der Server hat keinen Standard.',
  'guild.voice.guildDefault': 'Standard der Gilde: <code>{name}</code>',

  'guild.voice.tableLabel': 'Sprachregionen',
  'guild.voice.empty': 'Keine Regionen eingerichtet.',
  'guild.voice.colName': 'Name',
  'guild.voice.colSfu': 'SFU',
  'guild.voice.colType': 'Typ',
  // "Health" ist hier der Befund der letzten Prüfung des Servers, nicht die
  // Gesundheit von irgendetwas. "Zustand" ist das deutsche Wort dafür und
  // steht nicht in Konkurrenz zu "Status", das eine Spalte weiter unten den
  // Zustand eines Feeds meint.
  'guild.voice.colHealth': 'Zustand',
  // Englisch schreibt diese vier Zellen klein, weil die Spalte ein Wort breit
  // ist. Deutsch kann das nur halb: "Server" ist ein Substantiv und wird groß
  // geschrieben, und die Großschreibung ist laut dem Kopfkommentar von `de.js`
  // ausdrücklich keine Stilfrage, über die eine Tabelle abstimmen darf. Also
  // bleibt "eigen" klein und "Server" groß, und der Bruch in der Spalte ist
  // der richtige Preis.
  'guild.voice.typeCustom': 'eigen',
  'guild.voice.typeServer': 'Server',
  // "ok" ist auch im Deutschen "ok" -- kein Anglizismus, den man ersetzen
  // müsste, sondern ein Wort, das der Duden führt. Das Gegenstück ist
  // "ausgefallen" und nicht "aus": "aus" wäre `common.off` und hieße
  // abgeschaltet, während dieses Relay nur nicht antwortet.
  'guild.voice.healthOk': 'ok',
  'guild.voice.healthDown': 'ausgefallen',
  // Der Titel am Stern neben dem Namen einer Region. Der Stern selbst hat
  // nichts zu übersetzen, und das hier ist das Einzige, was einem Screenreader
  // sagt, was er bedeutet.
  'guild.voice.defaultMarker': 'Standard der Gilde',
  'guild.voice.makeDefault': 'Als Standard setzen',
  // Zugängliche Namen der beiden Zeilenschaltflächen, die sonst sechsmal
  // dasselbe Wort untereinander wären. `{name}` ist der Name der Region.
  // Deutsch schiebt den Infinitiv ans Ende, der Platzhalter steht also vorn,
  // und "zum Standard der Gilde machen" klingt natürlicher als "als Standard
  // der Gilde setzen", wenn ein Name davor steht.
  'guild.voice.makeDefaultRegion': '{name} zum Standard der Gilde machen',
  'guild.voice.removeRegion': '{name} entfernen',
  'guild.voice.loadFailed': 'Die Sprachregionen ließen sich nicht laden',
  'guild.voice.addFailed': 'Die Sprachregion ließ sich nicht hinzufügen',
  'guild.voice.defaultFailed': 'Die Standardregion ließ sich nicht setzen',
  // Der Einschub ist die übliche Ursache und seine Wörter wert: ein Kanal, der
  // auf eine Region zeigt, hält sie fest, und die Lösung ist, den Kanal
  // umzustellen, statt es noch einmal zu versuchen.
  'guild.voice.removeFailed': 'Die Region ließ sich nicht entfernen (vielleicht nutzt sie noch ein Kanal)',

  // ------------------------------------------------------- adding a region

  'guild.voice.add.title': 'Eine Region hinzufügen',
  // Schritt eins fragt genau eines. Die Überschrift ist eine Frage, weil der
  // Schritt einer ist, und die Zeile darunter sagt, was als Antwort zählt.
  // "Wo liegt …" statt "Wo ist …", weil ein Relay im Deutschen an einer
  // Adresse liegt.
  'guild.voice.add.step1Title': 'Wo liegt das Relay?',
  // "dial" ist im Englischen die Metapher vom Wählen einer Nummer. Deutsch
  // sagt "ansteuern", wenn eine Maschine eine andere kontaktiert; "anwählen"
  // wäre die wörtliche Übersetzung und klingt nach Modem.
  'guild.voice.add.step1Body': 'Die Adresse eines SFU, den diese Gilde ansteuern darf.',
  'guild.voice.add.sfuLabel': 'SFU-Adresse',
  // `example.com` ist nach RFC 2606 reserviert. Der Host-Teil davor dürfte
  // übersetzt werden, bleibt hier aber "sfu", weil das kein englisches Wort
  // ist, sondern der Protokollbegriff aus der Beschriftung darüber. Das
  // `https://` bleibt in jedem Fall.
  'guild.voice.add.sfuPlaceholder': 'https://sfu.example.com',

  // Drei Korrekturen, keine Absagen: das Feld behält, was getippt wurde, und
  // jede Zeile endet dort, wo die lesende Person etwas tun kann. `{scheme}`
  // ist genau das, was sie getippt hat -- `ws`, `wss`, `turn` -- und wird ihr
  // unverändert zurückgezeigt.
  'guild.voice.address.needsHost': 'Setz den Host dahinter, etwa https://sfu.example.com.',
  // Deutsch muss die Präposition wiederholen ("über … , nicht über …"), weil
  // sonst der Platzhalter am Ende ohne Anschluss hängt.
  'guild.voice.address.wrongScheme': 'Eine Region wird über http oder https angesteuert, nicht über {scheme}.',
  // Der häufigste Fehler: ein nackter Hostname. Die Erklärung ist die
  // wichtigere Hälfte -- ein nackter Host wird vom Browser nicht abgelehnt,
  // sondern *relativ zu dieser Seite aufgelöst*, und das ergibt eine Region,
  // die auf den Client selbst zeigt und lebendig aussieht, weil der Client
  // lebt. "nackt" ist im deutschen Netzjargon für so einen Hostnamen üblich.
  'guild.voice.address.bareHost': 'Fang mit https:// an — ein nackter Host wird als Teil der Adresse dieser Seite gelesen, nicht als Server.',

  // Schritt zwei. Die Brotkrume führt zurück zu Schritt eins und heißt nach
  // dem, was dort steht.
  'guild.voice.add.crumb': 'Adresse',
  // "Name it" ist im Englischen ein Imperativ ohne Subjekt. Deutsch braucht
  // das Pronomen, und es muss zum Geschlecht des Gemeinten passen: die Region
  // ist weiblich, also "ihr". Das Du kommt aus dem Kopfkommentar von `de.js`
  // und ist hier keine Abwägung mehr, sondern gesetzt.
  'guild.voice.add.step2Title': 'Gib ihr einen Namen',
  'guild.voice.add.nameLabel': 'Name der Region',
  // Aus dem englischen "What this relay is called" wird ein Satz, der mit "So
  // heißt …" beginnt: Deutsch stellt das Ergebnis nach vorn und kommt ohne den
  // Relativsatz aus, den eine wörtliche Übersetzung bräuchte.
  'guild.voice.add.nameHint': 'So heißt dieses Relay in der Regionsauswahl eines Kanals.',
  // Ein Platzhaltername, keine Adresse: klein und mit Bindestrich, weil
  // Regionsnamen diese Form haben.
  'guild.voice.add.namePlaceholder': 'mein-relay',
  // TURN ist ein Protokollname (RFC 8656) und bleibt in lateinischen
  // Buchstaben; übersetzt wird nur "(optional)", und das bleibt im Deutschen
  // klein, weil es in der Klammer als Adjektiv steht und nicht als
  // Substantiv -- anders als `common.optional`, das für sich allein am
  // Zeilenanfang steht.
  'guild.voice.add.turnLabel': 'TURN (optional)',
  'guild.voice.add.turnPlaceholder': 'turn.example.com:3478',
  'guild.voice.add.makeDefault': 'Das zum Standard der Gilde machen',
  'guild.voice.add.submit': 'Region hinzufügen',

  // ------------------------------------------------------------- the probe
  //
  // Jedes Urteil hier ist gegen ein einziges Missverständnis geschrieben: dass
  // ein Fehlschlag bedeutet, die Adresse sei falsch. Keines davon blockiert
  // das Absenden, keines sagt "das geht nicht", und jedes endet dort, wo die
  // lesende Person handeln kann. Die Vagheit ist der genaue Teil, und eine
  // deutsche Fassung, die entschiedener klingt als das Original, schickt Leute
  // los, etwas zu reparieren, das nicht kaputt ist.

  'guild.voice.probe.checking': 'Es wird geprüft, ob dein Browser das Relay erreicht…',
  'guild.voice.probe.recheck': 'Erreichbarkeit prüfen',
  // "Dein Browser" und nicht "wir": gemessen wurde von diesem Gerät, in diesem
  // Netz, und über das von irgendjemand anderem sagt das nichts.
  'guild.voice.probe.reachable.title': 'Dein Browser hat es erreicht.',
  // Die Vertrauensbedingung hängt mit Absicht am *guten* Befund: ein Relay,
  // das antwortet, kann diese Gilde trotzdem abweisen, und wer ein Häkchen als
  // "fertig" liest, merkt es erst, wenn ein Gespräch scheitert. Der
  // Gedankenstrich und die zwei Infinitivgruppen am Ende halten die
  // Gegenüberstellung, die Englisch mit "are two different things" macht.
  'guild.voice.probe.reachable.body': 'Ein privater SFU muss trotzdem so eingerichtet sein, dass er dieser Gilde vertraut, bevor ein Gespräch zustande kommt — erreichbar zu sein und diese Gilde anzunehmen sind zwei verschiedene Dinge.',
  // "Es kam keine Antwort" statt "Es hat nicht geantwortet": der unpersönliche
  // Satz beschuldigt das Relay nicht, und genau darum geht es in diesem
  // Befund.
  'guild.voice.probe.unreachable.title': 'Es kam keine Antwort.',
  'guild.voice.probe.unreachable.body': 'Das kann heißen, dass das Relay ausgefallen ist, oder dass es Anfragen aus einem Browser schlicht nicht beantwortet. Wenn es ein privater SFU ist, prüf, ob er dieser Gilde vertrauen darf. Du kannst die Region so oder so hinzufügen und ein Gespräch versuchen.',
  'guild.voice.probe.unverified.title': 'Von hier aus nicht prüfbar.',
  // "normal" trägt hier die Last. Dieser Befund erscheint bei den meisten
  // korrekt eingerichteten privaten Relays, und "und das ist normal" muss im
  // deutschen Satz genauso beiläufig stehen wie im englischen -- nicht
  // "was normal ist" als Nachtrag, sondern als eigene Aussage vor dem
  // Doppelpunkt, damit sie nicht überlesen wird. "Hinweis, kein Urteil" hält
  // die Gegenüberstellung des Originals.
  'guild.voice.probe.unverified.body': 'Der Browser wurde gestoppt, bevor eine Antwort ankam, und das ist normal: Ein SFU, der keine CORS-Header schickt, ist völlig in Ordnung und lässt sich von einer Webseite aus einfach nicht prüfen. Das ist ein Hinweis, kein Urteil — füge die Region hinzu und versuch ein Gespräch.',

  // Die Markierung neben dem Feld ist ein Zeichen, diese drei sind also ihre
  // zugänglichen Namen -- gehört, nie gezeichnet. Benannt wird der Zustand,
  // nicht das Symbol: ein Screenreader liest weder ein Häkchen noch eine
  // Farbe vor.
  'guild.voice.probe.a11yChecking': 'Die Adresse wird geprüft',
  'guild.voice.probe.a11yReached': 'Erreicht',
  'guild.voice.probe.a11yFailed': 'Aus diesem Browser nicht erreichbar',

// The two `DataTable` defaults. Both stay as generic in German as they are in
  // English: they render only when the caller said nothing about what the rows
  // are, so anything more specific would be a lie on most of the tables that
  // reach them. "Datensätze" rather than "Einträge" because the screen reader
  // is announcing a table of records, and "Einträge" is the word the invite
  // list and the audit log already use for their own rows -- reusing it here
  // would make the generic default sound like a specific one.
  'common.table.empty': 'Nichts hier.',
  'common.table.label': 'Datensätze',

// ===========================================================================
  // Deutsch: roles, channel, bots — the glossary these 260 keys are built on
  // ===========================================================================
  //
  // Three namespaces, one vocabulary. `roles` describes a ladder of named
  // permission bundles, `channel` describes the rooms that ladder bends inside,
  // and `bots` describes programs handed rungs of it — so a word chosen in one
  // of them is a word committed to in the other two, and the English headers of
  // all three say as much in their own way. What follows is the set, decided
  // once here so that no individual entry below has to re-argue it:
  //
  //   role                → **Rolle** (die). Already fixed by `errors.role_hierarchy`
  //                         in this file, which speaks of a Rolle standing über
  //                         another. Nothing to reopen.
  //   permission          → **Berechtigung** (die). Fixed by `errors.missing_permission`
  //                         and by `perms.group.*` above. Never *Recht*, never
  //                         *Erlaubnis*: those two are what a lawyer and a parent
  //                         say, and the error layer and the switch have to say
  //                         one word between them.
  //   channel             → **Kanal** (der). Fixed by `perms.group.text`
  //                         (Textkanäle) and `perms.group.voice` (Sprachkanäle).
  //   guild               → **Gilde** (die). Fixed by `settings.messages.typing.hint`
  //                         above, which already says Gildenserver.
  //   member              → **Mitglied** (das). Fixed by `settings.messages.members.label`.
  //   homeserver          → **Heimserver** (der). Fixed by `common.homeserver`.
  //   category            → **Kategorie** (die). The cognate, and right: it is the
  //                         shelf channels sit on, and German uses exactly this
  //                         word for that in every file manager on earth.
  //   overwrite           → **Überschreibung** (die). See the long note over the
  //                         overwrite block in `roles` for why not *Ausnahme*.
  //   allow / deny        → **erlauben / verweigern**. Not *zulassen/sperren*: the
  //                         pair has to read as two sides of one switch, and
  //                         erlauben/verweigern is the pair German law and German
  //                         firewalls both use.
  //   inherit             → **erben**. The role editor and the channel editor both
  //                         call the third state this; see the note at
  //                         `roles.overwrite.inherit`.
  //   thread              → **Thread** (der). A naturalised German noun — in Duden,
  //                         declined (des Threads, die Threads) — not an English
  //                         word left standing. *Strang* and *Diskussionsfaden*
  //                         exist and nobody under sixty uses them.
  //   tag (forum)         → **Schlagwort** (das, pl. Schlagwörter). The one place
  //                         the cognate is actively dangerous; see the long note
  //                         over the forum-tags block in `channel`.
  //   post (forum, noun)  → **Beitrag** (der). English "post" in this namespace is
  //                         always the noun (a forum thread's opening message),
  //                         never the verb; `channel.type.forum.description` and
  //                         `channel.tags.limit` both mean the thing, not the act.
  //   slow mode           → **Slow-Modus** (der). See `channel.edit.slowmodeLabel`.
  //   bot                 → **Bot** (der). TRANSLATED, and the translation happens
  //                         to be spelled the same; see the note at
  //                         `bots.install.title`.
  //   intent (protocol)   → **Ereignisabonnement** (das). The single largest
  //                         departure from the English surface in this fragment,
  //                         argued at `bots.install.intentsTitle`.
  //   grant (noun)        → **Freigabe** (die); grant (verb) → **erteilen**.
  //   ceiling             → **Obergrenze** (die). Already the word this file uses
  //                         for a server-side limit in `errors.too_large`.
  //   capability          → **Fähigkeit** (die), kept deliberately distinct from
  //                         Berechtigung; see `bots.capability.unknownGroup`.
  //   application         → **Anwendung** (die); descriptor → **Anwendungsbeschreibung**.
  //
  // Two grammatical habits run through everything below and are not restated at
  // each entry.
  //
  // **An unknown gender never gets an article or an adjective ending.** `{role}`,
  // `{name}`, `{module}`, `{capability}`, `{permission}`, `{region}` and `{query}`
  // are all data, and German cannot know whether the thing arriving is der, die
  // or das. Three devices keep every such sentence grammatical: German quotation
  // marks „ “ around the value, which turn it into a quoted citation that needs
  // no article at all (the precedent is `errors.missing_permission` above); a
  // participle with no ending where a predicate is needed („{module} eingeschaltet.“
  // rather than „Das {module} wurde eingeschaltet.“); and, where the sentence
  // really does need a gendered pronoun later on, naming the German noun
  // explicitly (die Rolle, der Kanal, der Bot) so the pronoun agrees with a word
  // this file wrote rather than with one the server sent.
  //
  // **Buttons take the infinitive, headings take a noun phrase.** German does
  // distinguish the two, which English here does not — `roles.list.create`
  // ("Create Role") and `roles.create.title` ("Create role") differ only in
  // capitalisation in English and are a verb and a noun in German. The English
  // comments invite exactly this ("if a language distinguishes the two, this is
  // the imperative"), so the distinction is taken up wherever both keys exist.
  //
  // Nothing below has been shortened to fit. Ereignisabonnements is twenty-one
  // characters where Intents is seven, Standardberechtigungen is twenty-two where
  // Default Permissions is nineteen, and Teilnehmerbegrenzung will not sit in the
  // space User limit sits in. That is the file doing its job: `i18n-layout.test.jsx`
  // exists to catch a row that was built for English, and a translation that
  // trims itself down to the row hides the defect in a language the people who
  // built the row cannot read.

  // ==== roles

  // ----------------------------------------------------------------- the list

  // The rank rule, stated once for the whole screen. German puts the finite verb
  // second and the infinitives at the end, which turns the English passive
  // ("can only be edited ... by somebody above it") into an active relative
  // clause with the agent last: *wer über ihr steht* is the subject and it lands
  // where German expects new information. The ladder metaphor — über / unter /
  // auf gleicher Höhe — is the one `errors.role_hierarchy` already committed to
  // above, and it is used in all four places English uses its four rank words.
  'roles.list.hint': 'Eine Rolle kann nur bearbeiten, verschieben oder vergeben, wer über ihr steht.',

  // `@everyone` is the heading of its own section, so the heading is the concept
  // and not the role name. One compound of twenty-two letters where English has
  // two words of nineteen; it is not split into „Standard-Berechtigungen“,
  // because German compounds this noun and a hyphen here would look like a
  // translator flinching at the width.
  'roles.everyone.title': 'Standardberechtigungen',
  // „darf“ rather than „kann“: the sentence is about permission, not ability,
  // and German keeps those two verbs apart where English blurs them into "can".
  'roles.everyone.description': 'Was jedes Mitglied dieser Gilde darf, bevor irgendeine Rolle vergeben wird.',

  // Both arms are genuinely different in German, unlike the English, because
  // Mitglied takes an umlaut in the plural. This is the case the English comment
  // was describing when it said a real plural rather than "member(s)".
  'roles.memberCount': '{count, plural, one {# Mitglied} other {# Mitglieder}}',

  // Here the two arms differ where English's do not, which is precisely the
  // freedom the English comment reserved for us: German would write „Rolle - 1“
  // over a list of one and „Rollen - 4“ over a list of four, and a heading that
  // said Rollen above a single row would read as a typo. The separator stays the
  // plain hyphen-with-spaces the English uses; `common.convo.group` above sets
  // the same precedent for a count appended to a heading.
  'roles.list.title': '{count, plural, one {Rolle - #} other {Rollen - #}}',
  // „wer über wem steht“ — the same vertical metaphor again, and the dative
  // *wem* is what German requires after über in a static sense. „Zieh“ is the
  // du-imperative, which is the convention this whole catalogue is on.
  'roles.list.description': 'Zieh eine Rolle, um zu ändern, wer über wem steht.',

  // The imperative on the button. German uses the bare infinitive for this and
  // it is the form every German application puts on a button; it is also what
  // tells this key apart from `roles.create.title` below, which English can only
  // distinguish by capitalising.
  'roles.list.create': 'Rolle erstellen',

  // Accessible name and placeholder in one. „durchsuchen“ rather than „suchen“:
  // the object is the collection being searched, not the thing being looked for,
  // and German marks that difference with the prefix.
  'roles.list.search': 'Rollen durchsuchen',

  'roles.list.empty.title': 'Noch keine Rollen',
  'roles.list.empty.body': 'Alle hier haben die Standardberechtigungen und sonst nichts.',

  // German quotation marks, as the English comment asks for („ “ rather than
  // “ ”). They are also what keeps `{query}` grammatical: whatever somebody
  // typed is a citation here, and a citation needs no article and agrees with
  // nothing.
  'roles.list.noMatch': 'Keine Rolle passt zu „{query}“.',

  // `{role}` is a name somebody in this guild typed, of unknown gender, so it is
  // quoted rather than given an article; German then puts the infinitive last,
  // which moves the placeholder to the front of the phrase where English has it
  // at the back.
  'roles.row.edit': '„{role}“ bearbeiten',
  'roles.row.delete': '„{role}“ löschen',

  // The dialog heading, as against the button above. A German dialog titles
  // itself with a noun phrase, so this is „Neue Rolle“ and the button is
  // „Rolle erstellen“ — the distinction English spells with a capital R.
  'roles.create.title': 'Neue Rolle',
  'roles.create.nameLabel': 'Name der Rolle',
  'roles.create.confirm': 'Erstellen',
  // A lead-in, not a sentence: `errors.context` joins it to whatever the server
  // said with a colon, so it takes no full stop. German turns the English
  // "Could not X" into a passive with the object first, which is what reads
  // naturally in front of a colon: „Die Rolle konnte nicht erstellt werden: …“.
  // Every failure key in all three namespaces follows this one shape.
  'roles.create.failed': 'Die Rolle konnte nicht erstellt werden',

  // The confirmation heading. English spells this identically to
  // `roles.row.delete` and the comment says several languages do not; German is
  // one of them. A heading nominalises — „Löschen von X“ — where the tooltip on
  // a control uses the infinitive. Same three words, two grammars.
  'roles.delete.title': 'Löschen von „{role}“',
  // „mit ihr“ agrees with *die Rolle*, a noun this sentence names itself, so the
  // pronoun is safe even though the role's own name is not in the sentence.
  'roles.delete.body': 'Überschreibungen in Kanälen, die diese Rolle nennen, verschwinden mit ihr.',
  'roles.delete.failed': 'Die Rolle konnte nicht gelöscht werden',

  // The list has already snapped back, so this says what did not happen.
  // „Reihenfolge“ carries what English gets from the verb "reorder"; German has
  // no single verb for it that is not either clumsy (umsortieren) or ambiguous
  // (ordnen).
  'roles.reorder.failed': 'Die Reihenfolge der Rollen konnte nicht geändert werden',

  // --------------------------------------------------------------- the editor

  'roles.editor.back': 'Zurück zu den Rollen',

  // The token keeps all nine characters. It is what somebody types into the
  // composer, so a German @alle would name a role that does not exist; the
  // sentence is built around the token instead, with the verb cluster at the end
  // where German wants it.
  'roles.everyone.locked': '@everyone lässt sich nicht verschieben, umbenennen oder löschen.',

  // The two bot-role notices. „Bei der Installation angelegt“ rather than „von
  // der Installation erstellt“: German prefers the prepositional phrase over an
  // agentive von-phrase when the agent is a process rather than a person, and
  // „anlegen“ is the verb German uses for a record being brought into existence
  // by machinery, as against „erstellen“ for something a person makes.
  //
  // „was der Bot darf“ is the same darf/kann distinction as in
  // `roles.everyone.description`, and it is the phrase used for this idea in
  // `bots` as well, so the two screens say one thing.
  'roles.managed.canManageGuild': 'Diese Rolle gehört zu einem installierten Bot. Sie wurde bei der Installation angelegt und lässt sich hier nicht bearbeiten — was der Bot darf, änderst du auf der Seite „Bots“ in diesen Einstellungen.',
  // The second half names the permission, because that is the whole point of
  // this variant. `{permission}` arrives already translated from
  // `perms.manage_guild.label`, of unknown gender, so it gets the same quoted
  // apposition `errors.missing_permission` uses above: the article agrees with
  // *die Berechtigung*, never with the value.
  'roles.managed.needsManageGuild': 'Diese Rolle gehört zu einem installierten Bot. Sie wurde bei der Installation angelegt und lässt sich hier nicht bearbeiten. Was der Bot darf, wird auf der Seite „Bots“ geändert, und dafür braucht man die Berechtigung „{permission}“.',

  // Phrased as the server's refusal, not the screen's, exactly as the English
  // insists. „auf deiner Höhe oder darüber“ is the third appearance of the
  // ladder; „lässt dich … nicht ändern“ keeps the server as the grammatical
  // agent, which is the thing a reader must not be able to mistake for a client
  // limitation.
  'roles.editor.notEditable': 'Diese Rolle steht auf deiner Höhe oder darüber, deshalb lässt dieser Server dich sie nicht ändern.',

  // The three tabs. „Darstellung“ for Display — what the role looks like — and
  // deliberately not „Anzeige“, which in this client means the act of showing
  // something. Note that `channel.forum.layoutLabel` therefore cannot also be
  // Darstellung; it is Standardansicht, and the two are kept apart on purpose.
  // „Mitglieder verwalten“ is two words because it is a tab you act from, which
  // is the distinction the English comment draws.
  'roles.tab.display': 'Darstellung',
  'roles.tab.permissions': 'Berechtigungen',
  'roles.tab.members': 'Mitglieder verwalten',

  'roles.editor.saveFailed': 'Die Rolle konnte nicht gespeichert werden',

  // Sharp, as instructed. „Achtung“ is the German word that carries the weight
  // of "Careful" without tipping into „Vorsicht!“, which is what a warning sign
  // on a machine says. „ungespeichert“ is a real German participle and not a
  // calque; the alternative, „nicht gespeicherte Änderungen“, is three words
  // where the sentence wants one and reads limper.
  'roles.editor.unsaved': 'Achtung, du hast ungespeicherte Änderungen.',
  // Four syllables where English has one, in a bar a few hundred pixels wide,
  // and kept anyway. The honest short alternatives are all wrong: „Verwerfen“
  // says throw away without saying restore, and „Abbrechen“ is already
  // `common.cancel` and would put two different meanings behind one word in
  // adjacent buttons.
  'roles.editor.reset': 'Zurücksetzen',
  // Not `common.save` („Speichern“), for the same reason English does not use
  // its own: this commits a set of edits gathered across three tabs.
  'roles.editor.save': 'Änderungen speichern',

  // ----------------------------------------------------------- the display tab

  'roles.display.colour': 'Rollenfarbe',
  // English's relative clause ("the highest role they hold that has one") stacks
  // two qualifiers on one noun, which German cannot do without a garden path.
  // Recast as a genitive plus one relative clause: *der höchsten ihrer Rollen,
  // die überhaupt eine hat*. „überhaupt“ carries the force of English's stranded
  // "that has one" — the point being that a role may have no colour at all.
  'roles.display.colourHint': 'Mitglieder tragen die Farbe der höchsten ihrer Rollen, die überhaupt eine hat.',
  // Not „Schwarz“ and not „Transparent“, as the English comment warns: the
  // absence of a colour, which the theme then fills in.
  'roles.display.noColour': 'Keine Farbe',

  'roles.display.hoist': 'Mitglieder dieser Rolle getrennt anzeigen',
  // „getrennt angezeigt“ echoes the switch label above word for word, which is
  // what makes the hint readable as an explanation of that switch rather than of
  // some other mechanism. German has no verb for "to hoist" in this sense and
  // inventing one („hochziehen“) would be a word nobody would recognise from the
  // switch they just flipped.
  'roles.display.hoistHint': 'Mitglieder mit dieser Rolle bekommen in der Mitgliederliste eine eigene Überschrift, und zwar unter der höchsten getrennt angezeigten Rolle, die sie haben.',
  // `@mention` stays in Latin script: it names a gesture with a literal
  // spelling, the same way `@everyone` does. German then needs a verb, and
  // „ansprechen“ is used rather than „erwähnen“ because „diese Rolle per
  // @mention erwähnen“ would say the same thing twice.
  'roles.display.mentionable': 'Allen erlauben, diese Rolle mit @mention anzusprechen',
  // English's "Without it" leaves the antecedent to the reader; German pronouns
  // would have to pick a gender for it, and the two candidates in scope (die
  // Rolle, die Berechtigung) are both feminine, so a bare „sie“ would be a real
  // ambiguity rather than a pedantic one. The noun is repeated instead.
  // „anpingen“ is the verb German chat actually uses; „anstupsen“ is a poke and
  // „benachrichtigen“ is what the system does, not what a person does.
  'roles.display.mentionableHint': 'Ohne diese Berechtigung können nur Mitglieder mit „{permission}“ die Rolle anpingen.',

  // ------------------------------------------------------------- the palette
  //
  // Paint-chart names, as the English comment asks, and not CSS keywords. Three
  // calls worth recording:
  //
  //   * Pink and Rosa are different colours in German. Rosa is the pale one;
  //     Pink is the saturated one, and it is a fully German colour word (das
  //     Pink, pinkfarben) rather than an English one left standing. The swatch
  //     is #eb459e, which is Pink.
  //   * The two greens are told apart the way the English asks: Grün and
  //     Smaragdgrün. Smaragd alone is the gemstone, not the colour.
  //   * Purple is Violett rather than Lila. Lila is the softer, greyer end of
  //     the range and would collide by ear with Pink on one side and Indigo on
  //     the other, and these names are read aloud one at a time by a screen
  //     reader with no swatch to disambiguate them.
  //   * Teal is Türkis. Blaugrün is the accurate translation and no German paint
  //     chart uses it; Türkis is what somebody would say out loud.
  'roles.colour.indigo': 'Indigo',
  'roles.colour.green': 'Grün',
  'roles.colour.yellow': 'Gelb',
  'roles.colour.pink': 'Pink',
  'roles.colour.red': 'Rot',
  'roles.colour.teal': 'Türkis',
  'roles.colour.orange': 'Orange',
  'roles.colour.purple': 'Violett',
  'roles.colour.blue': 'Blau',
  'roles.colour.grey': 'Grau',
  'roles.colour.emerald': 'Smaragdgrün',
  'roles.colour.gold': 'Gold',

  // ----------------------------------------------------- the permissions tab

  'roles.permissions.search': 'Berechtigungen durchsuchen',

  // Consent copy about the one irreversible switch, and both halves are kept.
  // The sentence opens on the quoted `{permission}` — German allows a quotation
  // in subject position and it is the cleanest way to start a sentence with a
  // value of unknown gender. „geht … hinweg über“ is stronger than „ignoriert“
  // and is the idiom for overriding something somebody set up deliberately,
  // which is the half the English comment says must not be dropped.
  'roles.permissions.adminNotice': '„{permission}“ ist jede Berechtigung, und es geht über die Überschreibungen in Kanälen hinweg.',
  'roles.permissions.noMatch': 'Keine Berechtigung passt zu „{query}“.',

  // -------------------------------------------------------- the members tab

  // The accessible name says what the box is for; the placeholder says what to
  // type. German keeps them apart the same way English does, with the purpose
  // („zum Hinzufügen“) in the name and the method („nach Namen“) in the hint.
  'roles.members.search': 'Mitglieder zum Hinzufügen suchen',
  'roles.members.searchPlaceholder': 'Mitglieder nach Namen suchen',

  'roles.members.matching': 'Treffer für „{query}“',
  // About the guild, not about the search, as the English comment insists.
  // „hört auf diesen Namen“ is the German idiom for answering to a name and it
  // keeps the slight wryness of the English without inventing a joke.
  'roles.members.noMatch': 'In dieser Gilde hört niemand auf diesen Namen.',

  // The heading over the holders. English's participle ("Holding X") has the
  // people as an implied subject, which German cannot do — a bare „Trägt“ would
  // make the role the subject and say the opposite. Recast as a prepositional
  // phrase naming the people: *Mitglied(er) mit „X“*. That also lets the two
  // arms differ, which they do here and do not in English.
  'roles.members.holding': '{count, plural, one {Mitglied mit „{role}“ - #} other {Mitglieder mit „{role}“ - #}}',

  'roles.members.empty.title': 'Diese Rolle hat niemand',
  // „sie“ agrees with *die Rolle* from the title above it, which is the noun on
  // screen directly over this line.
  'roles.members.empty.body': 'Such oben nach jemandem, um sie zu vergeben.',

  // The counterpart of `common.remove` („Entfernen“), so the pair reads as one
  // control in two states.
  'roles.members.add': 'Hinzufügen',
  // „Das Mitglied“ rather than the name, as the English comment asks: the row is
  // still on screen. Das Mitglied is neuter regardless of who it is, which is
  // one of the very few places German grammar makes this kind of sentence
  // easier rather than harder.
  'roles.members.addFailed': 'Das Mitglied konnte nicht hinzugefügt werden',
  'roles.members.removeFailed': 'Das Mitglied konnte nicht entfernt werden',

  // ------------------------------------------------------ channel overwrites
  //
  // **Überschreibung** is the term of art, everywhere, in both namespaces. The
  // alternatives were weighed and each loses something the mechanism needs:
  // *Ausnahme* says exception and says nothing about direction, so the sentence
  // that has to mean "narrows or widens" would be arguing with its own noun;
  // *Sonderregel* invents a rule where the server has an override; and leaving
  // "Overwrite" in English would put an untranslated word on the one screen
  // where the reader is being asked to understand a mechanism rather than press
  // a button. Überschreibung is also literally what the wire calls it, so a
  // moderator reading German and a developer reading the API are demonstrably
  // talking about the same object.

  // Both directions, because the English comment says the mechanism is an
  // exception mechanism and not a restriction mechanism. German splits the
  // separable verb — *schränkt … ein* — and the particle lands at the end, which
  // is why the sentence reads "narrows the permissions of a role inside one
  // channel in, or widens them": the „ein“ and the „oder erweitert sie“ have to
  // share the end of the clause.
  'roles.overwrite.hint': 'Eine Überschreibung schränkt die Berechtigungen einer Rolle innerhalb eines Kanals ein oder erweitert sie. Threads erben die Einstellungen ihres übergeordneten Kanals.',

  'roles.overwrite.channel': 'Kanal',
  'roles.overwrite.role': 'Rolle',

  // Three whole phrases, never assembled from the permission's name. Each is
  // read aloud alone, so each has to survive alone — „Erlauben“ by itself would
  // be a verb and not a state, exactly the failure the English comment
  // describes. Fronting „In diesem Kanal“ puts the scope first, which is where a
  // listener needs it and where German is happy to have it.
  //
  // „Von der Rolle erben“ rather than „Standard“ or „Neutral“, because the
  // permission genuinely falls through to whatever the role grants guild-wide,
  // and „Standard“ in German suggests off just as strongly as "Default" does in
  // English.
  'roles.overwrite.inherit': 'Von der Rolle erben',
  'roles.overwrite.allow': 'In diesem Kanal erlauben',
  'roles.overwrite.deny': 'In diesem Kanal verweigern',

  // The only place the permission is spoken. Quoted, so no article is needed for
  // a value whose gender is unknowable; „in diesem Kanal“ then matches the
  // phrasing of the three states above word for word, which is what lets a
  // screen reader say the two halves in either order and still make sense.
  'roles.overwrite.control': '„{permission}“ in diesem Kanal',

  'roles.overwrite.save': 'Überschreibung speichern',
  'roles.overwrite.saved': 'Überschreibung gespeichert.',
  'roles.overwrite.saveFailed': 'Die Überschreibung konnte nicht gespeichert werden',

  // ==== channel

  // ------------------------------------------------ the shared field labels
  //
  // Form labels, not nouns in a sentence. German form labels take the
  // nominative and no article, which is what these are.

  'channel.field.name': 'Name',
  // „Thema“ and not „Themenbereich“ or „Betreff“: a channel topic is the line in
  // the header saying what the room is about, which is exactly what Thema means.
  // Betreff is a mail subject and would import the wrong shape of thing.
  'channel.field.topic': 'Thema',
  'channel.field.category': 'Kategorie',
  // A choice, not a state — so „Keine Kategorie“ with the feminine ending
  // agreeing with Kategorie, not the bare „Keine“ that `channel.slowmode.off`
  // uses for a different reason a few blocks down.
  'channel.field.noCategory': 'Keine Kategorie',
  'channel.field.region': 'Region',
  // The switch on the create dialogs; `channel.perms.privateLabel` is the longer
  // one on the settings dialog and is deliberately not the same string.
  'channel.field.private': 'Privat',

  // ------------------------------------------------------ the kinds of room
  //
  // Words for a thing, chosen from a list, not the wire's identifiers. „Sprache“
  // rather than „Stimme“ for Voice: the whole catalogue already says Sprachkanal
  // (`perms.group.voice` above), and Stimme in German is the physical voice or a
  // vote. „Ankündigung“ rather than „Bekanntmachung“, which is what a town hall
  // posts on a noticeboard.

  'channel.type.text.name': 'Text',
  'channel.type.text.description': 'Nachrichten, Threads und Dateien.',
  'channel.type.voice.name': 'Sprache',
  // „den Bildschirm teilen“ is the settled German for screen sharing; „Bildschirm
  // freigeben“ is what the enterprise tools say and would collide with Freigabe,
  // which this fragment has already spent on bot grants.
  'channel.type.voice.description': 'Reden und den Bildschirm teilen.',
  'channel.type.forum.name': 'Forum',
  'channel.type.forum.description': 'Jeder Beitrag ist ein eigener Thread.',
  'channel.type.announcement.name': 'Ankündigung',
  // „Eingeschränktes Schreibrecht“ compresses English's "Restricted posting"
  // into the noun German would actually use for it. „ihm folgen“ agrees with
  // *der Kanal*, which is the subject of the whole block and a gender this file
  // owns.
  'channel.type.announcement.description': 'Eingeschränktes Schreibrecht. Andere Gilden können ihm folgen.',

  // ---------------------------------------------------- creating a channel

  // The dialog's own description of itself, with the indefinite article that
  // marks it as a description rather than as the act. The button below is the
  // act and drops the article — that is the whole difference between the two
  // strings in German, and it is the same difference English marks by putting
  // "a" in one of them.
  'channel.create.title': 'Einen Kanal erstellen',

  // Four sentences, and this is the key the English header holds up as the
  // reason. German capitalises every noun, so the lowercasing the old code did
  // would have been simply wrong here; and German compounds, so it is
  // Textkanal and not „Text Kanal“. Four compounds, four keys, no arithmetic.
  'channel.create.newText': 'Neuer Textkanal',
  'channel.create.newVoice': 'Neuer Sprachkanal',
  'channel.create.newForum': 'Neuer Forumkanal',
  'channel.create.newAnnouncement': 'Neuer Ankündigungskanal',

  // An example of a name a German-speaking guild would actually type into this
  // box, which is what the English comment asks for — not a translation of the
  // English example as a word. Lowercase, because the lowercase-slug convention
  // for channel names holds in German guilds too.
  'channel.create.namePlaceholder': 'allgemein',

  // `@everyone` is the literal token again — a German @alle would name a role
  // that does not exist — and it is left untouched here and in the three other
  // places below that mention it.
  //
  // Consequence first, undo second, as in the English. The undo is recast into
  // the second person („gibst du … frei“) because German has no comfortable
  // imperative for "grant it back" that does not read as an order from the
  // software to the reader.
  'channel.create.privateHint': 'Vor @everyone verborgen. In den Berechtigungen des Kanals gibst du den Zugang wieder frei.',

  'channel.create.submit': 'Kanal erstellen',
  'channel.create.failed': 'Der Kanal konnte nicht erstellt werden',

  // --------------------------------------------------- creating a category
  //
  // Kept separate from `channel.create.*` exactly as the English intends, and
  // German is a language where that matters: Kanal is masculine and Kategorie is
  // feminine, so every article, every pronoun and every adjective ending in
  // these five strings differs from its channel counterpart. Sharing the keys
  // would have forced one of the two to be ungrammatical.

  'channel.createCategory.title': 'Eine Kategorie erstellen',
  // Capitalised, because a category name is a heading in this product's
  // convention — and in German it would be capitalised anyway, being a noun,
  // which is why the example is a noun and not an adjective.
  'channel.createCategory.namePlaceholder': 'Allgemein',
  // `@everyone` untouched, as above.
  //
  // Stronger than the channel version, because it is true of more. „alles
  // darunter“ is literal in both senses German needs: below it in the list, and
  // filed under it.
  'channel.createCategory.privateHint': 'Vor @everyone verborgen, und alles darunter ebenfalls.',
  'channel.createCategory.submit': 'Kategorie erstellen',
  'channel.createCategory.failed': 'Die Kategorie konnte nicht erstellt werden',

  // ------------------------------------------------------ the settings shell

  'channel.edit.title': 'Kanal bearbeiten',
  'channel.edit.titleCategory': 'Kategorie bearbeiten',

  // The tab strip does not scroll and does not grow. „Übersicht“ is seven
  // letters against Overview's eight, so that one is free; „Schlagwörter“ is
  // twelve against Tags' four and is kept anyway, for the reason argued at
  // length over the forum-tags block below. If the strip cannot hold it, the
  // strip is what has to change.
  'channel.tab.overview': 'Übersicht',
  'channel.tab.tags': 'Schlagwörter',
  'channel.tab.permissions': 'Berechtigungen',

  // Commits the whole tab, which is why it is not `common.save`.
  'channel.edit.save': 'Änderungen speichern',
  'channel.edit.saveFailed': 'Der Kanal konnte nicht aktualisiert werden',
  // And here is the payoff for two keys rather than one interpolated noun: der
  // Kanal and die Kategorie take different articles, so one sentence with a slot
  // in it could not have been written in German at all.
  'channel.edit.saveFailedCategory': 'Die Kategorie konnte nicht aktualisiert werden',

  // ------------------------------------------------------------ the overview

  'channel.edit.topicHint': 'Wird in der Kopfzeile angezeigt.',
  // The channel/room distinction the English comment asks to keep. German has
  // both words and they carry the same difference: ein Kanal is read, ein Raum
  // is occupied.
  'channel.edit.topicPlaceholder': 'Wofür ist dieser Kanal da?',
  'channel.edit.topicPlaceholderVoice': 'Wofür ist dieser Raum da?',

  // **Slow-Modus.** The English comment allows a translation where the language
  // has a settled equivalent and forbids a paraphrase like "message delay
  // setting". German moderators say Slowmode out loud and write Slow-Modus; the
  // hyphenated compound is the form that declines (im Slow-Modus, den
  // Slow-Modus) and the form German orthography wants for an English stem glued
  // to a German noun. The honest native candidates all fail the say-it-out-loud
  // test: „Nachrichtensperre“ names a ban, „Wartezeit“ names the number and not
  // the feature, and „Entschleunigung“ is a word from a wellness pamphlet.
  'channel.edit.slowmodeLabel': 'Slow-Modus',
  // The parenthetical is doing real work — a voice channel's slowmode is about
  // the typing in it — and is not dropped for length.
  'channel.edit.slowmodeChatLabel': 'Slow-Modus (Chat)',
  // Lower case and describing people rather than naming a switch, which is the
  // distinction the English comment draws. „Nachrichten verwalten“ is the wording
  // `perms.manage_messages.label` will take when `perms` is translated; see the
  // report — this line fixes it.
  'channel.edit.slowmodeHint': 'Wer Nachrichten verwalten darf, ist davon ausgenommen.',

  'channel.edit.previewsLabel': 'Linkvorschauen anzeigen',
  // The reassurance is the point, and „so oder so“ is the German idiom that
  // carries "either way" with the same shrug. Fronting it puts the concessive
  // first, where German likes it, and leaves the proxy — the new information —
  // at the end.
  'channel.edit.previewsHint': 'So oder so werden sie über den eigenen Proxy der Gilde geladen.',

  // **Aufbewahrungsdauer** rather than the literal „Ablauf von Dateien“: it
  // names the span, which is what the box takes.
  'channel.edit.expiryLabel': 'Aufbewahrungsdauer für Dateien',
  // Two short sentences, and „Sekunden“ stays first, as the English asks: it is
  // what somebody needs before they start typing.
  'channel.edit.expiryHint': 'Sekunden. Leer heißt, es gilt die Obergrenze der Gilde.',
  // „in diesem Kanal“ carries what English loads onto the adjective "channel":
  // the guild's cap still applies, and this says only that the channel adds none
  // of its own. A bare „Keine Grenze“ would promise something false.
  'channel.edit.expiryPlaceholder': 'Keine Grenze in diesem Kanal',
  'channel.edit.fileSizeLabel': 'Maximale Dateigröße',
  'channel.edit.fileSizeHint': 'Bytes. Leer heißt, es gilt die Obergrenze der Gilde oder des Servers. Nur Anhänge.',
  'channel.edit.fileSizePlaceholder': 'Keine Grenze in diesem Kanal',

  // ------------------------------------------------------------- durations
  //
  // Two categories, one and other, which is all German declares — so both arms
  // are present on all four patterns below and nothing else is. The `#` in each
  // is the ICU count and goes through `Intl`, which for German means a full stop
  // as the thousands separator; it is never pasted in as digits.

  // The English comment predicted this key exactly: „Aus“ is the state of a
  // toggle and lives at `common.off` above, and this is an option in a ladder of
  // durations, where it means no wait at all. „Keine“ agrees with the *Wartezeit*
  // the whole ladder is measuring, which is why it carries a feminine ending
  // despite standing alone.
  'channel.slowmode.off': 'Keine',
  'channel.duration.seconds': '{count, plural, one {# Sekunde} other {# Sekunden}}',
  'channel.duration.minutes': '{count, plural, one {# Minute} other {# Minuten}}',
  'channel.duration.hours': '{count, plural, one {# Stunde} other {# Stunden}}',

  // ----------------------------------------------------------- forum defaults
  //
  // Defaults, not rules. „Standard-“ as the first element of the compound is
  // what makes that read correctly in German; a bare „Sortierung“ or „Ansicht“
  // would describe a setting the reader cannot change afterwards, which is the
  // misreading the English comment warns against.

  'channel.forum.sortLabel': 'Standardsortierung',
  // „Damit fängt das Forum an“ — the board is where the reader arrives, and
  // German says anfangen mit for a starting state. „Brett“ is the literal
  // translation of board and is a word for a physical noticeboard.
  'channel.forum.sortHint': 'Damit fängt das Forum an.',
  // Last reply, not last post — „Letzte Aktivität“ carries that in German the
  // same way it does in English, and „Letzter Beitrag“ would say the opposite.
  'channel.forum.sort.activity': 'Letzte Aktivität',
  // The thread's own creation time. „Erstellungsdatum“ and not
  // „Veröffentlichungsdatum“, which would suggest an editorial act.
  'channel.forum.sort.creation': 'Erstellungsdatum',
  // „Ansicht“ and not „Darstellung“: Darstellung is spent on `roles.tab.display`
  // a few hundred lines up, and List/Gallery are two views of one board.
  'channel.forum.layoutLabel': 'Standardansicht',
  // „stellt … voran“ is a separable verb and the particle goes last, which is
  // why the placeholder-free English "leads with X" becomes a German sentence
  // with the object in the middle.
  'channel.forum.layoutHint': 'Die Galerie stellt das erste Bild jedes Beitrags voran.',
  'channel.forum.layout.list': 'Liste',
  'channel.forum.layout.gallery': 'Galerie',

  // ----------------------------------------------------------- voice settings

  'channel.voice.regionLabel': 'Sprachregion',
  // SFU is left exactly as it stands — see the untranslated list in the report.
  // German needs an article for it and the wire does not supply a gender, so one
  // has to be chosen and used consistently: *die SFU*, agreeing with Einheit,
  // which is what the U expands to. „Automatisch“ must match
  // `channel.voice.regionAuto` below word for word, because this sentence tells
  // the reader to go and find that option in the list.
  'channel.voice.regionHint': 'Welche SFU diesen Kanal weiterleitet. „Automatisch“ folgt der Voreinstellung der Gilde.',
  'channel.voice.regionAuto': 'Automatisch',
  // The longer form, where there is room to say what Auto resolves to.
  'channel.voice.regionAutoDefault': 'Automatisch (Voreinstellung der Gilde bzw. des Servers)',
  // `{region}` is a minted identifier and is never touched. The parenthetical is
  // a past participle used predicatively, which in German takes no ending at all
  // — so „(selbst definiert)“ works whatever gender the region identifier would
  // have had, where an adjective like „(eigene)“ would have had to guess.
  'channel.voice.regionCustom': '{region} (selbst definiert)',
  'channel.voice.bitrateLabel': 'Bitrate',
  // Not softened. „kostet“ stays a cost and „pro sprechender Person“ keeps the
  // per-speaker linearity the English comment says must not be lost. „Betreiber“
  // rather than „Host“, because on a self-hosted server the person reading this
  // is the one paying, and Betreiber is what they would call themselves.
  'channel.voice.bitrateHint': 'Höher kostet den Betreiber mehr Bandbreite pro sprechender Person.',
  // `kbps` is a unit symbol and stays; the space before it is the translator's,
  // and German typography keeps a space between a number and a unit exactly as
  // English does here.
  'channel.voice.bitrateValue': '{kbps, number} kbps',
  // „Teilnehmerbegrenzung“ rather than „Nutzerlimit“: the thing being counted is
  // people in a room, which German calls Teilnehmer, and Nutzer in this client
  // means an account. Twenty letters against User limit's ten, in a form-label
  // column; kept.
  'channel.voice.limitLabel': 'Teilnehmerbegrenzung',
  // The digit, because it is the literal character somebody types into the
  // neighbouring box.
  'channel.voice.limitHint': '0 bedeutet keine Begrenzung.',
  'channel.voice.limitNone': 'Keine Begrenzung',
  // Person / Personen, and the `one` arm is genuinely reached because the ladder
  // has a rung of 1.
  'channel.voice.limitPeople': '{count, plural, one {# Person} other {# Personen}}',

  // --------------------------------------------------------------- forum tags
  //
  // **Schlagwort, not Tag, and this is the one lexical choice in the fragment
  // that is a correctness matter rather than a matter of taste.** German has
  // borrowed "Tag" for exactly this sense and Discord's own German build uses
  // it — but German already owns the word Tag, meaning *day*, and it is one of
  // the hundred commonest nouns in the language. `channel.tags.limit` renders as
  // „Höchstens 5 Schlagwörter.“; with the loanword it would render „Höchstens 5
  // Tags.“, which a German reader parses as *at most five days* before they
  // parse it as anything else, on a settings pane that a few rows earlier is
  // talking about file retention in seconds. „Nur für die Moderation“ sitting on
  // a row labelled Tag would be worse still.
  //
  // Schlagwort is the settled German for a keyword attached to a record — it is
  // what libraries, blogs and every German CMS call this — it compounds cleanly
  // (Schlagwortliste), and it pluralises unambiguously as Schlagwörter. Twelve
  // letters against four, on a tab strip and in a button, and kept.

  // Two plural blocks in one pattern, both preserved, each with its own count.
  // German splits them the same way English does; „davon“ in the second block is
  // what refers back to the Schlagwörter of the first without repeating the
  // noun, which is how the two halves stay one sentence to a reader.
  'channel.tags.limit': '{max, plural, one {Höchstens # Schlagwort.} other {Höchstens # Schlagwörter.}} {perPost, plural, one {Ein Beitrag darf # davon tragen.} other {Ein Beitrag darf # davon tragen.}}',

  // Accessible names only, never drawn. German has no noun-noun juxtaposition
  // for "Tag 3 emoji" that is not a compound, and a compound cannot take a
  // number in the middle of it — so the genitive-ish *von*-phrase is used and
  // the placeholder moves to the end, which is the opposite of where English has
  // it. The field is named and nothing else: no „Feld“, no „Eingabe“.
  'channel.tags.emojiLabel': 'Emoji von Schlagwort {n, number}',
  'channel.tags.nameLabel': 'Name von Schlagwort {n, number}',
  // The emoji box is 84 pixels wide. „Emoji“ is the German word too and happens
  // to fit; „Name“ likewise. This is the one place in the fragment where the
  // English comment sets a hard character budget and German does not spend it.
  'channel.tags.emojiPlaceholder': 'Emoji',
  'channel.tags.namePlaceholder': 'Name',
  // About who may *apply* the tag, not who may see it, which is the misreading
  // the English comment warns about. „Nur für die Moderation“ keeps that reading
  // open in a way „Nur für Moderatoren sichtbar“ would close off wrongly, and it
  // avoids the gendered pair on a control label where `common.*` above has room
  // for one and this row does not.
  'channel.tags.moderated': 'Nur für die Moderation',
  // `{name}` is data, quoted rather than given an article, with the infinitive
  // last as German wants.
  'channel.tags.removeNamed': '„{name}“ entfernen',
  'channel.tags.removeUnnamed': 'Dieses Schlagwort entfernen',
  'channel.tags.fieldLabel': 'Schlagwörter',
  'channel.tags.empty': 'Dieses Forum hat noch keine Schlagwörter.',
  'channel.tags.add': 'Schlagwort hinzufügen',
  'channel.tags.save': 'Schlagwörter speichern',
  // Not hedged. The server refuses; it does not "may refuse". German puts the
  // object first and the finite verb second — „Schlagwörter … weist der Server
  // ab“ — which is a perfectly ordinary German sentence and happens to give the
  // refusal the same end-weight the English gets from its passive.
  'channel.tags.moderatedNote': 'Schlagwörter, die nur der Moderation vorbehalten sind, weist der Server ab, nicht nur dieser Bildschirm.',
  'channel.tags.saveFailed': 'Die Schlagwörter konnten nicht gespeichert werden',

  // -------------------------------------------------------- who is allowed in

  // Longer than `channel.field.private` on purpose, as in the English: here the
  // switch sits above a column of role rows and „Privat“ alone could be read as
  // being about the role.
  'channel.perms.privateLabel': 'Privater Kanal',
  // `@everyone` untouched, as everywhere.
  //
  // `{permission}` is `perms.view_channel.label`, quoted so the article agrees
  // with *die Berechtigung* rather than with a value this sentence cannot see.
  // „sie“ at the end agrees with *eine Rolle*, a noun the sentence names itself.
  // The du-imperative „Erteile“ matches the catalogue's voice.
  'channel.perms.privateHintOn': 'Vor @everyone verborgen. Erteile unten einer Rolle die Berechtigung „{permission}“, um sie wieder hereinzulassen.',
  // `@everyone` untouched, as everywhere.
  //
  // The reassurance half, flat and absolute — not „sollte nichts gelöscht
  // werden“. German gets the emphasis from repeating the negation across both
  // verbs: nichts … und nichts.
  'channel.perms.privateHintOff': 'Nimmt @everyone die Sicht darauf. Nichts wird verschoben und nichts gelöscht.',
  'channel.perms.lockNote': 'Wird in der Kanalliste mit einem Schloss angezeigt.',

  'channel.perms.roleLabel': 'Rolle',
  // „je Rolle“ is the distributive German uses on labels and in pricing; „pro
  // Rolle“ would also be right and „je“ is the one that does not read as a rate.
  'channel.perms.roleHint': 'Überschreibungen gelten je Rolle.',
  // Named by the glyph, as in the English, because the glyphs are what is on
  // screen. „hier“ twice, carrying what English loads onto its two "here"s: both
  // the grant and the denial apply in this channel only. „unberührt lassen“ is
  // the German for leaving a setting alone without implying it was considered.
  'channel.perms.triStateHint': 'Der Haken erlaubt es hier, das Kreuz nimmt es hier weg, der Strich lässt die eigene Einstellung der Rolle unberührt.',

  // Short headings, deliberately not the `perms.group.*` noun phrases: those are
  // the role editor's and are full compounds (Textkanäle, Sprachkanäle) because
  // that screen spans a whole guild. Here the reader is already inside one
  // channel, so the heading says only which half of it is being configured.
  'channel.perms.group.general': 'Allgemein',
  'channel.perms.group.text': 'Text',
  // Chat and Text stay two words in German, because German has two and the
  // distinction is the point: the reader is looking at a voice room and needs to
  // be told these switches are about the typing in it.
  'channel.perms.group.chat': 'Chat',
  'channel.perms.group.voice': 'Sprache',

  // One word each where German has one. „Erben“ is the infinitive, matching the
  // other two, and means the absence of an overwrite rather than a third
  // opinion.
  'channel.perms.deny': 'Verweigern',
  'channel.perms.inherit': 'Erben',
  'channel.perms.allow': 'Erlauben',
  // Der Doppelpunkt ist weg, und damit ein Notbehelf, der hier drei Versionen
  // lang stand.
  //
  // `{choice}` war früher das fertige, großgeschriebene Wort aus den drei
  // Einträgen darüber („Verweigern“). Die englische Reihenfolge las sich damit
  // als „Verweigern Nachrichten senden“ — zwei Verben, die zusammenstoßen —,
  // und das natürliche „Nachrichten senden verweigern“ hätte ein
  // großgeschriebenes Wort mitten in den Satz gesetzt. Der Doppelpunkt war der
  // einzige Ausweg, der ohne Kasus, Artikel und Kongruenz auskam.
  //
  // Jetzt ist `{choice}` der Maschinen-Token (`deny`, `inherit`, `allow`), und
  // jeder Arm ist ein ganzer Satz. Deutsch kann also die Satzstellung nehmen,
  // die es ohnehin wollte: die Berechtigung zuerst, das Verb im Infinitiv ans
  // Ende, klein geschrieben, wie in jedem anderen deutschen Verbalsatz. Die
  // drei Wörter darüber bleiben großgeschrieben, weil sie als Tooltip allein
  // stehen. Der `other`-Arm ist unerreichbar und nennt nur die Berechtigung.
  'channel.perms.choiceLabel': '{choice, select, deny {{permission} verweigern} inherit {{permission} erben} allow {{permission} erlauben} other {{permission}}}',

  'channel.perms.saveFailed': 'Die Überschreibung konnte nicht gespeichert werden',
  // About the gesture the reader made, not about the mechanism. German fronts
  // the whole subordinate clause — „Wer das sehen darf“ — which is the subject,
  // and the passive follows; that is the idiomatic way to say this without
  // naming an agent.
  'channel.perms.privateFailed': 'Wer das sehen darf, konnte nicht geändert werden',

  // ==== bots

  // ------------------------------------------------------------- installing
  //
  // Consent copy throughout, and nothing in this block is softened. Where the
  // English says a permission is powerful, the German says mächtig; where it
  // says a server will not hand something back, the German says it does not give
  // it back, not that it might not.
  //
  // **Bot is translated, and the translation is „Bot“.** The English header is
  // emphatic that this is a common noun and must not be left as a name, and it
  // is right — but the German common noun for an account driven by a program
  // *is* der Bot. It is in Duden, it declines (des Bots, dem Bot, die Bots), it
  // compounds (Bot-Sitzung, Bot-Entwicklung) and it is what a German-speaking
  // guild says out loud. The alternatives are inventions: „Programmkonto“ names
  // the mechanism and nobody would recognise it, and „Roboter“ is a machine with
  // arms. So this is a translation whose output happens to be five of the same
  // letters, not an untranslated word — which is why it takes a German article
  // and a German plural everywhere below, and why `bots.list.badge` is a
  // separate judgement rather than a consequence of this one.

  'bots.install.title': 'Bot installieren',
  // `Telium` is the product and stays exactly as it is, in every language.
  //
  // Both load-bearing facts kept: the descriptor is *signed*, and nothing is
  // installed until the button is pressed. German turns "show exactly what it is
  // asking for" into a verb-final clause („was er verlangt“), which moves the
  // object ahead of the verb; „er“ agrees with *der Bot*, named earlier in the
  // same sentence.
  'bots.install.intro': 'Füge eine Anwendungsreferenz ein. Telium holt die signierte Anwendungsbeschreibung des Bots und zeigt genau, was er verlangt, bevor irgendetwas installiert wird.',
  'bots.install.referenceLabel': 'Anwendungsreferenz',
  // LEFT IN ENGLISH — `bots.example/01…` is the reserved documentation domain
  // and a ULID prefix. Localising either half would teach somebody to type a
  // reference that cannot resolve.
  'bots.install.referencePlaceholder': 'bots.example/01…',
  // The house style in this file does spell out both genders where a person is
  // meant (`errors.owner_only`: „die Inhaberin oder der Inhaber“;
  // `settings.language.hint`: „Übersetzerinnen und Übersetzer“), so the developer
  // is named the same way rather than defaulting to the masculine. It is longer
  // than the English and that is the correct trade.
  'bots.install.referenceHint': 'Füge die Referenz ein, die du von der Entwicklerin oder dem Entwickler des Bots kopiert hast.',
  // Matches `common.loading` („Wird geladen…“) in shape, so the two read as one
  // idiom. It sits in a narrow line under the field and cannot grow much; this
  // is as short as German gets without dropping the noun.
  'bots.install.loading': 'Anwendung wird geladen…',

  // The eyebrow over the origin, and blunt. „von Dritten“ is the German legal
  // and technical idiom for third-party and carries the distance the English
  // wants; „Drittanbieter-Anwendung“ would be one compound and would read as a
  // product category rather than as a warning about whose program this is.
  'bots.install.thirdParty': 'Anwendung von Dritten',
  // The distancing is the whole point. „Nennt sich selbst“ keeps it a claim by
  // the application rather than a fact about it — „Name“ as a label would have
  // quietly conceded the opposite. The `<name>` tag is preserved so the React
  // layer can draw the claimed name in the page's own ink; `{name}` inside it is
  // a remote string and is never touched.
  'bots.install.callsItself': 'Nennt sich selbst <name>{name}</name>',
  // The bare noun standing in for a missing name. Matches `bots.list.badge` and
  // `bots.install.submitUnnamed`, as the English comment requires.
  'bots.install.unnamed': 'Bot',
  // Not a refusal of this reader, so nothing here is about permission. „nimmt …
  // an“ is the same separable verb `errors.registration_closed` above uses for a
  // server that has closed its doors, which is deliberate: it is the same shape
  // of situation and should sound like it.
  'bots.install.closed': 'Diese Anwendung nimmt derzeit keine neuen Installationen an.',

  // **Ereignisabonnement**, and this is the fragment's biggest departure from the
  // English surface. The English header is explicit that the protocol meaning is
  // what gets translated and that a language with no natural noun should reach
  // for something closer to "event feed" or "subscription" rather than the
  // cognate. German has the cognate — *Intent* — and it is a trap: in German it
  // reads as intention, purpose, what somebody meant, which is exactly the
  // ordinary-language meaning the header forbids. „Absicht“ is worse for the
  // same reason.
  //
  // An Ereignisabonnement is literally a subscription to events, which is what
  // the thing is: one feed the bot asks to be sent. It compounds, it pluralises
  // (Ereignisabonnements), and a reader meeting it for the first time guesses
  // roughly right — which is the test the header sets for a coined term. It is
  // twenty-one characters against Intents' seven and sits over a narrow column,
  // and it is kept: the column heads wire constants that are shown untranslated,
  // so this heading is the only German word in that region of the screen and it
  // had better be the right one.
  'bots.install.intentsTitle': 'Ereignisabonnements',
  // „Ereignisarten“ here rather than repeating Ereignisabonnements — the English
  // says "event categories" in this sentence and "Intents" in the heading, and
  // German keeps the same two levels. „nimm den Haken … weg“ is the du-imperative
  // and matches the physical gesture; „deaktiviere“ would name the outcome and
  // not the control.
  'bots.install.intentsHint': 'Das sind die Ereignisarten, die der Bot anfordert. Sie sind zu Beginn eingeschaltet; nimm den Haken überall dort weg, wo dieser Server nichts preisgeben soll.',
  // „Gateway“ stays — see the untranslated list in the report.
  'bots.install.intentsEmpty': 'Dieser Bot fordert keine Gateway-Ereignisabonnements an.',
  'bots.install.permissionsTitle': 'Berechtigungen',
  // Not softened, and „mächtig“ is the word with weight — not „fortgeschritten“
  // and not „besonders“. The English comment says to use whatever word `perms.js`
  // marks those bits with; `perms.js` in fact marks none of them with any word
  // (see the report), so this fragment is the one that fixes it, and
  // `bots.capability.powerful` below uses the same stem.
  'bots.install.permissionsHint': 'Das sind die Berechtigungen, die die Entwicklung verlangt. Die mächtigen sind zu Beginn ausgeschaltet — setze nur dort einen Haken, wo der Bot es für seine Aufgabe braucht.',
  'bots.install.permissionsEmpty': 'Dieser Bot fordert keine Berechtigungen in dieser Gilde an.',
  // Both halves of the rule, because a reader told only the second half goes
  // looking for a setting to change. „selbst nicht“ carries English's "do not
  // hold ... yourself" and lands the emphasis on the reader, which is where the
  // explanation is.
  'bots.install.cannotGrant': 'Du hast diese Berechtigung hier selbst nicht, deshalb lässt dieser Server dich sie nicht weitergeben.',

  // Two keys and not one, because German does inflect after the verb and because
  // a quoted name and a bare common noun sit differently in the sentence.
  // `{name}` is remote data, so it is quoted and the infinitive goes last.
  'bots.install.submit': '„{name}“ installieren',
  'bots.install.submitUnnamed': 'Bot installieren',
  'bots.install.installing': 'Wird installiert…',

  // Lead-ins for an uncoded failure, joined by `errors.context`, so no full
  // stop. The passive with the object first is the same shape every other
  // failure key in this fragment uses.
  'bots.install.previewFailed': 'Der Bot konnte nicht geladen werden',
  'bots.install.failed': 'Der Bot konnte nicht installiert werden',

  // ------------------------------------------------------- what is installed

  'bots.list.title': 'Installierte Bots',
  // The standing warning, and the reassuring half — that reducing grants lands
  // on already-open sockets — must survive intact. German fronts the agent as a
  // wer-clause („Wer einen Bot entfernt“), which is how the language states a
  // general rule about whoever does a thing; the alternative, a subjectless
  // passive, would have made it unclear whether this describes the server's
  // behaviour or the reader's option. „Sockets“ is left in English: it is the
  // wire-level object an administrator recognises by that name, and German has
  // no noun for it that is not either a physical plug (Steckdose) or a
  // paraphrase of the very thing this sentence is being precise about.
  'bots.list.notice': 'Wer einen Bot entfernt, nimmt ihm sofort die Mitgliedschaft in der Gilde und beendet seine laufenden Bot-Sitzungen. Auch das Beschneiden seiner Freigaben wirkt sofort auf bereits offene Sockets, weil jede Zustellung die aktuelle Freigabe in der Gilde neu prüft.',
  'bots.list.empty': 'In dieser Gilde ist kein Bot installiert.',
  // The accessible name of the table. Without it the primitive announces its own
  // English default to every screen reader in every language.
  'bots.list.tableLabel': 'Installierte Bots',
  // Column headings over narrow columns. Bot is one syllable in German too;
  // Berechtigungen and Ereignisabonnements are not, and are kept.
  'bots.list.colBot': 'Bot',
  'bots.list.colPermissions': 'Berechtigungen',
  'bots.list.colIntents': 'Ereignisabonnements',
  // LEFT AS IT STANDS — „BOT“ is the badge every chat client draws in every
  // language and German is no exception: it is the established term here, it is
  // three characters in a pill that has room for about four, and it matches
  // `bots.install.unnamed` as the English comment requires. This is the one
  // place the English header flags for a second thought, and the second thought
  // lands in the same place: a German pill reading „PROGRAMM“ would be longer,
  // stranger and less recognisable than the shape people already read without
  // reading.
  'bots.list.badge': 'BOT',
  'bots.list.removeFailed': 'Der Bot konnte nicht entfernt werden',

  // ------------------------------------------- narrowing one that is already here
  //
  // About a bot running right now, in a guild full of people, whose edits land
  // on open sockets. „sofort“ is the load-bearing word in this block and it is
  // never weakened to „gleich“ or „in Kürze“.

  'bots.edit.heading': '„{name}“ bearbeiten',
  // Which half still works is the point of the sentence. „gefahrlos“ carries the
  // English "safely" without hedging it; „trotzdem“ keeps the concession that
  // the descriptor is missing and the reduction still works. „Zuhause“ for the
  // bot's home is the same everyday noun this catalogue uses in Heimserver, so
  // the two read as one metaphor.
  'bots.edit.offline': 'Das Zuhause des Bots war nicht erreichbar, deshalb werden nur seine aktuellen Freigaben angezeigt. Wegnehmen kannst du sie trotzdem gefahrlos; erweitern geht erst, wenn die Anwendungsbeschreibung neu geprüft werden kann.',
  // „Erteilt“ for granted, matching the verb this fragment uses for the act
  // throughout (`bots.edit.permissionsHint`, `bots.capability.withdrawnRemoved`).
  'bots.edit.intentsTitle': 'Erteilte Ereignisabonnements',
  'bots.edit.permissionsTitle': 'Erteilte Berechtigungen',
  // „Obergrenze“ is the word `errors.too_large` above already uses for a
  // server-side limit, and it is the right one here: the ceiling is the most a
  // developer has said this application may ever be given. Used again in
  // `bots.edit.permissionsHint` by implication, as the English asks.
  'bots.edit.ceilingLoading': 'Obergrenze der Anwendung wird geladen…',
  // „sofort“, exact rather than approximate. „datenschutzrechtlich heikel“ is
  // stronger than „sensibel“ and is the register a German privacy notice uses;
  // the semicolon is kept because the two clauses are one thought.
  'bots.edit.intentsHint': 'Nachrichteninhalt ist datenschutzrechtlich heikel; das Wegnehmen wirkt sofort.',
  // Two ceilings, one sentence, neither clause optional. German repeats the verb
  // („kann nie mehr erteilen“) across both halves, which is what keeps the
  // parallel audible; dropping the second verb would be grammatical and would
  // let a skimming reader take the two clauses as one.
  'bots.edit.permissionsHint': 'Ein Server kann nie mehr erteilen, als die Entwicklung angegeben hat, und du kannst nie mehr erteilen, als du selbst hast.',
  // „Freigaben“ and not „Änderungen“: the reader is saving a set of powers, and
  // Freigabe is the noun this namespace uses for what a bot has been given.
  'bots.edit.save': 'Freigaben speichern',
  'bots.edit.failed': 'Der Bot konnte nicht aktualisiert werden',

  // ------------------------------------------------ the capability checklist
  //
  // **Every label here names a category of events the bot will be *sent*, never
  // a thing the bot may *do*.** That is the one mistake in this block that
  // matters, and German makes it easy to commit: „Nachrichten“ on a checklist
  // row beside a tick box reads to a German eye as a permission — as *may send
  // messages* — because that is what a checklist of Berechtigungen looks like
  // two sections up on the very same screen. The defence is in the hints, which
  // are all built on *empfangen* (receive) with the events as the object, so
  // every row says plainly that something is being delivered to the bot rather
  // than licensed for it. Not one hint in this block uses dürfen or senden.
  //
  // The identifiers printed under each box — GUILD_MESSAGES, MESSAGE_CONTENT and
  // the rest — never appear in these strings and are never translated where they
  // do appear; see the report.

  // „Nachrichten“ is the bare noun, which is as neutral as German gets. The hint
  // under it is what does the work of saying these are events.
  'bots.intent.guild_messages.label': 'Nachrichten',
  // English's three noun-adjuncts ("message create, update and delete events")
  // cannot be stacked in German. Recast as a subordinate clause with the verbs
  // at the end — *wenn Nachrichten entstehen, geändert oder gelöscht werden* —
  // which is longer and is the only grammatical way to say it. „empfangen“
  // fronted, so the row begins with the receiving.
  'bots.intent.guild_messages.hint': 'Ereignisse empfangen, wenn Nachrichten entstehen, geändert oder gelöscht werden.',
  'bots.intent.guild_members.label': 'Mitglieder',
  // The colon introduces examples, not a definition, and German uses a colon
  // this way too, so it is kept. The three examples become three verb-final
  // clauses, which is German's own way of listing them.
  'bots.intent.guild_members.hint': 'Änderungen an der Mitgliedschaft der Gilde empfangen: wer beigetreten ist, wer gegangen ist, wer umbenannt wurde.',
  'bots.intent.guild_presences.label': 'Anwesenheit',
  // „von allen hier“ is English's "for everyone here" and it is not shortened
  // away: the scope is the whole guild, continuously, and that is the fact the
  // reader must finish the sentence holding.
  'bots.intent.guild_presences.hint': 'Online-Status und Änderungen der Anwesenheit von allen hier empfangen.',
  // „Tippen“ rather than „Schreiben“. `settings.messages.typing.label` above
  // says „Anzeigen, dass du schreibst“, so the catalogue is not yet of one mind
  // on this; Tippen is chosen here because as a bare noun „Schreiben“ means a
  // letter, and a one-word column label has no sentence around it to disambiguate.
  // Flagged in the report for reconciliation.
  'bots.intent.guild_typing.label': 'Tippen',
  'bots.intent.guild_typing.hint': 'Tippanzeigen empfangen.',
  // German pluralises the loanword as Emojis; Sticker is already a German noun
  // with a zero plural (die Sticker).
  'bots.intent.guild_expressions.label': 'Emojis und Sticker',
  'bots.intent.guild_expressions.hint': 'Änderungen an den Emojis und Stickern der Gilde empfangen.',
  // „Aufbau“ rather than „Struktur“ for structure, and the choice is made to
  // pair with `bots.intent.group.structure` below („Wie diese Gilde aufgebaut
  // ist“): heading and row then share a stem, which is what tells a reader the
  // row belongs to the heading. Struktur is the cognate and is the colder,
  // more abstract of the two words in German.
  'bots.intent.guild_structure.label': 'Aufbau der Gilde',
  'bots.intent.guild_structure.hint': 'Kanäle, Rollen und Änderungen am Aufbau sehen.',
  // „Sprachstatus“, invariant in the plural, because „Sprachzustände“ sounds
  // like a medical condition. It covers what the wire means: who is in which
  // voice channel and how they are muted.
  'bots.intent.guild_voice_states.label': 'Sprachstatus',
  // Recast as two indirect questions, which is how German says "membership and
  // state changes" without stacking nouns. „sein“ agrees with *der Status*.
  'bots.intent.guild_voice_states.hint': 'Empfangen, wer in einem Sprachkanal ist und wie sich sein Status ändert.',
  'bots.intent.message_content.label': 'Nachrichteninhalt',
  // The most consequential box on the screen, and both halves survive. „jeder
  // Nachricht, die er sehen kann“ keeps English's "every message it can see"
  // whole — it is not shortened to „von Nachrichten“ — and the contrast in the
  // second sentence is kept as a contrast, with „aber kein Wort von dem, was
  // darin stand“ carrying the whole weight of what unticking the box buys.
  // „er“ agrees with *ein Bot*, named in the second sentence.
  'bots.intent.message_content.hint': 'Den Text jeder Nachricht lesen, die er sehen kann. Ohne das erfährt ein Bot, dass es eine Nachricht gab, aber kein Wort von dem, was darin stand.',

  // Headings over the groups. Phrases, not nouns — they answer "what is this bot
  // being let in on?" and German answers it with the same indirect questions.
  'bots.intent.group.activity': 'Was hier passiert',
  'bots.intent.group.people': 'Wer hier ist',
  // Shares the *aufbauen* stem with `bots.intent.guild_structure.label`, as
  // noted there.
  'bots.intent.group.structure': 'Wie diese Gilde aufgebaut ist',
  // Short, because it sits above a row that already says at length what the risk
  // is. „Privilegiert“ is a German adjective in ordinary use and is the right
  // register: it says special access, not special quality.
  'bots.intent.group.privileged': 'Privilegiert',

  // The rest of the control, shared by the intent and the permission drawing.

  // A statement about the client's ignorance, not about the capability. „Von
  // diesem Client nicht beschrieben“ keeps that reading; „Unbekannt“ (which
  // `common.unknown` above already spends) would say the capability is suspect
  // and is exactly the sentence the English comment rules out. „Client“ is the
  // German word for the program in this sense and needs no replacement.
  'bots.capability.unknownGroup': 'Von diesem Client nicht beschrieben',
  // **Fähigkeit** for capability, kept apart from Berechtigung on purpose: this
  // row may hold either an intent or a permission bit the client has never heard
  // of, so the noun has to be the general one. Calling it a Berechtigung here
  // would assert something the client explicitly does not know.
  //
  // `{capability}` is a machine identifier and is moved but never touched — no
  // translation, no transliteration, no inserted space, no hyphenation. It is
  // placed before the comma so a line break cannot land inside it. „Sie bleibt“
  // agrees with *die Fähigkeit*, the noun this sentence supplies itself, and the
  // promise stays a promise rather than an apology.
  'bots.capability.unknown.hint': 'Dieser Server kennt die Fähigkeit {capability}, dieser Client nicht. Sie bleibt genau so, wie sie ist.',
  // The fallback that has to work for both intents and permissions, so it names
  // nothing. „angefordert“ matches the verb the two specific empty states use.
  'bots.capability.emptyDefault': 'Nichts angefordert.',
  // A warning, so it needs a word with weight: „mächtig“, not „fortgeschritten“
  // and not „besonders“. Lowercase, because German adjectives are lowercase and
  // because this is a tag inside a line of a form rather than a heading — which
  // is the convention the English comment asks each language to follow in its
  // own way. Same stem as „Die mächtigen“ in `bots.install.permissionsHint`.
  'bots.capability.powerful': 'mächtig',
  // About the developer's offer having been withdrawn, not about the grant
  // having lapsed. „nicht mehr angeboten“ says exactly that and nothing more.
  'bots.capability.withdrawnBadge': 'nicht mehr angeboten',
  // Every clause load-bearing, and the last one flat: „gibt es nicht wieder
  // her“ is a statement about what this server does, not a prediction about what
  // it might do. „es“ throughout agrees with *das* — the withdrawn capability
  // referred to neutrally — which sidesteps having to decide whether the thing
  // in question is eine Berechtigung or ein Ereignisabonnement, since this row
  // is drawn for both.
  'bots.capability.withdrawnHeld': 'Die Entwicklung hat das aus der Anwendung zurückgezogen. Der Bot hat es weiterhin, und du kannst es ihm wegnehmen — aber dieser Server gibt es nicht wieder her.',
  // Two short sentences, as in the English, because it confirms a decision that
  // cannot be undone and a reader skimming one long sentence can miss the second
  // half. „kann nicht erneut erteilt werden“ is absolute; „kann vielleicht
  // nicht“ would be the softening the comment forbids.
  'bots.capability.withdrawnRemoved': 'Von der Entwicklung zurückgezogen und jetzt entfernt. Es kann nicht erneut erteilt werden.',

// ===========================================================================
  // Deutsch: chat — the message view, and the words all 270 keys share
  // ===========================================================================
  //
  // This is the namespace a reader spends the day inside, which changes what a
  // wrong word costs here: a mistranslated button in the guild settings is met
  // once a month by a moderator, and a mistranslated word on a message row is
  // met every few seconds by everybody. So the vocabulary is settled once, in
  // this block, and no entry below re-argues it. Where an entry does carry a
  // comment, it is because that line made a judgement this block could not
  // make for it — a placeholder that moved, a gender that could not be known,
  // a compound that will not fit the control it sits on and was kept anyway.
  //
  //   message            → **Nachricht** (die). Never *Message*, never *Msg*.
  //   conversation       → **Unterhaltung** (die), and this is the one real
  //                        departure from the obvious word. German would say
  //                        *Gespräch*, but `guild.voice.*` above has already
  //                        spent *Gespräch* on a voice call („bevor ein Gespräch
  //                        zustande kommt“), and this file's own header explains
  //                        at length why one word meaning two things — the
  //                        „Server“ problem — is unusable in a namespace where
  //                        both meanings turn up in one sentence. A DM room and
  //                        a voice call are exactly that pair, so the DM room
  //                        gets its own noun and keeps it in all sixteen places.
  //   history, timeline  → **Verlauf** (der). The stream of what was said. Not
  //                        *Chronik* (that is a Facebook noun) and not
  //                        *Zeitachse* (that is a Gantt chart).
  //   thread             → **Thread** (der). Fixed by the roles/channel glossary
  //                        above; declined German, in Duden, and nobody under
  //                        sixty says *Diskussionsfaden*.
  //   reply              → **Antwort** (die) / **antworten**. The noun for the
  //                        quoted strip, the verb for the action on a row.
  //   quote              → **Zitat** (das) / **zitieren**.
  //   forward (verb)     → **weiterleiten**. English "forward" is a verb in
  //                        `chat.forward.title` and a noun nowhere in this file,
  //                        which is the ambiguity resolved: every key in the
  //                        family describes the act, so German uses the verb
  //                        throughout and never coins *die Weiterleitung*.
  //   share              → **teilen**, and likewise the act and not the link:
  //                        `chat.forward.shareTitle` is the operating system
  //                        handing this app something, which German phrases from
  //                        the sender's side („Mit Telium teilen“) the way every
  //                        Android and iOS share sheet already does.
  //   reaction / react   → **Reaktion** (die) / **reagieren**. Not *Emoji-Reaktion*:
  //                        a reaction can be a custom upload or a sticker, and the
  //                        longer compound would be narrower than the truth.
  //   attachment         → **Anhang** (der). Already the word `guild.overview.expiry.hint`
  //                        uses above („die längste Lebensdauer, die ein Anhang …
  //                        haben darf“), so it is not reopened here.
  //   upload             → **hochladen** for the act, **Upload** (der) for the
  //                        thing and for the compound *Upload-Host*. The loanword
  //                        is in the guild glossary's permitted set and is what
  //                        every German hosting provider prints on its own page.
  //   edit               → **bearbeiten**. German uses the same verb for a
  //                        settings form and for your own sentence, so the two
  //                        keys the English file keeps apart (`common.edit` and
  //                        `chat.message.actions.edit`) land on one German word.
  //                        They still stay two keys: the reason the English gives
  //                        is that *some* language needs the distinction, and a
  //                        merge here would take that option away from French and
  //                        Japanese, who are translating the same file.
  //   delivery           → **Zustellung** (die); sent/delivered/read →
  //                        **gesendet / zugestellt / gelesen**. These are the
  //                        words German postal and messaging apps use in that
  //                        order, and the ladder only reads as a ladder if all
  //                        three come from the same register.
  //   delivery receipt   → **Empfangsbestätigung** (die); read receipt →
  //                        **Lesebestätigung** (die). `chat.delivery.receiptsHint`
  //                        needs the word that covers both and takes the first.
  //   verify             → **verifizieren**; approve (a device) → **freigeben**.
  //                        Two different acts in the encryption copy and they
  //                        must not collapse: you verify a *person's* key and you
  //                        approve a *device*. *Verifizieren* is what Element and
  //                        every other German E2EE client calls the first, so a
  //                        reader arrives already knowing it.
  //   vault / locked     → **Tresor** (der) / **verschlossen**, opened with
  //                        **aufschließen**. Deliberately not *gesperrt/entsperrt*:
  //                        the guild glossary has committed *Sperre / sperren /
  //                        entsperren* to bans, and „deine Nachrichten sind
  //                        gesperrt“ would read, in a client that also bans
  //                        people, like a moderator did something to you.
  //   keyring            → **Schlüsselbund** (der).
  //   history mirror     → **Verlaufsspiegel** (der). A coinage, and defensible:
  //                        the thing is a server-side encrypted copy of the
  //                        Verlauf, the English is itself a coinage, and a
  //                        descriptive paraphrase („gespiegelte Kopie deines
  //                        Verlaufs“) would have to be repeated in six paragraphs
  //                        and would stop being the same noun each time.
  //   sticker, emoji     → **Sticker** (der), **Emoji** (das). Loanwords in the
  //                        guild glossary's permitted set, both in Duden.
  //   moderators         → **Moderierende**, the participle form this file
  //                        already uses in the guild fragment.
  //   timed out          → **stummgeschaltet**, fixed by `errors.timed_out` above.
  //
  // Two families are inherited rather than decided here. Every English
  // "Could not X" — and this namespace has fourteen of them — becomes
  // „… ließ sich nicht …“, the construction the guild fragment argued for at
  // length: it names the thing that failed, does not claim why, and has a
  // subject, which „Konnte nicht …“ does not. Where English drops the subject
  // („Could not forward“) German has to supply one, because a German sentence
  // without a subject is a command.
  //
  // And every plural keeps both arms German has, `one` and `other`, even where
  // the two read identically — `chat.encryption.chip.unverified` is the case
  // English flagged, and German has the same non-agreement English does there.
  // The arms are what `Intl.PluralRules` asks for, not what the sentence needs.
  //
  // **An unknown gender never gets an article or an adjective ending.** `{name}`,
  // `{guild}`, `{file}`, `{provider}`, `{host}`, `{title}`, `{label}`, `{target}`
  // and `{tone}` are all data. Three devices keep those sentences grammatical,
  // and each one is pointed at below where it is used: a bare accusative with no
  // article („{name} entfernen“), a participle with no ending („{name} gespeichert.“),
  // and a `von`/`aus`-phrase that names the relation instead of agreeing with it
  // („Vorschau von {name}“, „Emoji aus {guild}“). The German quotation marks
  // „ “ do the same job for a quoted value, and they are also why nothing in
  // this fragment ever puts a stand-in inside angle brackets: `<…>` around an
  // ASCII word is markup to `format.js` and would delete the word silently.
  //
  // **Buttons take the infinitive, headings and chips take a noun phrase.**
  // Same rule as the guild fragment, and this namespace has more pairs of it
  // than any other: `chat.staged.rename` is „Umbenennen“ on a button and
  // `chat.staged.renameTitle` is „Datei umbenennen“ as a dialog heading.
  //
  // Nothing has been shortened to fit, and in this namespace that is a promise
  // with teeth, because English wrote most of it for a gutter or a pill. The
  // per-entry comments say which controls are in danger. `i18n-layout.test.jsx`
  // exists to catch them; a translation that trims itself hides the defect in a
  // language the people who built the row cannot read.

  // ------------------------------------------------------------- the timeline

  // „Noch nichts hier“ rather than „Hier ist noch nichts“, because the heading
  // is a caption and not a sentence, and German drops the copula in a caption
  // exactly as readily as English does. The body keeps the nudge the English
  // comment insists on: „Sag etwas.“ is an invitation in the du-form of this
  // whole catalogue, where „Schreib die erste Nachricht“ would be homework.
  'chat.timeline.empty.title': 'Noch nichts hier',
  'chat.timeline.empty.body': 'Noch keine Nachrichten. Sag etwas.',

  // German turns the English gerund into a passive, which is what this catalogue
  // already does for every other in-flight state („Wird geladen…“, „Wird
  // gespeichert…“ in `common`). It is also longer than the English by a third
  // and sits in a one-line strip at the head of the room; the strip is full
  // width, so this is one of the few places the length costs nothing.
  'chat.timeline.loadingOlder': 'Ältere Nachrichten werden geladen…',
  // Phrased as what the reader does, not as what is up there — the English note
  // is right that a label naming a thing sends people hunting for a button. The
  // du-imperative („Scroll“) keeps it an instruction to a person rather than a
  // description of a mechanism.
  'chat.timeline.scrollForOlder': 'Scroll nach oben für ältere Nachrichten.',

  // The round button on a phone, and the accessible name nobody sees. „Ende“
  // would be the short German word and is avoided on purpose: it is the end of
  // the *stream*, and a blind reader hearing „ans Ende springen“ in a room that
  // is still loading older messages has no way to tell which end. Naming the
  // newest messages says which end without naming a direction, and costs four
  // words German would rather have spent on one compound.
  'chat.timeline.jumpToBottom': 'Zu den neuesten Nachrichten springen',

  // One word on a pill, upper-cased by the stylesheet. German has no shorter
  // word for this and needs none.
  'chat.timeline.unreadMarker': 'Neu',

  // The three context phrases, in the „… ließ sich nicht …“ family. Each names
  // its own subject, which is what keeps the three distinguishable after
  // `errors.context` has glued the server's sentence onto the end: „Ältere
  // Nachrichten ließen sich nicht laden: …“ answers a different question from
  // „Der Verlauf ließ sich nicht laden: …“, and that difference is the entire
  // reason English split them three ways.
  'chat.timeline.loadOlderFailed': 'Ältere Nachrichten ließen sich nicht laden',
  'chat.timeline.loadHistoryFailed': 'Der Verlauf ließ sich nicht laden',
  'chat.timeline.jumpFailed': 'Diese Nachricht ließ sich nicht laden',

  // Deliberately the same construction as `errors.status.404` above („Das gibt
  // es nicht mehr.“), because it is the same fact said about a message instead
  // of about a URL. „nicht mehr“ carries the whole of English's „any more“ —
  // it says the link was once good — and it is one word, so nothing here is
  // under pressure to drop it.
  'chat.timeline.messageGone': 'Diese Nachricht gibt es nicht mehr.',

  // -------------------------------------------------------------- the message

  // One key, two readings, as the English comment explains: the avatar is
  // announced with the display name and the tooltip carries `@user:host`.
  // German puts the possessor behind the noun with `von`, which is what keeps
  // this grammatical for both — „Profil von Anna öffnen“ and „Profil von
  // @anna:example.org öffnen“ — where the genitive („Annas Profil“) would have
  // needed an `s` glued onto data and would produce nonsense on the second
  // reading. The verb lands last, so `{name}` sits in the middle of the
  // sentence rather than at its end.
  'chat.message.openProfile': 'Profil von {name} öffnen',

  // The slot where the timestamp will be, in the passive this catalogue uses
  // for every in-flight state. Longer than „Sendet…“ and chosen anyway: the
  // active form would say the *reader* is sending, and it is the message that
  // is on its way.
  'chat.message.sending': 'Wird gesendet…',

  // Participle without an auxiliary, the way a German status line writes one.
  // It does not say who deleted it, for the reason the English gives — the row
  // does not know — and German makes that easier, because a passive participle
  // needs no agent at all.
  'chat.message.deleted': 'Nachricht gelöscht',

  // Security copy: names the fact, softens nothing. „für einen Schlüssel, den
  // dieses Gerät nicht hat“ keeps the two halves English keeps — it is about a
  // key, not about a permission — and the relative clause is where German has
  // to put it, which pushes the sentence eleven characters past the English.
  // It is drawn in place of the message body, so it has the width of a message.
  'chat.message.unreadable': 'Verschlüsselt für einen Schlüssel, den dieses Gerät nicht hat',

  // Lower case in English because it is an aside inside somebody else's
  // sentence; German keeps it lower case too, because it is a participle and
  // not a noun, so the capitalisation rule this catalogue's header mentions
  // does not reach it.
  'chat.message.edited': '(bearbeitet)',

  // The three glyph buttons, as tooltips and accessible names. Infinitives,
  // because they name acts; `common.a11y.*`'s rule about never saying „Schalt-
  // fläche“ applies unchanged.
  'chat.message.actions.react': 'Reagieren',
  'chat.message.actions.reply': 'Antworten',
  // Identical to `common.edit` in German, and still worth its own key: see the
  // glossary block above. If a later translator decides that correcting your
  // own words wants „Korrigieren“, this is the key that lets them.
  'chat.message.actions.edit': 'Bearbeiten',

  // Context phrases again, and both need a subject German can inflect. English
  // can say „Reaction failed“ with no article; German cannot, and „Reaktion
  // fehlgeschlagen“ is the machine-protocol register this catalogue's error
  // family was written to avoid.
  'chat.message.reactionFailed': 'Die Reaktion ließ sich nicht hinzufügen',
  'chat.message.editFailed': 'Die Änderung ließ sich nicht speichern',

  // The lead on a quoted line whose message is not in hand. English keeps it
  // lower case so it does not read as a system notice; German can only keep
  // that for the first word, since „Antwort“ is a noun and is capitalised
  // whatever happens — so the fragment starts on „als“, which is lower case,
  // does the same job, and makes the whole thing read as the reply's own header
  // rather than as a sentence about it.
  'chat.message.quotedOlder': 'als Antwort auf eine ältere Nachricht',

  // „beantwortet“ rather than „ursprünglich“: the English comment is explicit
  // that this goes one step up and not to the original, and German's past
  // participle as an attributive adjective („die beantwortete Nachricht“) says
  // exactly one step.
  'chat.message.jumpToQuoted': 'Zur beantworteten Nachricht springen',

  // The same „gibt es nicht mehr“ as the timeline's, with the relationship
  // named, which is what makes it follow from having pressed a quote. German
  // puts the relative clause between the subject and the verb, so the sentence
  // reads as one thing about one message rather than as two clauses.
  'chat.message.replyGone': 'Die Nachricht, auf die das antwortet, gibt es nicht mehr.',

  // The heading over the edit box is a noun phrase; the hint under it names two
  // keycaps. „Enter“ and „Esc“ are left exactly as they are: they are the
  // legends printed on a German keyboard, and a reader told to press „Eingabe“
  // or „Flucht“ would be hunting for a key that does not exist on the hardware
  // in front of them. What survives the translation is that both halves are
  // named — the escape half matters more to somebody who opened this box by
  // accident, and it is the half that gets cut for width.
  'chat.message.editBox.label': 'Nachricht bearbeiten',
  'chat.message.editBox.hint': 'Enter zum <save>Speichern</save>, Esc zum <cancel>Abbrechen</cancel>',

  // The thread pill. Both arms, `#` through the number formatter so a German
  // reader gets a German thousands separator on the day a thread has 1.200
  // messages in it.
  'chat.message.thread.count': '{count, plural, one {# Nachricht} other {# Nachrichten}}',

  // ----------------------------------------------------------------- delivery

  // The three states, as the dialog's title, plus the one for a state this
  // build has not met. German has a settled ladder for this and it is worth
  // using whole: „gesendet“ is what left this device, „zugestellt“ is what
  // arrived, „gelesen“ is what somebody opened. Every German messenger a reader
  // has used prints those three in that order, so the ladder needs no
  // explaining. The fallback is the noun, because it is the only thing that can
  // be said honestly when the state is unknown — it names the subject rather
  // than guessing at a rung.
  'chat.delivery.title.sent': 'Gesendet',
  'chat.delivery.title.delivered': 'Zugestellt',
  'chat.delivery.title.read': 'Gelesen',
  'chat.delivery.title.fallback': 'Zustellung',

  // The line under the title. „Alle anderen“ is the group minus you and carries
  // the exclusion English's "Everybody else" carries; a reader counting heads
  // against the list would otherwise be one out.
  //
  // „sie“ is the message, and it is the one pronoun in this fragment that
  // refers to a noun the sentence does not contain. That is safe here and only
  // here: the dialog is titled with a delivery state and drawn over one message,
  // and „die Nachricht“ is feminine, so there is exactly one thing „sie“ can be.
  // The alternative („Alle anderen haben die Nachricht.“) repeats a noun the
  // heading already said twice.
  'chat.delivery.subtitle.delivered': 'Alle anderen haben sie.',
  'chat.delivery.subtitle.read': 'Alle anderen haben sie gelesen.',
  // „Ein Teil der Gruppe“ rather than „Einige“: English's "some of the group"
  // is doing the work of not being a claim about the rest, and a bare „Einige
  // haben sie“ in German starts to sound like the others refused.
  'chat.delivery.subtitle.some': 'Ein Teil der Gruppe hat sie.',
  // „Bestätigungen“ and not „Empfangsbestätigungen“: the shorter noun is what
  // fits the line, and the full compound is spelled out two entries below in
  // `receiptsHint`, which is drawn under every state of this dialog including
  // this one. The reader meets both on the same screen.
  'chat.delivery.subtitle.none': 'Noch keine Bestätigungen.',

  // Three arms, and the `=0` one is a different sentence in German too — it
  // describes the record („Gerät nicht genannt“, an older client's account-level
  // watermark) where the other two describe devices. „auf“ governs the dative,
  // which is why the plural arm says „Geräten“ and not „Geräte“: this is the
  // kind of thing a `${n} devices` concatenation could never have got right,
  // and it is exactly why the key is a plural rather than a template.
  //
  // English keeps all three lower case because they sit after a name on one
  // row. German capitalises „Gerät“ and „Geräten“ regardless — that is the
  // orthography, not a decision — and the row still reads as one line because
  // the preposition in front of it is lower case.
  'chat.delivery.devices': '{count, plural, =0 {Gerät nicht genannt} one {auf # Gerät} other {auf # Geräten}}',

  // The mark on a row for somebody who opened it. A participle, so it stays
  // lower case and reads as part of the row.
  'chat.delivery.read': 'gelesen',

  // A state of the list, not a claim about people. „Noch nichts.“ keeps the
  // „noch“ that says this may yet change, which is the whole difference between
  // this and an absence claim.
  'chat.delivery.empty': 'Noch nichts.',

  // The sentence that stops the list being read as a census, and the reason the
  // dialog can be honest at all. German fronts the relative clause („Wer …“),
  // which puts the condition first and the consequence last — the natural order
  // for a rule in German, and it keeps „Empfangsbestätigungen“, all twenty-two
  // letters of it, away from the line break at the end.
  'chat.delivery.receiptsHint': 'Wer Empfangsbestätigungen abgeschaltet hat, erscheint hier nicht.',

  // ------------------------------------------------------------------ the quote

  // `<quoted/>` is an element, not a value: the quoted message is rendered
  // markdown with custom emoji in it. Moved nowhere, renamed never, nothing put
  // inside it. German keeps the colon exactly where English has it, because a
  // name followed by a colon followed by speech is the same convention in both.
  'chat.quote.line': '{name}: <quoted/>',

  // The composer's reply strip. „Antwort an {name}“ rather than „Antwortet auf
  // {name}“: the strip is a label on the box you are typing in, so the noun
  // reads as a header where the finite verb would read as a report about
  // somebody else. „an“ takes the accusative here and needs no article, which
  // is what keeps an unknown-gender display name out of trouble.
  'chat.quote.replyingTo': 'Antwort an {name}: <quoted/>',

  // What stands where the words would have been. A noun, because the line is
  // already attributed, and capitalised because German capitalises nouns even
  // in a slot English keeps lower case.
  'chat.quote.attachment': 'Anhang',

  // ------------------------------------------------------- the ephemeral reply

  // The label on a message only this reader can see. The English refuses the
  // protocol's word („ephemeral“) and says the two facts instead; German refuses
  // it twice over, because „ephemer“ is a word out of a literature seminar and
  // „flüchtig“ would sound like the message is unreliable rather than unsaved.
  // Both halves are load-bearing and neither is dropped: „Nur du siehst das“ is
  // the privacy fact, „es wird nicht gespeichert“ is the durability fact, and
  // the card wraps rather than the sentence shrinking. The em dash with spaces
  // is German punctuation as well as English here — a Gedankenstrich is set
  // exactly this way.
  'chat.ephemeral.mark': 'Nur du siehst das — es wird nicht gespeichert',

  // Not `common.dismiss`, which this catalogue translates as „Ausblenden“ — the
  // word for hiding a notice that will come back. This button destroys the only
  // copy of a message that exists anywhere, because no server holds it, so
  // German takes the stronger verb it happens to have available: „Verwerfen“ is
  // what you do to a draft you are not keeping, and it does not promise a
  // return. This is precisely the split the English comment predicted a language
  // might have and English does not.
  'chat.ephemeral.dismiss': 'Verwerfen',

  // -------------------------------------------------------------- the encryption

  // `en/security.js`'s three rules hold here, and the third one decides most of
  // this section: do not translate what is on the other person's screen, and do
  // not translate what is not a word.
  //
  // Left in English, every occurrence, deliberately:
  //
  //   * **MLS** and **OPAQUE** — published protocols. Somebody checking what
  //     this client claims searches for those letters; a translation would name
  //     a different protocol and a transliteration would name nothing. „MLS-
  //     Frames“ hyphenates the initialism into the German compound, which is
  //     what German does with an initialism and is not a translation of it.
  //   * **Key Schedule** in `syncFailed.body` — the name of a construction in
  //     the MLS specification. „Schlüsselfahrplan“ is a word I could write and
  //     nobody could look up.
  //   * **Encryption key** — no longer written out here at all. The pane's
  //     title is `settings.nav.recovery` now, and the four sentences below
  //     take it as `{pane}`. That closes the hole this bullet used to describe:
  //     the title was a hardcoded label in
  //     `views/user-settings/UserSettings.jsx`, there was nothing in the
  //     catalogue for a German sentence to agree with, and so the sentences
  //     quoted the English label because that is what the pane said on a German
  //     screen. It still says that, because `settings.nav.recovery` is not
  //     translated here yet — and deliberately so: the other sixteen rows of
  //     that settings list are still English literals, and one German row in an
  //     English list is worse than none. The moment somebody translates that
  //     one entry, all four sentences below follow it with no edit here, which
  //     is the entire point of the placeholder. Do not put a German word in
  //     `{pane}`'s place, and do not put the label back.
  //
  //     Two small gains that come with it: the interpolation is bidi-isolated
  //     by `format.js`, so the Latin run inside a German sentence can no longer
  //     drag the punctuation after it around; and „Einstellungen“ stays
  //     translated, because `common.settings` above already says the app's
  //     settings are Einstellungen.
  //   * **Telium** and **Client** — a product name and a loanword.
  //   * `{names}` in `startOver.partial` — a list already joined by
  //     `Intl.ListFormat` in German. Data: moved, never touched, and no comma or
  //     „und“ added around it.
  //
  // And the rule from `security.js` that overrides house style: a warning is
  // never softened and never invented. Three of the paragraphs below say that
  // somebody other than the intended reader can read the messages. That is the
  // point of those sentences and they stay in the indicative — „kann mitlesen“,
  // not „könnte unter Umständen mitlesen“.

  // The relay sentence is written out in each of the five, exactly as English
  // writes it out, so that a German paragraph can order its own clauses. German
  // gets one gift here English does not have: „wer wann mit wem spricht“ folds
  // "who is talking to whom, and when" into four words with no repetition, and
  // the interrogatives decline, so the roles stay unambiguous.
  'chat.encryption.custody.unknown': 'Nachrichten sind hier MLS-Frames. Dein Heimserver leitet sie weiter und sieht dabei immer, wer wann mit wem spricht.',
  // „servergestützt“ is one compound where English needs three words, and the
  // sentence still runs longer than the English because „Wiederherstellung für
  // Direktnachrichten“ cannot be shortened without losing which messages are
  // meant. „die Betreiber“ is plural and genderless on purpose: English's "the
  // operator" is one company, and German's singular would have forced a choice
  // between „der Betreiber“ and „die Betreiberin“ about a party this sentence
  // knows nothing about.
  'chat.encryption.custody.escrowed': 'Nachrichten sind hier MLS-Frames. Dein Heimserver leitet sie weiter und sieht dabei immer, wer wann mit wem spricht. Dieses Konto nutzt noch die alte, servergestützte Wiederherstellung für Direktnachrichten: Dein Heimserver hält einen Schlüssel, der den Wiederherstellungstresor und den Verlaufsspiegel öffnet, die Betreiber können diese Nachrichten also mitlesen. Verschieb die Wiederherstellung unter Einstellungen → {pane} auf deine vertrauten Geräte.',
  'chat.encryption.custody.opaque': 'Nachrichten sind hier MLS-Frames. Dein Heimserver leitet sie weiter und sieht dabei immer, wer wann mit wem spricht. Dein Telium-Passwort stellt verschlüsselte Direktnachrichten über OPAQUE wieder her. Das Passwort geht nie an deinen Heimserver, und nur dein Client bekommt den Schlüssel zum Tresor und zum Verlaufsspiegel.',
  'chat.encryption.custody.device': 'Nachrichten sind hier MLS-Frames. Dein Heimserver leitet sie weiter und sieht dabei immer, wer wann mit wem spricht. Deine Wiederherstellungsschlüssel für Direktnachrichten liegen auf Geräten, die du freigibst. Dein Heimserver speichert den verschlüsselten Verlaufsspiegel, hat aber keinen Schlüssel, der ihn öffnet.',
  // „Keines von beidem“ carries English's "Neither" across a sentence boundary,
  // which German can do because the pronoun declines and points back at two
  // named things (die Schlüssel, die Passphrase) without repeating either.
  'chat.encryption.custody.self': 'Nachrichten sind hier MLS-Frames. Dein Heimserver leitet sie weiter und sieht dabei immer, wer wann mit wem spricht. Deine vertrauten Geräte halten die Schlüssel für deine Direktnachrichten, und eine eigene Wiederherstellungs-Passphrase kann sie zurückholen, wenn alle Geräte verloren gehen. Keines von beidem geht je an deinen Heimserver.',

  // Word for word the second half of `custody.escrowed`, as English is word for
  // word its own second half. The reader may well see both, and two different
  // German accounts of one arrangement would read as two arrangements.
  'chat.encryption.escrowedNote': 'Dieses Konto nutzt noch die alte, servergestützte Wiederherstellung für Direktnachrichten: Dein Heimserver hält einen Schlüssel, der den Wiederherstellungstresor und den Verlaufsspiegel öffnet, die Betreiber können diese Nachrichten also mitlesen. Verschieb die Wiederherstellung unter Einstellungen → {pane} auf deine vertrauten Geräte.',

  // Why the history above is closed. The second clause is the one that stops
  // this reading as a fault, and German keeps it in the present indicative:
  // „MLS gibt alte Nachrichten nicht an ein neues Gerät weiter“ is a statement
  // about how the protocol works, where a subjunctive or a „leider“ would turn
  // forward secrecy into an apology for a bug. The hyphen in
  // „Wiederherstellungs-Schlüsselbund“ is Duden's Gliederungsbindestrich for a
  // three-noun compound, not a flinch at the width: the unhyphenated form is
  // thirty-one letters and readers parse it twice.
  'chat.encryption.notYetReadable': 'Der frühere Verlauf lässt sich auf diesem Gerät nicht lesen. Der Verlaufsspiegel kommt mit deinem Wiederherstellungs-Schlüsselbund zurück; MLS gibt alte Nachrichten nicht an ein neues Gerät weiter.',

  // --------------------------------------------------------- the header chip

  // Four pills beside a channel name on a phone, and German loses this fight on
  // three of them. „Schlüssel geändert“ is two words for English's two and fits.
  // „Server kann mitlesen“ is three words and eighteen characters against
  // English's fifteen, and it is kept because „mitlesen“ is the exact verb — it
  // says somebody is reading along with you, which is what escrow means and what
  // „lesbar“ would leave vague. „Ende-zu-Ende“ is the established German
  // spelling, hyphens and all, and is two characters longer than the English.
  // None of them is abbreviated to fit; the pill is what has to give.
  'chat.encryption.chip.keyChanged': 'Schlüssel geändert',
  'chat.encryption.chip.serverCanRead': 'Server kann mitlesen',
  'chat.encryption.chip.endToEnd': 'Ende-zu-Ende',
  'chat.encryption.chip.encrypted': 'Verschlüsselt',

  // Both arms read the same in German for the same reason they do in English:
  // the participle is predicative here, so it takes no ending and does not
  // agree with the number. The arms exist because `Intl.PluralRules` says
  // German has two, not because this sentence needs two.
  'chat.encryption.chip.unverified': '{count, plural, one {# nicht verifiziert} other {# nicht verifiziert}}',

  // The accessible name of the chip: not the visible word, not the tooltip
  // paragraph, but what pressing it does. German puts the topic behind the
  // noun with „zur“, which reads as a heading; „Verschlüsselungsdetails“ would
  // be one word and would read as a menu item in a developer tool.
  'chat.encryption.chip.open': 'Details zur Verschlüsselung',

  // The chip's tooltip: the banner's two sentences as one string, because a
  // `title` attribute is one string. „Identitätsdiebstahl“ is the German word a
  // reader already owns for somebody pretending to be somebody else; the
  // literal „Identitätsvortäuschung“ is a legal term nobody says. Both readings
  // stay in the order of likelihood and neither is chosen between.
  'chat.encryption.chip.keyChangedTooltip': 'Jemand hier verwendet einen anderen Kontoschlüssel. So sieht ein zurückgesetzter Schlüssel aus, und so sieht auch ein Identitätsdiebstahl aus. Verifiziere die Person noch einmal, bevor du darauf vertraust.',

  // ------------------------------------------------------------- the banners

  // Each is a headline that has to be read and a line that only has to be
  // there, and the two stack. German rebalances one pair (see `awaiting` below)
  // and leaves the rest where English put them; what does not change is that
  // every `.title` is a complete claim on its own, because either half may be
  // read alone.

  // The engine did not come up. „steht nicht zur Verfügung“ rather than „ist
  // nicht verfügbar“: the second is the calque and reads like a server status
  // page, the first is what a German sentence says about a thing a person
  // wanted to use. The body names the one cause a reader can fix in ten
  // seconds, and „ein normales Fenster funktioniert“ keeps English's flat
  // promise rather than turning into an instruction.
  'chat.encryption.unavailable.title': 'Die Verschlüsselung steht auf diesem Gerät nicht zur Verfügung.',
  'chat.encryption.unavailable.body': 'Der private Modus blockiert den lokalen Schlüsselspeicher; in einem normalen Fenster geht es.',

  // This device holds no group and could not let itself in. „um Einlass
  // gebeten“ is the phrase German uses for asking to be let into a room, and it
  // keeps the metaphor the whole encryption section runs on — a conversation is
  // a room and a device is either inside it or outside. The body deliberately
  // includes the reader's own other devices („auch eines deiner eigenen“),
  // because that is the half a reader who thinks only other people can help
  // will otherwise miss, and they will wait instead of opening their laptop.
  'chat.encryption.awaiting.title': 'Dieses Gerät kann hier noch nicht senden.',
  'chat.encryption.awaiting.body': 'Es hat um Einlass gebeten; das klappt, sobald ein Gerät, das schon in der Unterhaltung ist, sie öffnet — auch eines deiner eigenen. Die Nachrichten darüber stammen aus deinem eigenen Verlauf.',

  // The same state minus the part that was not true. „ist nie losgegangen“ is
  // deliberately plain: the request is a frame and it never left this device,
  // and German has a short everyday way of saying that about a message.
  // „Neuanfang“ names the act as a noun in the body because the sentence needs
  // a subject, while the button two entries down takes the infinitive.
  'chat.encryption.rejoinUndeliverable.title': 'Niemand wurde gebeten, dieses Gerät hereinzulassen.',
  'chat.encryption.rejoinUndeliverable.body': 'Der Server, der diese Unterhaltung ordnet, ist nicht erreichbar; die Anfrage ist deshalb nie losgegangen. Ein Neuanfang gibt allen, die noch erreichbar sind, eine neue Gruppe.',

  // The one banner that might be another person. Same two readings as the chip
  // tooltip, in the same words, because a reader can see both within a second
  // of each other and two spellings would read as two different problems.
  'chat.encryption.changedIdentity.title': 'Jemand hier verwendet einen anderen Kontoschlüssel.',
  'chat.encryption.changedIdentity.body': 'So sieht ein zurückgesetzter Schlüssel aus, und so sieht auch ein Identitätsdiebstahl aus. Verifiziere die Person noch einmal, bevor du darauf vertraust.',

  // „verschlossen“ and not „gesperrt“: see the glossary block. A client that
  // also bans people cannot use the ban verb for a key vault, and „verschlossen“
  // brings the Tresor with it, which is the metaphor the recovery copy uses
  // everywhere else.
  'chat.encryption.vaultLocked.title': 'Deine älteren Nachrichten sind auf diesem Gerät verschlossen.',
  'chat.encryption.vaultLocked.body': 'Gib unter Einstellungen → {pane} deine Wiederherstellungs-Passphrase ein, um sie zurückzuholen.',

  'chat.encryption.deviceApproval.title': 'Dieses Gerät hat deine Schlüssel noch nicht.',
  // „wandern direkt zwischen deinen Geräten“ is a claim about where the keys go
  // and it is not decoration — it is the reason approving from another device
  // is safe. It is not reduced to „werden kopiert“, which would say the
  // opposite thing about where the copy passes through.
  'chat.encryption.deviceApproval.body': 'Gib es von einem Gerät frei, das du schon benutzt. Die Schlüssel wandern direkt zwischen deinen Geräten.',

  // Signing in worked and did not open the history: the state that most looks
  // like a failure and is not one. „aufgeschlossen“ continues the Tresor chain
  // from `vaultLocked` — what is verschlossen gets aufgeschlossen — and avoids
  // „entsperrt“, which this catalogue has spent on lifting a ban. Two ways out,
  // both real, in the order of what they cost.
  'chat.encryption.recoveryFallback.title': 'Die Anmeldung hat deine älteren Nachrichten nicht aufgeschlossen.',
  'chat.encryption.recoveryFallback.body': 'Gib unter Einstellungen → {pane} deine Wiederherstellungs-Passphrase ein, oder gib dieses Gerät von einem frei, das du schon benutzt.',

  // Messages held back on purpose, said as such, because the fear this banner
  // answers is that messages are being lost. „zurückgehalten“ is the word for
  // deliberately keeping something back and cannot be read as „verloren“.
  'chat.encryption.syncFailed.title': 'Die Verschlüsselung ist auf diesem Gerät nicht mehr synchron.',
  'chat.encryption.syncFailed.body': 'Neuere Nachrichten werden zurückgehalten, während Telium den MLS Key Schedule erneut aufsetzt.',

  // Twenty-nine characters against English's ten, on a button. It is not
  // shortened: „Sync“ as a bare noun is developer slang in German, and the
  // alternative („Erneut synchronisieren“) loses the object and would leave the
  // reader wondering what is being synchronised on a banner that has just named
  // two candidates. The row is what gives.
  'chat.encryption.retrySync': 'Synchronisierung erneut versuchen',

  // ------------------------------------------------------------ starting over

  // Two presses: the first arms, the second does it. The unarmed label is the
  // infinitive with the object, as a button; the confirmation repeats the verb
  // rather than saying „Ja“ alone, because a bare yes on a destructive button
  // is a yes to a question the reader may have stopped reading.
  'chat.encryption.startOver.arm': 'Die Unterhaltung neu beginnen',
  'chat.encryption.startOver.confirm': 'Ja, neu beginnen',

  // The irreversible half, and it is not softened. „lässt sich nie wieder
  // öffnen“ is a flat statement about every device forever, where „ist
  // möglicherweise nicht mehr verfügbar“ — the phrase a German product page
  // would reach for — would be a hedge about a certainty.
  'chat.encryption.startOver.warning': 'Alle bekommen eine neue Gruppe; was vorher gesagt wurde, lässt sich nie wieder öffnen.',

  'chat.encryption.startOver.done': 'Neu begonnen. Neue Nachrichten lassen sich hier wieder lesen.',

  // The plural English needed a pattern for even though English does not
  // inflect: German does. „konnte“ against „konnten“ is the whole reason both
  // arms are written out, and it is the case the English comment predicted —
  // a language that inflects the verb for one versus several had nowhere to put
  // that when this was a template literal. `{names}` arrives already joined by
  // `Intl.ListFormat` in German, so the pattern adds no comma and no „und“.
  'chat.encryption.startOver.partial': '{count, plural, one {Neu begonnen, aber {names} konnte noch nicht hinzugefügt werden.} other {Neu begonnen, aber {names} konnten noch nicht hinzugefügt werden.}}',

  // The „… ließ sich nicht …“ family, with the object named.
  'chat.encryption.startOver.failed': 'Die Unterhaltung ließ sich nicht neu beginnen',

  // -------------------------------------------------------------- invite cards

  // The member count under a guild's name, and the same count with the host it
  // resolves against. „auf {domain}“ is the preposition German uses for a
  // machine, and it stays at the end where English has it because German puts
  // it there too. `{domain}` is a hostname: never translated, never given
  // different digits, because the reader is matching it against the address bar.
  'chat.invite.members': '{count, plural, one {# Mitglied} other {# Mitglieder}}',
  'chat.invite.membersOnHost': '{count, plural, one {# Mitglied} other {# Mitglieder}} auf {domain}',

  // The button. German is verb-final, so the guild name moves from the end of
  // the English sentence to the front of the German one and the infinitive
  // lands last — which is exactly the rearrangement a `'Join ' + name`
  // concatenation could not have expressed. The unnamed form is the bare
  // infinitive, and it exists because a guild whose name the host did not
  // return must not produce „ beitreten“ with a hole in front of it.
  'chat.invite.join': '{guild} beitreten',
  'chat.invite.joinUnnamed': 'Beitreten',

  // -------------------------------------------------------------- the surface

  // The composer's placeholder. `{target}` arrives already decorated — `#general`
  // for a text channel, the bare name for a thread — and German needs a
  // preposition in front of it where English needs none. „an“ takes the
  // accusative and the sigil sits directly against the name, so „Nachricht an
  // #allgemein“ reads as one address and nothing agrees with a gender this
  // sentence cannot know.
  'chat.surface.placeholder': 'Nachricht an {target}',
  // The same box where there is no name to put in it. English can use the bare
  // noun as a verb; German cannot, so it says what you do with the box. This is
  // the key the English comment set aside for exactly this — „Nachricht an “
  // with a hole at the end is not a sentence in any language.
  'chat.surface.placeholderPlain': 'Nachricht schreiben',

  // Both machines named, because „schreibgeschützt“ on its own reads like a
  // permission somebody took away. German fronts the outage and puts the
  // consequence in a relative clause on the copy, which is the order the
  // English comment explicitly frees a translator to choose.
  'chat.surface.standby': '{home} antwortet nicht. Du liest eine Kopie, die {standby} bereithält und die keine neuen Nachrichten annehmen kann.',
  // Three refusals, three speakers: a room's rule, a moderator's decision about
  // you, and the permission system. „geschlossen“ for a locked thread rather
  // than „gesperrt“, which this catalogue has spent on bans; „stummgeschaltet“
  // for the timeout, because `errors.timed_out` above already says that word
  // about the same state and the two are read minutes apart; and the third
  // echoes `errors.status.403` („Dazu hast du hier keine Berechtigung.“) with
  // the object spelled out, because the composer knows what you were trying to
  // do and the generic error does not. „Lesen geht, Schreiben nicht.“ is the
  // construction `errors.standby_read_only` already uses in this file.
  'chat.surface.threadLocked': 'Dieser Thread ist geschlossen. Hier können nur Moderierende schreiben.',
  'chat.surface.timedOut': 'Du bist in dieser Gilde stummgeschaltet. Lesen geht, Schreiben nicht.',
  'chat.surface.noPermission': 'Du hast hier keine Berechtigung, Nachrichten zu senden.',

  // The three states as the one word on a menu row. German lands on the same
  // three participles as the dialog title above, which is not the outcome the
  // English comment guessed at — it expected a noun here and a participle there
  // — but it is the right one: a menu row reading „Zustellung“ would name the
  // topic instead of answering the question, and the whole point of moving the
  // word onto the row was that the answer is one gesture away. The keys stay
  // separate anyway, because the reason they exist is that this decision
  // belongs to each language and a merge would take it from the next one.
  'chat.surface.delivery.sent': 'Gesendet',
  'chat.surface.delivery.delivered': 'Zugestellt',
  'chat.surface.delivery.read': 'Gelesen',

  // --------------------------------------------------------------- the composer

  // Glyph buttons: every one of these is a `title` and an accessible name at
  // once. Infinitives throughout, and no „Schaltfläche“.
  'chat.composer.attach': 'Datei anhängen',
  // „Weitere Nachrichtenaktionen“ is one compound of nineteen letters where
  // English has two words; it is kept whole rather than hyphenated, and it is
  // longer than `common.a11y.menu` („Weitere Aktionen“) on purpose, because
  // this one is announced next to a row that already has three other buttons.
  'chat.composer.moreActions': 'Weitere Nachrichtenaktionen',
  // The sheet takes the context with it when it covers the screen, so it is
  // „Nachrichtenaktionen“ and not „Aktionen“.
  'chat.composer.actionSheet': 'Nachrichtenaktionen',
  // NOT TRANSLATED: the name of the format, drawn inside the button as its own
  // face. German has no word of its own for it and every German GIF service
  // spells it this way. The key exists so that a locale whose readers would not
  // recognise three Latin letters has somewhere to put a transliteration; German
  // is not that locale.
  'chat.composer.gif': 'GIF',
  // The German word and the English word are the same word: „Emoji“ is in
  // Duden, takes a German plural and is what everybody says. Translated, and
  // the result happens to be identical.
  'chat.composer.emoji': 'Emoji',
  'chat.composer.send': 'Senden',
  // „Antwort abbrechen“ and not „verwerfen“: this only unsticks the reply strip
  // and nothing written is lost, so it takes `common.cancel`'s verb. The strong
  // verb is reserved for `chat.ephemeral.dismiss`, which really does destroy
  // the only copy of something.
  'chat.composer.cancelReply': 'Antwort abbrechen',

  // The clipboard pair, and the reason the English file duplicates
  // `common.copy` here rather than reusing it is precisely a German one: cut
  // and copy are a matched set on a text box and German translates them as a
  // set, „Kopieren“ / „Ausschneiden“. Splitting them across two files would
  // hand a translator two halves of one decision.
  'chat.composer.copy': 'Kopieren',
  'chat.composer.cut': 'Ausschneiden',

  // Why the paperclip is off, in the words the button itself says. The second
  // names the server rather than a setting, because an account on a server that
  // enables no upload host has nowhere to put a file and „Uploads sind
  // deaktiviert“ would send the reader hunting through their own preferences
  // for a switch that is not there.
  'chat.composer.attachBlocked': 'Du kannst hier keine Dateien anhängen',
  'chat.composer.noUploadHosts': 'Auf deinem Heimserver ist kein externer Upload-Host aktiviert',
  // Stated as a fact about the guild and not about the reader: a first message
  // held for review is a rule they walked into. „Zur Prüfung durch die
  // Moderation“ uses the noun for the group rather than „Moderierende“, because
  // the sentence is about an institution reviewing rather than about particular
  // people reading. No apostrophe anywhere in the German, which also keeps it
  // clear of ICU's quoting character entirely.
  'chat.composer.heldForReview': 'Zur Prüfung durch die Moderation zurückgehalten: Diese Gilde hält die erste Nachricht neuer Mitglieder zurück.',

  // ------------------------------------------------------------- the formatting

  // The seven formats, as the right-click menu names them, and all seven are
  // translated. The temptation is to leave them in English because the markers
  // are ASCII, and the English comment is right that this menu is the only
  // place the client ever teaches somebody these marks exist — a German reader
  // who is being taught them should be taught them in German.
  //
  // NOT TRANSLATED, and not in this file at all: the chord beside each row
  // (`⌘B`, `Strg+E`). `chordHint` in `views/chat/formatting.js` builds those
  // from the physical keyboard and has no catalogue entry, which is correct —
  // a translated chord names a key the reader would press to no effect.
  'chat.format.bold': 'Fett',
  'chat.format.italic': 'Kursiv',
  'chat.format.strike': 'Durchgestrichen',
  // „Code im Text“ rather than „Inline-Code“, which was the close call in this
  // block. „Inline“ is an English word wearing a German hyphen, and this menu
  // row is the one place somebody learns the mark exists; a reader who has to
  // know what „inline“ means before the label helps them has been handed the
  // English twice. „Code“ itself stays, as the guild glossary's loanword list
  // allows — it is what the thing is called in German too.
  'chat.format.code': 'Code im Text',
  // „Spoiler“ is in Duden with a German plural, and the thing it names arrived
  // in German through exactly this word. „Spannungsverderber“ exists and would
  // be a joke.
  'chat.format.spoiler': 'Spoiler',
  'chat.format.block': 'Codeblock',
  'chat.format.quote': 'Zitat',

  // --------------------------------------------------------- staged attachments

  // The card's three actions, twice over: the bare verb as a tooltip for
  // somebody who can see which card they are pointing at, and the named form as
  // the accessible label for somebody who cannot.
  //
  // The named forms are where German's gender problem would have bitten hardest
  // — a filename arrives as `{name}` and German cannot know whether it is der,
  // die or das — and two different devices keep them grammatical. „Vorschau von
  // {name}“ puts the file behind a preposition, where no article is needed at
  // all. „{name} umbenennen“ and „{name} entfernen“ put it in a bare accusative
  // in front of an infinitive, which also needs no article, and as a bonus the
  // filename lands first, which is what a screen-reader user wants to hear
  // first when six cards are stacked.
  'chat.staged.preview': 'Vorschau',
  'chat.staged.rename': 'Umbenennen',
  'chat.staged.remove': 'Entfernen',
  'chat.staged.previewOf': 'Vorschau von {name}',
  'chat.staged.renameOf': '{name} umbenennen',
  'chat.staged.removeOf': '{name} entfernen',
  // A progress bar's label, announced repeatedly while the bar moves. The
  // passive is what German uses for a thing in progress, and it also dodges the
  // article: „{name} wird hochgeladen“ needs nothing in front of the filename.
  'chat.staged.uploadingOf': '{name} wird hochgeladen',
  // The staged sticker has no name to put in a label, so the bare verb phrase
  // is also the accessible name here.
  'chat.staged.removeSticker': 'Sticker entfernen',
  'chat.staged.closePreview': 'Vorschau schließen',

  // The rename prompt: the heading is a noun phrase with its object, the field
  // label is the noun, and the button is the bare infinitive. German does
  // distinguish those three where English spells two of them the same, and this
  // is the pair the guild fragment's rule was written for. `common.save` is not
  // used for the button, for the reason the English gives — a dialog whose
  // button repeats its own title leaves people unsure whether they are renaming
  // or saving a copy.
  'chat.staged.renameTitle': 'Datei umbenennen',
  'chat.staged.renameLabel': 'Dateiname',
  'chat.staged.renameConfirm': 'Umbenennen',

  // The expiry chip and its menu, and the one place in this fragment where the
  // German construction is chosen by grammar rather than by meaning.
  //
  // English says "Expires in {duration}" and `{duration}` is a phrase that
  // arrives already formatted — either a preset from `chat.upload.expiry*` or a
  // derived label from `chat.upload.limit*`. The literal German, „Läuft in
  // {duration} ab“, governs the dative, so it would need „in 30 Tagen“ while
  // the same strings are also what the picker's own rows are built from. One
  // string cannot be both „30 Tage“ and „30 Tagen“, and no amount of care in
  // the unit entries fixes it, because the unit entry does not know which
  // sentence it is about to land in.
  //
  // So the German picks a verb that takes a bare accusative for a span of time:
  // „Bleibt 30 Tage“, „Bleibt 1 Stunde“. The accusative of a time span is
  // identical to the citation form, so every unit entry below can be written
  // once and read correctly in the chip, in the menu row, and anywhere a later
  // caller puts it. „Bleibt dauerhaft“ then falls out as the forever case in
  // the same voice, which the English pair does not quite manage.
  //
  // The menu button's own label drops English's dangling preposition: German
  // cannot end a label on „für“, and a noun-phrase label is what a German menu
  // button carries anyway.
  'chat.staged.keepFor': 'Dateien aufbewahren',
  'chat.staged.expiresIn': 'Bleibt {duration}',
  'chat.staged.keepsForever': 'Bleibt dauerhaft',
  // Whose rule cut the list short. Worth a sentence rather than a silently
  // shorter menu. This one *does* take the dative, and it may: `{duration}` here
  // comes only from the three `capDays`/`capHours`/`capMinutes` entries below,
  // which are used nowhere else and are therefore free to be written in the
  // case this sentence asks for.
  'chat.staged.cappedNote': 'Dateien, die hier gesendet werden, werden spätestens nach {duration} gelöscht.',

  // The article forms, for that sentence only — and German gets to keep the
  // distinction English was protecting. English writes "at most a day" rather
  // than "at most 1 day" because the sentence names a rule of the room instead
  // of counting; German's dative article „einem Tag“, „einer Stunde“, „einer
  // Minute“ says the same thing with the same lightness. The `other` arm is a
  // real plural and takes the dative plural ending, which is the -n that a
  // `days + ' Tage'` concatenation would have got wrong every single time.
  'chat.staged.capDays': '{count, plural, one {einem Tag} other {# Tagen}}',
  'chat.staged.capHours': '{count, plural, one {einer Stunde} other {# Stunden}}',
  'chat.staged.capMinutes': '{count, plural, one {einer Minute} other {# Minuten}}',

  // The host chip for accounts sending to a third-party provider. „Upload-Host“
  // is two loanwords German has fully adopted, hyphenated the way German
  // hyphenates a compound whose first part is a foreign noun.
  'chat.staged.uploadHost': 'Upload-Host',
  'chat.staged.noHosts': 'Es ist kein externer Upload-Host aktiviert',
  // NOT TRANSLATED, and nothing in it can be: `{name}` is a provider's own name
  // and `{domain}` is a hostname. The entry exists for the punctuation around
  // them, which German happens to set exactly as English does.
  'chat.staged.hostOption': '{name} ({domain})',
  // Two sentences, two keys, because only the first can be replaced by a
  // description the provider wrote. The second is ours and is always said, and
  // it is not softened: an external upload is a public URL outside this app's
  // access control. „steht nicht unter der Zugriffskontrolle von Telium“ is the
  // flat form; „wird von Telium nicht geschützt“ would invite the reading that
  // some other protection might apply.
  'chat.staged.hostPolicy': 'Dieser Host speichert Dateien nach seinen eigenen Regeln für Aufbewahrung und Missbrauch.',
  'chat.staged.hostPublic': 'Externe Uploads sind öffentliche URLs beim Anbieter und stehen nicht unter der Zugriffskontrolle von Telium.',

  // What a drag reveals: a destination on one line, the instruction on the next.
  // Two entries because they were never one sentence. The fallback stands where
  // a room's name would stand, so it is a noun phrase with a demonstrative and
  // not a sentence.
  'chat.staged.dropTargetFallback': 'diese Unterhaltung',
  // „Zum Hochladen loslassen“ rather than „Ablegen zum Hochladen“: the gesture
  // German names for letting go of a dragged thing is „loslassen“, and putting
  // the purpose first is the order a German instruction takes when the purpose
  // is the reason to act.
  'chat.staged.dropLine': 'Zum Hochladen loslassen',

  // Named rather than counted, because a tray of six files with one failure has
  // to say which one. The „… ließ sich nicht …“ family again, and the filename
  // needs no article in front of it as the subject of this construction.
  'chat.staged.uploadFailed': '{name} ließ sich nicht hochladen',
  'chat.staged.tooLarge': 'Zu groß — Anhänge sind hier auf {limit} begrenzt.',
  'chat.staged.cancelUpload': 'Upload abbrechen',
  'chat.staged.cancelUploadOf': 'Upload von {name} abbrechen',

  // -------------------------------------------------------------- expiry units

  // Die Presets. Feste Zeichenketten und keine Plurale, weil in jedem von
  // ihnen die Eins steht und immer stehen wird. Sie werden nur innerhalb von
  // `chat.staged.expiresIn` gelesen, weshalb sie in der Zitierform bleiben
  // dürfen; siehe die lange Notiz dort.
  //
  // `chat.upload.expiryMonth` („30 Tage“) ist entfallen. Die Dreißig war keine
  // Eigenschaft des Deutschen, sondern `30 * 24 * 60 * 60` aus `lib/upload.js`,
  // von Hand in vier Kataloge kopiert — niemand hier konnte wissen, dass die
  // Zahl tragend war. Das Preset wird jetzt aus seinen eigenen Sekunden über
  // `chat.upload.limitDays` beschrieben, den Plural, den es dafür längst gab.
  // Auf dem Bildschirm steht weiterhin „30 Tage“.
  'chat.upload.expiryHour': '1 Stunde',
  'chat.upload.expiryDay': '1 Tag',
  'chat.upload.expiryWeek': '1 Woche',
  // `common.never` says „Nie“ and this does not reuse it, for the same reason as
  // the clipboard pair: it is the last of five entries in one table and it has
  // to be translated alongside the other four. It is also the only one that is
  // not a duration — `expiryOptions` builds a label for it like the rest, while
  // the chip's own menu substitutes `chat.staged.keepsForever` for that row — so
  // it is written to stand on its own wherever a later caller prints it, and
  // „Nie“ alone would be an answer to a question nobody asked.
  'chat.upload.expiryNever': 'Nie löschen',

  // A cap that is not one of the presets, in human units. Two arms because
  // German has two, `#` through `Intl.NumberFormat`, and the citation form for
  // the same reason as the presets above.
  'chat.upload.limitDays': '{count, plural, one {1 Tag} other {# Tage}}',
  'chat.upload.limitHours': '{count, plural, one {1 Stunde} other {# Stunden}}',
  'chat.upload.limitMinutes': '{count, plural, one {1 Minute} other {# Minuten}}',

  // An encrypted attachment that would not come back from its origin. Two whole
  // sentences rather than one with a noun dropped into it: „der Anhang“ carries
  // a gender and an article that a `{name}` never can, so the unnamed case gets
  // its own sentence and the named one gets a subject that needs neither.
  'chat.upload.fetchFailedNamed': '{name} ließ sich nicht laden',
  'chat.upload.fetchFailed': 'Der Anhang ließ sich nicht laden',

  // ----------------------------------------------------------- the autocomplete

  // The note on the far edge of a completion row, saying what this row is.
  //
  // NOT TRANSLATED, and not present as a key: `@everyone` and `@here` are the
  // literal text that goes into the message and that the server matches on.
  // What they *do* is this line, and it is translated. German uses the third
  // person present — „Benachrichtigt den Kanal“ — rather than the infinitive:
  // the infinitive („Den Kanal benachrichtigen“) is this catalogue's button
  // form, and this is a note about what pressing Enter will set off, not a
  // second button on the row.
  'chat.autocomplete.notifyChannel': 'Benachrichtigt den Kanal',
  'chat.autocomplete.role': 'Rolle',
  // „Eigenes“ agrees with „Emoji“, which is neuter in German and is the noun
  // the row is already showing, so the adjective has something to agree with
  // and the noun does not have to be repeated. Naming the guild is what the
  // *other* key does; this one is the room you are in and saying so would be
  // telling the reader where they are.
  'chat.autocomplete.emojiCustom': 'Eigenes',
  // „Emoji aus {guild}“ rather than a compound: a guild name is arbitrary text
  // in any script, and „{guild}-Emoji“ would glue a hyphen onto data that may
  // end in punctuation or a right-to-left run. The preposition also frees the
  // word order, which is the whole reason this is a pattern.
  'chat.autocomplete.emojiFrom': 'Emoji aus {guild}',
  // „Andere Gilde“, und der Schlüssel heißt jetzt auch so. Diese Zeile stand
  // hier schon richtig, als Englisch noch "Other server" sagte: das Fragment
  // füllt denselben Platz wie `emojiFrom` darüber, in den ein Gildenname
  // kommt, also musste es dasselbe Substantiv sein — und das Gildenglossar hat
  // dieses Substantiv als Gilde festgelegt, gerade weil „Server“ in diesem
  // Client die Maschine ist. Großgeschrieben, weil es dort steht, wo ein
  // Eigenname stünde. Englisch ist nachgezogen; der Wert bleibt unverändert.
  'chat.autocomplete.otherGuild': 'Andere Gilde',
  // Hier stand „Auf diesem Server wird gesucht…“, mit einer Notiz, dass
  // „Server“ diesmal wirklich die Maschine sei. Das war aus dem Englischen
  // erschlossen und falsch: die Anfrage dahinter ist `api.members(guildId, …)`
  // und durchsucht die Mitgliederliste genau einer Gilde. Der Homeserver wird
  // dabei befragt, aber er ist nicht das, worin gesucht wird. Passiv, wie jede
  // andere Zeile in diesem Katalog, die etwas Laufendes meldet.
  'chat.autocomplete.searching': 'Diese Gilde wird durchsucht…',

  // The second line on a voice channel's row. The slash form is notation and
  // not a sentence — it is how a capacity is written on a door in German too —
  // and both numbers are already bidi-isolated. „im Sprachkanal“ is the phrase
  // `perms.group.voice` above has committed to for this kind of room.
  'chat.autocomplete.voiceHereOfLimit': '{count}/{limit} im Sprachkanal',
  'chat.autocomplete.voiceHere': '{count, plural, one {# Person im Sprachkanal} other {# Personen im Sprachkanal}}',
  'chat.autocomplete.voiceLimit': '{limit, plural, one {Bis zu # Person} other {Bis zu # Personen}}',

  // --------------------------------------------------------------- forwarding

  // Two titles for one dialog, because they are two acts: forwarding moves a
  // message you are reading, sharing is the operating system handing this app
  // something from elsewhere. German has two verbs and uses both, which is the
  // case the English comment says most languages have and English does not.
  // „Mit Telium teilen“ is the phrasing of every German share sheet, so the
  // reader recognises where the content came from before reading a word.
  'chat.forward.title': 'Nachricht weiterleiten',
  'chat.forward.shareTitle': 'Mit Telium teilen',
  'chat.forward.search': 'Kanäle und Unterhaltungen durchsuchen',
  // The pill on a row with no name of its own. Both are the words German
  // messengers print for these two kinds of room, and „Direktnachricht“ is the
  // noun this fragment uses for a DM wherever the encryption copy needs it, so
  // the pill and the paragraph agree.
  'chat.forward.groupChat': 'Gruppenchat',
  'chat.forward.directMessage': 'Direktnachricht',
  // Not `common.save`/`common.saving`: this dispatches a copy somewhere, and
  // German uses „senden“ for that and „speichern“ for storing. The in-flight
  // form is the passive this catalogue uses everywhere else.
  'chat.forward.send': 'Senden',
  'chat.forward.sending': 'Wird gesendet…',
  // English can drop the object („Could not forward“); German cannot, because a
  // subjectless German clause is an imperative and „Konnte nicht weiterleiten“
  // would read as a command to somebody. So the thing that failed is named. The
  // share case genuinely does not know what it was handed — a link, an image, a
  // file the OS never described — so its subject is the demonstrative „Das“,
  // which is honest about exactly that.
  'chat.forward.failed': 'Die Nachricht ließ sich nicht weiterleiten',
  'chat.forward.shareFailed': 'Das ließ sich nicht teilen',
  // German quotation marks, inside the pattern, which is why the marks are in
  // the string and not around the placeholder in JSX: „ “ is not “ ” and a
  // component that drew them would have chosen English typography for every
  // language at once. The query goes in front, because German states the
  // subject of a search before reporting on it.
  'chat.forward.noMatches': 'Zu „{query}“ passt nichts.',

  // --------------------------------------------------------------- the media card

  // Almost everything from here to the end of the section is read by somebody
  // who cannot see the picture: these are the words a screen reader says in
  // place of the thing itself. The rule that shaped the section in English
  // shapes it in German too — the filename is never glued to a word, because
  // the code that used to assemble these strings then read them back apart with
  // `label.endsWith(' audio')`, and there is no language but English in which
  // that test is true.

  // What the player is, named, as a bare noun phrase that the seven patterns
  // below interpolate. „Audiodatei“ and „Videodatei“ rather than bare „Audio“
  // and „Video“: German needs a noun that can carry a case, and a reader
  // hearing „holiday.mp4 Video abspielen“ would hear two nouns with nothing
  // between them. The noun goes first and the filename second, which is the
  // order German uses when it names a kind of thing and then says which one —
  // and the caller no longer decides that order, which is the point of these
  // two keys existing.
  //
  // No punctuation at the end of either: they land inside „{label} abspielen“.
  'chat.player.audioOf': 'Audiodatei {name}',
  'chat.player.videoOf': 'Videodatei {name}',

  // The transport, as a screen reader hears it. Seven patterns and not one verb
  // concatenated onto `{label}`, and German is the case that proves it: the
  // verb goes last, so every one of these reverses the English word order, and
  // three of them need a preposition English does not have.
  //
  // None of them puts an article in front of `{label}`. Both labels this file
  // supplies today are feminine („die Audiodatei“), so „die {label}“ would even
  // be grammatical — and it is still not written, because the pattern must
  // survive the day somebody adds a third label with a different gender. A bare
  // accusative in front of an infinitive is the one construction that never
  // needs to know.
  'chat.player.play': '{label} abspielen',
  'chat.player.pause': '{label} anhalten',
  // German has no single verb for seeking along a timeline; „spulen“ is what
  // a German reader knows from a transport bar and it takes a bare object, so
  // no preposition and no article are needed.
  'chat.player.seek': '{label} spulen',
  // „stummschalten“ is the universal German verb for muting audio. It collides
  // in the dictionary with `errors.timed_out`'s „stummgeschaltet“ for a
  // moderation timeout, and the collision is harmless because the two can never
  // be read on the same control: one is a tooltip on a speaker glyph, the other
  // is a banner across the composer. Undoing it takes a noun phrase, because
  // German has no „entstummschalten“ and any coinage would be worse than the
  // four words.
  'chat.player.mute': '{label} stummschalten',
  'chat.player.unmute': 'Stummschaltung von {label} aufheben',
  // These two are labels rather than acts, so they take „für“ — which, unlike
  // „der/die/das“, does not have to agree with anything.
  'chat.player.volume': 'Lautstärke für {label}',
  'chat.player.fullscreen': 'Vollbild für {label}',

  // When the browser will not play it. Two keys because the offer differs: a
  // wrapper that can write to the phone offers to keep the file, and everywhere
  // else the only thing left is to open it somewhere that can. The first clause
  // joins the „… ließ sich nicht …“ family with „Das“ as its subject, because
  // the card does not always have a name to use; the second is a du-imperative,
  // as the English second half is an imperative. The em dash with spaces is
  // German punctuation too.
  'chat.player.failedSave': 'Das ließ sich nicht abspielen — speichere die Originaldatei',
  'chat.player.failedOpen': 'Das ließ sich nicht abspielen — öffne die Originaldatei',

  // The row around the player. Three entries and not one with a sometimes-empty
  // `{name}`, because „Speichern“ is a bare infinitive on a button and „{name}
  // speichern“ is an infinitive with an object — German spells those the same
  // way but must still be free to spell them differently, which is why the
  // English file kept them apart. The named forms use the bare accusative
  // again, so no article has to agree with a filename.
  'chat.attachment.save': 'Speichern',
  'chat.attachment.saveNamed': '{name} speichern',
  'chat.attachment.openNamed': '{name} öffnen',

  // Where the bytes live. `{host}` is a domain: never translated, frequently
  // Latin script inside a non-Latin sentence, and kept away from the edge of
  // the pattern so the bidi isolation has something to sit between. „Liegt auf“
  // is what German says about a file on a machine.
  'chat.attachment.hostedOn': 'Liegt auf {host}',

  // The four stand-ins for a name we do not have. English keeps them lower case
  // because they fill a slot where a filename or a domain would go; German
  // capitalises the noun in all four, because that is orthography rather than
  // style, and keeps the adjective in front of it lower case, which preserves
  // the „this is a description, not a title“ signal at the only place German
  // has left to put it.
  'chat.attachment.unnamed': 'Anhang',
  'chat.attachment.externalMedia': 'externe Mediendatei',
  'chat.attachment.externalHost': 'externer Host',
  'chat.attachment.unknownHost': 'unbekannter Host',

  // Saving, and failing to. The named form is a participle with no ending —
  // „{name} gespeichert.“ — which is the device this file's guild fragment
  // names for a predicate about a thing whose gender is unknown: a participle
  // in that position inflects for nothing. The unnamed case is its own sentence
  // with its own subject, and German needs it for a reason English does not:
  // English gets away with „Attachment saved.“ because a capitalised noun at
  // the head of a sentence sits where an interpolated filename sits, and German
  // capitalises the noun either way so the coincidence is not available.
  'chat.attachment.saved': '{name} gespeichert.',
  'chat.attachment.savedUnnamed': 'Anhang gespeichert.',
  'chat.attachment.saveFailed': 'Der Anhang ließ sich nicht speichern',

  // The external file host. `{provider}` is a company name — Gofile today — and
  // it is interpolated rather than baked in because German, like Japanese, puts
  // the verb where English cannot: „Bei Gofile öffnen“ is unreachable from a
  // sentence that ends where the English ends.
  'chat.attachment.openOnProvider': 'Bei {provider} öffnen',
  'chat.attachment.openProviderFailed': '{provider} ließ sich nicht öffnen',

  // Two waiting states, in the corner where a file size normally sits. Lower
  // case in German as in English, and here that is free: both are verbs in the
  // passive, so nothing in them is a noun to capitalise. The ellipsis stays the
  // single character U+2026 — three periods would make the row wider for no
  // reason.
  'chat.attachment.preparing': 'wird vorbereitet…',
  'chat.attachment.decrypting': 'wird entschlüsselt…',

  // The one failure a reader can do nothing about: the bytes arrived and the
  // key did not open them. Split for the same reason `saved` is split.
  'chat.attachment.decryptFailed': '{name} ließ sich nicht entschlüsseln',
  'chat.attachment.decryptFailedUnnamed': 'Dieser Anhang ließ sich nicht entschlüsseln',

  // ----------------------------------------------------------------- the picture

  // `untitled` is what stands in when a picture has no name at all, and it is
  // the word the lightbox puts in `alt` when there is nothing else to say. It
  // is capitalised here for the reason the English comment gives and for one
  // more that only applies to German: English needs the two spellings „Image“
  // and „image“ because its sentence case differs from its caption case, and
  // German needs exactly one, because „Bild“ is capitalised in both positions.
  // The split into two zoom keys below is therefore free for German rather than
  // necessary — and it is still honoured key for key, because the coverage test
  // wants both keys and because a caller that reached for the wrong one would
  // otherwise be invisible.
  'chat.image.untitled': 'Bild',
  // „größer ansehen“ keeps the comparative English uses: the thumbnail is
  // already visible, so this is not „Bild öffnen“ but the offer of a bigger
  // one. The unnamed form writes the noun into the sentence itself rather than
  // interpolating `chat.image.untitled`, exactly as English does — one sentence
  // one key, and no caller gluing a noun to a verb.
  'chat.image.viewLarger': 'Bild größer ansehen',
  // The named form takes a real caption. Verb last, so `{label}` lands at the
  // front as a bare accusative with no article: the caption is a filename in
  // any language and any script, and nothing German puts in front of it could
  // agree with it.
  'chat.image.viewLargerNamed': '{label} größer ansehen',
  'chat.image.preview': 'Bildvorschau',
  'chat.image.close': 'Bildvorschau schließen',
  'chat.image.save': 'Speichern',
  'chat.image.openOriginal': 'Original öffnen',

  // ------------------------------------------------------------- the GIF picker

  // NOT TRANSLATED: **GIF**, in all nine entries and in the compounds. It is the
  // name of the format, it is what the composer's button is drawn with, and
  // every German GIF service spells it this way. German declines it — „ein GIF“,
  // „die GIFs“ — which is what a naturalised loanword looks like, so the plural
  // takes a plain -s and the compounds take a hyphen („GIF-Suche“,
  // „GIF-Ergebnisse“, „GIF-Auswahl“) because German hyphenates a compound whose
  // first element is an initialism.
  'chat.gif.search': 'GIFs suchen',
  'chat.gif.results': 'GIF-Ergebnisse',
  'chat.gif.picker': 'GIF-Auswahl',
  'chat.gif.dialogTitle': 'GIFs',
  'chat.gif.untitled': 'GIF',

  // The two chips that are not categories. „Im Trend“ is the provider's idea of
  // what is popular right now and is what German platforms print for it;
  // „Favoriten“ is the reader's own starred list and must match the two star
  // buttons below, which it does, because all three say Favoriten.
  'chat.gif.trending': 'Im Trend',
  'chat.gif.favorites': 'Favoriten',
  // The star, both ways. German has no verb „favorisieren“ that means this —
  // the one it has means „to prefer“ — so both are written as what they do to
  // the list the chip above names. Long for a glyph's tooltip, and kept.
  'chat.gif.favorite': 'GIF zu den Favoriten hinzufügen',
  'chat.gif.unfavorite': 'GIF aus den Favoriten entfernen',

  // `{title}` is whatever the provider called the GIF, usually English and
  // occasionally nothing — in which case the caller passes `chat.gif.untitled`
  // in, so this pattern always has a noun to work with and never has to survive
  // an empty slot. Verb last, as always.
  'chat.gif.send': '{title} senden',

  // Everything the grid can say instead of showing GIFs. The first two are
  // about the server's configuration rather than about the reader, and they
  // stay statements of fact: there is nothing to do about either from inside
  // the picker. „abgeschaltet“ rather than „deaktiviert“ — the second is the
  // word on a switch the reader could flip, and this is not one of those.
  'chat.gif.disabled': 'Die GIF-Suche ist auf diesem Server abgeschaltet.',
  'chat.gif.notConfigured': 'Die GIF-Suche ist noch nicht eingerichtet.',
  'chat.gif.loadFailed': 'Die GIFs ließen sich nicht laden.',
  'chat.gif.loading': 'GIFs werden geladen…',
  'chat.gif.favoritesEmpty': 'Markiere ein GIF mit dem Stern, damit es hier bleibt.',
  'chat.gif.noMatches': 'Dazu passt nichts.',

  // A share link that would not resolve, and a GIF whose bytes never arrived.
  // `{provider}` is Tenor, Giphy or Klipy — company names, never translated,
  // always interpolated. „direkt öffnen“ drops English's „it“, which German
  // would have had to give a gender.
  'chat.gif.openOn': 'GIF bei {provider} öffnen',
  'chat.gif.unavailable': 'GIF nicht verfügbar — direkt öffnen',

  // The category chips.
  //
  // Each is only the caption: the query actually sent to the provider stays in
  // English in `CATEGORIES` in `GifPicker.jsx`, because Klipy, Tenor and Giphy
  // index against English tags, so translating the query would empty the grid
  // while translating the caption is simply correct. That frees these entries
  // completely — they do not have to be translations, only the right caption
  // for a chip that returns those GIFs.
  //
  // So they are nouns rather than the mixed nouns and adjectives English has:
  // a German chip rail reads as a list of things, and „Glücklich“ next to
  // „Katzen“ reads as a sentence that lost its subject. „Facepalm“ is kept as
  // the loanword because that is the name German internet culture actually uses
  // for the gesture — this is the case the English comment explicitly opens the
  // door for — while „Schulterzucken“ is fully German because the German word
  // for that gesture is the one people say.
  'chat.gif.category.reactions': 'Reaktionen',
  'chat.gif.category.happy': 'Freude',
  'chat.gif.category.cry': 'Weinen',
  'chat.gif.category.love': 'Liebe',
  'chat.gif.category.dance': 'Tanzen',
  'chat.gif.category.cats': 'Katzen',
  'chat.gif.category.dogs': 'Hunde',
  'chat.gif.category.thumbsUp': 'Daumen hoch',
  // NOT TRANSLATED: „Facepalm“. The gesture reached German with its English
  // name and kept it — „Handfläche im Gesicht“ describes it and names nothing.
  // Duden lists it, German declines it („der Facepalm“), and this is the one
  // caption in the rail that a German reader would be confused to find
  // translated.
  'chat.gif.category.facepalm': 'Facepalm',
  'chat.gif.category.applause': 'Applaus',
  'chat.gif.category.shrug': 'Schulterzucken',
  'chat.gif.category.excited': 'Begeisterung',

  // ------------------------------------------------------------- the emoji picker

  // NOT TRANSLATED, and deliberately absent from this namespace: the names of
  // the emoji themselves. They come out of the Unicode dataset the picker
  // lazy-loads, they are English, and they stay English until that dataset
  // ships a localised build — two thousand CLDR names retyped by hand would be
  // stale by the next Unicode release. The shortcode beside each name
  // (`:grinning:`) is input syntax rather than a word and never moves.
  //
  // „Emoji“ itself is translated and the translation is the same word: it is in
  // Duden, it is neuter, and its German plural is „Emoji“ or „Emojis“ — this
  // fragment uses the uninflected plural, which is the form Duden lists first
  // and the form that lets one string serve a heading and a count alike.
  'chat.emoji.search': 'Emoji suchen',
  'chat.emoji.grid': 'Emoji',
  'chat.emoji.picker': 'Emoji-Auswahl',
  'chat.emoji.dialogTitle': 'Emoji',
  'chat.emoji.categories': 'Emoji-Kategorien',

  // The footer before the pointer has touched anything, and also what is
  // written back into the same element on every pointer move, so both spellings
  // come from this one key. Du-imperative, like every other invitation in this
  // catalogue.
  'chat.emoji.hint': 'Wähl ein Emoji aus.',

  // Two genuinely different waits: the Unicode dataset arriving over the
  // network, and this account's guilds answering with their own uploads.
  // Somebody watching the second one for a while is waiting on servers, not on
  // us, and the German says which is which by naming what is being loaded.
  'chat.emoji.loading': 'Emoji werden geladen…',
  'chat.emoji.loadingCustom': 'Eigene Emoji und Sticker werden geladen…',

  // Nothing to show. The second sentence names the Recent tab, so it has to
  // agree with `chat.emoji.group.recent` below — it does, and the German puts
  // the tab's name in „ “ so that the reader can see it is a label being quoted
  // rather than an adverb in the sentence. The quotation marks are also why
  // this is not written as „unter Zuletzt“, which reads as an unfinished
  // comparison.
  'chat.emoji.noMatches': 'Dazu passt kein Emoji.',
  'chat.emoji.empty': 'Noch nichts hier. Ausgewählte Emoji erscheinen unter „Zuletzt“.',

  // German quotation marks again, inside the pattern, for the reason the
  // English comment gives: „ “ is neither “ ” nor 「 」, and a translator who
  // cannot move them is stuck with somebody else's typography around their own
  // words.
  'chat.emoji.results': 'Ergebnisse für „{query}“',
  'chat.emoji.stickerResults': 'Sticker',
  'chat.emoji.savedStickers': 'Gespeicherte Sticker',

  // Section headings over a guild's own uploads. „aus {guild}“ rather than a
  // compound, for the same reason as `chat.autocomplete.emojiFrom`: a guild
  // name is arbitrary text in any script and a hyphen glued to it is a hyphen
  // glued to data.
  'chat.emoji.guildEmoji': 'Emoji aus {guild}',
  'chat.emoji.guildStickers': 'Sticker aus {guild}',
  'chat.emoji.saveSticker': 'Sticker speichern',
  // German has no prefix that undoes „speichern“, so the toggle's second state
  // says what it does instead. Four words where English has two, and kept.
  'chat.emoji.unsaveSticker': 'Sticker nicht mehr speichern',

  // Skin tone. `skinToneOf` takes one of the six names below as `{tone}`, and
  // this is the entry the English comment predicted would be hard: „Medium
  // light skin tone“ is one noun phrase in English and an adjective agreeing
  // with a noun in German — „mittelheller Hautton“ — and the agreement cannot
  // happen when the adjective arrives through a placeholder.
  //
  // So German does not agree with it at all. „Hautton {tone}“ puts the tone
  // behind the noun as an apposition, the way a paint chart or a size label
  // does, and an apposition takes no ending. The six names below keep their
  // capital letters, which also signals that what follows is the name of an
  // option rather than a description of the reader.
  'chat.emoji.skinTone': 'Hautton',
  'chat.emoji.skinToneOf': 'Hautton {tone}',

  // The five Fitzpatrick modifiers and the unmodified glyph. „Standard“ is the
  // yellow, tone-less emoji and is deliberately not named as a skin colour. The
  // other five are the words the German locale of every operating system
  // picker uses, which matters because readers meet these exact six options
  // there too — and because „mittelhell“ and „mitteldunkel“ are single German
  // compounds where English needs two words, which is the one place in this
  // fragment German is shorter.
  'chat.emoji.tone.default': 'Standard',
  'chat.emoji.tone.light': 'Hell',
  'chat.emoji.tone.mediumLight': 'Mittelhell',
  'chat.emoji.tone.medium': 'Mittel',
  'chat.emoji.tone.mediumDark': 'Mitteldunkel',
  'chat.emoji.tone.dark': 'Dunkel',

  // The category rail: the Unicode group names, shortened to fit a tooltip the
  // same way English shortens them, rather than transliterating the long form.
  // „Menschen“ for group 1 („People & Body“), „Natur“ for group 3 („Animals &
  // Nature“) — a rail of ampersands reads as noise in German too.
  //
  // „Zuletzt“ is not a Unicode group; it is this reader's own history, and it
  // is the tab `chat.emoji.empty` above points at by name. The two must stay
  // spelled identically or the sentence sends people to a tab that is no longer
  // called that.
  'chat.emoji.group.recent': 'Zuletzt',
  // NOT TRANSLATED: „Smileys“. The word entered German with the round yellow
  // face itself, it is in Duden, and it takes the German plural in -s, which is
  // why the English and the German spellings coincide here rather than the
  // English simply having been left in place. „Gesichter“ would be the literal
  // German and would also describe the next group along.
  'chat.emoji.group.smileys': 'Smileys',
  'chat.emoji.group.people': 'Menschen',
  'chat.emoji.group.nature': 'Natur',
  'chat.emoji.group.food': 'Essen',
  'chat.emoji.group.travel': 'Reisen',
  'chat.emoji.group.activities': 'Aktivitäten',
  'chat.emoji.group.objects': 'Objekte',
  'chat.emoji.group.symbols': 'Symbole',
  'chat.emoji.group.flags': 'Flaggen',

  // ---------------------------------------------------------------- link cards

  // The play button over a video unfurled from a link. `{title}` is the page's
  // own Open Graph title, written by a stranger's website in a language we do
  // not know, so German keeps it at the end behind the colon rather than
  // folding it into the sentence — an unknown-language string in the middle of
  // a German clause would take a case and a gender it cannot have. The colon is
  // set tight in German exactly as in English.
  'chat.embed.playVideo': 'Video abspielen',
  'chat.embed.playVideoTitled': 'Video abspielen: {title}',

// ===========================================================================
  // Deutsch: voice — the glossary these 226 keys are built on
  // ===========================================================================
  //
  // Eleven files, one call, one vocabulary. The English header says why the
  // namespace is not split; the same argument decides that the German is not
  // split either. The sidebar bar and the dock are on screen at the same time,
  // the tile pill and the square that sets it are four centimetres apart, and
  // a word chosen in one of them is a word committed to in all of them. What
  // follows is that set, decided once here so that no entry below has to
  // re-argue it, and so that whoever adds the twelfth voice surface can look
  // the words up instead of inventing them.
  //
  //   call (the thing)    → **das Gespräch**. Not *Anruf*, which is telephony
  //                         and belongs to one person dialling another; this
  //                         namespace is mostly rooms with eight people in
  //                         them. The sibling guild fragment already committed
  //                         to it — `guild.voice.probe.unreachable.body` says
  //                         „ein Gespräch versuchen“ — and two words for one
  //                         thing across two settings screens is exactly the
  //                         defect the English header describes.
  //   conversation (DM)   → **die Unterhaltung**, kept deliberately distinct
  //                         from Gespräch. Two keys below (`voice.call.noKeys`,
  //                         `voice.call.sfuAddressUnknown`) name both in one
  //                         sentence: the Unterhaltung is the thread that
  //                         persists, the Gespräch is the call happening inside
  //                         it right now. English gets away with
  //                         "conversation"/"call"; German would lose the
  //                         distinction entirely if both became Gespräch.
  //   voice (the feature) → **Sprache** / **Sprach-** in compounds
  //                         (Sprachkanal, Sprachverbindung, Sprachregion,
  //                         Sprachsteuerung). Fixed above by
  //                         `channel.type.voice.name` and `perms.group.voice`,
  //                         and the reason given there holds here twice over:
  //                         *Stimme* in German is the organ or a vote, and this
  //                         file talks about both microphones and rooms.
  //   mute                → **stumm** (stummschalten / Stummschaltung aufheben
  //                         / stummgeschaltet). See the long note at
  //                         `voice.bar.mic`.
  //   deafen              → **taub** (taubschalten / Taubschaltung aufheben /
  //                         taubgeschaltet). The hardest decision in the file;
  //                         argued at length at `voice.bar.deafen`.
  //   screen share        → **den Bildschirm teilen**, noun **das Teilen des
  //                         Bildschirms**. Fixed by `channel.type.voice.description`
  //                         above, which also records why not *freigeben*:
  //                         Freigabe is already spent on bot grants.
  //   watch together      → **gemeinsam ansehen**, nominalised **das gemeinsame
  //                         Ansehen**. A feature name, translated rather than
  //                         kept, because unlike SFU it is a plain phrase and
  //                         nobody reads it in a protocol document.
  //   watch (a share)     → **ansehen**; viewers are **Personen, die zusehen**.
  //                         Never *Zuschauer*: a generic masculine plural in a
  //                         client that elsewhere writes „die Inhaberin oder der
  //                         Inhaber“ would be one voice contradicting another.
  //   stream (noun)       → **der Stream**, and the compound **Streamqualität**.
  //                         A naturalised German noun, in Duden, declined;
  //                         *Übertragungsqualität* is broadcast-engineering
  //                         German and nobody says it about a screen share.
  //   hang up / disconnect→ **Verbindung trennen**. One phrase for the sidebar
  //                         button and the dock button, which are the same
  //                         button drawn twice.
  //   reconnect / rejoin  → **erneut beitreten** for the room, **wieder
  //                         aufnehmen** for a call the client is re-establishing
  //                         on its own (`voice.error.followServer`).
  //   ring / incoming     → **eingehend** („Eingehendes Gespräch“). The ringing
  //                         itself is never named, because the card never says
  //                         it in English either.
  //   noise suppression   → **die Rauschunterdrückung** für die Funktion,
  //                         **das neuronale Modell** für die zuschaltbare
  //                         Option. Englisch alternierte hier früher zwischen
  //                         "suppression" und "cancellation" für ein und
  //                         dieselbe Sache, und dieses Glossar hat die beiden
  //                         damals bewusst zusammengelegt. Englisch zieht die
  //                         Linie inzwischen an der richtigen Stelle, nämlich
  //                         zwischen Funktion und Modell; siehe die Notiz bei
  //                         `voice.noise.reason.load-failed`.
  //   input / output      → **Mikrofon** / **die Ausgabe**. Not *Eingang* und
  //                         *Ausgang*, which are sockets on a mixing desk;
  //                         the panel is choosing a device, and the device on
  //                         the input side is always a microphone.
  //   region              → **die Region**. Fixed by `guild.voice.regions.title`
  //                         and `channel.voice.regionLabel`; the identifiers
  //                         themselves are never touched.
  //   bitrate / kbps      → **Bitrate** / **kbps**, per `channel.voice.bitrateValue`.
  //                         Neither occurs in this fragment, but the stage
  //                         quality picker is one product decision away from
  //                         showing them, so the ruling stands recorded.
  //   SFU                 → **die SFU**, untranslated and feminine, exactly as
  //                         `channel.voice.regionHint` decided (agreeing with
  //                         *Einheit*, which the U expands to). Note that
  //                         `guild.voice.probe.unreachable.body` above says
  //                         „ein privater SFU“ — masculine — which is a sibling
  //                         inconsistency, not a precedent; it is flagged in the
  //                         report and this fragment does not copy it.
  //   relay               → **das Relay**, untranslated, per the note over the
  //                         voice-regions block above.
  //   pop out             → **Bild-in-Bild**, ein Name für alle vier Stellen.
  //                         Both Bild-in-Bild and Bild-im-Bild circulate in
  //                         German; Chrome says Bild-in-Bild, and the sentences
  //                         in this file that use the term are sentences *about
  //                         the browser* („Dieser Browser unterstützt
  //                         Bild-in-Bild nicht.“), so they should say what the
  //                         browser says. Englisch sagte an drei Stellen "Pop
  //                         out" und an einer "picture in picture"; dieses
  //                         Glossar hat das nie mitgemacht, und Englisch ist
  //                         inzwischen auf einen Namen ("pop out")
  //                         zusammengezogen.
  //   stage / dock / tile → not translated, because they are never on screen.
  //                         „Bühne“, „Dock“ and „Kachel“ appear nowhere below:
  //                         English names these surfaces only in its comments,
  //                         and a German word invented for a thing the reader
  //                         never sees is a word two translators will disagree
  //                         about later. Where the grid has to be named at all
  //                         it is **das Raster** (`voice.tile.collapse`).
  //
  // Four terms of art in the brief do not occur in this fragment and are
  // therefore not invented here: push-to-talk, voice activity (Sprachaktivität),
  // gain (die Verstärkung), echo cancellation (Echounterdrückung), jitter,
  // packet loss and bandwidth. The first two live in the settings namespace,
  // the rest are not surfaced by any voice component today. Whoever adds them
  // should add them to this list in the same breath.
  //
  // Three grammatical habits run through everything below and are not restated
  // at each entry.
  //
  // **An unknown gender never gets an article or an adjective ending.** `{who}`,
  // `{caller}`, `{name}`, `{label}`, `{device}`, `{region}`, `{provider}`,
  // `{host}`, `{channel}` and `{quality}` are data. German cannot know whether
  // what arrives is der, die or das, and half of them are not German nouns at
  // all. Four devices keep every such sentence grammatical, all of them already
  // used by the guild fragment above: a possessive built with **von** instead of
  // the genitive-s („Kamera von {who}“, never „{who}s Kamera“, which also breaks
  // on every name ending in s, z or x and on every name in a script that has no
  // apostrophe); a **preceding German noun** that the later pronoun can agree
  // with („die Region {region}“, „ein Frame von {provider}“ … „die Gegenseite“);
  // an **ending-free participle** where a predicate is needed; and German
  // quotation marks „ “ where a value has to be cited rather than used.
  //
  // **A screen reader hears most of this file and a sighted reader sees almost
  // none of it.** Every control on the dock, every control on a tile, both
  // buttons on the ringing card and the whole mini view are icons. Their German
  // is therefore written as a complete spoken phrase — „Gespräch von {caller}
  // ablehnen“, not „Ablehnen“ — even where the English is shorter, and it is
  // never abbreviated to the width of the square it belongs to, because the
  // square is not what reads it.
  //
  // **Buttons take the infinitive, states take a participle.** German marks the
  // difference English leaves to context, and this file has both in the same
  // 2x2 grid: „Stummschalten“ is an offer, „Stummgeschaltet“ is a fact about the
  // person. Wherever English has one word doing both jobs, the German splits
  // them, and the note on the entry says which one it chose and why.

  // ----------------------------------------------- the sidebar connection bar

  // One word, matching `channel.type.voice.name` above exactly: this is the
  // same room type named in the same client, and a card that says „Sprache“
  // where the channel list said „Sprache“ is the point.
  'voice.bar.channel': 'Sprache',
  // The `chat` namespace is not translated yet and will need the same word for
  // its own `chat.forward.directMessage`; „Direktnachricht“ is the compound
  // German actually uses for a DM (Privatnachricht is what a forum from 2004
  // called it), and it is recorded here so the two agree when chat arrives.
  'voice.bar.directMessage': 'Direktnachricht',

  // The progressive form German builds with „wird“, matching `common.loading`
  // („Wird geladen…“) and `common.saving` above. Not „Verbinde…“, which is
  // first-person singular and makes the app the speaker — this catalogue has
  // been careful everywhere else not to let the software say "I".
  'voice.bar.connecting': 'Wird verbunden…',
  // The English comment insists this names the subsystem rather than saying a
  // bare "Connected", because the sidebar has several things in it that could
  // be connected. German gets that for free by compounding: Sprachverbindung is
  // one word that can only mean this one connection, and „steht“ is what German
  // says about a connection that has come up — „Die Verbindung steht“ — where
  // „ist verbunden“ would be the passive of the act rather than the state.
  'voice.bar.connected': 'Sprachverbindung steht',

  // Two genuinely different answers, as the English comment says. „Wird
  // gemessen“ keeps the same wird-construction as `voice.bar.connecting` two
  // lines up, which is what makes the two read as one status line with two
  // moods rather than as two unrelated strings. No ellipsis, because English
  // has none here and the meter's animation is already saying "ongoing".
  'voice.bar.measuring': 'Wird gemessen',
  // UNTRANSLATED: `ms`. A unit symbol from the SI, identical in German, and the
  // space in front of it is the same space German typography wants. The number
  // arrives rounded and goes through `Intl.NumberFormat`, so a locale that
  // writes its digits differently is already handled without this line moving.
  'voice.bar.ping': '{ms} ms',

  // „Trennen“ alone is what a router dialog says; the object is named because
  // this is also the accessible name of an icon button, and „Verbindung
  // trennen“ is the whole spoken sentence. Identical to `voice.dock.disconnect`
  // below on purpose — same button, two places, one word.
  'voice.bar.disconnect': 'Verbindung trennen',
  // The landmark name of the 2x2 grid. Distinct from `voice.stage.controls`
  // („Gesprächssteuerung“) exactly as English keeps "Voice controls" distinct
  // from "Call controls": a screen reader user moving between the sidebar and
  // the stage has to be able to tell which toolbar they landed in.
  'voice.bar.toolbar': 'Sprachsteuerung',

  // **mute.** „Stumm“ is not a choice so much as a debt already incurred:
  // `errors.timed_out` above says „Du bist hier bis … stummgeschaltet“, and the
  // word family (stummschalten, Stummschaltung, stummgeschaltet) is what every
  // German conferencing tool, every television remote and every phone uses for
  // "cannot be heard". It builds all three forms this grid needs without a
  // seam, which is the property that matters: the square offers
  // „Stummschalten“, the same square later states „Stummgeschaltet“, and the
  // moderator's version is the same participle with an agent in front of it.
  //
  // „Vom Server stummgeschaltet“ rather than „Server-stumm“ or any other
  // compression. It is twenty-six characters against English's twelve in a
  // fixed-width square, and it is kept: the header of this catalogue says
  // nothing is shortened to fit, and the arm that sets the truncation for the
  // whole grid is precisely the arm where a layout bug most deserves to be
  // visible. „Vom Server“ and not „Von der Moderation“ for the reason the
  // English comment gives — the flag can come from a moderator, an automod rule
  // or the guild's own configuration, and the server is the only honest agent.
  //
  // The bare `muted` arm is the state where the microphone square is shut by
  // the headphone square beside it. It stays the bare participle, with no „weil
  // …“ appended, because the square next to it is already saying why and
  // because German would have to guess a clause order that the layout, not the
  // language, decides.
  //
  // The arm NAMES (`serverMuted`, `muted`, `unmute`, `other`) are the
  // component's vocabulary and are not touched; translating one deletes a
  // branch and drops the message silently into `other`.
  'voice.bar.mic': '{state, select, serverMuted {Vom Server stummgeschaltet} muted {Stummgeschaltet} unmute {Stummschaltung aufheben} other {Stummschalten}}',
  // **deafen — the hard one, argued here and then held for all 226 keys.**
  //
  // German has no idiomatic split for mute/deafen, and Discord's own German
  // build is the proof: it has shipped „Stummschalten“ for mute beside „Ton
  // aus“, „Audio stummschalten“ and „Taubstellen“ for deafen in different
  // versions of the same product, which is how a person ends up believing the
  // two squares do the same thing. So the choice has to be made on its merits
  // rather than by citation, and there were three real candidates.
  //
  //   1. **Ton aus / Ton an.** Short, obvious, and wrong in the one place it
  //      matters: „Ton aus“ is what you would also call muting a video, and the
  //      square next to it is *also* about Ton. Worse, deafening closes your
  //      microphone as well, and „Ton aus“ says nothing about that, so the
  //      person who presses it and then speaks has been actively misled. It
  //      also cannot form the moderator's version: „Vom Server Ton aus“ is not
  //      German.
  //   2. **TeamSpeak's Mikrofon / Lautsprecher split.** The most respectable
  //      precedent in German voice chat, and it fails twice here. It lies to
  //      everyone wearing headphones, and it makes the second square sound like
  //      an output-device setting sitting one panel away from the actual
  //      output-device setting (`voice.devices.output`).
  //   3. **stumm / taub.** Chosen. It mirrors the English pair morpheme for
  //      morpheme, it is productive in exactly the forms the grid needs
  //      (taubschalten, Taubschaltung, taubgeschaltet), it composes with the
  //      agent („Vom Server taubgeschaltet“) the same way stumm does, and it is
  //      immediately legible next to its partner *because* the two words rhyme
  //      structurally. Two squares that share a construction read as two halves
  //      of one control, which is what they are.
  //
  // The objection to 3 is that „taub“ is a word about deaf people, and a client
  // that labels a person „Taub“ would deserve the complaint. That is why every
  // arm here is the compound participle and never the bare adjective:
  // „taubgeschaltet“ is formed exactly like „stummgeschaltet“ and is
  // transparently a statement about a switch in a program, not about a person's
  // hearing — the same distinction German makes between „stumm“ (mute, of a
  // person) and „stummgeschaltet“ (muted, of a channel). `voice.tile.deafened`
  // below is the one place this is load-bearing and it is handled there.
  'voice.bar.deafen': '{state, select, serverDeafened {Vom Server taubgeschaltet} undeafen {Taubschaltung aufheben} other {Taubschalten}}',

  // Word for word the same as the dock's equivalents below, because they are
  // the same two buttons in two places and a person can see both at once.
  // „Ein-/ausschalten“ rather than „an/aus“: the camera is a device that is
  // switched, and the infinitive is what a button says in German.
  'voice.bar.videoStart': 'Kamera einschalten',
  'voice.bar.videoStop': 'Kamera ausschalten',
  // „Bildschirm teilen“ is the settled German and was already chosen above at
  // `channel.type.voice.description`, with the reason recorded there: „Bildschirm
  // freigeben“ is enterprise-tool German and would collide with Freigabe, which
  // this catalogue has spent on bot grants.
  'voice.bar.shareStart': 'Bildschirm teilen',
  // The object is dropped on the stop side exactly as English drops it, because
  // by then there is a share on screen and „Teilen beenden“ can only mean that
  // one. Identical to `voice.screen.stopSharing` and to the dock's `yes` arm.
  'voice.bar.shareStop': 'Teilen beenden',

  // ------------------------------------------------------------- the dock

  // Tooltips and accessible names at once, so every one is an infinitive
  // naming what the press will do — never the current state. German keeps that
  // distinction visibly (infinitive vs. participle), which is why these read as
  // offers where `voice.tile.muted` below reads as a fact.
  'voice.dock.camera': '{on, select, yes {Kamera ausschalten} other {Kamera einschalten}}',
  'voice.dock.mic': '{muted, select, yes {Stummschaltung aufheben} other {Stummschalten}}',
  'voice.dock.deafen': '{deafened, select, yes {Taubschaltung aufheben} other {Taubschalten}}',
  'voice.dock.share': '{on, select, yes {Teilen beenden} other {Bildschirm teilen}}',
  'voice.dock.disconnect': 'Verbindung trennen',
  // The arm is named after the `facingMode` currently in force, so
  // `environment` means the back camera is live and the press goes to the front
  // one — the arm name is a DOM constant and stays. „Frontkamera“ and
  // „Rückkamera“ are the words German phone manuals use; „vordere/hintere
  // Kamera“ would be a description rather than the name of the thing.
  'voice.dock.flip': '{facing, select, environment {Zur Frontkamera wechseln} other {Zur Rückkamera wechseln}}',
  // The feature's name, and it must match `voice.watch.title` below word for
  // word — English says so and German has the same obligation. The `yes` arm
  // nominalises it („das gemeinsame Ansehen“), which is how German ends a thing
  // whose name is a verb phrase.
  //
  // Dieser Eintrag stand hier schon richtig, als Englisch im `yes`-Arm noch
  // "End watch party" sagte — ein zweiter Name für dasselbe Feature, den die
  // Übersetzung bewusst nicht mitgemacht hat. Englisch sagt jetzt "End
  // watching together"; der deutsche Wert bleibt deshalb unverändert und ist
  // nur neu abgestempelt worden.
  'voice.dock.watch': '{on, select, yes {Gemeinsames Ansehen beenden} other {Gemeinsam ansehen}}',

  // ----------------------------------------------------------- the stage

  // „noch“ carries the whole tone of the English "yet": the room is not broken,
  // it is early. Without it the sentence reads as a verdict.
  'voice.stage.emptyTitle': 'Hier ist noch niemand',
  // The default for a voice channel; a DM passes its own words in, which is why
  // this may name the channel. „Dem Sprachkanal beitreten“ rather than „Sprache
  // beitreten“, which is not German — English can use "voice" as a place name
  // and German cannot, so the German says which place.
  'voice.stage.join': 'Dem Sprachkanal beitreten',
  'voice.stage.rejoin': 'Erneut beitreten',
  // The stage's landmark name, kept distinct from `voice.bar.toolbar` above.
  'voice.stage.controls': 'Gesprächssteuerung',

  // Autoplay. „zurückhalten“ is the verb German uses for something withheld
  // pending a condition, which is exactly the browser's posture, and it avoids
  // implying a fault. „bis du etwas auf der Seite tust“ rather than „anklickst“:
  // a keypress counts as interaction too, and a sentence that names only the
  // click sends keyboard users looking for a mouse.
  'voice.stage.audioBlocked': 'Dein Browser hält den Ton dieses Gesprächs zurück, bis du etwas auf der Seite tust.',
  'voice.stage.resumeAudio': 'Ton abspielen',

  // Both branch on whose it is rather than interpolating a name for "you", for
  // the reason English gives and one more: German would need „dein/deine“ to
  // agree with the medium, and the two media have different genders (der
  // Bildschirm, die Kamera), so even the first-person form cannot be assembled.
  // The `other` arm is the bare name, as in English — an icon has already said
  // which medium this is.
  'voice.stage.shareName': '{mine, select, yes {Dein Bildschirm} other {{who}}}',
  'voice.stage.cameraName': '{mine, select, yes {Deine Kamera} other {{who}}}',
  // SCREEN-READER ONLY. A dot on a button; the dot is not a word, so the word
  // lives here. „Neu“ is endingless and therefore agrees with nothing, which is
  // what it needs to be: it is read out beside a name this file did not write.
  'voice.stage.newShare': 'Neu',

  // The claim the whole media path exists to make. „mithören“ is the exact
  // German for listening in on a conversation you are carrying — „ohne es hören
  // zu können“ would be about acoustics, „ohne mithören zu können“ is about
  // access, and access is the claim. „trägt es weiter“ keeps the server as a
  // carrier rather than a party.
  'voice.stage.sealedNotice': 'Dieses Gespräch ist Ende-zu-Ende-verschlüsselt. Der Server trägt es weiter, ohne mithören zu können.',

  // ------------------------------------------------------------- the tiles

  // SCREEN-READER ONLY, both of them: these are the accessible name on the
  // video element and the only thing a screen reader has, which is why they
  // name the medium as well as the person even though the picture makes it
  // obvious to everyone else.
  //
  // „Kamera von {who}“ and never „{who}s Kamera“. The genitive-s is the English
  // possessive translated rather than the German one: it breaks on every name
  // ending in s, z or x (where German writes an apostrophe), it is wrong for
  // names that are not nominative-shaped, and it glues a wire value directly to
  // a German morpheme. „von“ takes the dative, and names do not inflect in the
  // dative, so the construction is safe whatever arrives.
  'voice.tile.cameraLabel': '{mine, select, yes {Deine Kamera} other {Kamera von {who}}}',
  // English builds both directions from a name plus a suffix and says in its
  // own comment that this is a fact about English. German proves it: the
  // placeholder has to move to the front of the object phrase in `expand`
  // („Video von {who} vergrößern“) and the verb goes last, which is the ordering
  // no component could have assembled. The two directions are also genuinely
  // different sentences — you enlarge a *video* and you send a *person* back to
  // the grid — and German keeps that asymmetry rather than tidying it away.
  'voice.tile.expand': '{mine, select, yes {Dein Video vergrößern} other {Video von {who} vergrößern}}',
  // „Raster“ is the grid, named here because the sentence needs a destination;
  // it is the only place in this fragment where a layout surface gets a German
  // name at all. „zurück ins Raster holen“ rather than „zurücksetzen“, which
  // would sound like discarding a setting.
  'voice.tile.collapse': '{mine, select, yes {Dein Video zurück ins Raster holen} other {{who} zurück ins Raster holen}}',

  // States, not offers: participles, and the contrast with the dock's
  // infinitives two sections up is doing real work. These are also repeated for
  // anything that cannot see the coloured glyph they sit beside, so they are
  // whole words and not abbreviations.
  //
  // „Taubgeschaltet“ is the entry the deafen argument at `voice.bar.deafen` was
  // really about, because this one is drawn on a *person's* name plate. It is
  // the compound participle for that reason: it says a switch is set in a
  // program, the way „Stummgeschaltet“ beside it does, and it is not the bare
  // adjective that would be a statement about the person.
  'voice.tile.muted': 'Stummgeschaltet',
  'voice.tile.deafened': 'Taubgeschaltet',

  // Corner pills, dropped entirely on a compact tile rather than truncated, so
  // length is a matter of taste here and not of breakage.
  'voice.tile.noMic': 'Kein Mikrofon',
  'voice.tile.camera': 'Kamera an',
  // Possessive on purpose: the whole point is that the choice is still yours
  // and is one click from being given up. „Deine Auswahl“ rather than „Deine
  // Wahl“, which in German is the act of choosing; Auswahl is the thing chosen.
  'voice.tile.yourPick': 'Deine Auswahl',

  'voice.tile.more': 'Mehr',
  // The mode, not the gesture. Englisch alternierte zwischen "Pop out" hier und
  // "picture in picture" drei Schlüssel weiter für ein Feature; Deutsch hat
  // durchgehend einen Namen benutzt, was Menüeintrag und Fehlermeldung als
  // dieselbe Sache erkennbar macht. Englisch sagt jetzt ebenfalls überall
  // dasselbe; an den deutschen Werten ändert das nichts.
  'voice.tile.pip': 'Bild-in-Bild',
  // Two sliders that must be told apart at a glance, because somebody turning
  // down a screen share almost always still wants to hear the person talk.
  // „Lautstärke“ is the person; „Ton des Bildschirms“ is the share. Not
  // „Bildschirmton“ as one compound: the two labels sit one above the other and
  // a compound would put „Ton“ at the end of one line and at the start of the
  // other, which is the one place a glance goes wrong.
  'voice.tile.volume': 'Lautstärke',
  'voice.tile.screenAudio': 'Ton des Bildschirms',

  // The consent button on somebody's share in an SFU room, where watching is
  // what actually asks the server to forward the picture. Three arms because a
  // narrow tile drops to the bare verb: `stop` is that narrow form and is the
  // interjection-shaped „Stopp“, which is what German puts on a button with no
  // room for an object, while `stopWatching` is the full phrase. Arm names
  // untouched.
  'voice.tile.watchGate': '{state, select, stop {Stopp} stopWatching {Nicht mehr ansehen} other {Ansehen}}',

  // ------------------------------------------------------- the screen share

  // The full form, used where nothing else says which medium this is — the
  // same von-construction as `voice.tile.cameraLabel` and for the same reason.
  'voice.screen.label': '{mine, select, yes {Dein Bildschirm} other {Bildschirm von {who}}}',
  'voice.screen.fullscreen': 'Vollbild',
  // UNTRANSLATED: „Zoom“. A naturalised German noun (der Zoom, zoomen, in
  // Duden), and the word on every German camera and map control.
  'voice.screen.resetZoom': 'Zoom zurücksetzen',
  'voice.screen.stopSharing': 'Teilen beenden',

  // Four refusals that are thrown as `Error`s and land in a toast, so they are
  // sentences with full stops and not developer strings. All four are phrased
  // as facts rather than as advice, because there is nothing here to fix.
  // „ließe“ — the subjunctive — is what German uses for a thing that does not
  // exist to be acted on, and it is what keeps these from reading as accusations.
  'voice.screen.noScreen': 'Es gibt keinen Bildschirm, der sich zeigen ließe.',
  'voice.screen.noFullscreen': 'Dieser Browser geht nicht in den Vollbildmodus.',
  'voice.screen.noVideo': 'Es gibt kein Video, das sich in Bild-in-Bild öffnen ließe.',
  'voice.screen.noPip': 'Dieser Browser unterstützt Bild-in-Bild nicht.',

  // The four rungs of `WATCH_QUALITIES`. „Streamqualität“ as one compound: der
  // Stream is a German noun in ordinary use and this is the quality *of* it, so
  // German compounds rather than saying „Qualität des Streams“, which would
  // read as a judgement on a particular stream rather than as the name of a
  // setting.
  'voice.quality.label': 'Streamqualität',
  // Must match `voice.region.auto` and `voice.route.automatic` below and
  // `channel.voice.regionAuto` above, all of which are the same offer made by
  // four different pickers. One word, four places.
  'voice.quality.auto': 'Automatisch',
  'voice.quality.low': 'Niedrig',
  'voice.quality.medium': 'Mittel',
  'voice.quality.high': 'Hoch',

  // The pill naming which encoder bet is in force. „Detail“ is the German noun
  // unchanged (das Detail); „Bewegung“ is translated because Motion here is the
  // ordinary word and not a codec term.
  'voice.preset.detail': 'Detail',
  'voice.preset.motion': 'Bewegung',
  // TRANSLATED, and the translation happens to be spelled the same: „live“ is a
  // German adverb and adjective in Duden („live übertragen“, „eine Live-
  // Sendung“), arrived through broadcasting decades ago. It is not on the
  // untranslated list — nothing was left alone here, the German word simply is
  // this one. The fallback for a share from a client that sends no preset.
  'voice.preset.live': 'Live',

  // --------------------------------------------------------- the chat toggle

  // TRANSLATED, spelled the same, by the same reasoning the guild fragment
  // recorded for „Bot“: der Chat is a fully naturalised German noun, declined
  // (des Chats, die Chats), and „Unterhaltung“ is taken by the DM thread.
  'voice.chat.label': 'Chat',
  // Two keys and not one because the visible word is the noun and the tooltip
  // is the action; German marks that difference with the infinitive.
  'voice.chat.toggle': '{open, select, yes {Chat schließen} other {Chat öffnen}}',
  'voice.chat.toggleMentions': '{open, select, yes {Chat schließen} other {Chat öffnen}}, {count, plural, one {# Erwähnung} other {# Erwähnungen}}',
  'voice.chat.toggleUnread': '{open, select, yes {Chat schließen} other {Chat öffnen}}, ungelesen',

  // ------------------------------------------------- Android's output picker

  // Android owns this list and hands over labels already in the system
  // language.
  'voice.route.title': 'Audioausgabe',
  'voice.route.finding': 'Ausgaben werden gesucht…',
  // UNTRANSLATED: `{label}`, and deliberately so — it is Android's own word for
  // the route („Bluetooth“, „Hörmuschel“, the automatic route's own label),
  // already localised by the platform. The tick is a prefix rather than a
  // column because the sheet is a plain menu, and the two arms exist precisely
  // so that a language marking the current choice some other way can; German
  // marks it exactly as English does, so the arms are identical in shape. The
  // arm names stay.
  'voice.route.option': '{state, select, selected {✓ {label}} other {{label}}}',
  // Only ever shown before the bridge answers; once it has, Android's own
  // `automatic_label` replaces this. Same word as the three other automatic
  // options in this fragment.
  'voice.route.automatic': 'Automatisch',
  'voice.route.unsupported': 'Dieses Gerät bietet keine Auswahl der Audioausgabe.',

  // -------------------------------------------- the desktop device panel

  'voice.devices.title': 'Audiogeräte',
  // English's "what this call listens to, and where it plays" is two relative
  // clauses hung off one verb, which German cannot do with these two verbs.
  // Split into the two questions the panel actually answers, in the same order.
  'voice.devices.subtitle': 'Worauf dieses Gespräch hört und wo es abgespielt wird.',
  // The tooltip on the trigger, which says what the panel is *for* rather than
  // repeating its name — so it names both ends of the path.
  'voice.devices.open': 'Mikrofon und Ausgabe wählen',
  'voice.devices.refreshing': 'Wird aktualisiert…',

  // The input side is always a microphone, so it is named one; see the glossary.
  'voice.devices.input': 'Mikrofon',
  'voice.devices.output': 'Ausgabe',
  // „Standard des Systems“ and not „Systemstandard“: the genitive says *whose*
  // default this is, which is the entire point of the English wording, where
  // the compound would name a kind of default. The guild fragment made the same
  // call at `guild.voice.serverDefault` („Standard des Servers“) and these two
  // lists are read by the same person on the same afternoon. Two identical
  // strings under two keys, because the microphone list and the output list are
  // separate lists and a language that genders the default by device would need
  // them apart.
  'voice.devices.defaultMic': 'Standard des Systems',
  'voice.devices.defaultSpeakers': 'Standard des Systems',

  // UNTRANSLATED: `{id}` — the first six characters of the hardware identifier,
  // which is a machine value and the only thing telling two unnamed devices
  // apart across a refresh. `{n}` is this entry's position and is formatted by
  // `Intl`. German counts after the noun exactly as English does here, so the
  // order survives; the point of the two values being values is that a language
  // that wanted the identifier first could say so.
  'voice.devices.unnamedMic': 'Mikrofon {n} ({id})',
  'voice.devices.unnamedOutput': 'Ausgabe {n} ({id})',

  // What sits between the microphone and the network. One German word for what
  // English calls suppression here and cancellation four keys down.
  'voice.devices.noise': 'Rauschunterdrückung',
  // Matching `common.off` / `common.on` above, because this is the same off in
  // the same client.
  'voice.devices.noiseOff': 'Aus',
  // UNTRANSLATED: „Browser“. A German noun (der Browser) and, more to the
  // point, the name of the thing being distinguished: this option is WebRTC's
  // own suppressor, which is already there and costs nothing, and the label has
  // to name the browser to make that distinction at all.
  'voice.devices.noiseBrowser': 'Browser',
  // One option, two states, one message — so that German can put the qualifier
  // where it belongs instead of receiving a word with a parenthesis stuck on.
  // „Neuronal“ is the established German for a neural network model; „neural“
  // exists as a loan but means the anatomical nerve in careful usage. The
  // measuring arm keeps the wird-construction the rest of this file uses for an
  // action in progress.
  'voice.devices.noiseNeural': '{state, select, measuring {Neuronal (wird gemessen…)} other {Neuronal}}',

  // The semicolon is kept because the second clause is the useful half: it is
  // not that nothing happens, it is that the system decides. „er folgt dem
  // System“ — „er“ agrees with *der Browser*, a gender this sentence itself
  // supplied two words earlier rather than one that arrived on the wire.
  'voice.devices.noSinkId': 'Dieser Browser kann die Ausgabe nicht wählen; er folgt dem System.',

  // Two failures from the microphone-switching path, both thrown, both about a
  // running call rather than a setting — which is why neither is advice.
  // „übertragen“ and not „veröffentlichen“ for WebRTC's *publish*: German media
  // engineering says übertragen, and veröffentlichen would suggest the
  // microphone was posted somewhere.
  'voice.devices.micPublishFailed': 'Das Gespräch hat das neue Mikrofon nicht übertragen.',
  'voice.devices.micSwitchUnsupported': 'Dieses Gespräch kann das Mikrofon nicht wechseln, während es läuft.',

  // --------------------------------------------- why the neural model cannot

  // Keyed by the machine reason the probe returns. The hyphenated key segments
  // are the probe's own vocabulary and are copied character for character, so
  // that grepping either half finds the other; a build meeting a reason it has
  // never heard of falls through to `voice.noise.cannot` rather than putting a
  // token on screen.
  //
  // UNTRANSLATED across this block: `Web Audio API`, `WebAssembly`, `CPU`,
  // `https`, `48 kHz` and „Thread“. The first four are names of web platform
  // features and a specification, spelled as the documentation the reader would
  // go and find spells them; `48 kHz` is a number and an SI-derived unit
  // symbol; „Thread“ is the loanword the guild fragment already naturalised
  // („der Thread“, declined, in Duden) and the word German developer
  // documentation uses for exactly this.
  'voice.noise.reason.no-audio-worklet': 'Dieser Browser kann Audioverarbeitung nicht außerhalb des Haupt-Threads ausführen.',
  'voice.noise.reason.no-audio-context': 'Dieser Browser stellt die Web Audio API nicht bereit.',
  // The parenthetical stays a parenthetical: „sicher“ alone would invite the
  // question this sentence is trying to answer, and the scheme is what the
  // reader can actually check in their address bar.
  'voice.noise.reason.insecure-context': 'Audioverarbeitung braucht eine sichere Verbindung (https).',
  'voice.noise.reason.no-wasm': 'Dieser Browser führt auf dieser Seite kein WebAssembly aus.',
  // „abstellen“ in the sense of assigning a resource to a job, which is what
  // the English "spare one for" means; „übrig haben“ would be about idleness
  // and this is about capacity.
  'voice.noise.reason.one-core': 'Dieses Gerät hat zu wenige CPU-Kerne, um einen davon für das Modell abzustellen.',
  'voice.noise.reason.no-48k': 'Die Audio-Hardware dieses Geräts läuft nicht mit 48 kHz.',
  'voice.noise.reason.too-slow': 'Dieses Gerät ist nicht schnell genug, um das Modell in Echtzeit auszuführen.',
  // Diese beiden hießen „das Modell zur Rauschunterdrückung“, solange Englisch
  // hier "noise-cancellation model" sagte und in der zugehörigen Einstellung
  // "noise suppression" — eine Unterscheidung, die es nicht gab, weshalb
  // Deutsch damals absichtlich ein Wort für beides benutzte.
  //
  // Englisch unterscheidet jetzt sauber: „Rauschunterdrückung“ ist die
  // Funktion, „das neuronale Modell“ ist die zuschaltbare Option, die nicht
  // laden kann — und genau das steht auf der Karte, die der Mensch angeklickt
  // hat (`voice.devices.noiseNeural`: „Neuronal“). Deutsch hatte das Wort
  // ohnehin schon in `voice.noise.cannot` und `voice.noise.fellBack`; diese
  // beiden Zeilen benutzen es nun ebenfalls, damit im selben Toast-Verlauf
  // nicht zwei Namen für dieselbe Sache stehen.
  'voice.noise.reason.load-failed': 'Das neuronale Modell ließ sich nicht laden.',
  // „vermessen“ rather than „messen“: the probe measures the model's
  // throughput, a completed act of measurement on an object, which is what the
  // ver- prefix carries.
  'voice.noise.reason.no-measurement': 'Das neuronale Modell ließ sich nicht vermessen.',
  'voice.noise.cannot': 'Dieses Gerät kann das neuronale Modell nicht ausführen.',
  // Said once, when a call gives up mid-flight and writes the preference back
  // to `browser`. The second half is the part worth saying, and German keeps it
  // in second position for the same reason English does: it is the reassurance,
  // and it should be the last thing read. „kam nicht mit“ is the colloquial
  // German for failing to keep up, which suits the du of this app better than
  // „konnte nicht Schritt halten“.
  'voice.noise.fellBack': 'Das neuronale Modell kam nicht mit, deshalb ist dieses Gespräch auf die Rauschunterdrückung des Browsers umgeschaltet.',

  // ---------------------------------------------------- joining and leaving

  // The single most important sentence in the file: what somebody reads when a
  // call has connected and they cannot be heard. The consequence is repeated in
  // full in every arm on purpose, and German is the language that proves why —
  // the clause order is not portable, and a translation that had been handed
  // three fragments would have had to choose between them.
  //
  // UNTRANSLATED: „Telium“ (product) and „Android“ (platform). „App-
  // Einstellungen von Android“ rather than „Androids App-Einstellungen“: the
  // von-construction again, and it also matches what the Android settings app
  // is actually called in German.
  //
  // `androidDenied` is separate from `denied` because the remedy is somewhere
  // else entirely, and the German has to keep them separate for a second
  // reason: „Website-Berechtigungen“ and „App-Einstellungen“ are both fixed
  // German UI strings the reader will go looking for, and neither can be
  // paraphrased into the other.
  //
  // „du hörst das Gespräch, kannst darin aber nicht sprechen“ puts the loss
  // last, where German puts new information, and „darin“ carries the call
  // forward without repeating it. The semicolon is kept: it is the join English
  // chose to mark cause from consequence and German punctuates it the same way.
  'voice.call.noMic': '{reason, select, androidDenied {Die Berechtigung für das Mikrofon wurde verweigert. Erlaube Telium das Mikrofon in den App-Einstellungen von Android; du hörst das Gespräch, kannst darin aber nicht sprechen.} denied {Die Berechtigung für das Mikrofon wurde verweigert. Erlaube sie in den Website-Berechtigungen deines Browsers; du hörst das Gespräch, kannst darin aber nicht sprechen.} missing {Auf diesem Gerät wurde kein Mikrofon gefunden; du hörst das Gespräch, kannst darin aber nicht sprechen.} other {Das Mikrofon ließ sich nicht öffnen; du hörst das Gespräch, kannst darin aber nicht sprechen.}}',

  // The camera's version of the same three refusals, shorter because a camera
  // that will not open is not the emergency a microphone that will not open is.
  // „Erlaube sie“ — „sie“ agrees with *die Berechtigung*, which the sentence
  // named itself one clause earlier; nothing here agrees with wire data.
  'voice.call.cameraRefused': '{reason, select, androidDenied {Die Berechtigung für die Kamera wurde verweigert. Erlaube Telium die Kamera in den App-Einstellungen von Android.} denied {Die Berechtigung für die Kamera wurde verweigert. Erlaube sie in den Website-Berechtigungen deines Browsers.} missing {Auf diesem Gerät wurde keine Kamera gefunden.} other {Die Kamera ließ sich nicht öffnen.}}',

  // Four things a call's transport simply cannot do, phrased as facts about
  // this call rather than as errors: there is nothing to retry. „kann kein Video
  // übertragen“ keeps the transport as the subject, which is the honest agent —
  // „Video ist hier nicht möglich“ would sound like a policy.
  'voice.call.noCameraSupport': 'Dieses Gespräch kann kein Video übertragen.',
  'voice.call.noScreenShareSupport': 'Dieses Gespräch kann keinen geteilten Bildschirm übertragen.',
  'voice.call.noFlipSupport': 'Dieses Gespräch kann die Kamera nicht wechseln.',
  'voice.call.noAlternateCamera': 'Dieses Gerät hat keine zweite Kamera, auf die sich wechseln ließe.',

  // Sealing a conversation's call. Both are thrown before a packet moves, so
  // both mean the call is not going to happen — not that something broke during
  // it. These are the two keys where Unterhaltung and Gespräch stand in one
  // sentence and the glossary's distinction earns its keep: the Unterhaltung is
  // the thread that has no keys yet, the Gespräch is what cannot be sealed
  // because of it.
  'voice.call.noKeys': 'Diese Unterhaltung hat noch keine Gesprächsschlüssel, deshalb lässt sich das Gespräch nicht versiegeln.',
  // UNTRANSLATED: „SFU“ — a protocol term (selective forwarding unit) the
  // reader has just met in their own relay's documentation, exactly as
  // `guild.nav.voice` argued above. Feminine here and everywhere below, per
  // `channel.voice.regionHint`: *die SFU*, agreeing with Einheit.
  'voice.call.sfuAddressUnknown': 'Diese Unterhaltung sagt nicht, welche SFU angerufen werden soll.',
  // A guild's server offered an SFU without end-to-end encryption. Refused
  // outright: the alternative is a call the server can listen to.
  'voice.call.sfuNotEncrypted': 'Dieser Server hat kein Ende-zu-Ende-verschlüsseltes Gespräch angeboten, deshalb wurdest du nicht verbunden.',

  // Three separate things can move and they stay three messages, because a
  // person who sees the same sentence twice assumes the second one is a
  // repaint. `mode` is the component's narrowed token, not the server's string.
  'voice.call.moved': '{mode, select, sfu {Das Gespräch läuft jetzt über eine SFU.} other {Das Gespräch läuft jetzt über direkte Verbindungen.}}',
  // `{region}` is an identifier the deployment minted and is never touched. It
  // is preceded by „die Region“ so that the German article agrees with a noun
  // this file wrote rather than with a value whose gender nobody can know —
  // „in die {region}-Region“ would have had to guess, and „in {region}“ alone
  // would read as a place name.
  'voice.call.movedRegion': 'Die Sprachverbindung läuft jetzt über die Region {region}.',
  // „in“ and not „nach“, and the choice is load-bearing: German prepositions
  // govern a case, and the fallback below is a whole noun phrase that has to
  // be inflected to fit whichever preposition this key picks. „in“ takes the
  // accusative for movement, which „einen anderen Sprachkanal“ satisfies and a
  // bare channel name („in Allgemein“) is unaffected by.
  'voice.call.movedTo': 'Umgezogen in {channel}.',
  // The name for a channel this client has not loaded, dropped into the middle
  // of `movedTo` and used nowhere else — so it is lower case, and it is in the
  // accusative that `movedTo` requires. If anybody ever reuses this key in a
  // sentence with a different case, the fix is a second key, not an edit here.
  'voice.call.someVoiceChannel': 'einen anderen Sprachkanal',
  'voice.call.shareStoppedOnMove': 'Das Teilen deines Bildschirms endete mit dem Umzug des Gesprächs.',

  // ------------------------------------------------- refusing to dial at all

  // The three codes from `refusalCode()`. These are about the posture the
  // person chose in their privacy settings, not about a failure, and the German
  // has to make the deliberateness audible: „verlangt“ is what a requirement
  // does, and each sentence then says what was on offer instead. A call is
  // never quietly downgraded to get it through, and these three sentences are
  // where that promise is visible.
  'voice.refusal.nothing': 'Es gibt keinen Sprachserver, der sich anrufen ließe.',
  'voice.refusal.sfu': 'Deine Privatsphäre-Einstellung für Gespräche verlangt eine SFU, und dieses Gespräch hat keine.',
  // UNTRANSLATED: „Relay“, per the guild fragment's ruling — it is the word
  // German network jargon uses, and „Weiterleitung“ or „Vermittler“ would not
  // connect to anything the reader has configured.
  'voice.refusal.relay': 'Deine Privatsphäre-Einstellung für Gespräche verlangt mindestens ein Relay, und dieses Gespräch bietet weder ein Relay noch eine SFU.',

  // ----------------------------------------------------- the ringing card

  // The second line under the caller's own name, for a two-person call.
  'voice.incoming.title': 'Eingehendes Gespräch',
  // Counted, because "1 people" is the sentence that proves nobody read the
  // number. German needs `one` and `other` and nothing else; the middle dot is
  // a separator German uses the same way. „Gruppengespräch“ is one compound
  // where English has two words, which is the file doing its job.
  'voice.incoming.groupSize': '{count, plural, one {Gruppengespräch · # Person} other {Gruppengespräch · # Personen}}',
  // SCREEN-READER ONLY, alle drei. Die erste ist der Name der Karte, damit
  // etwas, das per Tastatur ankommt, weiß, wozu die beiden Knöpfe gehören; die
  // anderen beiden sind die Knöpfe selbst, die reine Symbole sind und deshalb
  // den ganzen Satz im Namen tragen müssen.
  //
  // Der `yes`-Arm schiebt den Platzhalter in die Mitte und das Verb ans Ende —
  // genau die Stellung, die der englische Kommentar meint, wenn er sagt, zwei
  // Symbolknöpfe nebeneinander unterscheiden sich in manchen Sprachen im
  // ersten und in anderen im letzten Wort. Im Deutschen ist es das letzte, und
  // es ist das einzige, das sich zwischen den beiden unterscheidet.
  //
  // Der `other`-Arm ist neu. Vorher stand dort `voice.incoming.someone`
  // („Unbekannt“) im Platzhalter, und dieser Eintrag existierte nur, weil „von“
  // den Dativ regiert: „von Jemand“ ist ungrammatisch, „von jemandem“ lässt
  // sich nicht als Name allein hinzeichnen. Das Problem verschwindet mit dem
  // Platzhalter. Ohne Namen sagt Deutsch schlicht, was der Fall ist, und
  // braucht dafür weder ein Ersatzwort noch einen Kasus.
  'voice.incoming.fromWho': '{named, select, yes {Gespräch von {caller}} other {Eingehendes Gespräch}}',
  'voice.incoming.answer': '{named, select, yes {Gespräch von {caller} annehmen} other {Gespräch annehmen}}',
  'voice.incoming.decline': '{named, select, yes {Gespräch von {caller} ablehnen} other {Gespräch ablehnen}}',
  // A `reportError` context: a noun phrase, no full stop, joined by
  // `errors.context` to whatever went wrong. The „… ließ sich nicht …“ family
  // the guild fragment committed to for all twenty-odd of these.
  'voice.incoming.joinFailed': 'Das Gespräch ließ sich nicht annehmen',

  // ------------------------------------------------- the floating mini view

  'voice.mini.call': 'Gespräch',
  // SCREEN-READER ONLY: the landmark name of the floating picture.
  // „Miniaturansicht“ is the established German for a small persistent preview
  // (it is what every German file manager calls a thumbnail), and the genitive
  // says whose it is rather than what kind it is.
  'voice.mini.region': 'Miniaturansicht des Gesprächs',
  // Matching `common.next` above, which is the same word on the same kind of
  // control.
  'voice.mini.next': 'Weiter',
  'voice.mini.expand': 'Gespräch vergrößern',
  'voice.mini.hide': 'Ausblenden',

  // The label under that picture, and the only place in the client where the
  // medium and the person are said together with no icon to help. Four keys and
  // not two with a `select`, because the mini view reads each row's label from
  // the row itself — and keeping them apart also keeps the two media
  // distinguishable in a translation tool, where four arms of two messages
  // would arrive with no context at all. Same von-possessive as everywhere else
  // in this file.
  'voice.media.screenMine': 'Dein Bildschirm',
  'voice.media.screenOther': 'Bildschirm von {who}',
  'voice.media.cameraMine': 'Deine Kamera',
  'voice.media.cameraOther': 'Kamera von {who}',

  // ------------------------------------------------- the voice channel page

  // A channel that has gone while somebody was looking at it. „Er“ in the
  // second line agrees with *der Kanal*, named in the first — a gender this
  // file owns, not one the wire supplied.
  'voice.room.goneTitle': 'Diesen Sprachkanal gibt es nicht mehr',
  'voice.room.goneBody': 'Er wurde gelöscht, oder du kannst ihn nicht mehr sehen.',

  // The three hints the page hands to the stage. „Tritt bei“ is the imperative
  // of the du this catalogue speaks; „ihn“ is the Sprachkanal again.
  'voice.room.emptyBody': 'Tritt bei, um ihn zu öffnen.',
  // The one warning anybody gets that pressing the button opens a microphone.
  // Kept to one short clause, as English keeps it, because a longer sentence
  // under a button is a sentence people stop reading.
  'voice.room.joinHint': 'Öffnet dein Mikrofon.',
  'voice.room.staleHint': 'In diesem Tab ist nichts verbunden. Tritt erneut bei oder trenne die Verbindung, um das aufzuräumen.',

  // The mobile header's subtitle, and SCREEN-READER ONLY as the name of the row
  // of faces on desktop: the faces *are* the count for anyone who can see them
  // and are nothing at all for anyone who cannot. German's two arms are
  // identical here, which is not a redundancy to be optimised away — the arms
  // are what the language asks for, per this file's header, and „# im
  // Sprachkanal“ happens not to inflect. „in Sprache“ would be the literal
  // translation of English's place-name use of "voice" and is not German.
  'voice.room.inVoice': '{count, plural, one {# im Sprachkanal} other {# im Sprachkanal}}',
  'voice.room.empty': 'Niemand hier',
  // Drawn inside a circle the size of an avatar; a bare number, as in English.
  'voice.room.more': '+{count}',
  // SCREEN-READER ONLY: the name of a stack of watcher faces on somebody's
  // share. Here the two arms genuinely differ, and not only in the noun — the
  // verb inflects too („sieht“ / „sehen“), which is the clearest demonstration
  // in this fragment of why the count and the sentence cannot be separated.
  // „Personen“ rather than „Zuschauer“, per the glossary.
  'voice.room.watching': '{count, plural, one {# Person sieht zu} other {# Personen sehen zu}}',

  // The genitive rather than „Kanal-Chat“, for the same reason as „Standard des
  // Systems“ above: this is the chat *of this channel*, not a kind of chat.
  'voice.room.chatTitle': 'Chat des Kanals',
  'voice.room.minimize': 'Minimieren',

  // Four `reportError` contexts, so four noun phrases in the „… ließ sich nicht
  // …“ family, none of them ending in punctuation because a colon and a second
  // clause follow. „ließen“ where the subject is plural.
  'voice.room.readFailed': 'Wer zusieht, ließ sich nicht ermitteln',
  'voice.room.watchFailed': 'Das Ansehen ließ sich nicht starten',
  'voice.room.unwatchFailed': 'Das Ansehen ließ sich nicht beenden',
  'voice.room.qualityFailed': 'Die Streamqualität ließ sich nicht ändern',

  // ------------------------------------------------------- the region picker

  // UNTRANSLATED throughout this block: the region names themselves, which are
  // identifiers a deployment published (`eu-west`, `staging`) and are drawn
  // exactly as they arrive. Only the furniture around them is German.
  'voice.region.title': 'Sprachregion',
  // „Näher ist meistens ruhiger“ keeps English's comparative-as-subject, which
  // German does just as readily, and „ruhiger“ keeps the acoustic metaphor
  // rather than explaining it as latency — the person choosing a region is
  // choosing by how the call sounds.
  'voice.region.subtitle': 'Worüber dieses Gespräch läuft. Näher ist meistens ruhiger.',
  'voice.region.loading': 'Regionen werden geladen',
  'voice.region.none': 'Dieser Server veröffentlicht keine Sprachregionen.',
  'voice.region.auto': 'Automatisch',
  // „gesund“ is not said of a server in German, so the health check is named by
  // its result instead — „deren Zustand in Ordnung ist“ — which also lines up
  // with `guild.voice.colHealth` above, where the column of exactly this
  // information is called „Zustand“. Longer than English; kept.
  'voice.region.autoHint': 'Den Server die nächstgelegene Region auswählen lassen, deren Zustand in Ordnung ist.',
  'voice.region.unhealthy': 'Nimmt gerade keine Gespräche an.',

  // --------------------------------------------------- the share dialog

  'voice.share.title': 'Deinen Bildschirm teilen',
  'voice.share.choose': 'Wähle, was du teilst',
  // SCREEN-READER ONLY: the group name over the two content choices.
  'voice.share.contentLabel': 'Was du teilst',

  // The two encoder bets, keyed by the `value` of the presets in
  // `lib/screenShare.js`; the tokens stay there, the words are here. Each pair
  // is a promise and its price, in that order, because the price is what makes
  // the choice a choice — and German keeps the order rather than merging them
  // into one hedged sentence.
  'voice.share.content.detail.label': 'Ein Dokument oder Code',
  // „Jedes Pixel erhalten“ is a participle with no subject, which is what
  // German uses for a promise in a specification line; „es wird jedes Pixel
  // erhalten“ would be a sentence and would outweigh the half in front of it.
  'voice.share.content.detail.description': 'Scharfer Text. Weniger Bilder pro Sekunde, jedes Pixel erhalten.',
  'voice.share.content.motion.label': 'Ein Spiel oder Video',
  // „Wird weicher, bevor es ruckelt“ keeps English's ordering of the trade,
  // which is the whole content of the line: softness first, stutter avoided.
  // „wenn die Leitung eng wird“ is the German idiom for a link under pressure.
  'voice.share.content.motion.description': 'Flüssige Bewegung. Wird weicher, bevor es ruckelt, wenn die Leitung eng wird.',

  // „Auch den Ton teilen“ and emphatically not „Den Ton mitteilen“, which in
  // German means to inform somebody of something — the near-miss that would
  // have been funny in a screenshot and confusing in use.
  'voice.share.audio': 'Auch den Ton teilen',
  // Two different facts, and telling somebody the second when the first is true
  // costs them a working feature. UNTRANSLATED: „Tab“, a naturalised German
  // noun (der Tab) and the word every German browser UI uses.
  'voice.share.audioUnlikely': 'Dieser Browser kann den Ton eines Tabs aufnehmen, aber nicht den eines ganzen Bildschirms oder Fensters.',
  'voice.share.noCapture': 'Dieser Browser kann den Ton dessen, was du teilst, nicht aufnehmen.',
  // UNTRANSLATED, sort of, and this one needs care from whoever maintains it:
  // the quoted phrase is the BROWSER's own wording in its own picker, not
  // Telium's. „Audio des Tabs teilen“ is what Chrome's German picker says
  // today; if a reader's browser says something else, this quotation should
  // follow it, and if their browser leaves the phrase in English it should be
  // left in English here too. German quotation marks „ “ rather than the
  // English curly pair, and they are ordinary characters to the ICU parser —
  // no quoting rule is triggered.
  'voice.share.pickTabAudio': 'Es kam kein Ton mit. Wähle einen Tab und setze das Häkchen bei „Audio des Tabs teilen“, damit er mitkommt.',
  // UNTRANSLATED: `{reason}`, which is whatever the native Linux desktop-audio
  // bridge said — a PipeWire or venmic diagnostic this client did not compose
  // and cannot translate, carried in the one slot the sentence has for it.
  'voice.share.desktopAudioFailed': 'Der Ton des Desktops ließ sich nicht teilen: {reason}',

  // The collapsed advanced row and the two strips inside it.
  'voice.share.quality': 'Qualität',
  // UNTRANSLATED: `fps`. A unit symbol, written `fps` in German technical prose
  // as well; the label two lines down spells it out in words because it is a
  // form label with room, while this is a summary line with none. The middle
  // dot is a separator and not punctuation, and German separates the same way.
  'voice.share.summary': '{quality} · {fps} fps',
  'voice.share.resolution': 'Auflösung',
  // Spelled out here, unlike the `fps` in the summary: this is the label on the
  // control, and „Bilder pro Sekunde“ is what a German settings row says.
  'voice.share.frameRate': 'Bilder pro Sekunde',

  // ------------------------------------------------------- watch together

  // Everyone plays the same thing themselves and Telium carries only the
  // position and the play button. That distinction is the whole feature, and
  // most of the words below exist to make it before somebody agrees to it.
  // Identical to the `other` arm of `voice.dock.watch` above, as required.
  'voice.watch.title': 'Gemeinsam ansehen',
  // „im Gleichtakt“ rather than „synchron“: the German loan is correct and
  // colourless, and this subtitle is the one line that has to make the feature
  // feel like people rather than like a protocol.
  'voice.watch.subtitle': 'Alle spielen es selbst ab, im Gleichtakt miteinander.',
  // UNTRANSLATED: „Link“, a German noun (der Link, des Links) and the word on
  // every German share sheet; „Verknüpfung“ is a Windows shortcut.
  'voice.watch.url': 'Link',
  'voice.watch.urlPlaceholder': 'Link einfügen',
  // The final alternative in an `Intl.ListFormat` disjunction — so it never
  // carries its own comma or conjunction, and it is nominative because the list
  // it ends is a bare list of options under an input („YouTube, Vimeo oder eine
  // direkte Videodatei“).
  'voice.watch.orFile': 'eine direkte Videodatei',
  // UNTRANSLATED: „Build“. Der Build is what German developers and German
  // release notes say; „Fassung“ or „Version“ would both be wrong, because the
  // point is that this particular build was compiled without the providers.
  'voice.watch.noEmbeds': 'Dieser Build hat keine Anbieter zum gemeinsamen Ansehen, und direkte Dateien sind ausgeschaltet.',
  'voice.watch.start': 'Starten',

  // The consent sentence, in the dialog and again on the card. TAGS: `<b>`
  // around both values, kept exactly — they are the emphasis the sentence is
  // built on, and German emphasises the same two things, since the provider and
  // the host are precisely what is being consented to. The values inside them
  // are a brand and a DNS name and are never touched.
  //
  // German turns English's gerund subject („Playing from X connects…“) into a
  // noun phrase with a genitive („Das Abspielen von X verbindet…“), which is
  // the natural construction and also sidesteps having to inflect anything
  // around `{provider}`.
  'voice.watch.connects': 'Das Abspielen von <b>{provider}</b> verbindet diesen Browser mit <b>{host}</b>.',
  'voice.watch.consentHost': 'Das verbindet deinen Browser mit <b>{host}</b>.',
  // Chosen from `connectsTo().kind`, and the two cases are genuinely different:
  // a file is fetched by each person from wherever it lives, an embed runs a
  // player the provider serves.
  'voice.watch.noteFile': 'Jede Person holt sich die Datei selbst, von dort, wo sie liegt.',
  // The relative clause English hangs on `{provider}` („which sees this
  // browser…“) cannot be translated as a relative clause, because the pronoun
  // would have to agree with a provider name whose gender nobody knows — „der“,
  // „die“ or „das“ YouTube is a coin flip. So the clause is re-anchored on „die
  // Gegenseite“, a German noun this sentence supplies itself, and the meaning
  // is unchanged: the other end sees this browser much as a tab would show it.
  'voice.watch.noteFrame': 'Der Player läuft in einem Frame von {provider}, und die Gegenseite sieht diesen Browser dabei ungefähr so, als hättest du die Seite dort in einem Tab geöffnet.',
  // Short and flat, as in English. „Die Verbindung gehört dir“ is the sentence
  // that has to survive translation intact: it is a claim about who the party
  // to the connection is, not about routing.
  'voice.watch.proxyNote': 'Telium leitet das nicht weiter. Die Verbindung gehört dir.',
  'voice.watch.connectTo': 'Mit {host} verbinden',
  'voice.watch.notNow': 'Jetzt nicht',

  // What happens to the two bytes Telium does carry, said in both places
  // because consenting to a connection and consenting to a relay seeing your
  // scrubbing are two different consents. „die Wiedergabetaste“ for the play
  // button: the thing being carried is the press, and Taste is the German word
  // for the control that gets pressed.
  //
  // „das sie mitlesen kann“ in the two relayed variants agrees with *das
  // Relay* and with *Telium* respectively — both neuter, both nouns written by
  // this file, neither of them wire data.
  'voice.watch.sealed': 'Durch Telium laufen nur die Position und die Wiedergabetaste, und sie sind Ende zu Ende versiegelt.',
  'voice.watch.relayed': 'Die Position und die Wiedergabetaste laufen über das Relay von Telium, das sie mitlesen kann.',
  'voice.watch.relayedConsent': 'Die Position und die Wiedergabetaste werden über Telium weitergeleitet, das sie mitlesen kann.',
  // The pill. „Ende zu Ende“ without hyphens as a predicate, with them in
  // `voice.stage.sealedNotice` above where it is an attribute
  // („Ende-zu-Ende-verschlüsselt“) — that is German orthography, not an
  // inconsistency.
  'voice.watch.sealedLabel': 'Ende zu Ende versiegelt',

  // Three lines, in the order somebody needs them: what is wrong, why, and what
  // to do instead. „im Gleichtakt halten“ reuses the subtitle's metaphor, which
  // is what makes this read as the failure of the thing that was promised.
  'voice.watch.unsyncable': 'Dieser Link lässt sich nicht im Gleichtakt halten.',
  // „dieser“ at the end agrees with *der Player*, named at the start of the
  // sentence — the gender is the file's own. UNTRANSLATED: „Player“, der
  // Player, the German word for exactly this component.
  'voice.watch.unsyncableWhy': 'Telium kann nur Player steuern, mit denen es zu sprechen gelernt hat, und dieser gehört nicht dazu.',
  'voice.watch.unsyncableInstead': 'Teile stattdessen deinen Bildschirm und spiel es selbst ab.',
  'voice.watch.unplayable': 'Dieser Link lässt sich hier nicht abspielen.',

  // The line above the player, and the one place in this fragment where German
  // grammar forced the sentence to be rebuilt rather than translated.
  //
  // English writes „{who} started {what}“ and `who` is either a name or the
  // word "You". German conjugates the second person differently from the third
  // — „Du hast“ against „Alice hat“ — so no single pattern with a finite verb
  // can take both. The fix is to drop the finite verb entirely: „Gestartet von
  // {who}: {what}“ is a caption, which is what this line actually is, and „von“
  // governs a dative that names do not inflect for. That in turn means
  // `voice.watch.you` must be the dative „dir“ and not the nominative „Du“ —
  // legitimate, because `WatchTogether.jsx` feeds it into this one slot and
  // nowhere else (verified), but it is a key that is now inflected for its
  // caller. If anybody reuses it elsewhere, that is a new key, not an edit.
  'voice.watch.you': 'dir',
  // The accusative and nominative of „ein Video“ are identical, which is the
  // only reason this fragment survives being dropped into a caption; it is
  // luck, and it is written down so the next person does not assume design.
  'voice.watch.aVideo': 'ein Video',
  'voice.watch.started': 'Gestartet von {who}: {what}',
  // `{provider}` here is the provider's name or `voice.watch.thePlayer`, and it
  // is the SUBJECT of this sentence — which is why the fallback below is
  // nominative „Der Player“ while `voice.watch.aVideo` above is an object. It
  // is also capitalised, because that one slot is always the first word of the
  // line: „Der Player wird geöffnet…“ beside „YouTube wird geöffnet…“.
  'voice.watch.opening': '{provider} wird geöffnet…',
  'voice.watch.thePlayer': 'Der Player',

  // Somebody is still buffering. One name is worth saying; several are worth
  // counting. „Warten auf“ takes the accusative, and the `#` in the plural is
  // followed by Person/Personen, which do not inflect in the accusative
  // singular or plural — so the pattern is safe in both arms.
  'voice.watch.waitingFor': 'Warten auf {who}',
  'voice.watch.waitingForMany': '{count, plural, one {Warten auf # Person} other {Warten auf # Personen}}',
  // Deliberately not an apology and deliberately not an error: a decision the
  // room made. „ohne diese Person“ rather than „ohne sie“, which would be
  // ambiguous between the person and the position, and which would also force a
  // gender onto somebody the sentence has not named.
  'voice.watch.gaveUpWaiting': 'Jemand puffert noch, deshalb läuft die Wiedergabe ohne diese Person weiter.',

  // The control bar. Both transport buttons name the ROOM and not the player,
  // because that is the surprising half: pressing pause here pauses it for
  // everybody. „Für alle“ leads in German exactly as "for everyone" trails in
  // English — the emphasis lands in the position each language gives it.
  'voice.watch.playAll': 'Für alle abspielen',
  'voice.watch.pauseAll': 'Für alle pausieren',
  'voice.watch.position': 'Position',
  // Two values and a slash, all of them formatted elsewhere; nothing to
  // translate and nothing to reorder, since German reads elapsed/total the same
  // way round.
  'voice.watch.elapsedOf': '{at} / {duration}',
  // „Geschwindigkeit“ and not „Tempo“, which in German is musical, and not the
  // shorter „Speed“, which is a drug. Fourteen characters against five; kept,
  // because the strip has a label column and this is what belongs in it.
  'voice.watch.speed': 'Geschwindigkeit',
  // UNTRANSLATED: „×“, the multiplication sign — a number and its unit, not a
  // letter x. `{rate}` goes through `Intl.NumberFormat`, so German gets „1,5×“
  // with the comma for free and this line must not try to help.
  'voice.watch.rate': '{rate}×',
  // Two words for one button, chosen by whether this is your session: ending it
  // takes it away from everybody, leaving does not. „Für alle beenden“ keeps
  // the parallel with the two transport buttons above, which is what tells
  // somebody at a glance that this one is also a room-wide act.
  'voice.watch.end': 'Für alle beenden',
  'voice.watch.leave': 'Verlassen',
  'voice.watch.startFailed': 'Das gemeinsame Ansehen ließ sich nicht starten',

  // ------------------------------------------------------------- failures

  // Every key in this section is a `reportError` context: the first half of
  // `errors.context`, joined by a colon to whatever actually went wrong. So
  // none of them ends in a full stop, and none of them claims to know why.
  //
  // English writes them as "Could not X", which German cannot take literally —
  // „Konnte nicht X“ has no subject and reads like a machine log. The guild
  // fragment above settled the whole family on „… ließ sich nicht …“ (plural
  // „ließen“), which is colloquial enough for this app's du, names the thing
  // that did not work, and asserts nothing about the cause. These twenty-two
  // continue it without exception.
  //
  // They are worded from the person's side of the call, not the code's: a
  // failed `voiceState` request is what somebody who pressed Mute and watched
  // it spring back is looking at.
  //
  // „Die Verbindung zum Gespräch ließ sich nicht herstellen“ rather than a
  // literal „dem Gespräch beitreten“: German's beitreten takes a dative object,
  // which leaves the lassen-passive without a subject and sounds translated.
  // Verbindung herstellen is the ordinary German for what actually failed.
  'voice.error.join': 'Die Verbindung zum Gespräch ließ sich nicht herstellen',
  // „sauber“ carries English's "cleanly": the leave happened, the goodbye did
  // not, and that is worth the extra word because the person is already gone.
  'voice.error.leave': 'Das Gespräch ließ sich nicht sauber verlassen',
  // The one entry in this section that is not a "could not", in English or in
  // German. „in Schwierigkeiten geraten“ is the German idiom for exactly this
  // vague, ongoing trouble, and it stays vague on purpose.
  'voice.error.trouble': 'Das Gespräch ist in Schwierigkeiten geraten',
  // „Sprachstatus“ is the state the roster keeps about you — muted, deafened,
  // in this room — and it is the compound the gateway documentation uses.
  'voice.error.voiceState': 'Dein Sprachstatus ließ sich nicht aktualisieren',
  'voice.error.cameraOn': 'Die Kamera ließ sich nicht einschalten',
  'voice.error.cameraOff': 'Die Kamera ließ sich nicht ausschalten',
  'voice.error.flipCamera': 'Die Kamera ließ sich nicht wechseln',
  'voice.error.shareScreen': 'Der Bildschirm ließ sich nicht teilen',
  // The nominalised form from the glossary, so that the three share-related
  // failures read as being about one feature.
  'voice.error.stopStream': 'Das Teilen des Bildschirms ließ sich nicht beenden',
  'voice.error.streamState': 'Das Teilen des Bildschirms ließ sich nicht aktualisieren',
  'voice.error.resumeAudio': 'Der Ton des Gesprächs ließ sich nicht starten',
  'voice.error.fullscreen': 'Der Vollbildmodus ließ sich nicht öffnen',
  'voice.error.pip': 'Das Video ließ sich nicht in Bild-in-Bild öffnen',
  // The two halves of following a call that moved underneath you, kept apart
  // because one is a new server and the other a new region, and knowing which
  // failed is the difference between waiting and rejoining. „wieder aufnehmen“
  // rather than a literal „folgen“: German's folgen takes a dative and would
  // strand the lassen-passive the same way beitreten does above, and „wieder
  // aufnehmen“ says what the client was actually trying to do.
  'voice.error.followServer': 'Das Gespräch ließ sich auf seinem neuen Server nicht wieder aufnehmen',
  'voice.error.followRegion': 'Das Gespräch ließ sich in seiner neuen Region nicht wieder aufnehmen',
  // Re-keying is giving the call new keys, which German says as „neu
  // verschlüsseln“; „neu verschlüsseln“ is slightly broader than the English
  // term of art and is the right trade, because „Schlüsselwechsel“ in a toast
  // title would send people looking for a setting by that name.
  'voice.error.rekey': 'Das Gespräch ließ sich nicht neu verschlüsseln',
  // Rejoining kept failing, so the seat is given up; `errors.context` names
  // what the last attempt hit.
  'voice.error.rejoin': 'Der erneute Beitritt zum Gespräch schlug fehl',
  // The server says this device is no longer in the channel it was calling from.
  'voice.call.removed': 'Du wurdest aus dem Sprachkanal entfernt',
  // The device panel's four. `readRoutes` and `switchOutput` are shared with
  // Android's output sheet, which asks the same two questions of a different
  // implementation — so the German has to work in both, and neither of them
  // mentions a panel.
  'voice.error.listDevices': 'Die Audiogeräte ließen sich nicht auflisten',
  'voice.error.switchMic': 'Das Mikrofon ließ sich nicht wechseln',
  'voice.error.switchOutput': 'Die Ausgabe ließ sich nicht wechseln',
  'voice.error.readRoutes': 'Die Audioausgaben ließen sich nicht auslesen',
  'voice.error.noiseChange': 'Die Rauschunterdrückung ließ sich nicht ändern',
  // Das neuronale Modell, nicht die Rauschunterdrückung: die beiden Zeilen
  // darüber und darunter landen in derselben Toast-Schlange, und zwei
  // verschiedene Fehler dürfen dort nicht wie einer klingen.
  'voice.error.noiseModel': 'Das neuronale Modell ließ sich nicht prüfen',

  // ================================================== added to reach 100%
  //
  // Everything below was added in one pass to complete this catalogue. The
  // sentences were produced with machine assistance and have not been read by
  // a human, which is why none of them carries a stamp in `stamps.json` --
  // `node scripts/i18n-status.mjs --stale` reports them as *unknown*, not as
  // accepted. Treat this block as a first draft to review, not as finished copy.
  // ---- app
  'app.boot.connecting': 'Verbindung zu {domain}…',
  'app.boot.offline': 'Dieses Gerät ist offline. Telium meldet dich an, sobald die Verbindung wieder da ist.',
  'app.boot.signOut': 'Abmelden',
  'app.boot.switching': 'Wechsel zu {name}…',
  'app.boot.unreachable': 'Konnte {domain} nicht erreichen: {reason}',
  'app.boot.unreachableNotice': 'Server-Sitzungen laufen weiter, bis sie ablaufen; neue lassen sich jedoch nicht erzeugen, solange dein Heimserver nicht erreichbar ist.',
  'app.crash.recover': 'Auch nach dem Neuladen noch kaputt?',
  'app.crash.reload': 'Neu laden',
  'app.crash.report': 'Das melden',
  'app.crash.title': 'Beim Zeichnen dieses Bildschirms ist etwas schiefgegangen.',

  // ---- auth
  'auth.advanced.identityMismatch': 'Die Identitätsgeschichte dieses Kontos ließ sich nicht prüfen.',
  'auth.advanced.identityName': 'Kontoidentität',
  'auth.advanced.legacyPassphraseBody': 'Dieses Konto trägt noch eine Passphrase aus einer älteren Version von Telium mit sich. Dein Passwort erfüllt dieselbe Aufgabe bereits.',
  'auth.advanced.legacyPassphraseName': 'Alte Wiederherstellungs-Passphrase',
  'auth.advanced.modeName': 'Wie dieses Konto wiederhergestellt wird',
  'auth.advanced.passphraseRemoved': 'Alte Passphrase entfernt. Dein Passwort holt deine Nachrichten weiterhin zurück.',
  'auth.advanced.removeFailed': 'Die alte Wiederherstellungs-Passphrase ließ sich nicht entfernen: {detail}',
  'auth.advanced.removePassphrase': 'Die alte Passphrase entfernen',
  'auth.advanced.rootSequence': ' · Wurzelsequenz {sequence}',
  'auth.backup.delete': 'Die Sicherung löschen',
  'auth.backup.deleteBody': 'Nachrichten, die bereits auf diesem Gerät sind, bleiben. Ein neues Gerät wird die älteren nicht zurückholen können.',
  'auth.backup.deleteConfirm': 'Löschen',
  'auth.backup.deleted': 'Sicherung gelöscht.',
  'auth.backup.deleteFailed': 'Die Sicherung ließ sich nicht löschen: {detail}',
  'auth.backup.deleteTitle': 'Die Sicherung löschen',
  'auth.backup.detail': '{count, plural, one {# versiegelter Eintrag.} other {# versiegelte Einträge.}} {readable, select, yes {Dein Heimserver kann sie öffnen.} other {Dein Heimserver kann sie nicht öffnen.}}',
  'auth.backup.detailName': 'Sicherung',
  'auth.backup.empty': 'Es ist noch nichts gespeichert. Ein neues Gerät würde ab heute beginnen.',
  'auth.backup.explain': 'Eine verschlüsselte Kopie wird aufbewahrt, damit ein neues Gerät aufholen kann. Zuletzt geschrieben {at, relative}.',
  'auth.backup.title': 'Sicherung älterer Nachrichten',
  'auth.crumb.address': 'Telium-Adresse',
  'auth.crumb.password': 'Passwort',
  'auth.crumb.recoveryKey': 'Wiederherstellungsschlüssel',
  'auth.crumb.username': 'Benutzername',
  'auth.crumb.welcome': 'Willkommen',
  'auth.custody.device.name': 'Wiederherstellung über vertraute Geräte',
  'auth.custody.device.note': 'Deine Schlüssel liegen auf den Geräten, die du freigegeben hast, und nirgendwo sonst.',
  'auth.custody.escrowed.name': 'Servergestützte Wiederherstellung (alt)',
  'auth.custody.escrowed.note': 'Dein Heimserver hält einen Schlüssel, der diese Nachrichten öffnet.',
  'auth.custody.line': '{name}. {note}',
  'auth.custody.opaque.name': 'Passwort-Wiederherstellung (OPAQUE-Exportschlüssel)',
  'auth.custody.opaque.note': 'Die Anmeldung mit deinem Passwort genügt, um deine Nachrichten zurückzuholen.',
  'auth.custody.self.name': 'Eigene Passphrase (alt)',
  'auth.custody.self.note': 'Deine Schlüssel liegen auf deinen Geräten, mit einer Passphrase als Weg zurück.',
  'auth.custody.unknown': 'Noch nicht eingerichtet',
  'auth.encryption.backupEmpty': 'Nichts gespeichert',
  'auth.encryption.backupFact': 'Sicherung älterer Nachrichten',
  'auth.encryption.backupItems': '{count, plural, one {# Nachricht} other {# Nachrichten}}',
  'auth.encryption.devicesCounting': 'Wird gezählt',
  'auth.encryption.devicesFact': 'Geräte',
  'auth.encryption.devicesHint': '„Geräte“ ist der Ort, an dem du ein Gerät verifizierst oder abmeldest.',
  'auth.encryption.devicesSignedIn': '{count, plural, one {# angemeldet} other {# angemeldet}}',
  'auth.encryption.devicesVerified': '{total, plural, one {{verified} von # verifiziert} other {{verified} von # verifiziert}}',
  'auth.encryption.escrowed.note': 'Dieses Konto nutzt noch die alte Wiederherstellungseinrichtung. Sie abzuschalten erfordert nur einen Druck und kein zweites Passwort.',
  'auth.encryption.escrowed.title': 'Dein Heimserver kann deine privaten Nachrichten lesen.',
  'auth.encryption.keyFact': 'Wiederherstellungsschlüssel',
  'auth.encryption.keyLegacy': 'Alte Passphrase',
  'auth.encryption.keyMissing': 'Noch nicht erstellt',
  'auth.encryption.keySaved': 'Gespeichert',
  'auth.encryption.locked.note': 'Neue Nachrichten funktionieren. Um die älteren zurückzuholen, verwende unten deinen Wiederherstellungsschlüssel oder gib dieses Gerät von einem frei, das du bereits benutzt.',
  'auth.encryption.locked.title': 'Deine älteren Nachrichten sind auf diesem Gerät verschlossen.',
  'auth.encryption.ok.noteFallback': 'Nur deine Geräte können sie öffnen.',
  'auth.encryption.ok.title': 'Deine privaten Nachrichten sind geschützt.',
  'auth.encryption.settingUp.note': 'Das dauert nach der Anmeldung einen Moment.',
  'auth.encryption.settingUp.title': 'Verschlüsselung wird auf diesem Gerät eingerichtet.',
  'auth.escrow.button': 'Abschalten',
  'auth.escrow.doneDevices': 'Fertig. Deine Schlüssel liegen jetzt auf deinen Geräten.',
  'auth.escrow.doneRefresh': 'Fertig, allerdings brauchen ein paar Gespräche noch eine Schlüsselaktualisierung.',
  'auth.escrow.doneServer': 'Fertig. Dein Server kann keine neuen Nachrichten mehr öffnen.',
  'auth.escrow.explain': 'Dein Server kann danach nichts mehr öffnen, was nach diesem Zeitpunkt gesendet wird. Was er bereits gesehen hat, hat er bereits gesehen.',
  'auth.escrow.failed': 'Servergestützte Wiederherstellung ließ sich nicht abschalten: {detail}',
  'auth.escrow.title': 'Servergestützte Wiederherstellung abschalten',
  'auth.find.afterColon': 'Oder tippe ihn nach einem Doppelpunkt ein, etwa @{user}:dein.server',
  'auth.find.busy': 'Wird gesucht…',
  'auth.find.changeAddress': 'Andere Adresse verwenden',
  'auth.find.changeHome': 'Anderen Heimserver wählen',
  'auth.find.create': 'Konto erstellen',
  'auth.find.deactivated': 'Dieses Konto ist deaktiviert. Eine Anmeldung mit seinem Passwort holt es zurück.',
  'auth.find.elsewhere': 'Auf einem anderen Server?',
  'auth.find.forget': 'Vergiss {user} auf diesem Gerät',
  'auth.find.found': 'Gefunden: {user} auf {host}',
  'auth.find.foundLabel': 'Konten namens {user}',
  'auth.find.hint': 'Dein Benutzername und dein Server, etwa @ada:telium.chat. Server vergessen? Tipp einfach deinen Benutzernamen ein.',
  'auth.find.homeExplainer': 'Der Heimserver deines Kontos trägt dein Profil, deine Anmeldung, deine Freunde und deine Nachrichten. Gemeinschaften, die woanders gehostet werden, kannst du trotzdem beitreten.',
  'auth.find.invalid': 'Das sieht nicht nach einer Telium-Adresse aus. Versuch es mit @name:server.',
  'auth.find.label': 'Telium-Adresse',
  'auth.find.lookingUp': 'Suche nach {host}…',
  'auth.find.moved': 'Dein Konto ist nach {host} umgezogen.',
  'auth.find.newTitle': 'Neu bei Telium?',
  'auth.find.noAccount': 'Es gibt kein Konto namens {user} auf {host}. Prüf die Schreibweise, oder <create>erstelle ein Konto</create>.',
  'auth.find.noSuchAccount': 'Es gibt kein Konto namens {user} auf {host}.',
  'auth.find.placeholder': '@du:telium.chat',
  'auth.find.recentLabel': 'Konten auf diesem Gerät',
  'auth.find.searching': 'Suche nach {user}…',
  'auth.find.title': 'Bei Telium anmelden',
  'auth.find.unreachable': 'Konnte {host} nicht erreichen. Prüf die Schreibweise oder deine Verbindung.',
  'auth.find.whichServer': 'Auf welchem Server ist {user}?',
  'auth.guardians.cannotSign': 'Dieses Gerät kann gerade nicht für dein Konto signieren.',
  'auth.guardians.duplicate': 'Drei verschiedene Personen. Dieselbe ID kann nicht doppelt zählen.',
  'auth.guardians.incomplete': 'Nenne alle drei, bevor du speicherst.',
  'auth.guardians.name': 'Wiederherstellungskontakte (beliebige zwei von drei)',
  'auth.guardians.needThree': 'Wähle drei verschiedene Personen.',
  'auth.guardians.person': 'Person {index}',
  'auth.guardians.placeholder': '@freund:home.example',
  'auth.guardians.replace': 'Diese drei ersetzen',
  'auth.guardians.save': 'Diese drei speichern',
  'auth.guardians.saved': 'Deine drei Wiederherstellungskontakte sind gespeichert.',
  'auth.guardians.saveFailed': 'Deine Wiederherstellungskontakte ließen sich nicht speichern: {detail}',
  'auth.guardians.set': 'Eingerichtet, Version {version}. Wenn du neue wählst, werden die alten ungültig.',
  'auth.guardians.unset': 'Nicht eingerichtet. Beliebige zwei der drei können dich wieder hineinbürgen; eine einzelne Person allein nicht.',
  'auth.guardians.unsupported': 'Dieser Server bietet sie nicht an.',
  'auth.guardians.unsupportedName': 'Wiederherstellungskontakte',
  'auth.guardians.verifiedList': 'Personen, die du verifiziert hast: {people}',
  'auth.guardians.verifyFirst': 'Verifiziere zuerst jemanden mit dem Emoji-Abgleich und trage dann die vollständige ID hier ein.',
  'auth.handoff.account': '<b>Ziehe {account} nach {destination} um.</b> Melde dich bei dem Konto an, in das umgezogen werden soll, oder registriere ein neues. Du wirst um Bestätigung gebeten, bevor etwas an {source} gesendet wird.',
  'auth.handoff.guild': '<b>Die Gilde {name} wird nach {destination} umgezogen.</b> Melde dich bei dem Konto an, dem sie dort gehören soll, oder registriere ein neues. Du wirst um Bestätigung gebeten, bevor etwas an {source} gesendet wird.',
  'auth.identity.placeholder': 'ada oder @ada:{host}',
  'auth.identity.placeholderNew': 'ada',
  'auth.identity.titleLogin': 'Wer meldet sich an?',
  'auth.identity.titleRegister': 'Wähle einen Benutzernamen',
  'auth.key.acceptFailed': 'Wiederherstellungsschlüssel ließ sich nicht annehmen: {detail}',
  'auth.key.copy': 'Wiederherstellungsschlüssel kopieren',
  'auth.key.saved': 'Ich habe meinen Wiederherstellungsschlüssel gespeichert',
  'auth.key.sub': 'Er setzt dein Passwort zurück und holt dein Konto zurück, wenn du alle Geräte verlierst.',
  'auth.key.title': 'Speichere deinen Wiederherstellungsschlüssel',
  'auth.key.warning': '<b>Bewahre ihn sicher und getrennt von deinem Passwort auf.</b> Niemand, auch Telium nicht, kann ihn für dich neu erzeugen.',
  'auth.legacy.register.action': 'Alte Registrierung verwenden',
  'auth.legacy.register.body': 'Die alte Registrierung sendet dein Passwort an den Heimserver. Verwende das nur, wenn du dem Server vertraust und ihn nicht auf eine aktuelle Telium-Version aktualisieren kannst.',
  'auth.legacy.register.title': 'Dieser Heimserver unterstützt keine passwortprivate Registrierung.',
  'auth.legacy.server.action': 'Alte Anmeldung verwenden',
  'auth.legacy.server.actionReactivate': 'Alte Reaktivierung verwenden',
  'auth.legacy.server.body': 'Die alte Anmeldung sendet dein Passwort an den Heimserver. Verwende das nur, wenn du dem Server vertraust und ihn nicht auf eine aktuelle Telium-Version aktualisieren kannst.',
  'auth.legacy.server.title': 'Dieser Heimserver unterstützt keine passwortprivate Anmeldung.',
  'auth.legacy.upgrade.action': 'Dieses Konto aktualisieren',
  'auth.legacy.upgrade.body': 'Das Konto ist älter als OPAQUE. Nur für diesen einen Aktualisierungsversuch erhält der Heimserver dein Passwort über seinen alten Anmelde-Endpunkt. Telium ersetzt danach den alten Verifizierer durch OPAQUE, sodass künftige Anmeldungen das Passwort auf diesem Gerät belassen.',
  'auth.legacy.upgrade.title': 'Dieses alte Konto braucht eine einmalige Sicherheitsaktualisierung.',
  'auth.localData.cache.body': 'Ungefährlich. Alles hier ist eine Kopie von etwas, das ein Server weiterhin hat, und es kommt bei der nächsten Verbindung zurück. Du bleibst angemeldet, und deine verschlüsselten Gespräche werden nicht angetastet.',
  'auth.localData.cache.button': 'Zwischengespeicherte Daten löschen',
  'auth.localData.cache.cost1': 'Die Offline-Kopie deiner Gilden, Kanäle und der letzten Nachrichten.',
  'auth.localData.cache.cost2': 'Deine lokal gespiegelten Einstellungen, bis die nächste Synchronisierung sie zurückbringt.',
  'auth.localData.cache.cost3': 'Alles, was der Service Worker für die Offline-Nutzung zwischengespeichert hatte.',
  'auth.localData.cache.done': 'Geleert. Lade neu, um mit einem sauberen Cache zu starten.',
  'auth.localData.cache.reload': 'Neu laden',
  'auth.localData.cache.title': 'Zwischengespeicherte Daten löschen',
  'auth.localData.healed': 'Telium hat seinen Offline-Cache automatisch geleert, weil die App zweimal hintereinander nicht gestartet ist. An deinem Konto hat sich nichts geändert, und deine verschlüsselten Gespräche sind unberührt.',
  'auth.localData.identity.body': 'Nur, wenn das Leeren des Caches nicht geholfen hat. Damit werden die auf diesem Gerät liegenden Verschlüsselungsschlüssel zerstört, und ein Teil dessen, was sie öffnen, existiert nirgendwo sonst.',
  'auth.localData.identity.confirm': 'Löschen und abmelden',
  'auth.localData.identity.confirmTitle': 'Das lässt sich nicht rückgängig machen. Du verlierst:',
  'auth.localData.identity.cost1': 'Die MLS-Signieridentität dieses Geräts. Für alle, mit denen du sprichst, wird es ein neues Gerät sein, und sie sehen es als unverifiziert, bis du es erneut verifizierst.',
  'auth.localData.identity.cost2': 'Den gespeicherten Gruppenstatus für jedes verschlüsselte Gespräch. Nachrichten, die bereits auf diesem Gerät sind, bleiben nur lesbar, wenn der Wiederherstellungsschlüssel des Kontos sie wieder öffnen kann; alles, wovon dieses Gerät der letzte Besitzer ist, ist weg.',
  'auth.localData.identity.cost3': 'Den zwischengespeicherten DM-Wiederherstellungsschlüsselbund, sodass die nächste Anmeldung den Schlüsseltresor erneut entsperren muss — mit deinem Wiederherstellungsschlüssel oder deiner Passphrase, die du dafür zur Hand haben musst.',
  'auth.localData.identity.cost4': 'Deine Sitzung. Du wirst auf diesem Gerät abgemeldet.',
  'auth.localData.identity.open': 'Geräteidentität löschen…',
  'auth.localData.identity.title': 'Identität dieses Geräts löschen',
  'auth.parts.advanced': 'Erweitert',
  'auth.parts.download.account': 'Konto: {user}',
  'auth.parts.download.body1': 'Dieser Schlüssel setzt dein Passwort zurück und öffnet deine verschlüsselten Nachrichten wieder.',
  'auth.parts.download.body2': 'Wer ihn hat, kann beides tun. Bewahre ihn an einem Ort auf, den nur du erreichen kannst.',
  'auth.parts.download.server': 'Server: {host} (melde dich auf einem beliebigen Gerät mit dem obigen Konto an)',
  'auth.parts.download.title': 'Telium-Wiederherstellungsschlüssel',
  'auth.parts.keyGroups': '{label}, {count, plural, one {# Zeichengruppe} other {# Zeichengruppen}}',
  'auth.parts.needsAttention': 'Braucht Aufmerksamkeit: ',
  'auth.parts.recoveryKeyLabel': 'Wiederherstellungsschlüssel',
  'auth.password.confirmLabel': 'Passwort bestätigen',
  'auth.password.deactivated': 'Dieses Konto ist deaktiviert. Dasselbe Passwort holt es zurück.',
  'auth.password.forgot': 'Vergessen? <recover>Verwende deinen Wiederherstellungsschlüssel</recover>',
  'auth.password.mfaLabel': 'Authentifizierungscode',
  'auth.password.mfaPlaceholder': '123456 oder ein Wiederherstellungscode',
  'auth.password.mfaPrompt': 'Gib den sechsstelligen Code aus deiner Authentifizierungs-App oder einen deiner Wiederherstellungscodes ein.',
  'auth.password.mismatch': 'Diese stimmen noch nicht überein.',
  'auth.password.reactivateFailed': 'Reaktivierung fehlgeschlagen: {detail}',
  'auth.password.registerFailed': 'Registrierung fehlgeschlagen: {detail}',
  'auth.password.signInFailed': 'Anmeldung fehlgeschlagen: {detail}',
  'auth.password.signingInAs': 'Anmeldung als <b>{user}</b>.',
  'auth.password.submitLogin': 'Anmelden',
  'auth.password.submitReactivate': 'Konto reaktivieren',
  'auth.password.submitRegister': 'Konto erstellen',
  'auth.password.titleLogin': 'Passwort eingeben',
  'auth.password.titleReactivate': 'Dein Konto reaktivieren',
  'auth.password.titleRegister': 'Passwort festlegen',
  'auth.recover.malformed': 'Dieser Wiederherstellungsschlüssel ist fehlerhaft aufgebaut.',
  'auth.recover.notAKey': 'Das ist kein Telium-Wiederherstellungsschlüssel.',
  'auth.recover.reachFailed': 'Dein Heimserver war nicht erreichbar: {detail}',
  'auth.recover.rejected': 'Dieser Wiederherstellungsschlüssel wurde für dieses Konto nicht akzeptiert.',
  'auth.recover.title': 'Passwort zurücksetzen',
  'auth.recover.unsupported': 'Dieser Heimserver unterstützt das Zurücksetzen per Wiederherstellungsschlüssel nicht.',
  'auth.recoveryKey.clipboardName': 'Wiederherstellungsschlüssel',
  'auth.recoveryKey.copy': 'Kopieren',
  'auth.recoveryKey.createFailed': 'Dein Wiederherstellungsschlüssel ließ sich nicht erstellen: {detail}',
  'auth.recoveryKey.download': 'Als Datei herunterladen',
  'auth.recoveryKey.enterPassword': 'Gib dein Passwort ein.',
  'auth.recoveryKey.fieldLabel': 'Wiederherstellungsschlüssel',
  'auth.recoveryKey.finishFailed': 'Das Speichern deines Wiederherstellungsschlüssels ließ sich nicht abschließen: {detail}',
  'auth.recoveryKey.haveExplain': 'Dein Wiederherstellungsschlüssel ist der Weg zurück, wenn du dein Passwort vergisst oder alle Geräte verlierst. Bewahre ihn an einem Ort auf, den nur du erreichen kannst. Er kann nicht erneut angezeigt werden, und das Erstellen eines neuen setzt den alten außer Kraft.',
  'auth.recoveryKey.lockedFirst': 'Entsperre oben deine Nachrichten, dann kannst du einen Wiederherstellungsschlüssel erstellen.',
  'auth.recoveryKey.makeButton': 'Wiederherstellungsschlüssel erstellen',
  'auth.recoveryKey.makeNew': 'Neuen Schlüssel erstellen',
  'auth.recoveryKey.noneExplain': 'Dieses Konto hat keinen Wiederherstellungsschlüssel. Ohne einen bedeutet ein vergessenes Passwort den Verlust deiner älteren Nachrichten. Einen zu erstellen dauert ein paar Sekunden.',
  'auth.recoveryKey.onceWarning': '<b>Schreib ihn auf, bevor du weitermachst.</b> Er wird einmal angezeigt und kann nicht erneut angezeigt werden, weder von uns noch von irgendwem.',
  'auth.recoveryKey.passwordHint': 'Wird auf diesem Gerät geprüft. Dein Server erhält es nie.',
  'auth.recoveryKey.passwordLabel': 'Dein Passwort',
  'auth.recoveryKey.placeholder': 'telium-recovery-v1-…',
  'auth.recoveryKey.replaceBody': 'Dein aktueller Wiederherstellungsschlüssel funktioniert nicht mehr, sobald der neue erstellt ist. Wenn du ihn irgendwo aufgeschrieben hast, ist diese Kopie wertlos.',
  'auth.recoveryKey.replaceButton': 'Neuen Wiederherstellungsschlüssel erstellen',
  'auth.recoveryKey.replaceConfirm': 'Neuen erstellen',
  'auth.recoveryKey.replaceExplain': 'Gib dein Passwort ein, um den neuen Schlüssel zu erstellen. Der alte funktioniert dann nicht mehr.',
  'auth.recoveryKey.replaceTitle': 'Neuen Wiederherstellungsschlüssel erstellen',
  'auth.recoveryKey.saved': 'Ich habe ihn gespeichert',
  'auth.recoveryKey.savedToast': 'Wiederherstellungsschlüssel gespeichert. Bewahre ihn getrennt von deinem Passwort auf.',
  'auth.recoveryKey.title': 'Wiederherstellungsschlüssel',
  'auth.recoveryKey.unsupported': 'Dieser Server bietet keine Wiederherstellungsschlüssel an. Deine Schlüssel bleiben auf den Geräten, die du freigibst.',
  'auth.reset.confirmLabel': 'Neues Passwort bestätigen',
  'auth.reset.failed': 'Zurücksetzen des Passworts fehlgeschlagen: {detail}',
  'auth.reset.minLength': '{count, plural, one {Mindestens # Zeichen.} other {Mindestens # Zeichen.}}',
  'auth.reset.mismatch': 'Die neuen Passwörter stimmen nicht überein.',
  'auth.reset.newLabel': 'Neues Passwort',
  'auth.reset.submit': 'Passwort zurücksetzen',
  'auth.reset.title': 'Wähle ein neues Passwort',
  'auth.server.label': 'Heimserver',
  'auth.server.noServer': 'Hast du keinen? <a>Finde einen Heimserver</a>',
  'auth.server.placeholder': 'home.example',
  'auth.server.probeChecking': 'Server wird geprüft',
  'auth.server.probeFound': 'Server gefunden',
  'auth.server.probeUnreachable': 'Server nicht erreichbar',
  'auth.server.sub': 'Jedes Telium-Konto gehört zu einem Heimserver.',
  'auth.server.title': 'Wo liegt dein Konto?',
  'auth.server.unreachableBody': 'Unter dieser Adresse hat nichts geantwortet, sie ist also vielleicht falsch geschrieben, privat oder nicht erreichbar. Du kannst trotzdem damit weitermachen, aber Anmelden und Kontoerstellung funktionieren erst, wenn er antwortet. <a>Finde einen Heimserver</a>, der nachweislich läuft.',
  'auth.server.unreachableTitle': '{host} hat nicht geantwortet',
  'auth.server.use': 'Diesen Server verwenden',
  'auth.server.useAnyway': 'Trotzdem verwenden',
  'auth.start.lostPassword': 'Passwort vergessen? <recover>Konto wiederherstellen</recover>',
  'auth.start.register': 'Loslegen',
  'auth.start.signIn': 'Anmelden',
  'auth.start.title': 'Willkommen bei Telium',
  'auth.unlock.button': 'Entsperren',
  'auth.unlock.done': 'Entsperrt. Ab jetzt genügt dein Passwort.',
  'auth.unlock.doneDevice': 'Auf diesem Gerät entsperrt.',
  'auth.unlock.enterKey': 'Gib deinen Wiederherstellungsschlüssel ein.',
  'auth.unlock.enterPassphrase': 'Gib deine Wiederherstellungs-Passphrase ein.',
  'auth.unlock.failed': 'Deine Nachrichten ließen sich nicht entsperren: {detail}',
  'auth.unlock.keyHint': 'Der Schlüssel, den du bei der Erstellung dieses Kontos bekommen hast.',
  'auth.unlock.otherDevice': 'Du kannst Telium auch auf einem Gerät öffnen, das du bereits benutzt, und dieses von dort freigeben. Es wird nichts eingegeben, und dein Server sieht die Schlüssel nie.',
  'auth.unlock.passphraseHint': 'Die Passphrase, die du diesem Konto selbst hinzugefügt hast.',
  'auth.unlock.passphraseLabel': 'Wiederherstellungs-Passphrase',
  'auth.unlock.title': 'Deine älteren Nachrichten entsperren',

  // ---- chat
  'chat.format.bar': 'Textformatierung',
  'chat.gif.exitFullscreen': 'Vollbild beenden',
  'chat.gif.fullscreen': 'Vollbild',
  'chat.gif.resize': 'Größe der GIF-Auswahl ändern',
  'chat.message.actions.delete': 'Löschen',
  'chat.message.actions.pin': 'Anheften',
  'chat.message.actions.quickReact': 'Reagieren mit {emoji}',
  'chat.message.actions.unpin': 'Anheftung aufheben',
  'chat.message.deleteFailed': 'Löschen fehlgeschlagen',
  'chat.message.pinFailed': 'Anheften fehlgeschlagen',
  'chat.message.pinned': 'Angeheftet.',
  'chat.message.pinnedMark': 'Angeheftet',
  'chat.message.quotedDeleted': 'ursprüngliche Nachricht wurde gelöscht',
  'chat.message.unpinned': 'Nicht mehr angeheftet.',
  'chat.quote.body': '<quoted/>',
  'chat.timeline.pinNotice.anonymous': 'Eine Nachricht wurde angeheftet',
  'chat.timeline.pinNotice.named': '{name} hat eine Nachricht angeheftet',
  'chat.timeline.pinNotice.seeAll': 'Alle angehefteten Nachrichten ansehen',

  // ---- errors
  'errors.account_already_active': 'Dieses Konto ist bereits aktiv.',
  'errors.account_deleted': 'Dieses Konto wurde gelöscht und kann nicht mehr angemeldet werden.',
  'errors.assertion_rejected': 'Dieser Gildenserver hat die Zugangsdaten dieses Bots nicht angenommen.',
  'errors.bot_not_installed': 'Dieser Bot ist auf diesem Gildenserver nicht installiert.',
  'errors.demoted': 'Dieser Server hat an einen anderen Knoten übergeben. Verbindung wird wiederhergestellt.',
  'errors.invalid_recovery_proof': 'Diese Wiederherstellungs-Passphrase passt nicht zu diesem Konto. Prüf, ob ein Wort fehlt oder vertauscht ist.',
  'errors.legacy_auth_required': 'Dieser Heimserver ist zu alt, um sich mit dieser Version von Telium anzumelden.',
  'errors.mfa_not_configured': 'Für dieses Konto ist kein zweiter Faktor eingerichtet.',
  'errors.mfa_setup_not_started': 'Beginne mit der Einrichtung der Zwei-Faktor-Authentifizierung, bevor du einen Code bestätigst.',
  'errors.migration_handoff_invalid': 'Dieser Umzugslink ist nicht mehr gültig. Beginne den Umzug erneut von dem Konto aus, das du verlässt.',
  'errors.migration_in_progress': 'Dieses Konto zieht nach {destination} um. Hier lässt es sich nicht ändern, bis der Umzug abgeschlossen ist.',
  'errors.migration_refused': '{destination} hat den Umzug abgelehnt.',
  'errors.not_a_guild_server': 'Unter dieser Adresse gibt es keine Gilden.',
  'errors.opaque_downgrade': 'Dieser Server hat eine ältere, schwächere Anmeldung angeboten, als dein Konto verwendet. Telium hat dein Passwort nicht gesendet. Wenn du in einem öffentlichen Netz bist, versuch es von woanders noch einmal.',
  'errors.opaque_required': 'Dieses Konto meldet sich mit einem neueren Austauschverfahren an, das diese Version von Telium nicht spricht. Aktualisiere Telium und versuch es noch einmal.',
  'errors.recovery_attempt_expired': 'Dieser Wiederherstellungsversuch ist abgelaufen. Fang noch einmal von vorn an.',
  'errors.username_invalid': '{reason, select, too_short {Dieser Benutzername ist zu kurz.} too_long {Dieser Benutzername ist zu lang.} charset {Benutzernamen dürfen Buchstaben, Ziffern, Punkte, Bindestriche und Unterstriche enthalten.} reserved {Dieser Benutzername ist reserviert.} other {Dieser Benutzername kann hier nicht verwendet werden.}}',

  // ---- guild
  'guild.overview.vanity.address': 'Gildenadresse: {address}',
  'guild.overview.vanity.hint': 'Standardmäßig aus. Wenn aktiviert, kann jeder mit der Adresse eine Vorschau dieser Gilde ansehen und ihr beitreten. Einladungslinks funktionieren weiterhin.',
  'guild.overview.vanity.label': 'Adressname',
  'guild.overview.vanity.linkClipboard': 'Wunschlink',
  'guild.overview.vanity.linkLabel': 'Browser-Link',
  'guild.overview.vanity.placeholder': 'linuxcommunity',
  'guild.overview.vanity.saveFailed': 'Der Wunschlink ließ sich nicht speichern',
  'guild.overview.vanity.title': 'Wunschlink',
  'guild.overview.vanity.toggle': 'Wunschlink aktivieren',

  // ---- migration
  'migration.banner.alert': '{subject, select, guild {Die Gilde {subjectId}} other {Dein Konto}} wird nach {destination} verschoben {when, select, soon {sobald er abgeholt wird} other {am {at, date, short}, {at, time, withSeconds}}}. Wenn du das nicht veranlasst hast, brich den Umzug ab und ändere dein Passwort.{mailed, select, sent { Eine Warnung ging auch an deine Wiederherstellungs-E-Mail.} other {}}',
  'migration.banner.cancel': 'Umzug abbrechen',
  'migration.banner.cancelFailed': 'Der Umzug ließ sich nicht abbrechen: {reason}',
  'migration.banner.more': '{count, plural, one {# weiterer geplanter Umzug wartet. Öffne die Einstellungen, um ihn zu sehen.} other {# weitere geplante Umzüge warten. Öffne die Einstellungen, um sie zu sehen.}}',
  'migration.confirm.account': '<b>Ziehe {subjectId} nach {me} um?</b> Der Umzug muss auf {source} noch mit dem Passwort dieses Kontos autorisiert werden.',
  'migration.confirm.anotherServer': 'ein anderer Server',
  'migration.confirm.confirming': 'Wird bestätigt…',
  'migration.confirm.done': '<b>{source} wurde mitgeteilt, dass {subject, select, guild {diese Gilde} other {dieses Konto}} bereit ist.</b> Es ist noch nichts umgezogen. Geh zurück zu dem Fenster, in dem du den Umzug gestartet hast: {source} zeigt {target} {subject, select, guild {als neue Inhaberin oder neuen Inhaber der Gilde} other {als Ziel}} und fragt dort nach deinem Passwort, bevor die Bedenkzeit beginnt.',
  'migration.confirm.failed': 'Dieser Umzug ließ sich nicht bestätigen: {reason}',
  'migration.confirm.guild': '<b>Die Gilde {guild} von {source} übernehmen?</b> Sie würde hier {me} gehören. Der Umzug muss auf {source} noch von der Inhaberin oder dem Inhaber der Gilde autorisiert werden.',
  'migration.confirm.guildNamed': '„{name}“ ({id})',
  'migration.confirm.notNow': 'Nicht jetzt',
  'migration.confirm.notYou': 'Wenn du nicht gerade {subject, select, guild {eine Gilde} other {ein Konto}} von {source} umziehen wolltest, wähle Nicht jetzt. Es wird nichts gesendet, solange du nicht bestätigst.',
  'migration.confirm.receive': '{subject, select, guild {Diese Gilde übernehmen} other {Dieses Konto übernehmen}}',
  'migration.confirm.sending': 'Die Bestätigung wird an {source} gesendet…',
  'migration.confirm.thisAccount': 'dieses Konto',
  'migration.confirm.wrongServer': '<b>Dieser Link dient dazu, {subject, select, guild {eine Gilde} other {ein Konto}} nach {destination} umzuziehen.</b> Du bist auf {here} angemeldet. Melde dich ab und dann auf {destination} an oder registriere dich dort und öffne den Link erneut. Es wurde nichts gesendet.',
  'migration.field.destination': 'Zielserver',
  'migration.field.destinationPlaceholder': 'newhome.example.org',
  'migration.field.oldAccountId': 'Alte Konto-ID',
  'migration.field.oldGuildId': 'Alte Gilden-ID',
  'migration.field.oldServer': 'Alter Server',
  'migration.field.password': 'Dein Passwort auf diesem Server',
  'migration.field.passwordHint': 'Das ist das Passwort für den alten/aktuellen Server, nicht für den Zielserver.',
  'migration.guided.authorize': 'Gib dein Passwort erneut ein, um ihn zu autorisieren. Mit dem Planen beginnt eine Bedenkzeit, in der jedes deiner Geräte abbrechen kann.',
  'migration.guided.continue': 'Auf dem neuen Server fortfahren',
  'migration.guided.finishThere': '<b>Schließ auf {destination} ab.</b> Auf der eigenen Seite von {destination} hat sich ein Fenster geöffnet. Melde dich an oder {subject, select, guild {erstelle das Konto, dem die Gilde dort gehören soll} other {erstelle das Konto, in das du umziehst}}, und bestätige dort.',
  'migration.guided.intro': '{subject, select, guild {Nenne den Server, auf den du diese Gilde umziehst.} other {Nenne den Server, auf den du umziehst.}} Bestätige auf seiner Seite und komm dann hierher zurück, um mit deinem Passwort zu autorisieren.',
  'migration.guided.linkExpired': 'Dieser Link ist abgelaufen. Starte neu, um einen neuen zu bekommen.',
  'migration.guided.lookingUp': 'Suche nach {destination}…',
  'migration.guided.noClient': '{destination} veröffentlicht keine Webseite zum Empfangen eines Umzugs. Du kannst trotzdem dorthin umziehen, mit einem auf dem Zielserver erstellten Importcode.',
  'migration.guided.noWindow': 'Falls sich kein Fenster geöffnet hat: <a>{url}</a>',
  'migration.guided.openAgain': 'Erneut öffnen',
  'migration.guided.opening': 'Wird geöffnet…',
  'migration.guided.ready': '<b>{destination} ist bereit.</b> {subject, select, guild {Diese Gilde, {name}, zieht nach {destination} um und gehört dort <id>{target}</id>.} other {Dieses Konto, {name}, zieht nach <id>{target}</id> um.}} Wenn das nicht das Konto ist, das du gerade bestätigt hast, brich hier ab.',
  'migration.guided.startFailed': 'Der Umzug ließ sich nicht starten: {reason}',
  'migration.guided.step': 'Schritt {current, number} von {total, number}',
  'migration.guided.useCode': 'Einen Importcode verwenden',
  'migration.guided.waiting': 'Es wird auf die Bestätigung von {destination} gewartet… Dieser Link funktioniert einmal und läuft {expiresAt, relative} ab.',
  'migration.importCode.hint': 'Einmalig verwendbar und kurzlebig. Füge ihn nur in den Umzugsdialog auf dem alten Server ein.',
  'migration.importCode.label': 'Importcode',
  'migration.importCode.placeholder': 'einmaliger Code vom Zielserver',
  'migration.importCode.sourceHint': 'Erstellt über Einstellungen → Konto → Umzug empfangen auf dem Zielserver. Er läuft nach sieben Tagen ab.',
  'migration.manual.destinationHint': 'Der Server, auf dem du gerade den Importcode erstellt hast.',
  'migration.manual.step1': '{step, number}. Bereite den Zielserver vor.',
  'migration.manual.step1Where': 'Melde dich auf dem Server an, zu dem du umziehen willst, und öffne dann Einstellungen → Konto → Umzug empfangen. Damit wird ein einmaliger Importcode für genau diese Quelle erstellt.',
  'migration.manual.step1Which': 'Verwende für ein Konto das dort erstellte Zielkonto. Verwende für eine Gilde das Konto, dem sie dort gehören soll.',
  'migration.manual.step2': '{step, number}. Autorisiere den Umzug auf diesem Server.',
  'migration.manual.step2Cooling': 'Mit dem Planen beginnt eine Bedenkzeit. Jedes aktive Gerät kann abbrechen, bevor die Übertragung ausgeführt wird.',
  'migration.manual.step2Password': 'Gib unten dein aktuelles Passwort erneut ein.',
  'migration.manual.useGuided': 'Den geführten Umzug verwenden',
  'migration.receive.accountIdHint': 'Deine vollständige ID auf dem alten Server, zum Beispiel @du:old.example.',
  'migration.receive.accountIdPlaceholder': '@du:old.example',
  'migration.receive.another': 'Weiteren Code erstellen',
  'migration.receive.approvalFor': 'Diese Freigabe gilt für {subjectId} von {source}.',
  'migration.receive.create': 'Importcode erstellen',
  'migration.receive.creating': 'Wird vorbereitet…',
  'migration.receive.expires': 'Er läuft am {expiresAt, date, medium} ab ({expiresAt, relative}).',
  'migration.receive.guildIdHint': 'Kopiere die Gilden-ID genau so, wie sie auf dem alten Server angezeigt wird.',
  'migration.receive.guildIdPlaceholder': 'Gilden-ID vom alten Server',
  'migration.receive.guildOwner': 'Die umgezogene Gilde wird hier dem Konto gehören, mit dem du angemeldet bist.',
  'migration.receive.intro': '<b>Du bereitest {destination} als Ziel vor.</b> Durch diesen Schritt wird nichts verschoben oder gelöscht.',
  'migration.receive.nextTitle': 'Geh jetzt zum alten Server zurück.',
  'migration.receive.nextUse': 'Verwende in seinem Umzugsdialog {destination} als Zielserver und füge den obigen Importcode ein.',
  'migration.receive.prepareFailed': 'Dieser Server ließ sich nicht vorbereiten: {reason}',
  'migration.receive.preparing': 'Der alte Server wird geprüft und ein einmaliger Importcode erstellt…',
  'migration.receive.ready': '<b>{destination} ist bereit, diesen Umzug zu empfangen.</b> Es ist noch nichts umgezogen.',
  'migration.receive.sourceFromId': 'Wird aus der obigen Konto-ID gelesen.',
  'migration.receive.sourceGuildHint': 'Der Server, der die Gilde derzeit hostet.',
  'migration.receive.sourcePlaceholder': 'old.example',
  'migration.receive.subject': 'Was empfängst du?',
  'migration.receive.subjectAccount': 'Ein Konto',
  'migration.receive.subjectGuild': 'Eine Gilde',
  'migration.receive.thisServer': 'dieser Server',
  'migration.receive.title': 'Umzug empfangen',
  'migration.schedule.action': 'Umzug planen',
  'migration.schedule.busy': 'Wird geplant…',
  'migration.schedule.failed': 'Umzug nicht gestartet: {reason}',
  'migration.schedule.noDeviceKey': 'Dieses Gerät hat keinen gespeicherten Signaturschlüssel. Der Umzug muss von einem Gerät aus gestartet werden, das bereits zu diesem Konto gehört.',
  'migration.schedule.scheduling': 'Der Umzug wird geplant…',
  'migration.schedule.signFailed': 'Dieses Gerät konnte die Umzugsautorisierung nicht signieren.',
  'migration.schedule.signing': 'Dieser Umzug wird mit diesem Gerät signiert…',
  'migration.scheduled.cancelHint': 'Du kannst während der Bedenkzeit unter Einstellungen → Konto abbrechen.',
  'migration.scheduled.headline': '<b>Der Umzug ist geplant, noch nicht abgeschlossen.</b> Beim Drücken auf Planen wurde nichts gelöscht. Er wird nach {destination} umziehen, {at, relative}, sofern nicht vorher ein aktives Gerät abbricht.',
  'migration.title.account': 'Dieses Konto umziehen',
  'migration.title.guild': 'Diese Gilde umziehen',

  // ---- notifications
  'notifications.alerts.callRing.hint': 'Ein wiederholter Klingelton, während dich jemand in einem Gespräch anruft. Hört auf, wenn du annimmst, ablehnst oder die andere Seite aufgibt.',
  'notifications.alerts.callRing.label': 'Bei eingehenden Anrufen klingeln',
  'notifications.alerts.dms.hint': 'Jede Nachricht in einer Direktnachricht ist an dich gerichtet, deshalb decken Erwähnungen sie nicht ab.',
  'notifications.alerts.dms.hintAndroid': 'Zeigt verschlüsselte Hinweise zu Direktnachrichten und Gruppenchats, während Telium im Hintergrund oder ganz geschlossen ist. Hinweise bei beendeter App bleiben allgemein, bis MLS wieder läuft.',
  'notifications.alerts.dms.label': 'Bei Direktnachrichten benachrichtigen',
  'notifications.alerts.mentions.hint': 'Zeigt eine Benachrichtigung, wenn du erwähnt wirst, während Telium im Hintergrund ist.',
  'notifications.alerts.mentions.label': 'Bei Erwähnungen benachrichtigen',
  'notifications.alerts.preview.full': 'Vollständige Vorschau',
  'notifications.alerts.preview.hidden': 'Absender und Inhalt verbergen',
  'notifications.alerts.preview.hint': 'Steuert, was Systembenachrichtigungen auf diesem Gerät preisgeben. Die Einstellung wird mit deinem Konto synchronisiert; der Nachrichteninhalt bleibt weiterhin in Teliums verschlüsseltem Benachrichtigungsweg.',
  'notifications.alerts.preview.label': 'Benachrichtigungsvorschauen',
  'notifications.alerts.preview.sender': 'Nur Absender / Titel',
  'notifications.alerts.sound.hint': 'Wird abgespielt, solange der Client läuft, egal ob er im Vordergrund ist.',
  'notifications.alerts.sound.label': 'Bei Erwähnungen und Direktnachrichten einen Ton abspielen',
  'notifications.alerts.soundMessages.hint': 'Jede Nachricht in einem Kanal, den du liest, nicht nur die an dich gerichteten.',
  'notifications.alerts.soundMessages.label': 'Auch bei gewöhnlichen Nachrichten',
  'notifications.alerts.title': 'Hinweise',
  'notifications.local.blockedBrowser': 'Benachrichtigungen sind für diese Seite in den Browsereinstellungen blockiert. Erlaube sie dort zuerst wieder.',
  'notifications.local.blockedSystem': 'Benachrichtigungen sind in den Einstellungen deines Betriebssystems blockiert. Erlaube Telium dort zuerst wieder.',
  'notifications.local.browserPermission': 'Browser-Berechtigung',
  'notifications.local.description': 'Hinweise aus diesem Browser oder der Desktop-App, während Telium im Hintergrund läuft.',
  'notifications.local.enable': 'Aktivieren',
  'notifications.local.enabled': 'Benachrichtigungen sind auf diesem Gerät aktiviert.',
  'notifications.local.enableFailed': 'Benachrichtigungen ließen sich nicht aktivieren: {reason}',
  'notifications.local.enabling': 'Wird aktiviert…',
  'notifications.local.permissionState': '{state, select, loading {Wird geprüft…} granted {Erlaubt} denied {Blockiert} unsupported {Nicht verfügbar} other {Noch nicht gefragt}}',
  'notifications.local.reload': 'Neu laden',
  'notifications.local.systemPermission': 'Systemberechtigung',
  'notifications.local.title': 'Lokale Benachrichtigungen',
  'notifications.local.unsupported': 'Lokale Benachrichtigungen sind in diesem Browser nicht verfügbar.',
  'notifications.local.updateReady': 'Eine neuere Version ist installiert',
  'notifications.push.android.action': '{stage, select, unverified {Wecken testen} inbox {Einrichtung abschließen} other {Einrichten}}',
  'notifications.push.android.enrolled': '{outcome, select, verified {Android-Benachrichtigungen im Hintergrund haben einen Test-Weckruf bestanden.} endpoint {Android hat einen Push-Endpunkt registriert, aber die Zustellung des Weckrufs ist nicht verifiziert.} other {Android-Push ist eingerichtet; der Weck-Endpunkt wird registriert.}}',
  'notifications.push.android.enrollFailed': 'Android-Benachrichtigungen ließen sich nicht anmelden: {reason}',
  'notifications.push.android.label': 'Android-Benachrichtigungen im Hintergrund',
  'notifications.push.android.notice': '{stage, select, ready {Bereit für das Aufwecken im Hintergrund. Telium hat über den eingerichteten Push-Anbieter eine echte, inhaltsfreie Testklingel geschickt, und Android hat bestätigt, dass sie den nativen Push-Dienst erreicht hat.} unverified {Der verschlüsselte Posteingang und der Push-Endpunkt sind registriert, aber auf diesem Telefon ist noch kein verifiziertes Aufwecken angekommen. Teste das Wecken, bevor du dich bei geschlossenem Telium auf Benachrichtigungen verlässt.} inbox {Der verschlüsselte Posteingang ist bereit, aber dieses Gerät hat noch keinen bestätigten Weck-Endpunkt. Schließe die Einrichtung ab, um seinen Android-Push-Verteiler zu wählen oder zu erneuern.} none {Richte den verschlüsselten Android-Posteingang und den Push-Verteiler für die Zustellung im Hintergrund ein.} other {Aktiviere zuerst die Systembenachrichtigungen, dann kann Telium dieses Android-Gerät für die verschlüsselte Zustellung im Hintergrund anmelden.}}',
  'notifications.push.android.state': '{stage, select, checking {Wird geprüft…} ready {Bereit} unverified {Wecken unverifiziert} inbox {Nur Posteingang} other {Nicht eingerichtet}}',
  'notifications.push.android.testing': 'Wird getestet…',
  'notifications.push.description': 'Push-Anbieter wecken nur Telium. Der Inhalt der Benachrichtigung bleibt in Teliums verschlüsseltem Posteingang.',
  'notifications.push.desktopOnly': 'Desktop-Benachrichtigungen funktionieren, solange Telium läuft. Eine vollständig geschlossene Desktop-App zu wecken ist noch nicht umgesetzt.',
  'notifications.push.privacyHint': 'Weckmeldungen der Anbieter tragen keinen Nachrichteninhalt. Android und unterstützte Browser holen undurchsichtige Posteingangszeilen ab, entschlüsseln sie auf dem Gerät und bestätigen nur Zeilen, die sie erfolgreich verarbeitet haben.',
  'notifications.push.title': 'Hintergrund-Push',
  'notifications.push.unsupported': 'Dieser Browser kann auf diesem Gerät keinen Hintergrund-Push registrieren.',
  'notifications.push.web.hint': 'Registriert ein verschlüsseltes Web-Push-Abo bei deinem Heimserver.',
  'notifications.push.web.label': 'Diesen Browser wecken, wenn er geschlossen ist',
  'notifications.push.web.off': 'Hintergrund-Push ist in diesem Browser deaktiviert.',
  'notifications.push.web.offFailed': 'Push ließ sich nicht deaktivieren: {reason}',
  'notifications.push.web.on': 'Dieser Browser kann für Benachrichtigungen geweckt werden.',
  'notifications.push.web.onFailed': 'Push ließ sich nicht aktivieren: {reason}',
  'notifications.system.appName': 'Telium',
  'notifications.system.attachmentFrom': '{sender} hat einen Anhang gesendet',
  'notifications.system.calling': 'Anruf bei {name}',
  'notifications.system.channelTitle': '#{channel}',
  'notifications.system.encryptedFrom': '{sender} hat eine verschlüsselte Nachricht gesendet',
  'notifications.system.generic': 'Neue Benachrichtigung',
  'notifications.system.incomingCall': 'Eingehender Anruf',
  'notifications.system.messageFrom': '{sender}: {message}',
  'notifications.system.newDm': 'Neue Direktnachricht',
  'notifications.system.newMention': 'Neue Erwähnung',
  'notifications.system.newReply': 'Neue Antwort',
  'notifications.system.showFailed': 'Eine Benachrichtigung ließ sich nicht anzeigen',
  'notifications.system.unknownChannel': 'kanal',
  'notifications.wake.activity': 'Neue Aktivität in einem Kanal, dem du folgst.',
  'notifications.wake.migration': 'Ein Umzug deines Kontos wurde beantragt. Öffne Telium, um ihn zu prüfen oder abzubrechen.',
  'notifications.wake.updateToast': 'Eine neue Version ist bereit. Lade neu, um sie zu verwenden.',

  // ---- onboarding
  'onboarding.address.clipboardLabel': 'Adresse',
  'onboarding.address.copy': 'Adresse kopieren',
  'onboarding.address.yours': 'Deine Telium-Adresse ist <b>{user}</b>. Du brauchst sie, um dich auf einem anderen Gerät anzumelden.',
  'onboarding.home.advancedHint': 'Erweitert: Gib die HTTPS-Adresse eines beliebigen Telium-Heimservers ein, der Registrierung erlaubt.',
  'onboarding.home.advancedPlaceholder': 'https://home.example',
  'onboarding.home.browseAll': 'Alle Server durchsuchen',
  'onboarding.home.chipAction': '{host} — ändern, wo dein Konto liegt',
  'onboarding.home.chooseOther': 'Einen anderen wählen',
  'onboarding.home.communityBadge': 'Gemeinschaft',
  'onboarding.home.detailSeparator': ' · ',
  'onboarding.home.explainer': 'Dieser Server führt dein Konto und deine Anmeldung. Gemeinschaften können überall liegen.',
  'onboarding.home.finding': 'Ein gesunder Gemeinschaftsserver wird gesucht…',
  'onboarding.home.label': 'Heimserver',
  'onboarding.home.noPinnedKey': 'Dieser Client-Build hat den Signaturschlüssel der Empfehlung noch nicht verankert.',
  'onboarding.home.operatedBy': 'Betrieben von <a>{operator}</a>',
  'onboarding.home.otherChoices': 'Weitere empfohlene Konto-Heimserver',
  'onboarding.home.picked': 'Wir haben <b>{name}</b> für dich ausgewählt',
  'onboarding.home.title': 'Konto-Heimserver',
  'onboarding.home.unavailable': 'Derzeit ist keine verifizierte Gemeinschaftsempfehlung verfügbar. Wähle stattdessen einen beliebigen Heimserver, dem du vertraust.',
  'onboarding.home.uptime': '{rate, number} % letzte Verfügbarkeit',
  'onboarding.home.useAnother': 'Anderen Server verwenden',
  'onboarding.home.useDomain': 'Eine Serverdomain verwenden',
  'onboarding.home.why': 'Hier liegt dein Konto, ein bisschen wie die Wahl eines E-Mail-Anbieters. Du kannst weiterhin mit allen sprechen und jeder Gemeinschaft beitreten, egal welchen Server sie nutzen. Wir verteilen neue Leute auf vertrauenswürdige Server, damit Telium nie von einer einzigen Firma abhängt.',
  'onboarding.invite.accountIdLabel': 'Benutzername oder Konto-ID',
  'onboarding.invite.accountIdPlaceholder': 'deinname oder @du:home.example',
  'onboarding.invite.accountReady': 'Dein Konto ist bereit.',
  'onboarding.invite.backToSignIn': 'Zurück zur Anmeldung',
  'onboarding.invite.createAndJoin': 'Konto erstellen & Beitritt zu {guild}',
  'onboarding.invite.createFailed': 'Dein Konto ließ sich nicht erstellen.',
  'onboarding.invite.creating': 'Konto wird erstellt…',
  'onboarding.invite.displayNameHint': 'Du kannst das später ändern.',
  'onboarding.invite.displayNameLabel': 'Anzeigename',
  'onboarding.invite.displayNamePlaceholder': 'Wie soll dich jeder nennen?',
  'onboarding.invite.existingHomeHint': 'Der Server, auf dem dein bestehendes Telium-Konto liegt.',
  'onboarding.invite.expiredBody': 'Sie ist vielleicht abgelaufen, hat ihre Nutzungsgrenze erreicht oder wurde zurückgezogen.',
  'onboarding.invite.expiredTitle': 'Diese Einladung gilt nicht mehr',
  'onboarding.invite.goToTelium': 'Zu Telium gehen',
  'onboarding.invite.haveAccount': 'Hast du schon ein Telium-Konto? <a>Anmelden</a>',
  'onboarding.invite.homeHint': 'Wo dein neues Konto liegen wird. Eine Änderung ändert nichts an der Einladung.',
  'onboarding.invite.homePlaceholder': 'home.example',
  'onboarding.invite.hostNote': '<b>{domain}</b> hostet diese Gilde. Dein Konto kann auf einem anderen Telium-Server liegen.',
  'onboarding.invite.invited': 'Du wurdest eingeladen beizutreten',
  'onboarding.invite.invitedBy': '{name} hat dich eingeladen beizutreten',
  'onboarding.invite.join': 'Beitreten: {guild}',
  'onboarding.invite.joinFailed': 'Der Beitritt zu dieser Gilde ist nicht gelungen.',
  'onboarding.invite.joining': 'Beitritt läuft…',
  'onboarding.invite.joiningAs': 'Beitritt als {name}.',
  'onboarding.invite.legacyRegisterAction': 'Alte Registrierung verwenden',
  'onboarding.invite.legacyServer': '<b>Dieser Heimserver verwendet die alte Passwort-Authentifizierung.</b> Wenn du fortfährst, wird dein Passwort an diesen Server gesendet. Tu das nur, wenn du ihm vertraust.',
  'onboarding.invite.legacySignInAction': 'Alte Anmeldung verwenden',
  'onboarding.invite.legacyUpgrade': '<b>Dieses alte Konto braucht eine einmalige Sicherheitsaktualisierung.</b> Nur bei diesem Versuch erhält der Server dein Passwort. Spätere Anmeldungen nicht.',
  'onboarding.invite.legacyUpgradeAction': 'Dieses Konto aktualisieren',
  'onboarding.invite.members': '{count, plural, one {# Mitglied} other {# Mitglieder}}',
  'onboarding.invite.mfaLabel': 'Authentifizierungscode',
  'onboarding.invite.mfaPlaceholder': '123456 oder Wiederherstellungscode',
  'onboarding.invite.mfaPrompt': 'Gib den sechsstelligen Code aus deiner Authentifizierungs-App oder einen deiner Wiederherstellungscodes ein.',
  'onboarding.invite.needAccount': 'Brauchst du ein Telium-Konto? <a>Erstelle eins</a>',
  'onboarding.invite.needCredentials': 'Gib deinen Benutzernamen und dein Passwort ein.',
  'onboarding.invite.needDisplayName': 'Wähle den Anzeigenamen, den die Leute in der Gilde sehen sollen.',
  'onboarding.invite.needHome': 'Wähle einen Heimserver für dein Konto.',
  'onboarding.invite.newHomeHint': 'Der Server, zu dem dein neues Telium-Konto gehören wird.',
  'onboarding.invite.noIdentityRole': '{name} hostet keine Benutzerkonten.',
  'onboarding.invite.online': '{count, plural, one {# online} other {# online}}',
  'onboarding.invite.opening': 'Einladung wird geöffnet…',
  'onboarding.invite.openingHint': 'Der Server dieser Gilde wird gefragt, was der Link öffnet.',
  'onboarding.invite.registrationClosed': '{name} nimmt derzeit keine neuen Konten an.',
  'onboarding.invite.screeningPending': 'Dein Konto ist bereit. Diese Gilde verlangt eine Prüfung, bevor du Mitglied wirst.',
  'onboarding.invite.signInAndJoin': 'Anmelden & Beitritt zu {guild}',
  'onboarding.invite.signInFailed': 'Die Anmeldung ist nicht gelungen.',
  'onboarding.invite.signingIn': 'Anmeldung läuft…',
  'onboarding.invite.unopenableTitle': 'Diese Einladung ließ sich nicht öffnen',
  'onboarding.invite.unreachable': 'Der Server der Gilde war nicht erreichbar.',
  'onboarding.invite.useAnotherAccount': 'Ein anderes Konto verwenden',
  'onboarding.invite.usernameHint': 'Das wird der erste Teil deiner Telium-Konto-ID.',
  'onboarding.invite.usernamePlaceholder': 'deinname',
  'onboarding.recoveryKey.body': 'Er kann dein Passwort zurücksetzen und dein verschlüsseltes Konto wiederherstellen.',
  'onboarding.recoveryKey.clipboardLabel': 'Wiederherstellungsschlüssel',
  'onboarding.recoveryKey.confirm': 'Ich habe meinen Wiederherstellungsschlüssel gespeichert',
  'onboarding.recoveryKey.copy': 'Wiederherstellungsschlüssel kopieren',
  'onboarding.recoveryKey.download': 'Als Datei herunterladen',
  'onboarding.recoveryKey.finishing': 'Wird abgeschlossen…',
  'onboarding.recoveryKey.title': 'Speichere deinen Wiederherstellungsschlüssel',
  'onboarding.recoveryKey.warning': '<b>Bewahre ihn getrennt von deinem Passwort auf.</b> Er kann nicht neu erzeugt werden.',

  // ---- perms
  'perms.add_reactions.hint': 'Eine neue Reaktion auf eine Nachricht setzen. Einer bestehenden beizutreten erfordert nichts.',
  'perms.add_reactions.label': 'Reaktionen hinzufügen',
  'perms.administrator.hint': 'Jede Berechtigung auf diesem Server, und jede Überschreibung in Kanälen wird ignoriert. Gib das nur jemandem, dem du die Gilde selbst anvertrauen würdest.',
  'perms.administrator.label': 'Administrator',
  'perms.attach_files.hint': 'Bilder und Dateien in den eigenen Medienspeicher dieser Gilde hochladen.',
  'perms.attach_files.label': 'Dateien anhängen',
  'perms.ban_members.hint': 'Ein Konto über seine Konto-ID daran hindern, wieder beizutreten — auf jedem Heimserver.',
  'perms.ban_members.label': 'Mitglieder sperren',
  'perms.connect.hint': 'Sichtbaren Sprachkanälen beitreten.',
  'perms.connect.label': 'Verbinden',
  'perms.create_invite.hint': 'Einladungscodes erstellen, die Konten von jedem beliebigen Heimserver hereinlassen.',
  'perms.create_invite.label': 'Einladung erstellen',
  'perms.deafen_members.hint': 'Andere daran hindern, einen Sprachkanal zu hören.',
  'perms.deafen_members.label': 'Mitglieder taubschalten',
  'perms.embed_links.hint': 'Links, die gepostet werden, zu Vorschauen entfalten.',
  'perms.embed_links.label': 'Links einbetten',
  'perms.kick_members.hint': 'Mitglieder entfernen, deren höchste Rolle unter der eigenen steht. Ein Hinauswurf ist keine Sperre: Mit einer neuen Einladung steht der Weg zurück offen.',
  'perms.kick_members.label': 'Mitglieder hinauswerfen',
  'perms.manage_channels.hint': 'Die Kanäle dieser Gilde erstellen, umbenennen, umsortieren und löschen.',
  'perms.manage_channels.label': 'Kanäle verwalten',
  'perms.manage_expressions.hint': 'Die Emojis und Sticker hochladen und entfernen, die diese Gilde bereitstellt.',
  'perms.manage_expressions.label': 'Emoji und Sticker verwalten',
  'perms.manage_guild.hint': 'Name, Symbol, Einlasskontrolle und Sprachregion dieser Gilde ändern.',
  'perms.manage_guild.label': 'Gilde verwalten',
  'perms.manage_messages.hint': 'Nachrichten beliebiger Personen löschen und anheften.',
  'perms.manage_messages.label': 'Nachrichten verwalten',
  'perms.manage_roles.hint': 'Rollen unterhalb der eigenen bearbeiten und diese Rollen an beliebige Personen vergeben. Eine Berechtigung, die nicht schon selbst vorhanden ist, lässt sich nie vergeben.',
  'perms.manage_roles.label': 'Rollen verwalten',
  'perms.mention_everyone.hint': 'Die ganze Gilde anpingen oder jede beliebige Rolle — egal, ob diese Rolle erwähnbar ist.',
  'perms.mention_everyone.label': '@everyone und Rollen erwähnen',
  'perms.moderate_members.hint': 'Ein Mitglied eine Zeit lang stummschalten. Wer im Timeout ist, kann nur noch mitlesen.',
  'perms.moderate_members.label': 'Timeouts verhängen',
  'perms.move_members.hint': 'Personen zwischen Sprachkanälen hin- und herschieben oder ganz aus ihnen herausziehen.',
  'perms.move_members.label': 'Mitglieder verschieben',
  'perms.mute_members.hint': 'Andere in Sprachkanälen stummschalten.',
  'perms.mute_members.label': 'Mitglieder stummschalten',
  'perms.priority_speaker.hint': 'Beim Sprechen über alle anderen hinweg gehört werden.',
  'perms.priority_speaker.label': 'Priorisierter Sprecher',
  'perms.read_message_history.hint': 'Lesen, was vor der eigenen Ankunft gesagt wurde. Ohne sie startet ein Kanal leer.',
  'perms.read_message_history.label': 'Nachrichtenverlauf lesen',
  'perms.send_messages.hint': 'In Textkanälen schreiben, die sichtbar sind.',
  'perms.send_messages.label': 'Nachrichten senden',
  'perms.speak.hint': 'In der Sprache gehört werden. Ohne sie lässt sich zuhören.',
  'perms.speak.label': 'Sprechen',
  'perms.stream.hint': 'In der Sprache einen Bildschirm teilen.',
  'perms.stream.label': 'Live gehen',
  'perms.use_external_emoji.hint': 'Emojis verwenden, die andere Gilden bereitstellen — auf anderen Heimservern.',
  'perms.use_external_emoji.label': 'Externe Emojis verwenden',
  'perms.video.hint': 'In der Sprache eine Kamera einschalten.',
  'perms.video.label': 'Video',
  'perms.view_audit_log.hint': 'Im Prüfprotokoll nachlesen, wer auf diesem Server was geändert hat.',
  'perms.view_audit_log.label': 'Prüfprotokoll ansehen',
  'perms.view_channel.hint': 'Kanäle ansehen, die von keiner Überschreibung ausgeschlossen wurden.',
  'perms.view_channel.label': 'Kanäle ansehen',

  // ---- security
  'security.codes.clipboardName': 'Wiederherstellungscodes',
  'security.codes.copy': 'Kopieren',
  'security.codes.download': 'Als Datei herunterladen',
  'security.codes.fileHeading': 'Telium-Wiederherstellungscodes für die Zwei-Faktor-Authentifizierung',
  'security.codes.listLabel': '{count, plural, one {# Wiederherstellungscode} other {# Wiederherstellungscodes}}',
  'security.codes.title': 'Wiederherstellungscodes',
  'security.codes.warning': '<b>Schreib sie auf, bevor du weitermachst.</b> Jeder funktioniert einmal, und sie werden nicht erneut angezeigt.',
  'security.devices.addedAt': '{at, date, medium}',
  'security.devices.allVerified': '{count, plural, one {Dein Gerät ist verifiziert.} other {Alle # deiner Geräte sind verifiziert.}}',
  'security.devices.cannotSign': 'Dieses Gerät kann noch nicht für dein Konto signieren. Verifiziere es von einem Gerät aus, das du bereits benutzt, oder entsperre deine Nachrichten unter {pane}.',
  'security.devices.checking': 'Deine Geräte werden geprüft.',
  'security.devices.colAdded': 'Hinzugefügt',
  'security.devices.colDevice': 'Gerät',
  'security.devices.colLastSeen': 'Zuletzt gesehen',
  'security.devices.empty': 'Keine Geräte verzeichnet.',
  'security.devices.lastSeenAt': '{at, relative}',
  'security.devices.noneVerified': '{count, plural, one {Dein Gerät ist noch nicht verifiziert.} other {Keines deiner # Geräte ist bisher verifiziert.}}',
  'security.devices.recogniseNote': 'Melde alles ab, das du nicht wiedererkennst.',
  'security.devices.revocationBody': 'Eine Geräteabmeldung entzieht dem Gerät seine Berechtigung auf deinem Heimserver. Alles, was ihm bereits zugestellt wurde, bleibt zugestellt.',
  'security.devices.revocationTitle': 'Widerruf',
  'security.devices.revokeHint': 'Eine Geräteabmeldung braucht ein paar Minuten, bis sie wirkt, nicht Sekunden.',
  'security.devices.signedOut': 'abgemeldet',
  'security.devices.signOut': 'Abmelden',
  'security.devices.signOutDevice': 'Abmelden: {device}',
  'security.devices.signOutFailed': 'Dieses Gerät ließ sich nicht abmelden. {reason}',
  'security.devices.someUnverified': '{count, plural, one {# deiner {total, plural, one {# Gerät} other {# Geräte}} ist noch nicht verifiziert.} other {# deiner {total, plural, one {# Gerät} other {# Geräte}} sind noch nicht verifiziert.}}',
  'security.devices.tableLabel': 'Bei deinem Konto angemeldete Geräte',
  'security.devices.thisDevice': 'dieses Gerät',
  'security.devices.unverifiedBadge': 'unverifiziert',
  'security.devices.unverifiedNote': 'Ein unverifiziertes Gerät kann weiterhin lesen, was du sendest. Es zu verifizieren ist der Weg, festzustellen, dass es deins ist und nicht jemand, der sich als du ausgibt.',
  'security.devices.verifiedBadge': 'verifiziert',
  'security.devices.verify': 'Verifizieren',
  'security.devices.verifyDevice': 'Verifiziere {device}',
  'security.devices.whatVerifiedBody': 'Ein verifiziertes Gerät ist eines, für das dein eigener Kontoschlüssel signiert hat. Dein Server führt diese Liste, kann diese Signaturen aber nicht fälschen; das Abzeichen ist also eine Aussage deines Kontos und nicht eine des Betreibers.',
  'security.devices.whatVerifiedTitle': 'Was „verifiziert“ hier bedeutet',
  'security.mfa.appHint': 'Verwende eine beliebige standardkonforme TOTP-Authentifizierungs-App mit 6 Ziffern.',
  'security.mfa.codeFieldLabel': '6-stelliger Code',
  'security.mfa.codeLabel': 'Code aus der App oder Wiederherstellungscode',
  'security.mfa.disable': 'Zwei-Faktor-Authentifizierung ausschalten',
  'security.mfa.disabledToast': 'Die Zwei-Faktor-Authentifizierung ist aus.',
  'security.mfa.disableFailed': 'Die Zwei-Faktor-Authentifizierung ließ sich nicht ausschalten. {reason}',
  'security.mfa.enabled': '{remaining, plural, =0 {Die Zwei-Faktor-Authentifizierung ist an, und du hast keine Wiederherstellungscodes mehr. Wenn du deine Authentifizierungs-App verlierst, kannst du dich nicht mehr anmelden — schalte die Zwei-Faktor-Authentifizierung aus und richte sie erneut ein, um einen neuen Satz zu bekommen.} one {Die Zwei-Faktor-Authentifizierung ist an. Es ist noch # Wiederherstellungscode übrig.} other {Die Zwei-Faktor-Authentifizierung ist an. Es sind noch # Wiederherstellungscodes übrig.}}',
  'security.mfa.enabledNoCount': 'Die Zwei-Faktor-Authentifizierung ist an.',
  'security.mfa.enabledToast': 'Die Zwei-Faktor-Authentifizierung ist an.',
  'security.mfa.enableFailed': 'Die Zwei-Faktor-Authentifizierung ließ sich nicht einschalten. {reason}',
  'security.mfa.manualHint': 'Verwende das nur, wenn deine App den QR-Code nicht scannen kann.',
  'security.mfa.manualLabel': 'Manueller Einrichtungsschlüssel',
  'security.mfa.qrLabel': 'QR-Code zum Einrichten deiner Authentifizierungs-App',
  'security.mfa.reauthHint': 'Gib dein Passwort erneut ein. Es wird auf diesem Gerät geprüft und nicht gesendet.',
  'security.mfa.scanWarning': 'Scanne diesen QR-Code und gib dann den Code ein, den er anzeigt. Die Zwei-Faktor-Authentifizierung ist erst an, wenn das gelingt.',
  'security.mfa.setUp': 'Authentifizierungs-App einrichten',
  'security.mfa.setupFailed': 'Die Einrichtung der Zwei-Faktor-Authentifizierung ließ sich nicht starten. {reason}',
  'security.mfa.title': 'Zwei-Faktor-Authentifizierung',
  'security.mfa.verifyEnable': 'Verifizieren und einschalten',
  'security.mfa.whyPasswordBody': 'Auf einem OPAQUE-Heimserver verlässt dein Passwort dieses Gerät nie. Wenn du es hier eingibst, entsteht ein einmalig verwendbarer Nachweis, dass du die Kontoinhaberin oder der Kontoinhaber bist, und der autorisiert die Änderung.',
  'security.mfa.whyPasswordTitle': 'Warum das Passwort erneut abgefragt wird',
  'security.trustedLinks.description': 'Links zu diesen Domains öffnen sich ohne Nachfrage. Alles andere außerhalb deiner Server wird vorher bestätigt.',
  'security.trustedLinks.empty': 'Du hast noch keine Domains als vertrauenswürdig markiert.',
  'security.trustedLinks.forget': 'Erneut nachfragen bei {domain}',
  'security.trustedLinks.title': 'Vertrauenswürdige Links',
  'security.verify.comparePeer': 'Vergleiche sie mit {name} persönlich oder in einem Anruf.',
  'security.verify.compareSelf': '{count, plural, one {Beide Geräte sollten dieses Bild anzeigen.} other {Beide Geräte sollten diese # in dieser Reihenfolge anzeigen.}}',
  'security.verify.confirmingPeer': 'Es wird auf die Bestätigung von {name} gewartet…',
  'security.verify.confirmingSelf': 'Es wird auf die Bestätigung deines anderen Geräts gewartet…',
  'security.verify.donePeer': '{name} ist auf allen deinen Geräten verifiziert, auch auf jedem, das später hinzukommt.',
  'security.verify.doneSelf': 'Dieses Gerät ist verifiziert. Jeder, der dich verifiziert hat, sieht es ebenfalls.',
  'security.verify.finishFailed': 'Die Verifizierung ließ sich nicht abschließen. {reason}',
  'security.verify.match': 'Sie stimmen überein',
  'security.verify.mismatchHint': 'Wenn sie abweichen, sitzt etwas dazwischen.',
  'security.verify.noMatch': 'Sie stimmen nicht überein',
  'security.verify.pendingHintPeer': 'Welches Gerät auch antwortet, das deckt deren ganzes Konto ab.',
  'security.verify.pendingHintSelf': 'Öffne dort Telium; beide müssen gleichzeitig online sein.',
  'security.verify.startFailed': 'Die Verifizierung ließ sich nicht starten. {reason}',
  'security.verify.starting': 'Wird gestartet…',
  'security.verify.stopped': 'Verifizierung abgebrochen: {reason}.',
  'security.verify.stoppedByYou': 'Die Verifizierung wurde abgebrochen, weil die Bilder nicht übereingestimmt haben. Dieses Gerät ist weiterhin unverifiziert.',
  'security.verify.titlePeer': 'Verifiziere {name}',
  'security.verify.titleSelf': 'Dein anderes Gerät verifizieren',
  'security.verify.waitingButton': 'Warten',
  'security.verify.waitingPeer': 'Es wird gewartet, bis {name} Telium öffnet…',
  'security.verify.waitingSelf': 'Es wird auf dein anderes Gerät gewartet…',

  // ---- settings
  'settings.messages.dateFormat.dmy': 'TT/MM/JJ',
  'settings.messages.dateFormat.hint': 'Nachrichten von einem anderen Tag als heute zeigen ihr Datum neben der Uhrzeit. Hier wählst du, ob der Monat oder der Tag zuerst kommt.',
  'settings.messages.dateFormat.label': 'Datumsformat',
  'settings.messages.dateFormat.mdy': 'MM/TT/JJ',
  'settings.nav.recovery': 'Verschlüsselungsschlüssel',

  // ---- shell
  'shell.a11y.closeMembers': 'Mitgliederliste schließen',
  'shell.a11y.closeMenu': 'Menü schließen',
  'shell.a11y.openChannels': 'Kanäle öffnen',
  'shell.banner.cached': 'Dein letzter Stand von {when} wird angezeigt. Verbindung wird wiederhergestellt…',
  'shell.banner.reload': 'Telium neu laden',
  'shell.banner.retryHome': 'Versuche {domain} erneut',
  'shell.banner.signIn': 'Erneut anmelden',
  'shell.banner.wake': 'Jetzt erneut versuchen',
  'shell.empty.body': 'Wähle einen Kanal, um anzufangen.',
  'shell.empty.title': 'Kein Kanal geöffnet',
  'shell.fallback.lagHours': '{count, plural, one {# Stunde im Rückstand} other {# Stunden im Rückstand}}',
  'shell.fallback.lagMinutes': '{count, plural, one {# Minute im Rückstand} other {# Minuten im Rückstand}}',
  'shell.fallback.lagSeconds': '{count, plural, one {# Sekunde im Rückstand} other {# Sekunden im Rückstand}}',
  'shell.fallback.lagUnknown': 'Alter unbekannt',
  'shell.fallback.promoted': '{home} wird jetzt von {standby} bedient. Alles funktioniert normal.',
  'shell.fallback.readOnly': '{home} antwortet nicht. Es wird eine schreibgeschützte Kopie von {standby} angezeigt, {lag}.',
  'shell.members.search': 'Mitglieder suchen',
  'shell.socket.guildDown': '{name} antwortet nicht. Der Rest von Telium funktioniert normal. Telium versucht es weiter; wenn das anhält, ist die Betreiberin oder der Betreiber dieses Servers die richtige Ansprechperson.',
  'shell.socket.homeDown': '{name} ist der Server deines Kontos und antwortet nicht. Nachrichten, die du sendest, kommen erst an, wenn er zurück ist. Telium versucht es weiter; wenn das anhält, ist die Person, die {name} betreibt, die richtige Ansprechperson.',
  'shell.socket.incompatible': '{name} spricht eine Version von Telium, die dieser Client nicht kennt. Aktualisiere Telium und versuch es erneut.',
  'shell.socket.malformed': '{name} hat nicht verstanden, was dieser Client ihm gesendet hat. Lade Telium neu; wenn es weiterhin passiert, sind dieser Client und dieser Server nicht auf demselben Stand.',
  'shell.socket.offline': 'Dieses Gerät ist offline. Telium macht dort weiter, wo es aufgehört hat, sobald die Verbindung wieder da ist.',
  'shell.socket.reconnecting': '{role, select, home {Verbindung zu {name} wird wiederhergestellt.} other {Verbindung zu {name} wird wiederhergestellt. Andere Server sind nicht betroffen.}}',
  'shell.socket.restarting': '{name} startet neu. Die Verbindung kommt von selbst zurück.',
  'shell.socket.sessionRefused': '{role, select, home {{name} erkennt diese Sitzung nicht mehr. Melde dich neu an, um fortzufahren.} other {{name} erkennt diese Sitzung nicht mehr. Verbinde dich neu damit; der Rest von Telium ist nicht betroffen.}}',
  'shell.socket.unnamedServer': 'dieser Server',
  'shell.tabs.forum': 'Forenbeiträge',
  'shell.tabs.pinned': 'Angeheftete Nachrichten',
  'shell.title.guild': 'Gilde',

  // ---- voice
  'voice.bar.pingAvg': 'Durchschnitt',
  'voice.bar.pingHistory': 'Ping-Verlauf',
  'voice.bar.pingLast': 'Letzter Ping',
  'voice.log.cancel': 'Abbrechen',
  'voice.log.ended': 'Gespräch beendet',
  'voice.log.endedDuration': 'Gespräch beendet · {duration}',
  'voice.log.incoming': 'Eingehendes Gespräch',
  'voice.log.missed': 'Verpasstes Gespräch',
  'voice.log.outgoing': 'Ausgehendes Gespräch',
  'voice.log.ringing': 'Es klingelt…',
  'voice.log.ringingHint': 'Es wird gewartet, bis abgenommen wird.',
  'voice.status.clear': 'Leeren',
  'voice.status.clearFailed': 'Der Sprachstatus ließ sich nicht leeren',
  'voice.status.edit': 'Sprachstatus bearbeiten',
  'voice.status.hint': '{count} von {max} Zeichen',
  'voice.status.label': 'Sprachstatus',
  'voice.status.placeholder': 'Was macht dieser Raum gerade?',
  'voice.status.save': 'Status speichern',
  'voice.status.saveFailed': 'Der Sprachstatus ließ sich nicht setzen',
  'voice.status.set': 'Sprachstatus festlegen',
  'voice.status.tooLong': 'Bleib unter {max} Zeichen.',
  'voice.tile.screenAudioVolume': 'Lautstärke des Bildschirmtons',
  'voice.tile.screenAudioVolumeFor': '{name}: Lautstärke des Bildschirmtons',

};
