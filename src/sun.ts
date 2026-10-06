// Sun position for a place and time (formulas from SunCalc, https://github.com/mourner/suncalc, BSD-2).
// Accurate to well under a degree, which is plenty for lighting and shadows.

const RAD = Math.PI / 180;
const DAY_MS = 86_400_000;
const J1970 = 2440588;
const J2000 = 2451545;
const OBLIQUITY = RAD * 23.4397;

/** The building is in India: all times in the Sun panel are IST (UTC+5:30, no daylight saving). */
export const SITE_UTC_OFFSET_MIN = 330;
export const SITE_TIME_ZONE_LABEL = "IST";

export type SunPosition = {
  /** Degrees clockwise from north (0 = N, 90 = E, 180 = S, 270 = W). */
  azimuth: number;
  /** Degrees above the horizon (negative = below). */
  altitude: number;
};

const toDays = (date: Date) => date.valueOf() / DAY_MS - 0.5 + J1970 - J2000;

function sunCoords(d: number) {
  const m = RAD * (357.5291 + 0.98560028 * d); // solar mean anomaly
  const c = RAD * (1.9148 * Math.sin(m) + 0.02 * Math.sin(2 * m) + 0.0003 * Math.sin(3 * m)); // equation of centre
  const l = m + c + RAD * 102.9372 + Math.PI; // ecliptic longitude
  return {
    dec: Math.asin(Math.sin(0) * Math.cos(OBLIQUITY) + Math.cos(0) * Math.sin(OBLIQUITY) * Math.sin(l)),
    ra: Math.atan2(Math.sin(l) * Math.cos(OBLIQUITY), Math.cos(l))
  };
}

export function sunPosition(date: Date, lat: number, lon: number): SunPosition {
  const lw = RAD * -lon;
  const phi = RAD * lat;
  const d = toDays(date);
  const { dec, ra } = sunCoords(d);
  const h = RAD * (280.16 + 360.9856235 * d) - lw - ra; // hour angle
  const azimuthFromSouth = Math.atan2(Math.sin(h), Math.cos(h) * Math.sin(phi) - Math.tan(dec) * Math.cos(phi));
  const altitude = Math.asin(Math.sin(phi) * Math.sin(dec) + Math.cos(phi) * Math.cos(dec) * Math.cos(h));
  return { azimuth: (azimuthFromSouth / RAD + 180 + 360) % 360, altitude: altitude / RAD };
}

/** Unit vector towards the sun in local East-North-Up. */
export function sunDirectionEnu({ azimuth, altitude }: SunPosition): [number, number, number] {
  const az = azimuth * RAD;
  const alt = altitude * RAD;
  return [Math.cos(alt) * Math.sin(az), Math.cos(alt) * Math.cos(az), Math.sin(alt)];
}

/** Midnight (site time) of the site-local calendar day "YYYY-MM-DD", as a real instant. */
export function siteMidnight(isoDate: string): Date {
  const [y, m, d] = isoDate.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d) - SITE_UTC_OFFSET_MIN * 60_000);
}

/** Site-local date "YYYY-MM-DD" and minutes since midnight for an instant. */
export function toSiteTime(date: Date): { isoDate: string; minutes: number } {
  const shifted = new Date(date.valueOf() + SITE_UTC_OFFSET_MIN * 60_000);
  return {
    isoDate: shifted.toISOString().slice(0, 10),
    minutes: shifted.getUTCHours() * 60 + shifted.getUTCMinutes()
  };
}

export const formatMinutes = (minutes: number) => {
  const m = ((Math.round(minutes) % 1440) + 1440) % 1440;
  return `${String(Math.floor(m / 60)).padStart(2, "0")}:${String(m % 60).padStart(2, "0")}`;
};

export type SunDay = {
  /** Minutes after site midnight, or null if the sun doesn't rise/set that day. */
  sunrise: number | null;
  sunset: number | null;
  solarNoon: number;
  noonAltitude: number;
};

/** Sunrise/sunset (sun's upper edge at the horizon, -0.833°) and solar noon for a site-local day. */
export function sunDay(isoDate: string, lat: number, lon: number): SunDay {
  const midnight = siteMidnight(isoDate).valueOf();
  const HORIZON = -0.833;
  let sunrise: number | null = null;
  let sunset: number | null = null;
  let solarNoon = 720;
  let noonAltitude = -90;
  let previous = sunPosition(new Date(midnight), lat, lon).altitude;
  for (let minute = 1; minute <= 1440; minute++) {
    const altitude = sunPosition(new Date(midnight + minute * 60_000), lat, lon).altitude;
    if (previous < HORIZON && altitude >= HORIZON && sunrise === null) sunrise = minute - (altitude - HORIZON) / (altitude - previous);
    if (previous >= HORIZON && altitude < HORIZON) sunset = minute - (altitude - HORIZON) / (altitude - previous);
    if (altitude > noonAltitude) {
      noonAltitude = altitude;
      solarNoon = minute;
    }
    previous = altitude;
  }
  return { sunrise, sunset, solarNoon, noonAltitude };
}

export function compassPoint(azimuth: number): string {
  const points = ["N", "NNE", "NE", "ENE", "E", "ESE", "SE", "SSE", "S", "SSW", "SW", "WSW", "W", "WNW", "NW", "NNW"];
  return points[Math.round(azimuth / 22.5) % 16];
}
