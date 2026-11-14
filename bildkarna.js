/* Själva bildbehandlingen. Portning av bild.py:s pipeline.
 *
 * Den här filen är ETT VANLIGT SKRIPT, inte en modul, och den körs bara inuti
 * en Web Worker (se bildarbetare.js). Anledningen är att OpenCV.js är 10 MB
 * och låser tråden helt medan den läses in -- gör man det på huvudtråden
 * fryser hela gränssnittet, på datorn i tiotals sekunder och på en telefon
 * värre. I en egen tråd märks det inte alls.
 *
 * Konstanterna är identiska med bild.py och kan vara det därför att nästan
 * alla mått anges som andel av TEXTENS höjd, inte i pixlar och inte i andel
 * av bilden. Texthöjden mäts ur bilden själv.
 *
 * Varje cv.Mat måste städas undan med .delete(). wasm-minnet har ingen
 * skräpsamling -- glömmer man en Mat växer minnet tills telefonen dödar
 * fliken.
 */

const MIN_STRECKLANGD = 1.6;
const MAX_STRECKTJOCKLEK = 0.4;
const MIN_AVLANGDHET = 4.0;
const GLAPPLAGNING = 0.14;
const MAX_STRECKGLAPP = 2.2;
const MAX_BLACK_RUNTOM = 0.15;
const MAX_RELATIV_GRATON = 0.9;
const MIN_PENNGRATON = 0.55;
const MIN_TEXTHOJD = 14;
const MIN_TEXT_OVANFOR = 0.18;
const MIN_STRECKTJOCKLEK = 1.3;
const VIDGNING = 7;

// Lapparna -- se skarUtLapp().
const LAPP_OVAN = 5.5;
const LAPP_NEDAN = 2.5;
const LAPP_MARGINAL = 5.0;
const LAPP_TEXTHOJD = 32;
const TRYCK_SVART = 0.35;
const BLYERTS_VITT = 0.62;

const FOR_LITEN_TEXT =
  "Vid den storleken flyter bokstävernas fötter ihop och koden hittar\n" +
  "hundratals streck som inte finns. Det går inte att rätta i efterhand --\n" +
  "informationen finns inte i bilden.\n\n" +
  "Fotografera EN sida i taget, närmare, så att sidan fyller bilden.";

// --- Småverktyg ------------------------------------------------------------

/** adaptiveThreshold kräver en udda fönsterstorlek. */
function udda(n) {
  return n % 2 === 1 ? n : n + 1;
}

/**
 * Avrundar som Python gör: ett tal mitt emellan två heltal går till det
 * JÄMNA (2.5 -> 2, 3.5 -> 4). JavaScripts Math.round går alltid uppåt
 * (2.5 -> 3). Skillnaden är en enda pixel, men utan den här funktionen ger
 * de två versionerna inte exakt samma svar, och då går det inte längre att
 * testa den ena mot den andra.
 */
function avrunda(x) {
  const n = Math.round(x);
  return Math.abs(x % 1) === 0.5 && n % 2 !== 0 ? n - 1 : n;
}

function median(tal) {
  const sorterad = [...tal].sort((a, b) => a - b);
  const mitt = Math.floor(sorterad.length / 2);
  return sorterad.length % 2
    ? sorterad[mitt]
    : (sorterad[mitt - 1] + sorterad[mitt]) / 2;
}

function karna(bredd, hojd) {
  return cv.getStructuringElement(cv.MORPH_RECT, new cv.Size(bredd, hojd));
}

/** Andelen bläck i en rektangel av den binära bilden. */
function andelBlack(bin, bredd, hojd, x, b, y0, y1) {
  const a = Math.max(0, y0);
  const z = Math.min(hojd, y1);
  if (z <= a || b <= 0) return 0;
  let antal = 0;
  for (let y = a; y < z; y++) {
    const rad = y * bredd;
    for (let i = rad + x; i < rad + x + b; i++) {
      if (bin[i] > 0) antal++;
    }
  }
  return antal / ((z - a) * b);
}

// --- Steg 2a: hitta textytan ----------------------------------------------

