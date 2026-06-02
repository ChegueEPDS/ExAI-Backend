# Equipment XLSX import működése

Ez a dokumentum az eszközimport sablon exportját és az XLSX import feldolgozását írja le.

## Endpointok

- Template letöltése: `GET /api/exreg/import-template`
- XLSX import: `POST /api/exreg/import-xlsx`
- Az import `multipart/form-data` kérést vár:
  - `file`: az XLSX fájl
  - `zoneId`: az a zóna, ahová az eszközök kerülnek

Az importhoz `asset:write` jogosultság kell.

## Template export

A template mindig az aktuális tenant alapján készül. Minden olyan oszlop bekerül, amit a tenantnál meg lehet adni, akkor is, ha később üresen marad.

Az oszlopcsoportok:

- `IDENTIFICATION`: `_id`, sorszám, tag, equipment id
- `EQUIPMENT DATA`: alap eszközadatok
- `EX DATA`: RB / explosion safety adatok importhoz
- `CERTIFICATION`: tanúsítvány adatok
- `CUSTOM DATA`: tenant equipment custom field mezők
- `SCHEMA DATA`: tenantnál elérhető, equipment szintre attacholható schema mezők
- `INSPECTION DATA`: opcionális importált felülvizsgálati adatok

## Alap eszközadatok

Fontosabb oszlopok:

- `_id`: opcionális. Ha exportból jön vissza és létező eszközre mutat, akkor frissítés történik.
- `#`: opcionális sorrend a zónán belül.
- `TagNo`
- `EqID`
- `Description`: az eszköz típusa/leírása, a DB-ben `Equipment Type`.
- `Manufacturer`
- `Model`
- `Serial Number`
- `IP rating`
- `Temp. Range`: a DB-ben `Max Ambient Temp`.
- `Qualitycheck`

Ha nincs `_id`, az import új eszközt hoz létre. Az `EqID` önmagában nem frissítési kulcs, mert nem garantáltan egyedi.

## Custom field oszlopok

A tenant aktív equipment custom fieldjei ilyen néven kerülnek a template-be:

```text
Custom: <mező label>
```

Importkor ezek az eszköz `customFields` objektumába kerülnek.

Típusok:

- `text`, `textarea`: szöveg
- `number`: szám
- `date`: dátum, lehetőleg `YYYY-MM-DD`
- `boolean`: `Yes`, `No`, `True`, `False`, `1`, `0`
- `select`: egy érték az opciók közül
- `multiselect`: több érték pontosvesszővel elválasztva, például `A; B; C`

Üres custom mező nem ír felül semmit.

## Schema oszlopok

A template-be bekerül minden aktív, equipment szinten attacholható tenant schema, ami a tenant számára látható. System schema esetén csak a publikált schemák kerülnek be.

Az RB schema nem jelenik meg külön `Schema: Explosion Safety / RB` oszlopként, mert az RB importja az `EX DATA` és `CERTIFICATION` oszlopokon keresztül történik.

Egy nem-RB schema oszlopai:

```text
Schema: <schema név>
Schema: <schema név>: Cycle value
Schema: <schema név>: Cycle unit
Schema: <schema név>: <adatmező label>
```

Példa:

```text
Schema: Zsírozás
Schema: Zsírozás: Cycle value
Schema: Zsírozás: Cycle unit
Schema: Zsírozás: Zsírozható
```

Import szabályok:

- Ha a `Schema: <schema név>` oszlop értéke `Yes`, a schema hozzá lesz rendelve az eszközhöz.
- Ha bármelyik schema adatmező vagy ciklus mező ki van töltve, a schema hozzá lesz rendelve az eszközhöz.
- Ha a `Schema: <schema név>` oszlop értéke `No`, akkor az adott schema soron belül ignorálva lesz.
- Üres schema oszlopok nem csinálnak semmit.
- Az import nem távolít el schema hozzárendelést. Eltávolítás csak az eszköz szerkesztésén keresztül történik.

