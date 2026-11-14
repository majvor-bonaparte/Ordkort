/* Appen: foto in, Anki-fil ut.
 *
 * Den här filen är bara gränssnittet. Allt riktigt arbete görs av modulerna
 * som redan är testade mot Python-versionen:
 *
 *   foto.js         foto -> understrukna ord (bild.js + ocr.js)
 *   sprakbanken.js  ord -> uppslag (grundform, synonymer, meningar)
 *   kort.js         uppslag -> kortets fram- och baksida
 *   apkg.js         kort -> en .apkg-fil som Anki kan importera
 *
 * Modellen är enkel: en lista FOTON, och i varje foto en lista ORD. Varje
 * ord har en kortlek, en kryssruta och ett uppslag. rita() går igenom allt
 * och ställer gränssnittet i ordning efter varje ändring -- det är några
 * tiotal ord som mest, så det är billigare än att hålla reda på exakt vad
 * som ändrats.
 */

import { lasBild, BildFel } from "./bild.js";
import { lasOrdUrFoto, forberedAllt } from "./foto.js";
import { slaUpp, hittades, SprakbankenFel } from "./sprakbanken.js";
import { byggKort } from "./kort.js";
import { byggPaket, sparaPaket, KORT_CSS } from "./apkg.js";

// --- Minnet i webbläsaren --------------------------------------------------
//
// localStorage kan saknas eller vägra (privat läge, avstängd lagring). Appen
// ska fungera ändå -- den glömmer bara mellan gångerna.

const NYCKEL_LEKAR = "ordkort.kortlekar";
const NYCKEL_SENASTE = "ordkort.senasteLek";
const NYCKEL_SKICKADE = "ordkort.skickade";

function lasMinne(nyckel, reserv) {
  try {
    const text = localStorage.getItem(nyckel);
    return text === null ? reserv : JSON.parse(text);
  } catch {
    return reserv;
  }
}

function sparaMinne(nyckel, varde) {
  try {
    localStorage.setItem(nyckel, JSON.stringify(varde));
  } catch {
    /* lagringen är avstängd -- inget att göra åt */
  }
}

// --- Tillståndet -----------------------------------------------------------

/** Kortlekarna appen känner till, i den ordning de skapades. */
let lekar = lasMinne(NYCKEL_LEKAR, ["Ordkort"]);
if (!Array.isArray(lekar) || !lekar.length) lekar = ["Ordkort"];

/** Ord som redan gått iväg till Anki: grundform -> {datum, kortlek}. */
const skickade = lasMinne(NYCKEL_SKICKADE, {});

/** Fotona, i den ordning de lades till. */
const foton = [];
let nastaId = 1;

/** Sant medan Anki-filen byggs, så att knappen inte trycks två gånger. */
let byggerFil = false;

// --- Små verktyg -----------------------------------------------------------

/** Skapar ett element: el("button", {class: "x"}, "text", barn, ...). */
function el(tagg, egenskaper = {}, ...barn) {
  const e = document.createElement(tagg);
  for (const [namn, varde] of Object.entries(egenskaper)) {
    if (varde === false || varde == null) continue;
    if (namn === "class") e.className = varde;
    else if (namn.startsWith("on")) e.addEventListener(namn.slice(2), varde);
    else if (varde === true) e.setAttribute(namn, "");
    else e.setAttribute(namn, varde);
  }
  e.append(...barn.filter((b) => b != null && b !== false));
  return e;
}

const nyckel = (ord) => ord.trim().toLowerCase();

const datumText = (iso) =>
  new Date(iso).toLocaleDateString("sv-SE", { day: "numeric", month: "short" });

/**
 * Kör högst `max` jobb samtidigt. Språkbanken är en gratistjänst; att skicka
 * tjugo uppslag på en gång vore ohövligt, och telefonens nät blir inte
 * snabbare av det.
 */