/**
 * Maskar fram den del av fotot där det står text, och utesluter resten:
 * handen som håller boken, skrivbordet, en bildskärm i bakgrunden. Där finns
 * gott om raka mörka kanter som ser ut som understrykningar.
 *
 * Första versionen letade efter SIDAN: det största ljusa området. Det höll
 * på två foton och föll på nästa tjugo. Står det en tänd bildskärm bakom
 * boken är skärmen ljusare än papperet, och då blev det skärmen som utsågs
 * till sida -- sju foton av tjugo gav noll streck av det skälet.
 *
 * Den här versionen letar efter TEXTEN. En boksida är det enda stället i
 * fotot där hundratals lika stora små klumpar ligger tätt i rader:
 *
 *   1. Plocka ut alla bläckklumpar som är ungefär bokstavsstora.
 *   2. Rita in deras rutor i en liten karta och sudda ut den över ett par
 *      radhöjder. Där det står text blir kartan jämnt grå; en ensam klump i
 *      bakgrunden blir knappt synlig.
 *   3. Behåll de områden som är tillräckligt täta, och av dem bara de stora.
 *
 * Returnerar en ny Mat som anroparen ska delete():a.
 */
function hittaTextytan(binar) {
  const hojd = binar.rows;
  const bredd = binar.cols;
  const allt = () => new cv.Mat(hojd, bredd, cv.CV_8U, new cv.Scalar(255));

  const tillfalliga = [];
  const ny = () => {
    const m = new cv.Mat();
    tillfalliga.push(m);
    return m;
  };
  const etiketter = ny(), statistik = ny(), tyngdpunkter = ny();
  const tathet = ny(), tat = ny(), mask = ny(), stor = ny();

  try {
    const antal = cv.connectedComponentsWithStats(
      binar, etiketter, statistik, tyngdpunkter, 8,
    );

    // Samma grova storleksgränser som i uppskattaTexthojd().
    const rutor = [];
    for (let i = 1; i < antal; i++) {
      const h = statistik.intAt(i, cv.CC_STAT_HEIGHT);
      const b = statistik.intAt(i, cv.CC_STAT_WIDTH);
      if (h < 0.004 * hojd || h > 0.06 * hojd || b > 6 * h) continue;
      rutor.push([
        statistik.intAt(i, cv.CC_STAT_LEFT),
        statistik.intAt(i, cv.CC_STAT_TOP),
        b,
        h,
      ]);
    }
    if (rutor.length < 30) return allt(); // för lite text för att säga något

    // Snäva åt kring den vanligaste storleken. Bokstäverna i en bok är lika
    // stora; skräpet i bakgrunden har alla möjliga storlekar.
    const grov = median(rutor.map((r) => r[3]));

    // Kartan är åtta gånger mindre än fotot. Vi letar efter ett stort
    // område, så detaljerna spelar ingen roll, och det går mycket fortare.
    const S = 8;
    const kh = Math.floor(hojd / S) + 1;
    const kb = Math.floor(bredd / S) + 1;
    const karta = cv.Mat.zeros(kh, kb, cv.CV_8U);
    tillfalliga.push(karta);
    const kd = karta.data;
    for (const [x, y, b, h] of rutor) {
      if (h < 0.5 * grov || h > 2.0 * grov) continue;
      const r1 = Math.min(kh - 1, Math.floor((y + h) / S));
      const k1 = Math.min(kb - 1, Math.floor((x + b) / S));
      for (let r = Math.floor(y / S); r <= r1; r++) {
        for (let k = Math.floor(x / S); k <= k1; k++) kd[r * kb + k] = 255;
      }
    }

    // Medelvärde över tre texthöjder -- lite mer än ett radavstånd, så att
    // mellanrummen mellan raderna jämnas ut. I löpande text täcker
    // bokstävernas rutor ungefär 40 % av ytan; gränsen 15 % ligger långt
    // under det men långt över vad spridda klumpar i bakgrunden når.
    const k = udda(Math.max(3, avrunda((3 * grov) / S)));
    cv.blur(karta, tathet, new cv.Size(k, k));
    cv.threshold(tathet, tat, Math.floor(0.15 * 255), 255, cv.THRESH_BINARY);

    // Bygg ihop stycken som har luft emellan sig: ett blankt radavstånd, en
    // rubrik, eller text satt med dubbelt radavstånd. Annars blir varje rad
    // en egen liten ö, och öarna sållas bort i nästa steg.
    const c = udda(avrunda((8 * grov) / S));
    const stangare = karna(c, c);
    cv.morphologyEx(tat, tat, cv.MORPH_CLOSE, stangare);
    stangare.delete();

    const antalOar = cv.connectedComponentsWithStats(
      tat, etiketter, statistik, tyngdpunkter, 8,
    );
    if (antalOar <= 1) return allt();

    // Behåll det största textblocket och andra som är nästan lika stora (ett
    // uppslag har två sidor). En skylt i bakgrunden är mycket mindre än en
    // boksida och faller bort.
    let storst = 0;
    for (let i = 1; i < antalOar; i++) {
      storst = Math.max(storst, statistik.intAt(i, cv.CC_STAT_AREA));
    }
    const behall = new Uint8Array(antalOar);
    for (let i = 1; i < antalOar; i++) {
      if (statistik.intAt(i, cv.CC_STAT_AREA) >= 0.3 * storst) behall[i] = 1;
    }
    mask.create(kh, kb, cv.CV_8U);
    const etik = etiketter.data32S;
    const md = mask.data;
    for (let i = 0; i < etik.length; i++) md[i] = behall[etik[i]] ? 255 : 0;

    // Väx ut masken ett par texthöjder. Suddningen har rundat av kanterna,
    // och understrykningen under sista raden ligger strax UTANFÖR texten.
    const v = udda(avrunda((4 * grov) / S));
    const vaxare = karna(v, v);
    cv.dilate(mask, mask, vaxare);
    vaxare.delete();

    cv.resize(mask, stor, new cv.Size(bredd, hojd), 0, 0, cv.INTER_NEAREST);
    // Misstänkt litet: hellre leta i hela bilden.
    if (cv.mean(stor)[0] < 0.03 * 255) return allt();
    return stor.clone();
  } finally {
    for (const m of tillfalliga) m.delete();
  }
}

