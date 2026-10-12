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
    def __init__(self, hold=0.0, status=200, commands=None, next_wait=None, cut_after=None):
        # next_wait: what the cloud tells the bridge to ask for next (PLAN.md AO2).
        # cut_after: a held check-in is cut short after this many seconds (a 546).
        self.t = 0.0; self.hold = hold; self.status = status
        self.next_wait = next_wait; self.cut_after = cut_after
        # Each command is a time, or (time, door) for PLAN.md AK.
        self.calls = []; self.commands = [c if isinstance(c, tuple) else (c, None) for c in (commands or [])]
        self.unlocks = 0; self.opened = []
    def clock(self): return self.t
    def sleep(self, s): self.t += max(0.0, s)
    def cloud(self, action, **extra):
        self.calls.append((action, extra))
        if action == "poll":
            if self.status != 200:
                return self.status, {"error": "down"}
            if self.cut_after is not None:
                self.t += self.cut_after
                return 546, {"error": "wall clock"}
            if self.commands and self.t >= self.commands[0][0]:
                _, door = self.commands.pop(0)
                cmd = {"id": "cmd-12345678", "requested_at": None}
                if door is not None: cmd["door"] = door
                return 200, {"ok": True, "command": cmd, "tenant": {"panel_host": "10.0.0.5"}}
            self.t += min(self.hold, extra.get("wait") or 0) if self.hold else 0
            out = {"ok": True, "command": None, "tenant": {}}
            if self.next_wait is not None: out["next_wait"] = self.next_wait
            return 200, out
        return 200, {"ok": True}
    def unlock(self, **kw):
        self.unlocks += 1; return True, "panel returned 200"
    def open_door(self, **kw):
        self.opened.append(kw); return True, "controller opened it"

def run(sim, seconds):
    if "open_fn" in gb.run_loop.__code__.co_varnames:
        gb.run_loop(sim.cloud, sim.sleep, sim.clock, sim.unlock, until=seconds, open_fn=sim.open_door)
    else:
        gb.run_loop(sim.cloud, sim.sleep, sim.clock, sim.unlock, until=seconds)
    return [a for a, _ in sim.calls]

# The cloud holds each check-in up to 2 minutes (PLAN.md AO).
s = Sim(hold=120.0, next_wait=120); calls = run(s, 600)
check("AO: about one call every 2 minutes (≤ 6 in 10 minutes)", calls.count("poll") <= 6, f"{calls.count('poll')} polls")
check("AO: each check-in asks the cloud to wait 120 seconds", all(e.get("wait") == 120 for a, e in s.calls if a == "poll"), str(s.calls[:2]))
check("no separate heartbeat calls (each check-in counts)", "heartbeat" not in calls, str(set(calls)))

# The club PC's settings file may still say WAIT_SEC=20: the cloud's word wins after the first call.
gb_wait = gb.WAIT_SEC; gb.WAIT_SEC = 20
s = Sim(hold=120.0, next_wait=120); calls = run(s, 600)
waits = [e.get("wait") for a, e in s.calls if a == "poll"]
check("AO2: after the first check-in it asks for what the cloud says", waits[:1] == [20] and set(waits[1:]) == {120}, str(waits))
gb.WAIT_SEC = gb_wait
s = Sim(hold=200.0, next_wait=999); run(s, 600)
s2 = Sim(hold=0.0, next_wait=1); run(s2, 60)
check("AO3: a strange answer is kept between 5 and 130 seconds",
      max(e.get("wait") for a, e in s.calls if a == "poll") <= 130 and min(e.get("wait") for a, e in s2.calls if a == "poll")  >= 5)

# A long hold cut short by the cloud isn't an outage: ask again at once.
s = Sim(cut_after=60.0); calls = run(s, 600)
check("AO3: a hold cut short after a minute is retried straight away (about 10 in 10 minutes)", 9 <= calls.count("poll") <= 11, f"{calls.count('poll')} polls")

# An old cloud answers at once: the bridge still never loops faster than 5 s.
s = Sim(hold=0.0); calls = run(s, 600)
check("with an old cloud that answers at once: never more than one call every 5 seconds", calls.count("poll") <= 121, f"{calls.count('poll')} polls")

