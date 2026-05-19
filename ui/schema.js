// Single source of truth for the dropdowns + booking-class metadata.
//
// When new SD City Golf courses come online (e.g. Mission Bay), add them
// here. The UI and any auto-completion logic both read from this file.

export const TEESHEETS = [
  { id: 1470, label: "Balboa Park 18" },
  { id: 1490, label: "Balboa Park 9" },
  { id: 1468, label: "Torrey Pines North" },
  { id: 1487, label: "Torrey Pines South" },
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
