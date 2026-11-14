/* Läser texten i ett foto och ger en ruta per ord. Motsvarar ocr_ord() i
 * bild.py.
 *
 * Motorn är Tesseract -- samma som i Python-versionen -- men kompilerad till
 * WebAssembly (tesseract.js), så att den går att köra i telefonens webbläsare
 * utan att något installeras. Precis som i bild.py är den här filen ENDA
 * stället som vet vilken motor det är. Resten av appen ser bara ordrutor:
 *
 *     {text, x, y, bredd, hojd}
 *
 * Tre saker hämtas från nätet första gången, och sparas sedan i webbläsaren:
 *   - tesseract.js      (limmet, ca 0,2 MB)
 *   - tesseract-core    (själva motorn, ca 3 MB)
 *   - swe.traineddata   (svenskan, ca 2,5 MB)
 *
 * Versionerna är fastlåsta med flit. En adress utan version följer med varje
 * ny utgåva, och då kan läsningen ändras utan att vi rört en rad.
 */

import { BildFel, rensaOrd } from "./bild.js";

const CDN = "https://cdn.jsdelivr.net/npm";
const TESSERACT = `${CDN}/tesseract.js@7.0.0/dist`;
const KARNA = `${CDN}/tesseract.js-core@7.0.0`;
// "best_int" är Tesseracts noggrannaste modell omräknad till heltal. Det är
// samma modell som ligger i den swe.traineddata Python-versionen använder,
// men utan den äldre motorn som också följer med där -- därför en femtedel
// så stor. På testfotona läser de två 179 av 182 ord likadant.
const sprakdata = (sprak) =>
  `${CDN}/@tesseract.js-data/${sprak}@1.0.0/4.0.0_best_int`;

/** Ord som Tesseract är mindre säker på än så här (0-100) kastas. Samma
 *  gräns som i bild.py. */
export const MIN_SAKERHET = 40;

/**
 * Tesseracts "page segmentation mode" -- hur den delar in bilden innan den
 * börjar läsa.
 *   "3"  leta själv upp textblocken. Rätt för ett helt foto; det är också
 *        vad kommandoradsprogrammet (och därmed Python-versionen) gör.
 *   "6"  anta att hela bilden är ett enda textblock. Rätt för en utklippt
 *        lapp.
 * tesseract.js har "6" som förval, vilket är FEL för ett helt foto: där
 * finns bokens kant, tummen och grannsidan också. På testfotot sida1.jpg
 * lästes då bara 12 av 56 ord likadant som i Python.
 */
const HELT_FOTO = "3";
const ETT_BLOCK = "6";

/** Tecken som avslutar ett avstavat ord vid radslut. Tankstrecken är med för
 *  att Tesseract ofta läser bindestrecket som ett sådant: "lansiä-" kom ut
 *  som "lansiä—". Ett riktigt tankstreck har blanksteg före sig och blir ett
 *  eget ord, så det förväxlas inte med det här. */
const AVSTAVNINGSTECKEN = "-‐–—¬";

/** Tesseracts egna statusrader, översatta. */
const STATUS = {
  "loading tesseract core": "hämtar läsmotorn",
  "initializing tesseract": "startar läsmotorn",
  "loading language traineddata": "hämtar svenskan",
  "initializing api": "startar läsmotorn",
  "recognizing text": "läser texten",
};

// --- Läsaren ---------------------------------------------------------------

// Läsaren (en egen arbetartråd med motorn och språket inlästa) är dyr att
// starta, så den skapas en gång och återanvänds för varje foto.
let lasare = null; // löfte om en färdig läsare
let lasareSprak = null;
let aktuellPavag = null; // den som just nu vill ha framstegsrapporter

