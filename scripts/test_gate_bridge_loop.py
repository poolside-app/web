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

# PLAN.md AS4: keyfob sync jobs (bridge 1.4).
import datetime as dt
class Rec(types.SimpleNamespace): pass
class FakeCtl:
    """Two controllers' cards and time windows, as uhppoted shows them."""
    def __init__(self, down=()):
        self.cards = {(423141044, 786777): dict(start=dt.date(2026, 4, 7), end=dt.date(2026, 10, 30), d=[2, 0, 0, 0], pin=1234)}
        self.profiles = {(423141044, 2): dict(start=dt.date(2025, 4, 7), end=dt.date(2026, 10, 31), days=[True] * 7, s=dt.time(6, 0), e=dt.time(20, 30))}
        self.down = set(down); self.calls = []
    def _c(self, c):
        if c[0] in self.down:
            self.calls.append(("try", c[0])); raise OSError("timed out")
        return c[0]
    def get_card(self, c, n):
        s_ = self._c(c); self.calls.append(("get_card", s_, n)); x = self.cards.get((s_, n))
        if not x: return Rec(card_number=0)
        return Rec(card_number=n, start_date=x["start"], end_date=x["end"], door_1=x["d"][0], door_2=x["d"][1], door_3=x["d"][2], door_4=x["d"][3], pin=x["pin"])
    def put_card(self, c, n, start, end, d1, d2, d3, d4, pin):
        s_ = self._c(c); self.calls.append(("put_card", s_, n, start, end, [d1, d2, d3, d4], pin))
        self.cards[(s_, n)] = dict(start=start, end=end, d=[d1, d2, d3, d4], pin=pin); return Rec(stored=True)
    def delete_card(self, c, n):
        s_ = self._c(c); self.calls.append(("delete_card", s_, n)); self.cards.pop((s_, n), None); return Rec(deleted=True)
    def get_time_profile(self, c, pid):
        s_ = self._c(c); self.calls.append(("get_time_profile", s_, pid)); x = self.profiles.get((s_, pid))
        if not x: return Rec(profile_id=0)
        names = ("monday", "tuesday", "wednesday", "thursday", "friday", "saturday", "sunday")
        return Rec(profile_id=pid, start_date=x["start"], end_date=x["end"], segment_1_start=x["s"], segment_1_end=x["e"], **dict(zip(names, x["days"])))
    def set_time_profile(self, c, pid, start, end, mo, tu, we, th, fr, sa, su, s1, e1, s2, e2, s3, e3, linked):
        s_ = self._c(c); self.calls.append(("set_time_profile", s_, pid, start, end, [mo, tu, we, th, fr, sa, su], s1, e1, s2, e2))
        self.profiles[(s_, pid)] = dict(start=start, end=end, days=[mo, tu, we, th, fr, sa, su], s=s1, e=e1); return Rec(stored=True)

