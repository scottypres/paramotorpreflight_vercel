import { NextRequest, NextResponse } from "next/server";

interface ArcGISFeature {
  attributes: {
    CLASS: string;
    LOCAL_TYPE: string;
    NAME: string;
    UPPER_VAL: number;
    LOWER_VAL: number;
  };
}

interface ArcGISResponse {
  features?: ArcGISFeature[];
  error?: { message: string };
}

const CLASS_PRIORITY: Record<string, number> = {
  A: 6,
  B: 5,
  C: 4,
  D: 3,
  E: 2,
  G: 1,
};

function getPartRuling(airspaceClass: string, lowerVal: number) {
  switch (airspaceClass) {
    case "A":
      return {
        canFly: false,
        restrictions:
          "Class A airspace (18,000 ft+). Not relevant for paramotors but shown for reference.",
        recommendation: "Class A starts at 18,000 ft MSL. Paramotors operate well below this.",
      };
    case "B":
      return {
        canFly: false,
        restrictions:
          "DO NOT FLY HERE. Part 103 ultralights are PROHIBITED from Class B airspace. ATC clearance is required for all aircraft, and it is rarely granted to ultralights.",
        recommendation:
          "Move to a location outside the Class B boundaries shown on your VFR sectional chart. Class B airspace surrounds the nation's busiest airports.",
      };
    case "C":
      return {
        canFly: false,
        restrictions:
          "Part 103 ultralights must not enter Class C airspace without establishing two-way radio communication with ATC. Most paramotors do not have radios.",
        recommendation:
          "Avoid this area unless you have a radio and have contacted approach control. Find a location outside the Class C ring.",
      };
    case "D":
      return {
        canFly: false,
        restrictions:
          "Part 103 ultralights must establish two-way communication with the control tower before entering Class D airspace.",
        recommendation:
          "If the tower is active, you need radio communication. When the tower is closed, Class D typically reverts to Class E or G. Check tower hours.",
      };
    case "E":
      if (lowerVal === 0) {
        return {
          canFly: true,
          restrictions:
            "Class E surface area. Part 103 ultralights MAY fly here. VFR weather minimums: 3 statute miles visibility, 500 ft below clouds, 1000 ft above, 2000 ft horizontal.",
          recommendation:
            "You can fly here under Part 103 rules, but you must meet controlled airspace VFR weather minimums. Be aware of instrument traffic in the area.",
        };
      }
      return {
        canFly: true,
        restrictions:
          "Class E airspace (starts above surface). Part 103 ultralights can fly below the Class E floor under uncontrolled (Class G) rules. Above the floor, controlled airspace VFR minimums apply.",
        recommendation:
          "Good for paramotor flying! You're in Class G at the surface with Class E above. Standard VFR rules apply.",
      };
    default:
      return {
        canFly: true,
        restrictions:
          "Class G uncontrolled airspace. No ATC authorization needed. Standard Part 103 rules apply.",
        recommendation:
          "Great for paramotor flying! Maintain at least 1 statute mile visibility and stay clear of clouds (uncontrolled airspace minimums).",
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

    // Find nearest
    let minDist = Infinity;
    let nearest: { icaoId: string; name: string; lat: number; lon: number } | null = null;
    for (const a of data) {
      const d = Math.sqrt((a.lat - lat) ** 2 + (a.lon - lon) ** 2);
      if (d < minDist) {
        minDist = d;
        nearest = a;
      }
    }
    const distNm = minDist * 60; // rough conversion

    return {
      nearestAirport: nearest ? `${nearest.name} (${nearest.icaoId})` : null,
      distanceNm: Math.round(distNm * 10) / 10,
      airports: data.slice(0, 5).map((a: { icaoId: string; name: string; lat: number; lon: number }) => ({
        ident: a.icaoId,
        name: a.name,
        distance: Math.round(Math.sqrt((a.lat - lat) ** 2 + (a.lon - lon) ** 2) * 60 * 10) / 10,
      })),
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
    // Query the FAA ArcGIS Feature Service for Class Airspace
    const geometry = JSON.stringify({
      x: lon,
      y: lat,
      spatialReference: { wkid: 4326 },
    });

    const params = new URLSearchParams({
      geometry,
      geometryType: "esriGeometryPoint",
      spatialRel: "esriSpatialRelIntersects",
      outFields: "CLASS,LOCAL_TYPE,NAME,UPPER_VAL,LOWER_VAL",
      returnGeometry: "false",
      f: "json",
    });

    const arcgisUrl = `https://services6.arcgis.com/ssFJjBXIUyZDrSYZ/arcgis/rest/services/Class_Airspace/FeatureServer/0/query?${params}`;
    const res = await fetch(arcgisUrl, {
      headers: { Accept: "application/json" },
    });

    let airspaceClass = "G";
    let description = "Class G - Uncontrolled Airspace";
    let airspaceName = "";
    let lowerVal = 0;
    let canFly = true;
    let restrictions = "";
    let recommendation = "";
    let usedFallback = false;

    if (res.ok) {
      const data: ArcGISResponse = await res.json();

      if (data.error) {
        throw new Error(data.error.message);
      }

      if (data.features && data.features.length > 0) {
        // Find the most restrictive airspace class at this point
        let mostRestrictive = data.features[0];
        for (const feat of data.features) {
          const currentPriority =
            CLASS_PRIORITY[feat.attributes.CLASS] || 0;
          const bestPriority =
            CLASS_PRIORITY[mostRestrictive.attributes.CLASS] || 0;
          if (currentPriority > bestPriority) {
            mostRestrictive = feat;
          }
        }

        airspaceClass = mostRestrictive.attributes.CLASS || "E";
        airspaceName = mostRestrictive.attributes.NAME || "";
        lowerVal = mostRestrictive.attributes.LOWER_VAL || 0;
        description = `Class ${airspaceClass}${airspaceName ? ` - ${airspaceName}` : ""}`;

        const ruling = getPartRuling(airspaceClass, lowerVal);
        canFly = ruling.canFly;
        restrictions = ruling.restrictions;
        recommendation = ruling.recommendation;
      } else {
        // No airspace features = Class G
        const ruling = getPartRuling("G", 0);
        canFly = ruling.canFly;
        restrictions = ruling.restrictions;
        recommendation = ruling.recommendation;
      }
    } else {
      // ArcGIS unavailable, use fallback
      usedFallback = true;
      const ruling = getPartRuling("G", 0);
      canFly = ruling.canFly;
      restrictions = ruling.restrictions;
      recommendation =
        "Note: FAA airspace database was unavailable. Showing approximate data. " +
        ruling.recommendation;
    }

    // Also get nearby airports for reference
    const airportInfo = await fallbackAirportLookup(lat, lon);

    return NextResponse.json({
      airspaceClass,
      canFly,
      description,
      airspaceName,
      lowerVal,
      nearestAirport: airportInfo?.nearestAirport || null,
      distanceNm: airportInfo?.distanceNm || null,
      restrictions,
      recommendation,
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
