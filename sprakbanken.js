/* Uppslag mot Språkbankens öppna API:er -- portning av sprakbanken.py.
 *
 * Samma anrop, samma urval, samma filter. Python-filen är originalet och
 * bär de långa förklaringarna till VARFÖR det ser ut så här; den här filen
 * håller sig till VAD som görs, så att de två inte glider isär.
 *
 * Att det här över huvud taget går i en webbläsare beror på att både Karp
 * och Korp svarar med Access-Control-Allow-Origin för vilken avsändare som
 * helst. Telefonen pratar alltså direkt med Göteborgs universitet -- ingen
 * server av vår egen behövs, och ingen dator behöver vara igång.
 */

export const KARP_URL = "https://spraakbanken4.it.gu.se/karp/v7";
export const KORP_URL = "https://ws.spraakbanken.gu.se/ws/korp/v8";

export const KORPUSAR = ["ROMI", "ROMII", "GP2013", "DN1987", "ATTASIDOR"];

const TIMEOUT = 30000;

export class SprakbankenFel extends Error {}

// --- Lågnivå: prata med API:erna ------------------------------------------

/** fetch med tidsgräns. Utan den kan appen hänga för alltid på ett tyst nät. */
async function hamta(url, vad) {
  const avbrytare = new AbortController();
  const klocka = setTimeout(() => avbrytare.abort(), TIMEOUT);
  try {
    const svar = await fetch(url, { signal: avbrytare.signal });
    if (!svar.ok) {
      throw new SprakbankenFel(`${vad} svarade ${svar.status}`);
    }
    return await svar.json();
  } catch (fel) {
    if (fel instanceof SprakbankenFel) throw fel;
    const orsak = fel.name === "AbortError" ? "tog för lång tid" : fel.message;
    throw new SprakbankenFel(`${vad} misslyckades: ${orsak}`);
  } finally {
    clearTimeout(klocka);
  }
}

/** Karp-fråga på formen "operator|fält|värde". */
export function karpSok(resurs, falt, varde, antal = 25) {
  return karpFraga(resurs, `equals|${falt}|${varde}`, antal);
}

/** Färdigskriven Karp-fråga, för villkor som equals inte klarar. */
export function karpFraga(resurs, fraga, antal = 25) {
  const url = new URL(`${KARP_URL}/query/${resurs}`);
  url.searchParams.set("q", fraga);
  url.searchParams.set("size", String(antal));
  return hamta(url, `Karp-anrop mot '${resurs}'`);
}

function cqpStrang(text) {
  return text.replaceAll("\\", "\\\\").replaceAll('"', '\\"');
}

/** Konkordanssökning i Korp. Se _korp_sok i sprakbanken.py. */
export async function korpSok(cqp, antal) {
  const url = new URL(`${KORP_URL}/query`);
  url.searchParams.set("corpus", KORPUSAR.join(","));
  url.searchParams.set("cqp", cqp);
  url.searchParams.set("start", "0");
  // Korps "end" är inklusiv: end=9 ger 10 träffar. Vi tar med marginal
  // eftersom en hel del sorteras bort i plockaExempel().
  url.searchParams.set("end", String(Math.max(antal * 10, 40) - 1));
  // "1 sentence" ignoreras tyst av de här korpusarna -- vi ber om ett brett
  // fönster och klipper ut meningen själva.
  url.searchParams.set("defaultcontext", "30 words");
  url.searchParams.set("show", "lemma");

  const data = await hamta(url, "Korp-anrop");
  if (data && data.ERROR) {
    throw new SprakbankenFel(`Korp svarade med fel: ${JSON.stringify(data.ERROR)}`);
  }
  return data;
}

// --- Grundform -------------------------------------------------------------
// Böcker är skrivna i böjda former, SALDO är indexerat på grundform. Vi frågar
// saldom baklänges: vilket lemma har "plägar" i sin böjningstabell?

/** msd-koder som är sammansättningsleder, inte böjningar ("lad-" i ladugård). */
const SAMMANSATTNINGSFORMER = new Set(["c", "ci", "cm", "sms", "sm"]);

export const ORDKLASS_NAMN = {
  nn: "substantiv", vb: "verb", av: "adjektiv", ab: "adverb",
  pp: "preposition", pn: "pronomen", kn: "konjunktion", sn: "subjunktion",
  nl: "räkneord", in: "interjektion", pm: "egennamn",
};