// --- Steg 2b: hur stor är texten? -----------------------------------------

/**
 * Mäter ungefär hur höga bokstäverna är, direkt ur bilden. Allt annat skalas
 * mot det här måttet. Medianen bryr sig inte om att en del klumpar är punkter
 * eller hela sammanslagna ord, så länge de flesta är vanliga bokstäver.
 */
function uppskattaTexthojd(binar) {
  const hojd = binar.rows;
  const etiketter = new cv.Mat();
  const statistik = new cv.Mat();
  const tyngdpunkter = new cv.Mat();
  try {
    const antal = cv.connectedComponentsWithStats(
      binar, etiketter, statistik, tyngdpunkter, 8,
    );
    const hojder = [];
    for (let i = 1; i < antal; i++) {
      const h = statistik.intAt(i, cv.CC_STAT_HEIGHT);
      const b = statistik.intAt(i, cv.CC_STAT_WIDTH);
      if (h < 0.004 * hojd || h > 0.06 * hojd) continue; // brus eller inte bokstav
      if (b > 6 * h) continue; // långt och platt: ett streck
      hojder.push(h);
    }
    // Ingen text hittad. Gissa något rimligt hellre än att krascha.
    return hojder.length ? median(hojder) : Math.max(10, hojd * 0.02);
  } finally {
    etiketter.delete();
    statistik.delete();
    tyngdpunkter.delete();
  }
}

// --- Steg 7: är klumpen blyerts eller tryckt text? ------------------------

/**
 * Formfiltren räcker inte -- serifferna limmas ihop av glapplagningen till
 * något som ser ut som en lång linje. Det finns två OBEROENDE bevis för
 * blyerts, och vilket som av dem duger, för de sviker i olika situationer:
 *
 *   TOMRUM RUNTOM  En understrykning ligger i tomrummet under ordet: 0-4 %
 *                  bläck strax intill, mot 30-38 % för en seriffot.
 *                  Sviker när strecket dras tätt intill bokstäverna.
 *   GRÅTON         Blyerts är ljusare än trycksvärta: uppmätt 0.60 och 0.68
 *                  av papperets ljushet, mot under 0.52 för tryckt text.
 *                  Sviker för en mjuk, mörk penna.
 */
