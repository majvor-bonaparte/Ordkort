/* Service worker: ett litet program som webbläsaren håller igång i
 * bakgrunden för appens räkning.
 *
 * Varför den finns: Chrome på Android vill se en service worker innan den
 * går med på att INSTALLERA en webbapp. Utan den gick det bara att lägga
 * en genväg på hemskärmen.
 *
 * Vad den gör: lägger appens egna filer i ett förråd i telefonen, så att
 * appen startar även med dåligt nät.
 *
 * Nätet går alltid först. Finns det kontakt hämtas den senaste versionen,
 * och förrådet används bara när nätet inte svarar. Det omvända -- förrådet
 * först -- är det vanliga i exempel på nätet, men då skulle en ny version
 * som laddats upp till GitHub inte synas förrän vid nästa start, och det är
 * lätt att tro att uppdateringen misslyckades.
 *
 * Bara appens EGNA filer rörs. Biblioteken (OpenCV, Tesseract) och
 * Språkbankens svar går förbi helt; webbläsaren sparar biblioteken själv.
 */

const FORRAD = "ordkort-v2";

const FILER = [
  "./",
  "index.html",
  "app.css",
  "app.js",
  "manifest.json",
  "foto.js",
  "bild.js",
  "bildkarna.js",
  "bildarbetare.js",
  "ocr.js",
  "sprakbanken.js",
  "kort.js",
  "apkg.js",
  "ikoner/ikon-192.png",
  "ikoner/ikon-512.png",
  "ikoner/apple-touch-icon.png",
  "ikoner/favicon.png",
];

self.addEventListener("install", (h) => {
  // En fil i taget, och ett misslyckande stoppar inte resten. Med addAll()
  // räckte det att EN fil saknades på servern -- första gången mappen
  // ikoner inte kom med i uppladdningen -- för att hela service workern
  // skulle vägra starta, och då gick appen inte att installera.
  h.waitUntil(
    caches
      .open(FORRAD)
      .then((f) => Promise.allSettled(FILER.map((fil) => f.add(fil))))
      .then(() => self.skipWaiting()),
  );
});

self.addEventListener("activate", (h) => {
  // Städa bort förråd från äldre versioner av den här filen.
  h.waitUntil(
    caches
      .keys()
      .then((namn) => Promise.all(namn.filter((n) => n !== FORRAD).map((n) => caches.delete(n))))
      .then(() => self.clients.claim()),
  );
});

self.addEventListener("fetch", (h) => {
  const fraga = h.request;
  // Andra sajter (bibliotek, Språkbanken) och allt utom GET: rör inte.
  if (fraga.method !== "GET" || new URL(fraga.url).origin !== self.location.origin) return;

  h.respondWith(
    fetch(fraga)
      .then((svar) => {
        if (svar.ok) {
          const kopia = svar.clone();
          caches.open(FORRAD).then((f) => f.put(fraga, kopia));
        }
        return svar;
      })
      .catch(() => caches.match(fraga, { ignoreSearch: true })),
  );
});
