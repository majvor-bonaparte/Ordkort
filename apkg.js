/* Bygger en Anki-fil (.apkg) i webbläsaren.
 *
 * Det här är vad som ersätter AnkiConnect i telefonen. En .apkg är en
 * zip-fil som innehåller en SQLite-databas med Ankis eget schema. Poängen
 * för oss: KORTLEKENS NAMN STÅR INNE I FILEN. Vid import skapar AnkiDroid
 * kortleken om den saknas, och lägger korten i den befintliga om den finns.
 * Därför kan appen erbjuda både "välj kortlek" och "ny kortlek" utan att
 * kunna prata med AnkiDroid över huvud taget.
 *
 * Vi skriver den äldre schemaversionen (11, filen heter collection.anki2).
 * Anki läser den fortfarande, och den är enkel nog att få rätt för hand.
 *
 * Två bibliotek behövs och hämtas vid första användningen:
 *   sql.js  SQLite kompilerat till wasm -- bygger själva databasen
 *   JSZip   packar ihop det till en .apkg
 */

const SQLJS_VERSION = "1.10.3";
const SQLJS_BAS = `https://cdnjs.cloudflare.com/ajax/libs/sql.js/${SQLJS_VERSION}/`;
const JSZIP_URL =
  "https://cdnjs.cloudflare.com/ajax/libs/jszip/3.10.1/jszip.min.js";

export const NOTISTYP = "Ordkort (svenska)";
export const FALT_FRAM = "Framsida";
export const FALT_BAK = "Baksida";

/* Samma utseende som på datorn, så att korten ser likadana ut oavsett var de
 * skapades. Anki stoppar in kortets HTML i en .card-behållare. */
export const KORT_CSS = `
.card {
  font-family: Georgia, serif;
  font-size: 20px;
  text-align: left;
  color: #222;
  background: #fdfcfa;
  padding: 1em;
}
.ord { font-size: 32px; font-weight: bold; text-align: center; }
.ordklass { color: #888; font-style: italic; font-size: 16px; }
.bojning { color: #888; font-size: 16px; margin-bottom: .4em; }
.rubrik {
  font-size: 13px; letter-spacing: .08em; text-transform: uppercase;
  color: #b06030; margin-top: 1em; margin-bottom: .2em;
}
.synonymer, .narliggande { color: #333; }
.exempel { margin: .2em 0 0 1em; padding: 0; }
.exempel li { margin-bottom: .3em; }
.kalla { margin-top: 1.4em; font-size: 12px; color: #aaa; }
`.trim();

// --- Hämta biblioteken ------------------------------------------------------

function laddaSkript(url) {
  return new Promise((klar, fel) => {
    const tagg = document.createElement("script");
    tagg.src = url;
    tagg.onload = klar;
    tagg.onerror = () => fel(new Error(`Kunde inte ladda ${url}`));
    document.head.appendChild(tagg);
  });
}

let sqlLofte = null;
async function hamtaSql() {
  if (!sqlLofte) {
    sqlLofte = (async () => {
      await laddaSkript(SQLJS_BAS + "sql-wasm.js");
      // locateFile talar om var .wasm-filen ligger; utan den letar sql.js
      // bredvid vår egen sida och hittar ingenting.
      return window.initSqlJs({ locateFile: (fil) => SQLJS_BAS + fil });
    })();
  }
  return sqlLofte;
}

let zipLofte = null;
async function hamtaZip() {
  if (!zipLofte) {
    zipLofte = laddaSkript(JSZIP_URL).then(() => window.JSZip);
  }
  return zipLofte;
}

// --- Id:n som håller över tid -----------------------------------------------
// Anki identifierar notistyper och kortlekar på id, inte på namn. Får de nya
// id:n för varje paket ser Anki en främling med ett upptaget namn och döper om
// den: "Ordkort (svenska)+", sedan "++", sedan "+++". Korten sprids då över en
// ny notistyp vid varje import, och en ändring av utseendet slår bara igenom
// på en bråkdel av dem.
//
// Därför räknas id:na fram ur namnet i stället för ur klockan. Samma namn ger
// samma id, varje gång, på varje enhet.

const ID_BAS = 1600000000000; // en tidpunkt i det förflutna, utom vägen för Ankis egna

