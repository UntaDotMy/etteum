import { Hono } from 'hono';
import { BIN_LIST as binList } from '../lib/bin-data';

export const binApi = new Hono();

/**
 * GET /api/bin/brands
 * Get all available card brands
 */
binApi.get('/brands', async (c) => {
  try {
    const brands = [...new Set(binList.map(b => b.brand))].sort();
    return c.json({ success: true, data: brands });
  } catch (error) {
    return c.json({
      success: false,
      error: 'Failed to fetch brands'
    }, 500);
  }
});

/**
 * GET /api/bin/countries/:brand
 * Get all countries that support a specific brand
 */
binApi.get('/countries/:brand', async (c) => {
  try {
    const brand = c.req.param('brand').toLowerCase();
    const countries = [...new Set(
      binList
        .filter(b => b.brand === brand)
        .map(b => b.country)
    )].sort();

    return c.json({ success: true, data: countries });
  } catch (error) {
    return c.json({
      success: false,
      error: 'Failed to fetch countries'
    }, 500);
  }
});

/**
 * GET /api/bin/list/:brand/:country
 * Get all BINs for a specific brand and country
 */
binApi.get('/list/:brand/:country', async (c) => {
  try {
    const brand = c.req.param('brand').toLowerCase();
    const country = c.req.param('country').toUpperCase();

    const bins = binList
      .filter(b => b.brand === brand && b.country === country)
      .sort((a, b) => a.bin.localeCompare(b.bin));

    return c.json({ success: true, data: bins });
  } catch (error) {
    return c.json({
      success: false,
      error: 'Failed to fetch BINs'
    }, 500);
  }
});

/**
 * GET /api/bin/lookup/:bin
 * Lookup BIN details from binlist.net API (optional enrichment)
 */
binApi.get('/lookup/:bin', async (c) => {
  try {
    const bin = c.req.param('bin');

    // First check local list
    const localBin = binList.find(b => b.bin === bin);

    // If found locally, return it
    if (localBin) {
      return c.json({ success: true, data: localBin });
    }

    // Try to fetch from binlist.net for enrichment
    try {
      const response = await fetch(`https://lookup.binlist.net/${bin}`, {
        headers: {
          'Accept-Version': '3'
        }
      });

      if (response.ok) {
        const data = await response.json() as Record<string, any>;
        return c.json({
          success: true,
          data: {
            bin,
            brand: data.scheme?.toLowerCase() || 'unknown',
            type: data.type?.toLowerCase() || 'unknown',
            country: data.country?.alpha2 || 'unknown',
            countryName: data.country?.name || 'Unknown',
            issuer: data.bank?.name || 'Unknown'
          }
        });
      }
    } catch (apiError) {
      // If API fails and no local data, return not found
    }

    // No data found
    return c.json({
      success: false,
      error: 'BIN not found'
    }, 404);
  } catch (error) {
    return c.json({
      success: false,
      error: 'Failed to lookup BIN'
    }, 500);
  }
});

/**
 * GET /api/bin/stats
 * Get statistics about available BINs
 */
binApi.get('/stats', async (c) => {
  try {
    const totalBins = binList.length;
    const brands = [...new Set(binList.map(b => b.brand))].length;
    const countries = [...new Set(binList.map(b => b.country))].length;

    return c.json({
      success: true,
      data: {
        totalBins,
        totalBrands: brands,
        totalCountries: countries
      }
    });
  } catch (error) {
    return c.json({
      success: false,
      error: 'Failed to fetch stats'
    }, 500);
  }
});
