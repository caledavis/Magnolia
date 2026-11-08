/**
 * Stop words: the common words the word analysis tools (Word Frequencies,
 * Word Combinations) leave out by default. A new analysis starts with the
 * interface language's list, and the Leave out box can switch to another
 * language's, since the texts needn't be in the interface language.
 *
 * Every interface language must have a list (the type requires it). Words
 * are lower case; accented words are also listed without their accents
 * where people often type them that way (Portuguese "nao", "voce").
 */
import type { LanguageId } from '../../i18n'

const LISTS: Record<LanguageId, string> = {
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
  'pt-BR': `
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
    vão vc você vocês voce vou vez vezes`
}

/** A language's stop words, in the order the Leave out box shows them. */
export function stopWords(language: LanguageId): string[] {
  return [...new Set(LISTS[language].trim().split(/\s+/))]
}

/** A language's stop words as the Leave out box holds them. */
export function stopWordsText(language: LanguageId): string {
  return stopWords(language).join(', ')
}

/** The language whose stop words `text` (a Leave out box) holds exactly,
 *  in any order; null once the user has edited the list. */
export function stopWordsLanguageOf(text: string, languages: readonly LanguageId[]): LanguageId | null {
  const words = new Set(text.split(/[,\n]+/).map((w) => w.trim().toLowerCase()).filter(Boolean))
  return languages.find((id) => {
    const list = stopWords(id)
    return list.length === words.size && list.every((w) => words.has(w))
  }) ?? null
}