function serUtSomBlyerts(bin, bredd, hojd, x, y0, y1, b, graton, texthojd) {
  if (graton > MAX_RELATIV_GRATON) return false; // en kant eller en skugga

  const black = (a, z) => andelBlack(bin, bredd, hojd, x, b, a, z);

  // En understrykning måste stryka under NÅGOT. Äkta streck har 26-28 % bläck
  // en radhöjd ovanför; en skrivbordskant hade 0.1 % och 12.6 %.
  const ovanforText = black(
    y0 - avrunda(texthojd * 1.7),
    y0 - avrunda(texthojd * 0.15),
  );
  if (ovanforText < MIN_TEXT_OVANFOR) return false;

  if (graton >= MIN_PENNGRATON) return true; // ljusare än tryck: blyerts

  // Annars krävs tomrum runtom. Banden skalas mot texthöjden: i en liten text
  // ligger understrykningen närmare ordet.
  const inre = Math.max(2, avrunda(texthojd * 0.12));
  const yttre = Math.max(6, avrunda(texthojd * 0.38));
  const ovanfor = black(y0 - yttre, y0 - inre);
  const nedanfor = black(y1 + inre, y1 + yttre);
  return Math.max(ovanfor, nedanfor) <= MAX_BLACK_RUNTOM;
}

// --- Steg 8: laga sönderbrutna streck -------------------------------------

/**
 * Ett blyertsstreck släpper ibland helt mot papperets struktur, och glappet
 * kan vara större än glapplagningen klarar. Att laga det efteråt är säkrare
 * än att öka lagningen -- den här sammanslagningen rör bara sådant som redan
 * godkänts som blyerts.
 *
 * "Samma höjd" mäts som glappet mellan bitarnas över- och underkanter, inte
 * mellan deras mittpunkter. Ett handdraget streck är ofta en båge, och då
 * ligger ändbiten högre än mittbiten fast de sitter ihop.
 */
function slaIhopNarliggande(streck, texthojd) {
  const mittY = (s) => s.y + Math.floor(s.tjocklek / 2);
  const hoger = (s) => s.x + s.bredd;

  const resultat = [];
  const sorterad = [...streck].sort((a, b) => mittY(a) - mittY(b) || a.x - b.x);

  for (const s of sorterad) {
    let slogsIhop = false;
    for (let i = 0; i < resultat.length; i++) {
      const r = resultat[i];
      const lodrattGlapp =
        Math.max(r.y, s.y) - Math.min(r.y + r.tjocklek, s.y + s.tjocklek);
      if (lodrattGlapp > texthojd * 0.45) continue;
      const vagrattGlapp = Math.max(r.x, s.x) - Math.min(hoger(r), hoger(s));
      if (vagrattGlapp > texthojd * MAX_STRECKGLAPP) continue;
      resultat[i] = {
        x: Math.min(r.x, s.x),
        y: Math.min(r.y, s.y),
        bredd: Math.max(hoger(r), hoger(s)) - Math.min(r.x, s.x),
        tjocklek:
          Math.max(r.y + r.tjocklek, s.y + s.tjocklek) - Math.min(r.y, s.y),
      };
      slogsIhop = true;
      break;
    }
    if (!slogsIhop) resultat.push({ ...s });
  }
  return resultat;
}

// --- Steg 9: hur lutar strecket? ------------------------------------------

/**
 * Passar en rät linje till streckets pixlar och ger dess lutning: pixlar
 * nedåt per pixel åt höger. Strecket följer textraden, så lutningen säger
 * hur snett fotot är just här. (Minsta kvadratmetoden -- samma sak som
 * numpy.polyfit gör i Python-versionen.)
 */
function matLutning(mask, bredd, s) {
  let n = 0, sx = 0, sy = 0, sxx = 0, sxy = 0;
  for (let rad = 0; rad < s.tjocklek; rad++) {
    const bas = (s.y + rad) * bredd + s.x;
    for (let kol = 0; kol < s.bredd; kol++) {
      if (!mask[bas + kol]) continue;
      n++;
      sx += kol;
      sy += rad;
      sxx += kol * kol;
      sxy += kol * rad;
    }
  }
  const namnare = n * sxx - sx * sx;
  return n >= 2 && namnare !== 0 ? (n * sxy - sx * sy) / namnare : 0;
}

// --- Steg 10: klipp ut en lapp runt strecket ------------------------------