function begransare(max) {
  let aktiva = 0;
  const ko = [];
  const nasta = () => {
    if (aktiva >= max || !ko.length) return;
    aktiva++;
    const { jobb, klar, fel } = ko.shift();
    jobb()
      .then(klar, fel)
      .finally(() => {
        aktiva--;
        nasta();
      });
  };
  return (jobb) =>
    new Promise((klar, fel) => {
      ko.push({ jobb, klar, fel });
      nasta();
    });
}
const iKo = begransare(2);

// --- Kortlekar -------------------------------------------------------------

const NY_LEK = "\u0000ny";

/** Alla <select> för kortlekar som finns på sidan just nu. */
const valjare = new Set();

/**
 * Städar ett kortleksnamn. Anki delar upp på "::", så tomma led ("A::::B")
 * och blanksteg runt leden ger konstiga kortlekar. Citattecken krånglar till
 * Ankis sökningar och tas bort.
 */
function stadaLeknamn(text) {
  return text
    .replaceAll('"', "")
    .split("::")
    .map((led) => led.trim().replace(/\s+/g, " "))
    .filter(Boolean)
    .join("::");
}

function laggTillLek(namn) {
  if (!lekar.includes(namn)) {
    lekar.push(namn);
    sparaMinne(NYCKEL_LEKAR, lekar);
  }
  for (const s of valjare) fyllLekar(s);
}

function fyllLekar(select) {
  const varde = select.value;
  select.replaceChildren(
    ...lekar.map((namn) => new Option(namn, namn)),
    new Option("+ Ny kortlek …", NY_LEK),
  );
  if (lekar.includes(varde)) select.value = varde;
}

/**
 * En kortleksväljare: en lista, plus ett fält för att skapa en ny kortlek
 * som visas när man väljer "+ Ny kortlek …".
 *
 * @param start       kortleken som är vald från början
 * @param vidAndring  anropas med det nya namnet när användaren byter
 */
function lekValjare(start, vidAndring, etikett = "Kortlek") {
  if (!lekar.includes(start)) laggTillLek(start);

  const select = el("select", { "aria-label": etikett });
  const falt = el("input", {
    type: "text",
    placeholder: "Namn på den nya kortleken",
    "aria-label": "Namn på den nya kortleken",
    autocapitalize: "sentences",
  });
  const nyRad = el("div", { class: "nylek", hidden: true }, falt);
  const ram = el("div", { class: "lekvaljare" }, select, nyRad);

  valjare.add(select);
  fyllLekar(select);
  select.value = start;
  let forra = start;

  const skapa = () => {
    const namn = stadaLeknamn(falt.value);
    if (!namn) {
      falt.focus();
      return;
    }
    laggTillLek(namn);
    select.value = namn;
    forra = namn;
    nyRad.hidden = true;
    vidAndring(namn);
  };
  const avbryt = () => {
    nyRad.hidden = true;
    select.value = forra;
  };

  nyRad.append(
    el("button", { type: "button", onclick: skapa }, "Skapa"),
    el("button", { type: "button", class: "lank", onclick: avbryt }, "Avbryt"),
  );
  select.addEventListener("change", () => {
    if (select.value === NY_LEK) {
      nyRad.hidden = false;
      falt.value = "";
      falt.focus();
      return;
    }
    forra = select.value;
    vidAndring(forra);
  });
  falt.addEventListener("keydown", (h) => {
    if (h.key === "Enter") {
      h.preventDefault();
      skapa();
    } else if (h.key === "Escape") {
      avbryt();
    }
  });

  return {
    ram,
    satt(namn) {
      select.value = namn;
      forra = namn;
    },
    glom() {
      valjare.delete(select);
    },
  };
}

// Den stora väljaren högst upp: vilken kortlek nästa foto hamnar i.
let aktuellLek = lasMinne(NYCKEL_SENASTE, lekar[0]);
if (typeof aktuellLek !== "string" || !aktuellLek) aktuellLek = lekar[0];
const huvudlek = lekValjare(
  aktuellLek,
  (namn) => {
    aktuellLek = namn;
    sparaMinne(NYCKEL_SENASTE, namn);
  },
  "Kortlek för nästa foto",
);
document.getElementById("huvudlek").append(huvudlek.ram);