function hamtaLasare(sprak) {
  if (lasare && lasareSprak === sprak) return lasare;

  const gammal = lasare;
  lasareSprak = sprak;
  lasare = (async () => {
    // Byter man språk stängs den gamla läsaren först, annars ligger två
    // motorer i minnet -- och minne är det telefonen har minst av.
    if (gammal) {
      try {
        await (await gammal).terminate();
      } catch {
        /* den gamla startade aldrig; inget att stänga */
      }
    }

    let Tesseract;
    try {
      // import() i stället för import överst i filen: då blir ett avbrutet
      // nät ett fel vi kan fånga och förklara, i stället för att hela appen
      // vägrar starta.
      Tesseract = (await import(`${TESSERACT}/tesseract.esm.min.js`)).default;
    } catch (fel) {
      throw new BildFel(
        "Kunde inte hämta läsmotorn (Tesseract). Första gången behövs " +
          `internet; därefter ligger den sparad i webbläsaren. (${fel.message || fel})`,
      );
    }

    try {
      // 1 = bara den nyare LSTM-motorn. Det är också den enda som
      // best_int-språkdatan innehåller.
      return await Tesseract.createWorker(sprak, 1, {
        workerPath: `${TESSERACT}/worker.min.js`,
        corePath: KARNA,
        langPath: sprakdata(sprak),
        logger: (m) => {
          if (typeof aktuellPavag !== "function") return;
          aktuellPavag({
            typ: "steg",
            vad: STATUS[m.status] || m.status,
            andel: m.progress,
          });
        },
        // Utan den här skriver tesseract.js bara felet i konsolen.
        errorHandler: (fel) => console.error("Tesseract:", fel),
      });
    } catch (fel) {
      throw new BildFel(
        `Kunde inte starta läsmotorn för språket "${sprak}". Första gången ` +
          `behövs internet för att hämta språkdatan. (${fel?.message || fel})`,
      );
    }
  })();

  // Ett misslyckat försök får inte fastna. Annars skulle varje senare anrop
  // få tillbaka samma gamla fel, även när nätet kommit tillbaka.
  const mitt = lasare;
  mitt.catch(() => {
    if (lasare === mitt) {
      lasare = null;
      lasareSprak = null;
    }
  });
  return lasare;
}

/**
 * Hämtar och startar läsmotorn i förväg. Värt att göra när appen öppnas:
 * första starten tar några sekunder, och den tiden vill man ha undanstökad
 * innan fotot är taget.
 */
export async function forberedOcr(sprak = "swe", pavag = null) {
  aktuellPavag = pavag;
  try {
    await hamtaLasare(sprak);
  } finally {
    aktuellPavag = null;
  }
}

/** Stänger läsaren och lämnar tillbaka minnet. */
export async function stangOcr() {
  const gammal = lasare;
  lasare = null;
  lasareSprak = null;
  if (gammal) {
    try {
      await (await gammal).terminate();
    } catch {
      /* startade aldrig */
    }
  }
}

// --- Läsa ------------------------------------------------------------------

/**
 * Läser texten i en canvas och ger en ruta per ord.
 *
 * @param duk       bilden: ett helt foto, eller en lapp från hittaStreck()
 * @param sprak     Tesseracts språkkod
 * @param ettBlock  true för en utklippt lapp, false för ett helt foto
 * @param pavag     funktion som får framstegsrapporter {typ, vad, andel}
 * @returns {Promise<Array<{text, x, y, bredd, hojd, sakerhet, avstavat}>>}
 *          avstavat är true om ordet slutade med bindestreck -- då står
 *          resten av det i början av nästa rad.
 */
export async function ocrOrd(
  duk,
  { sprak = "swe", ettBlock = false, pavag = null } = {},
) {
  aktuellPavag = pavag;
  try {
    const motor = await hamtaLasare(sprak);

    let data;
    try {
      await motor.setParameters({
        tessedit_pageseg_mode: ettBlock ? ETT_BLOCK : HELT_FOTO,
      });
      // Tredje argumentet väljer VAD vi vill ha tillbaka. Vi behöver
      // koordinaterna ("blocks"), inte den löpande texten -- utan
      // koordinater går det inte att veta vilket ord som står ovanför
      // vilket streck.
      ({ data } = await motor.recognize(duk, {}, {
        text: false,
        blocks: true,
      }));
    } catch (fel) {
      throw new BildFel(`Tesseract misslyckades: ${fel?.message || fel}`);
    }

    // Svaret är ett träd: block -> stycken -> rader -> ord. Vi vill bara ha
    // löven.
    const ord = [];
    for (const block of data.blocks || []) {
      for (const stycke of block.paragraphs || []) {
        for (const rad of stycke.lines || []) {
          for (const o of rad.words || []) {
            const ra = (o.text || "").trim();
            const text = rensaOrd(ra);
            if (!text || o.confidence < MIN_SAKERHET) continue;
            ord.push({
              text,
              x: o.bbox.x0,
              y: o.bbox.y0,
              bredd: o.bbox.x1 - o.bbox.x0,
              hojd: o.bbox.y1 - o.bbox.y0,
              sakerhet: Math.round(o.confidence),
              avstavat: AVSTAVNINGSTECKEN.includes(ra.slice(-1)),
            });
          }
        }
      }
    }
    return ord;
  } finally {
    aktuellPavag = null;
  }
}