# The cloud is down: back off, up to a minute between tries.
s = Sim(status=0); calls = run(s, 1800)
check("when the cloud is down it backs off to one try a minute (≤ 40 in 30 minutes)", calls.count("poll") <= 40, f"{calls.count('poll')} polls")
s = Sim(status=503); calls = run(s, 1800)
check("same for an error answer", calls.count("poll") <= 40, f"{calls.count('poll')} polls")

# Someone taps Unlock: it's fired once and reported.
s = Sim(hold=120.0, next_wait=120, commands=[45.0]); calls = run(s, 300)
check("an unlock is fired once and reported back", s.unlocks == 1 and calls.count("complete") == 1, f"unlocks={s.unlocks} calls={calls}")

# PLAN.md AK: the board opens the other doors through the controller itself.
SNACK = {"key": "snack", "name": "Snack", "controller": 423141044, "address": "10.1.10.153", "door": 2}
MAIN = {"key": "main_gate", "name": "Main Gate"}
s = Sim(hold=20.0, commands=[(10.0, SNACK)]); calls = run(s, 60)
check("another door opens through its controller, not the Main Gate recipe",
      s.unlocks == 0 and len(s.opened) == 1 and s.opened[0].get("controller") == 423141044
      and s.opened[0].get("address") == "10.1.10.153" and s.opened[0].get("door") == 2, f"unlocks={s.unlocks} opened={s.opened}")
check("and it's reported back", calls.count("complete") == 1 and any(e.get("result_code") == "ok" for a, e in s.calls if a == "complete"), str(s.calls[-2:]))
s = Sim(hold=20.0, commands=[(10.0, MAIN), 30.0]); calls = run(s, 60)
check("the Main Gate (or an unlock with no door) keeps the proven recipe", s.unlocks == 2 and not s.opened, f"unlocks={s.unlocks} opened={s.opened}")

has_open = hasattr(gb, "open_door_udp")
check("the bridge has open_door_udp(controller, address, door)", has_open)
if has_open:
    class FakeClient:
        def __init__(self, reply): self.reply = reply; self.asked = None
        def open_door(self, controller, door, timeout=2.5):
            self.asked = (controller, door)
            if isinstance(self.reply, Exception): raise self.reply
            return self.reply
    yes = FakeClient(types.SimpleNamespace(controller=423141044, opened=True))
    ok, detail = gb.open_door_udp(controller=423141044, address="10.1.10.153", door=2, make_client=lambda: yes)
    check("it asks that controller, at that address, for that door", ok and yes.asked == ((423141044, "10.1.10.153", "udp"), 2), f"{ok} {detail} {yes.asked}")
    ok, detail = gb.open_door_udp(controller=423141044, address="10.1.10.153", door=2, make_client=lambda: FakeClient(types.SimpleNamespace(opened=False)))
    check("a controller that says no is a failure", not ok and detail, detail)
    ok, detail = gb.open_door_udp(controller=423141044, address="10.1.10.153", door=2, make_client=lambda: FakeClient(None))
    check("no answer is a failure", not ok and "no answer" in detail, detail)
    ok, detail = gb.open_door_udp(controller=423141044, address="10.1.10.153", door=2, make_client=lambda: FakeClient(OSError("timed out")))
    check("an error is caught and reported as unreachable", not ok and "unreachable" in detail, detail)
    def missing(): raise ImportError("No module named 'uhppoted'")
    ok, detail = gb.open_door_udp(controller=423141044, address="10.1.10.153", door=2, make_client=missing)
    check("without uhppoted installed it says so (and the Main Gate still works)", not ok and "uhppoted" in detail, detail)
    ok, detail = gb.open_door_udp(controller=423141044, address="10.1.10.153", door=9, make_client=lambda: yes)
    check("a door number outside 1-4 is refused", not ok, detail)

shutil.rmtree(tmp, ignore_errors=True)
print(f"\n{'FAILED' if failed else 'PASSED'}: {failed} failed")
sys.exit(1 if failed else 0)