// --- Ett ord ---------------------------------------------------------------

/**
 * Skapar ett ord i ett foto. `lapp` är utklippet runt understrykningen (en
 * canvas), eller null för ord som skrivits in för hand.
 */
function nyttOrd(foto, text, lapp = null) {
  const ord = {
    id: nastaId++,
    foto,
    text,
    lapp,
    kortlek: foto.kortlek,
    egenLek: false, // har användaren valt kortlek för just det här ordet?
    med: true,
    rortKrysset: false, // har användaren själv klickat i rutan?
    status: text ? "vantar" : "tom",
    uppslag: null,
    felText: "",
    skickadI: null, // filnamnet, när ordet gått iväg i den här omgången
    forsok: 0, // räknas upp vid varje nytt uppslag, så att gamla svar kan ignoreras
  };
  foto.ord.push(ord);
  byggOrdVy(ord);
  if (text) slaUppOrd(ord);
  return ord;
}

function byggOrdVy(ord) {
  const v = {};
  v.krysset = el("input", {
    type: "checkbox",
    "aria-label": "Ta med ordet",
    onchange: () => {
      ord.med = v.krysset.checked;
      ord.rortKrysset = true;
      rita();
    },
  });
  v.text = el("input", {
    type: "text",
    class: "ordtext",
    value: ord.text,
    autocapitalize: "none",
    spellcheck: "false",
    "aria-label": "Ordet",
    placeholder: "Skriv ordet",
  });
  // "change" kommer när fältet lämnas eller Enter trycks -- inte vid varje
  // tangent. Annars skulle vi fråga Språkbanken om "f", "fr", "fra" ...
  v.text.addEventListener("change", () => {
    const nytt = v.text.value.trim();
    if (nytt === ord.text) return;
    ord.text = nytt;
    if (!ord.rortKrysset) ord.med = true;
    if (nytt) slaUppOrd(ord);
    else {
      ord.status = "tom";
      ord.uppslag = null;
      rita();
    }
  });
  v.text.addEventListener("keydown", (h) => {
    if (h.key === "Enter") v.text.blur();
  });

  v.status = el("p", { class: "ordstatus" });
  v.kortvy = el("div", { class: "kortvy" });
  v.forhand = el(
    "details",
    { class: "forhand", hidden: true },
    el("summary", {}, "Visa kortet"),
    v.kortvy,
  );
  v.lek = lekValjare(ord.kortlek, (namn) => {
    ord.kortlek = namn;
    ord.egenLek = true;
    rita();
  });
  v.igen = el(
    "button",
    { type: "button", class: "lank", hidden: true, onclick: () => slaUppOrd(ord) },
    "Försök igen",
  );
  v.bort = el(
    "button",
    { type: "button", class: "lank", onclick: () => taBortOrd(ord) },
    "Ta bort",
  );

  v.rot = el(
    "article",
    { class: "ord" },
    ord.lapp,
    el("div", { class: "ordrad" }, el("label", { class: "med" }, v.krysset), v.text),
    v.status,
    v.forhand,
    el(
      "div",
      { class: "ordfot" },
      v.lek.ram,
      el("div", { class: "ordknappar" }, v.igen, v.bort),
    ),
  );
  if (ord.lapp) ord.lapp.classList.add("lapp");
  ord.vy = v;
  ord.foto.vy.lista.append(v.rot);
}

async function slaUppOrd(ord) {
  const forsok = ++ord.forsok;
  ord.status = "slar-upp";
  ord.felText = "";
  rita();

  try {
    const { uppslag } = await iKo(() => slaUpp(ord.text, { antalExempel: 3 }));
    if (forsok !== ord.forsok) return; // ordet ändrades medan vi väntade
    ord.uppslag = uppslag;
    ord.status = hittades(uppslag) ? "klar" : "ingenting";

    // Gick ordet redan till Anki en tidigare gång? Då är rutan urkryssad
    // från början -- men bara om användaren inte själv bestämt något.
    if (!ord.rortKrysset) {
      ord.med = ord.status === "klar" && !skickade[nyckel(uppslag.ord)];
    }
  } catch (fel) {
    if (forsok !== ord.forsok) return;
    ord.status = "fel";
    ord.felText =
      fel instanceof SprakbankenFel
        ? fel.message
        : `Något gick fel: ${fel?.message || fel}`;
  }
  rita();
}