/**
 * Grundformer som `ord` kan vara en böjning av, i rimlighetsordning.
 *
 * not(endswith|partOfSpeech|m) filtrerar bort flerordsuttrycken redan hos
 * Karp. Utan det försvann "lägga" ur svaret för "lade": de 91 uttrycken
 * "lägga an", "lägga av" ... trängde ut själva lemmat.
 */
export async function grundformer(ord, maxAntal = 3) {
  const svar = await karpFraga(
    "saldom",
    `and(equals|inflectionTable.writtenForm|${ord}` +
      `||not(endswith|partOfSpeech|m))`,
    50,
  );

  const kandidater = [];
  const sedda = new Set();
  for (const traff of svar.hits || []) {
    const post = traff.entry || {};
    const grund = post.baseform || "";
    const lemgram = post.lemgram || "";
    const ordklass = post.partOfSpeech || "";
    if (!grund || !lemgram) continue;

    // Flerordsuttryck duger inte som uppslagsord.
    if (ordklass.endsWith("m") || grund.includes(" ") || grund.includes("_")) {
      continue;
    }
    // Egennamn bara om ordet självt var versalt.
    if (ordklass === "pm" && ord.slice(0, 1) !== ord.slice(0, 1).toUpperCase()) {
      continue;
    }

    // Karp matchar på hela posten -- vi kontrollerar själva att formen
    // verkligen står i böjningstabellen, och att den inte är en
    // sammansättningsled.
    const bojningar = [];
    for (const rad of post.inflectionTable || []) {
      if (rad.writtenForm !== ord) continue;
      const msd = rad.msd || "";
      if (msd && !SAMMANSATTNINGSFORMER.has(msd.split(" ")[0])) {
        bojningar.push(msd);
      }
    }
    if (!bojningar.length || sedda.has(grund)) continue;

    sedda.add(grund);
    kandidater.push({ ord: grund, lemgram, ordklass, bojning: bojningar[0] });
  }

  // Exakt skiftläge först, kortast därefter.
  kandidater.sort((a, b) => {
    const aFel = a.ord[0] !== ord[0] ? 1 : 0;
    const bFel = b.ord[0] !== ord[0] ? 1 : 0;
    return aFel - bFel || a.ord.length - b.ord.length;
  });
  return { kandidater: kandidater.slice(0, maxAntal), radata: svar };
}

// --- Närliggande ord -------------------------------------------------------
// Swesaurus är tunt för ovanliga ord, och ovanliga ord är precis vad man
// stryker under. "pläga" har EN synonym, "minna" har noll. Vi fyller på från
// SALDO:s begreppsnät och Brings tesaurus -- men bara när det behövs, och
// under en egen rubrik, för det är inte synonymer.

export const MIN_SYNONYMER = 3;
const BRING_FONSTER = 2;

/** Sant om orden är varandras avledningar: "pläga"/"plägande". */
function arVariant(a, b) {
  const x = a.toLowerCase();
  const y = b.toLowerCase();
  return x.startsWith(y) || y.startsWith(x);
}

/**
 * Väljer den tesaurusgrupp som hör till RÄTT betydelse av ordet.
 *
 * "pläga" ligger både i Habit (bruka, praktisera) och i Food (förpläga,
 * regalera). Rätt grupp är den som innehåller en känd synonym eller SALDO:s
 * moder -- det vi redan vet pekar ut vilken betydelse vi är ute efter.
 */
async function bringGrupp(uppslag) {
  const svar = await karpSok("blingbring", "baseform", uppslag.ord, 20);

  const kanda = new Set(uppslag.synonymer.map((s) => s.toLowerCase()));
  for (const b of uppslag.betydelser) {
    if (b.moder) kanda.add(b.moder.split("..")[0].toLowerCase());
  }

  let forsta = null;
  for (const traff of svar.hits || []) {
    const bring = (traff.entry || {}).bring || {};
    if (!bring.class) continue;

    const medlemmar = await karpFraga(
      "blingbring",
      `and(equals|bring.class|${bring.class}` +
        `||equals|bring.group|${bring.group}` +
        `||equals|bring.partOfSpeech|${bring.partOfSpeech || ""})`,
      100,
    );
    const namn = (medlemmar.hits || []).map((t) =>
      t.entry.baseform.toLowerCase(),
    );
    const traffar = namn.some(
      (n) => kanda.has(n) || [...kanda].some((k) => arVariant(n, k)),
    );
    if (traffar) return { bring, medlemmar };
    if (!forsta) forsta = { bring, medlemmar };
  }
  return forsta || { bring: null, medlemmar: null };
}