/**
 * Skär ut området runt ett streck och gör det lättläst för Tesseract.
 *
 * Första versionen lät Tesseract läsa HELA fotot. Det höll på två provfoton.
 * På tjugo nya, tagna med boken i handen framför en bildskärm, läste
 * Tesseract noll ord på nio av dem: dess sidanalys utgår från en inskannad
 * sida och går vilse bland fingrar, bordskant och skärm.
 *
 * En lapp runt strecket innehåller bara text. Fyra saker görs med den:
 *
 *   1. VRIDS så att strecket ligger vågrätt. Strecket följer textraden, så
 *      då blir raden också vågrät, hur snett boken än hölls.
 *   2. SKALAS så att texten får den höjd Tesseract läser bäst.
 *   3. Strecket SUDDAS. Annars läses det som understreck mitt i ordet --
 *      "allom" blev "acl_lgg_n_".
 *   4. Gråskalan DRAS ISÄR så att blyerts blir vitt och tryck svart. Det tar
 *      de delar av strecket som detekteringen missade.
 *
 * Lappen returneras som RGBA-pixlar, så att huvudtråden kan lägga den rakt
 * på en canvas -- både för att läsa den och för att visa den.
 */
function skarUtLapp(rel8, streckmask, s, texthojd) {
  const skala = Math.min(3.0, Math.max(0.5, LAPP_TEXTHOJD / texthojd));
  const vinkel = (Math.atan(s.lutning) * 180) / Math.PI;
  const cx = s.x + s.bredd / 2;
  const cy = s.y + s.tjocklek / 2;

  const bredd = avrunda((s.bredd + 2 * LAPP_MARGINAL * texthojd) * skala);
  const hojd = avrunda((LAPP_OVAN + LAPP_NEDAN) * texthojd * skala);
  const streckY = LAPP_OVAN * texthojd * skala;

  // En "affin avbildning" är en 2x3-matris som beskriver vridning, skalning
  // och förflyttning i ett svep. getRotationMatrix2D ger vridning + skalning
  // runt streckets mitt; de två raderna därefter flyttar streckets mitt
  // till rätt ställe i lappen.
  const M = cv.getRotationMatrix2D(new cv.Point(cx, cy), vinkel, skala);
  M.data64F[2] += bredd / 2 - cx;
  M.data64F[5] += streckY - cy;

  const bild = new cv.Mat();
  const mask = new cv.Mat();
  try {
    const storlek = new cv.Size(bredd, hojd);
    cv.warpAffine(
      rel8, bild, M, storlek,
      cv.INTER_CUBIC, cv.BORDER_CONSTANT, new cv.Scalar(255), // utanför: vitt
    );
    cv.warpAffine(
      streckmask, mask, M, storlek,
      cv.INTER_LINEAR, cv.BORDER_CONSTANT, new cv.Scalar(0),
    );

    // Låt masken växa en aning, så att streckets gråa kanter kommer med.
    const k = udda(Math.max(3, avrunda(texthojd * skala * 0.12)));
    const rund = cv.getStructuringElement(cv.MORPH_ELLIPSE, new cv.Size(k, k));
    cv.dilate(mask, mask, rund);
    rund.delete();

    // Sudda strecket och dra isär gråskalan, pixel för pixel. Math.fround
    // räknar med samma precision som numpy gör i Python-versionen.
    const b = bild.data;
    const m = mask.data;
    const svart = Math.fround(TRYCK_SVART);
    const spann = Math.fround(BLYERTS_VITT - TRYCK_SVART);
    const rgba = new Uint8ClampedArray(bredd * hojd * 4);
    for (let i = 0; i < bredd * hojd; i++) {
      const ljushet = m[i] > 40 ? 255 : b[i];
      let f = Math.fround(Math.fround(Math.fround(ljushet / 255) - svart) / spann);
      f = Math.min(1, Math.max(0, f));
      const v = Math.floor(Math.fround(f * 255));
      rgba[4 * i] = v;
      rgba[4 * i + 1] = v;
      rgba[4 * i + 2] = v;
      rgba[4 * i + 3] = 255;
    }

    const x0 = LAPP_MARGINAL * texthojd * skala;
    return {
      bredd,
      hojd,
      rgba,
      x0, // streckets vänsterkant, i lappens koordinater
      x1: x0 + s.bredd * skala,
      y: streckY, // streckets mitt
      texthojd: texthojd * skala,
      skala, // lappens pixlar per fotopixel
    };
  } finally {
    M.delete();
    bild.delete();
    mask.delete();
  }
}

