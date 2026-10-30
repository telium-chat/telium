// العربية.
//
// The right-to-left catalogue, the one with six plural categories, and a
// complete one: every English key has an Arabic sentence here, so nothing
// falls back to English. The body was written by hand; the block near the end
// headed "added to reach 100%" is a machine-assisted draft no human has read,
// which is why this language carries no stamps in `catalog/stamps.json`. Note
// that direction is a property of the document and not of the string, so even
// a key that did fall back to English would still be laid out right-to-left.
//
// ------------------------------------------------------ the two hard parts
//
// **Direction.** `dir="rtl"` on `<html>` (set by `applyDocument` in
// `locale.js`) flips the whole layout: the sidebar moves to the right, text
// aligns to the right, and every logical CSS property follows. Every *physical*
// one does not -- `margin-left` stays on the left in Arabic, which is how an
// avatar ends up overlapping the name beside it. What is left to convert is
// listed in `docs/translating.md` under "Right-to-left"; where this branch
// touched CSS it converted, and `src/test/i18n-layout.test.jsx` pins the
// direction switch itself.
//
// **Six plural categories.** `zero`, `one`, `two`, `few`, `many`, `other`, and
// they are not a formality: Arabic genuinely inflects differently for 2, for
// 3-10, and for 11-99, and a pattern written with `one`/`other` will show the
// wrong noun for most numbers a real app displays. Every count in this file
// carries all six arms. Where two arms are identical they are still written
// out, because "identical today" is a fact about the sentence and not about
// the language, and the next translator to edit the sentence needs the arm to
// be there.
//
// ------------------------------------------------------------- conventions
//
//   * **Modern Standard Arabic**, no dialect. It is the only register every
//     reader shares.
//   * **Arabic-Indic digits are `Intl`'s business, not this file's.** A number
//     in a pattern goes through `{n, number}` and comes out as ٤٢ because the
//     `ar` locale says so. A digit typed literally into a string here would be
//     the wrong one half the time and would not follow a change of numbering
//     system.
//   * **Interpolated names are isolated automatically** -- see `isolate` in
//     `lib/i18n/index.js` -- so a Latin display name inside these sentences
//     does not drag the punctuation to the wrong end. Nothing here needs to
//     add the marks by hand, and nothing here should.

export const messages = {
  'format.justNow': 'الآن',
  // The unit stays Latin. Arabic technical writing overwhelmingly uses the
  // Latin abbreviations for data units, and the isolating done around a
  // `{value}` keeps the number and the unit in the right order.
  'format.bytes.b': '{value} B',
  'format.bytes.kb': '{value} KB',
  'format.bytes.mb': '{value} MB',
  'format.bytes.gb': '{value} GB',
  'format.bytes.tb': '{value} TB',

  'common.cancel': 'إلغاء',
  'common.close': 'إغلاق',
  'common.back': 'رجوع',
  'common.next': 'التالي',
  'common.done': 'تم',
  'common.save': 'حفظ',
  'common.saving': 'جارٍ الحفظ…',
  'common.saved': 'تم الحفظ',
  'common.confirm': 'تأكيد',
  'common.continue': 'متابعة',
  'common.copy': 'نسخ',
  'common.copied': 'تم النسخ',
  'common.copiedThing': 'تم نسخ {what}.',
  'common.clipboardFailed': 'تعذّر الوصول إلى الحافظة.',
  'common.delete': 'حذف',
  'common.remove': 'إزالة',
  'common.retry': 'إعادة المحاولة',
  'common.refresh': 'تحديث',
  'common.edit': 'تعديل',
  'common.download': 'تنزيل',
  'common.dismiss': 'تجاهل',
  'common.learnMore': 'معرفة المزيد',
  'common.showMore': 'عرض المزيد',
  'common.showLess': 'عرض أقل',
  'common.search': 'بحث',
  'common.loading': 'جارٍ التحميل…',
  'common.enable': 'تفعيل',
  'common.disable': 'تعطيل',
  'common.on': 'مفعّل',
  'common.off': 'معطّل',
  'common.yes': 'نعم',
  'common.no': 'لا',
  'common.none': 'لا شيء',
  'common.never': 'أبدًا',
  'common.unknown': 'غير معروف',
  'common.optional': 'اختياري',
  'common.required': 'مطلوب',
  'common.empty': '—',

  'common.a11y.close': 'إغلاق',
  'common.a11y.back': 'الرجوع',
  'common.a11y.menu': 'إجراءات أخرى',
  'common.a11y.dismissNotice': 'تجاهل هذا التنبيه',
  'common.a11y.copyToClipboard': 'نسخ إلى الحافظة',
  'common.a11y.showPassword': 'إظهار كلمة المرور',
  'common.a11y.hidePassword': 'إخفاء كلمة المرور',
  'common.a11y.loading': 'جارٍ التحميل',
  'common.a11y.stepDone': '{step} — تم',

  'common.homeserver': 'الخادم الرئيسي',
  'common.username': 'اسم المستخدم',
  'common.password': 'كلمة المرور',
  'common.email': 'البريد الإلكتروني',
  'common.account': 'الحساب',
  'common.device': 'الجهاز',
  'common.settings': 'الإعدادات',

  // All six arms. Note that the noun changes shape three times and that the
  // number moves out of the sentence entirely in the `two` arm, which is the
  // single clearest demonstration of why a count may never be concatenated on
  // to a translated noun.
  'common.convo.group': '{count, plural, zero {مجموعة - لا أحد} one {مجموعة - شخص واحد} two {مجموعة - شخصان} few {مجموعة - # أشخاص} many {مجموعة - # شخصًا} other {مجموعة - # شخص}}',

  'common.activity.playing': 'يلعب',
  'common.activity.streaming': 'يبث',
  'common.activity.listening': 'يستمع إلى',
  'common.activity.watching': 'يشاهد',
  'common.activity.competing': 'يتنافس في',
  'common.activity.line': '{verb} {name}',

  'errors.invalid_credentials': 'اسم المستخدم وكلمة المرور لا يطابقان أي حساب هنا.',
  'errors.account_deactivated': 'هذا الحساب معطّل. سيعاد تنشيطه عند تسجيل الدخول.',
  'errors.mfa_required': 'أدخل الرمز من تطبيق المصادقة.',
  'errors.invalid_mfa_code': 'هذا الرمز غير مطابق. تنتهي صلاحية الرموز بعد نحو دقيقة — جرّب الرمز التالي.',
  'errors.reauth_required': 'أدخل كلمة المرور مرة أخرى من باب الأمان.',
  'errors.registration_closed': 'هذا الخادم لا يقبل حسابات جديدة حاليًا.',
  'errors.username_taken': 'اسم المستخدم هذا مأخوذ على هذا الخادم.',
  'errors.invite_invalid': 'هذه الدعوة لم تعد صالحة. ربما انتهت صلاحيتها أو استُهلكت أو أُلغيت.',
  'errors.missing_permission': 'تحتاج إلى صلاحية «{permission}» للقيام بذلك.',
  'errors.not_a_member': 'لست عضوًا هنا.',
  // `{attempted}` اختيار لا إدراج، كما في الإنجليزية: الأربع حالات أربع جمل
  // كاملة، والعربية تبدأ كلًّا منها بفعل مختلف، فلا يصلح قالب واحد يُحشر فيه
  // المصدر. و`other` شبكة الأمان لخادم أحدث من هذا العميل وجد طريقة خامسة
  // للخروج.
  //
  // `{user_id}` يظهر في حالة `revoke` وحدها: في الحالات الثلاث الأخرى الحساب
  // هو حساب القارئ نفسه، وتسميته في وجهه كلام غريب.
  'errors.last_admin':
    '{attempted, select, ' +
    'deactivate {أنت المدير الوحيد لهذا الخادم الذي يمكنه تسجيل الدخول، وتعطيل حسابك سيترك الخادم بلا من يديره.} ' +
    'delete {أنت المدير الوحيد لهذا الخادم الذي يمكنه تسجيل الدخول، وحذف حسابك سيترك الخادم بلا من يديره.} ' +
    'move {أنت المدير الوحيد لهذا الخادم الذي يمكنه تسجيل الدخول، ونقل حسابك إلى خادم آخر سيترك الخادم بلا من يديره.} ' +
    'revoke {{user_id} هو المدير الوحيد لهذا الخادم الذي يمكنه تسجيل الدخول، وسحب صلاحيته سيترك الخادم بلا من يديره.} ' +
    'other {سيترك ذلك هذا الخادم بلا مدير يمكنه تسجيل الدخول.}} ' +
    'امنح صلاحية إدارة الخادم لحساب آخر يمكنه تسجيل الدخول، ثم أعد المحاولة.',
  'errors.rate_limited': '{retry_after, plural, =0 {تمهّل قليلًا ثم أعد المحاولة.} zero {تمهّل قليلًا ثم أعد المحاولة.} one {تمهّل قليلًا — أعد المحاولة بعد ثانية واحدة.} two {تمهّل قليلًا — أعد المحاولة بعد ثانيتين.} few {تمهّل قليلًا — أعد المحاولة بعد # ثوانٍ.} many {تمهّل قليلًا — أعد المحاولة بعد # ثانية.} other {تمهّل قليلًا — أعد المحاولة بعد # ثانية.}}',
  // الحد جزء من الجملة: «كبير جدًا» وحدها لا تخبر القارئ بما يفعله.
  'errors.too_large': 'هذا الملف كبير جدًا. الحد هنا هو {limit, bytes}.',
  'errors.quota_exceeded': 'لا توجد مساحة — استُخدم {used, bytes} من {limit, bytes}.',
  'errors.context': '{context}: {message}',
  'errors.generic': 'حدث خطأ ما.',
  // «السبب ليس منك» كانت النصف الخاطئ من الرسالة. في خطأ 500 يكون الخادم قد
  // نفّذ الطلب فعلًا ثم تعثّر في منتصفه، ولا أحد في هذا الطرف يعرف إلى أين
  // وصل. وأكثر ما يسبّب 500 هو عملية كتابة، فترك الأمر مفتوحًا هو الأصدق.
  'errors.serverFault': 'واجه الخادم مشكلة في ذلك. قد يكون التنفيذ قد تمّ وقد لا يكون.',
  // جملتان، يفصل بينهما `navigator.onLine`. الأولى لا تتّهم الخادم لأن بوابة
  // الاتصال المقيَّدة تبدو مثلها تمامًا؛ والثانية تسمّي الجهاز لأنه الشيء
  // الوحيد الذي يستطيع القارئ إصلاحه بنفسه.
  'errors.offline': 'تعذّر الوصول إلى الخادم. لم يُرسَل شيء؛ أعد المحاولة بعد قليل.',
  'errors.offlineDevice': 'هذا الجهاز غير متّصل. لم يُرسَل شيء.',

  // ------------------------------------------------ رموز الحالة دون رسالة

  'errors.status.401': 'انتهت صلاحية جلستك. سجّل الدخول من جديد للمتابعة.',
  'errors.status.403': 'لا تملك صلاحية القيام بذلك هنا.',
  'errors.status.404': 'لم يعد ذلك موجودًا.',
  'errors.status.409': 'غيّره شخص آخر قبلك. ألقِ نظرة أخرى ثم أعد المحاولة.',
  'errors.status.413': 'هذا أكبر مما يقبله هذا الخادم.',
  'errors.status.429': 'أنت أسرع مما يحتمله هذا الخادم. انتظر لحظة ثم أعد المحاولة.',
  'errors.status.gateway': 'الخادم لا يستجيب الآن. أعد المحاولة بعد قليل.',

  // -------------------------------------------------------- إغلاق البوّابة

  'errors.gateway.4001': 'تعذّر على Telium بدء جلسة مع هذا الخادم.',
  'errors.gateway.4002': 'لا يتّفق Telium وهذا الخادم على طريقة التخاطب بينهما.',
  'errors.gateway.4004': 'لم يقبل هذا الخادم جلستك. سجّل الدخول من جديد.',
  'errors.gateway.4005': 'هذا الخادم يُعاد تشغيله. جارٍ إعادة الاتصال.',
  'errors.gateway.4008': 'استغرق تسجيل الدخول إلى هذا الخادم وقتًا طويلًا. جارٍ إعادة الاتصال.',
  'errors.gateway.4009': 'انتهت مهلة هذا الاتصال. جارٍ إعادة الاتصال.',
  'errors.gateway.4010': 'تأخّر هذا الاتصال كثيرًا فأُعيد ضبطه. جارٍ اللحاق بما فات.',
  'errors.gateway.4011': 'عدد اتصالات Telium المفتوحة لحسابك كبير جدًا. أغلق أحدها ثم أعد المحاولة.',
  'errors.gateway.4013': 'هذا الخادم مشغول باستقبال الاتصالات. جارٍ الانتظار.',
  'errors.gateway.4015': 'يعمل Telium وهذا الخادم بإصدارين غير متوافقين.',
  'errors.gateway.unknown': 'أُغلق الاتصال بشكل غير متوقّع (الرمز {code}).',

  'perms.group.general': 'عام',
  'perms.group.membership': 'العضوية',
  'perms.group.text': 'القنوات النصية',
  'perms.group.voice': 'القنوات الصوتية',
  'perms.group.advanced': 'متقدّم',

  'settings.theme.title': 'المظهر',
  'settings.theme.description': 'ينتقل معك إلى أجهزتك الأخرى.',
  'settings.theme.preset.graphite.name': 'غرافيت',
  'settings.theme.preset.graphite.description': 'رمادي محايد عميق. الافتراضي.',
  'settings.theme.preset.obsidian.name': 'سبج',
  'settings.theme.preset.obsidian.description': 'أسود حتى البكسل، وشاشة OLED تطفئه تمامًا.',
  'settings.theme.preset.ash.name': 'رماد',
  'settings.theme.preset.ash.description': 'رمادي أدفأ وأفتح لغرفة مضاءة.',
  'settings.theme.preset.midnight.name': 'منتصف الليل',
  'settings.theme.preset.midnight.description': 'بنفسجي في الرمادي، كما كان Telium يبدو من قبل.',
  'settings.theme.preset.evergreen.name': 'دائم الخضرة',
  'settings.theme.preset.evergreen.description': 'داكن، بخضرة ليلة طويلة في الداخل.',
  'settings.theme.preset.paper.name': 'ورق',
  'settings.theme.preset.paper.description': 'أبيض كالورق، لغرفة مضيئة.',
  'settings.theme.custom.label': 'اصنع مظهرك',
  'settings.theme.custom.description': 'بضعة مزالق، والتطبيق يتغيّر تحتها أثناء تحريكها.',

  'settings.language.title': 'اللغة',
  'settings.language.label': 'لغة الواجهة',
  'settings.language.auto': 'استخدام لغة النظام',
  'settings.language.hint': '{state, select, none {الإنجليزية فقط في الوقت الحالي. صُمّم Telium ليُترجم — راجع دليل المترجمين إن أردت المساعدة.} partial {{languages} مترجمة جزئيًا؛ وما لم يُترجم بعد يظهر بالإنجليزية.} other {يتوفّر Telium بـ{languages}.}}',

  'settings.messages.title': 'الرسائل',
  'settings.messages.compact.label': 'رسائل مضغوطة',
  'settings.messages.compact.hint': 'يستبدل المسافة بين الرسائل بعدد أكبر منها على الشاشة.',
  'settings.messages.members.label': 'إظهار قائمة الأعضاء',
  'settings.messages.members.hint': 'قائمة الأعضاء مشتركة ضمن نطاق، لذا فإن إخفاءها يوقف التحديثات أيضًا.',
  'settings.messages.typing.label': 'إرسال مؤشرات الكتابة',
  'settings.messages.typing.hint': 'عند التعطيل لا تُبلَّغ خوادم النقابات أبدًا بأنك بدأت الكتابة.',

  // ---------------------------------------------------------- profile lookups
  //
  // The three answers to "when may this account ask a dozen servers what you
  // have in common with somebody". Labels name the reader's own act, and none
  // of them calls an option safe -- the middle one makes the same disclosure
  // as the loose one whenever it fires. See `catalog/en/settings.js`.
  'settings.lookups.title': 'متى يُبحث عمّا بينكما من قواسم مشتركة',
  'settings.lookups.hover.label': 'كلما أشرت إلى اسم',
  'settings.lookups.hover.description': 'يظهر الأصدقاء المشتركون لحظة فتح البطاقة. وتمرير المؤشّر على قائمة الأعضاء يسأل عن كل اسم يتوقّف عنده، بما في ذلك الأسماء التي لم تكن تنوي فتحها.',
  'settings.lookups.open.label': 'عند فتحي لملف شخصي',
  'settings.lookups.open.description': 'لا يُسأل عن شيء ما دمت تقرأ الأسماء فقط. وفتح ملف شخصي يسأل عن ذلك الشخص وحده، وتظهر الإجابة بعد البطاقة بلحظة.',
  'settings.lookups.never.label': 'أبدًا',
  'settings.lookups.never.description': 'لا يُسأل أي خادم إطلاقًا. ولن تعرض الملفات الشخصية أصدقاء أو مساحات مشتركة، حتى مع أشخاص تعرفهم منذ سنوات.',
  // Not "لا أصدقاء مشتركين": nothing was checked, and asserting the absence
  // would be a claim about a stranger the client never made.
  'settings.lookups.off.friendsTitle': 'لم يُبحث عنه',
  'settings.lookups.off.guildsTitle': 'لم يُبحث عنه',
  'settings.lookups.off.body': 'إعداد استعلامات الملفات الشخصية مضبوط على ألّا يسأل، فلم يُتحقَّق من شيء هنا. وهذا ليس ادّعاءً بأن لا قواسم مشتركة بينكما.',

  // ---------------------------------------------------------------- privacy
  //
  // Who else is on the wire. Translated in full ahead of the rest of the
  // migration, for the reason given at the same heading in the German file: an
  // untranslated privacy warning is a warning that gets skipped. Sources and
  // provenance are in `catalog/en/privacy.js`.
  //
  // Two Arabic-specific notes. `{host}` is a Latin-script hostname dropped into
  // an RTL sentence, so it is placed where the bidi algorithm can only resolve
  // it one way -- between Arabic words, never adjacent to the punctuation that
  // ends the clause, which is where a neutral run would flip. And «Invisible»
  // keeps its English spelling because the status row it annotates is still
  // English; it is quoted with guillemets rather than transliterated so that it
  // reads as the name of a control rather than as a word.
  'privacy.presence.invisible': '«Invisible» هو ما يُقال لكل شخص آخر. أما خادمك الرئيسي فما زال يرى هذا الاتصال ويُحصي الأجهزة التي سجّلت الدخول منها.',
  'privacy.block.body': 'سيرون أن الصداقة انتهت، ولن يصلك منهم شيء بعد ذلك — لا طلب ولا رسالة ولا إشعار، ولن يُقال لهم أيٌّ منها توقّف. غير أن ذلك لا يمنعهم من الإرسال: خادمك الرئيسي يظلّ يستقبل رسائلهم ويخزّنها، والمحادثة تبدو عندهم عادية تمامًا.',
  'privacy.gif.head': 'هذه المحادثة مُعمّاة. أما الصورة المتحركة فلا.',
  'privacy.gif.body': 'جهازك يطلب هذه النتائج من {host} ويجلب منهم مباشرةً كل ما ترسله، فيرون عنوانك وأي صورة اخترت. لا يمرّ شيء من ذلك عبر خادمك الرئيسي، ولا يوجد إعداد يوقفه.',
  'privacy.typing.inEncrypted': 'مؤشرات الكتابة هي الاستثناء: تخرج بلا تعمية، فيراها خادمك وخوادم الجميع وكل من في المحادثة لحظة حدوثها. يمكن إيقافها من «إشارات المحادثة».',
  // The fan-out behind the mutual-friends chips, drawn under all three options
  // on the Profile lookups pane. «سؤالًا موقَّعًا واحدًا لكل منها» is
  // load-bearing: one peer per *domain*, all of them, including the ones with
  // nothing to say. What travels is the question, never the friend list.
  'privacy.lookups.head': 'معرفة ما بينك وبين شخص من قواسم مشتركة سؤال يطرحه هذا الحساب بصوت مسموع.',
  'privacy.lookups.party.home': 'خادمك الرئيسي',
  'privacy.lookups.sees.home': 'أنك بحثت، وعمّن. قائمة أصدقائك لديه أصلًا، فلا يضيف الاستعلام سوى التوقيت.',
  'privacy.lookups.party.friendHosts': 'كل خادم يستضيف صديقًا لك',
  'privacy.lookups.sees.friendHosts': 'سؤالًا موقَّعًا واحدًا لكل منها، يذكر اسمك واسم من تنظر إليه. وتُسأل كلها، حتى تلك التي لا شيء لديها لتقوله، فيعرف كل واحد منها أنك كنت تقرأ في تلك اللحظة.',
  'privacy.lookups.party.guildHosts': 'كل خادم تشاركه مساحة',
  'privacy.lookups.sees.guildHosts': 'طلبًا من هذا الجهاز يسأل إن كان ذلك الشخص عضوًا، فيرى عنوانك إضافةً إلى أنك سألت.',
  'privacy.lookups.note': 'هؤلاء من يعلمون بالأمر في كل مرة يجري فيها استعلام. والإعداد أعلاه يغيّر عدد المرات، وما إذا كان شيء غير الفتح المتعمَّد يمكن أن يبدأ استعلامًا — لكنه لا يجعل الاستعلام أهدأ.',

  'privacy.push.head': 'خدمة الدفع لديك هي خدمة الشركة صانعة المتصفّح، وهي الجزء الوحيد هنا الذي لا يخصّك.',
  'privacy.push.provider': 'تحصل على عنوان ثابت لهذا المتصفّح، وعلى وقت كل تنبيه وحجمه. المحتويات مُعمّاة لهذا المتصفّح فلا تستطيع قراءتها — لكن التوقيع على كل تنبيه يذكر اسم خادمك الرئيسي، فيتراكم لديها مع الوقت سجلّ بالأوقات التي كان لدى خادمك فيها ما يخبرك به.',

  // -------------------------------------------------------------- updates
  //
  // الأفعال مفصولة عمدًا: «التثبيت» لا يصحّ إلا في نسخة سطح المكتب التي تملك
  // ملفّها التنفيذي، وفي غير ذلك زرٌّ لا يفعل شيئًا. انظر
  // `catalog/en/updates.js`. ورقم الإصدار يبقى بالأرقام اللاتينية كما ينطقه
  // الناس، ويضعه `Intl` في مكانه الصحيح داخل الجملة.

  'updates.available': 'الإصدار {version} من Telium متاح الآن.',
  'updates.security': 'أحد الإصدارات التي فاتتك يعالج مشكلة أمنية.',
  'updates.incompatible': 'نسخة Telium هذه أقدم من أن تتصل. التحديث سيحل المشكلة.',

  'updates.action.install': 'التثبيت وإعادة التشغيل',
  'updates.action.reload': 'إعادة التحميل',
  'updates.action.store': 'فتح المتجر',
  'updates.action.page': 'ما الذي تغيّر',
  // «لاحقًا» لا «إغلاق»: الإشعار سيعود، وكلمةٌ تَعِد بغير ذلك تَعِد بما لا
  // يفعله الكود.
  'updates.action.later': 'لاحقًا',
  'updates.action.restart': 'إعادة التشغيل',

  'updates.blocked.package': 'هذه النسخة مثبّتة عبر نظامك، فحدّثها بالطريقة نفسها التي ثبّتها بها.',
  'updates.blocked.artifact': 'لا يوجد تنزيل لهذه المنصة في هذا الإصدار.',

  'updates.state.downloading': 'جارٍ تنزيل Telium {version}…',
  'updates.state.verifying': 'جارٍ التحقق من التوقيع…',
  'updates.state.ready': 'الإصدار {version} من Telium جاهز. أعد التشغيل لاستخدامه.',
  'updates.state.failed': 'تعذّر تثبيت هذا التحديث. نزّله بنفسك بدلًا من ذلك.',

  'updates.footer.unkeyed': 'لا يوجد ناشر تحديثات مُعدّ لهذه النسخة، لذلك لن تبحث عن تحديثات.',
  'updates.footer.current': 'محدّثة.',
  'updates.footer.unreachable': 'تعذّر الوصول إلى ناشر التحديثات.',
  'updates.footer.forged': 'لم تحمل معلومات التحديث توقيعًا صالحًا، فتم رفضها.',
  'updates.footer.checking': 'جارٍ البحث عن تحديثات…',

// القيمتان الافتراضيتان في `DataTable`. تبقيان عامّتين كما في الإنجليزية: لا
  // تظهران إلا حين لا يمرّر المستدعي اسمًا، فأي تخصيص هنا يكذب على أغلب الجداول.
  // اخترنا «السجلات» بصيغة الجمع المعرَّف لأنها اسم القائمة لا عدد صفوفها، ولم
  // نستعمل «البيانات» لأنها تعني المحتوى نفسه لا الصفوف التي يقرؤها قارئ الشاشة.
  'common.table.empty': 'لا شيء هنا.',
  'common.table.label': 'السجلات',

// ------------------------------------------------------------------- الاصطلاح
  //
  // The glossary this namespace is built on, stated once so the next
  // translator can extend it rather than re-decide it. Arabic already has
  // settled technical words for almost everything a guild owner touches, so
  // the default here is to translate rather than to transliterate: a guild is
  // a نقابة (the word `ar.js` already uses in `settings.messages.typing.hint`,
  // so it was not mine to choose), a role is a دور, a channel a قناة, a member
  // an عضو, an invite a دعوة, a ban a حظر, a gate a بوّابة, a sticker a ملصق,
  // an emoji a رمز تعبيري, a region a منطقة, a relay a مُرحِّل, a key a مفتاح,
  // the audit log سجلّ التدقيق, and a queue a طابور. The three deliberate
  // separations inside that set are worth naming because they are what stops
  // the vocabulary collapsing: حظر is reserved for a *ban on a person* and
  // منع for a *block on a host*, so `guild.bans.*` and the blocklist policy do
  // not share a word; طابور is the queue and قائمة is a list, so "moderation
  // queue" and "allowlist" stay apart; and نقل always carries its object
  // (نقل النقابة to another server, نقل الملكية to another person) because
  // Arabic has one verb where English has "move" and "transfer".
  //
  // Comments below are in English, like the ones in `en/guild.js` and most of
  // the ones in `ar.js`, because they are addressed to a reviewer and to the
  // German and Japanese translators working the same namespace, not to a
  // reader of the app.
  //
  // Two conventions held across all 244 keys. **Register** is Modern Standard
  // Arabic throughout, no dialect, matching `ar.js`. **Imperatives** are split
  // the way `ar.js` already splits them: a control the reader presses takes
  // the مصدر (حفظ, إلغاء, حذف — `common.save`, `common.cancel`,
  // `common.delete`), and a sentence that tells the reader to do something
  // takes صيغة الأمر, masculine singular (أدخل, أعد المحاولة, سجّل الدخول —
  // `errors.mfa_required`, `errors.status.401`). That split is why
  // `guild.gates.pinned` says «احفظ البوّابات» while the button it points at
  // is labelled «حفظ البوّابات»: the sentence is speaking to a person, the
  // button is naming an action. It is not an inconsistency and it should not
  // be flattened.
  //
  // **Divergence from the sibling catalogues.** The Japanese translator
  // settled on ギルド for guild, ロール for role, ゲート for gate and treated
  // `ban` as an anglicism. Arabic diverges in kind on all four: نقابة, دور,
  // بوّابة and حظر are translations, not transliterations, because Arabic --
  // unlike Japanese, which has a productive katakana layer for exactly this --
  // has no register in which a transliterated ban reads as anything but a
  // failure to translate. Where Arabic *does* keep the Latin, it keeps it
  // whole and unchanged (SFU, TURN, CORS), following the
  // precedent `ar.js` already set by leaving "Telium" in Latin inside Arabic
  // sentences. Arabic never takes the middle road Japanese takes.

  // ------------------------------------------------------------------ the shell
  //
  // The rail. Every label here had to fit a narrow column, and Arabic is not
  // reliably shorter than English -- the definite article and the broken
  // plural give most of these one or two characters more, not fewer. Where a
  // literal rendering would have wrapped to three lines the *phrase* was
  // shortened rather than the words, as the English note asks: no acronyms
  // were invented, because an Arabic acronym is far less readable than an
  // English one (there is no established way to pronounce one) and a reader
  // who has to decode a rail label will not use the search box that filters on
  // it either.

  'guild.nav.overview': 'نظرة عامة',
  // دور/أدوار, not a transliteration. The word is what the role editor and
  // `roles.js` will need too, and a rail that said «الرولات» would be the only
  // place in the product speaking a different register from `perms.js`.
  'guild.nav.roles': 'الأدوار',
  // «صلاحية» for permission is fixed by `ar.js` already -- `errors.missing_permission`
  // reads «تحتاج إلى صلاحية «{permission}»» -- so this label has to use the
  // same noun or a moderator refused an action will go looking for a pane
  // called something else. That is the failure mode `docs/translating.md`
  // names under the `perms.js` bullet, and it applies just as hard here.
  'guild.nav.channels': 'صلاحيات القنوات',
  // "Bots" is the ordinary word and so is this: «بوت» is a fully naturalised
  // loan in Arabic (it takes the Arabic sound plural, بوتات, and the definite
  // article) and is what every Arabic-speaking chat community actually says.
  // «الروبوتات» was rejected because روبوت in Arabic means a machine with
  // limbs; a reader would picture the wrong thing. Note this is an Arabic-script
  // loan, not a Latin passthrough -- it is not one of the untranslated lines.
  'guild.nav.bots': 'البوتات',
  // بوّابة is the term of art for the whole of `guild.gates.*` and appears in
  // eight keys below; it must not drift. It collides only with the *comment*
  // banner in `ar.js` over the gateway close codes («إغلاق البوّابة») -- no
  // user-visible string there uses the word, they all say الاتصال or الخادم --
  // so the collision costs a reader nothing and is worth accepting for a term
  // this central. مصدر for origin: the pane means the host a file came from,
  // which is exactly مصدر, and the browser-security sense the English note
  // warns about does not attach to the Arabic word at all.
  'guild.nav.gates': 'البوّابات والمصادر',
  // طابور, not «قائمة انتظار». Two reasons, and the second is the one that
  // pays. طابور is the established Arabic computing word for a queue (طابور
  // الطباعة), and it is one word where قائمة انتظار is two, which is what
  // keeps this rail label from wrapping. More importantly it frees قائمة for
  // *list*, which this namespace needs for قائمة السماح and قائمة المنع below;
  // a vocabulary where the moderation queue and the allowlist are both قائمة
  // is one a reader has to disambiguate from context every time.
  'guild.nav.queue': 'طابور الإشراف',
  // The rail label names the pane by its subject -- «الرسائل المزعجة», spam --
  // while `guild.purge.title` carries the full «تنظيف الرسائل المزعجة». That
  // is the shortening the English note asks for: three words would have
  // wrapped here, and "spam" is what somebody would actually call the pane
  // when telling a colleague where to go. No transliteration («السبام») was
  // considered; الرسائل المزعجة is the settled term.
  'guild.nav.purge': 'الرسائل المزعجة',
  // حظر is the masdar and does duty for both the act and the pane. The table
  // below is labelled «المحظورون» instead, because a table of accounts should
  // be named for what its rows are; this rail entry is named for what the pane
  // is about.
  'guild.nav.bans': 'الحظر',
  'guild.nav.invites': 'الدعوات',
  // «الرموز التعبيرية» rather than «الإيموجي». The transliteration is common
  // in speech, but the pane also holds stickers and is read by somebody
  // administering a guild, and the descriptive term is the one that sits next
  // to «الملصقات» without either looking borrowed. It is long for a rail
  // label -- seventeen characters -- and it is the single entry here most
  // likely to wrap on a phone; if it does, the fix is the column, not an
  // abbreviation.
  'guild.nav.expressions': 'الرموز التعبيرية',
  // LEFT PARTLY IN ENGLISH. SFU is a protocol term and the reason it is in the
  // label at all is that the reader arrived having read it in their relay's
  // documentation; an Arabic gloss («وحدة إعادة التوجيه الانتقائية») is four
  // words, would not fit, and would not match anything they can search for.
  'guild.nav.voice': 'الصوت / SFU',
  // سجلّ التدقيق, not «سجلّ المراجعة». Both are current; تدقيق is the word
  // used for an audit in the accounting and security sense, which is the sense
  // here -- a record kept so somebody can check what was done -- while مراجعة
  // also means "review" and would read as a queue of things awaiting a look.
  'guild.nav.audit': 'سجلّ التدقيق',

  // Indefinite: the record has not arrived, so this is "a guild", not "the
  // guild". Arabic marks that by the absence of the article and it is the one
  // difference between this and every other use of the word in the file.
  'guild.title.fallback': 'نقابة',
  // A label over a value, so no verb and no full stop. «مستضافة لدى» agrees
  // with نقابة, which is feminine -- worth saying because every adjective and
  // participle in this namespace that refers to the guild follows it
  // (منتهية, نشطة, مخصّصة below all agree with their own feminine nouns).
  'guild.hostedBy': 'مستضافة لدى',
  // «في الوقت الحالي» is carrying the English "right now": the point is that
  // this is a state and not a loss. Arabic could drop it and the sentence
  // would still parse; it would also send somebody to ask where their guild
  // went, which is the outcome the English note exists to prevent.
  'guild.unreachable': 'تعذّر الوصول إلى خادم تلك النقابة في الوقت الحالي.',

  // ------------------------------------------------------------ shared durations
  //
  // The English note invites a translator to write the digits in their own
  // numerals here -- «٢٤ ساعة» -- and the header of `ar.js` forbids exactly
  // that: "a digit typed literally into a string here would be the wrong one
  // half the time and would not follow a change of numbering system". Both are
  // right, and the way out is to type no digit at all. Arabic spells small
  // numbers in words comfortably and idiomatically, so these are ست ساعات,
  // ثلاثة أيام, ثلاثون يومًا. That satisfies the house rule literally, reads
  // better in a menu than numerals would, and survives a switch of numbering
  // system because there is nothing in the string to switch.
  //
  // The agreement is the ordinary Arabic number agreement and is worth reading
  // as a preview of the plural arms further down: ست ساعات is the 3-10 shape
  // (plural noun), ثلاثون يومًا is the 11-99 shape (singular, accusative), and
  // ساعة واحدة / يوم واحد put the counted noun first because a bare «ساعة»
  // could be read as "an hour" rather than "one hour".

  'guild.duration.hour': 'ساعة واحدة',
  'guild.duration.sixHours': 'ست ساعات',
  'guild.duration.day': 'يوم واحد',
  'guild.duration.threeDays': 'ثلاثة أيام',
  'guild.duration.week': 'أسبوع واحد',
  'guild.duration.thirtyDays': 'ثلاثون يومًا',
  // "No limit", the top of the attachment-lifetime select: there is no
  // ceiling. Kept distinct from `common.never` («أبدًا»), which is the invite
  // select's "no deadline", exactly as the English note requires -- حدّ is a
  // bound on a quantity, أبدًا is a point in time that never comes. Written
  // «بلا حدّ» and not «بلا حدّ أقصى» so that it does not repeat the word أقصى
  // that `guild.overview.expiry.label` above it already carries.
  'guild.duration.unlimited': 'بلا حدّ',

  // ------------------------------------------------------------------- overview

  'guild.overview.name': 'الاسم',
  'guild.overview.description': 'الوصف',
  // مصدر for the button, per the convention at the top. «اختيار أيقونة» is
  // indefinite because no icon has been chosen yet; the saving state below is
  // definite because by then there is a particular file in flight.
  'guild.overview.chooseIcon': 'اختيار أيقونة',
  // «جارٍ …» is the progressive form `ar.js` already uses for in-flight states
  // (`common.saving`, `common.loading`). Keeping the same opener matters more
  // than the rest of the sentence: it is how a reader recognises at a glance
  // that a control is busy rather than broken.
  'guild.overview.savingIcon': 'جارٍ حفظ الأيقونة…',
  // A complete sentence read on its own, so it takes a full stop. Passive
  // «تم تعيين» rather than an active verb because there is no actor worth
  // naming and Arabic would have to invent one.
  'guild.overview.iconSet': 'تم تعيين أيقونة مخصّصة.',
  'guild.overview.iconNone': 'لا توجد أيقونة.',
  // No full stop, matching English: this is a toast title with the server's
  // own message underneath it, not a sentence. تعذّر is the house opener for
  // every "could not" in `ar.js` and is used for all fifteen failures below.
  'guild.overview.iconFailed': 'تعذّر حفظ الأيقونة',

  // ALL SIX ARMS. This is the clearest specimen in the namespace of why the
  // six are not a formality, so it is worth walking:
  //
  //   zero  (0)      «لا أعضاء»   -- no numeral at all. Arabic does not say
  //                  "zero members"; it negates the noun. English reaches this
  //                  through `other` and prints "0 members", which is why the
  //                  arm has to be written rather than inherited.
  //   one   (1)      «عضو واحد»   -- the numeral follows the noun and is a
  //                  word, not a digit; `#` is deliberately not used.
  //   two   (2)      «عضوان»      -- the real dual. The number vanishes into
  //                  the noun's own ending. There is nowhere to put `#`, and a
  //                  pattern that tried would read «٢ عضوان», which is wrong.
  //   few   (3-10)   «# أعضاء»    -- broken plural, genitive.
  //   many  (11-99)  «# عضوًا»    -- singular, accusative تمييز. The tanwin
  //                  alif is written because the orthography requires it on a
  //                  word ending in a consonant.
  //   other (100+)   «# عضو»      -- singular again, genitive. This is the arm
  //                  people get wrong: after the hundreds the noun goes back
  //                  to the singular, so «١٢٠٠ عضو» is correct and
  //                  «١٢٠٠ أعضاء» is not. Note that `many` and `other` differ
  //                  here only by the accusative ending, which *is* written on
  //                  عضو; on a noun ending in ة it would not be, and two arms
  //                  further down do coincide for exactly that reason.
  //
  // The full stop sits outside the plural, as in English, because it belongs
  // to the sentence and not to any one arm.
  'guild.overview.memberCount': '{count, plural, zero {لا أعضاء} one {عضو واحد} two {عضوان} few {# أعضاء} many {# عضوًا} other {# عضو}}.',
  // An absent fact, not a count of zero -- which is why this is a separate key
  // and why the Arabic states the absence rather than printing a number.
  'guild.overview.memberCountUnknown': 'عدد الأعضاء غير معروف.',
  'guild.overview.created': 'أُنشئت في {at, date, medium}.',
  // Deliberately vague, as English is. «منذ زمن» is the ordinary Arabic for
  // "a while ago" and carries the same shrug; «في تاريخ غير معروف» would be
  // the sharpening the English note forbids.
  'guild.overview.createdUnknown': 'أُنشئت منذ زمن.',

  // -------------------------------------------------------- attachment lifetime

  'guild.overview.expiry.title': 'انتهاء صلاحية الملفات',
  // The second sentence is the one moderators misread, so it is a full
  // independent clause in Arabic too rather than a subordinate tail. «حدّ
  // أضيق» keeps the ceiling metaphor: a channel may narrow it, never widen it.
  'guild.overview.expiry.hint': 'أطول مدة يبقاها المرفق في هذه النقابة. ويجوز للقنوات وضع حدّ أضيق.',
  // A NOUN PHRASE, taking the escape the English note offers, and not the
  // split sentence English uses. The reason is `guild.duration.unlimited`: a
  // running Arabic sentence «تُحفظ الملفات مدة أقصاها» completed by «بلا حدّ»
  // reads "files are kept for a maximum of no limit", which is nonsense in a
  // way the English fragment is not. A label naming the setting works with
  // every option in the menu, which is the property a select label has to have.
  'guild.overview.expiry.label': 'أقصى مدة لبقاء الملفات',
  'guild.overview.fileSize.title': 'حدّ حجم المرفقات',
  'guild.overview.fileSize.hint': 'أكبر ملف يمكن لعضو إرفاقه في هذه النقابة. ويجوز للقنوات وضع حدّ أضيق.',
  'guild.overview.fileSize.label': 'أقصى حجم للمرفقات (بالبايت)',
  'guild.overview.fileSize.placeholder': 'لا حدّ في هذه النقابة',

  // ------------------------------------------------------- moving and ownership
  //
  // نقل is the one verb Arabic has where English has two -- "move" (a guild to
  // another server) and "transfer" (ownership to another person) -- and both
  // features live in this section, four keys apart. The rule adopted and held
  // is that نقل always names its object: نقل النقابة for the first, نقل
  // الملكية for the second, never a bare نقل. `guild.overview.transfer.dialogTitle`
  // is where that bites hardest and is commented again there.

  'guild.overview.move.title': 'نقل هذه النقابة',
  // The order of the two parties is load bearing and is preserved: destination
  // first, current owner second. «ثم» is doing that work and must not be
  // softened to «و». The last sentence is the reassurance; «صالحة» (still
  // valid) rather than a literal "resolve", which has no Arabic equivalent a
  // moderator would recognise.
  'guild.overview.move.hint': 'يؤكّد المالك الجديد على الخادم المقصود، ثم يأذن المالك الحالي بالنقل من هنا. وتظلّ الروابط القديمة صالحة.',
  // The Arabic exceptive («لا … إلا») is the idiomatic way to say "only X can",
  // and it is stronger than a positive sentence with «فقط» tacked on.
  'guild.overview.move.ownerOnly': 'لا يستطيع نقلها إلا مالك النقابة.',
  'guild.overview.move.button': 'النقل إلى خادم آخر',
  // `{domain}` is a hostname and stays as it arrives. It needs no bidi mark
  // from this file: `stringify` in `format.js` routes every interpolated value
  // through `services.isolate`, which wraps a Latin value in FSI/PDI when the
  // direction may differ. The comma after it is therefore safe.
  'guild.overview.move.elsewhere': 'هذه النقابة مستضافة لدى {domain}، لذا يجب بدء النقل من حساب هناك.',

  // The English note asks a language that distinguishes a noun phrase from an
  // imperative to split the heading from the two buttons. Arabic does
  // distinguish, but taking the split as offered would mean putting صيغة الأمر
  // on buttons, which would break the file-wide convention for the sake of one
  // section. So the differentiation is made in the noun phrase instead: the
  // heading names the section *and its object* (نقل ملكية النقابة), the two
  // buttons name the act (نقل الملكية). The commit button is not «تأكيد»:
  // naming the irreversible act on the button that performs it is the
  // convention for destructive confirmations, and it is what `ar.js` does
  // wherever it has the choice.
  'guild.overview.transfer.title': 'نقل ملكية النقابة',
  'guild.overview.transfer.button': 'نقل الملكية',
  'guild.overview.transfer.confirm': 'نقل الملكية',
  // "must already be a member" is the precondition people fall over, so
  // «بالفعل» is not optional padding. The second sentence uses the exceptive
  // again («لا … سواه») to say that the old owner loses both powers, which is
  // the part that is irreversible.
  'guild.overview.transfer.hint': 'يجب أن يكون المالك الجديد عضوًا بالفعل. وبعد النقل لا يستطيع نقل النقابة أو حذفها سواه.',
  // THE COLLISION KEY. English "Transfer {name}" would translate word for word
  // as «نقل {name}», which in this dialog is indistinguishable from the *move
  // to another server* feature five keys above. الملكية is added to
  // disambiguate. The placeholder is untouched and is isolated by the runtime.
  'guild.overview.transfer.dialogTitle': 'نقل ملكية {name}',
  'guild.overview.transfer.label': 'معرّف حساب المالك الجديد',
  // صيغة الأمر: the sentence tells the reader to do something. Compare the
  // button labels four lines up, which are مصدر. Both are correct and the
  // difference is the convention, not an oversight.
  'guild.overview.transfer.dialogHint': 'أدخل معرّف الحساب الكامل لعضو حالي.',
  // LEFT IN ENGLISH, and this one is not a style choice. The field validates
  // the `@localpart:domain` syntax and account local parts are ASCII, so an
  // Arabic-script local part would produce an example the field itself
  // rejects -- an example that cannot be typed is worse than an English one.
  // `example.org` is reserved by RFC 2606 and stays for the reason the English
  // comment gives. The `@` and `:` are syntax.
  'guild.overview.transfer.placeholder': '@member:example.org',
  'guild.overview.transfer.done': 'تم نقل الملكية.',
  'guild.overview.transfer.failed': 'تعذّر نقل الملكية',

  'guild.overview.delete.title': 'حذف هذه النقابة',
  // The flattest sentence in the file, deliberately. No hedging verb, no
  // «قد», no reassurance Arabic could easily have added -- «لا توجد جهة تحتفظ
  // بنسخة» says plainly that nothing anywhere holds a copy. The list keeps
  // English's order and «كلها دفعة واحدة» keeps "all at once", which is the
  // half that tells the reader this is not a staged deletion they can stop.
  'guild.overview.delete.hint': 'تذهب القنوات والرسائل والأدوار والأعضاء كلها دفعة واحدة. ولا توجد جهة تحتفظ بنسخة يمكن الاستعادة منها.',
  'guild.overview.delete.button': 'حذف النقابة',
  'guild.overview.delete.confirm': 'حذف النقابة',
  'guild.overview.delete.dialogTitle': 'حذف {name}',
  // صيغة الأمر again -- an instruction to the reader. "the name" is the
  // guild's own, shown in the title above, so الاسم is definite.
  'guild.overview.delete.label': 'اكتب الاسم للتأكيد',
  'guild.overview.delete.dialogHint': 'لا يمكن التراجع عن هذا.',
  'guild.overview.delete.failed': 'تعذّر حذف النقابة',

  'guild.overview.saveFailed': 'تعذّر الحفظ',

  // ---------------------------------------------------------------------- gates

  // «أشدّ» / «أهون» is the Arabic pair for stricter/looser as applied to rules,
  // and the «ولا … أبدًا» keeps English's "never": this is a rule about
  // federation and not advice. الخادم المضيف is the host server, distinct from
  // الخادم الرئيسي (homeserver, `common.homeserver`) used two keys down -- the
  // first is where the guild lives, the second is where an account lives, and
  // Arabic has to keep them apart because the pane talks about both.
  'guild.gates.hint': 'تعمل البوّابات عند انضمام أحد. ويمكن لهذه النقابة أن تكون أشدّ من خادمها المضيف، لا أهون منه أبدًا.',

  'guild.gates.minAge.label': 'أدنى عمر للحساب (بالأيام)',
  // «خادمه الرئيسي» deliberately reuses `common.homeserver`'s الخادم الرئيسي
  // rather than inventing a second phrase for "home server". A moderator
  // reading this and then reading the login screen should meet one term.
  'guild.gates.minAge.hint': 'يُقاس من تاريخ إنشاء الحساب على خادمه الرئيسي.',

  // The three policy labels. The wire values are `open`, `allowlist`,
  // `blocklist` and nothing here touches them. All three are feminine to agree
  // with السياسة, the noun they are options of.
  'guild.gates.policy.open': 'مفتوحة',
  // Arabic does have a settled pair for these and it is not the colour one --
  // «القائمة البيضاء» / «القائمة السوداء» is both dated and, as in English,
  // being retired. قائمة السماح / قائمة المنع states what the table does,
  // which is what the English note asks a language without an established pair
  // to do, and Arabic gets it without a paraphrase. Note المنع and not الحظر:
  // حظر is reserved for a ban on a person throughout this namespace, so the
  // blocklist and the ban list do not share a word.
  'guild.gates.policy.allowlist': 'قائمة السماح',
  'guild.gates.policy.blocklist': 'قائمة المنع',

  // "Home domain" is the domain of the joiner's home server, so النطاق
  // الرئيسي, built on the same الرئيسي as `common.homeserver`.
  'guild.gates.domainPolicy.label': 'سياسة النطاق الرئيسي',
  'guild.gates.domainRules.label': 'قواعد النطاق الرئيسي',
  // LEFT PARTLY IN ENGLISH. `allow` and `deny` are keywords the server matches
  // literally and `example.org` / `spam.example` are reserved example domains;
  // all four survive untranslated inside the ASCII double quotes. The quotes
  // themselves are kept as ASCII `"` rather than converted to the Arabic
  // guillemets this file uses elsewhere, and that is a deliberate distinction:
  // « » here mark a *reference to a UI label* (see «مفتوحة» in the second
  // sentence, which points at `guild.gates.policy.open` and follows it if that
  // label ever changes), while " " mark literal machine syntax. A reader who
  // learns that contrast can tell at a glance which quoted runs they may type
  // and which they may not.
  //
  // BIDI LAYOUT RISK, reported rather than papered over: the two quoted rules
  // are hard-coded Latin inside an Arabic paragraph and nothing isolates them,
  // because `isolate` only runs on interpolated values. The Arabic comma after
  // the closing quote of the first rule sits between two LTR runs and will
  // resolve to the paragraph direction, which is what you want, but the
  // rendering has not been checked on a real RTL line. No U+200F was inserted.
  'guild.gates.domainRules.hint': 'قاعدة واحدة في كل سطر، مثل "allow example.org" أو "deny spam.example". وتحت سياسة «مفتوحة» تُتجاهل هذه القواعد.',

  // فرز is screening in the sense of sifting applicants, not «تصفية» (which is
  // filtering, and is what a search box does) and not «فحص» (which is the
  // probe, further down in the voice pane). Three different English words,
  // three different Arabic ones, and they must not be allowed to merge.
  'guild.gates.screening.label': 'أسئلة الفرز',
  // "the applicants queue" is named here exactly as `guild.queue.applicants.title`
  // names it -- طابور المتقدّمين -- because the English note requires the two
  // to match and a moderator following this sentence has to find that pane.
  'guild.gates.screening.hint': 'سؤال واحد في كل سطر. اتركه فارغًا للقبول دون فرز؛ وإلا فإن المنضمّ ينتقل إلى طابور المتقدّمين.',

  // The algebraic stand-in. English uses Latin `N`; Arabic mathematics uses
  // «ن» for a natural number in exactly this position ("first ن messages"), so
  // that is the letter, and it is the same letter in both strings as the
  // English note requires. Using ن rather than keeping `N` also removes a
  // one-character Latin run from the middle of an Arabic label, which is a
  // bidi hazard avoided by translating rather than by a control character.
  // Note the singular رسالة after أول: Arabic counts «أول ن رسالة», not
  // «أول ن رسائل».
  'guild.gates.hold.label': 'حجز أول ن رسالة',
  // "Zero" is spelled الصفر rather than typed as a digit, for the reason given
  // over the durations: no literal numeral belongs in this file.
  'guild.gates.hold.hint': 'تنتظر أول ن رسالة من العضو الجديد الموافقة بدل أن تظهر. والصفر يعطّل الحجز.',

  // مصدر here means the host a file was uploaded to. The English note warns
  // that a reader may import the browser-security sense of "origin"; the
  // Arabic word carries no such freight, so the warning does not transfer and
  // the sentence needs no extra hedging. «عند نشر الرسالة» keeps the timing
  // that matters: the check happens at post time, not at fetch time.
  'guild.gates.origins.hint': 'المصادر التي تقبل هذه النقابة المرفقات منها. ويجري الفحص عند نشر الرسالة.',
  'guild.gates.originPolicy.label': 'سياسة مصادر الوسائط',
  'guild.gates.originRules.label': 'قواعد مصادر الوسائط',
  // LEFT PARTLY IN ENGLISH. `allow`, `block`, `feed:`, `key:`, `https://` and
  // the reserved hosts `files.example` / `sketchy.example` are all syntax and
  // all survive. The one thing inside the quotes that was translated is the
  // metavariable `<curator key>` -> `<مفتاح القيّم>`: the angle brackets are
  // what marks it as the part a reader substitutes, they are preserved, and
  // translating what is inside them is what makes the marking legible to an
  // Arabic reader who would otherwise be tempted to type it literally. It is
  // safe against the parser -- `matchTag` in `format.js` requires an ASCII
  // letter after `<`, so `<م…>` never parses as a tag and renders as text.
  //
  // The last sentence is the precedence rule and it is not decorative: «يتقدّم
  // على» is "takes precedence over", not "is better than".
  //
  // BIDI LAYOUT RISK, same as the domain rules above and worse, because the
  // third quoted run mixes Latin syntax with an Arabic metavariable inside one
  // pair of quotes. Reported, not patched.
  'guild.gates.originRules.hint': 'قاعدة واحدة في كل سطر، مثل "allow files.example" أو "block sketchy.example". وخلاصة القيّم تُكتب هكذا: "allow feed:https://… key:<مفتاح القيّم>". والمضيف المسمّى يتقدّم على الخلاصة.',

  'guild.gates.save': 'حفظ البوّابات',
  'guild.gates.saved': 'تم حفظ البوّابات.',
  'guild.gates.saveFailed': 'تعذّر حفظ البوّابات',
  'guild.gates.refreshFailed': 'تعذّر تحديث الخلاصات',
  // The second sentence is صيغة الأمر because it tells the reader to press
  // something, even though the thing it names is labelled with a مصدر
  // («حفظ البوّابات», four keys up). That asymmetry is the convention working
  // as intended and is the clearest place in the file to see it.
  'guild.gates.pinned': 'أُضيفت إلى القواعد أعلاه. احفظ البوّابات للاشتراك.',

  // ------------------------------------------------------- the curator directory

  // قيّم (pl. قيّمون) is the Arabic for a curator in the museum sense -- one
  // who keeps and vouches for a collection -- and it transfers cleanly to a
  // person who publishes a signed list of hosts. «منسّق» (coordinator) was the
  // alternative and was rejected as too weak: it says nothing about vouching.
  // خلاصة is the established Arabic for a feed (as in RSS خلاصات), not
  // «تغذية», which is the literal "feeding" and is used for nutrition.
  //
  // The second sentence carries the whole point of the pane, so «ولا تقرّر
  // الخلاصة شيئًا حتى …» keeps the negative-until construction rather than
  // turning it into a positive "pin a key to make it work".
  'guild.gates.curators.hint': 'القيّمون الذين يعرفهم هذا الخادم. ولا تقرّر الخلاصة شيئًا حتى تثبّت مفتاحها هنا.',
  'guild.gates.curators.tableLabel': 'القيّمون',
  'guild.gates.curators.colCurator': 'القيّم',
  'guild.gates.curators.colFeed': 'الخلاصة',
  // "Listed by" -- who this client heard about the curator from. Rendered as a
  // verb («أدرجها», "listed it") rather than as a noun like «المصدر», because
  // مصدر is already the origin term of art in this same pane and a column
  // header reading «المصدر» beside a pane about مصادر الوسائط would be read as
  // the wrong thing.
  'guild.gates.curators.colSource': 'أدرجها',
  'guild.gates.curators.thisServer': 'هذا الخادم',
  // تثبيت is the Arabic term already used for certificate pinning, which the
  // English note explicitly asks a language to reuse if it has it. Arabic
  // does, so this is not a coinage.
  'guild.gates.curators.pin': 'تثبيت المفتاح',
  // The state the button turns into. «تم الاشتراك» follows `ar.js`'s own
  // pattern for a completed action shown on a control (`common.copied` is
  // «تم النسخ»), which is more idiomatic than the bare participle «مُشترَك».
  'guild.gates.curators.subscribed': 'تم الاشتراك',

  // ------------------------------------------------------------ subscribed feeds

  // Both halves matter and the second is fail-closed, so the Arabic keeps the
  // contrast explicit with «لكنها تستمرّ في»: an expired feed stops admitting
  // and does not stop refusing. Softening that into «قد تتوقّف» would invert
  // the safety property.
  'guild.gates.feeds.hint': 'تُجلب الخلاصات عند أول حفظ ثم كل ساعة. والخلاصة المنتهية الصلاحية تتوقّف عن السماح بمضيفيها لكنها تستمرّ في رفض من تمنعهم.',
  'guild.gates.feeds.tableLabel': 'الخلاصات المشترَك فيها',
  'guild.gates.feeds.colFeed': 'الخلاصة',
  'guild.gates.feeds.colHosts': 'المضيفون',
  // A serial in the DNS-zone sense, not a count. «الرقم التسلسلي» is the
  // settled Arabic and is the longest column header in this table; if it
  // clips, the column is too narrow, because there is no shorter Arabic that
  // still means a version serial rather than a sequence position.
  'guild.gates.feeds.colSerial': 'الرقم التسلسلي',
  'guild.gates.feeds.colFetched': 'آخر جلب',
  'guild.gates.feeds.colKey': 'مفتاح القيّم',
  // «الحالة» is the feed's status. Note that the voice table's "Health" column
  // is «السلامة» and not «الحالة» -- two different columns in two different
  // tables, and giving them the same Arabic word would suggest they report the
  // same kind of fact.
  'guild.gates.feeds.colState': 'الحالة',
  'guild.gates.feeds.refresh': 'تحديث الخلاصات',

  // `{action}` arrives as the literal `allow` or `block` the moderator typed
  // and stays that way; it is isolated by the runtime, so the `·` between the
  // two values will not be dragged. «من إعداد» is "compiled by" -- the nearest
  // Arabic to "curated by" that does not turn the curator into an author.
  // The separator is kept as `·`; Arabic has no different convention for it.
  'guild.gates.feeds.curatedBy': '{action} · من إعداد {curator}',
  'guild.gates.feeds.hosts': '{hosts, number}',
  // Restructured. English uses "(N blocked)", relying on an English participle
  // that does not inflect for number. Arabic «ممنوع» would have to agree with
  // the count (ممنوعة at 3-10, ممنوعًا at 11-99), and the parenthetical is not
  // a plural pattern -- `{blocks, number}` is a bare number and turning it into
  // a six-armed plural inside an eight-character column would not fit. So the
  // Arabic uses the label-and-colon form «(ممنوع: N)», where ممنوع is a
  // heading rather than a modifier and agreement never arises. Same two
  // placeholders, same order.
  'guild.gates.feeds.hostsWithBlocks': '{hosts, number} (ممنوع: {blocks, number})',
  'guild.gates.feeds.fetchedAt': '{at, dateTime}',

  // The quiet case: the key in the rule is the key in force. Masculine to
  // agree with مفتاح.
  'guild.gates.feeds.keyPinned': 'مثبّت',
  // CONVERTED FROM `{count, number}` TO `{count, plural, …}`. English writes
  // "Rotated 3x", leaning on an abbreviation Arabic does not have: there is no
  // Arabic convention for a bare multiplier after a verb, and «دُوِّر ٣ مرة»
  // is ungrammatical because the counted noun must agree. The placeholder name
  // is unchanged, so the coverage test's "same placeholders" check still sees
  // exactly `{count}`; what changed is that the pattern now selects an arm,
  // which means it also has to supply all six, and it does.
  //
  //   zero   «لم يُدوَّر»    -- not "rotated zero times"; the pill says the
  //          thing has not rotated. Reachable only at 0, and in practice the
  //          component shows `keyPinned` instead, so this arm is defensive.
  //   one    «دُوِّر مرة»     -- no numeral; Arabic does not say "one time".
  //   two    «دُوِّر مرتين»   -- the dual again, number absorbed into the noun.
  //   few    «دُوِّر # مرات»  -- plural.
  //   many   «دُوِّر # مرة»   -- singular accusative.
  //   other  «دُوِّر # مرة»   -- singular genitive.
  //
  // The English behind this was `Rotated {count, number}x` until recently -- a
  // numeral with an "x" stuck on it, which no Arabic count can be written as --
  // and this key was already a full six-arm plural in spite of it, on the
  // grounds that Arabic has to be one whatever English does. English is now a
  // plural too. Nothing here changed; it was re-read and re-stamped.
  //
  // `many` and `other` ARE IDENTICAL HERE, and the reason is orthographic
  // rather than grammatical: the two cases differ by a tanwin on a word ending
  // in ة, and undiacriticised Arabic -- which is what a UI is written in --
  // does not write it. Both arms are written out anyway, because a later
  // rewording onto a noun that does end in a consonant (مرّة -> دورة is not
  // that, but تدوير would be) would split them again, and the next translator
  // needs the arm to exist rather than to discover it is missing.
  'guild.gates.feeds.keyRotated': '{count, plural, zero {لم يُدوَّر} one {دُوِّر مرة} two {دُوِّر مرتين} few {دُوِّر # مرات} many {دُوِّر # مرة} other {دُوِّر # مرة}}',
  // `{key}` is base64 and is never touched. «المعمول به» is the legal-register
  // phrase for "in force", which is the right register: this is the key that
  // is actually binding, not the key that is newest.
  'guild.gates.feeds.keyInForce': 'المعمول به: {key}',
  'guild.gates.feeds.keyRotationAnnounced': 'أُعلن عن تدوير',
  'guild.gates.feeds.keyNext': 'التالي: {key}',

  // The five pills. All feminine, agreeing with خلاصة.
  'guild.gates.feeds.state.active': 'نشطة',
  'guild.gates.feeds.state.expired': 'منتهية الصلاحية',
  // Not «قيد الانتظار» -- that is "pending", which is exactly the reading the
  // English note is trying to avoid. «لم تُجلب بعد» states the fact: the fetch
  // has not come round yet and nothing is waiting on the reader.
  'guild.gates.feeds.state.pending': 'لم تُجلب بعد',
  'guild.gates.feeds.state.failed': 'أخفقت',
  // A warning, not an error: the rule was accepted and simply trusts nobody.
  // The bare negative «لا مفتاح مثبّت» carries that -- it reports a missing
  // part rather than a refusal.
  'guild.gates.feeds.state.unpinned': 'لا مفتاح مثبّت',

  // ------------------------------------------------------------ moderation queue

  'guild.queue.held.title': 'الرسائل المحجوزة',
  // "silently" is the half that needs saying, and Arabic has no adverb that
  // carries it, so it is spelled out: «دون إبلاغ صاحبها» -- without telling
  // the person who wrote it. That is longer than English and it is the
  // sentence's whole reason for existing.
  'guild.queue.held.description': 'الموافقة ترسل الرسالة الآن. والرفض يسقطها دون إبلاغ صاحبها.',
  // The English note says lowercase on purpose, so the pill matches reasons
  // like "new account". Arabic has no case, so that instruction cannot be
  // carried across directly; what carries it is the shape -- a bare participle
  // with no definite article, which is how «حساب جديد» or «رابط» would be
  // written in the same slot.
  'guild.queue.held.reason': 'محجوزة',
  // The parentheses mark the interface speaking rather than the message's
  // content, which matters more here than anywhere else in the file: every
  // other character in that box is something a person wrote.
  'guild.queue.held.noText': '(بلا نص)',
  'guild.queue.held.emptyTitle': 'لا شيء في الانتظار',
  // طابور, holding the glossary. Masculine agreement (فارغ) because طابور is
  // masculine, unlike قائمة.
  'guild.queue.held.emptyBody': 'طابور الحجز فارغ.',
  // موافقة for a message. See `guild.queue.admit` for the deliberate contrast.
  'guild.queue.approve': 'موافقة',
  'guild.queue.reject': 'رفض',
  // "Could not act on that message" says what failed rather than guessing why,
  // because the usual cause is another moderator having got there first.
  // Arabic keeps that agnosticism: «تعذّر تنفيذ ذلك» names the action the
  // reader took without naming a cause.
  'guild.queue.heldFailed': 'تعذّر تنفيذ ذلك على الرسالة',

  'guild.queue.applicants.title': 'المتقدّمون',
  'guild.queue.applicants.description': 'أشخاص تنتظر إجاباتهم عن أسئلة الفرز قرارًا.',
  // THE DELIBERATE PAIR. English distinguishes approving a message from
  // admitting a person and asks a language that has two words to use both.
  // Arabic has them and they are not near-synonyms: موافقة is assent to a
  // thing, قبول is acceptance of a person. Using موافقة here would make the
  // applicant sound like a document.
  'guild.queue.admit': 'قبول',
  'guild.queue.applicants.emptyTitle': 'لا أحد في الانتظار',
  // Not "there are no applicants": the usual reason the list is empty is that
  // the guild asks no screening questions, so the sentence says where
  // applicants come from. The Arabic exceptive («لا يظهر … إلا إذا») is how
  // that condition is stated idiomatically.
  'guild.queue.applicants.emptyBody': 'لا يظهر المتقدّمون هنا إلا إذا كانت هذه النقابة تطرح أسئلة فرز.',
  'guild.queue.applicantFailed': 'تعذّر تنفيذ ذلك على المتقدّم',

  // ----------------------------------------------------------------------- bans

  // حظر is the ban, and it is reserved for a ban on a person -- the blocklist
  // policy and the `block` rule keyword are منع. That separation is the single
  // most useful thing in this glossary, because both concepts appear on
  // adjacent panes and a reader who meets one word for both cannot tell a
  // guild-wide ban from a host rule. Note also that this is a translation, not
  // an anglicism: the Japanese catalogue treats `ban` as a loanword, and
  // Arabic has no register where a transliterated «بان» would read as anything
  // but a failure to translate.
  //
  // The scope sentence: «وحدها» is the whole point -- this guild only, not the
  // account and not the server.
  'guild.bans.hint': 'يسري الحظر على هذه النقابة وحدها.',
  // The table is named for what its rows are (banned accounts), while the rail
  // entry is named for what the pane is about (الحظر). Both are "Bans" in
  // English; Arabic can afford the distinction and a screen-reader user
  // reaching this table benefits from it.
  'guild.bans.tableLabel': 'المحظورون',
  'guild.bans.empty': 'لا أحد محظور.',
  'guild.bans.colAccount': 'الحساب',
  'guild.bans.colReason': 'السبب',
  // "When" as a column header. «الوقت» and not «متى»: an interrogative in a
  // header reads as a question in Arabic, where English can use one as a label.
  // The same choice is made for `guild.audit.colWhen`.
  'guild.bans.colWhen': 'الوقت',
  // It reports a gap in the record, not a fact about the person, so the verb
  // is passive and impersonal: «لم يُسجَّل سبب», no reason was recorded, with
  // nobody named as having failed to record it. No article on سبب, matching
  // the unemphatic shape the English note asks for.
  'guild.bans.noReason': 'لم يُسجَّل سبب',
  // "Unban" is «رفع الحظر» -- lifting the ban -- because Arabic has no
  // negating prefix that attaches to حظر. The accessible name below extends
  // the same phrase rather than restating it.
  'guild.bans.unban': 'رفع الحظر',
  // `{account}` is a full account id, read out as itself by the screen reader
  // and isolated by the runtime. The Arabic needs «عن» before it, which is the
  // only structural change: English juxtaposes, Arabic governs with a
  // preposition.
  'guild.bans.unbanAccount': 'رفع الحظر عن {account}',
  'guild.bans.unbanFailed': 'تعذّر رفع الحظر',
  'guild.bans.add': 'حظر بمعرّف الحساب',
  'guild.bans.dialogTitle': 'حظر حساب',
  // LEFT PARTLY IN ENGLISH. `@someone:example.org` is an account id in the
  // syntax the field validates; the local part is ASCII by protocol and
  // `example.org` is RFC 2606 reserved. See the note on
  // `guild.overview.transfer.placeholder` -- the same reasoning, and the same
  // refusal to localise an example that would then be rejected on submit.
  'guild.bans.dialogLabel': 'معرّف الحساب الكامل، مثل @someone:example.org',
  // The commit button names the act. Bare مصدر, no article, because it is a
  // button and not a heading.
  'guild.bans.confirm': 'حظر',
  'guild.bans.banFailed': 'تعذّر الحظر',

  // -------------------------------------------------------------- spam cleanup

  // The full phrase here, where the rail carries the short one. See
  // `guild.nav.purge`.
  'guild.purge.title': 'تنظيف الرسائل المزعجة',
  // "named account" -- the tool needs an id typed in, so «حساب محدَّد» (a
  // specified account) rather than «حساب» alone, which would read as a sweep
  // of the channel. «أحدث رسائل» keeps "most recent" attached to the messages
  // and not to the account.
  'guild.purge.hint': 'يزيل أحدث رسائل حساب محدَّد في هذه النقابة.',
  'guild.purge.accountLabel': 'معرّف الحساب',
  // LEFT IN ENGLISH. The English note says the "spammer" joke translates
  // badly, and it does -- but the constraint that actually decides it is the
  // same one as the other two id examples: account local parts are ASCII, so
  // an Arabic stand-in name would be an example the field rejects.
  // `example.org` is reserved.
  'guild.purge.accountPlaceholder': '@spammer:example.org',
  'guild.purge.limitLabel': 'أقصى عدد للرسائل',
  'guild.purge.button': 'حذف الرسائل الأخيرة',
  // ALL SIX ARMS PLUS THE `=0` LITERAL, which is preserved exactly as English
  // has it. The `=0` is not a category -- `pluralBranch` in `format.js`
  // resolves exact matches before asking `Intl.PluralRules` -- and the
  // coverage test explicitly filters arms starting with `=` out of the
  // category check, so it has to be there in addition to the six and not
  // instead of `zero`.
  //
  // That produces the one genuine shadowing in this file: **`zero` is
  // unreachable.** The only value in Arabic's `zero` category is 0 itself, and
  // `=0` takes 0 first. The arm is written anyway, and written with the same
  // sentence as `=0`, because the day somebody deletes the `=0` the plural
  // must not silently fall through to `other` and print «حُذفت ٠ رسالة» -- the
  // exact failure the English comment above the key describes.
  //
  //   =0     «لم تُحذف أي رسالة.»  -- a different outcome, not a count of
  //          nothing. States that the guild is unchanged.
  //   zero   identical to `=0`, shadowed, see above.
  //   one    «حُذفت رسالة واحدة.»
  //   two    «حُذفت رسالتان.»       -- the dual; no numeral in the string.
  //   few    «حُذفت # رسائل.»       -- 3-10, broken plural.
  //   many   «حُذفت # رسالة.»       -- 11-99, singular accusative.
  //   other  «حُذفت # رسالة.»       -- 100+, singular genitive.
  //
  // `many` and `other` ARE IDENTICAL, for the orthographic reason set out over
  // `guild.gates.feeds.keyRotated`: رسالة ends in ة, the accusative tanwin on
  // ة is not written in undiacriticised Arabic, and so the two cases collapse
  // on the page while remaining distinct in the grammar. Compare
  // `guild.overview.memberCount`, where the noun is عضو and the same two arms
  // differ visibly (عضوًا / عضو) because the tanwin alif *is* written. Both
  // arms are spelled out here regardless.
  'guild.purge.deleted': '{count, plural, =0 {لم تُحذف أي رسالة.} zero {لم تُحذف أي رسالة.} one {حُذفت رسالة واحدة.} two {حُذفت رسالتان.} few {حُذفت # رسائل.} many {حُذفت # رسالة.} other {حُذفت # رسالة.}}',
  // "purge" as a verb is just حذف here. Arabic has no separate word for a bulk
  // deletion that would not sound like a euphemism, and the button above
  // already says what is being deleted.
  'guild.purge.failed': 'تعذّر حذف الرسائل',

  // ------------------------------------------------------------------- invites
  //
  // دعوة for the invite and «رابط دعوة» for the link. The two are separate
  // keys in English too and Arabic keeps them separate: the pane creates
  // دعوات and lists روابط.

  'guild.invites.create.title': 'إنشاء دعوة',
  // "credentials" is NOT softened. «بيانات اعتماد» is the standard Arabic
  // security term and it is the whole argument of the sentence: an invite link
  // is a credential, so it is handed out like one. Translating it as «روابط»
  // would leave a sentence that says links are links. صيغة الأمر on the second
  // clause because it is telling the reader to do something before they paste.
  'guild.invites.create.hint': 'الدعوات بيانات اعتماد. امنحها مدة انتهاء أو حدًّا للاستخدام كلما أمكن.',
  'guild.invites.maxUses': 'أقصى عدد للاستخدامات',
  // A noun -- the *value* the empty field stands for -- and not an
  // instruction. «غير محدود» is an adjective describing the invite, distinct
  // from `guild.duration.unlimited`'s «بلا حدّ», which is a menu option naming
  // the absence of a ceiling. English uses two different words here too.
  'guild.invites.maxUsesPlaceholder': 'غير محدود',
  // A field label above a select. Noun phrase, not the verb «تنتهي», because
  // Arabic labels take noun phrases and a bare verb would read as a statement
  // that it has expired.
  'guild.invites.expires': 'انتهاء الصلاحية',
  'guild.invites.create.button': 'إنشاء دعوة',
  // Only shown when the clipboard refused, so the second sentence is what
  // makes it useful and is an imperative addressed to the reader.
  'guild.invites.created': 'أُنشئت الدعوة. انسخها من القائمة أدناه.',
  'guild.invites.createFailed': 'تعذّر إنشاء الدعوة',
  // The `{what}` of `common.copiedThing`, which in `ar.js` reads
  // «تم نسخ {what}.» -- so this has to be the definite «الدعوة» to produce
  // «تم نسخ الدعوة.». An indefinite «دعوة» would give «تم نسخ دعوة»,
  // "an invite was copied", which is not what happened. This is the key where
  // the host sentence, not the English word, decides the form.
  'guild.invites.clipboardName': 'الدعوة',

  'guild.invites.list.title': 'روابط الدعوة',
  'guild.invites.tableLabel': 'روابط الدعوة',
  'guild.invites.empty': 'لم تُنشأ أي دعوات.',
  // The invite's short code. «الرمز» is the same noun used for a verification
  // code in `ar.js` (`errors.invalid_mfa_code`), which is right: both are
  // short strings a person matches by eye.
  'guild.invites.colCode': 'الرمز',
  'guild.invites.colUses': 'الاستخدامات',
  'guild.invites.colExpires': 'انتهاء الصلاحية',
  // "Created by". A verb again, like `guild.gates.curators.colSource`, because
  // «المنشئ» as a noun is formal to the point of sounding theological.
  'guild.invites.colCreator': 'أنشأها',
  'guild.invites.uses': '{used, number}',
  // Two formatted numbers and a slash, kept in English's order. Both values go
  // through `Intl.NumberFormat` for the active locale, so they arrive as
  // Arabic-Indic digits without this file doing anything.
  //
  // BIDI LAYOUT RISK, reported: the slash is a neutral character between two
  // numeric runs inside an RTL paragraph, and which side of it the larger
  // number lands on depends on how the bidi algorithm resolves the run
  // boundaries. No mark was inserted; if it renders reversed, the cell needs
  // `dir` or `unicode-bidi: isolate` in CSS, which is a layout fix and not a
  // catalogue one.
  'guild.invites.usesOf': '{used, number} / {max, number}',
  // Past, not progressive: it has expired. Feminine, agreeing with الدعوة.
  'guild.invites.expired': 'منتهية',
  // إبطال, not إلغاء. `common.cancel` is already «إلغاء» and means backing out
  // of what you are doing; revoking an invite is destroying a credential that
  // is already out in the world. Two acts, two words.
  'guild.invites.revoke': 'إبطال',
  // `{code}` is the invite code and is read as itself.
  'guild.invites.revokeInvite': 'إبطال الدعوة {code}',
  'guild.invites.revokeFailed': 'تعذّر إبطال الدعوة',

  // ----------------------------------------------------------------- audit log

  'guild.audit.tableLabel': 'سجلّ التدقيق',
  // Not "empty": a log with nothing in it means nothing auditable has happened
  // since the record started, which is a fact about time. «لم يُسجَّل شيء بعد»
  // keeps the "yet" that carries that; «السجلّ فارغ» would not.
  'guild.audit.empty': 'لم يُسجَّل شيء بعد.',
  'guild.audit.colWhen': 'الوقت',
  // Always an account, never the server -- so «المنفِّذ», the one who carried
  // the action out, rather than «الفاعل», which in Arabic grammar means the
  // subject of a sentence and would read as jargon from a different field.
  'guild.audit.colActor': 'المنفِّذ',
  // The column header is translated; the codes in the cells beneath it are
  // not, and the long note at the top of `en/guild.js` explains why this
  // catalogue gives none of them a human name. Nothing was added here to
  // change that.
  'guild.audit.colAction': 'الإجراء',
  'guild.audit.colTarget': 'الهدف',

  // ---------------------------------------------------------- emoji and stickers

  'guild.expressions.emoji.title': 'الرموز التعبيرية المخصّصة',
  'guild.expressions.emoji.add': 'إضافة رمز تعبيري',
  'guild.expressions.emoji.emptyTitle': 'لا رموز تعبيرية مخصّصة بعد',
  // LEFT PARTLY IN ENGLISH. PNG, GIF, WebP and JPEG are format names and stay
  // in Latin letters -- they are what the file picker and the operating system
  // will show. «الرمز المختصر» is the shortcode, the `:name:` form typed in
  // the composer, and it must be the same phrase the composer's own picker
  // uses.
  //
  // BIDI LAYOUT RISK, reported: four Latin tokens separated by the Arabic
  // «أو» inside one RTL clause. Nothing isolates them because they are
  // literal, not interpolated. No marks inserted.
  'guild.expressions.emoji.emptyBody': 'ارفع ملف PNG أو GIF أو WebP أو JPEG؛ ويصبح اسم الملف هو الرمز المختصر. ويعيد الخادم ترميزه ويصغّره ليناسب المقاس.',
  // The colons around `{name}` are the shortcode syntax, not quotation marks,
  // and they stay. Arabic quotation marks were deliberately not substituted:
  // they would change what the tooltip appears to be naming.
  'guild.expressions.emoji.remove': 'إزالة :{name}:',
  // Feminine verb agreeing with إضافة, the implied subject. Arabic prefers
  // «تعذّرت الإضافة» to a masculine impersonal here because the noun is
  // present in the sentence.
  'guild.expressions.emoji.addFailed': 'تعذّرت إضافة الرمز التعبيري',
  'guild.expressions.removeFailed': 'تعذّرت الإزالة',

  // ملصق is the settled Arabic for a sticker in the chat sense and needs no
  // gloss; it is also literally "something stuck on", which is the same
  // metaphor English uses.
  'guild.expressions.stickers.title': 'الملصقات',
  'guild.expressions.stickers.add': 'إضافة ملصق',
  'guild.expressions.stickers.emptyTitle': 'لا ملصقات بعد',
  // Says where they turn up, because the complaint this line answers is from
  // somebody who uploaded one and never saw it again. «منتقي الرموز التعبيرية»
  // is the emoji picker, named with the same phrase used above so the reader
  // can go and find it.
  'guild.expressions.stickers.emptyBody': 'تُختار الملصقات من منتقي الرموز التعبيرية وتُرسل وحدها.',
  'guild.expressions.stickers.addFailed': 'تعذّرت إضافة الملصق',

  // ------------------------------------------------------------- voice regions
  //
  // منطقة for a region and مُرحِّل for a relay. مُرحِّل is the standard Arabic
  // networking term for a relay (the active participle of رحّل, "to forward
  // on") and it is not a coinage; «ريلاي» would be. SFU, TURN and CORS stay in
  // Latin letters throughout this section, because the person adding a region
  // has their relay's own documentation open in the next window and those
  // three words are their index into it.
  //
  // «المناطق الصوتية» uses the adjectival form rather than a genitive
  // («مناطق الصوت»), matching `ar.js`'s own «القنوات الصوتية» for voice
  // channels in `perms.group.voice`.

  'guild.voice.regions.title': 'المناطق الصوتية',
  // صيغة الأمر -- this tells the reader to do something. «بعينها» carries
  // English's "individual": particular channels, as opposed to the guild-wide
  // default.
  'guild.voice.regions.description': 'أضف مُرحِّلك الخاص لتستخدمه هذه النقابة أو قنوات صوتية بعينها.',
  // The `<code>` tag is required by the calling code and marks the value as an
  // address rather than a word. It is kept, the name inside it is untouched,
  // and nothing was added around it -- a tag the code does not supply renders
  // as nothing, and a tag dropped here would render the address as prose.
  'guild.voice.serverDefault': 'افتراضي الخادم: <code>{name}</code>',
  'guild.voice.serverDefaultNone': 'لا يوجد افتراضي للخادم.',
  'guild.voice.guildDefault': 'افتراضي النقابة: <code>{name}</code>',

  'guild.voice.tableLabel': 'المناطق الصوتية',
  // «مهيّأة» -- configured -- rather than «موجودة». The distinction is real:
  // the server may offer regions that this guild has not set up, and the
  // sentence is about what this guild has configured.
  'guild.voice.empty': 'لا توجد مناطق مهيّأة.',
  'guild.voice.colName': 'الاسم',
  // LEFT IN ENGLISH. A protocol term and the column the reader came for.
  'guild.voice.colSfu': 'SFU',
  'guild.voice.colType': 'النوع',
  // «السلامة», not «الحالة». This column reports whether the server's own
  // health probe passed; the feeds table's Status column is «الحالة». Two
  // columns in two tables reporting two different kinds of fact, so two words.
  'guild.voice.colHealth': 'السلامة',
  // English has "custom" / "server", an adjective beside a bare noun. Arabic
  // makes them parallel -- «من النقابة» / «من الخادم», both saying where the
  // region came from, which is what the English note says the column means.
  // An adjective/noun mix would read as a broken column in Arabic, where the
  // two cells sit directly above one another.
  'guild.voice.typeCustom': 'من النقابة',
  'guild.voice.typeServer': 'من الخادم',
  // The server's opinion, not the browser's. Feminine, agreeing with منطقة.
  // Kept as bare adjectives with no article, which is the Arabic equivalent of
  // English's lowercase telegraphic style in a status column.
  'guild.voice.healthOk': 'سليمة',
  'guild.voice.healthDown': 'متعطّلة',
  // The title on the star glyph, and the only thing that tells a screen reader
  // what the star means. Same phrase as `guild.voice.guildDefault`'s opener so
  // the two are recognisably about the same setting.
  'guild.voice.defaultMarker': 'افتراضي النقابة',
  // مصدر for the button. Feminine object pronoun, agreeing with منطقة.
  'guild.voice.makeDefault': 'جعلها الافتراضية',
  // The accessible name of the same button, with `{name}` in the object slot.
  // REORDERED: English puts the name between the verb and the complement
  // ("Make {name} the guild default"); Arabic puts the verb first and then the
  // object, so the placeholder moves to second position and «للنقابة» goes to
  // the end. The value is isolated by the runtime, so its Latin letters do not
  // disturb the Arabic around it.
  'guild.voice.makeDefaultRegion': 'جعل {name} الافتراضية للنقابة',
  'guild.voice.removeRegion': 'إزالة {name}',
  'guild.voice.loadFailed': 'تعذّر تحميل المناطق الصوتية',
  'guild.voice.addFailed': 'تعذّرت إضافة المنطقة الصوتية',
  'guild.voice.defaultFailed': 'تعذّر تعيين المنطقة الافتراضية',
  // The parenthetical is the usual cause and is worth its words: the fix is to
  // move the channel, not to press the button again. «ما تزال مستخدَمة» keeps
  // the "still", which is what says the region is held rather than missing.
  'guild.voice.removeFailed': 'تعذّرت إزالة المنطقة (قد تكون ما تزال مستخدَمة في قناة)',

  // ------------------------------------------------------- adding a region

  'guild.voice.add.title': 'إضافة منطقة',
  // A question, because the step asks one thing. Arabic fronts the
  // interrogative the same way English does, so nothing moves.
  'guild.voice.add.step1Title': 'أين المُرحِّل؟',
  // LEFT PARTLY IN ENGLISH (SFU). «يجوز لهذه النقابة الاتصال به» -- may dial:
  // permission, not capability, which is the sense the pane needs.
  'guild.voice.add.step1Body': 'عنوان SFU يجوز لهذه النقابة الاتصال به.',
  // LEFT PARTLY IN ENGLISH (SFU).
  'guild.voice.add.sfuLabel': 'عنوان SFU',
  // LEFT IN ENGLISH. A URL. `example.com` is RFC 2606 reserved, the `https://`
  // is the part the field is trying to teach, and the host label `sfu` is left
  // as it is because it is read directly against the `SFU address` label above
  // it -- translating it to «مُرحِّل» would break that echo and would also
  // produce a hostname nobody could type.
  'guild.voice.add.sfuPlaceholder': 'https://sfu.example.com',

  // LEFT PARTLY IN ENGLISH. A correction, not a refusal: the field keeps what
  // was typed and this says what to do next, so صيغة الأمر.
  //
  // BIDI LAYOUT RISK, reported and not patched: the sentence ends with a
  // hard-coded Latin URL followed by a full stop. The URL is literal, so
  // `isolate` never sees it, and the final stop is a neutral between an LTR
  // run and the end of an RTL paragraph. It should resolve to the paragraph
  // direction and land at the correct end, but that is a prediction about the
  // bidi algorithm rather than something observed on a rendered line. No
  // U+200F was inserted; if it renders wrong the fix belongs in the CSS that
  // draws the hint.
  'guild.voice.address.needsHost': 'أضف المضيف بعده، مثل https://sfu.example.com.',
  // LEFT PARTLY IN ENGLISH (`http`, `https`). `{scheme}` is whatever the
  // reader typed -- ws, wss, turn -- and is shown back unchanged; it is
  // interpolated, so the runtime isolates it and it is *not* a bidi risk. The
  // two literal scheme words are, for the same reason as the URL above.
  'guild.voice.address.wrongScheme': 'يُتصل بالمنطقة عبر http أو https، لا عبر {scheme}.',
  // LEFT PARTLY IN ENGLISH (`https://`). The explanation is the important
  // half, and it is kept whole: a bare host is not rejected, it is *resolved*
  // against this page, which is why the resulting region looks alive. «يُقرأ
  // كجزء من عنوان هذه الصفحة» is that, literally.
  //
  // «ابدأ بـ https://» uses the tatweel form of the preposition, بـ, which is
  // the standard Arabic orthography for attaching a one-letter preposition to
  // a Latin token. It is a letter, not a bidi control character.
  'guild.voice.address.bareHost': 'ابدأ بـ https:// — فالمضيف المجرّد يُقرأ كجزء من عنوان هذه الصفحة، لا كخادم.',

  // The crumb back to step one, named for what is there.
  'guild.voice.add.crumb': 'العنوان',
  // A step heading that is an instruction, so صيغة الأمر, feminine object
  // agreeing with منطقة. «التسمية» as a bare noun would have been the other
  // option and reads as a section label rather than as a step.
  'guild.voice.add.step2Title': 'سمِّها',
  'guild.voice.add.nameLabel': 'اسم المنطقة',
  // «منتقي المناطق» is the region picker, built on the same منتقي used for the
  // emoji picker above -- one word for one kind of control.
  'guild.voice.add.nameHint': 'الاسم الذي يظهر به هذا المُرحِّل في منتقي المناطق داخل القناة.',
  // LEFT IN ENGLISH. The English note allows either. It is left because the
  // lowercase-hyphenated shape *is* the information -- it shows what region
  // names look like in practice, and an Arabic placeholder would show a shape
  // no existing region uses. Region names also sit in a column beside SFU
  // addresses, where a Latin stand-in reads as an example and an Arabic one
  // would read as a real region somebody had added.
  'guild.voice.add.namePlaceholder': 'my-relay',
  // LEFT PARTLY IN ENGLISH (TURN, RFC 8656). Only the parenthetical is
  // translated, and it reuses `common.optional`'s «اختياري» rather than
  // inventing a second word for the same idea.
  'guild.voice.add.turnLabel': 'TURN (اختياري)',
  // LEFT IN ENGLISH. A host and port. `example.com` is reserved; 3478 is the
  // registered TURN port and is data, not a number to localise.
  'guild.voice.add.turnPlaceholder': 'turn.example.com:3478',
  // A checkbox label, so a مصدر phrase like the buttons. Feminine
  // demonstrative agreeing with منطقة.
  'guild.voice.add.makeDefault': 'جعل هذه هي الافتراضية للنقابة',
  'guild.voice.add.submit': 'إضافة المنطقة',

  // ------------------------------------------------------------- the probe
  //
  // Every verdict here is written against one misreading -- that a failure
  // means the address is wrong -- and the vagueness is the accurate part. The
  // Arabic is held to the same line: no verdict says the region is broken, no
  // verdict says it cannot be added, and each one ends somewhere the reader
  // can act. Arabic makes it easy to sound more decisive than this (the
  // language reaches for «لا يعمل» before «لم يُجب») and every one of these was
  // written away from that.
  //
  // فحص is the probe, kept distinct from فرز (screening, in the gates pane)
  // and from تدقيق (audit). Three English words, three Arabic ones.

  // «جارٍ …», the house in-flight form. «متصفّحك» -- your browser, second
  // person -- because the measurement was made from this machine.
  'guild.voice.probe.checking': 'جارٍ التحقّق مما إذا كان متصفّحك يستطيع الوصول إليه…',
  'guild.voice.probe.recheck': 'فحص إمكانية الوصول',
  // "Your browser" and not "we". Arabic fronts the verb, so the subject moves
  // to the end of the sentence: «وصل إليه متصفّحك» is literally "reached it,
  // your browser did". The emphasis lands in the same place either way.
  'guild.voice.probe.reachable.title': 'وصل إليه متصفّحك.',
  // The trust prerequisite, attached to the *good* verdict on purpose. «ومع
  // ذلك» opens it because Arabic needs an explicit concessive where English
  // can carry it on "still". The em dash and the two-things contrast are kept:
  // being up and accepting this guild are «أمران مختلفان».
  'guild.voice.probe.reachable.body': 'ومع ذلك يجب تهيئة أي SFU خاص ليثق بهذه النقابة قبل أن تنجح أي مكالمة — فكونه يعمل وكونه يقبل هذه النقابة أمران مختلفان.',
  // "It did not answer" -- a report of what happened, not a diagnosis. «لم
  // يُجب» and nothing else; «لا يستجيب» would claim the present tense and
  // therefore claim more than was measured.
  'guild.voice.probe.unreachable.title': 'لم يُجب.',
  // Three sentences, three jobs: the two possible causes, the thing to check,
  // and the permission to proceed. «في الحالتين» keeps "either way", which is
  // the sentence that stops somebody abandoning a working relay.
  'guild.voice.probe.unreachable.body': 'قد يعني ذلك أن المُرحِّل متعطّل، أو أنه ببساطة لا يجيب طلبات المتصفّحات. وإن كان SFU خاصًا فتحقّق من تهيئته ليثق بهذه النقابة. ويمكنك إضافته في الحالتين وتجربة مكالمة.',
  'guild.voice.probe.unverified.title': 'تعذّر الفحص من هنا.',
  // "normal" is doing the work and «أمر طبيعي» is where it does it: this
  // verdict fires for most correctly configured private relays, and a
  // translation that made it sound like a problem would send people to debug
  // something that is not broken.
  //
  // The verb for what happened to the browser is «أُوقف» (it was stopped) and
  // deliberately not «مُنع»: منع is the blocklist term of art in this
  // namespace, and using it here would suggest the guild's own origin rules
  // did this, which is the opposite of true -- the browser stopped the request
  // on its own.
  //
  // LEFT PARTLY IN ENGLISH (SFU, CORS). «فـ SFU» again uses the tatweel form
  // of the prefixed conjunction, which is orthography and not a bidi control.
  'guild.voice.probe.unverified.body': 'أُوقف المتصفّح قبل أن يصله جواب، وهذا أمر طبيعي: فـ SFU الذي لا يرسل ترويسات CORS سليم تمامًا ولا يمكن فحصه من صفحة ويب فحسب. هذه إشارة لا حكم — أضفه وجرّب مكالمة.',

  // Heard, never drawn. Each names the state rather than the icon: a screen
  // reader announces neither a tick nor a colour, so «علامة صح» would be
  // describing a picture nobody can see.
  'guild.voice.probe.a11yChecking': 'جارٍ فحص العنوان',
  'guild.voice.probe.a11yReached': 'تم الوصول إليه',
  'guild.voice.probe.a11yFailed': 'تعذّر الوصول إليه من هذا المتصفّح',

// ============================================================================
  // ar: roles + channel + bots. The glossary, as a set, before the entries.
  // ============================================================================
  //
  // These three namespaces are one vocabulary read from three screens, so the
  // words below were chosen once and then held everywhere. They are written out
  // here as a set rather than each beside its first use, because the failure
  // this guards against is not a bad word -- it is two good words for one
  // thing. A reader who meets «تجاوز» in the role editor and «استثناء» in the
  // channel dialog has been told there are two mechanisms.
  //
  //   permission        صلاحية / الصلاحيات      -- fixed already by ar.js:
  //                     `errors.missing_permission` says «تحتاج إلى صلاحية
  //                     «{permission}»» and `errors.status.403` says «لا تملك
  //                     صلاحية». `إذن` (plural أذونات) is the other candidate
  //                     and is what some Arabic chat clients use, but the
  //                     shipped catalogue already committed, and the error
  //                     layer and the switch have to say the same word.
  //   capability        إمكانية / الإمكانات     -- deliberately NOT صلاحية. A
  //                     capability is what the wire can name; a permission is
  //                     authority over this guild. `bots.capability.*` is drawn
  //                     over both intent rows and permission rows, so it needs
  //                     the wider, flatter noun.
  //   role              دور / الأدوار
  //   channel           قناة / القنوات
  //   category          فئة                     -- a shelf channels sit under.
  //                     Not «قسم» (section), which is what a *group of rooms*
  //                     would be in a forum, and not «تصنيف» (classification),
  //                     which is what a tag does.
  //   guild             نقابة                   -- already fixed by ar.js
  //                     (`settings.messages.typing.hint` says «خوادم
  //                     النقابات»). The sibling `guild` fragment must match.
  //   member            عضو / أعضاء
  //   overwrite         تجاوز / تجاوزات         -- "override". Chosen over
  //                     «استثناء» (exception), which describes what it does but
  //                     is not the API's noun, and over a transliteration. The
  //                     hint sentence explains the exception idea in prose, so
  //                     the noun does not have to.
  //   allow/deny/inherit  إتاحة / منع / وراثة   -- see the long note at
  //                     `channel.perms.allow`: all three must be مصدر forms
  //                     that can head an iḍāfa, because `channel.perms.
  //                     choiceLabel` glues one of them straight on to a
  //                     permission name.
  //   tag               وسم / وسوم
  //   thread            سلسلة / سلاسل           -- NOT «موضوع», which this
  //                     namespace has already spent on `channel.field.topic`.
  //   post (forum)      منشور / منشورات
  //   slowmode          الوضع البطيء            -- the settled Arabic for a
  //                     per-person send cooldown; survives being said out loud
  //                     in a moderation channel, which a paraphrase would not.
  //   bot               روبوت / روبوتات         -- see `bots.install.unnamed`.
  //   intent            اشتراك / اشتراكات       -- see `bots.install.
  //                     intentsTitle`. Never «نيّة», the cognate.
  //   grant (verb/noun) the root م-ن-ح: منح، ما مُنِح، الممنوحة. One root, three
  //                     shapes, because Arabic does not have one invariant noun
  //                     that covers "a grant", "granted" and "to grant".
  //   homeserver        الخادم الرئيسي          -- fixed by ar.js
  //                     (`common.homeserver`).
  //   gateway           البوّابة                -- fixed by ar.js
  //                     (`errors.gateway.*` sits under «إغلاق البوّابة»).
  //   emoji             إيموجي                  -- see `channel.tags.
  //                     emojiPlaceholder` for why the loan beats «الرموز
  //                     التعبيرية».
  //
  // ---------------------------------------------------------------- register
  //
  // Modern Standard Arabic, and **one** convention for controls, held across
  // all 260 keys:
  //
  //   * A **control** -- a button, a tab, a field label, an accessible name --
  //     takes the **مصدر** (verbal noun): «حفظ», «إنشاء دور», «إضافة»,
  //     «تعديل {role}». This is what ar.js already does (`common.save` is
  //     «حفظ», not «احفظ») and it is the universal Arabic UI convention: a
  //     button names an act, it does not order the reader about.
  //   * A **sentence addressed to the reader** takes **صيغة الأمر**, masculine
  //     singular: «اسحب دورًا…», «الصق المرجع…», «انتبه، لديك…». Again ar.js
  //     already does this (`errors.mfa_required` is «أدخل الرمز»).
  //
  // The line between the two is whether the string is the name of a thing or
  // an instruction about what to do next. Where a key is both -- a search box
  // whose accessible name and placeholder are one string -- the مصدر wins,
  // because the accessible name is read out of context and a bare imperative
  // heard alone is a command with no object.
  //
  // Failure toasts keep ar.js's «تعذّر …» and carry **no full stop**: they are
  // the left half of `errors.context` (`'{context}: {message}'`) and a period
  // before that colon is a sentence broken in two.
  //
  // Quotation marks are «…», the Arabic pair, per the doc's instruction that a
  // language with its own pair should use them. ar.js already does this in
  // `errors.missing_permission`.
  //
  // ------------------------------------------------------- the six plural arms
  //
  // Eight patterns below carry a `plural`; one of them (`channel.tags.limit`)
  // carries two in one sentence. Every one declares zero/one/two/few/many/
  // other. The arms mean: 0 · 1 · 2 (the real dual, and it is used) · 3-10
  // (plural noun, genitive) · 11-99 (**singular** noun, accusative تمييز) ·
  // 100+ (**singular** noun, genitive). The last is the arm that catches
  // people: after a hundred the noun goes back to the singular, so «١٠٠ عضو»
  // and «٣ أعضاء» are both correct and «١٠٠ أعضاء» is not.
  //
  // Where two arms come out byte-identical it is said at the entry and why. The
  // commonest reason here is orthographic rather than grammatical: `many` wants
  // an accusative تمييز and `other` a genitive one, and for a noun ending in ة
  // the two are spelled the same in unvowelled text. That is a fact about how
  // this file is written, not about the language, which is exactly why both
  // arms are still present.
  //
  // No pattern in these three namespaces has an `=0` exact arm in the English,
  // so none is preserved here; if one is ever added it goes *alongside* the six.
  //
  // --------------------------------------------------- bidi, and what is not fixed
  //
  // No bidi control characters anywhere in this fragment: direction is set on
  // `<html>` by `applyDocument`, interpolated values are isolated by `isolate`
  // in `lib/i18n/index.js`, and a catalogue that smuggled in RLM marks would be
  // hiding a layout bug rather than fixing one. Six strings below carry a
  // *literal* Latin token that `isolate` never sees because it is not a
  // placeholder, and each is flagged at its entry as a layout issue rather than
  // patched here.

  // ==== roles

  // The rule the whole screen obeys. The English rank metaphor is vertical and
  // so is Arabic's -- فوق / أعلى / دونه are the ordinary words for standing
  // over somebody in a hierarchy -- so the metaphor is kept rather than
  // replaced, and it is then used in all four places the header names:
  // here, `roles.editor.notEditable`, `roles.list.description` and
  // `roles.display.hoistHint`.
  //
  // «إلا من كان فوقه» is an exclusive construction (ما/لا … إلا), which is how
  // Arabic says "only" without a separate adverb; it puts the restriction on
  // the actor, which is what the English "only … by somebody above it" does.
  'roles.list.hint': 'لا يستطيع تعديل دور أو نقله أو منحه إلا من كان فوقه.',

  // A heading, not the role's name, so «الصلاحيات الافتراضية» is definite --
  // it names the one set of permissions this guild starts everybody with.
  'roles.everyone.title': 'الصلاحيات الافتراضية',
  'roles.everyone.description': 'ما يستطيع كل عضو في هذه النقابة فعله قبل منح أي دور.',

  // All six arms, and the noun takes four different shapes across them.
  //
  // `zero` is «لا أعضاء» rather than «٠ عضو»: this is drawn as visible text
  // under @everyone and read aloud beside every other row, and an Arabic reader
  // meeting a bare zero in a count phrase reads a placeholder, not a fact. It
  // follows ar.js's own `common.convo.group`, whose zero arm is «لا أحد».
  // `one` and `two` drop the `#` entirely, again as ar.js does: «عضو واحد» and
  // «عضوان» already carry the number in the noun's own shape, and printing the
  // digit beside them would be saying it twice. `#` is not a named placeholder
  // -- the coverage test counts `{name}` arguments, and the pound is a plural's
  // own number -- so dropping it in an arm is not a dropped placeholder.
  // `few` (3-10): plural noun, genitive -- «# أعضاء».
  // `many` (11-99): singular noun, accusative تمييز -- «# عضوًا», with the alif
  // of tanwīn visible because عضو is masculine and the alif is written.
  // `other` (100+): singular noun, genitive -- «# عضو». This is the arm a
  // translator copying English gets wrong, because English says "100 members"
  // and Arabic says the equivalent of "100 member".
  'roles.memberCount': '{count, plural, zero {لا أعضاء} one {عضو واحد} two {عضوان} few {# أعضاء} many {# عضوًا} other {# عضو}}',

  // The heading over the draggable list. English writes both arms the same and
  // its comment says why: the noun is a heading rather than a count phrase, so
  // English does not inflect it, and a language that agrees a heading with the
  // number following it "has nowhere else to say so". Arabic is exactly that
  // language, so the invitation is taken: the dash is dropped and the heading
  // becomes the ordinary Arabic counted phrase, which still contains the word
  // «أدوار» and so still names the section for somebody scanning the page.
  // Keeping «الأدوار - #» would have produced six identical arms for no reason
  // beyond copying English's punctuation.
  'roles.list.title': '{count, plural, zero {لا أدوار} one {دور واحد} two {دوران} few {# أدوار} many {# دورًا} other {# دور}}',
  // Imperative: this is an instruction about what to do with the list, not the
  // name of a control. «من يعلو على من» keeps the vertical metaphor.
  'roles.list.description': 'اسحب دورًا لتغيير من يعلو على من.',

  // مصدر, because it is a button. Indefinite «دور»: no particular role exists
  // yet. `roles.create.title` below is the same two words -- Arabic has no
  // case, so English's "Create Role" / "Create role" distinction has nothing to
  // land on -- and the two keys are written out separately anyway, because the
  // day the dialog heading grows a word the button must not grow it too.
  'roles.list.create': 'إنشاء دور',
  // Accessible name *and* placeholder in one key. The مصدر wins for the reason
  // given in the register note: this string is read aloud out of context.
  'roles.list.search': 'البحث في الأدوار',

  'roles.list.empty.title': 'لا أدوار بعد',
  'roles.list.empty.body': 'كل من هنا يملك الصلاحيات الافتراضية ولا شيء غيرها.',

  // «{query}» in the Arabic pair. The verb is fronted (لا يطابق … أي دور) so
  // the isolated Latin-or-Arabic query sits in the middle of the sentence
  // rather than at its edge, where a stray neutral would be ambiguous.
  'roles.list.noMatch': 'لا يطابق «{query}» أي دور.',

  // Row controls, named for the role they act on. مصدر + the interpolated name,
  // which reads as an iḍāfa and is the natural Arabic for a control's name.
  'roles.row.edit': 'تعديل {role}',
  'roles.row.delete': 'حذف {role}',

  'roles.create.title': 'إنشاء دور',
  'roles.create.nameLabel': 'اسم الدور',
  'roles.create.confirm': 'إنشاء',
  // No full stop: this is the left half of `errors.context`.
  'roles.create.failed': 'تعذّر إنشاء الدور',

  // English keeps this apart from `roles.row.delete` because a heading and a
  // tooltip are written differently in several languages. Arabic is not one of
  // them -- the مصدر serves both -- so the two coincide, and they are written
  // out twice rather than deduplicated, because the distinction is real even
  // where the wording is not.
  'roles.delete.title': 'حذف {role}',
  // Fronting the subject («تجاوزات القنوات …») makes the loss the topic of the
  // sentence, which is the point: the surprise is what goes *with* the role.
  'roles.delete.body': 'تجاوزات القنوات التي تسمّي هذا الدور تُحذف معه.',
  'roles.delete.failed': 'تعذّر حذف الدور',

  // Feminine verb agreement: the subject is «إعادة», not «الأدوار».
  'roles.reorder.failed': 'تعذّرت إعادة ترتيب الأدوار',

  'roles.editor.back': 'العودة إلى الأدوار',

  // @everyone stays exactly those nine characters: it is what somebody types
  // into the composer, and a translated form would be a word that pings nobody.
  // The sentence is rebuilt around it so the token is not sentence-initial.
  //
  // LAYOUT RISK, not patched here: `@` is a bidi-neutral character. Between the
  // Arabic run before it and the Latin run "everyone" after it, the UBA resolves
  // it to the paragraph level (RTL), which puts it on the far side of the word
  // it belongs to -- the reader sees the equivalent of "everyone@". No RLM/LRM
  // is inserted to hide that; the right fix is an isolate around the literal in
  // the component, the same treatment `isolate` gives an interpolated value.
  // The same flag applies to `roles.display.mentionable`,
  // `channel.create.privateHint`, `channel.createCategory.privateHint`,
  // `channel.perms.privateHintOn` and `channel.perms.privateHintOff`.
  'roles.everyone.locked': 'لا يمكن نقل @everyone ولا إعادة تسميته ولا حذفه.',

  // The two bot-role notices. «يخصّ» (belongs to) rather than «مملوك لـ», which
  // would suggest ownership of the role as property; the point is provenance.
  // The em dash is kept from the English: it is a bidi-neutral character
  // between two Arabic runs, so it resolves to the paragraph direction and sits
  // where it is written. `{permission}` arrives already translated from
  // `perms.manage_guild.label` and is isolated, so it needs nothing here.
  'roles.managed.canManageGuild': 'هذا الدور يخصّ روبوتًا مثبَّتًا. أنشأه التثبيت ولا يمكن تعديله هنا — غيّر ما يُسمح للروبوت بفعله من صفحة الروبوتات في هذه الإعدادات.',
  // The second half of the pair, for a reader who cannot act: it ends on the
  // name of the permission, which is the whole point of the sentence. «وهي
  // تحتاج إلى {permission}» -- the feminine pronoun refers to «صفحة», the page,
  // which is what actually needs the permission.
  'roles.managed.needsManageGuild': 'هذا الدور يخصّ روبوتًا مثبَّتًا. أنشأه التثبيت ولا يمكن تعديله هنا. وما يُسمح للروبوت بفعله يُغيَّر من صفحة الروبوتات، وهي تحتاج إلى {permission}.',

  // Stated as what the server will do, not as what the screen is doing, exactly
  // as the English comment demands -- «لن يسمح لك هذا الخادم» names the refuser.
  // «في مرتبة دورك أو أعلى منها» is the rank vocabulary again: مرتبة is the rung
  // and أعلى is the direction.
  'roles.editor.notEditable': 'هذا الدور في مرتبة دورك أو أعلى منها، ولذلك لن يسمح لك هذا الخادم بتغييره.',

  // The three tabs. «المظهر» for Display is the same noun ar.js uses for the
  // theme (`settings.theme.title`); the two never appear on one screen and
  // Arabic has no second everyday word for "how a thing looks". «إدارة الأعضاء»
  // keeps English's two words, because this is a tab you act from rather than a
  // list you read, and the مصدر «إدارة» says so.
  'roles.tab.display': 'المظهر',
  'roles.tab.permissions': 'الصلاحيات',
  'roles.tab.members': 'إدارة الأعضاء',

  'roles.editor.saveFailed': 'تعذّر حفظ الدور',

  // Kept sharp, as the English comment insists. «انتبه» is an imperative and is
  // the ordinary Arabic warning opener; a milder «هناك تغييرات غير محفوظة»
  // would be the neutral sentence the English deliberately refused.
  'roles.editor.unsaved': 'انتبه، لديك تغييرات غير محفوظة.',
  // One word, in a bar a few hundred pixels wide beside «حفظ التغييرات».
  // «تراجع» (revert) rather than «إعادة تعيين» (reset), which is two words and
  // in Arabic UI usually means restoring factory defaults -- which is not what
  // this does. This throws the draft away and returns to the server's copy, and
  // «تراجع» is exactly that.
  'roles.editor.reset': 'تراجع',
  // Not ar.js's `common.save` («حفظ»): this names the set of edits collected
  // across three tabs, so the object is spelled out.
  'roles.editor.save': 'حفظ التغييرات',

  'roles.display.colour': 'لون الدور',
  // «يظهر العضو بـ…» -- the member *appears in* the colour, which is the Arabic
  // idiom; a literal «يرتدي» (wears) would be a metaphor Arabic does not use
  // for colour. The relative clause «وله لون» carries the whole point: highest
  // role that *has* one, not simply highest role.
  'roles.display.colourHint': 'يظهر العضو بلون أعلى دورٍ يحمله وله لون.',
  // Not «أسود» and not «شفاف»: the absence of a colour, which is what the
  // swatch sets. «بلا لون» is the bare privative.
  'roles.display.noColour': 'بلا لون',

  'roles.display.hoist': 'إظهار أعضاء الدور على حدة',
  'roles.display.hoistHint': 'يحصل حاملو هذا الدور على عنوان خاص بهم في قائمة الأعضاء، تحت أعلى دور مُظهَر على حدة يحملونه.',
  // "@mention" is the verb form of the token and stays Latin for the same
  // reason @everyone does -- it names a gesture with a literal spelling. The
  // sentence is built so the token is the object of «استخدام», which keeps it
  // away from the sentence edge.
  //
  // LAYOUT RISK, not patched here: same neutral-`@` problem as
  // `roles.everyone.locked`. See that entry.
  'roles.display.mentionable': 'السماح للجميع باستخدام @mention مع هذا الدور',
  // `{permission}` is `perms.mention_everyone.label`, already translated.
  // «تنبيهه» (to ping it) rather than a transliteration of "ping": Arabic chat
  // usage has settled on the تنبيه root for a notification aimed at somebody.
  'roles.display.mentionableHint': 'بدونه لا يستطيع تنبيهه إلا الأعضاء الذين يملكون {permission}.',

  // The twelve swatch names, translated the way a paint chart would and not the
  // way a CSS keyword list would. The hex values stay in the code and are not
  // referred to here. Each name is the only thing a screen reader has, so no
  // two may collide: the two greens are «أخضر» and «زمردي», the two yellows are
  // «أصفر» and «ذهبي», and the three blues are «أزرق», «نيلي» and «أزرق مخضرّ».
  // «أزرق مخضرّ» is two words where the others are one, which is the
  // qualification the English comment asks for rather than a second «أزرق»:
  // two buttons with the same accessible name cannot be chosen between by voice.
  // All twelve are masculine singular, agreeing with «لون».
  'roles.colour.indigo': 'نيلي',
  'roles.colour.green': 'أخضر',
  'roles.colour.yellow': 'أصفر',
  'roles.colour.pink': 'وردي',
  'roles.colour.red': 'أحمر',
  'roles.colour.teal': 'أزرق مخضرّ',
  'roles.colour.orange': 'برتقالي',
  'roles.colour.purple': 'بنفسجي',
  'roles.colour.blue': 'أزرق',
  'roles.colour.grey': 'رمادي',
  'roles.colour.emerald': 'زمردي',
  'roles.colour.gold': 'ذهبي',

  'roles.permissions.search': 'البحث في الصلاحيات',

  // Consent-adjacent copy and both halves are kept: it grants everything, *and*
  // it walks past the overwrites. «هي كل الصلاحيات» is a flat identity
  // statement, not «تمنح كل الصلاحيات» (grants them) -- the English says *is*,
  // and the stronger reading is the true one. The feminine «هي» and «تتجاهل»
  // agree with «صلاحية», the noun `{permission}` resolves to.
  'roles.permissions.adminNotice': '{permission} هي كل الصلاحيات، وهي تتجاهل تجاوزات القنوات.',
  'roles.permissions.noMatch': 'لا تطابق «{query}» أي صلاحية.',

  // The accessible name -- مصدر, read aloud out of context -- and then the
  // placeholder, which is an instruction the reader is looking straight at and
  // so takes صيغة الأمر. English splits these two keys on purpose and Arabic
  // has a real distinction to put in the gap, which is more than most of the
  // deliberately-split pairs in this file get.
  'roles.members.search': 'البحث عن أعضاء لإضافتهم',
  'roles.members.searchPlaceholder': 'ابحث عن عضو بالاسم',

  'roles.members.matching': 'ما يطابق «{query}»',
  // About the guild, not about the search, exactly as the English comment says:
  // «لا أحد في هذه النقابة» names what was actually checked, which is every
  // member the guild's own server has.
  'roles.members.noMatch': 'لا أحد في هذه النقابة يحمل هذا الاسم.',

  // The other heading English leaves uninflected for a language that needs it,
  // and Arabic needs it. Built as a nominal sentence (subject first) so the
  // verb agrees fully with the subject and every arm is doing work:
  //   zero   no subject at all, so the verb is impersonal singular.
  //   one    «عضو واحد يحمل» -- singular subject, singular verb.
  //   two    «عضوان يحملان» -- the real dual, in the noun *and* in the verb.
  //          This is the arm that disappears in a two-arm translation and it is
  //          the most visible loss in the language.
  //   few    «# أعضاء يحملون» -- plural noun, plural verb.
  //   many   «# عضوًا يحملون» -- singular accusative تمييز, plural verb: the
  //          noun is singular but eleven people are doing the holding, so the
  //          verb agrees with the sense.
  //   other  «# عضو يحملون» -- singular genitive تمييز, plural verb for the
  //          same reason. `many` and `other` differ here only in the noun's
  //          ending, which is exactly the distinction English cannot express.
  // `{role}` appears in every arm; it is the role's own name and is isolated.
  'roles.members.holding': '{count, plural, zero {لا أحد يحمل {role}} one {عضو واحد يحمل {role}} two {عضوان يحملان {role}} few {# أعضاء يحملون {role}} many {# عضوًا يحملون {role}} other {# عضو يحملون {role}}}',

  'roles.members.empty.title': 'لا أحد يحمل هذا الدور',
  // Imperative -- it tells the reader what to do next. «في الأعلى» rather than
  // «أعلاه» because under RTL the search box really is at the top of the pane,
  // and «الأعلى» is spatial where «أعلاه» is textual.
  'roles.members.empty.body': 'ابحث في الأعلى لتمنحه لأحد.',

  // The button. مصدر, and the counterpart of ar.js's `common.remove` («إزالة»),
  // which is the same button on a row of somebody who already holds the role.
  'roles.members.add': 'إضافة',
  // «ذلك العضو» rather than the name, as the English comment asks: the row is
  // still on screen with the name on it.
  'roles.members.addFailed': 'تعذّرت إضافة ذلك العضو',
  'roles.members.removeFailed': 'تعذّرت إزالة ذلك العضو',

  // What an overwrite is. Both directions are kept -- «يضيّق … أو يوسّعها» --
  // because a reader who thinks it only takes away will never find the control
  // that lets one role into one private channel. «السلاسل» is thread; see the
  // glossary for why it cannot be «مواضيع».
  'roles.overwrite.hint': 'يضيّق التجاوز صلاحيات دور واحد داخل قناة واحدة أو يوسّعها. وترث السلاسل قناتها الأم.',

  // One-word field labels, definite because each names the thing chosen under
  // it. `channel.perms.roleLabel` is the same word on the other screen and is
  // kept identical on purpose.
  'roles.overwrite.channel': 'القناة',
  'roles.overwrite.role': 'الدور',

  // The three states, as whole phrases that name no permission -- so a screen
  // reader meeting one alone has been told a state and not a verb, and so that
  // nothing is ever glued together in JavaScript.
  //
  // These are the same three nouns as `channel.perms.deny/inherit/allow`, with
  // the definite article and the locative phrase added. That is the point of
  // the roles.js header's warning about inventing a second word for "allow":
  // the overwrite grid and the role editor are one vocabulary. «إتاحة» rather
  // than «سماح» for allow -- see `channel.perms.allow` for the grammatical
  // reason, which is real and not stylistic.
  //
  // Inherit is «الوراثة من الدور», spelled as what it does, because «افتراضي»
  // (default) would suggest off and the permission may fall through to on.
  'roles.overwrite.inherit': 'الوراثة من الدور',
  'roles.overwrite.allow': 'الإتاحة في هذه القناة',
  'roles.overwrite.deny': 'المنع في هذه القناة',

  // The only place the permission's name is spoken on this control, so it is
  // named in full. Together a screen reader says «إرسال الرسائل في هذه القناة،
  // الإتاحة في هذه القناة» -- two whole things, in either order.
  'roles.overwrite.control': '{permission} في هذه القناة',

  'roles.overwrite.save': 'حفظ التجاوز',
  'roles.overwrite.saved': 'تم حفظ التجاوز.',
  'roles.overwrite.saveFailed': 'تعذّر حفظ التجاوز',

  // ==== channel

  // The shared field labels. Definite, which is the Arabic form a form label
  // takes -- «الاسم», not «اسم» -- because the label names the one field under
  // it. `channel.tags.namePlaceholder` is the indefinite «اسم» for the opposite
  // reason: a placeholder is an example of a value, not a name for the box.
  'channel.field.name': 'الاسم',
  // «الموضوع» is spent here and so is unavailable for "thread"; see the
  // glossary note on سلسلة.
  'channel.field.topic': 'الموضوع',
  'channel.field.category': 'الفئة',
  // A choice, not a state: picking it takes the channel out of its category.
  // «بلا فئة» is the privative, matching «بلا لون» and «بلا حدّ» elsewhere.
  'channel.field.noCategory': 'بلا فئة',
  'channel.field.region': 'المنطقة',
  // A switch label. Feminine singular, and it happens to agree with both nouns
  // it is drawn beside -- «قناة» and «فئة» are both feminine -- which is luck
  // rather than design, and is why `channel.perms.privateLabel` on the settings
  // dialog spells the noun out instead of relying on it.
  'channel.field.private': 'خاصة',

  // The four kinds of room. Three are adjectives agreeing with «قناة» and one
  // («منتدى») is a noun in apposition, because Arabic has no adjective from
  // منتدى and coining one would be worse than the mismatch. The wire's own
  // identifiers (`announcement`, …) are untouched and are not these strings.
  'channel.type.text.name': 'نصية',
  'channel.type.text.description': 'رسائل وسلاسل وملفات.',
  'channel.type.voice.name': 'صوتية',
  'channel.type.voice.description': 'حديث ومشاركة شاشة.',
  'channel.type.forum.name': 'منتدى',
  // «سلسلة قائمة بذاتها» -- a thread standing on its own, which is the fact
  // that makes a forum not a text channel.
  'channel.type.forum.description': 'كل منشور سلسلة قائمة بذاتها.',
  'channel.type.announcement.name': 'إعلانات',
  // Both halves kept: the restriction, and the cross-guild following.
  'channel.type.announcement.description': 'النشر فيها مقيَّد، ويمكن لنقابات أخرى متابعتها.',

  // Indefinite: the dialog is about the act of creating a channel in general.
  // `channel.create.submit` below is definite, for the channel now described on
  // screen. Arabic can draw the distinction English draws with "a channel" /
  // "channel" with the article instead, which is a happy accident of the two
  // languages disagreeing in the same place.
  'channel.create.title': 'إنشاء قناة',

  // Four whole sentences, never one with the kind dropped into it. In Arabic
  // the adjective follows the noun and agrees with it in gender and
  // definiteness, so the English construction (`New ${kind} channel`) could not
  // be assembled here at all -- «قناة نصية جديدة» has the kind in the middle.
  'channel.create.newText': 'قناة نصية جديدة',
  'channel.create.newVoice': 'قناة صوتية جديدة',
  'channel.create.newForum': 'قناة منتدى جديدة',
  'channel.create.newAnnouncement': 'قناة إعلانات جديدة',

  // An example of a channel name an Arabic-speaking guild would actually type,
  // which is what the English comment asks for -- not a transliteration of
  // "general". Arabic has no letter case, so the convention English encodes by
  // lowercasing (channel names are slugs) has nothing to attach to, and this
  // comes out identical to `channel.createCategory.namePlaceholder` below. Both
  // keys are kept.
  'channel.create.namePlaceholder': 'عام',

  // Consequence first, then the undo, in that order.
  //
  // LAYOUT RISK, not patched here: the literal `@everyone`. See
  // `roles.everyone.locked` for the full explanation of the neutral `@`.
  'channel.create.privateHint': 'مخفية عن @everyone. امنحها من جديد في صلاحيات القناة.',

  // The act, definite -- see `channel.create.title`.
  'channel.create.submit': 'إنشاء القناة',
  'channel.create.failed': 'تعذّر إنشاء القناة',

  'channel.createCategory.title': 'إنشاء فئة',
  // Identical to the channel placeholder, for the reason given there.
  'channel.createCategory.namePlaceholder': 'عام',
  // Stronger than the channel version because it is true of more.
  //
  // LAYOUT RISK, not patched here: the literal `@everyone`.
  'channel.createCategory.privateHint': 'مخفية عن @everyone، وكذلك كل ما تحتها.',
  'channel.createCategory.submit': 'إنشاء الفئة',
  'channel.createCategory.failed': 'تعذّر إنشاء الفئة',

  'channel.edit.title': 'تعديل القناة',
  'channel.edit.titleCategory': 'تعديل الفئة',

  // The tabs, in a strip that does not scroll. «نظرة عامة» is two words and is
  // the shortest true rendering of Overview; a one-word «ملخّص» (summary) would
  // fit better and would be saying something else.
  'channel.tab.overview': 'نظرة عامة',
  // The tab heading. `channel.tags.fieldLabel` is the same Arabic word as a
  // field label; both keys are kept, as English keeps both.
  'channel.tab.tags': 'الوسوم',
  'channel.tab.permissions': 'الصلاحيات',

  'channel.edit.save': 'حفظ التغييرات',
  'channel.edit.saveFailed': 'تعذّر تحديث القناة',
  // A separate key, not one sentence with the noun interpolated -- and Arabic
  // is one of the languages that needs it: «الفئة» and «القناة» are both
  // feminine here, so nothing visibly changes, but a third noun in this family
  // would not be, and the key is the only place that could be said.
  'channel.edit.saveFailedCategory': 'تعذّر تحديث الفئة',

  'channel.edit.topicHint': 'يظهر في الترويسة.',
  // «فيمَ» is the contracted interrogative (في + ما), which is how Arabic asks
  // "what for". The voice variant keeps «غرفة» against «قناة», because a voice
  // channel is a room people are *in*, and Arabic has the distinction too.
  'channel.edit.topicPlaceholder': 'فيمَ تُستخدم هذه القناة؟',
  'channel.edit.topicPlaceholderVoice': 'فيمَ تُستخدم هذه الغرفة؟',

  // Slowmode. «الوضع البطيء» is the settled Arabic term of art; it is what
  // moderators say to each other, and it survives being said out loud, which a
  // descriptive paraphrase («إعداد تأخير الرسائل») would not.
  'channel.edit.slowmodeLabel': 'الوضع البطيء',
  // The parenthetical does real work -- a voice channel's slowmode is about the
  // typing under it, not the talking -- so it is kept.
  'channel.edit.slowmodeChatLabel': 'الوضع البطيء (المحادثة)',
  // «إدارة الرسائل» is the permission `perms.manage_messages.label` will be
  // called; it is spelled here as a described ability rather than as a named
  // switch, which in Arabic means it takes no quotation marks and no article
  // games. This is one of the terms this fragment is fixing for `perms`.
  'channel.edit.slowmodeHint': 'كل من يستطيع إدارة الرسائل معفى منه.',

  'channel.edit.previewsLabel': 'إظهار معاينات الروابط',
  // The reassurance is the point and it is kept flat: «في الحالتين» -- either
  // way -- is the whole sentence's load.
  'channel.edit.previewsHint': 'تُجلب عبر وسيط النقابة نفسه في الحالتين.',

  'channel.edit.expiryLabel': 'انتهاء صلاحية الملفات',
  // Two facts, two sentences, unit first -- the order English chose and the
  // order a person typing into the box needs.
  'channel.edit.expiryHint': 'بالثواني. والفارغ يرجع إلى سقف النقابة.',
  // "Channel" is load-bearing: the guild's cap still applies, and this says
  // only that the channel adds none of its own. «لا حدّ من القناة» keeps the
  // source of the limit in the sentence.
  'channel.edit.expiryPlaceholder': 'لا حدّ من القناة',
  'channel.edit.fileSizeLabel': 'حد حجم الملف',
  'channel.edit.fileSizeHint': 'بالبايت. والفارغ يرجع إلى سقف النقابة أو الخادم. للمرفقات فقط.',
  'channel.edit.fileSizePlaceholder': 'لا حدّ في هذه القناة',

  // The zero rung of the slowmode ladder, and deliberately not ar.js's
  // `common.off` («معطّل»), which is the state of a toggle. This is an option
  // in a list of durations and means "no wait at all", so it is spelled as a
  // duration: «بلا انتظار». Arabic needs the split for the same reason German
  // does.
  'channel.slowmode.off': 'بلا انتظار',
  // The three duration rungs, all six arms each.
  //
  // `zero` keeps the `#` here, unlike `roles.memberCount`: this is a list of
  // durations and «٠ ثانية» is a duration, where «لا ثواني» would be a refusal.
  // (The rung is not reachable today -- `channel.slowmode.off` covers it -- but
  // the arm is a fact about the sentence, not about today's ladder.)
  // `one` and `two` drop the `#` and carry the number in the noun: «ثانية
  // واحدة», «ثانيتان» -- the dual suffix ـان *is* the two.
  // `many` and `other` come out byte-identical for all three units, and that is
  // orthography rather than grammar: 11-99 takes the accusative تمييز and 100+
  // the genitive, but ثانية / دقيقة / ساعة all end in ة, whose tanwīn is not
  // written in unvowelled text. Both arms are still spelled out, because the
  // day one of these sentences is reworded the distinction comes back.
  'channel.duration.seconds': '{count, plural, zero {# ثانية} one {ثانية واحدة} two {ثانيتان} few {# ثوانٍ} many {# ثانية} other {# ثانية}}',
  'channel.duration.minutes': '{count, plural, zero {# دقيقة} one {دقيقة واحدة} two {دقيقتان} few {# دقائق} many {# دقيقة} other {# دقيقة}}',
  'channel.duration.hours': '{count, plural, zero {# ساعة} one {ساعة واحدة} two {ساعتان} few {# ساعات} many {# ساعة} other {# ساعة}}',

  // Forum defaults. These set where a board *starts* and must not read as
  // rules, so «الافتراضي» (default) carries each label and the hints say
  // "begins" rather than "is".
  'channel.forum.sortLabel': 'الترتيب الافتراضي',
  'channel.forum.sortHint': 'هكذا يبدأ المنتدى عند فتحه.',
  // «آخر نشاط» is the last reply, not the last post -- which is the distinction
  // the English comment insists on; «تاريخ النشر» is the thread's own creation
  // time. Two different nouns, so the two cannot be confused.
  'channel.forum.sort.activity': 'آخر نشاط',
  'channel.forum.sort.creation': 'تاريخ النشر',
  'channel.forum.layoutLabel': 'التخطيط الافتراضي',
  // «يتصدّر … بأول صورة» -- leads with the first image. The accusative on
  // «المعرضَ» and «كلَّ» is written with vowel marks here because the sentence
  // is verb-object-object and would otherwise be ambiguous about which noun is
  // doing the leading.
  'channel.forum.layoutHint': 'يتصدّر المعرضُ كلَّ منشور بأول صورة فيه.',
  'channel.forum.layout.list': 'قائمة',
  'channel.forum.layout.gallery': 'معرض',

  'channel.voice.regionLabel': 'المنطقة الصوتية',
  // SFU stays as it is: it names a category of server software, the people who
  // change this setting know the word, and no language has a translated
  // equivalent. A standalone Latin word between two Arabic words is bidi-safe
  // -- the neutrals on both sides sit between two RTL runs and resolve to the
  // paragraph direction -- so no mark is needed and none is added. «تلقائي» is
  // quoted with «» because it names the option in the list below rather than
  // describing behaviour.
  'channel.voice.regionHint': 'أيّ SFU ينقل هذه القناة. و«تلقائي» يتبع افتراضي النقابة.',
  'channel.voice.regionAuto': 'تلقائي',
  'channel.voice.regionAutoDefault': 'تلقائي (افتراضي النقابة/الخادم)',
  // `{region}` is the identifier the server minted (`eu-west`, `sfu-3`) and is
  // never translated; only the parenthetical is. «مخصّصة» is feminine, agreeing
  // with «منطقة» even though the noun is not in the sentence -- the label above
  // the control supplies it.
  'channel.voice.regionCustom': '{region} (مخصّصة)',
  'channel.voice.bitrateLabel': 'معدّل البت',
  // Not softened to "may use more": the cost is per speaker and it is linear,
  // and «عن كل متحدّث» says per-speaker outright. Aimed at whoever pays for the
  // bandwidth, which on a self-hosted server is the reader.
  'channel.voice.bitrateHint': 'كلما زاد كلّف المستضيف نطاقًا أوسع عن كل متحدّث.',
  // `kbps` is a unit symbol and is left alone; the number goes through
  // `{kbps, number}` and comes out in the locale's digits. The space before the
  // symbol is the translator's and is kept. Bidi: the Arabic-Indic digits are
  // AN and the symbol is L, so in an RTL line the number lands to the right of
  // «kbps» -- which is the correct reading order in Arabic (number first,
  // rightmost). Considered and deliberately not flagged.
  'channel.voice.bitrateValue': '{kbps, number} kbps',
  'channel.voice.limitLabel': 'حدّ المستخدمين',
  // English writes "0" as a digit because it is the literal glyph somebody
  // types into the neighbouring box. Arabic cannot: ar.js's header forbids
  // typing a literal digit into a pattern, because the numbering system is
  // `Intl`'s business and a hardcoded ٠ or 0 would be the wrong one half the
  // time. So the word «صفر» is used instead, which is stable under any
  // numbering system and is what a reader would say out loud anyway.
  'channel.voice.limitHint': 'صفر يعني بلا حدّ.',
  'channel.voice.limitNone': 'بلا حدّ',
  // The user-limit rungs. Same six-arm shape as `roles.memberCount` and the
  // same noun shapes as ar.js's own `common.convo.group`, deliberately: this is
  // the same fact (a number of people) said on a different screen, and the two
  // must not diverge. The `two` arm is genuinely reached here -- the picker
  // really does offer a limit of two -- so the dual is not hypothetical.
  // `zero` is «لا أحد» rather than a count, because zero means no limit and
  // `channel.voice.limitNone` is the option that actually says so.
  'channel.voice.limitPeople': '{count, plural, zero {لا أحد} one {شخص واحد} two {شخصان} few {# أشخاص} many {# شخصًا} other {# شخص}}',

  // TWO plural arguments in one sentence, and both carry all six arms. They are
  // one sentence to a reader and splitting them would hand the next translator
  // two fragments whose order is a fact about English.
  //
  // The first block (`max`) is the forum's ceiling. Arabic puts the counted
  // phrase first and «على الأكثر» after it, so the noun leads and every arm
  // inflects: «وسم واحد» / «وسمان» / «# وسوم» / «# وسمًا» / «# وسم».
  //
  // The second block (`perPost`) is how many one post may wear. English leaves
  // the noun out of it ("A post may wear 3.") because English can; Arabic
  // cannot, because a bare number has nothing to agree with, so «وسم» is
  // restated. Note the `two` arm: «وسمين», the *accusative* dual, because it is
  // the object of «يحمل» -- where the first block's `two` arm is «وسمان», the
  // nominative dual. The same dual in two cases in one sentence, which is a
  // distinction no two-arm plural could hold.
  //
  // Each block's `#` is that block's own count; the formatter scopes the pound
  // to the plural it is inside.
  'channel.tags.limit': '{max, plural, zero {لا وسوم.} one {وسم واحد على الأكثر.} two {وسمان على الأكثر.} few {# وسوم على الأكثر.} many {# وسمًا على الأكثر.} other {# وسم على الأكثر.}} {perPost, plural, zero {ولا يحمل المنشور الواحد شيئًا منها.} one {ويجوز للمنشور الواحد أن يحمل وسمًا واحدًا.} two {ويجوز للمنشور الواحد أن يحمل وسمين.} few {ويجوز للمنشور الواحد أن يحمل # وسوم.} many {ويجوز للمنشور الواحد أن يحمل # وسمًا.} other {ويجوز للمنشور الواحد أن يحمل # وسم.}}',

  // Accessible names, never drawn. The number tells somebody which of fifteen
  // identical rows they are in, so it stays `{n, number}` and gets the locale's
  // own digits. Arabic puts the possessed noun first («إيموجي الوسم ٣»), which
  // is the reverse of English's order -- this is one of the places a
  // Latin-script-first word order had to be reordered outright rather than
  // moved a little. The screen reader announces the control's role by itself,
  // so neither string says "field" or "box".
  'channel.tags.emojiLabel': 'إيموجي الوسم {n, number}',
  'channel.tags.nameLabel': 'اسم الوسم {n, number}',
  // The emoji box is 84 pixels and does not grow. «الرموز التعبيرية» is the
  // descriptive MSA phrase and is three words long; it would be cut off here.
  // «إيموجي» is the naturalised loan, is six characters, and is what Arabic
  // speakers actually write. It is therefore used for the emoji noun
  // *everywhere* in this fragment -- here, in `channel.tags.emojiLabel`, and in
  // `bots.intent.guild_expressions.*` -- rather than kept short in one place
  // and long in another, which would be the inconsistency the channel.js header
  // warns about. See the report: this fixes the word for `perms`
  // (`manage_expressions`) as well.
  'channel.tags.emojiPlaceholder': 'إيموجي',
  // Indefinite, unlike `channel.field.name`: a placeholder is an example of a
  // value, a label is the name of a box.
  'channel.tags.namePlaceholder': 'اسم',
  // "Moderator only" is about who may *apply* the tag, not who may see it, and
  // a translation reading as "visible to moderators only" describes a feature
  // this does not have. Arabic «للمشرفين فقط» has exactly that ambiguity, so
  // the verb is put in: «يضعه المشرفون فقط» -- only moderators *put* it on. One
  // word longer than the English and worth it.
  'channel.tags.moderated': 'يضعه المشرفون فقط',
  'channel.tags.removeNamed': 'إزالة {name}',
  'channel.tags.removeUnnamed': 'إزالة هذا الوسم',
  // The field label over the empty state; same Arabic word as the tab heading,
  // two keys, as in English.
  'channel.tags.fieldLabel': 'الوسوم',
  'channel.tags.empty': 'لا وسوم في هذا المنتدى بعد.',
  'channel.tags.add': 'إضافة وسم',
  // Not ar.js's `common.save`: the tags tab has its own save and the overview
  // tab has another, and the object is named so the reader knows which.
  'channel.tags.save': 'حفظ الوسوم',
  // Not hedged. «يرفضها الخادم نفسه، لا هذه الشاشة وحدها» is a flat statement
  // about the server, with the contrast that is the whole point of the sentence
  // kept as a contrast. No «قد تُرفض» (may be refused) anywhere near it.
  'channel.tags.moderatedNote': 'الوسوم المقصورة على المشرفين يرفضها الخادم نفسه، لا هذه الشاشة وحدها.',
  'channel.tags.saveFailed': 'تعذّر حفظ الوسوم',

  // Longer than `channel.field.private` on purpose: here the switch is the
  // first control on a tab full of role rows, so the noun is spelled out and
  // «خاصة» cannot be read as being about the role.
  'channel.perms.privateLabel': 'قناة خاصة',
  // `{permission}` is `perms.view_channel.label`, taken from there rather than
  // written out, so this instruction and the switch it points at cannot drift.
  // The imperative «امنح» is right: the sentence is telling the reader what to
  // do next.
  //
  // LAYOUT RISK, not patched here: the literal `@everyone`.
  'channel.perms.privateHintOn': 'مخفية عن @everyone. امنح {permission} لدور في الأسفل ليدخل من جديد.',
  // The reassurance half, and it is not weakened. «ولا يُنقل شيء ولا يُحذف» is
  // two flat negatives in the passive; there is no «ينبغي ألا» (should not)
  // anywhere in it.
  //
  // LAYOUT RISK, not patched here: the literal `@everyone`.
  'channel.perms.privateHintOff': 'يسحب الرؤية من @everyone. ولا يُنقل شيء ولا يُحذف.',
  'channel.perms.lockNote': 'تظهر بقفل في قائمة القنوات.',

  'channel.perms.roleLabel': 'الدور',
  // Says that the switches below apply to the role in the picker above and to
  // no other. «لكل دور على حدة» -- per role, separately -- is the phrase that
  // carries it; a bare «التجاوزات للأدوار» would say nothing.
  'channel.perms.roleHint': 'التجاوزات لكل دور على حدة.',
  // Named by the glyph, because the glyphs are what is on screen, and "here"
  // does the work in both halves. The three verbs are the verbal forms of the
  // three state nouns below, so the hint and the buttons share a root each.
  'channel.perms.triStateHint': 'علامة الصح تتيح هنا، والخطأ يمنع هنا، والشرطة تترك إعداد الدور نفسه كما هو.',

  // The group headings on *this* screen. Deliberately not `perms.group.*`,
  // which are the role editor's full noun phrases; the reader is already inside
  // one channel, the column is narrow, and the heading only has to say which
  // half is being configured. So these are bare nouns where `perms.group.*` is
  // «القنوات النصية» and so on. `perms.group.general` in ar.js is already «عام»
  // and this is «عام» too -- the two coincide, and they are different keys on
  // different screens, so that is allowed rather than a merge.
  'channel.perms.group.general': 'عام',
  'channel.perms.group.text': 'نص',
  // A voice channel carries a text channel under its own id, so its message
  // permissions are grouped under Chat rather than Text. Arabic has two words
  // -- «نص» is the written thing, «محادثة» is people talking to each other in
  // writing -- so the distinction is kept, as the English comment asks.
  'channel.perms.group.chat': 'محادثة',
  'channel.perms.group.voice': 'صوت',

  // The three states, one word each, in the order they are drawn.
  //
  // «إتاحة» and not «سماح» for allow, and this is the one genuinely technical
  // call in the namespace. `channel.perms.choiceLabel` below is
  // `'{choice} {permission}'` -- the state noun with a permission name glued
  // straight after it, which in Arabic is an iḍāfa (a construct chain). «منع
  // إرسال الرسائل» and «وراثة إرسال الرسائل» are grammatical iḍāfas; «سماح
  // إرسال الرسائل» is not, because سماح governs its object with the
  // preposition بـ and needs «السماح بإرسال الرسائل». Since the code may not
  // insert a preposition, the noun has to be one that takes a direct iḍāfa, and
  // «إتاحة» does. Whatever the roles editor says for allow must match this, and
  // `roles.overwrite.allow` above does.
  //
  // «وراثة» for inherit means "leave the role's own setting alone" -- the
  // absence of an overwrite, not a third opinion -- which is what the Arabic
  // inheritance metaphor carries too.
  'channel.perms.deny': 'منع',
  'channel.perms.inherit': 'وراثة',
  'channel.perms.allow': 'إتاحة',
  // `{choice}` is the machine token now -- `deny`, `inherit`, `allow` -- and
  // each arm is a whole sentence. It used to be the finished word, handed in
  // already translated, and the rendering below is byte for byte what that
  // produced: Arabic keeps English's order and needs no joining word, because
  // the juxtaposition *is* the iḍāfa -- see the note above the three state
  // nouns for why «إتاحة» and not «سماح».
  //
  // Nothing visible changed and the change still matters. Under the old shape
  // the iḍāfa only worked by luck: all three words happened to be ones that
  // govern a direct object, and had any future wording needed «بـ» or a
  // different case, Arabic had no way to insert it -- the code, not this file,
  // decided where the seam fell. Now each arm owns its whole sentence, so the
  // next person to reword one can. `other` is unreachable (`CHOICES` is three
  // fixed entries) and says the permission alone.
  'channel.perms.choiceLabel': '{choice, select, deny {منع {permission}} inherit {وراثة {permission}} allow {إتاحة {permission}} other {{permission}}}',

  'channel.perms.saveFailed': 'تعذّر حفظ ذلك التجاوز',
  // About the gesture the reader made -- the private switch -- rather than
  // about the mechanism. Naming the overwrite here would be correct and
  // unhelpful.
  'channel.perms.privateFailed': 'تعذّر تغيير من يمكنه رؤية هذا',

  // ==== bots

  // Indefinite «روبوت»: the screen is about installing a bot, any bot. The
  // button `bots.install.submitUnnamed` is the definite «الروبوت», for the one
  // whose card is on screen but whose descriptor carried no name. English
  // spells both "Install bot" and its comment asks for them to be treated
  // differently where a language can; Arabic can, with the article.
  'bots.install.title': 'تثبيت روبوت',
  // Consent copy, and both load-bearing facts survive: the descriptor is
  // *signed* («الموقَّع»), and nothing is installed until the button is pressed
  // («قبل تثبيت أي شيء»). Imperative «الصق», because it is an instruction.
  // "Telium" is the product name and stays Latin, as ar.js already does in
  // `errors.gateway.4001`; a standalone Latin word between Arabic words is
  // bidi-safe and takes no mark.
  'bots.install.intro': 'الصق مرجع تطبيق، وسيجلب Telium واصف التطبيق الموقَّع الخاص بالروبوت ويعرض بالضبط ما يطلبه قبل تثبيت أي شيء.',
  'bots.install.referenceLabel': 'مرجع التطبيق',
  // LEFT IN ENGLISH, deliberately, and the only string in these three
  // namespaces that is. It is an example of the *shape* of a reference: the
  // reserved documentation host `bots.example`, a slash, and the first digits
  // of a ULID. Localising the host would teach somebody to type a reference
  // that cannot resolve, and localising the digits would teach them to type a
  // ULID prefix that is not one.
  //
  // LAYOUT RISK, not patched here: the whole value is Latin plus a trailing
  // `…`, and the ellipsis is a bidi-neutral at the end of an RTL paragraph, so
  // it resolves to the paragraph level and renders on the *left* of the Latin
  // run -- the reader sees the equivalent of «…bots.example/01». No mark is
  // inserted; the fix is for the field to carry `dir="ltr"`, which is a layout
  // change and not a catalogue one.
  'bots.install.referencePlaceholder': 'bots.example/01…',
  'bots.install.referenceHint': 'الصق المرجع الذي نسخته من مطوّر الروبوت.',
  // ar.js's own loading idiom («جارٍ …»). It sits in the same narrow line under
  // the field and cannot grow.
  'bots.install.loading': 'جارٍ تحميل التطبيق…',

  // The eyebrow over the origin, and it is blunt on purpose: this is whose
  // program it is. «من طرف ثالث» is the settled Arabic for third-party.
  'bots.install.thirdParty': 'تطبيق من طرف ثالث',
  // "Calls itself", not "Name", and the distancing is the whole point: the
  // origin is verified and the name is a claim. «يسمّي نفسه» carries exactly
  // that -- it is what Arabic says of somebody asserting a name for themselves,
  // and it is not the neutral «الاسم:». The `<name>` tag is markup and is kept
  // byte-identical, opening and closing; `{name}` inside it is a remote string
  // and is never translated, and `isolate` handles its direction.
  'bots.install.callsItself': 'يسمّي نفسه <name>{name}</name>',
  // The bare common noun, standing in for a missing name. Same word as
  // `bots.list.badge`, as the English comment requires.
  //
  // «روبوت» and not «بوت». Both are loans; «بوت» is the bare transliteration
  // and is what Arabic chat users type, «روبوت» is the naturalised form that
  // Arabic dictionaries carry and that MSA technical writing uses. This
  // catalogue is MSA throughout (ar.js's header says so outright), the badge is
  // short enough either way, and a reader who has only ever seen «بوت» still
  // reads «روبوت» correctly, where the reverse is not true of a formal register.
  // Whatever is chosen, it has to be one word across `bots.install.*` and
  // `bots.list.*`, and it is.
  'bots.install.unnamed': 'روبوت',
  // Not a failure and not a refusal of *this* reader: there is nothing for them
  // to fix, so the sentence says only what the application is doing.
  'bots.install.closed': 'هذا التطبيق لا يقبل عمليات تثبيت جديدة حاليًا.',

  // "Intents" -> «الاشتراكات», subscriptions. This is the protocol meaning and
  // not the English word's ordinary one, which the bots.js header explicitly
  // asks for. The cognate «النوايا» (intentions) would be actively wrong: an
  // intent is one feed of events a bot asks to be sent, and «نيّة» is a wish.
  // «الاشتراك» is the ordinary Arabic for subscribing to a feed, so a reader
  // meeting the word for the first time guesses roughly right -- which is the
  // test the header sets. Nothing is lost by moving off the English word,
  // because `bots.list.colIntents` sits over a column of the protocol's own
  // constants, shown untranslated, so the machine spelling is always in view.
  'bots.install.intentsTitle': 'الاشتراكات',
  // Why these start ticked and the permissions below do not. The imperative
  // «أزل التحديد» is an instruction to the reader, not a description of the
  // control, matching the English. «يكشفه» (expose) is deliberately the verb of
  // disclosure, not of permission.
  'bots.install.intentsHint': 'هذه فئات الأحداث التي يطلبها الروبوت. تبدأ مفعّلة؛ أزل التحديد عن كل ما لا ينبغي لهذا الخادم أن يكشفه.',
  // «أحداث البوّابة» -- gateway events. «البوّابة» is already fixed by ar.js's
  // `errors.gateway.*` block.
  'bots.install.intentsEmpty': 'لا يطلب هذا الروبوت أي اشتراكات في أحداث البوّابة.',
  'bots.install.permissionsTitle': 'الصلاحيات',
  // The half that must not be softened. «تبدأ مطفأة» is flat indicative, not
  // «ينبغي أن تبدأ»; «حدّد … فقط» is the imperative with the restriction on the
  // object, which is where English puts it too.
  //
  // «الخطِرة» is the same word as the `bots.capability.powerful` pill -- see
  // the long note there for why Arabic cannot reuse one invariant form and what
  // is actually held constant.
  'bots.install.permissionsHint': 'هذه الصلاحيات التي يطلبها المطوّر. الخطِرة منها تبدأ مطفأة — حدّد ما يحتاجه هذا الروبوت لأداء عمله فقط.',
  'bots.install.permissionsEmpty': 'لا يطلب هذا الروبوت أي صلاحيات في النقابة.',
  // Both halves of the rule: you do not hold it, *and therefore* the server
  // will refuse. A reader told only the second half goes hunting for a setting.
  // «لغيرك» (to somebody else) keeps the giving-away sense of the English.
  'bots.install.cannotGrant': 'أنت لا تملك هذه الصلاحية هنا، ولذلك لن يسمح لك هذا الخادم بمنحها لغيرك.',

  // مصدر + the remote name, which reads as an iḍāfa: «تثبيت Ping Bot». The
  // unnamed form is definite, for the reason at `bots.install.title`.
  'bots.install.submit': 'تثبيت {name}',
  'bots.install.submitUnnamed': 'تثبيت الروبوت',
  'bots.install.installing': 'جارٍ التثبيت…',

  // The two uncoded failures, each naming which request did not land. No full
  // stop: `errors.context` joins them to the server's own sentence.
  'bots.install.previewFailed': 'تعذّر تحميل الروبوت',
  'bots.install.failed': 'تعذّر تثبيت الروبوت',

  'bots.list.title': 'الروبوتات المثبَّتة',
  // The standing warning, and the sentence people do not expect. Every clause
  // survives: removal is immediate («فورًا»), *and* reducing grants also
  // reaches sockets that are already open, *and* the reason is that the check
  // is re-run per dispatch. The last clause is the reassuring half and an
  // administrator cutting a misbehaving bot needs it to decide whether they
  // must also remove the bot, so it is not compressed away.
  //
  // "dispatch" has no settled Arabic noun; «كل حدث يُرسَل» (every event that is
  // sent) says what a dispatch is without coining a term the reader would then
  // have to learn. "grants" is the م-ن-ح root: «ما مُنِح له» and «المنح
  // الحالي» -- see the glossary on why this root has three shapes here.
  'bots.list.notice': 'إزالة روبوت تُلغي فورًا عضويته في النقابة وجلساته الحيّة. وتقليص ما مُنِح له يسري كذلك على الاتصالات المفتوحة بالفعل، لأن التحقّق من المنح الحالي في النقابة يتكرّر مع كل حدث يُرسَل.',
  'bots.list.empty': 'لا روبوتات مثبَّتة في هذه النقابة.',
  // The accessible name of the table. Without it the table primitive announces
  // its own default -- which in this catalogue is ar.js's «السجلات» -- to every
  // screen reader. Identical to `bots.list.title` here, as in English: the
  // visible heading and the spoken name are the same fact, and both keys are
  // kept because a narrower visible heading is a change somebody may want.
  'bots.list.tableLabel': 'الروبوتات المثبَّتة',
  // Column headings over narrow columns. The last two head columns of wire
  // constants (`GUILD_MESSAGES`, …) shown untranslated, so the heading is the
  // only translated word in the column.
  'bots.list.colBot': 'الروبوت',
  'bots.list.colPermissions': 'الصلاحيات',
  'bots.list.colIntents': 'الاشتراكات',
  // The badge beside a bot's display name. English capitalises because it is a
  // badge rather than a word in a sentence; Arabic has no case, so the badge
  // carries its weight by being short and by matching `bots.install.unnamed`
  // exactly, which is what the English comment asks for. It is not left as
  // "BOT": that is the badge every Latin-script client uses, and this
  // catalogue's own rule is that a *word* is translated where a wordmark is not.
  'bots.list.badge': 'روبوت',
  'bots.list.removeFailed': 'تعذّرت إزالة الروبوت',

  // `{name}` is the bot's display name or its account id; either way it is data.
  'bots.edit.heading': 'تعديل {name}',
  // The offline notice, and the half that matters is which half still works.
  // «ولا يزال بوسعك تقليصها بأمان» is kept as an affirmative statement, because
  // a translation that reduces this to "could not be reached" leaves an
  // administrator believing they cannot disarm a misbehaving bot. «موطن
  // الروبوت» for "the bot's home" -- the home server it was fetched from.
  'bots.edit.offline': 'تعذّر الوصول إلى موطن الروبوت، فلا يُعرض إلا ما يملكه الآن من منح. ولا يزال بوسعك تقليصها بأمان؛ أما توسيعها فيتطلّب مراجعة واصف التطبيق من جديد.',
  // The م-ن-ح root as a passive participle agreeing with each head noun:
  // «الاشتراكات الممنوحة» (feminine plural agreement on a non-human plural),
  // «الصلاحيات الممنوحة» likewise. One root, two agreements, which is what
  // "use the same word" has to mean in a language that inflects.
  'bots.edit.intentsTitle': 'الاشتراكات الممنوحة',
  'bots.edit.permissionsTitle': 'الصلاحيات الممنوحة',
  // "Ceiling" -> «سقف». Arabic uses سقف for an upper limit exactly as English
  // uses ceiling, so the metaphor transfers whole, and the same word is used in
  // `bots.edit.permissionsHint` below and in `channel.edit.expiryHint`
  // («سقف النقابة»).
  'bots.edit.ceilingLoading': 'جارٍ تحميل سقف التطبيق…',
  // "immediately" is exact, not approximate -- the next dispatch is already
  // filtered -- so «فورًا» is kept and not weakened to «قريبًا» or «عند إعادة
  // الاتصال». «حسّاس للخصوصية» is the standing Arabic for privacy-sensitive.
  'bots.edit.intentsHint': 'محتوى الرسائل حسّاس للخصوصية؛ وإزالته تسري فورًا.',
  // The two ceilings as one sentence, neither clause optional. Both are flat
  // negatives («لا يمنح … ولا تمنح أنت») rather than modal ones, because both
  // are refusals the server would otherwise deliver as a single blanket 403.
  // The second clause switches to second person, as English does, because the
  // second ceiling is about this particular administrator.
  'bots.edit.permissionsHint': 'لا يمنح أي خادم أكثر مما أعلنه المطوّر، ولا تمنح أنت أكثر مما تملك.',
  // "Grants" and not "changes": the reader is saving a set of powers. Arabic
  // has no single noun that carries this -- «المنح» as a plural of «منحة» reads
  // as scholarships, and «الأذونات» is the wrong term entirely -- so the
  // relative clause «ما مُنِح» (what has been granted) is used. It is the same
  // م-ن-ح root as `bots.list.notice` and `bots.edit.*Title`, which is the
  // consistency that actually matters here.
  'bots.edit.save': 'حفظ ما مُنِح',
  'bots.edit.failed': 'تعذّر تحديث الروبوت',

  // The eight gateway intents. Every label names a *category of events the bot
  // will be sent*, not a thing the bot may do.
  //
  // «الرسائل» alone is the label, as in English, and the safeguard against the
  // misreading the header warns about is structural rather than lexical: the
  // permission is «إرسال الرسائل» (`perms.send_messages.label`) and the intent
  // is «الرسائل», so the two phrases do not overlap, and every hint in this
  // block opens with «استقبال» -- *receiving* -- which frames the whole group
  // as a subscription before any noun is read. The section heading above them
  // is «الاشتراكات». Three independent signals, which is what it takes.
  'bots.intent.guild_messages.label': 'الرسائل',
  'bots.intent.guild_messages.hint': 'استقبال أحداث إنشاء الرسائل وتعديلها وحذفها.',
  'bots.intent.guild_members.label': 'الأعضاء',
  // The colon introduces examples, and Arabic uses a colon this way too, so it
  // is kept rather than split into a second sentence. The three relative
  // clauses are parallel («من انضمّ ومن غادر ومن غيّر اسمه»), which is how
  // Arabic lists people by what happened to them.
  'bots.intent.guild_members.hint': 'استقبال تغيّرات أعضاء النقابة: من انضمّ ومن غادر ومن غيّر اسمه.',
  'bots.intent.guild_presences.label': 'الحضور',
  // "everyone here" does real work and is not shortened: «لكل من هنا» says the
  // scope is the whole guild, continuously, and not the bot's own
  // conversations. That is the fact a reader should finish the sentence holding.
  'bots.intent.guild_presences.hint': 'استقبال حالة الاتصال وتغيّرات الحضور لكل من هنا.',
  'bots.intent.guild_typing.label': 'الكتابة',
  // «مؤشرات الكتابة» is already ar.js's phrase (`settings.messages.typing`).
  'bots.intent.guild_typing.hint': 'استقبال مؤشرات الكتابة.',
  // «الإيموجي» -- the same noun as `channel.tags.emojiPlaceholder`; see there
  // for why the loan beats «الرموز التعبيرية».
  'bots.intent.guild_expressions.label': 'الإيموجي والملصقات',
  'bots.intent.guild_expressions.hint': 'استقبال تغيّرات إيموجي النقابة وملصقاتها.',
  // "Guild structure" is the shape of the place -- channels, roles, their order
  // and settings -- as against the people in it or what they say. «بنية» is the
  // structural noun and is the part to get right; «النقابة» is this
  // catalogue's word for guild throughout.
  'bots.intent.guild_structure.label': 'بنية النقابة',
  // «رؤية» rather than «استقبال» here, matching English's "See" against
  // "Receive": this intent is about what the bot can observe in the guild's
  // shape, not only about events pushed to it.
  'bots.intent.guild_structure.hint': 'رؤية القنوات والأدوار والتغيّرات البنيوية.',
  'bots.intent.guild_voice_states.label': 'حالات الصوت',
  'bots.intent.guild_voice_states.hint': 'استقبال تغيّرات العضوية في القنوات الصوتية وحالاتها.',
  'bots.intent.message_content.label': 'محتوى الرسائل',
  // The single most consequential box on the screen, and both halves survive.
  // «كل رسالة يستطيع رؤيتها» is not shortened to «الرسائل»; and the contrast in
  // the second sentence -- the bot learns *that* a message happened and not one
  // word of it -- is the only place a reader learns what unchecking the box
  // buys them, so it is kept as a contrast and spelled out: «يعلم … أن رسالة
  // وقعت ولا يعلم كلمة واحدة مما قيل فيها».
  'bots.intent.message_content.hint': 'قراءة نصّ كل رسالة يستطيع رؤيتها. وبدون هذا يعلم الروبوت أن رسالة وقعت ولا يعلم كلمة واحدة مما قيل فيها.',

  // The group headings. They are phrases rather than nouns on purpose -- they
  // read as answers to "what is this bot being let in on?" -- so the question
  // is translated, not the words. All three are Arabic relative clauses without
  // a head noun (ما / من + verb), which is the same register as the English.
  'bots.intent.group.activity': 'ما يجري هنا',
  'bots.intent.group.people': 'من هنا',
  'bots.intent.group.structure': 'كيف رُتّبت هذه النقابة',
  // The privacy group. English's "Privileged" is the protocol's adjective;
  // Arabic's nearest, «امتيازية», reads as a tier of service rather than as a
  // warning, and the other candidate «مميّزة» reads as praise. So the *function*
  // is translated instead of the word -- which is exactly what the English
  // comment asks for in this block -- and «قرارات خصوصية» says what these boxes
  // are: privacy decisions rather than features. Two words, short enough to sit
  // over the row, and it does not compete with the «خطِر» pill beside it.
  'bots.intent.group.privileged': 'قرارات خصوصية',

  // A statement about the client's ignorance, not about the capability being
  // unusual or suspect: «لا يصفه هذا العميل» and not «غير معروف» (unknown) or
  // «غير صالح» (invalid). The reader is being told their software is out of
  // date, not that something is wrong with their bot.
  'bots.capability.unknownGroup': 'لا يصفه هذا العميل',
  // `{capability}` is a machine identifier the server sent (`GUILD_SCHEDULED_
  // EVENTS`). It is moved to where Arabic grammar wants it -- after the noun it
  // stands in apposition to -- and never translated, transliterated, respaced
  // or broken. It is a placeholder, so `isolate` gives it its direction and no
  // mark is needed here.
  //
  // The promise in the second half is kept as a promise: «وتُترك كما هي تمامًا»
  // tells the reader that editing other boxes will not quietly delete this
  // grant. Not an apology.
  'bots.capability.unknown.hint': 'يعرف هذا الخادم الإمكانية {capability} ولا يعرفها هذا العميل. وتُترك كما هي تمامًا.',
  // The fallback empty line, which has to work for both intents and
  // permissions, so it names nothing -- exactly as the English does.
  'bots.capability.emptyDefault': 'لا شيء مطلوب.',
  // The warning pill, and the hardest single word in the fragment.
  //
  // It is a warning, so it needs a word with weight: not «متقدّم» (advanced)
  // and not «خاص» (special), both of which the English comment rules out by
  // name, and not «قوي» (strong/powerful), which in Arabic reads as praise on a
  // capability -- a strong permission sounds like a good one. «خطِر» is the
  // adjective from خ-ط-ر, danger: grave, consequential, to be looked at twice.
  // It is one short word and fits a pill.
  //
  // On matching `bots.install.permissionsHint`: Arabic adjectives agree, so
  // there is no invariant form that can be both a standalone pill and an
  // attribute of «الصلاحيات». What is held constant is the *root*, which is
  // what "the same word" has to mean here -- the hint says «الخطِرة منها»
  // (feminine plural, agreeing with صلاحيات) and this pill is «خطِر» (masculine
  // singular, the default for a bare tag and correct for the one row it sits on
  // today, which is the «محتوى الرسائل» intent, a masculine «اشتراك»).
  'bots.capability.powerful': 'خطِر',
  // About the developer's offer having been withdrawn, not about the grant
  // having lapsed or been revoked -- nothing has been taken from anybody yet.
  // «لم يعد معروضًا» is precisely "no longer offered" and carries no sense of
  // removal.
  'bots.capability.withdrawnBadge': 'لم يعد معروضًا',
  // Every clause is load-bearing and every one is here: the developer did this
  // («سحب المطوّر»), the bot has it right now («لا يزال الروبوت يملكه»), the
  // reader can remove it («وبوسعك أن تنزعه منه»), and removing it is one-way
  // («لن يعيده»). The last is the clause a reader needs before they click, so
  // it is a flat future negative and not «قد لا يعيده» (may not hand it back).
  // The em dash is kept: it is a neutral between two Arabic runs and sits where
  // it is written.
  'bots.capability.withdrawnHeld': 'سحب المطوّر هذا من التطبيق. ولا يزال الروبوت يملكه وبوسعك أن تنزعه منه — لكن هذا الخادم لن يعيده.',
  // Two short sentences, because this confirms a decision that cannot be
  // undone and a reader skimming one long sentence misses the second half.
  // «ولا يمكن منحه من جديد» is a statement about this server's rule, flat and
  // absolute, not a prediction.
  'bots.capability.withdrawnRemoved': 'سحبه المطوّر، وقد أُزيل الآن. ولا يمكن منحه من جديد.',

// ============================================================ chat / الرسائل
  //
  // The message view in Arabic. Two conventions before the glossary, because
  // every one of the 269 entries below is an instance of one of them.
  //
  // **Comment language.** Section banners are Arabic, matching the only two
  // banners this file already has (`رموز الحالة دون رسالة`, `إغلاق البوّابة`);
  // the prose is English, matching this file's header and its existing
  // per-entry notes (`format.bytes.*`, `common.convo.group`). That split is not
  // laziness in either direction: a banner is a landmark for somebody reading
  // the Arabic, and a note explaining *why* a plural arm is spelled the way it
  // is has to be legible to the reviewer comparing this against `en/chat.js`,
  // who may not read Arabic at all.
  //
  // **Register and the shape of a control.** Modern Standard Arabic, no
  // dialect, exactly as the header says. The one convention held across all
  // 269 keys, and the decision a reader will feel on every screen:
  //
  //   * **A control is a مصدر (verbal noun).** `Send` is «إرسال», not «أرسِل»;
  //     `Rename` is «إعادة تسمية»; `Play {label}` is «تشغيل {label}». This is
  //     what the existing body already does -- «إلغاء», «حفظ», «نسخ»,
  //     «إعادة المحاولة» -- and it is the right choice for a further reason
  //     peculiar to this namespace: almost every control here is a `title` on
  //     a glyph and therefore also its accessible name, and an imperative read
  //     aloud out of nowhere («احفظ!») sounds like the software giving orders,
  //     while a مصدر names the act the way a menu should.
  //   * **A sentence addressed to the reader is صيغة الأمر (imperative).**
  //     «أدخل عبارة الاستعادة», «وافق عليه من جهاز تستخدمه بالفعل», «قل شيئًا».
  //     Again matching the body: «أدخل الرمز», «سجّل الدخول من جديد».
  //   * **A placeholder inside an input is an imperative**, because it is an
  //     instruction and not a label: «أرسل رسالة إلى {target}».
  //
  //   The seam between the first two rules is the whole reason `chat.surface.
  //   delivery.*` and `chat.delivery.title.*` are separate keys, and Arabic is
  //   one of the languages `en/chat.js` predicted would need them: the menu row
  //   is a مصدر («الإرسال») and the dialog title over a list of people is a
  //   participle agreeing with رسالة («أُرسلت»).
  //
  // **The glossary, as a set.** These are chosen together, not one at a time,
  // because half of them only make sense against the others -- the reason
  // `reply` is «ردّ` is partly that `forward` had to be «إعادة توجيه», which
  // forced `quote` off «نقل» and on to «اقتباس». Transliteration was rejected
  // everywhere it was available, with two exceptions noted at the bottom.
  //
  //   message        رسالة         -- the ordinary word; no competitor.
  //   reply          ردّ           -- «ردّ» is the answer; «إجابة» is an answer
  //                                   to a *question*, and most replies are not.
  //   quote          اقتباس        -- the act and the quoted line both. Not
  //                                   «تنصيص», which is about the marks.
  //   forward        إعادة توجيه   -- «توجيه» alone is "directing"; the إعادة
  //                                   is what makes it *re*-sending, and it is
  //                                   what distinguishes it from «مشاركة»
  //                                   (share), which this file also needs.
  //   reaction       تفاعل         -- not «رد فعل», which is a reaction in the
  //                                   psychological sense and collides with ردّ.
  //   attachment     مُرفَق         -- the standard term in every Arabic mail
  //                                   client; a reader meets it daily.
  //   upload         رفع           -- and download «تنزيل», already in the body.
  //   draft          مسوّدة         -- not used by a key here, fixed so the
  //                                   composer work that follows does not
  //                                   invent «مبدئية».
  //   edit (text)    تحرير         -- deliberately NOT «تعديل». `common.edit`
  //                                   is «تعديل» and is said about a form;
  //                                   «تحرير» is what you do to words you
  //                                   wrote. `en/chat.js` asked for exactly
  //                                   this distinction and Arabic has it.
  //   pin            تثبيت         -- reserved here for the same reason as
  //                                   draft; no key in this namespace pins.
  //   spoiler        محتوى محجوب   -- not «حرق الأحداث», which names the sin
  //                                   rather than the mark on the text.
  //   embed          بطاقة رابط    -- what the thing *is*. «تضمين» is the verb
  //                                   for embedding and says nothing to a
  //                                   reader looking at a card.
  //   mention        إشارة         -- fixed for the autocomplete's sake.
  //   thread         سلسلة         -- a chain of messages. «موضوع» is a topic
  //                                   and would collide with a channel.
  //   ephemeral      لا يُحفَظ      -- NOT a noun. See `chat.ephemeral.mark`:
  //                                   the English refuses the jargon and says
  //                                   the two facts, and so does the Arabic.
  //   delivery       التسليم       -- and the receipt «إقرار الاستلام».
  //   read receipt   إشعار القراءة -- «إشعارات الاستلام» covers both in the
  //                                   one sentence that names the setting.
  //   emoji          رمز تعبيري    -- not «إيموجي». The Arabic compound is
  //                                   established in every platform picker.
  //   sticker        ملصق          -- likewise established.
  //   GIF            GIF           -- one of the two exceptions: kept Latin,
  //                                   with `صور GIF` where a noun is needed.
  //                                   See the note over `chat.composer.gif`.
  //   MLS / OPAQUE   MLS / OPAQUE  -- the other. Protocol names.
  //
  // **Digits.** Not one literal digit anywhere below. `#` and `{count}` go
  // through `Intl.NumberFormat` and come out Arabic-Indic; the one place the
  // English hard-codes a number (`chat.upload.expiryMonth`, "30 days") is
  // written out as a word, «ثلاثين يومًا», which is both idiomatic and immune
  // to a change of numbering system.
  //
  // **Six arms, everywhere.** Fourteen patterns below carry a `plural`, and
  // every one declares `zero`, `one`, `two`, `few`, `many`, `other`. The arms
  // are not decoration: `two` is a real dual with its own word and no numeral
  // in it («رسالتان»), `few` (3-10) takes the broken plural after the numeral
  // («# رسائل»), `many` (11-99) takes the accusative singular tamyīz
  // («# رسالةً»), and `other` (100+) takes the *singular* again («# رسالة»).
  // That last one is the arm people get wrong -- a hundred messages is
  // «١٠٠ رسالة», not «١٠٠ رسائل» -- and it is the arm an English-shaped
  // `one`/`other` pair silently fills with the plural.

  // ------------------------------------------------------------ الجدول الزمني

  // «لا شيء هنا بعد» carries the nudge the English asked to keep: the body is
  // an invitation, «قل شيئًا», in the imperative, because it is addressed to
  // the reader rather than naming a control. An مصدر here («إرسال أول رسالة»)
  // would be the task-assignment the English note warns against.
  'chat.timeline.empty.title': 'لا شيء هنا بعد',
  'chat.timeline.empty.body': 'لا رسائل بعد. قل شيئًا.',

  // «الأقدم» rather than «القديمة»: the comparative is what says these are
  // older *than what you are looking at*, which is the whole meaning of the
  // strip. The scroll line is an imperative for the same reason the empty
  // body is -- it describes a gesture the reader makes, not a button.
  'chat.timeline.loadingOlder': 'جارٍ تحميل الرسائل الأقدم…',
  'chat.timeline.scrollForOlder': 'مرّر إلى الأعلى لرؤية الرسائل الأقدم.',

  // The English note is doing real work in Arabic. "Bottom" must not become
  // «إلى الأسفل»: the layout is right-to-left, the stream still runs down, and
  // a reader who has met «الأسفل» on a button that scrolls is entitled to
  // wonder which edge is meant. «الانتقال إلى الأحدث» names the newest end of
  // the stream and is direction-free, which is what the English asked for and
  // what a vertical script would need too.
  'chat.timeline.jumpToBottom': 'الانتقال إلى الأحدث',

  // One word on a pill. Arabic has no casing, so the stylesheet's upper-casing
  // is a no-op here and the string carries the whole appearance: «جديد», four
  // letters, which fits the same pill the English does.
  'chat.timeline.unreadMarker': 'جديد',

  // The three context phrases. No full stop on any of them, exactly as in
  // English: `errors.context` renders «{context}: {message}» and the sentence
  // that follows is the server's. «تعذّر» is the body's established verb for a
  // thing that did not come off -- see `errors.clipboardFailed` -- and keeping
  // it here means a reader meets one verb for failure across the client.
  //
  // «السجلّ» for history, with the shadda written, because «السجل» unpointed is
  // read as often as "the register" and this is the room's record.
  'chat.timeline.loadOlderFailed': 'تعذّر تحميل الرسائل الأقدم',
  'chat.timeline.loadHistoryFailed': 'تعذّر تحميل السجلّ',
  'chat.timeline.jumpFailed': 'تعذّر تحميل تلك الرسالة',

  // «لم تعد … متاحة» is the "any more" the English told us not to drop: «لم
  // تعد» is precisely "is no longer", it presupposes that it once was, and it
  // is one word shorter than the alternative. The feminine agreement is with
  // رسالة and is why this cannot be shared with a key about anything else.
  'chat.timeline.messageGone': 'لم تعد تلك الرسالة متاحة.',

  // -------------------------------------------------------------- الرسالة

  // `{name}` is data in both readings -- the display name for the avatar, the
  // full `@user:host` for the tooltip -- and `isolate` in `lib/i18n/index.js`
  // wraps it, so nothing here adds a mark. The Arabic attaches it with «لـ»
  // rather than leaving it loose, which is what stops «فتح الملف الشخصي
  // {name}» from reading as an apposition.
  //
  // BIDI, layout not catalogue: an `@user:host` identifier is Latin, and it
  // lands at the very end of an RTL sentence, i.e. at the left edge of the
  // line. The colon inside the identifier is inside the isolate and is safe;
  // what is not verifiable from here is whether the tooltip's own box is
  // `dir`-aware. Flagged, no RLM inserted.
  'chat.message.openProfile': 'فتح الملف الشخصي لـ{name}',

  // Sits in the slot a short time of day will occupy. «جارٍ الإرسال…» is four
  // glyph-clusters wide and matches the body's «جارٍ الحفظ…» / «جارٍ
  // التحميل…», which is the pattern Arabic uses for a thing in progress and
  // the reason no separate gerund form is needed.
  'chat.message.sending': 'جارٍ الإرسال…',

  // «رسالة محذوفة» and not «حُذفت هذه الرسالة»: the row is the message, so the
  // Arabic drops the pointing-at-itself demonstrative the same way the English
  // drops "This message was". It is also agentless by construction -- a
  // participle names no deleter -- which is exactly the property the English
  // note protects.
  'chat.message.deleted': 'رسالة محذوفة',

  // Security copy: names the fact, softens nothing. «مُشفَّرة» is feminine,
  // agreeing with the رسالة this row is, and «لا يملكه هذا الجهاز» is a claim
  // about a key rather than about a permission -- «غير مسموح» would have been
  // the wrong sentence for the reason `en/chat.js` gives.
  'chat.message.unreadable': 'مُشفَّرة لمفتاح لا يملكه هذا الجهاز',

  // An aside inside somebody else's sentence. Arabic has no lower case to
  // carry that, so the parentheses do all of it, and the participle is
  // feminine to agree with the message it trails. No leading space: the
  // component owns it, as the English note says.
  'chat.message.edited': '(معدَّلة)',

  // The three row controls, as مصادر. «إضافة تفاعل» rather than a bare
  // «تفاعل», which is both the verbal noun and the imperative and would be
  // read as either -- and a two-way ambiguity in a tooltip that is also an
  // accessible name is worth one extra word.
  //
  // `chat.message.actions.edit` is «تحرير» where `common.edit` is «تعديل».
  // This is the distinction `en/chat.js` predicted some language would need
  // and Arabic is one: you «تعدّل» a setting and you «تحرّر» something written.
  'chat.message.actions.react': 'إضافة تفاعل',
  'chat.message.actions.reply': 'ردّ',
  'chat.message.actions.edit': 'تحرير',

  'chat.message.reactionFailed': 'تعذّر التفاعل',
  'chat.message.editFailed': 'تعذّر التحرير',

  // A fragment standing where a name and a snatch of text would stand.
  // «ردًّا على» is the accusative absolute -- the idiomatic Arabic way to mark
  // a fragment as a circumstance rather than a statement, and the nearest
  // thing the script has to the English's lower-case-and-no-full-stop signal
  // that this is not a system notice.
  'chat.message.quotedOlder': 'ردًّا على رسالة أقدم',

  // «المُردّ عليها» -- "the one replied to" -- goes one step, like the English.
  // «الرسالة الأصلية» would have said "the original", which is wrong for a
  // reply to a reply.
  'chat.message.jumpToQuoted': 'الانتقال إلى الرسالة المُردّ عليها',
  'chat.message.replyGone': 'لم تعد الرسالة المُردّ عليها متاحة.',

  'chat.message.editBox.label': 'تحرير الرسالة',
  // NOT TRANSLATED, and deliberately: `Enter` and `Escape` are key legends.
  // They are printed on the physical keyboard in Latin on every Arabic layout
  // sold, and a reader told to press «إدخال» would be hunting for a cap that
  // does not exist. Same rule as the chord hints the English note exempts.
  //
  // BIDI, layout not catalogue: this line puts two Latin words inside an
  // Arabic one, and the first of them opens the string. In an RTL paragraph
  // the leading LTR run sits at the right edge and the comma between the two
  // clauses is a neutral resolving to RTL, so the visual order is correct --
  // but it is correct by the algorithm rather than by design, and it is the
  // sort of line that breaks when somebody wraps it in a `dir="auto"` span.
  // Named, no mark inserted.
  'chat.message.editBox.hint': 'Enter <save>للحفظ</save>، Escape <cancel>للإلغاء</cancel>',

  // SIX ARMS. The whole content of a pill, so the count carries the sentence.
  //   zero  «لا رسائل»     -- no numeral at all; «٠ رسالة» is arithmetic, not
  //                           Arabic, and a pill reading zero would anyway be
  //                           a pill that should not be drawn.
  //   one   «رسالة واحدة»  -- the numeral is redundant with the noun's form,
  //                           and Arabic drops it. This is the first place the
  //                           `#` disappears from a branch.
  //   two   «رسالتان»      -- the real dual. One word, no numeral, and the
  //                           single clearest demonstration in this namespace
  //                           of why a count may not be glued to a noun.
  //   few   «# رسائل»      -- 3-10 takes the broken plural (جمع القلّة).
  //   many  «# رسالةً»      -- 11-99 takes the accusative singular tamyīz.
  //   other «# رسالة»      -- 100+ returns to the singular. ١٠٠ رسالة.
  'chat.message.thread.count': '{count, plural, zero {لا رسائل} one {رسالة واحدة} two {رسالتان} few {# رسائل} many {# رسالةً} other {# رسالة}}',

  // ------------------------------------------------------------- التسليم

  // Four participles agreeing with رسالة, feminine singular, because the
  // subject of all three states is the message. This is the half of the
  // English note about "read is about the person, delivered is about the
  // message" that Arabic resolves by putting all four on the message: «قُرئت»
  // is "it was read", which avoids having to guess the reader's gender.
  //
  // `fallback` names the subject rather than a state, as instructed, and it is
  // a مصدر because it is a heading rather than a claim.
  'chat.delivery.title.sent': 'أُرسلت',
  'chat.delivery.title.delivered': 'وصلت',
  'chat.delivery.title.read': 'قُرئت',
  'chat.delivery.title.fallback': 'التسليم',

  // «عداك» -- "except you" -- is the load-bearing exclusion the English note
  // insists on, and Arabic says it in one clitic rather than a phrase, which
  // is the only reason these fit under a title. Nothing here claims an
  // absence: «بعض أفراد المجموعة» says some have it and says nothing about
  // the rest, and «لا إقرارات استلام بعد» is a fact about the record.
  'chat.delivery.subtitle.delivered': 'وصلت إلى الجميع عداك.',
  'chat.delivery.subtitle.read': 'قرأها الجميع عداك.',
  'chat.delivery.subtitle.some': 'وصلت إلى بعض أفراد المجموعة.',
  'chat.delivery.subtitle.none': 'لا إقرارات استلام بعد.',

  // SIX ARMS plus the exact `=0`, which is preserved because it is a literal
  // and not a category: it is the old account-level watermark, a statement
  // about the *record*, and it must not be rounded into "on one device".
  //
  //   The `zero` arm is written out with the same words as `=0` and it will
  //   never be reached: `pluralBranch` in `format.js` tries `=0` first and it
  //   always wins at zero. It is here because the coverage test requires the
  //   six categories to be declared and because the next person to edit this
  //   sentence needs the arm to exist rather than to discover it is missing.
  //   The two coinciding is a fact about this sentence, not about Arabic.
  //   two   «على جهازين» -- genitive dual, because it follows the preposition
  //                         «على». The nominative «جهازان» would be wrong here
  //                         and right in a standalone label, which is exactly
  //                         the kind of thing a shared key would get wrong.
  //   many  «# جهازًا»    -- masculine accusative tamyīz, so «جهازًا» and not
  //                         «جهازةً»; the noun's gender decides the ending.
  'chat.delivery.devices': '{count, plural, =0 {الجهاز غير محدَّد} zero {الجهاز غير محدَّد} one {على جهاز واحد} two {على جهازين} few {على # أجهزة} many {على # جهازًا} other {على # جهاز}}',

  // A mark on one person's row, read as part of it. «تمّت القراءة» rather than
  // «قرأ» because the Arabic verb would have to pick a gender for somebody
  // whose gender this client does not know and has no business assuming; the
  // impersonal مصدر construction names the event and no actor. This is the
  // one place where a one-word English string becomes two in Arabic, and the
  // row has the width for it.
  'chat.delivery.read': 'تمّت القراءة',

  'chat.delivery.empty': 'لا شيء بعد.',

  // The sentence that stops the list being read as a census. «من عطّلوا
  // إشعارات الاستلام» -- "those who turned receipts off" -- keeps it a fact
  // about a setting rather than about people, and the negative is on
  // *appearing here*, never on having received the message.
  'chat.delivery.receiptsHint': 'من عطّلوا إشعارات الاستلام لا يظهرون هنا.',

  // ------------------------------------------------------------- الاقتباس

  // `<quoted/>` is an element, not a value: it is the quoted message rendered
  // as markdown with real custom emoji in it. Moved, never renamed, never
  // filled. The colon is the same glyph in Arabic and stays; what changes is
  // that in an RTL line it sits to the *left* of the name, which is correct
  // and is the reason it has to live inside the pattern rather than in JSX.
  //
  // BIDI, layout not catalogue: `{name}` opens the line and `<quoted/>` may
  // begin with Latin text, so the colon sits between two runs whose direction
  // the algorithm resolves from the paragraph. It renders correctly under
  // `dir="rtl"` on `<html>`; it would not under a `dir="auto"` container that
  // guessed from the first strong character of a Latin display name. Named.
  'chat.quote.line': '{name}: <quoted/>',

  // «ردًّا على {name}» -- the same accusative absolute as `quotedOlder`, which
  // is what makes the strip read as a circumstance ("in reply to X:") rather
  // than as a claim that somebody is currently replying.
  'chat.quote.replyingTo': 'ردًّا على {name}: <quoted/>',

  // A noun standing where the words would have been. Not «أرسل مُرفَقًا»: the
  // line is already attributed, and the English note is right that a verb here
  // re-attributes it.
  'chat.quote.attachment': 'مُرفَق',

  // ---------------------------------------------------- الرسالة التي لا تُحفَظ

  // Both halves, as the English demands, and neither is droppable for width.
  // The word "ephemeral" is not transliterated and is not rendered as a term
  // at all: «أنت وحدك ترى هذا» is the privacy fact and «لن يُحفَظ» is the
  // persistence fact, which are the two things the jargon stands for. An
  // Arabic reader meeting «إيفيميرال» would learn nothing; one meeting
  // «مؤقتة» would learn the wrong thing, since this is not about time.
  'chat.ephemeral.mark': 'أنت وحدك ترى هذا — ولن يُحفَظ',

  // NOT `common.dismiss` («تجاهل»). The English note says a language with a
  // stronger verb for "get rid of permanently" should use it here, and Arabic
  // has one: «حذف نهائي» is what you call deleting the only copy. «تجاهل» is
  // ignoring a notice that will come back, which is the other key's job.
  'chat.ephemeral.dismiss': 'حذف نهائي',

  // -------------------------------------------------------------- التشفير

  // NOT TRANSLATED anywhere in this section: `MLS` and `OPAQUE`. They are the
  // names of published protocols, somebody auditing this client will search
  // for those exact letters, and a transliteration («إم إل إس») is a dead end
  // in a search box. Same rule `en/chat.js` states and the same rule
  // `en/security.js` is built on.
  //
  // Terms fixed once for the whole section, so the five paragraphs read as one
  // account of one arrangement:
  //   home server      الخادم الرئيسي   (matching `common.homeserver`)
  //   DM               رسالة مباشرة
  //   recovery vault   خزنة الاستعادة
  //   history mirror   مرآة السجلّ
  //   recovery keyring حلقة مفاتيح الاستعادة
  //   passphrase       عبارة الاستعادة
  //   group (MLS)      مجموعة
  //
  // «الإعدادات ← {pane}» names a pane. The arrow is U+2190, pointing
  // left, which in a right-to-left line is the *forward* direction and reads
  // as "then" the way «→» does in English. It is a separator, not a word.
  //
  // THE PROBLEM THE OLD NOTE HERE REPORTED IS FIXED. It said: `en/chat.js`
  // requires this phrase to be spelled the way the settings pane spells its
  // own title, and it could not be, because the title was a bare literal in
  // `views/user-settings/UserSettings.jsx` (`label: 'Encryption key'`) that no
  // catalogue held and no translator could see. That label is now
  // `settings.nav.recovery`, and these four sentences plus
  // `security.devices.cannotSign` take it as `{pane}` instead of quoting it.
  // There is one spelling of that pane's name in each language and every
  // sentence that points at it reads that spelling, so the two can no longer
  // disagree — which is what the old note asked for and had no way to get.
  //
  // `{pane}` renders as "Encryption key" on an Arabic screen today, exactly as
  // the Latin citation did, because `settings.nav.recovery` is deliberately
  // left untranslated: the other sixteen rows of that settings list are still
  // English literals in an unmigrated file, and one Arabic row among sixteen
  // English ones would be worse for the reader than none. The instant somebody
  // writes «مفتاح التشفير» into that one entry, these five sentences say it
  // too, with no edit here. Do not write it into `{pane}`'s place instead: an
  // instruction's whole job is to send somebody to a control they can then
  // find, and a name the screen does not use sends them looking for nothing.
  //
  // One thing gets better in the meantime. A hardcoded Latin run sat inside
  // the Arabic pattern with nothing around it, so the sentence-final full stop
  // was a neutral character between a Latin run and the paragraph's own
  // direction and could settle on the wrong side of it. An interpolated value
  // goes through `format.js`'s `isolate`, which wraps a Latin value in an
  // Arabic sentence in U+2068/U+2069 — so the pane name is resolved as its own
  // run and the punctuation around it stays where Arabic puts it.
  //
  // The relay sentence is written out in all five paragraphs, as in English.
  // Arabic fronts the verb, which means «يُمرّرها خادمك الرئيسي» puts the act
  // before the actor -- the reordering the English note says a translator must
  // be free to make, and which the discarded glued version could not.
  'chat.encryption.custody.unknown': 'الرسائل هنا إطارات MLS. يُمرّرها خادمك الرئيسي، وهو يرى دائمًا من يخاطب من، ومتى.',
  'chat.encryption.custody.escrowed': 'الرسائل هنا إطارات MLS. يُمرّرها خادمك الرئيسي، وهو يرى دائمًا من يخاطب من، ومتى. يستخدم هذا الحساب استعادةً قديمة للرسائل المباشرة بمساعدة الخادم: يحتفظ خادمك الرئيسي بمفتاح يفتح خزنة الاستعادة ومرآة السجلّ، فيستطيع مشغّل الخادم قراءة هذه الرسائل. انقل الاستعادة إلى أجهزتك الموثوقة من الإعدادات ← {pane}.',
  'chat.encryption.custody.opaque': 'الرسائل هنا إطارات MLS. يُمرّرها خادمك الرئيسي، وهو يرى دائمًا من يخاطب من، ومتى. تستعيد كلمة مرور Telium رسائلك المباشرة المشفّرة عبر OPAQUE. لا تُرسَل كلمة المرور إلى خادمك الرئيسي أبدًا، ولا يحصل على مفتاح الخزنة ومرآة السجلّ سوى تطبيقك.',
  'chat.encryption.custody.device': 'الرسائل هنا إطارات MLS. يُمرّرها خادمك الرئيسي، وهو يرى دائمًا من يخاطب من، ومتى. مفاتيح استعادة رسائلك المباشرة تبقى على أجهزة توافق عليها أنت. يخزّن خادمك الرئيسي مرآة السجلّ المشفّرة ولا يملك أي مفتاح يفتحها.',
  'chat.encryption.custody.self': 'الرسائل هنا إطارات MLS. يُمرّرها خادمك الرئيسي، وهو يرى دائمًا من يخاطب من، ومتى. تحتفظ أجهزتك الموثوقة بمفاتيح رسائلك المباشرة، وهناك عبارة استعادة منفصلة تُرجعها إن فُقدت كل الأجهزة. ولا يُرسَل أيٌّ منهما إلى خادمك الرئيسي أبدًا.',

  // Word for word the second half of `custody.escrowed`, as the English note
  // requires: a reader may see both, and two accounts of one arrangement read
  // as two arrangements. Any future edit has to touch both entries together.
  'chat.encryption.escrowedNote': 'يستخدم هذا الحساب استعادةً قديمة للرسائل المباشرة بمساعدة الخادم: يحتفظ خادمك الرئيسي بمفتاح يفتح خزنة الاستعادة ومرآة السجلّ، فيستطيع مشغّل الخادم قراءة هذه الرسائل. انقل الاستعادة إلى أجهزتك الموثوقة من الإعدادات ← {pane}.',

  // The second clause is what stops this reading as an apology for a bug: MLS
  // withholding old messages from a new device is the design working. The
  // Arabic fronts the verb -- «ولا يسلّم MLS الرسائل القديمة» -- which also
  // solves a bidi problem the obvious word order would have created: «وMLS»
  // would have glued an Arabic conjunction directly to a Latin initialism with
  // no space, and the rendered result is ambiguous about which side the و is
  // on. Rewriting the clause is the fix; a mark would not have been.
  'chat.encryption.notYetReadable': 'السجلّ الأقدم غير قابل للقراءة على هذا الجهاز. يعود السجلّ المنسوخ مع حلقة مفاتيح الاستعادة؛ ولا يسلّم MLS الرسائل القديمة إلى جهاز جديد.',

  // ------------------------------------------------------- شارة رأس القناة

  // Two words at the very most, on a pill beside a channel name on a phone.
  // «الخادم يقرأ» is the meaning-first naming the English asked for -- not
  // «المفتاح مودَع», which is accurate and tells a reader nothing. «طرف إلى
  // طرف» is the established Arabic for end-to-end and is three short words
  // that set narrower than the English.
  'chat.encryption.chip.keyChanged': 'تغيّر المفتاح',
  'chat.encryption.chip.serverCanRead': 'الخادم يقرأ',
  'chat.encryption.chip.endToEnd': 'طرف إلى طرف',
  'chat.encryption.chip.encrypted': 'مشفَّر',

  // SIX ARMS, and the case this key exists to demonstrate: both English arms
  // read the same because "unverified" does not agree with the number, and in
  // Arabic every single arm is different. «غير» takes the case of the noun and
  // what follows «غير» is genitive, which is why the dual is «غير موثَّقَين»
  // and not «غير موثَّقان».
  //   zero  لا جهاز غير موثّق      -- negated singular; no numeral.
  //   one   جهاز واحد غير موثّق
  //   two   جهازان غير موثَّقَين      -- dual noun, genitive dual adjective.
  //   few   # أجهزة غير موثّقة     -- non-human plural takes feminine singular
  //                                  agreement, hence «موثّقة» and not
  //                                  «موثّقين». This is the arm most likely to
  //                                  be "corrected" into being wrong.
  //   many  # جهازًا غير موثّق      -- accusative tamyīz, singular agreement.
  //   other # جهاز غير موثّق
  //
  // LENGTH: this cannot be done in two words in Arabic -- a bare «# غير موثّق»
  // has no noun for the adjective to agree with and reads as a fragment. The
  // chip will be three words wide on a phone. Flagged as a layout question,
  // not solved by mangling the grammar.
  'chat.encryption.chip.unverified': '{count, plural, zero {لا جهاز غير موثّق} one {جهاز واحد غير موثّق} two {جهازان غير موثَّقَين} few {# أجهزة غير موثّقة} many {# جهازًا غير موثّق} other {# جهاز غير موثّق}}',

  // The accessible name: what pressing the thing does, which is neither the
  // one-word label nor the paragraph-long tooltip.
  'chat.encryption.chip.open': 'تفاصيل التشفير',

  // The same two sentences as the banner, as one string, because a `title` is
  // one string. Neither reading is chosen between: «تبدو هكذا، وكذلك انتحال
  // الشخصية» keeps both on the table in the English's order of likelihood.
  'chat.encryption.chip.keyChangedTooltip': 'أحد الموجودين هنا يستخدم مفتاح حساب مختلفًا. إعادة تعيين المفتاح تبدو هكذا، وكذلك انتحال الشخصية. أعد التوثيق قبل أن تثق به.',

  // ------------------------------------------------------------- اللافتات

  // Each `.title` is a complete claim on its own and each `.body` is a whole
  // sentence, as the English note requires -- they are drawn at different
  // weights and either may be read alone. Arabic allowed one rebalancing
  // (`awaiting.body` leads with the request rather than the actor) and no
  // splitting.

  'chat.encryption.unavailable.title': 'التشفير غير متاح على هذا الجهاز.',
  'chat.encryption.unavailable.body': 'التصفّح الخاص يمنع مخزن المفاتيح المحلّي؛ والنافذة العادية تعمل.',

  // «بما في ذلك جهاز آخر من أجهزتك» is the half the English insists on: a
  // reader who thinks only other people can help will wait instead of opening
  // their own laptop. It is also the half that a length edit would cut, so it
  // is placed before the last sentence rather than trailing it.
  'chat.encryption.awaiting.title': 'لا يستطيع هذا الجهاز الإرسال هنا بعد.',
  'chat.encryption.awaiting.body': 'لقد طلب الانضمام؛ ويحدث ذلك حين يفتح المحادثةَ جهازٌ موجود فيها بالفعل، بما في ذلك جهاز آخر من أجهزتك. أما الرسائل أعلاه فجاءت من سجلّك أنت.',

  // Not a softer version of the banner above: the ask never left, so nobody
  // was asked. «لم يُطلَب من أحد» is the passive with an explicit «أحد», which
  // is the only way Arabic says "nobody has been asked" without naming an
  // asker this client cannot name.
  'chat.encryption.rejoinUndeliverable.title': 'لم يُطلَب من أحد إدخال هذا الجهاز.',
  'chat.encryption.rejoinUndeliverable.body': 'الخادم الذي يرتّب هذه المحادثة غير متاح، فلم يغادر الطلب أصلًا. والبدء من جديد يمنح كل من يمكن الوصول إليه مجموعة جديدة.',

  'chat.encryption.changedIdentity.title': 'أحد الموجودين هنا يستخدم مفتاح حساب مختلفًا.',
  'chat.encryption.changedIdentity.body': 'إعادة تعيين المفتاح تبدو هكذا، وكذلك انتحال الشخصية. أعد التوثيق قبل أن تثق به.',

  'chat.encryption.vaultLocked.title': 'رسائلك الأقدم مقفلة على هذا الجهاز.',
  'chat.encryption.vaultLocked.body': 'أدخل عبارة الاستعادة من الإعدادات ← {pane} لاستعادتها.',

  'chat.encryption.deviceApproval.title': 'هذا الجهاز لا يملك مفاتيحك بعد.',
  // «تنتقل المفاتيح مباشرةً بين أجهزتك» is a claim about where the keys go and
  // is the reason approving from another device is safe. Not reduced to «تُنسخ
  // مفاتيحك», which says nothing about the path and is what the English note
  // forbids.
  'chat.encryption.deviceApproval.body': 'وافق عليه من جهاز تستخدمه بالفعل. تنتقل المفاتيح مباشرةً بين أجهزتك.',

  'chat.encryption.recoveryFallback.title': 'تسجيل الدخول لم يفتح رسائلك الأقدم.',
  'chat.encryption.recoveryFallback.body': 'أدخل عبارة الاستعادة من الإعدادات ← {pane}، أو وافق على هذا الجهاز من جهاز تستخدمه بالفعل.',

  // «محجوزة» -- held back on purpose -- and not «لم تصل», which would be the
  // "messages are being lost" reading this banner exists to refuse.
  'chat.encryption.syncFailed.title': 'التشفير غير متزامن على هذا الجهاز.',
  'chat.encryption.syncFailed.body': 'الرسائل الأحدث محجوزة ريثما يعيد Telium محاولة جدول مفاتيح MLS.',

  'chat.encryption.retrySync': 'إعادة المزامنة',

  // --------------------------------------------------------- البدء من جديد

  // The unarmed label is a مصدر naming the act in full, per the convention.
  // The armed one is the exception that proves it: it is a confirmation
  // sentence rather than a control, so it takes the imperative and repeats the
  // verb -- «نعم، ابدأ من جديد» and never a bare «تأكيد», which would be a yes
  // to a question the reader may have stopped reading.
  'chat.encryption.startOver.arm': 'بدء المحادثة من جديد',
  'chat.encryption.startOver.confirm': 'نعم، ابدأ من جديد',

  // «ولا يُفتَح أبدًا ما قيل قبلها» -- the irreversible half, in the passive and
  // with «أبدًا» carrying "ever". Not «قد لا يكون متاحًا»: the English note
  // forbids softening this one, and Arabic's habitual politeness formulas are
  // exactly the softening it means.
  'chat.encryption.startOver.warning': 'يحصل الجميع على مجموعة جديدة؛ ولا يُفتَح أبدًا ما قيل قبلها.',

  'chat.encryption.startOver.done': 'بدأت المحادثة من جديد. والرسائل الجديدة هنا يمكن قراءتها مرة أخرى.',

  // SIX ARMS, and the entry that shows why English needed a plural it does not
  // itself use. `{names}` arrives already joined by `Intl.ListFormat`, so the
  // pattern adds no «و» and no commas of its own; `{count}` is how many names
  // are in it, and Arabic inflects the verb for exactly the distinction
  // English cannot express:
  //   one   لم يُضَف     -- singular passive jussive.
  //   two   لم يُضافا    -- dual. A genuine third form, not a rounding of the
  //                        plural, and the reason `two` is not decorative.
  //   few/many/other  لم يُضافوا  -- sound masculine plural, which is what
  //                        Arabic uses for a mixed group of people at any
  //                        count above two. These three arms are identical and
  //                        are written out anyway: the collapse is a fact about
  //                        *verbs agreeing with people*, where the noun-counting
  //                        arms above differ at every step. If this sentence is
  //                        ever reworded to count something, the arms are here.
  //   zero  identical to `one`, and unreachable: the caller only draws this
  //                        when at least one name failed.
  // `{names}` appears in all six so that no arm can silently drop the data.
  'chat.encryption.startOver.partial': '{count, plural, zero {بدأنا المحادثة من جديد، لكن {names} لم يُضَف إليها بعد.} one {بدأنا المحادثة من جديد، لكن {names} لم يُضَف إليها بعد.} two {بدأنا المحادثة من جديد، لكن {names} لم يُضافا إليها بعد.} few {بدأنا المحادثة من جديد، لكن {names} لم يُضافوا إليها بعد.} many {بدأنا المحادثة من جديد، لكن {names} لم يُضافوا إليها بعد.} other {بدأنا المحادثة من جديد، لكن {names} لم يُضافوا إليها بعد.}}',

  'chat.encryption.startOver.failed': 'تعذّر بدء المحادثة من جديد',

  // --------------------------------------------------------- بطاقات الدعوة

  // SIX ARMS. Same shape as the thread count, different noun: «عضو» is
  // masculine, so the tamyīz is «عضوًا» and not «عضوةً». The 100+ arm is
  // «# عضو» -- singular -- which is the one that surprises, and the one an
  // English-shaped `one`/`other` pair would have filled with «أعضاء».
  'chat.invite.members': '{count, plural, zero {لا أعضاء} one {عضو واحد} two {عضوان} few {# أعضاء} many {# عضوًا} other {# عضو}}',

  // The count and the host in one pattern, with «على» owned by the pattern so
  // a language that attaches the preposition elsewhere can move it. `{domain}`
  // is a hostname: never translated, never given localised digits, because the
  // reader is matching it against an address bar.
  //
  // BIDI, layout not catalogue: `{domain}` is Latin and ends an RTL line, so
  // it renders at the left edge with nothing after it to anchor the direction.
  // `isolate` wraps it (FSI/PDI), which is correct and sufficient; what is not
  // testable from here is whether the invite card clips at the line's start or
  // its end. Named, no mark added.
  'chat.invite.membersOnHost': '{count, plural, zero {لا أعضاء} one {عضو واحد} two {عضوان} few {# أعضاء} many {# عضوًا} other {# عضو}} على {domain}',

  // «الانضمام إلى {guild}» takes the definite مصدر because the guild's name
  // follows; the nameless form is indefinite, «انضمام», which is how Arabic
  // spells a bare button. `{guild}` is somebody's chosen name: moved, never
  // translated. The two keys are what stop «انضمام إلى » with a hole in it.
  'chat.invite.join': 'الانضمام إلى {guild}',
  'chat.invite.joinUnnamed': 'انضمام',

  // -------------------------------------------------------------- السطح

  // A placeholder is an instruction, so it is the imperative and not a مصدر --
  // the one deliberate break from the control convention, and the same break
  // every Arabic messaging app makes. `{target}` arrives already decorated:
  // `#general` for a channel, the bare name for a thread. The `#` sigil is
  // channel syntax and is never translated or replaced.
  //
  // BIDI, layout not catalogue: `#general` is `#` + Latin inside an Arabic
  // sentence and closes it, so it sits at the left edge of the line. The `#`
  // is a neutral that will attach to the Latin run inside the isolate and
  // render on the run's left -- i.e. visually *after* the name from an Arabic
  // reader's point of view, where English readers see it before. That is the
  // bidi algorithm doing the right thing with a Latin identifier, not a bug in
  // this string, and no RLM will improve it. Named for the report.
  'chat.surface.placeholder': 'أرسل رسالة إلى {target}',
  // A separate key, not the same pattern with an empty slot: «أرسل رسالة إلى »
  // is not a sentence in Arabic either, and this lets the conversation case
  // take the shorter imperative it actually wants.
  'chat.surface.placeholderPlain': 'أرسل رسالة',

  // Both machines named, as the English requires. Arabic can front the
  // consequence and does not need to here -- the outage is the news -- but the
  // final clause is attached with «وهي» rather than being split off, so the
  // "cannot accept new messages" stays bound to the standby and not to the
  // reader.
  //
  // BIDI, layout not catalogue: `{home}` opens the sentence, which puts a
  // Latin hostname at the *right* edge of an RTL line, and `{standby}` sits
  // mid-sentence. Both are isolated; the risk is the banner's own container,
  // not the string. Named.
  'chat.surface.standby': '{home} لا يستجيب. أنت تقرأ نسخة يحتفظ بها {standby}، وهي لا تستطيع قبول رسائل جديدة.',
  // Three speakers, three registers, as the English note predicts: the room's
  // rule is impersonal («هذه السلسلة مقفلة»), the moderator's decision about
  // you is second person and passive-agented («أنت موقوف مؤقتًا»), and the
  // permission system speaks of a صلاحية, matching `errors.missing_permission`
  // in the body of this file.
  'chat.surface.threadLocked': 'هذه السلسلة مقفلة. لا يستطيع النشر هنا إلا المشرفون.',
  'chat.surface.timedOut': 'أنت موقوف مؤقتًا في هذه النقابة. تستطيع القراءة لا النشر.',
  'chat.surface.noPermission': 'لا تملك صلاحية إرسال الرسائل هنا.',

  // The menu rows, and the reason `en/chat.js` refused to share them with
  // `chat.delivery.title.*`. Arabic is one of the languages it was predicting:
  // a menu row is a مصدر naming a category -- «الإرسال», «التسليم»,
  // «القراءة» -- while the dialog title over a list of people is a participle
  // agreeing with the message -- «أُرسلت», «وصلت», «قُرئت». One key doing both
  // jobs would put a finite verb on a menu row.
  'chat.surface.delivery.sent': 'الإرسال',
  'chat.surface.delivery.delivered': 'التسليم',
  'chat.surface.delivery.read': 'القراءة',

  // ---------------------------------------------------------- صندوق الكتابة

  // Every one of these is a `title` on a glyph and therefore also its
  // accessible name, which is the whole argument for the مصدر convention: read
  // aloud, «إرفاق ملف» names the act and «أرفِق ملفًا» barks an order at
  // somebody who only moved the pointer.
  'chat.composer.attach': 'إرفاق ملف',
  'chat.composer.moreActions': 'المزيد من إجراءات الرسالة',
  // The sheet takes its context with it on a phone, so it says which actions.
  'chat.composer.actionSheet': 'إجراءات الرسالة',
  // NOT TRANSLATED: `GIF`. It is the name of the format, it is drawn *inside*
  // the button as its face, and every GIF service on earth spells it this way;
  // an Arabic reader who uses a GIF picker knows these three letters. The
  // English note says the decision is the translator's -- this is the decision,
  // and the transliteration «جيف» was rejected because it is not what anybody
  // types into a search box. Where a noun is grammatically required elsewhere
  // in this file the Arabic supplies one around it («صور GIF»).
  'chat.composer.gif': 'GIF',
  'chat.composer.emoji': 'الرموز التعبيرية',
  'chat.composer.send': 'إرسال',
  'chat.composer.cancelReply': 'إلغاء الردّ',

  // The matched clipboard pair, kept together rather than half-inherited from
  // `common.copy`. In Arabic they are as matched as the English note says the
  // German pair is: «نسخ» and «قصّ» are learned together and would look wrong
  // if one of them drifted to «اقتطاع» because it was translated in a
  // different file on a different day. «نسخ» is intentionally identical to
  // `common.copy`; that is the one duplicated word the pairing costs.
  'chat.composer.copy': 'نسخ',
  'chat.composer.cut': 'قصّ',

  // Two refusals in the button's own voice. The second names the server, not a
  // setting, because the reader cannot change either and «الرفع معطّل» would
  // send them hunting through their own preferences for a switch that is not
  // there.
  'chat.composer.attachBlocked': 'لا يمكنك إرفاق ملفات هنا',
  'chat.composer.noUploadHosts': 'لا تُفعَّل أي مستضيفات رفع خارجية على خادمك الرئيسي',
  // A fact about the guild, not a judgement on the reader: the subject of the
  // second clause is «هذه النقابة» and not «أنت». «النقابة» for guild matches
  // `settings.messages.typing.hint` in the body («خوادم النقابات»).
  'chat.composer.heldForReview': 'محجوزة لمراجعة المشرفين: هذه النقابة تحجز أول رسالة لكل عضو جديد.',

  // ------------------------------------------------------------- التنسيق

  // The names of marks, translated -- which is the English note's instruction
  // and is right for Arabic twice over, since the menu is the only place this
  // client ever teaches anybody that the app can do these things. What is not
  // translated is the chord beside each row (`⌘B`, `Ctrl+E`), which
  // `chordHint` builds and which has no catalogue entry: a key legend names a
  // physical cap.
  //
  // «عريض» and «مائل» are the words every Arabic word processor uses. «شفرة»
  // for code rather than «كود» keeps the pair `code`/`block` in one register;
  // «محتوى محجوب» for spoiler names the mark on the text rather than the sin
  // of spoiling, which is what «حرق الأحداث» would have named.
  'chat.format.bold': 'عريض',
  'chat.format.italic': 'مائل',
  'chat.format.strike': 'يتوسّطه خط',
  'chat.format.code': 'شفرة ضمن السطر',
  'chat.format.spoiler': 'محتوى محجوب',
  'chat.format.block': 'كتلة شفرة',
  'chat.format.quote': 'اقتباس',

  // ------------------------------------------------------ المرفقات المُهيّأة

  // Tooltip and accessible name differ on purpose, and so do their keys: the
  // three bare مصادر are read by somebody who can see which card they are
  // pointing at, and the three `{name}` forms by somebody who cannot and needs
  // the file named. Nothing here is a screen reader saying what a sighted
  // reader never sees -- that is the next block -- these are the same act with
  // two audiences.
  'chat.staged.preview': 'معاينة',
  'chat.staged.rename': 'إعادة تسمية',
  'chat.staged.remove': 'إزالة',
  // BIDI, layout not catalogue, and it applies to all four of these plus
  // `chat.upload.fetchFailedNamed`, `chat.attachment.saveNamed`,
  // `chat.attachment.openNamed`, `chat.attachment.saved`,
  // `chat.attachment.decryptFailed` and `chat.staged.uploadFailed`: a filename
  // is Latin, it usually carries a dot and an extension, and it closes an
  // Arabic sentence. `isolate` keeps `holiday.mp4` from dragging the full stop
  // to the wrong end, which is the failure it exists to prevent -- but a
  // filename with a trailing Arabic-visible bracket or a right-to-left
  // component in it will still read ambiguously, and the fix for that is a
  // `dir`-aware element around the name, not a mark in this string.
  'chat.staged.previewOf': 'معاينة {name}',
  'chat.staged.renameOf': 'إعادة تسمية {name}',
  'chat.staged.removeOf': 'إزالة {name}',
  // A progress bar's label, announced repeatedly while the bar moves, so it
  // takes the continuous «جارٍ» form rather than the bare مصدر the buttons use.
  // This is one a screen reader says and a sighted reader never reads: the bar
  // itself is the visible answer.
  'chat.staged.uploadingOf': 'جارٍ رفع {name}',
  // The one place a bare verb is also the accessible name, because a sticker
  // has no filename to put in a label.
  'chat.staged.removeSticker': 'إزالة الملصق',
  'chat.staged.closePreview': 'إغلاق المعاينة',

  // The confirm button names the act rather than repeating `common.save`, so
  // nobody is left wondering whether they are renaming or saving a copy. It
  // takes the definite مصدر because it is confirming a named operation, where
  // the row's tooltip above is indefinite.
  'chat.staged.renameTitle': 'إعادة تسمية الملف',
  'chat.staged.renameLabel': 'اسم الملف',
  'chat.staged.renameConfirm': 'إعادة التسمية',

  // The chip's label is the answer, not the question. «مدّة» at the end of
  // `keepFor` is what makes the menu read as "keep files for: one day" in
  // Arabic without a colon the component does not draw.
  //
  // `{duration}` is a phrase, already pluralised and already formatted by
  // `chat.staged.cap*` and `chat.upload.limit*`. It always lands after a
  // preposition here -- «بعد {duration}» -- which is why every one of those
  // six patterns below is written in the GENITIVE. That is a decision this key
  // forces on them and it is recorded in both places.
  'chat.staged.keepFor': 'الاحتفاظ بالملفات مدّة',
  'chat.staged.expiresIn': 'تنتهي الصلاحية بعد {duration}',
  'chat.staged.keepsForever': 'الاحتفاظ بها إلى الأبد',
  // Whose rule cut the list short. A sentence rather than a silently shorter
  // menu, because policy you have to infer from a missing option is policy
  // nobody knows about until a file disappears.
  'chat.staged.cappedNote': 'الملفات المُرسَلة هنا تُحذَف بعد {duration} على الأكثر.',

  // SIX ARMS each. The English pair exists to carry an indefinite article --
  // "at most a day" rather than "at most 1 day" -- and the note says a
  // language with no article may give `one` the same words as the numbered
  // form and lose nothing. Arabic has no indefinite article, so «يوم واحد» is
  // that form, and the numeral is dropped as Arabic drops it before a
  // singular.
  //
  // GENITIVE THROUGHOUT, because `chat.staged.cappedNote` interpolates these
  // after «بعد». So the dual is «يومين» and not the citation form «يومان» --
  // which is what `Intl`'s own `ar` unit formatter produces standalone, and
  // which would be wrong here. A standalone use of these keys would need the
  // nominative; there is none (`describeCap` feeds `cappedNote` only).
  //   zero  «# يوم» -- singular after zero, following CLDR's own `ar` form
  //                   («٠ يوم»), and unreachable anyway: a cap of zero days is
  //                   reported in minutes by `describeCap`.
  //   few   3-10 broken plural; many 11-99 accusative tamyīz; other 100+
  //         singular again.
  'chat.staged.capDays': '{count, plural, zero {# يوم} one {يوم واحد} two {يومين} few {# أيام} many {# يومًا} other {# يوم}}',
  'chat.staged.capHours': '{count, plural, zero {# ساعة} one {ساعة واحدة} two {ساعتين} few {# ساعات} many {# ساعةً} other {# ساعة}}',
  'chat.staged.capMinutes': '{count, plural, zero {# دقيقة} one {دقيقة واحدة} two {دقيقتين} few {# دقائق} many {# دقيقةً} other {# دقيقة}}',

  'chat.staged.uploadHost': 'مستضيف الرفع',
  'chat.staged.noHosts': 'لا تُفعَّل أي مستضيفات رفع خارجية',
  // Both `{name}` and `{domain}` are identifiers and neither is translated.
  // This entry exists for the punctuation around them, and Arabic keeps the
  // parentheses: they are among the characters the bidi algorithm mirrors
  // automatically, so the opening one renders on the right without anything
  // being written differently here.
  'chat.staged.hostOption': '{name} ({domain})',
  // The second sentence is ours and is always said: an external upload is a
  // public URL outside this app's access control, and the sender is the only
  // person who can decide that is acceptable. «ولا تحميها ضوابط وصول Telium»
  // is not softened to «قد لا تحميها».
  'chat.staged.hostPolicy': 'يخزّن هذا المستضيف الملفات وفق سياساته الخاصة للاحتفاظ ومكافحة إساءة الاستخدام.',
  'chat.staged.hostPublic': 'الرفع الخارجي ينتج روابط عامة لدى المزوّد، ولا تحميها ضوابط وصول Telium.',

  // The drop overlay's two lines. `dropTargetFallback` stands in the slot a
  // room's name occupies, so it is a demonstrative phrase rather than a title;
  // Arabic has no casing to signal that and «هذه المحادثة» does it by being a
  // phrase and not a name. «أفلِت» is the imperative because the line is an
  // instruction to somebody mid-gesture.
  'chat.staged.dropTargetFallback': 'هذه المحادثة',
  'chat.staged.dropLine': 'أفلِت للرفع',

  'chat.staged.uploadFailed': 'تعذّر رفع {name}',
  'chat.staged.tooLarge': 'كبير جدًا — المرفقات هنا محدودة بـ {limit}.',
  'chat.staged.cancelUpload': 'إلغاء الرفع',
  'chat.staged.cancelUploadOf': 'إلغاء رفع {name}',
  'chat.staged.retry': 'إعادة محاولة الرفع',
  'chat.staged.retryOf': 'إعادة محاولة رفع {name}',

  // --------------------------------------------------------- وحدات الانتهاء

  // Fixed strings, not plurals: the numeral in each of these is one and always
  // will be. NO LITERAL DIGITS -- the header of this file forbids them and they
  // would be the wrong digits half the time. «يوم واحد» carries the "1" as a
  // word, which Arabic prefers anyway. Written in the GENITIVE for the same
  // reason as the caps above: `expiryOptions` feeds these straight into
  // `chat.staged.expiresIn`, so they are always read as «بعد يوم واحد», never
  // standalone.
  //
  // `chat.upload.expiryMonth` is gone. It read «ثلاثين يومًا» -- thirty spelled
  // out -- and the thirty was not a fact about Arabic: it was
  // `30 * 24 * 60 * 60` from `lib/upload.js`, copied by hand into four
  // catalogues with nothing tying them together. The preset now describes
  // itself from its own seconds through `chat.upload.limitDays`, whose `many`
  // arm («# يومًا», the accusative tamyīz for 11-99) is what 30 lands in. THE
  // RENDERED ARABIC CHANGES: «بعد ثلاثين يومًا» becomes «بعد ٣٠ يومًا». The
  // grammar is identical; only the numeral is now a numeral, in Arabic-Indic
  // digits through `Intl.NumberFormat`, which is how every other derived
  // duration in this pane has always been written.
  'chat.upload.expiryHour': 'ساعة واحدة',
  'chat.upload.expiryDay': 'يوم واحد',
  'chat.upload.expiryWeek': 'أسبوع واحد',
  // NOT `common.never` («أبدًا»), for the reason the English note gives and
  // which Arabic makes vivid: «أبدًا» is the adverb that negates a verb and
  // cannot stand alone at the end of a list of durations. «بلا انتهاء» is what
  // the fifth option in this menu says.
  'chat.upload.expiryNever': 'بلا انتهاء',

  // SIX ARMS each, and the same genitive decision as the caps: `describeLimit`
  // feeds these into `chat.staged.expiresIn` too. The English keeps the
  // numeral in its `one` arm («1 day») where the cap forms drop it («a day»);
  // Arabic cannot mark that difference -- there is no article to lose -- so
  // both sets read «يوم واحد». The distinction is English's and does not
  // survive, exactly as the English note anticipated.
  'chat.upload.limitDays': '{count, plural, zero {# يوم} one {يوم واحد} two {يومين} few {# أيام} many {# يومًا} other {# يوم}}',
  'chat.upload.limitHours': '{count, plural, zero {# ساعة} one {ساعة واحدة} two {ساعتين} few {# ساعات} many {# ساعةً} other {# ساعة}}',
  'chat.upload.limitMinutes': '{count, plural, zero {# دقيقة} one {دقيقة واحدة} two {دقيقتين} few {# دقائق} many {# دقيقةً} other {# دقيقة}}',

  // Two whole sentences rather than one with a noun dropped into it. «المُرفَق»
  // with the definite article is what Arabic says when it has no name to use,
  // and it is bound to the verb in front of it -- which is precisely why the
  // named form could not be built by emptying the slot.
  'chat.upload.fetchFailedNamed': 'تعذّر جلب {name}',
  'chat.upload.fetchFailed': 'تعذّر جلب المُرفَق',

  // ------------------------------------------------------- الإكمال التلقائي

  // NOT TRANSLATED: `@everyone` and `@here` are the literal text that goes
  // into the message and that the server matches on, so they never appear in
  // this file at all -- what is translated is what they *do*, and that is this
  // line. «تنبيه القناة» names the consequence of pressing Enter rather than
  // repeating the row's own label.
  'chat.autocomplete.notifyChannel': 'تنبيه القناة',
  'chat.autocomplete.role': 'دور',
  // «مخصّص» is the whole note in the local case: the guild is the room you are
  // in and naming it would be telling you where you are.
  'chat.autocomplete.emojiCustom': 'مخصّص',
  // REORDERED for the placeholder. English can pre-modify -- "{guild} emoji" --
  // and Arabic cannot: a noun takes its modifier after it, and `{guild}` is an
  // arbitrary name in an arbitrary script that cannot be inflected into an
  // adjective. So the head noun leads and the guild is attached with «من».
  // The same reordering happens at `chat.emoji.guildEmoji`, with «في» because
  // that one is a section heading rather than a row's note.
  'chat.autocomplete.emojiFrom': 'رموز تعبيرية من {guild}',
  // Fills a slot where a proper name goes, so it is a name-shaped phrase and
  // not a description.
  //
  // «نقابة» and not «خادم». This said «خادم آخر» because English said "Other
  // server", and both were wrong about the same thing: the slot this fills is
  // `{guild}` in `chat.autocomplete.emojiFrom` one key up, and an emoji belongs
  // to a guild. In Telium a نقابة is the room and a خادم is the homeserver that
  // hosts it; one خادم hosts many نقابات. «أخرى» is feminine, agreeing with
  // نقابة, as the glossary at the head of this file requires.
  'chat.autocomplete.otherGuild': 'نقابة أخرى',
  // Replaces the rows rather than sitting above them, so it is a whole
  // statement in the continuous form and not a header.
  //
  // Also «نقابة» rather than «خادم»: the request behind this row is
  // `api.members(guildId, …)`, one guild's member list. The homeserver is being
  // asked, but it is not what is being searched, and to somebody waiting those
  // are two different waits. «هذه» is feminine for نقابة.
  'chat.autocomplete.searching': 'جارٍ البحث في هذه النقابة…',

  // Notation, not a sentence: a capacity written the way it is written on a
  // door. «في القناة الصوتية» matches `perms.group.voice` in the body of this
  // file («القنوات الصوتية»), which is what stops the same room being called
  // two things on two screens.
  //
  // BIDI, layout not catalogue, and the interesting one: `{count}` and
  // `{limit}` are numbers, and `stringify` in `format.js` returns
  // `services.number(value)` *before* it ever reaches `services.isolate` --
  // so numbers are NOT bidi-isolated, contrary to what the English comment
  // over this key asserts. It renders correctly anyway: Arabic-Indic digits
  // are class AN, the solidus between two ANs is a common separator that joins
  // them into one number run, and a number run inside an RTL paragraph is laid
  // out left-to-right. So «٣/٨» shows count-then-limit exactly as English
  // does. Correct by the algorithm, not by the isolate the comment credits.
  'chat.autocomplete.voiceHereOfLimit': '{count}/{limit} في القناة الصوتية',
  // SIX ARMS. A real count of people, so the noun moves through all of them:
  // «شخصان» dual, «أشخاص» for 3-10, «شخصًا» accusative for 11-99, and the
  // singular «شخص» again at 100.
  'chat.autocomplete.voiceHere': '{count, plural, zero {لا أحد في القناة الصوتية} one {شخص واحد في القناة الصوتية} two {شخصان في القناة الصوتية} few {# أشخاص في القناة الصوتية} many {# شخصًا في القناة الصوتية} other {# شخص في القناة الصوتية}}',
  // SIX ARMS, on `{limit}` rather than on a count. «تتّسع لـ» -- "it fits" --
  // rather than a literal «حتى #», because Arabic has no idiom for "up to N"
  // on a room and the capacity verb says it in one word. The «لـ» is a
  // preposition written with a tatweel so it stays connected to a following
  // numeral; it is ordinary text, not a bidi control.
  //   The tamyīz survives the preposition: «لأحد عشر شخصًا» is accusative at
  //   11-99 even after «لـ», and genitive singular at 100+.
  'chat.autocomplete.voiceLimit': '{limit, plural, zero {لا تتّسع لأحد} one {تتّسع لشخص واحد} two {تتّسع لشخصين} few {تتّسع لـ# أشخاص} many {تتّسع لـ# شخصًا} other {تتّسع لـ# شخص}}',

  // -------------------------------------------------------- إعادة التوجيه

  // Two acts, two titles, and Arabic is one of the languages the English note
  // says cannot get away with one word: «إعادة توجيه» moves a message you are
  // reading, «مشاركة» is the operating system handing this app something from
  // elsewhere. Sharing the key would have made one of the two dialogs lie.
  'chat.forward.title': 'إعادة توجيه الرسالة',
  'chat.forward.shareTitle': 'المشاركة إلى Telium',
  // A search field's placeholder, so the imperative, like the composer's.
  'chat.forward.search': 'ابحث في القنوات والمحادثات',
  // The two destinations with no name to show. A guild channel's pill is the
  // guild's own name and needs no entry.
  'chat.forward.groupChat': 'محادثة جماعية',
  'chat.forward.directMessage': 'رسالة مباشرة',
  // Not `common.save`/`common.saving`: this dispatches a copy somewhere, and
  // Arabic uses «إرسال» for dispatching and «حفظ» for storing, which is the
  // distinction the English note anticipated.
  'chat.forward.send': 'إرسال',
  'chat.forward.sending': 'جارٍ الإرسال…',
  // Feminine agreement with the مصدر that failed -- «تعذّرت إعادة التوجيه»,
  // «تعذّرت المشاركة» -- where the masculine «تعذّر» is used above for masculine
  // مصادر like «الرفع» and «التحميل». Arabic will not let a context phrase be
  // agreement-free the way English does.
  'chat.forward.failed': 'تعذّرت إعادة التوجيه',
  'chat.forward.shareFailed': 'تعذّرت المشاركة',
  // The quotation marks are inside the pattern precisely so they can be the
  // Arabic pair «» rather than English's curly quotes -- the same swap the
  // body of this file already makes at `errors.missing_permission`. A
  // component that drew the marks would have chosen English's for everyone.
  'chat.forward.noMatches': 'لا شيء يطابق «{query}».',

  // ------------------------------------------------------- بطاقة الوسائط

  // Almost everything in this block is read by somebody who cannot see the
  // picture. The filename is never glued to a word: every entry takes `{name}`
  // and the surrounding sentence is entirely Arabic's, which is what the
  // `label.endsWith(' audio')` bug in the old code made impossible.

  // Bare noun phrases, because they are interpolated into the seven transport
  // patterns below as `{label}` -- so no trailing punctuation, and no verb.
  // These two are the only entries in this namespace that feed another entry.
  // «المقطع الصوتي {name}» puts the classifier first and the filename in
  // apposition, which is both the Arabic order and the order that keeps the
  // Latin run at one end where `isolate` can do its job.
  'chat.player.audioOf': 'المقطع الصوتي {name}',
  'chat.player.videoOf': 'مقطع الفيديو {name}',

  // Seven patterns rather than one verb concatenated onto `{label}` at seven
  // call sites, and Arabic needs every one of them: «إيقاف {label} مؤقتًا»
  // REORDERS around the placeholder -- the adverb that makes it a *pause*
  // rather than a stop lands after the object, so a concatenating call site
  // could never have produced it. «عرض {label} بملء الشاشة» does the same.
  // These are all accessible names on glyph buttons: مصدر, never imperative.
  'chat.player.play': 'تشغيل {label}',
  'chat.player.pause': 'إيقاف {label} مؤقتًا',
  'chat.player.seek': 'التنقّل في {label}',
  'chat.player.mute': 'كتم {label}',
  'chat.player.unmute': 'إلغاء كتم {label}',
  'chat.player.volume': 'مستوى صوت {label}',
  'chat.player.fullscreen': 'عرض {label} بملء الشاشة',

  // The offer differs, so the keys do. The second clause is the only thing
  // left to do, so it takes the imperative: these are sentences to the reader
  // rather than names of controls. The em dash is kept -- Arabic uses it for
  // exactly this kind of consequence clause -- and it is spaced as in English.
  'chat.player.failedSave': 'تعذّر التشغيل — احفظ الملف الأصلي',
  'chat.player.failedOpen': 'تعذّر التشغيل — افتح الملف الأصلي',

  // «حفظ» bare is the button; the two named forms are tooltips on the filename
  // itself, which is a control. Three entries and not one with a sometimes-
  // empty slot, because Arabic's bare مصدر and its مصدر-with-an-object are the
  // same word here only by luck of this particular verb.
  'chat.attachment.save': 'حفظ',
  'chat.attachment.saveNamed': 'حفظ {name}',
  'chat.attachment.openNamed': 'فتح {name}',

  // BIDI, layout not catalogue: `{host}` is a domain, it is Latin, it closes
  // the sentence, and the English note asks to keep it away from the edge --
  // which Arabic cannot do, because «مستضاف على» has nowhere else to put its
  // object. The domain therefore sits at the left edge of an RTL line with no
  // trailing punctuation to anchor it. `isolate` makes it render correctly;
  // whether it *clips* correctly is a property of the row, and that is the
  // layout question being flagged rather than solved with a mark.
  'chat.attachment.hostedOn': 'مستضاف على {host}',

  // Descriptions of an absence standing where a filename or a domain would
  // have gone. English marks that with lower case; Arabic has no case and
  // marks it by leaving them indefinite -- «مُرفَق», not «المُرفَق» -- which is
  // the same signal by a different mechanism. The definite form appears two
  // entries down, where the word really is the subject of a sentence.
  'chat.attachment.unnamed': 'مُرفَق',
  'chat.attachment.externalMedia': 'وسائط خارجية',
  'chat.attachment.externalHost': 'مستضيف خارجي',
  'chat.attachment.unknownHost': 'مستضيف غير معروف',

  // REORDERED: English can put the filename first and the participle after it;
  // Arabic fronts the verb, so «تم حفظ {name}.» It is the clearest case in
  // this file of why the unnamed variant must be its own sentence rather than
  // the named one with the slot emptied -- «تم حفظ .» is not a sentence, and
  // «تم حفظ المُرفَق.» needs the definite article that an interpolated filename
  // would never supply.
  'chat.attachment.saved': 'تم حفظ {name}.',
  'chat.attachment.savedUnnamed': 'تم حفظ المُرفَق.',
  'chat.attachment.saveFailed': 'تعذّر حفظ المُرفَق',
  'chat.attachment.expiresIn': 'تنتهي صلاحيتها {when}',
  'chat.attachment.hostedExpires': 'مستضاف على {host}، تنتهي صلاحيته {when}',
  'chat.attachment.hostedExpired': 'مستضاف على {host} — انتهت صلاحيته',
  'chat.attachment.fileGone': 'حُذف هذا الملف أو انتهت صلاحيته',
  'chat.menu.deleteFileItem': 'حذف الملف: {name}',
  'chat.menu.deleteFileTitle': 'حذف الملف',
  'chat.menu.deleteFileBody': 'سيُزال «{name}» من خادمك الأم. تبقى الرائمة وتُظهر الملف كما إذا كان قد رحل. إن رُفعت البايتات نفسها هنا أكثر من مرة، فالنسخة مشتركة وسيُرفض ذلك.',
  'chat.menu.deleteFileConfirm': 'حذف الملف',
  'chat.menu.fileDeleted': 'حُذف الملف.',
  'chat.menu.fileDeleteFailed': 'تعذّر حذف الملف',
  'chat.menu.pinPost': 'تثبيت المنشور',
  'chat.menu.unpinPost': 'إلغاء تثبيت المنشور',
  'chat.menu.lockPost': 'قفل المنشور',
  'chat.menu.unlockPost': 'فتح المنشور',
  'chat.menu.postPinFailed': 'تعذّر تثبيت المنشور',
  'chat.menu.postLockFailed': 'تعذّر قفل المنشور',
  'chat.menu.copyPostId': 'معرّف المنشور',
  'chat.menu.copyPostIdItem': 'نسخ معرّف المنشور',
  'chat.menu.deleteNamed': 'حذف {name}',
  'chat.menu.deleteRepliesBody': 'تمضي الردود معه. لا يمكن التراجع عن هذا.',
  'chat.menu.deleteConfirm': 'حذف',
  'chat.menu.deletePost': 'حذف المنشور',
  'chat.menu.postDeleteFailed': 'تعذّر حذف المنشور',
  'chat.menu.openThread': 'فتح السلسلة',
  'chat.menu.markRead': 'وضع علامة مقروء',
  'chat.menu.copyThreadLink': 'رابط السلسلة',
  'chat.menu.copyLink': 'نسخ الرابط',
  'chat.menu.renameThread': 'إعادة تسمية السلسلة',
  'chat.menu.threadTitle': 'عنوان السلسلة',
  'chat.menu.rename': 'إعادة التسمية',
  'chat.menu.renameFailed': 'تعذّرت إعادة تسمية السلسلة',
  'chat.menu.archiveThread': 'أرشفة السلسلة',
  'chat.menu.unarchiveThread': 'إخراج السلسلة من الأرشيف',
  'chat.menu.archiveFailed': 'تعذّرت أرشفة السلسلة',
  'chat.menu.pinThread': 'تثبيت السلسلة',
  'chat.menu.unpinThread': 'إلغاء تثبيت السلسلة',
  'chat.menu.threadPinFailed': 'تعذّر تثبيت السلسلة',
  'chat.menu.lockThread': 'قفل السلسلة',
  'chat.menu.unlockThread': 'فتح السلسلة',
  'chat.menu.threadLockFailed': 'تعذّر قفل السلسلة',
  'chat.menu.copyThreadId': 'معرّف السلسلة',
  'chat.menu.copyThreadIdItem': 'نسخ معرّف السلسلة',
  'chat.menu.deleteThread': 'حذف السلسلة',
  'chat.menu.threadDeleteFailed': 'تعذّر حذف السلسلة',
  'chat.menu.addReaction': 'إضافة تفاعل',
  'chat.menu.reply': 'رد',
  'chat.menu.forward': 'إعادة توجيه',
  'chat.menu.startThread': 'بدء سلسلة',
  'chat.menu.create': 'إنشاء',
  'chat.menu.startThreadFailed': 'تعذّر بدء السلسلة',
  'chat.menu.editMessage': 'تعديل الرسالة',
  'chat.menu.copyText': 'نسخ النص',
  'chat.menu.copyTextLabel': 'نص الرسالة',
  'chat.menu.pinMessage': 'تثبيت الرسالة',
  'chat.menu.unpinMessage': 'إلغاء تثبيت الرسالة',
  'chat.menu.pinnedToast': 'ثُبّتت.',
  'chat.menu.unpinnedToast': 'فُكّ تثبيتها.',
  'chat.menu.pinFailed': 'تعذّر التثبيت',
  'chat.menu.unpinFailed': 'تعذّر إلغاء التثبيت',
  'chat.menu.reportMessage': 'الإبلاغ عن الرسالة',
  'chat.menu.copyMessageId': 'معرّف الرسالة',
  'chat.menu.copyMessageIdItem': 'نسخ معرّف الرسالة',
  'chat.menu.deleteMessage': 'حذف الرسالة',
  'chat.menu.deleteMessageBody': 'لا يمكن التراجع عن هذا.',
  'chat.menu.deleteDmBody': 'هذا يزيلها لدى الجميع.',
  'chat.menu.deleteFailed': 'تعذّر الحذف',
  'chat.menu.reactionFailed': 'فشل التفاعل',
  'chat.attachment.expired': 'انتهت صلاحية هذا الملف',

  // `{provider}` is a company name -- Gofile today -- never translated, always
  // interpolated. Arabic puts the verb first and the provider last, which is
  // the same freedom the English note claims for Japanese.
  'chat.attachment.openOnProvider': 'فتح على {provider}',
  'chat.attachment.openProviderFailed': 'تعذّر فتح {provider}',

  // Captions on a spinner, drawn where a file size normally sits. The
  // continuous «جارٍ» form rather than a bare مصدر, matching the body's «جارٍ
  // الحفظ…» and «جارٍ التحميل…». The ellipsis is the single character U+2026,
  // as in English -- three periods would make the row wider for nothing.
  'chat.attachment.preparing': 'جارٍ التحضير…',
  'chat.attachment.decrypting': 'جارٍ فكّ التشفير…',

  // «فكّ التشفير» for decryption -- the established Arabic compound, literally
  // "undoing the encryption" -- rather than the coinage «التفكيك». Split for
  // the same reason `saved` is split.
  'chat.attachment.decryptFailed': 'تعذّر فكّ تشفير {name}',
  'chat.attachment.decryptFailedUnnamed': 'تعذّر فكّ تشفير هذا المُرفَق',

  // -------------------------------------------------------------- الصورة

  // `untitled` stands alone in `alt`, so it is written as a caption is
  // written: the bare noun, «صورة». Arabic has no letter case at all, which
  // is precisely the case the English note describes -- the word is simply
  // written twice, once here and once inside `viewLarger` below, and nothing
  // is lost in the writing.
  'chat.image.untitled': 'صورة',
  // REORDERED, both of them: the comparative «بحجم أكبر» goes to the end in
  // Arabic, after the object, so `{label}` sits mid-sentence rather than
  // closing the line.
  //
  // Two entries and not one pattern with the noun interpolated, and Arabic
  // needs the split for a harder reason than English's. English splits them
  // because a pattern cannot recase what it interpolates; Arabic cannot
  // *definite-ise* it either. The unnamed form is talking about a picture
  // already on the screen, which Arabic marks with the article -- «عرض
  // الصورة بحجم أكبر» -- while an interpolated caption or filename
  // arrives bare and must stay bare. So the two are genuinely different
  // strings here rather than the same string at two capitalisations, and a
  // caller that fed `untitled` into the named pattern would produce «عرض
  // صورة بحجم أكبر»: grammatical, but indefinite, and it reads as
  // "view *a* picture larger" when there is one picture and the reader is
  // looking at it.
  //
  // Both are accessible names on a glyph button -- a screen reader says them
  // and a sighted reader never reads either in full.
  'chat.image.viewLarger': 'عرض الصورة بحجم أكبر',
  'chat.image.viewLargerNamed': 'عرض {label} بحجم أكبر',
  'chat.image.preview': 'معاينة الصورة',
  'chat.image.close': 'إغلاق معاينة الصورة',
  'chat.image.save': 'حفظ',
  'chat.image.openOriginal': 'فتح الأصل',

  // ------------------------------------------------------------ منتقي GIF

  // NOT TRANSLATED: `GIF`, every time it appears below. The reasoning is at
  // `chat.composer.gif`. Where Arabic grammar wants a noun the Arabic supplies
  // one around it -- «صور GIF», "GIF images" -- rather than bending the
  // initialism, and where the English string is already a noun phrase («GIF
  // results») the Arabic head noun leads.
  //
  // BIDI, layout not catalogue: `GIF` is three Latin capitals inside Arabic
  // sentences in fifteen of the strings below, and they are literals rather
  // than placeholders, so `isolate` never touches them. Three strong-LTR
  // letters between Arabic runs resolve correctly on their own; the one to
  // watch is `chat.gif.unavailable`, where `GIF` is followed by an em dash
  // that is a neutral between an LTR run and an Arabic run. It resolves to the
  // paragraph direction and renders right; it is listed because it is the kind
  // of line that changes appearance under `dir="auto"`.
  'chat.gif.search': 'ابحث في صور GIF',
  'chat.gif.results': 'نتائج GIF',
  'chat.gif.picker': 'منتقي GIF',
  'chat.gif.dialogTitle': 'صور GIF',
  // The stand-in title, fed into `chat.gif.send` as `{title}`. A bare «GIF»
  // would give «إرسال GIF», which is a verb governing an initialism with no
  // noun; «صورة GIF» gives «إرسال صورة GIF» and reads as Arabic.
  'chat.gif.untitled': 'صورة GIF',

  // «الرائج» is the provider's idea of what is popular; «المفضّلة» is the
  // reader's own starred list and MUST match the two star controls below, or
  // the chip and the star describe one list by two names.
  'chat.gif.trending': 'الرائج',
  'chat.gif.favorites': 'المفضّلة',
  'chat.gif.favorite': 'إضافة GIF إلى المفضّلة',
  'chat.gif.unfavorite': 'إزالة GIF من المفضّلة',

  'chat.gif.send': 'إرسال {title}',

  // Statements of fact about this server's configuration, because there is
  // nothing to do about either from inside the picker -- no imperative, no
  // offer of a fix that does not exist.
  'chat.gif.disabled': 'بحث GIF معطَّل من هذا الخادم.',
  'chat.gif.notConfigured': 'بحث GIF غير مُعَدّ بعد.',
  'chat.gif.loadFailed': 'تعذّر تحميل صور GIF.',
  'chat.gif.loading': 'جارٍ تحميل صور GIF…',
  // An instruction the reader can act on, so the imperative.
  'chat.gif.favoritesEmpty': 'ضع نجمة على صورة GIF للاحتفاظ بها هنا.',
  'chat.gif.noMatches': 'لا شيء يطابق ذلك.',

  // `{provider}` is Tenor, Giphy or Klipy -- company names, never translated.
  'chat.gif.openOn': 'فتح GIF على {provider}',
  'chat.gif.unavailable': 'صورة GIF غير متاحة — افتحها مباشرةً',

  // The category chips are CAPTIONS ONLY. The query actually sent to the
  // provider stays English in `CATEGORIES` in `GifPicker.jsx`, because Klipy,
  // Tenor and Giphy index against English tags -- so these entries are freed
  // completely from being translations, and only have to be the right caption
  // for a chip that returns those GIFs.
  //
  // Two are taken up on that freedom. «خيبة» rather than a literal «كفّ على
  // الوجه»: the gesture is not one an Arabic reader names, and the chip
  // returns GIFs of dismay, which is what «خيبة» says in one word. «هزّ
  // الكتفين» is kept literal because that gesture *is* named in Arabic and is
  // what the GIFs show. «إعجاب» for thumbs-up names the meaning rather than
  // the thumb, which is how every Arabic interface labels that button.
  'chat.gif.category.reactions': 'تفاعلات',
  'chat.gif.category.happy': 'فرح',
  'chat.gif.category.cry': 'بكاء',
  'chat.gif.category.love': 'حبّ',
  'chat.gif.category.dance': 'رقص',
  'chat.gif.category.cats': 'قطط',
  'chat.gif.category.dogs': 'كلاب',
  'chat.gif.category.thumbsUp': 'إعجاب',
  'chat.gif.category.facepalm': 'خيبة',
  'chat.gif.category.applause': 'تصفيق',
  'chat.gif.category.shrug': 'هزّ الكتفين',
  'chat.gif.category.excited': 'حماس',

  // ------------------------------------------- منتقي الرموز التعبيرية

  // NOT TRANSLATED and not present here at all: the names of the individual
  // emoji, which come out of the Unicode dataset in English, and the
  // shortcodes beside them (`:grinning:`), which are input syntax and never
  // move. Re-typing two thousand CLDR names into this file by hand would be
  // stale by the next Unicode release.
  //
  // «رمز تعبيري» for emoji throughout, not the transliteration «إيموجي»: the
  // compound is what every platform picker in Arabic uses, and it inflects --
  // «رموز تعبيرية», «رمزًا تعبيريًا» -- where the loanword cannot.
  //
  // BIDI, layout not catalogue: the picker draws Latin emoji *names* and
  // `:shortcodes:` inside a right-to-left panel, and neither passes through a
  // catalogue string, so nothing here can isolate them. A shortcode's colons
  // are neutrals and will attach to whichever side the algorithm resolves
  // them to, which in an RTL panel puts them visually at the run's left. That
  // is a `dir`/`unicode-bidi` decision for the row element in `EmojiPicker.jsx`
  // and is named here because this is where somebody will look for it.
  'chat.emoji.search': 'ابحث في الرموز التعبيرية',
  'chat.emoji.grid': 'الرموز التعبيرية',
  'chat.emoji.picker': 'منتقي الرموز التعبيرية',
  'chat.emoji.dialogTitle': 'الرموز التعبيرية',
  'chat.emoji.categories': 'فئات الرموز التعبيرية',

  // The footer before the pointer has touched anything, written back into the
  // same element on every pointer move -- so both spellings come from this one
  // key. An instruction to the reader, hence the imperative.
  'chat.emoji.hint': 'اختر رمزًا تعبيريًا.',

  // Two genuinely different waits: the Unicode dataset over the network, then
  // this account's guilds answering with their own uploads. Somebody stuck on
  // the second is waiting on servers, and the sentence says so by naming what
  // is loading rather than saying «جارٍ التحميل» twice.
  'chat.emoji.loading': 'جارٍ تحميل الرموز التعبيرية…',
  'chat.emoji.loadingCustom': 'جارٍ تحميل الرموز التعبيرية المخصّصة والملصقات…',

  'chat.emoji.noMatches': 'لا رموز تعبيرية تطابق ذلك.',
  // «الأخيرة» here MUST stay identical to `chat.emoji.group.recent` below, and
  // it is quoted with the Arabic guillemets so a reader can see it is the name
  // of a tab rather than an adjective in the sentence -- which English gets
  // for free from the capital R and Arabic has to spend punctuation on.
  'chat.emoji.empty': 'لا شيء هنا بعد. الرموز التي تختارها تظهر ضمن «الأخيرة».',

  // Arabic guillemets again, chosen here rather than in JSX for exactly the
  // reason the English note gives: English's curly quotes are neither the
  // Japanese corner brackets nor the Arabic pair.
  'chat.emoji.results': 'نتائج «{query}»',
  'chat.emoji.stickerResults': 'ملصقات',
  'chat.emoji.savedStickers': 'الملصقات المحفوظة',

  // REORDERED for the placeholder, like `chat.autocomplete.emojiFrom`, but
  // with «في» rather than «من»: these are section headings over a guild's own
  // uploads, and Arabic marks the containing place with «في» where it marks
  // the source with «من». `{guild}` is arbitrary text in any script.
  'chat.emoji.guildEmoji': 'الرموز التعبيرية في {guild}',
  'chat.emoji.guildStickers': 'الملصقات في {guild}',
  'chat.emoji.saveSticker': 'حفظ الملصق',
  'chat.emoji.unsaveSticker': 'إلغاء حفظ الملصق',

  // Skin tone. The English note says these are separate entries because in
  // most languages the tone is an adjective agreeing with a noun -- Arabic is
  // one, and the noun it agrees with is «لون» (masculine), so the six entries
  // below are definite masculine adjectives: «الفاتح», «المتوسط», «الداكن».
  // `skinToneOf` supplies the noun and the agreement happens at render.
  //
  // This is also why the six are worded as they are: readers meet these exact
  // six options in their operating system's own picker, and Apple's and
  // Android's Arabic both say «لون البشرة الفاتح المتوسط». Matching that is
  // worth more than a tidier phrase nobody has seen before.
  'chat.emoji.skinTone': 'لون البشرة',
  'chat.emoji.skinToneOf': 'لون البشرة {tone}',

  // «الافتراضي» is the yellow, tone-less glyph and is deliberately not named
  // as a skin colour, exactly as in English.
  'chat.emoji.tone.default': 'الافتراضي',
  'chat.emoji.tone.light': 'الفاتح',
  'chat.emoji.tone.mediumLight': 'الفاتح المتوسط',
  'chat.emoji.tone.medium': 'المتوسط',
  'chat.emoji.tone.mediumDark': 'الداكن المتوسط',
  'chat.emoji.tone.dark': 'الداكن',

  // The Unicode group names, shortened to fit a tooltip the same way the
  // English shortens them -- «الوجوه» for "Smileys & Emotion", «الطبيعة» for
  // "Animals & Nature" -- rather than transliterating the long form. A rail of
  // «و» between two nouns reads as noise in Arabic too.
  //
  // «الأخيرة» is not a Unicode group; it is this reader's own history, and it
  // is the tab `chat.emoji.empty` points at by name. The two must move
  // together.
  'chat.emoji.group.recent': 'الأخيرة',
  'chat.emoji.group.smileys': 'الوجوه',
  'chat.emoji.group.people': 'الأشخاص',
  'chat.emoji.group.nature': 'الطبيعة',
  'chat.emoji.group.food': 'الطعام',
  'chat.emoji.group.travel': 'السفر',
  'chat.emoji.group.activities': 'الأنشطة',
  'chat.emoji.group.objects': 'الأشياء',
  'chat.emoji.group.symbols': 'الرموز',
  'chat.emoji.group.flags': 'الأعلام',

  // ------------------------------------------------------- بطاقات الروابط

  // `{title}` is a stranger's website's Open Graph title, in a language we do
  // not know and in any script. The colon is punctuation for introducing it
  // and Arabic uses the same glyph, so it stays -- and in an RTL line it
  // renders to the left of «تشغيل الفيديو», which is where an Arabic reader
  // expects the introducer to be.
  //
  // BIDI, layout not catalogue: an English page title after that colon is a
  // long LTR run closing an RTL line. `isolate` wraps it, so the colon stays
  // with the Arabic; a title that itself ends in punctuation will still show
  // that punctuation at the run's left. Named, not marked.
  'chat.embed.playVideo': 'تشغيل الفيديو',
  'chat.embed.playVideoTitled': 'تشغيل الفيديو: {title}',

// ============================================================================
  // ar: the voice surfaces. The glossary, as a set, before the entries.
  // ============================================================================
  //
  // Two hundred and twenty-six keys describing one call from nine places at
  // once -- the sidebar bar, the stage and its dock, the tiles, the share, the
  // watch party, two device pickers, the region picker and the failure toasts.
  // The English header says why they are one namespace: a person looking at the
  // bar and the dock at the same time, which is the normal case, must not read
  // two different words for one button. That constraint is *harder* in Arabic
  // than in English, because Arabic has more ways to say each of these things
  // and every one of them is defensible in isolation. So the words are chosen
  // once here and then held, and where a word was rejected the rejection is
  // written down so that nobody spends the argument twice.
  //
  //   call              مكالمة                  -- fixed already by the guild
  //                     fragment («قبل أن تنجح أي مكالمة» in
  //                     `guild.voice.probe.reachable.body`).
  //   voice (subsystem) الصوت                   -- the thing that is connected
  //                     or not. «القناة الصوتية» for a voice channel, adjectival,
  //                     matching `perms.group.voice` and
  //                     `channel.voice.regionLabel` which already shipped.
  //   mute              كتم / إلغاء الكتم / مكتوم
  //   deafen            كتم السماع / إلغاء كتم السماع / لا يسمع
  //                     -- the hardest pair in this file. The long argument is
  //                     at `voice.bar.deafen`; the short version is that كتم is
  //                     the only ordinary Arabic verb for both, so the two
  //                     controls are separated by their *object* rather than by
  //                     their verb, which is also how the two icons separate
  //                     them (a microphone and a headphone).
  //   microphone        الميكروفون              -- the loan, universally. The
  //                     Academy's «مِجهار/لاقط» is not what anybody calls it and
  //                     not what the OS device list says.
  //   output            مخرج الصوت              -- for both the desktop panel's
  //                     "Output" and Android's "Audio output". One control in
  //                     two implementations (`voice.error.switchOutput` and
  //                     `voice.error.readRoutes` are literally shared), so one
  //                     word. «السمّاعات» was rejected: an output may be a
  //                     Bluetooth car, an earpiece or an HDMI monitor.
  //   camera            الكاميرا
  //   screen share      مشاركة الشاشة           -- fixed already by
  //                     `channel.type.voice.description` («حديث ومشاركة شاشة»).
  //                     Stopping one is «إيقاف المشاركة».
  //   stream            البث / جودة البث        -- kept distinct from مشاركة:
  //                     مشاركة is the act you perform, بث is the picture that
  //                     travels, and `voice.quality.label` is about the second.
  //                     `common.activity.streaming` already says «يبث».
  //   watch together    المشاهدة معًا           -- the feature's name, used
  //                     verbatim in the dock and the dialog title exactly as
  //                     English asks. A watcher «يشاهد»; watching «المشاهدة».
  //   viewer            مشاهد                   -- but `voice.room.watching`
  //                     counts «أشخاص … يشاهدون» rather than «مشاهدين», because
  //                     the row it names is a stack of *faces* and the sentence
  //                     is about people, not about an audience metric.
  //   relay             مُرحِّل                   -- fixed by the guild fragment,
  //                     with its own note there on why it is not «ريلاي».
  //   region            منطقة                   -- fixed by the guild fragment
  //                     and by `channel.voice.regionLabel`.
  //   noise suppression كبح الضجيج              -- the setting. The model that
  //                     does the heavy version is «النموذج العصبي», the neural
  //                     model, and used to be «نموذج إلغاء الضجيج» here because
  //                     English used to call it "the noise-cancellation model".
  //                     That was English naming one subsystem twice, not a
  //                     distinction; the real split is between a policy and a
  //                     file that can fail to download, and English draws it at
  //                     the right place now. ضجيج rather than ضوضاء
  //                     because ضجيج is the acoustic-engineering noun and
  //                     ضوضاء carries a social sense (a noisy street). Neither
  //                     may be كتم: that root is spent on mute and reusing it
  //                     here would make the suppressor read as a third mute
  //                     button.
  //   neural (model)    عصبي                    -- the settled Arabic for
  //                     neural networks. Not a transliteration.
  //   sealed / e2e      مشفّر من طرف إلى طرف, and the seal itself ختم / مختوم
  //                     -- English deliberately uses two words ("end-to-end
  //                     encrypted" for the call, "sealed" for the watch
  //                     position), so Arabic keeps two. تشفير over تعمية: no
  //                     key in ar.js had committed either way, and تشفير is
  //                     what every Arabic-language security page and every
  //                     Arabic messenger says, which is the same reasoning the
  //                     roles fragment used to pick the loan «إيموجي» over
  //                     «الرموز التعبيرية».
  //   permission        إذن / أذونات            -- and this is DELIBERATELY NOT
  //                     «صلاحية», which the guild fragment fixed for guild
  //                     permissions. They are different objects: a صلاحية is
  //                     authority this guild granted you over other people, an
  //                     إذن is a grant the operating system or the browser made
  //                     to the whole site. A reader who met one word for both
  //                     would look for the microphone in the role editor.
  //   fullscreen        ملء الشاشة
  //   pop out           نافذة منفصلة            -- one phrase for all four
  //                     places. This glossary used to carry two, «نافذة منفصلة»
  //                     for the action and «صورة داخل صورة» for the browser
  //                     feature, on the reading that English's own split
  //                     between "Pop out" and "picture in picture" was
  //                     deliberate. It was not; English says "pop out"
  //                     everywhere now and so does this file.
  //   volume            مستوى الصوت             -- never «الصوت» alone, which
  //                     in this namespace already means the voice subsystem.
  //   tab (browser)     علامة التبويب
  //   picker            منتقي                   -- fixed by
  //                     `guild.voice.add.nameHint` («منتقي المناطق») and by the
  //                     emoji picker above it. One word for one kind of control.
  //   chat              محادثة                  -- fixed by
  //                     `channel.perms.group.chat`, where the note says محادثة
  //                     is people talking and نص is the written thing.
  //   conversation (DM) المحادثة                -- the same word, knowingly.
  //                     `voice.call.noKeys` and `voice.call.sfuAddressUnknown`
  //                     are about a DM object; `voice.chat.label` is about a
  //                     panel. Arabic has no second noun here that is not a
  //                     euphemism, and no screen shows both at once.
  //
  // ---------------------------------------------------------------- register
  //
  // Modern Standard Arabic, and **one** convention for controls, held across
  // all 226 keys, identical to the one the roles/channel/bots fragment states:
  //
  //   * A **control** -- a button, a tooltip, a switch label, a field label, an
  //     accessible name -- takes the **مصدر** (verbal noun): «كتم», «قطع
  //     الاتصال», «مشاركة الشاشة», «توسيع فيديو {who}». This is the universal
  //     Arabic UI convention and it is what ar.js already does (`common.save`
  //     is «حفظ», not «احفظ»).
  //
  //     This namespace is where that rule earns its keep, because the English
  //     dock comment says the opposite: "they are imperatives: what pressing it
  //     will do". That is a statement about English, where a bare verb stem and
  //     an imperative are the same string and nobody can tell which was meant.
  //     Arabic can tell. «اكتم» is an order shouted at the reader; «كتم» is the
  //     name of an act. The dock is a row of round icon buttons whose tooltips
  //     are also their accessible names, and a screen reader announcing
  //     «اكتم، زر» has told somebody to do something rather than told them what
  //     the button is. So every one of the dock's seven, the bar's eight, the
  //     tile's six and the watch bar's six is a مصدر.
  //
  //   * A **sentence addressed to the reader** -- a hint, a remedy, an
  //     instruction about what to do next -- takes **صيغة الأمر**, masculine
  //     singular: «اسمح به في أذونات المواقع…», «الصق رابطًا», «دع الخادم
  //     يختار…», «شارك شاشتك بدلًا من ذلك…». ar.js already does this
  //     (`errors.mfa_required` is «أدخل الرمز»).
  //
  // The line between them is whether the string names a thing or tells the
  // reader to do something. `voice.share.choose` ("Choose what to share") is a
  // heading that instructs, so it is صيغة الأمر; `voice.share.contentLabel`
  // ("What you are sharing") is the accessible name of the same group of
  // radios, so it is a noun phrase. That pair is the clearest illustration in
  // the file of why the distinction is not cosmetic.
  //
  // Failure toasts keep ar.js's «تعذّر …» and carry **no full stop**: they are
  // the left half of `errors.context` (`'{context}: {message}'`). Everything
  // under `voice.error.*`, plus `voice.incoming.joinFailed`,
  // `voice.room.readFailed/watchFailed/unwatchFailed/qualityFailed` and
  // `voice.watch.startFailed`, obeys that. Everything that is a thrown
  // `Error` reaching a toast as its own sentence -- `voice.screen.no*`,
  // `voice.call.*`, `voice.devices.micPublishFailed` -- does end in a full
  // stop, because English does and because those are whole sentences.
  //
  // In-flight states are «جارٍ …», the house form (`common.saving`,
  // `common.loading`, `guild.voice.probe.checking`).
  //
  // Quotation marks are «…», the Arabic pair, per the doc and per
  // `errors.missing_permission`.
  //
  // ------------------------------------------------------- the six plural arms
  //
  // Four patterns below carry a `plural`: `voice.incoming.groupSize`,
  // `voice.room.inVoice`, `voice.room.watching` and
  // `voice.watch.waitingForMany`. Every one declares all six of
  // zero/one/two/few/many/other, and every one of them counts **people** --
  // people in a call, people watching a share, people still buffering. That is
  // the happiest possible case for Arabic and the arms are used properly:
  //
  //   zero   0      «لا أحد …» -- not «٠ شخص». A bare zero in an Arabic count
  //                 phrase reads as an unfilled placeholder. Follows ar.js's
  //                 own `common.convo.group` and `channel.voice.limitPeople`,
  //                 both of which already say «لا أحد».
  //   one    1      «شخص واحد» -- the `#` is dropped; the noun and واحد already
  //                 carry the number and printing the digit says it twice.
  //   two    2      «شخصان» -- the **real dual**, and this is the arm that
  //                 matters most in this namespace. A two-person call is the
  //                 single commonest call there is: every direct call is one.
  //                 English has no dual, so `voice.incoming.groupSize` renders
  //                 "Group call · 2 people" and nobody notices; Arabic renders
  //                 «مكالمة جماعية · شخصان», which is the form an Arabic
  //                 speaker would actually say out loud about two people on a
  //                 call. The numeral disappears into the noun's own shape, as
  //                 it does in `common.convo.group`'s «مجموعة - شخصان».
  //                 Writing `two` as a copy of `few` here would produce «٢
  //                 أشخاص», which is not a stylistic lapse -- it is wrong.
  //   few    3-10   «# أشخاص» -- broken plural, genitive.
  //   many   11-99  «# شخصًا» -- **singular** noun, accusative تمييز, with the
  //                 alif of tanwīn written because شخص ends in a consonant.
  //   other  100+   «# شخص» -- **singular** noun again, genitive. This is the
  //                 arm a translator copying English gets wrong, because
  //                 English says "100 people" and Arabic says the equivalent of
  //                 "100 person". «١٠٠ أشخاص» is an error.
  //
  // Verbs and adjectives inside these arms agree too, which is the other half
  // of why the count may never be concatenated on to a translated noun: see
  // `voice.room.watching`, where the participle moves through يشاهد / يشاهدان /
  // يشاهدون / يشاهد across the six.
  //
  // **No pattern in this namespace has an `=0` exact arm in the English**, so
  // none is preserved here. If one is ever added it goes *alongside* the six
  // and not instead of `zero` -- `pluralBranch` in `format.js` resolves exact
  // matches before asking `Intl.PluralRules`, and the coverage test filters
  // arms beginning with `=` out of the category check, so the two are counted
  // separately. `guild.purge.deleted` in this same file is the worked example.
  //
  // Where two arms come out byte-identical it is said at the entry. It happens
  // twice below and both times for the same orthographic reason set out over
  // `guild.gates.feeds.keyRotated`.
  //
  // --------------------------------------------- bidi, and what is not fixed
  //
  // **No bidi control characters anywhere in this fragment.** No U+200E, no
  // U+200F, no U+202A-E. Direction is set on `<html>` by `applyDocument` in
  // `locale.js`; interpolated values are wrapped in FSI/PDI by `isolate` in
  // `lib/i18n/index.js`. A catalogue that smuggled in RLM marks would be hiding
  // a layout bug rather than fixing one, and it would hide it in the one place
  // nobody looks.
  //
  // This namespace is the worst case in the client for that, and it is worth
  // saying exactly why rather than leaving it as a warning. Two different
  // things put Latin into these sentences:
  //
  //   * **Interpolated** Latin -- `{host}`, `{provider}`, `{region}`,
  //     `{channel}`, `{caller}`, `{who}`, `{label}`, `{id}`, `{reason}`. These
  //     are SAFE. `stringify` in `format.js` routes every string value through
  //     `services.isolate`, so a hostname or an OS device name arrives already
  //     wrapped and cannot drag the surrounding punctuation anywhere.
  //
  //   * **Literal** Latin -- `SFU`, `Telium`, `Android`, `WebAssembly`,
  //     `Web Audio API`, `https`, `48 kHz`, `ms`, `fps`, `✓`, `×`, `+`. These
  //     are written into the pattern, so `isolate` never sees them and the bidi
  //     algorithm resolves them against whatever neighbours them on the
  //     rendered line.
  //
  // Fourteen entries below carry literal Latin or a literal sign in a position
  // where the result is a prediction about the UBA rather than something
  // observed on a rendered line. Each is flagged **BIDI LAYOUT RISK** at its
  // own entry with the specific worry, and none is patched. They are, in file
  // order: `voice.bar.ping`, `voice.route.option`, `voice.noise.reason.
  // no-audio-context`, `voice.noise.reason.insecure-context`, `voice.noise.
  // reason.no-wasm`, `voice.noise.reason.no-48k`, `voice.call.noMic`,
  // `voice.call.cameraRefused`, `voice.call.sfuAddressUnknown`,
  // `voice.refusal.sfu`, `voice.refusal.relay`, `voice.room.more`,
  // `voice.share.summary`, `voice.watch.elapsedOf`. Several more strings
  // contain `Telium` or `SFU` surrounded on both sides by Arabic words, which
  // is the bidi-safe case the shipped `channel.voice.regionHint` note already
  // established -- a standalone Latin run between two RTL runs resolves to the
  // paragraph direction -- and those are not flagged.

  // ----------------------------------------------- the sidebar connection bar

  // The fallback room name, one word, sharing a 2.5rem line with a timer.
  // Indefinite and bare: it is standing in for a channel name, so it must not
  // look like a definite reference to something the reader can go and find.
  'voice.bar.channel': 'صوت',
  // The DM equivalent. «رسالة مباشرة», the settled Arabic for a direct message,
  // kept singular as English has it even though the thing named is a thread:
  // this is the label for *where the call is*, and the reader recognises the
  // product's own name for that place.
  'voice.bar.directMessage': 'رسالة مباشرة',

  // «جارٍ …», the house in-flight form, with the ellipsis English uses.
  'voice.bar.connecting': 'جارٍ الاتصال…',
  // "Voice connected", and English's comment insists on the two words: the bar
  // sits beside several other things that could be connected. Arabic keeps
  // both, as a nominal sentence -- «الصوت متّصل», subject then predicate, which
  // is how Arabic states a current condition without a verb. «تم الاتصال»
  // would say the connecting *finished*, an event, where this is a state that
  // persists for the length of the call.
  'voice.bar.connected': 'الصوت متّصل',

  // The meter's two answers. «جارٍ القياس» rather than a bare «قياس», because
  // this is a state the tooltip reports and not the name of a control -- the
  // one place in this file where an in-flight form and the مصدر rule pull in
  // different directions, and the in-flight form wins because nothing here is
  // pressable.
  'voice.bar.measuring': 'جارٍ القياس',
  // LEFT PARTLY IN ENGLISH (`ms`). The unit is a Latin abbreviation and stays
  // one, exactly as `channel.voice.bitrateValue` keeps `kbps` and as
  // `format.bytes.*` keep `KB`/`MB`. Arabic technical writing uses the SI
  // abbreviations; «مِلّي ثانية» spelled out would be three times the width in
  // a tooltip sized for four characters. The space before it is the SI
  // convention and English's comment asks a locale that writes it differently
  // to change it here -- Arabic does not.
  //
  // BIDI LAYOUT RISK, reported and not patched: `{ms}` has no `, number` on it,
  // so `stringify` routes it through `services.number` (Arabic-Indic digits)
  // and, being a number rather than a string, it is NOT passed to `isolate`.
  // The rendered run is therefore AN digits, a space, then an L run, with no
  // Arabic on either side of the whole string. It should resolve to «٤٢ ms»
  // reading right-to-left, but an AN/L boundary with a neutral between them is
  // exactly the configuration that goes wrong when a container sets an
  // unexpected direction. If it renders as «ms ٤٢» the fix is `direction: ltr`
  // on the meter's own element, not a mark in this string.
  'voice.bar.ping': '{ms} ms',

  'voice.bar.disconnect': 'قطع الاتصال',
  // The accessible name of the 2x2 grid, heard and never drawn. «أدوات الصوت»
  // and not «أدوات المكالمة»: this grid is in the sidebar bar, where the word
  // the rest of the bar uses is الصوت, and `voice.stage.controls` on the stage
  // is the one that says المكالمة. Two rows of controls in two places, named
  // after the two things they are attached to, which is what English does too.
  'voice.bar.toolbar': 'أدوات الصوت',

  // ---------------------------------------------------------------------------
  // MUTE vs DEAFEN. The hardest pair in this file, argued once, here, and then
  // held in `voice.bar.mic`, `voice.bar.deafen`, `voice.dock.mic`,
  // `voice.dock.deafen`, `voice.tile.muted` and `voice.tile.deafened`.
  //
  // The problem: ordinary Arabic has one verb, كتم, and it covers both. You
  // كتم a microphone and you كتم a speaker and you كتم a whole call. English
  // has two words only because "deafen" was borrowed into this product from
  // gaming voice chat, where it acquired a meaning it does not have in
  // ordinary English either -- nobody outside a voice client says "deafen me".
  // So Arabic is not missing a word; English invented one.
  //
  // Four candidates were considered and three rejected:
  //
  //   1. **إصمام / أصمّ** (root ص-م-م, literally "to make deaf"). This is the
  //      exact lexical match and it is the wrong answer. إصمام is a medical
  //      noun; a reader meeting it on a headphone icon would not connect it to
  //      audio at all, and the maṣdar is rare enough that many readers would
  //      have to work it out. Precision that has to be decoded is not
  //      precision.
  //   2. **إسكات** ("silencing"). A second word from a second root, but it is a
  //      near-synonym of كتم rather than a contrast with it, so the two squares
  //      would read as two ways of saying the same thing -- which is precisely
  //      the failure the English header warns about ("a person looking at both
  //      at the same time will reasonably conclude that they do different
  //      things", and here they would conclude the opposite).
  //   3. **A transliteration** («ديفن»). Rejected on the same grounds the guild
  //      fragment rejected «ريلاي» for مُرحِّل: a loan is justified when it is
  //      what people actually say (إيموجي, ميكروفون) and not when it is a word
  //      nobody has ever said in Arabic.
  //   4. **Keep the verb, split on the object.** Chosen.
  //
  // So: mute is «كتم» with the microphone as the understood object, and deafen
  // is «كتم السماع» -- muting the *hearing*. That is what the control does,
  // exactly and literally: it shuts what reaches your ears, and it shuts your
  // microphone as a consequence. The two are a pair, which they should be
  // (they are drawn as a pair, a microphone square beside a headphone square),
  // and what distinguishes them is the noun, which is the half a reader's eye
  // lands on. «كتم» / «كتم السماع» differ at a glance in a way that «كتم» /
  // «إسكات» do not.
  //
  // The states follow from the controls. Muted is «مكتوم», the passive
  // participle, an adjective describing the person. Deafened is **«لا يسمع»**
  // -- "does not hear" -- and deliberately NOT «مكتوم السماع», because on a
  // name plate the reader wants the fact and not the mechanism, and because
  // «لا يسمع» is what one person in a call would actually say about another.
  // It also solves a problem English has and hides: a deafened person is also
  // muted, so the two glyphs appear together, and «مكتوم» beside «مكتوم
  // السماع» would look like a rendering bug. «مكتوم» beside «لا يسمع» reads as
  // two facts.
  // ---------------------------------------------------------------------------

  // The microphone square. Four arms, and two of them are states rather than
  // offers, exactly as English has it.
  //
  // `muted` is the bare «مكتوم» -- muted *because* deafened -- and it is an
  // adjective and not an offer, because the headphone square beside it is
  // already saying why. English's comment makes that call and Arabic honours
  // it rather than helpfully adding «بسبب كتم السماع», which would be a second
  // sentence on a square with room for two words.
  //
  // `serverMuted` names the server as the agent and puts it second, which is
  // Arabic's verb-subject order: «كتمك الخادم» is literally "muted you, the
  // server did". Two words, second person, and the object pronoun is suffixed
  // rather than standing free -- the shortest grammatical form there is, which
  // matters because these four squares are a fixed-width 2x2 and the longest
  // arm sets the truncation for all of them.
  'voice.bar.mic': '{state, select, serverMuted {كتمك الخادم} muted {مكتوم} unmute {إلغاء الكتم} other {كتم}}',
  // The headphone square. `serverDeafened` is «كتم الخادم سماعك» -- three
  // words, verb then subject then object, and it is **the longest arm in
  // either square and therefore the one that sets the truncation width for all
  // seven**. That is reported rather than fixed: every shorter phrasing tried
  // either dropped the server (and English's comment is explicit that the
  // server must be named, because the flag may be set by a moderator, an
  // automod rule or the guild's configuration and only "the server" covers all
  // three) or dropped the hearing (and then it is indistinguishable from
  // `voice.bar.mic`'s `serverMuted`). If the square truncates, the fix is the
  // square.
  'voice.bar.deafen': '{state, select, serverDeafened {كتم الخادم سماعك} undeafen {إلغاء كتم السماع} other {كتم السماع}}',

  // Deliberately byte-identical to the dock's equivalents below, because they
  // are the same two buttons in two places and a person can see both at once.
  // مصدر throughout: «تشغيل» and «إيقاف» name the act. «شغّل الكاميرا» would be
  // an order, and these are tooltips on icons.
  'voice.bar.videoStart': 'تشغيل الكاميرا',
  'voice.bar.videoStop': 'إيقاف الكاميرا',
  'voice.bar.shareStart': 'مشاركة الشاشة',
  // «إيقاف المشاركة» and not «إيقاف مشاركة الشاشة»: the definite «المشاركة»
  // refers back to the share that is running, which is the only one there is,
  // and the shorter form fits the square. Same string as
  // `voice.screen.stopSharing` and the `yes` arm of `voice.dock.share`, which
  // is the point.
  'voice.bar.shareStop': 'إيقاف المشاركة',

  // ------------------------------------------------------------- the dock

  // The round bar under the stage. Every one of these is a tooltip and an
  // accessible name at once. English calls them imperatives; Arabic makes them
  // مصدر, for the reason argued at length in the register note above -- an
  // Arabic imperative announced by a screen reader is an order, and «اكتم، زر»
  // is not a label.
  'voice.dock.camera': '{on, select, yes {إيقاف الكاميرا} other {تشغيل الكاميرا}}',
  'voice.dock.mic': '{muted, select, yes {إلغاء الكتم} other {كتم}}',
  'voice.dock.deafen': '{deafened, select, yes {إلغاء كتم السماع} other {كتم السماع}}',
  'voice.dock.share': '{on, select, yes {إيقاف المشاركة} other {مشاركة الشاشة}}',
  'voice.dock.disconnect': 'قطع الاتصال',
  // Phones only. The arm is named after the `facingMode` currently in force,
  // so `environment` means the back camera is live and the press goes to the
  // front one -- the arm name is a machine token and is untouched.
  // «الأمامية»/«الخلفية» are the ordinary Arabic for front and back cameras and
  // are what every Arabic phone UI says.
  'voice.dock.flip': '{facing, select, environment {التبديل إلى الكاميرا الأمامية} other {التبديل إلى الكاميرا الخلفية}}',
  // The feature's name, which must be the same string as `voice.watch.title`
  // and is.
  //
  // The English used to be inconsistent here -- the `yes` arm said "End watch
  // party" while the `other` arm, the dialog title and `voice.watch.startFailed`
  // all said "watch together" -- and Arabic did not copy the inconsistency.
  // English now says "End watching together" in both, so the note that used to
  // flag this is history rather than a warning.
  //
  // The Arabic value is unchanged and the reason it does not simply mirror the
  // new English is grammatical, not stylistic. «إنهاء المشاهدة معًا» does not
  // work: معًا is an adverb and cannot sit inside an iḍāfa, so the phrase reads
  // as broken rather than as terse. «إنهاء جلسة المشاهدة» ends *the watching
  // session*, which shares its head noun المشاهدة with the `other` arm -- the
  // reader sees the same word in both -- and is also the more accurate thing to
  // end, since the press runs `watch.end` and takes the session away from
  // everyone. Re-read and re-stamped rather than rewritten.
  'voice.dock.watch': '{on, select, yes {إنهاء جلسة المشاهدة} other {المشاهدة معًا}}',

  // ----------------------------------------------------------- the stage

  // English's "stage" never reaches the screen -- it is the section's name in
  // the source, not a word in any string -- so no Arabic equivalent had to be
  // chosen, and «منصّة» is deliberately not introduced. A word that appears in
  // no string is a word a reader cannot learn.
  //
  // «بعد» carries "yet", which is the half that says this is a room that will
  // fill rather than a room that is broken.
  'voice.stage.emptyTitle': 'لا أحد هنا بعد',
  // مصدر, a button. «الانضمام إلى الصوت» keeps English's subsystem noun: the
  // stage uses this only when no caller passed better words, and the caller
  // that knows better is a DM.
  'voice.stage.join': 'الانضمام إلى الصوت',
  'voice.stage.rejoin': 'إعادة الانضمام',
  // The stage's own controls, named after the call, against the bar's
  // `voice.bar.toolbar` which is named after the subsystem. Heard, never drawn.
  'voice.stage.controls': 'أدوات المكالمة',

  // Autoplay. «يحتجز» -- holds, detains -- and not «يحجب» (blocks): English
  // chose "holding" over "blocking" and the difference is real, because the
  // audio is not refused, it is waiting, and the sentence's whole job is to say
  // that one click releases it. «تتفاعل مع الصفحة» is second person singular
  // masculine, the register the file holds throughout.
  'voice.stage.audioBlocked': 'يحتجز متصفّحك صوت هذه المكالمة حتى تتفاعل مع الصفحة.',
  'voice.stage.resumeAudio': 'تشغيل الصوت',

  // The bare forms, used where an icon has already said "screen" or "camera".
  // Arabic attaches the second-person possessive as a suffix -- «شاشتك»,
  // «كاميرتك» -- which is exactly why English branches on `mine` rather than
  // interpolating a name: there is no string this catalogue could have glued
  // «You» on to and got «شاشتك». The `other` arm is the bare `{who}`, isolated
  // by the runtime, and nothing is added around it.
  'voice.stage.shareName': '{mine, select, yes {شاشتك} other {{who}}}',
  'voice.stage.cameraName': '{mine, select, yes {كاميرتك} other {{who}}}',
  // Screen-reader-only, beside a dot that means the share started while you
  // were looking elsewhere. «جديدة» is feminine, agreeing with the مشاركة it
  // sits on; the dot is a shape and carries no word, so this is the whole of
  // what a screen reader gets.
  'voice.stage.newShare': 'جديدة',

  // Shown once, above a call the relay cannot listen to, and worth a sentence
  // rather than a padlock because it is the claim the whole media path exists
  // to make. «يحملها» -- carries it -- matches the guild fragment's «ينقل» for
  // an SFU carrying a channel without being a party to it. «دون أن يقدر على
  // سماعها» is "without being able to hear it", and the *able* is the load
  // bearing word: not "without hearing it", which would be a promise about
  // behaviour, but a statement about capability.
  'voice.stage.sealedNotice': 'هذه المكالمة مشفّرة من طرف إلى طرف. يحملها الخادم دون أن يقدر على سماعها.',

  // ------------------------------------------------------------- the tiles

  // The full form, an accessible name on the video element itself and the only
  // thing a screen reader has. Arabic's iḍāfa does the work English's
  // possessive `'s` does, and it puts the noun first: «كاميرا {who}», where
  // English puts the name first. That reordering is the thing English's comment
  // predicted ("the moment the name moves inside the sentence -- as it must in
  // a language that puts the object first -- the join has to be the
  // catalogue's to make").
  'voice.tile.cameraLabel': '{mine, select, yes {كاميرتك} other {كاميرا {who}}}',
  // Expanding is a verb about a person and collapsing is a verb about a
  // rectangle, and English keeps the asymmetry deliberately (you expand a
  // *video*, you return a *person* to the grid). Arabic keeps it too rather
  // than tidying it into a matched pair.
  //
  // REORDERED: both arms front the مصدر and put `{who}` in the iḍāfa slot after
  // the noun -- «توسيع فيديو {who}» against English's "Expand {who}'s video".
  // The placeholder therefore moves from second position to third, which is
  // legal and invisible to the coverage test (it counts names, not order) and
  // is the whole reason the join could not stay in the component.
  'voice.tile.expand': '{mine, select, yes {توسيع فيديوك} other {توسيع فيديو {who}}}',
  'voice.tile.collapse': '{mine, select, yes {إعادة فيديوك إلى الشبكة} other {إعادة {who} إلى الشبكة}}',

  // The two glyph states on a name plate, repeated as words for anything that
  // cannot see a glyph. Adjectives describing the person, not buttons -- see
  // the long mute/deafen note above for why these two are «مكتوم» and «لا
  // يسمع» and not two shapes of one word.
  'voice.tile.muted': 'مكتوم',
  'voice.tile.deafened': 'لا يسمع',

  // Corner pills, dropped entirely on a compact tile rather than truncated, so
  // length is taste here and not breakage. «لا ميكروفون» is the telegraphic
  // negation Arabic uses on a status chip -- «لا يوجد ميكروفون» is the full
  // sentence and belongs in `voice.call.noMic`'s `missing` arm, not on a pill.
  'voice.tile.noMic': 'لا ميكروفون',
  // «الكاميرا تعمل» -- a nominal sentence, "the camera is working". «كاميرا
  // مفتوحة» would be the literal "camera on" and reads as a description of the
  // hardware rather than of this person's tile.
  'voice.tile.camera': 'الكاميرا تعمل',
  // Possessive, because the whole point is that the choice is still yours and
  // is one click from being given up. Arabic's suffix carries it in one word.
  'voice.tile.yourPick': 'اختيارك',

  // Matches `common.showMore`'s «عرض المزيد» in its noun, shortened the way a
  // tile's overflow button has to be. Not `common.a11y.menu`'s «إجراءات أخرى»,
  // which is an accessible name for an invisible menu; this one is drawn.
  'voice.tile.more': 'المزيد',
  // "Pop out". «نافذة منفصلة» -- a separate window -- names the destination
  // rather than the gesture, because Arabic has no single verb for popping
  // something out of a page and every attempt at one («إخراج», «انتزاع») reads
  // as removing it. Held identically in `voice.screen.noVideo`,
  // `voice.screen.noPip` and `voice.error.pip` -- all four, now that English
  // has stopped calling the fourth one "picture in picture" and this file has
  // stopped mirroring the split.
  'voice.tile.pip': 'نافذة منفصلة',
  // The two sliders, which have to be told apart at a glance because somebody
  // turning down a screen share almost always wants to keep hearing the
  // person. «مستوى الصوت» is the full phrase and never shortened to «الصوت»,
  // which in this namespace already means the voice subsystem
  // (`voice.bar.connected`).
  'voice.tile.volume': 'مستوى الصوت',
  'voice.tile.screenAudio': 'صوت الشاشة',

  // The consent button on somebody's share in an SFU room. Three arms, because
  // a narrow tile drops to the bare verb. مصدر throughout, and the bare arm is
  // «إيقاف» against the labelled «إيقاف المشاهدة» -- the same relationship
  // English's "Stop" has to "Stop watching".
  'voice.tile.watchGate': '{state, select, stop {إيقاف} stopWatching {إيقاف المشاهدة} other {مشاهدة}}',

  // ------------------------------------------------------- the screen share

  'voice.screen.label': '{mine, select, yes {شاشتك} other {شاشة {who}}}',
  'voice.screen.fullscreen': 'ملء الشاشة',
  // «إعادة ضبط التكبير» -- resetting the zoom. Not «تكبير عادي», which would
  // name a state; this is a button that performs an act.
  'voice.screen.resetZoom': 'إعادة ضبط التكبير',
  'voice.screen.stopSharing': 'إيقاف المشاركة',

  // The four refusals from fullscreen and picture-in-picture. These are thrown
  // as `Error`s and land in a toast as whole sentences, so they end in a full
  // stop -- unlike everything under `voice.error.*`, which are halves of
  // `errors.context`.
  'voice.screen.noScreen': 'لا توجد شاشة لعرضها.',
  // «لن ينتقل» -- will not go -- keeps English's refusal rather than softening
  // to «لا يستطيع». The browser is able and declines, which is what "will not"
  // says and what a reader needs in order to stop retrying.
  'voice.screen.noFullscreen': 'هذا المتصفّح لن ينتقل إلى ملء الشاشة.',
  'voice.screen.noVideo': 'لا يوجد فيديو لإخراجه في نافذة منفصلة.',
  // «نافذة منفصلة» here too, matching `voice.tile.pip` and the line above.
  // This used to say «صورة داخل صورة» -- picture in picture -- on the reading
  // that English's own split between "Pop out" and "picture in picture" was
  // deliberate: a gesture in the menu and a browser feature in the failure. It
  // was not deliberate. English now says "pop out" in all four places, so the
  // second Arabic noun has gone with it, and «لا يدعم» (does not support, said
  // of a named feature) has become «لا يستطيع إخراج» (cannot take out), which
  // is what you say about a gesture.
  'voice.screen.noPip': 'هذا المتصفّح لا يستطيع إخراج الفيديو في نافذة منفصلة.',

  // The four rungs of `WATCH_QUALITIES`. All four adjectives are **feminine**,
  // agreeing with «جودة» in the label above them, which is the ordinary Arabic
  // behaviour for a list of options under a noun and which English cannot
  // express at all.
  'voice.quality.label': 'جودة البث',
  // «تلقائية», feminine, and therefore NOT the same string as
  // `voice.region.auto` below, which is «تلقائي» masculine. That divergence is
  // deliberate and is explained at `voice.region.auto`: the region picker's
  // wording is pinned by an already-shipped key.
  'voice.quality.auto': 'تلقائية',
  'voice.quality.low': 'منخفضة',
  'voice.quality.medium': 'متوسطة',
  'voice.quality.high': 'عالية',

  // The pill naming which encoder bet is in force. These are bets about
  // *content*, not qualities, so they are bare nouns and not adjectives --
  // «تفاصيل» and «حركة» are what the encoder is protecting, which is exactly
  // what the pair of options in the share dialog below says in full.
  'voice.preset.detail': 'تفاصيل',
  'voice.preset.motion': 'حركة',
  // The fallback for a share that started before presets existed. «مباشر» --
  // live, in the broadcast sense -- and it is an adjective where the other two
  // are nouns, which is also true of the English and is the mark of it being
  // the odd one out rather than a third bet.
  'voice.preset.live': 'مباشر',

  // --------------------------------------------------------- the chat toggle

  // The visible word is the noun, the accessible name and tooltip are the act,
  // which is why English made them two keys. «محادثة» is fixed by
  // `channel.perms.group.chat`, whose own note says محادثة is people talking
  // and نص is the written thing -- and this panel is people talking.
  'voice.chat.label': 'محادثة',
  'voice.chat.toggle': '{open, select, yes {إغلاق المحادثة} other {فتح المحادثة}}',
  // «إشارة» هي الكلمة المثبَّتة في المسرد للـ mention. الجموع الستة كاملة لأن
  // العدد هنا صغير وواقعي: اثنتان وثلاث إشارات تحدثان فعلًا في مكالمة.
  'voice.chat.toggleMentions': '{open, select, yes {إغلاق المحادثة} other {فتح المحادثة}}، {count, plural, zero {لا إشارات} one {إشارة واحدة} two {إشارتان} few {# إشارات} many {# إشارة} other {# إشارة}}',
  'voice.chat.toggleUnread': '{open, select, yes {إغلاق المحادثة} other {فتح المحادثة}}، غير مقروءة',

  // ------------------------------------------------- Android's output picker

  'voice.route.title': 'مخرج الصوت',
  'voice.route.finding': 'جارٍ البحث عن المخارج…',
  // LEFT IN ENGLISH, in the sense that matters: `{label}` is **Android's own
  // string**, already localised by the platform to the system language, and it
  // travels through this pattern as a value precisely so that it is never
  // concatenated on to a prefix. "Bluetooth", "Earpiece" and the automatic
  // route's own label arrive from the bridge and are drawn exactly as they
  // arrive. Nothing in this entry touches them.
  //
  // The tick is kept as `✓` rather than replaced with a word or a bracket.
  // English's comment invites a language that marks the current choice
  // differently to change it; Arabic does not mark it differently -- a tick
  // before the chosen row is as readable in an Arabic menu as in an English
  // one, and it is a glyph rather than a letter, so it does not need
  // translating.
  //
  // BIDI LAYOUT RISK, reported and not patched: `✓` is a bidi-neutral (ON) at
  // the very start of the paragraph, followed by an FSI-isolated value that may
  // itself be Latin ("Bluetooth"). A leading neutral takes the paragraph
  // direction, so the tick should sit at the right-hand end of the row, which
  // is the correct place for it in RTL. That is a prediction. If it lands on
  // the left of a Latin device name, the fix is to draw the tick as its own
  // element in the sheet rather than to put a mark in this string.
  'voice.route.option': '{state, select, selected {✓ {label}} other {{label}}}',
  // Only ever shown before the bridge answers; once it has, Android's own
  // `automatic_label` replaces this. Masculine, agreeing with «مخرج».
  'voice.route.automatic': 'تلقائي',
  // «منتقي» is the fixed word for a picker (`guild.voice.add.nameHint`).
  // Indefinite «مخارج» because the complaint is that there is no such control
  // at all, not that a particular one is missing.
  'voice.route.unsupported': 'هذا الجهاز لا يوفّر منتقي مخارج.',

  // -------------------------------------------- the desktop device panel

  'voice.devices.title': 'أجهزة الصوت',
  // «ما تستمع إليه هذه المكالمة، وأين تُسمَع» -- what this call listens to, and
  // where it is heard. English's "where it plays" is intransitive in a way
  // Arabic's «تشغّل» is not, so the second clause goes passive; the passive is
  // also the more accurate half, because where it plays is not something the
  // call decides.
  'voice.devices.subtitle': 'ما تستمع إليه هذه المكالمة، وأين تُسمَع.',
  // The tooltip on the panel's trigger, which says what the panel is *for*
  // rather than repeating its name. مصدر, because it names the act the trigger
  // performs.
  'voice.devices.open': 'اختيار الميكروفون ومخرج الصوت',
  'voice.devices.refreshing': 'جارٍ التحديث…',

  'voice.devices.input': 'الميكروفون',
  'voice.devices.output': 'مخرج الصوت',
  // "System default", not "Default", and English's comment says why: the
  // default is not Telium's, it is the one the OS is currently pointing at, and
  // saying so is what makes the rest of the list worth reading. «افتراضي
  // النظام» is built on the same iḍāfa as the already-shipped «افتراضي الخادم»
  // and «افتراضي النقابة» in `guild.voice.serverDefault`, so the three defaults
  // in this product read as one family of facts.
  //
  // The two keys are byte-identical, as they are in English, and are kept as
  // two keys for the same reason: a language that inflects the adjective for
  // the microphone's gender against the speaker's would need both, and Arabic
  // is one hair away from being that language -- these are both iḍāfas with no
  // agreement in them, which is the only reason they collapse.
  'voice.devices.defaultMic': 'افتراضي النظام',
  'voice.devices.defaultSpeakers': 'افتراضي النظام',

  // A device the OS refused to name, which is what an un-permissioned browser
  // reports for every device it has. `{n}` is the position in the list and
  // `{id}` is six characters of the hardware identifier. Both are values in a
  // sentence, exactly so that a language wanting the identifier first could
  // move it; Arabic does not want that -- a noun then its ordinal then its
  // disambiguator is the same order Arabic uses -- so nothing moves.
  //
  // `{n}` has no `, number` on it and so comes out in Arabic-Indic digits via
  // `stringify`; `{id}` is a string and is isolated. Neither is flagged: the
  // whole string is bracketed by Arabic on the left and the isolate handles the
  // right.
  'voice.devices.unnamedMic': 'ميكروفون {n} ({id})',
  'voice.devices.unnamedOutput': 'مخرج {n} ({id})',

  // What sits between the microphone and the network. See the glossary note
  // above for كبح vs إلغاء and for ضجيج vs ضوضاء; the short version is that
  // كبح الضجيج is the running setting and «نموذج إلغاء الضجيج» is the file that
  // can fail to load, and English draws the same line.
  'voice.devices.noise': 'كبح الضجيج',
  // Reuses ar.js's own `common.off` rather than inventing a second word for
  // one idea.
  'voice.devices.noiseOff': 'معطّل',
  // Names the *browser*, because that is exactly the distinction English's
  // comment insists on: this is WebRTC's own suppressor, it costs nothing and
  // it is already there. «المتصفّح», definite, because it is this browser.
  'voice.devices.noiseBrowser': 'المتصفّح',
  // One option, two states, one message -- English's comment explains that it
  // used to be a word with a parenthesis appended, which reads as an aside in
  // English and as a second sentence stuck on the end in a language that would
  // rather put the qualifier first. Arabic is happy with the parenthesis in
  // place, so the arms keep English's shape, and the in-flight half uses the
  // house «جارٍ …» form rather than a bare «قياس».
  'voice.devices.noiseNeural': '{state, select, measuring {عصبي (جارٍ القياس…)} other {عصبي}}',

  // The semicolon in English joins a refusal to its consequence. Arabic uses
  // «؛» the Arabic semicolon, which is the same punctuation mark doing the same
  // job and is not a bidi control -- it is an ordinary character in the Arabic
  // block, and it mirrors automatically.
  'voice.devices.noSinkId': 'هذا المتصفّح لا يستطيع اختيار مخرج؛ فهو يتبع النظام.',

  // Two failures from the microphone-switching path. Both are thrown, both
  // reach a toast, and neither is phrased as advice, because neither has a
  // remedy -- which is why «لم تنشر» (it did not publish) rather than «تعذّر
  // النشر» (publishing failed). The first states what happened to the call; the
  // second states what this call cannot do. Neither takes the «تعذّر …» form,
  // which in this file is reserved for `errors.context` halves.
  'voice.devices.micPublishFailed': 'لم تنشر المكالمة الميكروفون الجديد.',
  'voice.devices.micSwitchUnsupported': 'هذه المكالمة لا تستطيع تغيير الميكروفون أثناء عملها.',

  // --------------------------------------------- why the neural model cannot

  // The nine refusals from `neuralCapability()` and `probeNeural()`, keyed by
  // the machine reason the probe returns. The hyphens in the key segments are
  // the probe's own vocabulary spelled exactly as it spells it, and the keys
  // are copied character for character.
  //
  // All nine are statements about a device or a browser, never about the
  // reader, and none of them suggests a fix -- there is not one. Arabic makes
  // it easy to sound like an apology here («للأسف», «نعتذر») and every one of
  // these was written away from that, the same discipline the guild fragment
  // applied to the probe verdicts.

  // «الخيط الرئيسي» is the settled Arabic for the main thread and is what every
  // Arabic-language description of an AudioWorklet says.
  'voice.noise.reason.no-audio-worklet': 'هذا المتصفّح لا يستطيع تشغيل معالجة الصوت خارج الخيط الرئيسي.',
  // LEFT PARTLY IN ENGLISH (`Web Audio API`). A W3C specification's name. The
  // precedent is the guild fragment's `CORS` and this file's `SFU`: a spec name
  // that has been translated no longer matches the console error, the MDN page
  // or the search the reader is about to run. «واجهة الصوت للويب» would be a
  // coinage with no documentation behind it.
  //
  // BIDI LAYOUT RISK, reported and not patched: `Web Audio API` is a
  // three-word Latin run with an internal space, sitting at the very end of an
  // Arabic sentence and followed by a full stop. The internal spaces are
  // neutrals *between two L runs* and resolve to L, so the phrase should hold
  // together; the final stop is a neutral between an L run and the end of an
  // RTL paragraph and should take the paragraph direction and land at the left.
  // Both are predictions. Multi-word Latin at a sentence end is the shape most
  // likely to render with the stop in the wrong place, and it is unpatched
  // here on purpose.
  'voice.noise.reason.no-audio-context': 'هذا المتصفّح لا يتيح Web Audio API.',
  // LEFT PARTLY IN ENGLISH (`https`). The scheme, as typed. Precedent:
  // `guild.voice.address.wrongScheme` keeps `http` and `https` for the same
  // reason -- they are things the reader types and reads in an address bar.
  //
  // BIDI LAYOUT RISK, reported and not patched: the same shape the guild
  // fragment already flagged. `https` is a literal, so `isolate` never sees it,
  // and here it sits inside parentheses at the end of the sentence, so the
  // closing paren and the full stop are two consecutive neutrals between an L
  // run and the paragraph end. Parentheses are also mirrored glyphs, which is a
  // second thing that can go wrong independently.
  'voice.noise.reason.insecure-context': 'تحتاج معالجة الصوت إلى اتصال آمن (https).',
  // LEFT PARTLY IN ENGLISH (`WebAssembly`). A product name, in the sense the
  // English header means: it is the name of a specific technology, it appears
  // in the browser's own error text, and «تجميع الويب» is not a thing anybody
  // has written.
  //
  // BIDI LAYOUT RISK, reported and not patched: a single Latin run with Arabic
  // on both sides, which is the case `channel.voice.regionHint`'s note calls
  // bidi-safe. Flagged all the same because the run is eleven characters and
  // internally capitalised, which is the shape most likely to be broken across
  // a line at a width where the neighbouring Arabic is not.
  'voice.noise.reason.no-wasm': 'هذا المتصفّح لن يشغّل WebAssembly في هذه الصفحة.',
  // «أنوية المعالج» -- CPU cores -- and CPU is **translated** here where SFU
  // and WebRTC are not. The distinction is the one the English header draws:
  // SFU is a name with no Arabic equivalent and with documentation behind it,
  // while a CPU is an ordinary object that every Arabic-language operating
  // system, phone spec sheet and shop window calls «المعالج». Leaving it Latin
  // would be affectation, not fidelity.
  //
  // REORDERED: English says "has too few cores to spare one", subject-verb;
  // Arabic fronts the noun phrase «أنوية المعالج في هذا الجهاز» and puts the
  // comparison after it, because «هذا الجهاز لديه أنوية قليلة جدًا» would be a
  // calque of an English possessive construction that Arabic states as a
  // relation instead.
  'voice.noise.reason.one-core': 'أنوية المعالج في هذا الجهاز أقل من أن يُفرَّغ أحدها للنموذج.',
  // LEFT PARTLY IN ENGLISH (`48 kHz` -- **both the numeral and the unit**).
  //
  // This is the one entry where a literal digit is kept in Latin script in
  // defiance of ar.js's header rule that "Arabic-Indic digits are Intl's
  // business". The rule is about *counts* -- values that arrive through
  // `{n, number}` and that the reader adds up. `48 kHz` is not a count; it is a
  // sample rate, a single technical token that appears identically on every
  // datasheet, in every audio driver panel and in every browser console. There
  // is no placeholder to route it through, so the only alternatives were
  // «٤٨ kHz» -- a mixed-script token with no precedent anywhere in this
  // catalogue, where the numeral is in one script and its unit in another --
  // or «٤٨ كيلوهرتز», which is readable but is no longer the string the reader
  // will find in their sound settings. The token is kept whole.
  //
  // BIDI LAYOUT RISK, reported and not patched, and this one is the worst in
  // the file: `48 kHz` is EN digits followed by a space followed by an L run,
  // embedded in RTL, followed immediately by a full stop. That is three
  // different bidi classes in five characters plus a trailing neutral. It
  // should render as «48 kHz» left-to-right as a unit with the stop at the
  // left; it is unverified. No mark was inserted. If it breaks, the token wants
  // an element with `direction: ltr; unicode-bidi: isolate` around it, which is
  // a change to the component that draws the reason list.
  'voice.noise.reason.no-48k': 'عتاد الصوت في هذا الجهاز لا يعمل عند 48 kHz.',
  // «الزمن الحقيقي» is the settled Arabic for real time in a processing sense.
  'voice.noise.reason.too-slow': 'هذا الجهاز ليس سريعًا بما يكفي لتشغيل النموذج في الزمن الحقيقي.',
  // These two are the model *file* and not «كبح الضجيج», which is the setting.
  // They used to say «نموذج إلغاء الضجيج» -- the noise-cancellation model --
  // because English said "noise-cancellation model" here and "noise
  // suppression" in the setting, and Arabic mirrored the split with إلغاء
  // against كبح.
  //
  // The split was an English mistake, not a distinction. What actually needs
  // two names is the feature (كبح الضجيج) and the optional model that can fail
  // to load, which is the neural one -- «النموذج العصبي» -- the word already
  // used two keys down in `voice.noise.cannot` and in `voice.noise.fellBack`,
  // and the word on the card the reader chose («عصبي», at
  // `voice.devices.noiseNeural`). English now says "the neural model" and so do
  // these. Passive, as English is, because what matters is that it did not
  // happen and not who failed to do it.
  'voice.noise.reason.load-failed': 'تعذّر تحميل النموذج العصبي.',
  'voice.noise.reason.no-measurement': 'تعذّر قياس النموذج العصبي.',
  // The fallthrough for a reason this build has never heard of. Note that these
  // three keys take «تعذّر …» *with* a full stop, which looks like a violation
  // of the no-full-stop rule but is not: that rule applies to `errors.context`
  // halves, and these are whole sentences shown on their own under a setting.
  'voice.noise.cannot': 'هذا الجهاز لا يستطيع تشغيل النموذج العصبي.',
  // Said once, when a call gives up on the neural model mid-flight. The second
  // half is the part worth saying: something is still suppressing noise, so the
  // reader does not go hunting for a setting that is already correct. «فانتقلت»
  // with the fā of consequence carries English's "so" in one letter, which is
  // what keeps this one sentence rather than two.
  'voice.noise.fellBack': 'لم يواكب النموذج العصبي، فانتقلت هذه المكالمة إلى كبح الضجيج في المتصفّح.',

  // ---------------------------------------------------- joining and leaving

  // The microphone refusal, and the single most important sentence in this
  // file: it is what somebody reads when a call has connected and they cannot
  // be heard.
  //
  // The consequence is repeated in full in all four arms, exactly as English
  // does and for exactly the reason English gives -- and Arabic is the language
  // that proves the point. «يمكنك سماع المكالمة لا التحدّث فيها» has to attach
  // to whatever precedes it, and in the `missing` and `other` arms it attaches
  // with «؛» to a clause about the device rather than about a permission. A
  // catalogue that had factored the consequence out into its own key would have
  // had to glue it on, and the glue is the part that differs.
  //
  // «يمكنك سماع المكالمة لا التحدّث فيها» is deliberately one clause with a
  // negative particle rather than two clauses joined by «لكن». Arabic's «لا»
  // between two verbal nouns is the tightest way to say "X but not Y", and it
  // keeps the sentence at the length a toast can hold.
  //
  // `androidDenied` is a separate arm because the remedy is somewhere else
  // entirely -- a browser permission lives in site settings, an Android one in
  // the system's app settings -- and pointing at the wrong one wastes the only
  // sentence we get. The remedy clause is صيغة الأمر («اسمح»), because it is an
  // instruction to the reader, while everything around it is a report.
  //
  // «إذن» and not «صلاحية»: see the glossary note. A microphone permission is
  // the OS's grant to the site, not this guild's authority over you.
  //
  // «اسمح لـ Telium بالميكروفون» uses the tatweel form of the prefixed lām,
  // بـ/لـ, which is the standard Arabic orthography for attaching a one-letter
  // preposition to a Latin token. It is an ordinary letter (U+0640), **not a
  // bidi control character**, and the guild fragment already uses it («فـ SFU»,
  // «ابدأ بـ https://»).
  //
  // LEFT IN ENGLISH: `Telium` (the product name, as `errors.gateway.4001`
  // already keeps it) and `Android` (the platform's name, and the word the
  // reader will look for on their own phone).
  //
  // BIDI LAYOUT RISK, reported and not patched: the `androidDenied` arm carries
  // two separate literal Latin runs, one of them (`Telium`) glued to an Arabic
  // preposition by a tatweel and the other (`Android`) followed by an Arabic
  // word, and the arm is long enough to wrap. A Latin run that lands at a line
  // break with a tatweel-joined preposition before it is the case most likely
  // to separate the preposition from its object visually. Unverified; no mark
  // added.
  'voice.call.noMic': '{reason, select, androidDenied {رُفض إذن الميكروفون. اسمح لـ Telium بالميكروفون في إعدادات التطبيقات على Android؛ يمكنك سماع المكالمة لا التحدّث فيها.} denied {رُفض إذن الميكروفون. اسمح به في أذونات المواقع في متصفّحك؛ يمكنك سماع المكالمة لا التحدّث فيها.} missing {لم يُعثر على ميكروفون في هذا الجهاز؛ يمكنك سماع المكالمة لا التحدّث فيها.} other {تعذّر فتح الميكروفون؛ يمكنك سماع المكالمة لا التحدّث فيها.}}',

  // The camera's version of the same three refusals, shorter because a camera
  // that will not open is not the emergency a microphone that will not open is:
  // the call still works. Arabic keeps the asymmetry rather than padding the
  // camera arms out to match.
  //
  // LEFT IN ENGLISH: `Telium`, `Android`. Same BIDI LAYOUT RISK as
  // `voice.call.noMic`'s `androidDenied` arm, reported and not patched.
  'voice.call.cameraRefused': '{reason, select, androidDenied {رُفض إذن الكاميرا. اسمح لـ Telium بالكاميرا في إعدادات التطبيقات على Android.} denied {رُفض إذن الكاميرا. اسمح به في أذونات المواقع في متصفّحك.} missing {لم يُعثر على كاميرا في هذا الجهاز.} other {تعذّر فتح الكاميرا.}}',

  // Four things a call's transport simply cannot do. Phrased as facts about
  // this call rather than as errors, because there is nothing to retry and
  // nothing to fix -- so «لا تستطيع» (is not able) and never «تعذّر» (failed),
  // which would invite a second attempt.
  //
  // «حمل» -- to carry -- is the verb the guild fragment already uses for what a
  // relay does with a channel («أي SFU ينقل هذه القناة» uses نقل for the same
  // idea). حمل is used here rather than نقل because these sentences are about
  // capacity rather than about routing: the call is a vehicle and video is
  // cargo it has no room for.
  'voice.call.noCameraSupport': 'هذه المكالمة لا تستطيع حمل الفيديو.',
  'voice.call.noScreenShareSupport': 'هذه المكالمة لا تستطيع حمل مشاركة الشاشة.',
  'voice.call.noFlipSupport': 'هذه المكالمة لا تستطيع تبديل الكاميرات.',
  'voice.call.noAlternateCamera': 'لا توجد في هذا الجهاز كاميرا أخرى للتبديل إليها.',

  // Sealing a conversation's call. Both are thrown before a single packet
  // moves, so both mean the call is not going to happen rather than that
  // something went wrong during it -- which is why neither uses «تعذّر».
  //
  // «ختم» is the seal: a physical metaphor, the same one English chose, kept
  // distinct from «تشفير» (encryption) which is the mechanism. The pair
  // recurs at `voice.watch.sealed` and `voice.watch.sealedLabel`.
  'voice.call.noKeys': 'لا تملك هذه المحادثة مفاتيح مكالمات بعد، فلا يمكن ختم المكالمة.',
  // LEFT PARTLY IN ENGLISH (`SFU`). A protocol-level category of server, fixed
  // by the guild fragment's note, which says the person who reads this word has
  // their relay's own documentation open in the next window.
  //
  // BIDI LAYOUT RISK, reported and not patched: `SFU` is three capitals
  // followed directly by the Arabic word «يُتصل», with no space-plus-Arabic
  // buffer on the right that is longer than one word. Standalone Latin between
  // two Arabic runs is the case `channel.voice.regionHint` calls safe, and this
  // is that case; it is listed for completeness because the run is an acronym
  // in a sentence that also contains an interrogative, and interrogative word
  // order is where a misresolved neutral is hardest to spot.
  'voice.call.sfuAddressUnknown': 'هذه المحادثة لا تحدّد أي SFU يُتصل به.',
  // A guild's server offered an SFU without end-to-end encryption. Refused
  // outright: the alternative is a call the server can listen to.
  'voice.call.sfuNotEncrypted': 'لم يعرض هذا الخادم مكالمة مشفّرة من طرف إلى طرف، لذلك لم يتم توصيلك.',

  // The call moved while you were in it. Three separate facts, three messages,
  // because a person who sees the same sentence twice assumes the second is a
  // repaint.
  //
  // `mode` is a token and not the server's own `mode` string -- the component
  // narrows anything that is not an SFU to `mesh` -- and the arm names are
  // untouched. LEFT PARTLY IN ENGLISH (`SFU`).
  'voice.call.moved': '{mode, select, sfu {انتقلت المكالمة إلى SFU.} other {انتقلت المكالمة إلى اتصالات مباشرة.}}',
  // `{region}` is an identifier the deployment published (`eu-west`, `sfu-3`)
  // and is never translated. It is interpolated, so the runtime isolates it and
  // it is **not** a bidi risk -- the same call `channel.voice.regionCustom`
  // already made for the same value.
  //
  // REORDERED: English is "moved to the {region} region", with the identifier
  // used attributively before its noun. Arabic has no attributive slot there,
  // so the noun comes first and the identifier follows it in apposition:
  // «منطقة {region}».
  'voice.call.movedRegion': 'انتقل الصوت إلى منطقة {region}.',
  // Feminine «انتقلت», agreeing with the المكالمة that the previous message in
  // the same toast stack named. The subject is elided exactly as English elides
  // it, which is a piece of luck: Arabic can drop a subject and keep its
  // agreement on the verb, so the sentence stays as short as the English while
  // still saying what moved.
  'voice.call.movedTo': 'انتقلت إلى {channel}.',
  // Indefinite, because it is dropped into the middle of `movedTo` and is the
  // only place it is ever used. English lower-cases it for the same reason;
  // Arabic has no case to lower, and indefiniteness is what does that job here.
  'voice.call.someVoiceChannel': 'قناة صوتية أخرى',
  'voice.call.shareStoppedOnMove': 'توقّفت مشاركة شاشتك عند انتقال المكالمة.',

  // ------------------------------------------------- refusing to dial at all

  // The three codes from `refusalCode()`. These are about the *posture* the
  // reader chose in their privacy settings, not about a failure, so each one
  // names the requirement and then says what was on offer instead. A call is
  // never quietly downgraded to get it through, and the Arabic has to make the
  // deliberateness audible: «تطلب» -- asks for, demands -- and not «تحتاج»,
  // which would make it sound like a technical prerequisite rather than a
  // choice the reader made.
  'voice.refusal.nothing': 'لا يوجد خادم صوت للاتصال به.',
  // LEFT PARTLY IN ENGLISH (`SFU`, twice).
  //
  // BIDI LAYOUT RISK, reported and not patched: two separate Latin acronym runs
  // in one sentence, the second immediately before a clause-final «فيها» and a
  // full stop. Two Latin islands in one RTL paragraph is where a
  // misconfigured container shows itself, because the two can resolve
  // differently from one another.
  'voice.refusal.sfu': 'خصوصية مكالماتك تطلب SFU، وهذه المكالمة لا SFU فيها.',
  // LEFT PARTLY IN ENGLISH (`SFU`). «مُرحِّلًا» is the accusative of the guild
  // fragment's fixed مُرحِّل, with the tanwīn alif written because the noun ends
  // in a consonant.
  //
  // BIDI LAYOUT RISK, reported and not patched: `SFU` is the **last** token
  // before the full stop, which is the single most fragile position for a Latin
  // run in an RTL paragraph -- the stop is a neutral with an L run on one side
  // and the paragraph boundary on the other, and where it lands is decided by
  // the paragraph level rather than by anything in this string.
  'voice.refusal.relay': 'خصوصية مكالماتك تطلب مُرحِّلًا على الأقل، وهذه المكالمة لا تعرض مُرحِّلًا ولا SFU.',

  // ----------------------------------------------------- the ringing card

  'voice.incoming.title': 'مكالمة واردة',
  // ALL SIX ARMS. A group call names the room; when the room has no name, the
  // size is the only thing distinguishing it from a two-person call.
  //
  // The `two` arm is the reason this key is worth reading twice. A two-person
  // group call is not a hypothetical -- it is what a group becomes when
  // everyone else leaves -- and «مكالمة جماعية · شخصان» is what an Arabic
  // speaker says about it. English renders "2 people" and cannot do otherwise;
  // «٢ أشخاص» would be the mechanical copy of that and is simply wrong.
  //
  //   zero   «لا أحد»   -- following `common.convo.group`, whose zero arm is
  //                       the same two words.
  //   one    «شخص واحد» -- no `#`; واحد carries it.
  //   two    «شخصان»    -- the dual; no numeral in the string at all.
  //   few    «# أشخاص»  -- 3-10, broken plural.
  //   many   «# شخصًا»  -- 11-99, singular accusative تمييز, alif written.
  //   other  «# شخص»    -- 100+, singular genitive.
  //
  // `many` and `other` are visibly different here, unlike the two collapses
  // noted further down, because شخص ends in a consonant and so the accusative
  // tanwīn alif is written.
  //
  // The middle dot is English's separator and is kept. ar.js's
  // `common.convo.group` uses « - » only because its own English does; the
  // separator is a property of the source string, not of the language, and
  // English's note at `voice.share.summary` invites a change only where a
  // language separates differently. Arabic does not.
  'voice.incoming.groupSize': '{count, plural, zero {مكالمة جماعية · لا أحد} one {مكالمة جماعية · شخص واحد} two {مكالمة جماعية · شخصان} few {مكالمة جماعية · # أشخاص} many {مكالمة جماعية · # شخصًا} other {مكالمة جماعية · # شخص}}',
  // The card's own accessible name, so something arriving by keyboard knows
  // what the two buttons belong to before it reaches them. Heard, never seen.
  //
  // The `other` arm replaces a key that used to exist here,
  // `voice.incoming.someone` («شخص ما»), which was handed in as `{caller}`
  // whenever no name could be resolved. It rendered «مكالمة من شخص ما» -- a
  // call from someone -- which is ordinary Arabic and still wrong, because it
  // asserts something about the caller that the client does not know. Arabic
  // also had to choose an indefinite noun and then let it be governed by «من»
  // in three different sentences, which is exactly the kind of agreement a
  // placeholder cannot carry. With no name, Arabic now says only what is true:
  // a call is arriving. Identical to `voice.incoming.title` above, which is the
  // same fact said to a different sense.
  'voice.incoming.fromWho': '{named, select, yes {مكالمة من {caller}} other {مكالمة واردة}}',
  // Both buttons are icons, so the accessible name carries the whole sentence
  // and is the only thing a screen reader has. English's comment says the
  // caller goes *inside* the sentence because two icon buttons side by side are
  // told apart by their first word in some languages and by their last in
  // others -- Arabic is a first-word language here, and «الردّ» and «رفض» differ
  // in their first letter, so the distinction survives even when the two names
  // are heard back to back at speed.
  //
  // REORDERED against English: "Answer call from {caller}" puts the verb, the
  // object and then the source; Arabic's iḍāfa lets «مكالمة {caller}» be one
  // noun phrase, so «من» disappears and the placeholder moves up one slot.
  // «الردّ على» is the fixed Arabic for answering a call; «إجابة» would be
  // answering a question.
  // The unnamed arms drop the iḍāfa and take the definite article instead:
  // «المكالمة» is the call that is ringing right now, which is the only call
  // either button could mean. The first-letter distinction that the note above
  // relies on survives it -- «الردّ» against «رفض» -- unchanged.
  'voice.incoming.answer': '{named, select, yes {الردّ على مكالمة {caller}} other {الردّ على المكالمة}}',
  'voice.incoming.decline': '{named, select, yes {رفض مكالمة {caller}} other {رفض المكالمة}}',
  // An `errors.context` half: no full stop.
  'voice.incoming.joinFailed': 'تعذّر الردّ على المكالمة',

  // ------------------------------------------------- the floating mini view

  'voice.mini.call': 'مكالمة',
  // The landmark's accessible name -- heard, never drawn. «العرض المصغّر» is
  // the settled Arabic for a mini view and is definite because there is exactly
  // one of them on screen.
  'voice.mini.region': 'العرض المصغّر للمكالمة',
  // Reuses ar.js's `common.next` rather than inventing a second word.
  'voice.mini.next': 'التالي',
  'voice.mini.expand': 'توسيع المكالمة',
  // Reuses `common.a11y.hidePassword`'s verb. مصدر, a button.
  'voice.mini.hide': 'إخفاء',

  // The label under that picture, and the only place in the client where the
  // medium and the person are said together with no icon to help. Four keys
  // rather than two with a `select`, because the mini view reads each row's
  // label from the row itself.
  //
  // These four must match `voice.stage.shareName`, `voice.screen.label` and
  // `voice.tile.cameraLabel` word for word where they say the same thing, and
  // they do: «شاشتك», «شاشة {who}», «كاميرتك», «كاميرا {who}». That is the
  // whole reason this namespace exists.
  'voice.media.screenMine': 'شاشتك',
  'voice.media.screenOther': 'شاشة {who}',
  'voice.media.cameraMine': 'كاميرتك',
  'voice.media.cameraOther': 'كاميرا {who}',

  // ------------------------------------------------- the voice channel page

  // A channel that has gone while somebody was looking at it. «لم تعد موجودة»
  // -- no longer exists -- rather than «غير موجودة», because the reader was
  // just in it and the sentence has to acknowledge that.
  'voice.room.goneTitle': 'هذه القناة الصوتية لم تعد موجودة',
  // Feminine throughout, agreeing with «القناة» in the heading above. The two
  // possibilities are kept as two, because a reader who can no longer see a
  // channel and a reader whose channel was deleted need different next actions
  // and the sentence refuses to guess which happened.
  'voice.room.goneBody': 'حُذفت، أو لم تعد تراها.',

  // صيغة الأمر: this is an instruction about what to do next, not the name of a
  // control. The button it sits under is `voice.stage.join`, which is a مصدر --
  // the two forms beside each other are the clearest demonstration in the file
  // of the register rule, and they are deliberately not made to match.
  'voice.room.emptyBody': 'انضم لفتحها.',
  // The one warning anybody gets that pressing the button opens a microphone.
  // Present tense, third person, subject elided: a statement of what the button
  // does, which is what makes it a warning rather than a request for consent.
  'voice.room.joinHint': 'يفتح ميكروفونك.',
  // Two instructions in one line, both صيغة الأمر, because this is the case
  // where this tab believes it is in a call that no connection on this tab is
  // holding and the reader has to choose between two actions. «علامة التبويب»
  // is the settled Arabic for a browser tab and is used again in
  // `voice.share.audioUnlikely` and `voice.watch.noteFrame`.
  'voice.room.staleHint': 'لا شيء في علامة التبويب هذه متّصل. أعد الانضمام، أو اقطع الاتصال لمسح ذلك.',

  // ALL SIX ARMS. The mobile header's subtitle, and the accessible name of the
  // row of faces on the desktop header -- the faces *are* the count for anyone
  // who can see them and are nothing at all for anyone who cannot, which is why
  // the number lives in the row's name.
  //
  // English writes both its arms identically ("# in voice" twice) because
  // English's noun is elided there and has nothing to inflect. Arabic has the
  // noun and must supply it, so all six arms differ and the elision is gone.
  // That is the invitation English's own comment extends elsewhere, taken here.
  //
  // «في الصوت» -- in voice -- is elliptical in Arabic exactly as it is in
  // English, and it is kept elliptical on purpose. «في القناة الصوتية» is the
  // full phrase and is three words too long for a mobile subtitle; «متّصل»
  // (connected) was rejected because `voice.bar.connected` has already spent
  // that word on the transport's state, and a reader meeting «٣ أشخاص
  // متّصلون» in a voice channel would not know whether three people are in the
  // room or three sockets are open.
  'voice.room.inVoice': '{count, plural, zero {لا أحد في الصوت} one {شخص واحد في الصوت} two {شخصان في الصوت} few {# أشخاص في الصوت} many {# شخصًا في الصوت} other {# شخص في الصوت}}',
  'voice.room.empty': 'لا أحد هنا',
  // LEFT AS IS (`+`). The overflow chip at the end of a stack of faces, drawn
  // inside a circle the size of an avatar, so it is a bare sign and a number
  // and not a sentence. `{count}` has no `, number` on it and so comes out in
  // Arabic-Indic digits.
  //
  // BIDI LAYOUT RISK, reported and not patched, and this is the one I would bet
  // on going wrong. The whole string is a plus sign followed by AN digits, with
  // no Arabic anywhere in it to anchor the paragraph. `+` is bidi class ES,
  // which only binds to European numbers; against Arabic-Indic (AN) digits it
  // is an unattached neutral, and in an RTL paragraph an unattached leading
  // neutral takes the paragraph direction and renders on the **right**, so
  // «+٣» may well display as «٣+». Some Arabic UIs accept that and some do not.
  // No mark was added; if it reads wrong the chip's own element wants
  // `direction: ltr`.
  'voice.room.more': '+{count}',
  // ALL SIX ARMS, and the arm that shows why a count can never be concatenated
  // on to a translated noun: the **verb agrees too**, and it takes four shapes
  // across the six arms while the noun takes three.
  //
  //   zero   «لا أحد يشاهد»      -- singular verb with the negated «أحد».
  //   one    «شخص واحد يشاهد»    -- singular.
  //   two    «شخصان يشاهدان»     -- **dual verb**, يشاهدان. Arabic conjugates a
  //                                verb for two people, and there is no way to
  //                                reach this from an English source that has
  //                                only "1 / many".
  //   few    «# أشخاص يشاهدون»   -- sound masculine plural verb.
  //   many   «# شخصًا يشاهد»     -- the noun is singular here (تمييز), so the
  //                                verb goes back to the singular with it.
  //   other  «# شخص يشاهد»       -- singular again, genitive noun.
  //
  // `many` and `other` differ visibly (شخصًا / شخص), as at
  // `voice.incoming.groupSize` and for the same reason.
  'voice.room.watching': '{count, plural, zero {لا أحد يشاهد} one {شخص واحد يشاهد} two {شخصان يشاهدان} few {# أشخاص يشاهدون} many {# شخصًا يشاهد} other {# شخص يشاهد}}',

  'voice.room.chatTitle': 'محادثة القناة',
  'voice.room.minimize': 'تصغير',

  // Four `reportError` contexts. Noun phrases describing the attempt, never
  // complete sentences, and **never ending in punctuation** -- `errors.context`
  // puts a colon and a second clause after each of them.
  //
  // «تعذّرت» feminine where the subject is feminine (قراءة, مشاركة) and «تعذّر»
  // masculine where it is masculine (بدء, إيقاف, تغيير). English cannot show
  // this and Arabic cannot avoid it; the agreement is not decoration.
  'voice.room.readFailed': 'تعذّرت قراءة من يشاهد',
  'voice.room.watchFailed': 'تعذّر بدء المشاهدة',
  'voice.room.unwatchFailed': 'تعذّر إيقاف المشاهدة',
  'voice.room.qualityFailed': 'تعذّر تغيير جودة البث',

  // ------------------------------------------------------- the region picker

  // Same string as the already-shipped `channel.voice.regionLabel`, which is
  // the point: the channel settings pane and the in-call picker are choosing
  // the same thing and must say so.
  'voice.region.title': 'المنطقة الصوتية',
  // «الأقرب أهدأ عادةً» -- the elative twice, which is how Arabic states a
  // correlation without a verb, and it is shorter and plainer than English's
  // "Closer is usually quieter". «أهدأ» (quieter) is kept literal rather than
  // explained as latency: English chose the sensory word over the technical one
  // and the reason holds in Arabic, because the person choosing a region is
  // choosing by how the call sounds.
  'voice.region.subtitle': 'من أين تُحمَل هذه المكالمة. والأقرب أهدأ عادةً.',
  'voice.region.loading': 'جارٍ تحميل المناطق',
  'voice.region.none': 'هذا الخادم لا ينشر مناطق صوتية.',
  // «تلقائي», **masculine**, and therefore not the same string as
  // `voice.quality.auto` above. This is not an oversight. The already-shipped
  // `channel.voice.regionAuto` is «تلقائي» and its sibling
  // `channel.voice.regionHint` quotes it as «تلقائي» inside a sentence, so the
  // in-call picker must match the settings pane or a reader comparing the two
  // screens sees two options. The quality picker has no such constraint and
  // agrees with its own noun.
  'voice.region.auto': 'تلقائي',
  // صيغة الأمر: «دع الخادم يختار» is an instruction under a radio button, not
  // the button's name. «سليمة» -- healthy -- is the word the guild fragment
  // already fixed for a region's health («سليمة»/«متعطّلة» at
  // `guild.voice.healthOk`), so the picker and the guild table agree.
  'voice.region.autoHint': 'دع الخادم يختار أقرب منطقة سليمة.',
  // Feminine, agreeing with منطقة, with the subject elided -- the row the text
  // sits in supplies it. «الآن» keeps English's "right now", which is what says
  // this is a passing condition rather than a permanent one.
  'voice.region.unhealthy': 'لا تقبل المكالمات الآن.',

  // --------------------------------------------------- the share dialog

  'voice.share.title': 'مشاركة شاشتك',
  // صيغة الأمر -- a heading that instructs. Compare `contentLabel` immediately
  // below, which is the accessible name of the same group of radios and is a
  // noun phrase. The pair is the file's clearest illustration of the register
  // rule: one tells you to do something, the other names what you are looking
  // at, and a screen reader that announced «اختر ما تشاركه» as a group label
  // would be issuing an order every time focus entered the group.
  'voice.share.choose': 'اختر ما تشاركه',
  'voice.share.contentLabel': 'ما تشاركه',

  // The two encoder bets, keyed by the `value` of the presets in
  // `lib/screenShare.js`. Each pair is a promise and its price, in that order,
  // because the price is what makes the choice a choice -- and the order is
  // kept.
  //
  // «شفرة برمجية» rather than a bare «كود»: the loan «كود» is common in speech
  // but this is a radio label sitting beside «مستند», and a loan next to a
  // formal noun reads as a register slip. The pair «مستند أو شفرة برمجية» is
  // what a formal Arabic UI says.
  'voice.share.content.detail.label': 'مستند أو شفرة برمجية',
  // «نصّ حادّ» -- sharp text -- is the same sensory metaphor English uses and
  // Arabic has it: حادّ is used of an image's edges. «كل بكسل محفوظ» keeps
  // English's promise in its own shape; «بكسل» is the universal loan and needs
  // no defence.
  'voice.share.content.detail.description': 'نصّ حادّ. إطارات أقل في الثانية، وكل بكسل محفوظ.',
  'voice.share.content.motion.label': 'لعبة أو فيديو',
  // «تلين قبل أن تتقطّع» -- softens before it stutters -- keeps both verbs and
  // their order, which is what makes the sentence a warning about a tradeoff
  // rather than a boast. «يضيق الاتصال» is "the link tightens", the same
  // physical metaphor; Arabic's ضاق is used of a narrowing channel and of a
  // narrowing circumstance alike, which is exactly the double sense English's
  // "tightens" carries here.
  'voice.share.content.motion.description': 'حركة سلسة. تلين قبل أن تتقطّع عندما يضيق الاتصال.',

  // The switch label -- a control, so مصدر, even though English's "Share the
  // sound too" is imperative-shaped. «أيضًا» carries the "too", which is the
  // word that says this is in addition to the picture and not instead of it.
  'voice.share.audio': 'مشاركة الصوت أيضًا',
  // Two hints under that switch, chosen from what the engine can actually do,
  // and they are different facts: one browser can capture a tab's audio but not
  // a whole screen's, another cannot capture any at all, and telling somebody
  // the second when the first is true costs them a working feature. Arabic
  // keeps them as two sentences with different subjects rather than one hedged
  // one.
  'voice.share.audioUnlikely': 'يستطيع هذا المتصفّح أخذ صوت علامة تبويب، لا صوت شاشة كاملة أو نافذة.',
  'voice.share.noCapture': 'هذا المتصفّح لا يستطيع التقاط صوت ما تشاركه.',
  // TRANSLATED, WITH A CAVEAT WORTH READING. The quoted phrase is the
  // **browser's own wording in its picker**, and English's comment instructs a
  // translator to use whatever that picker says in their language and to leave
  // it alone if it is not translated there either. Chromium does localise this
  // checkbox into Arabic, and «مشاركة صوت علامة التبويب» is its wording. That
  // is asserted from the browser's Arabic UI and not from a string table in
  // this repository, so it is the one entry in this fragment that should be
  // re-checked against a real Arabic-language Chrome before it is trusted --
  // if Chromium's wording has changed, this sentence sends the reader hunting
  // for a checkbox that says something else, which is worse than leaving it in
  // English would have been.
  //
  // The quotation marks are «…», the Arabic pair, per the doc and per
  // `errors.missing_permission`; English's curly doubles are not kept, because
  // the marks are the language's and not the string's.
  'voice.share.pickTabAudio': 'لم يأتِ صوت مع ذلك. اختر علامة تبويب وأشّر على «مشاركة صوت علامة التبويب» لإحضاره معها.',
  // `{reason}` is `displayAudioFailureReason()` -- a diagnostic composed by the
  // native Linux desktop-audio bridge (PipeWire, venmic), which this client did
  // not write and cannot translate. It arrives as data in the one slot the
  // sentence has for it, and it is interpolated, so the runtime isolates it: a
  // Latin diagnostic at the end of this Arabic sentence is **not** a bidi risk.
  'voice.share.desktopAudioFailed': 'تعذّرت مشاركة صوت سطح المكتب: {reason}',

  // The collapsed advanced row and the two strips inside it.
  'voice.share.quality': 'الجودة',
  // LEFT PARTLY IN ENGLISH (`fps`). The unit, for the same reason as `ms` and
  // `kbps`: it is the SI-style abbreviation Arabic technical writing uses, and
  // it is drawn on a one-line summary row with no space for «إطارًا في
  // الثانية». The middle dot is a separator and not punctuation; English's
  // comment invites a language that separates differently to change it, and
  // Arabic does not separate differently.
  //
  // BIDI LAYOUT RISK, reported and not patched: this string is **entirely**
  // made of an isolated value, a neutral separator, a number in Arabic-Indic
  // digits and a Latin unit, with no Arabic word anywhere to anchor it. The
  // middle dot sits between an FSI-isolated run and an AN run, and the `fps`
  // sits at the end after a space. Every neutral in the string resolves to the
  // paragraph direction, so the whole row should read right-to-left with `fps`
  // at the left; whether that is what a reader wants from a resolution/frame
  // rate summary is a design question this catalogue cannot settle.
  'voice.share.summary': '{quality} · {fps} fps',
  'voice.share.resolution': 'الدقة',
  // «إطارات في الثانية» -- frames in the second -- which is the Arabic form of
  // the phrase and matches the `fps` abbreviation above it, so a reader
  // connects the two.
  'voice.share.frameRate': 'إطارات في الثانية',

  // ------------------------------------------------------- watch together

  // Everyone plays the same thing themselves and Telium carries only the
  // position and the play button. That distinction is the whole feature, and
  // most of the words below exist to make it before somebody agrees to it --
  // which means none of them may be softened into "watch a video together",
  // the thing people will assume this is.
  'voice.watch.title': 'المشاهدة معًا',
  // «يشغّله كل واحد عنده» -- each person plays it at their end -- and
  // «متزامنين» carries "in time with each other" in one word. «عنده» is the
  // load-bearing half: it is what says the video is not coming from Telium.
  'voice.watch.subtitle': 'يشغّله كل واحد عنده، متزامنين مع بعضهم.',
  // The field label. «رابط» is the noun the guild fragment already fixed for a
  // link, indefinite because no link exists yet.
  'voice.watch.url': 'رابط',
  // صيغة الأمر -- a placeholder that instructs, matching the guild fragment's
  // «الصق المرجع…» exactly.
  'voice.watch.urlPlaceholder': 'الصق رابطًا',
  // The last alternative in a list built with `Intl.ListFormat`, so it is only
  // ever the final item and must never carry its own comma or conjunction --
  // `Intl` supplies «و» in front of it. Indefinite, because it is one of a list
  // of kinds.
  'voice.watch.orFile': 'ملف فيديو مباشر',
  // «نسخة» for a build. «مزوّدي مشاهدة» -- watch providers -- genitive plural
  // after the negating «لا».
  'voice.watch.noEmbeds': 'لا مزوّدي مشاهدة في هذه النسخة، والملفات المباشرة معطّلة.',
  'voice.watch.start': 'بدء',

  // The consent sentence, in the dialog and again on the card. One sentence
  // with the host emphasised inside it, not three nodes glued together.
  //
  // BOTH `<b>` TAGS ARE KEPT, both of them, with the same names and nothing
  // added around them. They are the code's, they wrap the two values the
  // sentence is about, and a tag the code does not supply renders as its
  // contents rather than vanishing -- so keeping them costs nothing and
  // dropping one would silently lose the emphasis on a privacy claim.
  //
  // «بـ<b>{host}</b>» attaches the one-letter preposition to the tag with the
  // tatweel, the same orthography as «فـ SFU» in the guild fragment. The tag
  // boundary is invisible to the renderer -- `format.js` unwraps tags to their
  // children -- so the preposition lands directly against the host name, which
  // is what Arabic requires. It is a letter, **not** a bidi control.
  //
  // REORDERED: English is "Playing from <b>X</b> connects this browser to
  // <b>Y</b>", subject-verb-object with the subject a gerund phrase. Arabic
  // keeps that order because the gerund «التشغيل» can head a nominal subject,
  // which is the rarer case where the two languages agree; «يربط» is the verb
  // and it follows its subject here rather than fronting, because fronting it
  // would put the two hosts side by side and the whole point of the sentence is
  // that they are two different parties.
  'voice.watch.connects': 'التشغيل من <b>{provider}</b> يربط هذا المتصفّح بـ<b>{host}</b>.',
  'voice.watch.consentHost': 'هذا يربط متصفّحك بـ<b>{host}</b>.',
  // Chosen from `connectsTo().kind`, which stays in `lib/watch/player.js`
  // because it is the privacy contract the watch gate is tested against. The
  // two cases are genuinely different and the Arabic keeps them different: a
  // file is fetched by each person from wherever it lives, and an embed runs a
  // player the provider serves.
  'voice.watch.noteFile': 'يجلب كل شخص الملف بنفسه، من حيث هو مستضاف.',
  // «كما لو فتحته في علامة تبويب» -- as if you had opened it in a tab -- second
  // person, because the comparison is to something the reader does. This is the
  // sentence that tells somebody an embed is a full browsing context, and
  // softening it («قد يرى بعض المعلومات») would be the translation that loses
  // the consent.
  'voice.watch.noteFrame': 'يعمل المشغّل في إطار من {provider}، الذي يرى هذا المتصفّح كما لو فتحته في علامة تبويب.',
  // LEFT PARTLY IN ENGLISH (`Telium`). «لا يتوسّط» -- does not act as an
  // intermediary -- is the Arabic for proxying in this sense, and it is the
  // right verb because it is the same word used of a party standing between two
  // others. «الاتصال اتصالك» is a nominal sentence with the predicate
  // possessed: "the connection is your connection", which is as flat and as
  // final as English's "The connection is yours."
  'voice.watch.proxyNote': 'لا يتوسّط Telium فيه. الاتصال اتصالك.',
  // مصدر, a button. «بـ{host}» -- the tatweel preposition again, and `{host}`
  // is interpolated so the runtime isolates it.
  'voice.watch.connectTo': 'الاتصال بـ{host}',
  // The refusal button beside it. «ليس الآن» is the settled Arabic for a
  // deferral rather than a refusal, which is what "Not now" is.
  'voice.watch.notNow': 'ليس الآن',

  // What happens to the two bytes Telium *does* carry. Said in both places,
  // because consenting to a connection and consenting to a relay seeing your
  // scrubbing are two different consents -- and the three keys below are three
  // sentences and not one reused, for exactly that reason.
  //
  // LEFT PARTLY IN ENGLISH (`Telium`) in all three.
  //
  // «الموضع وزرّ التشغيل» -- the position and the play button -- is kept
  // concrete in all three, as English keeps it. The abstraction («بيانات
  // التزامن», sync data) would be shorter and would destroy the sentence: the
  // reader is being told exactly two things travel, and a category noun tells
  // them an unknown number of things travel.
  //
  // «لا يمرّ … إلا …» is Arabic's exclusive construction, which is how the
  // language says "only" without a separate adverb. It puts the restriction on
  // what travels, which is where English's "Only" puts it.
  'voice.watch.sealed': 'لا يمرّ عبر Telium إلا الموضع وزرّ التشغيل، وهما مختومان من طرف إلى طرف.',
  // «مُرحِّل Telium» -- Telium's relay -- using the fixed مُرحِّل. The second
  // clause is the whole point and is not softened: «يستطيع قراءتهما», it *can*
  // read them, a statement about capability and not about intent, which is the
  // same distinction `voice.stage.sealedNotice` makes in the other direction.
  'voice.watch.relayed': 'يمرّ الموضع وزرّ التشغيل عبر مُرحِّل Telium، وهو يستطيع قراءتهما.',
  // The consent-dialog wording of the same fact. English's two differ only in
  // voice ("travel through" against "are relayed through"), and Arabic keeps
  // two sentences differing in the same way -- «يمرّ» active, «يُرحَّل» passive --
  // rather than collapsing them, because a reader who meets the same sentence
  // twice assumes the second is a repaint.
  'voice.watch.relayedConsent': 'يُرحَّل الموضع وزرّ التشغيل عبر Telium، وهو يستطيع قراءتهما.',
  // The badge. «مختوم» -- sealed -- the physical metaphor, kept distinct from
  // «مشفّر» in `voice.stage.sealedNotice`, exactly as English keeps "sealed"
  // distinct from "end-to-end encrypted".
  'voice.watch.sealedLabel': 'مختوم من طرف إلى طرف',

  // A link no adapter can drive. Three lines, in the order somebody needs them:
  // what is wrong, why, and what to do instead. The third is the only one in
  // صيغة الأمر, because it is the only one that asks for an action.
  'voice.watch.unsyncable': 'هذا الرابط لا يمكن إبقاؤه متزامنًا.',
  // LEFT PARTLY IN ENGLISH (`Telium`). «قيادة» -- driving, steering -- is the
  // same metaphor English uses for controlling a player, and Arabic has it:
  // قاد is used of steering a vehicle and of directing a process. «يخاطبها» is
  // "talk to", literally addressing, which keeps English's deliberately
  // informal framing of a protocol.
  'voice.watch.unsyncableWhy': 'لا يستطيع Telium قيادة إلا المشغّلات التي يعرف كيف يخاطبها، وهذا ليس منها.',
  'voice.watch.unsyncableInstead': 'شارك شاشتك بدلًا من ذلك، وشغّله بنفسك.',
  'voice.watch.unplayable': 'هذا الرابط لا يمكن تشغيله هنا.',

  // The line above the player.
  //
  // «أنت» is the self-label, and it is **the reason `voice.watch.started` below
  // is not a plain verbal sentence**. See that entry.
  'voice.watch.you': 'أنت',
  // Indefinite: it is a stand-in for whatever the registry could not name, used
  // where the source is a bare file, because the registry calls that "Direct
  // video file" and nobody says that out loud.
  'voice.watch.aVideo': 'فيديو',
  // RESTRUCTURED, and this is the most interesting sentence in the fragment.
  //
  // English is "{who} started {what}", where `{who}` is a display name **or the
  // string `voice.watch.you`, which is a pronoun**. Arabic cannot use a finite
  // verb here, because an Arabic verb agrees with the person of its subject:
  // «بدأ محمد» is right and «بدأ أنت» is ungrammatical, and so is «أنت بدأ» --
  // the second-person form is «بدأتَ», and the catalogue has no way to know
  // which of the two it is about to be handed. A language with verb-person
  // agreement simply cannot interpolate a subject that might be a pronoun.
  //
  // The fix is a **cleft**: «{who} من بدأ {what}» -- "{who} is the one who
  // started {what}". The relative «من» is invariant for person, number and
  // gender, and the verb after it is always third-person singular regardless of
  // who the subject is. So «أنت من بدأ فيديو» and «محمد من بدأ YouTube» are
  // both correct, from one pattern, with no arms.
  //
  // It also happens to be the better sentence. A cleft in Arabic is mildly
  // emphatic -- it attributes rather than narrates -- which is exactly what a
  // caption above a player is doing: this session belongs to this person, and
  // that is why the End button says what it says.
  //
  // `{what}` is a provider's own name, or `voice.watch.aVideo`, or
  // `voice.watch.thePlayer`. All three are values and all three are isolated.
  'voice.watch.started': '{who} من بدأ {what}',
  'voice.watch.opening': 'جارٍ فتح {provider}…',
  // Definite: the player that is already on screen.
  'voice.watch.thePlayer': 'المشغّل',

  // Somebody is still buffering. One name is worth saying; several are worth
  // counting.
  //
  // A NOTE ON `{who}` HERE, which I believe is an English design bug rather
  // than a translation problem: «في انتظار {who}» is a prepositional phrase,
  // and Arabic attaches a pronoun object to a preposition as a suffix
  // («في انتظارك»), never as a free word. So if `{who}` is ever handed the
  // string `voice.watch.you` -- as it is in `voice.watch.started` -- this
  // renders «في انتظار أنت», which is wrong. The component appears never to do
  // that (you are not waiting for yourself), and the English comment attaches
  // the "or 'You'" note only to `started`, so this is left as it is and
  // reported rather than worked around.
  'voice.watch.waitingFor': 'في انتظار {who}',
  // ALL SIX ARMS. The counted noun sits after «في انتظار», which governs the
  // genitive, so the shapes differ from `voice.room.watching` above even though
  // the noun is the same word:
  //
  //   zero   «لا أحد في الانتظار» -- restructured, because «في انتظار لا أحد»
  //                                 is not Arabic. The zero arm is the one that
  //                                 most often has to be a different sentence
  //                                 rather than a different number, and it is
  //                                 here.
  //   one    «في انتظار شخص واحد»
  //   two    «في انتظار شخصين»    -- the dual in the **genitive/accusative**
  //                                 form شخصين, not the nominative شخصان that
  //                                 `voice.room.watching` uses, because the
  //                                 preposition governs it. Same dual, two
  //                                 spellings, decided by the sentence around
  //                                 it -- which is one more reason the count
  //                                 and the noun cannot be separated.
  //   few    «في انتظار # أشخاص»  -- 3-10, genitive plural.
  //   many   «في انتظار # شخصًا»  -- 11-99, singular accusative تمييز.
  //   other  «في انتظار # شخص»    -- 100+, singular genitive.
  'voice.watch.waitingForMany': '{count, plural, zero {لا أحد في الانتظار} one {في انتظار شخص واحد} two {في انتظار شخصين} few {في انتظار # أشخاص} many {في انتظار # شخصًا} other {في انتظار # شخص}}',
  // Said once, when the wait has gone on long enough that carrying on is kinder
  // than stopping. Deliberately not an apology and deliberately not an error:
  // it is a decision the room made, and «فاستمرّ التشغيل» states it as a fact
  // that has already happened. «يخزّن مؤقتًا» is buffering.
  'voice.watch.gaveUpWaiting': 'لا يزال أحدهم يخزّن مؤقتًا، فاستمرّ التشغيل من دونه.',

  // The control bar. Both transport buttons name the **room** rather than the
  // player, because that is the surprising half: pressing pause here pauses it
  // for everybody. «للجميع» carries that and is kept on all three of play,
  // pause and end, exactly as English keeps "for everyone".
  'voice.watch.playAll': 'تشغيل للجميع',
  'voice.watch.pauseAll': 'إيقاف مؤقت للجميع',
  'voice.watch.position': 'الموضع',
  // LEFT AS IS. Two time strings the component formats, with a slash between
  // them. Both are isolated by the runtime.
  //
  // BIDI LAYOUT RISK, reported and not patched: the slash is a neutral between
  // two FSI-isolated runs, so it takes the paragraph direction and the pair
  // renders right-to-left -- elapsed on the right, total on the left. That is
  // logically correct and is very probably not what a reader wants: every video
  // player an Arabic speaker has ever used, including Arabic-localised ones,
  // draws its transport row left-to-right, because the row is a picture of time
  // passing and time in a scrubber goes the way the scrubber goes. This
  // catalogue cannot fix that without a mark, and a mark here would be the
  // textbook case of papering over a layout bug: the fix is `direction: ltr` on
  // the timestamp element, alongside whatever the scrubber itself already does.
  'voice.watch.elapsedOf': '{at} / {duration}',
  'voice.watch.speed': 'السرعة',
  // LEFT AS IS (`×`). The multiplication sign U+00D7, not the letter x, exactly
  // as English's comment insists: it is a number and its unit. `{rate}` has no
  // `, number` style but is a number, so it comes out in Arabic-Indic digits
  // and is not isolated.
  //
  // Not flagged as a bidi risk, unlike `voice.bar.ping`: `×` is bidi class ON
  // like any other symbol, but it directly follows an AN run with no space, and
  // a neutral **between** a number and the paragraph end behaves the same as
  // the paragraph. «١٫٥×» is the expected render. If it inverts, so does every
  // other trailing-symbol string in the catalogue, which would be a systemic
  // problem and not this key's.
  'voice.watch.rate': '{rate}×',
  // Two words for one button, chosen by whether this is your session: ending it
  // takes it away from everybody, leaving it does not. Both مصدر.
  'voice.watch.end': 'إنهاء للجميع',
  'voice.watch.leave': 'مغادرة',
  // An `errors.context` half: no full stop. Uses the feature's name, «المشاهدة
  // معًا», rather than the dock's «جلسة المشاهدة» -- what failed was starting
  // the feature, not ending a session.
  'voice.watch.startFailed': 'تعذّر بدء المشاهدة معًا',

  // ------------------------------------------------------------- failures

  // Everything in this section is a `reportError` context: the first half of
  // `errors.context`, joined to whatever actually went wrong. Noun phrases in
  // the past-attempt sense, **none of them ending in a full stop**, because a
  // colon and a second clause follow each one.
  //
  // They are worded from the person's side of the call and not the code's --
  // «تعذّر تحديث حالتك الصوتية» is what a failed `voiceState` request means to
  // somebody who pressed the mute square and watched it spring back.
  //
  // «تعذّر» agrees with its subject throughout: masculine before a masculine
  // مصدر (الانضمام, بدء, تبديل, تحديث, إيقاف, تشغيل, سرد, إخراج, فحص,
  // الانتقال, تجديد, تغيير) and feminine before a feminine one (مغادرة,
  // مشاركة, قراءة, متابعة, إعادة). Nothing in English distinguishes these and
  // nothing in Arabic may fail to.
  'voice.error.join': 'تعذّر الانضمام إلى المكالمة',
  // «بسلاسة» -- cleanly, smoothly. English's "cleanly" is doing real work here:
  // the call *did* end, and what failed was the tidying-up, which is why this
  // is not the same sentence as `voice.error.join`.
  'voice.error.leave': 'تعذّرت مغادرة المكالمة بسلاسة',
  // Not a «تعذّر …» at all, and deliberately so: English says "The call ran
  // into trouble", which is a report of something that happened to the call
  // rather than of something that could not be done. «واجهت المكالمة مشكلة»
  // keeps that, and keeps the subject the call. This is the only key in the
  // section that is not «تعذّر …», and it still carries no full stop, because
  // it is still the left half of `errors.context`.
  'voice.error.trouble': 'واجهت المكالمة مشكلة',
  // «حالتك الصوتية» -- your voice state -- the roster flag, possessed, because
  // the reader pressed a button and it sprang back.
  'voice.error.voiceState': 'تعذّر تحديث حالتك الصوتية',
  'voice.error.cameraOn': 'تعذّر تشغيل الكاميرا',
  'voice.error.cameraOff': 'تعذّر إيقاف الكاميرا',
  'voice.error.flipCamera': 'تعذّر تبديل الكاميرات',
  'voice.error.shareScreen': 'تعذّرت مشاركة الشاشة',
  'voice.error.stopStream': 'تعذّر إيقاف مشاركة الشاشة',
  'voice.error.streamState': 'تعذّر تحديث مشاركة الشاشة',
  // «صوت المكالمة» -- the call's audio -- and not «الصوت» alone, because the
  // failure is about the autoplay gate on this one call and not about the
  // voice subsystem.
  'voice.error.resumeAudio': 'تعذّر بدء صوت المكالمة',
  'voice.error.fullscreen': 'تعذّر الانتقال إلى ملء الشاشة',
  // Same «نافذة منفصلة» as `voice.tile.pip` and `voice.screen.noVideo`, so the
  // button, the refusal and the toast all name one thing.
  'voice.error.pip': 'تعذّر إخراج الفيديو في نافذة منفصلة',
  // The two halves of following a call that moved underneath you. Separate,
  // because one is a new server and the other is a new region, and knowing
  // which failed is the difference between waiting and rejoining. «متابعة» --
  // following -- with the call as object, which keeps the reader's client as
  // the thing that failed rather than the call.
  'voice.error.followServer': 'تعذّرت متابعة المكالمة إلى خادمها الجديد',
  'voice.error.followRegion': 'تعذّرت متابعة المكالمة إلى منطقتها الجديدة',
  // "Re-key" is «تجديد مفاتيح المكالمة» -- renewing the call's keys. Not
  // «إعادة التشفير» (re-encrypting), which is a different operation and would
  // suggest the call's existing media had to be redone; what failed was minting
  // and distributing a new key, which is what «تجديد المفاتيح» says. The word
  // «مفاتيح» matches `voice.call.noKeys` above.
  'voice.error.rekey': 'تعذّر تجديد مفاتيح المكالمة',
  // Rejoining kept failing, so the seat is given up; `errors.context` names
  // what the last attempt hit.
  'voice.error.rejoin': 'تعذّرت إعادة الانضمام إلى المكالمة',
  // The server says this device is no longer in the channel it was calling from.
  'voice.call.removed': 'تمت إزالتك من القناة الصوتية',
  // The device panel's four. `readRoutes` and `switchOutput` are shared with
  // Android's output sheet, which asks the same two questions of a different
  // implementation -- so both use «مخرج الصوت», the same phrase as
  // `voice.route.title` and `voice.devices.output`.
  'voice.error.listDevices': 'تعذّر سرد أجهزة الصوت',
  'voice.error.switchMic': 'تعذّر تبديل الميكروفون',
  'voice.error.switchOutput': 'تعذّر تبديل مخرج الصوت',
  'voice.error.readRoutes': 'تعذّرت قراءة مخارج الصوت',
  // The setting, so «كبح الضجيج».
  'voice.error.noiseChange': 'تعذّر تغيير كبح الضجيج',
  // The model, so «النموذج العصبي» -- see `voice.noise.reason.load-failed` for
  // why this is no longer «نموذج إلغاء الضجيج». The two keys sit next to each
  // other and land in the same toast queue, so two different failures must not
  // arrive under one name.
  'voice.error.noiseModel': 'تعذّر فحص النموذج العصبي',

  // ================================================== added to reach 100%
  //
  // Everything below was added in one pass to complete this catalogue. The
  // sentences were produced with machine assistance and have not been read by
  // a human, which is why none of them carries a stamp in `stamps.json` --
  // `node scripts/i18n-status.mjs --stale` reports them as *unknown*, not as
  // accepted. Treat this block as a first draft to review, not as finished copy.
  // ---- app
  'app.boot.connecting': 'جارٍ الاتصال بـ{domain}…',
  'app.boot.offline': 'هذا الجهاز غير متصل. سيسجّلك Telium في الدخول بمجرد عودة الاتصال.',
  'app.boot.signOut': 'تسجيل الخروج',
  'app.boot.switching': 'جارٍ التبديل إلى {name}…',
  'app.boot.unreachable': 'تعذّر الوصول إلى {domain}: {reason}',
  'app.boot.unreachableNotice': 'تبقى جلسات الخادم تعمل حتى تنتهي صلاحيتها، لكن لا يمكن إنشاء جلسات جديدة ما دام خادمك الرئيسي معطّلًا.',
  'app.crash.recover': 'ما زال معطّلًا بعد إعادة التحميل؟',
  'app.crash.reload': 'إعادة التحميل',
  'app.crash.report': 'الإبلاغ عن هذا',
  'app.crash.title': 'حدث خطأ أثناء عرض هذه الشاشة.',

  // ---- auth
  'auth.advanced.identityMismatch': 'تعذّر التحقّق من سجلّ هوية هذا الحساب.',
  'auth.advanced.identityName': 'هوية الحساب',
  'auth.advanced.legacyPassphraseBody': 'لا يزال هذا الحساب يحمل عبارة مرور من إصدار أقدم من Telium. وكلمة مرورك تقوم بالمهمة نفسها بالفعل.',
  'auth.advanced.legacyPassphraseName': 'عبارة الاستعادة القديمة',
  'auth.advanced.modeName': 'كيف يستعيد هذا الحساب',
  'auth.advanced.passphraseRemoved': 'أُزيلت عبارة المرور القديمة. وما زالت كلمة مرورك تستعيد رسائلك.',
  'auth.advanced.removeFailed': 'تعذّرت إزالة عبارة الاستعادة القديمة: {detail}',
  'auth.advanced.removePassphrase': 'إزالة عبارة المرور القديمة',
  'auth.advanced.rootSequence': ' · تسلسل الجذر {sequence}',
  'auth.backup.delete': 'حذف النسخة الاحتياطية',
  'auth.backup.deleteBody': 'تبقى الرسائل الموجودة أصلًا على هذا الجهاز. ولن يستطيع جهاز جديد استعادة الأقدم.',
  'auth.backup.deleteConfirm': 'حذفها',
  'auth.backup.deleted': 'حُذفت النسخة الاحتياطية.',
  'auth.backup.deleteFailed': 'تعذّر حذف النسخة الاحتياطية: {detail}',
  'auth.backup.deleteTitle': 'حذف النسخة الاحتياطية',
  'auth.backup.detail': '{count, plural, zero {# عنصر مختوم.} one {# عنصر مختوم.} two {# عنصران مختومان.} few {# عناصر مختومة.} many {# عنصرًا مختومًا.} other {# عنصر مختوم.}} {readable, select, yes {يستطيع خادمك الرئيسي فتحه.} other {لا يستطيع خادمك الرئيسي فتحه.}}',
  'auth.backup.detailName': 'نسخة احتياطية',
  'auth.backup.empty': 'لم يُخزَّن شيء بعد. سيبدأ جهاز جديد من اليوم.',
  'auth.backup.explain': 'تُحفظ نسخة مشفّرة حتى يتمكّن جهاز جديد من اللحاق. آخر كتابة {at, relative}.',
  'auth.backup.title': 'نسخة احتياطية من الرسائل الأقدم',
  'auth.crumb.address': 'عنوان Telium',
  'auth.crumb.password': 'كلمة المرور',
  'auth.crumb.recoveryKey': 'مفتاح الاستعادة',
  'auth.crumb.username': 'اسم المستخدم',
  'auth.crumb.welcome': 'ترحيب',
  'auth.custody.device.name': 'استعادة عبر الأجهزة الموثوقة',
  'auth.custody.device.note': 'تعيش مفاتيحك على الأجهزة التي وافقت عليها، ولا مكان آخر.',
  'auth.custody.escrowed.name': 'استعادة بمساعدة الخادم (قديمة)',
  'auth.custody.escrowed.note': 'يحتفظ خادمك الرئيسي بمفتاح يفتح هذه الرسائل.',
  'auth.custody.line': '{name}. {note}',
  'auth.custody.opaque.name': 'استعادة كلمة المرور (مفتاح تصدير OPAQUE)',
  'auth.custody.opaque.note': 'يكفي تسجيل الدخول بكلمة مرورك لاستعادة رسائلك.',
  'auth.custody.self.name': 'عبارة مرور مستقلة (قديمة)',
  'auth.custody.self.note': 'تعيش مفاتيحك على أجهزتك، مع عبارة مرور كطريق للعودة.',
  'auth.custody.unknown': 'لم تُنشأ بعد',
  'auth.encryption.backupEmpty': 'لا شيء مخزّن',
  'auth.encryption.backupFact': 'نسخة احتياطية من الرسائل الأقدم',
  'auth.encryption.backupItems': '{count, plural, zero {# رسالة} one {# رسالة} two {# رسالتان} few {# رسائل} many {# رسالةً} other {# رسالة}}',
  'auth.encryption.devicesCounting': 'جارٍ العدّ',
  'auth.encryption.devicesFact': 'الأجهزة',
  'auth.encryption.devicesHint': 'الأجهزة هو المكان الذي توثّق فيه جهازًا أو تسجّل خروج أحدها.',
  'auth.encryption.devicesSignedIn': '{count, plural, zero {# مسجَّل للدخول} one {# مسجَّل للدخول} two {# مسجَّلان للدخول} few {# مسجَّلة للدخول} many {# مسجَّلًا للدخول} other {# مسجَّل للدخول}}',
  'auth.encryption.devicesVerified': '{total, plural, zero {{verified} من # موثَّق} one {{verified} من # موثَّق} two {{verified} من # موثَّقَين} few {{verified} من # موثّقة} many {{verified} من # موثَّقًا} other {{verified} من # موثَّق}}',
  'auth.encryption.escrowed.note': 'لا يزال هذا الحساب على إعداد الاستعادة القديم. إيقافه يستغرق ضغطة واحدة ولا يحتاج كلمة مرور ثانية.',
  'auth.encryption.escrowed.title': 'يستطيع خادمك الرئيسي قراءة رسائلك الخاصة.',
  'auth.encryption.keyFact': 'مفتاح الاستعادة',
  'auth.encryption.keyLegacy': 'عبارة المرور القديمة',
  'auth.encryption.keyMissing': 'لم يُنشأ بعد',
  'auth.encryption.keySaved': 'محفوظ',
  'auth.encryption.locked.note': 'الرسائل الجديدة تعمل. لاستعادة الأقدم، استخدم مفتاح استعادتك أدناه، أو وافق على هذا الجهاز من جهاز تستخدمه بالفعل.',
  'auth.encryption.locked.title': 'رسائلك الأقدم مقفلة على هذا الجهاز.',
  'auth.encryption.ok.noteFallback': 'لا تفتحها سوى أجهزتك.',
  'auth.encryption.ok.title': 'رسائلك الخاصة محمية.',
  'auth.encryption.settingUp.note': 'يستغرق هذا لحظة بعد تسجيل الدخول.',
  'auth.encryption.settingUp.title': 'إعداد التشفير على هذا الجهاز.',
  'auth.escrow.button': 'إيقافه',
  'auth.escrow.doneDevices': 'تم. مفاتيحك على أجهزتك الآن.',
  'auth.escrow.doneRefresh': 'تم، وإن كانت بضع محادثات ما زالت تحتاج تجديد مفتاح.',
  'auth.escrow.doneServer': 'تم. لم يعد خادمك قادرًا على فتح رسائل جديدة.',
  'auth.escrow.explain': 'يتوقف خادمك عن القدرة على فتح أي شيء يُرسل بعد هذا. وما رآه بالفعل فقد رآه.',
  'auth.escrow.failed': 'تعذّر إيقاف الاستعادة بمساعدة الخادم: {detail}',
  'auth.escrow.title': 'إيقاف الاستعادة بمساعدة الخادم',
  'auth.find.afterColon': 'أو اكتبه بعد نقطتين، مثل @{user}:your.server',
  'auth.find.busy': 'جارٍ البحث…',
  'auth.find.changeAddress': 'استخدام عنوان مختلف',
  'auth.find.changeHome': 'اختيار موطن مختلف',
  'auth.find.create': 'إنشاء حساب',
  'auth.find.deactivated': 'هذا الحساب معطّل. تسجيل الدخول بكلمة مروره يعيده.',
  'auth.find.elsewhere': 'على خادم مختلف؟',
  'auth.find.forget': 'تجاهل {user} على هذا الجهاز',
  'auth.find.found': 'تم العثور على {user} على {host}',
  'auth.find.foundLabel': 'حسابات باسم {user}',
  'auth.find.hint': 'اسم المستخدم والخادم، مثل @ada:telium.chat. نسيت خادمك؟ اكتب اسم المستخدم فقط.',
  'auth.find.homeExplainer': 'يحفظ موطن حسابك ملفّك الشخصي وتسجيل دخولك وأصدقاءك ورسائلك. ويمكنك مع ذلك الانضمام إلى مجتمعات مستضافة في مكان آخر.',
  'auth.find.invalid': 'لا يبدو هذا عنوان Telium. جرّب @name:server.',
  'auth.find.label': 'عنوان Telium',
  'auth.find.lookingUp': 'جارٍ البحث عن {host}…',
  'auth.find.moved': 'انتقل حسابك إلى {host}.',
  'auth.find.newTitle': 'جديد على Telium؟',
  'auth.find.noAccount': 'لا يوجد حساب باسم {user} على {host}. تحقّق من الكتابة، أو <create>أنشئ حسابًا</create>.',
  'auth.find.noSuchAccount': 'لا يوجد حساب باسم {user} على {host}.',
  'auth.find.placeholder': '@you:telium.chat',
  'auth.find.recentLabel': 'الحسابات على هذا الجهاز',
  'auth.find.searching': 'جارٍ البحث عن {user}…',
  'auth.find.title': 'تسجيل الدخول إلى Telium',
  'auth.find.unreachable': 'تعذّر الوصول إلى {host}. تحقّق من الكتابة أو من اتصالك.',
  'auth.find.whichServer': 'على أي خادم يوجد {user}؟',
  'auth.guardians.cannotSign': 'لا يستطيع هذا الجهاز التوقيع عن حسابك الآن.',
  'auth.guardians.duplicate': 'ثلاثة أشخاص مختلفين. ولا يمكن احتساب المعرّف نفسه مرتين.',
  'auth.guardians.incomplete': 'سمِّ الثلاث جميعًا قبل الحفظ.',
  'auth.guardians.name': 'جهات اتصال الاستعادة (أيّ اثنتين من ثلاث)',
  'auth.guardians.needThree': 'اختر ثلاثة أشخاص مختلفين.',
  'auth.guardians.person': 'الشخص {index}',
  'auth.guardians.placeholder': '@friend:home.example',
  'auth.guardians.replace': 'استبدال هؤلاء الثلاثة',
  'auth.guardians.save': 'حفظ هؤلاء الثلاثة',
  'auth.guardians.saved': 'تم حفظ جهات اتصال الاستعادة الثلاث.',
  'auth.guardians.saveFailed': 'تعذّر حفظ جهات اتصال الاستعادة: {detail}',
  'auth.guardians.set': 'مضبوطة، الإصدار {version}. واختيار جهات جديدة يلغي القديمة.',
  'auth.guardians.unset': 'غير مضبوطة. أيّ اثنتين من الثلاث يمكنهما أن يضمنك للعودة؛ ولا تستطيع واحدة وحدها.',
  'auth.guardians.unsupported': 'هذا الخادم لا يوفّرها.',
  'auth.guardians.unsupportedName': 'جهات اتصال الاستعادة',
  'auth.guardians.verifiedList': 'الأشخاص الذين وثّقتهم: {people}',
  'auth.guardians.verifyFirst': 'وثّق أحدهم عبر فحص الرموز التعبيرية أولًا، ثم ضع معرّفه الكامل هنا.',
  'auth.handoff.account': '<b>نقل {account} إلى {destination}.</b> سجّل الدخول إلى الحساب الذي ينبغي أن ينتقل إليه، أو أنشئ حسابًا جديدًا. سيُطلب منك التأكيد قبل إرسال أي شيء إلى {source}.',
  'auth.handoff.guild': '<b>نقل النقابة {name} إلى {destination}.</b> سجّل الدخول إلى الحساب الذي ينبغي أن يملكها هناك، أو أنشئ حسابًا جديدًا. سيُطلب منك التأكيد قبل إرسال أي شيء إلى {source}.',
  'auth.identity.placeholder': 'ada أو @ada:{host}',
  'auth.identity.placeholderNew': 'ada',
  'auth.identity.titleLogin': 'من يسجّل الدخول؟',
  'auth.identity.titleRegister': 'اختر اسم مستخدم',
  'auth.key.acceptFailed': 'تعذّر قبول مفتاح الاستعادة: {detail}',
  'auth.key.copy': 'نسخ مفتاح الاستعادة',
  'auth.key.saved': 'حفظت مفتاح الاستعادة',
  'auth.key.sub': 'يعيد تعيين كلمة مرورك ويستعيد حسابك إن فقدت كل الأجهزة.',
  'auth.key.title': 'احفظ مفتاح الاستعادة',
  'auth.key.warning': '<b>احفظه في مكان آمن منفصل عن كلمة مرورك.</b> لا أحد، ولا Telium نفسها، يستطيع إعادة إنشائه لك.',
  'auth.legacy.register.action': 'استخدام التسجيل القديم',
  'auth.legacy.register.body': 'يُرسل التسجيل القديم كلمة مرورك إلى الخادم الرئيسي. لا تستخدمه إلا إذا كنت تثق بالخادم ولا تستطيع ترقيته إلى إصدار Telium حديث.',
  'auth.legacy.register.title': 'هذا الخادم الرئيسي لا يدعم التسجيل الذي يبقي كلمة المرور خاصة.',
  'auth.legacy.server.action': 'استخدام تسجيل الدخول القديم',
  'auth.legacy.server.actionReactivate': 'استخدام إعادة التفعيل القديمة',
  'auth.legacy.server.body': 'يُرسل تسجيل الدخول القديم كلمة مرورك إلى الخادم الرئيسي. لا تستخدمه إلا إذا كنت تثق بالخادم ولا تستطيع ترقيته إلى إصدار Telium حديث.',
  'auth.legacy.server.title': 'هذا الخادم الرئيسي لا يدعم تسجيل دخول يبقي كلمة المرور خاصة.',
  'auth.legacy.upgrade.action': 'ترقية هذا الحساب',
  'auth.legacy.upgrade.body': 'الحساب أقدم من OPAQUE. في محاولة الترقية هذه فقط، سيتلقّى الخادم الرئيسي كلمة مرورك عبر نقطة تسجيل الدخول القديمة. ثم يستبدل Telium المدقّق القديم بـOPAQUE لتبقى كلمة المرور على هذا الجهاز في عمليات الدخول المستقبلية.',
  'auth.legacy.upgrade.title': 'يحتاج هذا الحساب القديم إلى ترقية أمنية لمرة واحدة.',
  'auth.localData.cache.body': 'آمن. كل ما هنا نسخة من شيء ما زال الخادم يحتفظ به، ويعود عند الاتصال التالي. تبقى مسجّلًا للدخول ومحادثاتك المشفّرة لا تُمسّ.',
  'auth.localData.cache.button': 'مسح البيانات المخزّنة مؤقتًا',
  'auth.localData.cache.cost1': 'النسخة دون اتصال من نقاباتك وقنواتك ورسائلك الأخيرة.',
  'auth.localData.cache.cost2': 'تفضيلاتك المنسوخة محليًّا، حتى تُعيدها المزامنة التالية.',
  'auth.localData.cache.cost3': 'أي شيء خزّنه عامل الخدمة مؤقتًا للاستخدام دون اتصال.',
  'auth.localData.cache.done': 'تم المسح. أعد التحميل للبدء من ذاكرة مؤقتة نظيفة.',
  'auth.localData.cache.reload': 'إعادة التحميل',
  'auth.localData.cache.title': 'مسح البيانات المخزّنة مؤقتًا',
  'auth.localData.healed': 'مسح Telium ذاكرته المؤقتة دون اتصال تلقائيًّا، لأن التطبيق فشل في البدء مرتين متتاليتين. لم يتغيّر شيء في حسابك، ومحادثاتك المشفّرة لم تُمسّ.',
  'auth.localData.identity.body': 'فقط إذا لم يساعد مسح الذاكرة المؤقتة. يدمّر هذا مفاتيح التشفير المحفوظة على هذا الجهاز، وبعض ما تفتحه لا يوجد في أي مكان آخر.',
  'auth.localData.identity.confirm': 'المحو وتسجيل الخروج',
  'auth.localData.identity.confirmTitle': 'لا يمكن التراجع عن هذا. ستفقد:',
  'auth.localData.identity.cost1': 'هوية توقيع MLS لهذا الجهاز. سيكون جهازًا جديدًا عند كل من تحدّثه، وسيرونه غير موثّق حتى توثّقه من جديد.',
  'auth.localData.identity.cost2': 'حالة المجموعة المخزّنة لكل محادثة مشفّرة. لا تبقى الرسائل الموجودة أصلًا على هذا الجهاز قابلة للقراءة إلا إذا استطاع مفتاح استعادة الحساب إعادة فتحها؛ وكل ما هو هذا الجهاز آخر من يحتفظ به يزول.',
  'auth.localData.identity.cost3': 'حلقة مفاتيح استعادة الرسائل المباشرة المخزّنة مؤقتًا، فيجب على تسجيل الدخول التالي فتح خزنة المفاتيح من جديد — بمفتاح استعادتك أو عبارة المرور، ويلزم أن تكون بحوزتك.',
  'auth.localData.identity.cost4': 'جلستك. سيُسجَّل خروجك على هذا الجهاز.',
  'auth.localData.identity.open': 'محو هوية الجهاز…',
  'auth.localData.identity.title': 'محو هوية هذا الجهاز',
  'auth.parts.advanced': 'متقدّم',
  'auth.parts.download.account': 'الحساب: {user}',
  'auth.parts.download.body1': 'يعيد هذا المفتاح تعيين كلمة مرورك ويفتح رسائلك المشفّرة من جديد.',
  'auth.parts.download.body2': 'من يملكه يستطيع فعل الأمرين. احفظه في مكان لا يصل إليه سواك.',
  'auth.parts.download.server': 'الخادم: {host} (سجّل الدخول بالحساب أعلاه على أي جهاز)',
  'auth.parts.download.title': 'مفتاح استعادة Telium',
  'auth.parts.keyGroups': '{label}، {count, plural, zero {# مجموعة محارف} one {# مجموعة محارف} two {# مجموعتا محارف} few {# مجموعات محارف} many {# مجموعة محارف} other {# مجموعة محارف}}',
  'auth.parts.needsAttention': 'يحتاج إلى انتباه: ',
  'auth.parts.recoveryKeyLabel': 'مفتاح الاستعادة',
  'auth.password.confirmLabel': 'تأكيد كلمة المرور',
  'auth.password.deactivated': 'هذا الحساب معطّل. تعيده كلمة المرور نفسها.',
  'auth.password.forgot': 'نسيتها؟ <recover>استخدم مفتاح الاستعادة</recover>',
  'auth.password.mfaLabel': 'رمز المصادقة',
  'auth.password.mfaPlaceholder': '123456، أو رمز استعادة',
  'auth.password.mfaPrompt': 'أدخل رمز المصادقة المكوّن من ستة أرقام، أو أحد رموز الاستعادة.',
  'auth.password.mismatch': 'هاتان غير متطابقتين بعد.',
  'auth.password.reactivateFailed': 'فشل إعادة التفعيل: {detail}',
  'auth.password.registerFailed': 'فشل التسجيل: {detail}',
  'auth.password.signInFailed': 'فشل تسجيل الدخول: {detail}',
  'auth.password.signingInAs': 'تسجيل الدخول باسم <b>{user}</b>.',
  'auth.password.submitLogin': 'تسجيل الدخول',
  'auth.password.submitReactivate': 'إعادة تفعيل الحساب',
  'auth.password.submitRegister': 'إنشاء حساب',
  'auth.password.titleLogin': 'أدخل كلمة مرورك',
  'auth.password.titleReactivate': 'أعد تفعيل حسابك',
  'auth.password.titleRegister': 'عيّن كلمة مرور',
  'auth.recover.malformed': 'مفتاح الاستعادة هذا مشوّه.',
  'auth.recover.notAKey': 'هذا ليس مفتاح استعادة Telium.',
  'auth.recover.reachFailed': 'تعذّر الوصول إلى خادمك الرئيسي: {detail}',
  'auth.recover.rejected': 'لم يُقبل مفتاح الاستعادة هذا لهذا الحساب.',
  'auth.recover.title': 'إعادة تعيين كلمة المرور',
  'auth.recover.unsupported': 'هذا الخادم الرئيسي لا يدعم إعادة التعيين بمفتاح الاستعادة.',
  'auth.recoveryKey.clipboardName': 'مفتاح الاستعادة',
  'auth.recoveryKey.copy': 'نسخه',
  'auth.recoveryKey.createFailed': 'تعذّر إنشاء مفتاح الاستعادة: {detail}',
  'auth.recoveryKey.download': 'تنزيله كملف',
  'auth.recoveryKey.enterPassword': 'أدخل كلمة مرورك.',
  'auth.recoveryKey.fieldLabel': 'مفتاح الاستعادة',
  'auth.recoveryKey.finishFailed': 'تعذّر إتمام حفظ مفتاح الاستعادة: {detail}',
  'auth.recoveryKey.haveExplain': 'مفتاح استعادتك هو طريق العودة إن نسيت كلمة مرورك أو فقدت كل الأجهزة. احفظه في مكان لا يصل إليه سواك. لا يمكن عرضه مرة أخرى، وإنشاء مفتاح جديد يوقف القديم عن العمل.',
  'auth.recoveryKey.lockedFirst': 'افتح رسائلك أعلاه، ثم يمكنك إنشاء مفتاح استعادة.',
  'auth.recoveryKey.makeButton': 'إنشاء مفتاح استعادة',
  'auth.recoveryKey.makeNew': 'إنشاء المفتاح الجديد',
  'auth.recoveryKey.noneExplain': 'هذا الحساب لا يملك مفتاح استعادة. ومن دونه، يعني نسيان كلمة المرور فقدان رسائلك الأقدم. وإنشاء واحد يستغرق ثوانٍ قليلة.',
  'auth.recoveryKey.onceWarning': '<b>دوّنه قبل أن تمضي.</b> يُعرض مرة واحدة ولا يمكن عرضه مرة أخرى، لا منّا ولا من أي أحد.',
  'auth.recoveryKey.passwordHint': 'يُتحقّق منها على هذا الجهاز. لا يتلقّاها خادمك أبدًا.',
  'auth.recoveryKey.passwordLabel': 'كلمة مرورك',
  'auth.recoveryKey.placeholder': 'telium-recovery-v1-…',
  'auth.recoveryKey.replaceBody': 'يتوقف مفتاح استعادتك الحالي عن العمل لحظة إنشاء الجديد. وإن كنت قد دوّنته في مكان ما، تصبح تلك النسخة بلا فائدة.',
  'auth.recoveryKey.replaceButton': 'إنشاء مفتاح استعادة جديد',
  'auth.recoveryKey.replaceConfirm': 'إنشاء واحد جديد',
  'auth.recoveryKey.replaceExplain': 'أدخل كلمة مرورك لإنشاء المفتاح الجديد. يتوقف المفتاح القديم عن العمل.',
  'auth.recoveryKey.replaceTitle': 'إنشاء مفتاح استعادة جديد',
  'auth.recoveryKey.saved': 'حفظته',
  'auth.recoveryKey.savedToast': 'تم حفظ مفتاح الاستعادة. احفظه منفصلًا عن كلمة مرورك.',
  'auth.recoveryKey.title': 'مفتاح الاستعادة',
  'auth.recoveryKey.unsupported': 'هذا الخادم لا يوفّر مفاتيح استعادة. تبقى مفاتيحك على الأجهزة التي توافق عليها.',
  'auth.reset.confirmLabel': 'تأكيد كلمة المرور الجديدة',
  'auth.reset.failed': 'فشلت إعادة تعيين كلمة المرور: {detail}',
  'auth.reset.minLength': '{count, plural, zero {على الأقل # حرف.} one {على الأقل # حرف.} two {على الأقل # حرفين.} few {على الأقل # محارف.} many {على الأقل # حرفًا.} other {على الأقل # حرف.}}',
  'auth.reset.mismatch': 'كلمتا المرور الجديدتان غير متطابقتين.',
  'auth.reset.newLabel': 'كلمة المرور الجديدة',
  'auth.reset.submit': 'إعادة تعيين كلمة المرور',
  'auth.reset.title': 'اختر كلمة مرور جديدة',
  'auth.server.label': 'الخادم الرئيسي',
  'auth.server.noServer': 'ليس لديك واحد؟ <a>ابحث عن خادم رئيسي</a>',
  'auth.server.placeholder': 'home.example',
  'auth.server.probeChecking': 'جارٍ فحص الخادم',
  'auth.server.probeFound': 'تم العثور على الخادم',
  'auth.server.probeUnreachable': 'تعذّر الوصول إلى الخادم',
  'auth.server.sub': 'كل حساب Telium ينتمي إلى خادم رئيسي واحد.',
  'auth.server.title': 'أين يقع حسابك؟',
  'auth.server.unreachableBody': 'لم يستجب شيء على ذلك العنوان، فقد يكون مكتوبًا خطأً أو خاصًّا أو معطّلًا. يمكنك المتابعة به، لكن تسجيل الدخول وإنشاء حساب لن يعملا حتى يستجيب. <a>ابحث عن خادم رئيسي</a> معروف بأنه يعمل.',
  'auth.server.unreachableTitle': '{host} لم يستجب',
  'auth.server.use': 'استخدام هذا الخادم',
  'auth.server.useAnyway': 'استخدامه على أي حال',
  'auth.start.lostPassword': 'نسيت كلمة المرور؟ <recover>استعد حسابك</recover>',
  'auth.start.register': 'ابدأ',
  'auth.start.signIn': 'تسجيل الدخول',
  'auth.start.title': 'مرحبًا بك في Telium',
  'auth.unlock.button': 'فتح',
  'auth.unlock.done': 'تم الفتح. تكفي كلمة مرورك من الآن فصاعدًا.',
  'auth.unlock.doneDevice': 'تم الفتح على هذا الجهاز.',
  'auth.unlock.enterKey': 'أدخل مفتاح الاستعادة.',
  'auth.unlock.enterPassphrase': 'أدخل عبارة الاستعادة.',
  'auth.unlock.failed': 'تعذّر فتح رسائلك: {detail}',
  'auth.unlock.keyHint': 'المفتاح الذي أُعطي لك عند إنشاء هذا الحساب.',
  'auth.unlock.otherDevice': 'يمكنك أيضًا فتح Telium على جهاز تستخدمه بالفعل والموافقة على هذا الجهاز من هناك. لا يُكتب أي شيء، ولا يرى خادمك المفاتيح أبدًا.',
  'auth.unlock.passphraseHint': 'عبارة المرور التي أضفتها إلى هذا الحساب بنفسك.',
  'auth.unlock.passphraseLabel': 'عبارة الاستعادة',
  'auth.unlock.title': 'افتح رسائلك الأقدم',

  // ---- chat
  'chat.format.bar': 'تنسيق النص',
  'chat.gif.exitFullscreen': 'الخروج من ملء الشاشة',
  'chat.gif.fullscreen': 'ملء الشاشة',
  'chat.gif.resize': 'تغيير حجم منتقي GIF',
  'chat.message.actions.delete': 'حذف',
  'chat.message.actions.pin': 'تثبيت',
  'chat.message.actions.quickReact': 'تفاعل باستخدام {emoji}',
  'chat.message.actions.unpin': 'إلغاء التثبيت',
  'chat.message.deleteFailed': 'تعذّر الحذف',
  'chat.message.pinFailed': 'تعذّر التثبيت',
  'chat.message.pinned': 'تم التثبيت.',
  'chat.message.pinnedMark': 'مثبّتة',
  'chat.message.quotedDeleted': 'حُذفت الرسالة الأصلية',
  'chat.message.unpinned': 'أُلغي التثبيت.',
  'chat.quote.body': '<quoted/>',
  'chat.timeline.pinNotice.anonymous': 'تم تثبيت رسالة',
  'chat.timeline.pinNotice.named': '{name} ثبّت رسالة',
  'chat.timeline.pinNotice.seeAll': 'عرض كل المثبّتات',

  // ---- errors
  'errors.account_already_active': 'هذا الحساب نشط بالفعل.',
  'errors.account_deleted': 'حُذف هذا الحساب ولا يمكن تسجيل الدخول إليه.',
  'errors.assertion_rejected': 'لم يقبل خادم تلك النقابة بيانات اعتماد هذا البوت.',
  'errors.bot_not_installed': 'هذا البوت غير مثبّت على خادم تلك النقابة.',
  'errors.demoted': 'سلّم هذا الخادم المهمة إلى عقدة أخرى. جارٍ إعادة الاتصال.',
  'errors.invalid_recovery_proof': 'عبارة الاستعادة هذه غير صحيحة لهذا الحساب. تحقّق من كلمة ناقصة أو مبدَّلة.',
  'errors.legacy_auth_required': 'هذا الخادم الرئيسي أقدم من أن يُسجَّل الدخول إليه بهذه النسخة من Telium.',
  'errors.mfa_not_configured': 'لم يُهيَّأ لهذا الحساب عامل ثانٍ.',
  'errors.mfa_setup_not_started': 'ابدأ تهيئة المصادقة الثنائية قبل تأكيد الرمز.',
  'errors.migration_handoff_invalid': 'رابط الترحيل هذا لم يعد صالحًا. ابدأ النقل مجددًا من الحساب الذي تغادره.',
  'errors.migration_in_progress': 'ينتقل هذا الحساب إلى {destination}. ولا يمكن تغييره هنا حتى يكتمل النقل.',
  'errors.migration_refused': '{destination} رفض النقل.',
  'errors.not_a_guild_server': 'هذا العنوان لا يستضيف نقابات.',
  'errors.opaque_downgrade': 'قدّم هذا الخادم طريقة دخول أقدم وأضعف من التي يستخدمها حسابك. ولم يُرسل Telium كلمة مرورك. وإن كنت على شبكة عامة، فأعد المحاولة من مكان آخر.',
  'errors.opaque_required': 'يسجّل هذا الحساب الدخول بتبادل أحدث لا تتقنه هذه النسخة من Telium. حدّث Telium ثم أعد المحاولة.',
  'errors.owner_only': 'لا يستطيع فعل ذلك إلا مالك هذه النقابة.',
  'errors.reauth_expired': 'استغرق ذلك وقتًا طويلًا حتى صرنا نحتاج إلى كلمة مرورك مجددًا.',
  'errors.recovery_attempt_expired': 'انتهت صلاحية محاولة الاستعادة هذه. ابدأ من البداية.',
  'errors.role_hierarchy': 'لا يمكنك فعل ذلك بشخص أعلى دورًا منك.',
  'errors.shut_down': 'أُغلق هذا الخادم الرئيسي من قِبل مشغّله.',
  'errors.standby_read_only': 'هذا الخادم في وضع الاستعداد ولا يمكن القراءة منه إلا الآن. لم تُرسل رسالتك.',
  'errors.timed_out': 'أنت في مهلة هنا حتى {expires_at, time, short}.',
  'errors.try_again': 'هناك شيء آخر يستخدم ذلك الآن. أعد المحاولة بعد لحظة.',
  'errors.unsupported_media_type': 'لا تُقبل هنا الملفات من نوع {media_type}.',
  'errors.username_invalid': '{reason, select, too_short {اسم المستخدم هذا قصير جدًا.} too_long {اسم المستخدم هذا طويل جدًا.} charset {يمكن أن يحتوي اسم المستخدم على حروف وأرقام ونقاط وشرطات وشرطات سفلية.} reserved {اسم المستخدم هذا محجوز.} other {لا يمكن استخدام اسم المستخدم هذا هنا.}}',

  // ---- guild
  'guild.overview.vanity.address': 'عنوان النقابة: {address}',
  'guild.overview.vanity.hint': 'معطّل افتراضيًا. وعند تفعيله يستطيع أي شخص لديه العنوان معاينة هذه النقابة والانضمام إليها. وتبقى روابط الدعوة تعمل أيضًا.',
  'guild.overview.vanity.label': 'اسم العنوان',
  'guild.overview.vanity.linkClipboard': 'الرابط المخصّص',
  'guild.overview.vanity.linkLabel': 'رابط المتصفّح',
  'guild.overview.vanity.placeholder': 'linuxcommunity',
  'guild.overview.vanity.saveFailed': 'تعذّر حفظ الرابط المخصّص',
  'guild.overview.vanity.title': 'رابط مخصّص',
  'guild.overview.vanity.toggle': 'تفعيل الرابط المخصّص',

  // ---- migration
  'migration.banner.alert': '{subject, select, guild {النقابة {subjectId}} other {حسابك}} مُهيّأ للانتقال إلى {destination} {when, select, soon {بمجرد التقاطه} other {في {at, date, short}، {at, time, withSeconds}}}. إن لم تطلب هذا، فألغِه وغيّر كلمة مرورك.{mailed, select, sent { وقد أُرسل تحذير أيضًا إلى بريد الاستعادة.} other {}}',
  'migration.banner.cancel': 'إلغاء النقل',
  'migration.banner.cancelFailed': 'تعذّر إلغاء النقل: {reason}',
  'migration.banner.more': '{count, plural, zero {# انتقال مجدول إضافي في الانتظار. افتح الإعدادات لرؤيته.} one {# انتقال مجدول إضافي في الانتظار. افتح الإعدادات لرؤيته.} two {# انتقالان مجدولان إضافيان في الانتظار. افتح الإعدادات لرؤيتهما.} few {# انتقالات مجدولة إضافية في الانتظار. افتح الإعدادات لرؤيتها.} many {# انتقالًا مجدولًا إضافيًّا في الانتظار. افتح الإعدادات لرؤيته.} other {# انتقال مجدول إضافي في الانتظار. افتح الإعدادات لرؤيته.}}',
  'migration.confirm.account': '<b>هل تنقل {subjectId} إلى {me}؟</b> وما زال يجب التصريح بالنقل على {source} بكلمة مرور ذلك الحساب.',
  'migration.confirm.anotherServer': 'خادم آخر',
  'migration.confirm.confirming': 'جارٍ التأكيد…',
  'migration.confirm.done': '<b>{source} أُبلغ أن هذا {subject, select, guild {النقابة} other {الحساب}} جاهز.</b> لم ينتقل شيء بعد. ارجع إلى النافذة التي بدأت منها النقل: {source} سيعرض {target} {subject, select, guild {بصفته المالك الجديد للنقابة} other {بصفته الوجهة}} ويطلب كلمة مرورك هناك قبل أن تبدأ فترة التهدئة.',
  'migration.confirm.failed': 'تعذّر تأكيد هذا النقل: {reason}',
  'migration.confirm.guild': '<b>هل تستقبل النقابة {guild} من {source}؟</b> سيملكها هنا {me}. وما زال يجب أن يصرّح بالنقل على {source} مالكُ النقابة.',
  'migration.confirm.guildNamed': '«{name}» ({id})',
  'migration.confirm.notNow': 'ليس الآن',
  'migration.confirm.notYou': 'إن لم تكن قد بدأت للتو نقل {subject, select, guild {نقابة} other {حسابًا}} من {source}، فاختر ليس الآن. ولا يُرسل شيء إلا إذا أكّدت.',
  'migration.confirm.receive': '{subject, select, guild {استقبال هذه النقابة} other {استقبال هذا الحساب}}',
  'migration.confirm.sending': 'جارٍ إرسال التأكيد إلى {source}…',
  'migration.confirm.thisAccount': 'هذا الحساب',
  'migration.confirm.wrongServer': '<b>هذا الرابط لنقل {subject, select, guild {نقابة} other {حساب}} إلى {destination}.</b> أنت مسجّل الدخول على {here}. سجّل الخروج، ثم سجّل الدخول أو أنشئ حسابًا على {destination} وافتح الرابط من جديد. لم يُرسل شيء.',
  'migration.field.destination': 'خادم الوجهة',
  'migration.field.destinationPlaceholder': 'newhome.example.org',
  'migration.field.oldAccountId': 'معرّف الحساب القديم',
  'migration.field.oldGuildId': 'معرّف النقابة القديمة',
  'migration.field.oldServer': 'الخادم القديم',
  'migration.field.password': 'كلمة مرورك على هذا الخادم',
  'migration.field.passwordHint': 'هذه كلمة مرور الخادم القديم/الحالي، لا الوجهة.',
  'migration.guided.authorize': 'أعد إدخال كلمة مرورك للتصريح به. وبدء الجدولة يفتح فترة تهدئة يمكن لأي من أجهزتك الإلغاء خلالها.',
  'migration.guided.continue': 'تابع على الخادم الجديد',
  'migration.guided.finishThere': '<b>أكمِل على {destination}.</b> فُتحت نافذة على صفحة {destination} نفسها. سجّل الدخول، أو {subject, select, guild {أنشئ الحساب الذي سيملك النقابة هناك} other {أنشئ الحساب الذي تنتقل إليه}}، وأكّد هناك.',
  'migration.guided.intro': '{subject, select, guild {سمِّ الخادم الذي تنقل هذه النقابة إليه.} other {سمِّ الخادم الذي تنتقل إليه.}} أكّد في صفحته، ثم ارجع إلى هنا للتصريح بكلمة مرورك.',
  'migration.guided.linkExpired': 'انتهت صلاحية ذلك الرابط. ابدأ من جديد للحصول على رابط آخر.',
  'migration.guided.lookingUp': 'جارٍ البحث عن {destination}…',
  'migration.guided.noClient': '{destination} لا تنشر صفحة ويب لاستقبال نقل. ويمكنك مع ذلك الانتقال إليها برمز استيراد يُنشأ على ذلك الخادم.',
  'migration.guided.noWindow': 'إن لم تُفتح أي نافذة: <a>{url}</a>',
  'migration.guided.openAgain': 'افتحه من جديد',
  'migration.guided.opening': 'جارٍ الفتح…',
  'migration.guided.ready': '<b>{destination} جاهزة.</b> {subject, select, guild {هذه النقابة، {name}، ستنتقل إلى {destination}، ويملكها هناك <id>{target}</id>.} other {هذا الحساب، {name}، سينتقل إلى <id>{target}</id>.}} إن لم يكن ذلك الحساب الذي أكّدته للتو، فألغِ من هنا.',
  'migration.guided.startFailed': 'تعذّر بدء النقل: {reason}',
  'migration.guided.step': 'الخطوة {current, number} من {total, number}',
  'migration.guided.useCode': 'استخدام رمز استيراد',
  'migration.guided.waiting': 'في انتظار تأكيد {destination}… يعمل هذا الرابط مرة واحدة وينتهي {expiresAt, relative}.',
  'migration.importCode.hint': 'للاستخدام مرة واحدة وقصير الأجل. لا تلصقه إلا في مربّع حوار النقل على الخادم القديم.',
  'migration.importCode.label': 'رمز الاستيراد',
  'migration.importCode.placeholder': 'رمز لمرة واحدة من الوجهة',
  'migration.importCode.sourceHint': 'يُنشأ من الإعدادات ← الحساب ← استقبال نقل على الوجهة. وينتهي بعد سبعة أيام.',
  'migration.manual.destinationHint': 'الخادم الذي أنشأت عليه رمز الاستيراد للتو.',
  'migration.manual.step1': '{step, number}. جهّز خادم الوجهة.',
  'migration.manual.step1Where': 'سجّل الدخول على الخادم الذي تريد الانتقال إليه، ثم افتح الإعدادات ← الحساب ← استقبال نقل. وسينشئ رمز استيراد لمرة واحدة لهذا المصدر بالتحديد.',
  'migration.manual.step1Which': 'للحساب، استخدم حساب الوجهة الذي أنشأته هناك. وللنقابة، استخدم الحساب الذي ينبغي أن يملكها هناك.',
  'migration.manual.step2': '{step, number}. صرّح بالنقل على هذا الخادم.',
  'migration.manual.step2Cooling': 'تبدأ الجدولة فترة تهدئة. ويمكن لأي جهاز نشط الإلغاء قبل تنفيذ النقل.',
  'migration.manual.step2Password': 'أعد إدخال كلمة مرورك الحالية أدناه.',
  'migration.manual.useGuided': 'استخدام النقل الموجَّه',
  'migration.receive.accountIdHint': 'معرّفك الكامل على الخادم القديم، مثل @you:old.example.',
  'migration.receive.accountIdPlaceholder': '@you:old.example',
  'migration.receive.another': 'إنشاء رمز آخر',
  'migration.receive.approvalFor': 'هذه الموافقة تخصّ {subjectId} من {source}.',
  'migration.receive.create': 'إنشاء رمز استيراد',
  'migration.receive.creating': 'جارٍ التحضير…',
  'migration.receive.expires': 'ينتهي {expiresAt, date, medium} ({expiresAt, relative}).',
  'migration.receive.guildIdHint': 'انسخ معرّف النقابة كما يظهر تمامًا على الخادم القديم.',
  'migration.receive.guildIdPlaceholder': 'معرّف النقابة من الخادم القديم',
  'migration.receive.guildOwner': 'ستُملَك النقابة المنقولة هنا بالحساب الذي أنت مسجّل الدخول به.',
  'migration.receive.intro': '<b>أنت تهيّئ {destination} لتكون الوجهة.</b> لا ينتقل أو يُحذف شيء بهذه الخطوة.',
  'migration.receive.nextTitle': 'الآن ارجع إلى الخادم القديم.',
  'migration.receive.nextUse': 'في مربّع حوار النقل لديه، استخدم {destination} خادمًا للوجهة والصق رمز الاستيراد أعلاه.',
  'migration.receive.prepareFailed': 'تعذّر تحضير هذا الخادم: {reason}',
  'migration.receive.preparing': 'جارٍ فحص الخادم القديم وإنشاء رمز استيراد لمرة واحدة…',
  'migration.receive.ready': '<b>{destination} جاهزة لاستقبال هذا النقل.</b> لم ينتقل شيء بعد.',
  'migration.receive.sourceFromId': 'يُقرأ من معرّف الحساب أعلاه.',
  'migration.receive.sourceGuildHint': 'الخادم الذي يستضيف النقابة حاليًّا.',
  'migration.receive.sourcePlaceholder': 'old.example',
  'migration.receive.subject': 'ماذا تستقبل؟',
  'migration.receive.subjectAccount': 'حسابًا',
  'migration.receive.subjectGuild': 'نقابة',
  'migration.receive.thisServer': 'هذا الخادم',
  'migration.receive.title': 'استقبال نقل',
  'migration.schedule.action': 'جدولة النقل',
  'migration.schedule.busy': 'جارٍ الجدولة…',
  'migration.schedule.failed': 'لم تبدأ الهجرة: {reason}',
  'migration.schedule.noDeviceKey': 'لا يملك هذا الجهاز مفتاح توقيع مخزّنًا. ويجب بدء الهجرة من جهاز ينتمي بالفعل إلى هذا الحساب.',
  'migration.schedule.scheduling': 'جارٍ جدولة النقل…',
  'migration.schedule.signFailed': 'تعذّر على هذا الجهاز توقيع تصريح الهجرة.',
  'migration.schedule.signing': 'جارٍ توقيع هذا النقل بهذا الجهاز…',
  'migration.scheduled.cancelHint': 'يمكنك الإلغاء خلال فترة التهدئة من الإعدادات ← الحساب.',
  'migration.scheduled.headline': '<b>النقل مجدول، ولم يكتمل بعد.</b> لم يُحذف شيء عند ضغطك على جدولة. وسينتقل إلى {destination} {at, relative} ما لم يلغِه جهاز نشط أولًا.',
  'migration.title.account': 'نقل هذا الحساب',
  'migration.title.guild': 'نقل هذه النقابة',

  // ---- notifications
  'notifications.alerts.callRing.hint': 'نغمة رنين متكرّرة بينما يتّصل بك أحد في محادثة. تتوقّف عند ردّك أو رفضك أو استسلامه.',
  'notifications.alerts.callRing.label': 'الرنين للمكالمات الواردة',
  'notifications.alerts.dms.hint': 'كل رسالة في محادثة مباشرة موجّهة إليك، فلا تغطّيها الإشارات.',
  'notifications.alerts.dms.hintAndroid': 'يعرض تنبيهات مشفّرة للرسائل المباشرة ومحادثات المجموعات بينما Telium في الخلفية أو مغلق تمامًا. وتبقى تنبيهات التطبيق الموقوف عامة حتى يعمل MLS من جديد.',
  'notifications.alerts.dms.label': 'الإشعار بالرسائل المباشرة',
  'notifications.alerts.mentions.hint': 'يعرض إشعارًا عند ذكرك بينما Telium في الخلفية.',
  'notifications.alerts.mentions.label': 'الإشعار عند الإشارات',
  'notifications.alerts.preview.full': 'معاينة كاملة',
  'notifications.alerts.preview.hidden': 'إخفاء المرسل والمحتوى',
  'notifications.alerts.preview.hint': 'يتحكّم في ما تكشفه إشعارات النظام على هذا الجهاز. ويتزامن التفضيل مع حسابك؛ ويبقى محتوى الرسائل داخل مسار الإشعارات المشفّر في Telium.',
  'notifications.alerts.preview.label': 'معاينات الإشعارات',
  'notifications.alerts.preview.sender': 'المرسل / العنوان فقط',
  'notifications.alerts.sound.hint': 'يُشغَّل بينما يعمل العميل، سواء كان في المقدمة أم لا.',
  'notifications.alerts.sound.label': 'تشغيل صوت للإشارات والرسائل المباشرة',
  'notifications.alerts.soundMessages.hint': 'كل رسالة في قناة تقرؤها، لا فقط الموجّهة إليك.',
  'notifications.alerts.soundMessages.label': 'أيضًا للرسائل العادية',
  'notifications.alerts.title': 'التنبيهات',
  'notifications.local.blockedBrowser': 'الإشعارات محجوبة لهذا الموقع في إعدادات المتصفّح. أعد السماح بها هناك أولًا.',
  'notifications.local.blockedSystem': 'الإشعارات محجوبة في إعدادات نظام تشغيلك. أعد تفعيل Telium هناك أولًا.',
  'notifications.local.browserPermission': 'إذن المتصفّح',
  'notifications.local.description': 'تنبيهات من هذا المتصفّح أو تطبيق سطح المكتب بينما يعمل Telium في الخلفية.',
  'notifications.local.enable': 'تفعيل',
  'notifications.local.enabled': 'تم تفعيل الإشعارات على هذا الجهاز.',
  'notifications.local.enableFailed': 'تعذّر تفعيل الإشعارات: {reason}',
  'notifications.local.enabling': 'جارٍ التفعيل…',
  'notifications.local.permissionState': '{state, select, loading {جارٍ الفحص…} granted {مسموح} denied {محجوب} unsupported {غير متاح} other {لم يُطلب بعد}}',
  'notifications.local.reload': 'إعادة التحميل',
  'notifications.local.systemPermission': 'إذن النظام',
  'notifications.local.title': 'الإشعارات المحلية',
  'notifications.local.unsupported': 'الإشعارات المحلية غير متاحة في هذا المتصفّح.',
  'notifications.local.updateReady': 'ثُبّت بناء أحدث',
  'notifications.push.android.action': '{stage, select, unverified {اختبار الإيقاظ} inbox {إكمال الإعداد} other {إعداد}}',
  'notifications.push.android.enrolled': '{outcome, select, verified {اجتازت إشعارات Android في الخلفية اختبار إيقاظ.} endpoint {سجّل Android نقطة نهاية دفع، لكن تسليم الإيقاظ غير موثّق.} other {أُعدّ دفع Android؛ ونقطة نهاية الإيقاظ قيد التسجيل.}}',
  'notifications.push.android.enrollFailed': 'تعذّر تسجيل إشعارات Android: {reason}',
  'notifications.push.android.label': 'إشعارات Android في الخلفية',
  'notifications.push.android.notice': '{stage, select, ready {جاهز للإيقاظ في الخلفية. أرسل Telium جرس باب اختباريًّا حقيقيًّا خاليًا من المحتوى عبر مزوّد الدفع المُعدّ، وأكّد Android وصوله إلى خدمة الدفع الأصلية.} unverified {صندوق الوارد المشفّر ونقطة نهاية الدفع مسجّلان، لكن لم يصل بعد أي إيقاظ موثّق إلى هذا الهاتف. اختبر الإيقاظ قبل الاعتماد على الإشعارات بينما Telium مغلق.} inbox {صندوق الوارد المشفّر جاهز، لكن لا تملك هذا الجهاز بعد نقطة نهاية إيقاظ مؤكّدة. أكمل الإعداد لاختيار موزّع دفع Android أو تحديثه.} none {أعدّ صندوق وارد Android المشفّر وموزّع الدفع للتسليم في الخلفية.} other {فعّل إشعارات النظام أولًا، ثم يستطيع Telium تسجيل هذا الجهاز بنظام Android للتسليم المشفّر في الخلفية.}}',
  'notifications.push.android.state': '{stage, select, checking {جارٍ الفحص…} ready {جاهز} unverified {الإيقاظ غير موثّق} inbox {صندوق الوارد فقط} other {غير مُعدّ}}',
  'notifications.push.android.testing': 'جارٍ الاختبار…',
  'notifications.push.description': 'لا تفعل مزوّدات الدفع سوى إيقاظ Telium. ويبقى محتوى الإشعار داخل صندوق وارد Telium المشفّر.',
  'notifications.push.desktopOnly': 'تعمل إشعارات سطح المكتب بينما يعمل Telium. وإيقاظ تطبيق سطح مكتب مغلق تمامًا غير مُنفَّذ بعد.',
  'notifications.push.privacyHint': 'لا تحمل إيقاظات المزوّد أي محتوى رسالة. ويسحب Android والمتصفّحات المدعومة صفوف صندوق وارد غير شفّافة، ويفكّ تشفيرها على الجهاز، ويؤكّد فقط الصفوف التي عالجها بنجاح.',
  'notifications.push.title': 'الدفع في الخلفية',
  'notifications.push.unsupported': 'لا يستطيع هذا المتصفّح تسجيل الدفع في الخلفية على هذا الجهاز.',
  'notifications.push.web.hint': 'يسجّل اشتراك Web Push مشفّرًا لدى خادمك الرئيسي.',
  'notifications.push.web.label': 'إيقاظ هذا المتصفّح عندما يكون مغلقًا',
  'notifications.push.web.off': 'الدفع في الخلفية معطّل على هذا المتصفّح.',
  'notifications.push.web.offFailed': 'تعذّر تعطيل الدفع: {reason}',
  'notifications.push.web.on': 'يستطيع هذا المتصفّح الإيقاظ للإشعارات.',
  'notifications.push.web.onFailed': 'تعذّر تفعيل الدفع: {reason}',
  'notifications.system.appName': 'Telium',
  'notifications.system.attachmentFrom': '{sender} أرسل مرفقًا',
  'notifications.system.calling': 'الاتصال بـ{name}',
  'notifications.system.channelTitle': '#{channel}',
  'notifications.system.encryptedFrom': '{sender} أرسل رسالة مشفّرة',
  'notifications.system.generic': 'إشعار جديد',
  'notifications.system.incomingCall': 'مكالمة واردة',
  'notifications.system.messageFrom': '{sender}: {message}',
  'notifications.system.newDm': 'رسالة مباشرة جديدة',
  'notifications.system.newMention': 'إشارة جديدة',
  'notifications.system.newReply': 'ردّ جديد',
  'notifications.system.showFailed': 'تعذّر عرض إشعار',
  'notifications.system.unknownChannel': 'قناة',
  'notifications.wake.activity': 'نشاط جديد في قناة تتابعها.',
  'notifications.wake.migration': 'طُلب نقل حسابك. افتح Telium لمراجعته أو إلغائه.',
  'notifications.wake.updateToast': 'إصدار جديد جاهز. أعد التحميل لاستخدامه.',

  // ---- onboarding
  'onboarding.address.clipboardLabel': 'العنوان',
  'onboarding.address.copy': 'نسخ العنوان',
  'onboarding.address.yours': 'عنوان Telium هو <b>{user}</b>. وستحتاجه لتسجيل الدخول على جهاز آخر.',
  'onboarding.home.advancedHint': 'متقدّم: أدخل عنوان HTTPS لأي خادم رئيسي لـTelium يسمح بالتسجيل.',
  'onboarding.home.advancedPlaceholder': 'https://home.example',
  'onboarding.home.browseAll': 'تصفّح كل الخوادم',
  'onboarding.home.chipAction': '{host} — غيّر مكان عيش حسابك',
  'onboarding.home.chooseOther': 'اختيار واحد مختلف',
  'onboarding.home.communityBadge': 'مجتمع',
  'onboarding.home.detailSeparator': ' · ',
  'onboarding.home.explainer': 'يحفظ هذا الخادم حسابك وتسجيل دخولك. ويمكن أن تعيش المجتمعات في أي مكان.',
  'onboarding.home.finding': 'جارٍ إيجاد خادم مجتمع سليم…',
  'onboarding.home.label': 'الخادم الرئيسي',
  'onboarding.home.noPinnedKey': 'لم يثبّت بناء هذا العميل مفتاح توقيع الترشيحات بعد.',
  'onboarding.home.operatedBy': 'يشغّله <a>{operator}</a>',
  'onboarding.home.otherChoices': 'مواطن حسابات موصى بها أخرى',
  'onboarding.home.picked': 'اخترنا <b>{name}</b> من أجلك',
  'onboarding.home.title': 'موطن الحساب',
  'onboarding.home.unavailable': 'لا يتوفّر الآن أي ترشيح مجتمعي موثّق. اختر بدلًا من ذلك أي خادم رئيسي تثق به.',
  'onboarding.home.uptime': '{rate, number}% من وقت التشغيل الأخير',
  'onboarding.home.useAnother': 'استخدام خادم آخر',
  'onboarding.home.useDomain': 'استخدام نطاق خادم',
  'onboarding.home.why': 'هنا يعيش حسابك، قليلًا كاختيار مزوّد بريد إلكتروني. وما زال بإمكانك التحدّث إلى أي أحد والانضمام إلى أي مجتمع، أيًّا كان الخادم الذي يستخدمونه. ونوزّع الوافدين الجدد على خوادم موثوقة حتى لا تعتمد Telium أبدًا على شركة واحدة.',
  'onboarding.invite.accountIdLabel': 'اسم المستخدم أو معرّف الحساب',
  'onboarding.invite.accountIdPlaceholder': 'yourname أو @you:home.example',
  'onboarding.invite.accountReady': 'حسابك جاهز.',
  'onboarding.invite.backToSignIn': 'العودة إلى تسجيل الدخول',
  'onboarding.invite.createAndJoin': 'إنشاء حساب والانضمام إلى {guild}',
  'onboarding.invite.createFailed': 'تعذّر إنشاء حسابك.',
  'onboarding.invite.creating': 'جارٍ إنشاء الحساب…',
  'onboarding.invite.displayNameHint': 'يمكنك تغيير هذا لاحقًا.',
  'onboarding.invite.displayNameLabel': 'اسم العرض',
  'onboarding.invite.displayNamePlaceholder': 'بماذا يناديك الجميع؟',
  'onboarding.invite.existingHomeHint': 'الخادم حيث يعيش حساب Telium الحالي.',
  'onboarding.invite.expiredBody': 'ربما انتهت صلاحيتها أو بلغت حدّ استخدامها أو أُلغيت.',
  'onboarding.invite.expiredTitle': 'لم تعد هذه الدعوة صالحة',
  'onboarding.invite.goToTelium': 'الانتقال إلى Telium',
  'onboarding.invite.haveAccount': 'لديك حساب Telium بالفعل؟ <a>سجّل الدخول</a>',
  'onboarding.invite.homeHint': 'حيث سيعيش حسابك الجديد. وتغييره لا يغيّر الدعوة.',
  'onboarding.invite.homePlaceholder': 'home.example',
  'onboarding.invite.hostNote': '<b>{domain}</b> تستضيف هذه النقابة. ويمكن أن يعيش حسابك على خادم Telium مختلف.',
  'onboarding.invite.invited': 'دُعيت للانضمام',
  'onboarding.invite.invitedBy': '{name} دعاك للانضمام',
  'onboarding.invite.join': 'الانضمام إلى {guild}',
  'onboarding.invite.joinFailed': 'تعذّر الانضمام إلى هذه النقابة.',
  'onboarding.invite.joining': 'جارٍ الانضمام…',
  'onboarding.invite.joiningAs': 'الانضمام باسم {name}.',
  'onboarding.invite.legacyRegisterAction': 'استخدام التسجيل القديم',
  'onboarding.invite.legacyServer': '<b>هذا الخادم الرئيسي يستخدم مصادقة كلمات المرور القديمة.</b> المتابعة ترسل كلمة مرورك إلى هذا الخادم. لا تفعل ذلك إلا إذا كنت تثق به.',
  'onboarding.invite.legacySignInAction': 'استخدام تسجيل الدخول القديم',
  'onboarding.invite.legacyUpgrade': '<b>يحتاج هذا الحساب القديم إلى ترقية أمنية لمرة واحدة.</b> في هذه المحاولة فقط، سيتلقّى الخادم كلمة مرورك. ولن يفعل ذلك في عمليات الدخول اللاحقة.',
  'onboarding.invite.legacyUpgradeAction': 'ترقية هذا الحساب',
  'onboarding.invite.members': '{count, plural, zero {# عضو} one {# عضو} two {# عضوان} few {# أعضاء} many {# عضوًا} other {# عضو}}',
  'onboarding.invite.mfaLabel': 'رمز المصادقة',
  'onboarding.invite.mfaPlaceholder': '123456 أو رمز استعادة',
  'onboarding.invite.mfaPrompt': 'أدخل رمز المصادقة المكوّن من ستة أرقام أو أحد رموز الاستعادة.',
  'onboarding.invite.needAccount': 'تحتاج حساب Telium؟ <a>أنشئ واحدًا</a>',
  'onboarding.invite.needCredentials': 'أدخل اسم المستخدم وكلمة المرور.',
  'onboarding.invite.needDisplayName': 'اختر اسم العرض الذي ينبغي أن يراه أعضاء النقابة.',
  'onboarding.invite.needHome': 'اختر خادمًا رئيسيًّا لحسابك.',
  'onboarding.invite.newHomeHint': 'الخادم الذي سينتمي إليه حساب Telium الجديد.',
  'onboarding.invite.noIdentityRole': '{name} لا تستضيف حسابات مستخدمين.',
  'onboarding.invite.online': '{count, plural, zero {# متصل} one {# متصل} two {# متصلان} few {# متصلون} many {# متصلًا} other {# متصل}}',
  'onboarding.invite.opening': 'جارٍ فتح الدعوة…',
  'onboarding.invite.openingHint': 'جارٍ سؤال خادم هذه النقابة عمّا يفتحه الرابط.',
  'onboarding.invite.registrationClosed': '{name} لا تقبل حسابات جديدة.',
  'onboarding.invite.screeningPending': 'حسابك جاهز. وتتطلّب هذه النقابة فرزًا قبل أن تصبح عضوًا.',
  'onboarding.invite.signInAndJoin': 'تسجيل الدخول والانضمام إلى {guild}',
  'onboarding.invite.signInFailed': 'تعذّر تسجيل الدخول.',
  'onboarding.invite.signingIn': 'جارٍ تسجيل الدخول…',
  'onboarding.invite.unopenableTitle': 'تعذّر فتح هذه الدعوة',
  'onboarding.invite.unreachable': 'تعذّر الوصول إلى خادم النقابة.',
  'onboarding.invite.useAnotherAccount': 'استخدام حساب مختلف',
  'onboarding.invite.usernameHint': 'يصبح هذا الجزء الأول من معرّف حساب Telium.',
  'onboarding.invite.usernamePlaceholder': 'yourname',
  'onboarding.recoveryKey.body': 'يمكنه إعادة تعيين كلمة مرورك واستعادة حسابك المشفّر.',
  'onboarding.recoveryKey.clipboardLabel': 'مفتاح الاستعادة',
  'onboarding.recoveryKey.confirm': 'حفظت مفتاح الاستعادة',
  'onboarding.recoveryKey.copy': 'نسخ مفتاح الاستعادة',
  'onboarding.recoveryKey.download': 'تنزيله كملف',
  'onboarding.recoveryKey.finishing': 'جارٍ الإنهاء…',
  'onboarding.recoveryKey.title': 'احفظ مفتاح الاستعادة',
  'onboarding.recoveryKey.warning': '<b>احفظه منفصلًا عن كلمة مرورك.</b> لا يمكن إعادة إنشائه.',

  // ---- perms
  'perms.add_reactions.hint': 'إضافة تفاعل جديد إلى رسالة. والانضمام إلى تفاعل قائم لا يحتاج إلى شيء.',
  'perms.add_reactions.label': 'إضافة التفاعلات',
  'perms.administrator.hint': 'كل صلاحية على هذا الخادم، وكل تجاوزات القنوات مُتجاهَلة. لا تمنح هذا إلا لمن تثق به على النقابة نفسها.',
  'perms.administrator.label': 'المسؤول',
  'perms.attach_files.hint': 'رفع الصور والملفات إلى مخزن الوسائط الخاص بهذه النقابة.',
  'perms.attach_files.label': 'إرفاق الملفات',
  'perms.ban_members.hint': 'منع حساب من الانضمام مجددًا، بمعرّف المستخدم، على كل خادم رئيسي.',
  'perms.ban_members.label': 'حظر الأعضاء',
  'perms.connect.hint': 'الانضمام إلى القنوات الصوتية التي يرونها.',
  'perms.connect.label': 'الاتصال',
  'perms.create_invite.hint': 'إنشاء رموز دعوة تتيح لحسابات من أي خادم رئيسي الانضمام.',
  'perms.create_invite.label': 'إنشاء دعوة',
  'perms.deafen_members.hint': 'منع الآخرين من سماع قناة صوتية.',
  'perms.deafen_members.label': 'إصمات الأعضاء',
  'perms.embed_links.hint': 'أن تتحوّل الروابط التي ينشرونها إلى معاينات.',
  'perms.embed_links.label': 'تضمين الروابط',
  'perms.kick_members.hint': 'إزالة الأعضاء الأدنى منهم رتبة. والطرد ليس حظرًا: يمكنهم العودة بدعوة جديدة.',
  'perms.kick_members.label': 'طرد الأعضاء',
  'perms.manage_channels.hint': 'إنشاء قنوات هذه النقابة وإعادة تسميتها وترتيبها وحذفها.',
  'perms.manage_channels.label': 'إدارة القنوات',
  'perms.manage_expressions.hint': 'رفع الرموز التعبيرية والملصقات التي تقدّمها هذه النقابة وإزالتها.',
  'perms.manage_expressions.label': 'إدارة الرموز التعبيرية والملصقات',
  'perms.manage_guild.hint': 'تغيير اسم النقابة وأيقونتها وبوّابة الانضمام ومنطقتها الصوتية.',
  'perms.manage_guild.label': 'إدارة الخادم',
  'perms.manage_messages.hint': 'حذف رسائل أي شخص وتثبيتها.',
  'perms.manage_messages.label': 'إدارة الرسائل',
  'perms.manage_roles.hint': 'تعديل الأدوار الواقعة دون أدوارهم، ومنح تلك الأدوار لأي أحد. ولا يمكنهم أبدًا منح صلاحية لا يملكونها بالفعل.',
  'perms.manage_roles.label': 'إدارة الأدوار',
  'perms.mention_everyone.hint': 'إشعار النقابة بأكملها، أو أي دور، سواء كان ذلك الدور قابلًا للإشارة أم لا.',
  'perms.mention_everyone.label': 'الإشارة إلى @everyone والأدوار',
  'perms.moderate_members.hint': 'إمهال عضو إلى حين. ومن فُرضت عليه المهلة لا يبقى له إلا القراءة.',
  'perms.moderate_members.label': 'إمهال الأعضاء',
  'perms.move_members.hint': 'سحب الأشخاص بين القنوات الصوتية أو خارجها.',
  'perms.move_members.label': 'نقل الأعضاء',
  'perms.mute_members.hint': 'كتم الآخرين في القنوات الصوتية.',
  'perms.mute_members.label': 'كتم الأعضاء',
  'perms.priority_speaker.hint': 'أن يُسمع صوتهم فوق الجميع أثناء تحدّثهم.',
  'perms.priority_speaker.label': 'متحدّث ذو أولوية',
  'perms.read_message_history.hint': 'رؤية ما قيل قبل وصولهم. وبدونها تبدأ القناة فارغة.',
  'perms.read_message_history.label': 'قراءة سجلّ الرسائل',
  'perms.send_messages.hint': 'النشر في القنوات النصية التي يرونها.',
  'perms.send_messages.label': 'إرسال الرسائل',
  'perms.speak.hint': 'أن يُسمع صوتهم في المكالمة الصوتية. وبدونها يمكنهم الاستماع.',
  'perms.speak.label': 'التحدّث',
  'perms.stream.hint': 'مشاركة الشاشة في المكالمة الصوتية.',
  'perms.stream.label': 'البثّ المباشر',
  'perms.use_external_emoji.hint': 'استخدام رموز تعبيرية تقدّمها نقابات أخرى على خوادم رئيسية أخرى.',
  'perms.use_external_emoji.label': 'استخدام الرموز التعبيرية الخارجية',
  'perms.video.hint': 'تشغيل الكاميرا في المكالمة الصوتية.',
  'perms.video.label': 'الفيديو',
  'perms.view_audit_log.hint': 'قراءة سجلّ من غيّر ماذا على هذا الخادم.',
  'perms.view_audit_log.label': 'عرض سجلّ التدقيق',
  'perms.view_channel.hint': 'رؤية القنوات التي لم يصدّهم عنها تجاوز.',
  'perms.view_channel.label': 'عرض القنوات',

  // ---- security
  'security.codes.clipboardName': 'رموز الاستعادة',
  'security.codes.copy': 'نسخها',
  'security.codes.download': 'تنزيلها كملف',
  'security.codes.fileHeading': 'رموز استعادة المصادقة الثنائية لـTelium',
  'security.codes.listLabel': '{count, plural, zero {# رمز استعادة} one {# رمز استعادة} two {# رمزا استعادة} few {# رموز استعادة} many {# رمز استعادة} other {# رمز استعادة}}',
  'security.codes.title': 'رموز الاستعادة',
  'security.codes.warning': '<b>دوّنها قبل أن تمضي.</b> كل واحد منها يعمل مرة واحدة، ولا تُعرض مرة أخرى.',
  'security.devices.addedAt': '{at, date, medium}',
  'security.devices.allVerified': '{count, plural, zero {لا أجهزة موثّقة.} one {جهازك موثّق.} two {كلا جهازيك موثّقان.} few {جميع أجهزتك الـ# موثّقة.} many {جميع أجهزتك الـ# موثّقة.} other {كل # من أجهزتك موثّقة.}}',
  'security.devices.cannotSign': 'لا يستطيع هذا الجهاز التوقيع عن حسابك بعد. وثّقه من جهاز تستخدمه بالفعل، أو افتح رسائلك تحت {pane}.',
  'security.devices.checking': 'جارٍ فحص أجهزتك.',
  'security.devices.colAdded': 'أُضيف',
  'security.devices.colDevice': 'الجهاز',
  'security.devices.colLastSeen': 'آخر ظهور',
  'security.devices.empty': 'لا أجهزة مسجّلة.',
  'security.devices.lastSeenAt': '{at, relative}',
  'security.devices.noneVerified': '{count, plural, zero {لا أجهزة موثّقة بعد.} one {جهازك غير موثّق بعد.} two {كلا جهازيك غير موثَّقَين بعد.} few {لا شيء من أجهزتك الـ# موثّق بعد.} many {لا شيء من أجهزتك الـ# موثّق بعد.} other {لا شيء من أجهزتك الـ# موثّق بعد.}}',
  'security.devices.recogniseNote': 'سجّل خروج كل ما لا تعرفه.',
  'security.devices.revocationBody': 'تسجيل خروج جهاز يبطل اعتماده على خادمك الرئيسي. وكل ما سُلّم إليه بالفعل يبقى مسلَّمًا.',
  'security.devices.revocationTitle': 'الإبطال',
  'security.devices.revokeHint': 'يستغرق تسجيل خروج جهاز بضع دقائق حتى يسري مفعوله، لا ثواني.',
  'security.devices.signedOut': 'مسجَّل الخروج',
  'security.devices.signOut': 'تسجيل الخروج',
  'security.devices.signOutDevice': 'تسجيل خروج {device}',
  'security.devices.signOutFailed': 'تعذّر تسجيل خروج ذلك الجهاز. {reason}',
  'security.devices.someUnverified': '{count, plural, zero {لا جهاز من أجهزتك غير موثّق بعد.} one {# من أجهزتك الـ{total, plural, zero {# جهاز} one {# جهاز} two {# جهازان} few {# أجهزة} many {# جهازًا} other {# جهاز}} ليست موثّقة بعد.} two {# من أجهزتك الـ{total, plural, zero {# جهاز} one {# جهاز} two {# جهازان} few {# أجهزة} many {# جهازًا} other {# جهاز}} ليست موثّقتين بعد.} few {# من أجهزتك الـ{total, plural, zero {# جهاز} one {# جهاز} two {# جهازان} few {# أجهزة} many {# جهازًا} other {# جهاز}} ليست موثّقة بعد.} many {# من أجهزتك الـ{total, plural, zero {# جهاز} one {# جهاز} two {# جهازان} few {# أجهزة} many {# جهازًا} other {# جهاز}} ليست موثّقة بعد.} other {# من أجهزتك الـ{total, plural, zero {# جهاز} one {# جهاز} two {# جهازان} few {# أجهزة} many {# جهازًا} other {# جهاز}} ليست موثّقة بعد.}}',
  'security.devices.tableLabel': 'الأجهزة المسجّلة الدخول إلى حسابك',
  'security.devices.thisDevice': 'هذا الجهاز',
  'security.devices.unverifiedBadge': 'غير موثّق',
  'security.devices.unverifiedNote': 'يستطيع الجهاز غير الموثّق مع ذلك قراءة ما ترسله. وتوثيقه هو طريقتك للتأكّد من أنه لك لا لشخص ينتحل هويتك.',
  'security.devices.verifiedBadge': 'موثّق',
  'security.devices.verify': 'توثيق',
  'security.devices.verifyDevice': 'توثيق {device}',
  'security.devices.whatVerifiedBody': 'الجهاز الموثّق هو الذي وقّع عليه مفتاح حسابك نفسه. ويحفظ خادمك هذه القائمة، لكنه لا يستطيع تزوير تلك التواقيع، فالشعار ادّعاءه حسابك لا ادّعاءه المشغّل.',
  'security.devices.whatVerifiedTitle': 'ما معنى «موثّق» هنا',
  'security.mfa.appHint': 'استخدم أي تطبيق مصادقة TOTP قياسي من ستة أرقام.',
  'security.mfa.codeFieldLabel': 'رمز من 6 أرقام',
  'security.mfa.codeLabel': 'رمز المصادقة أو رمز استعادة',
  'security.mfa.disable': 'إيقاف المصادقة الثنائية',
  'security.mfa.disabledToast': 'المصادقة الثنائية معطّلة.',
  'security.mfa.disableFailed': 'تعذّر إيقاف المصادقة الثنائية. {reason}',
  'security.mfa.enabled': '{remaining, plural, =0 {المصادقة الثنائية مفعّلة، ولم تبقَ لديك أي رموز استعادة. إن فقدت تطبيق المصادقة فلن تستطيع تسجيل الدخول — عطّل المصادقة الثنائية وأعد إعدادها للحصول على مجموعة جديدة.} zero {المصادقة الثنائية مفعّلة. لا رموز استعادة.} one {المصادقة الثنائية مفعّلة. بقي # رمز استعادة.} two {المصادقة الثنائية مفعّلة. بقي رمزان للاستعادة.} few {المصادقة الثنائية مفعّلة. بقيت # رموز استعادة.} many {المصادقة الثنائية مفعّلة. بقي # رمزًا للاستعادة.} other {المصادقة الثنائية مفعّلة. بقي # رمز استعادة.}}',
  'security.mfa.enabledNoCount': 'المصادقة الثنائية مفعّلة.',
  'security.mfa.enabledToast': 'المصادقة الثنائية مفعّلة.',
  'security.mfa.enableFailed': 'تعذّر تفعيل المصادقة الثنائية. {reason}',
  'security.mfa.manualHint': 'لا تستخدم هذا إلا إذا تعذّر على تطبيق مصادقتك مسح رمز QR.',
  'security.mfa.manualLabel': 'مفتاح الإعداد اليدوي',
  'security.mfa.qrLabel': 'رمز QR لإعداد تطبيق المصادقة',
  'security.mfa.reauthHint': 'أعد إدخال كلمة مرورك. يُتحقّق منها على هذا الجهاز ولا تُرسل.',
  'security.mfa.scanWarning': 'امسح رمز QR هذا، ثم أدخل الرمز الذي يعرضه. ولا تُفعَّل المصادقة الثنائية حتى ينجح ذلك.',
  'security.mfa.setUp': 'إعداد تطبيق المصادقة',
  'security.mfa.setupFailed': 'تعذّر بدء إعداد المصادقة الثنائية. {reason}',
  'security.mfa.title': 'المصادقة الثنائية',
  'security.mfa.verifyEnable': 'التحقّق والتفعيل',
  'security.mfa.whyPasswordBody': 'على خادم رئيسي يدعم OPAQUE لا تغادر كلمة مرورك هذا الجهاز أبدًا. وكتابتها هنا تنتج إثباتًا لاستخدام واحد بأنك صاحب الحساب، وهو ما يصرّح بالتغيير.',
  'security.mfa.whyPasswordTitle': 'لماذا تُطلب كلمة المرور مرة أخرى',
  'security.trustedLinks.description': 'تُفتح الروابط المؤدية إلى هذه النطاقات دون سؤال. ويُؤكَّد كل ما عدا ذلك خارج خوادمك أولًا.',
  'security.trustedLinks.empty': 'لم تثق بأي نطاقات بعد.',
  'security.trustedLinks.forget': 'اسأل مرة أخرى عن {domain}',
  'security.trustedLinks.title': 'الروابط الموثوقة',
  'security.verify.comparePeer': 'قارن هذه مع {name} شخصيًّا أو في مكالمة.',
  'security.verify.compareSelf': '{count, plural, zero {يجب أن يعرض كلا الجهازين هذه الصورة.} one {يجب أن يعرض كلا الجهازين هذه الصورة.} two {يجب أن يعرض كلا الجهازين هاتين، بهذا الترتيب.} few {يجب أن يعرض كلا الجهازين هذه الـ#، بهذا الترتيب.} many {يجب أن يعرض كلا الجهازين هذه الـ#، بهذا الترتيب.} other {يجب أن يعرض كلا الجهازين هذه الـ#، بهذا الترتيب.}}',
  'security.verify.confirmingPeer': 'في انتظار تأكيد {name}…',
  'security.verify.confirmingSelf': 'في انتظار تأكيد جهازك الآخر…',
  'security.verify.donePeer': '{name} موثّق على كل أجهزتك، بما في ذلك أي جهاز يضيفه لاحقًا.',
  'security.verify.doneSelf': 'ذلك الجهاز موثّق. وكل من وثّقك يراه كذلك.',
  'security.verify.finishFailed': 'تعذّر إتمام التوثيق. {reason}',
  'security.verify.match': 'يتطابقان',
  'security.verify.mismatchHint': 'إن اختلفت، فهناك شيء يجلس في المنتصف.',
  'security.verify.noMatch': 'لا يتطابقان',
  'security.verify.pendingHintPeer': 'أيًّا كان الجهاز الذي يستجيب، فهذا يغطّي حسابه كله.',
  'security.verify.pendingHintSelf': 'افتح Telium هناك؛ ويجب أن يكون كلا الجهازين متصلًا في الوقت نفسه.',
  'security.verify.startFailed': 'تعذّر بدء التوثيق. {reason}',
  'security.verify.starting': 'جارٍ البدء…',
  'security.verify.stopped': 'توقّف التوثيق: {reason}.',
  'security.verify.stoppedByYou': 'توقّف التوثيق لأن الصور لم تتطابق. وذلك الجهاز ما زال غير موثّق.',
  'security.verify.titlePeer': 'توثيق {name}',
  'security.verify.titleSelf': 'وثّق جهازك الآخر',
  'security.verify.waitingButton': 'في الانتظار',
  'security.verify.waitingPeer': 'في انتظار أن يفتح {name} Telium…',
  'security.verify.waitingSelf': 'في انتظار جهازك الآخر…',

  // ---- settings
  'settings.messages.dateFormat.dmy': 'DD/MM/YY',
  'settings.messages.dateFormat.hint': 'الرسائل من يوم غير اليوم تعرض تاريخها بجانب الوقت. وهذا يحدّد أيهما يأتي أولًا: الشهر أم اليوم.',
  'settings.messages.dateFormat.label': 'صيغة التاريخ',
  'settings.messages.dateFormat.mdy': 'MM/DD/YY',
  'settings.nav.recovery': 'مفتاح التعمية',
  'settings.scheme.accentHue.hint': 'الروابط وحلقة التركيز والمؤشر وحالة غير المقروء. ولا يوجد سوى واحد.',
  'settings.scheme.accentHue.label': 'درجة اللون المميّز',
  'settings.scheme.accentStrength.label': 'قوة اللون المميّز',
  'settings.scheme.depth.hintDark': 'النهاية القصوى أسود خالص، تُطفئه شاشة OLED تمامًا.',
  'settings.scheme.depth.hintLight': 'مقدار انخفاض الصفحة عن الأبيض.',
  'settings.scheme.depth.label': 'العمق',
  'settings.scheme.description': 'كل موضع على كل شريط تمرير يبقى مقروءًا؛ وهذا هو الغرض من طرفيه.',
  'settings.scheme.greyHue.hint': 'إلى أي جهة تميل الصبغة. ولا تفعل شيئًا ما دامت الصبغة معطّلة.',
  'settings.scheme.greyHue.label': 'درجة الرمادي',
  'settings.scheme.mode.dark': 'داكن',
  'settings.scheme.mode.hint': 'أي اللوحتين تضبطه بقية هذه الخيارات.',
  'settings.scheme.mode.label': 'الصفحة',
  'settings.scheme.mode.light': 'فاتح',
  'settings.scheme.reading.amount': '{value, number, fixed3}',
  'settings.scheme.reading.degrees': '{value, number, integer}°',
  'settings.scheme.reading.percent': '{value, number, fixed1}%',
  'settings.scheme.separation.hint': 'مقدار ارتفاع البطاقة عن الصفحة، وغوص الشريط الجانبي خلفها.',
  'settings.scheme.separation.label': 'التباعد',
  'settings.scheme.tint.hint': 'مقدار اللون في الرمادي. ولا شيء منه لون يمكنك تسميته.',
  'settings.scheme.tint.label': 'الصبغة',
  'settings.scheme.tint.none': 'بلا',
  'settings.scheme.title': 'نظامك اللوني',

  // ---- shell
  'shell.a11y.closeMembers': 'إغلاق الأعضاء',
  'shell.a11y.closeMenu': 'إغلاق القائمة',
  'shell.a11y.openChannels': 'فتح القنوات',
  'shell.banner.cached': 'عرض حالتك الأخيرة من {when}. جارٍ إعادة الاتصال…',
  'shell.banner.reload': 'إعادة تحميل Telium',
  'shell.banner.retryHome': 'جرّب {domain} مرة أخرى',
  'shell.banner.signIn': 'سجّل الدخول من جديد',
  'shell.banner.wake': 'جرّب مرة أخرى الآن',
  'shell.empty.body': 'اختر قناة للبدء.',
  'shell.empty.title': 'لا قناة مفتوحة',
  'shell.fallback.lagHours': '{count, plural, zero {# ساعة تأخّر} one {# ساعة تأخّر} two {# ساعتان تأخّر} few {# ساعات تأخّر} many {# ساعة تأخّر} other {# ساعة تأخّر}}',
  'shell.fallback.lagMinutes': '{count, plural, zero {# دقيقة تأخّر} one {# دقيقة تأخّر} two {# دقيقتان تأخّر} few {# دقائق تأخّر} many {# دقيقة تأخّر} other {# دقيقة تأخّر}}',
  'shell.fallback.lagSeconds': '{count, plural, zero {# ثانية تأخّر} one {# ثانية تأخّر} two {# ثانيتان تأخّر} few {# ثوانٍ تأخّر} many {# ثانية تأخّر} other {# ثانية تأخّر}}',
  'shell.fallback.lagUnknown': 'مدة غير معروفة',
  'shell.fallback.promoted': '{home} يخدمه الآن {standby}. وكل شيء يعمل طبيعيًّا.',
  'shell.fallback.readOnly': '{home} لا يستجيب. عرض نسخة للقراءة فقط من {standby}، {lag}.',
  'shell.members.search': 'بحث في الأعضاء',
  'shell.socket.guildDown': '{name} لا يستجيب. وبقية Telium تعمل طبيعيًّا. ويواصل Telium المحاولة؛ وإن طال هذا، فمشغّل ذلك الخادم هو من تسأله.',
  'shell.socket.homeDown': '{name} هو خادم حسابك ولا يستجيب. ولن تذهب الرسائل التي ترسلها إلى أي مكان حتى يعود. ويواصل Telium المحاولة؛ وإن طال هذا، فمن يشغّل {name} هو من تسأله.',
  'shell.socket.incompatible': '{name} يتحدّث إصدارًا من Telium لا يعرفه هذا العميل. حدّث Telium وحاول مرة أخرى.',
  'shell.socket.malformed': '{name} لم يفهم ما أرسله إليه هذا العميل. أعد تحميل Telium؛ وإن استمر الأمر، فهذا العميل وذلك الخادم غير متوافقين.',
  'shell.socket.offline': 'هذا الجهاز غير متصل. سيكمل Telium من حيث توقّف عند عودة الاتصال.',
  'shell.socket.reconnecting': '{role, select, home {جارٍ إعادة الاتصال بـ{name}.} other {جارٍ إعادة الاتصال بـ{name}. والخوادم الأخرى غير متأثّرة.}}',
  'shell.socket.restarting': '{name} يعيد التشغيل. وسيعود من تلقاء نفسه.',
  'shell.socket.sessionRefused': '{role, select, home {{name} لم يعد يتعرّف على هذه الجلسة. سجّل الدخول من جديد للمتابعة.} other {{name} لم يعد يتعرّف على هذه الجلسة. أعد الاتصال به؛ وبقية Telium غير متأثّرة.}}',
  'shell.socket.unnamedServer': 'ذلك الخادم',
  'shell.tabs.forum': 'منشورات المنتدى',
  'shell.tabs.pinned': 'الرسائل المثبّتة',
  'shell.title.guild': 'النقابة',

  // ---- voice
  'voice.bar.pingAvg': 'المتوسط',
  'voice.bar.pingHistory': 'سجلّ زمن الاستجابة',
  'voice.bar.pingLast': 'آخر زمن استجابة',
  'voice.log.cancel': 'إلغاء',
  'voice.log.ended': 'انتهت المكالمة',
  'voice.log.endedDuration': 'انتهت المكالمة · {duration}',
  'voice.log.incoming': 'مكالمة واردة',
  'voice.log.missed': 'مكالمة فائتة',
  'voice.log.outgoing': 'مكالمة صادرة',
  'voice.log.ringing': 'يرنّ…',
  'voice.log.ringingHint': 'في انتظار أن يردّوا.',
  'voice.status.clear': 'مسح',
  'voice.status.clearFailed': 'تعذّر مسح حالة الصوت',
  'voice.status.edit': 'تعديل حالة الصوت',
  'voice.status.hint': '{count} من {max} حرفًا',
  'voice.status.label': 'حالة الصوت',
  'voice.status.placeholder': 'ماذا تفعل هذه الغرفة الآن؟',
  'voice.status.save': 'حفظ الحالة',
  'voice.status.saveFailed': 'تعذّر تعيين حالة الصوت',
  'voice.status.set': 'تعيين حالة الصوت',
  'voice.status.tooLong': 'أبقِه تحت {max} حرفًا.',
  'voice.tile.screenAudioVolume': 'مستوى صوت الشاشة',
  'voice.tile.screenAudioVolumeFor': '{name}: مستوى صوت الشاشة',


  'settings.media.sectionTitle': 'إلى أين تذهب رفعاتك',
  'settings.media.followsAccount': 'يتبع هذا الخيار حسابك إلى كل جهاز.',
  'settings.media.tier1': 'هذا الخادم',
  'settings.media.tier1Desc': 'الافتراضي. لا شيء لإعداده.',
  'settings.media.tier2': 'خادم Telium آخر',
  'settings.media.tier2Desc': 'تذهب الملفات إلى خادم Telium آخر تختاره.',
  'settings.media.tier3': 'مضيف آخر',
  'settings.media.tier3Desc': 'تذهب الملفات إلى مضيف خارجي مثل Gofile. تلك الملفات روابط عمومية.',
  'settings.media.usage': 'مستخدم {used} من {quota} على {home}.',
  'settings.media.usageWarn': 'مستخدم {used} من {quota} على {home}. احذف الملفات التي لم تعد بحاجة إليها من رسائلك، أو انقل رفعاتك إلى مضيف آخر.',
  'settings.media.savedToast': 'حُفظ مضيف الرفع.',
  'settings.media.saveFailed': 'تعذّر حفظ مضيف الرفع',
  'settings.media.hostLabel': 'مضيف الوسائط',
  'settings.media.hostsRecommended': 'مضيفون موصى بهم. أي مصدر وسائط من Telium يعمل.',
  'settings.media.hostsNone': 'هذا الخادم لا يوصي بمضيفين. اذكر واحدًا بنفسك.',
  'settings.media.anotherHost': 'مضيف آخر...',
  'settings.media.originLabel': 'المصدر',
  'settings.media.originHint': 'نطاق، لا رابط.',
  'settings.media.externalEnabled': 'المضيفون الخارجيون المفعّلون',
  'settings.media.externalNone': 'هذا الخادم لم يفعّل أي مضيف رفع خارجي.',
  'settings.media.upTo': 'حتى {size} للملف.',
  'settings.media.abuseContact': 'جهة الإبلاغ عن سوء الاستخدام: {contact}.',
  'settings.media.vouchedBy': 'ضمان من {names}.',
  'settings.media.via': '{name} - عبر {names}',
};
