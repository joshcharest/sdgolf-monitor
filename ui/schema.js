// Single source of truth for the course dropdown. When new SD City Golf
// courses come online (e.g. Mission Bay), add them here. The booking
// class for SD city courses is resolved per-date by the runner (929 for
// 0-7 day window, 51735 for 8-90), so it isn't part of this schema.

// Each entry needs an ``id`` unique across all providers — it's the value
// stored on the form checkbox. Two providers today:
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
export const TEESHEETS = [
  { id: 1470,  label: "Balboa Park 18",     provider: "foreup",  facility: 19348 },
  { id: 1490,  label: "Balboa Park 9",      provider: "foreup",  facility: 19348 },
  { id: 1468,  label: "Torrey Pines North", provider: "foreup",  facility: 19347 },
  { id: 1487,  label: "Torrey Pines South", provider: "foreup",  facility: 19347 },
  { id: 10985, label: "Coronado 18 (3-14d)", provider: "teeitup",
    facility_id: 10985, alias: "coronado-gc-3-14-be" },
];
