// Français.
//
// A complete translation: every English key has a French sentence here, so
// nothing falls back to English. It was written in two passes -- the body by
// hand, in the order `docs/translating.md` recommends (`common`, then `errors`,
// then the small boot-screen namespaces), and the block near the end headed
// "added to reach 100%" as a machine-assisted draft no human has read. That
// second pass is why this language carries no stamps in `catalog/stamps.json`:
// a stamp is a claim a person read the English and wrote the French, and for
// the added block no such claim has been made. The security-sensitive
// namespaces -- `auth`, `security`, `perms`, `migration` -- are in that draft
// block, so they are the strings to read first and slowest before trusting
// this file.
//
// ------------------------------------------------- why French is in the tree
//
// Not for the number of speakers. German is the length test, Japanese the
// no-plural test, Arabic the right-to-left test. French is here for three
// traps that none of the other four springs, and all three are in this file.
//
// **Zero is singular.** `Intl.PluralRules('fr').select(0)` is `one`. English,
// German and Japanese all answer `other` for zero and Arabic answers `zero`;
// French is the only language shipped here where a count of nothing takes the
// *singular* arm. So `0 message`, with a singular noun -- and, less obviously,
// the sentence around the number has to read correctly at zero as well as at
// one, which is a constraint no other catalogue in this directory has.
//
// **A plural arm nobody will ever see by hand.** French has three categories:
// `one`, `many`, `other`. `many` is reached only at 1 000 000 and above, where
// French inserts a preposition the other arms do not have -- « 1 000 000 de
// messages », never « 1 000 000 messages ». That is the whole reason the arm
// exists and the reason it must not be a copy of `other`. No amount of
// clicking around the app will ever display it; `i18n-coverage.test.js` is
// what makes sure it is written anyway.
//
// **Apostrophes, and this is the one that bites.** ICU treats a lone ASCII `'`
// immediately before `{`, `}` or `#` as the start of a quoted run, and French
// prose cannot avoid elision: `l'`, `d'`, `n'`, `qu'`. So
// `"Supprimer l'{item} ?"` renders as `Supprimer l{item} ?` -- the apostrophe
// eaten, the placeholder printed as itself, nothing thrown, nothing logged.
// **The convention in this file is the typographic apostrophe `’` (U+2019),
// everywhere, without exception.** It has no special meaning to ICU at all, so
// the quoting rules never come up; it is also simply the correct character for
// French typography. Doubling the ASCII one works too, and is harder to read
// and easier to get wrong by exactly one. If you add a key here, type `’`.
//
// ------------------------------------------------------------- conventions
//
//   * **Vous, throughout.** Decided once, and never mixed. The English copy is
//     informal ("Slow down a moment") and `tu` would carry that better in a
//     chat client aimed at friends -- but this catalogue is mostly `errors`,
//     `settings` and the boot screens, which is the software speaking to a
//     stranger about their account, their password and their device. French
//     software that says `tu` there reads as a game rather than a tool, and
//     the mixture of the two registers reads as two people having written the
//     app. `vous` also has a second, unglamorous advantage: it is the register
//     the whole French-speaking world shares, and this file is read in Lyon,
//     Montréal, Dakar and Brussels.
//
//   * **Espace fine insécable.** French puts a thin non-breaking space before
//     `:`, `;`, `?` and `!`, and inside `«  »`. It is written here as U+202F,
//     a real character in the pattern, because the string is what reaches the
//     screen and `Intl` does not put it there. An ordinary non-breaking space
//     (U+00A0) is used in the two places where French wants a full one: before
//     `%` and between a number and a unit symbol. Both are invisible in a
//     diff, so if you are editing a sentence here, copy an existing one rather
//     than retyping the punctuation.
//
//   * **Nothing numeric is formatted by hand.** `{n, number}`,
//     `{at, date, medium}`, `{limit, bytes}` already produce `1 234,5` with the
//     narrow no-break group separator French uses, and `1,4 Mo`. A separator
//     typed into a pattern is wrong the first time the number gets bigger, and
//     it does not follow a locale change.
//
//   * **Placeholders are never renamed and never dropped**, only moved. The
//     name is the contract with the calling code; a renamed one renders as
//     nothing, and `i18n-coverage.test.js` walks both patterns and compares.
//     Where French wanted a different word order, the placeholder moved -- that
//     is what these are patterns for.
//
//   * **The reader has no gender here.** French agrees past participles and
//     adjectives with the person addressed, and this catalogue does not know
//     who that is. Every sentence that would have needed `vous êtes
//     mentionné(e)` or `vous êtes exclu(e)` was rewritten so the agreement
//     never arises -- « lorsque quelqu’un vous mentionne », « vous êtes sous
//     exclusion temporaire ». That is not squeamishness: parenthesised endings
//     are unreadable aloud, and a screen reader says them.
//
// ------------------------------------------------------------ terminology
//
//   * **serveur d’accueil** for `homeserver`. It is the established French
//     term for this exact thing and not a transliteration, which is what the
//     note on `common.homeserver` asks for. English keeps two forms -- the
//     one-word compound for the software and the two-word phrase for the
//     reader's own server as a thing in the world. French has no such
//     distinction available, and the English note says a language without one
//     should use a single form for both. It does.
//   * **guilde** for `guild`, not « serveur ». Telium already has a server --
//     the homeserver -- and reusing the word for the other thing would make
//     `errors.not_a_guild_server` unreadable.
//   * **salon** for `channel`. It is what French speakers call a chat channel;
//     « canal » is a waterway or a TV band.
//   * **octets** for byte units: `o`, `Ko`, `Mo`, `Go`, `To`. Unlike German
//     and Arabic, which keep the Latin `KB`, French genuinely has its own unit
//     and uses it everywhere, including in every operating system a French
//     reader has ever opened a file manager in.
//   * Kept in English, deliberately: **push**, **bot**, **Web Push**,
//     **Telium**. These are what the French-speaking internet actually says,
//     and inventing French for them would produce a sentence a reader has to
//     translate back. Each one carries a note where it first appears.