/** Letar upp `antal` ord som ligger nära, när synonymerna inte räcker. */
export async function hamtaNarliggande(uppslag, antal) {
  const radata = {};
  const kandidater = [];

  for (const betydelse of uppslag.betydelser) {
    // Egennamn råkar vara stavade som vanliga ord: SALDO ger både "minna..1"
    // och "Minna..1" (flicknamnet), vars moder är "förnamn".
    if ((betydelse.lemgram || []).some((lg) => lg.includes("..pm."))) continue;
    if (betydelse.moder) {
      kandidater.push([0, betydelse.moder.split("..")[0]]);
    }
  }

  const { bring, medlemmar } = await bringGrupp(uppslag);
  if (bring) {
    radata.blingbring = medlemmar;
    const mitt = parseInt(bring.groupposition, 10);
    for (const traff of medlemmar.hits || []) {
      const plats = (traff.entry.bring || {}).groupposition;
      if (plats === undefined) continue;
      const avstand = Math.abs(parseInt(plats, 10) - mitt);
      if (avstand > 0 && avstand <= BRING_FONSTER) {
        kandidater.push([avstand, traff.entry.baseform]);
      }
    }
  }

  const redan = new Set(uppslag.synonymer.map((s) => s.toLowerCase()));
  redan.add(uppslag.ord.toLowerCase());

  const valda = [];
  kandidater.sort((a, b) => a[0] - b[0]);
  for (const [, kandidat] of kandidater) {
    const ordet = kandidat.replaceAll("_", " ");
    const nyckel = ordet.toLowerCase();
    if (redan.has(nyckel) || arVariant(ordet, uppslag.ord)) continue;
    if (valda.some((v) => arVariant(ordet, v))) continue;
    valda.push(ordet);
    redan.add(nyckel);
    if (valda.length >= antal) break;
  }
  return { narliggande: valda, radata };
}

// --- Steg 1: hämta rådata --------------------------------------------------

export async function hamtaRadata(ord, antalExempel = 3) {
  const radata = { ord };

  // 1. SALDO -- ger senseID och lemgram, nycklarna till allt annat.
  const saldo = await karpSok("saldo", "baseform", ord);
  radata.saldo = saldo;

  const senseIds = [];
  const lemgram = [];
  for (const traff of saldo.hits || []) {
    const post = traff.entry || {};
    if (post.senseID) senseIds.push(post.senseID);
    lemgram.push(...(post.lemgrams || []));
  }

  // 2. Swesaurus -- en fråga per betydelse.
  radata.swesaurus = {};
  for (const senseId of senseIds) {
    radata.swesaurus[senseId] = await karpSok("swesaurus", "saldo", senseId);
  }

  // 3. Lexin -- definition, ordklass och en exempelmening.
  radata.lexin = await karpSok("lexin", "languages.baseform", ord);

  // 4. Korp -- autentiska meningar. Med lemgram får vi alla böjningsformer;
  //    utan dem får vi nöja oss med den exakta ordformen.
  const cqp = lemgram.length
    ? lemgram.map((lg) => `[lex contains "${cqpStrang(lg)}"]`).join(" | ")
    : (() => {
        const sakert = cqpStrang(ord);
        return `[lemma contains "${sakert}" | word = "${sakert}"]`;
      })();
  radata.korp_cqp = cqp;
  radata.korp = antalExempel > 0 ? await korpSok(cqp, antalExempel) : {};

  return radata;
}

// --- Steg 2: tolka rådatan -------------------------------------------------

const INGET_MELLANSLAG_FORE = new Set([...".,;:!?%)]}»…"]);
const INGET_MELLANSLAG_EFTER = new Set([..."([{«"]);

