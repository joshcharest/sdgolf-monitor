// Single source of truth for the dropdowns + booking-class metadata.
//
// When new SD City Golf courses come online (e.g. Mission Bay), add them
// here. The UI and any auto-completion logic both read from this file.

export const REPO_OWNER = "joshcharest";
export const REPO_NAME = "sdgolf-monitor";
export const REPO_BRANCH = "main";

export const TEESHEETS = [
  { id: 1470, label: "Balboa Park 18" },
  { id: 1490, label: "Balboa Park 9" },
  { id: 1468, label: "Torrey Pines North" },
  { id: 1487, label: "Torrey Pines South" },
];

// Booking classes the user (Josh) is entitled to. Discovered via discover.py.
// `recommended_for` is shown as a hint in the UI; the underlying booking class
// constraints are enforced server-side by ForeUp, not by this UI.
export const BOOKING_CLASSES = [
  { id: 929,   label: "929 — Resident 0-7 day window (Balboa, Mission Bay)" },
  { id: 49924, label: "49924 — Special / promo" },
  { id: 51735, label: "51735 — Resident 8-90 day window (all courses, booking fee)" },
  { id: 51736, label: "51736 — Resident 8-90 day window (alternate)" },
  { id: 969,   label: "969 — Torrey 8-90 day window (legacy)" },
];

// Display the date string the way the YAML stores it.
export function fmtDate(s) {
  if (!s) return "?";
  return s;
}