function taBortOrd(ord) {
  const lista = ord.foto.ord;
  lista.splice(lista.indexOf(ord), 1);
  ord.forsok++; // ett pågående uppslag ska inte väcka det till liv igen
  ord.vy.lek.glom();
  ord.vy.rot.remove();
  if (!lista.length && ord.foto.klar) taBortFoto(ord.foto);
  rita();
}

/** Kortet, så som det kommer att se ut i Anki. */
function visaKort(ord) {
  const v = ord.vy;
  if (v.visat === ord.uppslag) return;
  v.visat = ord.uppslag;
  // Shadow DOM: kortets egen CSS (samma som i Anki) får inte läcka ut och
  // ändra appen, och appens CSS får inte ändra kortet.
  const rot = v.kortvy.shadowRoot || v.kortvy.attachShadow({ mode: "open" });
  const [fram, bak] = byggKort(ord.uppslag);
  rot.innerHTML =
    `<style>${KORT_CSS}\n.card{border-radius:8px;border:1px solid #ddd}` +
    `hr{border:0;border-top:1px solid #ddd;margin:1em 0}</style>` +
    `<div class="card">${fram}<hr>${bak}</div>`;
}

// --- Ett foto --------------------------------------------------------------

function nyttFoto(titel, underrubrik = "") {
  const foto = {
    id: nastaId++,
    titel,
    kortlek: aktuellLek,
    ord: [],
    klar: false,
    status: "",
    statusFel: false,
  };
  const v = {};
  v.status = el("p", { class: "foto-status" });
  v.lista = el("div", {});
  v.lek = lekValjare(
    foto.kortlek,
    (namn) => {
      foto.kortlek = namn;
      // Ord som fått en egen kortlek behåller den; resten följer med.
      for (const ord of foto.ord) {
        if (!ord.egenLek) {
          ord.kortlek = namn;
          ord.vy.lek.satt(namn);
        }
      }
      rita();
    },
    "Kortlek för hela fotot",
  );
  v.rot = el(
    "section",
    { class: "panel foto" },
    el(
      "div",
      { class: "foto-huvud" },
      el(
        "div",
        { class: "foto-titelrad" },
        el("h2", { class: "foto-titel" }, titel),
        el(
          "button",
          { type: "button", class: "lank", onclick: () => taBortFoto(foto) },
          "Ta bort",
        ),
      ),
      underrubrik ? el("p", { class: "foto-status" }, underrubrik) : null,
      el("div", { class: "lekrad" }, el("span", {}, "Kortlek"), v.lek.ram),
      v.status,
    ),
    v.lista,
  );
  foto.vy = v;
  foton.push(foto);
  document.getElementById("foton").prepend(v.rot);
  return foto;
}

function taBortFoto(foto) {
  foton.splice(foton.indexOf(foto), 1);
  for (const ord of foto.ord) {
    ord.forsok++;
    ord.vy.lek.glom();
  }
  foto.vy.lek.glom();
  foto.vy.rot.remove();
  rita();
}

/** Ritar en tunn röd linje där strecket låg, så att man ser vad som lästes. */
function markeraStreck(lapp) {
  const r = lapp.duk.getContext("2d");
  r.strokeStyle = "rgba(200, 40, 40, 0.8)";
  r.lineWidth = Math.max(2, lapp.texthojd * 0.08);
  r.beginPath();
  r.moveTo(lapp.x0, lapp.y);
  r.lineTo(lapp.x1, lapp.y);
  r.stroke();
}

