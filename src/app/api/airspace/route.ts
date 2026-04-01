import { NextRequest, NextResponse } from "next/server";

/* ------------------------------------------------------------------ */
/*  Types                                                              */
/* ------------------------------------------------------------------ */

interface ArcGISAttributes {
  CLASS: string;
  LOCAL_TYPE: string;
  NAME: string;
  IDENT: string;
  ICAO_ID: string;
  SECTOR: string;
  TYPE_CODE: string;
  UPPER_VAL: number;
  LOWER_VAL: number;
  UPPER_UOM: string;
  LOWER_UOM: string;
}

interface SUAAttributes {
  NAME: string;
  TYPE_CODE: string;
  UPPER_VAL: number;
  LOWER_VAL: number;
  UPPER_UOM: string;
  LOWER_UOM: string;
  IDENT: string;
  ICAO_ID: string;
  LOCAL_TYPE: string;
}

interface ArcGISRing {
  rings: number[][][];
}

interface ArcGISFeature {
  attributes: ArcGISAttributes;
  geometry?: ArcGISRing;
}

interface SUAFeature {
  attributes: SUAAttributes;
  geometry?: ArcGISRing;
}

interface ArcGISResponse {
  features?: ArcGISFeature[];
  error?: { message: string };
}

interface SUAResponse {
  features?: SUAFeature[];
  error?: { message: string };
}

interface GeoJSONFeature {
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
}

// Typical paramotor operating ceiling in feet AGL
const PARAMOTOR_MAX_ALT = 1500;

interface AirspaceLayer {
  airspaceClass: string;
  name: string;
  lowerFt: number;
  upperFt: number;
  touchesSurface: boolean;
  affectsParamotor: boolean;
}

/* ------------------------------------------------------------------ */
/*  Helpers                                                            */
/* ------------------------------------------------------------------ */

function formatAltitude(ft: number, isSurface: boolean): string {
  if (isSurface || ft === 0) return "Surface";
  if (ft >= 18000) return `FL${ft / 100}`;
  return `${ft.toLocaleString()} ft`;
}

function extractIdent(name: string): string {
  if (!name) return "";
  const icaoMatch = name.match(/\b(K[A-Z]{3})\b/);
  if (icaoMatch) return icaoMatch[1];
  return "";
}

// Map SUA TYPE_CODE to a readable airspace class label
function suaTypeToClass(typeCode: string): string {
  const t = (typeCode || "").toUpperCase();
  if (t.includes("P") || t === "PROHIBITED") return "P";
  if (t.includes("R") || t === "RESTRICTED") return "R";
  if (t.includes("W") || t === "WARNING") return "W";
  if (t.includes("MOA") || t === "M") return "MOA";
  if (t.includes("A") || t === "ALERT") return "A";
  if (t.includes("NSA") || t.includes("NATIONAL")) return "NSA";
  return t || "SUA";
}

function suaClassLabel(cls: string): string {
  switch (cls) {
    case "P": return "Prohibited";
    case "R": return "Restricted";
    case "W": return "Warning";
    case "MOA": return "Military Operations Area";
    case "A": return "Alert";
    case "NSA": return "National Security Area";
    default: return "Special Use";
  }
}