const MENINGSSLUT = new Set([".", "!", "?", "…", ":"]);
const CITATTECKEN = new Set(['"', "'", "»", "«", "”", "“", "„"]);

// En bra exempelmening är varken ett fragment eller ett stycke.
const MIN_ORD = 5;
const MAX_ORD = 28;

function escapeHtml(text) {
  return text
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#x27;");
}

/** Sätter ihop Korps lösa ord till en mening, med träffordet i fetstil. */
function byggMening(tokens, start, slut) {
  const delar = [];
  let efterOppningstecken = false;
  tokens.forEach((token, i) => {
    const ordform = token.word || "";
    if (!ordform) return;
    // Mellanrummet avgörs av den RÅA ordformen, före escape och <b>.
    if (
      delar.length &&
      !INGET_MELLANSLAG_FORE.has(ordform[0]) &&
      !efterOppningstecken
    ) {
      delar.push(" ");
    }
    efterOppningstecken = INGET_MELLANSLAG_EFTER.has(ordform.at(-1));

    let text = escapeHtml(ordform);
    if (i >= start && i < slut) text = `<b>${text}</b>`;
    delar.push(text);
  });
  return delar.join("").trim();
}

/** Hittar meningsgränserna runt träffen i Korps 30-ordsfönster. */
function klippUtMening(tokens, start, slut) {
  let vanster = null;
  for (let i = start - 1; i >= 0; i--) {
    if (MENINGSSLUT.has(tokens[i].word)) {
      vanster = i + 1;
      break;
    }
  }
  if (vanster === null && start === 0) vanster = 0;

  let hoger = null;
  for (let i = slut - 1; i < tokens.length; i++) {
    if (MENINGSSLUT.has(tokens[i].word)) {
      hoger = i + 1; // ta med skiljetecknet
      break;
    }
  }

  if (vanster === null || hoger === null || vanster >= hoger) return null;

  // Oparade citattecken ser ut som fel på ett kort. Tankstreck lämnas i
  // fred -- de markerar repliker på svenska.
  while (vanster < hoger && CITATTECKEN.has(tokens[vanster].word)) vanster++;
  while (hoger > vanster && CITATTECKEN.has(tokens[hoger - 1].word)) hoger--;

  if (vanster >= slut || hoger <= start) return null;
  return [vanster, hoger];
}

/** Väljer ut de mest kortvänliga meningarna ur Korps träfflista. */
function plockaExempel(korp, antal) {
  const kandidater = [];
  for (const traff of (korp && korp.kwic) || []) {
    const tokens = traff.tokens || [];
    const match = traff.match || {};
    const start = match.start || 0;
    const slut = match.end || 0;

    const granser = klippUtMening(tokens, start, slut);
    if (!granser) continue;
    const [vanster, hoger] = granser;

    const langd = hoger - vanster;
    if (langd < MIN_ORD || langd > MAX_ORD) continue;

    const mening = byggMening(
      tokens.slice(vanster, hoger),
      start - vanster,
      slut - vanster,
    );
    if (mening && !kandidater.includes(mening)) kandidater.push(mening);
  }

  // Kortast först -- lättare att läsa på ett flashcard.
  kandidater.sort((a, b) => a.length - b.length);
  return kandidater.slice(0, antal);
}