function kopieraDuk(duk) {
  const kopia = el("canvas", { width: duk.width, height: duk.height });
  kopia.getContext("2d").drawImage(duk, 0, 0);
  return kopia;
}

async function behandlaFoto(fil, nummer) {
  const tid = new Date().toLocaleTimeString("sv-SE", { hour: "2-digit", minute: "2-digit" });
  const foto = nyttFoto(`Foto ${nummer}`, `${fil.name || "kamera"} · ${tid}`);
  const status = (text, fel = false) => {
    foto.status = text;
    foto.statusFel = fel;
    rita();
  };

  try {
    status("Läser in bilden …");
    const duk = await lasBild(fil);
    status("Letar efter understrykningar …");
    const svar = await lasOrdUrFoto(duk, {
      pavag: (m) => {
        if (!m.vad) return;
        const andel = typeof m.andel === "number" && m.andel > 0 && m.andel < 1
          ? ` ${Math.round(m.andel * 100)} %` : "";
        status(`${m.vad[0].toUpperCase()}${m.vad.slice(1)}${andel} …`);
      },
    });

    for (const { texter, lapp } of svar.par) {
      markeraStreck(lapp);
      const lasta = texter.filter((t) => t.length > 1);
      if (!lasta.length) {
        // Strecket finns men ordet gick inte att läsa. Visa utklippet ändå,
        // så kan ordet skrivas in för hand.
        nyttOrd(foto, "", lapp.duk);
        continue;
      }
      lasta.forEach((text, i) => nyttOrd(foto, text, i ? kopieraDuk(lapp.duk) : lapp.duk));
    }

    const n = foto.ord.length;
    status(
      n === 0
        ? "Hittade inga understrykningar. Fota närmare, så att sidan fyller bilden, " +
            "och se till att strecket syns tydligt."
        : `Hittade ${n} understruk${n === 1 ? "et ord" : "na ord"}.`,
    );
  } catch (fel) {
    const text = fel instanceof BildFel ? fel.message : `Något gick fel: ${fel?.message || fel}`;
    status(text, true);
  } finally {
    foto.klar = true;
    rita();
  }
}

// Fotona läses ett i taget. Läsmotorerna har en tråd var, och två foton
// samtidigt skulle bara slåss om dem -- och om telefonens minne.
let fotoKo = Promise.resolve();
let fotonummer = 0;

function laggTillFoton(filer) {
  for (const fil of filer) {
    const nummer = ++fotonummer;
    fotoKo = fotoKo.then(() => behandlaFoto(fil, nummer));
  }
}

for (const id of ["kamera", "galleri"]) {
  const falt = document.getElementById(id);
  falt.addEventListener("change", () => {
    laggTillFoton([...falt.files]);
    falt.value = ""; // så att samma bild kan väljas igen
  });
}

// Ord som skrivs in för hand hamnar i ett eget "foto" utan bild.
let handfoto = null;
document.getElementById("handord").addEventListener("submit", (h) => {
  h.preventDefault();
  const falt = document.getElementById("handord-text");
  const text = falt.value.trim();
  if (!text) return;
  if (!handfoto || !foton.includes(handfoto)) {
    handfoto = nyttFoto("Inskrivna ord");
    handfoto.klar = true;
  }
  nyttOrd(handfoto, text);
  falt.value = "";
});

// --- Rita om ---------------------------------------------------------------

/**
 * Går igenom alla ord, avgör vilka som är dubbletter, och ställer varje
 * ords vy och summeringen längst ned i ordning.
 *
 * Dubbletter avgörs på GRUNDFORMEN, inte på det som stod i boken: "lansiärer"
 * på ett foto och "lansiär" på ett annat blir samma kort. Det första ordet
 * vinner; de senare visas men tas inte med.
 */
