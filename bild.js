/* Hittar understrukna ord i ett foto. Portning av bild.py.
 *
 * Den tunga bildbehandlingen ligger i bildkarna.js och körs i en Web Worker
 * (bildarbetare.js). Den här filen sköter bara det som måste ske på
 * huvudtråden: läsa in bilden, skicka den vidare, och para ihop strecken med
 * de ord OCR läst på lapparna.
 *
 * Varför en egen tråd: OpenCV.js är 10 MB och låser tråden medan den
 * kompileras. På huvudtråden fryser gränssnittet helt -- uppmätt över två
 * minuter utan ett enda svar. I en worker märks det inte.
 */

// Var ordets nederkant får ligga i förhållande till streckets mitt, i
// texthöjder: högst så här långt ovanför ...
export const MAX_AVSTAND_OVANFOR = 1.3;
// ... och högst så här långt nedanför (strecket får skära in i ordet).
export const MAX_INSKARNING = 0.6;
// Ett ord hör till strecket om minst så här stor del av ORDET ligger över
// strecket ...
export const MIN_OVERLAPP = 0.3;
// ... eller om minst så här stor del av STRECKET ligger under ordet. Svaga
// streck hittas ofta bara till en del: under "förmått" hittades bara biten
// under "mått", en fjärdedel av ordet.
export const MIN_STRECKANDEL = 0.5;
export const MIN_TEXTHOJD = 14;

export class BildFel extends Error {
  constructor(meddelande, { forLitenText = false } = {}) {
    super(meddelande);
    this.forLitenText = forLitenText;
  }
}

// --- Läsa in bilden --------------------------------------------------------

/**
 * Läser en bild (File, Blob eller URL) och skalar ner den om den är onödigt
 * stor. En mobilkamera ger 4000 pixlar bred bild; 2000 räcker gott för tryckt
 * text, och bildbehandlingen blir dubbelt så snabb.
 */
export async function lasBild(kalla, maxBredd = 2000) {
  let bitmap;
  try {
    bitmap =
      kalla instanceof Blob
        ? await createImageBitmap(kalla)
        : await createImageBitmap(await (await fetch(kalla)).blob());
  } catch (fel) {
    throw new BildFel(`Kunde inte läsa bilden: ${fel.message || fel}`);
  }

  let { width, height } = bitmap;
  if (width > maxBredd) {
    height = Math.round((height * maxBredd) / width);
    width = maxBredd;
  }

  const duk = document.createElement("canvas");
  duk.width = width;
  duk.height = height;
  // Webbläsarens nedskalning medelvärdesbildar, precis som OpenCV:s
  // INTER_AREA, så tunna streck försvinner inte.
  const ritare = duk.getContext("2d", { willReadFrequently: true });
  ritare.imageSmoothingEnabled = true;
  ritare.imageSmoothingQuality = "high";
  ritare.drawImage(bitmap, 0, 0, width, height);
  bitmap.close();
  return duk;
}

// --- Arbetartråden ---------------------------------------------------------

let arbetare = null;

function hamtaArbetare() {
  if (!arbetare) {
    arbetare = new Worker(new URL("./bildarbetare.js", import.meta.url));
  }
  return arbetare;
}

/**
 * Startar arbetartråden och läser in OpenCV i förväg.
 *
 * Värt att göra när appen öppnas, inte när användaren tryckt på knappen:
 * inläsningen tar sekunder, och den tiden vill man ha undanstökad innan
 * fotot ens är taget.
 */
export function forbered() {
  return new Promise((klar, fel) => {
    const w = hamtaArbetare();
    const lyssnare = (h) => {
      if (h.data.typ === "redo") {
        w.removeEventListener("message", lyssnare);
        klar();
      } else if (h.data.typ === "fel") {
        w.removeEventListener("message", lyssnare);
        fel(new BildFel(h.data.meddelande));
      }
    };
    w.addEventListener("message", lyssnare);
    w.postMessage({ typ: "forbered" });
  });
}