// Part 103 rules for class airspace
function getPartRuling(airspaceClass: string, touchesSurface: boolean) {
  switch (airspaceClass) {
    case "B":
      if (touchesSurface) {
        return {
          canFly: false,
          restrictions:
            "DO NOT FLY HERE. You are within a Class B surface area. Part 103 ultralights are PROHIBITED from Class B airspace.",
          recommendation:
            "Move to a location outside the Class B boundaries. Check your VFR sectional chart for exact boundaries.",
        };
      }
      return {
        canFly: true,
        restrictions:
          "A Class B shelf exists above you but does NOT extend to the surface here. You can fly BELOW the shelf floor.",
        recommendation:
          "You are under a Class B shelf. Stay below the shelf floor altitude shown above.",
      };
    case "C":
      if (touchesSurface) {
        return {
          canFly: false,
          restrictions:
            "You are within the Class C surface area. Part 103 ultralights must establish two-way radio communication with ATC before entering.",
          recommendation:
            "Avoid this area unless you have a radio and have contacted approach control.",
        };
      }
      return {
        canFly: true,
        restrictions:
          "A Class C shelf exists above you but does NOT extend to the surface here. You can fly BELOW the shelf floor.",
        recommendation:
          "You are under a Class C shelf. Stay below the shelf floor altitude.",
      };
    case "D":
      if (touchesSurface) {
        return {
          canFly: false,
          restrictions:
            "You are within Class D airspace (towered airport). Part 103 ultralights must establish two-way communication with the tower.",
          recommendation:
            "If the tower is active, you need radio communication. When the tower is closed, this reverts to Class E or G.",
        };
      }
      return {
        canFly: true,
        restrictions:
          "Class D airspace exists above you but does not reach the surface at your location.",
        recommendation:
          "Stay below the Class D floor altitude.",
      };
    case "P":
      return {
        canFly: false,
        restrictions:
          "PROHIBITED AREA. No flight is permitted in this airspace under any circumstances without specific authorization.",
        recommendation:
          "Do not enter. Find an alternative flying location.",
      };
    case "R":
      return {
        canFly: false,
        restrictions:
          "RESTRICTED AREA. Flight is prohibited during active times. May involve military operations, artillery firing, or missile testing.",
        recommendation:
          "Check NOTAMs for active times. When not active, you may be able to fly through. Contact the controlling agency for status.",
      };
    case "MOA":
      return {
        canFly: true,
        restrictions:
          "Military Operations Area. VFR flight is permitted but use extreme caution. Military aircraft may be conducting training including high-speed, aerobatic maneuvers.",
        recommendation:
          "Legal to fly through but risky. Military jets may not see you. Contact the controlling agency for activity status before entering.",
      };
    case "W":
      return {
        canFly: true,
        restrictions:
          "Warning Area. Similar to restricted areas but over international waters. Hazardous activities may be in progress.",
        recommendation:
          "Use extreme caution. Check NOTAMs for activity status.",
      };
    case "A":
      return {
        canFly: true,
        restrictions:
          "Alert Area. High volume of pilot training or unusual aerial activity. No ATC clearance required.",
        recommendation:
          "Legal to fly but be extra vigilant for other aircraft.",
      };
    default:
      return {
        canFly: true,
        restrictions:
          "Class G uncontrolled airspace. No ATC authorization needed. Standard Part 103 rules apply.",
        recommendation:
          "Great for paramotor flying! Maintain at least 1 statute mile visibility and stay clear of clouds.",
      };
  }
}

// Is this airspace class restricted for paramotors?
function isRestrictedClass(cls: string): boolean {
  return ["B", "C", "D", "P", "R"].includes(cls);
}

// Fallback: use airport proximity when ArcGIS is unavailable
async function fallbackAirportLookup(lat: number, lon: number) {
  try {
    const res = await fetch(
      `https://aviationweather.gov/api/data/airport?bbox=${lat - 0.3},${lon - 0.3},${lat + 0.3},${lon + 0.3}&format=json`
    );
    if (!res.ok) return null;
    const data = await res.json();
    if (!Array.isArray(data) || data.length === 0) return null;

    let minDist = Infinity;
    let nearest: { icaoId: string; name: string; lat: number; lon: number } | null = null;
    for (const a of data) {
      const d = Math.sqrt((a.lat - lat) ** 2 + (a.lon - lon) ** 2);
      if (d < minDist) {
        minDist = d;
        nearest = a;
      }
    }
    const distNm = minDist * 60;

    return {
      nearestAirport: nearest ? `${nearest.name} (${nearest.icaoId})` : null,
      distanceNm: Math.round(distNm * 10) / 10,
      airports: data
        .slice(0, 5)
        .map(
          (a: { icaoId: string; name: string; lat: number; lon: number }) => ({
            ident: a.icaoId,
            name: a.name,
            distance:
              Math.round(
                Math.sqrt((a.lat - lat) ** 2 + (a.lon - lon) ** 2) * 60 * 10
              ) / 10,
          })
        ),
    };
  } catch {
    return null;
  }
}

/* ------------------------------------------------------------------ */
/*  Fetch helpers                                                      */
/* ------------------------------------------------------------------ */

async function fetchClassAirspace(
  envelope: string
): Promise<ArcGISFeature[]> {
  const params = new URLSearchParams({
    geometry: envelope,
    geometryType: "esriGeometryEnvelope",
    spatialRel: "esriSpatialRelIntersects",
    outFields:
      "CLASS,LOCAL_TYPE,NAME,IDENT,ICAO_ID,SECTOR,TYPE_CODE,UPPER_VAL,LOWER_VAL,UPPER_UOM,LOWER_UOM",
    returnGeometry: "true",
    outSR: "4326",
    f: "json",
  });

  const url = `https://services6.arcgis.com/ssFJjBXIUyZDrSYZ/arcgis/rest/services/Class_Airspace/FeatureServer/0/query?${params}`;
  const res = await fetch(url, { headers: { Accept: "application/json" } });

  if (!res.ok) return [];
  const data: ArcGISResponse = await res.json();
  if (data.error) return [];
  return data.features || [];
}

