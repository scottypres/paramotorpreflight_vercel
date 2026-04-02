"use client";

import React, { useState, useEffect, useCallback, useRef, FormEvent } from "react";
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
/*  Cookie helpers & threshold defaults                                */
/* ------------------------------------------------------------------ */

const DEFAULT_THRESHOLDS = {
  maxWind: 14,    // mph
  maxGust: 20,    // mph
  minVisibility: 3, // statute miles
};

type Thresholds = typeof DEFAULT_THRESHOLDS;

function getCookie(name: string): string | null {
  if (typeof document === "undefined") return null;
  const match = document.cookie.match(new RegExp(`(?:^|; )${name}=([^;]*)`));
  return match ? decodeURIComponent(match[1]) : null;
}

function setCookie(name: string, value: string, days = 365) {
  const expires = new Date(Date.now() + days * 864e5).toUTCString();
  document.cookie = `${name}=${encodeURIComponent(value)};expires=${expires};path=/;SameSite=Lax`;
}

function loadThresholds(): Thresholds {
  try {
    const raw = getCookie("ppf_thresholds");
    if (raw) {
      const parsed = JSON.parse(raw);
      return { ...DEFAULT_THRESHOLDS, ...parsed };
    }
  } catch { /* use defaults */ }
  return { ...DEFAULT_THRESHOLDS };
}

function saveThresholds(t: Thresholds) {
  setCookie("ppf_thresholds", JSON.stringify(t));
}

/* ------------------------------------------------------------------ */
/*  Types                                                              */
/* ------------------------------------------------------------------ */

