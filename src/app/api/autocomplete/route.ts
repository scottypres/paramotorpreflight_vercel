import { NextRequest, NextResponse } from "next/server";

interface NominatimResult {
  display_name: string;
  lat: string;
  lon: string;
  type: string;
  address?: {
    city?: string;
    town?: string;
    village?: string;
    county?: string;
    state?: string;
    postcode?: string;
  };
}

export async function GET(request: NextRequest) {
  const q = request.nextUrl.searchParams.get("q");

  if (!q || q.trim().length < 2) {
    return NextResponse.json([]);
  }

  try {
    const encoded = encodeURIComponent(q.trim());
    const res = await fetch(
      `https://nominatim.openstreetmap.org/search?q=${encoded}&format=json&countrycodes=us&limit=5&addressdetails=1`,
      {
        headers: { "User-Agent": "ParamotorPreflight/1.0" },
      }
    );

    if (!res.ok) {
      return NextResponse.json([]);
    }

    const data: NominatimResult[] = await res.json();

    const suggestions = data.map((r) => {
      const addr = r.address;
      const city = addr?.city || addr?.town || addr?.village || "";
      const state = addr?.state || "";
      const label = city && state ? `${city}, ${state}` : r.display_name.split(",").slice(0, 2).join(",").trim();

      return {
        label,
        full: r.display_name,
        lat: parseFloat(r.lat),
        lon: parseFloat(r.lon),
      };
    });

    return NextResponse.json(suggestions);
  } catch {
    return NextResponse.json([]);
  }
}