has_sync = hasattr(gb, "run_sync")
check("AS4: the bridge has run_sync(job)", has_sync)
if has_sync:
    CTLS = [{"serial": 423141044, "address": "10.1.10.153"}, {"serial": 423150481, "address": "10.1.10.173"}]
    chk = {"id": "s1", "kind": "check", "plan": {"controllers": CTLS,
        "cards": [{"card": 786777, "controller": 423141044}, {"card": 786777, "controller": 423150481}],
        "profiles": [{"controller": 423141044, "id": 2}, {"controller": 423150481, "id": 2}]}}
    fc = FakeCtl(); res, err = gb.run_sync(chk, make_client=lambda: fc)
    check("AS4 check: a card that's there is read with its dates, doors and PIN", not err and res["cards"][0]["have"] == {"from": "2026-04-07", "to": "2026-10-30", "doors": [2, 0, 0, 0], "pin": 1234}, str(res and res["cards"][0]))
    check("AS4 check: a card that isn't there reads as none", res["cards"][1]["have"] is None and "error" not in res["cards"][1])
    check("AS4 check: time windows are read (Monday first, HH:MM)", res["profiles"][0]["have"] == {"from": "2025-04-07", "to": "2026-10-31", "days": [True] * 7, "start": "06:00", "end": "20:30"} and res["profiles"][1]["have"] is None, str(res["profiles"]))
    check("AS4 check: it only reads (no writes)", not any(c[0] in ("put_card", "delete_card", "set_time_profile") for c in fc.calls))
    fc2 = FakeCtl(down=[423150481]); many = dict(chk, plan=dict(chk["plan"], cards=[{"card": n, "controller": 423150481} for n in range(1, 8)]))
    res2, _ = gb.run_sync(many, make_client=lambda: fc2)
    tries = sum(1 for c in fc2.calls if c == ("try", 423150481))
    check("AS4 check: a controller that doesn't answer is reported as unreadable (never as empty), and tried only twice", all(e.get("error") for e in res2["cards"]) and tries == 2, f"tries={tries} {res2['cards'][:2]}")
    send = {"id": "s2", "kind": "send", "plan": {"controllers": CTLS, "ops": [
        {"op": "put", "controller": 423141044, "card": 786777, "from": "2027-05-23", "to": "2027-10-31", "doors": [2, 0, 0, 0], "pin": 1234},
        {"op": "put", "controller": 423150481, "card": 786777, "from": "2027-05-23", "to": "2027-10-31", "doors": [0, 0, 2, 2], "pin": 0},
        {"op": "delete", "controller": 423141044, "card": 700001},
        {"op": "profile", "controller": 423141044, "id": 2, "from": "2027-05-23", "to": "2027-10-31", "days": [True] * 7, "start": "06:00", "end": "20:30"}]}}
    fc3 = FakeCtl(); fc3.cards[(423141044, 700001)] = dict(start=dt.date(2026, 4, 7), end=dt.date(2026, 10, 30), d=[2, 0, 0, 0], pin=0)
    res3, err3 = gb.run_sync(send, make_client=lambda: fc3)
    puts = [c for c in fc3.calls if c[0] == "put_card"]
    check("AS4 send: a card is written with its dates, each door's value, and its PIN kept", puts[0][3:] == (dt.date(2027, 5, 23), dt.date(2027, 10, 31), [2, 0, 0, 0], 1234), str(puts[0]))
    check("AS4 send: a turned-off fob is deleted", ("delete_card", 423141044, 700001) in fc3.calls and (423141044, 700001) not in fc3.cards)
    check("AS4 send: the Member window is set (dates, days, hours)", any(c[0] == "set_time_profile" and c[2] == 2 and c[6] == dt.time(6, 0) and c[7] == dt.time(20, 30) for c in fc3.calls))
    check("AS4 send: every change is read back and reported live", not err3 and all(o["ok"] and o["live"] for o in res3["ops"]), str(res3["ops"]))
    night = dict(send, plan=dict(send["plan"], ops=[{"op": "profile", "controller": 423141044, "id": 4, "from": "2027-05-23", "to": "2027-10-31", "days": [True] * 7, "start": "22:00", "end": "02:00"}]))
    fc4 = FakeCtl(); gb.run_sync(night, make_client=lambda: fc4)
    sp = [c for c in fc4.calls if c[0] == "set_time_profile"][0]
    check("AS4 send: an overnight window becomes two segments", sp[6:10] == (dt.time(22, 0), dt.time(23, 59), dt.time(0, 0), dt.time(2, 0)), str(sp))
    def no_lib(): raise ImportError("No module named 'uhppoted'")
    _, err5 = gb.run_sync(chk, make_client=no_lib)
    check("AS4: without uhppoted it says so", err5 and "uhppoted" in err5)

    class SyncSim(Sim):
        def cloud(self, action, **extra):
            if action == "poll" and not getattr(self, "gave", False):
                self.gave = True; self.calls.append((action, extra))
                return 200, {"ok": True, "command": None, "sync": chk, "tenant": {}}
            return Sim.cloud(self, action, **extra)
    ss = SyncSim(hold=20.0); got = []
    if "sync_fn" in gb.run_loop.__code__.co_varnames:
        gb.run_loop(ss.cloud, ss.sleep, ss.clock, ss.unlock, until=60, open_fn=ss.open_door, sync_fn=lambda job: (got.append(job["id"]) or ({"cards": []}, None)))
    done = [e for a, e in ss.calls if a == "sync_done"]
    check("AS4 loop: a sync job from the cloud is done and reported (no door opened)", got == ["s1"] and len(done) == 1 and done[0].get("id") == "s1" and ss.unlocks == 0, f"got={got} done={done}")

shutil.rmtree(tmp, ignore_errors=True)
print(f"\n{'FAILED' if failed else 'PASSED'}: {failed} failed")
sys.exit(1 if failed else 0)