interface WeatherData {
  location: { city: string; state: string; lat: number; lon: number; zip: string };
  sunrise: string;
  sunset: string;
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
    windGust: string | null;
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
  windsAloft: { altitude: string; wind: string; temp: string | null }[] | null;
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

interface OpenMeteoHour {
  time: string;
  hourLabel: string;
  dateLabel: string;
  isDay: boolean;
  sunrise: string;
  sunset: string;
}

interface OpenMeteoAltitude {
  key: string;
  feet: number;
  label: string;
  wind: { speed: number | null; directionFrom: number | null; cardinal: string | null }[];
  temp: (number | null)[];
}

interface OpenMeteoData {
  model: string;
  hours: OpenMeteoHour[];
  altitudes: OpenMeteoAltitude[];
  surface: {
    gusts: number[];
    temp: number[];
    humidity: number[];
    dewpoint: number[];
    visibility: (number | null)[];
    cloudCover: number[];
    weatherCode: number[];
    isDay: number[];
  };
  daily: {
    sunrise: string[];
    sunset: string[];
    dates: string[];
  };
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

function getWindColorNum(mph: number | null): string {
  if (mph == null) return "text-muted";
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
  const h = d.getHours();
  if (h === 0) return "12 AM";
  if (h === 12) return "12 PM";
  if (h < 12) return `${h} AM`;
  return `${h - 12} PM`;
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
  const [query, setQuery] = useState("");
  const [loading, setLoading] = useState(false);
  const [locating, setLocating] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [weather, setWeather] = useState<WeatherData | null>(null);
  const [airspace, setAirspace] = useState<AirspaceData | null>(null);
  const [meteo, setMeteo] = useState<OpenMeteoData | null>(null);
  const [thresholds, setThresholds] = useState<Thresholds>(DEFAULT_THRESHOLDS);
  const [showSettings, setShowSettings] = useState(false);
  const [showAirspaceDetails, setShowAirspaceDetails] = useState(false);

  const [selectedHourIndex, setSelectedHourIndex] = useState<number | null>(null);
  const hourlyScrollRef = useRef<HTMLDivElement>(null);
  const currentHourRef = useRef<HTMLTableRowElement>(null);
  const touchStartX = useRef<number | null>(null);
  const dayIndicesRef = useRef<number[]>([]);

  // Autocomplete state
  const [suggestions, setSuggestions] = useState<{ label: string; full: string; lat: number; lon: number }[]>([]);
  const [showSuggestions, setShowSuggestions] = useState(false);
  const [activeSuggestion, setActiveSuggestion] = useState(-1);
  const autocompleteTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const inputWrapperRef = useRef<HTMLDivElement>(null);

  // Load thresholds from cookie on mount
  useEffect(() => {
    setThresholds(loadThresholds());
  }, []);

  // Auto-scroll hourly table to current hour when data loads
  useEffect(() => {
    if (meteo && currentHourRef.current && hourlyScrollRef.current) {
      const container = hourlyScrollRef.current;
      const row = currentHourRef.current;
      const rowTop = row.offsetTop - container.offsetTop;
      container.scrollTop = Math.max(0, rowTop - row.offsetHeight);
    }
    setSelectedHourIndex(null);
  }, [meteo]);

  // Close suggestions when clicking outside
  useEffect(() => {
    function handleClickOutside(e: MouseEvent) {
      if (inputWrapperRef.current && !inputWrapperRef.current.contains(e.target as Node)) {
        setShowSuggestions(false);
      }
    }
    document.addEventListener("mousedown", handleClickOutside);
    return () => document.removeEventListener("mousedown", handleClickOutside);
  }, []);

  // Debounced autocomplete fetch
  const fetchSuggestions = useCallback((value: string) => {
    if (autocompleteTimer.current) clearTimeout(autocompleteTimer.current);

    // Don't autocomplete zip codes or very short queries
    if (value.trim().length < 3 || /^\d+$/.test(value.trim())) {
      setSuggestions([]);
      setShowSuggestions(false);
      return;
    }

    autocompleteTimer.current = setTimeout(async () => {
      try {
        const res = await fetch(`/api/autocomplete?q=${encodeURIComponent(value.trim())}`);
        const data = await res.json();
        setSuggestions(data);
        setShowSuggestions(data.length > 0);
        setActiveSuggestion(-1);
      } catch {
        setSuggestions([]);
        setShowSuggestions(false);
      }
    }, 300);
  }, []);

  function handleQueryChange(value: string) {
    setQuery(value);
    fetchSuggestions(value);
  }

  function selectSuggestion(suggestion: { label: string; lat: number; lon: number }) {
    setQuery(suggestion.label);
    setSuggestions([]);
    setShowSuggestions(false);
    fetchData(`/api/weather?lat=${suggestion.lat}&lon=${suggestion.lon}`);
  }

  function handleKeyDownSuggestions(e: React.KeyboardEvent) {
    if (!showSuggestions || suggestions.length === 0) return;

    if (e.key === "ArrowDown") {
      e.preventDefault();
      setActiveSuggestion((prev) => (prev < suggestions.length - 1 ? prev + 1 : 0));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setActiveSuggestion((prev) => (prev > 0 ? prev - 1 : suggestions.length - 1));
    } else if (e.key === "Enter" && activeSuggestion >= 0) {
      e.preventDefault();
      selectSuggestion(suggestions[activeSuggestion]);
    } else if (e.key === "Escape") {
      setShowSuggestions(false);
    }
  }

  const updateThreshold = useCallback((key: keyof Thresholds, value: number) => {
    setThresholds((prev) => {
      const next = { ...prev, [key]: value };
      saveThresholds(next);
      return next;
    });
  }, []);

  async function fetchData(weatherUrl: string) {
    setLoading(true);
    setError(null);
    setWeather(null);
    setAirspace(null);
    setMeteo(null);

    try {
      const weatherRes = await fetch(weatherUrl);
      const weatherData = await weatherRes.json();

      if (weatherData.error) {
        throw new Error(weatherData.error);
      }

      setWeather(weatherData);

      const { lat, lon } = weatherData.location;

      // Fetch airspace and Open-Meteo in parallel
      const [airspaceRes, meteoRes] = await Promise.all([
        fetch(`/api/airspace?lat=${lat}&lon=${lon}`),
        fetch(`/api/openmeteo?lat=${lat}&lon=${lon}`),
      ]);

      const airspaceData = await airspaceRes.json();
      if (airspaceData.error) {
        throw new Error(airspaceData.error);
      }
      setAirspace(airspaceData);

      const meteoData = await meteoRes.json();
      if (!meteoData.error) {
        setMeteo(meteoData);
      }
    } catch (err) {
      setError(
        err instanceof Error ? err.message : "Something went wrong. Please try again."
      );
    } finally {
      setLoading(false);
    }
  }

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    const trimmed = query.trim();
    if (!trimmed) {
      setError("Please enter a location");
      return;
    }
    // If it looks like a zip code, use the zip param; otherwise use freeform query
    if (/^\d{5}$/.test(trimmed)) {
      fetchData(`/api/weather?zip=${trimmed}`);
    } else {
      fetchData(`/api/weather?q=${encodeURIComponent(trimmed)}`);
    }
  }

