import { useState, useEffect } from 'react';
import { Input } from '@/components/ui/input';
import { Badge } from '@/components/ui/badge';
import { fetchApi } from '@/lib/api';
import type { BinEntry } from '@/lib/bin-data';

interface BinSelectorProps {
  value: string;
  onChange: (bin: string) => void;
  onBinInfo?: (info: BinEntry | null) => void;
}

export function BinSelector({ value, onChange, onBinInfo }: BinSelectorProps) {
  const [brands, setBrands] = useState<string[]>([]);
  const [countries, setCountries] = useState<string[]>([]);
  const [bins, setBins] = useState<BinEntry[]>([]);
  const [selectedBrand, setSelectedBrand] = useState<string>('');
  const [selectedCountry, setSelectedCountry] = useState<string>('');
  const [selectedBin, setSelectedBin] = useState<string>(value || '');
  const [loading, setLoading] = useState(false);
  const [binInfo, setBinInfo] = useState<BinEntry | null>(null);

  // Fetch brands on mount
  useEffect(() => {
    fetchBrands();
  }, []);

  // Fetch countries when brand changes
  useEffect(() => {
    if (selectedBrand) {
      fetchCountries(selectedBrand);
    } else {
      setCountries([]);
      setBins([]);
    }
  }, [selectedBrand]);

  // Fetch BINs when country changes
  useEffect(() => {
    if (selectedBrand && selectedCountry) {
      fetchBins(selectedBrand, selectedCountry);
    } else {
      setBins([]);
    }
  }, [selectedBrand, selectedCountry]);

  // Lookup BIN info when BIN changes
  useEffect(() => {
    if (selectedBin && selectedBin.length >= 6) {
      lookupBin(selectedBin);
    } else {
      setBinInfo(null);
      onBinInfo?.(null);
    }
  }, [selectedBin]);

  const fetchBrands = async () => {
    try {
      setLoading(true);
      const response = await fetchApi<{ success: boolean; data: string[] }>('/api/bin/brands');
      if (response.success) {
        setBrands(response.data);
      }
    } catch (error) {
      console.error('Failed to fetch brands:', error);
    } finally {
      setLoading(false);
    }
  };

  const fetchCountries = async (brand: string) => {
    try {
      setLoading(true);
      const response = await fetchApi<{ success: boolean; data: string[] }>(`/api/bin/countries/${brand}`);
      if (response.success) {
        setCountries(response.data);
      }
    } catch (error) {
      console.error('Failed to fetch countries:', error);
    } finally {
      setLoading(false);
    }
  };

  const fetchBins = async (brand: string, country: string) => {
    try {
      setLoading(true);
      const response = await fetchApi<{ success: boolean; data: BinEntry[] }>(`/api/bin/list/${brand}/${country}`);
      if (response.success) {
        setBins(response.data);
      }
    } catch (error) {
      console.error('Failed to fetch BINs:', error);
    } finally {
      setLoading(false);
    }
  };

  const lookupBin = async (bin: string) => {
    try {
      const response = await fetchApi<{ success: boolean; data: BinEntry }>(`/api/bin/lookup/${bin}`);
      if (response.success) {
        setBinInfo(response.data);
        onBinInfo?.(response.data);
      }
    } catch (error) {
      console.error('Failed to lookup BIN:', error);
      setBinInfo(null);
      onBinInfo?.(null);
    }
  };

  const handleBrandChange = (e: React.ChangeEvent<HTMLSelectElement>) => {
    const brand = e.target.value;
    setSelectedBrand(brand);
    setSelectedCountry('');
    setSelectedBin('');
    setBins([]);
    onChange('');
  };

  const handleCountryChange = (e: React.ChangeEvent<HTMLSelectElement>) => {
    const country = e.target.value;
    setSelectedCountry(country);
    setSelectedBin('');
    onChange('');
  };

  const handleBinChange = (e: React.ChangeEvent<HTMLSelectElement>) => {
    const bin = e.target.value;
    setSelectedBin(bin);
    onChange(bin);
  };

  return (
    <div className="space-y-4">
      {/* Brand Selection */}
      <div className="space-y-2">
        <label htmlFor="brand" className="text-sm font-medium">
          Card Brand
        </label>
        <select
          id="brand"
          value={selectedBrand}
          onChange={handleBrandChange}
          disabled={loading}
          className="w-full h-10 px-3 rounded-md border border-input bg-background disabled:opacity-50"
        >
          <option value="">Select a brand</option>
          {brands.map((brand) => (
            <option key={brand} value={brand}>
              {brand.charAt(0).toUpperCase() + brand.slice(1)}
            </option>
          ))}
        </select>
      </div>

      {/* Country Selection */}
      <div className="space-y-2">
        <label htmlFor="country" className="text-sm font-medium">
          Country
        </label>
        <select
          id="country"
          value={selectedCountry}
          onChange={handleCountryChange}
          disabled={!selectedBrand || loading}
          className="w-full h-10 px-3 rounded-md border border-input bg-background disabled:opacity-50"
        >
          <option value="">Select a country</option>
          {countries.map((country) => (
            <option key={country} value={country}>
              {country}
            </option>
          ))}
        </select>
      </div>

      {/* BIN Selection */}
      <div className="space-y-2">
        <label htmlFor="bin" className="text-sm font-medium">
          BIN
        </label>
        <select
          id="bin"
          value={selectedBin}
          onChange={handleBinChange}
          disabled={!selectedCountry || loading}
          className="w-full h-10 px-3 rounded-md border border-input bg-background disabled:opacity-50"
        >
          <option value="">Select a BIN</option>
          {bins.map((binEntry) => (
            <option key={binEntry.bin} value={binEntry.bin}>
              {binEntry.bin} - {binEntry.issuer}
            </option>
          ))}
        </select>
      </div>

      {/* Custom BIN Input */}
      <div className="space-y-2">
        <label htmlFor="custom-bin" className="text-sm font-medium">
          Or enter custom BIN (6 digits)
        </label>
        <Input
          id="custom-bin"
          type="text"
          placeholder="Enter 6-digit BIN"
          maxLength={6}
          value={selectedBin}
          onChange={(e) => {
            const bin = e.target.value.replace(/\D/g, '');
            setSelectedBin(bin);
            onChange(bin);
          }}
        />
      </div>

      {/* BIN Info Display */}
      {binInfo && (
        <div className="p-4 border rounded-lg bg-muted/50 space-y-2">
          <div className="flex items-center gap-2 mb-2">
            <Badge variant="secondary">{binInfo.brand.toUpperCase()}</Badge>
            {binInfo.type && <Badge variant="outline">{binInfo.type}</Badge>}
          </div>
          <div className="text-sm space-y-1">
            <div><span className="font-medium">BIN:</span> {binInfo.bin}</div>
            <div><span className="font-medium">Issuer:</span> {binInfo.issuer}</div>
            <div><span className="font-medium">Country:</span> {binInfo.countryName}</div>
          </div>
        </div>
      )}
    </div>
  );
}
