/**
 * Curated BIN list for VCC UI helpers.
 * Data lives in shared/bin-list.json (same source as the backend API).
 */
import raw from "@shared/bin-list.json";

export interface BinEntry {
  bin: string;
  brand: string;
  country: string;
  countryName: string;
  issuer?: string;
  type?: string;
}

export const BIN_LIST = raw as BinEntry[];

export function getBrands(): string[] {
  return Array.from(new Set(BIN_LIST.map((b) => b.brand))).sort();
}

export function getCountriesForBrand(brand: string): { code: string; name: string }[] {
  const countries = new Map<string, string>();
  for (const b of BIN_LIST) {
    if (b.brand === brand) countries.set(b.country, b.countryName);
  }
  return Array.from(countries.entries())
    .map(([code, name]) => ({ code, name }))
    .sort((a, b) => a.name.localeCompare(b.name));
}

export function getBinsForBrandAndCountry(brand: string, country: string): BinEntry[] {
  return BIN_LIST.filter((b) => b.brand === brand && b.country === country).sort((a, b) =>
    a.bin.localeCompare(b.bin),
  );
}

export function findBin(bin: string): BinEntry | undefined {
  return BIN_LIST.find((b) => b.bin === bin);
}
