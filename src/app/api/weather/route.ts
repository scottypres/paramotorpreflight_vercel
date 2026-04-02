import { NextRequest, NextResponse } from "next/server";

interface NWSPoint {
  properties: {
    forecast: string;
    forecastHourly: string;
    gridId: string;
    gridX: number;
    gridY: number;
    relativeLocation: {
      properties: {
        city: string;
        state: string;
      };
    };
  };
}

interface NWSForecastPeriod {
  name: string;
  temperature: number;
  temperatureUnit: string;
  windSpeed: string;
  windDirection: string;
  shortForecast: string;
  detailedForecast: string;
  isDaytime: boolean;
}

interface NWSGridData {
  properties: {
    visibility?: { values: { validTime: string; value: number }[] };
    windGust?: { values: { validTime: string; value: number }[] };
    windSpeed?: { values: { validTime: string; value: number }[] };
    weather?: { values: { value: { coverage: string; weather: string }[] }[] };
  };
}

const NWS_HEADERS = {
  "User-Agent": "(ParamotorPreflight, contact@paramotorpreflight.app)",
  Accept: "application/geo+json",
};

async function getCoordinatesFromZip(
  zip: string
): Promise<{ lat: number; lon: number }> {
  // Use the US Census Bureau geocoder for zip codes (free, no key needed)
  const res = await fetch(
    `https://geocoding.geo.census.gov/geocoder/geographies/onelineaddress?address=${zip}&benchmark=Public_AR_Current&vintage=Current_Current&format=json`,
    { next: { revalidate: 86400 } }
  );

  if (!res.ok) {
    throw new Error("Failed to geocode zip code");
  }

  const data = await res.json();
  const matches = data?.result?.addressMatches;

  if (!matches || matches.length === 0) {
    // Fallback: try with the zip code directly using NWS
    // Use a zip code to lat/lon API
    const zipRes = await fetch(
      `https://api.zippopotam.us/us/${zip}`
    );
    if (!zipRes.ok) {
      throw new Error("Invalid zip code");
    }
    const zipData = await zipRes.json();
    return {
      lat: parseFloat(zipData.places[0].latitude),
      lon: parseFloat(zipData.places[0].longitude),
    };
  }

  const coords = matches[0].coordinates;
  return { lat: coords.y, lon: coords.x };
}

async function getCoordinatesFromQuery(
  query: string
): Promise<{ lat: number; lon: number }> {
  // Use US Census Bureau geocoder for freeform address/place name search
  const encoded = encodeURIComponent(query);
  const res = await fetch(
    `https://geocoding.geo.census.gov/geocoder/locations/onelineaddress?address=${encoded}&benchmark=Public_AR_Current&format=json`,
    { next: { revalidate: 86400 } }
  );

  if (res.ok) {
    const data = await res.json();
    const matches = data?.result?.addressMatches;
    if (matches && matches.length > 0) {
      const coords = matches[0].coordinates;
      return { lat: coords.y, lon: coords.x };
    }
  }

  // Fallback: try Nominatim (OpenStreetMap) geocoder - free, no key needed
  const nomRes = await fetch(
    `https://nominatim.openstreetmap.org/search?q=${encoded}&format=json&countrycodes=us&limit=1`,
    { headers: { "User-Agent": "ParamotorPreflight/1.0" } }
  );

  if (!nomRes.ok) {
    throw new Error("Could not find that location");
  }

  const nomData = await nomRes.json();
  if (!nomData || nomData.length === 0) {
    throw new Error("Could not find that location. Try a zip code or city, state format.");
  }

  return {
    lat: parseFloat(nomData[0].lat),
    lon: parseFloat(nomData[0].lon),
  };
}

