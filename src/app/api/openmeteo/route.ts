import { NextRequest, NextResponse } from "next/server";

/* ------------------------------------------------------------------ */
/*  Pressure-level → altitude mapping (only up to ~6,400 ft)          */
/* ------------------------------------------------------------------ */

const PRESSURE_LEVELS = [
  { hPa: 1000, feet: 364,  label: "364 ft"  },
  { hPa: 975,  feet: 1184, label: "1,184 ft" },
  { hPa: 950,  feet: 1773, label: "1,773 ft" },
  { hPa: 925,  feet: 2500, label: "2,500 ft" },
  { hPa: 900,  feet: 3243, label: "3,243 ft" },
  { hPa: 850,  feet: 4781, label: "4,781 ft" },
  { hPa: 800,  feet: 6394, label: "6,394 ft" },
];

const SURFACE_LEVELS = [
  { key: "10m",  feet: 33,  label: "33 ft (Surface)" },
  { key: "80m",  feet: 262, label: "262 ft" },
];

function degreesToCardinal(deg: number): string {
  const dirs = [
    "N", "NNE", "NE", "ENE", "E", "ESE", "SE", "SSE",
    "S", "SSW", "SW", "WSW", "W", "WNW", "NW", "NNW",
  ];
  const idx = Math.round(deg / 22.5) % 16;
  return dirs[idx];
}

function formatHourLabel(iso: string): string {
  const d = new Date(iso);
  const h = d.getHours();
  if (h === 0) return "12A";
  if (h === 12) return "12P";
  if (h < 12) return `${h}A`;
  return `${h - 12}P`;
}

/* ------------------------------------------------------------------ */
/*  GET handler                                                        */
/* ------------------------------------------------------------------ */

export async function GET(request: NextRequest) {
  const latParam = request.nextUrl.searchParams.get("lat");
  const lonParam = request.nextUrl.searchParams.get("lon");

  if (!latParam || !lonParam) {
    return NextResponse.json({ error: "lat and lon required" }, { status: 400 });
  }

  const lat = parseFloat(latParam);
  const lon = parseFloat(lonParam);
  if (isNaN(lat) || isNaN(lon)) {
    return NextResponse.json({ error: "Invalid coordinates" }, { status: 400 });
  }

  // Build hourly params
  const surfaceParams = [
    "wind_speed_10m", "wind_speed_80m",
    "wind_direction_10m", "wind_direction_80m",
    "wind_gusts_10m",
    "temperature_2m", "temperature_80m",
    "weather_code", "is_day",
    "relative_humidity_2m", "dew_point_2m",
    "visibility", "cloud_cover",
  ];

  const pressureWindParams = PRESSURE_LEVELS.flatMap((p) => [
    `windspeed_${p.hPa}hPa`,
    `winddirection_${p.hPa}hPa`,
    `temperature_${p.hPa}hPa`,
  ]);

  const hourlyParams = [...surfaceParams, ...pressureWindParams].join(",");

  const url =
    `https://api.open-meteo.com/v1/gfs` +
    `?latitude=${lat}&longitude=${lon}` +
    `&hourly=${hourlyParams}` +
    `&daily=sunrise,sunset` +
    `&current_weather=true` +
    `&temperature_unit=fahrenheit` +
    `&wind_speed_unit=mph` +
    `&precipitation_unit=inch` +
    `&timezone=auto` +
    `&forecast_days=2`;

  try {
    const res = await fetch(url);
    if (!res.ok) {
      throw new Error(`Open-Meteo API returned ${res.status}`);
    }
    const data = await res.json();

    const hourly = data.hourly;
    const daily = data.daily;
    const times: string[] = hourly.time; // ISO strings in local tz

    // Get sunrise/sunset for today and tomorrow
    const sunrises: string[] = daily.sunrise || [];
    const sunsets: string[] = daily.sunset || [];

    // Build hour entries
    const hours = times.map((t: string, i: number) => {
      const isDay = hourly.is_day[i] === 1;

      // Find the matching day's sunrise/sunset
      const dateStr = t.substring(0, 10);
      const dayIdx = daily.time?.indexOf(dateStr) ?? 0;
      const sunrise = sunrises[dayIdx] || sunrises[0];
      const sunset = sunsets[dayIdx] || sunsets[0];

      return {
        time: t,
        hourLabel: formatHourLabel(t),
        isDay,
        sunrise,
        sunset,
      };
    });

    // Build altitude rows (surface + pressure levels)
    const altitudes = [
      // Surface 10m
      {
        key: "10m",
        feet: 33,
        label: "33 ft (Sfc)",
        wind: times.map((_: string, i: number) => ({
          speed: hourly.wind_speed_10m[i],
          directionFrom: hourly.wind_direction_10m[i],
          cardinal: degreesToCardinal(hourly.wind_direction_10m[i]),
        })),
        temp: hourly.temperature_2m as number[],
      },
      // Surface 80m
      {
        key: "80m",
        feet: 262,
        label: "262 ft",
        wind: times.map((_: string, i: number) => ({
          speed: hourly.wind_speed_80m[i],
          directionFrom: hourly.wind_direction_80m[i],
          cardinal: degreesToCardinal(hourly.wind_direction_80m[i]),
        })),
        temp: hourly.temperature_80m as number[],
      },
      // Pressure levels
      ...PRESSURE_LEVELS.map((p) => ({
        key: `${p.hPa}hPa`,
        feet: p.feet,
        label: p.label,
        wind: times.map((_: string, i: number) => ({
          speed: hourly[`windspeed_${p.hPa}hPa`]?.[i] ?? null,
          directionFrom: hourly[`winddirection_${p.hPa}hPa`]?.[i] ?? null,
          cardinal: hourly[`winddirection_${p.hPa}hPa`]?.[i] != null
            ? degreesToCardinal(hourly[`winddirection_${p.hPa}hPa`][i])
            : null,
        })),
        temp: (hourly[`temperature_${p.hPa}hPa`] as number[]) || times.map(() => null),
      })),
    ];

    // Surface data arrays
    const surface = {
      gusts: hourly.wind_gusts_10m as number[],
      temp: hourly.temperature_2m as number[],
      humidity: hourly.relative_humidity_2m as number[],
      dewpoint: hourly.dew_point_2m as number[],
      visibility: (hourly.visibility as number[])?.map((v: number) =>
        v != null ? Math.round(v * 0.000621371 * 10) / 10 : null
      ),
      cloudCover: hourly.cloud_cover as number[],
      weatherCode: hourly.weather_code as number[],
      isDay: hourly.is_day as number[],
    };

    return NextResponse.json({
      model: "gfs",
      hours,
      altitudes,
      surface,
      daily: {
        sunrise: sunrises,
        sunset: sunsets,
        dates: daily.time,
      },
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Failed to fetch Open-Meteo data";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