export function tolka(radata, antalExempel = 3) {
  const ord = radata.ord;
  const uppslag = {
    ord,
    ordklass: null,
    betydelser: [],
    synonymer: [],
    definitioner: [],
    exempel: [],
    narliggande: [],
    lastForm: null,
    bojning: null,
  };

  // SALDO: betydelser och lemgram
  for (const traff of (radata.saldo || {}).hits || []) {
    const post = traff.entry || {};
    if (!post.senseID) continue;
    uppslag.betydelser.push({
      senseId: post.senseID,
      lemgram: post.lemgrams || [],
      moder: post.primary || null,
    });
  }

  // Swesaurus: synonymer. Högsta "degree" per synonym behålls -- samma ordpar
  // kan komma från flera källor med olika säkerhet.
  const styrka = new Map();
  for (const svar of Object.values(radata.swesaurus || {})) {
    for (const traff of svar.hits || []) {
      for (const relation of (traff.entry || {}).relations || []) {
        if (relation.label !== "syn") continue;
        const synonym = (relation.saldo || "").split("..")[0];
        if (!synonym || synonym === ord) continue;
        const grad = relation.degree || 0;
        styrka.set(synonym, Math.max(styrka.get(synonym) || 0, grad));
      }
    }
  }
  uppslag.synonymer = [...styrka.entries()]
    .sort((a, b) => b[1] - a[1])
    .map(([s]) => s);

  // Lexin: definition, ordklass och en exempelmening
  for (const traff of (radata.lexin || {}).hits || []) {
    const post = traff.entry || {};
    const sense = post.sense || {};
    const definition = (sense.definition || {}).text;
    if (definition && !uppslag.definitioner.includes(definition)) {
      uppslag.definitioner.push(definition);
    }
    for (const exempel of sense.examples || []) {
      if (
        exempel.lang === "swe" &&
        exempel.text &&
        !uppslag.exempel.includes(exempel.text)
      ) {
        uppslag.exempel.push(exempel.text);
      }
    }
    if (!uppslag.ordklass) {
      for (const sprak of post.languages || []) {
        if (sprak.lang === "swe" && sprak.nativeOfSpeech) {
          uppslag.ordklass = sprak.nativeOfSpeech;
          break;
        }
      }
    }
  }

  // Korp: autentiska meningar
  uppslag.exempel.push(...plockaExempel(radata.korp, antalExempel));

  return uppslag;
}

/** Sant om vi fick något användbart, inte bara ett tomt skal. */
export function hittades(uppslag) {
  return Boolean(
    uppslag.synonymer.length ||
      uppslag.definitioner.length ||
      uppslag.exempel.length ||
      uppslag.narliggande.length,
  );
}

// --- Allt i ett ------------------------------------------------------------

export async function slaUpp(ord, { antalExempel = 3, grundform = true } = {}) {
  /** Sista handpåläggningen, oavsett vilken väg vi tog hit. */
  async function klart(uppslag, radata) {
    if (uppslag.betydelser.length && uppslag.synonymer.length < MIN_SYNONYMER) {
      try {
        const { narliggande, radata: extra } = await hamtaNarliggande(
          uppslag,
          MIN_SYNONYMER - uppslag.synonymer.length,
        );
        uppslag.narliggande = narliggande;
        Object.assign(radata, extra);
      } catch (fel) {
        if (!(fel instanceof SprakbankenFel)) throw fel;
        // Utfyllnad är en bonus, inte ett krav.
      }
    }
    return { uppslag, radata };
  }

  const radata = await hamtaRadata(ord, antalExempel);
  const uppslag = tolka(radata, antalExempel);

  // Det vi lämnar tillbaka om ingen grundform ger något bättre.
  let reserv = null;
  if (uppslag.betydelser.length || !grundform) {
    reserv = await klart(uppslag, radata);
    if (hittades(reserv.uppslag) || !grundform) return reserv;
    // Ordet finns i SALDO, men posten är ett tomt skal: "fraterniserande"
    // har en egen post som substantiv, utan synonymer, definition eller
    // exempel. Verbet "fraternisera", som ordet är en böjning av, ger
    // däremot ett kort. Prova vidare.
  }

  let kandidater;
  try {
    const svar = await grundformer(ord);
    kandidater = svar.kandidater;
    radata.saldom = svar.radata;
  } catch (fel) {
    if (!(fel instanceof SprakbankenFel)) throw fel;
    return reserv || klart(uppslag, radata);
  }

  for (const kandidat of kandidater) {
    if (kandidat.ord === ord) continue; // ordet var redan grundform
    const nyRadata = await hamtaRadata(kandidat.ord, antalExempel);
    const nytt = tolka(nyRadata, antalExempel);
    if (!nytt.betydelser.length) continue;
    nytt.lastForm = ord;
    nytt.bojning = kandidat.bojning;
    if (!nytt.ordklass) nytt.ordklass = ORDKLASS_NAMN[kandidat.ordklass] || null;
    nyRadata.saldom = radata.saldom;
    nyRadata.last_form = ord;
    const fardigt = await klart(nytt, nyRadata);
    if (hittades(fardigt.uppslag)) return fardigt;
    // Även grundformen var ett tomt skal -- prova nästa.
  }

  return reserv || klart(uppslag, radata);
}
