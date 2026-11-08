/**
 * Stop words: the common words the word analysis tools (Word Frequencies,
 * Word Combinations) leave out by default. A new analysis starts with the
 * interface language's list, and the Leave out box can switch to another
 * language's, since the texts needn't be in the interface language.
 *
 * Every interface language must have a list (the `satisfies` below
 * requires it), and there can be lists for languages the interface isn't
 * in yet. Words are lower case; accented words are also listed without
 * their accents where people often type them that way (Portuguese "nao",
 * Arabic "انه" for "أنه").
 */
import type { LanguageId } from '../../i18n'

const PORTUGUESE = `
    a à agora ainda ali algo alguém algum alguma algumas alguns ao aos
    aquela aquelas aquele aqueles aquilo as às assim até bem cada coisa
    coisas com como da das de dela delas dele deles depois diz disse do
    dos e é ela elas ele eles em entao então entre era eram essa essas
    esse esses esta está estado estamos estão estar estas estava estavam
    este estes estou eu faz fazem fazer fiz foi foram fui há havia isso
    isto já lá lhe lhes mais mas me mesma mesmo meu meus minha minhas
    muita muitas muito muitos na nada nao não nas ne né nem nenhum
    nenhuma no nos nós nossa nossas nosso nossos num numa o onde os ou
    outra outras outro outros para pela pelas pelo pelos pode podem poder
    porque posso pouca pouco poucos pra pro quais qual quando quanto que
    quem são se seja sem sempre ser seu seus sido sim só sobre somos sou
    sua suas ta tá também tambem tanto tão te tem têm temos tenho ter teve
    ti tinha tinham toda todas todo todos tu tua tudo um uma umas uns vai
    vão vou vez vezes`

