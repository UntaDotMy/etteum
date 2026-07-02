# Alibaba Model Groups Implementation

## Summary

Implemented model-based account grouping for Alibaba provider to solve the issue where warmup marks accounts as "active" but queries still fail with "API error" because the model isn't actually queryable on that account.

## Changes Made

### 1. Backend Changes

#### `src/proxy/providers/alibaba.ts`
- Extended `AlibabaQuotaTokens` interface to include `queryableModels?: string[]`
- Modified `healthCheck()` to track which models successfully respond to probe requests
- Stores verified queryable models in account tokens during warmup

#### `src/proxy/pool.ts`
- Added `getNextAccountForModel(provider, model)` method
- For Alibaba: filters accounts by checking if `tokens.queryableModels` contains the requested model
- For other providers: falls back to standard `getNextAccount(provider)`
- Implements load balancing only among eligible accounts

#### `src/proxy/router.ts`
- Updated `routeRequest()` to use `pool.getNextAccountForModel()` instead of `pool.getNextAccount()`
- Ensures requests only go to accounts that can actually query the model

#### `src/api/accounts.ts`
- Added `GET /api/accounts/model-groups` endpoint
- Returns accounts grouped by queryable models
- Includes error group for accounts with issues or no verified models
- Provides summary statistics

### 2. Dashboard Changes

#### `dashboard/src/lib/api.ts`
- Added `fetchAlibabaModelGroups()` API function

#### `dashboard/src/components/AlibabaModelGroups.tsx`
- New component displaying model groups visualization
- Shows summary stats (total, active, error, model count)
- Lists each model with account count
- Displays error group with common issues

#### `dashboard/src/pages/Accounts.tsx`
- Integrated `AlibabaModelGroups` component
- Shows model groups when Alibaba accounts exist

## How It Works

1. **Warmup Phase**: When warmup runs on Alibaba accounts, it probes each model with a minimal chat request
2. **Tracking**: Models that respond successfully are added to `queryableModels` array in account tokens
3. **Routing**: When a query comes in for a model (e.g., `ali-qwen-plus`):
   - System filters Alibaba accounts to only those with `qwen-plus` in their `queryableModels`
   - Load balances among eligible accounts
   - If no accounts can query the model, returns "No active accounts available"
4. **Dashboard**: Shows visual grouping of accounts by model capability

## Benefits

- **No more failed queries**: Only routes to accounts that can actually query the model
- **Clear visibility**: Dashboard shows which accounts can query which models
- **Error isolation**: Accounts with issues are grouped separately with reasons
- **Backward compatible**: Falls back to current behavior if `queryableModels` not yet populated

## Migration

- Existing accounts will have `queryableModels: undefined` initially
- First warmup after deployment populates this field
- Until populated, routing falls back to all active accounts (current behavior)

## Example Response

```json
{
  "data": {
    "models": {
      "qwen-plus": {
        "accounts": [1, 3, 5],
        "count": 3,
        "emails": ["key1", "key3", "key5"]
      },
      "qwen-max": {
        "accounts": [1, 2],
        "count": 2,
        "emails": ["key1", "key2"]
      }
    },
    "error": {
      "accounts": [4, 6],
      "count": 2,
      "emails": ["key4", "key6"],
      "reasons": ["No queryable models verified"]
    },
    "summary": {
      "totalAccounts": 6,
      "activeAccounts": 4,
      "errorAccounts": 2,
      "modelCount": 2
    }
  }
}
```

## Testing

1. Run warmup on Alibaba accounts
2. Check dashboard to see model groups
3. Query a model - should only use accounts in that model's group
4. Query a model with no accounts - should return clear error message
