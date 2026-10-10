"""Teams of units from a report's words; unit log CSV."""
from app.incidents.intake import needs_from_text
from app.units.service import to_csv


def test_fire_with_people_trapped_needs_a_team():
    n = needs_from_text("Fire in the chemical godown, two workers trapped inside, crowd gathered")
    assert n == {"search_rescue": 1, "medical_transport": 1, "traffic_control": 1}


def test_marathi_and_hindi_words():
    assert "search_rescue" in needs_from_text("इमारतीत लोक अडकले आहेत")
    assert needs_from_text("सड़क पर भीड़ है") == {"traffic_control": 1}
    assert needs_from_text("water on the road") == {}


def test_log_csv_has_header_and_rows():
    out = to_csv([{"at": "2026-10-10T10:00:00+00:00", "type": "event", "kind": "assignment.rerouted",
                   "summary": "off route, redrawn", "lng": 73.8, "lat": 18.6}], "PC-AMB-01")
    lines = out.strip().splitlines()
    assert lines[0].startswith("unit,at,type,kind") and "PC-AMB-01" in lines[1] and "rerouted" in lines[1]
