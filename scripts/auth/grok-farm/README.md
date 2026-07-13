# Grok Standalone Farmer

CLI-only farmer for **xAI / Grok free CLI** accounts.  
Independent of poolprox3 — copy this folder to any VPS and run.

## What it does

1. Creates catch-all (or Gmail plus-trick) emails  
2. Registers at `accounts.x.ai` (OTP via IMAP)  
3. Completes profile + password + Turnstile  
4. Runs Grok CLI OAuth (PKCE) → `access_token` + `refresh_token`  
5. Writes results into a **new batch folder** each run (JSON + TXT)

Progress default = **HUD panel** (bar + active workers), bukan spam log.  
Detail tetap di `batch_*/farm.log`. Pakai `GROK_UI=log` untuk mode lama.  
Emails stay **unique across batches** via `results/used_emails.txt` + scan all past batches.

## Quick install (new VPS)

```bash
# 1) Copy this folder to the VPS (scp / rsync / git)
scp -r grok-farm user@vps:~/

# 2) On VPS
cd ~/grok-farm
chmod +x install.sh run.sh
./install.sh

# 3) Configure
nano .env   # IMAP + domain + password

# 4) Farm (CLI akan tanya jumlah akun + concurrency)
./run.sh
```

Saat start, bot tanya (Enter = pakai default `.env`):

```text
  Berapa akun yang mau di-farm? [5]: 20
  Concurrency (browser paralel)? [1]: 2
  Mulai farm 20 akun × concurrent 2? [Y/n]:
```

Non-interactive / script:

```bash
./run.sh -- -n 20 -c 2 -y          # flags diteruskan ke farm.py
# atau
source .venv/bin/activate
python farm.py -n 20 -c 2 -y
```

## `.env` essentials

| Variable | Example | Notes |
|----------|---------|--------|
| `GROK_IMAP_USER` | `you@gmail.com` | Inbox that receives OTP |
| `GROK_IMAP_PASS` | app password | Gmail App Password |
| `GROK_EMAIL_MODE` | `domain` | or `plus_trick` |
| `GROK_EMAIL_DOMAIN` | `koemail.my.id` | catch-all (no `@`) |
| `GROK_PASSWORD` | `$Priyo000` | password for all accounts |
| `GROK_MAX_ACCOUNTS` | `10` | how many this run |
| `GROK_CONCURRENT` | `1` | browsers in parallel (start with 1–2) |
| `GROK_HEADLESS` | `false` | **false recommended** for Turnstile |
| `GROK_PROXY_FILE` | `./proxies.txt` | list file (auto if file exists) |
| `GROK_PROXY_SHUFFLE` | `false` | shuffle pool at start |
| `GROK_PROXY_POOL` | (optional) | comma-separated URLs merged with file |

### Proxy list file

For concurrent farming / Cloudflare Turnstile, put residential (or mobile) proxies in `proxies.txt` (one per line):

```bash
cp proxies.txt.example proxies.txt
nano proxies.txt
```

Formats supported:

```text
http://user:pass@host:port
socks5://user:pass@host:port
host:port
host:port:user:pass
user:pass@host:port
```

Each new account takes the **next** proxy (round-robin). Startup banner shows how many loaded, e.g. `Proxies: 50 (file:/…/proxies.txt (50))`. Without a file / env → **direct** VPS IP.

## Output (per batch)

Setiap run membuat folder baru:

```text
results/
  used_emails.txt                 # global dedup (semua batch)
  batch_20260710_031500_a1b2c3/
    batch_meta.json               # id, count, created/failed, times
    accounts.json                 # full records batch ini saja
    accounts.txt                  # email|password|access|refresh|expires
    failed.json
    farm.log                      # full step detail (IMAP/Turnstile/…)
  batch_...
```

### HUD vs log

| Env | Tampilan |
|-----|----------|
| `GROK_UI=hud` (default di TTY) | Panel progress: bar, ok/fail/run, worker step |
| `GROK_UI=log` | Line log klasik per step |
| `GROK_VERBOSE=true` | HUD + detail ke terminal juga |

Contoh HUD:

```text
╭──────────── Grok Farm  ·  batch 20260710_… ────────────╮
│ ████████░░░░░░░░░░░░░░    8/20   40%                    │
│ ok=7  fail=1  run=2  elapsed 12:04                      │
│─────────────────────────────────────────────────────────│
│  #9   ab12…@koemail.my.id   wait_otp       45s          │
│  #10  cd34…@koemail.my.id   turnstile      12s          │
│─────────────────────────────────────────────────────────│
│  ✓ #8 ab12…@koemail…                                    │
╰─────────────────────────────────────────────────────────╯
```

**Email uniqueness**
- Local-part pakai `secrets` (crypto), default **16** char `a-z0-9` (~36¹⁶ space)
- Saat generate langsung di-reserve ke `used_emails.txt`
- Start run: load `used_emails.txt` + semua `batch_*/accounts.json` + legacy `accounts.json`

Import ke poolprox3: ambil **folder batch** yang baru (bukan campur).

## Import into poolprox3 (optional)

TXT lines can be imported / used with your own tooling.  
JSON `tokens` object matches poolprox3 Grok shape:

```json
{
  "access_token": "...",
  "refresh_token": "...",
  "expires_at": "...",
  "client_id": "b1a00492-...",
  "auth_mode": "oidc",
  "email": "..."
}
```

## Tips

- **Turnstile**: prefer headed (`GROK_HEADLESS=false`) or `xvfb-run -a ./run.sh`
- **Catch-all**: IMAP must be the mailbox that receives `@yourdomain` forwards  
- **OTP format**: xAI codes look like `K35-1QR` (not 6 digits)  
- **Rate limits**: keep `GROK_CONCURRENT=1` if many fails  
- Stop anytime: `Ctrl+C` (partial results batch ini tetap tersimpan; batch folder tidak dihapus)
- Batch terpisah: cancel + farm lagi → folder `batch_*` baru, email tetap unique

## Layout

```text
grok-farm/
  install.sh
  run.sh
  farm.py
  requirements.txt
  .env.example
  proxies.txt.example
  proxies.txt          # your list (gitignored)
  results/
    used_emails.txt
    batch_<id>/
  screenshots/
  README.md
```

## Manual run

```bash
source .venv/bin/activate
python farm.py
```
