#!/usr/bin/env python3
"""
TELEMETRY DASHBOARD // local server

Serves dashboard.html and exposes this machine's vitals at /api/stats.

Runs on every machine in the ecosystem. One machine is the HOST (serves the
page to everyone, including phones over Tailscale); the others run in AGENT
mode and only report their own vitals, which the host aggregates.

  Host mode :  python3 server.py --host 0.0.0.0 --name kieran-desktop
  Agent mode:  python3 server.py --host 0.0.0.0 --name kieran-laptop --agent

Config lives in config.json next to this file. CLI flags override it.
"""

import argparse
import json
import os
import socket
import time
import urllib.request
from http.server import HTTPServer, SimpleHTTPRequestHandler
from pathlib import Path

ROOT = Path(__file__).resolve().parent

DEFAULTS = {
    "port": 8080,
    "bind": "127.0.0.1",
    "machine_name": socket.gethostname(),
    "agent": False,
    "peers": [],          # host mode: other machines to poll, e.g. ["kieran-laptop:8080"]
    "peer_timeout": 2.0,
    "exec_url": "",       # Apps Script /exec URL, handed to the browser via /api/config
    "journal_dir": "~/journal",
    "journal_min_words": 15,   # below this, the day doesn't count toward the streak
    "journal_history": 28,     # days of metadata the dashboard asks for
}


def load_config():
    cfg = dict(DEFAULTS)
    path = ROOT / "config.json"
    if path.exists():
        try:
            cfg.update(json.loads(path.read_text()))
        except json.JSONDecodeError as e:
            print(f"[warn] config.json is not valid JSON ({e}); using defaults")
    return cfg


# ----------------------------------------------------------------------
#  /proc readers
#  Every one of these degrades to None rather than raising. A missing
#  battery on the desktop must not take the whole endpoint down.
# ----------------------------------------------------------------------

_prev_cpu = {"idle": 0, "total": 0}


def read_cpu():
    """Percent busy since the previous call. First call returns None."""
    try:
        with open("/proc/stat") as f:
            parts = [float(x) for x in f.readline().split()[1:]]
    except OSError:
        return None

    idle = parts[3] + (parts[4] if len(parts) > 4 else 0)
    total = sum(parts)

    d_idle = idle - _prev_cpu["idle"]
    d_total = total - _prev_cpu["total"]
    _prev_cpu["idle"], _prev_cpu["total"] = idle, total

    if d_total <= 0:
        return None
    return round(100.0 * (1.0 - d_idle / d_total), 1)


def read_mem():
    try:
        info = {}
        with open("/proc/meminfo") as f:
            for line in f:
                key, _, rest = line.partition(":")
                info[key] = float(rest.split()[0])  # kB
    except OSError:
        return None

    total = info.get("MemTotal", 0)
    avail = info.get("MemAvailable", info.get("MemFree", 0))
    if not total:
        return None

    return {
        "total_gb": round(total / 1048576, 1),
        "used_gb": round((total - avail) / 1048576, 1),
        "pct": round(100.0 * (total - avail) / total, 1),
    }


def read_uptime():
    try:
        with open("/proc/uptime") as f:
            return int(float(f.readline().split()[0]))
    except (OSError, ValueError):
        return None


def read_disk(path="/"):
    try:
        st = os.statvfs(path)
    except OSError:
        return None
    total = st.f_blocks * st.f_frsize
    free = st.f_bavail * st.f_frsize
    if not total:
        return None
    return {
        "total_gb": round(total / 1073741824, 1),
        "used_gb": round((total - free) / 1073741824, 1),
        "pct": round(100.0 * (total - free) / total, 1),
    }


def read_battery():
    """None on the desktop, which is correct and not an error."""
    base = Path("/sys/class/power_supply")
    if not base.exists():
        return None
    for entry in sorted(base.iterdir()):
        try:
            if (entry / "type").read_text().strip() != "Battery":
                continue
            pct = int((entry / "capacity").read_text().strip())
            status = (entry / "status").read_text().strip()
            return {"pct": pct, "status": status}
        except (OSError, ValueError):
            continue
    return None


def read_temp():
    """Prefer a CPU package sensor; fall back to the first readable zone."""
    base = Path("/sys/class/thermal")
    if not base.exists():
        return None

    fallback = None
    for zone in sorted(base.glob("thermal_zone*")):
        try:
            kind = (zone / "type").read_text().strip()
            milli = int((zone / "temp").read_text().strip())
        except (OSError, ValueError):
            continue
        celsius = round(milli / 1000.0, 1)
        if celsius <= 0 or celsius > 150:
            continue
        if kind in ("x86_pkg_temp", "acpitz", "coretemp"):
            return celsius
        if fallback is None:
            fallback = celsius
    return fallback


def read_load():
    try:
        return [round(x, 2) for x in os.getloadavg()]
    except OSError:
        return None