function rita() {
  const sedda = new Map(); // grundform -> första ordet med den
  const iFil = [];

  // Äldsta fotot först, så att det är det först fotade ordet som vinner.
  for (const foto of foton) {
    for (const ord of foto.ord) {
      ord.dubblettAv = null;
      if (ord.status !== "klar") continue;
      const k = nyckel(ord.uppslag.ord);
      if (!ord.med) {
        // Ett ord som redan skickats räknas fortfarande: dess dubbletter
        // längre ned ska inte bli "nya" bara för att originalet gått iväg.
        if (ord.skickadI && !sedda.has(k)) sedda.set(k, ord);
        continue;
      }
      if (sedda.has(k)) {
        ord.dubblettAv = sedda.get(k);
        continue;
      }
      sedda.set(k, ord);
      iFil.push(ord);
    }
  }

  for (const foto of foton) {
    foto.vy.status.textContent = foto.status;
    foto.vy.status.classList.toggle("fel", foto.statusFel);
    for (const ord of foto.ord) ritaOrd(ord);
  }

  document.getElementById("tomt").hidden = foton.length > 0;

  const vantar = foton.flatMap((f) => f.ord).filter((o) => o.status === "slar-upp").length;
  const antalLekar = new Set(iFil.map((o) => o.kortlek)).size;
  const delar = [];
  if (iFil.length) {
    delar.push(
      `${iFil.length} kort` + (antalLekar > 1 ? ` i ${antalLekar} kortlekar` : ` i ${iFil[0].kortlek}`),
    );
  }
  if (vantar) delar.push(`${vantar} slås upp`);
  const lasesNu = foton.filter((f) => !f.klar).length;
  if (lasesNu) delar.push(`${lasesNu} foto läses`);
  document.getElementById("summa").textContent = delar.join(" · ") || "Inga kort än";
  const knapp = document.getElementById("skapa");
  knapp.disabled = !iFil.length || byggerFil;
  knapp.textContent = byggerFil ? "Bygger …" : "Skapa Anki-fil";
  return iFil;
}

function ritaOrd(ord) {
  const v = ord.vy;
  const u = ord.uppslag;
  const klar = ord.status === "klar";

  v.krysset.checked = klar && ord.med;
  v.krysset.disabled = !klar;
  if (document.activeElement !== v.text) v.text.value = ord.text;

  let text = "";
  let klass = "";
  switch (ord.status) {
    case "tom":
      text = "Ordet gick inte att läsa. Skriv in det ovanför.";
      klass = "varning";
      break;
    case "vantar":
    case "slar-upp":
      text = "Slår upp hos Språkbanken …";
      break;
    case "ingenting":
      text =
        `Språkbanken känner inte till ”${ord.text}”. ` +
        "Blev läsningen fel? Rätta stavningen ovanför.";
      klass = "varning";
      break;
    case "fel":
      text = ord.felText;
      klass = "fel";
      break;
    case "klar": {
      const ordklass = u.ordklass ? ` (${u.ordklass})` : "";
      text =
        u.lastForm && u.lastForm !== u.ord
          ? `Böjd form av ”${u.ord}”${ordklass} – kortet gäller grundformen.`
          : `Kort för ”${u.ord}”${ordklass}.`;
      klass = "ok";
      const tidigare = skickade[nyckel(u.ord)];
      const forsta = ord.dubblettAv;
      if (ord.skickadI && !ord.med) {
        text = `Skickat i ${ord.skickadI}.`;
        klass = "";
      } else if (forsta && forsta.skickadI && !forsta.med) {
        text = `”${u.ord}” skickades redan i ${forsta.skickadI}.`;
        klass = "varning";
      } else if (forsta) {
        text = `”${u.ord}” finns redan ovanför – kommer bara med en gång.`;
        klass = "varning";
      } else if (tidigare && !ord.med) {
        text =
          `”${u.ord}” skickades till Anki ${datumText(tidigare.datum)} ` +
          `(${tidigare.kortlek}). Kryssa i rutan för att skicka det igen.`;
        klass = "varning";
      }
      break;
    }
  }
  v.status.textContent = text;
  v.status.className = `ordstatus ${klass}`;
  v.igen.hidden = ord.status !== "fel";
  v.forhand.hidden = !klar;
  if (klar) visaKort(ord);
  v.rot.classList.toggle("ute", !klar || !ord.med || Boolean(ord.dubblettAv));
}