/**
 * Letar upp understrykningarna i en canvas.
 *
 * @returns {Promise<{streck: Array, info: Object, lappar: Array}>}
 *          streck  strecken i läsordning
 *          info    de uträknade måtten -- bra när man vill veta VARFÖR ett
 *                  streck missades, inte bara att det gjorde det
 *          lappar  en lapp per streck: ett utklipp runt strecket, uppvridet
 *                  och rensat, som en canvas färdig att läsa (och att visa).
 *                  lapp.x0, x1 och y säger var strecket ligger i lappen.
 */
export function hittaStreck(duk, { tvinga = false, pavag = null } = {}) {
  const bilddata = duk
    .getContext("2d", { willReadFrequently: true })
    .getImageData(0, 0, duk.width, duk.height);

  return new Promise((klar, fel) => {
    const w = hamtaArbetare();
    const lyssnare = (h) => {
      const svar = h.data;
      // Lyssna BARA efter de två svar som avslutar körningen. Arbetaren
      // skickar också framstegsrapporter ("steg", "redo"), och tolkade man
      // dem som utfall avbröts körningen av sitt eget livstecken -- med ett
      // tomt felmeddelande, eftersom new Error(undefined) saknar text.
      if (svar.typ !== "klar" && svar.typ !== "fel") {
        if (typeof pavag === "function") pavag(svar);
        return;
      }
      w.removeEventListener("message", lyssnare);
      if (svar.typ === "klar") {
        klar({
          streck: svar.streck,
          info: svar.info,
          lappar: svar.lappar.map(tillDuk),
        });
      } else {
        fel(new BildFel(svar.meddelande, { forLitenText: svar.forLitenText }));
      }
    };
    w.addEventListener("message", lyssnare);
    w.postMessage({
      typ: "kor",
      bilddata: {
        data: bilddata.data,
        width: bilddata.width,
        height: bilddata.height,
      },
      tvinga,
    });
  });
}

/** Lägger arbetartrådens råa pixlar på en canvas. */
function tillDuk(lapp) {
  const duk = document.createElement("canvas");
  duk.width = lapp.bredd;
  duk.height = lapp.hojd;
  duk
    .getContext("2d")
    .putImageData(new ImageData(lapp.rgba, lapp.bredd, lapp.hojd), 0, 0);
  return {
    duk,
    x0: lapp.x0,
    x1: lapp.x1,
    y: lapp.y,
    texthojd: lapp.texthojd,
    skala: lapp.skala,
  };
}

// --- Para ihop streck med ord ---------------------------------------------

/**
 * Väljer ut orden som hör till lappens streck. Allt i lappens koordinater.
 *
 * Två villkor måste gälla:
 *   - ordets nederkant ligger strax OVANFÖR strecket (inte på raden ovanför,
 *     och inte på raden under)
 *   - ordet och strecket överlappar vågrätt -- antingen ligger en bra del av
 *     ordet över strecket, eller så ligger det mesta av strecket under ordet
 */
export function ordVidStreck(lapp, ord) {
  const traffar = [];
  for (const o of ord) {
    const avstand = lapp.y - (o.y + o.hojd);
    if (
      avstand < -MAX_INSKARNING * lapp.texthojd ||
      avstand > MAX_AVSTAND_OVANFOR * lapp.texthojd
    ) {
      continue;
    }

    const overlapp = Math.min(o.x + o.bredd, lapp.x1) - Math.max(o.x, lapp.x0);
    if (overlapp <= 0) continue;
    const avOrdet = overlapp / Math.max(o.bredd, 1);
    const avStrecket = overlapp / Math.max(lapp.x1 - lapp.x0, 1);
    if (avOrdet < MIN_OVERLAPP && avStrecket < MIN_STRECKANDEL) continue;
    traffar.push(o);
  }
  traffar.sort((a, b) => a.x - b.x);
  return traffar;
}

/** Tecken som ska bort från kanterna av ett OCR-läst ord. */
const SKRAP = " \t\r\n.,;:!?\"'»«”“„()[]{}-–—…*";

export function rensaOrd(text) {
  let start = 0;
  let slut = text.length;
  while (start < slut && SKRAP.includes(text[start])) start++;
  while (slut > start && SKRAP.includes(text[slut - 1])) slut--;
  return text.slice(start, slut);
}