export const messages = {
  // ------------------------------------------------------------- format
  //
  // The two seams where `Intl` stops. Everything else about a number, a date
  // or a size comes from CLDR; these are the words around them.

  'format.justNow': 'à l’instant',

  // The unit *is* translated here, which is the difference between French and
  // the German and Arabic catalogues next door: both of those keep `KB`,
  // because technical writing in those languages does. French does not -- an
  // octet is an octet, every file manager a French reader has used says `Mo`,
  // and `1,4 MB` on a French screen looks like an untranslated string. `b` is
  // the bare-bytes case and is lower-case `o` for the same reason.
  //
  // The space before the unit is a non-breaking one (U+00A0) rather than the
  // plain space English uses. French typography asks for it, and the number
  // and its unit are one token to a reader: `1,4` at the end of a line with
  // `Mo` at the start of the next is a rendering bug as far as anybody looking
  // at it is concerned. Nothing pins this string the way `src/test/lib.test.js`
  // pins the English one, so French can have the better typography for free.
  //
  // `{value}` arrives already formatted -- the decimal comma is `Intl`'s work,
  // so a French reader sees `1,4` -- which is why it is interpolated plainly
  // and not through `{value, number}`.
  'format.bytes.b': '{value} o',
  'format.bytes.kb': '{value} Ko',
  'format.bytes.mb': '{value} Mo',
  'format.bytes.gb': '{value} Go',
  'format.bytes.tb': '{value} To',

  // -------------------------------------------------------------- common
  //
  // The words on every screen. Two rules run through the whole group.
  //
  // A control's label is an **infinitive** (« Enregistrer », « Supprimer »),
  // which is the French UI convention and what every reader expects on a
  // button; a sentence addressed to the reader is an **imperative with vous**
  // (« Saisissez le code »). English uses the bare verb for both and the
  // distinction is invisible in it. Getting this backwards is the single most
  // recognisable sign of a machine translation: a button that says
  // « Enregistrez » is shouting an order at somebody who was only going to
  // press it.
  //
  // And a state is an **adjective agreeing with what it describes**, which is
  // why `common.on` is « Activé » and `notifications.local.permissionState`
  // says « Autorisées » -- the second one is describing « les notifications »,
  // which is feminine plural. English cannot express the difference and French
  // cannot avoid it.

  'common.cancel': 'Annuler',
  'common.close': 'Fermer',
  'common.back': 'Retour',
  'common.next': 'Suivant',
  'common.done': 'Terminé',
  'common.save': 'Enregistrer',
  'common.saving': 'Enregistrement…',
  'common.saved': 'Enregistré',
  'common.confirm': 'Confirmer',
  'common.continue': 'Continuer',
  'common.copy': 'Copier',
  'common.copied': 'Copié',

  // French forced a different sentence here, and this is the clearest example
  // in the file of why these are patterns rather than `${what} + ' copied.'`.
  //
  // The English is « {what} copied. » -- the participle after the noun. A
  // French past participle in that position agrees in gender and number with
  // the noun in front of it, and `{what}` is a translated name handed in by
  // whichever button was pressed: « Lien d’invitation » (masculine),
  // « Clé de récupération » (feminine), and one day something plural. There is
  // no form of « copié » that is right for all three and no way for this
  // sentence to find out which it has.
  //
  // So the participle moved to the front, where it is impersonal and therefore
  // invariable, and `{what}` moved behind the colon. It reads as a French
  // interface sentence rather than a translated English one, and it is correct
  // whatever arrives in the placeholder. Note the thin space before the colon.
  'common.copiedThing': 'Copié dans le presse-papiers : {what}',
  'common.clipboardFailed': 'Le presse-papiers est inaccessible.',

  'common.delete': 'Supprimer',
  'common.remove': 'Retirer',
  'common.retry': 'Réessayer',
  'common.refresh': 'Actualiser',
  'common.edit': 'Modifier',
  'common.download': 'Télécharger',
  // « Masquer » and not « Ignorer », which is the obvious first choice and is
  // wrong. « Ignorer » means to disregard something on purpose -- it is what
  // French puts on the button that declines an offer. This button hides a
  // notice that has already been read, and nothing is being refused by
  // pressing it.
  'common.dismiss': 'Masquer',
  'common.learnMore': 'En savoir plus',
  'common.showMore': 'Afficher plus',
  'common.showLess': 'Afficher moins',
  // The control, so the infinitive: this is the button and the placeholder in
  // the field, not the heading of a results page. A heading would be
  // « Recherche ».
  'common.search': 'Rechercher',
  'common.loading': 'Chargement…',
  'common.enable': 'Activer',
  'common.disable': 'Désactiver',

  // English's On/Off has no two-word French equivalent that works in software.
  // « Marche »/« Arrêt » is what a physical appliance says and reads as a
  // washing machine; French interfaces say « Activé »/« Désactivé », which is
  // longer than the English and is why the rows that draw these wrap.
  // Masculine singular, because what they describe is the setting itself.
  'common.on': 'Activé',
  'common.off': 'Désactivé',
  'common.yes': 'Oui',
  'common.no': 'Non',
  // Masculine singular by default. These two are read as values in a list or a
  // table cell, where the thing they stand for is unknown to this file; French
  // has no genderless form and the masculine is what the language uses when
  // the referent is unspecified. A screen that needs « Aucune » because its
  // column is feminine needs its own key in its own namespace -- see the note
  // at the top of `en/common.js` about duplicating freely, and
  // `settings.scheme.tint.none` below, which is exactly that case.
  'common.none': 'Aucun',
  'common.never': 'Jamais',
  'common.unknown': 'Inconnu',
  // « Facultatif », not « Optionnel ». The second is an anglicism that has
  // crept into French software and still reads as one; forms in French say
  // « facultatif » and have for a century.
  'common.optional': 'Facultatif',
  'common.required': 'Obligatoire',
  'common.empty': '—',

  // --------------------------------------------------------- accessibility
  //
  // Read aloud, never drawn. The screen reader announces the role itself, so
  // naming it again ("le bouton Fermer") is heard twice. Name the action.
  // These stay in the infinitive for the same reason the visible labels do:
  // they are the names of controls, not instructions to the listener.

  'common.a11y.close': 'Fermer',
  'common.a11y.back': 'Revenir en arrière',
  'common.a11y.menu': 'Autres actions',
  'common.a11y.dismissNotice': 'Masquer cet avis',
  'common.a11y.copyToClipboard': 'Copier dans le presse-papiers',
  'common.a11y.showPassword': 'Afficher le mot de passe',
  'common.a11y.hidePassword': 'Masquer le mot de passe',
  'common.a11y.loading': 'Chargement en cours',
  // Announced by a live region when a step finishes. `{step}` is the step's own
  // translated name, so the participle after it would have the agreement
  // problem `common.copiedThing` has -- except that here it is describing the
  // *step*, which is « l’étape », feminine, whatever it is called. « Terminé »
  // is left in the impersonal masculine because it is reporting a state of
  // affairs rather than qualifying the noun: this is one line in a stream of
  // announcements, and "Étape 2 — terminé" is how French announces it.
  'common.a11y.stepDone': '{step} — terminé',

  // ------------------------------------------------------------- the nouns

  // See the note in the header. « serveur d’accueil » is the French term for
  // the software a person runs, picks from a list, or types the address of --
  // not a transliteration of the English compound, which is what the note on
  // the English key warns against. `app.boot.unreachableNotice` uses the same
  // phrase where English switches to its two-word form, because French has no
  // second form to switch to and inventing one would make two rows of the same
  // settings pane look like they were talking about different machines.
  'common.homeserver': 'Serveur d’accueil',
  'common.username': 'Nom d’utilisateur',
  'common.password': 'Mot de passe',
  // « E-mail » and not « Courriel ». Both are correct French and « courriel »
  // is the official term in Québec and in French administrative writing, but
  // the word on a field label in software that French speakers actually use is
  // « E-mail », and a field labelled « Courriel » in France reads as a
  // government form. The hyphen is not optional: « email » without it is not a
  // French word.
  'common.email': 'E-mail',
  'common.account': 'Compte',
  // « Appareil », not « Périphérique ». A périphérique is something plugged
  // into a computer; this is the phone or the laptop itself.
  'common.device': 'Appareil',
  'common.settings': 'Paramètres',

  // -------------------------------------------------------- conversations

  // The first `plural` in the file, and the one to read before writing another.
  //
  // Three arms, because `Intl.PluralRules('fr')` says French has three, and
  // all three are required whatever this particular sentence needs:
  //
  //   `one`   -- and this is the trap. French selects `one` for **zero** as
  //              well as for one, so this arm must read correctly at both.
  //              « Groupe - 0 personne » is right; a plural noun here would be
  //              wrong at zero *and* at one. (A group of zero cannot happen in
  //              `conversations.js` today. "Cannot happen today" is a claim
  //              about today's code, and the arm has to exist regardless.)
  //   `many`  -- reached only at 1 000 000 and above. **You cannot see this
  //              arm by using the app**, and it is not decoration: at a
  //              million French inserts « de » that the other arms do not
  //              have -- « 1 000 000 de personnes », never « 1 000 000
  //              personnes ». Copying the `other` arm into it would satisfy
  //              `i18n-coverage.test.js` and still be wrong French, so it is
  //              written as the real sentence. Every `plural` in this file has
  //              one; this is the only comment that explains it.
  //   `other` -- everything else, which is every number a person will see.
  //
  // `#` is the count, formatted by `Intl`, and it includes the reader:
  // `lib/util.js` adds one before passing it, so « Groupe - 3 personnes » is
  // you and two others. The hyphen separator is kept as English has it -- it
  // is a layout convention shared with the German and Arabic catalogues, not
  // French punctuation, and changing it here alone would make one language's
  // conversation list look different from the rest for no reason.
  'common.convo.group': '{count, plural, one {Groupe - # personne} many {Groupe - # de personnes} other {Groupe - # personnes}}',

  // The five activity verbs, drawn separately from the name of what somebody
  // is doing and reassembled by `common.activity.line`.
  //
  // English uses the gerund, which French has no usable equivalent for in this
  // position: « Jouant à » is a participle nobody writes on a screen. So these
  // are the third person singular of the present indicative -- the phrase
  // reads as a small sentence about the person whose card it is
  // (« Écoute Radiohead »), which is exactly how French presence lines are
  // written everywhere else.
  //
  // Two of them carry a preposition that belongs to the verb and not to the
  // English: « jouer **à** » a game, « participer **à** » a competition. They
  // have to stay attached to the verb here, because the name they govern
  // arrives separately and the two halves are drawn in different colours.
  // « Diffuse » is left without one because it takes a direct object.
  'common.activity.playing': 'Joue à',
  'common.activity.streaming': 'Diffuse',
  'common.activity.listening': 'Écoute',
  'common.activity.watching': 'Regarde',
  'common.activity.competing': 'Participe à',
  'common.activity.line': '{verb} {name}',

  // ----------------------------------------------------------------- app
  //
  // The three screens that exist when the rest of the client does not: the
  // connecting card, the unreachable card, and the error boundary. There is no
  // screen around these sentences to give them context, so each has to say
  // what happened and what to do without leaning on anything else.
  //
  // Tone: flat. Not cheerful, not chatty, no apology. French has a strong pull
  // towards « Oups ! Une erreur est survenue 🙁 » in this exact position and it
  // is the wrong register -- somebody reading `app.crash.title` has just lost
  // what they were doing, and somebody reading `app.boot.unreachable` cannot
  // sign in and does not yet know whose fault it is. The neutral French
  // register here is impersonal and matter-of-fact, which is what these use.

  // « cet écran » and not « Telium », deliberately, exactly as in English: most
  // render failures take one view down and the app around it is still alive. A
  // French sentence saying the application had crashed would send people to
  // reload when they did not need to.
  'app.crash.title': 'Un problème est survenu pendant l’affichage de cet écran.',

  // The thrown message is drawn under this in a monospace face and is NOT
  // translated -- it is a developer string in an unknown language, and it is
  // there to be copied into a bug report, where a French version of it would
  // be worth less rather than more.

  'app.crash.reload': 'Recharger',
  // The button opens a pre-filled issue in a browser; nothing is sent by
  // pressing it. « Signaler le problème » is the act, still ahead of the
  // reader. « Envoyer un rapport » would promise a send that does not happen,
  // and « Problème signalé » would claim it already had.
  'app.crash.report': 'Signaler le problème',
  // A question, and it is the disclosure that reveals the storage-reset
  // controls. English phrases it as the thought the person who needs it is
  // already having, and so does this: « Le problème persiste » is the sentence
  // somebody says to themselves after the second failed reload. It also avoids
  // « Toujours bloqué ? », which would have to agree with a reader whose
  // gender this file does not know. Thin space before the question mark.
  'app.crash.recover': 'Le problème persiste après un rechargement ?',

  // `{domain}` is a hostname and is data: never translated, never
  // transliterated, and never wrapped in quotation marks by a translation --
  // French would happily put it in « guillemets » and that would make people
  // think the punctuation was part of the name.
  'app.boot.connecting': 'Connexion à {domain}…',
  'app.boot.switching': 'Passage à {name}…',

  // Two placeholders and a thin space before the colon, which is the whole
  // reason this is a pattern.
  //
  // There is no full stop after `{reason}` and that is not an omission: this
  // sentence wraps around *another sentence*. Every `errors.*` line in this
  // catalogue ends in its own punctuation and so does almost everything a
  // server sends, so adding one here produces « … est injoignable.. » on every
  // coded failure. French punctuates the half before the colon as French does
  // -- hence the U+202F -- and leaves the end alone.
  'app.boot.unreachable': 'Impossible de joindre {domain} : {reason}',

  // A different sentence, not a shorter one: different subject, different
  // culprit, different instruction. The screen above names the reader's server
  // and asks them to wait; this one names their own connection and asks them
  // to fix it. `{domain}` is deliberately absent in English and stays absent
  // here -- naming a server this device has not even tried to reach is the
  // accusation the split exists to prevent.
  'app.boot.offline': 'Cet appareil est hors ligne. Telium vous connectera dès que la connexion sera rétablie.',

  // The distinction this makes is the reason the screen exists. A dead home
  // server does not sign anybody out and does not end sessions already held --
  // it stops new ones being minted, which is why guilds you are already in
  // keep working and new ones fail. Getting that backwards in French turns a
  // wait into a panic, so « déjà ouvertes » is doing real work and must not be
  // dropped for length.
  'app.boot.unreachableNotice': 'Les sessions déjà ouvertes continuent de fonctionner jusqu’à leur expiration, mais aucune nouvelle session ne peut être créée tant que votre serveur d’accueil est hors service.',

  // The reader's own session, not another device in a list. French marks the
  // difference with the pronominal verb: « se déconnecter » is what you do to
  // yourself, « déconnecter » is what you do to something else. That is
  // precisely the distinction the note on the English key asks to be kept, and
  // it costs nothing here because French has it built in.
  'app.boot.signOut': 'Se déconnecter',

  // -------------------------------------------------------------- errors
  //
  // La partie la plus utile du catalogue, et celle où l’on traduit le plus
  // mal : ces phrases sont lues au pire moment pour être en train de déchiffrer
  // une deuxième langue. Trois règles, reprises de l’anglais et valables mot
  // pour mot en français.
  //
  //   * **Dire ce qui s’est passé, puis quoi faire, dans cet ordre.** La
  //     personne qui lit cherche d’abord à savoir si elle s’est trompée, si
  //     quelque chose est cassé, ou si on lui dit non.
  //   * **Reprendre le détail envoyé par le serveur.** `{permission}`,
  //     `{retry_after}`, `{destination}` arrivent chacun dans leur propre
  //     champ précisément pour que la phrase puisse les placer là où la
  //     grammaire du français les veut. Une phrase qui ignore le champ a jeté
  //     la seule chose précise que le serveur savait.
  //   * **Ne jamais accuser le lecteur du protocole.** « Votre client est trop
  //     ancien » est un fait ; « vous vous y êtes mal pris » est une
  //     accusation, et elle est presque toujours fausse.
  //
  // Et une règle qui n’est pas une question de style : **là où l’anglais est
  // vague exprès, le français reste vague.** Voir juste en dessous.

  // Vague on purpose about *which* half was wrong, and it stays vague. The
  // server sends one code for both cases so that the client cannot leak which
  // one it was; a French sentence saying « aucun compte ne porte ce nom »
  // would hand an attacker the account-enumeration oracle the single code was
  // chosen to deny -- and it would do it in French, where nobody reviewing the
  // English would ever see it. Do not sharpen this.
  'errors.invalid_credentials': 'Ce nom d’utilisateur et ce mot de passe ne correspondent à aucun compte ici.',
  'errors.account_deactivated': 'Ce compte est désactivé. Il sera réactivé dès que vous vous y connecterez.',
  'errors.account_deleted': 'Ce compte a été supprimé ; il n’est plus possible de s’y connecter.',
  'errors.account_already_active': 'Ce compte est déjà actif.',
  'errors.mfa_required': 'Saisissez le code de votre application d’authentification.',
  'errors.invalid_mfa_code': 'Ce code n’est pas le bon. Les codes expirent au bout d’une minute environ — essayez le suivant.',
  'errors.mfa_setup_not_started': 'Commencez par configurer l’authentification à deux facteurs avant de confirmer un code.',
  'errors.mfa_not_configured': 'Aucun deuxième facteur n’est configuré sur ce compte.',
  // Cette phrase doit dire « mettez l’application à jour » et surtout pas
  // « votre mot de passe est faux » : vu de l’intérieur, une tentative de
  // rétrogradation du protocole ressemble exactement à un mot de passe refusé,
  // et c’est la confusion qui fait retaper cinq fois un mot de passe correct.
  'errors.opaque_required': 'Ce compte se connecte avec un échange plus récent que cette version de Telium ne sait pas mener. Mettez Telium à jour, puis réessayez.',
  'errors.reauth_required': 'Confirmez votre mot de passe pour continuer.',
  'errors.reauth_expired': 'Cela a pris trop de temps. Saisissez de nouveau votre mot de passe.',

  // ---------------------------------------------------------------- recovery

  // « phrase de récupération » : ce sont des mots, pas une clé. La clé de
  // récupération (`telium-recovery-v1-…`) est une donnée qui ne se traduit ni
  // ne se translittère jamais ; elle vit dans `auth`, qui n’est pas traduit
  // ici. Les deux ne doivent pas porter le même nom en français.
  'errors.invalid_recovery_proof': 'Cette phrase de récupération ne correspond pas à ce compte. Vérifiez qu’aucun mot ne manque et que deux mots ne sont pas inversés.',
  'errors.recovery_attempt_expired': 'Cette tentative de récupération a expiré. Reprenez depuis le début.',

  // ------------------------------------------------------------ registration

  'errors.registration_closed': 'Ce serveur d’accueil n’accepte pas de nouveaux comptes.',
  'errors.username_taken': 'Quelqu’un a déjà ce nom d’utilisateur sur ce serveur d’accueil.',
  // `{reason}` is a slug and is machine vocabulary: `too_short`, `too_long`,
  // `charset`, `reserved`. **The arm names are not translated** -- translating
  // one deletes a branch and the sentence silently falls through to `other`,
  // which would tell somebody their username is unusable when it is merely too
  // short. The `other` arm exists so that a server inventing a fifth reason
  // still produces a sentence.
  //
  // « tiret bas » for the underscore is the dictionary term and the one that
  // can be read aloud; « underscore » is what most French developers say out
  // loud, and neither is wrong. The written form wins here because this
  // sentence is a rule being explained, not a character being dictated.
  'errors.username_invalid': '{reason, select, too_short {Ce nom d’utilisateur est trop court.} too_long {Ce nom d’utilisateur est trop long.} charset {Un nom d’utilisateur peut contenir des lettres, des chiffres, des points, des tirets et des tirets bas.} reserved {Ce nom d’utilisateur est réservé.} other {Ce nom d’utilisateur ne peut pas être utilisé ici.}}',
  'errors.invite_invalid': 'Cette invitation n’est plus valable. Elle a pu expirer, être épuisée, ou être révoquée.',

  // ------------------------------------------------------------- permissions

  // `{permission}` is the human name of the permission, from `perms.*.label`.
  // German had to drop the article here because it could not agree with a
  // gender the sentence cannot know; French does not have that problem, but
  // only because of how this is built: the article agrees with « permission »,
  // which is in the pattern, and the value sits inside guillemets as a quoted
  // name rather than as a noun the grammar has to accommodate. Keep the
  // guillemets for that reason, and keep the thin spaces inside them -- both
  // are U+202F, and both are what French typography asks for.
  //
  // « permission » rather than « autorisation » is a deliberate split from
  // `notifications.local.systemPermission`: a permission is a Telium bit in
  // the role editor, an autorisation is something the operating system or the
  // browser grants. A reader who sees the same French word in both places will
  // go looking for a role setting in their phone's settings app.
  'errors.missing_permission': 'Il vous faut la permission « {permission} » pour faire cela.',
  'errors.role_hierarchy': 'Vous ne pouvez pas faire cela à une personne dont le rôle le plus élevé est au-dessus du vôtre.',
  // « Seule la personne propriétaire » rather than « Seul le propriétaire ».
  // The owner of a guild is a person whose gender this sentence does not know,
  // and French has no neuter: the masculine would be the default and reads as
  // an assumption in a sentence that is about one specific human being. The
  // German catalogue solved the same problem by naming both forms; French can
  // route around it entirely, which is shorter and does not have to choose an
  // order.
  'errors.owner_only': 'Seule la personne propriétaire de cette guilde peut faire cela.',
  'errors.not_a_member': 'Vous n’êtes pas membre de cette guilde.',
  // « sous exclusion temporaire » rather than « vous êtes exclu », which would
  // have to agree with the reader. `{expires_at, time, short}` is formatted by
  // `Intl`, so it is a 24-hour clock in French without this file doing
  // anything.
  'errors.timed_out': 'Vous êtes sous exclusion temporaire ici jusqu’à {expires_at, time, short}.',

  // ------------------------------------------------------------ bot sessions

  // « bot » stays English. It is the word French speakers use for this, it is
  // the word the SDK and the bot management pane use, and « robot » would be a
  // machine with arms.
  'errors.bot_not_installed': 'Ce bot n’est pas installé sur ce serveur de guilde.',
  'errors.assertion_rejected': 'Ce serveur de guilde n’a pas accepté les identifiants de ce bot.',
  'errors.not_a_guild_server': 'Cette adresse n’héberge pas de guildes.',

  // ------------------------------------------------------------ availability

  // The second `plural`, and the one where the French categories are easiest
  // to get wrong. See `common.convo.group` above for the full explanation of
  // the three arms.
  //
  // `=0` is an exact-value arm and not a plural category: it is here because
  // zero seconds is a different *sentence* (there is nothing to wait for), not
  // a different number. It is worth noticing what would happen without it:
  // French would send zero to `one`, and « réessayez dans 0 seconde » -- with
  // the singular noun -- is grammatically correct French and useless advice.
  // In English, German and Japanese the same removal would produce « 0 seconds
  // », which is why this is the one pattern in the catalogue that reads
  // differently in French from every other language whether or not the arm is
  // there.
  //
  // The `many` arm is a million seconds -- eleven and a half days of rate
  // limiting. Nobody will ever see it. It still has to be the real French
  // sentence, with « de », because the test asks the language and not the
  // situation.
  'errors.rate_limited': '{retry_after, plural, =0 {Ralentissez un instant, puis réessayez.} one {Ralentissez un instant — réessayez dans # seconde.} many {Ralentissez un instant — réessayez dans # de secondes.} other {Ralentissez un instant — réessayez dans # secondes.}}',
  'errors.demoted': 'Ce serveur a passé la main à un autre nœud. Reconnexion en cours.',
  'errors.standby_read_only': 'Ce serveur est en veille : il est accessible en lecture seule pour le moment. Votre message n’a pas été envoyé.',
  'errors.shut_down': 'Ce serveur d’accueil a été arrêté par la personne qui l’exploite.',
  'errors.try_again': 'Quelque chose d’autre utilise cela en ce moment. Réessayez dans un instant.',

  // --------------------------------------------------------------- migration

  // `{destination}` is a hostname: data, never translated. « transfert » and
  // not « migration » for the act -- French uses « migration » for populations
  // and for databases, and the reader of this sentence is moving their account
  // from one server to another, which is a transfer they asked for.
  'errors.migration_in_progress': 'Ce compte est en cours de transfert vers {destination}. Il ne peut pas être modifié ici tant que le transfert n’est pas terminé.',
  'errors.migration_handoff_invalid': 'Ce lien de transfert n’est plus valable. Relancez le transfert depuis le compte que vous quittez.',
  'errors.migration_refused': '{destination} a refusé le transfert.',

  // ----------------------------------------------------------------- uploads

  // La limite fait partie de la phrase : « trop volumineux » tout seul
  // n’apprend rien à qui doit décider quoi faire ensuite. `{limit, bytes}`
  // passe par le catalogue et par `Intl`, donc le résultat est « 8,0 Mo » avec
  // la virgule décimale et l’unité française — rien de tout cela n’est écrit à
  // la main ici, et c’est bien le sujet.
  'errors.too_large': 'Ce fichier est trop volumineux. La limite ici est de {limit, bytes}.',
  'errors.unsupported_media_type': 'Les fichiers de type {media_type} ne sont pas acceptés ici.',
  'errors.quota_exceeded': 'Plus d’espace disponible — {used, bytes} utilisés sur {limit, bytes}.',

  // ------------------------------------------------------- client-side codes

  // Ce n’est pas le serveur qui refuse : c’est le client qui juge la réponse
  // du serveur. La phrase est de la copie de sécurité et ne doit pas être
  // adoucie. Les trois faits qu’elle porte sont, dans l’ordre : ce serveur a
  // proposé quelque chose de plus faible que ce que le compte utilise ; le mot
  // de passe n’est pas parti ; et si le réseau est public, il vaut mieux
  // réessayer ailleurs. Aucun des trois n’est décoratif, et « Telium n’a pas
  // envoyé votre mot de passe » est celui qu’il ne faut surtout pas raccourcir.
  'errors.opaque_downgrade': 'Ce serveur a proposé une connexion plus ancienne et plus faible que celle utilisée par votre compte. Telium n’a pas envoyé votre mot de passe. Si vous êtes sur un réseau public, réessayez depuis un autre endroit.',
  'errors.legacy_auth_required': 'Ce serveur d’accueil est trop ancien pour que cette version de Telium puisse s’y connecter.',

  // --------------------------------------------------------- the bottom rungs

  // The key the English comment names French for, so here is the French.
  // `reportError` puts this between what was being attempted and what went
  // wrong, and the thin space before the colon is the entire reason it is a
  // catalogue key rather than a template literal in JavaScript. `{message}`
  // arrives finished, with its own full stop, so nothing follows it.
  'errors.context': '{context} : {message}',

  'errors.generic': 'Un problème est survenu.',

  // Un 500 et un 502 ne sont pas la même nouvelle, et c’est cette phrase-ci
  // qui le dit. Un 500 veut dire qu’un serveur a exécuté la requête et qu’il a
  // échoué quelque part au milieu : personne de ce côté-ci du câble ne sait
  // jusqu’où il est allé. La phrase doit donc laisser la question ouverte et
  // ne pas se terminer par une invitation à réessayer — ce qui provoque le
  // plus souvent un 500, c’est une écriture, et un « réessayez » guilleret sur
  // une écriture à moitié faite, c’est un paiement envoyé deux fois.
  'errors.serverFault': 'Le serveur a rencontré un problème. L’opération a peut-être été effectuée malgré tout.',

  // Deux phrases, séparées par `navigator.onLine`. La première n’accuse pas le
  // serveur, parce qu’un portail captif ressemble exactement à cela ; la
  // seconde nomme l’appareil, parce que c’est la seule chose que la personne
  // qui lit peut réparer elle-même. Les deux disent que rien n’a été envoyé,
  // et les deux disent vrai : `lib/retry.js` a déjà décidé si la requête était
  // rejouable avant qu’on n’arrive ici.
  'errors.offline': 'Le serveur n’a pas pu être joint. Rien n’a été envoyé ; réessayez dans un instant.',
  'errors.offlineDevice': 'Cet appareil est hors ligne. Rien n’a été envoyé.',

  // ---------------------------------------------------- refusals with no code

  // Keyed by HTTP status, for refusals that carry nothing to translate -- a
  // reverse proxy answering with its own HTML, a load balancer answering with
  // nothing. Each says what to do next rather than naming the number, because
  // the number is not information to the person reading it.
  'errors.status.401': 'Votre session a expiré. Reconnectez-vous pour continuer.',
  'errors.status.403': 'Vous n’avez pas la permission de faire cela ici.',
  'errors.status.404': 'Cela n’existe plus.',
  'errors.status.409': 'Quelqu’un d’autre a modifié cela avant vous. Regardez de nouveau, puis réessayez.',
  'errors.status.413': 'C’est trop volumineux pour ce serveur.',
  'errors.status.429': 'Vous allez trop vite pour ce serveur. Attendez un instant, puis réessayez.',
  'errors.status.gateway': 'Le serveur ne répond pas pour le moment. Réessayez dans un instant.',

  // ------------------------------------------------------------ gateway close

  // Keyed by the numeric websocket close code. Two of these promise a
  // reconnection and four do not, and that is not a stylistic choice:
  // `lib/gateway.js` gives up on 4001, 4002, 4004 and 4015 and keeps trying on
  // the rest. « Reconnexion en cours » on one of the terminal codes would be a
  // promise that never comes true, so the four terminal sentences stop at the
  // fact.
  'errors.gateway.4001': 'Telium n’a pas pu ouvrir de session sur ce serveur.',
  'errors.gateway.4002': 'Telium et ce serveur ne sont pas d’accord sur la façon de communiquer.',
  'errors.gateway.4004': 'Ce serveur n’a pas accepté votre session. Reconnectez-vous.',
  'errors.gateway.4005': 'Ce serveur redémarre. Reconnexion en cours.',
  'errors.gateway.4008': 'La connexion à ce serveur a pris trop de temps. Reconnexion en cours.',
  'errors.gateway.4009': 'Cette connexion a expiré. Reconnexion en cours.',
  // 4011 counts sockets belonging to this account -- too many tabs, too many
  // devices, something the reader can act on. 4013 counts unidentified sockets
  // from anywhere, which is usually a stranger's traffic. The French has to
  // keep the two apart for the same reason the English does: only one of them
  // asks the reader to do anything.
  'errors.gateway.4011': 'Trop de connexions Telium ouvertes pour votre compte. Fermez-en une, puis réessayez.',
  'errors.gateway.4013': 'Ce serveur reçoit beaucoup de connexions en ce moment. Nouvelle tentative dans un instant.',
  'errors.gateway.4015': 'Telium et ce serveur fonctionnent dans des versions incompatibles.',
  // `{code}` is a number and is data. `closeMessage` prefers the server's own
  // reason string whenever there is one, so this is the last resort.
  'errors.gateway.unknown': 'La connexion s’est fermée de façon inattendue (code {code}).',

  // ------------------------------------------------------------ settings
  //
  // Deux pièges dans cette section, et ils sont signalés dans `en/settings.js`.
  //
  // **Les noms de thèmes ne sont pas des mots à traduire, ce sont des choses à
  // nommer.** « Graphite » n’est pas une demande du mot français pour le
  // minéral : c’est un nom donné à un gris neutre très sombre. Là où le mot
  // français porte la même image, il est gardé ; là où il ne la porte pas, il
  // a été remplacé (voir `evergreen`). Les descriptions disent à quoi
  // ressemble chaque thème précisément pour qu’on puisse le renommer de zéro.
  //
  // **Les curseurs sont la copie la plus difficile du fichier.** Chaque
  // étiquette est un mot pour une quantité que rien d’autre ne nomme dans le
  // produit, et chaque indication est la seule explication qui existe. Traduire
  // la métaphore anglaise (« how far a card *lifts off* the page ») donnerait
  // une phrase sans objet en français ; ce qu’il faut faire passer, c’est le
  // fait : le curseur règle à quel point le fond d’une carte diffère de celui
  // de la page. Traduire le fait, pas la figure de style.

  'settings.theme.title': 'Thème',
  // « Vous suit » = synchronisé avec le compte, et non conservé sur cet
  // appareil. C’est une information, pas un argument : quelqu’un qui ne veut
  // pas du thème de son ordinateur professionnel sur son téléphone mérite de
  // l’apprendre ici et pas plus tard.
  'settings.theme.description': 'Vous suit sur vos autres appareils.',

  'settings.theme.preset.graphite.name': 'Graphite',
  'settings.theme.preset.graphite.description': 'Gris neutre profond. Le thème par défaut.',
  'settings.theme.preset.obsidian.name': 'Obsidienne',
  // Pas une figure de style : les pixels sont vraiment à `#000`, et une dalle
  // OLED n’allume pas du tout un pixel noir. Le lien de cause à effet est ce
  // que la phrase existe pour dire, donc il reste.
  'settings.theme.preset.obsidian.description': 'Noir jusqu’au pixel, qu’un écran OLED n’allume pas du tout.',
  'settings.theme.preset.ash.name': 'Cendre',
  'settings.theme.preset.ash.description': 'Un gris plus chaud et plus clair, pour une pièce éclairée par une lampe.',
  'settings.theme.preset.midnight.name': 'Minuit',
  // « comme Telium s’ouvrait autrefois » : un clin d’œil à l’ancien thème par
  // défaut, pour celles et ceux à qui il manque. Ce qui doit survivre si la
  // nostalgie ne passe pas, c’est « du violet dans le gris ».
  'settings.theme.preset.midnight.description': 'Du violet dans le gris, comme Telium s’ouvrait autrefois.',
  // The one preset name that is not a translation of the English word, and the
  // clearest illustration of the rule at the top of this section. "Evergreen"
  // carries a dark, saturated green to an English reader. The French words for
  // the botanical idea -- « persistant », « toujours vert » -- are adjectives
  // about leaves and carry no colour at all; a French reader seeing
  // « Persistant » in a list of themes would have no idea what colour they were
  // choosing. « Sapin » is the word French actually attaches to that green
  // (« vert sapin » is a standard colour name), so it names the thing rather
  // than the word. The description below carries the rest of the picture.
  'settings.theme.preset.evergreen.name': 'Sapin',
  'settings.theme.preset.evergreen.description': 'Sombre, avec le vert d’une longue soirée passée à l’intérieur.',
  'settings.theme.preset.paper.name': 'Papier',
  'settings.theme.preset.paper.description': 'Blanc papier, pour une pièce lumineuse.',

  // The label of a control, so the infinitive -- see the note in `common`.
  // « Créez le vôtre » would be an order; « Créer le vôtre » is the name of the
  // thing the card does.
  'settings.theme.custom.label': 'Créer le vôtre',
  'settings.theme.custom.description': 'Quelques curseurs, et l’application change sous vos yeux à mesure que vous les déplacez.',

  // ------------------------------------------------------- the custom scheme

  // « palette » rather than a literal « schéma », which in French is a diagram
  // on a whiteboard. A palette is a set of colours chosen together, which is
  // what this is.
  'settings.scheme.title': 'Votre palette',
  'settings.scheme.description': 'Toutes les positions de tous les curseurs restent lisibles ; c’est à cela que servent les extrémités.',

  'settings.scheme.mode.label': 'Page',
  'settings.scheme.mode.hint': 'Laquelle des deux palettes les autres curseurs modifient.',
  'settings.scheme.mode.dark': 'Sombre',
  'settings.scheme.mode.light': 'Clair',

  'settings.scheme.depth.label': 'Profondeur',
  // Deux indications pour un seul curseur, parce qu’il ne veut pas dire la
  // même chose de chaque côté de l’interrupteur clair/sombre : en bas de la
  // page sombre il y a du vrai noir, et sur une page claire il n’y a de noir
  // nulle part.
  'settings.scheme.depth.hintDark': 'Tout en bas, c’est du vrai noir, qu’un écran OLED n’allume pas du tout.',
  'settings.scheme.depth.hintLight': 'De combien la page descend sous le blanc.',

  // « Détachement » rather than « Séparation », which is the literal word and
  // would read as a gap between two things. This slider does not move anything
  // apart -- it changes how far a card's fill differs from the page behind it.
  // The hint says the fact, and deliberately drops the English metaphor of a
  // card lifting off a page, which French does not have.
  'settings.scheme.separation.label': 'Détachement',
  'settings.scheme.separation.hint': 'À quel point une carte se distingue de la page, et la barre latérale s’efface derrière elle.',

  // English has two words, "tint" and "hue", and French has one, « teinte ».
  // Using it twice would put two sliders with the same name in the same pane.
  // So the one that controls *how much* colour there is is « Coloration », and
  // « Teinte » is kept for the two that control *which* colour -- which is
  // what the word means in French, and what a colour picker calls it.
  'settings.scheme.tint.label': 'Coloration',
  // « une couleur que vous sauriez nommer » is load-bearing: the chroma here
  // tops out around 0.02, which is visible as warmth and never as a hue.
  // Without the sentence people push the slider to the end expecting a
  // coloured interface and conclude it is broken.
  'settings.scheme.tint.hint': 'La quantité de couleur présente dans les gris. Rien de tout cela n’est une couleur que vous sauriez nommer.',
  // Feminine, because here it agrees with « coloration » -- and lower case,
  // because it is a reading beside a slider rather than a label. This is the
  // key the note on `common.none` points at: the same English word, a
  // different French one, and no way to share them.
  'settings.scheme.tint.none': 'aucune',

  'settings.scheme.greyHue.label': 'Teinte des gris',
  'settings.scheme.greyHue.hint': 'Vers quelle couleur penche la coloration. Sans coloration, ce curseur ne fait rien.',

  'settings.scheme.accentHue.label': 'Teinte d’accentuation',
  // « Il n’y en a qu’une » : féminin, parce que le pronom reprend « la
  // teinte ». L’anglais « There is only the one » dit qu’il n’existe qu’une
  // seule couleur d’accentuation dans tout le produit, et c’est cela qu’il
  // faut faire passer, pas le nombre.
  'settings.scheme.accentHue.hint': 'Les liens, l’anneau de focus, le curseur de saisie et les éléments non lus. Il n’y en a qu’une.',

  'settings.scheme.accentStrength.label': 'Force de l’accentuation',

  // Les lectures affichées à côté de chaque curseur. Le nombre passe par
  // `Intl` : la virgule décimale et le séparateur de milliers sont son
  // affaire, pas celle de ce fichier. Ce qui appartient au motif, c’est le
  // *symbole* et l’espace devant lui — le français met une espace insécable
  // (U+00A0) avant `%`, et rien du tout avant le symbole degré.
  'settings.scheme.reading.percent': '{value, number, fixed1} %',
  'settings.scheme.reading.degrees': '{value, number, integer}°',
  'settings.scheme.reading.amount': '{value, number, fixed3}',

  // ---------------------------------------------------------------- language

  'settings.language.title': 'Langue',
  'settings.language.label': 'Langue de l’interface',
  // La seule ligne du sélecteur qui nomme un comportement et non une langue,
  // donc la seule qui s’écrit dans la langue affichée à l’écran.
  'settings.language.auto': 'Utiliser la langue du système',

  // French forced a real restructure here, and the result is better than the
  // English rather than merely different.
  //
  // `{languages}` is a list built by `Intl.ListFormat`, so it already carries
  // the right commas and the right « et » -- the pattern must never add its
  // own. But it may hold *one* name or five, and the English « {languages} are
  // partly translated » is ungrammatical when it holds one. French cannot get
  // away with that as quietly as English does, and it has a second problem on
  // top: a language name in French normally wants an article that contracts
  // with its gender and its first letter -- « du français », « de l’allemand »
  // -- and the list arrives already joined, so there is nowhere to put one.
  //
  // So the `partial` arm was rewritten around Telium as its subject:
  // « Telium n’est que partiellement traduit en {languages} ». The participle
  // now agrees with Telium and not with the list, and « en » is the one
  // preposition French takes in front of a bare language name -- « traduit en
  // français » and « traduit en français, allemand et japonais » are both
  // correct, so the sentence holds at one name and at five. It is also the
  // same preposition the `other` arm uses, which makes the two read as one
  // family. `docs/translating.md` is explicit that a reviewer will not ask a
  // translation to match sentence for sentence; this is what it is for.
  //
  // The arm names -- `none`, `partial`, `other` -- are code vocabulary and are
  // never translated.
  'settings.language.hint': '{state, select, none {Uniquement en anglais pour l’instant. Telium est conçu pour être traduit — voyez le guide de traduction si vous souhaitez y contribuer.} partial {Telium n’est que partiellement traduit en {languages} ; tout ce qui manque s’affiche en anglais.} other {Telium est disponible en {languages}.}}',

  // ---------------------------------------------------------------- messages

  'settings.messages.title': 'Messages',
  'settings.messages.compact.label': 'Messages compacts',
  'settings.messages.compact.hint': 'Échange l’espace entre les messages contre un plus grand nombre de messages à l’écran.',
  'settings.messages.members.label': 'Afficher la liste des membres',
  // Dit la partie qu’on tait d’habitude : masquer la liste n’est pas qu’un
  // changement d’affichage, cela coupe un abonnement. Qui la désactive pour
  // économiser de la bande passante doit savoir que ça marche, et qui
  // s’étonne que les présences soient figées doit pouvoir en trouver la raison.
  'settings.messages.members.hint': 'La liste des membres est abonnée par tranches : la masquer interrompt aussi les mises à jour.',
  'settings.messages.typing.label': 'Envoyer les indicateurs de saisie',
  'settings.messages.typing.hint': 'Désactivé, cela signifie que les serveurs de guilde ne sont jamais informés que vous avez commencé à écrire.',

  // ------------------------------------------------------- notifications
  //
  // Deux surfaces dans le même espace de noms : le panneau où l’on décide ce
  // qu’une notification système a le droit de dire, et les vingt lignes de
  // `lib/notification-preview.js` qui obéissent à cette décision au moment de
  // la remettre au système d’exploitation. Traduire l’une sans lire l’autre,
  // c’est traduire la moitié d’une promesse.
  //
  // Presque rien, dans une notification système, ne nous appartient : le titre
  // est un nom de salon ou une personne, le corps est ce que quelqu’un a tapé.
  // Rien de tout cela n’est traduit, jamais — un salon qui s’appelle #general
  // s’appelle #general pour un lecteur français aussi. Ce fichier ne contient
  // que le cadre autour, et en particulier les deux phrases qui n’existent que
  // parce que le contenu a été retiré exprès (`system.appName` et
  // `system.generic`). Pour qui a choisi « Masquer l’expéditeur et le
  // contenu », ce sont les seuls mots que Telium écrira jamais sur son écran
  // verrouillé.
  //
  // Les jetons des `select` (`granted`, `denied`, `ready`, `unverified`…) sont
  // du vocabulaire machine et ne se traduisent pas. Traduire `granted`, ce
  // n’est pas changer un mot à l’écran : c’est supprimer une branche, et le
  // badge retombe silencieusement sur `other`, qui annonce « Pas encore
  // demandées » sur un appareil où tout fonctionne.

  'notifications.local.title': 'Notifications locales',
  'notifications.local.description': 'Alertes de ce navigateur ou de cette application de bureau pendant que Telium tourne en arrière-plan.',

  // « Autorisation » and not « permission », which is the word `errors.
  // missing_permission` uses for a Telium role bit. The two must not share a
  // French word: one is a setting inside the product, the other is something
  // the operating system or the browser grants to the whole app, and a reader
  // who confuses them goes looking for a role editor in their phone's
  // settings. Two keys because the thing named is genuinely different on the
  // web and on a native build, exactly as in English.
  'notifications.local.systemPermission': 'Autorisation système',
  'notifications.local.browserPermission': 'Autorisation du navigateur',

  // The badge beside that row. `state` is the raw permission string from the
  // platform; `other` deliberately covers `default`, `prompt` and
  // `prompt-with-rationale` together, because all three mean the same thing to
  // a person -- nobody has been asked yet.
  //
  // All five arms agree with « les notifications », feminine plural, which is
  // what the badge is describing: « Autorisées », « Bloquées »,
  // « Indisponibles », « Pas encore demandées ». English has no agreement and
  // gives no hint that a choice is being made here; get it wrong and the badge
  // reads as though it were describing the button next to it.
  //
  // « Pas encore demandées » states a state and does not offer an action --
  // the action is the button beside it -- which is why it is not
  // « Demander ».
  'notifications.local.permissionState': '{state, select, loading {Vérification…} granted {Autorisées} denied {Bloquées} unsupported {Indisponibles} other {Pas encore demandées}}',

  // Not `common.enable`, even though the English word is the same one. This
  // button does not turn a Telium setting on: it opens the platform's own
  // permission prompt, and French should use the platform's own word for it.
  // Every browser and every phone says « Autoriser » in that dialog, so the
  // button that summons it says « Autoriser » too, and the reader recognises
  // what is about to appear. The progress state is built from the same noun so
  // the pair stays a pair -- « Autoriser » then « Autorisation… », never
  // « Autoriser » then « Activation… ».
  'notifications.local.enable': 'Autoriser',
  'notifications.local.enabling': 'Autorisation…',

  // Neither of these can say the other's sentence: the web build cannot send
  // anybody to an operating-system settings panel, and the desktop build has
  // no site permission to re-allow. Naming the wrong place is advice that
  // leads nowhere.
  'notifications.local.blockedSystem': 'Les notifications sont bloquées dans les paramètres de votre système d’exploitation. Commencez par y réautoriser Telium.',
  'notifications.local.blockedBrowser': 'Les notifications sont bloquées pour ce site dans les paramètres du navigateur. Commencez par les y réautoriser.',

  'notifications.local.unsupported': 'Les notifications locales ne sont pas disponibles dans ce navigateur.',

  // « version » plutôt que « build » : c’est le mot que tout le monde lit sans
  // s’arrêter, et il n’y a ici aucune distinction technique à préserver entre
  // les deux.
  'notifications.local.updateReady': 'Une nouvelle version est installée',
  // Pas `common.refresh` : « Actualiser », c’est ce que fait une liste qui va
  // rechercher ses données, alors que ce bouton-ci jette l’application en
  // cours d’exécution et la relance.
  'notifications.local.reload': 'Recharger',

  // « sur cet appareil » porte tout le sens et ne doit pas sauter à la
  // traduction : la préférence n’est pas synchronisée, et qui lit « les
  // notifications sont activées » comme un réglage de compte se demandera
  // pourquoi son ordinateur portable reste muet.
  'notifications.local.enabled': 'Notifications activées sur cet appareil.',
  // `{reason}` est une phrase déjà traduite, avec son propre point final :
  // rien ne suit le paramètre. Espace fine avant les deux-points.
  'notifications.local.enableFailed': 'Impossible d’activer les notifications : {reason}',

  // ------------------------------------------------------- background push

  // « push » stays English, and so does « Web Push » below. This is not
  // laziness: « notification push » is what the French-speaking web says, what
  // every French Android and browser vendor documentation says, and what a
  // reader searching for help will type. The available French
  // (« notification poussée ») is a translation nobody uses and that the
  // reader would have to translate back. The pair local/push keeps the
  // distinction the English header insists on -- one needs a permission, the
  // other needs a server subscription, and they fail in completely different
  // ways.
  'notifications.push.title': 'Notifications push',
  // Une affirmation sur la vie privée, pas un résumé de fonctionnalité, et
  // c’est cette affirmation que toute la section existe pour tenir. « Les
  // fournisseurs de push », au pluriel et sans les nommer : lesquels
  // interviennent dépend de la version installée.
  'notifications.push.description': 'Les fournisseurs de push ne font que réveiller Telium. Le contenu des notifications reste dans la boîte de réception chiffrée de Telium.',

  // Une seule clé et une seule paire de phrases, pas deux : la seconde moitié
  // est la preuve de la première, et une traduction qui les recevrait
  // séparément ne pourrait pas le voir.
  'notifications.push.privacyHint': 'Les réveils envoyés par le fournisseur ne transportent aucun contenu de message. Android et les navigateurs pris en charge récupèrent des lignes opaques de la boîte de réception, les déchiffrent sur l’appareil et n’accusent réception que des lignes traitées avec succès.',

  'notifications.push.android.label': 'Notifications Android en arrière-plan',

  // `stage` is a ladder, not a set: `blocked` → `none` → `inbox` →
  // `unverified` → `ready`, with `checking` off to the side. The badge
  // collapses `blocked` and `none` into « Non configuré » because from the
  // reader's side they are the same fact -- this phone will not wake -- and
  // the notice underneath is where the difference is explained.
  //
  // Masculine singular throughout, because what these describe is « le réveil
  // en arrière-plan » and not « les notifications »; this is the opposite
  // choice from `local.permissionState` above and both are right, which is
  // exactly the kind of thing English cannot show a translator.
  'notifications.push.android.state': '{stage, select, checking {Vérification…} ready {Prêt} unverified {Réveil non vérifié} inbox {Boîte de réception seule} other {Non configuré}}',

  // Chaque branche nomme l’échelon *suivant*, pas le but : « Tester le
  // réveil » envoie une vraie sonnerie, « Terminer la configuration » choisit
  // un distributeur, « Configurer » part de zéro. Un seul verbe pour les trois
  // donnerait un bouton qui a l’air inerte alors qu’il fait trois choses
  // différentes.
  'notifications.push.android.action': '{stage, select, unverified {Tester le réveil} inbox {Terminer la configuration} other {Configurer}}',
  'notifications.push.android.testing': 'Test en cours…',

  // Long on purpose: background delivery on Android fails quietly and in
  // several distinguishable ways, and a reader who is not told which rung they
  // are on cannot guess. `other` is the `blocked` rung and is the only branch
  // that points somewhere else on the screen, because it is the only one whose
  // next step is not this row.
  //
  // The English calls the test message a "doorbell", which is a good metaphor
  // in English and has no French equivalent that is not a joke: « coup de
  // sonnette » in a sentence about push endpoints reads as whimsy in the
  // middle of a diagnostic. The French says what the thing is -- a real test
  // wake carrying no content -- which is what the metaphor was standing in for
  // anyway.
  'notifications.push.android.notice': '{stage, select, ready {Prêt pour le réveil en arrière-plan. Telium a envoyé un véritable réveil de test, sans aucun contenu, via le fournisseur de push configuré, et Android a confirmé qu’il a bien atteint le service push natif.} unverified {La boîte de réception chiffrée et le point d’accès de réveil sont enregistrés, mais aucun réveil vérifié n’est encore parvenu à ce téléphone. Testez le réveil avant de compter sur les notifications lorsque Telium est fermé.} inbox {La boîte de réception chiffrée est prête, mais cet appareil n’a pas encore de point d’accès de réveil confirmé. Terminez la configuration pour choisir ou actualiser son distributeur push Android.} none {Configurez la boîte de réception Android chiffrée et le distributeur push pour la remise en arrière-plan.} other {Activez d’abord les notifications système ; Telium pourra ensuite inscrire cet appareil Android pour la remise chiffrée en arrière-plan.}}',

  // Dit une fois, quand l’inscription revient. Les trois fins sont vraiment
  // différentes : une promesse tenue, une réussite partielle sur laquelle il
  // faudra peut-être agir, et un « revenez dans un instant ».
  'notifications.push.android.enrolled': '{outcome, select, verified {Les notifications Android en arrière-plan ont passé un test de réveil.} endpoint {Android a enregistré un point d’accès de réveil, mais la remise n’est pas vérifiée.} other {Le push Android est configuré ; le point d’accès de réveil est en cours d’enregistrement.}}',
  'notifications.push.android.enrollFailed': 'Impossible d’inscrire les notifications Android : {reason}',

  // « lorsqu’il est fermé » est tout l’intérêt du réglage et c’est la moitié
  // qu’une traduction plus courte perdrait : sans elle, la ligne ressemble à
  // un doublon de l’autorisation de notification juste au-dessus.
  'notifications.push.web.label': 'Réveiller ce navigateur lorsqu’il est fermé',
  'notifications.push.web.hint': 'Enregistre un abonnement Web Push chiffré auprès de votre serveur d’accueil.',

  // Les deux confirmations nomment le navigateur et non le compte, pour la
  // même raison que `notifications.local.enabled` nomme l’appareil : un
  // abonnement Web Push appartient à un profil de navigateur sur une machine,
  // et qui lit cela comme un réglage de compte sera surpris par son téléphone.
  'notifications.push.web.on': 'Ce navigateur peut être réveillé pour les notifications.',
  'notifications.push.web.off': 'Push en arrière-plan désactivé sur ce navigateur.',
  'notifications.push.web.onFailed': 'Impossible d’activer le push : {reason}',
  'notifications.push.web.offFailed': 'Impossible de désactiver le push : {reason}',

  // La version bureau n’est pas un échec et n’est pas formulée comme tel : les
  // notifications de bureau fonctionnent, il ne manque que le cas de
  // l’application complètement fermée.
  'notifications.push.desktopOnly': 'Les notifications de bureau fonctionnent tant que Telium est en cours d’exécution. Réveiller une application de bureau complètement fermée n’est pas encore implémenté.',
  'notifications.push.unsupported': 'Ce navigateur ne peut pas enregistrer de push en arrière-plan sur cet appareil.',

  // -------------------------------------------------------------- alerts

  'notifications.alerts.title': 'Alertes',

  // L’indication fait deux choses à la fois et les deux sont nécessaires :
  // dire que la préférence suit le compte sur les autres appareils, et
  // empêcher de lire cela comme « mes messages sont donc synchronisés quelque
  // part ». C’est la seconde moitié qu’il faut garder s’il faut raccourcir.
  'notifications.alerts.preview.label': 'Aperçus des notifications',
  'notifications.alerts.preview.hint': 'Détermine ce que les notifications système laissent voir sur cet appareil. La préférence est synchronisée avec votre compte ; le contenu des messages, lui, reste dans le circuit de notification chiffré de Telium.',

  'notifications.alerts.preview.full': 'Aperçu complet',
  // The awkward one. English writes "Sender / title only" and its comment
  // explains the slash is doing real work: for a DM the thing kept is a
  // person's name and for a channel mention it is the channel's title, and no
  // single English noun covers both. French has no such noun either -- so the
  // alternative stays, but as a word rather than a slash. « Expéditeur ou
  // titre » is read aloud correctly by a screen reader, which « Expéditeur /
  // titre » is not, and it is one character longer.
  'notifications.alerts.preview.sender': 'Expéditeur ou titre uniquement',
  'notifications.alerts.preview.hidden': 'Masquer l’expéditeur et le contenu',

  'notifications.alerts.mentions.label': 'Notifier les mentions',
  // « lorsque quelqu’un vous mentionne » rather than « lorsque vous êtes
  // mentionné », which would have to agree with a reader this file knows
  // nothing about. The active turn is also the shorter one and names who did
  // it, which is what the notification will say anyway.
  'notifications.alerts.mentions.hint': 'Affiche une notification lorsque quelqu’un vous mentionne alors que Telium est en arrière-plan.',

  // « message privé » is what French speakers call a DM -- the abbreviation
  // « MP » is as common as « DM » is in English. The full phrase is used on
  // the label and in the sentences, because the pane is read by somebody
  // configuring something rather than by somebody in a hurry, and « MP » in a
  // settings row looks like an acronym they are supposed to already know.
  'notifications.alerts.dms.label': 'Notifier les messages privés',
  'notifications.alerts.dms.hint': 'Dans une conversation privée, chaque message vous est adressé : les mentions ne les couvrent donc pas.',
  // Deux indications pour un seul interrupteur, choisies selon la version
  // installée et non selon la langue. Celle-ci doit d’abord déclarer une
  // limite : une application tuée ne se réveille pas encore pour un message
  // privé, et qui active le réglage en pensant le contraire va manquer des
  // messages.
  'notifications.alerts.dms.hintAndroid': 'Affiche les notifications de messages privés pendant que Telium tourne en arrière-plan. Le réveil pour un message privé lorsque l’application a été fermée par le système nécessite encore une indication de notification MLS respectueuse de la vie privée, et ne fait pas partie de ce circuit push pour l’instant.',

  // « qu’il soit au premier plan ou non » porte tout le sens : qui lit cela
  // comme « se déclenche quand vous regardez Telium » a compris l’inverse de
  // ce que fait l’interrupteur.
  'notifications.alerts.sound.label': 'Émettre un son pour les mentions et les messages privés',
  'notifications.alerts.sound.hint': 'Se déclenche tant que le client est en cours d’exécution, qu’il soit au premier plan ou non.',

  // « Également » fait un vrai travail et n’est pas du remplissage : cet
  // interrupteur n’a aucun sens lu tout seul, et une traduction qui laisse
  // tomber le mot laisse deux réglages de son sans aucun lien déclaré entre
  // eux.
  'notifications.alerts.soundMessages.label': 'Également pour les messages ordinaires',
  'notifications.alerts.soundMessages.hint': 'Tous les messages d’un salon que vous êtes en train de lire, et pas seulement ceux qui vous sont adressés.',

  // La sonnerie, le seul réglage de cette section qui est activé par défaut :
  // une notification de message sera encore là dans une heure, un appel est
  // terminé en trente secondes. L’indication doit nommer les trois façons dont
  // la sonnerie s’arrête, parce qu’un son répété dont on ne voit pas la fin
  // est le genre de chose qui fait désinstaller une application.
  'notifications.alerts.callRing.label': 'Sonner pour les appels entrants',
  'notifications.alerts.callRing.hint': 'Une sonnerie répétée pendant que quelqu’un vous appelle dans une conversation. Elle s’arrête si vous répondez, si vous refusez, ou si la personne abandonne.',

  // ------------------------------------ the notification's own words

  // Le nom reste « Telium ». C’est un nom propre et non un nom commun, et la
  // clé n’existe que pour permettre à une écriture non latine de le
  // translittérer si son lecteur en a besoin pour le reconnaître d’un coup
  // d’œil sur un écran verrouillé. Le français s’écrit en alphabet latin :
  // rien à faire ici, et surtout rien à inventer.
  'notifications.system.appName': 'Telium',
  // Le corps de dernier recours, quand le texte du message a été retiré et que
  // l’appelant n’avait rien de plus précis. Ne dit délibérément ni qui ni où :
  // il s’affiche sur l’écran verrouillé de quelqu’un qui a demandé exactement
  // cela, et un « Nouveau message d’un contact » qui sonne serviable divulgue
  // le seul bit qu’on lui avait demandé de cacher.
  'notifications.system.generic': 'Nouvelle notification',

  // Le sigil et le nom du salon. Le nom est une donnée et ne se traduit
  // jamais ; le `#` est dans le motif pour qu’une écriture de droite à gauche
  // puisse le placer de l’autre côté. Le français le laisse là où il est.
  'notifications.system.channelTitle': '#{channel}',
  // En minuscules, exprès : ce mot prend la place d’un nom de salon, qui
  // s’écrit lui aussi en minuscules.
  'notifications.system.unknownChannel': 'salon',

  // The attribution line, and the second place in this catalogue where the
  // thin space before the colon is the entire point of the key being a
  // pattern. `{sender}` and `{message}` are both user-generated content: a
  // display name in any script and a message body already clipped to 140
  // characters. Neither is translated, ever, and neither may be reordered into
  // a form French would prefer for a *person's* name -- these are arbitrary
  // strings.
  'notifications.system.messageFrom': '{sender} : {message}',
  // Pas une erreur : le message est bien arrivé, il est réel, et la clé qui
  // l’ouvre est sur un autre appareil de ce compte. La phrase doit rester
  // assez neutre pour ne pas se lire comme une panne.
  'notifications.system.encryptedFrom': '{sender} a envoyé un message chiffré',
  // « une pièce jointe » et non le nom du fichier : le nom est du contenu, et
  // cette phrase s’affiche dans les modes où le contenu a été retiré.
  'notifications.system.attachmentFrom': '{sender} a envoyé une pièce jointe',

  'notifications.system.newMention': 'Nouvelle mention',
  'notifications.system.newReply': 'Nouvelle réponse',
  'notifications.system.newDm': 'Nouveau message privé',
  'notifications.system.incomingCall': 'Appel entrant',
  // French forced a change of shape here, and it is a correction rather than a
  // liberty. The English « Calling {name} » reads as *this device placing a
  // call*, which is the opposite of what it is: it is the body of an incoming
  // ring notification, and `{name}` is the title of the conversation the call
  // is happening in -- a group, or a DM the reader has named. « Appel de X »
  // in French would carry the same ambiguity (a call *from* X, or X's call),
  // and « Appel entrant : X » cannot be misread by anybody. It also matches
  // `notifications.system.incomingCall` above, which is what this key falls
  // back to when the conversation has no name worth showing, so the two read
  // as one family instead of two unrelated sentences.
  'notifications.system.calling': 'Appel entrant : {name}',

  // Le contexte auquel `errors.context` viendra coller la cause, donc la
  // phrase nomme l’acte et non le résultat : ce qui suit est déjà le résultat,
  // et deux résultats à la suite disent deux fois la même chose. Pas de point
  // final, pour la même raison.
  'notifications.system.showFailed': 'Impossible d’afficher une notification',

// Les deux valeurs par défaut de `DataTable`. Elles restent aussi génériques
  // qu'en anglais : elles ne s'affichent que si l'appelant n'a rien dit de ce
  // que contiennent les lignes, donc toute précision serait fausse sur la
  // plupart des tableaux concernés. « Enregistrements » plutôt que « Entrées »,
  // qui est déjà le mot des listes d'invitations et du journal d'audit : le
  // réutiliser ferait passer un libellé par défaut pour un libellé choisi.
  'common.table.empty': 'Rien ici.',
  'common.table.label': 'Enregistrements',

  // ================================================== added to reach 100%
  //
  // Everything below was added in one pass to complete this catalogue. The
  // sentences were produced with machine assistance and have not been read by
  // a human, which is why none of them carries a stamp in `stamps.json` --
  // `node scripts/i18n-status.mjs --stale` reports them as *unknown*, not as
  // accepted. Treat this block as a first draft to review, not as finished copy.
  // ---- auth
  'auth.advanced.identityMismatch': 'L’historique d’identité de ce compte n’a pas pu être vérifié.',
  'auth.advanced.identityName': 'Identité du compte',
  'auth.advanced.legacyPassphraseBody': 'Ce compte porte encore une phrase secrète d’une ancienne version de Telium. Votre mot de passe fait déjà le même travail.',
  'auth.advanced.legacyPassphraseName': 'Ancienne phrase secrète de récupération',
  'auth.advanced.modeName': 'Comment ce compte récupère',
  'auth.advanced.passphraseRemoved': 'Ancienne phrase secrète retirée. Votre mot de passe récupère toujours vos messages.',
  'auth.advanced.removeFailed': 'Impossible de retirer l’ancienne phrase secrète de récupération : {detail}',
  'auth.advanced.removePassphrase': 'Retirer l’ancienne phrase secrète',
  'auth.advanced.rootSequence': ' · séquence racine {sequence}',
  'auth.backup.delete': 'Supprimer la sauvegarde',
  'auth.backup.deleteBody': 'Les messages déjà présents sur cet appareil restent. Un nouvel appareil ne pourra pas récupérer les anciens.',
  'auth.backup.deleteConfirm': 'La supprimer',
  'auth.backup.deleted': 'Sauvegarde supprimée.',
  'auth.backup.deleteFailed': 'Impossible de supprimer la sauvegarde : {detail}',
  'auth.backup.deleteTitle': 'Supprimer la sauvegarde',
  'auth.backup.detail': '{count, plural, one {# élément scellé.} many {# d’éléments scellés.} other {# éléments scellés.}} {readable, select, yes {Votre serveur d’accueil peut l’ouvrir.} other {Votre serveur d’accueil ne peut pas l’ouvrir.}}',
  'auth.backup.detailName': 'Sauvegarde',
  'auth.backup.empty': 'Rien n’est encore stocké. Un nouvel appareil partirait d’aujourd’hui.',
  'auth.backup.explain': 'Une copie chiffrée est conservée pour qu’un nouvel appareil puisse rattraper son retard. Dernière écriture {at, relative}.',
  'auth.backup.title': 'Sauvegarde des anciens messages',
  'auth.crumb.address': 'Adresse Telium',
  'auth.crumb.password': 'Mot de passe',
  'auth.crumb.recoveryKey': 'Clé de récupération',
  'auth.crumb.username': 'Nom d’utilisateur',
  'auth.crumb.welcome': 'Bienvenue',
  'auth.custody.device.name': 'Récupération par appareil de confiance',
  'auth.custody.device.note': 'Vos clés vivent sur les appareils que vous avez approuvés, et nulle part ailleurs.',
  'auth.custody.escrowed.name': 'Récupération assistée par le serveur (héritée)',
  'auth.custody.escrowed.note': 'Votre serveur d’accueil détient une clé qui ouvre ces messages.',
  'auth.custody.line': '{name}. {note}',
  'auth.custody.opaque.name': 'Récupération par mot de passe (clé d’export OPAQUE)',
  'auth.custody.opaque.note': 'Se connecter avec votre mot de passe suffit à récupérer vos messages.',
  'auth.custody.self.name': 'Phrase secrète indépendante (héritée)',
  'auth.custody.self.note': 'Vos clés vivent sur vos appareils, avec une phrase secrète comme moyen de retour.',
  'auth.custody.unknown': 'Pas encore établie',
  'auth.encryption.backupEmpty': 'Rien de stocké',
  'auth.encryption.backupFact': 'Sauvegarde des anciens messages',
  'auth.encryption.backupItems': '{count, plural, one {# message} many {# de messages} other {# messages}}',
  'auth.encryption.devicesCounting': 'Comptage',
  'auth.encryption.devicesFact': 'Appareils',
  'auth.encryption.devicesHint': 'C’est dans Appareils que vous vérifiez un appareil ou en déconnectez un.',
  'auth.encryption.devicesSignedIn': '{count, plural, one {# connecté} many {# de connectés} other {# connectés}}',
  'auth.encryption.devicesVerified': '{total, plural, one {{verified} sur # vérifié} many {{verified} sur # de vérifiés} other {{verified} sur # vérifiés}}',
  'auth.encryption.escrowed.note': 'Ce compte utilise encore l’ancien dispositif de récupération. Le désactiver ne demande qu’une pression et aucun second mot de passe.',
  'auth.encryption.escrowed.title': 'Votre serveur d’accueil peut lire vos messages privés.',
  'auth.encryption.keyFact': 'Clé de récupération',
  'auth.encryption.keyLegacy': 'Ancienne phrase secrète',
  'auth.encryption.keyMissing': 'Pas encore créée',
  'auth.encryption.keySaved': 'Enregistrée',
  'auth.encryption.locked.note': 'Les nouveaux messages fonctionnent. Pour récupérer les anciens, utilisez votre clé de récupération ci-dessous, ou approuvez cet appareil depuis un appareil que vous utilisez déjà.',
  'auth.encryption.locked.title': 'Vos anciens messages sont verrouillés sur cet appareil.',
  'auth.encryption.ok.noteFallback': 'Seuls vos appareils peuvent les ouvrir.',
  'auth.encryption.ok.title': 'Vos messages privés sont protégés.',
  'auth.encryption.settingUp.note': 'Cela prend un moment après la connexion.',
  'auth.encryption.settingUp.title': 'Configuration du chiffrement sur cet appareil.',
  'auth.escrow.button': 'La désactiver',
  'auth.escrow.doneDevices': 'C’est fait. Vos clés sont désormais sur vos appareils.',
  'auth.escrow.doneRefresh': 'C’est fait, mais quelques conversations ont encore besoin d’une actualisation de clé.',
  'auth.escrow.doneServer': 'C’est fait. Votre serveur ne peut plus ouvrir les nouveaux messages.',
  'auth.escrow.explain': 'Votre serveur cesse de pouvoir ouvrir tout ce qui est envoyé après cela. Ce qu’il a déjà vu, il l’a déjà vu.',
  'auth.escrow.failed': 'Impossible de désactiver la récupération assistée par le serveur : {detail}',
  'auth.escrow.title': 'Désactiver la récupération assistée par le serveur',
  'auth.find.afterColon': 'Ou saisissez-le après deux-points, comme @{user}:votre.serveur',
  'auth.find.busy': 'Recherche…',
  'auth.find.changeAddress': 'Utiliser une autre adresse',
  'auth.find.changeHome': 'Choisir une autre attache',
  'auth.find.create': 'Créer un compte',
  'auth.find.deactivated': 'Ce compte est désactivé. Se connecter avec son mot de passe le réactive.',
  'auth.find.elsewhere': 'Sur un autre serveur ?',
  'auth.find.forget': 'Oublier {user} sur cet appareil',
  'auth.find.found': 'Compte {user} trouvé sur {host}',
  'auth.find.foundLabel': 'Comptes nommés {user}',
  'auth.find.hint': 'Votre nom d’utilisateur et votre serveur, comme @ada:telium.chat. Serveur oublié ? Saisissez simplement votre nom d’utilisateur.',
  'auth.find.homeExplainer': 'Le serveur d’attache de votre compte conserve votre profil, votre connexion, vos amis et vos messages. Vous pouvez quand même rejoindre des communautés hébergées ailleurs.',
  'auth.find.invalid': 'Cela ne ressemble pas à une adresse Telium. Essayez @nom:serveur.',
  'auth.find.label': 'Adresse Telium',
  'auth.find.lookingUp': 'Recherche de {host}…',
  'auth.find.moved': 'Votre compte a été déplacé vers {host}.',
  'auth.find.newTitle': 'Nouveau sur Telium ?',
  'auth.find.noAccount': 'Il n’existe aucun compte nommé {user} sur {host}. Vérifiez l’orthographe, ou <create>créez un compte</create>.',
  'auth.find.noSuchAccount': 'Il n’existe aucun compte nommé {user} sur {host}.',
  'auth.find.placeholder': '@you:telium.chat',
  'auth.find.recentLabel': 'Comptes sur cet appareil',
  'auth.find.searching': 'Recherche de {user}…',
  'auth.find.title': 'Se connecter à Telium',
  'auth.find.unreachable': 'Impossible de joindre {host}. Vérifiez l’orthographe, ou votre connexion.',
  'auth.find.whichServer': 'Sur quel serveur se trouve {user} ?',
  'auth.guardians.cannotSign': 'Cet appareil ne peut pas signer pour votre compte en ce moment.',
  'auth.guardians.duplicate': 'Trois personnes différentes. Le même identifiant ne peut pas compter deux fois.',
  'auth.guardians.incomplete': 'Nommez les trois avant d’enregistrer.',
  'auth.guardians.name': 'Contacts de récupération (deux sur trois au choix)',
  'auth.guardians.needThree': 'Choisissez trois personnes différentes.',
  'auth.guardians.person': 'Personne {index}',
  'auth.guardians.placeholder': '@friend:home.example',
  'auth.guardians.replace': 'Remplacer ces trois',
  'auth.guardians.save': 'Enregistrer ces trois',
  'auth.guardians.saved': 'Vos trois contacts de récupération sont enregistrés.',
  'auth.guardians.saveFailed': 'Impossible d’enregistrer vos contacts de récupération : {detail}',
  'auth.guardians.set': 'Définis, version {version}. Choisir de nouveaux contacts annule les anciens.',
  'auth.guardians.unset': 'Non définis. Deux des trois peuvent vous réintégrer ; un seul ne le peut pas.',
  'auth.guardians.unsupported': 'Ce serveur ne les propose pas.',
  'auth.guardians.unsupportedName': 'Contacts de récupération',
  'auth.guardians.verifiedList': 'Personnes que vous avez vérifiées : {people}',
  'auth.guardians.verifyFirst': 'Vérifiez d’abord quelqu’un avec la comparaison d’émoji, puis indiquez ici son identifiant complet.',
  'auth.handoff.account': '<b>Transfert de {account} vers {destination}.</b> Connectez-vous au compte vers lequel il doit être transféré, ou créez-en un nouveau. Il vous sera demandé de confirmer avant que quoi que ce soit soit envoyé à {source}.',
  'auth.handoff.guild': '<b>Transfert de la guilde {name} vers {destination}.</b> Connectez-vous au compte qui doit la posséder là-bas, ou créez un nouveau compte. Il vous sera demandé de confirmer avant que quoi que ce soit soit envoyé à {source}.',
  'auth.identity.placeholder': 'ada ou @ada:{host}',
  'auth.identity.placeholderNew': 'ada',
  'auth.identity.titleLogin': 'Qui se connecte ?',
  'auth.identity.titleRegister': 'Choisissez un nom d’utilisateur',
  'auth.key.acceptFailed': 'Impossible d’accepter la clé de récupération : {detail}',
  'auth.key.copy': 'Copier la clé de récupération',
  'auth.key.saved': 'J’ai enregistré ma clé de récupération',
  'auth.key.sub': 'Elle réinitialise votre mot de passe et récupère votre compte si vous perdez tous vos appareils.',
  'auth.key.title': 'Enregistrez votre clé de récupération',
  'auth.key.warning': '<b>Conservez-la en lieu sûr et séparément de votre mot de passe.</b> Personne, Telium compris, ne peut la recréer pour vous.',
  'auth.legacy.register.action': 'Utiliser l’inscription héritée',
  'auth.legacy.register.body': 'L’inscription héritée envoie votre mot de passe au serveur d’accueil. N’utilisez ceci que si vous faites confiance au serveur et ne pouvez pas le mettre à niveau vers une version actuelle de Telium.',
  'auth.legacy.register.title': 'Ce serveur d’accueil ne prend pas en charge l’inscription à mot de passe privé.',
  'auth.legacy.server.action': 'Utiliser la connexion héritée',
  'auth.legacy.server.actionReactivate': 'Utiliser la réactivation héritée',
  'auth.legacy.server.body': 'La connexion héritée envoie votre mot de passe au serveur d’accueil. N’utilisez ceci que si vous faites confiance au serveur et ne pouvez pas le mettre à niveau vers une version actuelle de Telium.',
  'auth.legacy.server.title': 'Ce serveur d’accueil ne prend pas en charge la connexion à mot de passe privé.',
  'auth.legacy.upgrade.action': 'Mettre ce compte à niveau',
  'auth.legacy.upgrade.body': 'Le compte est antérieur à OPAQUE. Pour cette tentative de mise à niveau uniquement, le serveur d’accueil recevra votre mot de passe via son point d’accès de connexion hérité. Telium remplace ensuite l’ancien vérificateur par OPAQUE afin que les connexions futures gardent le mot de passe sur cet appareil.',
  'auth.legacy.upgrade.title': 'Ce vieux compte a besoin d’une mise à niveau de sécurité ponctuelle.',
  'auth.localData.cache.body': 'Sans risque. Tout ici est une copie de quelque chose qu’un serveur détient toujours, et cela revient à la prochaine connexion. Vous restez connecté et vos conversations chiffrées ne sont pas touchées.',
  'auth.localData.cache.button': 'Effacer les données en cache',
  'auth.localData.cache.cost1': 'La copie hors ligne de vos guildes, salons et messages récents.',
  'auth.localData.cache.cost2': 'Vos préférences mises en miroir localement, jusqu’à ce que la prochaine synchronisation les rétablisse.',
  'auth.localData.cache.cost3': 'Tout ce que le service worker avait mis en cache pour un usage hors ligne.',
  'auth.localData.cache.done': 'Effacé. Rechargez pour repartir d’un cache propre.',
  'auth.localData.cache.reload': 'Recharger',
  'auth.localData.cache.title': 'Effacer les données en cache',
  'auth.localData.healed': 'Telium a vidé son cache hors ligne automatiquement, car l’application n’a pas réussi à démarrer deux fois de suite. Rien n’a changé sur votre compte, et vos conversations chiffrées sont intactes.',
  'auth.localData.identity.body': 'Uniquement si vider le cache n’a pas aidé. Cela détruit les clés de chiffrement détenues sur cet appareil, et une partie de ce qu’elles ouvrent n’existe nulle part ailleurs.',
  'auth.localData.identity.confirm': 'Effacer et se déconnecter',
  'auth.localData.identity.confirmTitle': 'Cette opération est irréversible. Vous perdrez :',
  'auth.localData.identity.cost1': 'L’identité de signature MLS de cet appareil. Elle sera un nouvel appareil pour toutes les personnes à qui vous parlez, qui la verront comme non vérifiée jusqu’à ce que vous la vérifiiez de nouveau.',
  'auth.localData.identity.cost2': 'L’état de groupe stocké pour chaque conversation chiffrée. Les messages déjà présents sur cet appareil ne resteront lisibles que si la clé de récupération du compte peut les rouvrir ; tout ce dont cet appareil est le dernier détenteur est perdu.',
  'auth.localData.identity.cost3': 'Le trousseau de clés de récupération des messages privés mis en cache, de sorte que la prochaine connexion devra de nouveau déverrouiller le coffre de clés — avec votre clé de récupération ou votre phrase secrète, que vous devrez avoir.',
  'auth.localData.identity.cost4': 'Votre session. Vous serez déconnecté sur cet appareil.',
  'auth.localData.identity.open': 'Effacer l’identité de l’appareil…',
  'auth.localData.identity.title': 'Effacer l’identité de cet appareil',
  'auth.parts.advanced': 'Avancé',
  'auth.parts.download.account': 'Compte : {user}',
  'auth.parts.download.body1': 'Cette clé réinitialise votre mot de passe et rouvre vos messages chiffrés.',
  'auth.parts.download.body2': 'Quiconque la détient peut faire les deux. Conservez-la quelque part où vous seul pouvez accéder.',
  'auth.parts.download.server': 'Serveur : {host} (connectez-vous avec le compte ci-dessus sur n’importe quel appareil)',
  'auth.parts.download.title': 'Clé de récupération Telium',
  'auth.parts.keyGroups': '{label}, {count, plural, one {# groupe de caractères} many {# de groupes de caractères} other {# groupes de caractères}}',
  'auth.parts.needsAttention': 'Nécessite votre attention : ',
  'auth.parts.recoveryKeyLabel': 'Clé de récupération',
  'auth.password.confirmLabel': 'Confirmer le mot de passe',
  'auth.password.deactivated': 'Ce compte est désactivé. Le même mot de passe le réactive.',
  'auth.password.forgot': 'Oublié ? <recover>Utilisez votre clé de récupération</recover>',
  'auth.password.mfaLabel': 'Code d’authentification',
  'auth.password.mfaPlaceholder': '123456, ou un code de récupération',
  'auth.password.mfaPrompt': 'Saisissez le code d’authentification à six chiffres, ou l’un de vos codes de récupération.',
  'auth.password.mismatch': 'Ils ne correspondent pas encore.',
  'auth.password.reactivateFailed': 'Échec de la réactivation : {detail}',
  'auth.password.registerFailed': 'Échec de l’inscription : {detail}',
  'auth.password.signInFailed': 'Échec de la connexion : {detail}',
  'auth.password.signingInAs': 'Connexion en tant que <b>{user}</b>.',
  'auth.password.submitLogin': 'Se connecter',
  'auth.password.submitReactivate': 'Réactiver le compte',
  'auth.password.submitRegister': 'Créer le compte',
  'auth.password.titleLogin': 'Saisissez votre mot de passe',
  'auth.password.titleReactivate': 'Réactivez votre compte',
  'auth.password.titleRegister': 'Définissez un mot de passe',
  'auth.recover.malformed': 'Cette clé de récupération est mal formée.',
  'auth.recover.notAKey': 'Ce n’est pas une clé de récupération Telium.',
  'auth.recover.reachFailed': 'Impossible de joindre votre serveur d’accueil : {detail}',
  'auth.recover.rejected': 'Cette clé de récupération n’a pas été acceptée pour ce compte.',
  'auth.recover.title': 'Réinitialiser votre mot de passe',
  'auth.recover.unsupported': 'Ce serveur d’accueil ne prend pas en charge la réinitialisation par clé de récupération.',
  'auth.recoveryKey.clipboardName': 'Clé de récupération',
  'auth.recoveryKey.copy': 'La copier',
  'auth.recoveryKey.createFailed': 'Impossible de créer votre clé de récupération : {detail}',
  'auth.recoveryKey.download': 'La télécharger dans un fichier',
  'auth.recoveryKey.enterPassword': 'Saisissez votre mot de passe.',
  'auth.recoveryKey.fieldLabel': 'Clé de récupération',
  'auth.recoveryKey.finishFailed': 'Impossible de terminer l’enregistrement de votre clé de récupération : {detail}',
  'auth.recoveryKey.haveExplain': 'Votre clé de récupération est le moyen de retour si vous oubliez votre mot de passe ou perdez tous vos appareils. Conservez-la quelque part où vous seul pouvez accéder. Elle ne peut plus être affichée, et en créer une nouvelle empêche l’ancienne de fonctionner.',
  'auth.recoveryKey.lockedFirst': 'Déverrouillez vos messages ci-dessus, puis vous pourrez créer une clé de récupération.',
  'auth.recoveryKey.makeButton': 'Créer une clé de récupération',
  'auth.recoveryKey.makeNew': 'Créer la nouvelle clé',
  'auth.recoveryKey.noneExplain': 'Ce compte n’a pas de clé de récupération. Sans clé, oublier votre mot de passe signifie perdre vos anciens messages. En créer une prend quelques secondes.',
  'auth.recoveryKey.onceWarning': '<b>Notez-la avant de continuer.</b> Elle n’est affichée qu’une fois et ne pourra plus être montrée, ni par nous ni par personne.',
  'auth.recoveryKey.passwordHint': 'Vérifié sur cet appareil. Votre serveur ne le reçoit jamais.',
  'auth.recoveryKey.passwordLabel': 'Votre mot de passe',
  'auth.recoveryKey.placeholder': 'telium-recovery-v1-…',
  'auth.recoveryKey.replaceBody': 'Votre clé de récupération actuelle cesse de fonctionner dès que la nouvelle est créée. Si vous l’avez notée quelque part, cette copie devient inutile.',
  'auth.recoveryKey.replaceButton': 'Créer une nouvelle clé de récupération',
  'auth.recoveryKey.replaceConfirm': 'En créer une nouvelle',
  'auth.recoveryKey.replaceExplain': 'Saisissez votre mot de passe pour créer la nouvelle clé. L’ancienne cesse de fonctionner.',
  'auth.recoveryKey.replaceTitle': 'Créer une nouvelle clé de récupération',
  'auth.recoveryKey.saved': 'Je l’ai enregistrée',
  'auth.recoveryKey.savedToast': 'Clé de récupération enregistrée. Conservez-la à part de votre mot de passe.',
  'auth.recoveryKey.title': 'Clé de récupération',
  'auth.recoveryKey.unsupported': 'Ce serveur ne propose pas de clés de récupération. Vos clés restent sur les appareils que vous approuvez.',
  'auth.reset.confirmLabel': 'Confirmer le nouveau mot de passe',
  'auth.reset.failed': 'Échec de la réinitialisation du mot de passe : {detail}',
  'auth.reset.minLength': '{count, plural, one {Au moins # caractère.} many {Au moins # de caractères.} other {Au moins # caractères.}}',
  'auth.reset.mismatch': 'Les nouveaux mots de passe ne correspondent pas.',
  'auth.reset.newLabel': 'Nouveau mot de passe',
  'auth.reset.submit': 'Réinitialiser le mot de passe',
  'auth.reset.title': 'Choisissez un nouveau mot de passe',
  'auth.server.label': 'Serveur d’accueil',
  'auth.server.noServer': 'Vous n’en avez pas ? <a>Trouver un serveur d’accueil</a>',
  'auth.server.placeholder': 'home.example',
  'auth.server.probeChecking': 'Vérification du serveur',
  'auth.server.probeFound': 'Serveur trouvé',
  'auth.server.probeUnreachable': 'Serveur injoignable',
  'auth.server.sub': 'Chaque compte Telium appartient à un seul serveur d’accueil.',
  'auth.server.title': 'Où vit votre compte ?',
  'auth.server.unreachableBody': 'Rien n’a répondu à cette adresse ; elle est peut-être mal orthographiée, privée ou hors service. Vous pouvez continuer avec elle, mais la connexion et la création de compte ne fonctionneront pas tant qu’elle ne répondra pas. <a>Trouver un serveur d’accueil</a> connu comme disponible.',
  'auth.server.unreachableTitle': '{host} n’a pas répondu',
  'auth.server.use': 'Utiliser ce serveur',
  'auth.server.useAnyway': 'L’utiliser quand même',
  'auth.start.lostPassword': 'Mot de passe perdu ? <recover>Récupérer votre compte</recover>',
  'auth.start.register': 'Commencer',
  'auth.start.signIn': 'Se connecter',
  'auth.start.title': 'Bienvenue sur Telium',
  'auth.unlock.button': 'Déverrouiller',
  'auth.unlock.done': 'Déverrouillé. Votre mot de passe suffit désormais.',
  'auth.unlock.doneDevice': 'Déverrouillé sur cet appareil.',
  'auth.unlock.enterKey': 'Saisissez votre clé de récupération.',
  'auth.unlock.enterPassphrase': 'Saisissez votre phrase secrète de récupération.',
  'auth.unlock.failed': 'Impossible de déverrouiller vos messages : {detail}',
  'auth.unlock.keyHint': 'La clé qui vous a été remise à la création de ce compte.',
  'auth.unlock.otherDevice': 'Vous pouvez aussi ouvrir Telium sur un appareil que vous utilisez déjà et approuver celui-ci depuis là-bas. Rien n’est saisi, et votre serveur ne voit jamais les clés.',
  'auth.unlock.passphraseHint': 'La phrase secrète que vous avez ajoutée vous-même à ce compte.',
  'auth.unlock.passphraseLabel': 'Phrase secrète de récupération',
  'auth.unlock.title': 'Déverrouillez vos anciens messages',

  // ---- bots
  'bots.capability.emptyDefault': 'Aucune demandée.',
  'bots.capability.powerful': 'puissante',
  'bots.capability.unknown.hint': 'Ce serveur connaît la capacité {capability} et ce client non. Elle est laissée exactement telle quelle.',
  'bots.capability.unknownGroup': 'Non décrit par ce client',
  'bots.capability.withdrawnBadge': 'plus proposée',
  'bots.capability.withdrawnHeld': 'Le développeur l’a retirée de l’application. Le bot la détient toujours et vous pouvez la lui retirer — mais ce serveur ne la lui rendra pas.',
  'bots.capability.withdrawnRemoved': 'Retirée par le développeur et désormais supprimée. Elle ne peut plus être accordée.',
  'bots.edit.ceilingLoading': 'Chargement du plafond de l’application…',
  'bots.edit.failed': 'Impossible de mettre à jour le bot',
  'bots.edit.heading': 'Modifier {name}',
  'bots.edit.intentsHint': 'Le contenu des messages est sensible pour la vie privée ; le retirer prend effet immédiatement.',
  'bots.edit.intentsTitle': 'Intentions accordées',
  'bots.edit.offline': 'Le foyer du bot n’a pas pu être joint, seuls ses droits actuels sont donc affichés. Vous pouvez encore les réduire en toute sécurité ; les élargir exige de revérifier le descripteur d’application.',
  'bots.edit.permissionsHint': 'Un serveur ne peut jamais accorder plus que ce que le développeur a déclaré, et vous ne pouvez jamais accorder plus que ce que vous détenez vous-même.',
  'bots.edit.permissionsTitle': 'Permissions accordées',
  'bots.edit.save': 'Enregistrer les droits',
  'bots.install.callsItself': 'S’appelle <name>{name}</name>',
  'bots.install.cannotGrant': 'Vous ne détenez pas cette permission ici, ce serveur ne vous laissera donc pas l’accorder.',
  'bots.install.closed': 'Cette application n’accepte pas de nouvelles installations pour l’instant.',
  'bots.install.failed': 'Impossible d’installer le bot',
  'bots.install.installing': 'Installation…',
  'bots.install.intentsEmpty': 'Ce bot ne demande aucune intention de passerelle.',
  'bots.install.intentsHint': 'Ce sont les catégories d’événements que le bot demande. Elles démarrent activées ; décochez tout ce que ce serveur ne doit pas exposer.',
  'bots.install.intentsTitle': 'Intentions',
  'bots.install.intro': 'Collez une référence d’application. Telium récupérera le descripteur d’application signé du bot et montrera exactement ce qu’il demande avant que quoi que ce soit soit installé.',
  'bots.install.loading': 'Chargement de l’application…',
  'bots.install.permissionsEmpty': 'Ce bot ne demande aucune permission de guilde.',
  'bots.install.permissionsHint': 'Ce sont les permissions que le développeur demande. Les plus puissantes démarrent désactivées — ne cochez que ce dont ce bot a besoin pour faire son travail.',
  'bots.install.permissionsTitle': 'Permissions',
  'bots.install.previewFailed': 'Impossible de charger le bot',
  'bots.install.referenceHint': 'Collez la référence copiée depuis la personne qui développe le bot.',
  'bots.install.referenceLabel': 'Référence d’application',
  'bots.install.referencePlaceholder': 'bots.example/01…',
  'bots.install.submit': 'Installer {name}',
  'bots.install.submitUnnamed': 'Installer le bot',
  'bots.install.thirdParty': 'Application tierce',
  'bots.install.title': 'Installer un bot',
  'bots.install.unnamed': 'Bot',
  'bots.intent.group.activity': 'Ce qui se passe ici',
  'bots.intent.group.people': 'Qui est ici',
  'bots.intent.group.privileged': 'Privilégiées',
  'bots.intent.group.structure': 'Comment cette guilde est organisée',
  'bots.intent.guild_expressions.hint': 'Recevoir les changements d’émojis et de stickers de la guilde.',
  'bots.intent.guild_expressions.label': 'Émojis et stickers',
  'bots.intent.guild_members.hint': 'Recevoir les changements de membres de la guilde : qui a rejoint, qui est parti, qui a été renommé.',
  'bots.intent.guild_members.label': 'Membres',
  'bots.intent.guild_messages.hint': 'Recevoir les événements de création, modification et suppression de messages.',
  'bots.intent.guild_messages.label': 'Messages',
  'bots.intent.guild_presences.hint': 'Recevoir les changements de statut en ligne et de présence de tout le monde ici.',
  'bots.intent.guild_presences.label': 'Présence',
  'bots.intent.guild_structure.hint': 'Voir les salons, les rôles et les changements structurels.',
  'bots.intent.guild_structure.label': 'Structure de la guilde',
  'bots.intent.guild_typing.hint': 'Recevoir les indicateurs de saisie.',
  'bots.intent.guild_typing.label': 'Saisie',
  'bots.intent.guild_voice_states.hint': 'Recevoir les changements d’appartenance et d’état des salons vocaux.',
  'bots.intent.guild_voice_states.label': 'États vocaux',
  'bots.intent.message_content.hint': 'Lire le texte de chaque message qu’il peut voir. Sans cela, un bot obtient le fait d’un message et non ses mots.',
  'bots.intent.message_content.label': 'Contenu des messages',
  'bots.list.badge': 'BOT',
  'bots.list.colBot': 'Bot',
  'bots.list.colIntents': 'Intentions',
  'bots.list.colPermissions': 'Permissions',
  'bots.list.empty': 'Aucun bot n’est installé dans cette guilde.',
  'bots.list.notice': 'Retirer un bot révoque immédiatement son appartenance à la guilde et ses sessions de bot actives. Réduire ses droits prend aussi effet pour les sockets déjà ouvertes, car chaque distribution revérifie les droits actuels dans la guilde.',
  'bots.list.removeFailed': 'Impossible de retirer le bot',
  'bots.list.tableLabel': 'Bots installés',
  'bots.list.title': 'Bots installés',

  // ---- channel
  'channel.create.failed': 'Impossible de créer le salon',
  'channel.create.namePlaceholder': 'general',
  'channel.create.newAnnouncement': 'Nouveau salon d’annonces',
  'channel.create.newForum': 'Nouveau salon forum',
  'channel.create.newText': 'Nouveau salon textuel',
  'channel.create.newVoice': 'Nouveau salon vocal',
  'channel.create.privateHint': 'Masqué à @everyone. Redonnez l’accès dans les permissions du salon.',
  'channel.create.submit': 'Créer le salon',
  'channel.create.title': 'Créer un salon',
  'channel.createCategory.failed': 'Impossible de créer la catégorie',
  'channel.createCategory.namePlaceholder': 'Général',
  'channel.createCategory.privateHint': 'Masquée à @everyone, et tout ce qu’elle contient l’est aussi.',
  'channel.createCategory.submit': 'Créer la catégorie',
  'channel.createCategory.title': 'Créer une catégorie',
  'channel.duration.hours': '{count, plural, one {# heure} many {# d’heures} other {# heures}}',
  'channel.duration.minutes': '{count, plural, one {# minute} many {# de minutes} other {# minutes}}',
  'channel.duration.seconds': '{count, plural, one {# seconde} many {# de secondes} other {# secondes}}',
  'channel.edit.expiryHint': 'Secondes. Vide, la limite de la guilde s’applique.',
  'channel.edit.expiryLabel': 'Expiration des fichiers',
  'channel.edit.expiryPlaceholder': 'Aucune limite de salon',
  'channel.edit.fileSizeLabel': 'Limite de taille de fichier',
  'channel.edit.fileSizeHint': 'Octets. Vide, la limite de la guilde ou du serveur s’applique. Pièces jointes uniquement.',
  'channel.edit.fileSizePlaceholder': 'Aucune limite sur ce salon',
  'channel.edit.previewsHint': 'Récupérés via le proxy propre à la guilde dans tous les cas.',
  'channel.edit.previewsLabel': 'Afficher les aperçus des liens',
  'channel.edit.save': 'Enregistrer les modifications',
  'channel.edit.saveFailed': 'Impossible de mettre à jour le salon',
  'channel.edit.saveFailedCategory': 'Impossible de mettre à jour la catégorie',
  'channel.edit.slowmodeChatLabel': 'Mode lent (discussion)',
  'channel.edit.slowmodeHint': 'Toute personne pouvant gérer les messages en est exemptée.',
  'channel.edit.slowmodeLabel': 'Mode lent',
  'channel.edit.title': 'Modifier le salon',
  'channel.edit.titleCategory': 'Modifier la catégorie',
  'channel.edit.topicHint': 'Affiché dans l’en-tête.',
  'channel.edit.topicPlaceholder': 'À quoi sert ce salon ?',
  'channel.edit.topicPlaceholderVoice': 'À quoi sert cette salle ?',
  'channel.field.category': 'Catégorie',
  'channel.field.name': 'Nom',
  'channel.field.noCategory': 'Aucune catégorie',
  'channel.field.private': 'Privé',
  'channel.field.region': 'Région',
  'channel.field.topic': 'Sujet',
  'channel.forum.layout.gallery': 'Galerie',
  'channel.forum.layout.list': 'Liste',
  'channel.forum.layoutHint': 'La galerie met en avant la première image de chaque publication.',
  'channel.forum.layoutLabel': 'Disposition par défaut',
  'channel.forum.sort.activity': 'Activité récente',
  'channel.forum.sort.creation': 'Date de publication',
  'channel.forum.sortHint': 'Là où commence le tableau.',
  'channel.forum.sortLabel': 'Ordre de tri par défaut',
  'channel.perms.allow': 'Autoriser',
  'channel.perms.choiceLabel': '{choice, select, deny {Refuser {permission}} inherit {Hériter {permission}} allow {Autoriser {permission}} other {{permission}}}',
  'channel.perms.deny': 'Refuser',
  'channel.perms.group.chat': 'Discussion',
  'channel.perms.group.general': 'Général',
  'channel.perms.group.text': 'Texte',
  'channel.perms.group.voice': 'Vocal',
  'channel.perms.inherit': 'Hériter',
  'channel.perms.lockNote': 'Affiché avec un cadenas dans la liste des salons.',
  'channel.perms.privateFailed': 'Impossible de modifier qui peut voir ceci',
  'channel.perms.privateHintOff': 'Retire la vue à @everyone. Rien n’est déplacé ni supprimé.',
  'channel.perms.privateHintOn': 'Masqué à @everyone. Accordez {permission} à un rôle inférieur pour lui redonner l’accès.',
  'channel.perms.privateLabel': 'Salon privé',
  'channel.perms.roleHint': 'Les surcharges sont par rôle.',
  'channel.perms.roleLabel': 'Rôle',
  'channel.perms.saveFailed': 'Impossible d’enregistrer cette surcharge',
  'channel.perms.triStateHint': 'Une coche accorde ici, une croix retire ici, un tiret laisse le réglage propre du rôle intact.',
  'channel.slowmode.off': 'Désactivé',
  'channel.tab.overview': 'Vue d’ensemble',
  'channel.tab.permissions': 'Permissions',
  'channel.tab.tags': 'Étiquettes',
  'channel.tags.add': 'Ajouter une étiquette',
  'channel.tags.emojiLabel': 'Étiquette {n, number} : émoji',
  'channel.tags.emojiPlaceholder': 'Émoji',
  'channel.tags.empty': 'Ce forum n’a encore aucune étiquette.',
  'channel.tags.fieldLabel': 'Étiquettes',
  'channel.tags.limit': '{max, plural, one {Jusqu’à # étiquette.} many {Jusqu’à # d’étiquettes.} other {Jusqu’à # étiquettes.}} {perPost, plural, one {Une publication peut en porter #.} many {Une publication peut en porter #.} other {Une publication peut en porter #.}}',
  'channel.tags.moderated': 'Modération uniquement',
  'channel.tags.moderatedNote': 'Les étiquettes réservées à la modération sont refusées par le serveur, pas seulement par cet écran.',
  'channel.tags.nameLabel': 'Étiquette {n, number} : nom',
  'channel.tags.namePlaceholder': 'Nom',
  'channel.tags.removeNamed': 'Retirer {name}',
  'channel.tags.removeUnnamed': 'Retirer cette étiquette',
  'channel.tags.save': 'Enregistrer les étiquettes',
  'channel.tags.saveFailed': 'Impossible d’enregistrer les étiquettes',
  'channel.type.announcement.description': 'Publication restreinte. D’autres guildes peuvent le suivre.',
  'channel.type.announcement.name': 'Annonce',
  'channel.type.forum.description': 'Chaque publication est son propre fil.',
  'channel.type.forum.name': 'Forum',
  'channel.type.text.description': 'Messages, fils et fichiers.',
  'channel.type.text.name': 'Textuel',
  'channel.type.voice.description': 'Parler, et partager un écran.',
  'channel.type.voice.name': 'Vocal',
  'channel.voice.bitrateHint': 'Plus élevé coûte plus de bande passante à l’hôte par personne qui parle.',
  'channel.voice.bitrateLabel': 'Débit',
  'channel.voice.bitrateValue': '{kbps, number} kbps',
  'channel.voice.limitHint': '0 pour aucune limite.',
  'channel.voice.limitLabel': 'Limite d’utilisateurs',
  'channel.voice.limitNone': 'Aucune limite',
  'channel.voice.limitPeople': '{count, plural, one {# personne} many {# de personnes} other {# personnes}}',
  'channel.voice.regionAuto': 'Auto',
  'channel.voice.regionAutoDefault': 'Auto (défaut de la guilde/serveur)',
  'channel.voice.regionCustom': '{region} (personnalisée)',
  'channel.voice.regionHint': 'Quel SFU relaie ce salon. Auto suit le défaut de la guilde.',
  'channel.voice.regionLabel': 'Région vocale',

  // ---- chat
  'chat.attachment.decryptFailed': '{name} n’a pas pu être déchiffré',
  'chat.attachment.decryptFailedUnnamed': 'Cette pièce jointe n’a pas pu être déchiffrée',
  'chat.attachment.decrypting': 'déchiffrement…',
  'chat.attachment.externalHost': 'hôte externe',
  'chat.attachment.externalMedia': 'média externe',
  'chat.attachment.hostedOn': 'Hébergé sur {host}',
  'chat.attachment.openNamed': 'Ouvrir {name}',
  'chat.attachment.openOnProvider': 'Ouvrir sur {provider}',
  'chat.attachment.openProviderFailed': 'Impossible d’ouvrir {provider}',
  'chat.attachment.preparing': 'préparation…',
  'chat.attachment.save': 'Enregistrer',
  'chat.attachment.saved': '{name} enregistré.',
  'chat.attachment.savedUnnamed': 'Pièce jointe enregistrée.',
  'chat.attachment.saveFailed': 'Impossible d’enregistrer la pièce jointe',
  'chat.attachment.expiresIn': 'Expire {when}',
  'chat.attachment.hostedExpires': 'Hébergé sur {host}, expire {when}',
  'chat.attachment.hostedExpired': 'Hébergé sur {host} — expiré',
  'chat.attachment.fileGone': 'Ce fichier a été supprimé ou a expiré',
  'chat.menu.deleteFileItem': 'Supprimer le fichier : {name}',
  'chat.menu.deleteFileTitle': 'Supprimer le fichier',
  'chat.menu.deleteFileBody': '« {name} » est retiré de votre serveur d’origine. Le message reste et montre le fichier comme disparu. Si les mêmes octets ont été envoyés plus d’une fois ici, la copie est partagée et ce refus arrivera.',
  'chat.menu.deleteFileConfirm': 'Supprimer le fichier',
  'chat.menu.fileDeleted': 'Fichier supprimé.',
  'chat.menu.fileDeleteFailed': 'Impossible de supprimer le fichier',
  'chat.menu.pinPost': 'Épingler la publication',
  'chat.menu.unpinPost': 'Désépingler la publication',
  'chat.menu.lockPost': 'Verrouiller la publication',
  'chat.menu.unlockPost': 'Déverrouiller la publication',
  'chat.menu.postPinFailed': 'Impossible d’épingler la publication',
  'chat.menu.postLockFailed': 'Impossible de verrouiller la publication',
  'chat.menu.copyPostId': 'Identifiant de la publication',
  'chat.menu.copyPostIdItem': 'Copier l’identifiant de la publication',
  'chat.menu.deleteNamed': 'Supprimer {name}',
  'chat.menu.deleteRepliesBody': 'Les réponses s’en vont avec. C’est irréversible.',
  'chat.menu.deleteConfirm': 'Supprimer',
  'chat.menu.deletePost': 'Supprimer la publication',
  'chat.menu.postDeleteFailed': 'Impossible de supprimer la publication',
  'chat.menu.openThread': 'Ouvrir le fil',
  'chat.menu.markRead': 'Marquer comme lu',
  'chat.menu.copyThreadLink': 'Lien du fil',
  'chat.menu.copyLink': 'Copier le lien',
  'chat.menu.renameThread': 'Renommer le fil',
  'chat.menu.threadTitle': 'Titre du fil',
  'chat.menu.rename': 'Renommer',
  'chat.menu.renameFailed': 'Impossible de renommer le fil',
  'chat.menu.archiveThread': 'Archiver le fil',
  'chat.menu.unarchiveThread': 'Désarchiver le fil',
  'chat.menu.archiveFailed': 'Impossible d’archiver le fil',
  'chat.menu.pinThread': 'Épingler le fil',
  'chat.menu.unpinThread': 'Désépingler le fil',
  'chat.menu.threadPinFailed': 'Impossible d’épingler le fil',
  'chat.menu.lockThread': 'Verrouiller le fil',
  'chat.menu.unlockThread': 'Déverrouiller le fil',
  'chat.menu.threadLockFailed': 'Impossible de verrouiller le fil',
  'chat.menu.copyThreadId': 'Identifiant du fil',
  'chat.menu.copyThreadIdItem': 'Copier l’identifiant du fil',
  'chat.menu.deleteThread': 'Supprimer le fil',
  'chat.menu.threadDeleteFailed': 'Impossible de supprimer le fil',
  'chat.menu.addReaction': 'Ajouter une réaction',
  'chat.menu.reply': 'Répondre',
  'chat.menu.forward': 'Transférer',
  'chat.menu.startThread': 'Démarrer un fil',
  'chat.menu.create': 'Créer',
  'chat.menu.startThreadFailed': 'Impossible de démarrer le fil',
  'chat.menu.editMessage': 'Modifier le message',
  'chat.menu.copyText': 'Copier le texte',
  'chat.menu.copyTextLabel': 'Texte du message',
  'chat.menu.pinMessage': 'Épingler le message',
  'chat.menu.unpinMessage': 'Désépingler le message',
  'chat.menu.pinnedToast': 'Épinglé.',
  'chat.menu.unpinnedToast': 'Désépinglé.',
  'chat.menu.pinFailed': 'Impossible d’épingler',
  'chat.menu.unpinFailed': 'Impossible de désépingler',
  'chat.menu.reportMessage': 'Signaler le message',
  'chat.menu.copyMessageId': 'Identifiant du message',
  'chat.menu.copyMessageIdItem': 'Copier l’identifiant du message',
  'chat.menu.deleteMessage': 'Supprimer le message',
  'chat.menu.deleteMessageBody': 'C’est irréversible.',
  'chat.menu.deleteDmBody': 'Cela le supprime pour tout le monde.',
  'chat.menu.deleteFailed': 'Impossible de supprimer',
  'chat.menu.reactionFailed': 'La réaction a échoué',
  'chat.attachment.expired': 'Ce fichier a expiré',
  'chat.attachment.saveNamed': 'Enregistrer {name}',
  'chat.attachment.unknownHost': 'hôte inconnu',
  'chat.attachment.unnamed': 'pièce jointe',
  'chat.autocomplete.emojiCustom': 'Personnalisé',
  'chat.autocomplete.emojiFrom': '{guild} — émoji',
  'chat.autocomplete.notifyChannel': 'Notifier le salon',
  'chat.autocomplete.otherGuild': 'Autre guilde',
  'chat.autocomplete.role': 'Rôle',
  'chat.autocomplete.searching': 'Recherche dans cette guilde…',
  'chat.autocomplete.voiceHere': '{count, plural, one {# personne en vocal} many {# de personnes en vocal} other {# personnes en vocal}}',
  'chat.autocomplete.voiceHereOfLimit': '{count}/{limit} en vocal',
  'chat.autocomplete.voiceLimit': '{limit, plural, one {Jusqu’à # personne} many {Jusqu’à # de personnes} other {Jusqu’à # personnes}}',
  'chat.composer.actionSheet': 'Actions sur le message',
  'chat.composer.attach': 'Joindre un fichier',
  'chat.composer.attachBlocked': 'Vous ne pouvez pas joindre de fichiers ici',
  'chat.composer.cancelReply': 'Annuler la réponse',
  'chat.composer.copy': 'Copier',
  'chat.composer.cut': 'Couper',
  'chat.composer.emoji': 'Émoji',
  'chat.composer.gif': 'GIF',
  'chat.composer.heldForReview': 'Retenu pour examen par la modération : cette guilde retient les premiers messages des nouveaux membres.',
  'chat.composer.moreActions': 'Plus d’actions sur le message',
  'chat.composer.noUploadHosts': 'Aucun hôte de mise en ligne externe n’est activé sur votre serveur d’accueil',
  'chat.composer.send': 'Envoyer',
  'chat.delivery.devices': '{count, plural, =0 {appareil non précisé} one {sur # appareil} many {sur # d’appareils} other {sur # appareils}}',
  'chat.delivery.empty': 'Rien pour l’instant.',
  'chat.delivery.read': 'lu',
  'chat.delivery.receiptsHint': 'Les personnes ayant désactivé les accusés n’apparaissent pas ici.',
  'chat.delivery.subtitle.delivered': 'Tout le monde l’a reçu.',
  'chat.delivery.subtitle.none': 'Aucun accusé de réception pour l’instant.',
  'chat.delivery.subtitle.read': 'Tout le monde l’a lu.',
  'chat.delivery.subtitle.some': 'Une partie du groupe l’a reçu.',
  'chat.delivery.title.delivered': 'Remis',
  'chat.delivery.title.fallback': 'Remise',
  'chat.delivery.title.read': 'Lu',
  'chat.delivery.title.sent': 'Envoyé',
  'chat.embed.playVideo': 'Lire la vidéo',
  'chat.embed.playVideoTitled': 'Lire la vidéo : {title}',
  'chat.emoji.categories': 'Catégories d’émojis',
  'chat.emoji.dialogTitle': 'Émoji',
  'chat.emoji.empty': 'Rien ici pour l’instant. Les émojis que vous choisissez apparaissent sous Récents.',
  'chat.emoji.grid': 'Émoji',
  'chat.emoji.group.activities': 'Activités',
  'chat.emoji.group.flags': 'Drapeaux',
  'chat.emoji.group.food': 'Nourriture',
  'chat.emoji.group.nature': 'Nature',
  'chat.emoji.group.objects': 'Objets',
  'chat.emoji.group.people': 'Personnes',
  'chat.emoji.group.recent': 'Récents',
  'chat.emoji.group.smileys': 'Émoticônes',
  'chat.emoji.group.symbols': 'Symboles',
  'chat.emoji.group.travel': 'Voyage',
  'chat.emoji.guildEmoji': '{guild} — émoji',
  'chat.emoji.guildStickers': '{guild} — stickers',
  'chat.emoji.hint': 'Choisissez un émoji.',
  'chat.emoji.loading': 'Chargement des émojis…',
  'chat.emoji.loadingCustom': 'Chargement des émojis et stickers personnalisés…',
  'chat.emoji.noMatches': 'Aucun émoji ne correspond à cela.',
  'chat.emoji.picker': 'Sélecteur d’émojis',
  'chat.emoji.results': 'Résultats pour « {query} »',
  'chat.emoji.savedStickers': 'Stickers enregistrés',
  'chat.emoji.saveSticker': 'Enregistrer le sticker',
  'chat.emoji.search': 'Rechercher un émoji',
  'chat.emoji.skinTone': 'Teint de peau',
  'chat.emoji.skinToneOf': '{tone} — teint de peau',
  'chat.emoji.stickerResults': 'Stickers',
  'chat.emoji.tone.dark': 'Foncé',
  'chat.emoji.tone.default': 'Par défaut',
  'chat.emoji.tone.light': 'Clair',
  'chat.emoji.tone.medium': 'Moyen',
  'chat.emoji.tone.mediumDark': 'Moyen foncé',
  'chat.emoji.tone.mediumLight': 'Moyen clair',
  'chat.emoji.unsaveSticker': 'Retirer le sticker des enregistrés',
  'chat.encryption.awaiting.body': 'Il a demandé à être admis ; cela se produit lorsqu’un appareil déjà présent dans la conversation l’ouvre, y compris un autre des vôtres. Les messages ci-dessus proviennent de votre propre historique.',
  'chat.encryption.awaiting.title': 'Cet appareil ne peut pas encore envoyer ici.',
  'chat.encryption.changedIdentity.body': 'Une réinitialisation de clé ressemble à cela ; une usurpation aussi. Vérifiez-la de nouveau avant de lui faire confiance.',
  'chat.encryption.changedIdentity.title': 'Quelqu’un ici utilise une clé de compte différente.',
  'chat.encryption.chip.encrypted': 'Chiffré',
  'chat.encryption.chip.endToEnd': 'Bout en bout',
  'chat.encryption.chip.keyChanged': 'Clé modifiée',
  'chat.encryption.chip.keyChangedTooltip': 'Quelqu’un ici utilise une clé de compte différente. Une réinitialisation de clé ressemble à cela ; une usurpation aussi. Vérifiez-la de nouveau avant de lui faire confiance.',
  'chat.encryption.chip.open': 'Détails du chiffrement',
  'chat.encryption.chip.serverCanRead': 'Le serveur peut lire',
  'chat.encryption.chip.unverified': '{count, plural, one {# non vérifié} many {# de non vérifiés} other {# non vérifiés}}',
  'chat.encryption.custody.device': 'Les messages ici sont des trames MLS. Votre serveur d’accueil les relaie, et voit toujours qui parle à qui, et quand. Vos clés de récupération des messages privés vivent sur les appareils que vous approuvez. Votre serveur d’accueil stocke le miroir d’historique chiffré mais ne détient aucune clé qui l’ouvre.',
  'chat.encryption.custody.escrowed': 'Les messages ici sont des trames MLS. Votre serveur d’accueil les relaie, et voit toujours qui parle à qui, et quand. Ce compte utilise la récupération héritée des messages privés assistée par le serveur : votre serveur d’accueil détient une clé qui ouvre le coffre de récupération et le miroir d’historique, de sorte que l’exploitant peut lire ces messages. Déplacez la récupération vers vos appareils de confiance dans Paramètres → {pane}.',
  'chat.encryption.custody.opaque': 'Les messages ici sont des trames MLS. Votre serveur d’accueil les relaie, et voit toujours qui parle à qui, et quand. Votre mot de passe Telium restaure les messages privés chiffrés via OPAQUE. Le mot de passe n’est jamais envoyé à votre serveur d’accueil, et seul votre client obtient la clé du coffre et du miroir d’historique.',
  'chat.encryption.custody.self': 'Les messages ici sont des trames MLS. Votre serveur d’accueil les relaie, et voit toujours qui parle à qui, et quand. Les appareils de confiance détiennent vos clés de messages privés, et une phrase secrète de récupération distincte peut les restaurer si tous les appareils sont perdus. Ni l’une ni l’autre n’est jamais envoyée à votre serveur d’accueil.',
  'chat.encryption.custody.unknown': 'Les messages ici sont des trames MLS. Votre serveur d’accueil les relaie, et voit toujours qui parle à qui, et quand.',
  'chat.encryption.deviceApproval.body': 'Approuvez-le depuis un appareil que vous utilisez déjà. Les clés voyagent directement entre vos appareils.',
  'chat.encryption.deviceApproval.title': 'Cet appareil n’a pas encore vos clés.',
  'chat.encryption.escrowedNote': 'Ce compte utilise la récupération héritée des messages privés assistée par le serveur : votre serveur d’accueil détient une clé qui ouvre le coffre de récupération et le miroir d’historique, de sorte que l’exploitant peut lire ces messages. Déplacez la récupération vers vos appareils de confiance dans Paramètres → {pane}.',
  'chat.encryption.notYetReadable': 'L’historique antérieur n’est pas lisible sur cet appareil. L’historique mis en miroir revient avec votre trousseau de récupération ; MLS ne remet pas les anciens messages à un nouvel appareil.',
  'chat.encryption.recoveryFallback.body': 'Saisissez votre phrase secrète de récupération dans Paramètres → {pane}, ou approuvez cet appareil depuis un appareil que vous utilisez déjà.',
  'chat.encryption.recoveryFallback.title': 'La connexion n’a pas déverrouillé vos anciens messages.',
  'chat.encryption.rejoinUndeliverable.body': 'Le serveur qui ordonne cette conversation est injoignable, la demande n’est donc jamais partie. Recommencer donne à toutes les personnes encore joignables un nouveau groupe.',
  'chat.encryption.rejoinUndeliverable.title': 'Personne n’a été prié d’admettre cet appareil.',
  'chat.encryption.retrySync': 'Réessayer la synchronisation',
  'chat.encryption.startOver.arm': 'Recommencer la conversation',
  'chat.encryption.startOver.confirm': 'Oui, recommencer',
  'chat.encryption.startOver.done': 'Recommencé. Les nouveaux messages ici peuvent de nouveau être lus.',
  'chat.encryption.startOver.failed': 'Impossible de recommencer la conversation',
  'chat.encryption.startOver.partial': '{count, plural, one {Recommencé, mais {names} n’a pas encore pu être ajouté.} many {Recommencé, mais {names} n’ont pas encore pu être ajoutés.} other {Recommencé, mais {names} n’ont pas encore pu être ajoutés.}}',
  'chat.encryption.startOver.warning': 'Tout le monde obtient un nouveau groupe ; rien de ce qui a été dit avant ne s’ouvrira.',
  'chat.encryption.syncFailed.body': 'Les messages plus récents sont retenus pendant que Telium réessaie la planification des clés MLS.',
  'chat.encryption.syncFailed.title': 'Le chiffrement est désynchronisé sur cet appareil.',
  'chat.encryption.unavailable.body': 'La navigation privée bloque le magasin de clés local ; une fenêtre normale fonctionne.',
  'chat.encryption.unavailable.title': 'Le chiffrement n’est pas disponible sur cet appareil.',
  'chat.encryption.vaultLocked.body': 'Saisissez votre phrase secrète de récupération dans Paramètres → {pane} pour les récupérer.',
  'chat.encryption.vaultLocked.title': 'Vos anciens messages sont verrouillés sur cet appareil.',
  'chat.ephemeral.dismiss': 'Masquer',
  'chat.ephemeral.mark': 'Vous seul pouvez voir ceci — ne sera pas enregistré',
  'chat.format.bar': 'Mise en forme du texte',
  'chat.format.block': 'Bloc de code',
  'chat.format.bold': 'Gras',
  'chat.format.code': 'Code en ligne',
  'chat.format.italic': 'Italique',
  'chat.format.quote': 'Citation',
  'chat.format.spoiler': 'Spoiler',
  'chat.format.strike': 'Barré',
  'chat.forward.directMessage': 'Message privé',
  'chat.forward.failed': 'Impossible de transférer',
  'chat.forward.groupChat': 'Conversation de groupe',
  'chat.forward.noMatches': 'Rien ne correspond à « {query} ».',
  'chat.forward.search': 'Rechercher des salons et des conversations',
  'chat.forward.send': 'Envoyer',
  'chat.forward.sending': 'Envoi…',
  'chat.forward.shareFailed': 'Impossible de partager',
  'chat.forward.shareTitle': 'Partager vers Telium',
  'chat.forward.title': 'Transférer le message',
  'chat.gif.category.applause': 'Applaudissements',
  'chat.gif.category.cats': 'Chats',
  'chat.gif.category.cry': 'Pleurer',
  'chat.gif.category.dance': 'Danse',
  'chat.gif.category.dogs': 'Chiens',
  'chat.gif.category.excited': 'Excitation',
  'chat.gif.category.facepalm': 'Facepalm',
  'chat.gif.category.happy': 'Joie',
  'chat.gif.category.love': 'Amour',
  'chat.gif.category.reactions': 'Réactions',
  'chat.gif.category.shrug': 'Haussement d’épaules',
  'chat.gif.category.thumbsUp': 'Pouce en l’air',
  'chat.gif.dialogTitle': 'GIF',
  'chat.gif.disabled': 'La recherche de GIF est désactivée par ce serveur.',
  'chat.gif.exitFullscreen': 'Quitter le plein écran',
  'chat.gif.favorite': 'Ajouter le GIF aux favoris',
  'chat.gif.favorites': 'Favoris',
  'chat.gif.favoritesEmpty': 'Ajoutez un GIF aux favoris pour le garder ici.',
  'chat.gif.fullscreen': 'Plein écran',
  'chat.gif.loadFailed': 'Les GIF n’ont pas pu être chargés.',
  'chat.gif.loading': 'Chargement des GIF…',
  'chat.gif.noMatches': 'Rien ne correspond à cela.',
  'chat.gif.notConfigured': 'La recherche de GIF n’est pas encore configurée.',
  'chat.gif.openOn': 'Ouvrir le GIF sur {provider}',
  'chat.gif.picker': 'Sélecteur de GIF',
  'chat.gif.resize': 'Redimensionner le sélecteur de GIF',
  'chat.gif.results': 'Résultats GIF',
  'chat.gif.search': 'Rechercher des GIF',
  'chat.gif.send': 'Envoyer {title}',
  'chat.gif.trending': 'Tendances',
  'chat.gif.unavailable': 'GIF indisponible — ouvrez-le directement',
  'chat.gif.unfavorite': 'Retirer le GIF des favoris',
  'chat.gif.untitled': 'GIF',
  'chat.image.close': 'Fermer l’aperçu de l’image',
  'chat.image.openOriginal': 'Ouvrir l’original',
  'chat.image.preview': 'Aperçu de l’image',
  'chat.image.save': 'Enregistrer',
  'chat.image.untitled': 'Image',
  'chat.image.viewLarger': 'Afficher l’image en plus grand',
  'chat.image.viewLargerNamed': 'Afficher {label} en plus grand',
  'chat.invite.join': 'Rejoindre {guild}',
  'chat.invite.joinUnnamed': 'Rejoindre',
  'chat.invite.members': '{count, plural, one {# membre} many {# de membres} other {# membres}}',
  'chat.invite.membersOnHost': '{count, plural, one {# membre} many {# de membres} other {# membres}} sur {domain}',
  'chat.message.actions.delete': 'Supprimer',
  'chat.message.actions.edit': 'Modifier',
  'chat.message.actions.pin': 'Épingler',
  'chat.message.actions.quickReact': 'Réagir avec {emoji}',
  'chat.message.actions.react': 'Réagir',
  'chat.message.actions.reply': 'Répondre',
  'chat.message.actions.unpin': 'Désépingler',
  'chat.message.deleted': 'Message supprimé',
  'chat.message.deleteFailed': 'Échec de la suppression',
  'chat.message.editBox.hint': 'entrée pour <save>enregistrer</save>, échap pour <cancel>annuler</cancel>',
  'chat.message.editBox.label': 'Modifier le message',
  'chat.message.edited': '(modifié)',
  'chat.message.editFailed': 'Échec de la modification',
  'chat.message.jumpToQuoted': 'Aller au message auquel il est répondu',
  'chat.message.openProfile': 'Ouvrir le profil de {name}',
  'chat.message.pinFailed': 'Échec de l’épinglage',
  'chat.message.pinned': 'Épinglé.',
  'chat.message.pinnedMark': 'Épinglé',
  'chat.message.quotedDeleted': 'le message d’origine a été supprimé',
  'chat.message.quotedOlder': 'en réponse à un message plus ancien',
  'chat.message.reactionFailed': 'Échec de la réaction',
  'chat.message.replyGone': 'Le message auquel celui-ci répond n’est plus disponible.',
  'chat.message.sending': 'Envoi…',
  'chat.message.thread.count': '{count, plural, one {# message} many {# de messages} other {# messages}}',
  'chat.message.unpinned': 'Désépinglé.',
  'chat.message.unreadable': 'Chiffré avec une clé que cet appareil ne possède pas',
  'chat.player.audioOf': '{name} — audio',
  'chat.player.failedOpen': 'Échec de la lecture — ouvrez le fichier d’origine',
  'chat.player.failedSave': 'Échec de la lecture — enregistrez le fichier d’origine',
  'chat.player.fullscreen': 'Plein écran {label}',
  'chat.player.mute': 'Couper le son de {label}',
  'chat.player.pause': 'Mettre en pause {label}',
  'chat.player.play': 'Lire {label}',
  'chat.player.seek': 'Se déplacer dans {label}',
  'chat.player.unmute': 'Rétablir le son de {label}',
  'chat.player.videoOf': '{name} — vidéo',
  'chat.player.volume': 'Volume de {label}',
  'chat.quote.attachment': 'pièce jointe',
  'chat.quote.body': '<quoted/>',
  'chat.quote.line': '{name}: <quoted/>',
  'chat.quote.replyingTo': 'En réponse à {name} : <quoted/>',
  'chat.staged.capDays': '{count, plural, one {un jour} many {# de jours} other {# jours}}',
  'chat.staged.capHours': '{count, plural, one {une heure} many {# d’heures} other {# heures}}',
  'chat.staged.capMinutes': '{count, plural, one {une minute} many {# de minutes} other {# minutes}}',
  'chat.staged.cappedNote': 'Les fichiers envoyés ici sont supprimés au bout de {duration} au maximum.',
  'chat.staged.closePreview': 'Fermer l’aperçu',
  'chat.staged.dropLine': 'Déposez pour mettre en ligne',
  'chat.staged.dropTargetFallback': 'cette conversation',
  'chat.staged.expiresIn': 'Expire dans {duration}',
  'chat.staged.hostOption': '{name} ({domain})',
  'chat.staged.hostPolicy': 'Les fichiers sont stockés par cet hôte selon ses propres politiques de conservation et d’usage abusif.',
  'chat.staged.hostPublic': 'Les mises en ligne externes sont des URL de fournisseurs publics et ne sont pas protégées par les contrôles d’accès de Telium.',
  'chat.staged.keepFor': 'Conserver les fichiers pendant',
  'chat.staged.keepsForever': 'Conservé indéfiniment',
  'chat.staged.noHosts': 'Aucun hôte de mise en ligne externe n’est activé',
  'chat.staged.preview': 'Aperçu',
  'chat.staged.previewOf': 'Aperçu de {name}',
  'chat.staged.remove': 'Retirer',
  'chat.staged.removeOf': 'Retirer {name}',
  'chat.staged.removeSticker': 'Retirer le sticker',
  'chat.staged.rename': 'Renommer',
  'chat.staged.renameConfirm': 'Renommer',
  'chat.staged.renameLabel': 'Nom du fichier',
  'chat.staged.renameOf': 'Renommer {name}',
  'chat.staged.renameTitle': 'Renommer le fichier',
  'chat.staged.uploadFailed': 'Impossible de mettre en ligne {name}',
  'chat.staged.tooLarge': 'Trop volumineux — les pièces jointes sont limitées à {limit} ici.',
  'chat.staged.cancelUpload': 'Annuler l’envoi',
  'chat.staged.cancelUploadOf': 'Annuler l’envoi de {name}',
  'chat.staged.retry': 'Réessayer l’envoi',
  'chat.staged.retryOf': 'Réessayer l’envoi de {name}',
  'chat.staged.uploadHost': 'Hôte de mise en ligne',
  'chat.staged.uploadingOf': 'Mise en ligne de {name}',
  'chat.surface.delivery.delivered': 'Remis',
  'chat.surface.delivery.read': 'Lu',
  'chat.surface.delivery.sent': 'Envoyé',
  'chat.surface.noPermission': 'Vous n’avez pas la permission d’envoyer des messages ici.',
  'chat.surface.placeholder': 'Message à {target}',
  'chat.surface.placeholderPlain': 'Message',
  'chat.surface.standby': '{home} ne répond pas. Vous lisez une copie détenue par {standby}, qui ne peut pas accepter de nouveaux messages.',
  'chat.surface.threadLocked': 'Ce fil est verrouillé. Seules les personnes modératrices peuvent y publier.',
  'chat.surface.timedOut': 'Vous êtes sous exclusion temporaire dans cette guilde. Vous pouvez lire, mais pas publier.',
  'chat.timeline.empty.body': 'Aucun message pour l’instant. Dites quelque chose.',
  'chat.timeline.empty.title': 'Rien ici pour l’instant',
  'chat.timeline.jumpFailed': 'Impossible de charger ce message',
  'chat.timeline.jumpToBottom': 'Aller en bas',
  'chat.timeline.loadHistoryFailed': 'Impossible de charger l’historique',
  'chat.timeline.loadingOlder': 'Chargement des anciens messages…',
  'chat.timeline.loadOlderFailed': 'Impossible de charger les anciens messages',
  'chat.timeline.messageGone': 'Ce message n’est plus disponible.',
  'chat.timeline.pinNotice.anonymous': 'Un message a été épinglé',
  'chat.timeline.pinNotice.named': '{name} a épinglé un message',
  'chat.timeline.pinNotice.seeAll': 'Voir toutes les épingles',
  'chat.timeline.scrollForOlder': 'Faites défiler vers le haut pour les anciens messages.',
  'chat.timeline.unreadMarker': 'Nouveau',
  'chat.upload.expiryDay': '1 jour',
  'chat.upload.expiryHour': '1 heure',
  'chat.upload.expiryNever': 'Jamais',
  'chat.upload.expiryWeek': '1 semaine',
  'chat.upload.fetchFailed': 'Impossible de récupérer la pièce jointe',
  'chat.upload.fetchFailedNamed': 'Impossible de récupérer {name}',
  'chat.upload.limitDays': '{count, plural, one {1 jour} many {# de jours} other {# jours}}',
  'chat.upload.limitHours': '{count, plural, one {1 heure} many {# d’heures} other {# heures}}',
  'chat.upload.limitMinutes': '{count, plural, one {1 minute} many {# de minutes} other {# minutes}}',

  // ---- errors
  'errors.gateway.4010': 'Cette connexion a pris du retard et a été réinitialisée. Rattrapage en cours.',
  'errors.last_admin': '{attempted, select, deactivate {Vous êtes le seul administrateur de ce serveur à pouvoir vous connecter ; désactiver votre compte ne laisserait donc personne pour l’exploiter.} delete {Vous êtes le seul administrateur de ce serveur à pouvoir vous connecter ; supprimer votre compte ne laisserait donc personne pour l’exploiter.} move {Vous êtes le seul administrateur de ce serveur à pouvoir vous connecter ; déplacer votre compte vers un autre serveur d’accueil ne laisserait donc personne pour l’exploiter.} revoke {{user_id} est le seul administrateur de ce serveur à pouvoir se connecter ; lui retirer son accès ne laisserait donc personne pour l’exploiter.} other {Cela laisserait ce serveur sans aucun administrateur capable de se connecter.}} Accordez les droits d’administrateur du serveur à un autre compte susceptible de se connecter, puis réessayez.',

  // ---- guild
  'guild.audit.colAction': 'Action',
  'guild.audit.colActor': 'Auteur',
  'guild.audit.colTarget': 'Cible',
  'guild.audit.colWhen': 'Date',
  'guild.audit.empty': 'Rien d’enregistré pour l’instant.',
  'guild.audit.tableLabel': 'Journal d’audit',
  'guild.bans.add': 'Bannir par identifiant de compte',
  'guild.bans.banFailed': 'Impossible de bannir',
  'guild.bans.colAccount': 'Compte',
  'guild.bans.colReason': 'Motif',
  'guild.bans.colWhen': 'Date',
  'guild.bans.confirm': 'Bannir',
  'guild.bans.dialogLabel': 'Identifiant complet du compte, comme @quelqu’un:example.org',
  'guild.bans.dialogTitle': 'Bannir un compte',
  'guild.bans.empty': 'Personne n’est banni.',
  'guild.bans.hint': 'Un bannissement ne s’applique qu’à cette guilde.',
  'guild.bans.noReason': 'aucun motif enregistré',
  'guild.bans.tableLabel': 'Bannissements',
  'guild.bans.unban': 'Débannir',
  'guild.bans.unbanAccount': 'Débannir {account}',
  'guild.bans.unbanFailed': 'Impossible de lever le bannissement',
  'guild.duration.day': '1 jour',
  'guild.duration.hour': '1 heure',
  'guild.duration.sixHours': '6 heures',
  'guild.duration.thirtyDays': '30 jours',
  'guild.duration.threeDays': '3 jours',
  'guild.duration.unlimited': 'Aucune limite',
  'guild.duration.week': '1 semaine',
  'guild.expressions.emoji.add': 'Ajouter un émoji',
  'guild.expressions.emoji.addFailed': 'Impossible d’ajouter l’émoji',
  'guild.expressions.emoji.emptyBody': 'Mettez en ligne un PNG, GIF, WebP ou JPEG ; le nom du fichier devient le code court. Le serveur le réencode et le réduit pour qu’il tienne.',
  'guild.expressions.emoji.emptyTitle': 'Aucun émoji personnalisé pour l’instant',
  'guild.expressions.emoji.remove': 'Retirer :{name}:',
  'guild.expressions.emoji.title': 'Émojis personnalisés',
  'guild.expressions.removeFailed': 'Impossible de retirer',
  'guild.expressions.stickers.add': 'Ajouter un sticker',
  'guild.expressions.stickers.addFailed': 'Impossible d’ajouter le sticker',
  'guild.expressions.stickers.emptyBody': 'Les stickers se choisissent dans le sélecteur d’émojis et s’envoient seuls.',
  'guild.expressions.stickers.emptyTitle': 'Aucun sticker pour l’instant',
  'guild.expressions.stickers.title': 'Stickers',
  'guild.gates.curators.colCurator': 'Curateur',
  'guild.gates.curators.colFeed': 'Flux',
  'guild.gates.curators.colSource': 'Répertorié par',
  'guild.gates.curators.hint': 'Les curateurs que ce serveur connaît. Un flux ne décide rien tant que vous n’avez pas épinglé sa clé ici.',
  'guild.gates.curators.pin': 'Épingler la clé',
  'guild.gates.curators.subscribed': 'Abonné',
  'guild.gates.curators.tableLabel': 'Curateurs',
  'guild.gates.curators.thisServer': 'Ce serveur',
  'guild.gates.domainPolicy.label': 'Politique des domaines d’attache',
  'guild.gates.domainRules.hint': 'Une par ligne, sous la forme « allow example.org » ou « deny spam.example ». Avec la politique Ouverte, elles sont ignorées.',
  'guild.gates.domainRules.label': 'Règles des domaines d’attache',
  'guild.gates.feeds.colFeed': 'Flux',
  'guild.gates.feeds.colFetched': 'Dernière récupération',
  'guild.gates.feeds.colHosts': 'Hôtes',
  'guild.gates.feeds.colKey': 'Clé du curateur',
  'guild.gates.feeds.colSerial': 'Numéro de série',
  'guild.gates.feeds.colState': 'État',
  'guild.gates.feeds.curatedBy': '{action} · géré par {curator}',
  'guild.gates.feeds.fetchedAt': '{at, dateTime}',
  'guild.gates.feeds.hint': 'Les flux sont récupérés au premier enregistrement, puis toutes les heures. Un flux expiré cesse d’admettre ses hôtes mais continue de refuser ceux qu’il bloque.',
  'guild.gates.feeds.hosts': '{hosts, number}',
  'guild.gates.feeds.hostsWithBlocks': '{hosts, number} ({blocks, number} bloqués)',
  'guild.gates.feeds.keyInForce': 'En vigueur : {key}',
  'guild.gates.feeds.keyNext': 'Suivante : {key}',
  'guild.gates.feeds.keyPinned': 'Épinglée',
  'guild.gates.feeds.keyRotated': '{count, plural, one {Renouvelée une fois} many {Renouvelée # de fois} other {Renouvelée # fois}}',
  'guild.gates.feeds.keyRotationAnnounced': 'Rotation annoncée',
  'guild.gates.feeds.refresh': 'Actualiser les flux',
  'guild.gates.feeds.state.active': 'Actif',
  'guild.gates.feeds.state.expired': 'Expiré',
  'guild.gates.feeds.state.failed': 'Échec',
  'guild.gates.feeds.state.pending': 'Pas encore récupéré',
  'guild.gates.feeds.state.unpinned': 'Aucune clé épinglée',
  'guild.gates.feeds.tableLabel': 'Flux abonnés',
  'guild.gates.hint': 'Les filtres s’exécutent quand quelqu’un rejoint. Cette guilde peut être plus stricte que son hôte, jamais plus permissive.',
  'guild.gates.hold.hint': 'Les N premiers messages d’un nouveau membre attendent une approbation au lieu d’apparaître. Zéro désactive la retenue.',
  'guild.gates.hold.label': 'Retenir les N premiers messages',
  'guild.gates.minAge.hint': 'Mesuré depuis la date de création du compte sur son serveur d’accueil.',
  'guild.gates.minAge.label': 'Âge minimum du compte (jours)',
  'guild.gates.originPolicy.label': 'Politique d’origine des médias',
  'guild.gates.originRules.hint': 'Une par ligne, sous la forme « allow files.example » ou « block sketchy.example ». Un flux de curateur s’écrit « allow feed:https://… key:<curator key> ». Un hôte nommé l’emporte sur un flux.',
  'guild.gates.originRules.label': 'Règles d’origine des médias',
  'guild.gates.origins.hint': 'Quelles origines cette guilde accepte pour les pièces jointes. Vérifié au moment où un message est publié.',
  'guild.gates.pinned': 'Ajouté aux règles ci-dessus. Enregistrez les filtres pour vous abonner.',
  'guild.gates.policy.allowlist': 'Liste d’autorisation',
  'guild.gates.policy.blocklist': 'Liste de blocage',
  'guild.gates.policy.open': 'Ouverte',
  'guild.gates.refreshFailed': 'Impossible d’actualiser les flux',
  'guild.gates.save': 'Enregistrer les filtres',
  'guild.gates.saved': 'Filtres enregistrés.',
  'guild.gates.saveFailed': 'Impossible d’enregistrer les filtres',
  'guild.gates.screening.hint': 'Une par ligne. Laissez vide pour admettre sans filtrage ; sinon la personne qui rejoint arrive dans la file des candidats.',
  'guild.gates.screening.label': 'Questions d’admission',
  'guild.hostedBy': 'Hébergée par',
  'guild.invites.clipboardName': 'Invitation',
  'guild.invites.colCode': 'Code',
  'guild.invites.colCreator': 'Créée par',
  'guild.invites.colExpires': 'Expire',
  'guild.invites.colUses': 'Utilisations',
  'guild.invites.create.button': 'Créer l’invitation',
  'guild.invites.create.hint': 'Les invitations sont des justificatifs. Donnez-leur une expiration ou une limite d’utilisation quand vous le pouvez.',
  'guild.invites.create.title': 'Créer une invitation',
  'guild.invites.created': 'Invitation créée. Copiez-la depuis la liste ci-dessous.',
  'guild.invites.createFailed': 'Impossible de créer l’invitation',
  'guild.invites.empty': 'Aucune invitation n’a été créée.',
  'guild.invites.expired': 'Expirée',
  'guild.invites.expires': 'Expire',
  'guild.invites.list.title': 'Liens d’invitation',
  'guild.invites.maxUses': 'Nombre maximal d’utilisations',
  'guild.invites.maxUsesPlaceholder': 'Illimité',
  'guild.invites.revoke': 'Révoquer',
  'guild.invites.revokeFailed': 'Impossible de révoquer l’invitation',
  'guild.invites.revokeInvite': 'Révoquer l’invitation {code}',
  'guild.invites.tableLabel': 'Liens d’invitation',
  'guild.invites.uses': '{used, number}',
  'guild.invites.usesOf': '{used, number} / {max, number}',
  'guild.nav.audit': 'Journal d’audit',
  'guild.nav.bans': 'Bannissements',
  'guild.nav.bots': 'Bots',
  'guild.nav.channels': 'Permissions des salons',
  'guild.nav.expressions': 'Émoji',
  'guild.nav.gates': 'Filtres d’entrée et origines',
  'guild.nav.invites': 'Invitations',
  'guild.nav.overview': 'Vue d’ensemble',
  'guild.nav.purge': 'Nettoyage antispam',
  'guild.nav.queue': 'File de modération',
  'guild.nav.roles': 'Rôles',
  'guild.nav.voice': 'Voix / SFU',
  'guild.overview.chooseIcon': 'Choisir une icône',
  'guild.overview.created': 'Créée le {at, date, medium}.',
  'guild.overview.createdUnknown': 'Créée il y a un moment.',
  'guild.overview.delete.button': 'Supprimer la guilde',
  'guild.overview.delete.confirm': 'Supprimer la guilde',
  'guild.overview.delete.dialogHint': 'Cette opération est irréversible.',
  'guild.overview.delete.dialogTitle': 'Supprimer {name}',
  'guild.overview.delete.failed': 'Impossible de supprimer la guilde',
  'guild.overview.delete.hint': 'Les salons, messages, rôles et membres partent tous en même temps. Rien n’en détient de copie pour la restaurer.',
  'guild.overview.delete.label': 'Saisissez le nom pour confirmer',
  'guild.overview.delete.title': 'Supprimer cette guilde',
  'guild.overview.description': 'Description',
  'guild.overview.expiry.hint': 'La durée de vie maximale qu’une pièce jointe peut atteindre ici. Les salons peuvent fixer une limite plus stricte.',
  'guild.overview.expiry.label': 'Les fichiers peuvent être conservés au maximum',
  'guild.overview.fileSize.title': 'Limite de taille des pièces jointes',
  'guild.overview.fileSize.hint': 'Le plus grand fichier qu’un membre peut joindre dans cette guilde. Les salons peuvent fixer une limite plus stricte.',
  'guild.overview.fileSize.label': 'Taille maximale des pièces jointes (octets)',
  'guild.overview.fileSize.placeholder': 'Aucune limite dans cette guilde',
  'guild.overview.expiry.title': 'Expiration des fichiers',
  'guild.overview.iconFailed': 'Impossible d’enregistrer l’icône',
  'guild.overview.iconNone': 'Aucune icône.',
  'guild.overview.iconSet': 'Icône personnalisée définie.',
  'guild.overview.memberCount': '{count, plural, one {# membre} many {# de membres} other {# membres}}.',
  'guild.overview.memberCountUnknown': 'Nombre de membres inconnu.',
  'guild.overview.move.button': 'Déplacer vers un autre serveur',
  'guild.overview.move.elsewhere': 'Cette guilde est hébergée par {domain}, le déplacement doit donc être lancé depuis un compte qui s’y trouve.',
  'guild.overview.move.hint': 'La nouvelle personne propriétaire confirme sur le serveur de destination, puis la personne propriétaire actuelle autorise le déplacement ici. Les anciens liens continuent de fonctionner.',
  'guild.overview.move.ownerOnly': 'Seule la personne propriétaire de la guilde peut la déplacer.',
  'guild.overview.move.title': 'Déplacer cette guilde',
  'guild.overview.name': 'Nom',
  'guild.overview.saveFailed': 'Impossible d’enregistrer',
  'guild.overview.savingIcon': 'Enregistrement de l’icône…',
  'guild.overview.transfer.button': 'Transférer la propriété',
  'guild.overview.transfer.confirm': 'Transférer la propriété',
  'guild.overview.transfer.dialogHint': 'Saisissez l’identifiant complet d’un membre actuel.',
  'guild.overview.transfer.dialogTitle': 'Transférer {name}',
  'guild.overview.transfer.done': 'Propriété transférée.',
  'guild.overview.transfer.failed': 'Impossible de transférer la propriété',
  'guild.overview.transfer.hint': 'La nouvelle personne propriétaire doit déjà être membre. Après le transfert, elle seule peut transférer ou supprimer la guilde.',
  'guild.overview.transfer.label': 'Identifiant du nouveau compte propriétaire',
  'guild.overview.transfer.placeholder': '@member:example.org',
  'guild.overview.transfer.title': 'Transférer la propriété',
  'guild.overview.vanity.address': 'Adresse de la guilde : {address}',
  'guild.overview.vanity.hint': 'Désactivé par défaut. Une fois activé, toute personne ayant l’adresse peut prévisualiser et rejoindre cette guilde. Les liens d’invitation fonctionnent toujours aussi.',
  'guild.overview.vanity.label': 'Nom de l’adresse',
  'guild.overview.vanity.linkClipboard': 'lien personnalisé',
  'guild.overview.vanity.linkLabel': 'Lien du navigateur',
  'guild.overview.vanity.placeholder': 'linuxcommunity',
  'guild.overview.vanity.saveFailed': 'Impossible d’enregistrer le lien personnalisé',
  'guild.overview.vanity.title': 'Lien personnalisé',
  'guild.overview.vanity.toggle': 'Activer le lien personnalisé',
  'guild.purge.accountLabel': 'Identifiant de compte',
  'guild.purge.accountPlaceholder': '@spammer:example.org',
  'guild.purge.button': 'Supprimer les messages récents',
  'guild.purge.deleted': '{count, plural, =0 {Aucun message n’a été supprimé.} one {Suppression : # message.} many {Suppression : # de messages.} other {Suppression : # messages.}}',
  'guild.purge.failed': 'Impossible de purger les messages',
  'guild.purge.hint': 'Supprime les messages les plus récents d’un compte nommé dans cette guilde.',
  'guild.purge.limitLabel': 'Nombre maximal de messages',
  'guild.purge.title': 'Nettoyage antispam',
  'guild.queue.admit': 'Admettre',
  'guild.queue.applicantFailed': 'Impossible d’agir sur ce candidat',
  'guild.queue.applicants.description': 'Des personnes dont les réponses aux questions d’admission attendent une décision.',
  'guild.queue.applicants.emptyBody': 'Les candidats n’apparaissent ici que lorsque cette guilde pose des questions d’admission.',
  'guild.queue.applicants.emptyTitle': 'Personne n’attend',
  'guild.queue.applicants.title': 'Candidats',
  'guild.queue.approve': 'Approuver',
  'guild.queue.held.description': 'Approuver envoie le message maintenant. Refuser le supprime en silence.',
  'guild.queue.held.emptyBody': 'La file de retenue est vide.',
  'guild.queue.held.emptyTitle': 'Rien en attente',
  'guild.queue.held.noText': '(aucun texte)',
  'guild.queue.held.reason': 'retenu',
  'guild.queue.held.title': 'Messages retenus',
  'guild.queue.heldFailed': 'Impossible d’agir sur ce message',
  'guild.queue.reject': 'Refuser',
  'guild.title.fallback': 'Guilde',
  'guild.unreachable': 'Le serveur de cette guilde est injoignable pour l’instant.',
  'guild.voice.add.crumb': 'Adresse',
  'guild.voice.add.makeDefault': 'Définir comme défaut de la guilde',
  'guild.voice.add.nameHint': 'Le nom sous lequel ce relais apparaît dans le sélecteur de région d’un salon.',
  'guild.voice.add.nameLabel': 'Nom de la région',
  'guild.voice.add.namePlaceholder': 'mon-relais',
  'guild.voice.add.sfuLabel': 'Adresse du SFU',
  'guild.voice.add.sfuPlaceholder': 'https://sfu.example.com',
  'guild.voice.add.step1Body': 'L’adresse d’un SFU que cette guilde peut appeler.',
  'guild.voice.add.step1Title': 'Où se trouve le relais ?',
  'guild.voice.add.step2Title': 'Nommez-la',
  'guild.voice.add.submit': 'Ajouter la région',
  'guild.voice.add.title': 'Ajouter une région',
  'guild.voice.add.turnLabel': 'TURN (facultatif)',
  'guild.voice.add.turnPlaceholder': 'turn.example.com:3478',
  'guild.voice.addFailed': 'Impossible d’ajouter la région vocale',
  'guild.voice.address.bareHost': 'Commencez par https:// — un hôte nu est lu comme une partie de l’adresse de cette page, pas comme un serveur.',
  'guild.voice.address.needsHost': 'Ajoutez l’hôte après, comme https://sfu.example.com.',
  'guild.voice.address.wrongScheme': 'Une région s’appelle en http ou https, pas en {scheme}.',
  'guild.voice.colHealth': 'Santé',
  'guild.voice.colName': 'Nom',
  'guild.voice.colSfu': 'SFU',
  'guild.voice.colType': 'Type',
  'guild.voice.defaultFailed': 'Impossible de définir la région par défaut',
  'guild.voice.defaultMarker': 'Défaut de la guilde',
  'guild.voice.empty': 'Aucune région configurée.',
  'guild.voice.guildDefault': 'Par défaut de la guilde : <code>{name}</code>',
  'guild.voice.healthDown': 'hors service',
  'guild.voice.healthOk': 'ok',
  'guild.voice.loadFailed': 'Impossible de charger les régions vocales',
  'guild.voice.makeDefault': 'Définir par défaut',
  'guild.voice.makeDefaultRegion': 'Définir {name} comme défaut de la guilde',
  'guild.voice.probe.a11yChecking': 'Vérification de l’adresse',
  'guild.voice.probe.a11yFailed': 'Impossible de l’atteindre depuis ce navigateur',
  'guild.voice.probe.a11yReached': 'Atteint',
  'guild.voice.probe.checking': 'Vérification que votre navigateur peut l’atteindre…',
  'guild.voice.probe.reachable.body': 'Un SFU privé doit quand même être configuré pour faire confiance à cette guilde avant qu’un appel puisse se connecter — être disponible et accepter cette guilde sont deux choses différentes.',
  'guild.voice.probe.reachable.title': 'Votre navigateur l’a atteint.',
  'guild.voice.probe.recheck': 'Vérifier l’accessibilité',
  'guild.voice.probe.unreachable.body': 'Cela peut signifier que le relais est hors service, ou qu’il ne répond tout simplement pas aux requêtes d’un navigateur. S’il s’agit d’un SFU privé, vérifiez qu’il a été configuré pour faire confiance à cette guilde. Vous pouvez l’ajouter dans un cas comme dans l’autre et essayer un appel.',
  'guild.voice.probe.unreachable.title': 'Il n’a pas répondu.',
  'guild.voice.probe.unverified.body': 'Le navigateur a été bloqué avant d’obtenir une réponse, ce qui est normal : un SFU qui n’envoie aucun en-tête CORS est parfaitement correct et ne peut simplement pas être sondé depuis une page web. C’est une indication, pas un verdict — ajoutez-le et essayez un appel.',
  'guild.voice.probe.unverified.title': 'Impossible de vérifier d’ici.',
  'guild.voice.regions.description': 'Ajoutez votre propre relais pour que cette guilde, ou des salons vocaux précis, l’utilise.',
  'guild.voice.regions.title': 'Régions vocales',
  'guild.voice.removeFailed': 'Impossible de retirer la région (elle est peut-être encore utilisée par un salon)',
  'guild.voice.removeRegion': 'Retirer {name}',
  'guild.voice.serverDefault': 'Par défaut du serveur : <code>{name}</code>',
  'guild.voice.serverDefaultNone': 'Aucun défaut de serveur.',
  'guild.voice.tableLabel': 'Régions vocales',
  'guild.voice.typeCustom': 'personnalisée',
  'guild.voice.typeServer': 'serveur',

  // ---- migration
  'migration.banner.alert': '{subject, select, guild {La guilde {subjectId}} other {Votre compte}} est sur le point d’être déplacé vers {destination} {when, select, soon {dès qu’il sera pris en charge} other {le {at, date, short}, {at, time, withSeconds}}}. Si vous n’avez pas demandé cela, annulez-le et changez votre mot de passe.{mailed, select, sent { Un avertissement a aussi été envoyé à votre adresse e-mail de récupération.} other {}}',
  'migration.banner.cancel': 'Annuler le déplacement',
  'migration.banner.cancelFailed': 'Impossible d’annuler le déplacement : {reason}',
  'migration.banner.more': '{count, plural, one {# autre déplacement programmé vous attend. Ouvrez les paramètres pour le voir.} many {# d’autres déplacements programmés vous attendent. Ouvrez les paramètres pour les voir.} other {# autres déplacements programmés vous attendent. Ouvrez les paramètres pour les voir.}}',
  'migration.confirm.account': '<b>Déplacer {subjectId} vers {me} ?</b> Le déplacement doit encore être autorisé sur {source} avec le mot de passe de ce compte.',
  'migration.confirm.anotherServer': 'un autre serveur',
  'migration.confirm.confirming': 'Confirmation…',
  'migration.confirm.done': '<b>{source} a été informé que ce {subject, select, guild {guilde} other {compte}} est prêt.</b> Rien n’a encore bougé. Retournez à la fenêtre où vous avez lancé le déplacement : {source} y montrera {target} {subject, select, guild {comme nouveau propriétaire de la guilde} other {comme destination}} et vous demandera votre mot de passe avant que le délai de réflexion ne commence.',
  'migration.confirm.failed': 'Impossible de confirmer ce déplacement : {reason}',
  'migration.confirm.guild': '<b>Recevoir la guilde {guild} depuis {source} ?</b> Elle appartiendrait ici à {me}. Le déplacement doit encore être autorisé sur {source} par la personne propriétaire de la guilde.',
  'migration.confirm.guildNamed': '« {name} » ({id})',
  'migration.confirm.notNow': 'Pas maintenant',
  'migration.confirm.notYou': 'Si vous ne venez pas de lancer le déplacement {subject, select, guild {d’une guilde} other {d’un compte}} depuis {source}, choisissez Pas maintenant. Rien n’est envoyé tant que vous ne confirmez pas.',
  'migration.confirm.receive': '{subject, select, guild {Recevoir cette guilde} other {Recevoir ce compte}}',
  'migration.confirm.sending': 'Envoi de la confirmation à {source}…',
  'migration.confirm.thisAccount': 'ce compte',
  'migration.confirm.wrongServer': '<b>Ce lien sert à déplacer {subject, select, guild {une guilde} other {un compte}} vers {destination}.</b> Vous êtes connecté sur {here}. Déconnectez-vous, puis connectez-vous ou créez un compte sur {destination} et ouvrez de nouveau le lien. Rien n’a été envoyé.',
  'migration.field.destination': 'Serveur de destination',
  'migration.field.destinationPlaceholder': 'newhome.example.org',
  'migration.field.oldAccountId': 'Ancien identifiant de compte',
  'migration.field.oldGuildId': 'Ancien identifiant de guilde',
  'migration.field.oldServer': 'Ancien serveur',
  'migration.field.password': 'Votre mot de passe sur ce serveur',
  'migration.field.passwordHint': 'C’est le mot de passe de l’ancien serveur (ou du serveur actuel), pas celui de la destination.',
  'migration.guided.authorize': 'Saisissez de nouveau votre mot de passe pour l’autoriser. La programmation démarre un délai de réflexion pendant lequel n’importe lequel de vos appareils peut annuler.',
  'migration.guided.continue': 'Continuer sur le nouveau serveur',
  'migration.guided.finishThere': '<b>Terminez sur {destination}.</b> Une fenêtre s’est ouverte sur la propre page de {destination}. Connectez-vous, ou {subject, select, guild {créez le compte qui possédera la guilde là-bas} other {créez le compte vers lequel vous déménagez}}, et confirmez sur place.',
  'migration.guided.intro': '{subject, select, guild {Nommez le serveur vers lequel vous déplacez cette guilde.} other {Nommez le serveur vers lequel vous déménagez.}} Confirmez sur sa page, puis revenez ici pour autoriser avec votre mot de passe.',
  'migration.guided.linkExpired': 'Ce lien a expiré. Recommencez pour en obtenir un nouveau.',
  'migration.guided.lookingUp': 'Recherche de {destination}…',
  'migration.guided.noClient': '{destination} ne publie pas de page web pour recevoir un déplacement. Vous pouvez quand même y déménager avec un code d’importation créé sur ce serveur.',
  'migration.guided.noWindow': 'Si aucune fenêtre ne s’est ouverte : <a>{url}</a>',
  'migration.guided.openAgain': 'L’ouvrir de nouveau',
  'migration.guided.opening': 'Ouverture…',
  'migration.guided.ready': '<b>{destination} est prêt.</b> {subject, select, guild {Cette guilde, {name}, sera déplacée vers {destination}, où elle appartiendra à <id>{target}</id>.} other {Ce compte, {name}, sera déplacé vers <id>{target}</id>.}} Si ce n’est pas le compte que vous venez de confirmer, annulez ici.',
  'migration.guided.startFailed': 'Impossible de lancer le déplacement : {reason}',
  'migration.guided.step': 'Étape {current, number} sur {total, number}',
  'migration.guided.useCode': 'Utiliser un code d’importation',
  'migration.guided.waiting': 'En attente de la confirmation de {destination}… Ce lien fonctionne une fois et expire {expiresAt, relative}.',
  'migration.importCode.hint': 'À usage unique et de courte durée. Ne le collez que dans la boîte de dialogue de déplacement sur l’ancien serveur.',
  'migration.importCode.label': 'Code d’importation',
  'migration.importCode.placeholder': 'code à usage unique de la destination',
  'migration.importCode.sourceHint': 'Créé par Paramètres → Compte → Recevoir un déplacement sur la destination. Il expire au bout de sept jours.',
  'migration.manual.destinationHint': 'Le serveur où vous venez de créer le code d’importation.',
  'migration.manual.step1': '{step, number}. Préparez le serveur de destination.',
  'migration.manual.step1Where': 'Connectez-vous sur le serveur vers lequel vous voulez déménager, puis ouvrez Paramètres → Compte → Recevoir un déplacement. Cela créera un code d’importation à usage unique pour cette source précise.',
  'migration.manual.step1Which': 'Pour un compte, utilisez le compte de destination que vous y avez créé. Pour une guilde, utilisez le compte qui doit la posséder là-bas.',
  'migration.manual.step2': '{step, number}. Autorisez le déplacement sur ce serveur.',
  'migration.manual.step2Cooling': 'La programmation démarre un délai de réflexion. N’importe quel appareil actif peut annuler avant l’exécution du transfert.',
  'migration.manual.step2Password': 'Saisissez de nouveau votre mot de passe actuel ci-dessous.',
  'migration.manual.useGuided': 'Utiliser le déplacement guidé',
  'migration.receive.accountIdHint': 'Votre identifiant complet sur l’ancien serveur, par exemple @vous:ancien.example.',
  'migration.receive.accountIdPlaceholder': '@you:old.example',
  'migration.receive.another': 'Créer un autre code',
  'migration.receive.approvalFor': 'Cette approbation concerne {subjectId} depuis {source}.',
  'migration.receive.create': 'Créer un code d’importation',
  'migration.receive.creating': 'Préparation…',
  'migration.receive.expires': 'Il expire {expiresAt, date, medium} ({expiresAt, relative}).',
  'migration.receive.guildIdHint': 'Copiez l’identifiant de guilde exactement tel qu’il apparaît sur l’ancien serveur.',
  'migration.receive.guildIdPlaceholder': 'identifiant de guilde de l’ancien serveur',
  'migration.receive.guildOwner': 'La guilde déplacée appartiendra ici au compte avec lequel vous êtes connecté.',
  'migration.receive.intro': '<b>Vous préparez {destination} comme destination.</b> Rien n’est déplacé ni supprimé par cette étape.',
  'migration.receive.nextTitle': 'Retournez maintenant sur l’ancien serveur.',
  'migration.receive.nextUse': 'Dans sa boîte de dialogue de déplacement, utilisez {destination} comme serveur de destination et collez le code d’importation ci-dessus.',
  'migration.receive.prepareFailed': 'Impossible de préparer ce serveur : {reason}',
  'migration.receive.preparing': 'Vérification de l’ancien serveur et création d’un code d’importation à usage unique…',
  'migration.receive.ready': '<b>{destination} est prêt à recevoir ce déplacement.</b> Rien n’a encore bougé.',
  'migration.receive.sourceFromId': 'Lu à partir de l’identifiant de compte ci-dessus.',
  'migration.receive.sourceGuildHint': 'Le serveur qui héberge actuellement la guilde.',
  'migration.receive.sourcePlaceholder': 'old.example',
  'migration.receive.subject': 'Que recevez-vous ?',
  'migration.receive.subjectAccount': 'Un compte',
  'migration.receive.subjectGuild': 'Une guilde',
  'migration.receive.thisServer': 'ce serveur',
  'migration.receive.title': 'Recevoir un déplacement',
  'migration.schedule.action': 'Programmer le déplacement',
  'migration.schedule.busy': 'Programmation…',
  'migration.schedule.failed': 'Migration non lancée : {reason}',
  'migration.schedule.noDeviceKey': 'Cet appareil n’a pas de clé de signature stockée. La migration doit être lancée depuis un appareil qui appartient déjà à ce compte.',
  'migration.schedule.scheduling': 'Programmation du déplacement…',
  'migration.schedule.signFailed': 'Cet appareil n’a pas pu signer l’autorisation de migration.',
  'migration.schedule.signing': 'Signature de ce déplacement avec cet appareil…',
  'migration.scheduled.cancelHint': 'Vous pouvez annuler pendant le délai de réflexion depuis Paramètres → Compte.',
  'migration.scheduled.headline': '<b>Le déplacement est programmé, pas encore effectué.</b> Rien n’a été supprimé lorsque vous avez appuyé sur Programmer. Il sera déplacé vers {destination} {at, relative}, sauf si un appareil actif l’annule avant.',
  'migration.title.account': 'Déplacer ce compte',
  'migration.title.guild': 'Déplacer cette guilde',

  // ---- notifications
  'notifications.wake.activity': 'Nouvelle activité dans un salon que vous suivez.',
  'notifications.wake.migration': 'Un déplacement de votre compte a été demandé. Ouvrez Telium pour l’examiner ou l’annuler.',
  'notifications.wake.updateToast': 'Une nouvelle version est prête. Rechargez pour l’utiliser.',

  // ---- onboarding
  'onboarding.address.clipboardLabel': 'Adresse',
  'onboarding.address.copy': 'Copier l’adresse',
  'onboarding.address.yours': 'Votre adresse Telium est <b>{user}</b>. Vous en aurez besoin pour vous connecter sur un autre appareil.',
  'onboarding.home.advancedHint': 'Avancé : saisissez l’adresse HTTPS de n’importe quel serveur d’accueil Telium qui autorise l’inscription.',
  'onboarding.home.advancedPlaceholder': 'https://home.example',
  'onboarding.home.browseAll': 'Parcourir tous les serveurs',
  'onboarding.home.chipAction': '{host} — changer le lieu de vie de votre compte',
  'onboarding.home.chooseOther': 'En choisir un autre',
  'onboarding.home.communityBadge': 'Communauté',
  'onboarding.home.detailSeparator': ' · ',
  'onboarding.home.explainer': 'Ce serveur héberge votre compte et votre connexion. Les communautés peuvent vivre n’importe où.',
  'onboarding.home.finding': 'Recherche d’un serveur communautaire sain…',
  'onboarding.home.label': 'Serveur d’accueil',
  'onboarding.home.noPinnedKey': 'Cette version du client n’a pas encore épinglé la clé de signature des recommandations.',
  'onboarding.home.operatedBy': 'Exploité par <a>{operator}</a>',
  'onboarding.home.otherChoices': 'Autres serveurs d’attache recommandés',
  'onboarding.home.picked': 'Nous avons choisi <b>{name}</b> pour vous',
  'onboarding.home.title': 'Serveur du compte',
  'onboarding.home.unavailable': 'Aucune recommandation communautaire vérifiée n’est disponible pour l’instant. Choisissez plutôt n’importe quel serveur d’accueil auquel vous faites confiance.',
  'onboarding.home.uptime': '{rate, number} % de disponibilité récente',
  'onboarding.home.useAnother': 'Utiliser un autre serveur',
  'onboarding.home.useDomain': 'Utiliser un domaine de serveur',
  'onboarding.home.why': 'C’est ici que vit votre compte, un peu comme choisir un fournisseur de messagerie. Vous pouvez quand même parler à tout le monde et rejoindre n’importe quelle communauté, quel que soit le serveur qu’elle utilise. Nous répartissons les nouvelles personnes sur des serveurs de confiance afin que Telium ne dépende jamais d’une seule entreprise.',
  'onboarding.invite.accountIdLabel': 'Nom d’utilisateur ou identifiant de compte',
  'onboarding.invite.accountIdPlaceholder': 'votrenom ou @vous:home.example',
  'onboarding.invite.accountReady': 'Votre compte est prêt.',
  'onboarding.invite.backToSignIn': 'Retour à la connexion',
  'onboarding.invite.createAndJoin': 'Créer un compte et rejoindre {guild}',
  'onboarding.invite.createFailed': 'Impossible de créer votre compte.',
  'onboarding.invite.creating': 'Création du compte…',
  'onboarding.invite.displayNameHint': 'Vous pourrez le modifier plus tard.',
  'onboarding.invite.displayNameLabel': 'Nom d’affichage',
  'onboarding.invite.displayNamePlaceholder': 'Comment doit-on vous appeler ?',
  'onboarding.invite.existingHomeHint': 'Le serveur où vit votre compte Telium existant.',
  'onboarding.invite.expiredBody': 'Elle a peut-être expiré, atteint sa limite d’utilisation, ou été révoquée.',
  'onboarding.invite.expiredTitle': 'Cette invitation n’est plus valable',
  'onboarding.invite.goToTelium': 'Aller sur Telium',
  'onboarding.invite.haveAccount': 'Vous avez déjà un compte Telium ? <a>Se connecter</a>',
  'onboarding.invite.homeHint': 'Où vivra votre nouveau compte. Le modifier ne change pas l’invitation.',
  'onboarding.invite.homePlaceholder': 'home.example',
  'onboarding.invite.hostNote': '<b>{domain}</b> héberge cette guilde. Votre compte peut vivre sur un autre serveur Telium.',
  'onboarding.invite.invited': 'Vous avez été invité à rejoindre',
  'onboarding.invite.invitedBy': '{name} vous invite à rejoindre',
  'onboarding.invite.join': 'Rejoindre {guild}',
  'onboarding.invite.joinFailed': 'Impossible de rejoindre cette guilde.',
  'onboarding.invite.joining': 'Connexion…',
  'onboarding.invite.joiningAs': 'Connexion en tant que {name}.',
  'onboarding.invite.legacyRegisterAction': 'Utiliser l’inscription héritée',
  'onboarding.invite.legacyServer': '<b>Ce serveur d’accueil utilise l’authentification par mot de passe héritée.</b> Continuer envoie votre mot de passe à ce serveur. Ne le faites que si vous lui faites confiance.',
  'onboarding.invite.legacySignInAction': 'Utiliser la connexion héritée',
  'onboarding.invite.legacyUpgrade': '<b>Ce vieux compte a besoin d’une mise à niveau de sécurité ponctuelle.</b> Pour cette tentative uniquement, le serveur recevra votre mot de passe. Les connexions suivantes ne le feront pas.',
  'onboarding.invite.legacyUpgradeAction': 'Mettre ce compte à niveau',
  'onboarding.invite.members': '{count, plural, one {# membre} many {# de membres} other {# membres}}',
  'onboarding.invite.mfaLabel': 'Code d’authentification',
  'onboarding.invite.mfaPlaceholder': '123456 ou code de récupération',
  'onboarding.invite.mfaPrompt': 'Saisissez le code d’authentification à six chiffres ou l’un de vos codes de récupération.',
  'onboarding.invite.needAccount': 'Besoin d’un compte Telium ? <a>En créer un</a>',
  'onboarding.invite.needCredentials': 'Saisissez votre nom d’utilisateur et votre mot de passe.',
  'onboarding.invite.needDisplayName': 'Choisissez le nom d’affichage que les personnes de la guilde doivent voir.',
  'onboarding.invite.needHome': 'Choisissez un serveur d’accueil pour votre compte.',
  'onboarding.invite.newHomeHint': 'Le serveur auquel appartiendra votre nouveau compte Telium.',
  'onboarding.invite.noIdentityRole': '{name} n’héberge pas de comptes utilisateurs.',
  'onboarding.invite.online': '{count, plural, one {# en ligne} many {# de personnes en ligne} other {# en ligne}}',
  'onboarding.invite.opening': 'Ouverture de l’invitation…',
  'onboarding.invite.openingHint': 'Demande au serveur de cette guilde ce que le lien ouvre.',
  'onboarding.invite.registrationClosed': '{name} n’accepte pas de nouveaux comptes.',
  'onboarding.invite.screeningPending': 'Votre compte est prêt. Cette guilde exige une vérification avant que vous deveniez membre.',
  'onboarding.invite.signInAndJoin': 'Se connecter et rejoindre {guild}',
  'onboarding.invite.signInFailed': 'Impossible de se connecter.',
  'onboarding.invite.signingIn': 'Connexion…',
  'onboarding.invite.unopenableTitle': 'Impossible d’ouvrir cette invitation',
  'onboarding.invite.unreachable': 'Le serveur de la guilde n’a pas pu être joint.',
  'onboarding.invite.useAnotherAccount': 'Utiliser un autre compte',
  'onboarding.invite.usernameHint': 'Cela deviendra la première partie de votre identifiant de compte Telium.',
  'onboarding.invite.usernamePlaceholder': 'votrenom',
  'onboarding.recoveryKey.body': 'Elle peut réinitialiser votre mot de passe et récupérer votre compte chiffré.',
  'onboarding.recoveryKey.clipboardLabel': 'Clé de récupération',
  'onboarding.recoveryKey.confirm': 'J’ai enregistré ma clé de récupération',
  'onboarding.recoveryKey.copy': 'Copier la clé de récupération',
  'onboarding.recoveryKey.download': 'La télécharger dans un fichier',
  'onboarding.recoveryKey.finishing': 'Finalisation…',
  'onboarding.recoveryKey.title': 'Enregistrez votre clé de récupération',
  'onboarding.recoveryKey.warning': '<b>Conservez-la séparément de votre mot de passe.</b> Elle ne peut pas être recréée.',

  // ---- perms
  'perms.add_reactions.hint': 'Poser une nouvelle réaction sur un message. Rejoindre une réaction existante ne demande rien.',
  'perms.add_reactions.label': 'Ajouter des réactions',
  'perms.administrator.hint': 'Toutes les permissions sur ce serveur, et toutes les surcharges de salon ignorées. À ne confier qu’à quelqu’un à qui l’on confierait la guilde elle-même.',
  'perms.administrator.label': 'Administrateur',
  'perms.attach_files.hint': 'Mettre en ligne des images et des fichiers dans le stockage média propre à cette guilde.',
  'perms.attach_files.label': 'Joindre des fichiers',
  'perms.ban_members.hint': 'Interdire à un compte de revenir, par identifiant d’utilisateur, sur tous les serveurs d’accueil.',
  'perms.ban_members.label': 'Bannir des membres',
  'perms.connect.hint': 'Rejoindre les salons vocaux visibles.',
  'perms.connect.label': 'Se connecter',
  'perms.create_invite.hint': 'Générer des codes d’invitation qui laissent entrer des comptes de n’importe quel serveur d’accueil.',
  'perms.create_invite.label': 'Créer une invitation',
  'perms.deafen_members.hint': 'Empêcher les autres d’entendre un salon vocal.',
  'perms.deafen_members.label': 'Assourdir des membres',
  'perms.embed_links.hint': 'Déployer les liens publiés en aperçus.',
  'perms.embed_links.label': 'Intégrer les liens',
  'perms.group.advanced': 'Permissions avancées',
  'perms.group.general': 'Permissions générales du serveur',
  'perms.group.membership': 'Permissions d’appartenance',
  'perms.group.text': 'Permissions des salons textuels',
  'perms.group.voice': 'Permissions des salons vocaux',
  'perms.kick_members.hint': 'Retirer les membres classés en dessous du sien. Une expulsion n’est pas un bannissement : la personne peut revenir avec une nouvelle invitation.',
  'perms.kick_members.label': 'Expulser des membres',
  'perms.manage_channels.hint': 'Créer, renommer, réordonner et supprimer les salons de cette guilde.',
  'perms.manage_channels.label': 'Gérer les salons',
  'perms.manage_expressions.hint': 'Mettre en ligne et retirer les émojis et les stickers que cette guilde sert.',
  'perms.manage_expressions.label': 'Gérer les émojis et les stickers',
  'perms.manage_guild.hint': 'Modifier le nom de la guilde, son icône, son filtre d’entrée et sa région vocale.',
  'perms.manage_guild.label': 'Gérer le serveur',
  'perms.manage_messages.hint': 'Supprimer et épingler les messages de n’importe qui.',
  'perms.manage_messages.label': 'Gérer les messages',
  'perms.manage_roles.hint': 'Modifier les rôles situés sous le sien, et attribuer ces rôles à n’importe qui. On ne peut jamais accorder une permission que l’on ne détient pas déjà.',
  'perms.manage_roles.label': 'Gérer les rôles',
  'perms.mention_everyone.hint': 'Notifier toute la guilde, ou n’importe quel rôle, que ce rôle soit mentionnable ou non.',
  'perms.mention_everyone.label': 'Mentionner @everyone et les rôles',
  'perms.moderate_members.hint': 'Réduire un membre au silence un moment. Un membre exclu temporairement ne peut plus que lire.',
  'perms.moderate_members.label': 'Exclure temporairement des membres',
  'perms.move_members.hint': 'Faire glisser des personnes entre les salons vocaux, ou hors de ceux-ci.',
  'perms.move_members.label': 'Déplacer des membres',
  'perms.mute_members.hint': 'Réduire les autres au silence dans les salons vocaux.',
  'perms.mute_members.label': 'Rendre des membres muets',
  'perms.priority_speaker.hint': 'Se faire entendre au-dessus de tout le monde pendant que l’on parle.',
  'perms.priority_speaker.label': 'Orateur prioritaire',
  'perms.read_message_history.hint': 'Voir ce qui a été dit avant d’arriver. Sans cela, un salon commence vide.',
  'perms.read_message_history.label': 'Lire l’historique des messages',
  'perms.send_messages.hint': 'Publier dans les salons textuels visibles.',
  'perms.send_messages.label': 'Envoyer des messages',
  'perms.speak.hint': 'Se faire entendre en vocal. Sans cela, on peut seulement écouter.',
  'perms.speak.label': 'Parler',
  'perms.stream.hint': 'Partager un écran en vocal.',
  'perms.stream.label': 'Diffuser',
  'perms.use_external_emoji.hint': 'Utiliser des émojis servis par d’autres guildes, sur d’autres serveurs d’accueil.',
  'perms.use_external_emoji.label': 'Utiliser des émojis externes',
  'perms.video.hint': 'Allumer une caméra en vocal.',
  'perms.video.label': 'Vidéo',
  'perms.view_audit_log.hint': 'Consulter le registre de ce qui a été modifié, et par qui, sur ce serveur.',
  'perms.view_audit_log.label': 'Voir le journal d’audit',
  'perms.view_channel.hint': 'Voir les salons dont une surcharge n’a pas fermé l’accès.',
  'perms.view_channel.label': 'Voir les salons',

  // ---- privacy
  'privacy.block.body': 'La personne voit l’amitié prendre fin, et plus rien de sa part ne vous parvient — ni demande, ni message, ni notification, et on ne lui dit jamais lequel. Cela ne l’empêche pas d’envoyer : votre serveur d’accueil prend quand même ses messages et les stocke, et de son côté la conversation a l’air ordinaire.',
  'privacy.gif.body': 'Votre appareil demande ces résultats à {host} et récupère directement chez lui tout ce que vous envoyez ; il voit donc votre adresse et le GIF que vous avez choisi. Rien de tout cela ne passe par votre serveur d’accueil, et aucun réglage ne permet de le désactiver.',
  'privacy.gif.head': 'Cette conversation est chiffrée. Le GIF ne l’est pas.',
  'privacy.lookups.head': 'Découvrir ce que vous avez en commun avec quelqu’un est une question que ce compte pose à voix haute.',
  'privacy.lookups.note': 'Voilà qui en entend parler à chaque fois qu’une recherche a lieu. Le réglage ci-dessus change la fréquence, et si autre chose qu’une ouverture délibérée peut en déclencher une — il ne rend pas la recherche plus discrète.',
  'privacy.lookups.party.friendHosts': 'Tous les serveurs qui hébergent un de vos amis',
  'privacy.lookups.party.guildHosts': 'Tous les serveurs avec lesquels vous partagez un espace',
  'privacy.lookups.party.home': 'Votre serveur d’accueil',
  'privacy.lookups.sees.friendHosts': 'une question signée chacun, vous nommant ainsi que la personne que vous regardez. Ils sont tous interrogés, y compris ceux qui n’ont rien à répondre, de sorte que chacun apprend que vous lisiez à ce moment-là.',
  'privacy.lookups.sees.guildHosts': 'une requête de cet appareil demandant si cette personne est membre ; ils voient donc votre adresse, ainsi que le fait que vous avez posé la question.',
  'privacy.lookups.sees.home': 'que vous avez regardé, et qui. Il détient déjà votre liste d’amis ; la recherche n’ajoute donc que le moment, et rien d’autre.',
  'privacy.presence.invisible': '« Invisible », c’est ce que l’on dit à tout le monde. Votre serveur d’accueil voit quand même cette connexion et compte les appareils sur lesquels vous êtes connecté.',
  'privacy.push.head': 'Votre fournisseur de push est le service de l’éditeur de votre navigateur, et c’est la seule partie de tout cela qui ne vous appartient pas.',
  'privacy.push.provider': 'Il obtient une adresse stable pour ce navigateur, ainsi que l’heure et la taille de chaque réveil. Le contenu est chiffré à destination de ce navigateur, il ne peut donc pas le lire — mais la signature de chacun nomme votre serveur d’accueil ; au fil du temps, il détient donc un journal des moments où votre serveur d’accueil avait quelque chose à vous dire.',
  'privacy.typing.inEncrypted': 'Les indicateurs de saisie sont l’exception : ils partent en clair, de sorte que votre serveur, le serveur de tout le monde et toutes les personnes de la conversation les voient au fur et à mesure. Les signaux de conversation permettent de les désactiver.',

  // ---- roles
  'roles.colour.blue': 'Bleu',
  'roles.colour.emerald': 'Émeraude',
  'roles.colour.gold': 'Or',
  'roles.colour.green': 'Vert',
  'roles.colour.grey': 'Gris',
  'roles.colour.indigo': 'Indigo',
  'roles.colour.orange': 'Orange',
  'roles.colour.pink': 'Rose',
  'roles.colour.purple': 'Violet',
  'roles.colour.red': 'Rouge',
  'roles.colour.teal': 'Bleu sarcelle',
  'roles.colour.yellow': 'Jaune',
  'roles.create.confirm': 'Créer',
  'roles.create.failed': 'Impossible de créer le rôle',
  'roles.create.nameLabel': 'Nom du rôle',
  'roles.create.title': 'Créer un rôle',
  'roles.delete.body': 'Les surcharges de salon qui nomment ce rôle partent avec lui.',
  'roles.delete.failed': 'Impossible de supprimer le rôle',
  'roles.delete.title': 'Supprimer {role}',
  'roles.display.colour': 'Couleur du rôle',
  'roles.display.colourHint': 'Les membres portent la couleur du rôle le plus élevé qu’ils détiennent, parmi ceux qui en ont une.',
  'roles.display.hoist': 'Afficher les membres du rôle à part',
  'roles.display.hoistHint': 'Les membres détenant ce rôle obtiennent leur propre titre dans la liste des membres, sous le rôle affiché à part le plus élevé qu’ils détiennent.',
  'roles.display.mentionable': 'Autoriser tout le monde à mentionner ce rôle avec @',
  'roles.display.mentionableHint': 'Sans cela, seuls les membres disposant de {permission} peuvent le notifier.',
  'roles.display.noColour': 'Aucune couleur',
  'roles.editor.back': 'Retour aux rôles',
  'roles.editor.notEditable': 'Ce rôle se situe au niveau du vôtre ou au-dessus ; ce serveur ne vous laissera donc pas le modifier.',
  'roles.editor.reset': 'Réinitialiser',
  'roles.editor.save': 'Enregistrer les modifications',
  'roles.editor.saveFailed': 'Impossible d’enregistrer le rôle',
  'roles.editor.unsaved': 'Attention, vous avez des modifications non enregistrées.',
  'roles.everyone.description': 'Ce que chaque membre de cette guilde peut faire, avant qu’aucun rôle ne soit attribué.',
  'roles.everyone.locked': '@everyone ne peut être ni déplacé, ni renommé, ni supprimé.',
  'roles.everyone.title': 'Permissions par défaut',
  'roles.list.create': 'Créer un rôle',
  'roles.list.description': 'Faites glisser un rôle pour changer qui dépasse qui dans la hiérarchie.',
  'roles.list.empty.body': 'Tout le monde ici a les permissions par défaut, et rien de plus.',
  'roles.list.empty.title': 'Aucun rôle pour l’instant',
  'roles.list.hint': 'Un rôle ne peut être modifié, déplacé ou attribué que par quelqu’un situé au-dessus de lui.',
  'roles.list.noMatch': 'Aucun rôle ne correspond à « {query} ».',
  'roles.list.search': 'Rechercher des rôles',
  'roles.list.title': '{count, plural, one {Rôles - #} many {Rôles - #} other {Rôles - #}}',
  'roles.managed.canManageGuild': 'Ce rôle appartient à un bot installé. Il a été créé lors de l’installation et ne peut pas être modifié ici — modifiez ce que le bot a le droit de faire depuis la page Bots de ces paramètres.',
  'roles.managed.needsManageGuild': 'Ce rôle appartient à un bot installé. Il a été créé lors de l’installation et ne peut pas être modifié ici. Ce que le bot a le droit de faire se modifie depuis la page Bots, qui nécessite {permission}.',
  'roles.memberCount': '{count, plural, one {# membre} many {# de membres} other {# membres}}',
  'roles.members.add': 'Ajouter',
  'roles.members.addFailed': 'Impossible d’ajouter ce membre',
  'roles.members.empty.body': 'Cherchez ci-dessus pour l’attribuer à quelqu’un.',
  'roles.members.empty.title': 'Personne ne détient ce rôle',
  'roles.members.holding': '{count, plural, one {Possédant {role} - #} many {Possédant {role} - #} other {Possédant {role} - #}}',
  'roles.members.matching': 'Correspondant à « {query} »',
  'roles.members.noMatch': 'Personne dans cette guilde ne répond à cela.',
  'roles.members.removeFailed': 'Impossible de retirer ce membre',
  'roles.members.search': 'Rechercher des membres à ajouter',
  'roles.members.searchPlaceholder': 'Rechercher des membres par nom',
  'roles.overwrite.allow': 'Autoriser dans ce salon',
  'roles.overwrite.channel': 'Salon',
  'roles.overwrite.control': '{permission} dans ce salon',
  'roles.overwrite.deny': 'Refuser dans ce salon',
  'roles.overwrite.hint': 'Une surcharge restreint ou élargit les permissions d’un rôle dans un salon. Les fils héritent de leur salon parent.',
  'roles.overwrite.inherit': 'Hériter du rôle',
  'roles.overwrite.role': 'Rôle',
  'roles.overwrite.save': 'Enregistrer la surcharge',
  'roles.overwrite.saved': 'Surcharge enregistrée.',
  'roles.overwrite.saveFailed': 'Impossible d’enregistrer la surcharge',
  'roles.permissions.adminNotice': '{permission} est toutes les permissions, et ignore les surcharges de salon.',
  'roles.permissions.noMatch': 'Aucune permission ne correspond à « {query} ».',
  'roles.permissions.search': 'Rechercher des permissions',
  'roles.reorder.failed': 'Impossible de réordonner les rôles',
  'roles.row.delete': 'Supprimer {role}',
  'roles.row.edit': 'Modifier {role}',
  'roles.tab.display': 'Affichage',
  'roles.tab.members': 'Gérer les membres',
  'roles.tab.permissions': 'Permissions',

  // ---- security
  'security.codes.clipboardName': 'Codes de récupération',
  'security.codes.copy': 'Les copier',
  'security.codes.download': 'Les télécharger dans un fichier',
  'security.codes.fileHeading': 'Codes de récupération à deux facteurs Telium',
  'security.codes.listLabel': '{count, plural, one {# code de récupération} many {# de codes de récupération} other {# codes de récupération}}',
  'security.codes.title': 'Codes de récupération',
  'security.codes.warning': '<b>Notez-les avant de continuer.</b> Chacun fonctionne une fois, et ils ne sont plus affichés.',
  'security.devices.addedAt': '{at, date, medium}',
  'security.devices.allVerified': '{count, plural, one {Votre appareil est vérifié.} many {Tous vos # d’appareils sont vérifiés.} other {Tous vos # appareils sont vérifiés.}}',
  'security.devices.cannotSign': 'Cet appareil ne peut pas encore signer pour votre compte. Vérifiez-le depuis un appareil que vous utilisez déjà, ou déverrouillez vos messages dans {pane}.',
  'security.devices.checking': 'Vérification de vos appareils.',
  'security.devices.colAdded': 'Ajouté',
  'security.devices.colDevice': 'Appareil',
  'security.devices.colLastSeen': 'Vu pour la dernière fois',
  'security.devices.empty': 'Aucun appareil enregistré.',
  'security.devices.lastSeenAt': '{at, relative}',
  'security.devices.noneVerified': '{count, plural, one {Votre appareil n’est pas encore vérifié.} many {Aucun de vos # d’appareils n’est encore vérifié.} other {Aucun de vos # appareils n’est encore vérifié.}}',
  'security.devices.recogniseNote': 'Déconnectez tout ce que vous ne reconnaissez pas.',
  'security.devices.revocationBody': 'Déconnecter un appareil révoque son justificatif auprès de votre serveur d’accueil. Tout ce qui lui a déjà été remis reste remis.',
  'security.devices.revocationTitle': 'Révocation',
  'security.devices.revokeHint': 'La déconnexion d’un appareil met quelques minutes à prendre effet, pas quelques secondes.',
  'security.devices.signedOut': 'déconnecté',
  'security.devices.signOut': 'Déconnecter',
  'security.devices.signOutDevice': 'Déconnecter {device}',
  'security.devices.signOutFailed': 'Cet appareil n’a pas pu être déconnecté. {reason}',
  'security.devices.someUnverified': '{count, plural, one {# de vos {total, plural, one {# appareil} many {# d’appareils} other {# appareils}} n’est pas encore vérifié.} many {# de vos {total, plural, one {# appareil} many {# d’appareils} other {# appareils}} ne sont pas encore vérifiés.} other {# de vos {total, plural, one {# appareil} many {# d’appareils} other {# appareils}} ne sont pas encore vérifiés.}}',
  'security.devices.tableLabel': 'Appareils connectés à votre compte',
  'security.devices.thisDevice': 'cet appareil',
  'security.devices.unverifiedBadge': 'non vérifié',
  'security.devices.unverifiedNote': 'Un appareil non vérifié peut quand même lire ce que vous envoyez. Le vérifier, c’est ce qui vous permet de contrôler qu’il est bien à vous et non à quelqu’un qui se fait passer pour vous.',
  'security.devices.verifiedBadge': 'vérifié',
  'security.devices.verify': 'Vérifier',
  'security.devices.verifyDevice': 'Vérifier {device}',
  'security.devices.whatVerifiedBody': 'Un appareil vérifié est un appareil que votre propre clé de compte a signé. Votre serveur conserve cette liste, mais il ne peut pas falsifier ces signatures ; le badge est donc une affirmation faite par votre compte, et non par l’exploitant.',
  'security.devices.whatVerifiedTitle': 'Ce que signifie « vérifié » ici',
  'security.mfa.appHint': 'Utilisez n’importe quelle application d’authentification TOTP standard à 6 chiffres.',
  'security.mfa.codeFieldLabel': 'Code à 6 chiffres',
  'security.mfa.codeLabel': 'Code d’authentification ou de récupération',
  'security.mfa.disable': 'Désactiver l’authentification à deux facteurs',
  'security.mfa.disabledToast': 'L’authentification à deux facteurs est désactivée.',
  'security.mfa.disableFailed': 'L’authentification à deux facteurs n’a pas pu être désactivée. {reason}',
  'security.mfa.enabled': '{remaining, plural, =0 {L’authentification à deux facteurs est activée, et il ne vous reste aucun code de récupération. Si vous perdez votre application d’authentification, vous ne pourrez plus vous connecter — désactivez l’authentification à deux facteurs et reconfigurez-la pour obtenir un nouveau jeu.} one {L’authentification à deux facteurs est activée. Il reste # code de récupération.} many {L’authentification à deux facteurs est activée. Il reste # de codes de récupération.} other {L’authentification à deux facteurs est activée. Il reste # codes de récupération.}}',
  'security.mfa.enabledNoCount': 'L’authentification à deux facteurs est activée.',
  'security.mfa.enabledToast': 'L’authentification à deux facteurs est activée.',
  'security.mfa.enableFailed': 'L’authentification à deux facteurs n’a pas pu être activée. {reason}',
  'security.mfa.manualHint': 'N’utilisez ceci que si votre application d’authentification ne peut pas scanner le code QR.',
  'security.mfa.manualLabel': 'Clé de configuration manuelle',
  'security.mfa.qrLabel': 'Code QR pour configurer votre application d’authentification',
  'security.mfa.reauthHint': 'Saisissez de nouveau votre mot de passe. Il est vérifié sur cet appareil et n’est pas envoyé.',
  'security.mfa.scanWarning': 'Scannez ce code QR, puis saisissez le code qu’il affiche. L’authentification à deux facteurs n’est activée qu’une fois cette étape réussie.',
  'security.mfa.setUp': 'Configurer l’application d’authentification',
  'security.mfa.setupFailed': 'La configuration à deux facteurs n’a pas pu être lancée. {reason}',
  'security.mfa.title': 'Authentification à deux facteurs',
  'security.mfa.verifyEnable': 'Vérifier et activer',
  'security.mfa.whyPasswordBody': 'Sur un serveur d’accueil OPAQUE, votre mot de passe ne quitte jamais cet appareil. Le saisir ici produit une preuve à usage unique que vous êtes titulaire du compte, ce qui autorise le changement.',
  'security.mfa.whyPasswordTitle': 'Pourquoi le mot de passe est demandé de nouveau',
  'security.trustedLinks.description': 'Les liens vers ces domaines s’ouvrent sans demander. Tout le reste, en dehors de vos serveurs, est confirmé au préalable.',
  'security.trustedLinks.empty': 'Vous n’avez encore approuvé aucun domaine.',
  'security.trustedLinks.forget': 'Redemander pour {domain}',
  'security.trustedLinks.title': 'Liens de confiance',
  'security.verify.comparePeer': 'Comparez-les avec {name} en personne ou lors d’un appel.',
  'security.verify.compareSelf': '{count, plural, one {Les deux appareils doivent afficher cette image.} many {Les deux appareils doivent afficher ces #, dans cet ordre.} other {Les deux appareils doivent afficher ces #, dans cet ordre.}}',
  'security.verify.confirmingPeer': 'En attente que {name} confirme…',
  'security.verify.confirmingSelf': 'En attente que votre autre appareil confirme…',
  'security.verify.donePeer': '{name} est vérifié sur tous vos appareils, y compris tout appareil qu’il ajoutera plus tard.',
  'security.verify.doneSelf': 'Cet appareil est vérifié. Toute personne qui vous a vérifié le voit aussi.',
  'security.verify.finishFailed': 'La vérification n’a pas pu être terminée. {reason}',
  'security.verify.match': 'Elles correspondent',
  'security.verify.mismatchHint': 'S’ils diffèrent, quelque chose s’est intercalé entre les deux.',
  'security.verify.noMatch': 'Elles ne correspondent pas',
  'security.verify.pendingHintPeer': 'Quel que soit l’appareil qui répond, cette vérification couvre tout son compte.',
  'security.verify.pendingHintSelf': 'Ouvrez Telium là-bas ; les deux doivent être en ligne en même temps.',
  'security.verify.startFailed': 'La vérification n’a pas pu être lancée. {reason}',
  'security.verify.starting': 'Démarrage…',
  'security.verify.stopped': 'Vérification arrêtée : {reason}.',
  'security.verify.stoppedByYou': 'La vérification s’est arrêtée parce que les images ne correspondaient pas. Cet appareil reste non vérifié.',
  'security.verify.titlePeer': 'Vérifier {name}',
  'security.verify.titleSelf': 'Vérifier votre autre appareil',
  'security.verify.waitingButton': 'En attente',
  'security.verify.waitingPeer': 'En attente que {name} ouvre Telium…',
  'security.verify.waitingSelf': 'En attente de votre autre appareil…',

  // ---- settings
  'settings.lookups.hover.description': 'Les amis en commun sont prêts dès qu’une fiche s’ouvre. Faire glisser le pointeur le long d’une liste de membres interroge chaque nom sur lequel il s’arrête, y compris ceux que vous n’aviez aucune intention d’ouvrir.',
  'settings.lookups.hover.label': 'Chaque fois que je pointe un nom',
  'settings.lookups.never.description': 'Aucun serveur n’est jamais interrogé. Les profils cessent d’afficher les amis et les espaces que vous avez en commun, y compris pour des personnes que vous connaissez depuis des années.',
  'settings.lookups.never.label': 'Jamais',
  'settings.lookups.off.body': 'Les recherches de profil sont réglées sur « ne jamais demander » ; rien ici n’a donc été vérifié. Cela ne signifie pas que vous n’avez rien en commun.',
  'settings.lookups.off.friendsTitle': 'Non recherché',
  'settings.lookups.off.guildsTitle': 'Non recherché',
  'settings.lookups.open.description': 'Rien n’est demandé tant que vous ne faites que lire des noms. Ouvrir un profil interroge cette seule personne, et la réponse se remplit un instant après la fiche.',
  'settings.lookups.open.label': 'Quand j’ouvre le profil de quelqu’un',
  'settings.lookups.title': 'Quand rechercher ce que vous avez en commun',
  'settings.messages.dateFormat.dmy': 'JJ/MM/AA',
  'settings.messages.dateFormat.hint': 'Les messages d’un autre jour que le jour même affichent leur date à côté de l’heure. Ceci détermine si le mois ou le jour vient en premier.',
  'settings.messages.dateFormat.label': 'Format de date',
  'settings.messages.dateFormat.mdy': 'MM/JJ/AA',
  'settings.nav.recovery': 'Clé de chiffrement',

  // ---- shell
  'shell.a11y.closeMembers': 'Fermer les membres',
  'shell.a11y.closeMenu': 'Fermer le menu',
  'shell.a11y.openChannels': 'Ouvrir les salons',
  'shell.banner.cached': 'Affichage de votre dernier état depuis {when}. Reconnexion…',
  'shell.banner.reload': 'Recharger Telium',
  'shell.banner.retryHome': 'Réessayer {domain} maintenant',
  'shell.banner.signIn': 'Se reconnecter',
  'shell.banner.wake': 'Réessayer maintenant',
  'shell.empty.body': 'Choisissez un salon pour commencer.',
  'shell.empty.title': 'Aucun salon ouvert',
  'shell.fallback.lagHours': '{count, plural, one {# heure de retard} many {# d’heures de retard} other {# heures de retard}}',
  'shell.fallback.lagMinutes': '{count, plural, one {# minute de retard} many {# de minutes de retard} other {# minutes de retard}}',
  'shell.fallback.lagSeconds': '{count, plural, one {# seconde de retard} many {# de secondes de retard} other {# secondes de retard}}',
  'shell.fallback.lagUnknown': 'ancienneté inconnue',
  'shell.fallback.promoted': '{home} est désormais servi par {standby}. Tout fonctionne normalement.',
  'shell.fallback.readOnly': '{home} ne répond pas. Affichage d’une copie en lecture seule provenant de {standby}, {lag}.',
  'shell.members.search': 'Rechercher des membres',
  'shell.socket.guildDown': '{name} ne répond pas. Le reste de Telium fonctionne normalement. Telium continue de réessayer ; si cela dure, la personne à qui demander est l’exploitant de ce serveur.',
  'shell.socket.homeDown': '{name} est le serveur de votre compte et il ne répond pas. Les messages que vous envoyez n’iront nulle part tant qu’il ne sera pas revenu. Telium continue de réessayer ; si cela dure, la personne à qui demander est celle qui exploite {name}.',
  'shell.socket.incompatible': '{name} parle une version de Telium que ce client ne connaît pas. Mettez Telium à jour et réessayez.',
  'shell.socket.malformed': '{name} n’a pas compris ce que ce client lui a envoyé. Rechargez Telium ; si cela se reproduit, ce client et ce serveur ne sont plus synchronisés.',
  'shell.socket.offline': 'Cet appareil est hors ligne. Telium reprendra là où il s’est arrêté dès que la connexion sera rétablie.',
  'shell.socket.reconnecting': '{role, select, home {Reconnexion à {name}.} other {Reconnexion à {name}. Les autres serveurs ne sont pas affectés.}}',
  'shell.socket.restarting': '{name} redémarre. Cela reviendra tout seul.',
  'shell.socket.sessionRefused': '{role, select, home {{name} ne reconnaît plus cette session. Reconnectez-vous pour continuer.} other {{name} ne reconnaît plus cette session. Reconnectez-vous-y ; le reste de Telium n’est pas affecté.}}',
  'shell.socket.unnamedServer': 'ce serveur',
  'shell.tabs.forum': 'Publications du forum',
  'shell.tabs.pinned': 'Messages épinglés',
  'shell.title.guild': 'Guilde',

  // ---- updates
  'updates.action.install': 'Installer et redémarrer',
  'updates.action.later': 'Plus tard',
  'updates.action.page': 'Ce qui a changé',
  'updates.action.reload': 'Recharger',
  'updates.action.restart': 'Redémarrer',
  'updates.action.store': 'Ouvrir la boutique',
  'updates.available': 'Telium {version} est disponible.',
  'updates.blocked.artifact': 'Cette version ne propose pas de téléchargement pour cette plateforme.',
  'updates.blocked.package': 'Cette version est installée par votre système ; mettez-la à jour de la façon dont vous l’avez installée.',
  'updates.footer.checking': 'Recherche de mises à jour…',
  'updates.footer.current': 'À jour.',
  'updates.footer.forged': 'Les informations de mise à jour ne portaient pas de signature valide et ont été refusées.',
  'updates.footer.unkeyed': 'Cette version n’a pas d’éditeur de mises à jour configuré ; elle ne vérifiera donc pas les mises à jour.',
  'updates.footer.unreachable': 'Impossible de joindre l’éditeur de mises à jour.',
  'updates.incompatible': 'Cette copie de Telium est trop ancienne pour se connecter. La mettre à jour résoudra le problème.',
  'updates.security': 'L’une des versions que vous avez manquées corrige un problème de sécurité.',
  'updates.state.downloading': 'Téléchargement de Telium {version}…',
  'updates.state.failed': 'Cette mise à jour n’a pas pu être installée. Téléchargez-la vous-même à la place.',
  'updates.state.ready': 'Telium {version} est prêt. Redémarrez pour l’utiliser.',
  'updates.state.verifying': 'Vérification de la signature…',

  // ---- voice
  'voice.bar.channel': 'Vocal',
  'voice.bar.connected': 'Vocal connecté',
  'voice.bar.connecting': 'Connexion…',
  'voice.bar.deafen': '{state, select, serverDeafened {Son coupé par le serveur} undeafen {Réactiver le son} other {Couper le son}}',
  'voice.bar.directMessage': 'Message privé',
  'voice.bar.disconnect': 'Se déconnecter',
  'voice.bar.measuring': 'Mesure',
  'voice.bar.mic': '{state, select, serverMuted {Micro coupé par le serveur} muted {Micro coupé} unmute {Réactiver le micro} other {Couper le micro}}',
  'voice.bar.ping': '{ms} ms',
  'voice.bar.pingAvg': 'Moyenne',
  'voice.bar.pingHistory': 'Historique du ping',
  'voice.bar.pingLast': 'Dernier ping',
  'voice.bar.shareStart': 'Partager l’écran',
  'voice.bar.shareStop': 'Arrêter le partage',
  'voice.bar.toolbar': 'Commandes vocales',
  'voice.bar.videoStart': 'Allumer la caméra',
  'voice.bar.videoStop': 'Éteindre la caméra',
  'voice.call.cameraRefused': '{reason, select, androidDenied {L’autorisation d’accès à la caméra a été refusée. Accordez la caméra à Telium dans les paramètres d’application d’Android.} denied {L’autorisation d’accès à la caméra a été refusée. Accordez-la dans les autorisations de site de votre navigateur.} missing {Aucune caméra n’a été trouvée sur cet appareil.} other {La caméra n’a pas pu être ouverte.}}',
  'voice.call.moved': '{mode, select, sfu {L’appel est passé sur un SFU.} other {L’appel est passé à des connexions directes.}}',
  'voice.call.movedRegion': 'Le vocal est passé dans la région {region}.',
  'voice.call.movedTo': 'Déplacé vers {channel}.',
  'voice.call.noAlternateCamera': 'Cet appareil n’a pas d’autre caméra vers laquelle basculer.',
  'voice.call.noCameraSupport': 'Cet appel ne peut pas transporter de vidéo.',
  'voice.call.noFlipSupport': 'Cet appel ne peut pas changer de caméra.',
  'voice.call.noKeys': 'Cette conversation n’a pas encore de clés d’appel, l’appel ne peut donc pas être scellé.',
  'voice.call.noMic': '{reason, select, androidDenied {L’autorisation d’accès au microphone a été refusée. Accordez le microphone à Telium dans les paramètres d’application d’Android ; vous pouvez entendre l’appel mais pas y parler.} denied {L’autorisation d’accès au microphone a été refusée. Accordez-la dans les autorisations de site de votre navigateur ; vous pouvez entendre l’appel mais pas y parler.} missing {Aucun microphone n’a été trouvé sur cet appareil ; vous pouvez entendre l’appel mais pas y parler.} other {Le microphone n’a pas pu être ouvert ; vous pouvez entendre l’appel mais pas y parler.}}',
  'voice.call.noScreenShareSupport': 'Cet appel ne peut pas transporter de partage d’écran.',
  'voice.call.removed': 'Vous avez été retiré du salon vocal',
  'voice.call.sfuAddressUnknown': 'Cette conversation n’indique pas quel SFU appeler.',
  'voice.call.sfuNotEncrypted': 'Ce serveur n’a proposé aucun appel chiffré de bout en bout, la connexion n’a donc pas été établie.',
  'voice.call.shareStoppedOnMove': 'Votre partage d’écran s’est arrêté lorsque l’appel a été déplacé.',
  'voice.call.someVoiceChannel': 'un autre salon vocal',
  'voice.chat.label': 'Discussion',
  'voice.chat.toggle': '{open, select, yes {Fermer la discussion} other {Ouvrir la discussion}}',
  'voice.chat.toggleMentions': '{open, select, yes {Fermer la discussion} other {Ouvrir la discussion}}, {count, plural, one {# mention} many {# de mentions} other {# mentions}}',
  'voice.chat.toggleUnread': '{open, select, yes {Fermer la discussion} other {Ouvrir la discussion}}, non lues',
  'voice.devices.defaultMic': 'Défaut du système',
  'voice.devices.defaultSpeakers': 'Défaut du système',
  'voice.devices.input': 'Microphone',
  'voice.devices.micPublishFailed': 'L’appel n’a pas publié le nouveau microphone.',
  'voice.devices.micSwitchUnsupported': 'Cet appel ne peut pas changer de microphone pendant qu’il est en cours.',
  'voice.devices.noise': 'Réduction du bruit',
  'voice.devices.noiseBrowser': 'Navigateur',
  'voice.devices.noiseNeural': '{state, select, measuring {Neural (mesure…)} other {Neural}}',
  'voice.devices.noiseOff': 'Désactivée',
  'voice.devices.noSinkId': 'Ce navigateur ne peut pas choisir de sortie ; il suit le système.',
  'voice.devices.open': 'Choisir le microphone et la sortie',
  'voice.devices.output': 'Sortie',
  'voice.devices.refreshing': 'Actualisation…',
  'voice.devices.subtitle': 'Ce que cet appel écoute, et où il diffuse.',
  'voice.devices.title': 'Périphériques audio',
  'voice.devices.unnamedMic': 'Microphone {n} ({id})',
  'voice.devices.unnamedOutput': 'Sortie {n} ({id})',
  'voice.dock.camera': '{on, select, yes {Éteindre la caméra} other {Allumer la caméra}}',
  'voice.dock.deafen': '{deafened, select, yes {Réactiver le son} other {Couper le son}}',
  'voice.dock.disconnect': 'Se déconnecter',
  'voice.dock.flip': '{facing, select, environment {Passer à la caméra frontale} other {Passer à la caméra arrière}}',
  'voice.dock.mic': '{muted, select, yes {Réactiver le micro} other {Couper le micro}}',
  'voice.dock.share': '{on, select, yes {Arrêter le partage} other {Partager l’écran}}',
  'voice.dock.watch': '{on, select, yes {Arrêter le visionnage ensemble} other {Regarder ensemble}}',
  'voice.error.cameraOff': 'Impossible d’éteindre la caméra',
  'voice.error.cameraOn': 'Impossible d’allumer la caméra',
  'voice.error.flipCamera': 'Impossible de changer de caméra',
  'voice.error.followRegion': 'Impossible de suivre l’appel vers sa nouvelle région',
  'voice.error.followServer': 'Impossible de suivre l’appel vers son nouveau serveur',
  'voice.error.fullscreen': 'Impossible de passer en plein écran',
  'voice.error.join': 'Impossible de rejoindre l’appel',
  'voice.error.leave': 'Impossible de quitter proprement l’appel',
  'voice.error.listDevices': 'Impossible de lister les périphériques audio',
  'voice.error.noiseChange': 'Impossible de modifier la réduction du bruit',
  'voice.error.noiseModel': 'Impossible de vérifier le modèle neuronal',
  'voice.error.pip': 'Impossible de détacher la vidéo',
  'voice.error.readRoutes': 'Impossible de lire les sorties audio',
  'voice.error.rekey': 'Impossible de renouveler les clés de l’appel',
  'voice.error.rejoin': 'Impossible de revenir dans l’appel',
  'voice.error.resumeAudio': 'Impossible de démarrer l’audio de l’appel',
  'voice.error.shareScreen': 'Impossible de partager l’écran',
  'voice.error.stopStream': 'Impossible d’arrêter le partage d’écran',
  'voice.error.streamState': 'Impossible de mettre à jour le partage d’écran',
  'voice.error.switchMic': 'Impossible de changer de microphone',
  'voice.error.switchOutput': 'Impossible de changer de sortie',
  'voice.error.trouble': 'L’appel a rencontré un problème',
  'voice.error.voiceState': 'Impossible de mettre à jour votre état vocal',
  'voice.incoming.answer': '{named, select, yes {Répondre à l’appel de {caller}} other {Répondre à l’appel}}',
  'voice.incoming.decline': '{named, select, yes {Refuser l’appel de {caller}} other {Refuser l’appel}}',
  'voice.incoming.fromWho': '{named, select, yes {Appel de {caller}} other {Appel entrant}}',
  'voice.incoming.groupSize': '{count, plural, one {Appel de groupe · # personne} many {Appel de groupe · # de personnes} other {Appel de groupe · # personnes}}',
  'voice.incoming.joinFailed': 'Impossible de répondre à l’appel',
  'voice.incoming.title': 'Appel entrant',
  'voice.log.cancel': 'Annuler',
  'voice.log.ended': 'Appel terminé',
  'voice.log.endedDuration': 'Appel terminé · {duration}',
  'voice.log.incoming': 'Appel entrant',
  'voice.log.missed': 'Appel manqué',
  'voice.log.outgoing': 'Appel sortant',
  'voice.log.ringing': 'Sonnerie…',
  'voice.log.ringingHint': 'En attente que la personne décroche.',
  'voice.media.cameraMine': 'Votre caméra',
  'voice.media.cameraOther': '{who} — caméra',
  'voice.media.screenMine': 'Votre écran',
  'voice.media.screenOther': '{who} — écran',
  'voice.mini.call': 'Appel',
  'voice.mini.expand': 'Agrandir l’appel',
  'voice.mini.hide': 'Masquer',
  'voice.mini.next': 'Suivant',
  'voice.mini.region': 'Vue réduite de l’appel',
  'voice.noise.cannot': 'Cet appareil ne peut pas exécuter le modèle neuronal.',
  'voice.noise.fellBack': 'Le modèle neuronal n’a pas pu suivre, cet appel est donc passé à la réduction de bruit du navigateur.',
  'voice.noise.reason.insecure-context': 'Le traitement audio nécessite une connexion sécurisée (https).',
  'voice.noise.reason.load-failed': 'Le modèle neuronal n’a pas pu être chargé.',
  'voice.noise.reason.no-48k': 'Le matériel audio de cet appareil ne fonctionne pas à 48 kHz.',
  'voice.noise.reason.no-audio-context': 'Ce navigateur n’expose pas l’API Web Audio.',
  'voice.noise.reason.no-audio-worklet': 'Ce navigateur ne peut pas exécuter le traitement audio hors du fil principal.',
  'voice.noise.reason.no-measurement': 'Le modèle neuronal n’a pas pu être mesuré.',
  'voice.noise.reason.no-wasm': 'Ce navigateur ne veut pas exécuter WebAssembly sur cette page.',
  'voice.noise.reason.one-core': 'Cet appareil a trop peu de cœurs de processeur pour en réserver un au modèle.',
  'voice.noise.reason.too-slow': 'Cet appareil n’est pas assez rapide pour exécuter le modèle en temps réel.',
  'voice.preset.detail': 'Détail',
  'voice.preset.live': 'Direct',
  'voice.preset.motion': 'Mouvement',
  'voice.quality.auto': 'Auto',
  'voice.quality.high': 'Haute',
  'voice.quality.label': 'Qualité du flux',
  'voice.quality.low': 'Basse',
  'voice.quality.medium': 'Moyenne',
  'voice.refusal.nothing': 'Il n’y a aucun serveur vocal à appeler.',
  'voice.refusal.relay': 'Votre confidentialité d’appel exige au moins un relais, et cet appel n’offre ni relais ni SFU.',
  'voice.refusal.sfu': 'Votre confidentialité d’appel exige un SFU, et cet appel n’en a aucun.',
  'voice.region.auto': 'Automatique',
  'voice.region.autoHint': 'Laisser le serveur choisir la région saine la plus proche.',
  'voice.region.loading': 'Chargement des régions',
  'voice.region.none': 'Ce serveur ne publie aucune région vocale.',
  'voice.region.subtitle': 'Où cet appel est transporté. Plus proche signifie généralement plus silencieux.',
  'voice.region.title': 'Région vocale',
  'voice.region.unhealthy': 'N’accepte pas d’appels pour l’instant.',
  'voice.room.chatTitle': 'Discussion du salon',
  'voice.room.empty': 'Personne ici',
  'voice.room.emptyBody': 'Rejoignez pour l’ouvrir.',
  'voice.room.goneBody': 'Il a été supprimé, ou vous ne pouvez plus le voir.',
  'voice.room.goneTitle': 'Ce salon vocal a disparu',
  'voice.room.inVoice': '{count, plural, one {# en vocal} many {# de personnes en vocal} other {# en vocal}}',
  'voice.room.joinHint': 'Ouvre votre microphone.',
  'voice.room.minimize': 'Réduire',
  'voice.room.more': '+{count}',
  'voice.room.qualityFailed': 'Impossible de modifier la qualité du flux',
  'voice.room.readFailed': 'Impossible de lire qui regarde',
  'voice.room.staleHint': 'Rien dans cet onglet n’est connecté. Rejoignez de nouveau, ou déconnectez-vous pour effacer.',
  'voice.room.unwatchFailed': 'Impossible d’arrêter de regarder',
  'voice.room.watchFailed': 'Impossible de commencer à regarder',
  'voice.room.watching': '{count, plural, one {# personne qui regarde} many {# de personnes qui regardent} other {# personnes qui regardent}}',
  'voice.route.automatic': 'Automatique',
  'voice.route.finding': 'Recherche des sorties…',
  'voice.route.option': '{state, select, selected {✓ {label}} other {{label}}}',
  'voice.route.title': 'Sortie audio',
  'voice.route.unsupported': 'Cet appareil ne propose pas de sélecteur de sortie.',
  'voice.screen.fullscreen': 'Plein écran',
  'voice.screen.label': '{mine, select, yes {Votre écran} other {{who} — écran}}',
  'voice.screen.noFullscreen': 'Ce navigateur ne passera pas en plein écran.',
  'voice.screen.noPip': 'Ce navigateur ne peut pas détacher de vidéo.',
  'voice.screen.noScreen': 'Il n’y a aucun écran à afficher.',
  'voice.screen.noVideo': 'Il n’y a aucune vidéo à détacher.',
  'voice.screen.resetZoom': 'Réinitialiser le zoom',
  'voice.screen.stopSharing': 'Arrêter le partage',
  'voice.share.audio': 'Partager aussi le son',
  'voice.share.audioUnlikely': 'Ce navigateur peut prendre le son d’un onglet, mais pas d’un écran ou d’une fenêtre entiers.',
  'voice.share.choose': 'Choisir quoi partager',
  'voice.share.content.detail.description': 'Texte net. Moins d’images par seconde, chaque pixel conservé.',
  'voice.share.content.detail.label': 'Un document ou du code',
  'voice.share.content.motion.description': 'Mouvement fluide. S’adoucit avant de saccader quand le lien se tend.',
  'voice.share.content.motion.label': 'Un jeu ou une vidéo',
  'voice.share.contentLabel': 'Ce que vous partagez',
  'voice.share.desktopAudioFailed': 'Impossible de partager le son du bureau : {reason}',
  'voice.share.frameRate': 'Images par seconde',
  'voice.share.noCapture': 'Ce navigateur ne peut pas capturer le son de ce que vous partagez.',
  'voice.share.pickTabAudio': 'Aucun son n’est venu avec cela. Choisissez un onglet et cochez « Partager l’audio de l’onglet » pour l’emporter.',
  'voice.share.quality': 'Qualité',
  'voice.share.resolution': 'Résolution',
  'voice.share.summary': '{quality} · {fps} fps',
  'voice.share.title': 'Partager votre écran',
  'voice.stage.audioBlocked': 'Votre navigateur retient l’audio de cet appel jusqu’à ce que vous interagissiez avec la page.',
  'voice.stage.cameraName': '{mine, select, yes {Votre caméra} other {{who}}}',
  'voice.stage.controls': 'Commandes d’appel',
  'voice.stage.emptyTitle': 'Personne n’est encore là',
  'voice.stage.join': 'Rejoindre le vocal',
  'voice.stage.newShare': 'Nouveau',
  'voice.stage.rejoin': 'Rejoindre de nouveau',
  'voice.stage.resumeAudio': 'Lire l’audio',
  'voice.stage.sealedNotice': 'Cet appel est chiffré de bout en bout. Le serveur le transporte sans pouvoir l’entendre.',
  'voice.stage.shareName': '{mine, select, yes {Votre écran} other {{who}}}',
  'voice.status.clear': 'Effacer',
  'voice.status.clearFailed': 'Impossible d’effacer le statut vocal',
  'voice.status.edit': 'Modifier le statut vocal',
  'voice.status.hint': '{count} sur {max} caractères',
  'voice.status.label': 'Statut vocal',
  'voice.status.placeholder': 'Que fait cette salle en ce moment ?',
  'voice.status.save': 'Enregistrer le statut',
  'voice.status.saveFailed': 'Impossible de définir le statut vocal',
  'voice.status.set': 'Définir le statut vocal',
  'voice.status.tooLong': 'Gardez-le sous {max} caractères.',
  'voice.tile.camera': 'Caméra allumée',
  'voice.tile.cameraLabel': '{mine, select, yes {Votre caméra} other {{who} — caméra}}',
  'voice.tile.collapse': '{mine, select, yes {Ramener votre vidéo dans la grille} other {Ramener {who} dans la grille}}',
  'voice.tile.deafened': 'Son coupé',
  'voice.tile.expand': '{mine, select, yes {Agrandir votre vidéo} other {Développer {who} — vidéo}}',
  'voice.tile.more': 'Plus',
  'voice.tile.muted': 'Micro coupé',
  'voice.tile.noMic': 'Aucun microphone',
  'voice.tile.pip': 'Détacher',
  'voice.tile.screenAudio': 'Audio de l’écran',
  'voice.tile.screenAudioVolume': 'Volume de l’audio de l’écran',
  'voice.tile.screenAudioVolumeFor': '{name} — volume de l’audio d’écran',
  'voice.tile.volume': 'Volume',
  'voice.tile.watchGate': '{state, select, stop {Arrêter} stopWatching {Arrêter de regarder} other {Regarder}}',
  'voice.tile.yourPick': 'Votre choix',
  'voice.watch.aVideo': 'une vidéo',
  'voice.watch.connects': 'La lecture depuis <b>{provider}</b> connecte ce navigateur à <b>{host}</b>.',
  'voice.watch.connectTo': 'Se connecter à {host}',
  'voice.watch.consentHost': 'Cela connecte votre navigateur à <b>{host}</b>.',
  'voice.watch.elapsedOf': '{at} / {duration}',
  'voice.watch.end': 'Terminer pour tout le monde',
  'voice.watch.gaveUpWaiting': 'Quelqu’un est encore en train de mettre en mémoire tampon, la lecture a donc continué sans cette personne.',
  'voice.watch.leave': 'Quitter',
  'voice.watch.noEmbeds': 'Cette version n’a aucun fournisseur de visionnage, et les fichiers directs sont désactivés.',
  'voice.watch.noteFile': 'Chaque personne récupère le fichier elle-même, depuis l’endroit où il est hébergé.',
  'voice.watch.noteFrame': 'Le lecteur s’exécute dans un cadre de {provider}, qui voit ce navigateur à peu près comme s’il l’ouvrait dans un onglet.',
  'voice.watch.notNow': 'Pas maintenant',
  'voice.watch.opening': 'Ouverture de {provider}…',
  'voice.watch.orFile': 'un fichier vidéo direct',
  'voice.watch.pauseAll': 'Mettre en pause pour tout le monde',
  'voice.watch.playAll': 'Lire pour tout le monde',
  'voice.watch.position': 'Position',
  'voice.watch.proxyNote': 'Telium ne le met pas en proxy. La connexion est la vôtre.',
  'voice.watch.rate': '{rate}×',
  'voice.watch.relayed': 'La position et le bouton de lecture passent par le relais de Telium, qui peut les lire.',
  'voice.watch.relayedConsent': 'La position et le bouton de lecture sont relayés par Telium, qui peut les lire.',
  'voice.watch.sealed': 'Seule la position et le bouton de lecture passent par Telium, et ils sont scellés de bout en bout.',
  'voice.watch.sealedLabel': 'Scellé de bout en bout',
  'voice.watch.speed': 'Vitesse',
  'voice.watch.start': 'Démarrer',
  'voice.watch.started': '{who} a lancé {what}',
  'voice.watch.startFailed': 'Impossible de commencer à regarder ensemble',
  'voice.watch.subtitle': 'Chacun le lance soi-même, en cadence avec les autres.',
  'voice.watch.thePlayer': 'le lecteur',
  'voice.watch.title': 'Regarder ensemble',
  'voice.watch.unplayable': 'Ce lien ne peut pas être lu ici.',
  'voice.watch.unsyncable': 'Ce lien ne peut pas être maintenu en cadence.',
  'voice.watch.unsyncableInstead': 'Partagez plutôt votre écran, et lancez-le vous-même.',
  'voice.watch.unsyncableWhy': 'Telium ne peut piloter que les lecteurs avec lesquels il sait parler, et celui-ci n’en fait pas partie.',
  'voice.watch.url': 'Lien',
  'voice.watch.urlPlaceholder': 'Collez un lien',
  'voice.watch.waitingFor': 'En attente de {who}',
  'voice.watch.waitingForMany': '{count, plural, one {En attente de # personne} many {En attente de # de personnes} other {En attente de # personnes}}',
  'voice.watch.you': 'Vous',


  'settings.media.sectionTitle': 'Où vont vos envois',
  'settings.media.followsAccount': 'Ce choix suit votre compte sur chaque appareil.',
  'settings.media.tier1': 'Ce serveur',
  'settings.media.tier1Desc': 'Par défaut. Rien à régler.',
  'settings.media.tier2': 'Un autre serveur Telium',
  'settings.media.tier2Desc': 'Les fichiers vont vers un autre serveur Telium de votre choix.',
  'settings.media.tier3': 'Un autre hébergeur',
  'settings.media.tier3Desc': 'Les fichiers vont vers un tiers tel que Gofile. Ces fichiers sont des URL publiques.',
  'settings.media.usage': '{used} sur {quota} utilisés sur {home}.',
  'settings.media.usageWarn': '{used} sur {quota} utilisés sur {home}. Supprimez de vos messages les fichiers dont vous ne voulez plus, ou déplacez vos envois vers un autre hébergeur.',
  'settings.media.savedToast': 'Hébergeur d’envoi enregistré.',
  'settings.media.saveFailed': 'Impossible d’enregistrer l’hébergeur d’envoi',
  'settings.media.hostLabel': 'Hébergeur de médias',
  'settings.media.hostsRecommended': 'Hébergeurs recommandés. N’importe quelle origine de médias Telium convient.',
  'settings.media.hostsNone': 'Ce serveur ne recommande aucun hébergeur. Nommez-en un vous-même.',
  'settings.media.anotherHost': 'Un autre hébergeur…',
  'settings.media.originLabel': 'Origine',
  'settings.media.originHint': 'Un domaine, pas une URL.',
  'settings.media.externalEnabled': 'Hébergeurs externes activés',
  'settings.media.externalNone': 'Ce serveur n’a activé aucun hébergeur d’envoi externe.',
  'settings.media.upTo': 'Jusqu’à {size} par fichier.',
  'settings.media.abuseContact': 'Contact abus : {contact}.',
  'settings.media.vouchedBy': 'Garanti par {names}.',
  'settings.media.via': '{name} - via {names}',
};
