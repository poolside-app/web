#!/usr/bin/env python3
"""Offline check of the gate bridge's loop (PLAN.md AA2), against a fake
cloud and a fake clock. Counts how often the bridge would call Supabase.
Run by scripts/test_gate_poll.mjs; needs nothing installed."""
import importlib.util, os, shutil, sys, tempfile, types

failed = 0
def check(label, ok, detail=""):
    global failed
    print(("  ✓ " if ok else "  ✗ ") + label + ("" if ok else f" — {detail}"))
    if not ok: failed += 1

# Load a copy of the bridge from a temp folder (it writes bridge.log next to
# itself), with stand-ins for requests and dotenv.
here = os.path.dirname(os.path.abspath(__file__))
tmp = tempfile.mkdtemp()
shutil.copy(os.path.join(here, "..", "bridge", "gate_bridge.py"), tmp)
fake_requests = types.ModuleType("requests")
class _RE(Exception): pass
fake_requests.RequestException = _RE
fake_requests.Session = lambda: types.SimpleNamespace(post=None, headers={})
fake_requests.post = None
sys.modules["requests"] = fake_requests
fake_dotenv = types.ModuleType("dotenv"); fake_dotenv.load_dotenv = lambda *a, **k: None
sys.modules["dotenv"] = fake_dotenv
os.environ.update(SUPABASE_URL="https://example.supabase.co", BRIDGE_ID="b", BRIDGE_SECRET="s")
spec = importlib.util.spec_from_file_location("gate_bridge", os.path.join(tmp, "gate_bridge.py"))
gb = importlib.util.module_from_spec(spec); spec.loader.exec_module(gb)

check("the bridge has run_loop(cloud, sleep, clock, unlock, ...)", hasattr(gb, "run_loop"))
if not hasattr(gb, "run_loop"):
    print(f"\nFAILED: {failed} failed"); sys.exit(1)

class Sim:
    """A fake clock and cloud. `hold` is how long the cloud keeps a poll open."""
    def __init__(self, hold=0.0, status=200, commands=None):
        self.t = 0.0; self.hold = hold; self.status = status
        self.calls = []; self.commands = list(commands or []); self.unlocks = 0
    def clock(self): return self.t
    def sleep(self, s): self.t += max(0.0, s)
    def cloud(self, action, **extra):
        self.calls.append((action, extra))
        if action == "poll":
            if self.status != 200:
                return self.status, {"error": "down"}
            if self.commands and self.t >= self.commands[0]:
                self.commands.pop(0)
                return 200, {"ok": True, "command": {"id": "cmd-12345678", "requested_at": None}, "tenant": {"panel_host": "10.0.0.5"}}
            self.t += self.hold
            return 200, {"ok": True, "command": None, "tenant": {}}
        return 200, {"ok": True}
    def unlock(self, **kw):
        self.unlocks += 1; return True, "panel returned 200"

def run(sim, seconds):
    gb.run_loop(sim.cloud, sim.sleep, sim.clock, sim.unlock, until=seconds)
    return [a for a, _ in sim.calls]

# The cloud holds each check-in up to 20 seconds.
s = Sim(hold=20.0); calls = run(s, 600)
check("with the new cloud: about one call every 20 seconds (≤ 31 in 10 minutes)", calls.count("poll") <= 31, f"{calls.count('poll')} polls")
check("each check-in asks the cloud to wait 20 seconds", all(e.get("wait") == 20 for a, e in s.calls if a == "poll"), str(s.calls[:2]))
check("no separate heartbeat calls (each check-in counts)", "heartbeat" not in calls, str(set(calls)))

# An old cloud answers at once: the bridge still never loops faster than 5 s.
s = Sim(hold=0.0); calls = run(s, 600)
check("with an old cloud that answers at once: never more than one call every 5 seconds", calls.count("poll") <= 121, f"{calls.count('poll')} polls")

# The cloud is down: back off, up to a minute between tries.
s = Sim(status=0); calls = run(s, 1800)
check("when the cloud is down it backs off to one try a minute (≤ 40 in 30 minutes)", calls.count("poll") <= 40, f"{calls.count('poll')} polls")
s = Sim(status=503); calls = run(s, 1800)
check("same for an error answer", calls.count("poll") <= 40, f"{calls.count('poll')} polls")

# Someone taps Unlock: it's fired once and reported.
s = Sim(hold=20.0, commands=[45.0]); calls = run(s, 120)
check("an unlock is fired once and reported back", s.unlocks == 1 and calls.count("complete") == 1, f"unlocks={s.unlocks} calls={calls}")

shutil.rmtree(tmp, ignore_errors=True)
print(f"\n{'FAILED' if failed else 'PASSED'}: {failed} failed")
sys.exit(1 if failed else 0)
