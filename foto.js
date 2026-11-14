/* Hela kedjan: foto in -> understrukna ord ut.
 *
 * Motsvarar hitta_understrukna_ord() och foga_ihop_avstavade() i bild.py och
 * las_ord_ur_foto() i main.py. Det här är den enda fil gränssnittet behöver
 * känna till för att läsa ett foto; bild.js (strecken) och ocr.js (texten) är
 * dess två händer.
 */

import { hittaStreck, ordVidStreck, forbered } from "./bild.js";
import { ocrOrd, forberedOcr } from "./ocr.js";

/**
 * Värmer upp båda motorerna -- OpenCV för strecken och Tesseract för texten.
 * Anropas när appen öppnas, så att väntan är över innan fotot är taget.
 * De två startar samtidigt; de kör i var sin tråd och stör inte varandra.
 */
export function forberedAllt(sprak = "swe", pavag = null) {
  return Promise.all([forbered(), forberedOcr(sprak, pavag)]);
}

/**
 * Letar upp strecken och läser ordet vid vart och ett.
 *
 * Texten läses inte ur hela fotot utan ur en liten lapp runt varje streck
 * (se skarUtLapp() i bildkarna.js för varför). Det är både säkrare och
 * snabbare: en lapp tar en bråkdel av tiden för en hel sida.
 *
 * @returns {Promise<{par: Array<{streck, ord, lapp}>, info}>}
 *          par   ett element per understrykning:
 *                  streck  var i fotot den ligger
 *                  ord     ordrutorna som hör till den, i lappens koordinater
 *                  lapp    utklippet (lapp.duk är en canvas som går att visa)
 *          info  måtten från streckdetekteringen (för felsökning)
 */
export async function hittaUnderstruknaOrd(
  duk,
  { sprak = "swe", tvinga = false, pavag = null } = {},
) {
  const { streck, info, lappar } = await hittaStreck(duk, { tvinga, pavag });

  const par = [];
  for (let i = 0; i < streck.length; i++) {
    const lapp = lappar[i];
    const lasta = await ocrOrd(lapp.duk, { sprak, ettBlock: true, pavag });
    // Inte ett enda läsbart ord i hela lappen: då var det ingen
    // understrykning, utan ett veck i papperet eller en skugga.
    if (!lasta.length) continue;
    par.push({ streck: streck[i], ord: ordVidStreck(lapp, lasta), lapp });
  }
  return { par, info };
}

/**
 * Gör om träffarna till ren text, och fogar ihop avstavade ord.
 *
 * Står ett understruket ord sist på raden och är avstavat -- "lansiä-" -- så
 * är fortsättningen "rer" understruken för sig, i början av nästa rad. Utan
 * det här steget skulle det bli två kort, båda för ord som inte finns.
 *
 * Fortsättningen är det streck som ligger längst till vänster bland dem
 * strax nedanför. Att leta efter "raden under" duger inte: håller man boken
 * snett ligger början av nästa rad flera radhöjder längre ned än slutet av
 * den förra.
 *
 * @returns {Array<{streck, texter: string[], lapp}>}
 */
export function fogaIhopAvstavade(par) {
  const texter = par.map((p) => p.ord.map((o) => o.text));

  par.forEach((p, i) => {
    const sista = p.ord[p.ord.length - 1];
    if (!sista || !sista.avstavat) return;
    // Ordets höjd räknat i FOTOTS pixlar; lappen är omskalad.
    const hojd = sista.hojd / p.lapp.skala;
    const s = p.streck;

    const kandidater = [];
    par.forEach((p2, j) => {
      const nedanfor = p2.streck.mittY - s.mittY;
      if (
        j !== i && texter[j].length &&
        nedanfor > 0.5 * hojd && nedanfor < 6 * hojd &&
        p2.streck.x < s.x
      ) {
        kandidater.push(j);
      }
    });
    if (!kandidater.length) return;

    const vanstrast = Math.min(...kandidater.map((j) => par[j].streck.x));
    const naraKanten = kandidater.filter(
      (j) => par[j].streck.x - vanstrast <= 2 * hojd,
    );
    const j = naraKanten.reduce((a, b) =>
      par[b].streck.mittY < par[a].streck.mittY ? b : a,
    );
    texter[i][texter[i].length - 1] += texter[j].shift();
  });

  // Ett streck som hade ord men blev av med dem har gått åt till ett
  // avstavat ord på raden ovanför. Det ska inte synas som "oläst".
  return par
    .map((p, i) => ({ streck: p.streck, texter: texter[i], lapp: p.lapp }))
    .filter((p, i) => p.texter.length || !par[i].ord.length);
}

/**
 * Läser ett foto och ger de understrukna orden som en enkel lista, i
 * läsordning och utan dubbletter.
 *
 * @returns {Promise<{ord: string[], olasta: Array, antalStreck: number, par}>}
 *          ord         orden som ska slås upp
 *          olasta      streck där inget ord gick att läsa -- så att
 *                      gränssnittet kan säga det, i stället för att tiga
 *          antalStreck hur många understrykningar som hittades
 *          par         allt i detalj, med lapparna (för att visa dem)
 */
export async function lasOrdUrFoto(duk, val = {}) {
  const { par } = await hittaUnderstruknaOrd(duk, val);
  const hopfogade = fogaIhopAvstavade(par);

  const ord = [];
  const sedda = new Set();
  const olasta = [];

  for (const { streck, texter } of hopfogade) {
    // Enstaka tecken är nästan alltid skräp ur ett streck, inte ord.
    const lasta = texter.filter((o) => o.length > 1);
    if (!lasta.length) {
      olasta.push(streck);
      continue;
    }
    for (const o of lasta) {
      // Samma ord kan vara understruket flera gånger på en sida.
      const nyckel = o.toLowerCase();
      if (!sedda.has(nyckel)) {
        sedda.add(nyckel);
        ord.push(o);
      }
    }
  }
  return { ord, olasta, antalStreck: hopfogade.length, par: hopfogade };
}

/**
 * Håller reda på vilka ord som redan är omhändertagna, över flera foton.
 *
 * Samma ord kan dyka upp två gånger på två sätt, och de går inte att
 * upptäcka samtidigt:
 *
 *   1. Samma ORD, bokstav för bokstav -- samma sida fotad två gånger. Syns
 *      direkt när fotot är läst. Fråga nyttOrd() innan ordet slås upp, så
 *      slipper vi fråga Språkbanken i onödan.
 *   2. Samma GRUNDFORM -- "lansiärer" på ett foto och "lansiär" på ett annat
 *      blir samma kort. Syns först när båda har slagits upp. Fråga
 *      nyGrundform() innan kortet läggs till.
 *
 * Båda metoderna svarar true första gången och false därefter.
 */
export class Ordsamling {
  #ord = new Set();
  #grundformer = new Set();

  nyttOrd(ord) {
    return Ordsamling.#lagg(this.#ord, ord);
  }

  nyGrundform(grundform) {
    return Ordsamling.#lagg(this.#grundformer, grundform);
  }

  static #lagg(mangd, text) {
    const nyckel = text.trim().toLowerCase();
    if (!nyckel || mangd.has(nyckel)) return false;
    mangd.add(nyckel);
    return true;
  }
}
