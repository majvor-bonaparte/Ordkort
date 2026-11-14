# Ordkort

Fota en boksida där du strukit under okända ord med blyerts. Appen hittar
strecken, läser orden, slår upp dem hos Språkbanken och gör en fil som
Anki/AnkiDroid kan importera.

Allt körs i webbläsaren på telefonen:

- **Fotot lämnar aldrig telefonen.** Strecken och texten tolkas lokalt
  (OpenCV och Tesseract, kompilerade till WebAssembly).
- **Orden skickas till Språkbanken** (Göteborgs universitet) för uppslag:
  SALDO, Swesaurus, Lexin och Korp.
- **Anki-filen byggs i telefonen** och sparas där.

Sidan har en Content Security Policy som bara tillåter kod från sidan själv
och två biblioteksarkiv (jsDelivr, cdnjs), och bara förfrågningar till
Språkbanken och samma arkiv.

Bibliotek, med fastlåsta versioner: OpenCV.js 4.10.0, tesseract.js 7.0.0,
sql.js 1.10.3, JSZip 3.10.1.
