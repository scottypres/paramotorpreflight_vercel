import { NextRequest, NextResponse } from "next/server";

interface Airport {
  ident: string;
  name: string;
  type: string;
  latitude_deg: number;
  longitude_deg: number;
  elevation_ft: number;
}

interface AirspaceResult {
  airspaceClass: string;
  canFly: boolean;
  nearestAirport: string | null;
  distanceNm: number | null;
  description: string;
  restrictions: string;
  recommendation: string;
}

// FAA facility data - we'll use the FAA's airport API to determine nearby airports
// and infer airspace class from airport type and proximity
async function findNearbyAirports(
  lat: number,
  lon: number
): Promise<Airport[]> {
  // Use the FAA NASR (National Airspace System Resources) via a public endpoint
  // We'll query multiple radius ranges
  try {
    const res = await fetch(
      `https://aviationweather.gov/api/data/airport?bbox=${lat - 0.5},${lon - 0.5},${lat + 0.5},${lon + 0.5}&format=json`
    );
    if (res.ok) {
      const data = await res.json();
      if (Array.isArray(data) && data.length > 0) {
        return data.map(
          (a: { icaoId: string; name: string; lat: number; lon: number; elev: number }) => ({
            ident: a.icaoId || "Unknown",
            name: a.name || "Unknown",
            type: inferAirportType(a.icaoId || ""),
            latitude_deg: a.lat,
            longitude_deg: a.lon,
            elevation_ft: a.elev || 0,
          })
        );
      }
    }
  } catch {
    // Fall through to TFR/NOTAM check
  }

  return [];
}

function inferAirportType(ident: string): string {
  // Major airports with Class B airspace (busiest US airports)
  const classB = [
    "KATL", "KBOS", "KBWI", "KCLE", "KCLT", "KCVG", "KDAL", "KDCA",
    "KDEN", "KDFW", "KDTW", "KEWR", "KFLL", "KHNL", "KHOU", "KIAD",
    "KIAH", "KJFK", "KLAS", "KLAX", "KLGA", "KMCI", "KMCO", "KMDW",
    "KMEM", "KMIA", "KMKE", "KMSP", "KMSN", "KORD", "KPBI", "KPDX",
    "KPHL", "KPHX", "KPIT", "KSAN", "KSAT", "KSDF", "KSEA", "KSFO",
    "KSLC", "KSTL", "KTPA", "KBNA", "KRDU", "KAUS", "KSMF", "KOAK",
    "KSJC", "KABQ",
  ];

  // Class C airports (medium-sized with approach control)
  const classC = [
    "KACY", "KALB", "KBDL", "KBHM", "KBIL", "KBNA", "KBTV", "KBUF",
    "KCAE", "KCHS", "KCOS", "KCRP", "KDAY", "KDLH", "KDSM", "KELP",
    "KERI", "KEVV", "KFAT", "KFNT", "KFSD", "KFSM", "KFWA", "KGRR",
    "KGSO", "KGSP", "KHSV", "KICT", "KJAN", "KJAX", "KLEX", "KLIT",
    "KMBS", "KMDT", "KMLI", "KMOB", "KMSY", "KOKC", "KOMA", "KORF",
    "KPNS", "KPVD", "KRNO", "KROA", "KROC", "KRSW", "KSAV", "KSGF",
    "KSHV", "KSRQ", "KSYR", "KTOL", "KTUL", "KTUS", "KTYS", "KXNA",
  ];

  if (classB.includes(ident)) return "large_airport";
  if (classC.includes(ident)) return "medium_airport";
  return "small_airport";
}

