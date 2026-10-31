"""Check contracts between the served HTML and its controllers without a database."""

import json
import re
import subprocess
import unittest
from collections import Counter
from html.parser import HTMLParser
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]


class Page(HTMLParser):
    def __init__(self):
        super().__init__()
        self.ids, self.scripts = [], []

    def handle_starttag(self, tag, attrs):
        attrs = dict(attrs)
        if "id" in attrs:
            self.ids.append(attrs["id"])
        if tag == "script" and attrs.get("src"):
            self.scripts.append(attrs["src"])


class FrontendContracts(unittest.TestCase):
    def setUp(self):
        self.page = Page()
        self.html = (ROOT / "frontend/index.html").read_text()
        self.page.feed(self.html)

    def test_dom_ids_unique_and_identity_controls_exist(self):
        self.assertFalse(
            [key for key, count in Counter(self.page.ids).items() if count > 1]
        )
        identity = (ROOT / "frontend/identity.js").read_text()
        dynamic = (ROOT / "frontend/app.js").read_text() + identity
        ids = set(self.page.ids) | set(re.findall(r'id="([^"\n]+)"', dynamic))
        for key in re.findall(r'\$\("([^"\n]+)"\)', identity):
            self.assertIn(key, ids, f"Identity controller needs #{key}")

    def test_all_served_scripts_exist_and_old_api_routes_are_absent(self):
        for src in self.page.scripts:
            self.assertTrue((ROOT / "frontend" / src).is_file(), src)
        sources = "\n".join(
            (ROOT / "frontend" / x).read_text()
            for x in ("app.js", "identity.js", "catalog.js")
        )
        for route in (
            "/analytics/dashboard",
            "/billing/run-billing-day",
            "/auth/register",
            "/customer/my-subscriptions",
        ):
            self.assertNotIn(route, sources)

    def test_catalog_controls_exist(self):
        source = (ROOT / "frontend/catalog.js").read_text()
        for key in re.findall(r'\$\("([^"\n]+)"\)', source):
            self.assertIn(key, self.page.ids, f"Catalog controller needs #{key}")

    def test_money_input_preserves_paise_and_rejects_invalid_values(self):
        source = (ROOT / "frontend/catalog.js").read_text()
        script = (
            source
            + "\nconsole.log(JSON.stringify(['560.00','100.01','0.09'].map(paise)));\n"
            + "for (const x of ['-1','1.005','Infinity','NaN','1000000000.01']) { let rejected=false; try {paise(x)} catch(e) {rejected=true} if(!rejected) throw Error(x); }"
        )
        result = subprocess.run(
            ["node", "-e", script], text=True, capture_output=True, check=True
        )
        self.assertEqual(json.loads(result.stdout), [56000, 10001, 9])

    def test_login_navigation_preserves_centered_flex_layout(self):
        source = (ROOT / "frontend/app.js").read_text()
        script = (
            """
const elements = new Map();
const document = {
  addEventListener() {},
  getElementById(id) {
    if (!elements.has(id)) elements.set(id, {style: {}});
    return elements.get(id);
  }
};
"""
            + source
            + """
navigateTo('login');
console.log(JSON.stringify({
  login: elements.get('view-login').style.display,
  dashboard: elements.get('view-dashboard').style.display,
  navbar: elements.get('odoo-top-navbar').style.display
}));
"""
        )
        result = subprocess.run(
            ["node", "-e", script], text=True, capture_output=True, check=True
        )
        self.assertEqual(
            json.loads(result.stdout),
            {"login": "flex", "dashboard": "none", "navbar": "none"},
        )