/** Enkel och stabil stränghash (FNV-1a). Behöver inte vara kryptografisk. */
function hashtal(text) {
  let h = 0x811c9dc5;
  for (const tecken of text) {
    h ^= tecken.codePointAt(0);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h;
}

function stabiltId(namn) {
  // Kortlek 1 är Ankis egen "Default" -- den får vi inte krocka med.
  return ID_BAS + (hashtal(namn) % 1000000000) + 2;
}

// --- Ankis sätt att räkna ---------------------------------------------------

/* Anki avgör om en notis är en dubblett genom en kontrollsumma på första
 * fältet -- med HTML-taggarna borttagna. Räknar vi fel får vi dubbletter
 * som Anki inte upptäcker. */
function rensaHtml(text) {
  return new DOMParser()
    .parseFromString(text, "text/html")
    .documentElement.textContent.trim();
}

async function faltsumma(text) {
  const data = new TextEncoder().encode(text);
  const hash = await crypto.subtle.digest("SHA-1", data);
  const hex = [...new Uint8Array(hash)]
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
  // Anki använder de åtta första hex-tecknen som ett heltal.
  return parseInt(hex.slice(0, 8), 16);
}

/* Varje notis har ett "guid", och det är på det Anki känner igen en notis
 * vid import: finns guid:et redan i samlingen skapas ingen ny notis.
 *
 * Första versionen slumpade fram ett nytt guid för varje kort. Då blev
 * samma ord en NY notis varje gång det kom i en ny fil -- fotade man samma
 * sida två dagar i rad fick man två kort för samma ord.
 *
 * Nu räknas guid:et fram ur ordet självt. Samma ord ger samma guid, vilken
 * dag och i vilken fil det än kommer, och Anki hoppar över det (eller
 * uppdaterar kortet, om det nya är nyare). Kortet stannar i den kortlek där
 * det först hamnade.
 *
 * Två olika hashar sätts ihop, så att två olika ord i praktiken aldrig får
 * samma guid. */
function stabiltGuid(ordet) {
  const nyckel = ordet.trim().toLowerCase();
  const a = hashtal(`${NOTISTYP}|${nyckel}`);
  const b = hashtal(`${nyckel}|${NOTISTYP}|2`);
  return `ok${a.toString(36)}${b.toString(36)}`;
}

// --- Schemat ----------------------------------------------------------------

const SCHEMA = `
CREATE TABLE col (
  id integer primary key, crt integer not null, mod integer not null,
  scm integer not null, ver integer not null, dty integer not null,
  usn integer not null, ls integer not null, conf text not null,
  models text not null, decks text not null, dconf text not null,
  tags text not null
);
CREATE TABLE notes (
  id integer primary key, guid text not null, mid integer not null,
  mod integer not null, usn integer not null, tags text not null,
  flds text not null, sfld integer not null, csum integer not null,
  flags integer not null, data text not null
);
CREATE TABLE cards (
  id integer primary key, nid integer not null, did integer not null,
  ord integer not null, mod integer not null, usn integer not null,
  type integer not null, queue integer not null, due integer not null,
  ivl integer not null, factor integer not null, reps integer not null,
  lapses integer not null, left integer not null, odue integer not null,
  odid integer not null, flags integer not null, data text not null
);
CREATE TABLE graves (
  usn integer not null, oid integer not null, type integer not null
);
CREATE TABLE revlog (
  id integer primary key, cid integer not null, usn integer not null,
  ease integer not null, ivl integer not null, lastIvl integer not null,
  factor integer not null, time integer not null, type integer not null
);
CREATE INDEX ix_notes_usn on notes (usn);
CREATE INDEX ix_cards_usn on cards (usn);
CREATE INDEX ix_cards_nid on cards (nid);
CREATE INDEX ix_cards_sched on cards (did, queue, due);
CREATE INDEX ix_revlog_usn on revlog (usn);
CREATE INDEX ix_revlog_cid on revlog (cid);
CREATE INDEX ix_notes_csum on notes (csum);
`;

const STANDARD_DCONF = {
  1: {
    id: 1, name: "Default", mod: 0, usn: 0, maxTaken: 60, autoplay: true,
    timer: 0, replayq: true,
    new: { bury: false, delays: [1, 10], initialFactor: 2500,
           ints: [1, 4, 0], order: 1, perDay: 20 },
    rev: { bury: false, ease4: 1.3, ivlFct: 1, maxIvl: 36500, perDay: 200,
           hardFactor: 1.2 },
    lapse: { delays: [10], leechAction: 0, leechFails: 8, minInt: 1, mult: 0 },
    dyn: false, newMix: 0, newPerDayMinimum: 0, interdayLearningMix: 0,
    reviewOrder: 0,
  },
};

function byggNotistyp(mid, deckId) {
  return {
    id: mid,
    name: NOTISTYP,
    type: 0,
    mod: Math.floor(Date.now() / 1000),
    usn: -1,
    sortf: 0,
    did: deckId,
    tmpls: [
      {
        name: "Kort 1",
        ord: 0,
        qfmt: `{{${FALT_FRAM}}}`,
        afmt: `{{FrontSide}}\n\n<hr id=answer>\n\n{{${FALT_BAK}}}`,
        did: null,
        bqfmt: "",
        bafmt: "",
      },
    ],
    flds: [FALT_FRAM, FALT_BAK].map((namn, i) => ({
      name: namn, ord: i, sticky: false, rtl: false,
      font: "Arial", size: 20, media: [],
    })),
    css: KORT_CSS,
    latexPre:
      "\\documentclass[12pt]{article}\n\\special{papersize=3in,5in}\n" +
      "\\usepackage[utf8]{inputenc}\n\\usepackage{amssymb,amsmath}\n" +
      "\\pagestyle{empty}\n\\setlength{\\parindent}{0in}\n\\begin{document}\n",
    latexPost: "\\end{document}",
    latexsvg: false,
    // "req" talar om vilka fält som måste vara ifyllda för att kortet ska
    // genereras. Utan den hoppar Anki över korten vid import.
    req: [[0, "any", [0]]],
    tags: [],
    vers: [],
  };
}

function byggKortlek(id, namn) {
  return {
    id, name: namn, mod: Math.floor(Date.now() / 1000), usn: -1,
    lrnToday: [0, 0], revToday: [0, 0], newToday: [0, 0], timeToday: [0, 0],
    collapsed: false, browserCollapsed: true, desc: "", dyn: 0,
    conf: 1, extendRev: 50, extendNew: 10, mid: null,
  };
}

// --- Bygget -----------------------------------------------------------------

/**
 * Bygger ett Anki-paket av en lista kort.
 *
 * @param {string} kortlek  Kortlekens namn. Finns den inte skapas den vid
 *                          import. Undermappar skrivs med "::" i Anki,
 *                          t.ex. "Svenska::Romaner".
 * @param {Array<{framsida: string, baksida: string, taggar?: string[],
 *                kortlek?: string}>} kort
 *        Ett kort med en egen `kortlek` hamnar där i stället. Så kan en och
 *        samma fil fylla på flera kortlekar.
 * @returns {Promise<Blob>} filen, redo att sparas eller delas
 */
export async function byggPaket(kortlek, kort) {
  if (!kort.length) {
    throw new Error("Inga kort att packa.");
  }
  const lekFor = (post) => (post.kortlek || kortlek || "").trim();
  if (kort.some((post) => !lekFor(post))) {
    throw new Error("Kortleken måste ha ett namn.");
  }

  const SQL = await hamtaSql();
  const JSZip = await hamtaZip();
  const db = new SQL.Database();
  db.run(SCHEMA);

  const nu = Date.now();
  const nuSek = Math.floor(nu / 1000);
  // Alla id:n i Anki är millisekunder sedan 1970. De måste vara unika, så vi
  // räknar upp i stället för att läsa klockan på nytt för varje rad.
  let nastaId = nu;
  const id = () => nastaId++;

  // Notiser och kort får löpande id:n -- de SKA vara unika för varje kort.
  // Kortleken och notistypen får stabila id:n, så att Anki känner igen dem
  // från förra importen i stället för att skapa kopior.
  const lekar = new Map();
  for (const post of kort) {
    const namn = lekFor(post);
    if (!lekar.has(namn)) lekar.set(namn, stabiltId(`kortlek:${namn}`));
  }
  const forstaLek = lekar.values().next().value;
  const mid = stabiltId(`notistyp:${NOTISTYP}`);

  db.run(
    `INSERT INTO col VALUES (1, ?, ?, ?, 11, 0, 0, 0, ?, ?, ?, ?, '{}')`,
    [
      // crt: när samlingen "börjar". Anki räknar dagar från denna tidpunkt.
      nuSek,
      nuSek,
      nu,
      JSON.stringify({
        nextPos: 1, estTimes: true, activeDecks: [1], sortType: "noteFld",
        timeLim: 0, sortBackwards: false, addToCur: true, curDeck: 1,
        newBury: true, newSpread: 0, dueCounts: true,
        curModel: String(mid), collapseTime: 1200,
      }),
      JSON.stringify({ [mid]: byggNotistyp(mid, forstaLek) }),
      JSON.stringify(
        Object.fromEntries([
          [1, byggKortlek(1, "Default")],
          ...[...lekar].map(([namn, lekId]) => [lekId, byggKortlek(lekId, namn)]),
        ]),
      ),
      JSON.stringify(STANDARD_DCONF),
    ],
  );

  let position = 0;
  const redanMed = new Set();
  for (const post of kort) {
    const falt = [post.framsida, post.baksida];
    const sorteringsfalt = rensaHtml(falt[0]);
    // Samma ord två gånger i samma fil: ta bara det första.
    const guid = stabiltGuid(sorteringsfalt);
    if (redanMed.has(guid)) continue;
    redanMed.add(guid);
    const notisId = id();

    db.run(
      `INSERT INTO notes VALUES (?, ?, ?, ?, -1, ?, ?, ?, ?, 0, '')`,
      [
        notisId,
        guid,
        mid,
        nuSek,
        // Anki lagrar taggar som " tagg1 tagg2 " -- mellanslag runt om.
        post.taggar && post.taggar.length ? ` ${post.taggar.join(" ")} ` : "",
        // Fälten separeras av tecknet 0x1f, inte av något läsbart.
        falt.join("\x1f"),
        sorteringsfalt,
        await faltsumma(sorteringsfalt),
      ],
    );

    db.run(
      `INSERT INTO cards VALUES (?, ?, ?, 0, ?, -1, 0, 0, ?, 0, 0, 0, 0, 0, 0, 0, 0, '')`,
      [id(), notisId, lekar.get(lekFor(post)), nuSek, position++],
    );
  }

  const binar = db.export();
  db.close();

  const zip = new JSZip();
  zip.file("collection.anki2", binar);
  // "media" är en innehållsförteckning över bifogade filer. Vi har inga,
  // men filen måste finnas -- annars vägrar Anki att läsa paketet.
  zip.file("media", "{}");
  return zip.generateAsync({ type: "blob", compression: "DEFLATE" });
}

/** Sparar paketet som en nedladdning. I telefonen hamnar det i Nedladdningar. */
/**
 * Lämnar över filen till användaren.
 *
 * Först provas delningsmenyn (navigator.share), som på en telefon låter en
 * skicka filen rakt till AnkiDroid. Chrome delar dock bara filtyper på en
 * godkänd lista -- bilder, ljud, pdf och liknande -- och .apkg brukar inte
 * vara med. Då laddas filen ned i stället; tryck på den i nedladdningarna så
 * öppnas den i AnkiDroid.
 *
 * @returns {Promise<"delad" | "nedladdad" | "avbruten">}
 */
export async function sparaPaket(blob, filnamn = "ordkort.apkg") {
  const fil = new File([blob], filnamn, { type: "application/apkg" });
  if (navigator.canShare && navigator.canShare({ files: [fil] })) {
    try {
      await navigator.share({ files: [fil], title: filnamn });
      return "delad";
    } catch (fel) {
      // Användaren stängde delningsmenyn: det är ett val, inte ett fel.
      if (fel && fel.name === "AbortError") return "avbruten";
      // Annat fel -- fall tillbaka på nedladdning.
    }
  }

  const url = URL.createObjectURL(blob);
  const lank = document.createElement("a");
  lank.href = url;
  lank.download = filnamn;
  document.body.append(lank);
  lank.click();
  lank.remove();
  // Webbläsaren behöver ett ögonblick på sig att starta nedladdningen innan
  // vi släpper minnet.
  setTimeout(() => URL.revokeObjectURL(url), 10000);
  return "nedladdad";
}
