/* Gör om ett uppslag till fram- och baksida i HTML. Portning av kort.py.
 *
 * Modulen känner varken till Anki eller Språkbanken -- data in, sträng ut.
 *
 * En sak att hålla reda på: exempelmeningarna från Korp är REDAN HTML (de
 * innehåller <b> runt sökordet), medan allt annat är ren text som måste
 * escapas.
 */

function escapeHtml(text) {
  return String(text)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#x27;");
}

/** Framsidan är bara ordet -- det är ju det jag ska minnas betydelsen av. */
export function byggFramsida(uppslag) {
  return `<div class="ord">${escapeHtml(uppslag.ord)}</div>`;
}

/** Baksidan: ordklass, definition, synonymer, närliggande och meningar. */
export function byggBaksida(uppslag, maxSynonymer = 6) {
  const delar = [];

  if (uppslag.ordklass) {
    delar.push(`<div class="ordklass">${escapeHtml(uppslag.ordklass)}</div>`);
  }

  // Stod det "plägar" i boken är det värt att visa -- då känner jag igen
  // ordet när jag möter det igen. Framsidan är ändå grundformen.
  if (uppslag.lastForm && uppslag.lastForm !== uppslag.ord) {
    delar.push(
      `<div class="bojning">läst som <i>${escapeHtml(uppslag.lastForm)}</i></div>`,
    );
  }

  if (uppslag.definitioner.length) {
    delar.push('<div class="rubrik">Betyder</div>');
    for (const definition of uppslag.definitioner) {
      delar.push(`<div>${escapeHtml(definition)}</div>`);
    }
  }

  if (uppslag.synonymer.length) {
    // Swesaurus kan ge tjugo synonymer, men ett kort med tjugo ord på lär
    // man sig ingenting av.
    const valda = uppslag.synonymer.slice(0, maxSynonymer);
    delar.push('<div class="rubrik">Synonymer</div>');
    delar.push(
      `<div class="synonymer">${valda.map(escapeHtml).join(", ")}</div>`,
    );
  }

  // Egen rubrik, inte hopslaget med synonymerna: orden ligger nära betydelsen
  // utan att vara utbytbara, och att kalla dem synonymer vore att lära sig
  // något felaktigt.
  if (uppslag.narliggande.length) {
    delar.push('<div class="rubrik">Närliggande</div>');
    delar.push(
      `<div class="narliggande">${uppslag.narliggande.map(escapeHtml).join(", ")}</div>`,
    );
  }

  if (uppslag.exempel.length) {
    delar.push('<div class="rubrik">I en mening</div>');
    // OBS: ingen escape här -- meningarna innehåller vår egen <b>-markering
    // och orden i dem är redan escapade i sprakbanken.js.
    const rader = uppslag.exempel.map((m) => `<li>${m}</li>`).join("");
    delar.push(`<ul class="exempel">${rader}</ul>`);
  }

  delar.push(
    '<div class="kalla">Källa: Språkbanken (SALDO, Swesaurus, Lexin, Korp)</div>',
  );

  return delar.join("\n");
}

export function byggKort(uppslag, maxSynonymer = 6) {
  return [byggFramsida(uppslag), byggBaksida(uppslag, maxSynonymer)];
}

/** En läsbar textversion, för förhandsvisning i appen. */
export function forhandsvisa(uppslag, maxSynonymer = 6) {
  const rader = [
    uppslag.ord + (uppslag.ordklass ? `  (${uppslag.ordklass})` : ""),
  ];

  if (uppslag.lastForm && uppslag.lastForm !== uppslag.ord) {
    rader.push(
      `läst som: ${uppslag.lastForm}` +
        (uppslag.bojning ? `  [${uppslag.bojning}]` : ""),
    );
  }

  const avsnitt = [
    ["Betyder", uppslag.definitioner],
    ["Synonymer", [uppslag.synonymer.slice(0, maxSynonymer).join(", ")]],
    ["Närliggande", [uppslag.narliggande.join(", ")]],
  ];
  for (const [rubrik, innehall] of avsnitt) {
    const rent = innehall.filter(Boolean);
    if (!rent.length) continue;
    rader.push("", `${rubrik}:`, ...rent.map((r) => `  ${r}`));
  }

  if (uppslag.exempel.length) {
    rader.push("", "I en mening:");
    for (const mening of uppslag.exempel) {
      // Meningarna är HTML. Här vill vi ha stjärnor i stället för <b>, och
      // riktiga tecken i stället för &quot; och &amp;.
      const doc = new DOMParser().parseFromString(
        mening.replaceAll("<b>", "*").replaceAll("</b>", "*"),
        "text/html",
      );
      rader.push(`  - ${doc.documentElement.textContent}`);
    }
  }

  return rader.join("\n");
}
