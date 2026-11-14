/* Web Worker som kör bildbehandlingen i en egen tråd.
 *
 * Hela poängen: OpenCV.js är 10 MB och låser tråden helt medan den läses in
 * och kompileras. Händer det på huvudtråden fryser gränssnittet -- uppmätt
 * på den här datorn svarade sidan inte alls på över två minuter, inte ens på
 * en enda rad JavaScript. Här inne märks det inte: huvudtråden rullar vidare
 * och kan visa "läser bilden ..." under tiden.
 *
 * Protokollet är avsiktligt litet:
 *   in:  {typ: "kor", bilddata, tvinga}
 *   ut:  {typ: "redo"}                      -- OpenCV inläst
 *        {typ: "klar", streck, info, lappar}  -- en lapp per streck
 *        {typ: "fel", meddelande, forLitenText}
 */

const OPENCV_URL =
  "https://cdn.jsdelivr.net/npm/@techstark/opencv-js@4.10.0-release.1/dist/opencv.js";

let redo = null;

function laddaOpenCv() {
  if (redo) return redo;
  redo = (async () => {
    // Rapportera varje steg. Inläsningen tar sekunder, och utan besked ser
    // det ut som om appen hängt sig -- både för användaren och för den som
    // felsöker.
    const t0 = Date.now();
    const steg = (vad) =>
      postMessage({ typ: "steg", vad, ms: Date.now() - t0 });

    steg("hämtar OpenCV");
    importScripts(OPENCV_URL);
    steg("OpenCV hämtad");

    // VARNING -- skriv ALDRIG "await self.cv" här.
    //
    // OpenCV-modulen är en "thenable": ett vanligt objekt som råkar ha en
    // then-metod. await ser då inte ett objekt utan ett löfte, och försöker
    // packa upp det. Problemet är att modulen löser sig till SIG SJÄLV, och
    // det den får tillbaka har fortfarande en then-metod -- så await packar
    // upp igen, och igen. Tråden snurrar för alltid, helt tyst: ingen krasch,
    // inget felmeddelande, ingenting i konsolen. Det tog en stunds felsökning.
    //
    // Lösningen är att anropa then() för hand och lösa vårt EGET löfte med
    // ingenting alls. Då finns det inget thenable kvar att packa upp.
    if (self.cv && typeof self.cv.then === "function") {
      const modul = self.cv;
      await new Promise((klar, fel) => {
        const klocka = setTimeout(
          () => fel(new Error("OpenCV svarade inte inom 60 sekunder.")),
          60000,
        );
        modul.then(
          (fardig) => {
            clearTimeout(klocka);
            self.cv = fardig;
            klar();
          },
          (orsak) => {
            clearTimeout(klocka);
            fel(new Error(`OpenCV kunde inte starta: ${orsak}`));
          },
        );
      });
    } else if (self.cv && !self.cv.Mat) {
      // Äldre byggen signalerar i stället med en återanropsfunktion.
      await new Promise((klar) => {
        self.cv.onRuntimeInitialized = klar;
      });
    }
    if (!self.cv || !self.cv.Mat) {
      throw new Error("OpenCV lästes in men ser inte komplett ut.");
    }
    steg("OpenCV igång");
    importScripts("./bildkarna.js");
    postMessage({ typ: "redo", ms: Date.now() - t0 });
  })();
  return redo;
}

self.onmessage = async (handelse) => {
  const { typ, bilddata, tvinga } = handelse.data || {};

  // "forbered" laddar bara OpenCV och svarar med "redo". Att i stället köra en
  // tom bild genom pipelinen vore frestande men fel: den kraschar på en 1x1-
  // bild, och felsvaret skulle fastna i kön och förstöra NÄSTA anrop.
  if (typ === "forbered") {
    try {
      await laddaOpenCv();
    } catch (fel) {
      postMessage({ typ: "fel", meddelande: fel.message || String(fel) });
    }
    return;
  }
  if (typ !== "kor") return;

  try {
    await laddaOpenCv();
    const { streck, info, lappar } = self.korPipeline(bilddata, Boolean(tvinga));
    // Andra argumentet "överlåter" lapparnas pixlar till huvudtråden i
    // stället för att kopiera dem. Det går på ett ögonblick oavsett storlek.
    postMessage(
      { typ: "klar", streck, info, lappar },
      lappar.map((l) => l.rgba.buffer),
    );
  } catch (fel) {
    postMessage({
      typ: "fel",
      meddelande: felText(fel),
      stack: fel && fel.stack ? String(fel.stack).split("\n").slice(0, 4) : null,
      forLitenText: Boolean(fel.forLitenText),
    });
  }
};

/**
 * OpenCV.js kastar undantag från C++-sidan som RÅA TAL -- pekare in i
 * wasm-minnet. Ett sådant har varken message eller stack, så det syns bara
 * som ett tomt "Error". exceptionFromPtr packar upp den riktiga texten.
 */
function felText(fel) {
  if (typeof fel === "number" && self.cv && self.cv.exceptionFromPtr) {
    try {
      return `OpenCV: ${self.cv.exceptionFromPtr(fel).msg}`;
    } catch {
      return `OpenCV kastade undantag ${fel}`;
    }
  }
  if (fel && fel.message) return fel.message;
  if (fel && fel.msg) return `OpenCV: ${fel.msg}`;
  return String(fel);
}