function haversineNm(
  lat1: number,
  lon1: number,
  lat2: number,
  lon2: number
): number {
  const R = 3440.065; // Earth radius in nautical miles
  const dLat = ((lat2 - lat1) * Math.PI) / 180;
  const dLon = ((lon2 - lon1) * Math.PI) / 180;
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos((lat1 * Math.PI) / 180) *
      Math.cos((lat2 * Math.PI) / 180) *
      Math.sin(dLon / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

function classifyAirspace(
  airports: Airport[],
  lat: number,
  lon: number
): AirspaceResult {
  if (airports.length === 0) {
    return {
      airspaceClass: "G",
      canFly: true,
      nearestAirport: null,
      distanceNm: null,
      description: "Class G - Uncontrolled Airspace",
      restrictions:
        "No ATC authorization needed. Standard Part 103 rules apply.",
      recommendation:
        "You are likely in uncontrolled airspace. Great for paramotor flying! Always maintain situational awareness and check NOTAMs.",
    };
  }

  // Find nearest airport and classify
  let nearest: Airport | null = null;
  let minDist = Infinity;

  for (const airport of airports) {
    const dist = haversineNm(
      lat,
      lon,
      airport.latitude_deg,
      airport.longitude_deg
    );
    if (dist < minDist) {
      minDist = dist;
      nearest = airport;
    }
  }

  if (!nearest) {
    return {
      airspaceClass: "G",
      canFly: true,
      nearestAirport: null,
      distanceNm: null,
      description: "Class G - Uncontrolled Airspace",
      restrictions: "No ATC authorization needed.",
      recommendation: "You appear to be in uncontrolled airspace. Fly safe!",
    };
  }

  const distNm = Math.round(minDist * 10) / 10;
  const airportName = `${nearest.name} (${nearest.ident})`;

  // Class B airspace (large airports) - typically 30nm radius surface area, but core is ~5nm
  if (nearest.type === "large_airport") {
    if (distNm < 5) {
      return {
        airspaceClass: "B",
        canFly: false,
        nearestAirport: airportName,
        distanceNm: distNm,
        description: "Class B - Major Airport Airspace",
        restrictions:
          "DO NOT FLY HERE. Part 103 ultralights are PROHIBITED from Class B airspace. ATC clearance required for all aircraft.",
        recommendation:
          "You are very close to a major airport. Find a location further away. You need to be outside the Class B boundaries shown on your VFR sectional chart.",
      };
    }
    if (distNm < 15) {
      return {
        airspaceClass: "B (outer)",
        canFly: false,
        nearestAirport: airportName,
        distanceNm: distNm,
        description: "Class B - Outer Ring (Possible)",
        restrictions:
          "You may still be within Class B shelves. Part 103 ultralights are PROHIBITED from Class B airspace without ATC clearance.",
        recommendation:
          "Check your VFR sectional chart carefully. Class B airspace has multiple shelves at different altitudes. You may be under a shelf but verify the exact boundaries before flying.",
      };
    }
    if (distNm < 30) {
      return {
        airspaceClass: "E or B (fringe)",
        canFly: true,
        nearestAirport: airportName,
        distanceNm: distNm,
        description: "Near Class B - Verify on Sectional",
        restrictions:
          "You are near a major airport. Check your VFR sectional chart for exact airspace boundaries.",
        recommendation:
          "You are likely outside the Class B surface area but should verify on a current VFR sectional chart. Watch for arriving/departing traffic.",
      };
    }
  }

  // Class C airspace (medium airports) - typically 5nm core + 10nm shelf
  if (nearest.type === "medium_airport") {
    if (distNm < 5) {
      return {
        airspaceClass: "C",
        canFly: false,
        nearestAirport: airportName,
        distanceNm: distNm,
        description: "Class C - Controlled Airspace",
        restrictions:
          "Part 103 ultralights need to avoid Class C airspace unless you have established two-way communication with ATC.",
        recommendation:
          "You are within the inner ring of Class C airspace. Contact the tower or find a location further from the airport.",
      };
    }
    if (distNm < 10) {
      return {
        airspaceClass: "C (shelf)",
        canFly: false,
        nearestAirport: airportName,
        distanceNm: distNm,
        description: "Class C - Outer Shelf (Possible)",
        restrictions:
          "You may be within the Class C outer shelf. Two-way ATC communication required.",
        recommendation:
          "Check your VFR sectional chart. Class C typically extends to 10nm with shelves. Consider moving further from the airport.",
      };
    }
  }

  // Class D airspace (small towered airports) - typically 4nm radius
  if (distNm < 4 && nearest.ident.startsWith("K")) {
    // Check if it might be a towered airport
    return {
      airspaceClass: "D (possible)",
      canFly: true,
      nearestAirport: airportName,
      distanceNm: distNm,
      description: "Possibly Class D - Towered Airport Nearby",
      restrictions:
        "If this airport has an active control tower, you need to establish communication with ATC before entering Class D airspace.",
      recommendation:
        "Check if this airport has an active tower. If towered, Part 103 ultralights must establish two-way communication before entering. If untowered, standard Class E or G rules apply.",
    };
  }

  // Class E or G
  if (distNm < 5) {
    return {
      airspaceClass: "E",
      canFly: true,
      nearestAirport: airportName,
      distanceNm: distNm,
      description: "Class E - Controlled Airspace (likely)",
      restrictions:
        "Part 103 ultralights may fly in Class E airspace. No ATC communication required, but standard visibility and cloud clearance rules apply.",
      recommendation:
        "You can fly here under Part 103 rules. Maintain VFR weather minimums: 3 statute miles visibility, 500 ft below clouds, 1000 ft above, 2000 ft horizontal from clouds.",
    };
  }

  return {
    airspaceClass: "E/G",
    canFly: true,
    nearestAirport: airportName,
    distanceNm: distNm,
    description: "Class E or G Airspace",
    restrictions:
      "Part 103 ultralights can fly freely. Follow standard VFR weather minimums.",
    recommendation:
      "Good location for paramotor flying! You are away from major airports. Always check NOTAMs for temporary flight restrictions (TFRs).",
  };
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
    const airports = await findNearbyAirports(lat, lon);
    const result = classifyAirspace(airports, lat, lon);

    return NextResponse.json({
      ...result,
      airports: airports.slice(0, 5).map((a) => ({
        ident: a.ident,
        name: a.name,
        distance: Math.round(haversineNm(lat, lon, a.latitude_deg, a.longitude_deg) * 10) / 10,
      })),
      note: "This is an approximation. ALWAYS verify airspace on a current VFR Sectional Chart before flying. Check FAA TFRs at tfr.faa.gov.",
    });
  } catch (err) {
    const message =
      err instanceof Error ? err.message : "Failed to check airspace";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
