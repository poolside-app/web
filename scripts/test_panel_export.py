#!/usr/bin/env python3
"""Offline check of the read-only keyfob export (PLAN.md AJ1), against fake
controllers. Also re-checks the read-only guard. Needs nothing installed.

Usage: python3 scripts/test_panel_export.py"""
import csv, datetime, importlib.util, os, sys, tempfile, types

failed = 0
def check(label, ok, detail=""):
    global failed
    print(("  ✓ " if ok else "  ✗ ") + label + ("" if ok else f" — {detail}"))
    if not ok: failed += 1

# A stand-in for the uhppoted library, so the script imports here.
pkg = types.ModuleType("uhppoted"); sub = types.ModuleType("uhppoted.uhppote")
class Uhppote:
    def __init__(self, **kw): pass
sub.Uhppote = Uhppote
sys.modules["uhppoted"] = pkg; sys.modules["uhppoted.uhppote"] = sub
here = os.path.dirname(os.path.abspath(__file__))
spec = importlib.util.spec_from_file_location("pcr", os.path.join(here, "..", "bridge", "panel_check_readonly.py"))
pcr = importlib.util.module_from_spec(spec); spec.loader.exec_module(pcr)

print("AJ1 · the keyfob list (offline, fake controllers)")
check("the export lives in the read-only check (--export)", hasattr(pcr, "export_cards"))
if not hasattr(pcr, "export_cards"):
    print(f"\nFAILED: {failed} failed"); sys.exit(1)

D = datetime.date
def card(n, end, doors, start=D(2024, 5, 1)):
    return types.SimpleNamespace(card_number=n, start_date=start, end_date=end, door_1=doors[0], door_2=doors[1], door_3=doors[2], door_4=doors[3], pin=1234)
SNACK, PUMP = 423141044, 423150481
CARDS = {
    SNACK: [card(786777, D(2099, 12, 31), (1, 0, 0, 0)), card(10483921, D(2027, 9, 30), (1, 1, 0, 0)), card(0, None, (0, 0, 0, 0)), card(555, D(2020, 1, 1), (1, 0, 0, 0))],
    PUMP:  [card(786777, D(2099, 12, 31), (0, 0, 1, 1)), card(10483921, D(2027, 9, 30), (1, 1, 1, 1)), card(424242, D(2027, 9, 30), (0, 0, 1, 1))],
}
class FakeClient:
    def get_cards(self, serial): return types.SimpleNamespace(cards=len(CARDS[serial]))
    def get_card_by_index(self, serial, i): return CARDS[serial][i - 1]
out = os.path.join(tempfile.mkdtemp(), "keyfobs.csv")
n = pcr.export_cards(FakeClient(), [SNACK, PUMP], out, today=D(2026, 10, 12))
rows = list(csv.DictReader(open(out, newline="", encoding="utf-8")))
by = {r["card_number"]: r for r in rows}
check("one row per keyfob across both controllers, empty slots skipped", n == 4 and len(rows) == 4 and set(by) == {"786777", "10483921", "555", "424242"}, str(list(by)))
r = by.get("786777", {})
check("both printed forms: 10-digit and facility,card", r.get("printed_10_digit") == "0000786777" and r.get("facility_card") == "012,00345", str(r))
check("never expires, and its doors merged from both controllers by name", r.get("never_expires") == "yes" and r.get("Main Gate") == "yes" and r.get("Mens") == "yes" and r.get("Womens") == "yes" and r.get("Pump Room") == "no" and r.get("Snack") == "no", str(r))
check("valid until and expired", by["10483921"]["valid_until"] == "2027-09-30" and by["555"]["expired"] == "yes" and by["10483921"]["expired"] == "no")
check("which controllers have it (a keyfob on only one stands out)", by["786777"]["on_controllers"] == "both" and by["424242"]["on_controllers"] == "pump room only" and by["555"]["on_controllers"] == "snack shack only", str({k: v["on_controllers"] for k, v in by.items()}))
check("no door PINs in the file", not any("pin" in k.lower() for k in rows[0].keys()) and "1234" not in open(out, encoding="utf-8").read())

print("AJ1 · still read-only (offline)")
def refused(b):
    try: pcr.check_packet(b); return False
    except pcr.WriteBlocked: return True
pk = lambda op: bytes([0x17, op]) + bytes(62)
check("the three reads are allowed", not refused(pk(0x94)) and not refused(pk(0x58)) and not refused(pk(0x5C)))
check("add/change a card, delete, open a door are refused", refused(pk(0x50)) and refused(pk(0x52)) and refused(pk(0x40)))
check("the export calls only the reads", "put_card" not in open(os.path.join(here, "..", "bridge", "panel_check_readonly.py"), encoding="utf-8").read().split("def export_cards")[1].split("def main")[0])

print(f"\n{'FAILED' if failed else 'PASSED'}: {failed} failed")
sys.exit(1 if failed else 0)
