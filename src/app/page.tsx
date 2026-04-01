"use client";

import { useState, FormEvent } from "react";
import dynamic from "next/dynamic";

const AirspaceMap = dynamic(() => import("@/components/AirspaceMap"), {
  ssr: false,
  loading: () => (
    <div className="w-full rounded-xl border border-card-border bg-background flex items-center justify-center text-muted text-sm" style={{ height: "380px" }}>
      Loading map...
    </div>
  ),
});

/* ------------------------------------------------------------------ */
/*  Types                                                              */
/* ------------------------------------------------------------------ */

interface WeatherData {
  location: { city: string; state: string; lat: number; lon: number; zip: string };
  current: {
    temperature: number;
    temperatureUnit: string;
    windSpeed: string;
    windDirection: string;
    windGust: string | null;
    visibility: string | null;
    shortForecast: string;
  };
  hourly: {
    time: string;
    temperature: number;
    temperatureUnit: string;
    windSpeed: string;
    windDirection: string;
    shortForecast: string;
  }[];
  forecast: {
    name: string;
    temperature: number;
    temperatureUnit: string;
    windSpeed: string;
    windDirection: string;
    shortForecast: string;
    isDaytime: boolean;
  }[];
  windsAloft: { altitude: string; wind: string }[] | null;
}

interface AirspaceLayer {
  airspaceClass: string;
  name: string;
  floor: string;
  ceiling: string;
  lowerFt: number;
  upperFt: number;
  touchesSurface: boolean;
  affectsParamotor: boolean;
}

interface AirspaceGeoJSON {
  type: "FeatureCollection";
  features: {
    type: "Feature";
    properties: {
      airspaceClass: string;
      name: string;
      ident: string;
      floor: string;
      ceiling: string;
      lowerFt: number;
      upperFt: number;
      touchesSurface: boolean;
    };
    geometry: {
      type: "Polygon";
      coordinates: number[][][];
    };
  }[];
}

interface AirspaceData {
  surfaceClass: string;
  canFly: boolean;
  nearestAirport: string | null;
  distanceNm: number | null;
  restrictions: string;
  recommendation: string;
  layers: AirspaceLayer[];
  mapGeoJSON: AirspaceGeoJSON;
  airports: { ident: string; name: string; distance: number }[];
  note: string;
  usedFallback: boolean;
}

/* ------------------------------------------------------------------ */
/*  Helpers                                                            */
/* ------------------------------------------------------------------ */

function windSpeedNumber(speed: string): number {
  const match = speed.match(/(\d+)/);
  return match ? parseInt(match[1]) : 0;
}

function getWindColor(speed: string): string {
  const mph = windSpeedNumber(speed);
  if (mph <= 8) return "text-safe";
  if (mph <= 14) return "text-warn";
  return "text-danger";
}

function getWindLabel(speed: string): string {
  const mph = windSpeedNumber(speed);
  if (mph <= 5) return "Calm - Perfect";
  if (mph <= 8) return "Light - Good";
  if (mph <= 12) return "Moderate - Caution";
  if (mph <= 18) return "Strong - Not Recommended";
  return "Dangerous - Do NOT Fly";
}

function getWindEmoji(speed: string): string {
  const mph = windSpeedNumber(speed);
  if (mph <= 8) return "✅";
  if (mph <= 14) return "⚠️";
  return "🚫";
}

function getVisibilityColor(vis: string | null): string {
  if (!vis) return "text-muted";
  const miles = parseFloat(vis);
  if (miles >= 5) return "text-safe";
  if (miles >= 3) return "text-warn";
  return "text-danger";
}

function formatHour(iso: string): string {
  const d = new Date(iso);
  return d.toLocaleTimeString("en-US", { hour: "numeric", hour12: true });
}

function getWeatherIcon(forecast: string): string {
  const f = forecast.toLowerCase();
  if (f.includes("thunder") || f.includes("storm")) return "⛈️";
  if (f.includes("rain") || f.includes("shower")) return "🌧️";
  if (f.includes("snow")) return "🌨️";
  if (f.includes("fog") || f.includes("haze") || f.includes("mist")) return "🌫️";
  if (f.includes("cloud") || f.includes("overcast")) return "☁️";
  if (f.includes("partly")) return "⛅";
  if (f.includes("sun") || f.includes("clear")) return "☀️";
  return "🌤️";
}

