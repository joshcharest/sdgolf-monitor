// Single source of truth for the course dropdown. When new SD City Golf
// courses come online (e.g. Mission Bay), add them here. The booking
// class for SD city courses is resolved per-date by the runner (929 for
// 0-7 day window, 51735 for 8-90), so it isn't part of this schema.

// Each entry needs an ``id`` unique across all providers — it's the value
// stored on the form checkbox. Three providers today:
//
// foreup (SD City Golf): ``id`` is the ForeUp ``teesheet_id`` (= the
//   booking API's ``schedule_id``). ``facility`` is the SPA's
//   /booking/{facility}/... id (Balboa = 19348, Torrey = 19347); sharing
//   one across courses lands the user on the wrong SPA, so keep aligned.
//
// teeitup (Coronado): ``id`` is the TeeItUp ``facility_id`` (= the
//   ``?course=`` URL param and the API's ``facilityIds`` param).
//   ``alias`` selects which rate-window view the API responds with — it
//   matches the subdomain of the booking SPA.
//
// webtrac (Navy MWR — Admiral Baker): ``id`` is the WebTrac
//   ``secondarycode`` course code on the myffr.navyaims.com portal
//   (28 = Admiral Baker North, 29 = South, 27 = Sea 'N Air).
//
// golfdistrict (JC Golf prepaid RESALE marketplace): ``id`` is the Golf
//   District ``course_id`` UUID from the page URL. This surfaces tee times
//   golfers are reselling, not the primary tee sheet. Note the string id —
//   the UI id handling is string-safe to accommodate these UUIDs.
export const TEESHEETS = [
  { id: 1470,  label: "Balboa Park 18",     provider: "foreup",  facility: 19348 },
  { id: 1490,  label: "Balboa Park 9",      provider: "foreup",  facility: 19348 },
  { id: 1468,  label: "Torrey Pines North", provider: "foreup",  facility: 19347 },
  { id: 1487,  label: "Torrey Pines South", provider: "foreup",  facility: 19347 },
  { id: 10985, label: "Coronado (3-14d)", provider: "teeitup",
    facility_id: 10985, alias: "coronado-gc-3-14-be" },
  { id: 28,    label: "Admiral Baker North", provider: "webtrac",
    secondarycode: 28 },
  { id: 29,    label: "Admiral Baker South", provider: "webtrac",
    secondarycode: 29 },
  { id: 27,    label: "Sea 'N Air", provider: "webtrac",
    secondarycode: 27 },
  { id: "3f755992-90e0-11ef-9af2-6a003139847e", label: "Encinitas Ranch (resale)",
    provider: "golfdistrict", course_id: "3f755992-90e0-11ef-9af2-6a003139847e" },
];