def collect(name):
    return {
        "name": name,
        "at": time.time(),
        "cpu": read_cpu(),
        "mem": read_mem(),
        "disk": read_disk(),
        "battery": read_battery(),
        "temp": read_temp(),
        "uptime": read_uptime(),
        "load": read_load(),
    }


def poll_peers(cfg):
    """Host mode: gather vitals from agent machines. Failures become
    offline markers rather than exceptions, so one sleeping laptop
    doesn't blank the panel."""
    out = []
    for peer in cfg.get("peers", []):
        url = peer if peer.startswith("http") else f"http://{peer}"
        try:
            with urllib.request.urlopen(
                f"{url}/api/stats?local=1", timeout=cfg["peer_timeout"]
            ) as r:
                data = json.loads(r.read().decode())
            out.extend(data.get("machines", []))
        except Exception:
            out.append({"name": peer.split(":")[0], "online": False})
    return out


# ----------------------------------------------------------------------
#  Journal
#
#  Entries are plain markdown, one file per day, stored locally on the
#  host. The text never leaves this machine. Only the word count is
#  pushed to the spreadsheet, which is enough for the streak and the
#  ring without putting your thinking in a spreadsheet.
# ----------------------------------------------------------------------

DATE_RE = __import__("re").compile(r"^\d{4}-\d{2}-\d{2}$")


def journal_dir(cfg):
    d = Path(os.path.expanduser(cfg["journal_dir"]))
    d.mkdir(parents=True, exist_ok=True)
    return d


def journal_path(cfg, day):
    """Reject anything that isn't a bare ISO date, so a crafted request
    can't walk out of the journal directory."""
    if not DATE_RE.match(day):
        raise ValueError("bad date")
    return journal_dir(cfg) / f"{day}.md"


def count_words(text):
    return len([w for w in text.split() if w.strip()])


def journal_read(cfg, day):
    path = journal_path(cfg, day)
    text = path.read_text(encoding="utf-8") if path.exists() else ""
    return {"date": day, "text": text, "words": count_words(text)}


def journal_write(cfg, day, text):
    path = journal_path(cfg, day)
    tmp = path.with_suffix(".md.tmp")
    tmp.write_text(text, encoding="utf-8")
    tmp.replace(path)            # atomic, so an autosave mid-write can't truncate
    words = count_words(text)
    if words >= cfg["journal_min_words"]:
        push_journal_count(cfg, day, words)
    return {"date": day, "words": words, "saved": True}


def journal_meta(cfg, days):
    """Word count per day plus the current streak, for the ring."""
    import datetime

    today = datetime.date.today()
    out = []
    for i in range(days - 1, -1, -1):
        day = today - datetime.timedelta(days=i)
        path = journal_dir(cfg) / f"{day.isoformat()}.md"
        words = count_words(path.read_text(encoding="utf-8")) if path.exists() else 0
        out.append({"date": day.isoformat(), "words": words})

    threshold = cfg["journal_min_words"]
    streak = 0
    for i, rec in enumerate(reversed(out)):
        if rec["words"] >= threshold:
            streak += 1
        elif i > 0:              # today not yet written is not a broken streak
            break

    return {"days": out, "streak": streak, "min_words": threshold}


_pushed = {}


def push_journal_count(cfg, day, words):
    """Send the word count to Apps Script, at most once per day per value
    change. Failures are ignored: a dead network must never cost you the
    entry, which is already safely on disk."""
    if not cfg.get("exec_url"):
        return
    if _pushed.get(day) == words:
        return
    body = json.dumps({"metric": "journal", "value": words, "date": day}).encode()
    req = urllib.request.Request(
        cfg["exec_url"], data=body,
        headers={"Content-Type": "text/plain"},   # dodges the CORS preflight
    )
    try:
        urllib.request.urlopen(req, timeout=5).read()
        _pushed[day] = words
    except Exception as e:
        print(f"[journal] count not pushed ({e}); entry is saved locally")


# ----------------------------------------------------------------------
#  Apps Script proxy
#
#  The browser used to call Apps Script directly via JSONP, because /exec
#  redirects to script.googleusercontent.com and the redirect strips CORS
#  headers. JSONP works but fails silently and differs between browser
#  profiles. Proxying through this server makes it a same-origin fetch:
#  real status codes, real error text, and one place to debug.
# ----------------------------------------------------------------------

_cache = {"at": 0, "body": None}
CACHE_SECONDS = 20


def fetch_sheet(cfg, force=False):
    if not cfg.get("exec_url"):
        raise RuntimeError("exec_url is not set in config.json")

    now = time.time()
    if not force and _cache["body"] and now - _cache["at"] < CACHE_SECONDS:
        return _cache["body"]

    req = urllib.request.Request(
        cfg["exec_url"],
        headers={"User-Agent": "telemetry-dashboard"},
    )
    with urllib.request.urlopen(req, timeout=25) as r:
        raw = r.read().decode("utf-8", "replace")

    # A login page or an error page comes back as HTML, not JSON. Say so
    # plainly rather than letting json.loads throw something cryptic.
    stripped = raw.lstrip()
    if stripped.startswith("<"):
        raise RuntimeError(
            "Apps Script returned a web page instead of data. Check that the "
            "deployment's access is set to Anyone."
        )

    data = json.loads(raw)
    _cache["at"], _cache["body"] = now, data
    return data