function directionArrow(dir: string): string {
  const arrows: Record<string, string> = {
    N: "↓", NNE: "↙", NE: "↙", ENE: "←",
    E: "←", ESE: "←", SE: "↖", SSE: "↖",
    S: "↑", SSW: "↗", SW: "↗", WSW: "→",
    W: "→", WNW: "→", NW: "↘", NNW: "↘",
  };
  return arrows[dir] || "•";
}

/* ------------------------------------------------------------------ */
/*  Sub-components                                                     */
/* ------------------------------------------------------------------ */

function StatusBadge({ ok, label }: { ok: boolean; label: string }) {
  return (
    <span
      className={`inline-flex items-center gap-1.5 rounded-full px-3 py-1 text-sm font-semibold ${
        ok
          ? "bg-safe/15 text-safe border border-safe/30"
          : "bg-danger/15 text-danger border border-danger/30"
      }`}
    >
      <span className="text-xs">{ok ? "●" : "●"}</span>
      {label}
    </span>
  );
}

function SectionCard({
  title,
  icon,
  children,
  delay = 0,
}: {
  title: string;
  icon: string;
  children: React.ReactNode;
  delay?: number;
}) {
  return (
    <div
      className="card animate-fade-in"
      style={{ animationDelay: `${delay}ms` }}
    >
      <h2 className="text-lg font-bold mb-4 flex items-center gap-2">
        <span className="text-2xl">{icon}</span>
        {title}
      </h2>
      {children}
    </div>
  );
}