  function handleUseLocation() {
    if (!navigator.geolocation) {
      setError("Geolocation is not supported by your browser");
      return;
    }

    setLocating(true);
    setError(null);

    navigator.geolocation.getCurrentPosition(
      (position) => {
        setLocating(false);
        const { latitude, longitude } = position.coords;
        fetchData(`/api/weather?lat=${latitude}&lon=${longitude}`);
      },
      (err) => {
        setLocating(false);
        switch (err.code) {
          case err.PERMISSION_DENIED:
            setError("Location access denied. Please enter a zip code instead.");
            break;
          case err.POSITION_UNAVAILABLE:
            setError("Location unavailable. Please enter a zip code instead.");
            break;
          default:
            setError("Could not get your location. Please enter a zip code instead.");
        }
      },
      { enableHighAccuracy: true, timeout: 10000, maximumAge: 300000 }
    );
  }

  const canFlyWeather =
    weather &&
    windSpeedNumber(weather.current.windSpeed) <= thresholds.maxWind &&
    (!weather.current.windGust || windSpeedNumber(weather.current.windGust) <= thresholds.maxGust) &&
    (!weather.current.visibility || parseFloat(weather.current.visibility) >= thresholds.minVisibility);

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
            <div className="flex-1 relative" ref={inputWrapperRef}>
              <label
                htmlFor="location"
                className="block text-sm font-medium text-muted mb-1"
              >
                Enter a zip code, city, or place name to check flying conditions
              </label>
              <input
                id="location"
                type="text"
                autoComplete="off"
                placeholder="e.g. 32003, Jacksonville FL, Lake Okeechobee"
                value={query}
                onChange={(e) => handleQueryChange(e.target.value)}
                onKeyDown={handleKeyDownSuggestions}
                onFocus={() => { if (suggestions.length > 0) setShowSuggestions(true); }}
                className="w-full rounded-lg bg-background border border-card-border px-4 py-3 text-lg placeholder:text-muted/50 focus:outline-none focus:ring-2 focus:ring-sky/50 focus:border-sky transition-colors"
              />
              {showSuggestions && suggestions.length > 0 && (
                <ul className="absolute z-50 left-0 right-0 mt-1 rounded-lg bg-card border border-card-border shadow-lg overflow-hidden">
                  {suggestions.map((s, i) => (
                    <li
                      key={i}
                      className={`px-4 py-3 text-sm cursor-pointer transition-colors ${
                        i === activeSuggestion
                          ? "bg-sky/15 text-sky"
                          : "hover:bg-sky/10 text-foreground"
                      }`}
                      onMouseDown={() => selectSuggestion(s)}
                      onMouseEnter={() => setActiveSuggestion(i)}
                    >
                      <span className="font-medium">{s.label}</span>
                      {s.full !== s.label && (
                        <span className="text-muted text-xs ml-2 truncate">
                          {s.full.length > 60 ? s.full.substring(0, 60) + "..." : s.full}
                        </span>
                      )}
                    </li>
                  ))}
                </ul>
              )}
            </div>
            <div className="flex gap-2 self-end">
              <button
                type="submit"
                disabled={loading || locating || query.trim().length === 0}
                className="rounded-lg bg-sky px-6 py-3 text-base font-bold text-background hover:bg-sky/90 disabled:opacity-40 disabled:cursor-not-allowed transition-all"
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
                  "Check"
                )}
              </button>
              <button
                type="button"
                onClick={handleUseLocation}
                disabled={loading || locating}
                className="rounded-lg border border-card-border bg-background px-4 py-3 text-sm font-medium text-muted hover:text-foreground hover:border-sky/50 disabled:opacity-40 disabled:cursor-not-allowed transition-all"
              >
                {locating ? (
                  <span className="flex items-center gap-2">
                    <svg
                      className="animate-spin h-4 w-4"
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
                    Locating...
                  </span>
                ) : (
                  <span className="flex items-center gap-1.5">
                    <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 20 20" fill="currentColor" className="w-4 h-4">
                      <path fillRule="evenodd" d="M9.69 18.933l.003.001C9.89 19.02 10 19 10 19s.11.02.308-.066l.002-.001.006-.003.018-.008a5.741 5.741 0 00.281-.14c.186-.096.446-.24.757-.433.62-.384 1.445-.966 2.274-1.765C15.302 14.988 17 12.493 17 9A7 7 0 103 9c0 3.492 1.698 5.988 3.355 7.584a13.731 13.731 0 002.273 1.765 11.842 11.842 0 00.976.544l.062.029.018.008.006.003zM10 11.25a2.25 2.25 0 100-4.5 2.25 2.25 0 000 4.5z" clipRule="evenodd" />
                    </svg>
                    Use My Location
                  </span>
                )}
              </button>
            </div>
          </form>

          {error && (
            <div className="mt-4 rounded-lg bg-danger/10 border border-danger/30 px-4 py-3 text-danger text-sm">
              {error}
            </div>
          )}
        </div>

        {/* Flyable Conditions Settings */}
        <div className="card mb-6">
          <button
            type="button"
            onClick={() => setShowSettings(!showSettings)}
            className="w-full flex items-center justify-between text-sm font-medium text-muted hover:text-foreground transition-colors"
          >
            <span className="flex items-center gap-2">
              <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 20 20" fill="currentColor" className="w-4 h-4">
                <path fillRule="evenodd" d="M7.84 1.804A1 1 0 018.82 1h2.36a1 1 0 01.98.804l.331 1.652a6.993 6.993 0 011.929 1.115l1.598-.54a1 1 0 011.186.447l1.18 2.044a1 1 0 01-.205 1.251l-1.267 1.113a7.047 7.047 0 010 2.228l1.267 1.113a1 1 0 01.206 1.25l-1.18 2.045a1 1 0 01-1.187.447l-1.598-.54a6.993 6.993 0 01-1.929 1.115l-.33 1.652a1 1 0 01-.98.804H8.82a1 1 0 01-.98-.804l-.331-1.652a6.993 6.993 0 01-1.929-1.115l-1.598.54a1 1 0 01-1.186-.447l-1.18-2.044a1 1 0 01.205-1.251l1.267-1.114a7.05 7.05 0 010-2.227L1.821 7.773a1 1 0 01-.206-1.25l1.18-2.045a1 1 0 011.187-.447l1.598.54A6.993 6.993 0 017.51 3.456l.33-1.652zM10 13a3 3 0 100-6 3 3 0 000 6z" clipRule="evenodd" />
              </svg>
              Flyable Conditions Settings
            </span>
            <span className="text-xs">{showSettings ? "▲" : "▼"}</span>
          </button>

          {showSettings && (
            <div className="mt-4 space-y-4 pt-4 border-t border-card-border">
              <p className="text-xs text-muted">
                Adjust thresholds for the go/no-go assessment. These are saved to your browser.
              </p>

              {/* Max Wind Speed */}
              <div>
                <div className="flex justify-between text-sm mb-1">
                  <label htmlFor="maxWind">Max Wind Speed</label>
                  <span className="font-mono font-bold text-sky">{thresholds.maxWind} mph</span>
                </div>
                <input
                  id="maxWind"
                  type="range"
                  min={5}
                  max={30}
                  step={1}
                  value={thresholds.maxWind}
                  onChange={(e) => updateThreshold("maxWind", parseInt(e.target.value))}
                  className="w-full accent-sky"
                />
                <div className="flex justify-between text-xs text-muted">
                  <span>5 mph</span>
                  <span>30 mph</span>
                </div>
              </div>

              {/* Max Gust */}
              <div>
                <div className="flex justify-between text-sm mb-1">
                  <label htmlFor="maxGust">Max Wind Gust</label>
                  <span className="font-mono font-bold text-sky">{thresholds.maxGust} mph</span>
                </div>
                <input
                  id="maxGust"
                  type="range"
                  min={10}
                  max={40}
                  step={1}
                  value={thresholds.maxGust}
                  onChange={(e) => updateThreshold("maxGust", parseInt(e.target.value))}
                  className="w-full accent-sky"
                />
                <div className="flex justify-between text-xs text-muted">
                  <span>10 mph</span>
                  <span>40 mph</span>
                </div>
              </div>

              {/* Min Visibility */}
              <div>
                <div className="flex justify-between text-sm mb-1">
                  <label htmlFor="minVis">Min Visibility</label>
                  <span className="font-mono font-bold text-sky">{thresholds.minVisibility} mi</span>
                </div>
                <input
                  id="minVis"
                  type="range"
                  min={1}
                  max={10}
                  step={0.5}
                  value={thresholds.minVisibility}
                  onChange={(e) => updateThreshold("minVisibility", parseFloat(e.target.value))}
                  className="w-full accent-sky"
                />
                <div className="flex justify-between text-xs text-muted">
                  <span>1 mi</span>
                  <span>10 mi</span>
                </div>
              </div>

              <button
                type="button"
                onClick={() => {
                  setThresholds({ ...DEFAULT_THRESHOLDS });
                  saveThresholds(DEFAULT_THRESHOLDS);
                }}
                className="text-xs text-muted hover:text-foreground transition-colors underline"
              >
                Reset to defaults (Wind: 14 mph, Gust: 20 mph, Visibility: 3 mi)
              </button>
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
                    {weather.location.city}, {weather.location.state}
                    {weather.location.zip ? ` (${weather.location.zip})` : ""}
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
                      const restricted =
                        ["B", "C", "D", "P", "R"].includes(layer.airspaceClass);
                      const caution =
                        ["MOA", "W", "A"].includes(layer.airspaceClass);
                      const bgColor = restricted
                        ? "bg-danger/10 border-danger/20"
                        : caution
                        ? "bg-orange/10 border-orange/20"
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
                                  restricted
                                    ? "text-danger"
                                    : caution
                                    ? "text-orange"
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

              <button
                type="button"
                onClick={() => setShowAirspaceDetails(!showAirspaceDetails)}
                className="w-full flex items-center justify-between text-sm font-medium text-muted hover:text-foreground transition-colors mt-2 py-2"
              >
                <span>Additional Info</span>
                <span className="text-xs">{showAirspaceDetails ? "▲" : "▼"}</span>
              </button>

              {showAirspaceDetails && (
                <div className="pt-2 border-t border-card-border space-y-0">
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
                    <div className="mt-4 pt-2">
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

            {/* Hourly Wind Forecast (Open-Meteo) */}
            {meteo && (
              <SectionCard title="Hourly Wind Forecast" icon="📊" delay={300}>
                {(() => {
                  // Show daylight hours within 2h ago to 24h forward
                  const ONE_HOUR = 60 * 60 * 1000;
                  const now = Date.now();
                  const windowStart = now - 2 * ONE_HOUR;
                  const windowEnd = now + 24 * ONE_HOUR;

                  // Build filtered indices: within time window AND within daylight (1h before sunrise to 1h after sunset)
                  const dayIndices: number[] = [];
                  for (let i = 0; i < meteo.hours.length; i++) {
                    const h = meteo.hours[i];
                    const t = new Date(h.time).getTime();
                    // Must be within the 2h ago → 24h forward window
                    if (t < windowStart || t > windowEnd) continue;
                    // Must be within daylight for that day
                    const sunrise = new Date(h.sunrise).getTime() - ONE_HOUR;
                    const sunset = new Date(h.sunset).getTime() + ONE_HOUR;
                    if (t >= sunrise && t <= sunset) {
                      dayIndices.push(i);
                    }
                  }

                  // Find current hour within filtered list
                  let currentFilteredIdx = 0;
                  for (let fi = 0; fi < dayIndices.length; fi++) {
                    if (new Date(meteo.hours[dayIndices[fi]].time).getTime() <= now) {
                      currentFilteredIdx = fi;
                    }
                  }

                  // Sunrise/sunset from today
                  const sunriseLocal = new Date(meteo.daily.sunrise[0]).toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit", hour12: true });
                  const sunsetLocal = new Date(meteo.daily.sunset[0]).toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit", hour12: true });

                  // Surface altitude row (10m) for wind data
                  const sfc = meteo.altitudes[0]; // 10m surface

                  return (
                    <>
                      <div className="flex gap-4 mb-3 text-xs text-muted">
                        <span>Sunrise: <span className="text-warn font-semibold">{sunriseLocal}</span></span>
                        <span>Sunset: <span className="text-orange font-semibold">{sunsetLocal}</span></span>
                      </div>
                      <div
                        ref={hourlyScrollRef}
                        className="overflow-y-auto max-h-[320px]"
                      >
                        <table className="w-full text-sm">
                          <thead className="sticky top-0 bg-card z-10">
                            <tr className="border-b border-card-border">
                              <th className="text-left py-2 px-2 text-muted font-medium">Time</th>
                              <th className="text-left py-2 px-2 text-muted font-medium">Wind</th>
                              <th className="text-left py-2 px-2 text-muted font-medium">Gusts</th>
                              <th className="text-left py-2 px-2 text-muted font-medium">Dir</th>
                              <th className="text-right py-2 px-2 text-muted font-medium">Temp</th>
                            </tr>
                          </thead>
                          <tbody>
                            {dayIndices.map((gi, fi) => {
                              const h = meteo.hours[gi];
                              const wind = sfc.wind[gi];
                              const gust = meteo.surface.gusts[gi];
                              const temp = meteo.surface.temp[gi];
                              const isNow = fi === currentFilteredIdx;
                              const isSelected = selectedHourIndex === fi;

                              // Show date header when date changes
                              const prevGi = fi > 0 ? dayIndices[fi - 1] : -1;
                              const prevDate = prevGi >= 0 ? meteo.hours[prevGi].dateLabel : "";
                              const showDate = h.dateLabel !== prevDate;

                              return (
                                <React.Fragment key={gi}>
                                  {showDate && (
                                    <tr className="bg-card-border/20">
                                      <td colSpan={5} className="py-1.5 px-2 text-xs font-semibold text-muted">
                                        {h.dateLabel}
                                      </td>
                                    </tr>
                                  )}
                                  <tr
                                    ref={isNow ? currentHourRef : undefined}
                                    onClick={() => setSelectedHourIndex(isSelected ? null : fi)}
                                    className={`border-b border-card-border last:border-0 cursor-pointer transition-colors ${
                                      isSelected
                                        ? "bg-sky/15 border-sky/30"
                                        : isNow
                                        ? "bg-sky/5"
                                        : "hover:bg-card-border/30"
                                    }`}
                                  >
                                    <td className={`py-2 px-2 font-medium whitespace-nowrap ${isNow ? "text-sky" : ""}`}>
                                      {h.hourLabel}{isNow ? " *" : ""}
                                    </td>
                                    <td className={`py-2 px-2 font-bold ${getWindColorNum(wind.speed)}`}>
                                      {wind.speed != null ? `${Math.round(wind.speed)} mph` : "—"}
                                    </td>
                                    <td className={`py-2 px-2 ${gust != null ? getWindColorNum(gust) + " font-bold" : "text-muted"}`}>
                                      {gust != null ? `${Math.round(gust)} mph` : "—"}
                                    </td>
                                    <td className="py-2 px-2 whitespace-nowrap">
                                      {wind.cardinal ? (
                                        <><span className="text-base">{directionArrow(wind.cardinal)}</span> {wind.cardinal}</>
                                      ) : "—"}
                                    </td>
                                    <td className="py-2 px-2 text-right font-mono">
                                      {temp != null ? `${Math.round(temp)}°F` : "—"}
                                    </td>
                                  </tr>
                                </React.Fragment>
                              );
                            })}
                          </tbody>
                        </table>
                      </div>
                      <p className="text-xs text-muted mt-2">
                        1h before sunrise to 1h after sunset. Click a row to update winds aloft. * = current hour.
                      </p>
                    </>
                  );
                })()}
              </SectionCard>
            )}

            {/* Winds Aloft (Open-Meteo pressure levels) */}
            {meteo && (
              <SectionCard title="Winds Aloft" icon="🌬️" delay={400}>
                {(() => {
                  const ONE_HOUR = 60 * 60 * 1000;
                  const now = Date.now();

                  // Build daylight indices matching the hourly table filter
                  const windowStart = now - 2 * ONE_HOUR;
                  const windowEnd = now + 24 * ONE_HOUR;
                  const dayIndices: number[] = [];
                  for (let i = 0; i < meteo.hours.length; i++) {
                    const h = meteo.hours[i];
                    const t = new Date(h.time).getTime();
                    if (t < windowStart || t > windowEnd) continue;
                    const sunrise = new Date(h.sunrise).getTime() - ONE_HOUR;
                    const sunset = new Date(h.sunset).getTime() + ONE_HOUR;
                    if (t >= sunrise && t <= sunset) {
                      dayIndices.push(i);
                    }
                  }
                  dayIndicesRef.current = dayIndices;

                  // Find current hour within daylight indices (for default & swipe starting point)
                  let currentDayIdx = 0;
                  for (let fi = 0; fi < dayIndices.length; fi++) {
                    if (new Date(meteo.hours[dayIndices[fi]].time).getTime() <= now) {
                      currentDayIdx = fi;
                    }
                  }

                  // Determine which global hour index to use
                  let hourIdx: number;
                  if (selectedHourIndex != null && dayIndices[selectedHourIndex] != null) {
                    hourIdx = dayIndices[selectedHourIndex];
                  } else {
                    hourIdx = dayIndices[currentDayIdx] ?? 0;
                  }

                  const timeLabel = selectedHourIndex != null
                    ? meteo.hours[dayIndices[selectedHourIndex]]?.hourLabel || "—"
                    : "Now";

                  // Swipe position info
                  const effectiveIdx = selectedHourIndex ?? currentDayIdx;
                  const canSwipeLeft = effectiveIdx < dayIndices.length - 1;
                  const canSwipeRight = effectiveIdx > 0;

                  return (
                    <>
                      <div className="flex items-center justify-between mb-3">
                        <p className="text-xs text-muted">
                          Wind at different altitudes. Swipe left/right to change hour.
                        </p>
                        <div className="flex items-center gap-2">
                          <button
                            type="button"
                            onClick={() => {
                              if (canSwipeRight) {
                                setSelectedHourIndex(effectiveIdx - 1);
                              }
                            }}
                            disabled={!canSwipeRight}
                            className="text-muted hover:text-foreground disabled:opacity-30 text-sm px-1"
                            aria-label="Previous hour"
                          >
                            ◀
                          </button>
                          <span className={`text-xs font-semibold px-2 py-0.5 rounded ${selectedHourIndex != null ? "bg-sky/15 text-sky" : "text-muted"}`}>
                            {timeLabel}
                          </span>
                          <button
                            type="button"
                            onClick={() => {
                              if (canSwipeLeft) {
                                setSelectedHourIndex(effectiveIdx + 1);
                              }
                            }}
                            disabled={!canSwipeLeft}
                            className="text-muted hover:text-foreground disabled:opacity-30 text-sm px-1"
                            aria-label="Next hour"
                          >
                            ▶
                          </button>
                        </div>
                      </div>
                      <div
                        className="overflow-x-auto"
                        onTouchStart={(e) => {
                          touchStartX.current = e.touches[0].clientX;
                        }}
                        onTouchEnd={(e) => {
                          if (touchStartX.current == null) return;
                          const diff = touchStartX.current - e.changedTouches[0].clientX;
                          touchStartX.current = null;
                          const SWIPE_THRESHOLD = 50;
                          if (Math.abs(diff) < SWIPE_THRESHOLD) return;

                          const di = dayIndicesRef.current;
                          const curIdx = selectedHourIndex ?? currentDayIdx;

                          if (diff > 0 && curIdx < di.length - 1) {
                            // Swiped left → next hour
                            setSelectedHourIndex(curIdx + 1);
                          } else if (diff < 0 && curIdx > 0) {
                            // Swiped right → previous hour
                            setSelectedHourIndex(curIdx - 1);
                          }
                        }}
                      >
                        <table className="w-full text-sm">
                          <thead>
                            <tr className="border-b border-card-border">
                              <th className="text-left py-2 px-2 text-muted font-medium">Altitude</th>
                              <th className="text-left py-2 px-2 text-muted font-medium">Speed</th>
                              <th className="text-left py-2 px-2 text-muted font-medium">Direction</th>
                              <th className="text-right py-2 px-2 text-muted font-medium">Temp</th>
                            </tr>
                          </thead>
                          <tbody>
                            {meteo.altitudes.map((alt, ai) => {
                              const w = alt.wind[hourIdx];
                              const temp = alt.temp[hourIdx];
                              const isSurface = ai === 0;

                              return (
                                <tr key={alt.key} className={`border-b border-card-border last:border-0 ${isSurface ? "bg-sky/5" : ""}`}>
                                  <td className={`py-2.5 px-2 font-medium ${isSurface ? "text-sky" : ""}`}>
                                    {alt.label}
                                  </td>
                                  <td className={`py-2.5 px-2 font-bold ${getWindColorNum(w?.speed)}`}>
                                    {w?.speed != null ? `${Math.round(w.speed)} mph` : "—"}
                                  </td>
                                  <td className="py-2.5 px-2">
                                    {w?.cardinal ? (
                                      <span>
                                        <span className="text-base">{directionArrow(w.cardinal)}</span> {w.cardinal}
                                      </span>
                                    ) : (
                                      <span className="text-muted">—</span>
                                    )}
                                  </td>
                                  <td className="py-2.5 px-2 text-right font-mono">
                                    {temp != null ? `${Math.round(temp)}°F` : "—"}
                                  </td>
                                </tr>
                              );
                            })}
                          </tbody>
                        </table>
                      </div>
                      <p className="text-xs text-muted mt-2">
                        All speeds in mph.{selectedHourIndex != null ? " Click the selected hour again to reset." : ""}
                      </p>
                    </>
                  );
                })()}
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