def write_sheet(cfg, payload):
    if not cfg.get("exec_url"):
        raise RuntimeError("exec_url is not set in config.json")

    req = urllib.request.Request(
        cfg["exec_url"],
        data=json.dumps(payload).encode(),
        headers={"Content-Type": "text/plain"},
    )
    with urllib.request.urlopen(req, timeout=25) as r:
        raw = r.read().decode("utf-8", "replace")

    _cache["at"] = 0          # next read must not serve pre-write state
    try:
        return json.loads(raw)
    except json.JSONDecodeError:
        return {"ok": True}


# ----------------------------------------------------------------------
#  HTTP
# ----------------------------------------------------------------------

class Handler(SimpleHTTPRequestHandler):
    cfg = DEFAULTS

    def __init__(self, *a, **kw):
        super().__init__(*a, directory=str(ROOT / "static"), **kw)

    def _json(self, payload, code=200):
        body = json.dumps(payload).encode()
        self.send_response(code)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self):
        path = self.path.split("?", 1)[0]
        query = self.path.split("?", 1)[1] if "?" in self.path else ""

        if path == "/api/stats":
            me = collect(self.cfg["machine_name"])
            me["online"] = True
            machines = [me]
            # ?local=1 stops a host polling a host and recursing forever
            if not self.cfg["agent"] and "local=1" not in query:
                machines.extend(poll_peers(self.cfg))
            return self._json({"machines": machines})

        if path == "/api/config":
            return self._json({
                "exec_url": self.cfg["exec_url"],
                "machine_name": self.cfg["machine_name"],
            })

        if path == "/api/data" and not self.cfg["agent"]:
            try:
                return self._json(fetch_sheet(self.cfg, force="force=1" in query))
            except Exception as e:
                return self._json({"ok": False, "error": str(e)}, 502)

        if path == "/api/health":
            return self._json({"ok": True, "name": self.cfg["machine_name"]})

        if path == "/api/journal" and not self.cfg["agent"]:
            import datetime
            params = dict(
                p.split("=", 1) for p in query.split("&") if "=" in p
            )
            day = params.get("date", datetime.date.today().isoformat())
            try:
                return self._json(journal_read(self.cfg, day))
            except ValueError:
                return self._json({"error": "bad date"}, 400)

        if path == "/api/journal/meta" and not self.cfg["agent"]:
            return self._json(journal_meta(self.cfg, self.cfg["journal_history"]))

        if path == "/":
            self.path = "/dashboard.html"

        return super().do_GET()

    def do_POST(self):
        path = self.path.split("?", 1)[0]

        if self.cfg["agent"] or path not in ("/api/journal", "/api/write"):
            return self._json({"error": "not found"}, 404)

        try:
            length = int(self.headers.get("Content-Length", 0))
            body = json.loads(self.rfile.read(length).decode("utf-8"))
        except (ValueError, TypeError):
            return self._json({"error": "bad body"}, 400)

        if path == "/api/write":
            try:
                return self._json(write_sheet(self.cfg, body))
            except Exception as e:
                return self._json({"ok": False, "error": str(e)}, 502)

        import datetime
        day = body.get("date") or datetime.date.today().isoformat()
        try:
            return self._json(journal_write(self.cfg, day, body.get("text", "")))
        except ValueError:
            return self._json({"error": "bad date"}, 400)

    def log_message(self, fmt, *args):
        # systemd journal gets one line per request otherwise; keep errors only
        if not str(args[1] if len(args) > 1 else "").startswith("2"):
            super().log_message(fmt, *args)


def main():
    cfg = load_config()

    p = argparse.ArgumentParser()
    p.add_argument("--port", type=int)
    p.add_argument("--host", dest="bind")
    p.add_argument("--name", dest="machine_name")
    p.add_argument("--agent", action="store_true", default=None)
    args = p.parse_args()

    for key, val in vars(args).items():
        if val is not None:
            cfg[key] = val

    Handler.cfg = cfg
    read_cpu()  # prime the delta so the first real request isn't None

    mode = "agent" if cfg["agent"] else "host"
    srv = HTTPServer((cfg["bind"], cfg["port"]), Handler)
    print(f"[telemetry] {cfg['machine_name']} ({mode}) on "
          f"http://{cfg['bind']}:{cfg['port']}")
    if cfg["peers"]:
        print(f"[telemetry] peers: {', '.join(cfg['peers'])}")

    try:
        srv.serve_forever()
    except KeyboardInterrupt:
        print("\n[telemetry] stopped")


if __name__ == "__main__":
    main()
