import { NextRequest, NextResponse } from "next/server";

interface ArcGISAttributes {
  CLASS: string;
  LOCAL_TYPE: string;
  NAME: string;
  IDENT: string;
  ICAO_ID: string;
  UPPER_VAL: number;
  LOWER_VAL: number;
  UPPER_UOM: string;
  LOWER_UOM: string;
}

interface ArcGISRing {
  rings: number[][][];
}

interface ArcGISFeature {
  attributes: ArcGISAttributes;
  geometry?: ArcGISRing;
}

interface ArcGISResponse {
  features?: ArcGISFeature[];
  error?: { message: string };
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

function buildLayers(features: ArcGISFeature[]): AirspaceLayer[] {
  return features.map((f) => {
    const lower = f.attributes.LOWER_VAL || 0;
    const upper = f.attributes.UPPER_VAL || 0;
    const touchesSurface = lower === 0 || f.attributes.LOWER_UOM === "SFC";
    const affectsParamotor = touchesSurface || lower < PARAMOTOR_MAX_ALT;

    return {
      airspaceClass: f.attributes.CLASS || "E",
      name: f.attributes.NAME || "",
      lowerFt: lower,
      upperFt: upper,
      touchesSurface,
      affectsParamotor,
    };
  });
}

function formatAltitude(ft: number, isSurface: boolean): string {
  if (isSurface || ft === 0) return "Surface";
  if (ft >= 18000) return `FL${ft / 100}`;
  return `${ft.toLocaleString()} ft`;
}

// Try to extract a 3-4 letter airport code from a name string like "ATLANTA CLASS B"
function extractIdent(name: string): string {
  // Sometimes the name itself IS the ident
  const match = name.match(/\b([A-Z]{3,4})\b/);
  return match ? match[1] : "";
}

// Convert ArcGIS rings to GeoJSON polygon coordinates
// ArcGIS uses [lon, lat], GeoJSON also uses [lon, lat], so no conversion needed
function ringsToGeoJSON(rings: number[][][]): number[][][] {
  return rings;
}

function getPartRuling(airspaceClass: string, touchesSurface: boolean) {
  switch (airspaceClass) {
    case "A":
      return {
        canFly: true,
        restrictions:
          "Class A airspace (FL180+). Does not affect paramotor operations.",
        recommendation:
          "Class A starts at 18,000 ft MSL. Paramotors operate well below this. No restriction on your flight.",
      };
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
          "You are under a Class B shelf. Stay below the shelf floor altitude shown above. Check your VFR sectional for the exact shelf altitude at this location.",
      };
    case "C":
      if (touchesSurface) {
        return {
          canFly: false,
          restrictions:
            "You are within the Class C surface area. Part 103 ultralights must establish two-way radio communication with ATC before entering.",
          recommendation:
            "Avoid this area unless you have a radio and have contacted approach control. Move outside the Class C inner ring.",
        };
      }
      return {
        canFly: true,
        restrictions:
          "A Class C shelf exists above you but does NOT extend to the surface here. You can fly BELOW the shelf floor.",
        recommendation:
          "You are under a Class C shelf. Stay below the shelf floor altitude. The surface airspace here is likely Class G (uncontrolled).",
      };
    case "D":
      if (touchesSurface) {
        return {
          canFly: false,
          restrictions:
            "You are within Class D airspace (towered airport). Part 103 ultralights must establish two-way communication with the tower.",
          recommendation:
            "If the tower is active, you need radio communication. When the tower is closed, this reverts to Class E or G. Check tower hours.",
        };
      }
      return {
        canFly: true,
        restrictions:
          "Class D airspace exists above you but does not reach the surface at your location.",
        recommendation:
          "Stay below the Class D floor altitude. The surface airspace here is likely Class E or G.",
      };
    case "E":
      if (touchesSurface) {
        return {
          canFly: true,
          restrictions:
            "Class E surface area. Part 103 ultralights MAY fly here. You must meet controlled airspace VFR weather minimums: 3 mi visibility, 500 ft below / 1000 ft above / 2000 ft horizontal from clouds.",
          recommendation:
            "You can fly here under Part 103. Be aware of instrument traffic. Stricter weather minimums apply compared to Class G.",
        };
      }
      return {
        canFly: true,
        restrictions:
          "Class E begins above the surface here. Below the Class E floor you are in Class G (uncontrolled). Above the floor, controlled VFR weather minimums apply.",
        recommendation:
          "Good for paramotor flying! You're in Class G at the surface. If you climb above the Class E floor, controlled airspace weather minimums kick in.",
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
          (a: {
            icaoId: string;
            name: string;
            lat: number;
            lon: number;
          }) => ({
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
    // Query a wider area (envelope) around the point so we get surrounding airspace
    // for the map display — ~30nm in each direction
    const bufferDeg = 0.5; // roughly 30nm
    const envelope = JSON.stringify({
      xmin: lon - bufferDeg,
      ymin: lat - bufferDeg,
      xmax: lon + bufferDeg,
      ymax: lat + bufferDeg,
      spatialReference: { wkid: 4326 },
    });

    const params = new URLSearchParams({
      geometry: envelope,
      geometryType: "esriGeometryEnvelope",
      spatialRel: "esriSpatialRelIntersects",
      outFields: "CLASS,LOCAL_TYPE,NAME,IDENT,ICAO_ID,UPPER_VAL,LOWER_VAL,UPPER_UOM,LOWER_UOM",
      returnGeometry: "true",
      outSR: "4326",
      f: "json",
    });

    const arcgisUrl = `https://services6.arcgis.com/ssFJjBXIUyZDrSYZ/arcgis/rest/services/Class_Airspace/FeatureServer/0/query?${params}`;
    const res = await fetch(arcgisUrl, {
      headers: { Accept: "application/json" },
    });

    let surfaceClass = "G";
    let canFly = true;
    let restrictions = "";
    let recommendation = "";
    let usedFallback = false;
    let layers: AirspaceLayer[] = [];

    // GeoJSON features for the map (all airspace in the area)
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
    const mapFeatures: GeoJSONFeature[] = [];

    if (res.ok) {
      const data: ArcGISResponse = await res.json();

      if (data.error) {
        throw new Error(data.error.message);
      }

      if (data.features && data.features.length > 0) {
        // Build map features from ALL returned airspace (wider area)
        for (const feat of data.features) {
          if (feat.geometry?.rings) {
            const lower = feat.attributes.LOWER_VAL || 0;
            const upper = feat.attributes.UPPER_VAL || 0;
            const touchesSurface = lower === 0 || feat.attributes.LOWER_UOM === "SFC";

            // Skip Class A (FL180+) — not useful on the map for paramotors
            if (feat.attributes.CLASS === "A") continue;

            // Extract airport identifier (try ICAO_ID first, then IDENT, then parse from NAME)
            const ident =
              feat.attributes.ICAO_ID ||
              feat.attributes.IDENT ||
              extractIdent(feat.attributes.NAME || "");

            mapFeatures.push({
              type: "Feature",
              properties: {
                airspaceClass: feat.attributes.CLASS || "E",
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
                coordinates: ringsToGeoJSON(feat.geometry.rings),
              },
            });
          }
        }

        // Now do the point-in-polygon check for the user's exact location
        // Filter to features that actually contain the user's point
        const pointFeatures = data.features.filter((f) => {
          if (!f.geometry?.rings) return false;
          return isPointInPolygon(lat, lon, f.geometry.rings);
        });

        if (pointFeatures.length > 0) {
          layers = buildLayers(pointFeatures);

          const priority: Record<string, number> = {
            B: 5, C: 4, D: 3, E: 2, A: 1, G: 0,
          };
          layers.sort(
            (a, b) =>
              (priority[b.airspaceClass] || 0) -
              (priority[a.airspaceClass] || 0)
          );

          const paramotorLayers = layers.filter((l) => l.affectsParamotor);

          if (paramotorLayers.length > 0) {
            const surfaceLayer = paramotorLayers.find(
              (l) => l.touchesSurface
            );
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
            surfaceClass = "G";
            const ruling = getPartRuling("G", false);
            canFly = ruling.canFly;
            restrictions = ruling.restrictions;
            recommendation = ruling.recommendation;
          }
        } else {
          const ruling = getPartRuling("G", false);
          canFly = ruling.canFly;
          restrictions = ruling.restrictions;
          recommendation = ruling.recommendation;
        }
      } else {
        const ruling = getPartRuling("G", false);
        canFly = ruling.canFly;
        restrictions = ruling.restrictions;
        recommendation = ruling.recommendation;
      }
    } else {
      usedFallback = true;
      const ruling = getPartRuling("G", false);
      canFly = ruling.canFly;
      restrictions = ruling.restrictions;
      recommendation =
        "Note: FAA airspace database was unavailable. Showing approximate data. " +
        ruling.recommendation;
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
      // GeoJSON FeatureCollection for the map
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
  // Check the outer ring (first ring)
  const ring = rings[0];
  if (!ring) return false;

  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const xi = ring[i][0]; // lon
    const yi = ring[i][1]; // lat
    const xj = ring[j][0];
    const yj = ring[j][1];

    const intersect =
      yi > lat !== yj > lat &&
      lon < ((xj - xi) * (lat - yi)) / (yj - yi) + xi;
    if (intersect) inside = !inside;
  }
  return inside;
}