// --- Hela kedjan ----------------------------------------------------------

/**
 * Letar upp understrykningarna i en ImageData och klipper ut en lapp runt
 * var och en. Kastar {forLitenText: true} om texten är för liten.
 */
function korPipeline(bilddata, tvinga) {
  const info = {};
  const tillfalliga = [];
  const ny = () => {
    const m = new cv.Mat();
    tillfalliga.push(m);
    return m;
  };

  const kalla = cv.matFromImageData(bilddata);
  tillfalliga.push(kalla);
  const gra = ny(), binar = ny(), lagad = ny(), sokbild = ny();
  const bakgrund = ny(), etiketter = ny(), statistik = ny(), tyngdpunkter = ny();

  try {
    const hojd = kalla.rows;
    const bredd = kalla.cols;
    info.bildstorlek = [bredd, hojd];

    // 1. Till gråskala. Färgen hjälper oss inte med blyerts.
    cv.cvtColor(kalla, gra, cv.COLOR_RGBA2GRAY);

    // 2. Adaptiv tröskel: gränsen mellan mörkt och ljust räknas ut LOKALT,
    //    eftersom ett foto av en bok nästan alltid har en ljusgradient.
    const fonster = udda(Math.max(15, avrunda(bredd * 0.02)));
    cv.adaptiveThreshold(
      gra, binar, 255,
      cv.ADAPTIVE_THRESH_GAUSSIAN_C,
      cv.THRESH_BINARY_INV, // text blir vit på svart
      fonster, 10,
    );

    // 2a. Hitta textytan och strunta i resten av fotot. Allt utanför nollas
    //     här, en gång.
    const sidmask = hittaTextytan(binar);
    tillfalliga.push(sidmask);
    info.sidmask_andel = cv.mean(sidmask)[0] / 255;
    cv.bitwise_and(binar, sidmask, binar);

    // 2b. Mät texten. Allt nedan skalas mot det här måttet.
    const texthojd = uppskattaTexthojd(binar);
    info.texthojd = texthojd;
    if (texthojd < MIN_TEXTHOJD && !tvinga) {
      const fel = new Error(
        `Texten i bilden är för liten: ${Math.round(texthojd)} pixlar hög, ` +
          `minst ${MIN_TEXTHOJD} behövs.\n\n${FOR_LITEN_TEXT}`,
      );
      fel.forLitenText = true;
      throw fel;
    }

    // 3. Laga glappen i ett ojämnt penndrag.
    const lagning = Math.max(3, avrunda(texthojd * GLAPPLAGNING));
    info.lagning = lagning;
    const lagKarna = karna(lagning, 1);
    cv.morphologyEx(binar, lagad, cv.MORPH_CLOSE, lagKarna);
    lagKarna.delete();

    // 4. Vidga LODRÄTT före öppningen. Ett frihandsstreck är böjt och stannar
    //    inte i samma pixelrad: uppmätt 29 px längsta obrutna löpa i en rad,
    //    fast strecket var 184 px långt. Vidgningen överbryggar inga vågräta
    //    glapp, så bokstäver limmas inte ihop.
    const vidgKarna = karna(1, VIDGNING);
    cv.dilate(lagad, sokbild, vidgKarna);
    vidgKarna.delete();

    // 5. Kärnan i metoden: öppning med en LÅNG vågrät kärna behåller bara det
    //    som har så många mörka pixlar i obruten följd. Bokstäver dör här.
    const minLangd = Math.max(20, avrunda(texthojd * MIN_STRECKLANGD));
    info.min_langd = minLangd;
    const langKarna = karna(minLangd, 1);
    cv.morphologyEx(sokbild, sokbild, cv.MORPH_OPEN, langKarna);
    langKarna.delete();

    // 6. Normalisera bort ljusgradienten, så att vi kan mäta hur mörkt något
    //    är JÄMFÖRT MED PAPPERET bredvid.
    const storKarna = karna(51, 51);
    cv.morphologyEx(gra, bakgrund, cv.MORPH_CLOSE, storKarna);
    storKarna.delete();

    const graData = gra.data;
    const bakData = bakgrund.data;
    const relativ = new Float32Array(graData.length);
    for (let i = 0; i < graData.length; i++) {
      relativ[i] = graData[i] / Math.max(bakData[i], 1);
    }

    // 7. Sålla klumparna.
    const antal = cv.connectedComponentsWithStats(
      sokbild, etiketter, statistik, tyngdpunkter, 8,
    );
    const maxTjocklek = Math.max(4, texthojd * MAX_STRECKTJOCKLEK);
    info.max_tjocklek = maxTjocklek;

    const etik = etiketter.data32S;
    const bin = binar.data;
    const streck = [];
    // Alla godkända strecks pixlar. Lapparna behöver dem för att kunna
    // sudda bort strecket innan ordet läses.
    const streckmask = new Uint8Array(bredd * hojd);

    for (let i = 1; i < antal; i++) {
      const x = statistik.intAt(i, cv.CC_STAT_LEFT);
      const y = statistik.intAt(i, cv.CC_STAT_TOP);
      const b = statistik.intAt(i, cv.CC_STAT_WIDTH);
      const t = statistik.intAt(i, cv.CC_STAT_HEIGHT);
      if (b < minLangd) continue;

      // VIKTIGT: vi LETAR i den vidgade bilden men MÄTER i den ursprungliga.
      // Vidgningen i steg 4 gjorde strecket konstgjort tjockt.
      let yta = 0, y0 = -1, y1 = -1, gratonSumma = 0;
      for (let rad = y; rad < y + t; rad++) {
        const bas = rad * bredd;
        let radHadeBlack = false;
        for (let kol = x; kol < x + b; kol++) {
          const p = bas + kol;
          if (etik[p] === i && bin[p] > 0) {
            yta++;
            gratonSumma += relativ[p];
            radHadeBlack = true;
          }
        }
        if (radHadeBlack) {
          if (y0 < 0) y0 = rad;
          y1 = rad + 1;
        }
      }
      if (!yta) continue;

      // Tjockleken mäts som YTA / BREDD, inte som ramens höjd. Ett streck som
      // lutar har en hög ram utan att vara tjockt -- håller man telefonen tre
      // grader snett stiger ett långt streck en bra bit.
      const tjocklek = yta / Math.max(b, 1);
      if (tjocklek < MIN_STRECKTJOCKLEK || tjocklek > maxTjocklek) continue;
      if (b / Math.max(tjocklek, 0.5) < MIN_AVLANGDHET) continue;

      const graton = gratonSumma / yta;
      if (!serUtSomBlyerts(bin, bredd, hojd, x, y0, y1, b, graton, texthojd)) {
        continue;
      }
      streck.push({ x, y: y0, bredd: b, tjocklek: Math.max(1, y1 - y0) });
      for (let rad = y; rad < y + t; rad++) {
        const bas = rad * bredd;
        for (let kol = x; kol < x + b; kol++) {
          const p = bas + kol;
          if (etik[p] === i && bin[p] > 0) streckmask[p] = 255;
        }
      }
    }

    // 8. Laga ihop sönderbrutna streck och sortera i läsordning.
    const ihop = slaIhopNarliggande(streck, texthojd);
    for (const s of ihop) {
      s.mittY = s.y + Math.floor(s.tjocklek / 2);
      s.hoger = s.x + s.bredd;
    }
    ihop.sort((a, b) => a.mittY - b.mittY || a.x - b.x);

    // 9. Mät hur varje streck lutar.
    for (const s of ihop) s.lutning = matLutning(streckmask, bredd, s);

    // 10. Klipp ut en lapp runt varje streck, färdig att läsa.
    const lappar = [];
    if (ihop.length) {
      // Samma bild som steg["6_relativ"] i bild.py: papperet = 255.
      const rel = new Uint8Array(relativ.length);
      for (let i = 0; i < relativ.length; i++) {
        rel[i] = Math.floor(Math.fround(Math.min(1, relativ[i]) * 255));
      }
      const rel8 = cv.matFromArray(hojd, bredd, cv.CV_8UC1, rel);
      const maskMat = cv.matFromArray(hojd, bredd, cv.CV_8UC1, streckmask);
      tillfalliga.push(rel8, maskMat);
      for (const s of ihop) lappar.push(skarUtLapp(rel8, maskMat, s, texthojd));
    }

    return { streck: ihop, info, lappar };
  } finally {
    for (const m of tillfalliga) m.delete();
  }
}

self.korPipeline = korPipeline;
