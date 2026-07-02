# Plan: Tambah Provider YouMind ke Etteum Pool

## Konteks

YouMind (https://youmind.com) menyediakan dua **Relay endpoint** yang sudah Anthropic/OpenAI compatible — tinggal kasih `Authorization: Bearer sk-ym-...`:

- **Anthropic relay** → `POST /openapi/v1/chat/anthropic/v1/messages`
  Models valid: `claude-opus-4-6`, `claude-opus-4-7`, `claude-opus-4-8`, `claude-sonnet-4-6`
- **OpenAI relay** → `POST /openapi/v1/chat/openai/v1/chat/completions`
  Models valid: `gpt-5.5`, `gpt-4o`
- **Models endpoint** → `GET /openapi/v1/chat/anthropic/v1/models` (list Claude models)
- **Health probe** → `POST /openapi/v1/listBoards` body `{}` (cheap, no inference)

Auth = **API key paste** (mirip Qoder PAT). Tidak butuh browser automation.

## Pemahaman Pattern Provider Existing

Setelah inspect 8 provider (`registry.ts`):

| Provider | Auth Method | Format | File pattern |
|---|---|---|---|
| kiro / kiro-pro | email/pass + browser | proprietary AWS | python script |
| codebuddy | email/pass + browser → api_key | proprietary | python script |
| canva | email/pass + browser | proprietary | python script |
| codex | OAuth | OpenAI Responses API | TS only (refresh token) |
| qoder | **PAT paste** | proprietary COSY signed | TS only |
| **byok** | **API key + custom URL** | **dual: openai/anthropic** | TS only — closest to YouMind! |
| gitlab-duo | PAT | proprietary | TS only |

**Insight kunci**: BYOK provider sudah punya semua building block — dispatcher `chatCompletionOpenAI/Anthropic`, password encryption, dual format support. Tapi BYOK generic (user-defined URL/models). YouMind = **"BYOK with hard-coded URL & curated model list"**.

## Pertanyaan User & Jawaban

User minta saya cek pattern dulu sebelum decide. Setelah cek:

**Q: 1 akun untuk semua model, atau split per-route?**
**A:** **1 akun = semua model** (recommended pattern). Alasan:
- Sama dengan UX YouMind sendiri (1 API key → semua model)
- Provider class internal yang dispatcher route ke endpoint tepat by model prefix (`ym-claude-*` → Anthropic relay, `ym-gpt-*` → OpenAI relay)
- Konsisten dengan codebuddy (1 account, banyak model dengan dispatcher internal `cb-opus-*`, `cb-gpt-*`, `cb-gemini-*`)

**Q: Prefix model?**
**A:** `ym-` (lowercase, konsisten dengan `cb-`/`qd-`/`kp-`)

**Q: Scope?**
**A:** Semua: chat+stream, quota, warmup, compression integration

## Arsitektur Implementasi

### Provider Class Design

Single class `YouMindProvider extends BaseProvider`, dispatcher pattern:

```
chatCompletion(account, request)
  → resolveModel(request.model) → { actualModel, route: "anthropic" | "openai" }
    ├── route === "anthropic" → callAnthropicRelay()  [native: anthropic format]
    └── route === "openai"    → callOpenAIRelay()     [native: openai format]
```

`nativeFormat` set ke `"openai"` (mayoritas use case), tapi class internal handle conversion saat target Anthropic. Ini sama dengan pola BYOK.

### Model Catalog

```ts
const YM_MODEL_MAP = {
  // Anthropic relay
  "ym-claude-opus-4.6":   { upstream: "claude-opus-4-6",   route: "anthropic", ctx: 200000, max_out: 64000, vision: true,  thinking: true  },
  "ym-claude-opus-4.7":   { upstream: "claude-opus-4-7",   route: "anthropic", ctx: 200000, max_out: 64000, vision: true,  thinking: true  },
  "ym-claude-opus-4.8":   { upstream: "claude-opus-4-8",   route: "anthropic", ctx: 200000, max_out: 64000, vision: true,  thinking: true  },
  "ym-claude-sonnet-4.6": { upstream: "claude-sonnet-4-6", route: "anthropic", ctx: 200000, max_out: 64000, vision: true,  thinking: true  },
  // OpenAI relay
  "ym-gpt-5.5":           { upstream: "gpt-5.5",           route: "openai",    ctx: 200000, max_out: 16000, vision: true,  thinking: true  },
  "ym-gpt-4o":            { upstream: "gpt-4o",            route: "openai",    ctx: 128000, max_out: 16000, vision: true,  thinking: false },
}
```

`ownsModel(m)` → `m.toLowerCase().startsWith("ym-")`

### Storage Schema

Pakai tabel `accounts` existing tanpa migration:

| Kolom | Isi YouMind |
|---|---|
| `provider` | `"youmind"` |
| `email` | hasil dari endpoint identity (atau `youmind-{first8chars}@apikey` fallback) |
| `password` | encrypted API key (`encrypt("sk-ym-...")`) |
| `tokens` | `null` (atau `{ "validated_at": ts }` opsional) |
| `status` | `"active"` setelah validasi |
| `quotaLimit/Remaining` | -1 (unlimited) atau numeric kalau YouMind expose credits |
| `metadata` | `{ "models_seen": [...] }` opsional |

Ini sama persis pola BYOK (api key di password, encrypted), tapi tanpa user-defined config karena YouMind hard-coded.

### Auth Flow (Add Account)

Reuse pattern Qoder PAT:

```
POST /api/accounts
  body: { provider: "youmind", apiKey: "sk-ym-..." }
  ↓
activateYouMindKey(apiKey)
  ↓
  1. Validate via GET /openapi/v1/chat/anthropic/v1/models
     - 200 → key valid, dapat list model
     - 401 → return error "Invalid API key"
  2. Probe identity via POST /openapi/v1/listBoards (untuk cek user/space)
     - dapat space_id, creator_id, boards count → simpan di metadata
  3. Encrypt key → insert into accounts
  ↓
return { id, provider, email, status: "active" }
```

Tidak butuh modifikasi Python script (`scripts/auth/`) sama sekali.

## File yang Akan Dibuat / Diubah

### 1. **CREATE** `src/proxy/providers/youmind.ts` (~600 lines)

Provider class lengkap. Skeleton:

```ts
export class YouMindProvider extends BaseProvider {
  name = "youmind";
  override nativeFormat = "openai" as const;
  
  override ownsModel(m: string) { return m.toLowerCase().startsWith("ym-"); }
  
  supportedModels: ModelInfo[] = [/* dari YM_MODEL_MAP */];
  
  // Helpers
  private getApiKey(account): string  // decrypt password
  private resolveModel(model): { upstream, route }
  
  // Anthropic relay path
  private async chatCompletionAnthropic(account, request) { /* ... */ }
  private async chatCompletionStreamAnthropic(account, request) { /* ... */ }
  
  // OpenAI relay path  
  private async chatCompletionOpenAI(account, request) { /* ... */ }
  private async chatCompletionStreamOpenAI(account, request) { /* ... */ }
  
  // Dispatchers (BaseProvider contract)
  async chatCompletion(account, request): Promise<ProviderResult> {
    const { route } = this.resolveModel(request.model);
    return route === "anthropic"
      ? this.chatCompletionAnthropic(account, request)
      : this.chatCompletionOpenAI(account, request);
  }
  async chatCompletionStream(account, request): Promise<ProviderResult> { /* same dispatcher */ }
  
  async refreshToken(): Promise<{ success: true }> { return { success: true }; }
  
  async validateAccount(account): Promise<boolean> {
    return !!this.getApiKey(account);
  }
  
  async fetchQuota(account): Promise<{ success: true, quota: ... }> {
    // YouMind tidak expose quota number per-account, return -1 (unlimited)
    // Tapi probe listBoards untuk verify key masih live
    const res = await fetch("https://youmind.com/openapi/v1/listBoards", {
      method: "POST",
      headers: { "x-api-key": apiKey, "Content-Type": "application/json" },
      body: "{}",
    });
    if (res.status === 401) return { success: false, error: "expired: invalid key" };
    if (!res.ok) return { success: false, error: `HTTP ${res.status}` };
    return { success: true, quota: { limit: -1, remaining: -1, used: 0, resetAt: null } };
  }
}

// Public helpers untuk add-account flow
export async function activateYouMindKey(apiKey: string): Promise<{
  email: string;
  metadata: Record<string, unknown>;
}> { /* ... */ }
```

**Implementasi detail kunci:**

- **Anthropic non-stream**: forward request as-is ke `/chat/anthropic/v1/messages` dengan body Anthropic format. Karena edge sudah handle Anthropic↔OpenAI translation (lihat `transforms/anthropic.ts`), kalau client kirim OpenAI format dan provider native=anthropic, edge convert otomatis. Tapi karena nativeFormat kita "openai", kita conversion sendiri pakai BYOK pattern.
  - **Lebih simpel**: set `nativeFormat = "anthropic"` di-base provider, tapi karena YouMind handle 2 format, kita set "openai" (default) dan tangani konversi inline saat hit Anthropic relay.
  - Ini PERSIS pattern BYOK `chatCompletionAnthropic` di lines 526-700.

- **Anthropic stream**: passthrough SSE ke client, rewrite `model` field saja (BYOK pattern di-line 580-720).

- **OpenAI stream**: passthrough (BYOK pattern di-line 427-522).

- **Token compression**: tidak perlu effort tambahan. Pipeline RTK/DCP/dll di `src/proxy/compression/` bekerja di edge level pada chat messages SEBELUM provider dipanggil — provider cuma terima request yang sudah dikompres. Selama provider implement `chatCompletion`/`chatCompletionStream` standar, compression bekerja transparan. (Konfirmasi dari `src/proxy/index.ts` yang call compression pre-provider.)

- **GPT-5.x quirks**: OpenAI relay tolak `max_tokens`, butuh `max_completion_tokens` (sudah ditest!). Provider ini convert `request.max_tokens` → `max_completion_tokens` saat hit OpenAI relay GPT-5.x.

### 2. **EDIT** `src/proxy/providers/registry.ts` (3 lines)

```diff
+ import { YouMindProvider } from "./youmind";
  ...
+ const youmind = new YouMindProvider();
  ...
- const PROVIDER_ORDER = [gitlabDuo, canva, qoder, codex, kiroPro, byok, codebuddy, kiro] as const;
+ const PROVIDER_ORDER = [gitlabDuo, canva, qoder, codex, kiroPro, youmind, byok, codebuddy, kiro] as const;
  
  export const providers = {
    ...
+   youmind,
  } as const;
```

Posisi: sebelum `byok` (lebih spesifik) dan sebelum `codebuddy`/`kiro` (yang fallback). Karena prefix `ym-` unik, posisi tidak load-bearing.

### 3. **EDIT** `src/api/accounts.ts` (~50 lines added)

Tambah branch youmind di `POST /api/accounts` mirip dengan branch qoder existing (line 907-948):

```ts
import { activateYouMindKey } from "../proxy/providers/youmind";

// di handler POST /
if (body.provider === "youmind" && body.apiKey) {
  const trimmed = body.apiKey.trim();
  if (!trimmed.startsWith("sk-ym-")) {
    return c.json({ error: "API key must start with sk-ym-" }, 400);
  }
  try {
    const { email, metadata } = await activateYouMindKey(trimmed);
    const encrypted = encrypt(trimmed);
    
    // Upsert by email+provider
    const existing = await db.select().from(accounts)
      .where(eq(accounts.email, email))
      .then(rows => rows.find(r => r.provider === "youmind"));
    
    if (existing) {
      await db.update(accounts).set({
        password: encrypted,
        status: "active",
        metadata,
        errorMessage: null,
        lastLoginAt: new Date(),
        updatedAt: new Date(),
      }).where(eq(accounts.id, existing.id));
      pool.invalidate("youmind");
      broadcast({ type: "account_updated", data: { id: existing.id, provider: "youmind", status: "active" } });
      return c.json({ id: existing.id, provider: "youmind", email, status: "active", updated: true }, 200);
    }
    
    const inserted = await db.insert(accounts).values({
      provider: "youmind",
      email,
      password: encrypted,
      status: "active",
      tokens: null,
      metadata,
      lastLoginAt: new Date(),
      quotaLimit: -1,
      quotaRemaining: -1,
    }).returning();
    const created = inserted[0]!;
    pool.invalidate("youmind");
    broadcast({ type: "account_created", data: { id: created.id, provider: "youmind", email } });
    return c.json({ ...created, password: "***", tokens: null }, 201);
  } catch (error) {
    return c.json({ error: `YouMind activation failed: ${error.message}` }, 400);
  }
}
```

Juga update type union di line 893:
```ts
provider: "kiro" | "kiro-pro" | "codebuddy" | "canva" | "codex" | "qoder" | "gitlab-duo" | "youmind";
+ apiKey?: string; // YouMind
```

### 4. **EDIT** `dashboard/src/pages/Accounts.tsx` (~30 lines)

3 perubahan:

**(a)** Line 45 — tambah ke type union:
```diff
- type Provider = "kiro" | "kiro-pro" | "codebuddy" | "canva" | "codex" | "qoder" | "gitlab-duo";
+ type Provider = "kiro" | "kiro-pro" | "codebuddy" | "canva" | "codex" | "qoder" | "gitlab-duo" | "youmind";
```

**(b)** Line 56 — tambah ke array:
```diff
- const providers: Provider[] = ["kiro", "kiro-pro", "codebuddy", "canva", "codex", "qoder", "gitlab-duo"];
+ const providers: Provider[] = ["kiro", "kiro-pro", "codebuddy", "canva", "codex", "qoder", "gitlab-duo", "youmind"];
```

**(c)** Line 58 — tambah label:
```diff
  function labelProvider(provider: string) {
    if (provider === "codebuddy") return "CodeBuddy";
    ...
+   if (provider === "youmind") return "YouMind";
    ...
  }
```

**(d)** Line ~1302 — tambah branch di add-account dialog form. Mirip dengan branch qoder PAT yang existing — render input single textarea/text untuk API key dengan label "Paste YouMind API Key (sk-ym-...)" + button submit yang call `POST /api/accounts` dengan `{ provider: "youmind", apiKey }`.

### 5. **CREATE** `docs/youmind-provider.md` (opsional, tapi project punya `docs/` folder)

Singkat: cara dapat API key, list model, contoh request, troubleshooting.

## Yang TIDAK Perlu Diubah

- ❌ `scripts/auth/` — tidak ada Python integration sama sekali
- ❌ `src/db/schema.ts` — schema accounts existing cukup
- ❌ `src/db/migrate.ts` — tidak ada migrasi baru
- ❌ `src/auth/runner.ts` — runner cuma untuk browser-based provider
- ❌ `src/auth/warmup-runner.ts` — warmup auto-handle via `BaseProvider.healthCheck()` default
- ❌ `src/proxy/compression/*` — compression beroperasi di edge, transparan
- ❌ `src/proxy/transforms/anthropic.ts` — kita handle conversion internal di provider class

## Step-by-Step Implementation Order

1. **Buat `src/proxy/providers/youmind.ts`** — provider class lengkap
2. **Edit `src/proxy/providers/registry.ts`** — register provider
3. **Edit `src/api/accounts.ts`** — add-account endpoint untuk YouMind
4. **Test backend manual** dengan curl:
   - `POST /api/accounts` body `{ provider: "youmind", apiKey: "sk-ym-..." }` → expect 201
   - `POST /v1/chat/completions` body `{ model: "ym-claude-sonnet-4.6", messages: [...] }` → expect Claude response
   - Stream test dengan `stream: true`
   - Test GPT route: `model: "ym-gpt-5.5"` (perhatikan max_completion_tokens)
5. **Edit `dashboard/src/pages/Accounts.tsx`** — UI add-account
6. **Build dashboard**: `cd dashboard && bun run build`
7. **Restart**: `etteum restart`
8. **End-to-end test via dashboard**: add account → see model di /v1/models → invoke chat

## Risiko & Mitigasi

| Risiko | Mitigasi |
|---|---|
| YouMind ubah model ID format | Hard-coded map di YM_MODEL_MAP, mudah update |
| Quota tidak exposed via API | Return `-1` (unlimited sentinel) — sudah established di base.ts |
| User submit key bukan sk-ym format | Validate prefix di add-account API |
| Anthropic-vs-OpenAI format mismatch saat client minta non-native | BYOK pattern sudah test conversion → reuse |
| Streaming SSE format YouMind beda dari upstream | Test paling awal — kalau ada kuirk, fix di stream parser |
| GPT-5.x butuh max_completion_tokens | Sudah dikonfirmasi via test live, handle di OpenAI relay code |

## Estimasi LOC

- `youmind.ts`: ~550 LOC (~50% dari BYOK karena tidak butuh dynamic config)
- `registry.ts`: +3 LOC
- `accounts.ts`: +50 LOC
- `Accounts.tsx`: +30 LOC
- **Total**: ~635 LOC, single PR

## Validasi Berhasil

✅ `curl http://localhost:1930/v1/models` → ada 6 model `ym-*` di list
✅ `curl http://localhost:1930/v1/chat/completions -d '{"model":"ym-claude-sonnet-4.6",...}'` → response Claude valid
✅ Stream version → SSE chunks valid
✅ `curl http://localhost:1930/v1/chat/completions -d '{"model":"ym-gpt-5.5",...}'` → response GPT valid
✅ Dashboard "Add Account" untuk YouMind → form muncul, submit jalan
✅ Account muncul di Accounts page dengan status "active"
✅ Auto-warmup tick → status tetap "active"