async function fetchSpecialUseAirspace(
  envelope: string
): Promise<SUAFeature[]> {
  // FAA Special Use Airspace (SUA) — includes Prohibited, Restricted, MOA, Warning, Alert
  const params = new URLSearchParams({
    geometry: envelope,
    geometryType: "esriGeometryEnvelope",
    spatialRel: "esriSpatialRelIntersects",
    outFields: "NAME,TYPE_CODE,IDENT,ICAO_ID,LOCAL_TYPE,UPPER_VAL,LOWER_VAL,UPPER_UOM,LOWER_UOM",
    returnGeometry: "true",
    outSR: "4326",
    f: "json",
  });

  // Try multiple possible service names
  const serviceUrls = [
    `https://services6.arcgis.com/ssFJjBXIUyZDrSYZ/arcgis/rest/services/Special_Use_Airspace/FeatureServer/0/query?${params}`,
    `https://services6.arcgis.com/ssFJjBXIUyZDrSYZ/arcgis/rest/services/Sua/FeatureServer/0/query?${params}`,
  ];

  for (const url of serviceUrls) {
    try {
      const res = await fetch(url, { headers: { Accept: "application/json" } });
      if (!res.ok) continue;
      const data: SUAResponse = await res.json();
      if (data.error) continue;
      if (data.features && data.features.length > 0) {
        return data.features;
      }
    } catch {
      continue;
    }
  }

  return [];
}

/* ------------------------------------------------------------------ */
/*  Main handler                                                       */
/* ------------------------------------------------------------------ */