const LISTS = {
  en: `
    the be to of and a in that have i it for not on with he as you do at
    this but his by from they we say her she or an will my one all would
    there their what so up out if about who get which go me when make can
    like time no just him know take people into year your good some could
    them see other than then now look only come its over think also back
    after use two how our work first well way even new want because any
    these give day most us is am are was were been being has had did does
    doing done should may might must shall very much more such those own
    same able each every both few many where while here through during
    before between under again further once why too still`,
  es: `
    a al algo alguien algún alguna algunas alguno algunos allí ahí ahora
    ante antes aquel aquella aquellas aquello aquellos aquí así aunque bajo
    bien cada casi como cómo con contra cosa cosas cual cuál cuales cuáles
    cuando cuándo cuanto cuánto cuantos de del desde después dice dijo
    donde dónde durante e el él ella ellas ellos en entonces entre era eran
    eres es esa esas ese eso esos esta está estaba estaban estado están
    estar estas estás este esto estos estoy fue fueron ha había habían han
    has hace hacen hacer hacia hago hasta hay he hemos lo la las le les
    los luego más mas me mi mí mientras mis misma mismas mismo mismos mucha
    muchas mucho muchos muy nada ni ningún ninguna ninguno no nos nosotras
    nosotros nuestra nuestras nuestro nuestros nunca o os otra otras otro
    otros para pero poca pocas poco pocos poder porque por puede pueden
    puedo pues que qué quien quién quienes se sea según ser si sí siempre
    sido sin sobre sois solo sólo somos son soy su sus suya suyo también
    tan tanto te tener tengo tenía tiene tienen ti toda todas todo todos
    tras tu tú tus u un una unas uno unos usted ustedes va van vez veces
    vosotras vosotros voy y ya yo`,
  nl: `
    aan al alle alleen alles als altijd ander andere ben bent bij daar
    daarna daarom dan dat de deed deze die dit doe doen doet door dus een
    eens elk elke en er erg even geen geweest ging had hadden heb hebben
    hebt heeft heel hem hen het hier hij hoe hun ieder iedere iemand ik in
    is ja je jij jou jouw jullie kan komen komt kon konden kun kunnen kunt
    kwam m'n maar mag me meer meest men met mij mijn moest moet moeten
    mogen na naar nee niet niemand niets nog nooit nu of om omdat ons onze
    ook op over reeds sinds te tegen toch toen tot u uit uw van veel voor
    want waren waar waarom wanneer was wat we wel welk welke werd werden
    wie wij wil wilde willen wilt word worden wordt z'n ze zei zeer zelf
    zelfs zich zij zijn zo zo'n zonder zou zouden zal zullen zult`,
  'pt-BR': PORTUGUESE + ' vc você vocês voce',
  'pt-PT': PORTUGUESE + ` teu teus tuas contigo vós vosso vossa vossos
    vossas estás tens connosco consigo cá pois portanto`,
  ar: `
    في من على إلى الى عن مع هذا هذه ذلك تلك هؤلاء أولئك هذان هاتان الذي
    التي الذين اللذان اللتان اللواتي اللاتي ما ماذا لماذا كيف أين اين متى
    هل لا لم لن ليس ليست ليسوا كان كانت كانوا كنت كنا يكون تكون يكونون
    أن إن ان أنه إنه انه أنها إنها انها أنهم انهم قد لقد كل بعض غير بين
    عند عندما حتى ثم أو او أم بل لكن لكنه ولكن إذا اذا إذ لو لولا كما
    مثل أي اي أيضا ايضا هو هي هم هن هما أنا انا نحن أنت انت أنتم انتم
    له لها لهم لنا لي لك لكم به بها بهم فيه فيها فيهم منه منها منهم
    عليه عليها عليهم إليه اليه إليها اليها عنه عنها هناك هنا الآن الان
    جدا فقط كذلك ذات ذو يا و ف ب ل ك وفي ومن وعلى وإلى والى وهو وهي وهم
    وكان وقد ولا وما وأن وان فإن فان وهذا وهذه حيث حين بعد قبل خلال تحت
    فوق أمام امام دون نحو منذ لدى لدي يمكن أصبح اصبح صار سوف أكثر اكثر
    أقل اقل كثير كثيرا قليل شيء شي أحد احد كلها كله جميع معظم أيضاً
    عليها لأن لان لأنه لانه أنني انني إنني انني ولم ولن`,
  fr: `
    à a ai aie aient ainsi alors après as au aucun aussi autre autres aux
    avaient avais avait avant avec avez avions avoir avons ayant beaucoup
    bien c ça car ce ceci cela celle celles celui cependant certains ces
    cet cette ceux chez chose choses comme comment d dans de déjà depuis
    des donc dont du elle elles en encore entre es est et étaient étais
    était étant été êtes étions être eu eux faire fait faut fois font ici
    il ils j je jusqu l la là le les leur leurs lui m ma mais me même
    mes moi moins mon n ne ni non nos notre nous on ont or ou où oui par
    parce pas peu peut plus pour pourquoi qu quand que quel quelle
    quelles quels qui quoi rien s sa sans se sera seront ses si sien
    soit sommes son sont sous suis sur t ta te tes toi ton toujours tous
    tout toute toutes très tu un une va vers vont vos votre vous y
    c'est c’est j'ai j’ai qu'il qu’il qu'elle qu’elle n'est n’est d'un
    d’un d'une d’une s'il s’il c'était c’était n'a n’a l'on l’on`,
  ru: `
    а без более бы был была были было быть в вам вас весь во вот все
    всегда всего всех всю вся всё вы где да даже два для до его ее её
    если есть еще ещё ж же за здесь и из или им их к как какая какой
    когда конечно который которые которая которое которых кто куда ли
    лучше между меня мне много может можно мой моя мы на над надо наш
    наша наши не него нее неё нельзя нет ни них ничего но ну о об один
    он она они опять от очень перед по под после потом потому почти при
    про раз разве с сам свой свою своей себе себя сейчас со совсем так
    также такой там тебя тем теперь то тогда того тоже только том тот
    три тут ты у уже хоть хорошо чего чем через что чтоб чтобы чуть эта
    эти это этого этой этом этот эту я`,
  'zh-Hans': `
    的 了 是 在 我 有 和 就 不 人 都 一 一个 上 也 很 到 说 要 去 你 会
    着 没有 看 好 自己 这 那 他 她 它 我们 你们 他们 她们 什么 怎么
    因为 所以 但是 但 如果 还 吗 吧 呢 啊 被 把 让 给 对 从 与 及 而 或
    等 之 其 这个 那个 这些 那些 可以 能 已经 没 又 再 就是 还是 只 才
    比 更 最 非常 地 得 过 来 为 以 于 中 还有 而且 然后 或者 并 并且
    这样 那样 怎样 哪 哪里 这里 那里 时候 现在 已 每 各 些 个 么 嗯
    哦 呀 啦 所 将 向 由 跟 同 这种 那种 一些 一样 觉得 认为 比较`,
  it: `
    a ad agli ai al alla alle allo allora anche ancora avere aveva avevo
    abbiamo avete c che chi ci cioè come con contro cosa così cui da dai
    dal dalla dalle dagli de dei del della delle dello deve di dopo dove
    e è ed era erano essere fa fare fatto gli già ha hai hanno ho i il in
    io l la le lei li lo loro lui ma mai mentre mi mia mie miei mio molto
    ne negli nei nel nella nelle nello noi non nostra nostre nostri nostro
    o per perché però più poco poi possono prima può qual quale quali
    quando quanto quella quelle quelli quello questa queste questi questo
    qui quindi sarà se sei sempre si sia siamo siete solo sono stata stato
    su sua sue sui sul sulla sulle suo suoi ti tra tu tua tue tuo tuoi
    tutta tutte tutti tutto un una uno vi voi c'è c’è c'era c’era l'ho
    l’ho dell dell'`,
  hi: `
    के का की है हैं यह और से को पर इस होता कि जो कर में मे गया करने किया
    लिये लिए अपने अपनी अपना ने नहीं तो ही या एवं दिया हो इसका इसकी इसके
    था थी थे द्वारा हुआ हुई हुए तक साथ करना वाले वाली बाद आप कुछ सकते
    सकता किसी ये सबसे इसमें इसी इसे दो होने वह वे करते करता करें होती
    होते बहुत कहा कई यदि जा ना कहते जब कोई व न अभी जैसे सभी उनके उनकी
    उनका उन्हें तरह उस उसे उसका उसकी उसके आदि रहा रही रहे पे मैं मुझे
    मेरा मेरी मेरे हम हमारे हमारी हमें तुम तुम्हारे भी तब क्या क्यों
    कैसे कहाँ यहाँ वहाँ लेकिन मगर क्योंकि इसलिए फिर अब जी हाँ गए गई
    होगा होगी होंगे एक`,
  de: `
    aber alle allem allen aller alles als also am an andere anderen auch
    auf aus bei beim bin bis bist da dabei damit dann das dass dein deine
    dem den denn der des dessen die dies diese diesem diesen dieser dieses
    doch dort du durch ein eine einem einen einer eines er es etwas euch
    euer für gegen gewesen hab habe haben hat hatte hatten hier hin hinter
    ich ihm ihn ihnen ihr ihre ihrem ihren ihrer im in indem ins ist ja
    jede jedem jeden jeder jedes jetzt kann kannst kein keine keinem
    keinen keiner können könnte machen man manche mehr mein meine meinem
    meinen meiner mich mir mit muss musste nach nicht nichts noch nun nur
    ob oder ohne schon sehr sein seine seinem seinen seiner selbst sich
    sie sind so solche soll sollte sondern sonst über um und uns unser
    unsere unter viel vom von vor wann war waren warum was weil weiter
    welche welchem welchen welcher wenn wer werde werden wie wieder will
    wir wird wirst wo wollen wollte würde würden zu zum zur zwar zwischen`,
  fi: `
    ei eikä emme en enkä et ette että he heidän heille heillä heiltä
    heissä heistä heitä hän häneen hänelle hänellä häneltä hänen hänessä
    hänestä hänet häntä itse ja johon joiden joihin joille joilla joilta
    joina joissa joista joita joka joksi jolla jolle jolta jona jonka jos
    jossa josta jota jotka kanssa keiden keihin keille keillä keiltä keinä
    keissä keistä keitä keneen keneksi kenelle kenellä keneltä kenen
    kenenä kenessä kenestä kenet ketkä ketä koska kuin kuka kun me meidän
    meille meillä meiltä meissä meistä meitä mihin mikä miksi mille millä
    miltä minkä minua minulla minulle minulta minun minussa minusta minut
    minä missä mistä mitkä mitä mukaan mutta ne niiden niihin niille
    niillä niiltä niin niinä niissä niistä niitä noiden noihin noille
    noilla noilta noin noina noissa noista noita nuo nyt näiden näihin
    näille näillä näiltä näinä näissä näistä näitä nämä ole olemme olen
    olet olette oli olimme olin olisi olisimme olisin olisit olisitte
    olisivat olit olitte olivat olla olleet ollut on ovat se sekä sen
    siihen siinä siitä siksi sille sillä siltä sinua sinulla sinulle
    sinulta sinun sinussa sinusta sinut sinä sitä tai te teidän teille
    teillä teiltä teissä teistä teitä tuo tuohon tuoksi tuolla tuolle
    tuolta tuon tuona tuossa tuosta tuota tähän täksi tälle tällä tältä
    tämä tämän tänä tässä tästä tätä vaan vai vaikka yli myös vain jo
    hyvin aina sitten kuitenkin`
} satisfies Record<LanguageId, string> & Record<string, string>

/** The languages with stop words: the interface languages, and others. */
export type StopWordLanguage = keyof typeof LISTS
export const STOP_WORD_LANGUAGES = Object.keys(LISTS) as StopWordLanguage[]

/** A language's stop words, in the order the Leave out box shows them. */
export function stopWords(language: StopWordLanguage): string[] {
  return [...new Set(LISTS[language].trim().split(/\s+/))]
}

/** A language's stop words as the Leave out box holds them. */
export function stopWordsText(language: StopWordLanguage): string {
  return stopWords(language).join(', ')
}

/** The language whose stop words `text` (a Leave out box) holds exactly,
 *  in any order; null once the user has edited the list. */
export function stopWordsLanguageOf(text: string, languages: readonly StopWordLanguage[] = STOP_WORD_LANGUAGES): StopWordLanguage | null {
  const words = new Set(text.split(/[,\n]+/).map((w) => w.trim().toLowerCase()).filter(Boolean))
  return languages.find((id) => {
    const list = stopWords(id)
    return list.length === words.size && list.every((w) => words.has(w))
  }) ?? null
}