function DataRow({
  label,
  value,
  colorClass,
  subtext,
}: {
  label: string;
  value: string;
  colorClass?: string;
  subtext?: string;
}) {
  return (
    <div className="flex items-start justify-between py-2 border-b border-card-border last:border-0">
      <span className="text-muted text-sm">{label}</span>
      <div className="text-right">
        <span className={`font-semibold ${colorClass || ""}`}>{value}</span>
        {subtext && <div className="text-xs text-muted mt-0.5">{subtext}</div>}
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/*  2-Stroke Mix Chart                                                 */
/* ------------------------------------------------------------------ */

function FuelMixChart() {
  const ratios = [
    { ratio: "32:1", mlPerGal: 4.0, ozPerGal: 4.0, use: "Break-in / Rich" },
    { ratio: "40:1", mlPerGal: 3.2, ozPerGal: 3.2, use: "Standard" },
    { ratio: "50:1", mlPerGal: 2.56, ozPerGal: 2.56, use: "Most Common" },
    { ratio: "60:1", mlPerGal: 2.13, ozPerGal: 2.13, use: "Lean" },
  ];

  const gallons = [1, 2, 2.5, 5];

  return (
    <div className="overflow-x-auto">
      <table className="w-full text-sm">
        <thead>
          <tr className="border-b border-card-border">
            <th className="text-left py-2 px-2 text-muted font-medium">Ratio</th>
            <th className="text-left py-2 px-2 text-muted font-medium">Use</th>
            {gallons.map((g) => (
              <th key={g} className="text-center py-2 px-2 text-muted font-medium">
                {g} gal
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {ratios.map((r) => (
            <tr key={r.ratio} className="border-b border-card-border last:border-0">
              <td className="py-2.5 px-2 font-bold text-sky">{r.ratio}</td>
              <td className="py-2.5 px-2 text-muted text-xs">{r.use}</td>
              {gallons.map((g) => (
                <td key={g} className="text-center py-2.5 px-2 font-mono">
                  {(r.ozPerGal * g).toFixed(1)} oz
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
      <p className="text-xs text-muted mt-3">
        Measurements are in fluid ounces of 2-stroke oil per gallons of gasoline.
        Always check your engine manufacturer&apos;s recommended ratio.
        Most paramotors use <span className="text-sky font-semibold">50:1</span>.
      </p>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/*  Main Page                                                          */
/* ------------------------------------------------------------------ */

export default function Home() {
  const [zip, setZip] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [weather, setWeather] = useState<WeatherData | null>(null);
  const [airspace, setAirspace] = useState<AirspaceData | null>(null);

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    if (!/^\d{5}$/.test(zip)) {
      setError("Please enter a valid 5-digit zip code");
      return;
    }

    setLoading(true);
    setError(null);
    setWeather(null);
    setAirspace(null);

    try {
      // Fetch weather first (it gives us lat/lon)
      const weatherRes = await fetch(`/api/weather?zip=${zip}`);
      const weatherData = await weatherRes.json();

      if (weatherData.error) {
        throw new Error(weatherData.error);
      }

      setWeather(weatherData);

      // Now fetch airspace with the lat/lon
      const { lat, lon } = weatherData.location;
      const airspaceRes = await fetch(`/api/airspace?lat=${lat}&lon=${lon}`);
      const airspaceData = await airspaceRes.json();

      if (airspaceData.error) {
        throw new Error(airspaceData.error);
      }

      setAirspace(airspaceData);
    } catch (err) {
      setError(
        err instanceof Error ? err.message : "Something went wrong. Please try again."
      );
    } finally {
      setLoading(false);
    }
  }

  const canFlyWeather =
    weather &&
    windSpeedNumber(weather.current.windSpeed) <= 14 &&
    (!weather.current.windGust || windSpeedNumber(weather.current.windGust) <= 20);

  const overallGoodToFly =
    canFlyWeather && airspace?.canFly;

  return (
    <div className="min-h-screen flex flex-col">
      {/* Header */}
      <header className="border-b border-card-border bg-card/50 backdrop-blur-sm sticky top-0 z-50">
        <div className="max-w-4xl mx-auto px-4 py-4 flex items-center gap-3">
          <span className="text-3xl">🪂</span>
          <div>
            <h1 className="text-xl font-bold tracking-tight">
              Paramotor Preflight
            </h1>
            <p className="text-xs text-muted">
              Airspace, weather &amp; fuel mixing reference
            </p>
          </div>
        </div>
      </header>

      {/* Main Content */}
      <main className="flex-1 max-w-4xl mx-auto w-full px-4 py-8">
        {/* Zip Code Input */}
        <div className="card mb-8">
          <form onSubmit={handleSubmit} className="flex flex-col sm:flex-row gap-3">
            <div className="flex-1">
              <label
                htmlFor="zip"
                className="block text-sm font-medium text-muted mb-1"
              >
                Enter your zip code to check flying conditions
              </label>
              <input
                id="zip"
                type="text"
                inputMode="numeric"
                pattern="[0-9]{5}"
                maxLength={5}
                placeholder="e.g. 32003"
                value={zip}
                onChange={(e) => setZip(e.target.value.replace(/\D/g, ""))}
                className="w-full rounded-lg bg-background border border-card-border px-4 py-3 text-lg font-mono tracking-widest placeholder:text-muted/50 focus:outline-none focus:ring-2 focus:ring-sky/50 focus:border-sky transition-colors"
              />
            </div>
            <button
              type="submit"
              disabled={loading || zip.length !== 5}
              className="self-end rounded-lg bg-sky px-8 py-3 text-base font-bold text-background hover:bg-sky/90 disabled:opacity-40 disabled:cursor-not-allowed transition-all"
            >
              {loading ? (
                <span className="flex items-center gap-2">
                  <svg
                    className="animate-spin h-5 w-5"
                    viewBox="0 0 24 24"
                    fill="none"
                  >
                    <circle
                      className="opacity-25"
                      cx="12"
                      cy="12"
                      r="10"
                      stroke="currentColor"
                      strokeWidth="4"
                    />
                    <path
                      className="opacity-75"
                      fill="currentColor"
                      d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z"
                    />
                  </svg>
                  Checking...
                </span>
              ) : (
                "Check Conditions"
              )}
            </button>
          </form>

          {error && (
            <div className="mt-4 rounded-lg bg-danger/10 border border-danger/30 px-4 py-3 text-danger text-sm">
              {error}
            </div>
          )}
        </div>

        {/* Results */}
        {weather && airspace && (
          <div className="space-y-6">
            {/* Overall Status Banner */}
            <div
              className={`card animate-fade-in border-2 ${
                overallGoodToFly
                  ? "border-safe/40 bg-safe/5"
                  : "border-danger/40 bg-danger/5"
              }`}
            >
              <div className="flex flex-col sm:flex-row items-start sm:items-center justify-between gap-4">
                <div>
                  <div className="flex items-center gap-2 mb-1">
                    <span className="text-3xl">
                      {overallGoodToFly ? "✅" : "⚠️"}
                    </span>
                    <h2
                      className={`text-2xl font-bold ${
                        overallGoodToFly ? "text-safe" : "text-danger"
                      }`}
                    >
                      {overallGoodToFly
                        ? "Conditions Look Good!"
                        : "Conditions Need Attention"}
                    </h2>
                  </div>
                  <p className="text-muted text-sm">
                    {weather.location.city}, {weather.location.state} ({zip})
                  </p>
                </div>
                <div className="flex flex-wrap gap-2">
                  <StatusBadge
                    ok={!!airspace.canFly}
                    label={airspace.canFly ? "Airspace OK" : "Airspace Issue"}
                  />
                  <StatusBadge
                    ok={!!canFlyWeather}
                    label={canFlyWeather ? "Weather OK" : "Weather Issue"}
                  />
                </div>
              </div>
            </div>

            {/* Airspace Section */}
            <SectionCard title="Airspace Classification" icon="🗺️" delay={100}>
              {/* Surface class summary */}
              <div
                className={`rounded-xl p-4 mb-4 ${
                  airspace.canFly
                    ? "bg-safe/10 border border-safe/20"
                    : "bg-danger/10 border border-danger/20"
                }`}
              >
                <div className="flex items-center gap-3 mb-2">
                  <span
                    className={`text-3xl font-black ${
                      airspace.canFly ? "text-safe" : "text-danger"
                    }`}
                  >
                    {airspace.surfaceClass}
                  </span>
                  <div>
                    <p className="font-semibold">
                      Class {airspace.surfaceClass} at your location
                    </p>
                    <p
                      className={`text-sm ${
                        airspace.canFly ? "text-safe" : "text-danger"
                      }`}
                    >
                      {airspace.canFly
                        ? "Part 103 ultralights CAN fly here"
                        : "Part 103 ultralights CANNOT fly here without authorization"}
                    </p>
                  </div>
                </div>
              </div>

              {/* Airspace layers stack */}
              {airspace.layers.length > 0 && (
                <div className="mb-4">
                  <p className="text-xs text-muted mb-2 font-medium uppercase tracking-wide">
                    Airspace Layers Above You
                  </p>
                  <div className="space-y-2">
                    {airspace.layers.map((layer, i) => {
                      const isRestricted =
                        layer.touchesSurface &&
                        ["B", "C", "D"].includes(layer.airspaceClass);
                      const bgColor = isRestricted
                        ? "bg-danger/10 border-danger/20"
                        : layer.affectsParamotor
                        ? "bg-warn/10 border-warn/20"
                        : "bg-background border-card-border";
                      return (
                        <div
                          key={i}
                          className={`rounded-lg p-3 border text-sm ${bgColor}`}
                        >
                          <div className="flex items-center justify-between">
                            <div className="flex items-center gap-2">
                              <span
                                className={`font-black text-lg ${
                                  isRestricted
                                    ? "text-danger"
                                    : layer.affectsParamotor
                                    ? "text-warn"
                                    : "text-muted"
                                }`}
                              >
                                {layer.airspaceClass}
                              </span>
                              <span className="text-muted">
                                {layer.name || `Class ${layer.airspaceClass}`}
                              </span>
                            </div>
                            <span className="font-mono text-xs text-muted">
                              {layer.floor} &ndash; {layer.ceiling}
                            </span>
                          </div>
                          {layer.affectsParamotor && (
                            <p className="text-xs mt-1 text-muted">
                              {layer.touchesSurface
                                ? "Extends to the surface"
                                : `Floor at ${layer.floor} — fly below this`}
                            </p>
                          )}
                        </div>
                      );
                    })}
                  </div>
                  <p className="text-xs text-muted mt-2">
                    Only layers reaching the surface or below ~1,500 ft affect paramotor operations.
                  </p>
                </div>
              )}

              <DataRow label="Restrictions" value={airspace.restrictions} />
              {airspace.nearestAirport && (
                <DataRow
                  label="Nearest Airport"
                  value={airspace.nearestAirport}
                  subtext={`${airspace.distanceNm} NM away`}
                />
              )}
              <DataRow label="Recommendation" value={airspace.recommendation} />

              {airspace.airports?.length > 0 && (
                <div className="mt-4">
                  <p className="text-xs text-muted mb-2 font-medium">
                    NEARBY AIRPORTS
                  </p>
                  <div className="flex flex-wrap gap-2">
                    {airspace.airports.map((a) => (
                      <span
                        key={a.ident}
                        className="text-xs bg-background rounded-lg px-2.5 py-1.5 border border-card-border"
                      >
                        {a.ident} - {a.distance} NM
                      </span>
                    ))}
                  </div>
                </div>
              )}

              {/* Airspace Map */}
              {airspace.mapGeoJSON && weather && (
                <div className="mt-4">
                  <p className="text-xs text-muted mb-2 font-medium uppercase tracking-wide">
                    Airspace Map
                  </p>
                  <AirspaceMap
                    lat={weather.location.lat}
                    lon={weather.location.lon}
                    geoJSON={airspace.mapGeoJSON}
                  />
                  <p className="text-xs text-muted mt-2">
                    Solid shapes = extends to surface. Dashed shapes = shelves/upper layers (you can fly below them).
                    Click any shape to see its class and altitude range.
                  </p>
                </div>
              )}

              <div className="mt-4 rounded-lg bg-warn/10 border border-warn/20 px-3 py-2 text-xs text-warn">
                <strong>Disclaimer:</strong> {airspace.note}
              </div>
            </SectionCard>

            {/* Current Weather */}
            <SectionCard title="Current Conditions" icon="🌤️" delay={200}>
              <div className="grid grid-cols-2 sm:grid-cols-3 gap-4 mb-4">
                {/* Temperature */}
                <div className="rounded-xl bg-background p-4 border border-card-border text-center">
                  <p className="text-xs text-muted mb-1">Temperature</p>
                  <p className="text-3xl font-bold">
                    {weather.current.temperature}°
                    <span className="text-lg text-muted">
                      {weather.current.temperatureUnit}
                    </span>
                  </p>
                  <p className="text-xs text-muted mt-1">
                    {getWeatherIcon(weather.current.shortForecast)}{" "}
                    {weather.current.shortForecast}
                  </p>
                </div>

                {/* Wind */}
                <div className="rounded-xl bg-background p-4 border border-card-border text-center">
                  <p className="text-xs text-muted mb-1">Wind</p>
                  <p className={`text-3xl font-bold ${getWindColor(weather.current.windSpeed)}`}>
                    {weather.current.windSpeed}
                  </p>
                  <p className="text-sm mt-1">
                    <span className="text-lg">
                      {directionArrow(weather.current.windDirection)}
                    </span>{" "}
                    {weather.current.windDirection}
                  </p>
                  <p
                    className={`text-xs mt-1 font-semibold ${getWindColor(
                      weather.current.windSpeed
                    )}`}
                  >
                    {getWindEmoji(weather.current.windSpeed)}{" "}
                    {getWindLabel(weather.current.windSpeed)}
                  </p>
                </div>

                {/* Gusts */}
                <div className="rounded-xl bg-background p-4 border border-card-border text-center col-span-2 sm:col-span-1">
                  <p className="text-xs text-muted mb-1">Wind Gusts</p>
                  <p
                    className={`text-3xl font-bold ${
                      weather.current.windGust
                        ? getWindColor(weather.current.windGust)
                        : "text-safe"
                    }`}
                  >
                    {weather.current.windGust || "None"}
                  </p>
                  {weather.current.windGust && (
                    <p className="text-xs text-warn mt-1">
                      Gusts can be dangerous for paramotors
                    </p>
                  )}
                </div>
              </div>

              <DataRow
                label="Visibility"
                value={weather.current.visibility || "Data unavailable"}
                colorClass={getVisibilityColor(weather.current.visibility)}
                subtext={
                  weather.current.visibility
                    ? parseFloat(weather.current.visibility) >= 3
                      ? "VFR minimums met"
                      : "Below VFR minimums - DO NOT FLY"
                    : undefined
                }
              />
            </SectionCard>

            {/* Hourly Wind Forecast */}
            <SectionCard title="Hourly Wind Forecast" icon="📊" delay={300}>
              <div className="overflow-x-auto -mx-2">
                <div className="flex gap-2 px-2 pb-2 min-w-max">
                  {weather.hourly.slice(0, 12).map((h, i) => (
                    <div
                      key={i}
                      className="flex-shrink-0 w-20 rounded-xl bg-background border border-card-border p-3 text-center text-xs"
                    >
                      <p className="text-muted font-medium">{formatHour(h.time)}</p>
                      <p className="text-lg my-1">
                        {getWeatherIcon(h.shortForecast)}
                      </p>
                      <p
                        className={`font-bold text-sm ${getWindColor(h.windSpeed)}`}
                      >
                        {h.windSpeed}
                      </p>
                      <p className="text-muted">
                        {directionArrow(h.windDirection)} {h.windDirection}
                      </p>
                      <p className="font-semibold mt-1">
                        {h.temperature}°{h.temperatureUnit}
                      </p>
                    </div>
                  ))}
                </div>
              </div>
              <p className="text-xs text-muted mt-2">
                Scroll right to see more hours →
              </p>
            </SectionCard>

            {/* Winds Aloft */}
            {weather.windsAloft && (
              <SectionCard title="Winds Aloft" icon="🌬️" delay={400}>
                <p className="text-xs text-muted mb-3">
                  Wind speed and direction at different altitudes. Important for
                  understanding turbulence and wind shear.
                </p>
                {weather.windsAloft.map((w, i) => (
                  <DataRow key={i} label={w.altitude} value={w.wind} />
                ))}
              </SectionCard>
            )}

            {/* Extended Forecast */}
            <SectionCard title="Extended Forecast" icon="📅" delay={500}>
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                {weather.forecast.map((p, i) => (
                  <div
                    key={i}
                    className={`rounded-xl bg-background border border-card-border p-4 ${
                      !p.isDaytime ? "opacity-70" : ""
                    }`}
                  >
                    <div className="flex justify-between items-start mb-2">
                      <p className="font-semibold text-sm">{p.name}</p>
                      <span className="text-2xl">
                        {getWeatherIcon(p.shortForecast)}
                      </span>
                    </div>
                    <p className="text-2xl font-bold mb-1">
                      {p.temperature}°{p.temperatureUnit}
                    </p>
                    <p className="text-xs text-muted mb-2">{p.shortForecast}</p>
                    <div className="flex items-center gap-2 text-xs">
                      <span className={getWindColor(p.windSpeed)}>
                        {getWindEmoji(p.windSpeed)} {p.windSpeed}
                      </span>
                      <span className="text-muted">
                        {directionArrow(p.windDirection)} {p.windDirection}
                      </span>
                    </div>
                  </div>
                ))}
              </div>
            </SectionCard>

            {/* 2-Stroke Mix Chart */}
            <SectionCard title="2-Stroke Fuel Mixing" icon="⛽" delay={600}>
              <FuelMixChart />
            </SectionCard>

            {/* Safety Checklist */}
            <SectionCard title="Quick Preflight Reminders" icon="📋" delay={700}>
              <ul className="space-y-2 text-sm">
                {[
                  "Check NOTAMs & TFRs at tfr.faa.gov before every flight",
                  "Part 103: Max 5 gal fuel, empty weight under 254 lbs, single seat only",
                  "VFR weather minimums: 3 mi visibility, 500 ft below / 1000 ft above / 2000 ft horizontal from clouds",
                  "Fly during daylight hours only (sunrise to sunset)",
                  "Do not fly over congested areas or open-air assemblies",
                  "Always do a thorough preflight inspection of wing, lines, motor, and harness",
                  "Tell someone where you&apos;re flying and when you expect to return",
                ].map((item, i) => (
                  <li key={i} className="flex gap-2 items-start">
                    <span className="text-sky mt-0.5 flex-shrink-0">•</span>
                    <span className="text-muted">{item}</span>
                  </li>
                ))}
              </ul>
            </SectionCard>
          </div>
        )}

        {/* Show fuel chart even without weather lookup */}
        {!weather && !loading && (
          <div className="space-y-6 animate-fade-in">
            <SectionCard title="2-Stroke Fuel Mixing Chart" icon="⛽">
              <FuelMixChart />
            </SectionCard>
          </div>
        )}
      </main>

      {/* Footer */}
      <footer className="border-t border-card-border py-6 text-center text-xs text-muted">
        <p>
          This tool is for reference only. Always verify airspace on current VFR
          Sectional Charts and check NOTAMs before flying.
        </p>
        <p className="mt-1">
          Weather data from the National Weather Service. Airspace data is
          approximate.
        </p>
      </footer>
    </div>
  );
}