export async function GET(request: NextRequest) {
  const lat = parseFloat(request.nextUrl.searchParams.get("lat") || "");
  const lon = parseFloat(request.nextUrl.searchParams.get("lon") || "");

  if (isNaN(lat) || isNaN(lon)) {
    return NextResponse.json(
      { error: "Valid lat/lon required" },
      { status: 400 }
    );
  }

  try {
    const bufferDeg = 0.5; // ~30nm
    const envelope = JSON.stringify({
      xmin: lon - bufferDeg,
      ymin: lat - bufferDeg,
      xmax: lon + bufferDeg,
      ymax: lat + bufferDeg,
      spatialReference: { wkid: 4326 },
    });

    // Fetch class airspace and special use airspace in parallel
    const [classFeatures, suaFeatures] = await Promise.all([
      fetchClassAirspace(envelope),
      fetchSpecialUseAirspace(envelope),
    ]);

    let surfaceClass = "G";
    let canFly = true;
    let restrictions = "";
    let recommendation = "";
    const usedFallback = classFeatures.length === 0 && suaFeatures.length === 0;
    let layers: AirspaceLayer[] = [];
    const mapFeatures: GeoJSONFeature[] = [];

    // Process class airspace features (B, C, D only — skip A and E)
    for (const feat of classFeatures) {
      const cls = feat.attributes.CLASS;

      // Skip Class A (FL180+) and Class E (too noisy, everywhere)
      if (cls === "A" || cls === "E") continue;

      if (feat.geometry?.rings) {
        const lower = feat.attributes.LOWER_VAL || 0;
        const upper = feat.attributes.UPPER_VAL || 0;
        const touchesSurface =
          lower === 0 || feat.attributes.LOWER_UOM === "SFC";

        const ident =
          feat.attributes.ICAO_ID ||
          feat.attributes.IDENT ||
          extractIdent(feat.attributes.NAME || "");

        mapFeatures.push({
          type: "Feature",
          properties: {
            airspaceClass: cls || "G",
            name: feat.attributes.NAME || "",
            ident,
            floor: formatAltitude(lower, touchesSurface),
            ceiling: formatAltitude(upper, false),
            lowerFt: lower,
            upperFt: upper,
            touchesSurface,
          },
          geometry: {
            type: "Polygon",
            coordinates: feat.geometry.rings,
          },
        });
      }
    }

    // Process special use airspace features (P, R, MOA, W, A)
    for (const feat of suaFeatures) {
      if (feat.geometry?.rings) {
        const lower = feat.attributes.LOWER_VAL || 0;
        const upper = feat.attributes.UPPER_VAL || 0;
        const touchesSurface =
          lower === 0 || feat.attributes.LOWER_UOM === "SFC";
        const typeCode = suaTypeToClass(
          feat.attributes.TYPE_CODE || feat.attributes.LOCAL_TYPE || ""
        );

        const ident =
          feat.attributes.ICAO_ID ||
          feat.attributes.IDENT ||
          "";

        mapFeatures.push({
          type: "Feature",
          properties: {
            airspaceClass: typeCode,
            name: feat.attributes.NAME || "",
            ident,
            floor: formatAltitude(lower, touchesSurface),
            ceiling: formatAltitude(upper, false),
            lowerFt: lower,
            upperFt: upper,
            touchesSurface,
          },
          geometry: {
            type: "Polygon",
            coordinates: feat.geometry.rings,
          },
        });
      }
    }

    // Point-in-polygon for the user's exact location (class airspace, skip E)
    const pointClassFeatures = classFeatures.filter((f) => {
      if (!f.geometry?.rings) return false;
      if (f.attributes.CLASS === "A" || f.attributes.CLASS === "E") return false;
      return isPointInPolygon(lat, lon, f.geometry.rings);
    });

    // Point-in-polygon for SUA
    const pointSUAFeatures = suaFeatures.filter((f) => {
      if (!f.geometry?.rings) return false;
      return isPointInPolygon(lat, lon, f.geometry.rings);
    });

    // Build layers from class airspace at user's point
    if (pointClassFeatures.length > 0) {
      layers = pointClassFeatures.map((f) => {
        const lower = f.attributes.LOWER_VAL || 0;
        const upper = f.attributes.UPPER_VAL || 0;
        const touchesSurface = lower === 0 || f.attributes.LOWER_UOM === "SFC";
        return {
          airspaceClass: f.attributes.CLASS || "G",
          name: f.attributes.NAME || "",
          lowerFt: lower,
          upperFt: upper,
          touchesSurface,
          affectsParamotor: touchesSurface || lower < PARAMOTOR_MAX_ALT,
        };
      });
    }

    // Add SUA layers at user's point
    for (const f of pointSUAFeatures) {
      const lower = f.attributes.LOWER_VAL || 0;
      const upper = f.attributes.UPPER_VAL || 0;
      const touchesSurface = lower === 0 || f.attributes.LOWER_UOM === "SFC";
      const typeCode = suaTypeToClass(
        f.attributes.TYPE_CODE || f.attributes.LOCAL_TYPE || ""
      );
      layers.push({
        airspaceClass: typeCode,
        name: f.attributes.NAME || "",
        lowerFt: lower,
        upperFt: upper,
        touchesSurface,
        affectsParamotor: touchesSurface || lower < PARAMOTOR_MAX_ALT,
      });
    }

    // Sort layers by restrictiveness
    const priority: Record<string, number> = {
      P: 7, B: 6, R: 5, C: 4, D: 3, W: 2, MOA: 1, A: 0,
    };
    layers.sort(
      (a, b) =>
        (priority[b.airspaceClass] || 0) - (priority[a.airspaceClass] || 0)
    );

    // Determine go/no-go based on most restrictive layer affecting paramotor
    const paramotorLayers = layers.filter((l) => l.affectsParamotor);
    if (paramotorLayers.length > 0) {
      const surfaceLayer = paramotorLayers.find((l) => l.touchesSurface);
      const relevantLayer = surfaceLayer || paramotorLayers[0];
      surfaceClass = relevantLayer.airspaceClass;
      const ruling = getPartRuling(
        relevantLayer.airspaceClass,
        relevantLayer.touchesSurface
      );
      canFly = ruling.canFly;
      restrictions = ruling.restrictions;
      recommendation = ruling.recommendation;
    } else {
      const ruling = getPartRuling("G", false);
      canFly = ruling.canFly;
      restrictions = ruling.restrictions;
      recommendation = ruling.recommendation;
    }

    if (usedFallback) {
      recommendation =
        "Note: FAA airspace database was unavailable. Showing approximate data. " +
        recommendation;
    }

    const airportInfo = await fallbackAirportLookup(lat, lon);

    return NextResponse.json({
      surfaceClass,
      canFly,
      restrictions,
      recommendation,
      layers: layers.map((l) => ({
        airspaceClass: l.airspaceClass,
        name: l.name,
        floor: formatAltitude(l.lowerFt, l.touchesSurface),
        ceiling: formatAltitude(l.upperFt, false),
        lowerFt: l.lowerFt,
        upperFt: l.upperFt,
        touchesSurface: l.touchesSurface,
        affectsParamotor: l.affectsParamotor,
      })),
      mapGeoJSON: {
        type: "FeatureCollection" as const,
        features: mapFeatures,
      },
      nearestAirport: airportInfo?.nearestAirport || null,
      distanceNm: airportInfo?.distanceNm || null,
      airports: airportInfo?.airports || [],
      usedFallback,
      note: "This is based on FAA airspace data. ALWAYS verify on a current VFR Sectional Chart before flying. Check TFRs at tfr.faa.gov.",
    });
  } catch (err) {
    const message =
      err instanceof Error ? err.message : "Failed to check airspace";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}

// Ray-casting point-in-polygon test
function isPointInPolygon(
  lat: number,
  lon: number,
  rings: number[][][]
): boolean {
  const ring = rings[0];
  if (!ring) return false;

  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const xi = ring[i][0];
    const yi = ring[i][1];
    const xj = ring[j][0];
    const yj = ring[j][1];

    const intersect =
      yi > lat !== yj > lat &&
      lon < ((xj - xi) * (lat - yi)) / (yj - yi) + xi;
    if (intersect) inside = !inside;
  }
  return inside;
}
