// Single source of truth for the dropdowns + booking-class metadata.
//
// When new SD City Golf courses come online (e.g. Mission Bay), add them
// here. The UI and any auto-completion logic both read from this file.

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

// Booking classes the user (Josh) is entitled to. Discovered via discover.py.
//
// Verified via raw API probes against Torrey N (teesheet 1468):
// - 929 returns Torrey slots with booking_fee_required=false — it's the
//   universal resident 0-7 day class for all three SD city courses. Torrey
//   18-hole inside 0-7 days is empirically near-zero (the lottery + walk-ups
//   eat those slots), but the class IS valid — that's why it's worth
//   monitoring.
// - 51735 returns Torrey slots with booking_fee_required=true at day+7+ —
//   the resident 8-90 day window with the non-refundable booking fee
//   described on the Resident ID card.
// - 969 and 51736 mirror 929/51735 respectively across every probe.
export const BOOKING_CLASSES = [
  { id: 929,   label: "929 — Resident 0-7 day window (all SD city courses, no booking fee)" },
  { id: 969,   label: "969 — Resident 0-7 day window (alternate, matches 929)" },
  { id: 51735, label: "51735 — Resident 8-90 day window (all courses, booking fee)" },
  { id: 51736, label: "51736 — Resident 8-90 day window (alternate, matches 51735)" },
  { id: 49924, label: "49924 — Special / promo (no current entitlements)" },
];
