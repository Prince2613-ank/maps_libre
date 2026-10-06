// Details shown on the Overview tab's place card, as listed on Google Maps. Edit here when they change.

export type Place = {
  name: string;
  /** Name in the local script, shown under the name; empty to hide. */
  localName: string;
  category: string;
  /** Google rating and review count; they don't update by themselves. */
  rating: number;
  reviewCount: number;
  address: string;
  website: string;
  /** Opening hours, "HH:MM" in the building's time zone. Without `opens` the card only shows the closing time. */
  hours: { opens: string | null; closes: string };
  /** Cover photo, relative to public/. Replace the file with a real photo of the office if you have one. */
  cover: string;
};

export const PLACE: Place = {
  name: "FloData Analytics",
  localName: "फ्लोड़ता एनालिटिक्स",
  category: "Information services",
  rating: 4.8,
  reviewCount: 6,
  address: "Building 9-10 (2nd Floor), Central Market, West Punjabi Bagh, Punjabi Bagh, New Delhi, Delhi 110026",
  website: "https://flodataanalytics.com",
  hours: { opens: null, closes: "19:00" },
  cover: "place/cover.jpg"
};