// --- Skapa filen -------------------------------------------------------------

function filnamn() {
  const d = new Date();
  const tva = (n) => String(n).padStart(2, "0");
  return (
    `ordkort-${d.getFullYear()}-${tva(d.getMonth() + 1)}-${tva(d.getDate())}` +
    `-${tva(d.getHours())}${tva(d.getMinutes())}.apkg`
  );
}

function visaMeddelande(rader, fel = false) {
  const ruta = document.getElementById("meddelande");
  ruta.replaceChildren(...rader.map((r) => el("p", {}, r)));
  ruta.classList.toggle("fel", fel);
  ruta.hidden = false;
  ruta.scrollIntoView({ behavior: "smooth", block: "nearest" });
}

document.getElementById("skapa").addEventListener("click", async () => {
  const iFil = rita();
  if (!iFil.length || byggerFil) return;
  byggerFil = true;
  rita();

  try {
    const kort = iFil.map((ord) => {
      const [framsida, baksida] = byggKort(ord.uppslag);
      return { framsida, baksida, kortlek: ord.kortlek, taggar: ["ordkort", "svenska"] };
    });
    const blob = await byggPaket(iFil[0].kortlek, kort);
    const namn = filnamn();
    // Testsidan kan byta ut sparandet, så att filen hamnar på disken i
    // stället för i nedladdningarna. Appen själv använder alltid sparaPaket.
    const spara = window.ordkortTest?.spara || sparaPaket;
    const hur = await spara(blob, namn);
    if (hur === "avbruten") return;

    const idag = new Date().toISOString();
    const lekarna = new Set();
    for (const ord of iFil) {
      skickade[nyckel(ord.uppslag.ord)] = { datum: idag, kortlek: ord.kortlek };
      ord.skickadI = namn;
      ord.med = false;
      ord.rortKrysset = true;
      lekarna.add(ord.kortlek);
    }
    sparaMinne(NYCKEL_SKICKADE, skickade);

    visaMeddelande([
      `${iFil.length} kort i ${namn}` +
        (lekarna.size > 1 ? ` (${lekarna.size} kortlekar).` : ` (${[...lekarna][0]}).`),
      hur === "delad"
        ? "Välj AnkiDroid i listan för att importera dem."
        : "Filen ligger i Nedladdningar. Tryck på den så öppnas den i AnkiDroid. " +
          "På datorn: Arkiv → Importera i Anki.",
      "Ord som redan finns i Anki hoppas över vid importen.",
    ]);
  } catch (fel) {
    visaMeddelande([`Kunde inte skapa filen: ${fel?.message || fel}`], true);
  } finally {
    byggerFil = false;
    rita();
  }
});

// --- Start ---------------------------------------------------------------------

// Läsmotorerna (OpenCV och Tesseract, drygt 15 MB första gången) startas
// direkt, så att väntan är över innan första fotot är taget.
const motorstatus = document.getElementById("motorstatus");
async function startaMotorerna() {
  motorstatus.classList.remove("fel");
  motorstatus.textContent = "Startar läsmotorn …";
  try {
    await forberedAllt("swe", (m) => {
      if (m.vad) motorstatus.textContent = `Startar läsmotorn: ${m.vad} …`;
    });
    motorstatus.textContent = "Redo. Fota en sida med understrukna ord.";
  } catch (fel) {
    motorstatus.classList.add("fel");
    motorstatus.replaceChildren(
      `Läsmotorn startade inte: ${fel?.message || fel} `,
      el("button", { type: "button", class: "lank", onclick: startaMotorerna }, "Försök igen"),
    );
  }
}
startaMotorerna();
rita();

// Service workern gör att Chrome går med på att installera appen. Går det
// inte att registrera den fungerar appen ändå, bara utan installation.
if ("serviceWorker" in navigator) {
  navigator.serviceWorker.register("./sw.js").catch((fel) => {
    console.warn("Service workern kunde inte registreras:", fel);
  });
}