Schema ciklus:

- `Cycle value`: pozitív szám.
- `Cycle unit`: `day`, `month` vagy `year`.
- Ha a ciklus üres, a schema default ciklusa kerül az assignmentbe.
- RB esetén a ciklus mindig `3 year`, és importból nem módosítható.

Schema adatmezők:

- A schema saját `dataFields` mezői külön oszlopként jelennek meg.
- `textarea` mező is tölthető sima cellaszövegként.
- `multiselect` értéknél pontosvesszőt kell használni: `Option A; Option B`.
- Required schema mező hiánya import hibát okozhat, ha a schema hozzá van rendelve a sorban.

Frissítéskor a meglévő schema assignment megmarad, az importált értékek rámerge-elődnek a meglévő `values` objektumra.

## RB / Explosion Safety import

Az RB schema adatai nem a `SCHEMA DATA` oszlopokon keresztül jönnek, hanem ezekből:

```text
EPL
Equipment Group
Equipment Category
Environment
SubGroup
Temperature Class
Protection Concept
Certificate No
Declaration of conformity
Status
```

Importkor ezekből épül az eszköz RB schema assignmentje:

- `scheme`: alapértelmezetten `ATEX`
- `certificateNo`: `Certificate No`, ha üres, akkor `Declaration of conformity`
- `compliance`: `Status`, ha nincs megadva, akkor `NA`
- `environment`
- `protectionTypes`
- `subGroup`
- `tempClass`
- `epl`
- `exMarking`

Ha a sorban van RB adat, az import automatikusan gondoskodik az RB schema létezéséről, és hozzárendeli az eszközhöz.

## Felülvizsgálati adatok importja

Opcionális oszlopok:

```text
Inspection Date
Type
Status
Remarks
```

Szabály:

- Ha `Status = Passed` és van érvényes `Inspection Date`, az import automatikusan felülvizsgálatot hoz létre az eszközhöz.
- `Type` értékei: `Detailed`, `Visual`, `Initial Detailed`, `Initial Detailed (Index)`, `Close`.
- A `Status` értékei: `Passed`, `Failed`, `NA`.

## Létrehozás és frissítés

Frissítés történik, ha:

- az `_id` oszlop ki van töltve,
- az `_id` érvényes Mongo ObjectId,
- az eszköz ugyanahhoz a tenanthoz és a megadott zónához tartozik.

Minden más esetben új eszköz jön létre.

Az import nem használja egyedi kulcsként az `EqID` mezőt.

## Üres mezők és törlés

Általános szabály:

- Üres custom/schema oszlop nem írja felül a meglévő adatot.
- Üres schema oszlop nem távolít el schema assignmentet.
- `Schema: <név> = No` nem detach, csak az adott import sorban nem attacholja/importálja azt a schemát.
- Törléshez vagy eltávolításhoz külön szerkesztési funkciót kell használni.

## Hibakezelés

Ha az import validációs hibát talál:

- JSON hibát adhat vissza, ha a fájl szerkezete hibás.
- Vagy XLSX válaszfájlt generál `Import summary` munkalappal, és a hibás sorokat jelöli.

Gyakori hibák:

- hiányzó vagy érvénytelen `zoneId`
- nincs worksheet az XLSX-ben
- nem található fejlécsor
- required schema mező hiányzik
- schema mezőben nem megengedett érték szerepel
- érvénytelen dátum vagy státusz

## Ajánlott használat

1. Töltsd le mindig frissen a template-et.
2. Ne nevezd át az oszlopokat.
3. Új eszköznél hagyd üresen az `_id` mezőt.
4. Frissítésnél tartsd meg az `_id` mezőt.
5. Schema hozzárendeléshez töltsd ki a `Schema: <név>` oszlopot `Yes` értékkel, vagy tölts ki legalább egy schema adatmezőt.
6. RB adatokhoz az `EX DATA` és `CERTIFICATION` oszlopokat használd.