export async function GET(request: NextRequest) {
  const zip = request.nextUrl.searchParams.get("zip");
  const query = request.nextUrl.searchParams.get("q");
  const latParam = request.nextUrl.searchParams.get("lat");
  const lonParam = request.nextUrl.searchParams.get("lon");

  let lat: number;
  let lon: number;
  let locationZip = zip || "";

  if (latParam && lonParam) {
    // Direct lat/lon mode (from geolocation)
    lat = parseFloat(latParam);
    lon = parseFloat(lonParam);
    if (isNaN(lat) || isNaN(lon)) {
      return NextResponse.json(
        { error: "Invalid coordinates" },
        { status: 400 }
      );
    }
  } else if (zip && /^\d{5}$/.test(zip)) {
    // Zip code mode
    try {
      const coords = await getCoordinatesFromZip(zip);
      lat = coords.lat;
      lon = coords.lon;
    } catch {
      return NextResponse.json(
        { error: "Could not find that zip code" },
        { status: 400 }
      );
    }
  } else if (query && query.trim().length > 0) {
    // Place name / address search mode
    try {
      const coords = await getCoordinatesFromQuery(query.trim());
      lat = coords.lat;
      lon = coords.lon;
    } catch (err) {
      return NextResponse.json(
        { error: err instanceof Error ? err.message : "Could not find that location" },
        { status: 400 }
      );
    }
  } else {
    return NextResponse.json(
      { error: "Please provide a location, zip code, or allow location access" },
      { status: 400 }
    );
  }

  try {

    // Step 2: Get NWS point metadata
    const pointRes = await fetch(
      `https://api.weather.gov/points/${lat.toFixed(4)},${lon.toFixed(4)}`,
      { headers: NWS_HEADERS }
    );

    if (!pointRes.ok) {
      throw new Error("Could not find weather data for this location");
    }

    const pointData: NWSPoint = await pointRes.json();
    const {
      forecast: forecastUrl,
      forecastHourly: hourlyUrl,
      gridId,
      gridX,
      gridY,
      relativeLocation,
    } = pointData.properties;

    const city = relativeLocation.properties.city;
    const state = relativeLocation.properties.state;

    // Step 3: Fetch forecast, hourly, and grid data in parallel
    const [forecastRes, hourlyRes, gridRes] = await Promise.all([
      fetch(forecastUrl, { headers: NWS_HEADERS }),
      fetch(hourlyUrl, { headers: NWS_HEADERS }),
      fetch(
        `https://api.weather.gov/gridpoints/${gridId}/${gridX},${gridY}`,
        { headers: NWS_HEADERS }
      ),
    ]);

    const forecastData = await forecastRes.json();
    const hourlyData = await hourlyRes.json();
    const gridData: NWSGridData = await gridRes.json();

    // Extract current conditions from hourly (first period)
    const currentHourly = hourlyData.properties?.periods?.[0];
    const upcomingHours = hourlyData.properties?.periods?.slice(0, 24) || [];

    // Build a lookup of gust values by hour from grid data
    // Grid data uses ISO 8601 duration format: "2024-01-01T06:00:00+00:00/PT1H"
    const gustByHour: Record<string, number> = {};
    const gustValues = gridData.properties?.windGust?.values || [];
    for (const gv of gustValues) {
      if (!gv.validTime || gv.value == null) continue;
      const [startStr, durStr] = gv.validTime.split("/");
      const start = new Date(startStr).getTime();
      // Parse duration like PT1H, PT2H, PT3H
      const durMatch = durStr?.match(/PT(\d+)H/);
      const hours = durMatch ? parseInt(durMatch[1]) : 1;
      for (let h = 0; h < hours; h++) {
        const hourKey = new Date(start + h * 3600000).toISOString().substring(0, 13);
        gustByHour[hourKey] = gv.value;
      }
    }

    // Extract current gust
    const currentGust = gustValues[0]?.value;

    // Extract visibility from grid data
    const visValues = gridData.properties?.visibility?.values;
    const currentVisibility = visValues?.[0]?.value;

    // Get forecast periods
    const periods: NWSForecastPeriod[] =
      forecastData.properties?.periods?.slice(0, 6) || [];

    // Step 4: Fetch winds aloft data from Aviation Weather Center
    let windsAloft = null;
    try {
      const awcRes = await fetch(
        `https://aviationweather.gov/api/data/windtemp?region=all&level=low&fcst=06`,
        { headers: { Accept: "text/plain" } }
      );
      if (awcRes.ok) {
        const rawText = await awcRes.text();
        windsAloft = parseWindsAloft(rawText, lat, lon);
      }
    } catch {
      // Winds aloft is optional, don't fail the whole request
    }

    // Parse wind info from current conditions
    const windSpeed = currentHourly?.windSpeed || "Unknown";
    const windDirection = currentHourly?.windDirection || "Unknown";

    // Build ground-level entry and prepend to winds aloft
    const surfaceTemp = currentHourly?.temperature
      ? `${currentHourly.temperature}°${currentHourly.temperatureUnit}`
      : null;
    const groundWind = {
      altitude: "Surface",
      wind: `${windDirection} at ${windSpeed}`,
      temp: surfaceTemp,
    };
    const windsAloftWithGround = [groundWind, ...(windsAloft || [])];

    // Convert visibility from meters to statute miles
    const visibilityMiles = currentVisibility
      ? (currentVisibility / 1609.34).toFixed(1)
      : null;

    // Calculate sunrise/sunset
    const sunTimes = calculateSunTimes(lat, lon);

    return NextResponse.json({
      location: { city, state, lat, lon, zip: locationZip },
      sunrise: sunTimes.sunrise,
      sunset: sunTimes.sunset,
      current: {
        temperature: currentHourly?.temperature,
        temperatureUnit: currentHourly?.temperatureUnit,
        windSpeed,
        windDirection,
        windGust: currentGust
          ? `${Math.round(currentGust * 0.621371)} mph`
          : null,
        visibility: visibilityMiles ? `${visibilityMiles} mi` : null,
        shortForecast: currentHourly?.shortForecast,
      },
      hourly: upcomingHours.map(
        (h: {
          startTime: string;
          temperature: number;
          temperatureUnit: string;
          windSpeed: string;
          windDirection: string;
          shortForecast: string;
        }) => {
          const hourKey = new Date(h.startTime).toISOString().substring(0, 13);
          const gustMps = gustByHour[hourKey];
          const gustMph = gustMps != null ? Math.round(gustMps * 2.23694) : null;
          return {
            time: h.startTime,
            temperature: h.temperature,
            temperatureUnit: h.temperatureUnit,
            windSpeed: h.windSpeed,
            windDirection: h.windDirection,
            windGust: gustMph ? `${gustMph} mph` : null,
            shortForecast: h.shortForecast,
          };
        }
      ),
      forecast: periods.map((p) => ({
        name: p.name,
        temperature: p.temperature,
        temperatureUnit: p.temperatureUnit,
        windSpeed: p.windSpeed,
        windDirection: p.windDirection,
        shortForecast: p.shortForecast,
        isDaytime: p.isDaytime,
      })),
      windsAloft: windsAloftWithGround,
    });
  } catch (err) {
    const message =
      err instanceof Error ? err.message : "Failed to fetch weather data";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}

function parseWindsAloft(
  rawText: string,
  lat: number,
  lon: number
): { altitude: string; wind: string; temp: string | null }[] | null {
  const lines = rawText.split("\n").filter((l) => l.trim());

  let dataStarted = false;
  const stations: {
    id: string;
    data: string;
  }[] = [];

  for (const line of lines) {
    if (line.includes("3000") && line.includes("6000")) {
      dataStarted = true;
      continue;
    }
    if (dataStarted && line.trim().length > 10) {
      const parts = line.trim().split(/\s+/);
      if (parts.length >= 3 && /^[A-Z]{3}$/.test(parts[0])) {
        stations.push({ id: parts[0], data: line.trim() });
      }
    }
  }

  if (stations.length === 0) return null;

  // Only show altitudes up to 6,000 ft (relevant for paramotors)
  const altitudes = ["3,000 ft", "6,000 ft"];
  const nearest = stations[0];
  if (!nearest) return null;

  const parts = nearest.data.split(/\s+/).slice(1); // skip station ID
  return altitudes
    .map((alt, i) => {
      const raw = parts[i];
      if (!raw || raw === "9900") return { altitude: alt, wind: "Light & Variable", temp: null };
      if (raw.length >= 4) {
        const dirDeg = parseInt(raw.substring(0, 2) + "0");
        const speedKts = parseInt(raw.substring(2, 4));
        const speedMph = Math.round(speedKts * 1.15078);
        const cardinal = degreesToCardinal(dirDeg);

        // FB format: 4 chars = DDSS (no temp at 3k), 6+ chars = DDSSTt (temp in °C)
        let temp: string | null = null;
        if (raw.length >= 6) {
          let tempC = parseInt(raw.substring(4, 6));
          // Negative temps indicated by direction >= 51 (add 100 to speed, negate temp)
          if (dirDeg >= 510) {
            tempC = -tempC;
          }
          const tempF = Math.round(tempC * 9 / 5 + 32);
          temp = `${tempF}°F`;
        }

        return {
          altitude: alt,
          wind: `${cardinal} at ${speedMph} mph`,
          temp,
        };
      }
      return { altitude: alt, wind: raw, temp: null };
    })
    .filter(Boolean);
}

function calculateSunTimes(lat: number, lon: number): { sunrise: string; sunset: string } {
  // Solar position calculation (simplified NOAA algorithm)
  const now = new Date();
  const start = new Date(now.getFullYear(), 0, 1);
  const dayOfYear = Math.floor((now.getTime() - start.getTime()) / 86400000) + 1;

  const latRad = (lat * Math.PI) / 180;

  // Solar declination
  const declination = 23.45 * Math.sin((2 * Math.PI * (284 + dayOfYear)) / 365);
  const decRad = (declination * Math.PI) / 180;

  // Hour angle for sunrise/sunset
  const cosHA = -(Math.tan(latRad) * Math.tan(decRad));
  // Clamp for polar regions
  const clampedCosHA = Math.max(-1, Math.min(1, cosHA));
  const haRad = Math.acos(clampedCosHA);
  const haDeg = (haRad * 180) / Math.PI;

  // Equation of time (minutes)
  const B = ((360 / 365) * (dayOfYear - 81)) * (Math.PI / 180);
  const eot = 9.87 * Math.sin(2 * B) - 7.53 * Math.cos(B) - 1.5 * Math.sin(B);

  // Solar noon in minutes from midnight UTC
  const solarNoonMin = 720 - 4 * lon - eot;

  const sunriseMin = solarNoonMin - 4 * haDeg;
  const sunsetMin = solarNoonMin + 4 * haDeg;

  function minsToISO(mins: number): string {
    const d = new Date(now);
    d.setUTCHours(0, 0, 0, 0);
    d.setUTCMinutes(Math.round(mins));
    return d.toISOString();
  }

  return {
    sunrise: minsToISO(sunriseMin),
    sunset: minsToISO(sunsetMin),
  };
}

function degreesToCardinal(deg: number): string {
  const dirs = [
    "N", "NNE", "NE", "ENE",
    "E", "ESE", "SE", "SSE",
    "S", "SSW", "SW", "WSW",
    "W", "WNW", "NW", "NNW",
  ];
  const idx = Math.round(deg / 22.5) % 16;
  return dirs[idx];
}
